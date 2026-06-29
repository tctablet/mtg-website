#!/usr/bin/env node
/**
 * Downloads Scryfall bulk data (default_cards) and upserts the cheapest
 * EUR price per card name into the Supabase `scryfall_prices` table.
 *
 * Env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY
 * Usage: node scripts/sync-prices.mjs
 */

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
const USD_TO_EUR = 0.92

// Scryfall requires a custom User-Agent and an Accept header on every request,
// otherwise it returns HTTP 400 (https://scryfall.com/docs/api).
const SCRYFALL_HEADERS = {
  'User-Agent': 'mtg-website-price-sync/1.0 (+https://github.com/tctablet/mtg-website)',
  Accept: 'application/json',
}

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY')
  process.exit(1)
}

async function supabaseRpc(path, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Supabase ${method} ${path}: ${res.status} ${text}`)
  }
  return res
}

/**
 * Streams a Scryfall bulk-data file (a JSON array of card objects) and yields
 * one parsed card object at a time. The full file is ~530 MB and growing, which
 * exceeds V8's max single-string length (~512 MB), so `res.json()` throws
 * ERR_STRING_TOO_LONG. We instead scan the byte stream, track brace depth
 * (ignoring braces inside strings), and JSON.parse each top-level object on its
 * own — the working buffer never holds more than one object plus one chunk.
 */
async function* streamScryfallCards(url) {
  const res = await fetch(url, { headers: SCRYFALL_HEADERS })
  if (!res.ok) {
    throw new Error(`Scryfall bulk download failed: ${res.status}`)
  }
  const decoder = new TextDecoder('utf-8')
  let buf = ''
  let scanPos = 0
  let depth = 0
  let inStr = false
  let esc = false
  let objStart = -1

  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true })
    for (; scanPos < buf.length; scanPos++) {
      const c = buf[scanPos]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') {
        inStr = true
      } else if (c === '{') {
        if (depth++ === 0) objStart = scanPos
      } else if (c === '}') {
        if (--depth === 0 && objStart >= 0) {
          yield JSON.parse(buf.slice(objStart, scanPos + 1))
          objStart = -1
        }
      }
    }
    // Compact the buffer so memory stays bounded: keep only a pending partial
    // object, otherwise drop everything already scanned.
    if (objStart >= 0) {
      buf = buf.slice(objStart)
      scanPos -= objStart
      objStart = 0
    } else {
      buf = ''
      scanPos = 0
    }
  }
}

async function main() {
  // 1. Get bulk data download URL
  console.log('Fetching bulk data URL...')
  const bulkRes = await fetch('https://api.scryfall.com/bulk-data/default_cards', {
    headers: SCRYFALL_HEADERS,
  })
  if (!bulkRes.ok) {
    throw new Error(`Scryfall bulk-data lookup failed: ${bulkRes.status} ${await bulkRes.text()}`)
  }
  const bulkMeta = await bulkRes.json()
  const downloadUrl = bulkMeta.download_uri
  if (!downloadUrl) {
    throw new Error(`Scryfall bulk-data response has no download_uri: ${JSON.stringify(bulkMeta)}`)
  }
  console.log(`Downloading ${bulkMeta.name} (${(bulkMeta.size / 1024 / 1024).toFixed(0)} MB)...`)

  // 2. Download and parse (streamed — the file is too large for res.json()).
  // 3. Find cheapest price per card name while streaming.
  const priceMap = new Map() // name -> { eur, is_foil }
  let cardCount = 0

  for await (const card of streamScryfallCards(downloadUrl)) {
    cardCount++
    if (card.digital) continue

    const name = card.name
    const p = card.prices || {}

    // Try non-foil EUR first, then USD converted, then foil
    let eur = null
    let isFoil = false

    if (p.eur) {
      eur = parseFloat(p.eur)
    } else if (p.usd) {
      eur = parseFloat(p.usd) * USD_TO_EUR
    } else if (p.eur_foil) {
      eur = parseFloat(p.eur_foil)
      isFoil = true
    } else if (p.usd_foil) {
      eur = parseFloat(p.usd_foil) * USD_TO_EUR
      isFoil = true
    }

    if (eur === null || isNaN(eur)) continue

    const existing = priceMap.get(name)
    if (!existing || eur < existing.eur) {
      priceMap.set(name, { eur: Math.round(eur * 100) / 100, is_foil: isFoil })
    }
  }

  console.log(`Streamed ${cardCount} card objects`)
  console.log(`Found cheapest prices for ${priceMap.size} unique cards`)

  // 4. Upsert into Supabase in batches
  const now = new Date().toISOString()
  const rows = [...priceMap.entries()].map(([name, { eur, is_foil }]) => ({
    name,
    cheapest_eur: eur,
    is_foil,
    updated_at: now,
  }))

  const BATCH_SIZE = 500
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    await supabaseRpc('scryfall_prices', {
      method: 'POST',
      body: batch,
    })
    console.log(`Upserted ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length}`)
  }

  console.log('Done!')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

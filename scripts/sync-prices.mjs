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
 * Streams a Scryfall bulk-data file and yields one parsed card object at a time.
 *
 * Scryfall serves gzipped JSONL (one card object per line) from data.scryfall.io
 * with `content-type: application/gzip` and no `content-encoding`, so fetch hands
 * us the compressed bytes and we have to gunzip ourselves. Streaming line by line
 * also keeps the working buffer at one object: the uncompressed file is ~530 MB,
 * well past V8's max string length, so buffering it whole would throw
 * ERR_STRING_TOO_LONG.
 *
 * Lines that are just an array bracket or carry a trailing comma are tolerated,
 * so a plain JSON array with one object per line parses too.
 */
async function* streamScryfallCards(url) {
  const res = await fetch(url, { headers: SCRYFALL_HEADERS })
  if (!res.ok) {
    throw new Error(`Scryfall bulk download failed: ${res.status}`)
  }

  // DecompressionStream keeps this on web streams, so the byte loop below stays
  // exactly the one that already ran fine in this workflow.
  const gzipped = url.endsWith('.gz')
    || (res.headers.get('content-type') || '').includes('gzip')
  const source = gzipped
    ? res.body.pipeThrough(new DecompressionStream('gzip'))
    : res.body

  const decoder = new TextDecoder('utf-8')
  let buf = ''
  let lineNo = 0

  const parseLine = (raw) => {
    const line = raw.trim().replace(/,$/, '')
    if (!line || line === '[' || line === ']') return null
    try {
      return JSON.parse(line)
    } catch (err) {
      throw new Error(`Bulk line ${lineNo} is not valid JSON: ${err.message}`)
    }
  }

  for await (const chunk of source) {
    buf += decoder.decode(chunk, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      lineNo++
      const card = parseLine(raw)
      if (card) yield card
    }
  }
  buf += decoder.decode()
  lineNo++
  const last = parseLine(buf)
  if (last) yield last
}

/**
 * Propagates the freshly-computed cheapest prices onto every card in every deck
 * (the `cards` table), so decks stay current even if nobody opens them. This is
 * the same data the in-app "Preise aktualisieren" button writes, just applied to
 * all decks at once. Pure DB work — no Scryfall calls. Matches by card name with
 * a DFC front-face fallback, mirroring src/pages/deck-view.js refreshPrices().
 */
async function propagateToDeckCards(priceMap, now) {
  // 1. Fetch all deck cards (paginated — PostgREST caps at 1000 rows/response).
  const cards = []
  const PAGE = 1000
  for (let offset = 0; ; offset += PAGE) {
    const res = await supabaseRpc(`cards?select=id,name&order=id&limit=${PAGE}&offset=${offset}`)
    const page = await res.json()
    cards.push(...page)
    if (page.length < PAGE) break
  }
  console.log(`Fetched ${cards.length} deck cards`)

  // 2. Group card ids by name → target price (DFC front-face fallback).
  const byName = new Map() // name -> { ids:[], price, is_foil }
  let unmatched = 0
  for (const c of cards) {
    let info = priceMap.get(c.name)
    if (!info && c.name.includes(' // ')) info = priceMap.get(c.name.split(' // ')[0])
    if (!info) { unmatched++; continue }
    const g = byName.get(c.name) || { ids: [], price: info.eur, is_foil: info.is_foil }
    g.ids.push(c.id)
    byName.set(c.name, g)
  }
  const matched = cards.length - unmatched
  console.log(`Matched ${matched} deck cards to a price (${unmatched} without one)`)

  // 3. PATCH grouped by name (one request updates that card across all decks).
  const groups = [...byName.values()]
  const CONC = 10
  for (let i = 0; i < groups.length; i += CONC) {
    const chunk = groups.slice(i, i + CONC)
    await Promise.all(chunk.map(g =>
      supabaseRpc(`cards?id=in.(${g.ids.join(',')})`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: { price_eur: g.price, price_is_foil: g.is_foil, price_updated_at: now },
      })
    ))
  }
  console.log(`Updated prices on ${matched} deck cards across ${groups.length} names`)
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
  // Scryfall switched to gzipped JSONL in 2026 and renamed both fields; keep the
  // old names as a fallback so this works either way.
  const downloadUrl = bulkMeta.jsonl_download_uri || bulkMeta.download_uri
  if (!downloadUrl) {
    throw new Error(
      `Scryfall bulk-data response has no download URL. Keys: ${Object.keys(bulkMeta).join(', ')}`
    )
  }
  const sizeBytes = bulkMeta.compressed_size ?? bulkMeta.size
  const sizeLabel = sizeBytes ? `${(sizeBytes / 1024 / 1024).toFixed(0)} MB` : 'unbekannte Größe'
  console.log(`Downloading ${bulkMeta.name} (${sizeLabel})...`)

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

  // 5. Propagate the fresh prices onto every deck's cards.
  console.log('Propagating prices to deck cards...')
  await propagateToDeckCards(priceMap, now)

  console.log('Done!')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})

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

async function main() {
  // 1. Get bulk data download URL
  console.log('Fetching bulk data URL...')
  const bulkRes = await fetch('https://api.scryfall.com/bulk-data/default_cards')
  const bulkMeta = await bulkRes.json()
  const downloadUrl = bulkMeta.download_uri
  console.log(`Downloading ${bulkMeta.name} (${(bulkMeta.size / 1024 / 1024).toFixed(0)} MB)...`)

  // 2. Download and parse
  const dataRes = await fetch(downloadUrl)
  const cards = await dataRes.json()
  console.log(`Parsed ${cards.length} card objects`)

  // 3. Find cheapest price per card name
  const priceMap = new Map() // name -> { eur, is_foil }

  for (const card of cards) {
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

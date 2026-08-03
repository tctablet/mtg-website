#!/usr/bin/env node
/**
 * Downloads Scryfall bulk data (default_cards) and, in one streamed pass:
 *  1. upserts the cheapest EUR price per card name into `scryfall_prices`
 *  2. refreshes `card_printings` with every eligible paper printing of the
 *     cards that currently sit in any deck (the artwork picker reads it with
 *     a single query instead of ~86 Scryfall requests)
 *
 * Env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY
 * Usage: node scripts/sync-prices.mjs
 */

import { pathToFileURL } from 'node:url'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY
const USD_TO_EUR = 0.92

// Scryfall requires a custom User-Agent and an Accept header on every request,
// otherwise it returns HTTP 400 (https://scryfall.com/docs/api).
const SCRYFALL_HEADERS = {
  'User-Agent': 'mtg-website-price-sync/1.0 (+https://github.com/tctablet/mtg-website)',
  Accept: 'application/json',
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

// ---- Printings-Cache (card_printings) ----
// Der Artwork-Picker filtert Printings clientseitig (src/scryfall.js). Dieselbe
// Logik hier beim Befüllen, damit die Tabelle exakt das enthält, was der Picker
// zeigen würde. Beide Stellen synchron halten!
const EXCLUDED_SET_TYPES = ['promo', 'treasure_chest', 'token']

export function keepPrinting(c) {
  if (c.finishes && c.finishes.length === 1 && c.finishes[0] !== 'nonfoil') return false
  if (c.digital) return false
  if (c.promo) return false
  if (EXCLUDED_SET_TYPES.includes(c.set_type)) return false
  return (c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal) != null
}

export function toPrintingRow(c, updatedAt) {
  const img = c.image_uris || c.card_faces?.[0]?.image_uris || {}
  return {
    scryfall_id: c.id,
    name: c.name,
    set_code: c.set,
    set_name: c.set_name,
    released_at: c.released_at || null,
    image_small: img.small || img.normal,
    image_normal: img.normal,
    image_png: img.png || img.normal,
    updated_at: updatedAt,
  }
}

// Alle Kartennamen, die aktuell in irgendeinem Deck liegen (paginiert — PostgREST
// cappt bei 1000 Rows). cards.name ist immer die volle Scryfall-Form (bei DFCs
// "A // B"), matcht also exakt gegen card.name aus dem Bulk.
async function fetchDeckNames() {
  const names = new Set()
  const PAGE = 1000
  for (let offset = 0; ; offset += PAGE) {
    const res = await supabaseRpc(`cards?select=name&order=id&limit=${PAGE}&offset=${offset}`)
    const page = await res.json()
    for (const c of page) names.add(c.name)
    if (page.length < PAGE) break
  }
  return names
}

/**
 * Upserts the collected printings and removes rows this run did not touch
 * (cards that left every deck, printings Scryfall withdrew). The DELETE keys on
 * updated_at < runStamp, which only works because every upserted row carries
 * runStamp explicitly in its body — merge-duplicates would otherwise leave the
 * column's old value in place and the cleanup would eat fresh rows.
 */
async function syncPrintings(rows, deckNames, runStamp) {
  const matchedNames = new Set(rows.map(r => r.name))
  const unmatched = [...deckNames].filter(n => !matchedNames.has(n))
  if (unmatched.length) {
    // Namentlich loggen: ein Name, der hier dauerhaft auftaucht, läuft in der
    // App für immer über den (unauffälligen) Scryfall-Fallback.
    console.log(`Printings: ${unmatched.length} Deck-Namen ohne Bulk-Treffer: ${unmatched.join(', ')}`)
  }
  if (matchedNames.size < deckNames.size * 0.8) {
    throw new Error(
      `nur ${matchedNames.size}/${deckNames.size} Deck-Namen im Bulk gematcht (<80%) — ` +
      'Bulk-Anomalie? Upsert und Cleanup übersprungen.'
    )
  }

  const BATCH = 500
  for (let i = 0; i < rows.length; i += BATCH) {
    await supabaseRpc('card_printings', { method: 'POST', body: rows.slice(i, i + BATCH) })
    console.log(`Printings upserted ${Math.min(i + BATCH, rows.length)}/${rows.length}`)
  }

  // Cleanup erst NACH komplettem Upsert — bricht ein Batch ab, bleibt der alte
  // Bestand unangetastet stehen (Fallback-Daten sind besser als keine).
  const res = await supabaseRpc(
    `card_printings?updated_at=lt.${encodeURIComponent(runStamp)}&select=scryfall_id`,
    { method: 'DELETE', headers: { Prefer: 'return=representation' } }
  )
  const deleted = await res.json()
  console.log(`Printings: ${rows.length} rows für ${matchedNames.size} Namen, ${deleted.length} veraltete entfernt`)
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
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY')
    process.exit(1)
  }

  // 0. Printings-Cache vorbereiten: Tabelle da? Welche Namen liegen in Decks?
  // Fehlt die Tabelle (Migration 003 noch nicht ausgeführt), läuft der
  // Preis-Sync unverändert weiter — der Picker nutzt dann den Scryfall-Fallback.
  let deckNames = null
  try {
    await supabaseRpc('card_printings?select=scryfall_id&limit=1')
    deckNames = await fetchDeckNames()
    console.log(`Printings-Cache aktiv: ${deckNames.size} Deck-Namen`)
    if (deckNames.size < 50) {
      // Leere/kaputte cards-Tabelle darf nicht als "alle Decks gelöscht"
      // durchgehen und den kompletten Cache wegräumen.
      console.log(`::warning::Nur ${deckNames.size} Deck-Namen gefunden — Printings-Sync übersprungen.`)
      deckNames = null
    }
  } catch (err) {
    console.log(`::warning::Printings-Cache inaktiv (${err.message.split('\n')[0]}) — migrations/003_printings_cache.sql schon ausgeführt?`)
  }
  const runStamp = new Date().toISOString()
  const printingRows = []

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

    if (deckNames && deckNames.has(card.name) && keepPrinting(card)) {
      printingRows.push(toPrintingRow(card, runStamp))
    }

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

  // Nichts schreiben, wenn die Ausbeute unplausibel klein ist. Ein leeres oder
  // halb übertragenes Bulk-File würde sonst als grüner Lauf durchgehen und die
  // Preise still einfrieren — genau der Ausfall, der hier gerade behoben wurde.
  // Referenz: ein gesunder Lauf liefert ~38.000 Namen aus ~116.000 Objekten.
  const MIN_EXPECTED_NAMES = 20000
  if (priceMap.size < MIN_EXPECTED_NAMES) {
    throw new Error(
      `Nur ${priceMap.size} Preise aus ${cardCount} Objekten — erwartet mindestens ${MIN_EXPECTED_NAMES}. ` +
      'Bulk-Datei vermutlich unvollständig; es wird nichts geschrieben.'
    )
  }

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

  // 6. Printings-Cache aktualisieren. Fehler hier dürfen den (bereits
  // erfolgreichen) Preis-Sync nie mit in den Abgrund reißen: warnen, Exit 0.
  if (deckNames) {
    try {
      await syncPrintings(printingRows, deckNames, runStamp)
    } catch (err) {
      console.log(`::warning::Printings-Sync fehlgeschlagen: ${err.message.split('\n')[0]}`)
    }
  }

  console.log('Done!')
}

// Nur bei Direktaufruf starten — Tests importieren keepPrinting/toPrintingRow,
// ohne dass dabei ein Sync losläuft.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}

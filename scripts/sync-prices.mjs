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

// Untergrenze fuer einen plausiblen Lauf (ein gesunder Lauf liefert ~33.500
// Namen). Exportiert, damit scripts/price-sync-dryrun.mjs dieselbe Schwelle
// prueft statt eine eigene zu erfinden.
export const MIN_EXPECTED_NAMES = 20000

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
export async function* streamScryfallCards(url) {
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
const EXCLUDED_SET_TYPES = ['promo', 'treasure_chest', 'token', 'memorabilia']

export function keepPrinting(c) {
  if (c.finishes && c.finishes.length === 1 && c.finishes[0] !== 'nonfoil') return false
  if (c.digital) return false
  if (c.promo) return false
  if (EXCLUDED_SET_TYPES.includes(c.set_type)) return false
  return (c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal) != null
}

// Kanonischer Name, unter dem Preis UND Printing einer Bulk-Karte gekeyt
// werden. Secret-Lair-Reversible-Printings (layout reversible_card) heißen
// "A // A" — beide Faces tragen denselben Namen. Stumpf unter c.name gekeyt
// erzeugten sie 397 Geister-Rows in scryfall_prices, für die weder
// card_printings noch Scryfall-exact je ein Bild fanden (User-Report
// „Doppelseiten ohne Bilder"). Der generische Beide-Hälften-identisch-Guard
// fängt künftige gleichnamige Varianten auch ohne das Layout-Flag; echte
// Transform-DFCs ("A // B") bleiben unberührt.
export function canonicalPriceName(c) {
  const name = c?.name || ''
  if (c?.layout === 'reversible_card') return c.card_faces?.[0]?.name || name
  const parts = name.split(' // ')
  if (parts.length === 2 && parts[0] === parts[1]) return parts[0]
  return name
}

// ---- Preis-Filter (scryfall_prices) ----
// BEWUSST NICHT dieselbe Liste wie EXCLUDED_SET_TYPES oben. Der Picker-Filter
// ist eine Optik-Entscheidung ("zeig normale Prints"), hier lautet die Frage
// "was kostet die Karte im Laden". Die beiden dürfen auseinanderlaufen — was
// sie unterscheidet, steht hier, damit es niemand versehentlich angleicht:
//
//   memorabilia RAUS — Art Cards, Oversized Commander, Heroes of the Realm,
//     World Championship Decks, 30th Anniversary sind keine kaufbaren
//     Spiel-Prints. Genau das drückte "Legolas's Quick Reflexes" auf 0,40 €
//     statt 31,81 €: der Art-Series-Print ALTC #3 heißt "A // A", wurde von
//     canonicalPriceName auf den Namen der echten Karte gefaltet und gewann
//     mit 0.43 USD × 0.92 den Min-Merge (Befund 01.09.2026).
//   token/treasure_chest RAUS — heute ohne messbare Wirkung (0 Deck-Karten),
//     kommen als Schutz gegen dieselbe Bug-Klasse mit: ein gleichnamiger
//     Token-Print darf den Min-Merge nie gewinnen.
//   promo BLEIBT DRIN — ein Promo-Print ist eine echte, kaufbare Karte und oft
//     der günstigste Weg an sie heranzukommen. Gemessen 01.09.2026 über alle
//     2063 Deck-Kartennamen: Promos auszuschließen macht 163 Karten um
//     zusammen 138 € TEURER (Portal to Phyrexia PBRO #240p 30,86 € statt
//     41,75 €) — das 500-€-Gate würde Decks fälschlich blockieren.
const EXCLUDED_PRICE_SET_TYPES = ['memorabilia', 'token', 'treasure_chest']

export function isPriceEligible(c) {
  if (c.digital) return false
  return !EXCLUDED_PRICE_SET_TYPES.includes(c.set_type)
}

// EUR-Kaskade eines einzelnen Printings: non-foil EUR → USD umgerechnet →
// Foil. null = Scryfall kennt für dieses Printing keinen Preis.
export function priceOf(c) {
  const p = c.prices || {}
  if (p.eur) return { eur: parseFloat(p.eur), isFoil: false }
  if (p.usd) return { eur: parseFloat(p.usd) * USD_TO_EUR, isFoil: false }
  if (p.eur_foil) return { eur: parseFloat(p.eur_foil), isFoil: true }
  if (p.usd_foil) return { eur: parseFloat(p.usd_foil) * USD_TO_EUR, isFoil: true }
  return null
}

// Frischer Akkumulator für einen Bulk-Durchlauf.
export function newBulkContext({ deckNames = null, runStamp = null, printingRows = [] } = {}) {
  return {
    priceMap: new Map(), // kanonischer Name -> { eur, is_foil }
    printingRows,
    deckNames,
    runStamp,
    stats: { cards: 0, reversible: 0, skippedSetType: 0 },
  }
}

/**
 * Der KOMPLETTE Schleifenkörper des Bulk-Streams als pure Funktion.
 * main() ruft nur noch das hier auf, und Tests wie der Dry-Run
 * (scripts/price-sync-dryrun.mjs) nutzen exakt dieselbe Funktion — sonst kann
 * ein grüner Test neben einer abweichenden Produktionsschleife stehen.
 */
export function processBulkCard(card, ctx) {
  const { priceMap, printingRows, deckNames, runStamp, stats } = ctx
  stats.cards++

  // Reversible-Printings laufen unter ihrem kanonischen Namen mit — sowohl
  // in den Preis-Min-Merge als auch als Printing des kanonischen Deck-Namens.
  const name = canonicalPriceName(card)
  if (name !== card.name) stats.reversible++

  if (deckNames && keepPrinting(card)) {
    // Sowohl kanonischer als auch roher Bulk-Name können als Deck-Name
    // gespeichert sein — die Row trägt die Variante, die das Deck nutzt
    const deckVariant = deckNames.has(name) ? name : (deckNames.has(card.name) ? card.name : null)
    if (deckVariant) printingRows.push(toPrintingRow(card, runStamp, deckVariant))
  }

  if (!isPriceEligible(card)) {
    // digital war schon immer draußen und ist kein Signal — nur die neu
    // gefilterten set_types zählen, damit die Log-Zeile aussagekräftig bleibt.
    if (!card.digital) stats.skippedSetType++
    return
  }

  const price = priceOf(card)
  if (!price || isNaN(price.eur)) return

  const existing = priceMap.get(name)
  if (!existing || price.eur < existing.eur) {
    priceMap.set(name, { eur: Math.round(price.eur * 100) / 100, is_foil: price.isFoil })
  }
}

// nameOverride: Deck-Karten werden über ihren GESPEICHERTEN Namen nachgeschlagen
// (fetchPrintingsFromDB .in('name', …)) — liegt eine Karte historisch unter dem
// rohen "X // X"-Namen im Deck, muss die Printing-Row genau diesen Namen tragen,
// sonst fällt sie dauerhaft aus dem Cache (Critic R1 [MED]).
export function toPrintingRow(c, updatedAt, nameOverride = null) {
  const img = c.image_uris || c.card_faces?.[0]?.image_uris || {}
  return {
    scryfall_id: c.id,
    name: nameOverride || canonicalPriceName(c),
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
  // Keyset- statt Offset-Pagination: löscht jemand während des Laufs eine
  // Karte, verschiebt ein Offset-Fenster sonst still eine Row aus dem Bild —
  // und deren Printings würden am Ende als "nicht mehr im Deck" weggeräumt.
  let lastId = null
  for (;;) {
    const filter = lastId === null ? '' : `&id=gt.${encodeURIComponent(lastId)}`
    const res = await supabaseRpc(`cards?select=id,name&order=id&limit=${PAGE}${filter}`)
    const page = await res.json()
    for (const c of page) names.add(c.name)
    if (page.length < PAGE) break
    lastId = page[page.length - 1].id
  }
  return names
}

/**
 * Löscht Rows, die dieser Lauf nicht angefasst hat (updated_at < Stempel des
 * Laufs). Funktioniert nur, weil jede upsertete Row ihren Stempel explizit im
 * Body trägt — merge-duplicates ließe den alten Spaltenwert sonst stehen und
 * das Cleanup fräße frische Rows. Fail-closed: ohne parsbaren exakten Count
 * oder bei unplausibel vielen Stale-Rows (>20 %-Cap) wird NICHT gelöscht.
 * Wird für card_printings UND scryfall_prices genutzt (Critic R2: für
 * scryfall_prices gab es nie ein Cleanup — Geister-Namen froren ewig ein).
 */
async function deleteStaleRows(table, keyCol, stamp, upsertedCount, capFn = staleCapFor) {
  const staleFilter = `${table}?updated_at=lt.${encodeURIComponent(stamp)}&select=${keyCol}`
  const countRes = await supabaseRpc(`${staleFilter}&limit=1`, {
    headers: { Prefer: 'count=exact' },
  })
  const staleCount = parseInt((countRes.headers.get('content-range') || '').split('/')[1], 10)
  if (!Number.isFinite(staleCount)) {
    throw new Error(
      `Cleanup ${table} übersprungen: kein exakter Count im Content-Range-Header ` +
      `("${countRes.headers.get('content-range')}") — fail-closed.`
    )
  }
  const staleLimit = capFn(upsertedCount)
  if (staleCount > staleLimit) {
    throw new Error(
      `Cleanup ${table} übersprungen: ${staleCount} Rows wären veraltet (Limit ${staleLimit} ` +
      `bei ${upsertedCount} upserteten) — updated_at-Semantik prüfen (db-probe.yml).`
    )
  }
  if (staleCount === 0) return 0
  const res = await supabaseRpc(staleFilter, {
    method: 'DELETE',
    headers: { Prefer: 'return=representation' },
  })
  return (await res.json()).length
}

// Pure + exportiert für den Test: das 20%-Cap mit 500er-Boden (card_printings —
// dort wechselt der Bestand mit den Decks der Runde legitimerweise stark).
export function staleCapFor(upsertedCount) {
  return Math.max(500, Math.round(upsertedCount * 0.2))
}

// Deutlich strengeres Cap für scryfall_prices (Critic R1 [HIGH]): die Tabelle
// ist die EINZIGE Preisquelle der App, und ein Tages-Teilausfall bei Scryfall
// (Stream-Abriss, Preislücken) darf nie tausende legitime Namen fressen.
// 2 % der Referenzmenge bei MIN_EXPECTED_NAMES (~33.500) ≈ 670 — die 397
// Reversible-Geister passen durch, ein 1000-Namen-Loch NICHT (fail-closed).
export function stalePriceCapFor(upsertedCount) {
  return Math.max(500, Math.round(upsertedCount * 0.02))
}

/**
 * Upserts the collected printings and removes rows this run did not touch
 * (cards that left every deck, printings Scryfall withdrew).
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
  const deleted = await deleteStaleRows('card_printings', 'scryfall_id', runStamp, rows.length)
  console.log(`Printings: ${rows.length} rows für ${matchedNames.size} Namen, ${deleted} veraltete entfernt`)
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
  // Der Schleifenkörper lebt in processBulkCard — dieselbe Funktion, die Tests
  // und scripts/price-sync-dryrun.mjs aufrufen.
  const ctx = newBulkContext({ deckNames, runStamp, printingRows })
  for await (const card of streamScryfallCards(downloadUrl)) {
    processBulkCard(card, ctx)
  }
  const { priceMap } = ctx
  const cardCount = ctx.stats.cards
  const reversibleCount = ctx.stats.reversible

  console.log(`Streamed ${cardCount} card objects`)
  // Sichtbares Signal, falls Scryfall die set_type-Konvention ändert: kippt
  // diese Zahl auf 0 oder explodiert sie, stimmt der Preis-Filter nicht mehr.
  console.log(
    `Skipped ${ctx.stats.skippedSetType} printings by set_type ` +
    `(${EXCLUDED_PRICE_SET_TYPES.join(', ')})`
  )
  console.log(`Found cheapest prices for ${priceMap.size} unique cards`)
  // Sichtbares Signal statt stiller Drift: taucht hier plötzlich 0 oder eine
  // Explosion auf, hat Scryfall die Reversible-Namenskonvention geändert.
  console.log(`Normalized ${reversibleCount} reversible printings onto their canonical names`)

  // Nichts schreiben, wenn die Ausbeute unplausibel klein ist. Ein leeres oder
  // halb übertragenes Bulk-File würde sonst als grüner Lauf durchgehen und die
  // Preise still einfrieren — genau der Ausfall, der hier gerade behoben wurde.
  // Referenzwert steht bei MIN_EXPECTED_NAMES ganz oben (eine Zahl, nicht zwei).
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

  // 4b. Geister-Namen abräumen, die dieser Lauf nicht mehr geschrieben hat
  // (z.B. die 397 alten "A // A"-Reversible-Rows). Fehler hier dürfen den
  // erfolgreichen Preis-Upsert nicht röten — ::error macht sie sichtbar.
  try {
    const deletedPrices = await deleteStaleRows('scryfall_prices', 'name', now, rows.length, stalePriceCapFor)
    // ::warning statt stilles Log (Critic R1): gelöschte Preis-Namen müssen in
    // den Actions-Annotations auffallen, nicht nur im aufgeklappten Log.
    if (deletedPrices > 0) {
      console.log(`::warning::Preis-Cleanup: ${deletedPrices} veraltete Namen aus scryfall_prices entfernt`)
    } else {
      console.log('Preis-Cleanup: keine veralteten Namen')
    }
  } catch (err) {
    console.log(`::error::Preis-Cleanup fehlgeschlagen: ${err.message.split('\n')[0]}`)
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
      // ::error:: statt ::warning::: taucht rot in den Actions-Annotations auf.
      // Exit bleibt bewusst 0 — die Preise SIND synchron, nur der Printings-
      // Teil hakt; ein roter Job würde fälschlich "Preise kaputt" signalisieren.
      console.log(`::error::Printings-Sync fehlgeschlagen: ${err.message.split('\n')[0]}`)
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

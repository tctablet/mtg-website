#!/usr/bin/env node
/**
 * Dry-Run des Preis-Syncs: streamt die ECHTE Scryfall-Bulk-Datei durch die
 * ECHTEN Funktionen aus sync-prices.mjs und vergleicht das Ergebnis mit dem,
 * was gerade in Supabase steht — **ohne eine Zeile zu schreiben**.
 *
 * Der Punkt ist die Verdrahtung: der Lauf ruft `processBulkCard`, also exakt
 * die Funktion, die auch `main()` in der Schleife aufruft. Ein grüner Dry-Run
 * kann deshalb nicht neben einer abweichenden Produktionsschleife stehen.
 *
 * Grenze der Aussagekraft: die Cap-FORMELN (`staleCapFor`,
 * `stalePriceCapFor`, `MIN_EXPECTED_NAMES`) sind aus dem Produktionsmodul
 * importiert, die Stale-ZÄHLER dagegen über einen Set-Diff gegen den DB-Stand
 * geschätzt — `deleteStaleRows` zählt in Prod über `updated_at < runStamp`.
 * Das ist nah dran, aber nicht dieselbe Query.
 *
 * Prüft die fail-closed-Gates, bevor sie in Prod greifen:
 *   - MIN_EXPECTED_NAMES (Bulk-Datei plausibel?)
 *   - stalePriceCapFor  (räumt der Cleanup zu viele scryfall_prices weg?)
 *   - staleCapFor       (dasselbe für card_printings)
 *   - das 80-%-Deck-Namen-Gate aus syncPrintings
 *
 * Env: SUPABASE_URL, SUPABASE_KEY (Anon-Key reicht — es wird nur gelesen)
 * Usage: node scripts/price-sync-dryrun.mjs
 */

import {
  streamScryfallCards, processBulkCard, newBulkContext, canonicalPriceName, priceOf,
  staleCapFor, stalePriceCapFor, MIN_EXPECTED_NAMES,
} from './sync-prices.mjs'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY
const SCRYFALL_HEADERS = {
  'User-Agent': 'mtg-website-price-sync/1.0 (+https://github.com/tctablet/mtg-website)',
  Accept: 'application/json',
}
const BUDGET_LIMIT_EUR = 500

let failures = 0
const check = (ok, label, detail = '') => {
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

// Keyset-paginierter Lesezugriff (PostgREST cappt bei 1000 Rows).
async function readAll(path, orderCol, select) {
  const rows = []
  let last = null
  for (;;) {
    const filter = last === null ? '' : `&${orderCol}=gt.${encodeURIComponent(last)}`
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/${path}?select=${select}&order=${orderCol}&limit=1000${filter}`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    )
    if (!res.ok) throw new Error(`Supabase ${path}: ${res.status} ${await res.text()}`)
    const page = await res.json()
    rows.push(...page)
    if (page.length < 1000) return rows
    last = page[page.length - 1][orderCol]
  }
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_KEY')
    process.exit(2)
  }

  console.log('Lese Ist-Zustand aus Supabase …')
  const [cards, priceRows, printingRowsLive] = await Promise.all([
    readAll('cards', 'id', 'id,name,price_eur,quantity,deck_id'),
    readAll('scryfall_prices', 'name', 'name,cheapest_eur'),
    readAll('card_printings', 'scryfall_id', 'scryfall_id,name,set_code'),
  ])
  const decks = await readAll('decks', 'id', 'id,name')
  const deckName = new Map(decks.map(d => [d.id, d.name]))
  const deckNames = new Set(cards.map(c => c.name))
  const livePrices = new Map(priceRows.map(r => [r.name, Number(r.cheapest_eur)]))
  console.log(
    `  ${cards.length} Deck-Karten (${deckNames.size} Namen), ` +
    `${livePrices.size} Preis-Rows, ${printingRowsLive.length} Printing-Rows`
  )

  const meta = await (await fetch('https://api.scryfall.com/bulk-data/default_cards', {
    headers: SCRYFALL_HEADERS,
  })).json()
  const url = meta.jsonl_download_uri || meta.download_uri
  console.log(`Streame ${meta.name} (${meta.updated_at}) …`)

  const runStamp = new Date().toISOString()
  const ctx = newBulkContext({ deckNames, runStamp })
  // Nebenher (nur fuer den Bericht, nicht Teil der Produktionslogik): der
  // guenstigste memorabilia-Preis je Name. Damit laesst sich der Effekt DIESES
  // Filters von der normalen Tagespreis-Drift trennen — sonst mischt der
  // Vergleich gegen die DB von gestern beides.
  const memMin = new Map()
  for await (const card of streamScryfallCards(url)) {
    processBulkCard(card, ctx)
    if (card.set_type === 'memorabilia' && !card.digital) {
      const p = priceOf(card)
      if (p && !Number.isNaN(p.eur)) {
        const n = canonicalPriceName(card)
        const rounded = Math.round(p.eur * 100) / 100
        if (!memMin.has(n) || rounded < memMin.get(n)) memMin.set(n, rounded)
      }
    }
  }

  const { priceMap, printingRows, stats } = ctx
  console.log(
    `  ${stats.cards} Objekte, ${priceMap.size} Preis-Namen, ${printingRows.length} Printing-Rows, ` +
    `${stats.skippedSetType} per set_type übersprungen, ${stats.reversible} reversible`
  )

  console.log('\n── Gates ─────────────────────────────────────────────')
  check(priceMap.size >= MIN_EXPECTED_NAMES, `MIN_EXPECTED_NAMES`,
    `${priceMap.size} ≥ ${MIN_EXPECTED_NAMES}`)

  const lostPrices = [...livePrices.keys()].filter(n => !priceMap.has(n))
  // Aufschluesselung: wie viele davon gehen auf DIESEN Filter zurueck (Name
  // hatte nur einen memorabilia-Preis) und wie viele auf normale Scryfall-Drift?
  const lostByFilter = lostPrices.filter(n => memMin.has(n))
  const priceCap = stalePriceCapFor(priceMap.size)
  check(lostPrices.length <= priceCap, 'stalePriceCapFor (scryfall_prices-Cleanup)',
    `${lostPrices.length} veraltete Rows ≤ Cap ${priceCap} ` +
    `(${lostByFilter.length} durch den Filter, ${lostPrices.length - lostByFilter.length} Scryfall-Drift)`)

  const keptIds = new Set(printingRows.map(r => r.scryfall_id))
  const lostPrintings = printingRowsLive.filter(r => !keptIds.has(r.scryfall_id))
  const printCap = staleCapFor(printingRows.length)
  check(lostPrintings.length <= printCap, 'staleCapFor (card_printings-Cleanup)',
    `${lostPrintings.length} veraltete Rows ≤ Cap ${printCap}`)

  const matchedNames = new Set(printingRows.map(r => r.name))
  check(matchedNames.size >= deckNames.size * 0.8, '80-%-Deck-Namen-Gate (syncPrintings)',
    `${matchedNames.size}/${deckNames.size}`)

  console.log('\n── Regression: Memorabilia ───────────────────────────')
  const legolas = priceMap.get("Legolas's Quick Reflexes")
  check(legolas != null && legolas.eur > 30, "Legolas's Quick Reflexes",
    `${legolas ? legolas.eur : 'kein Preis'} € (vor dem Fix: 0,40 €)`)

  // Deck-Karten, deren Preis KOMPLETT wegfällt — das wäre der einzige echte
  // Datenverlust dieses Filters.
  const lostDeckCards = [...deckNames].filter(n => !priceMap.has(n) && livePrices.has(n))
  check(lostDeckCards.length === 0, 'Keine Deck-Karte verliert ihren Preis',
    lostDeckCards.length ? lostDeckCards.slice(0, 10).join(', ') : '0')

  console.log('\n── Wirkung auf die Deck-Werte ────────────────────────')
  // Zwei getrennte Rechnungen, damit nichts vermischt wird:
  //   filterDelta = memorabilia-Preis vs. neuer Preis  (Effekt DIESER Aenderung)
  //   dbDelta     = DB-Stand vs. neuer Preis           (enthaelt auch Tagesdrift)
  const eur = n => `${n.toFixed(2)} €`
  const cur = new Map(); const next = new Map(); const filtered = new Map()
  const movers = new Map()
  for (const c of cards) {
    const q = c.quantity || 1
    const before = Number.parseFloat(c.price_eur)
    const beforeSafe = Number.isNaN(before) ? 0 : before
    const after = priceMap.get(c.name)?.eur
    const afterSafe = after == null ? beforeSafe : after
    cur.set(c.deck_id, (cur.get(c.deck_id) || 0) + beforeSafe * q)
    next.set(c.deck_id, (next.get(c.deck_id) || 0) + afterSafe * q)

    // Haette der memorabilia-Print gewonnen? Dann ist die Differenz zum neuen
    // Preis exakt das, was dieser Filter bewirkt.
    const mem = memMin.get(c.name)
    const filterDelta = (after != null && mem != null && after - mem > 0.005) ? after - mem : 0
    filtered.set(c.deck_id, (filtered.get(c.deck_id) || 0) + filterDelta * q)
    if (filterDelta > 0) movers.set(c.name, { mem, after })
  }
  console.log(`  ${movers.size} Deck-Kartennamen wurden von einem memorabilia-Print gedrueckt. Top 10:`)
  for (const [name, m] of [...movers].sort((a, b) => (b[1].after - b[1].mem) - (a[1].after - a[1].mem)).slice(0, 10)) {
    console.log(`     ${name.slice(0, 38).padEnd(38)} ${eur(m.mem)} → ${eur(m.after)}`)
  }
  const rows = [...cur.keys()]
    .map(id => ({ id, before: cur.get(id), after: next.get(id), byFilter: filtered.get(id) || 0 }))
    .sort((a, b) => b.after - a.after)
  console.log(`\n  Decks über ${BUDGET_LIMIT_EUR} € nach der Korrektur ` +
    `(davon = Anteil, der auf diesen Filter entfaellt):`)
  for (const r of rows) {
    if (r.after <= BUDGET_LIMIT_EUR) continue
    const flag = r.before <= BUDGET_LIMIT_EUR ? 'NEU über Limit' : 'war schon drüber'
    console.log(
      `     ${(deckName.get(r.id) || r.id).slice(0, 44).padEnd(44)} ` +
      `${eur(r.before)} → ${eur(r.after)}  (davon ${eur(r.byFilter)} Filter, ${flag})`
    )
  }
  const tipsOnlyByFilter = rows.filter(r => r.before <= BUDGET_LIMIT_EUR && r.before + r.byFilter > BUDGET_LIMIT_EUR)
  console.log(`\n  Decks, die ALLEIN durch den Filter über ${BUDGET_LIMIT_EUR} € kippen: ${tipsOnlyByFilter.length}`)
  for (const r of tipsOnlyByFilter) {
    console.log(`     ${(deckName.get(r.id) || r.id).slice(0, 44).padEnd(44)} ${eur(r.before)} → ${eur(r.before + r.byFilter)}`)
  }

  console.log(`\n${failures === 0 ? 'Dry-Run grün.' : `Dry-Run ROT: ${failures} Gate(s) verletzt.`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(err => { console.error(err); process.exit(1) })

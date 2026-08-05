#!/usr/bin/env node
// apply.mjs — bestätigte Deck-Änderungen abbruchsicher in Supabase schreiben.
//
// Usage:
//   node scripts/optimizer/apply.mjs --swap swap.json          # Dry-Run (Plan + Gates)
//   node scripts/optimizer/apply.mjs --swap swap.json --yes    # ausführen
//   node scripts/optimizer/apply.mjs --resume <journal.json>   # abgebrochenen Lauf zu Ende führen
//   node scripts/optimizer/apply.mjs --probe                   # Atomaritäts-Probe (Wegwerf-Deck)
//
// swap.json: { "deck": "<id oder Name>", "cuts": ["Karte", ...], "adds": ["Karte", ...] }
//
// Sicherheits-Design (Plan + Critic-Runden):
//   - Gates VOR jedem Write: validate (Pool/CI/Singleton, strict 24h-Pool),
//     Budget-Gate mit FRISCH gelesenen cheapest_eur (zweiter Check beim Apply).
//   - Reihenfolge: 1 atomarer Bulk-INSERT, dann 1 atomarer Bulk-DELETE — bei
//     Abbruch hat das Deck nie zu wenige Karten. Atomarität per --probe belegt.
//   - Journal + DB-verifizierendes --resume: vor Resume-Writes wird der LIVE-
//     Deckstand gelesen und nur ausgeführt, was wirklich fehlt (Ack-Verlust-
//     Race: serverseitig committeter Insert wird nie dupliziert).
//   - Insert-Rows spiegeln exakt den Website-Add-Pfad (extractCardData +
//     cheapest_eur, deck-view.js setupAddCard).

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ensurePool, formatDatenstand } from './lib/cardpool.mjs'
import { commanderColorIdentity, validateCandidate } from './lib/validate.mjs'
import { budgetGate, deckValue, BUDGET_LIMIT_EUR } from './lib/budget.mjs'
import { renderTable, formatEur, heading } from './lib/format.mjs'

const CACHE_DIR = fileURLToPath(new URL('./.cache/', import.meta.url))
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function resolveDeck(target) {
  const { getDeck, getDeckCards, getAllDecksWithPlayers } = await import('./lib/supabase.mjs')
  let deck
  if (UUID_RE.test(target)) {
    deck = await getDeck(target)
    if (!deck) throw new Error(`Kein Deck mit ID ${target}`)
  } else {
    const decks = await getAllDecksWithPlayers()
    const hits = decks.filter(d => d.name.toLowerCase().includes(target.toLowerCase()))
    if (hits.length !== 1) throw new Error(hits.length === 0 ? `Kein Deck matcht "${target}"` : `Mehrdeutig: ${hits.map(d => d.name).join(', ')}`)
    deck = hits[0]
  }
  return { deck, cards: await getDeckCards(deck.id) }
}

// Scryfall verlangt einen echten User-Agent — src/scryfall.js (Browser-Code)
// setzt keinen und bekommt aus Node HTTP 400 subcode generic_user_agent
// (live diagnostiziert 04.08.2026). Deshalb hier ein eigener Fetch mit den
// Pflicht-Headern; extractCardData aus src/ bleibt die eine Row-Wahrheit.
const SCRYFALL_HEADERS = {
  'User-Agent': 'mtg-website-deck-optimizer/1.0 (+https://github.com/tctablet/mtg-website)',
  Accept: 'application/json',
}

async function fetchNamedCard(name) {
  const res = await fetch(
    `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`,
    { headers: SCRYFALL_HEADERS }
  )
  if (!res.ok) return null
  return res.json()
}

// Insert-Row exakt wie der Website-Add-Pfad (deck-view.js:296-310) — inklusive
// type_category (deck-view.js:305): extractCardData liefert das Feld NICHT,
// ohne es landen Karten im UI unter "Sonstige" (Live-Fund 04.08.2026).
async function buildInsertRows(deckId, addNames) {
  const { extractCardData } = await import('../../src/scryfall.js')
  const { getTypeCategory } = await import('../../src/utils.js')
  const { fetchCheapestPrices } = await import('./lib/supabase.mjs')
  const cheapest = await fetchCheapestPrices(addNames)
  const rows = []
  for (const name of addNames) {
    const scryfallCard = await fetchNamedCard(name)
    if (!scryfallCard) throw new Error(`Scryfall kennt "${name}" nicht — Abbruch vor jedem Write.`)
    const data = extractCardData(scryfallCard)
    const cheap = cheapest.get(data.name) ?? cheapest.get(name)
    rows.push({
      deck_id: deckId,
      ...data,
      type_category: getTypeCategory(data.type_line),
      quantity: 1,
      price_eur: cheap?.price != null ? cheap.price : data.price_eur,
      price_is_foil: cheap?.isFoil ?? false,
      price_updated_at: new Date().toISOString(),
    })
    await new Promise(r => setTimeout(r, 120)) // Scryfall-Rate-Limit (2/s auf named)
  }
  return rows
}

function summarizeGate(gate) {
  if (gate.ok) return `Budget ok: ${formatEur(gate.total)} / ${formatEur(gate.limit)}`
  if (gate.reason === 'unknown-price') return `GEBLOCKT: Preis unbekannt für ${gate.cards.join(', ')} (zählt NIE als 0 €)`
  return `GEBLOCKT: ${formatEur(gate.total)} > ${formatEur(gate.limit)}`
}

async function preflight({ deck, cards, cuts, adds }) {
  // Pool strikt frisch (Gate-Politik 24h) — Banlist-Stand darf nicht alt sein.
  const { index, meta } = await ensurePool({ maxAgeHours: 24, strict: true, log: console.error })
  console.error(formatDatenstand(meta))

  const commanders = [deck.commander, deck.commander2].filter(Boolean)
  const { ci: deckCI } = commanderColorIdentity(index, commanders)

  // Pool-freie Swap-Regeln (Commander-nie-Cut, Cut-im-Deck, Duplikat-Adds,
  // adds∩cuts) leben in lib/preflight.mjs — Browser-Wizard prüft über
  // DIESELBE Funktion (M6, eine Wahrheit). checkAddsInDeck: false, weil
  // validateCandidate unten das Duplikat bereits meldet.
  const { preflightSwapRules } = await import('./lib/preflight.mjs')
  const errors = preflightSwapRules({ cards, commanders, cuts, adds, checkAddsInDeck: false })
  const lowerNames = cards.map(c => c.name.toLowerCase())
  const commanderSet = new Set(commanders.map(c => c.toLowerCase()))

  const cutRows = []
  for (const cut of cuts) {
    if (commanderSet.has(cut.toLowerCase())) continue // bereits als Fehler gemeldet
    const rows = cards.filter(c => c.name.toLowerCase() === cut.toLowerCase())
    if (rows.length > 0) cutRows.push({ name: rows[0].name, ids: rows.map(r => r.id) })
  }

  // existingNames wächst pro validiertem Add mit. Batch-Duplikate wurden oben
  // schon gemeldet — hier nur EINMAL pro Name validieren, damit derselbe
  // Root-Cause nicht zwei widersprüchliche Meldungen erzeugt (Critic Runde 2).
  const remainingNames = lowerNames.filter(n => !cuts.some(c => c.toLowerCase() === n))
  const uniqueAdds = adds.filter((a, i) => adds.findIndex(x => x.toLowerCase() === a.toLowerCase()) === i)
  for (const add of uniqueAdds) {
    const v = validateCandidate({ name: add, index, deckCI, existingNames: remainingNames })
    if (!v.ok) errors.push(`Add "${add}": ${v.reason}`)
    else remainingNames.push(v.record.name.toLowerCase())
  }

  // Budget-Gate mit frischen Preisen — auch beim Resume erneut.
  const { fetchCheapestPrices } = await import('./lib/supabase.mjs')
  const priceMap = await fetchCheapestPrices(adds)
  const gate = budgetGate({
    currentCards: cards,
    cuts,
    adds: adds.map(name => ({ name, price: priceMap.get(name)?.price ?? null })),
  })
  if (!gate.ok) errors.push(summarizeGate(gate))

  return { errors, gate, cutRows, deckCI }
}

async function executeSwap({ deck, cards, cuts, adds, yes }) {
  const { errors, gate, cutRows } = await preflight({ deck, cards, cuts, adds })

  const current = deckValue(cards)
  console.log(heading(`Apply-Plan: ${deck.name}`))
  console.log(renderTable(
    [
      ...cutRows.map(c => ({ op: 'OUT', name: c.name })),
      ...adds.map(name => ({ op: 'IN', name })),
    ],
    [{ key: 'op', label: 'Op' }, { key: 'name', label: 'Karte' }]
  ))
  console.log(`Aktueller Wert: ${formatEur(current.total)} → ${gate.ok ? formatEur(gate.total) : '—'} (Limit ${formatEur(BUDGET_LIMIT_EUR)})`)

  if (errors.length) {
    console.log(heading('GEBLOCKT — kein Write ausgeführt'))
    for (const e of errors) console.log(`  ✗ ${e}`)
    process.exit(2)
  }
  if (!yes) {
    console.log('\nDry-Run ok. Ausführen mit: --yes')
    return
  }

  // Journal VOR dem ersten Write.
  await mkdir(CACHE_DIR, { recursive: true })
  const journalFile = `${CACHE_DIR}apply-${deck.id}-${Date.now()}.json`
  const journal = {
    version: 1, deckId: deck.id, deckName: deck.name,
    createdAt: new Date().toISOString(),
    cuts: cutRows, adds, state: 'plan',
  }
  await writeFile(journalFile, JSON.stringify(journal, null, 2))
  console.log(`Journal: ${journalFile}`)

  try {
    await writeSwap({ journal, journalFile })
  } catch (err) {
    // Der Resume-Hinweis muss IN der Fehlermeldung stehen — die letzte Zeile
    // ist das Einzige, was sicher gelesen wird (Critic-Finding).
    throw new Error(`${err.message}\n→ Lauf fortsetzen mit: node scripts/optimizer/apply.mjs --resume ${journalFile}`)
  }
}

async function writeSwap({ journal, journalFile }) {
  const { supabase, insertCards, getDeckCards } = await import('./lib/supabase.mjs')

  // 1) Inserts zuerst (1 atomarer Bulk-POST) — Deck hat nie zu WENIG Karten.
  if (journal.adds.length && journal.state === 'plan') {
    const rows = await buildInsertRows(journal.deckId, journal.adds)
    await insertCards(rows)
    journal.state = 'inserts_done'
    await writeFile(journalFile, JSON.stringify(journal, null, 2))
  }

  // 2) Deletes (1 atomarer Bulk-DELETE über alle Cut-Row-IDs).
  const allIds = journal.cuts.flatMap(c => c.ids)
  if (allIds.length) {
    const { error } = await supabase.from('cards').delete().in('id', allIds)
    if (error) throw error
  }
  journal.state = 'done'
  await writeFile(journalFile, JSON.stringify(journal, null, 2))

  // 3) Verifikation gegen die Live-DB.
  const live = await getDeckCards(journal.deckId)
  const liveNames = new Set(live.map(c => c.name.toLowerCase()))
  const missingAdds = journal.adds.filter(a => !liveNames.has(a.toLowerCase()))
  const lingering = journal.cuts.filter(c => liveNames.has(c.name.toLowerCase()))
  const value = deckValue(live)

  console.log(heading('Ergebnis (Live-DB verifiziert)'))
  console.log(`  Karten: ${live.reduce((s, c) => s + (c.quantity || 1), 0)} · Wert: ${formatEur(value.total)} / ${formatEur(BUDGET_LIMIT_EUR)}`)
  if (missingAdds.length || lingering.length) {
    console.log(`  ⚠ Unvollständig — fehlende Adds: ${missingAdds.join(', ') || '—'} · verbliebene Cuts: ${lingering.map(c => c.name).join(', ') || '—'}`)
    console.log(`  → mit --resume ${journalFile} zu Ende führen.`)
    process.exit(3)
  }
  console.log('  ✓ Alle Adds drin, alle Cuts raus.')
}

// Pure: Journal gegen den LIVE-Deckstand abgleichen — nur was wirklich fehlt,
// wird erneut ausgeführt. Deckt das Ack-Verlust-Race ab: Insert serverseitig
// committed, Antwort verloren, Journal blieb auf 'plan' → Resume darf den
// Insert NICHT wiederholen. (Fault-Injection-Test in tests/optimizer-apply.)
export function reconcileJournal(journal, liveCards) {
  const liveNames = new Set(liveCards.map(c => c.name.toLowerCase()))
  const liveIds = new Set(liveCards.map(c => c.id))
  const adds = journal.adds.filter(a => !liveNames.has(a.toLowerCase()))
  const cuts = journal.cuts
    .map(c => ({ ...c, ids: c.ids.filter(id => liveIds.has(id)) }))
    .filter(c => c.ids.length > 0)
  return { ...journal, adds, cuts, state: adds.length === 0 ? 'inserts_done' : 'plan' }
}

async function resume(journalFile) {
  let journal = JSON.parse(await readFile(journalFile, 'utf8'))
  if (journal.state === 'done') { console.log('Journal ist bereits done.'); return }

  // DB-verifizierend: NUR ausführen, was live wirklich noch fehlt (Ack-Verlust).
  const { getDeck, getDeckCards } = await import('./lib/supabase.mjs')
  const deck = await getDeck(journal.deckId)
  if (!deck) throw new Error(`Deck ${journal.deckId} existiert nicht mehr.`)
  const live = await getDeckCards(journal.deckId)
  journal = reconcileJournal(journal, live)

  // Budget-Gate erneut gegen den Live-Stand (Preise können sich geändert haben).
  const { errors } = await preflight({
    deck, cards: live,
    cuts: journal.cuts.map(c => c.name),
    adds: journal.adds,
  })
  if (errors.length) {
    console.log(heading('Resume GEBLOCKT'))
    for (const e of errors) console.log(`  ✗ ${e}`)
    process.exit(2)
  }

  console.log(`Resume: ${journal.adds.length} Adds, ${journal.cuts.length} Cuts noch offen.`)
  try {
    await writeSwap({ journal, journalFile })
  } catch (err) {
    // Auch der ZWEITE Fehlversuch muss den Weg zurück nennen (Critic Runde 2).
    throw new Error(`${err.message}\n→ Erneut fortsetzen mit: node scripts/optimizer/apply.mjs --resume ${journalFile}`)
  }
}

// Atomaritäts-Probe (Plan: Pflicht vor produktiver apply-Nutzung): Bulk-Insert
// mit einer absichtlich kaputten Row auf ein Wegwerf-Deck — erwartet: Fehler
// UND 0 eingefügte Rows. Räumt hinterher auf.
async function probe() {
  const { supabase, getDeckCards } = await import('./lib/supabase.mjs')
  const { data: players, error: pErr } = await supabase.from('players').select('id').limit(1)
  if (pErr || !players?.length) throw new Error(`Kein Player für die Probe: ${pErr?.message}`)

  const { data: deckRows, error: dErr } = await supabase
    .from('decks')
    .insert({ player_id: players[0].id, name: 'ATOMICITY-PROBE-DELETE-ME', commander: 'Probe' })
    .select()
  if (dErr) throw new Error(`Probe-Deck anlegen fehlgeschlagen: ${dErr.message}`)
  const deckId = deckRows[0].id

  try {
    const { error } = await supabase.from('cards').insert([
      { deck_id: deckId, name: 'Probe Valid', quantity: 1 },
      { deck_id: deckId, name: null, quantity: 1 }, // NOT-NULL-Verletzung
    ])
    const after = await getDeckCards(deckId)
    console.log(heading('Atomaritäts-Probe (PostgREST Bulk-Insert)'))
    console.log(`  Insert-Fehler erwartet: ${error ? `ja (${error.code})` : 'NEIN — unerwartet!'}`)
    console.log(`  Rows nach Fehler: ${after.length} (erwartet 0)`)
    if (error && after.length === 0) {
      console.log('  ✓ DB-ATOMAR: Ein Bulk-Insert mit Constraint-Fehler schreibt 0 Rows.')
      console.log('  Hinweis: belegt die Transaktions-Garantie EINES Requests — den orthogonalen')
      console.log('  Netzwerk-Ack-Verlust-Fall deckt reconcileJournal/--resume ab (eigener Test).')
    } else {
      console.log('  ✗ NICHT atomar — apply.mjs muss auf Einzel-Writes mit Journal-Eintrag pro Karte umgestellt werden!')
      process.exitCode = 4
    }
  } finally {
    await supabase.from('cards').delete().eq('deck_id', deckId)
    await supabase.from('decks').delete().eq('id', deckId)
    const gone = await supabase.from('decks').select('id').eq('id', deckId)
    console.log(`  Cleanup: Probe-Deck entfernt (verifiziert: ${gone.data?.length === 0 ? 'ja' : 'NEIN'})`)
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const get = flag => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null }

  if (argv.includes('--probe')) return probe()
  const resumeFile = get('--resume')
  if (resumeFile) return resume(resumeFile)

  const swapFile = get('--swap')
  if (!swapFile) {
    console.error('Usage: apply.mjs --swap swap.json [--yes] | --resume <journal> | --probe')
    process.exit(1)
  }
  const swap = JSON.parse(await readFile(swapFile, 'utf8'))
  if (!swap.deck || !Array.isArray(swap.cuts) || !Array.isArray(swap.adds)) {
    throw new Error('swap.json braucht { deck, cuts: [], adds: [] }')
  }
  const { deck, cards } = await resolveDeck(swap.deck)
  await executeSwap({ deck, cards, cuts: swap.cuts, adds: swap.adds, yes: argv.includes('--yes') })
}

// Direct-Run-Guard (Repo-Muster aus sync-prices.mjs): beim Import durch
// Tests/andere Module darf die CLI nicht mitlaufen.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(err => {
    console.error(`Fehler: ${err.message}`)
    process.exit(1)
  })
}

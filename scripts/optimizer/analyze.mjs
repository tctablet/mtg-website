#!/usr/bin/env node
// analyze.mjs — Deck-Report: Quoten, Manabase, Budget, Bracket, Legalität.
//
// Usage:
//   node scripts/optimizer/analyze.mjs <deck-id | Deckname-Fragment> [--refresh] [--json]
//   node scripts/optimizer/analyze.mjs --file liste.json --commander "Name" [--commander2 "Name"]
//
// --file: JSON-Array [{ name, quantity }] — für hypothetische Listen
//         (Critic-Re-Run im Optimizer-Loop). Preise kommen dann aus
//         scryfall_prices (cheapest_eur), wie beim Website-Import.
// --json: maschinenlesbarer Voll-Output (für Skill/Critic), Tabellen entfallen.
//
// Semantik-Regel (Plan): Reports FLAGGEN, Gates BLOCKEN — dieses CLI bricht
// nie wegen einer einzelnen Karte ab.

import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ensurePool, formatDatenstand } from './lib/cardpool.mjs'
import { buildAnalysis } from './lib/report.mjs'
import { renderTable, formatEur, formatPct, heading } from './lib/format.mjs'

// Analyse-Kern lebt jetzt in lib/report.mjs (M5) — CLI und Browser-Wizard
// rufen dieselbe buildAnalysis(); Re-Export hält bestehende Test-Importe stabil.
export { enrich, bracketIndication } from './lib/report.mjs'

const OVERRIDES_FILE = fileURLToPath(new URL('./roles-overrides.json', import.meta.url))

function parseArgs(argv) {
  const args = { flags: new Set(), opts: {}, positional: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--refresh' || a === '--json') args.flags.add(a.slice(2))
    else if (a === '--file' || a === '--commander' || a === '--commander2') {
      args.opts[a.slice(2)] = argv[++i]
    } else args.positional.push(a)
  }
  return args
}

async function loadOverrides() {
  try {
    return JSON.parse(await readFile(OVERRIDES_FILE, 'utf8'))
  } catch (err) {
    // Fehlende Datei ist der Normalfall; eine KORRUPTE darf nie still zu
    // "keine Overrides" degradieren (Backend-Pack: kein silent catch).
    if (err.code !== 'ENOENT') console.error(`⚠ roles-overrides.json unlesbar (${err.message}) — Heuristik ohne Overrides.`)
    return {}
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function resolveDeck(arg) {
  const { getDeck, getDeckCards, getAllDecksWithPlayers, friendlyDbError } = await import('./lib/supabase.mjs')
  try {
    if (UUID_RE.test(arg)) {
      const deck = await getDeck(arg)
      if (!deck) throw new Error(`Kein Deck mit ID ${arg} (falsch getippt oder gelöscht?)`)
      return { deck, cards: await getDeckCards(arg) }
    }
    const decks = await getAllDecksWithPlayers()
    const hits = decks.filter(d => d.name.toLowerCase().includes(arg.toLowerCase()))
    if (hits.length === 0) throw new Error(`Kein Deck matcht "${arg}"`)
    if (hits.length > 1) {
      throw new Error(`Mehrdeutig: ${hits.map(d => `${d.name} (${d.id})`).join(', ')}`)
    }
    return { deck: hits[0], cards: await getDeckCards(hits[0].id) }
  } catch (err) {
    throw new Error(friendlyDbError(err))
  }
}

async function loadFromFile(path, commander, commander2) {
  const rows = JSON.parse(await readFile(path, 'utf8'))
  if (!Array.isArray(rows)) throw new Error('--file erwartet ein JSON-Array [{ name, quantity }]')
  const { fetchCheapestPrices } = await import('./lib/supabase.mjs')
  const priceMap = await fetchCheapestPrices(rows.map(r => r.name))
  const cards = rows.map(r => ({
    name: r.name,
    quantity: r.quantity ?? 1,
    price_eur: priceMap.get(r.name)?.price ?? null,
    type_line: null,
    mana_cost: null,
    cmc: null,
  }))
  return {
    deck: { name: `(Datei: ${path})`, commander: commander ?? null, commander2: commander2 ?? null },
    cards,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const json = args.flags.has('json')
  const log = json ? () => {} : console.log

  let deck, cards
  if (args.opts.file) {
    ;({ deck, cards } = await loadFromFile(args.opts.file, args.opts.commander, args.opts.commander2))
  } else {
    const target = args.positional[0]
    if (!target) {
      console.error('Usage: analyze.mjs <deck-id|Name> [--refresh] [--json] | --file liste.json --commander "Name"')
      process.exit(1)
    }
    ;({ deck, cards } = await resolveDeck(target))
  }

  const { index, meta } = await ensurePool({
    maxAgeHours: 168,
    refresh: args.flags.has('refresh'),
    log: console.error,
  })
  const overrides = await loadOverrides()

  // Der komplette Analyse-Kern (Shape von --json) lebt in lib/report.mjs —
  // hier nur noch datenstand ergänzen und rendern.
  const { deck: deckInfo, ...analysis } = buildAnalysis({ deck, cards, index, overrides })
  const result = { deck: deckInfo, datenstand: meta, ...analysis }

  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  log(`\nDeck: ${deck.name}${deckInfo.commanders.length ? ` — ${deckInfo.commanders.join(' + ')}` : ''}`)
  log(formatDatenstand(meta))

  log(heading('Quoten (Command-Zone-Template Ep. 658)'))
  log(renderTable(
    result.quotas.map(t => ({ ...t, soll: `${t.min}–${t.max}`, status: t.status === 'ok' ? '✓' : `⚠ ${t.status}` })),
    [
      { key: 'label', label: 'Kategorie' },
      { key: 'have', label: 'Ist', align: 'right' },
      { key: 'soll', label: 'Soll', align: 'right' },
      { key: 'status', label: '' },
    ]
  ))

  log(heading('Konsistenz (Hypergeometrik, on the play)'))
  log(renderTable(
    Object.entries(result.hypergeo).map(([k, v]) => ({ metric: k, p: formatPct(v) })),
    [{ key: 'metric', label: 'Metrik' }, { key: 'p', label: 'P', align: 'right' }]
  ))

  log(heading('Manabase (Karsten)'))
  log(`Avg MV (nonland): ${result.manabase.avgMV} · Länder: ${result.manabase.landsHave} · Karsten-Empfehlung: ${result.manabase.landTarget}`)
  if (result.manabase.colorSources.length) {
    log(renderTable(
      result.manabase.colorSources.map(c => ({
        ...c,
        target: c.target ?? '—',
        ok: c.ok ? '✓' : '⚠ zu wenig',
      })),
      [
        { key: 'color', label: 'Farbe' },
        { key: 'pips', label: 'Pips', align: 'right' },
        { key: 'maxEarlyPips', label: 'max Pips ≤4 MV', align: 'right' },
        { key: 'sources', label: 'Quellen', align: 'right' },
        { key: 'target', label: 'Richtwert', align: 'right' },
        { key: 'ok', label: '' },
      ]
    ))
  }

  log(heading('Budget (Website-Formel, Limit 500 €)'))
  log(`Gesamtwert: ${formatEur(result.budget.total)}${result.budget.total > 500 ? '  ⚠ ÜBER LIMIT' : ''}`)
  if (result.budget.missing.length) log(`⚠ Preis unbekannt (zählt NICHT als 0 € im Gate): ${result.budget.missing.join(', ')}`)
  log(renderTable(
    result.budget.top.map(c => ({ name: c.name, eur: formatEur(c.eur) })),
    [{ key: 'name', label: 'Teuerste Karten' }, { key: 'eur', label: '€', align: 'right' }]
  ))

  log(heading('Bracket-Indikation'))
  log(`Game Changers: ${result.bracket.gameChangers.length} → Bracket ${result.bracket.bracket}`)
  if (result.bracket.gameChangers.length) log(`  ${result.bracket.gameChangers.join(', ')}`)
  if (result.bracket.extraTurns.length) log(`Extra Turns: ${result.bracket.extraTurns.join(', ')}`)
  if (result.bracket.mld.length) log(`Mass Land Denial: ${result.bracket.mld.join(', ')}`)
  log(`Interaktion: ${result.interaction.count}/${result.interaction.nonland} nonland (${formatPct(result.interaction.density)}), davon instant-speed: ${result.interaction.instantSpeed}`)

  if (result.audit.findings.length) {
    log(heading('Audit-Findings'))
    for (const f of result.audit.findings) {
      log(`  [${f.level}] ${f.kind}${f.name ? `: ${f.name}` : ''}${f.detail ? ` (${f.detail})` : ''}`)
    }
  }

  if (result.unclassified.length) {
    log(heading('Ohne Rolle (Synergie oder nachklassifizieren)'))
    log('  ' + result.unclassified.join(', '))
  }
}

// Direct-Run-Guard (Repo-Muster aus sync-prices.mjs): beim Import durch
// Tests/andere Module darf die CLI nicht mitlaufen.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(err => {
    console.error(`Fehler: ${err.message}`)
    process.exit(1)
  })
}

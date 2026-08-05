#!/usr/bin/env node
// goldfish.mjs — Monte-Carlo-Goldfish eines Decks (seeded, reproduzierbar).
//
// Usage: node scripts/optimizer/goldfish.mjs <deck-id|Name> [--seed 42] [--iterations 1000] [--turns 10] [--json]
//
// Grenzen (v1, bewusst): keine Gegner/Interaktion — Proxy-Metriken nach
// ScrollVault-Vorbild. Clocks: Combat (40 Leben, 1 Gegner) und Mill (99er-
// Bibliothek, 1 Gegner). Bracket-Turn-Fenster als Referenz: B1 T9+, B2 T8+,
// B3 T6+, B4 T4+ (offizielle Brackets, Stand Feb 2026).

import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ensurePool, lookupCard, formatDatenstand } from './lib/cardpool.mjs'
import { classifyCard, mergeOverrides } from './lib/roles.mjs'
import { toSimCard, simulate } from './lib/sim.mjs'
import { renderTable, formatPct, heading } from './lib/format.mjs'

const OVERRIDES_FILE = fileURLToPath(new URL('./roles-overrides.json', import.meta.url))
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function parseArgs(argv) {
  const args = { flags: new Set(), opts: {}, positional: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json' || a === '--refresh') args.flags.add(a.slice(2))
    else if (a === '--seed' || a === '--iterations' || a === '--turns') args.opts[a.slice(2)] = parseInt(argv[++i], 10)
    else args.positional.push(a)
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const target = args.positional[0]
  if (!target) {
    console.error('Usage: goldfish.mjs <deck-id|Name> [--seed N] [--iterations N] [--turns N] [--json]')
    process.exit(1)
  }

  const { getDeck, getDeckCards, getAllDecksWithPlayers, friendlyDbError } = await import('./lib/supabase.mjs')
  let deck, cards
  try {
    if (UUID_RE.test(target)) {
      deck = await getDeck(target)
      if (!deck) throw new Error(`Kein Deck mit ID ${target}`)
    } else {
      const decks = await getAllDecksWithPlayers()
      const hits = decks.filter(d => d.name.toLowerCase().includes(target.toLowerCase()))
      if (hits.length !== 1) throw new Error(hits.length === 0 ? `Kein Deck matcht "${target}"` : `Mehrdeutig: ${hits.map(d => d.name).join(', ')}`)
      deck = hits[0]
    }
    cards = await getDeckCards(deck.id)
  } catch (err) {
    console.error(`Fehler: ${friendlyDbError(err)}`)
    process.exit(1)
  }

  const { index, meta } = await ensurePool({ maxAgeHours: 168, refresh: args.flags.has('refresh'), log: console.error })
  let overrides = {}
  try {
    overrides = JSON.parse(await readFile(OVERRIDES_FILE, 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`⚠ roles-overrides.json unlesbar (${err.message}) — Heuristik ohne Overrides.`)
  }

  const simCards = cards.map(row => {
    const record = lookupCard(index, row.name)
    const effective = record ?? {
      name: row.name, type_line: row.type_line ?? '', mana_cost: row.mana_cost ?? '',
      cmc: row.cmc ?? 0, oracle_text: '', power: null, layout: 'normal',
    }
    const roles = mergeOverrides(row.name, classifyCard(effective), overrides)
    return toSimCard({ effective, roles, quantity: row.quantity ?? 1 })
  })

  const result = simulate(simCards, {
    iterations: args.opts.iterations ?? 1000,
    seed: args.opts.seed ?? 42,
    turns: args.opts.turns ?? 10,
  })

  if (args.flags.has('json')) {
    console.log(JSON.stringify({ deck: { id: deck.id, name: deck.name }, ...result }, null, 2))
    return
  }

  console.log(`\nGoldfish: ${deck.name} — ${result.iterations} Spiele, Seed ${result.seed}, ${result.turns} Züge`)
  console.log(formatDatenstand(meta))
  console.log(`\nKeep-Rate (7 Karten, 2–5 Länder): ${formatPct(result.keepRate)}`)

  console.log(heading('Verfügbares Mana / Länder (Ø je Zug)'))
  console.log(renderTable(
    [1, 2, 3, 4, 5, 6].map((t, i) => ({
      turn: `T${t}`,
      lands: result.landsAvg[i].toFixed(2),
      mana: result.manaAvg[i].toFixed(2),
    })),
    [{ key: 'turn', label: 'Zug' }, { key: 'lands', label: 'Länder', align: 'right' }, { key: 'mana', label: 'Mana', align: 'right' }]
  ))

  console.log(heading('Rollen: erster Cast (Median-Zug, Anteil Spiele)'))
  console.log(renderTable(
    Object.entries(result.roleMedians)
      .filter(([r]) => r !== 'land')
      .sort((a, b) => (a[1].median ?? 99) - (b[1].median ?? 99))
      .map(([role, v]) => ({ role, median: v.median ?? '—', games: formatPct(v.inGames) })),
    [{ key: 'role', label: 'Rolle' }, { key: 'median', label: 'Median-Zug', align: 'right' }, { key: 'games', label: 'in % Spiele', align: 'right' }]
  ))

  console.log(heading('Clocks (1 Gegner — Median / Ceiling top 5%)'))
  for (const [name, c] of Object.entries(result.clocks)) {
    const label = name === 'combat' ? 'Combat (40 Leben)' : 'Mill (99 Karten)'
    console.log(`  ${label}: ${c.median ? `T${c.median} Median / T${c.ceiling} Ceiling` : 'nicht erreicht'} (${formatPct(c.hitRate)} der Spiele in ${result.turns} Zügen)`)
  }
  console.log('\nBracket-Turn-Fenster zum Vergleich: B1 T9+ · B2 T8+ · B3 T6+ · B4 T4+ (offiziell, Feb 2026)')
  console.log('Hinweis: Goldfish ohne Gegner/Interaktion — Clocks sind obere Abschätzungen (Research Kap. 3).')
}

// Direct-Run-Guard (Repo-Muster aus sync-prices.mjs): beim Import durch
// Tests/andere Module darf die CLI nicht mitlaufen.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(err => {
    console.error(`Fehler: ${err.message}`)
    process.exit(1)
  })
}

#!/usr/bin/env node
// combos.mjs — Combo-Erkennung + Bracket-Schätzung via Commander Spellbook.
//
// Usage: node scripts/optimizer/combos.mjs <deck-id|Name> [--json] [--almost]
//
// API ohne Key, Live-verifiziert am 04.08.2026 (DECK-OPTIMIZER-RESEARCH.md
// Kap. 6): POST /find-my-combos und /estimate-bracket. Sequentiell mit kurzer
// Pause — Rate-Limits sind serverseitig undokumentiert, 429-Handling defensiv.

import { heading, renderTable } from './lib/format.mjs'
import { pathToFileURL } from 'node:url'

const API = 'https://backend.commanderspellbook.com'
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const BRACKET_TAGS = {
  E: 'Exhibition (B1)', C: 'Core (B2)', O: 'Oddball', P: 'Powerful (B3–4)',
  S: 'Spicy', R: 'Ruthless (B4–5)', B: 'enthält Banned-Karten',
}

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'mtg-website-deck-optimizer/1.0 (+https://github.com/tctablet/mtg-website)',
    },
    body: JSON.stringify(body),
  })
  if (res.status === 429) {
    throw new Error('Spellbook rate-limited (429) — kurz warten und erneut versuchen.')
  }
  if (!res.ok) throw new Error(`Spellbook ${path}: HTTP ${res.status}`)
  return res.json()
}

async function main() {
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  const showAlmost = argv.includes('--almost')
  const target = argv.filter(a => !a.startsWith('--'))[0]
  if (!target) {
    console.error('Usage: combos.mjs <deck-id|Name> [--json] [--almost]')
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

  const commanders = [deck.commander, deck.commander2].filter(Boolean)
  const commanderSet = new Set(commanders.map(c => c.toLowerCase()))
  const payload = {
    commanders: commanders.map(name => ({ card: name, quantity: 1 })),
    main: cards
      .filter(c => !commanderSet.has(c.name.toLowerCase()))
      .map(c => ({ card: c.name, quantity: c.quantity ?? 1 })),
  }

  const combos = await post('/find-my-combos', payload)
  await new Promise(r => setTimeout(r, 500))
  const bracket = await post('/estimate-bracket', payload)

  const included = combos.results?.included ?? combos.included ?? []
  const almost = combos.results?.almostIncluded ?? combos.almostIncluded ?? []

  if (json) {
    console.log(JSON.stringify({ deck: { id: deck.id, name: deck.name }, included, almostIncluded: almost, bracket }, null, 2))
    return
  }

  console.log(`\nCombos: ${deck.name} — ${commanders.join(' + ') || 'ohne Commander'}`)
  console.log(heading(`Im Deck montierbar: ${included.length}`))
  if (included.length) {
    console.log(renderTable(
      included.slice(0, 15).map(c => ({
        cards: (c.uses ?? []).map(u => u.card?.name).filter(Boolean).join(' + '),
        result: (c.produces ?? []).map(p => p.feature?.name ?? p.name).filter(Boolean).slice(0, 2).join('; '),
      })),
      [{ key: 'cards', label: 'Karten' }, { key: 'result', label: 'Ergebnis' }]
    ))
    if (included.length > 15) console.log(`  … und ${included.length - 15} weitere`)
  }

  console.log(`\nFast fertig (1 Karte fehlt): ${almost.length}${showAlmost ? '' : '  (--almost zeigt Details)'}`)
  if (showAlmost && almost.length) {
    console.log(renderTable(
      almost.slice(0, 10).map(c => ({
        cards: (c.uses ?? []).map(u => u.card?.name).filter(Boolean).join(' + '),
      })),
      [{ key: 'cards', label: 'Karten (eine davon fehlt im Deck)' }]
    ))
  }

  const tag = bracket.bracketTag ?? bracket.bracket_tag
  console.log(heading('Spellbook-Bracket-Schätzung'))
  console.log(`  ${tag}: ${BRACKET_TAGS[tag] ?? 'unbekanntes Tag'}`)
}

// Direct-Run-Guard (Repo-Muster aus sync-prices.mjs): beim Import durch
// Tests/andere Module darf die CLI nicht mitlaufen.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(err => {
    console.error(`Fehler: ${err.message}`)
    process.exit(1)
  })
}

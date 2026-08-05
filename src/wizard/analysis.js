// wizard/analysis.js — Deck-Analyse LIVE im Browser.
//
// Der Pool wird dafür NICHT gebraucht: fetchCardCollection liefert volle
// Scryfall-Objekte der 100 Deck-Karten; toPoolRecord + buildIndex bauen
// denselben Index, mit dem auch das CLI arbeitet, und buildAnalysis ist
// wortwörtlich dieselbe Funktion wie in `analyze --json` (Contract-Test:
// tests/report-contract.test.mjs).

import { fetchCardCollection } from '../scryfall.js'
import { toPoolRecord, buildIndex } from '../../scripts/optimizer/lib/pool-core.mjs'
import { buildAnalysis, enrich } from '../../scripts/optimizer/lib/report.mjs'
import { simulate, toSimCard } from '../../scripts/optimizer/lib/sim.mjs'

export async function analyzeDeck({ deck, cards }) {
  const names = cards.map(c => c.name)
  const { found, notFound } = await fetchCardCollection(names)
  const records = found.map(toPoolRecord)
  const index = buildIndex(records)
  const analysis = buildAnalysis({ deck, cards, index })
  const enriched = enrich(cards, index, {})
  return { analysis, enriched, index, notFound }
}

// Goldfish-Sim (optional, on demand): seeded + deterministisch, 500 Läufe <1s
export function runGoldfish(enriched, { iterations = 500 } = {}) {
  return simulate(enriched.map(toSimCard), { iterations, seed: 42 })
}

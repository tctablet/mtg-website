// report.mjs — der Analyse-Kern von analyze.mjs als geteilte, pure Funktion.
//
// CLI (analyze.mjs) und Browser (Wizard) rufen buildAnalysis() mit demselben
// Contract: der JSON-Shape von `analyze --json` IST dieses Result-Objekt
// (plus CLI-seitigem `datenstand`). Shape-Snapshot-Test:
// tests/optimizer-analyzer.test.mjs.
//
// index: ein buildIndex()-Index (pool-core). Das CLI übergibt den vollen
// Oracle-Pool; der Browser baut denselben Index aus der Scryfall-Collection
// der Deck-Karten (toPoolRecord) — identische Lookup-Semantik, kein Adapter.

import { lookupCard } from './pool-core.mjs'
import { classifyCard, mergeOverrides, isInteraction, isInstantSpeed } from './roles.mjs'
import { countRoles, compareToTemplate, pByTurn } from './quotas.mjs'
import {
  karstenLandCount, averageManaValue, colorSourceReport, splitFastMana,
} from './manabase.mjs'
import { deckValue } from './budget.mjs'
import { auditDeck } from './validate.mjs'

// Effektiver Datensatz pro Karte: Pool-Record, sonst DB-Row-Fallback (Karte
// fehlt im Pool → trotzdem Typ/Kosten aus der cards-Tabelle nutzbar).
export function enrich(cards, index, overrides) {
  return cards.map(row => {
    const record = lookupCard(index, row.name)
    const effective = record ?? {
      name: row.name,
      type_line: row.type_line ?? '',
      mana_cost: row.mana_cost ?? '',
      cmc: row.cmc ?? 0,
      oracle_text: '',
      color_identity: [],
      keywords: [],
      produced_mana: [],
      layout: 'normal',
      legal: 'unknown',
      game_changer: false,
      faces: null,
    }
    const roles = mergeOverrides(row.name, classifyCard(effective), overrides)
    return { row, record, effective, roles, quantity: row.quantity ?? 1 }
  })
}

export function bracketIndication(enriched) {
  const gameChangers = enriched.filter(e => e.record?.game_changer).map(e => e.row.name)
  const extraTurns = enriched.filter(e => /extra turn/i.test(e.effective.oracle_text)).map(e => e.row.name)
  const mld = enriched
    .filter(e => /destroy all lands|each player sacrifices? .{0,20}lands|lands don't untap/i.test(e.effective.oracle_text))
    .map(e => e.row.name)
  const n = gameChangers.length
  const bracket = n === 0 ? '1–2 (0 GC)' : n <= 3 ? `3 (${n} GC)` : `4–5 (${n} GC)`
  return { gameChangers, extraTurns, mld, bracket }
}

/**
 * Vollständiger Deck-Report (das --json-Result von analyze.mjs, ohne
 * `datenstand` — den ergänzt der jeweilige Aufrufer aus seiner Datenquelle).
 * @param deck   { id?, name, commander, commander2 }
 * @param cards  Deck-Rows ({ name, quantity, price_eur, type_line?, mana_cost?, cmc? })
 * @param index  buildIndex()-Index (voller Pool ODER Deck-Collection)
 */
export function buildAnalysis({ deck, cards, index, overrides = {} }) {
  const enriched = enrich(cards, index, overrides)

  // --- Audit (Legalität/Singleton/CI) ---
  const commanderNames = [deck.commander, deck.commander2].filter(Boolean)
  const audit = auditDeck({ cards, commanderNames, index })

  // --- Quoten ---
  const roleCounts = countRoles(enriched)
  const template = compareToTemplate(roleCounts)

  // --- Manabase ---
  const effectiveCards = enriched.map(e => ({ ...e.effective, quantity: e.quantity }))
  const avgMV = averageManaValue(effectiveCards)
  const rampCount = roleCounts.get('ramp') || 0
  const drawCount = roleCounts.get('draw') || 0
  const fastManaRaw = enriched.filter(e => e.roles.includes('ramp') && (e.effective.cmc ?? 99) <= 1).length
  const { rampForFormula, fastMana } = splitFastMana(rampCount, fastManaRaw)
  const mdfcLands = enriched.filter(e =>
    e.effective.layout === 'modal_dfc' &&
    e.effective.faces?.some(f => /Land/.test(f.type_line))
  )
  const mdfcTapped = mdfcLands.filter(e =>
    e.effective.faces.some(f => /Land/.test(f.type_line) && /enters (?:the battlefield )?tapped/i.test(f.oracle_text))
  ).length
  const mdfcUntapped = mdfcLands.length - mdfcTapped
  const landTarget = karstenLandCount({
    commanders: commanderNames.length || 1,
    avgMV, rampCount: rampForFormula, drawCount, fastMana, mdfcTapped, mdfcUntapped,
  })
  const colorSources = colorSourceReport(
    enriched.map(e => ({ record: e.record ?? e.effective, quantity: e.quantity }))
  )

  // --- Budget ---
  const value = deckValue(cards)
  const expensive = [...cards]
    .filter(c => !isNaN(parseFloat(c.price_eur)))
    .sort((a, b) => parseFloat(b.price_eur) * b.quantity - parseFloat(a.price_eur) * a.quantity)
    .slice(0, 5)

  // --- Bracket + Interaktion ---
  const bracket = bracketIndication(enriched)
  const interactionCards = enriched.filter(e => isInteraction(e.roles))
  const nonlandCount = enriched.filter(e => !e.roles.includes('land')).reduce((s, e) => s + e.quantity, 0)
  const interactionCount = interactionCards.reduce((s, e) => s + e.quantity, 0)
  const instantSpeedCount = interactionCards
    .filter(e => isInstantSpeed(e.effective))
    .reduce((s, e) => s + e.quantity, 0)

  const unclassified = enriched
    .filter(e => e.roles.length === 0 && e.record)
    .map(e => e.row.name)

  return {
    deck: { id: deck.id ?? null, name: deck.name, commanders: commanderNames },
    audit,
    quotas: template,
    hypergeo: {
      'P(≥3 Länder bis T3)': pByTurn(3, roleCounts.get('land') || 0, 3),
      'P(≥1 Ramp bis T3)': pByTurn(1, rampCount, 3),
      'P(≥1 Draw bis T4)': pByTurn(1, drawCount, 4),
      'P(≥1 Removal bis T4)': pByTurn(1, (roleCounts.get('removal') || 0), 4),
    },
    manabase: { avgMV, landTarget, landsHave: roleCounts.get('land') || 0, mdfcTapped, mdfcUntapped, colorSources },
    budget: { ...value, limit: 500, top: expensive.map(c => ({ name: c.name, eur: parseFloat(c.price_eur) * c.quantity })) },
    bracket,
    interaction: {
      count: interactionCount,
      nonland: nonlandCount,
      density: nonlandCount ? interactionCount / nonlandCount : 0,
      instantSpeed: instantSpeedCount,
    },
    unclassified,
    roles: Object.fromEntries(enriched.map(e => [e.row.name, e.roles])),
  }
}

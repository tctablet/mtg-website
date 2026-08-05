// budget.mjs — das 500-€-Gate (pure, testbar).
//
// Der Deck-Ist-Wert nutzt EXAKT die Website-Formel (src/utils.js:
// formatTotalPrice): sum(parseFloat(price_eur) * quantity). Paritätstest in
// tests/optimizer-budget.test.mjs importiert die echte Website-Funktion.
//
// Gate-Semantik ist STRENGER als der Report: eine Karte ohne Preis wird im
// Report als "Preis unbekannt" gelistet (nie als 0 € gewertet), im Gate
// BLOCKIERT sie — sonst wäre das 500-€-Limit über frisch gespoilte Karten
// still umgehbar (Critic-Finding, Runde 1).

export const BUDGET_LIMIT_EUR = 500

// Website-Parität: identische Semantik wie formatTotalPrice (fehlender Preis
// zählt 0 in die SUMME — dafür wird er separat als "missing" gemeldet).
export function deckValue(cards) {
  let total = 0
  const missing = []
  for (const c of cards) {
    const q = c.quantity || 1 // exakt wie formatTotalPrice (|| statt ??)
    const p = parseFloat(c.price_eur)
    if (isNaN(p)) {
      missing.push(c.name)
      continue
    }
    total += p * q
  }
  return { total: Math.round(total * 100) / 100, missing }
}

/**
 * Gate für einen vorgeschlagenen Swap.
 * @param currentCards  aktuelle Deck-Rows (price_eur, quantity, name)
 * @param cuts          Namen der zu entfernenden Karten
 * @param adds          [{ name, price }] — price = cheapest_eur aus scryfall_prices,
 *                      null/undefined wenn dort kein Treffer
 */
export function budgetGate({ currentCards, cuts = [], adds = [] }) {
  const cutSet = new Set(cuts.map(n => n.toLowerCase()))
  const remaining = currentCards.filter(c => !cutSet.has((c.name || '').toLowerCase()))
  const base = deckValue(remaining)

  const unknownAdds = adds.filter(a => a.price == null || isNaN(parseFloat(a.price)))
  if (unknownAdds.length > 0) {
    return {
      ok: false,
      reason: 'unknown-price',
      cards: unknownAdds.map(a => a.name),
      total: null,
    }
  }

  const addsTotal = adds.reduce((s, a) => s + parseFloat(a.price), 0)
  const total = Math.round((base.total + addsTotal) * 100) / 100

  if (total > BUDGET_LIMIT_EUR) {
    return { ok: false, reason: 'over-budget', total, limit: BUDGET_LIMIT_EUR }
  }
  return { ok: true, total, limit: BUDGET_LIMIT_EUR, missingInDeck: base.missing }
}

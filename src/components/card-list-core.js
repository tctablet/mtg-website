// card-list-core.js — DOM-freie Logik der Kartenliste (node-testbar).
// Von card-list.js benutzt; Tests: tests/card-list.test.mjs.

import { TYPE_ORDER } from '../utils.js'

// Anzahl + Summe einer Kartenmenge — eine Wahrheit für Gruppen-Header
// (Erst-Render UND Refresh nach Mutation nutzen dieselbe Rechnung).
export function summarizeCards(cards) {
  return {
    count: cards.reduce((s, c) => s + (c.quantity || 1), 0),
    total: cards.reduce((s, c) => s + (parseFloat(c.price_eur) || 0) * (c.quantity || 1), 0),
  }
}

// Ordnungsindex einer Kategorie für das Einsortieren neuer Sections:
// TYPE_ORDER-Reihenfolge, 'other' (und Unbekanntes) am Ende.
export function categoryOrderIndex(category) {
  const idx = TYPE_ORDER.findIndex(t => t.key === category)
  return idx === -1 ? TYPE_ORDER.length : idx
}

// Erste Position, an der `card` laut sortFn VOR dem bestehenden Eintrag liegt;
// -1 = ans Ende anhängen.
export function insertIndexFor(rowCards, card, sortFn) {
  for (let i = 0; i < rowCards.length; i++) {
    if (sortFn(rowCards[i], card) > 0) return i
  }
  return -1
}

// deck-mutations.js — die eine Wahrheit für Deck-Writes (Add, Swap, Undo).
// Add-Bar, Swap-Picker und Wizard-Apply laufen alle über diese Funktionen.
//
// Feld-Parität: Insert-Rows entstehen hier strukturell EXAKT wie im CLI-Pfad
// (scripts/optimizer/apply.mjs buildInsertRows) — beide spreaden extractCardData
// und ergänzen dieselben Felder. Paritätstest: tests/deck-mutations.test.mjs.
//
// Swap-Reihenfolge: erst atomarer INSERT, dann DELETE (apply.mjs-Parität) —
// bricht der Delete ab, hat das Deck 101 Karten, nie 99.

import { fetchCardByName, extractCardData } from './scryfall.js'
import { getTypeCategory } from './utils.js'
import { fetchCheapestPrices, insertCardsReturning, deleteCard } from './supabase.js'
import { budgetGate } from '../scripts/optimizer/lib/budget.mjs'

// Spalten der cards-Tabelle, die ein Re-Insert (Undo) mitnehmen darf — `id`
// bleibt draußen (vergibt die DB), `proxy_image_uri` bleibt DRIN: die
// kuratierte Artwork-Auswahl übersteht den Undo verlustfrei.
const CARD_COLUMNS = [
  'deck_id', 'name', 'scryfall_id', 'type_line', 'type_category', 'mana_cost',
  'cmc', 'image_uri', 'price_eur', 'price_is_foil', 'price_updated_at',
  'commander_legality', 'quantity', 'proxy_image_uri',
]

export function rowToInsert(deckId, row) {
  const out = {}
  for (const col of CARD_COLUMNS) {
    if (row[col] !== undefined) out[col] = row[col]
  }
  out.deck_id = deckId
  return out
}

// Entfernt die Karte aus dem lokalen Array und gibt die Row zurück (Bug-a-Fix:
// vorher driftete das Array nach einem Delete und die Karte tauchte beim
// nächsten Sortierwechsel wieder auf).
export function applyLocalDelete(cards, cardId) {
  const idx = cards.findIndex(c => c.id === cardId)
  if (idx === -1) return null
  return cards.splice(idx, 1)[0]
}

// Budget-Delta für einen Einzel-Swap — Gate-Semantik wie apply.mjs (Preis
// unbekannt zählt NIE als 0 €, sondern blockt). Der Cut wird per ROW-ID
// entfernt, nicht per Name: budgetGates Name-Cut würde bei mehreren
// gleichnamigen Rows (Basics, Alt-Importe) zu viel herausrechnen und den
// Tausch fälschlich freigeben (Critic-Fund).
export function swapBudget({ cards, cutCard, addName, addPrice }) {
  const remaining = cutCard ? cards.filter(c => c.id !== cutCard.id) : cards
  return budgetGate({
    currentCards: remaining,
    cuts: [],
    adds: [{ name: addName, price: addPrice }],
  })
}

// Pure Row-Assembly (testbar ohne Netz): Scryfall-Daten + cheapest_eur-Override.
// Bewusste Nuance ggü. apply.mjs: ohne scryfall_prices-Treffer behält der
// Website-Pfad das Printing-price_is_foil (Bestandsverhalten seit f0c1df7);
// apply.mjs setzt dort hart false. Die FELDMENGE ist identisch (Paritätstest),
// die Foil-Fallback-Semantik folgt der Website als User-facing-Wahrheit.
export function assembleInsertRow({ deckId, data, cheapest }) {
  return {
    deck_id: deckId,
    ...data,
    type_category: getTypeCategory(data.type_line),
    quantity: 1,
    price_eur: cheapest?.price != null ? cheapest.price : data.price_eur,
    price_is_foil: cheapest?.price != null ? !!cheapest.isFoil : data.price_is_foil,
    price_updated_at: new Date().toISOString(),
  }
}

// Vollständige Insert-Row für einen Kartennamen — extrahiert aus dem alten
// addCardToDeck-Pfad (deck-view.js). null = Scryfall kennt den Namen nicht.
export async function buildCardInsertRow(deckId, cardName) {
  const scryfallCard = await fetchCardByName(cardName)
  if (!scryfallCard) return null
  const data = extractCardData(scryfallCard)
  const cheapest = (await fetchCheapestPrices([data.name])).get(data.name)
  return assembleInsertRow({ deckId, data, cheapest })
}

// Einzelkarten-Swap: cutCard raus, addName rein. Mutiert `cards` in place.
// deps nur für Tests (DI) — Produktion nutzt die echten DB-Funktionen.
export async function swapCard({ deckId, cards, cutCard, addName }, deps = {}) {
  const {
    buildRow = buildCardInsertRow,
    insert = insertCardsReturning,
    remove = deleteCard,
  } = deps

  const row = await buildRow(deckId, addName)
  if (!row) return { status: 'not-found', addName }

  const [newRow] = await insert([row])
  cards.push(newRow)

  try {
    await remove(cutCard.id)
  } catch (err) {
    // Deck hat jetzt 101 Karten — nie zu wenige. UI bietet Delete-Retry an.
    return { status: 'delete-failed', newRow, error: err }
  }
  applyLocalDelete(cards, cutCard.id)
  return { status: 'ok', newRow, removedRow: cutCard }
}

// Undo eines Swaps: exakt die ORIGINAL-Row re-inserten (inkl. proxy_image_uri
// und quantity — kein frisches buildCardInsertRow!), dann die neue Karte raus.
export async function undoSwap({ deckId, cards, originalRow, newRow }, deps = {}) {
  const { insert = insertCardsReturning, remove = deleteCard } = deps

  const [restored] = await insert([rowToInsert(deckId, originalRow)])
  cards.push(restored)

  try {
    await remove(newRow.id)
  } catch (err) {
    return { status: 'delete-failed', restored, error: err }
  }
  applyLocalDelete(cards, newRow.id)
  return { status: 'ok', restored }
}

// deck-mutations.test.mjs — Datenpfad-Fundament von Edit v2.
//
// Kernpunkte: (1) Regressionstest für Bug a (lokales Array driftete nach
// Delete), (2) Feld-Parität der Insert-Row mit dem CLI-Pfad
// (scripts/optimizer/apply.mjs buildInsertRows), (3) Budget-Delta ist exakt
// budgetGate, (4) Swap-Orchestrierung: Insert-VOR-Delete, Delete-Fehler lässt
// nie zu wenige Karten zurück, Undo re-inserted die Original-Row verlustfrei.

import test from 'node:test'
import assert from 'node:assert/strict'
import {
  rowToInsert,
  applyLocalDelete,
  swapBudget,
  assembleInsertRow,
  swapCard,
  undoSwap,
} from '../src/deck-mutations.js'
import { extractCardData } from '../src/scryfall.js'
import { budgetGate } from '../scripts/optimizer/lib/budget.mjs'

const SCRYFALL_FIXTURE = {
  name: 'Arcane Signet',
  id: '11111111-2222-3333-4444-555555555555',
  type_line: 'Artifact',
  mana_cost: '{2}',
  cmc: 2,
  image_uris: { normal: 'https://img.example/normal.jpg' },
  prices: { eur: '1.20' },
  legalities: { commander: 'legal' },
}

function deckCards() {
  return [
    { id: 1, name: 'Sol Ring', price_eur: '1.50', quantity: 1, type_category: 'artifact' },
    { id: 2, name: 'Forest', price_eur: '0.10', quantity: 5, type_category: 'land' },
    { id: 3, name: 'Counterspell', price_eur: '0.80', quantity: 1, type_category: 'instant' },
  ]
}

// --- applyLocalDelete (Bug-a-Regression) ---

test('applyLocalDelete entfernt die Row aus dem Array und gibt sie zurück', () => {
  const cards = deckCards()
  const removed = applyLocalDelete(cards, 2)
  assert.equal(removed.name, 'Forest')
  assert.equal(cards.length, 2)
  // Bug a: nach Delete + Sortierwechsel darf die Karte NICHT wieder auftauchen —
  // das Array ist die Renderquelle, sie muss wirklich raus sein
  assert.ok(!cards.some(c => c.id === 2))
})

test('applyLocalDelete mit unbekannter ID lässt das Array unangetastet', () => {
  const cards = deckCards()
  assert.equal(applyLocalDelete(cards, 999), null)
  assert.equal(cards.length, 3)
})

// --- rowToInsert (Undo-Grundlage) ---

test('rowToInsert nimmt proxy_image_uri und quantity mit, aber nie die id', () => {
  const original = {
    id: 42,
    deck_id: 'old-deck',
    name: 'Lightning Bolt',
    scryfall_id: 'abc',
    type_line: 'Instant',
    type_category: 'instant',
    mana_cost: '{R}',
    cmc: 1,
    image_uri: 'https://img/x.jpg',
    price_eur: '2.00',
    price_is_foil: false,
    price_updated_at: '2026-08-01T00:00:00Z',
    commander_legality: 'legal',
    quantity: 3,
    proxy_image_uri: 'https://img/custom-art.png',
    created_at: '2026-01-01T00:00:00Z', // DB-Spalte, die kein Insert setzen darf
  }
  const row = rowToInsert('new-deck', original)
  assert.equal(row.id, undefined)
  assert.equal(row.created_at, undefined)
  assert.equal(row.deck_id, 'new-deck')
  assert.equal(row.proxy_image_uri, 'https://img/custom-art.png')
  assert.equal(row.quantity, 3)
  assert.equal(row.price_eur, '2.00')
})

// --- Feld-Parität mit apply.mjs ---

test('assembleInsertRow hat exakt die Feldmenge des CLI-Pfads (apply.mjs buildInsertRows)', () => {
  const data = extractCardData(SCRYFALL_FIXTURE)
  const websiteRow = assembleInsertRow({ deckId: 'd1', data, cheapest: { price: 0.9, isFoil: false } })

  // apply.mjs:80-88 baut: { deck_id, ...extractCardData(...), type_category,
  // quantity, price_eur, price_is_foil, price_updated_at } — price_* liegen
  // schon in extractCardData, netto also data-Keys + deck_id/type_category/quantity
  const cliKeys = new Set(['deck_id', ...Object.keys(data), 'type_category', 'quantity'])
  assert.deepEqual(new Set(Object.keys(websiteRow)), cliKeys)
})

test('assembleInsertRow: cheapest_eur-Override greift, Fallback auf Printing-Preis ohne Treffer', () => {
  const data = extractCardData(SCRYFALL_FIXTURE)

  const withCheapest = assembleInsertRow({ deckId: 'd1', data, cheapest: { price: 0.55, isFoil: true } })
  assert.equal(withCheapest.price_eur, 0.55)
  assert.equal(withCheapest.price_is_foil, true)

  const noCheapest = assembleInsertRow({ deckId: 'd1', data, cheapest: undefined })
  assert.equal(noCheapest.price_eur, 1.2)
  assert.equal(noCheapest.price_is_foil, false)

  const nullPrice = assembleInsertRow({ deckId: 'd1', data, cheapest: { price: null, isFoil: false } })
  assert.equal(nullPrice.price_eur, 1.2)

  assert.equal(withCheapest.type_category, 'artifact')
  assert.equal(withCheapest.quantity, 1)
})

// --- swapBudget ≡ budgetGate (Cut per Row-ID, nicht per Name) ---

test('swapBudget liefert exakt das budgetGate-Ergebnis (Cut-Row per ID entfernt)', () => {
  const cards = deckCards()
  const cutCard = cards[0] // Sol Ring
  const viaSwap = swapBudget({ cards, cutCard, addName: 'Mana Crypt', addPrice: 150 })
  const direct = budgetGate({
    currentCards: cards.filter(c => c.id !== cutCard.id),
    cuts: [],
    adds: [{ name: 'Mana Crypt', price: 150 }],
  })
  assert.deepEqual(viaSwap, direct)
})

test('swapBudget: bei mehreren gleichnamigen Rows fliegt NUR die Cut-Row raus (Critic-Fund)', () => {
  // Zwei "Forest"-Rows (z.B. Alt-Import mit unterschiedlichem Proxy-Artwork):
  // ein Name-basierter Cut würde beide herausrechnen und das Budget schönen.
  const cards = [
    { id: 1, name: 'Forest', price_eur: '100.00', quantity: 1 },
    { id: 2, name: 'Forest', price_eur: '100.00', quantity: 1 },
    { id: 3, name: 'Sol Ring', price_eur: '1.50', quantity: 1 },
  ]
  const gate = swapBudget({ cards, cutCard: cards[0], addName: 'Island', addPrice: 0.1 })
  // Verbleibend: Forest(100) + Sol Ring(1.50) + Island(0.10) = 101.60 — die
  // zweite Forest-Row bleibt in der Summe!
  assert.equal(gate.ok, true)
  assert.equal(gate.total, 101.6)
})

test('swapBudget blockt bei unbekanntem Preis (zählt nie als 0 €)', () => {
  const cards = deckCards()
  const gate = swapBudget({ cards, cutCard: cards[0], addName: 'Brandneue Karte', addPrice: null })
  assert.equal(gate.ok, false)
  assert.equal(gate.reason, 'unknown-price')
})

// --- swapCard-Orchestrierung (mit Fakes, keine Live-DB) ---

function fakeDeps({ failDelete = false, rowForAdd } = {}) {
  const calls = []
  return {
    calls,
    deps: {
      buildRow: async (deckId, name) => {
        calls.push(['buildRow', name])
        return rowForAdd === null ? null : { deck_id: deckId, name, quantity: 1, price_eur: '0.50', ...rowForAdd }
      },
      insert: async (rows) => {
        calls.push(['insert', rows[0].name])
        return rows.map((r, i) => ({ ...r, id: 100 + i }))
      },
      remove: async (id) => {
        calls.push(['remove', id])
        if (failDelete) throw new Error('delete kaputt')
      },
    },
  }
}

test('swapCard: Insert passiert VOR Delete, Array wird korrekt mutiert', async () => {
  const cards = deckCards()
  const cutCard = cards[2] // Counterspell
  const { calls, deps } = fakeDeps()

  const result = await swapCard({ deckId: 'd1', cards, cutCard, addName: 'Negate' }, deps)

  assert.equal(result.status, 'ok')
  assert.deepEqual(calls.map(c => c[0]), ['buildRow', 'insert', 'remove'])
  assert.ok(cards.some(c => c.name === 'Negate' && c.id === 100))
  assert.ok(!cards.some(c => c.id === cutCard.id))
  assert.equal(result.removedRow, cutCard)
})

test('swapCard: Delete-Fehler lässt beide Karten im Array (nie zu wenige)', async () => {
  const cards = deckCards()
  const cutCard = cards[0]
  const { deps } = fakeDeps({ failDelete: true })

  const result = await swapCard({ deckId: 'd1', cards, cutCard, addName: 'Negate' }, deps)

  assert.equal(result.status, 'delete-failed')
  assert.ok(cards.some(c => c.name === 'Negate'))
  assert.ok(cards.some(c => c.id === cutCard.id))
  assert.equal(cards.length, 4)
})

test('swapCard: unbekannter Kartenname bricht vor jedem Write ab', async () => {
  const cards = deckCards()
  const { calls, deps } = fakeDeps({ rowForAdd: null })

  const result = await swapCard({ deckId: 'd1', cards, cutCard: cards[0], addName: 'Gibts Nicht' }, deps)

  assert.equal(result.status, 'not-found')
  assert.deepEqual(calls.map(c => c[0]), ['buildRow'])
  assert.equal(cards.length, 3)
})

// --- undoSwap: verlustfreier Undo ---

test('undoSwap re-inserted die Original-Row inkl. proxy_image_uri, ohne id', async () => {
  const originalRow = {
    id: 7,
    name: 'Lightning Bolt',
    quantity: 2,
    price_eur: '2.00',
    proxy_image_uri: 'https://img/custom.png',
    type_category: 'instant',
  }
  const newRow = { id: 100, name: 'Shock', quantity: 1, price_eur: '0.20' }
  const cards = [newRow, ...deckCards()]

  const inserted = []
  const removed = []
  const deps = {
    insert: async (rows) => {
      inserted.push(...rows)
      return rows.map(r => ({ ...r, id: 200 }))
    },
    remove: async (id) => { removed.push(id) },
  }

  const result = await undoSwap({ deckId: 'd1', cards, originalRow, newRow }, deps)

  assert.equal(result.status, 'ok')
  assert.equal(inserted[0].id, undefined)
  assert.equal(inserted[0].proxy_image_uri, 'https://img/custom.png')
  assert.equal(inserted[0].quantity, 2)
  assert.equal(inserted[0].deck_id, 'd1')
  assert.deepEqual(removed, [100])
  assert.ok(cards.some(c => c.id === 200 && c.name === 'Lightning Bolt'))
  assert.ok(!cards.some(c => c.id === 100))
})

// applyPrintingPrices: exakte Printing-Preise als In-Memory-Override
// (Resterampe-Precons) — Fallback-Verhalten ist Teil des Vertrags.

import test from 'node:test'
import assert from 'node:assert/strict'
import { applyPrintingPrices } from '../src/utils.js'

const mk = (over = {}) => ({ name: 'X', scryfall_id: 'id-1', price_eur: 1.0, quantity: 1, ...over })

test('applyPrintingPrices: überschreibt nur Karten mit bekanntem Printing-Preis', () => {
  const cards = [
    mk({ scryfall_id: 'a', price_eur: 3.0 }),   // Printing teurer als cheapest
    mk({ scryfall_id: 'b', price_eur: 2.0 }),   // Printing unbekannt → Fallback
    mk({ scryfall_id: 'c', price_eur: 5.0 }),   // Printing ohne Preis (null) → Fallback
    mk({ scryfall_id: null, price_eur: 4.0 }),  // keine ID → Fallback
  ]
  const prices = new Map([['a', 12.5], ['c', null]])
  const applied = applyPrintingPrices(cards, prices)
  assert.equal(applied, 1)
  assert.equal(cards[0].price_eur, 12.5)
  assert.equal(cards[1].price_eur, 2.0)
  assert.equal(cards[2].price_eur, 5.0)
  assert.equal(cards[3].price_eur, 4.0)
})

test('applyPrintingPrices: 0-€-Preis ist ein echter Preis, kein Miss', () => {
  const cards = [mk({ scryfall_id: 'a', price_eur: 9.9 })]
  assert.equal(applyPrintingPrices(cards, new Map([['a', 0]])), 1)
  assert.equal(cards[0].price_eur, 0)
})

test('applyPrintingPrices: Showcase-Guard — absurde Varianten-Preise bleiben draußen', () => {
  const cards = [
    mk({ scryfall_id: 'solring', price_eur: 1.2 }),   // 602 € = Sammler-Variante → Fallback
    mk({ scryfall_id: 'birds', price_eur: 3.0 }),     // 10,44 € = plausibler Precon-Print → übernehmen
    mk({ scryfall_id: 'bulk', price_eur: 0.05 }),     // 0,60 € = 12x, aber nur +0,55 € → übernehmen
  ]
  const prices = new Map([['solring', 602.71], ['birds', 10.44], ['bulk', 0.6]])
  assert.equal(applyPrintingPrices(cards, prices), 2)
  assert.equal(cards[0].price_eur, 1.2)
  assert.equal(cards[1].price_eur, 10.44)
  assert.equal(cards[2].price_eur, 0.6)
})

test('applyPrintingPrices: ohne Vergleichsbasis gilt der 30-€-Deckel', () => {
  const cards = [
    mk({ scryfall_id: 'a', price_eur: null }),  // 602 € ohne Fallback → geblockt
    mk({ scryfall_id: 'b', price_eur: 0 }),     // 999 € bei 0-€-Fallback → geblockt
    mk({ scryfall_id: 'c', price_eur: null }),  // 12 € ohne Fallback → plausibel, übernehmen
  ]
  const prices = new Map([['a', 602.71], ['b', 999.99], ['c', 12.0]])
  assert.equal(applyPrintingPrices(cards, prices), 1)
  assert.equal(cards[0].price_eur, null)
  assert.equal(cards[1].price_eur, 0)
  assert.equal(cards[2].price_eur, 12.0)
})

test('applyPrintingPrices: robust gegen leere/fehlende Eingaben', () => {
  assert.equal(applyPrintingPrices([], new Map()), 0)
  assert.equal(applyPrintingPrices(null, new Map()), 0)
  assert.equal(applyPrintingPrices([mk()], null), 0)
})

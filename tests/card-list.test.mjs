// card-list.test.mjs — DOM-freie Kartenlisten-Logik (card-list-core.js):
// Gruppen-Summen, Section-Ordnung, sortiertes Einfügen. Regressionsschutz für
// die In-Place-Update-Pfade von Edit v2 (Critic-Fund: vorher nur
// Playwright-Stichprobe, kein Unit-Ratchet).

import test from 'node:test'
import assert from 'node:assert/strict'
import { summarizeCards, categoryOrderIndex, insertIndexFor } from '../src/components/card-list-core.js'
import { TYPE_ORDER } from '../src/utils.js'

test('summarizeCards: Anzahl gewichtet Quantity, Summe = preis × quantity', () => {
  const { count, total } = summarizeCards([
    { name: 'A', price_eur: '2.50', quantity: 2 },
    { name: 'B', price_eur: '0.10', quantity: 5 },
    { name: 'C', price_eur: null, quantity: 1 }, // fehlender Preis zählt 0 in die Summe
  ])
  assert.equal(count, 8)
  assert.equal(Math.round(total * 100) / 100, 5.5)
})

test('summarizeCards: fehlende quantity zählt als 1 (Parität zu formatTotalPrice)', () => {
  const { count, total } = summarizeCards([{ name: 'A', price_eur: '3.00' }])
  assert.equal(count, 1)
  assert.equal(total, 3)
})

test('categoryOrderIndex: TYPE_ORDER-Reihenfolge, Unbekanntes/other ans Ende', () => {
  assert.equal(categoryOrderIndex('creature'), 0)
  assert.ok(categoryOrderIndex('land') > categoryOrderIndex('artifact'))
  assert.equal(categoryOrderIndex('other'), TYPE_ORDER.length)
  assert.equal(categoryOrderIndex('gibtsnicht'), TYPE_ORDER.length)
})

const byName = (a, b) => a.name.localeCompare(b.name)

test('insertIndexFor: findet die erste Position vor einem größeren Eintrag', () => {
  const rows = [{ name: 'Anger' }, { name: 'Counterspell' }, { name: 'Opt' }]
  assert.equal(insertIndexFor(rows, { name: 'Brainstorm' }, byName), 1)
  assert.equal(insertIndexFor(rows, { name: 'Aaa' }, byName), 0)
})

test('insertIndexFor: -1 = ans Ende anhängen (auch bei leerer Liste)', () => {
  const rows = [{ name: 'Anger' }, { name: 'Opt' }]
  assert.equal(insertIndexFor(rows, { name: 'Zuran Orb' }, byName), -1)
  assert.equal(insertIndexFor([], { name: 'Opt' }, byName), -1)
})

test('insertIndexFor: Preis-Sortierung (desc) — teure Karte kommt nach vorn', () => {
  const byPriceDesc = (a, b) =>
    ((parseFloat(b.price_eur) || 0) * b.quantity) - ((parseFloat(a.price_eur) || 0) * a.quantity)
  const rows = [
    { name: 'Teuer', price_eur: '50', quantity: 1 },
    { name: 'Mittel', price_eur: '5', quantity: 1 },
    { name: 'Billig', price_eur: '0.10', quantity: 1 },
  ]
  assert.equal(insertIndexFor(rows, { name: 'Neu', price_eur: '10', quantity: 1 }, byPriceDesc), 1)
})

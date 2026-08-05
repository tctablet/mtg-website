// autocomplete.test.mjs — Race-Guard (latest-wins) und Suggestion-Mapping.
// Der Guard ist die Pflicht-Absicherung aus dem Plan-Critic: der Confirm-lose
// Sofort-Swap darf nie auf einer veralteten Vorschlagsliste basieren.

import test from 'node:test'
import assert from 'node:assert/strict'
import { createLatestGuard, mapSuggestions } from '../src/components/autocomplete.js'

test('createLatestGuard: nur der jüngste Token ist current (latest-wins)', () => {
  const guard = createLatestGuard()
  const t1 = guard.begin()
  const t2 = guard.begin()
  assert.equal(guard.isCurrent(t1), false) // alte Response darf NICHT rendern
  assert.equal(guard.isCurrent(t2), true)

  const t3 = guard.begin()
  assert.equal(guard.isCurrent(t2), false)
  assert.equal(guard.isCurrent(t3), true)
})

test('createLatestGuard: out-of-order-Abschluss — späte alte Response bleibt stale', () => {
  const guard = createLatestGuard()
  const slow = guard.begin()
  const fast = guard.begin()
  // "fast" kommt zuerst zurück und rendert
  assert.equal(guard.isCurrent(fast), true)
  // danach trudelt "slow" ein — darf nicht mehr rendern
  assert.equal(guard.isCurrent(slow), false)
})

const FOUND = [
  {
    name: 'Fire // Ice',
    image_uris: undefined,
    card_faces: [
      { image_uris: { small: 'https://img/fire-small.jpg' }, mana_cost: '{1}{R}' },
      { image_uris: { small: 'https://img/ice-small.jpg' }, mana_cost: '{1}{U}' },
    ],
  },
  {
    name: 'Counterspell',
    image_uris: { small: 'https://img/cs-small.jpg' },
    mana_cost: '{U}{U}',
  },
]

test('mapSuggestions: DFC-Front-Face-Name löst auf vollen Namen + Preis auf', () => {
  // Autocomplete liefert die Front-Face ("Fire"), DB-Preis hängt am vollen Namen
  const prices = new Map([['Fire // Ice', { price: 0.75, isFoil: false }]])
  const items = mapSuggestions(['Fire'], FOUND, prices)
  assert.equal(items.length, 1)
  assert.equal(items[0].name, 'Fire // Ice')
  assert.equal(items[0].thumb, 'https://img/fire-small.jpg')
  assert.equal(items[0].mana, '{1}{R}')
  assert.equal(items[0].price, 0.75)
})

test('mapSuggestions: normaler Treffer mit Preis + Foil-Flag', () => {
  const prices = new Map([['Counterspell', { price: 0.8, isFoil: true }]])
  const items = mapSuggestions(['Counterspell'], FOUND, prices)
  assert.equal(items[0].name, 'Counterspell')
  assert.equal(items[0].thumb, 'https://img/cs-small.jpg')
  assert.equal(items[0].price, 0.8)
  assert.equal(items[0].isFoil, true)
})

test('mapSuggestions: Name ohne Collection-Treffer und ohne Preis → price null, kein Crash', () => {
  const items = mapSuggestions(['Brandneue Karte'], FOUND, new Map())
  assert.equal(items[0].name, 'Brandneue Karte')
  assert.equal(items[0].thumb, null)
  assert.equal(items[0].price, null)
  assert.equal(items[0].isFoil, false)
})

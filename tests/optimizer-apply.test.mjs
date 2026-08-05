import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reconcileJournal } from '../scripts/optimizer/apply.mjs'

const journal = (over = {}) => ({
  version: 1, deckId: 'deck-1', deckName: 'Test',
  cuts: [{ name: 'Alt A', ids: [1, 2] }, { name: 'Alt B', ids: [3] }],
  adds: ['Neu X', 'Neu Y'],
  state: 'plan',
  ...over,
})

test('reconcileJournal: Ack-Verlust — Insert kam an, Journal blieb auf plan → kein Doppel-Insert', () => {
  // Live-DB enthält die Adds schon (Antwort ging verloren), Cuts liegen noch.
  const live = [
    { id: 1, name: 'Alt A' }, { id: 2, name: 'Alt A' }, { id: 3, name: 'Alt B' },
    { id: 10, name: 'Neu X' }, { id: 11, name: 'Neu Y' },
  ]
  const r = reconcileJournal(journal({ state: 'plan' }), live)
  assert.deepEqual(r.adds, [], 'bereits eingefügte Adds dürfen nicht erneut gesendet werden')
  assert.equal(r.state, 'inserts_done')
  assert.deepEqual(r.cuts.flatMap(c => c.ids), [1, 2, 3], 'Cuts stehen weiter aus')
})

test('reconcileJournal: Teil-Delete — schon gelöschte IDs fallen raus', () => {
  const live = [
    { id: 3, name: 'Alt B' }, // Alt A (1,2) schon weg
    { id: 10, name: 'Neu X' }, { id: 11, name: 'Neu Y' },
  ]
  const r = reconcileJournal(journal(), live)
  assert.deepEqual(r.cuts, [{ name: 'Alt B', ids: [3] }])
  assert.deepEqual(r.adds, [])
})

test('reconcileJournal: nichts passiert (Crash vor erstem Write) → alles bleibt offen', () => {
  const live = [
    { id: 1, name: 'Alt A' }, { id: 2, name: 'Alt A' }, { id: 3, name: 'Alt B' },
  ]
  const r = reconcileJournal(journal(), live)
  assert.deepEqual(r.adds, ['Neu X', 'Neu Y'])
  assert.equal(r.state, 'plan')
  assert.equal(r.cuts.length, 2)
})

test('reconcileJournal: alles durch → keine offenen Ops', () => {
  const live = [{ id: 10, name: 'Neu X' }, { id: 11, name: 'Neu Y' }]
  const r = reconcileJournal(journal(), live)
  assert.deepEqual(r.adds, [])
  assert.deepEqual(r.cuts, [])
  assert.equal(r.state, 'inserts_done')
})

test('reconcileJournal: Multiples-Karte (quantity>1 als mehrere Rows) — Cut über explizite IDs bleibt exakt', () => {
  // "Alt A" liegt 2x (ids 1,2); der Cut nennt BEIDE ids. Live ist nur id 2 weg.
  const j = journal({ cuts: [{ name: 'Alt A', ids: [1, 2] }], adds: [] })
  const live = [{ id: 1, name: 'Alt A' }, { id: 3, name: 'Alt B' }]
  const r = reconcileJournal(j, live)
  assert.deepEqual(r.cuts, [{ name: 'Alt A', ids: [1] }], 'nur die real noch existierende Row wird gelöscht')
})

test('reconcileJournal: Add heißt wie eine bestehende Karte → wird als "schon da" gewertet (Namensbasis, dokumentiert)', () => {
  // Grenzfall: Ack-Verlust-Erkennung läuft über Namen — ein Add, dessen Name
  // schon im Deck liegt, gilt als angekommen. preflight blockt diesen Fall
  // vorher (duplicate), der Test dokumentiert das Resume-Verhalten explizit.
  const j = journal({ adds: ['Alt B'], cuts: [] })
  const live = [{ id: 3, name: 'Alt B' }]
  const r = reconcileJournal(j, live)
  assert.deepEqual(r.adds, [])
})

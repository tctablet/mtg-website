// preise.test.mjs — pure Helfer der Preisdatenbank-Seite.

import test from 'node:test'
import assert from 'node:assert/strict'
import { escapeLike, parseSortValue } from '../src/utils.js'

test('escapeLike entschärft %, _ und Backslash', () => {
  assert.equal(escapeLike('100% Karte'), '100\\% Karte')
  assert.equal(escapeLike('under_score'), 'under\\_score')
  assert.equal(escapeLike('back\\slash'), 'back\\\\slash')
  assert.equal(escapeLike('Sol Ring'), 'Sol Ring')
})

test('escapeLike: kombinierter Angriffs-Input bleibt harmlos escaped', () => {
  assert.equal(escapeLike('%_\\'), '\\%\\_\\\\')
})

test('parseSortValue: gültige Werte', () => {
  assert.deepEqual(parseSortValue('name-asc'), { sort: 'name', ascending: true })
  assert.deepEqual(parseSortValue('name-desc'), { sort: 'name', ascending: false })
  assert.deepEqual(parseSortValue('price-desc'), { sort: 'price', ascending: false })
  assert.deepEqual(parseSortValue('updated-desc'), { sort: 'updated', ascending: false })
})

test('parseSortValue: Murks fällt auf name-asc zurück', () => {
  assert.deepEqual(parseSortValue('gibtsnicht-desc'), { sort: 'name', ascending: false })
  assert.deepEqual(parseSortValue(''), { sort: 'name', ascending: true })
  assert.deepEqual(parseSortValue(null), { sort: 'name', ascending: true })
  assert.deepEqual(parseSortValue('name'), { sort: 'name', ascending: true })
})

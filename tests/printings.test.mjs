import { test } from 'node:test'
import assert from 'node:assert/strict'
import { groupPrintingRows } from '../src/printings.js'

// Rows exakt so, wie PostgREST sie liefert: date-Spalten als 'YYYY-MM-DD'.
const row = (over = {}) => ({
  scryfall_id: 'aaaaaaaa-0000-0000-0000-000000000001',
  name: 'Counterspell',
  set_code: 'mh2',
  set_name: 'Modern Horizons 2',
  released_at: '2021-06-18',
  image_small: 'small-url',
  image_normal: 'normal-url',
  image_png: 'png-url',
  ...over,
})

test('mappt Rows auf das toPrinting-Format unter kleingeschriebenem Key', () => {
  const map = groupPrintingRows([row()], ['Counterspell'])
  const list = map.get('counterspell')
  assert.ok(list)
  assert.deepEqual(list[0], {
    scryfall_id: 'aaaaaaaa-0000-0000-0000-000000000001',
    set: 'Modern Horizons 2',
    set_code: 'mh2',
    released: '2021-06-18',
    image_small: 'small-url',
    image_normal: 'normal-url',
    image_png: 'png-url',
  })
})

test('sortiert neueste zuerst (Scryfall order=released)', () => {
  const map = groupPrintingRows([
    row({ scryfall_id: 'a1', released_at: '1999-01-01' }),
    row({ scryfall_id: 'a2', released_at: '2024-05-01' }),
    row({ scryfall_id: 'a3', released_at: '2010-07-15' }),
    row({ scryfall_id: 'a4', released_at: null }),
  ], ['Counterspell'])
  assert.deepEqual(map.get('counterspell').map(p => p.scryfall_id), ['a2', 'a3', 'a1', 'a4'])
})

test('Name ohne Rows fehlt in der Map — wird NIE zu []', () => {
  const map = groupPrintingRows([row()], ['Counterspell', 'Sol Ring'])
  assert.equal(map.has('sol ring'), false)
  assert.equal(map.get('sol ring'), undefined)
})

test('nicht angefragte Rows werden ignoriert, DFC-Namen matchen voll', () => {
  const map = groupPrintingRows([
    row(),
    row({ scryfall_id: 'b1', name: 'Brazen Borrower // Petty Theft' }),
  ], ['Brazen Borrower // Petty Theft'])
  assert.equal(map.has('counterspell'), false)
  assert.equal(map.get('brazen borrower // petty theft').length, 1)
})

test('URL-Fallbacks: fehlendes small/png fällt auf normal zurück', () => {
  const map = groupPrintingRows([row({ image_small: null, image_png: null })], ['Counterspell'])
  const p = map.get('counterspell')[0]
  assert.equal(p.image_small, 'normal-url')
  assert.equal(p.image_png, 'normal-url')
})

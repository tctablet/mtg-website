import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keepPrinting as keepFrontend, toPrinting } from '../src/scryfall.js'
import { keepPrinting as keepCron, toPrintingRow } from '../scripts/sync-prices.mjs'

// Die Filter-/Mapping-Logik existiert zweimal (Frontend-Live-Pfad und Cron-
// Befüllung der card_printings-Tabelle). Dieser Test erzwingt, was der
// Kommentar nur erbittet: beide Stellen bleiben synchron. Wer eine Seite
// ändert, bricht hier — und zieht die andere nach.

const img = { small: 's', normal: 'n', png: 'p' }
const FIXTURES = [
  { name: 'normal', c: { id: 'x', name: 'A', set: 's1', set_name: 'S1', set_type: 'expansion', released_at: '2020-01-01', finishes: ['nonfoil', 'foil'], image_uris: img } },
  { name: 'foil-only', c: { id: 'x', name: 'A', set_type: 'expansion', finishes: ['foil'], image_uris: img } },
  { name: 'etched-only', c: { id: 'x', name: 'A', set_type: 'expansion', finishes: ['etched'], image_uris: img } },
  { name: 'nonfoil-only', c: { id: 'x', name: 'A', set_type: 'expansion', finishes: ['nonfoil'], image_uris: img } },
  { name: 'finishes fehlt', c: { id: 'x', name: 'A', set_type: 'expansion', image_uris: img } },
  { name: 'digital', c: { id: 'x', name: 'A', set_type: 'expansion', digital: true, image_uris: img } },
  { name: 'promo', c: { id: 'x', name: 'A', set_type: 'expansion', promo: true, image_uris: img } },
  { name: 'promo-set', c: { id: 'x', name: 'A', set_type: 'promo', image_uris: img } },
  { name: 'treasure_chest', c: { id: 'x', name: 'A', set_type: 'treasure_chest', image_uris: img } },
  { name: 'token', c: { id: 'x', name: 'A', set_type: 'token', image_uris: img } },
  { name: 'memorabilia', c: { id: 'x', name: 'A', set_type: 'memorabilia', image_uris: img } },
  // Art Cards: set_type memorabilia, Name doppelt, Bild nur im card_face.
  // Genau dieser Fixture-Typ drückte Legolas's Quick Reflexes auf 0,40 €.
  { name: 'art_series', c: { id: 'x', name: 'A // A', layout: 'art_series', set_type: 'memorabilia', finishes: ['nonfoil', 'foil'], card_faces: [{ image_uris: img }] } },
  // Oversized Commander / World Championship: gleicher set_type, normales Layout
  { name: 'oversized', c: { id: 'x', name: 'A', layout: 'normal', set_type: 'memorabilia', finishes: ['nonfoil'], image_uris: img } },
  { name: 'ohne Bild', c: { id: 'x', name: 'A', set_type: 'expansion' } },
  { name: 'nur small', c: { id: 'x', name: 'A', set_type: 'expansion', image_uris: { small: 's' } } },
  { name: 'DFC', c: { id: 'x', name: 'A // B', set_type: 'expansion', card_faces: [{ image_uris: img }, { image_uris: { normal: 'back' } }] } },
  { name: 'sparse images', c: { id: 'x', name: 'A', set_type: 'expansion', image_uris: { normal: 'n-only' } } },
]

test('keepPrinting: Frontend und Cron entscheiden identisch', () => {
  for (const { name, c } of FIXTURES) {
    assert.equal(keepCron(c), keepFrontend(c), `Divergenz bei Fixture "${name}"`)
  }
})

test('Mapping: Cron-Row entspricht dem Frontend-Printing-Format', () => {
  for (const { name, c } of FIXTURES) {
    if (!keepFrontend(c)) continue
    const fe = toPrinting(c)
    const row = toPrintingRow(c, '2026-01-01T00:00:00Z')
    assert.equal(row.scryfall_id, fe.scryfall_id, `scryfall_id bei "${name}"`)
    assert.equal(row.set_name, fe.set, `set_name bei "${name}"`)
    assert.equal(row.set_code, fe.set_code, `set_code bei "${name}"`)
    assert.equal(row.released_at ?? null, fe.released ?? null, `released bei "${name}"`)
    assert.equal(row.image_small, fe.image_small, `image_small bei "${name}"`)
    assert.equal(row.image_normal, fe.image_normal, `image_normal bei "${name}"`)
    assert.equal(row.image_png, fe.image_png, `image_png bei "${name}"`)
  }
})

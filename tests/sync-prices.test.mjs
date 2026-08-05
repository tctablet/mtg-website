import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keepPrinting, toPrintingRow, canonicalPriceName, staleCapFor, stalePriceCapFor } from '../scripts/sync-prices.mjs'

// Die Filter-Logik MUSS mit keepPrinting in src/scryfall.js übereinstimmen —
// die Tabelle darf nur enthalten, was der Picker auch live zeigen würde.

const base = {
  id: '11111111-2222-3333-4444-555555555555',
  name: 'Counterspell',
  set: 'mh2',
  set_name: 'Modern Horizons 2',
  set_type: 'expansion',
  released_at: '2021-06-18',
  digital: false,
  promo: false,
  finishes: ['nonfoil', 'foil'],
  image_uris: {
    small: 'https://cards.scryfall.io/small/x.jpg',
    normal: 'https://cards.scryfall.io/normal/x.jpg',
    png: 'https://cards.scryfall.io/png/x.png',
  },
}

test('normales Paper-Printing wird behalten', () => {
  assert.equal(keepPrinting(base), true)
})

test('foil-only und etched-only fliegen raus, nonfoil-only bleibt', () => {
  assert.equal(keepPrinting({ ...base, finishes: ['foil'] }), false)
  assert.equal(keepPrinting({ ...base, finishes: ['etched'] }), false)
  assert.equal(keepPrinting({ ...base, finishes: ['nonfoil'] }), true)
  // fehlendes finishes-Feld darf nicht crashen (alte Bulk-Objekte)
  assert.equal(keepPrinting({ ...base, finishes: undefined }), true)
})

test('digital, promo und ausgeschlossene set_types fliegen raus', () => {
  assert.equal(keepPrinting({ ...base, digital: true }), false)
  assert.equal(keepPrinting({ ...base, promo: true }), false)
  for (const t of ['promo', 'treasure_chest', 'token']) {
    assert.equal(keepPrinting({ ...base, set_type: t }), false)
  }
})

test('Printing ohne normal-Bild fliegt raus', () => {
  assert.equal(keepPrinting({ ...base, image_uris: undefined }), false)
  assert.equal(keepPrinting({ ...base, image_uris: { small: 'x' } }), false)
})

test('DFC nutzt die Bilder der Vorderseite', () => {
  const dfc = {
    ...base,
    name: 'Brazen Borrower // Petty Theft',
    image_uris: undefined,
    card_faces: [
      { image_uris: { small: 's-front', normal: 'n-front', png: 'p-front' } },
      { image_uris: { small: 's-back', normal: 'n-back', png: 'p-back' } },
    ],
  }
  assert.equal(keepPrinting(dfc), true)
  const row = toPrintingRow(dfc, '2026-08-03T00:00:00Z')
  assert.equal(row.image_normal, 'n-front')
  assert.equal(row.image_small, 's-front')
  assert.equal(row.image_png, 'p-front')
})

test('toPrintingRow: Shape, URL-Fallbacks und Zeitstempel', () => {
  const stamp = '2026-08-03T12:00:00.000Z'
  const row = toPrintingRow(base, stamp)
  assert.deepEqual(row, {
    scryfall_id: base.id,
    name: 'Counterspell',
    set_code: 'mh2',
    set_name: 'Modern Horizons 2',
    released_at: '2021-06-18',
    image_small: base.image_uris.small,
    image_normal: base.image_uris.normal,
    image_png: base.image_uris.png,
    updated_at: stamp,
  })
  // small/png fehlen → normal einspringen lassen (wie toPrinting im Frontend)
  const sparse = toPrintingRow({ ...base, image_uris: { normal: 'only-normal' } }, stamp)
  assert.equal(sparse.image_small, 'only-normal')
  assert.equal(sparse.image_png, 'only-normal')
  // released_at fehlt → null, nicht undefined (PostgREST-Kompatibilität)
  assert.equal(toPrintingRow({ ...base, released_at: undefined }, stamp).released_at, null)
})

// --- canonicalPriceName: Reversible-Normalisierung (User-Report
// „Doppelseiten ohne Bilder" — 397 "A // A"-Geister-Rows in scryfall_prices) ---

test('canonicalPriceName: reversible_card nutzt den Front-Face-Namen', () => {
  const rev = {
    name: 'Ludevic, Necrogenius // Ludevic, Necrogenius',
    layout: 'reversible_card',
    card_faces: [{ name: 'Ludevic, Necrogenius' }, { name: 'Ludevic, Necrogenius' }],
  }
  assert.equal(canonicalPriceName(rev), 'Ludevic, Necrogenius')
})

test('canonicalPriceName: identische //-Hälften kollabieren auch ohne Layout-Flag', () => {
  assert.equal(
    canonicalPriceName({ name: "Bonders' Enclave // Bonders' Enclave" }),
    "Bonders' Enclave"
  )
})

test('canonicalPriceName: echte Transform-DFCs bleiben unberührt', () => {
  assert.equal(
    canonicalPriceName({ name: 'Brazen Borrower // Petty Theft', layout: 'adventure' }),
    'Brazen Borrower // Petty Theft'
  )
  assert.equal(canonicalPriceName({ name: 'Counterspell' }), 'Counterspell')
  // reversible ohne card_faces darf nicht crashen → Fallback voller Name
  assert.equal(
    canonicalPriceName({ name: 'X // X', layout: 'reversible_card' }),
    'X // X'
  )
  // Defensiv: kaputte Objekte
  assert.equal(canonicalPriceName({}), '')
  assert.equal(canonicalPriceName(null), '')
})

test('toPrintingRow keyt Reversible-Printings unter dem kanonischen Namen', () => {
  const rev = {
    ...base,
    name: 'Abhorrent Oculus // Abhorrent Oculus',
    layout: 'reversible_card',
    card_faces: [{ name: 'Abhorrent Oculus' }, { name: 'Abhorrent Oculus' }],
  }
  assert.equal(toPrintingRow(rev, 'x').name, 'Abhorrent Oculus')
})

test('staleCapFor: 20%-Cap mit 500er-Boden (fail-closed-Sicherheitsnetz)', () => {
  assert.equal(staleCapFor(38000), 7600)
  assert.equal(staleCapFor(1000), 500) // Boden greift
  assert.equal(staleCapFor(0), 500)
})

test('stalePriceCapFor: strenges 2%-Cap — 397 Geister passen, ein 1000er-Loch nicht', () => {
  assert.equal(stalePriceCapFor(38000), 760)
  assert.ok(397 <= stalePriceCapFor(38000))
  assert.ok(1000 > stalePriceCapFor(38000)) // Teilausfall → fail-closed
  assert.equal(stalePriceCapFor(0), 500) // Boden
})

test('toPrintingRow: nameOverride trägt die Deck-Namens-Variante (roher "X // X"-Bestand)', () => {
  const rev = {
    ...base,
    name: 'Abhorrent Oculus // Abhorrent Oculus',
    layout: 'reversible_card',
    card_faces: [{ name: 'Abhorrent Oculus' }, { name: 'Abhorrent Oculus' }],
  }
  assert.equal(toPrintingRow(rev, 'x', 'Abhorrent Oculus // Abhorrent Oculus').name, 'Abhorrent Oculus // Abhorrent Oculus')
  assert.equal(toPrintingRow(rev, 'x').name, 'Abhorrent Oculus')
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  keepPrinting, toPrintingRow, canonicalPriceName, staleCapFor, stalePriceCapFor,
  isPriceEligible, priceOf, processBulkCard, newBulkContext,
} from '../scripts/sync-prices.mjs'

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
  for (const t of ['promo', 'treasure_chest', 'token', 'memorabilia']) {
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

// ---- Preis-Pfad ----
// Der Preis-Filter ist BEWUSST nicht deckungsgleich mit keepPrinting: Promos
// sind echte, kaufbare Karten und oft der günstigste Weg an eine Karte zu
// kommen (gemessen: Promos ausschließen macht 163 Deck-Karten um 138 € teurer).
// Dieser Test friert genau diese Entscheidung ein.
test('isPriceEligible: memorabilia/token/treasure_chest raus, Promos bleiben drin', () => {
  assert.equal(isPriceEligible(base), true)
  assert.equal(isPriceEligible({ ...base, digital: true }), false)
  for (const t of ['memorabilia', 'token', 'treasure_chest']) {
    assert.equal(isPriceEligible({ ...base, set_type: t }), false)
  }
  // Promo als Flag UND als set_type zählen weiter für den Preis
  assert.equal(isPriceEligible({ ...base, promo: true }), true)
  assert.equal(isPriceEligible({ ...base, set_type: 'promo' }), true)
})

test('priceOf: Kaskade non-foil EUR → USD×0,92 → EUR-Foil → USD-Foil', () => {
  assert.deepEqual(priceOf({ prices: { eur: '1.50', usd: '9.99' } }), { eur: 1.5, isFoil: false })
  assert.deepEqual(priceOf({ prices: { usd: '0.43' } }), { eur: 0.43 * 0.92, isFoil: false })
  assert.deepEqual(priceOf({ prices: { eur_foil: '3.25' } }), { eur: 3.25, isFoil: true })
  assert.deepEqual(priceOf({ prices: { usd_foil: '2.00' } }), { eur: 2 * 0.92, isFoil: true })
  assert.equal(priceOf({ prices: {} }), null)
  assert.equal(priceOf({}), null)
})

// Regressionstest für den Befund vom 01.09.2026: die Art Card ALTC #3 heißt
// "A // A", wurde von canonicalPriceName auf den Namen der echten Karte
// gefaltet und gewann mit 0,43 USD × 0,92 = 0,40 € den Min-Merge gegen den
// echten Print zu 31,81 €. Vor dem Fix lief dieser Test rot.
const LEGOLAS = "Legolas's Quick Reflexes"
const legolasPrints = [
  { // die Art Card — set_type memorabilia, Name doppelt
    id: 'a78e4154-0092-4b1a-b7f9-1e999e0a56cd',
    name: `${LEGOLAS} // ${LEGOLAS}`,
    layout: 'art_series',
    set: 'altc',
    set_name: 'Tales of Middle-earth Scene Box',
    set_type: 'memorabilia',
    released_at: '2023-11-04',
    digital: false,
    promo: false,
    finishes: ['nonfoil', 'foil'],
    card_faces: [{ image_uris: { small: 'as', normal: 'an', png: 'ap' } }],
    prices: { usd: '0.43', eur: null, eur_foil: null, usd_foil: null },
  },
  { // der echte, spielbare Print
    id: '851c0167-04ba-4d15-b0fa-c211bd8826f1',
    name: LEGOLAS,
    set: 'ltc',
    set_name: 'Tales of Middle-earth Commander',
    set_type: 'commander',
    released_at: '2023-11-03',
    digital: false,
    promo: false,
    finishes: ['nonfoil', 'foil'],
    image_uris: { small: 'ls', normal: 'ln', png: 'lp' },
    prices: { eur: '31.81', usd: '47.89', eur_foil: '35.57' },
  },
  { // foil-only Variante — schon vorher via keepPrinting draußen
    id: '00000000-0000-0000-0000-000000000537',
    name: LEGOLAS,
    set: 'ltc',
    set_name: 'Tales of Middle-earth Commander',
    set_type: 'commander',
    digital: false,
    promo: false,
    finishes: ['foil'],
    image_uris: { small: 'fs', normal: 'fn', png: 'fp' },
    prices: { eur: null, eur_foil: '54.74' },
  },
]

test('processBulkCard: Art Card gewinnt den Min-Merge NICHT (Legolas-Regression)', () => {
  // deckNames MUSS den Namen enthalten, sonst läuft der Printing-Zweig gar
  // nicht und die "keine ALTC-Zeile"-Assertion wäre vakuum-grün.
  const ctx = newBulkContext({ deckNames: new Set([LEGOLAS]), runStamp: '2026-09-01T00:00:00Z' })
  for (const c of legolasPrints) processBulkCard(c, ctx)

  assert.equal(ctx.stats.cards, 3)
  assert.deepEqual(ctx.priceMap.get(LEGOLAS), { eur: 31.81, is_foil: false })

  // Anti-Vakuum: es MUSS eine Printing-Zeile geben, und zwar genau den echten
  // Print — nicht die Art Card, nicht den foil-only Print.
  assert.equal(ctx.printingRows.length, 1)
  assert.equal(ctx.printingRows[0].set_code, 'ltc')
  assert.equal(ctx.printingRows[0].name, LEGOLAS)
  assert.equal(ctx.printingRows.some(r => r.set_code === 'altc'), false)

  assert.equal(ctx.stats.skippedSetType, 1) // die Art Card
})

test('processBulkCard: NUR der set_type-Filter verhindert die 0,40 € (Mutationsprobe)', () => {
  // Mutation an der EINEN Eigenschaft, an der der Filter haengt: derselbe
  // Art-Card-Print mit einem nicht ausgeschlossenen set_type laeuft durch
  // dieselbe processBulkCard-Schleife und gewinnt den Min-Merge mit 0,40 €.
  // Das beweist, dass die Assertion im Test darueber an isPriceEligible haengt
  // und nicht zufaellig gruen ist — ohne den Filter nachzubauen.
  const [artCard, ...rest] = legolasPrints
  const ctx = newBulkContext({ deckNames: new Set([LEGOLAS]), runStamp: 'x' })
  for (const c of [{ ...artCard, set_type: 'commander' }, ...rest]) processBulkCard(c, ctx)

  assert.deepEqual(ctx.priceMap.get(LEGOLAS), { eur: 0.4, is_foil: false })
  assert.equal(ctx.stats.skippedSetType, 0)
})

test('processBulkCard: Preis ohne deckNames läuft weiter, Printings bleiben leer', () => {
  const ctx = newBulkContext({ deckNames: null, runStamp: 'x' })
  for (const c of legolasPrints) processBulkCard(c, ctx)
  assert.deepEqual(ctx.priceMap.get(LEGOLAS), { eur: 31.81, is_foil: false })
  assert.equal(ctx.printingRows.length, 0)
})

test('processBulkCard: reversible_card wird weiterhin auf den Front-Face-Namen gefaltet', () => {
  const ctx = newBulkContext({ deckNames: new Set(['Abhorrent Oculus']), runStamp: 'x' })
  processBulkCard({
    ...base,
    name: 'Abhorrent Oculus // Abhorrent Oculus',
    layout: 'reversible_card',
    card_faces: [{ name: 'Abhorrent Oculus' }, { name: 'Abhorrent Oculus' }],
    prices: { eur: '12.00' },
  }, ctx)
  assert.deepEqual(ctx.priceMap.get('Abhorrent Oculus'), { eur: 12, is_foil: false })
  assert.equal(ctx.stats.reversible, 1)
  assert.equal(ctx.printingRows.length, 1)
})

// main() reicht sein lokales printingRows-Array in den Context und liest die
// Ergebnisse danach über die ÄUSSERE Referenz weiter. Das funktioniert nur,
// solange newBulkContext das Array durchreicht statt zu kopieren. Würde ein
// späterer "defensiver" Refactor hier `[...printingRows]` einbauen, bliebe
// main()s Array leer, syncPrintings sähe 0 Namen und das 80-%-Gate würfe —
// ohne dass ein Test es merkt. Dieser Test friert die Aliasing-Semantik ein.
test('newBulkContext: übergebenes printingRows-Array wird per Referenz befüllt', () => {
  const outer = []
  const ctx = newBulkContext({
    deckNames: new Set([LEGOLAS]),
    runStamp: 'x',
    printingRows: outer,
  })
  assert.equal(ctx.printingRows, outer) // dieselbe Referenz, keine Kopie
  for (const c of legolasPrints) processBulkCard(c, ctx)
  assert.equal(outer.length, 1)
  assert.equal(outer[0].set_code, 'ltc')
})

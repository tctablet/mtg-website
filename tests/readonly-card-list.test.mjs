// readonly-card-list.test.mjs — pure Merge-Logik der Scan-Kartenlisten
// (buildScryfallIndex/enrichCards; das DOM-Rendering testet der
// Playwright-Durchlauf).

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildScryfallIndex, enrichCards } from '../src/components/readonly-card-list.js'

const sol = {
  name: 'Sol Ring', type_line: 'Artifact', mana_cost: '{1}',
  id: 'aaaaaaaa-0000-0000-0000-000000000001',
  image_uris: { normal: 'https://img/sol.jpg' },
}
const dfc = {
  name: 'Esika, God of the Tree // The Prismatic Bridge',
  type_line: 'Legendary Creature — God // Legendary Enchantment',
  id: 'bbbbbbbb-0000-0000-0000-000000000002',
  card_faces: [
    { name: 'Esika, God of the Tree', mana_cost: '{1}{G}{G}', image_uris: { normal: 'https://img/esika-front.jpg' } },
    { name: 'The Prismatic Bridge', mana_cost: '', image_uris: { normal: 'https://img/esika-back.jpg' } },
  ],
}

test('buildScryfallIndex: indexiert Voll-Namen UND DFC-Front-Face', () => {
  const idx = buildScryfallIndex([sol, dfc])
  assert.equal(idx.get('sol ring'), sol)
  assert.equal(idx.get('esika, god of the tree // the prismatic bridge'), dfc)
  // EDHREC nennt DFCs beim Front-Face
  assert.equal(idx.get('esika, god of the tree'), dfc)
  // kaputte Einträge crashen nicht
  assert.equal(buildScryfallIndex([null, {}]).size, 0)
})

test('enrichCards: Typ, Mana, Bild aus Scryfall; Preis aus unserer Liste', () => {
  const idx = buildScryfallIndex([sol, dfc])
  const priced = [
    { name: 'Sol Ring', price: 1.5, isFoil: false },
    { name: 'Esika, God of the Tree', price: 9.99, isFoil: true },
  ]
  const cards = enrichCards(
    [{ name: 'Sol Ring', quantity: 1 }, { name: 'Esika, God of the Tree', quantity: 1 }],
    idx, priced
  )
  assert.equal(cards[0].type_category, 'artifact')
  assert.equal(cards[0].mana_cost, '{1}')
  assert.equal(cards[0].image_uri, 'https://img/sol.jpg')
  assert.equal(cards[0].price_eur, 1.5)
  // DFC: Front-Face-Mana + Front-Face-Bild, Typ-Kategorie creature
  assert.equal(cards[1].type_category, 'creature')
  assert.equal(cards[1].mana_cost, '{1}{G}{G}')
  assert.equal(cards[1].image_uri, 'https://img/esika-front.jpg')
  assert.equal(cards[1].price_is_foil, true)
})

test('enrichCards: ohne Scryfall-Treffer ehrlich "other"/leer statt Crash', () => {
  const [c] = enrichCards([{ name: 'Unbekannt', quantity: 2 }], new Map(), [])
  assert.equal(c.type_category, 'other')
  assert.equal(c.image_uri, null)
  assert.equal(c.price_eur, null)
  assert.equal(c.quantity, 2)
})

test('slimCollectionCard: enrichCards funktioniert auf der geslimmten Form (Cache-Roundtrip)', async () => {
  const { slimCollectionCard } = await import('../src/components/readonly-card-list.js')
  const slimmed = [sol, dfc].map(slimCollectionCard)
  const roundtrip = JSON.parse(JSON.stringify(slimmed)) // sessionStorage-Simulation
  const idx = buildScryfallIndex(roundtrip)
  const [a, b] = enrichCards(
    [{ name: 'Sol Ring', quantity: 1 }, { name: 'Esika, God of the Tree', quantity: 1 }],
    idx, []
  )
  assert.equal(a.type_category, 'artifact')
  assert.equal(a.image_uri, 'https://img/sol.jpg')
  assert.equal(b.type_category, 'creature')
  assert.equal(b.image_uri, 'https://img/esika-front.jpg')
  assert.equal(b.mana_cost, '{1}{G}{G}')
  // slim ist wirklich klein: kein oracle_text/prices/legalities-Ballast
  assert.ok(!('oracle_text' in slimmed[0]))
})

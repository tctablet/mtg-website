// report-contract.test.mjs — der buildAnalysis-Contract (M5).
// (1) Shape-Snapshot: die Top-Level-Keys von `analyze --json` sind festgenagelt
//     — CLI und Browser-Wizard konsumieren denselben Shape.
// (2) Index-Äquivalenz: voller Pool-Index vs. Deck-only-Index (so baut ihn der
//     Browser aus der Scryfall-Collection) liefern ein identisches Ergebnis.

import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAnalysis } from '../scripts/optimizer/lib/report.mjs'
import { buildIndex, toPoolRecord } from '../scripts/optimizer/lib/pool-core.mjs'

const SCRYFALL = [
  {
    name: 'Saruman of Many Colors',
    cmc: 6,
    type_line: 'Legendary Creature — Avatar Wizard',
    oracle_text: 'Menace, ward {2}',
    color_identity: ['W', 'U', 'B'],
    legalities: { commander: 'legal' },
    games: ['paper'],
    edhrec_rank: 5000,
  },
  {
    name: 'Counterspell',
    cmc: 2,
    type_line: 'Instant',
    oracle_text: 'Counter target spell.',
    color_identity: ['U'],
    legalities: { commander: 'legal' },
    games: ['paper'],
    edhrec_rank: 50,
  },
  {
    name: 'Island',
    cmc: 0,
    type_line: 'Basic Land — Island',
    oracle_text: '({T}: Add {U}.)',
    color_identity: ['U'],
    legalities: { commander: 'legal' },
    games: ['paper'],
    produced_mana: ['U'],
  },
]

// Irrelevante Zusatz-Records im "vollen Pool" — dürfen das Ergebnis nie ändern
const EXTRA = [
  {
    name: 'Lightning Bolt',
    cmc: 1,
    type_line: 'Instant',
    oracle_text: 'Lightning Bolt deals 3 damage to any target.',
    color_identity: ['R'],
    legalities: { commander: 'legal' },
    games: ['paper'],
    edhrec_rank: 30,
  },
]

const DECK = { id: 'test-deck', name: 'Testdeck', commander: 'Saruman of Many Colors', commander2: null }
const CARDS = [
  { name: 'Saruman of Many Colors', quantity: 1, price_eur: '4.00' },
  { name: 'Counterspell', quantity: 1, price_eur: '0.80' },
  { name: 'Island', quantity: 30, price_eur: '0.05' },
]

test('buildAnalysis: Top-Level-Shape ist der dokumentierte --json-Contract', () => {
  const index = buildIndex(SCRYFALL.map(toPoolRecord))
  const result = buildAnalysis({ deck: DECK, cards: CARDS, index })
  assert.deepEqual(Object.keys(result), [
    'deck', 'audit', 'quotas', 'hypergeo', 'manabase', 'budget',
    'bracket', 'interaction', 'unclassified', 'roles',
  ])
  assert.deepEqual(result.deck, { id: 'test-deck', name: 'Testdeck', commanders: ['Saruman of Many Colors'] })
  assert.equal(result.budget.limit, 500)
  assert.equal(typeof result.interaction.density, 'number')
})

test('buildAnalysis: Deck-only-Index (Browser-Pfad) ≡ voller Pool-Index (CLI-Pfad)', () => {
  const fullIndex = buildIndex([...SCRYFALL, ...EXTRA].map(toPoolRecord))
  const deckIndex = buildIndex(SCRYFALL.map(toPoolRecord))
  const a = buildAnalysis({ deck: DECK, cards: CARDS, index: fullIndex })
  const b = buildAnalysis({ deck: DECK, cards: CARDS, index: deckIndex })
  assert.deepEqual(a, b)
})

test('buildAnalysis: Karte ohne Index-Treffer läuft als Fallback weiter (flaggen, nie crashen)', () => {
  const index = buildIndex(SCRYFALL.map(toPoolRecord))
  const cards = [...CARDS, { name: 'Brandneue Unbekannte Karte', quantity: 1, price_eur: null }]
  const result = buildAnalysis({ deck: DECK, cards, index })
  assert.ok(result.budget.missing.includes('Brandneue Unbekannte Karte'))
  assert.deepEqual(result.roles['Brandneue Unbekannte Karte'], [])
})

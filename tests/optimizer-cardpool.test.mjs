import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  toPoolRecord,
  buildIndex,
  lookupCard,
  isCandidate,
  ciSubset,
  searchCandidates,
  poolAgeHours,
  formatDatenstand,
} from '../scripts/optimizer/lib/cardpool.mjs'

// Fixtures im Format des Scryfall-Oracle-Bulks (nur die genutzten Felder).
const scryfallCard = (over = {}) => ({
  name: 'Counterspell',
  mana_cost: '{U}{U}',
  cmc: 2,
  type_line: 'Instant',
  oracle_text: 'Counter target spell.',
  colors: ['U'],
  color_identity: ['U'],
  keywords: [],
  layout: 'normal',
  legalities: { commander: 'legal' },
  games: ['paper', 'mtgo'],
  game_changer: false,
  edhrec_rank: 50,
  ...over,
})

const dfcCard = (over = {}) => ({
  name: 'Malakir Rebirth // Malakir Mire',
  cmc: 1,
  color_identity: ['B'],
  layout: 'modal_dfc',
  legalities: { commander: 'legal' },
  games: ['paper'],
  card_faces: [
    {
      name: 'Malakir Rebirth',
      mana_cost: '{B}',
      type_line: 'Instant',
      oracle_text: 'Choose target creature...',
      colors: ['B'],
    },
    {
      name: 'Malakir Mire',
      mana_cost: '',
      type_line: 'Land',
      oracle_text: 'Malakir Mire enters the battlefield tapped.',
      colors: [],
    },
  ],
  ...over,
})

test('toPoolRecord: normale Karte übernimmt Kernfelder kompakt', () => {
  const r = toPoolRecord(scryfallCard())
  assert.equal(r.name, 'Counterspell')
  assert.equal(r.mana_cost, '{U}{U}')
  assert.equal(r.legal, 'legal')
  assert.equal(r.game_changer, false)
  assert.equal(r.faces, null)
})

test('toPoolRecord: DFC zieht mana_cost/type_line/oracle_text aus den Faces', () => {
  const r = toPoolRecord(dfcCard())
  assert.equal(r.mana_cost, '{B}')
  assert.equal(r.type_line, 'Instant')
  assert.match(r.oracle_text, /Choose target creature/)
  assert.match(r.oracle_text, /enters the battlefield tapped/)
  assert.equal(r.faces.length, 2)
})

test('buildIndex + lookupCard: voller Name und Front-Face-Alias treffen', () => {
  const idx = buildIndex([toPoolRecord(scryfallCard()), toPoolRecord(dfcCard())])
  assert.equal(lookupCard(idx, 'Counterspell').name, 'Counterspell')
  assert.equal(lookupCard(idx, 'Malakir Rebirth // Malakir Mire').name, 'Malakir Rebirth // Malakir Mire')
  assert.equal(lookupCard(idx, 'malakir rebirth').name, 'Malakir Rebirth // Malakir Mire')
  assert.equal(lookupCard(idx, 'Gibt Es Nicht'), null)
})

test('buildIndex: exakter voller Name gewinnt vor Front-Face-Alias', () => {
  // Konstruierter Konflikt: eine eigenständige Karte heißt wie das Front-Face.
  const standalone = toPoolRecord(scryfallCard({ name: 'Malakir Rebirth', edhrec_rank: 1 }))
  const idx = buildIndex([standalone, toPoolRecord(dfcCard())])
  assert.equal(lookupCard(idx, 'Malakir Rebirth').name, 'Malakir Rebirth')
  // Der volle DFC-Name bleibt weiterhin auflösbar.
  assert.equal(lookupCard(idx, 'Malakir Rebirth // Malakir Mire').faces.length, 2)
})

test('isCandidate: not_legal und digital-only fliegen raus, Audit-Lookup bleibt möglich', () => {
  const banned = toPoolRecord(scryfallCard({ name: 'Black Lotus', legalities: { commander: 'banned' } }))
  const alchemy = toPoolRecord(scryfallCard({ name: 'A-Digital Only', games: ['arena'] }))
  const ok = toPoolRecord(scryfallCard())
  assert.equal(isCandidate(banned), false)
  assert.equal(isCandidate(alchemy), false)
  assert.equal(isCandidate(ok), true)
  // Voll-Index: auch die gebannte Karte ist auflösbar (Report-Flag statt Crash).
  const idx = buildIndex([banned])
  assert.equal(lookupCard(idx, 'Black Lotus').legal, 'banned')
})

test('ciSubset: Karten-CI muss Teilmenge der Deck-CI sein', () => {
  assert.equal(ciSubset(['U'], ['W', 'U', 'B']), true)
  assert.equal(ciSubset(['R'], ['W', 'U', 'B']), false)
  assert.equal(ciSubset([], ['B']), true) // farblos passt überall
})

test('searchCandidates: filtert CI + Typ und sortiert nach edhrec_rank', () => {
  const idx = buildIndex([
    toPoolRecord(scryfallCard({ name: 'Teuer Populär', edhrec_rank: 10, type_line: 'Instant' })),
    toPoolRecord(scryfallCard({ name: 'Unbekannt', edhrec_rank: null, type_line: 'Instant' })),
    toPoolRecord(scryfallCard({ name: 'Roter Ausreißer', color_identity: ['R'], type_line: 'Instant' })),
    toPoolRecord(scryfallCard({ name: 'Kreatur', type_line: 'Creature — Wizard', edhrec_rank: 5 })),
  ])
  const hits = searchCandidates(idx, { colorIdentity: ['U'], typeRegex: /Instant/ })
  assert.deepEqual(hits.map(h => h.name), ['Teuer Populär', 'Unbekannt'])
})

test('poolAgeHours/formatDatenstand: Alter + Warnschwelle 24 h', () => {
  const now = Date.parse('2026-08-04T12:00:00Z')
  const fresh = { fetchedAt: '2026-08-04T10:00:00Z', cardCount: 35000, bulkUpdatedAt: '2026-08-04T05:00:00Z' }
  const stale = { fetchedAt: '2026-07-30T10:00:00Z', cardCount: 35000, bulkUpdatedAt: '2026-07-30T05:00:00Z' }
  assert.equal(Math.round(poolAgeHours(fresh, now)), 2)
  assert.ok(!formatDatenstand(fresh, now).includes('⚠'))
  assert.ok(formatDatenstand(stale, now).includes('⚠'))
  assert.equal(poolAgeHours(null, now), Infinity)
})

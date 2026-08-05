// pool-asset.test.mjs — Slim-Mapping des Wizard-Pool-Assets.
// Kerngarantie: die zur BUILD-Zeit eingebackenen Rollen sind exakt das, was
// classifyCard live liefern würde (Drift-Test) — und rolesVersion im Meta
// entspricht der Code-Konstante (der Client vergleicht dagegen).

import test from 'node:test'
import assert from 'node:assert/strict'
import { toSlimRecord, buildAsset } from '../scripts/build-pool-asset.mjs'
import { toPoolRecord } from '../scripts/optimizer/lib/pool-core.mjs'
import { classifyCard, ROLES_VERSION } from '../scripts/optimizer/lib/roles.mjs'

const SCRYFALL_FIXTURES = [
  {
    name: 'Rampant Growth',
    cmc: 2,
    type_line: 'Sorcery',
    oracle_text: 'Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.',
    color_identity: ['G'],
    legalities: { commander: 'legal' },
    games: ['paper', 'mtgo'],
    edhrec_rank: 100,
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
    game_changer: false,
  },
  {
    name: 'Digital Only Card',
    cmc: 1,
    type_line: 'Instant',
    oracle_text: 'Counter target spell.',
    color_identity: ['U'],
    legalities: { commander: 'legal' },
    games: ['arena'], // kein Papier → fliegt raus
    edhrec_rank: 10,
  },
  {
    name: 'Banned Card',
    cmc: 0,
    type_line: 'Artifact',
    oracle_text: '{T}: Add {C}{C}{C}.',
    color_identity: [],
    legalities: { commander: 'banned' }, // illegal → fliegt raus
    games: ['paper'],
    edhrec_rank: 1,
  },
]

test('toSlimRecord: Felder gemappt, Rollen eingebacken ≡ classifyCard live', () => {
  const record = toPoolRecord(SCRYFALL_FIXTURES[0])
  const slim = toSlimRecord(record)
  assert.equal(slim.n, 'Rampant Growth')
  assert.deepEqual(slim.r, classifyCard(record)) // Drift-Garantie
  assert.ok(slim.r.includes('ramp'))
  assert.equal(slim.ci, 'G')
  assert.equal(slim.c, 2)
  assert.equal(slim.t, 'sorcery')
  assert.equal(slim.e, 100)
  assert.equal(slim.gc, false)
})

test('toSlimRecord: instant-speed Interaktion wird als i=true markiert', () => {
  const slim = toSlimRecord(toPoolRecord(SCRYFALL_FIXTURES[1]))
  assert.ok(slim.r.includes('counter'))
  assert.equal(slim.i, true)
})

test('buildAsset: isCandidate-Vorfilter (kein Papier / banned fliegen raus), Sortierung nach Rank', () => {
  const records = SCRYFALL_FIXTURES.map(toPoolRecord)
  const asset = buildAsset(records, { now: new Date('2026-08-05T12:00:00Z'), bulkUpdatedAt: '2026-08-05' })
  const names = asset.cards.map(c => c.n)
  assert.deepEqual(names, ['Counterspell', 'Rampant Growth']) // rank 50 vor 100
  assert.ok(!names.includes('Digital Only Card'))
  assert.ok(!names.includes('Banned Card'))
})

test('buildAsset: Meta trägt rolesVersion (Client-Drift-Vertrag) + Zählung + Zeitstempel', () => {
  const asset = buildAsset(SCRYFALL_FIXTURES.map(toPoolRecord), { now: new Date('2026-08-05T12:00:00Z') })
  assert.equal(asset.meta.rolesVersion, ROLES_VERSION)
  assert.equal(asset.meta.cardCount, 2)
  assert.equal(asset.meta.builtAt, '2026-08-05T12:00:00.000Z')
})

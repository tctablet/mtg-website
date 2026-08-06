// wizard-recommend.test.mjs — die puren Wizard-Bausteine (M6):
// geteilte Preflight-Regeln (== apply.mjs), Kandidaten-Suche im Slim-Pool,
// Empfehlungs-Merge mit ehrlichen Labels, Cut-Heuristiken.

import test from 'node:test'
import assert from 'node:assert/strict'
import { preflightSwapRules } from '../scripts/optimizer/lib/preflight.mjs'
import { searchByRole } from '../src/wizard/pool.js'
import { buildGapRecommendations, unionCandidates } from '../src/wizard/recommend.js'
import { buildCutCandidates } from '../src/wizard/cuts.js'

// --- preflightSwapRules (eine Wahrheit mit apply.mjs) ---

const CARDS = [
  { id: 1, name: 'Sol Ring' },
  { id: 2, name: 'Counterspell' },
  { id: 3, name: 'Saruman of Many Colors' },
]
const COMMANDERS = ['Saruman of Many Colors']

test('preflight: Commander ist nie Cut', () => {
  const errors = preflightSwapRules({ cards: CARDS, commanders: COMMANDERS, cuts: ['Saruman of Many Colors'], adds: ['Opt'] })
  assert.ok(errors.some(e => /Commander/.test(e)))
})

test('preflight: Cut muss im Deck liegen', () => {
  const errors = preflightSwapRules({ cards: CARDS, commanders: COMMANDERS, cuts: ['Nicht Da'], adds: ['Opt'] })
  assert.ok(errors.some(e => /nicht im Deck/.test(e)))
})

test('preflight: doppelte Adds und adds∩cuts blocken', () => {
  const errors = preflightSwapRules({
    cards: CARDS, commanders: COMMANDERS,
    cuts: ['Sol Ring'], adds: ['Opt', 'Opt', 'Sol Ring'],
  })
  assert.ok(errors.some(e => /doppelt/.test(e)))
  assert.ok(errors.some(e => /adds UND cuts/.test(e)))
})

test('preflight: Add-bereits-im-Deck nur mit checkAddsInDeck (Browser-Pfad)', () => {
  const args = { cards: CARDS, commanders: COMMANDERS, cuts: ['Sol Ring'], adds: ['Counterspell'] }
  assert.ok(preflightSwapRules({ ...args, checkAddsInDeck: true }).some(e => /bereits im Deck/.test(e)))
  assert.equal(preflightSwapRules({ ...args, checkAddsInDeck: false }).length, 0)
})

test('preflight: sauberer Swap → keine Fehler', () => {
  const errors = preflightSwapRules({ cards: CARDS, commanders: COMMANDERS, cuts: ['Sol Ring'], adds: ['Opt'] })
  assert.deepEqual(errors, [])
})

test('preflight: unausgeglichene cuts/adds blocken (100-Karten-Invariante, Critic R2)', () => {
  const errors = preflightSwapRules({ cards: CARDS, commanders: COMMANDERS, cuts: ['Sol Ring', 'Counterspell'], adds: ['Opt'] })
  assert.ok(errors.some(e => /Unausgeglichen/.test(e)))
})

test('preflight: Cut auf quantity>1-Row bzw. Mehrfach-Rows blockt (Critic R2)', () => {
  const stacked = [
    { id: 1, name: 'Forest', quantity: 8 },
    { id: 2, name: 'Opt', quantity: 1 },
    { id: 3, name: 'Opt', quantity: 1 }, // zweite Row gleichen Namens
  ]
  const e1 = preflightSwapRules({ cards: stacked, commanders: [], cuts: ['Forest'], adds: ['Island'] })
  assert.ok(e1.some(e => /8× im Deck/.test(e)))
  const e2 = preflightSwapRules({ cards: stacked, commanders: [], cuts: ['Opt'], adds: ['Island'] })
  assert.ok(e2.some(e => /2× im Deck/.test(e)))
})

// --- searchByRole auf Slim-Records ---

const POOL = {
  cards: [
    { n: 'Cultivate', r: ['ramp'], ci: 'G', c: 3, t: 'sorcery', e: 40, gc: false, i: false },
    { n: 'Arcane Signet', r: ['ramp'], ci: '', c: 2, t: 'artifact', e: 10, gc: false, i: false },
    { n: 'Dark Ritual', r: ['ramp'], ci: 'B', c: 1, t: 'instant', e: 200, gc: false, i: false },
    { n: 'Rhystic Study', r: ['draw'], ci: 'U', c: 3, t: 'enchantment', e: 5, gc: true, i: false },
  ],
}

test('searchByRole: Rolle + CI-Subset + exclude + limit', () => {
  const hits = searchByRole(POOL, { role: 'ramp', ci: ['G', 'U'], exclude: new Set(['cultivate']), limit: 5 })
  // Dark Ritual (B) fällt am CI-Filter, Cultivate am exclude → nur Signet (farblos)
  assert.deepEqual(hits.map(h => h.n), ['Arcane Signet'])
})

test('searchByRole: farbloser Kandidat passt in jede Identity', () => {
  const hits = searchByRole(POOL, { role: 'ramp', ci: [], limit: 5 })
  assert.deepEqual(hits.map(h => h.n), ['Arcane Signet'])
})

// --- unionCandidates (Pool ∪ EDHREC, Critic-R1-[HIGH]-Fix) ---

test('unionCandidates: EDHREC-Karte mit mittlerem Global-Rank kommt DAZU (kein Overlay)', () => {
  const poolByName = new Map([
    ['cultivate', POOL.cards[0]],
    ['nyxbloom ancient', { n: 'Nyxbloom Ancient', r: ['ramp'], ci: 'G', c: 7, t: 'creature', e: 9000, gc: false, i: false }],
  ])
  const out = unionCandidates({
    base: [POOL.cards[0]], // Pool-Top: nur Cultivate
    edhrecRecs: [
      { name: 'Nyxbloom Ancient', inclusionPct: 38 }, // commander-spezifisch stark, global mittelmäßig
      { name: 'Cultivate', inclusionPct: 44 },        // Duplikat → nicht doppelt
      { name: 'Dark Ritual', inclusionPct: 30 },      // falsche CI → raus
      { name: 'Unbekannt', inclusionPct: 50 },        // nicht im Pool → raus
    ],
    poolByName: new Map([...poolByName, ['dark ritual', POOL.cards[2]]]),
    role: 'ramp',
    deckCI: ['G', 'U'],
    deckNames: new Set(),
  })
  assert.deepEqual(out.map(c => c.n), ['Cultivate', 'Nyxbloom Ancient'])
})

test('unionCandidates: cap begrenzt, Deck-Karten bleiben draußen', () => {
  const out = unionCandidates({
    base: [],
    edhrecRecs: [{ name: 'Cultivate' }, { name: 'Arcane Signet' }],
    poolByName: new Map([['cultivate', POOL.cards[0]], ['arcane signet', POOL.cards[1]]]),
    role: 'ramp',
    deckCI: ['G'],
    deckNames: new Set(['cultivate']), // liegt schon im Deck
    cap: 5,
  })
  assert.deepEqual(out.map(c => c.n), ['Arcane Signet'])
})

// --- buildGapRecommendations ---

test('buildGapRecommendations: EDHREC-Konsens-Label vor Popularitäts-Label, Sortierung nach Inclusion', () => {
  const gaps = [{ role: 'ramp', label: 'Ramp', have: 8, min: 10, max: 12, status: 'unter' }]
  const poolCandidatesByRole = new Map([['ramp', [POOL.cards[0], POOL.cards[1]]]])
  const recs = buildGapRecommendations({
    gaps,
    poolCandidatesByRole,
    edhrecRecs: [{ name: 'Cultivate', inclusionPct: 44, synergy: 2, listHeader: 'Ramp' }],
    priceMap: new Map([['Cultivate', { price: 1.1, isFoil: false }], ['Arcane Signet', { price: 0.9, isFoil: false }]]),
    headroom: 10,
  })
  const cands = recs[0].candidates
  assert.equal(cands[0].name, 'Cultivate') // Konsens (44%) vor Rank-only
  assert.match(cands[0].label, /\[KONSENS\] EDHREC 44%/)
  assert.match(cands[1].label, /Popularität/)
  assert.equal(cands[0].price, 1.1)
})

test('buildGapRecommendations: über Headroom wird markiert, nicht versteckt', () => {
  const gaps = [{ role: 'ramp', label: 'Ramp', have: 8, min: 10, max: 12, status: 'unter' }]
  const recs = buildGapRecommendations({
    gaps,
    poolCandidatesByRole: new Map([['ramp', [POOL.cards[0]]]]),
    priceMap: new Map([['Cultivate', { price: 25, isFoil: false }]]),
    headroom: 10,
  })
  assert.equal(recs[0].candidates.length, 1)
  assert.equal(recs[0].candidates[0].overHeadroom, true)
})

// --- buildCutCandidates ---

const ANALYSIS = {
  deck: { commanders: ['Saruman of Many Colors'] },
  audit: { findings: [{ level: 'block', kind: 'nicht legal', name: 'Banned Karte', detail: 'banned' }] },
  quotas: [
    { role: 'wipe', label: 'Board Wipes', have: 6, min: 3, max: 4, status: 'über' },
    { role: 'ramp', label: 'Ramp', have: 11, min: 10, max: 12, status: 'ok' },
  ],
  roles: {
    'Teurer Wipe': ['wipe'],
    'Billiger Wipe A': ['wipe'],
    'Billiger Wipe B': ['wipe'],
    'Saruman of Many Colors': [],
  },
  unclassified: ['Mystery Karte', 'Nischen Karte', 'Saruman of Many Colors'],
}
const ENRICHED = [
  { row: { name: 'Teurer Wipe', price_eur: '12.00' }, quantity: 1, record: { edhrec_rank: 500 } },
  { row: { name: 'Billiger Wipe A', price_eur: '0.50' }, quantity: 1, record: { edhrec_rank: 700 } },
  { row: { name: 'Billiger Wipe B', price_eur: '0.60' }, quantity: 1, record: { edhrec_rank: 800 } },
  { row: { name: 'Banned Karte', price_eur: '2.00' }, quantity: 1, record: { edhrec_rank: 900 } },
  { row: { name: 'Teuer Unbeliebt', price_eur: '9.00' }, quantity: 1, record: { edhrec_rank: 50000 } },
  { row: { name: 'Mystery Karte', price_eur: '0.10' }, quantity: 1, record: { edhrec_rank: 100 } },
  { row: { name: 'Nischen Karte', price_eur: '0.20' }, quantity: 1, record: { edhrec_rank: 40000 } },
  { row: { name: 'Saruman of Many Colors', price_eur: '4.00' }, quantity: 1, record: { edhrec_rank: 5000 } },
]

test('buildCutCandidates: quantity>1-Rows werden NIE vorgeschlagen (100-Karten-Invariante)', () => {
  const analysis = {
    deck: { commanders: [] },
    audit: { findings: [] },
    quotas: [{ role: 'land', label: 'Länder', have: 40, min: 36, max: 38, status: 'über' }],
    roles: { Forest: ['land'], 'Reliquary Tower': ['land'] },
    unclassified: [],
  }
  const enriched = [
    { row: { name: 'Forest', price_eur: '0.10' }, quantity: 8, record: { edhrec_rank: 1 } },
    { row: { name: 'Reliquary Tower', price_eur: '2.00' }, quantity: 1, record: { edhrec_rank: 300 } },
  ]
  const cuts = buildCutCandidates({ analysis, enriched })
  const names = cuts.map(c => c.name)
  assert.ok(!names.includes('Forest')) // 8× gestapelt → 1:1-Swap würde Karten verlieren
  assert.ok(names.includes('Reliquary Tower'))
})

test('buildCutCandidates: Audit zuerst, dann Überschuss (teuerste), Commander NIE', () => {
  const cuts = buildCutCandidates({ analysis: ANALYSIS, enriched: ENRICHED })
  const names = cuts.map(c => c.name)
  assert.equal(names[0], 'Banned Karte')
  // Überschuss: 6 - 4 = 2 → die zwei teuersten Wipes
  assert.ok(names.includes('Teurer Wipe'))
  assert.ok(!names.includes('Saruman of Many Colors'))
  const teuer = cuts.find(c => c.name === 'Teuer Unbeliebt')
  assert.ok(teuer && /geringer Popularität/.test(teuer.reason))
  // Rang-4-Guard (User-Befund 06.08.): beliebte Unklassifizierte (#100) sind
  // KEINE Cut-Kandidaten mehr — nur wenig gespielte (#40.000) bleiben.
  assert.ok(!names.includes('Mystery Karte'), 'Staple ohne Rolle ist kein Cut')
  const nische = cuts.find(c => c.name === 'Nischen Karte')
  assert.ok(nische && /keine Standard-Rolle & wenig gespielt/.test(nische.reason))
})

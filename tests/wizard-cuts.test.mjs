import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildCutCandidates } from '../src/wizard/cuts.js'

// Minimal-Fixtures: analysis + enriched, wie buildAnalysis/enrich sie liefern.
const enrichedRow = (name, { price = '1.00', quantity = 1, rank = null } = {}) => ({
  row: { name, price_eur: price, quantity },
  record: { edhrec_rank: rank },
  effective: {},
  roles: [],
  quantity,
})

const baseAnalysis = (over = {}) => ({
  deck: { commanders: ['Test Commander'], ...over.deck },
  audit: { findings: [], ...over.audit },
  quotas: over.quotas ?? [],
  roles: over.roles ?? {},
  unclassified: over.unclassified ?? [],
})

test('cuts: Rang 4 schlägt beliebte Unklassifizierte NICHT mehr vor (Sphinx-Befund)', () => {
  // User-Screenshot 06.08.: Consecrated Sphinx (#662), Mithril Coat (#239) &
  // Co. dominierten die Liste — alles Staples. Mit Popularitäts-Guard bleibt
  // nur die wirklich wenig gespielte Karte übrig.
  const enriched = [
    enrichedRow('Consecrated Sphinx', { price: '17.52', rank: 662 }),
    enrichedRow('Sapphire Medallion', { price: '4.79', rank: 370 }),
    enrichedRow('Obscure Pet Card', { price: '0.50', rank: 25000 }),
  ]
  const analysis = baseAnalysis({
    unclassified: ['Consecrated Sphinx', 'Sapphire Medallion', 'Obscure Pet Card'],
  })
  const cuts = buildCutCandidates({ analysis, enriched })
  const names = cuts.map(c => c.name)
  assert.ok(!names.includes('Consecrated Sphinx'), 'Staple (#662) ist kein Cut-Kandidat')
  assert.ok(!names.includes('Sapphire Medallion'), 'Staple (#370) ist kein Cut-Kandidat')
  assert.ok(names.includes('Obscure Pet Card'), 'wenig gespielte Unklassifizierte bleibt Kandidat')
  assert.match(cuts.find(c => c.name === 'Obscure Pet Card').reason, /EDHREC #25\.000/)
})

test('cuts: Rang 4 ohne EDHREC-Daten — ehrlicher Text statt "Rank #null", Cap 3', () => {
  const names = ['Karte A', 'Karte B', 'Karte C', 'Karte D', 'Karte E']
  const enriched = names.map((n, i) => enrichedRow(n, { rank: i < 3 ? 20000 + i : null }))
  const analysis = baseAnalysis({ unclassified: names })
  const cuts = buildCutCandidates({ analysis, enriched })
  const rank4 = cuts.filter(c => c.rank === 4)
  assert.equal(rank4.length, 3, 'Rang 4 ist auf 3 gedeckelt (vorher 6)')
  // Unbeliebteste zuerst, rank-lose (schwächste Evidenz) hinter bekannten Ranks
  assert.match(rank4[0].reason, /EDHREC #/)
  for (const c of rank4) assert.ok(!/null/.test(c.reason), 'kein "Rank #null"-Leak')
})

test('cuts: Commander und quantity>1-Rows bleiben ausgeschlossen (Bestand)', () => {
  const enriched = [
    enrichedRow('Test Commander', { rank: 50000 }),
    enrichedRow('Stapel-Basics', { rank: 50000, quantity: 8 }),
    enrichedRow('Echte Nische', { rank: 50000 }),
  ]
  const analysis = baseAnalysis({
    unclassified: ['Test Commander', 'Stapel-Basics', 'Echte Nische'],
  })
  const names = buildCutCandidates({ analysis, enriched }).map(c => c.name)
  assert.deepEqual(names, ['Echte Nische'])
})

test('cuts: Audit-Findings (Rang 1) und Überschuss (Rang 2) stehen vor Rang 4', () => {
  const enriched = [
    enrichedRow('Banned Karte', { price: '2.00', rank: 100 }),
    enrichedRow('Ramp Teuer', { price: '9.00', rank: 200 }),
    enrichedRow('Ramp Billig', { price: '0.30', rank: 300 }),
    enrichedRow('Nische', { rank: 30000 }),
  ]
  const analysis = baseAnalysis({
    audit: { findings: [{ kind: 'banned', name: 'Banned Karte' }] },
    quotas: [{ role: 'ramp', label: 'Ramp', have: 2, min: 0, max: 1, status: 'über' }],
    roles: { 'Ramp Teuer': ['ramp'], 'Ramp Billig': ['ramp'] },
    unclassified: ['Nische'],
  })
  const cuts = buildCutCandidates({ analysis, enriched })
  assert.equal(cuts[0].name, 'Banned Karte')
  assert.equal(cuts[1].name, 'Ramp Teuer', 'Überschuss: teuerste zuerst')
  assert.equal(cuts.at(-1).name, 'Nische')
})

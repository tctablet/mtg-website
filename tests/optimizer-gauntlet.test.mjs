import { test } from 'node:test'
import assert from 'node:assert/strict'
import { passesAgainst } from '../scripts/optimizer/gauntlet.mjs'

const me = (over = {}) => ({
  speed: 8,
  keepRate: 0.9,
  interaction: { count: 12, nonland: 60, density: 0.2, instantSpeed: 8 },
  ...over,
})
const opp = (over = {}) => ({ speed: 7, bracketBand: 'mid', ...over })

test('passesAgainst: Clock-Parity (eigener Median <= Gegner + 1)', () => {
  assert.equal(passesAgainst(me({ speed: 8 }), opp({ speed: 7 })).pass, true)
  assert.equal(passesAgainst(me({ speed: 9, interaction: { count: 2, nonland: 60, density: 0.03, instantSpeed: 0 } }), opp({ speed: 7 })).pass, false)
})

test('passesAgainst: Antwort-Parity rettet langsame Decks mit genug Interaktion', () => {
  const slow = me({ speed: null }) // kein Goldfish-Kill <= T10
  const r = passesAgainst(slow, opp({ speed: 5, bracketBand: 'mid' }))
  assert.equal(r.clockParity, false)
  assert.equal(r.answerParity, true) // 20% Dichte >= 15% Benchmark, 8/12 instant >= 40%
  assert.equal(r.pass, true)
})

test('passesAgainst: instant-speed-Anteil unter 40% kippt Antwort-Parity', () => {
  const sorceryOnly = me({ speed: null, interaction: { count: 12, nonland: 60, density: 0.2, instantSpeed: 2 } })
  assert.equal(passesAgainst(sorceryOnly, opp({ speed: 5 })).pass, false)
})

test('passesAgainst: Benchmark skaliert mit Gegner-Bracket-Band', () => {
  const borderline = me({ speed: null, interaction: { count: 8, nonland: 60, density: 0.13, instantSpeed: 6 } })
  assert.equal(passesAgainst(borderline, opp({ bracketBand: 'low', speed: 9 })).pass, true) // 13% >= 10%
  assert.equal(passesAgainst(borderline, opp({ bracketBand: 'high', speed: 4 })).pass, false) // 13% < 20%
})

test('passesAgainst: Keep-Rate unter 80% schlägt alles', () => {
  assert.equal(passesAgainst(me({ keepRate: 0.7 }), opp()).pass, false)
  assert.equal(passesAgainst(me({ keepRate: 0.7 }), opp()).keepOk, false)
})

test('passesAgainst: Gegner ohne Clock (>T10) gilt für Clock-Parity als eingeholt', () => {
  const r = passesAgainst(me({ speed: 9 }), opp({ speed: null }))
  assert.equal(r.clockParity, true)
})

test('passesAgainst: Interaktions-Floor ist Pflicht — Clock-Parity allein reicht nicht (Anti-Gummistempel)', () => {
  // Schnell genug, aber quasi ohne Interaktion → fällt am Floor.
  const bystander = me({ speed: 9, interaction: { count: 3, nonland: 62, density: 0.048, instantSpeed: 2 } })
  const r = passesAgainst(bystander, opp({ speed: 9, bracketBand: 'mid' }))
  assert.equal(r.clockParity, true)
  assert.equal(r.floorOk, false)
  assert.equal(r.pass, false, 'ohne Interaktions-Floor kein Bestehen')
})

test('Canary gegen echtes pod-meta.json: Kriterium darf kein Gummistempel sein', async (t) => {
  let pod
  try {
    const { readFile } = await import('node:fs/promises')
    pod = JSON.parse(await readFile(new URL('../scripts/optimizer/pod-meta.json', import.meta.url), 'utf8'))
  } catch {
    t.skip('pod-meta.json fehlt (noch kein --scan gelaufen)')
    return
  }
  const decks = pod.decks
  if (decks.length < 5) { t.skip('zu wenige Decks für aussagekräftige Rate'); return }
  let pass = 0, total = 0
  for (const a of decks) for (const b of decks) {
    if (a.id === b.id) continue
    total++
    if (passesAgainst(a, b).pass) pass++
  }
  const rate = pass / total
  // Engeres Band als 0..1 (Critic Runde 2: weiche Verwässerung fangen):
  // >95% wäre wieder Quasi-Gummistempel, <5% übertrieben streng.
  assert.ok(rate < 0.95, `passRate ${(rate * 100).toFixed(1)}% — >95% ist ein Quasi-Rubber-Stamp`)
  assert.ok(rate > 0.05, `passRate ${(rate * 100).toFixed(1)}% — <5% wäre nutzlos streng`)
})

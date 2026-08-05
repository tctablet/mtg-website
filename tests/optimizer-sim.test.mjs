import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mulberry32, shuffled, millAmount, manaProductionAmount, isLandRampText, toSimCard, playGame, simulate } from '../scripts/optimizer/lib/sim.mjs'

const land = (name = 'Island', tapped = false) => ({
  name, quantity: 1, isLand: true, entersTapped: tapped, cmc: 0,
  isRock: false, isCreature: false, power: 0, mill: 0, roles: ['land'],
})
const spell = (name, cmc, over = {}) => ({
  name, quantity: 1, isLand: false, entersTapped: false, cmc,
  isRock: false, isCreature: false, power: 0, mill: 0, roles: [], ...over,
})

test('mulberry32: gleicher Seed → identische Sequenz, andere Seeds divergieren', () => {
  const a = mulberry32(42), b = mulberry32(42), c = mulberry32(7)
  const seqA = [a(), a(), a()]
  const seqB = [b(), b(), b()]
  assert.deepEqual(seqA, seqB)
  assert.notDeepEqual(seqA, [c(), c(), c()])
  assert.ok(seqA.every(x => x >= 0 && x < 1))
})

test('shuffled: Permutation, deterministisch bei gleichem Seed, Original unberührt', () => {
  const orig = [1, 2, 3, 4, 5, 6, 7, 8]
  const s1 = shuffled(orig, mulberry32(1))
  const s2 = shuffled(orig, mulberry32(1))
  assert.deepEqual(s1, s2)
  assert.deepEqual([...s1].sort((a, b) => a - b), orig)
  assert.deepEqual(orig, [1, 2, 3, 4, 5, 6, 7, 8])
})

test('millAmount: Zahlwörter, Ziffern, put-top-X-Muster', () => {
  assert.equal(millAmount('Each opponent mills eight cards.'), 8)
  assert.equal(millAmount('Target player mills two cards.'), 2)
  assert.equal(millAmount('Target player puts the top three cards of their library into their graveyard.'), 3)
  assert.equal(millAmount('Counter target spell.'), 0)
})

test('toSimCard: Tapland-Erkennung mit Bedingungs-Ausnahme', () => {
  const eff = (text, type = 'Land') => ({ name: 'X', type_line: type, oracle_text: text, cmc: 0, power: null, layout: 'normal' })
  assert.equal(toSimCard({ effective: eff('This land enters the battlefield tapped.'), roles: ['land'], quantity: 1 }).entersTapped, true)
  assert.equal(toSimCard({ effective: eff('This land enters the battlefield tapped unless you control two or more basic lands.'), roles: ['land'], quantity: 1 }).entersTapped, false)
})

test('Mana-Modell: Sol Ring = 2, Dork = 1, Land-Ramp erkannt (Critic-Fix)', () => {
  assert.equal(manaProductionAmount('{T}: Add {C}{C}.'), 2)
  assert.equal(manaProductionAmount('{T}: Add {G}.'), 1)
  assert.equal(manaProductionAmount('{T}: Add two mana of any one color.'), 2)
  assert.equal(manaProductionAmount('Counter target spell.'), 0)
  assert.equal(isLandRampText('Search your library for up to two basic land cards, put one onto the battlefield tapped.'), true)
  assert.equal(isLandRampText('Draw a card.'), false)

  const solRing = toSimCard({ effective: { name: 'Sol Ring', type_line: 'Artifact', oracle_text: '{T}: Add {C}{C}.', cmc: 1, power: null, layout: 'normal' }, roles: ['ramp'], quantity: 1 })
  assert.equal(solRing.manaProduction, 2, 'Sol Ring produziert 2, nicht pauschal 1')
  const dork = toSimCard({ effective: { name: 'Llanowar Elves', type_line: 'Creature — Elf Druid', oracle_text: '{T}: Add {G}.', cmc: 1, power: '1', layout: 'normal' }, roles: ['ramp'], quantity: 1 })
  assert.equal(dork.manaProduction, 1, 'Kreatur-Dorks sind Mana-Quellen (waren vorher blind)')
  const cultivate = toSimCard({ effective: { name: 'Cultivate', type_line: 'Sorcery', oracle_text: 'Search your library for up to two basic land cards, put one onto the battlefield tapped and the other into your hand, then shuffle.', cmc: 3, power: null, layout: 'normal' }, roles: ['ramp'], quantity: 1 })
  assert.equal(cultivate.isLandRamp, true)
  assert.equal(cultivate.manaProduction, 0, 'Sorcery ist keine wiederholende Quelle')
})

test('Mana-Modell: einmalige ETB-Treasure-Kreatur ist KEIN permanenter Rock (Critic Runde 2)', () => {
  const etbTreasure = toSimCard({
    effective: {
      name: 'Goblin Schatzmacher', type_line: 'Creature — Goblin',
      oracle_text: 'When this creature enters the battlefield, create a Treasure token.',
      cmc: 2, power: '2', layout: 'normal',
    },
    roles: ['ramp'], quantity: 1,
  })
  assert.equal(etbTreasure.manaProduction, 0, 'One-Shot-Treasure darf nicht dauerhaft produzieren')
  assert.equal(etbTreasure.oneShotMana, 1, 'aber einmalig 1 Mana geben')
  // Aktivierte Quelle bleibt Rock:
  const monument = toSimCard({
    effective: { name: 'Rock', type_line: 'Artifact', oracle_text: '{T}: Add {C}.', cmc: 2, power: null, layout: 'normal' },
    roles: ['ramp'], quantity: 1,
  })
  assert.equal(monument.manaProduction, 1)
  assert.equal(monument.oneShotMana, 0)
})

test('Mana-Modell wirkt in der Simulation: Dorks/Land-Ramp beschleunigen', () => {
  const base = [
    ...Array(36).fill({ name: 'Island', quantity: 1, isLand: true, entersTapped: false, cmc: 0, manaProduction: 0, isLandRamp: false, isCreature: false, power: 0, mill: 0, roles: ['land'] }),
    ...Array(63).fill({ name: 'Filler', quantity: 1, isLand: false, entersTapped: false, cmc: 4, manaProduction: 0, isLandRamp: false, isCreature: false, power: 0, mill: 0, roles: [] }),
  ]
  const ramped = [
    ...base.slice(0, 36),
    ...Array(10).fill({ name: 'Dork', quantity: 1, isLand: false, entersTapped: false, cmc: 1, manaProduction: 1, isLandRamp: false, isCreature: true, power: 1, mill: 0, roles: ['ramp'] }),
    ...Array(53).fill(base[40]),
  ]
  const rBase = simulate(base, { iterations: 150, seed: 9, turns: 6 })
  const rRamp = simulate(ramped, { iterations: 150, seed: 9, turns: 6 })
  assert.ok(rRamp.manaAvg[5] > rBase.manaAvg[5] + 0.5,
    `Dorks müssen Mana messbar erhöhen (${rRamp.manaAvg[5]} vs ${rBase.manaAvg[5]})`)
})

test('playGame: deterministisch, Landdrops akkumulieren, Rock produziert ab Folgezug', () => {
  // 30 Länder + 10 Rocks + 60 Vanilla-Spells: strukturiert genug für stabile Aussagen.
  const deck = [
    ...Array(30).fill(land()),
    ...Array(10).fill(spell('Rock', 1, { isRock: true, roles: ['ramp'] })),
    ...Array(60).fill(spell('Filler', 3)),
  ]
  const g1 = playGame(deck, mulberry32(5), { turns: 6 })
  const g2 = playGame(deck, mulberry32(5), { turns: 6 })
  assert.deepEqual(g1, g2)
  // Länder je Zug sind monoton nicht-fallend.
  for (let i = 1; i < g1.landsByTurn.length; i++) {
    assert.ok(g1.landsByTurn[i] >= g1.landsByTurn[i - 1])
  }
})

test('simulate: Keep-Rate plausibel, Mill-Clock feuert bei Mill-Deck', () => {
  // Extremes Mill-Deck: 40 Länder + 59 "Mill 20"-Spells für 1 Mana.
  const deck = [
    ...Array(40).fill(land()),
    ...Array(59).fill(spell('Mill20', 1, { mill: 20, roles: ['mill'] })),
  ]
  const r = simulate(deck, { iterations: 200, seed: 42, turns: 10 })
  // Keep-Rate misst die Hand NACH dem Free Mulligan — bei 40 Ländern muss die
  // fast immer keepbar sein.
  assert.ok(r.keepRate > 0.9, `Keep-Rate ${r.keepRate} bei 40 Ländern sollte nach Free Mulligan >90% sein`)
  assert.ok(r.clocks.mill.median !== null, 'Mill-Clock muss erreicht werden')
  assert.ok(r.clocks.mill.median <= 8)
  assert.equal(r.clocks.combat.median, null, 'kein Combat ohne Kreaturen')
  // Ceiling (beste 5%) ist nie langsamer als der Median.
  assert.ok(r.clocks.mill.ceiling <= r.clocks.mill.median)
  // Reproduzierbarkeit der Aggregatwerte.
  const r2 = simulate(deck, { iterations: 200, seed: 42, turns: 10 })
  assert.deepEqual(r, r2)
})

test('simulate: Combat-Clock mit dicken Kreaturen, Summoning Sickness respektiert', () => {
  const deck = [
    ...Array(40).fill(land()),
    ...Array(59).fill(spell('Bär 8/8', 2, { isCreature: true, power: 8, roles: [] })),
  ]
  const r = simulate(deck, { iterations: 200, seed: 1, turns: 10 })
  assert.ok(r.clocks.combat.median !== null)
  // 40 Schaden mit 8er-Power-Kreaturen: T2 erste Kreatur, greift ab T3 an —
  // Clock kann nie vor T3 liegen (Summoning Sickness).
  assert.ok(r.clocks.combat.ceiling >= 3)
})

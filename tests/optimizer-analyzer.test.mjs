import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyCard, allowsMultiples, isInstantSpeed, mergeOverrides } from '../scripts/optimizer/lib/roles.mjs'
import { countRoles, compareToTemplate, hypergeomAtLeast, pByTurn } from '../scripts/optimizer/lib/quotas.mjs'
import { karstenLandCount, averageManaValue, countPips, colorSourceReport, countColorSources, splitFastMana } from '../scripts/optimizer/lib/manabase.mjs'
import { deckValue, budgetGate, BUDGET_LIMIT_EUR } from '../scripts/optimizer/lib/budget.mjs'
import { auditDeck, validateCandidate } from '../scripts/optimizer/lib/validate.mjs'
import { buildIndex, toPoolRecord } from '../scripts/optimizer/lib/cardpool.mjs'
import { formatTotalPrice } from '../src/utils.js'

// ---- Fixtures: echte Oracle-Texte (gekürzt) ----
const rec = (name, type_line, oracle_text, over = {}) => ({
  name, type_line, oracle_text,
  mana_cost: over.mana_cost ?? '{1}', cmc: over.cmc ?? 1,
  colors: [], color_identity: over.color_identity ?? [],
  keywords: over.keywords ?? [], layout: 'normal',
  legal: over.legal ?? 'legal', games: ['paper'],
  game_changer: false, edhrec_rank: null,
  produced_mana: over.produced_mana ?? [], power: null, toughness: null, faces: null,
})

test('roles: Ramp-Erkennung (Rock, Land-Ramp) ohne False-Positives', () => {
  assert.deepEqual(classifyCard(rec('Sol Ring', 'Artifact', '{T}: Add {C}{C}.')), ['ramp'])
  const cultivate = classifyCard(rec('Cultivate', 'Sorcery',
    'Search your library for up to two basic land cards, put one onto the battlefield tapped and the other into your hand, then shuffle.'))
  assert.ok(cultivate.includes('ramp'))
  assert.ok(!cultivate.includes('tutor'), 'Land-Ramp ist kein Tutor')
  // Ein normales Land ist NUR land, kein Ramp.
  assert.deepEqual(classifyCard(rec('Island', 'Basic Land — Island', '({T}: Add {U}.)')), ['land'])
})

test('roles: Removal inkl. Path-to-Exile-Fall, aber nicht Land Destruction', () => {
  const path = classifyCard(rec('Path to Exile', 'Instant',
    'Exile target creature. Its controller may search their library for a basic land card, put that card onto the battlefield tapped, then shuffle.'))
  assert.ok(path.includes('removal'), 'Path to Exile ist Removal trotz "land" im Text')
  const stripMine = classifyCard(rec('Strip Mine Effekt', 'Sorcery', 'Destroy target land.'))
  assert.ok(!stripMine.includes('removal'), 'Land Destruction ist kein Removal-Slot')
})

test('roles: Selbst-Ziele sind kein Removal, "you don\'t control" schon (Critic-Fund 21.08.)', () => {
  const closet = classifyCard(rec('Conjurer\'s Closet', 'Artifact',
    'At the beginning of your end step, you may exile target creature you control, then return that card to the battlefield under your control.'))
  assert.ok(!closet.includes('removal'), 'Selbst-Blink (you control) ist kein Removal')
  const swords = classifyCard(rec('Exil-Effekt', 'Instant', 'Exile target creature you don\'t control.'))
  assert.ok(swords.includes('removal'), '"you don\'t control" bleibt Removal')
  const duplicant = classifyCard(rec('Duplicant', 'Artifact Creature — Shapeshifter',
    'Imprint — When this creature enters, you may exile target nontoken creature.'))
  assert.ok(duplicant.includes('removal'), 'Exil ohne Selbst-Bezug bleibt Removal')
  // "you control" in Relativsatz/Präposition bezieht sich NICHT aufs Ziel
  // (Critic-Corpus-Fund 21.08.): das bleibt Removal.
  const soulSnare = classifyCard(rec('Soul Snare', 'Enchantment',
    '{W}, Sacrifice this enchantment: Exile target creature that\'s attacking you or a planeswalker you control.'))
  assert.ok(soulSnare.includes('removal'), 'Ziel ist die gegnerische Angreifer-Kreatur')
  const miracleWorker = classifyCard(rec('Miracle Worker', 'Creature — Human Cleric',
    '{T}: Destroy target Aura attached to a creature you control.'))
  assert.ok(miracleWorker.includes('removal'), 'Ziel ist die gegnerische Aura, nicht die eigene Kreatur')
  // O-Ring-Duration-Anker ("until target enchantment you control leaves")
  // ist nicht das Exil-Ziel — bleibt Removal (Calix-Klasse).
  const calix = classifyCard(rec('Calix, Destiny\'s Hand', 'Legendary Planeswalker — Calix',
    '−3: Exile target creature or enchantment you don\'t control until target enchantment you control leaves the battlefield.'))
  assert.ok(calix.includes('removal'), 'Duration-Anker macht O-Ring-Exil nicht zum Selbst-Ziel')
})

test('roles: Replacement-Modifikator ("instead create … Treasure") ist kein Ramp (Bilbo-Klasse)', () => {
  const bilbo = classifyCard(rec('Bilbo, Fellow Conspirator', 'Legendary Creature — Halfling Citizen',
    'If you would create a Food token, instead create a Food token and a Treasure token.'))
  assert.ok(!bilbo.includes('ramp'), 'passiver Food→Treasure-Modifikator produziert selbst kein Mana')
  const innkeeper = classifyCard(rec('Prosperous Innkeeper', 'Creature — Halfling Citizen',
    'When this creature enters, create a Treasure token.\nWhenever another creature you control enters, you gain 1 life.'))
  assert.ok(innkeeper.includes('ramp'), 'aktiver Treasure-Maker bleibt Ramp')
  // Eigene bedingte Eskalation ("instead" OHNE "would create") ist echte
  // Treasure-Quelle (Mr.-House-Klasse, Critic-Corpus-Fund 21.08.).
  const mrHouse = classifyCard(rec('Mr. House, President and CEO', 'Legendary Creature — Human',
    'Whenever you roll a 4 or higher, create a 3/3 colorless Robot artifact creature token. If you rolled 6 or higher, instead create that token and a Treasure token.'))
  assert.ok(mrHouse.includes('ramp'), 'bedingte Eskalation der eigenen Fähigkeit bleibt Ramp')
})

test('roles: Wipe eng gefasst — Anthem matcht nicht', () => {
  assert.ok(classifyCard(rec('Wrath of God', 'Sorcery', 'Destroy all creatures. They can\'t be regenerated.')).includes('wipe'))
  assert.ok(classifyCard(rec('Blasphemous Act', 'Sorcery', 'This spell costs {1} less to cast for each creature on the battlefield.\nBlasphemous Act deals 13 damage to each creature.')).includes('wipe'))
  assert.ok(classifyCard(rec('Toxic Deluge', 'Sorcery', 'As an additional cost to cast this spell, pay X life.\nEach creature gets -X/-X until end of turn.')).includes('wipe'))
  const anthem = classifyCard(rec('Glorious Anthem', 'Enchantment', 'Creatures you control get +1/+1.'))
  assert.ok(!anthem.includes('wipe'))
})

test('roles: Counter, Tutor, Draw, Mill, Protection', () => {
  assert.deepEqual(classifyCard(rec('Counterspell', 'Instant', 'Counter target spell.')), ['counter'])
  assert.ok(classifyCard(rec('Mystical Tutor', 'Instant', 'Search your library for an instant or sorcery card, reveal it, then shuffle. Put that card on top of your library.')).includes('tutor'))
  assert.ok(classifyCard(rec('Rhystic Study', 'Enchantment', 'Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.')).includes('draw'))
  assert.ok(classifyCard(rec('Maddening Cacophony', 'Sorcery', 'Each opponent mills eight cards.')).includes('mill'))
  assert.ok(classifyCard(rec('Heroic Intervention', 'Instant', 'Permanents you control gain hexproof and indestructible until end of turn.')).includes('protection'))
})

test('roles: Gegner-Draw nur mit Removal-Kontext gestrippt (Baleful vs. Howling Mine)', () => {
  // Removal-Kompensation: "that player draws" NACH gezieltem Removal → kein Draw.
  const baleful = classifyCard(rec('Baleful Mastery', 'Instant',
    'Exile target creature or planeswalker. That player draws a card.'))
  assert.ok(baleful.includes('removal'))
  assert.ok(!baleful.includes('draw'), 'Gegner-Kompensations-Draw ist kein Card Advantage')
  // OHNE Removal-Kontext bleibt "that player draws" Draw (Group-Hug-Klasse).
  const mine = classifyCard(rec('Howling Mine', 'Artifact',
    'At the beginning of each player\'s draw step, that player draws an additional card.'))
  assert.ok(mine.includes('draw'), 'Howling Mine ist Draw (Critic-Regression Runde 2)')
  // "Target player draws X cards" ist in EDH Selbst-Draw (Stroke-of-Genius-Klasse).
  const stroke = classifyCard(rec('Stroke of Genius', 'Instant', 'Target player draws X cards.'))
  assert.deepEqual(stroke, ['draw'], 'Stroke of Genius darf nicht gestrippt werden')
  // Immer-Gegner-Subjekte bleiben gestrippt.
  const gift = classifyCard(rec('Geschenk', 'Sorcery', 'Each opponent draws two cards.'))
  assert.ok(!gift.includes('draw'))
  const windfall = classifyCard(rec('Windfall', 'Sorcery',
    'Each player discards their hand, then draws cards equal to the greatest number of cards a player discarded this way.'))
  assert.ok(windfall.includes('draw'))
})

test('roles: Gegner-Draw mit Selbst-Draw-Folge bleibt Draw (Consecrated-Sphinx-Klasse)', () => {
  // "Whenever an opponent draws a card, you may draw two cards." — der Strip
  // darf den Satz nicht fressen, DU bist der Nutznießer (User-Befund 06.08.:
  // Sphinx landete als "ohne erkannte Rolle" in den Cut-Kandidaten).
  const sphinx = classifyCard(rec('Consecrated Sphinx', 'Creature — Sphinx',
    'Flying\nWhenever an opponent draws a card, you may draw two cards.'))
  assert.ok(sphinx.includes('draw'), 'Consecrated Sphinx ist eine Draw-Engine')
  // Regression: reiner Gegner-Draw ohne Selbst-Draw bleibt gestrippt.
  const tithe = classifyCard(rec('Smothering-Klasse', 'Enchantment',
    'Whenever an opponent draws a card, that player loses 1 life.'))
  assert.ok(!tithe.includes('draw'))
})

test('roles: Bounce ist Removal (Cyclonic-Rift-Klasse), Selbst-Bounce nicht', () => {
  const rift = classifyCard(rec('Cyclonic Rift', 'Instant',
    'Return target nonland permanent you don\'t control to its owner\'s hand.\nOverload {6}{U} (You may cast this spell for its overload cost. If you do, change its text by replacing all instances of "target" with "each.")'))
  assert.ok(rift.includes('removal'), 'Cyclonic Rift ist Interaktion (User-Fund 06.08.)')
  assert.ok(classifyCard(rec('Unsummon', 'Instant',
    'Return target creature to its owner\'s hand.')).includes('removal'))
  assert.ok(classifyCard(rec('Evacuation', 'Instant',
    'Return all creatures to their owners\' hands.')).includes('removal'))
  // Selbst-Bounce/Selbst-Rückholer sind KEIN Removal-Slot.
  assert.ok(!classifyCard(rec('Eigenbounce', 'Instant',
    'Return target creature you control to its owner\'s hand. Draw a card.')).includes('removal'))
  assert.ok(!classifyCard(rec('Gott-Klasse', 'Creature — God',
    'When this creature dies, return it to its owner\'s hand.')).includes('removal'))
  assert.ok(!classifyCard(rec('Selbstschutz-Klasse', 'Creature — Illusion',
    'When this creature becomes the target of a spell, return this creature to its owner\'s hand.')).includes('removal'),
    'Critic-Fund: "return this creature" ist Selbstschutz, kein Removal')
  // Grabgeschichte ist Rekursion, kein Board-Removal (Called-Back-Klasse).
  assert.ok(!classifyCard(rec('Called-Back-Klasse', 'Sorcery',
    'Return target creature card from your graveyard to its owner\'s hand.')).includes('removal'),
    'Critic-Fund: "creature card" (Friedhof) darf nicht als Bounce zählen')
})

test('roles: "has indestructible" zählt als Protection (Mithril-Coat-Klasse)', () => {
  const coat = classifyCard(rec('Mithril Coat', 'Legendary Artifact — Equipment',
    'Flash\nIndestructible\nWhen Mithril Coat enters, attach it to target legendary creature you control.\nEquipped creature has indestructible.\nEquip {3}'))
  assert.ok(coat.includes('protection'), '"has indestructible" fehlte in der Alternation')
  // Bestand: "gains"/"have" matchen weiterhin.
  assert.ok(classifyCard(rec('Boros Charm Mode', 'Instant',
    'Permanents you control gain indestructible until end of turn.')).includes('protection'))
})

test('manabase: Fetchländer zählen als Quellen ihrer holbaren Farben (Karsten)', () => {
  const land = (name, oracle_text, produced = []) => ({
    record: { name, type_line: 'Land', oracle_text, produced_mana: produced, mana_cost: '', cmc: 0 },
    quantity: 1,
  })
  const sources = countColorSources([
    land('Polluted Delta', "{T}, Pay 1 life, Sacrifice this land: Search your library for an Island or Swamp card, put it onto the battlefield, then shuffle."),
    land('Evolving Wilds', '{T}, Sacrifice this land: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.'),
    land('Island', '', ['U']),
  ])
  assert.equal(sources.U, 3, 'Delta + Wilds + Island')
  assert.equal(sources.B, 2, 'Delta + Wilds')
  assert.equal(sources.G, 1, 'nur Wilds (generisches basic land)')
  // Nonland-Tutoren mit Land-Suche zählen NICHT (kein Permanent auf dem Feld)
  const tutor = countColorSources([{
    record: { name: 'Rampant Growth', type_line: 'Sorcery', oracle_text: 'Search your library for a basic land card...', produced_mana: [], mana_cost: '{1}{G}', cmc: 2 },
    quantity: 1,
  }])
  assert.equal(tutor.G, 0)
})

test('manabase: colorSourceReport nennt die Treiber-Karte des Ziels', () => {
  const report = colorSourceReport([
    { record: { name: 'Fractured Sanity', type_line: 'Sorcery', mana_cost: '{U}{U}{U}', cmc: 3, oracle_text: '', produced_mana: [] }, quantity: 1 },
    { record: { name: 'Counterspell', type_line: 'Instant', mana_cost: '{U}{U}', cmc: 2, oracle_text: '', produced_mana: [] }, quantity: 1 },
    { record: { name: 'Island', type_line: 'Basic Land', mana_cost: '', cmc: 0, oracle_text: '', produced_mana: ['U'] }, quantity: 20 },
  ])
  const u = report.find(c => c.color === 'U')
  assert.equal(u.target, 34, '3 frühe Pips → Karsten 34')
  assert.equal(u.driver, 'Fractured Sanity', 'die UUU-Karte setzt den Richtwert')
})

test('roles: Edict- und Divided-Damage-Removal inkl. Grave Pact werden erkannt', () => {
  assert.ok(classifyCard(rec('Diabolic Edict', 'Instant', 'Target opponent sacrifices a creature.')).includes('removal'))
  assert.ok(classifyCard(rec('Chainer\'s Edict', 'Sorcery', 'Target player sacrifices a creature. Flashback {5}{B}{B}')).includes('removal'))
  assert.ok(classifyCard(rec('Comet Storm', 'Instant', 'Comet Storm deals X damage divided as you choose among any number of targets.')).includes('removal'))
  assert.ok(classifyCard(rec('Grave Pact', 'Enchantment',
    'Whenever a creature you control dies, each other player sacrifices a creature.')).includes('removal'),
    'Grave Pact ("each other player") ist die Referenzkarte der Edict-Klasse')
})

test('roles: MDFC mit Removal-Front + Land-Back bekommt land UND removal', () => {
  const mdfc = classifyCard({
    ...rec('Poison the Cup // Innistrad Seite', 'Instant // Land',
      'Destroy target creature. If this spell was cast during your turn... // Land enters the battlefield tapped.'),
    layout: 'modal_dfc',
  })
  assert.ok(mdfc.includes('land'))
  assert.ok(mdfc.includes('removal'), 'Spell-Rolle der Vorderseite bleibt erhalten')
})

test('manabase: splitFastMana verhindert Doppelzählung in der Karsten-Formel', () => {
  const { rampForFormula, fastMana } = splitFastMana(10, 2)
  assert.equal(rampForFormula, 8)
  // Sol-Ring-Fall durchgerechnet: ramp=10 inkl. 2 Fast Mana ==>
  // Formel bekommt ramp=8 UND fastMana=2 — NICHT ramp=10 + fastMana=2.
  const korrekt = karstenLandCount({ commanders: 1, avgMV: 3.0, rampCount: rampForFormula, drawCount: 10, fastMana })
  const doppelt = karstenLandCount({ commanders: 1, avgMV: 3.0, rampCount: 10, drawCount: 10, fastMana: 2 })
  assert.ok(korrekt > doppelt, 'Doppelzählung drückt den Land-Zielwert zu stark')
  assert.equal(korrekt, 33.8) // 35.224 - 2 + 0.28*2 = 33.784 → 33.8
  assert.equal(splitFastMana(1, 3).rampForFormula, 0) // nie negativ
})

test('roles: allowsMultiples, isInstantSpeed, Overrides ersetzen komplett', () => {
  assert.equal(allowsMultiples(rec('Plains', 'Basic Land — Plains', '')), true)
  assert.equal(allowsMultiples(rec('Relentless Rats', 'Creature — Rat', 'A deck can have any number of cards named Relentless Rats.')), true)
  assert.equal(allowsMultiples(rec('Sol Ring', 'Artifact', '{T}: Add {C}{C}.')), false)
  assert.equal(isInstantSpeed(rec('Counterspell', 'Instant', '')), true)
  assert.equal(isInstantSpeed(rec('Fauna Shaman', 'Creature — Elf', '', { keywords: ['Flash'] })), true)
  assert.deepEqual(mergeOverrides('X', ['ramp'], { X: ['wincon'] }), ['wincon'])
  assert.deepEqual(mergeOverrides('X', ['ramp'], {}), ['ramp'])
})

test('quotas: quantity-gewichtete Zählung + Template-Status', () => {
  const counts = countRoles([
    { roles: ['land'], quantity: 30 },
    { roles: ['land'], quantity: 8 },
    { roles: ['ramp', 'draw'], quantity: 1 },
  ])
  assert.equal(counts.get('land'), 38)
  assert.equal(counts.get('ramp'), 1)
  const cmp = compareToTemplate(counts)
  assert.equal(cmp.find(r => r.role === 'land').status, 'ok')
  assert.equal(cmp.find(r => r.role === 'ramp').status, 'unter')
})

test('hypergeom: handgerechnete Referenzwerte', () => {
  // P(>=1 von 10 Treffern bei 10 Zügen aus 99) ≈ 0.6737
  assert.ok(Math.abs(pByTurn(1, 10, 3) - 0.6737) < 0.002)
  // P(>=1 von 1 bei 7 aus 99) = 7/99
  assert.ok(Math.abs(hypergeomAtLeast(1, 1, 7, 99) - 7 / 99) < 1e-9)
  assert.equal(hypergeomAtLeast(0, 10, 7, 99), 1)
  assert.equal(hypergeomAtLeast(3, 2, 7, 99), 0)
})

test('karsten: Formel gegen handgerechneten Wert', () => {
  // ((100-1)/60)*(19.59+1.90*3+0.27*1) - 0.28*(10+10) - 0 - 0 - 0 - 1.35 = 35.224
  const lands = karstenLandCount({ commanders: 1, avgMV: 3.0, rampCount: 10, drawCount: 10 })
  assert.equal(lands, 35.2)
})

test('manabase: avgMV, Pips (inkl. Hybrid), Quellen-Report', () => {
  const cards = [
    { type_line: 'Instant', cmc: 2, mana_cost: '{U}{U}', quantity: 1 },
    { type_line: 'Sorcery', cmc: 4, mana_cost: '{2}{W/U}{B}', quantity: 1 },
    { type_line: 'Land', cmc: 0, mana_cost: '', quantity: 30 },
  ]
  assert.equal(averageManaValue(cards), 3)
  const pips = countPips(cards)
  assert.equal(pips.U, 2.5) // {U}{U} + halber Hybrid
  assert.equal(pips.W, 0.5)
  assert.equal(pips.B, 1)

  const report = colorSourceReport([
    { record: rec('Island', 'Basic Land — Island', '', { produced_mana: ['U'] }), quantity: 20 },
    { record: rec('Doppel-Spell', 'Instant', '', { mana_cost: '{U}{U}', cmc: 2 }), quantity: 1 },
  ])
  const u = report.find(r => r.color === 'U')
  assert.equal(u.sources, 20)
  assert.equal(u.target, 29) // Double-Pip früh → 29 Quellen Richtwert
  assert.equal(u.ok, false)
})

test('budget: Parität mit der ECHTEN Website-Funktion (src/utils.js)', () => {
  const cards = [
    { name: 'A', price_eur: '2.50', quantity: 2 },
    { name: 'B', price_eur: 0.99, quantity: 1 },
    { name: 'C', price_eur: null, quantity: 1 }, // Website: 0 in Summe
  ]
  const { total, missing } = deckValue(cards)
  assert.equal(`${total.toFixed(2)} €`, formatTotalPrice(cards))
  assert.deepEqual(missing, ['C'])
})

test('budget: Gate blockt unbekannte Preise und Überschreitung hart', () => {
  const current = [{ name: 'Alt', price_eur: '480', quantity: 1 }]
  assert.equal(BUDGET_LIMIT_EUR, 500)

  const unknown = budgetGate({ currentCards: current, adds: [{ name: 'Neu', price: null }] })
  assert.equal(unknown.ok, false)
  assert.equal(unknown.reason, 'unknown-price')
  assert.deepEqual(unknown.cards, ['Neu'])

  const over = budgetGate({ currentCards: current, adds: [{ name: 'Neu', price: 30 }] })
  assert.equal(over.ok, false)
  assert.equal(over.reason, 'over-budget')
  assert.equal(over.total, 510)

  const ok = budgetGate({ currentCards: current, cuts: ['Alt'], adds: [{ name: 'Neu', price: 30 }] })
  assert.equal(ok.ok, true)
  assert.equal(ok.total, 30)
})

// ---- validate: Audit-Modus flaggt, Kandidaten-Modus blockt ----
const poolIndex = buildIndex([
  toPoolRecord({ name: 'Sol Ring', type_line: 'Artifact', oracle_text: '{T}: Add {C}{C}.', cmc: 1, color_identity: [], legalities: { commander: 'legal' }, games: ['paper'] }),
  toPoolRecord({ name: 'Black Lotus', type_line: 'Artifact', oracle_text: '', cmc: 0, color_identity: [], legalities: { commander: 'banned' }, games: ['paper'] }),
  toPoolRecord({ name: 'Lightning Bolt', type_line: 'Instant', oracle_text: 'Lightning Bolt deals 3 damage to any target.', cmc: 1, color_identity: ['R'], legalities: { commander: 'legal' }, games: ['paper'] }),
  toPoolRecord({ name: 'Saruman of Many Colors', type_line: 'Legendary Creature — Avatar Wizard', oracle_text: '', cmc: 6, color_identity: ['W', 'U', 'B'], legalities: { commander: 'legal' }, games: ['paper'] }),
])

test('validate/auditDeck: flaggt Banned, CI-Verstoß, Pool-Miss, Count — bricht nie ab', () => {
  const { findings, deckCI, totalCards } = auditDeck({
    cards: [
      { name: 'Sol Ring', quantity: 1 },
      { name: 'Black Lotus', quantity: 1 },
      { name: 'Lightning Bolt', quantity: 1 }, // R ⊄ WUB
      { name: 'Nicht Im Pool', quantity: 1 },
      { name: 'Sol Ring 2. Kopie Fake', quantity: 2 }, // not-in-pool, kein Singleton-Check möglich
    ],
    commanderNames: ['Saruman of Many Colors'],
    index: poolIndex,
  })
  assert.deepEqual(deckCI.sort(), ['B', 'U', 'W'])
  assert.equal(totalCards, 6)
  const kinds = findings.map(f => f.kind)
  assert.ok(kinds.includes('banned'))
  assert.ok(kinds.includes('color-identity'))
  assert.ok(kinds.includes('not-in-pool'))
  assert.ok(kinds.includes('card-count'))
})

test('validate/auditDeck: Preview-Karte (Release in Zukunft) ist info, nicht error', () => {
  const future = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10)
  const idx = buildIndex([
    toPoolRecord({ name: 'Hobbit Preview', type_line: 'Instant', oracle_text: '', cmc: 2, color_identity: [], legalities: { commander: 'not_legal' }, games: ['paper'], released_at: future }),
    toPoolRecord({ name: 'Echt Illegal', type_line: 'Card', oracle_text: '', cmc: 0, color_identity: [], legalities: { commander: 'not_legal' }, games: ['paper'], released_at: '2020-01-01' }),
  ])
  const { findings } = auditDeck({ cards: [{ name: 'Hobbit Preview', quantity: 1 }, { name: 'Echt Illegal', quantity: 1 }], commanderNames: [], index: idx })
  assert.equal(findings.find(f => f.name === 'Hobbit Preview').kind, 'preview-not-yet-legal')
  assert.equal(findings.find(f => f.name === 'Hobbit Preview').level, 'info')
  assert.equal(findings.find(f => f.name === 'Echt Illegal').level, 'error')
})

test('validate/validateCandidate: Pool-Miss, Banned, CI und Duplikat blocken hart', () => {
  const base = { index: poolIndex, deckCI: ['W', 'U', 'B'], existingNames: ['Sol Ring'] }
  assert.equal(validateCandidate({ ...base, name: 'Halluzinierte Karte' }).ok, false)
  assert.equal(validateCandidate({ ...base, name: 'Halluzinierte Karte' }).reason, 'not-in-pool')
  assert.equal(validateCandidate({ ...base, name: 'Black Lotus' }).ok, false)
  assert.equal(validateCandidate({ ...base, name: 'Lightning Bolt' }).ok, false)
  assert.match(validateCandidate({ ...base, name: 'Lightning Bolt' }).reason, /color-identity/)
  assert.equal(validateCandidate({ ...base, name: 'Sol Ring' }).reason, 'duplicate')
  assert.equal(validateCandidate({ ...base, name: 'Saruman of Many Colors' }).ok, true)
})

test('validate: unbekannte Commander-CI schaltet Prüfung NIE still ab (Critic-BLOCKER)', () => {
  // Audit: Commander nicht auflösbar → lauter ci-check-skipped-Finding,
  // KEINE (falschen) color-identity-Findings.
  const { findings, deckCI } = auditDeck({
    cards: [{ name: 'Lightning Bolt', quantity: 1 }],
    commanderNames: ['Vertippter Commander'],
    index: poolIndex,
  })
  assert.equal(deckCI, null)
  assert.ok(findings.some(f => f.kind === 'commander-not-found'))
  assert.ok(findings.some(f => f.kind === 'ci-check-skipped'))
  assert.ok(!findings.some(f => f.kind === 'color-identity'))

  // Gate: deckCI null/undefined → hart geblockt.
  assert.equal(validateCandidate({ index: poolIndex, deckCI: null, name: 'Sol Ring' }).ok, false)
  assert.match(validateCandidate({ index: poolIndex, deckCI: null, name: 'Sol Ring' }).reason, /no-deck-ci/)

  // Farbloser Commander (CI = []) ist dagegen VALIDE: farblose Karte ok,
  // farbige geblockt.
  assert.equal(validateCandidate({ index: poolIndex, deckCI: [], name: 'Sol Ring' }).ok, true)
  assert.equal(validateCandidate({ index: poolIndex, deckCI: [], name: 'Lightning Bolt' }).ok, false)
})

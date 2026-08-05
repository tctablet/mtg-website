// sim.mjs — seeded Monte-Carlo-Goldfish-Engine (pure, testbar).
//
// BEWUSSTE GRENZEN (v1, dokumentiert im Plan + Research Kap. 3): keine Gegner,
// keine Interaktion, kein Stack — Goldfish-Proxy-Metriken nach dem Vorbild des
// ScrollVault-Bracket-Calculators (Median-/Ceiling-Clock, Keep-Rate, Mana-
// Verfügbarkeit). Spielverhalten ist eine grobe Heuristik: Landdrop pro Zug,
// Mana-Rocks werden priorisiert gecastet und produzieren ab dem Folgezug,
// Kreaturen greedy nach Kurve, Mill-Spells sofort.
//
// Multiplayer-Annahme (Regel 103.8a): auch Turn 1 wird gezogen.

// mulberry32 — deterministischer 32-bit-PRNG, gleicher Seed → gleiche Läufe.
export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function shuffled(arr, rand) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const NUM_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, x: 3, half: 0,
}

// Wie viel Mana produziert eine Nonland-Quelle pro Aktivierung? Zählt die
// {X}-Symbole hinter "add" (Sol Ring "{T}: Add {C}{C}." → 2, Dork "Add {G}" → 1)
// bzw. Zahlwörter ("add two mana" → 2). 0 = keine erkennbare Produktion.
export function manaProductionAmount(oracleText) {
  const text = (oracleText || '').toLowerCase()
  let best = 0
  for (const m of text.matchAll(/add ((?:\{[^}]+\})+)/g)) {
    const symbols = (m[1].match(/\{[^}]+\}/g) || []).length
    best = Math.max(best, symbols)
  }
  const words = text.match(/add (one|two|three|four|five|six) mana/)
  if (words) best = Math.max(best, NUM_WORDS[words[1]] ?? 0)
  return best
}

// Land-Ramp-Spell (Cultivate-Klasse): legt beim Cast ein Land zusätzlich.
// Muster bewusst identisch zu RE.landRamp/putLandFromHand in roles.mjs.
export function isLandRampText(oracleText) {
  const text = (oracleText || '').toLowerCase()
  return /search (?:your|their) library for .{0,40}land .{0,80}battlefield/.test(text) ||
    /put (?:a|up to \w+) land cards? from your hand onto the battlefield/.test(text)
}

// Wie viele Karten millt EIN Cast/Trigger dieser Karte (gegen EINEN Gegner)?
// "each opponent mills eight" zählt im Goldfish (1 Ziel-Gegner) als 8.
export function millAmount(oracleText) {
  const text = (oracleText || '').toLowerCase()
  let total = 0
  for (const m of text.matchAll(/mills? (?:the top )?(\w+)(?: cards?)?/g)) {
    total += NUM_WORDS[m[1]] ?? (parseInt(m[1], 10) || 0)
  }
  const puts = text.match(/puts? the top (\w+) cards? of (?:their|his or her|target player's|each player's) library into/)
  if (puts) total += NUM_WORDS[puts[1]] ?? (parseInt(puts[1], 10) || 0)
  return total
}

// Sim-Karte aus enriched-Eintrag (analyze.mjs) bauen.
// Mana-Modell (Critic-Fix M3-M5): Nonland-Ramp zählt nach ECHTEM Ertrag —
// Artefakt-Rocks UND Kreatur-Dorks produzieren `manaProduction` ab dem
// Folgezug (Sol Ring 2, Dork 1); Land-Ramp-Spells (Cultivate-Klasse) legen
// beim Cast ein zusätzliches Land.
export function toSimCard({ effective, roles, quantity }) {
  const type = (effective.type_line || '').toLowerCase()
  const isLand = roles.includes('land')
  const text = effective.oracle_text || ''
  const lower = text.toLowerCase()
  // WIEDERHOLBARE Quelle = aktivierte Fähigkeit mit "add" hinter dem
  // Doppelpunkt ({T}: Add …, {1}: Add …). Einmalige ETB-Treasures (Critic-
  // Finding Runde 2) sind KEINE Rocks — sie geben oneShotMana genau einmal.
  const repeatable = /\{[^}]+\}(?:, [^:]+)?: add /.test(lower)
  const isPermanent = /artifact|creature|enchantment/.test(type)
  const oneShotTreasure = !repeatable && /create .{0,40}treasure token/.test(lower)
  return {
    name: effective.name,
    quantity,
    isLand,
    entersTapped: isLand && /enters (?:the battlefield )?tapped/i.test(text) &&
      !/unless|if you|you may pay/i.test(text),
    cmc: effective.cmc ?? 0,
    manaProduction: !isLand && roles.includes('ramp') && isPermanent && repeatable
      ? Math.max(1, manaProductionAmount(text))
      : 0,
    oneShotMana: !isLand && oneShotTreasure ? 1 : 0,
    isLandRamp: !isLand && roles.includes('ramp') && isLandRampText(text),
    isCreature: /creature/.test(type),
    power: parseInt(effective.power, 10) || 0,
    mill: millAmount(text),
    roles,
  }
}

// Ein Spiel goldfischen. Liefert Kennzahlen pro Lauf.
export function playGame(deck, rand, { turns = 10 } = {}) {
  let library = shuffled(deck, rand)
  let hand = library.splice(0, 7)

  // Free Mulligan (Commander): einmal kostenlos neu, wenn Länder außerhalb 2..5.
  // kept7 misst die Hand NACH dem Free Mulligan — erst eine zweite schlechte
  // Hand kostet real (Mull auf 6) und zählt als "nicht keepbar". So misst die
  // Keep-Rate Manabase-Gesundheit statt purer Erstziehungs-Varianz.
  const landsIn = h => h.filter(c => c.isLand).length
  const keepable = h => landsIn(h) >= 2 && landsIn(h) <= 5
  let kept7 = true
  if (!keepable(hand)) {
    library = shuffled(deck, rand)
    hand = library.splice(0, 7)
    kept7 = keepable(hand)
  }

  let landsPlay = 0
  let rocksMana = 0 // Mana aus bereits liegenden Rocks (produziert ab Folgezug)
  let oneShotPool = 0 // Treasures o.ä.: einmal nutzbar (im Folgezug), dann weg
  let tappedLandThisTurn = false
  let combatPower = 0
  let damageDealt = 0
  let milled = 0
  let combatClock = null
  let millClock = null
  const manaByTurn = []
  const landsByTurn = []
  const roleFirstCast = {}

  for (let t = 1; t <= turns; t++) {
    if (library.length > 0) hand.push(library.shift())

    // Landdrop: untapped bevorzugt.
    const landIdx = hand.findIndex(c => c.isLand && !c.entersTapped)
    const anyLandIdx = landIdx >= 0 ? landIdx : hand.findIndex(c => c.isLand)
    tappedLandThisTurn = false
    if (anyLandIdx >= 0) {
      tappedLandThisTurn = hand[anyLandIdx].entersTapped
      hand.splice(anyLandIdx, 1)
      landsPlay++
    }

    let mana = (landsPlay - (tappedLandThisTurn ? 1 : 0)) + rocksMana + oneShotPool
    manaByTurn.push(landsPlay + rocksMana + oneShotPool)
    landsByTurn.push(landsPlay)
    oneShotPool = 0 // Treasures sind nach der Nutzung verbraucht

    // Casten, grob priorisiert: Mana-Quellen → Mill → Kreaturen → Rest.
    const castable = () => hand
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => !c.isLand && c.cmc <= mana)
      .sort((a, b) =>
        ((b.c.manaProduction > 0 || b.c.isLandRamp) - (a.c.manaProduction > 0 || a.c.isLandRamp)) ||
        ((b.c.mill > 0) - (a.c.mill > 0)) ||
        (b.c.isCreature - a.c.isCreature) ||
        (b.c.cmc - a.c.cmc))
    let powerCastThisTurn = 0
    let pick
    while ((pick = castable()[0])) {
      const { c, i } = pick
      hand.splice(i, 1)
      mana -= c.cmc
      for (const role of c.roles) {
        if (roleFirstCast[role] === undefined) roleFirstCast[role] = t
      }
      // Rocks/Dorks produzieren ab dem FOLGEZUG (rocksMana fließt erst in die
      // Mana-Berechnung des nächsten Zugs ein); Land-Ramp legt sofort ein Land;
      // One-Shot-Treasures geben im Folgezug einmalig Mana.
      if (c.manaProduction > 0) rocksMana += c.manaProduction
      if (c.oneShotMana > 0) oneShotPool += c.oneShotMana
      if (c.isLandRamp) landsPlay++
      if (c.mill > 0) milled += c.mill
      if (c.isCreature) { combatPower += c.power; powerCastThisTurn += c.power }
    }

    // Combat gegen EINEN Gegner (40 Leben): Kreaturen greifen ab dem Folgezug
    // an (Summoning Sickness) — diese Runde gecastete Power zählt noch nicht.
    damageDealt += Math.max(0, combatPower - powerCastThisTurn)
    if (combatClock === null && damageDealt >= 40) combatClock = t
    if (millClock === null && milled >= 99) millClock = t
  }

  return { kept7, manaByTurn, landsByTurn, roleFirstCast, combatClock, millClock }
}

function median(values) {
  const v = values.filter(x => x !== null && x !== undefined).sort((a, b) => a - b)
  if (v.length === 0) return null
  return v[Math.floor(v.length / 2)]
}

function percentile(values, p) {
  const v = values.filter(x => x !== null && x !== undefined).sort((a, b) => a - b)
  if (v.length === 0) return null
  return v[Math.min(v.length - 1, Math.floor(v.length * p))]
}

/**
 * Läuft `iterations` Spiele. deckCards = toSimCard-Ergebnisse, quantity wird
 * expandiert. Liefert aggregierte Kennzahlen inkl. Median/Ceiling-Clocks.
 */
export function simulate(deckCards, { iterations = 1000, seed = 42, turns = 10 } = {}) {
  const deck = deckCards.flatMap(c => Array(c.quantity || 1).fill(c))
  const rand = mulberry32(seed)

  const games = []
  for (let i = 0; i < iterations; i++) games.push(playGame(deck, rand, { turns }))

  const keepRate = games.filter(g => g.kept7).length / games.length
  const avgAt = (arr, t) => arr.reduce((s, g) => s + (g[t - 1] ?? 0), 0) / arr.length
  const landsAvg = [1, 2, 3, 4, 5, 6].map(t => avgAt(games.map(g => g.landsByTurn), t))
  const manaAvg = [1, 2, 3, 4, 5, 6].map(t => avgAt(games.map(g => g.manaByTurn), t))

  const roles = {}
  for (const g of games) {
    for (const [role, t] of Object.entries(g.roleFirstCast)) {
      ;(roles[role] ??= []).push(t)
    }
  }
  const roleMedians = Object.fromEntries(
    Object.entries(roles).map(([r, ts]) => [r, { median: median(ts), inGames: ts.length / games.length }])
  )

  const combatClocks = games.map(g => g.combatClock)
  const millClocks = games.map(g => g.millClock)
  return {
    iterations, seed, turns, keepRate, landsAvg, manaAvg, roleMedians,
    clocks: {
      combat: { median: median(combatClocks), ceiling: percentile(combatClocks, 0.05), hitRate: combatClocks.filter(Boolean).length / games.length },
      mill: { median: median(millClocks), ceiling: percentile(millClocks, 0.05), hitRate: millClocks.filter(Boolean).length / games.length },
    },
  }
}

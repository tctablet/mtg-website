// manabase.mjs — Karsten-Landcount-Formel + Colored-Source-Check (pure).
//
// Landcount-Formel für 100-Karten-Singleton (Quelle: canadianhighlander.ca,
// "How to build a manabase for singleton formats", vollständig dokumentiert in
// DECK-OPTIMIZER-RESEARCH.md Kap. 1):
//   ((100 - C) / 60) * (19.59 + 1.90*avgMV + 0.27*C)
//     - 0.28*(ramp + draw) - fastMana - 0.74*mdfcTapped - 0.38*mdfcUntapped - 1.35
//
// Colored Sources: Karstens 60-Karten-Richtwerte × ~1,6 fürs 100er-Deck —
// Single Pip ~22 Quellen, Double Pip ~29, Triple Pip ~34 (Approximation).

export function karstenLandCount({
  commanders = 1,
  avgMV,
  rampCount = 0,
  drawCount = 0,
  fastMana = 0,
  mdfcTapped = 0,
  mdfcUntapped = 0,
}) {
  const c = commanders
  const raw =
    ((100 - c) / 60) * (19.59 + 1.90 * avgMV + 0.27 * c) -
    0.28 * (rampCount + drawCount) -
    fastMana -
    0.74 * mdfcTapped -
    0.38 * mdfcUntapped -
    1.35
  return Math.round(raw * 10) / 10
}

// Fast Mana (Ramp mit MV<=1) ist in der Karsten-Formel ein EIGENER Abzug und
// muss deshalb aus dem 0.28er-Ramp-Term herausgerechnet werden — sonst würde
// z.B. Sol Ring doppelt subtrahiert (Critic-Finding M1/M2, Regressionstest
// in tests/optimizer-analyzer.test.mjs).
export function splitFastMana(rampCount, fastMana) {
  return { rampForFormula: Math.max(0, rampCount - fastMana), fastMana }
}

// Durchschnittliches Mana Value der Nonland-Karten (quantity-gewichtet).
export function averageManaValue(cards) {
  let sum = 0
  let n = 0
  for (const c of cards) {
    if ((c.type_line || '').includes('Land')) continue
    const q = c.quantity ?? 1
    sum += (c.cmc ?? 0) * q
    n += q
  }
  return n === 0 ? 0 : Math.round((sum / n) * 100) / 100
}

// Pips pro Farbe über alle Nonland-Manakosten ({2}{W}{W} -> W:2).
export function countPips(cards) {
  const pips = { W: 0, U: 0, B: 0, R: 0, G: 0 }
  for (const c of cards) {
    if ((c.type_line || '').includes('Land')) continue
    const q = c.quantity ?? 1
    const cost = c.mana_cost || ''
    for (const sym of cost.matchAll(/\{([^}]+)\}/g)) {
      const s = sym[1]
      // Hybrid ({W/U}) zählt für beide zur Hälfte; Phyrexian ({W/P}) voll.
      const letters = s.split('/').filter(x => pips[x] !== undefined)
      if (letters.length === 1) pips[letters[0]] += q
      else if (letters.length > 1) letters.forEach(l => { pips[l] += q / letters.length })
    }
  }
  for (const k of Object.keys(pips)) pips[k] = Math.round(pips[k] * 10) / 10
  return pips
}

// Höchste Pip-Anforderung pro Farbe unter den früh relevanten Spells (MV <= 4):
// bestimmt, welcher Karsten-Richtwert gilt (1 Pip -> 22, 2 -> 29, 3+ -> 34).
export function maxEarlyPipsPerColor(cards, maxMV = 4) {
  const req = { W: 0, U: 0, B: 0, R: 0, G: 0 }
  for (const c of cards) {
    if ((c.type_line || '').includes('Land')) continue
    if ((c.cmc ?? 0) > maxMV) continue
    const perColor = { W: 0, U: 0, B: 0, R: 0, G: 0 }
    for (const sym of (c.mana_cost || '').matchAll(/\{([^}]+)\}/g)) {
      const letters = sym[1].split('/').filter(x => perColor[x] !== undefined)
      if (letters.length === 1) perColor[letters[0]]++
    }
    for (const k of Object.keys(req)) req[k] = Math.max(req[k], perColor[k])
  }
  return req
}

export const SOURCE_TARGETS = { 1: 22, 2: 29, 3: 34 }

// Fetch-/Suchländer zählen als Quellen der Farben, die sie holen können —
// Karsten zählt Fetches mit; ihr produced_mana ist leer (User-Fund 06.08.:
// Fetch-Manabases wirkten pauschal "zu wenig").
const BASIC_COLOR = { plains: 'W', island: 'U', swamp: 'B', mountain: 'R', forest: 'G' }
export function fetchedColors(record) {
  const text = (record?.oracle_text || '').toLowerCase()
  // Echte Fetches nennen Basic-TYPEN ("island or swamp card"), nicht das Wort
  // "land" — beide Formen abdecken, aber nur im Such-Satzsegment suchen.
  const seg = text.match(/search your library for [^.\n]{0,120}/)?.[0]
  if (!seg) return []
  const named = [...new Set(
    Object.keys(BASIC_COLOR).filter(t => seg.includes(t)).map(t => BASIC_COLOR[t])
  )]
  if (named.length) return named
  // Generische "basic land"-Fetches (Evolving-Wilds-Klasse) holen jede Farbe
  return /\bland\b/.test(seg) ? ['W', 'U', 'B', 'R', 'G'] : []
}

// Zählt Quellen pro Farbe: Länder + Nonland-Permanents mit produced_mana,
// plus Fetch-Länder für ihre holbaren Farben.
export function countColorSources(cardsWithPool) {
  const sources = { W: 0, U: 0, B: 0, R: 0, G: 0 }
  for (const { record, quantity = 1 } of cardsWithPool) {
    if (!record) continue
    const produced = record.produced_mana || []
    const isLand = (record.type_line || '').includes('Land')
    const isPermanentSource =
      isLand ||
      /artifact|creature|enchantment/i.test(record.type_line || '')
    if (!isPermanentSource) continue
    const colors = new Set(produced.filter(c => sources[c] !== undefined))
    if (isLand) for (const c of fetchedColors(record)) colors.add(c)
    for (const col of colors) sources[col] += quantity
  }
  return sources
}

export function colorSourceReport(cardsWithPool) {
  const cards = cardsWithPool.map(({ record, quantity }) => ({
    name: record?.name ?? '',
    type_line: record?.type_line ?? '',
    mana_cost: record?.mana_cost ?? '',
    cmc: record?.cmc ?? 0,
    quantity,
  }))
  const pips = countPips(cards)
  const early = maxEarlyPipsPerColor(cards)
  const sources = countColorSources(cardsWithPool)
  // Treiber-Karte pro Farbe: WER fordert die maxEarlyPips? (User-Fund 06.08.:
  // "Ziel 34" ohne Begründung ist unverständlich — eine einzelne UUU-Karte
  // setzt den Karsten-Richtwert der ganzen Farbe.)
  const driverFor = (col) => {
    if (!early[col]) return null
    const hit = cards.find(c => early[col] === maxEarlyPipsPerColor([c])[col])
    return hit?.name || null
  }
  return ['W', 'U', 'B', 'R', 'G']
    .filter(col => pips[col] > 0)
    .map(col => {
      const need = SOURCE_TARGETS[Math.min(3, Math.max(1, early[col]))] ?? 22
      return {
        color: col,
        pips: pips[col],
        maxEarlyPips: early[col],
        sources: sources[col],
        target: early[col] > 0 ? need : null,
        ok: early[col] === 0 || sources[col] >= need,
        driver: driverFor(col),
      }
    })
}

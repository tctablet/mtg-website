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

// Zählt Quellen pro Farbe: Länder + Nonland-Permanents mit produced_mana.
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
    for (const col of produced) {
      if (sources[col] !== undefined) sources[col] += quantity
    }
  }
  return sources
}

export function colorSourceReport(cardsWithPool) {
  const cards = cardsWithPool.map(({ record, quantity }) => ({
    type_line: record?.type_line ?? '',
    mana_cost: record?.mana_cost ?? '',
    cmc: record?.cmc ?? 0,
    quantity,
  }))
  const pips = countPips(cards)
  const early = maxEarlyPipsPerColor(cards)
  const sources = countColorSources(cardsWithPool)
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
      }
    })
}

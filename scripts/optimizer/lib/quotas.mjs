// quotas.mjs — Template-Vergleich + Hypergeometrik (pure, testbar).
//
// Referenz-Template: Command Zone Ep. 658 ("New Era", Feb 2025) — Quellen in
// DECK-OPTIMIZER-RESEARCH.md Kap. 1. Kategorien dürfen überlappen (eine Karte
// kann Ramp UND Draw sein), deshalb wird pro Rolle gezählt, nicht partitioniert.

export const TEMPLATE = [
  { role: 'land', label: 'Länder', min: 36, max: 38 },
  { role: 'ramp', label: 'Ramp', min: 10, max: 12 },
  { role: 'draw', label: 'Card Draw', min: 10, max: 12 },
  { role: 'removal', label: 'Spot-Removal', min: 10, max: 12 },
  { role: 'wipe', label: 'Board Wipes', min: 3, max: 4 },
]

// Zählt Rollen quantity-gewichtet (Basics/any-number-Karten liegen mehrfach).
export function countRoles(cardsWithRoles) {
  const counts = new Map()
  for (const { roles, quantity = 1 } of cardsWithRoles) {
    for (const role of roles) {
      counts.set(role, (counts.get(role) || 0) + quantity)
    }
  }
  return counts
}

export function compareToTemplate(counts) {
  return TEMPLATE.map(({ role, label, min, max }) => {
    const have = counts.get(role) || 0
    const status = have < min ? 'unter' : have > max ? 'über' : 'ok'
    return { role, label, have, min, max, status }
  })
}

// --- Hypergeometrik ---
// P(X >= k) beim Ziehen von n Karten aus N mit K "Treffern" (ohne Zurücklegen).
// Für Report-Aussagen wie "P(mind. 1 Ramp bis Turn 3)": n = 7 + T Züge.
// Annahme MULTIPLAYER (>=3 Spieler, Regel 103.8a): auch der Startspieler zieht
// in Turn 1 — das ist der Pod der Runde. Für 1v1 wäre n um 1 kleiner; Free
// Mulligan ignoriert (konservativ).

function lnFactorial(n) {
  let s = 0
  for (let i = 2; i <= n; i++) s += Math.log(i)
  return s
}

function lnChoose(n, k) {
  if (k < 0 || k > n) return -Infinity
  return lnFactorial(n) - lnFactorial(k) - lnFactorial(n - k)
}

export function hypergeomAtLeast(k, K, n, N) {
  if (k <= 0) return 1
  let p = 0
  const maxX = Math.min(K, n)
  for (let x = k; x <= maxX; x++) {
    const ln = lnChoose(K, x) + lnChoose(N - K, n - x) - lnChoose(N, n)
    if (ln > -Infinity) p += Math.exp(ln)
  }
  return Math.min(1, p)
}

// P(mindestens k Karten der Kategorie bis einschließlich Turn t auf der Hand,
// on the play, mit Commander-Turn-1-Draw): 7 Start + t gezogene Karten.
export function pByTurn(k, categoryCount, turn, deckSize = 99) {
  return hypergeomAtLeast(k, categoryCount, 7 + turn, deckSize)
}

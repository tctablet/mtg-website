// preflight.mjs — die POOL-FREIEN Preflight-Regeln für Deck-Swaps (pure).
//
// Aus apply.mjs preflight() extrahiert (M6, Critic-Fix gegen Regel-Duplizierung):
// apply.mjs (CLI) und der Browser-Wizard prüfen dieselben Regeln über dieselbe
// Funktion — eine Wahrheit, ein Test. Pool-basierte Validierung
// (validateCandidate: Legalität/CI/Pool-Miss) bleibt bewusst getrennt:
// CLI nutzt den Oracle-Pool, der Browser prüft Legalität live via Scryfall.
//
// cards: Deck-Rows ({ name, ... }); commanders: [deck.commander, deck.commander2];
// cuts/adds: Kartennamen. Rückgabe: Fehlerliste (leer = ok).
//
// checkAddsInDeck: false im CLI — dort meldet validateCandidate (Pool-Pfad)
// das Duplikat bereits; doppelte Meldungen zum selben Root-Cause waren ein
// früherer Critic-Fund. Der Browser (ohne validateCandidate) lässt es an.

export function preflightSwapRules({ cards, commanders = [], cuts = [], adds = [], checkAddsInDeck = true }) {
  const errors = []
  const commanderSet = new Set(commanders.filter(Boolean).map(c => c.toLowerCase()))

  // 100-Karten-Invariante (Critic R2 [BLOCKER]): der Swap ist 1:1 — ein
  // unausgeglichenes cuts/adds-Paar oder ein Cut auf gestapelte/mehrfache
  // Rows würde das Deck still schrumpfen, und apply.mjs meldete trotzdem
  // Erfolg. Mengen pflegt die Website, nie der Swap-Pfad.
  if (cuts.length !== adds.length) {
    errors.push(`Unausgeglichen: ${cuts.length} Cuts vs. ${adds.length} Adds — das Deck bliebe nicht bei 100 Karten.`)
  }

  for (const cut of cuts) {
    if (commanderSet.has(cut.toLowerCase())) {
      errors.push(`Cut "${cut}": Commander wird nicht über apply getauscht (decks-Metadaten via Website ändern).`)
      continue
    }
    const rows = cards.filter(c => c.name.toLowerCase() === cut.toLowerCase())
    if (rows.length === 0) {
      errors.push(`Cut "${cut}": nicht im Deck.`)
    } else if (rows.length > 1 || rows.some(r => (r.quantity || 1) > 1)) {
      const copies = rows.reduce((s, r) => s + (r.quantity || 1), 0)
      errors.push(`Cut "${cut}": liegt ${copies}× im Deck — der 1:1-Swap tauscht nur Einzel-Kopien (Mengen über die Website pflegen).`)
    }
  }

  // Batch-interne Duplikate hart blocken: doppelte adds, adds∩cuts.
  const seenAdds = new Set()
  for (const add of adds) {
    const key = add.toLowerCase()
    if (seenAdds.has(key)) errors.push(`Add "${add}": doppelt in der adds-Liste (v1: eine Kopie pro Add).`)
    seenAdds.add(key)
    if (cuts.some(c => c.toLowerCase() === key)) errors.push(`"${add}" steht in adds UND cuts.`)
  }

  // Add darf nicht schon im Deck liegen (außer es wird gerade gecuttet)
  if (checkAddsInDeck) {
    const cutSet = new Set(cuts.map(c => c.toLowerCase()))
    for (const add of seenAdds) {
      const inDeck = cards.some(c => c.name.toLowerCase() === add)
      if (inDeck && !cutSet.has(add)) {
        const original = adds.find(a => a.toLowerCase() === add)
        errors.push(`Add "${original}": ist bereits im Deck.`)
      }
    }
  }

  return errors
}

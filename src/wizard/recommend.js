// wizard/recommend.js — deterministische Empfehlungen pro Quoten-Lücke (pure).
//
// KEIN LLM: Kandidaten kommen aus dem Pool-Asset (Rolle × CI × Rank) und den
// EDHREC-Konsensdaten; jede Empfehlung trägt ihre Quelle ehrlich als Label
// ([KONSENS] Inclusion%/Synergy bzw. Popularität) — keine unbelegten
// Synergie-Behauptungen (Plan/User-Vorgabe: Deck-Strukturen + Archetyp-Regeln).

// Union-Merge (pure, getestet): Pool-Top-N ∪ EDHREC-Empfehlungen. EDHREC-Namen
// werden über den Slim-Pool aufgelöst, damit sie dieselben harten Filter
// (Rolle, CI, Legalität via Asset-Vorfilter) durchlaufen — commander-
// spezifische Konsens-Karten mit mittlerem Global-Rank dürfen nicht
// untergehen (Critic R1 [HIGH]).
export function unionCandidates({ base, edhrecRecs = [], poolByName, role, deckCI, deckNames, cap = 18 }) {
  const out = [...base]
  const have = new Set(out.map(c => c.n.toLowerCase()))
  const ciSet = new Set(deckCI || [])
  for (const rec of edhrecRecs) {
    if (out.length >= cap) break
    const key = rec.name.toLowerCase()
    if (have.has(key) || deckNames.has(key)) continue
    const card = poolByName.get(key)
    if (!card || !card.r.includes(role)) continue
    if (![...card.ci].every(c => ciSet.has(c))) continue
    out.push(card)
    have.add(key)
  }
  return out
}

// Budget-Headroom: Empfehlungen über dem Rest-Budget werden markiert, nicht
// versteckt — der Swap-Fall gewinnt ja den Cut-Preis zurück; hart blockt erst
// das budgetGate im Review/Apply.
export function buildGapRecommendations({ gaps, poolCandidatesByRole, edhrecRecs = [], priceMap = new Map(), headroom = null }) {
  const edhrecByName = new Map()
  for (const rec of edhrecRecs) {
    const existing = edhrecByName.get(rec.name.toLowerCase())
    if (!existing || (rec.inclusionPct ?? -1) > (existing.inclusionPct ?? -1)) {
      edhrecByName.set(rec.name.toLowerCase(), rec)
    }
  }

  return gaps.map(gap => {
    const poolCands = poolCandidatesByRole.get(gap.role) || []
    const candidates = poolCands.map(card => {
      const price = priceMap.get(card.n) ?? null
      const ed = edhrecByName.get(card.n.toLowerCase())
      return {
        name: card.n,
        cmc: card.c,
        ci: card.ci,
        typeCategory: card.t,
        price: price?.price ?? null,
        isFoil: !!price?.isFoil,
        gameChanger: !!card.gc,
        inclusionPct: ed?.inclusionPct ?? null,
        synergy: ed?.synergy ?? null,
        edhrecRank: card.e,
        overHeadroom: headroom != null && price?.price != null && price.price > headroom,
        label: ed
          ? `[KONSENS] EDHREC ${ed.inclusionPct != null ? `${ed.inclusionPct}%` : '—'}${ed.synergy != null ? ` · Synergy ${ed.synergy > 0 ? '+' : ''}${ed.synergy}` : ''}`
          : `Popularität${card.e != null ? ` (EDHREC-Rank #${card.e})` : ''}`,
      }
    })
    // Konsens zuerst (Inclusion% absteigend), dann Rank aufsteigend
    candidates.sort((a, b) => {
      const ai = a.inclusionPct ?? -1
      const bi = b.inclusionPct ?? -1
      if (ai !== bi) return bi - ai
      return (a.edhrecRank ?? Infinity) - (b.edhrecRank ?? Infinity)
    })
    return { ...gap, candidates }
  })
}

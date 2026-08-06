// wizard/cuts.js — deterministische Cut-Kandidaten mit Begründung (pure).
//
// Heuristiken (in dieser Rang-Reihenfolge, Commander NIE):
//   1. illegal/banned (Audit-Finding)            → harter Kandidat
//   2. Rollen-Überschuss (Quoten-Status "über")  → teuerste zuerst
//   3. teuer bei geringer Popularität            → Preis/Rank-Quotient
//   4. ohne erkannte Rolle UND wenig gespielt    → Synergie manuell prüfen
//
// Rang 4 ist bewusst eng (User-Befund 06.08.: die Liste bestand fast nur aus
// "ohne erkannte Rolle"-Staples wie Consecrated Sphinx/Mithril Coat): eine
// unklassifizierte Karte ist erst dann ein Cut-Hinweis, wenn sie AUCH kaum
// gespielt wird (EDHREC-Rank > UNPOPULAR_RANK oder unbekannt). Beliebte
// Karten ohne Standard-Rolle sind bewusste Synergie-Picks, keine Cuts.

export function buildCutCandidates({ analysis, enriched, limit = 12 }) {
  const commanders = new Set(analysis.deck.commanders.map(c => c.toLowerCase()))
  const out = []
  const seen = new Set()

  const push = (name, price, reason, rank) => {
    const key = name.toLowerCase()
    if (commanders.has(key) || seen.has(key)) return
    if (!isSingleCopy(name)) return
    seen.add(key)
    out.push({ name, price, reason, rank })
  }

  const byName = new Map(enriched.map(e => [e.row.name.toLowerCase(), e]))
  const priceOf = (name) => {
    const e = byName.get(name.toLowerCase())
    const p = parseFloat(e?.row.price_eur)
    return isNaN(p) ? null : p * (e?.quantity || 1)
  }
  // quantity>1-Rows (gestapelte Basics) NIE als Cut vorschlagen: der Swap ist
  // 1:1 (eine Row raus, EINE Karte rein) — das Deck würde sonst still unter
  // 100 Karten rutschen (Critic [BLOCKER]). Mengen pflegt der Edit-Tab.
  const isSingleCopy = (name) => (byName.get(name.toLowerCase())?.quantity || 1) === 1

  // 1. Audit: illegal/banned
  for (const f of analysis.audit.findings || []) {
    if (f.name && /legal|banned/i.test(f.kind || '')) {
      push(f.name, priceOf(f.name), `Audit: ${f.kind}${f.detail ? ` (${f.detail})` : ''}`, 1)
    }
  }

  // 2. Rollen-Überschuss
  for (const q of analysis.quotas) {
    if (q.status !== 'über') continue
    const members = Object.entries(analysis.roles)
      .filter(([, roles]) => roles.includes(q.role))
      .map(([name]) => name)
      .sort((a, b) => (priceOf(b) ?? 0) - (priceOf(a) ?? 0))
    for (const name of members.slice(0, q.have - q.max)) {
      push(name, priceOf(name), `${q.label}: ${q.have}/${q.max} — Überschuss`, 2)
    }
  }

  // 3. teuer bei geringer Popularität (Preis > 5 €, Rank > 20000)
  for (const e of enriched) {
    const price = priceOf(e.row.name)
    const rank = e.record?.edhrec_rank
    if (price != null && price > 5 && rank != null && rank > 20000) {
      push(e.row.name, price, `${price.toFixed(2)} € bei geringer Popularität (Rank #${rank})`, 3)
    }
  }

  // 4. ohne erkannte Rolle UND wenig gespielt (schwacher Hinweis, hart gedeckelt).
  // Bewusst STRENGER als die Rang-3-Schwelle (20000): Rang 3 hat mit dem
  // Preis (>5 €) ein zweites Signal, Rang 4 nur die Unpopularität — dafür
  // muss die Evidenz härter sein (Self-Review-Fund: Differenz begründen).
  const UNPOPULAR_RANK = 15000
  const unpopularUnclassified = (analysis.unclassified || [])
    .map(name => ({ name, rank: byName.get(name.toLowerCase())?.record?.edhrec_rank ?? null }))
    .filter(({ rank }) => rank == null || rank > UNPOPULAR_RANK)
    // Unbeliebteste zuerst; ohne Rank-Daten ganz nach hinten (schwächste Evidenz)
    .sort((a, b) => (b.rank ?? -1) - (a.rank ?? -1))
  for (const { name, rank } of unpopularUnclassified.slice(0, 3)) {
    push(name, priceOf(name), rank != null
      ? `keine Standard-Rolle & wenig gespielt (EDHREC #${rank.toLocaleString('de-DE')}) — Synergie prüfen`
      : 'keine Standard-Rolle & keine EDHREC-Daten — Synergie prüfen', 4)
  }

  out.sort((a, b) => a.rank - b.rank || (b.price ?? 0) - (a.price ?? 0))
  return out.slice(0, limit)
}

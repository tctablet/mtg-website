// pool-core.mjs — die PURE Hälfte von cardpool.mjs (kein fs, kein Netz).
// Aus cardpool.mjs extrahiert (M5), damit Browser-Code (Wizard) dieselben
// Record-/Index-/Suchfunktionen nutzen kann; cardpool.mjs re-exportiert alles,
// CLIs und bestehende Tests laufen unverändert.

// Kompaktes Karten-Record: nur was Analyzer/Validator/Sim wirklich brauchen.
export function toPoolRecord(card) {
  const faces = Array.isArray(card.card_faces)
    ? card.card_faces.map(f => ({
        name: f.name,
        mana_cost: f.mana_cost ?? '',
        type_line: f.type_line ?? '',
        oracle_text: f.oracle_text ?? '',
        colors: f.colors ?? [],
        power: f.power ?? null,
        toughness: f.toughness ?? null,
      }))
    : null
  return {
    name: card.name,
    mana_cost: card.mana_cost ?? faces?.[0]?.mana_cost ?? '',
    cmc: card.cmc ?? 0,
    type_line: card.type_line ?? faces?.[0]?.type_line ?? '',
    oracle_text: card.oracle_text ?? (faces ? faces.map(f => f.oracle_text).join('\n//\n') : ''),
    colors: card.colors ?? faces?.[0]?.colors ?? [],
    color_identity: card.color_identity ?? [],
    keywords: card.keywords ?? [],
    power: card.power ?? faces?.[0]?.power ?? null,
    toughness: card.toughness ?? faces?.[0]?.toughness ?? null,
    layout: card.layout ?? 'normal',
    legal: card.legalities?.commander ?? 'not_legal',
    released_at: card.released_at ?? null,
    games: card.games ?? [],
    game_changer: card.game_changer === true,
    edhrec_rank: card.edhrec_rank ?? null,
    produced_mana: card.produced_mana ?? [],
    faces,
  }
}

// Index: byName (voller Name, lowercased) + aliases (Front-Face -> voller Name).
// Kollisionsregel: ein exakter voller Name gewinnt immer vor einem Front-Face-
// Alias; ein Alias wird nie über einen bestehenden vollen Namen gelegt.
export function buildIndex(records) {
  const byName = new Map()
  const aliases = new Map()
  for (const r of records) {
    byName.set(r.name.toLowerCase(), r)
  }
  for (const r of records) {
    if (!r.name.includes(' // ')) continue
    const front = r.name.split(' // ')[0].toLowerCase()
    if (byName.has(front)) continue // voller Name hat Vorrang
    if (!aliases.has(front)) aliases.set(front, r.name.toLowerCase())
  }
  return { byName, aliases }
}

export function lookupCard(index, name) {
  const key = String(name || '').trim().toLowerCase()
  if (!key) return null
  const direct = index.byName.get(key)
  if (direct) return direct
  const alias = index.aliases.get(key)
  return alias ? index.byName.get(alias) ?? null : null
}

// Kandidatensuche filtert hart: nur commander-legal + Papier. (Der Audit-Pfad
// nutzt lookupCard direkt und bewertet `legal` selbst.)
export function isCandidate(record) {
  if (record.legal !== 'legal') return false
  if (record.games.length > 0 && !record.games.includes('paper')) return false
  return true
}

// Color-Identity-Check: Karten-CI muss Teilmenge der Deck-CI sein.
export function ciSubset(cardCI, deckCI) {
  const deck = new Set(deckCI)
  return (cardCI || []).every(c => deck.has(c))
}

export function searchCandidates(index, { colorIdentity, textRegex, typeRegex, maxCmc, limit = 50 } = {}) {
  // Bewusst KEIN Early-Break: erst alle Treffer sammeln, dann sortieren —
  // ein Abbruch in Map-Insertion-Reihenfolge würde populäre Karten still
  // verschlucken (Critic-Finding M1/M2). 38k-Iteration kostet <50ms.
  const out = []
  for (const r of index.byName.values()) {
    if (!isCandidate(r)) continue
    if (colorIdentity && !ciSubset(r.color_identity, colorIdentity)) continue
    if (maxCmc != null && r.cmc > maxCmc) continue
    if (typeRegex && !typeRegex.test(r.type_line)) continue
    if (textRegex && !textRegex.test(r.oracle_text)) continue
    out.push(r)
  }
  // EDHREC-Rank als neutrale Vorsortierung (kleiner = populärer/etablierter).
  out.sort((a, b) => (a.edhrec_rank ?? Infinity) - (b.edhrec_rank ?? Infinity))
  return out.slice(0, limit)
}

export function poolAgeHours(meta, now = Date.now()) {
  if (!meta?.fetchedAt) return Infinity
  return (now - Date.parse(meta.fetchedAt)) / 3_600_000
}

export function formatDatenstand(meta, now = Date.now()) {
  const h = poolAgeHours(meta, now)
  if (!isFinite(h)) return 'Datenstand: kein lokaler Kartenpool'
  const label = h < 1 ? '<1 h' : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} Tage`
  const warn = h > 24 ? '  ⚠ älter als 24 h — Banlist-/Set-Änderungen ggf. nicht enthalten (--refresh)' : ''
  return `Datenstand Kartenpool: vor ${label} (${meta.cardCount} Karten, Bulk vom ${meta.bulkUpdatedAt?.slice(0, 10) ?? '?'})${warn}`
}

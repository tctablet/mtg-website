// sets.js — pure Helfer für den /preise-Set-Browser (node-testbar, keine
// DOM-/Fetch-Abhängigkeiten). Der Browser zeigt den VOLLEN Scryfall-Katalog
// (Scryfall-API liefert Sets + Karten samt Collector-Sortierung), unsere
// Preisliste (scryfall_prices) legt nur die Preise darüber.

import { getCardNormalImage } from './scryfall.js'

// Kuratierte Default-Auswahl: „richtige" Produkte. Promos, Token-Beilagen,
// Memorabilia etc. bleiben ohne den „Alle Set-Typen"-Haken draußen —
// die SUCHE findet sie trotzdem (durchsucht immer alle non-digitalen Sets).
export const BROWSER_SET_TYPES = new Set([
  'expansion', 'core', 'masters', 'commander', 'draft_innovation',
  'funny', 'starter', 'duel_deck', 'from_the_vault', 'premium_deck',
  'planechase', 'archenemy', 'box', 'arsenal', 'spellbook',
])

// Volles API-Set → schlankes Objekt (sessionStorage-Cache speichert NUR das:
// ~80 KB statt ~620 KB Rohantwort).
export function slimSet(s) {
  return {
    code: s.code,
    name: s.name,
    setType: s.set_type,
    released: s.released_at || null,
    cardCount: s.card_count || 0,
    digital: !!s.digital,
    icon: s.icon_svg_uri || null,
  }
}

// Sichtbare Sets bestimmen: digital + leere immer raus; ohne Suchbegriff
// entscheidet showAll über die kuratierten Typen; MIT Suchbegriff wird immer
// über alle non-digitalen Sets gesucht (Name + Code, case-insensitiv).
// Sortierung: released desc, ohne Datum zuletzt, Name als Tiebreak.
export function filterSets(sets, { query = '', showAll = false } = {}) {
  const base = (sets || []).filter(s => s && !s.digital && s.cardCount > 0)
  const q = query.trim().toLowerCase()
  const visible = q
    ? base.filter(s =>
        (s.name || '').toLowerCase().includes(q)
        || (s.code || '').toLowerCase().includes(q))
    : (showAll ? base : base.filter(s => BROWSER_SET_TYPES.has(s.setType)))
  return [...visible].sort((a, b) => {
    if (a.released && b.released && a.released !== b.released) {
      return a.released < b.released ? 1 : -1
    }
    if (a.released && !b.released) return -1
    if (!a.released && b.released) return 1
    return (a.name || '').localeCompare(b.name || '')
  })
}

// Gefilterte+sortierte Sets → Jahres-Gruppen für die Kachel-Übersicht mit
// Trennern (User-Ansage). Erwartet released-desc-Sortierung aus filterSets
// und behält sie AUCH innerhalb des Jahres bei — das neuste Set steht damit
// ganz oben auf der Seite (User-Ansage 06.08.2026, ersetzt das frühere
// Jan→Dez). Sets ohne Datum landen gesammelt hinter dem letzten Jahr.
export function groupSetsByYear(sets) {
  const groups = []
  let current = null
  for (const s of sets || []) {
    const year = s.released ? s.released.slice(0, 4) : 'Ohne Datum'
    if (!current || current.year !== year) {
      current = { year, sets: [] }
      groups.push(current)
    }
    current.sets.push(s)
  }
  return groups
}

// Suche einer Set-Seite: game:paper hält Alchemy-/MTGO-Varianten draußen
// (live gesehen: e:neo liefert sonst "A-Ancestral Katana"-Rebalances mit).
export function setSearchUrl(code) {
  const q = encodeURIComponent(`e:${code} game:paper`)
  return `https://api.scryfall.com/cards/search?q=${q}&unique=prints&order=set`
}

// Eine cards/search-Seite → { cards, hasMore, nextPage, totalCards }.
// Defensiv: fehlt data, ist die Struktur gekippt → Error (Caller zeigt Retry).
// digital-Skip als Gürtel+Hosenträger zur game:paper-Query.
export function extractSetCardsPage(json) {
  if (!json || !Array.isArray(json.data)) {
    throw new Error('Scryfall-Antwort hat eine unerwartete Struktur (kein data-Array)')
  }
  const cards = []
  for (const c of json.data) {
    if (!c || typeof c.name !== 'string' || c.digital) continue
    cards.push({
      name: c.name,
      collector: c.collector_number || '',
      image: getCardNormalImage(c),
      scryfallId: c.id || null,
    })
  }
  return {
    cards,
    hasMore: !!json.has_more,
    nextPage: json.next_page || null,
    totalCards: Number.isFinite(json.total_cards) ? json.total_cards : cards.length,
  }
}

// Unsere DB-Preise (Map aus fetchCheapestPrices) über die Set-Karten legen.
// Kein Treffer → ourPrice null (UI zeigt „–"), nie 0 erfinden.
export function mergeOurPrices(cards, lookup) {
  return (cards || []).map(c => {
    const info = lookup?.get?.(c.name)
    return {
      ...c,
      ourPrice: info?.price ?? null,
      isFoil: !!info?.isFoil,
    }
  })
}

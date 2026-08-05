// --- Deck-List Parser ---

export function parseDeckList(text) {
  const lines = text.split('\n')
  const cards = []

  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('//') || line.startsWith('#')) continue
    if (/^(commander|deck|sideboard|companion|maybeboard):?$/i.test(line)) continue

    // deckstats: skip sideboard lines ("SB: 1 Card Name")
    if (/^SB:\s*/i.test(line)) continue
    // deckstats: strip leading set code ("1 [IKO] Card Name" → "1 Card Name")
    const normalized = line.replace(/^(\d+x?\s+)\[[\w-]+\]\s*/, '$1')

    const match = normalized.match(/^(\d+)x?\s+(.+?)(?:\s*[\(\[][\w-]+[\)\]]\s*[\w-]*)?(?:\s*\*F\*)?$/)
    if (match) {
      // Detect inline annotations before stripping (e.g. # !Commander, # !Foil)
      const rawName = match[2].trim().replace(/\s*[\(\[][\w-]+[\)\]]\s*[\w-]*$/, '')
      const isCommander = /!Commander/i.test(rawName)
      // Strip inline # comments (# !Foil, # !Commander, etc.)
      const name = rawName.replace(/\s*#.*$/, '').trim()
      cards.push({ quantity: parseInt(match[1], 10), name, isCommander })
    }
  }

  return cards
}

// --- HTML-Escaping ---

// Externe Strings (Scryfall-/EDHREC-/DB-Namen) landen in innerHTML-Templates —
// eine geteilte Wahrheit statt lokaler Kopien (vorher je eine in resterampe.js
// und deck-view.js).
export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

// --- Typ-Kategorisierung ---

export const TYPE_ORDER = [
  { key: 'creature', match: 'Creature', label: 'Kreaturen' },
  { key: 'planeswalker', match: 'Planeswalker', label: 'Planeswalker' },
  { key: 'instant', match: 'Instant', label: 'Spontanzauber' },
  { key: 'sorcery', match: 'Sorcery', label: 'Hexereien' },
  { key: 'enchantment', match: 'Enchantment', label: 'Verzauberungen' },
  { key: 'artifact', match: 'Artifact', label: 'Artefakte' },
  { key: 'land', match: 'Land', label: 'Länder' },
  { key: 'battle', match: 'Battle', label: 'Schlachten' },
]

export function getTypeCategory(typeLine) {
  if (!typeLine) return 'other'
  for (const t of TYPE_ORDER) {
    if (typeLine.includes(t.match)) return t.key
  }
  return 'other'
}

export function getTypeCategoryLabel(category) {
  const found = TYPE_ORDER.find(t => t.key === category)
  return found ? found.label : 'Sonstige'
}

export function groupCardsByType(cards) {
  const groups = {}
  for (const card of cards) {
    const cat = card.type_category || 'other'
    if (!groups[cat]) groups[cat] = []
    groups[cat].push(card)
  }

  // Sort groups by TYPE_ORDER
  const sorted = []
  for (const t of TYPE_ORDER) {
    if (groups[t.key]) {
      sorted.push({ category: t.key, label: t.label, cards: groups[t.key] })
    }
  }
  if (groups['other']) {
    sorted.push({ category: 'other', label: 'Sonstige', cards: groups['other'] })
  }
  return sorted
}

// --- Mana-Kosten → mana-font-Icons ---
// "{2}{W}{U}" → <i class="ms ms-2">… (mana.min.css ist global geladen).
// Aus card-row.js hierher gehoben: der Read-only-Scan-Listen-Renderer
// braucht dieselbe Darstellung.

export function formatManaCost(manaCost) {
  if (!manaCost) return ''
  // Zero-Width-Space zwischen den Pips: ohne Umbruchgelegenheit zwingt ein
  // 7-Pip-Extremfall die min-content-Breite der Kartentabelle über den
  // Mobil-Viewport (gemessen 418px bei 390px) — mit ZWSP bleiben ≤5 Pips
  // einzeilig und lange Kosten brechen kontrolliert um statt zu overflown.
  return manaCost.replace(/\{([^}]+)\}/g, (_, symbol) => {
    let cls = symbol.toLowerCase().replace(/\//g, '')
    const special = { t: 'tap', q: 'untap' }
    if (special[cls]) cls = special[cls]
    return `<i class="ms ms-${cls} ms-cost ms-shadow"></i>​`
  })
}

// --- Preis-Formatierung ---

export function formatPrice(eur) {
  if (eur == null) return 'N/A'
  return `${parseFloat(eur).toFixed(2)} \u20AC`
}

export function formatTotalPrice(cards) {
  const total = cards.reduce((sum, c) => sum + (parseFloat(c.price_eur) || 0) * (c.quantity || 1), 0)
  return formatPrice(total)
}

export function isPriceStale(priceUpdatedAt) {
  if (!priceUpdatedAt) return true
  const diff = Date.now() - new Date(priceUpdatedAt).getTime()
  return diff > 7 * 24 * 60 * 60 * 1000 // 7 Tage
}

// --- Preisdatenbank-Helfer (pure, node-testbar) ---

// PostgREST-ilike-Wildcards im User-Input entschärfen — "%"/"_" sind sonst
// Suchoperatoren, "\" der Escape-Prefix
export function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, c => `\\${c}`)
}

// Sort-Select-Value ("price-desc") → { sort, ascending } für searchPrices
export function parseSortValue(value) {
  const [sort, dir] = String(value || '').split('-')
  const valid = ['name', 'price', 'updated']
  return {
    sort: valid.includes(sort) ? sort : 'name',
    ascending: dir !== 'desc',
  }
}

// --- Color Identity ---

const BASIC_LAND_COLOR = {
  Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G',
}

export function getDeckColors(cards) {
  const colors = new Set()
  for (const c of cards) {
    const cost = c.mana_cost || ''
    for (const sym of ['W', 'U', 'B', 'R', 'G']) {
      if (new RegExp(`\\{[^}]*${sym}[^}]*\\}`).test(cost)) colors.add(sym)
    }
    const tl = c.type_line || ''
    if (/Basic Land/i.test(tl)) {
      for (const [land, color] of Object.entries(BASIC_LAND_COLOR)) {
        if (tl.includes(land)) colors.add(color)
      }
    }
  }
  return ['W', 'U', 'B', 'R', 'G'].filter(c => colors.has(c))
}

// Fehlerzustand fuer Seiten, deren Daten-Load fehlschlaegt — statt ewigem
// "Lade..." oder einem faelschlichen Leerzustand
export function renderLoadError(container, err, retry) {
  const msg = String(err?.message || err).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))
  container.innerHTML = `
    <div class="page load-error">
      <p>Daten konnten nicht geladen werden.<br /><span class="load-error-detail">${msg}</span></p>
      <button class="btn" id="retry-load">Nochmal versuchen</button>
    </div>
  `
  document.getElementById('retry-load').addEventListener('click', retry)
}

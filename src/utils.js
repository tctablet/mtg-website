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

// --- Typ-Kategorisierung ---

const TYPE_ORDER = [
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

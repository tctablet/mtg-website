const API_BASE = 'https://api.scryfall.com'

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function fetchCardCollection(cardNames) {
  const found = []
  const notFound = []
  const chunks = []

  for (let i = 0; i < cardNames.length; i += 75) {
    chunks.push(cardNames.slice(i, i + 75))
  }

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await delay(100)

    // Scryfall collection API doesn't accept "A // B" DFC names — use front face only
    const identifiers = chunks[i].map(name => ({ name: name.includes(' // ') ? name.split(' // ')[0] : name }))
    const res = await fetch(`${API_BASE}/cards/collection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifiers }),
    })

    if (!res.ok) {
      throw new Error(`Scryfall API Fehler: ${res.status}`)
    }

    const data = await res.json()
    found.push(...(data.data || []))
    notFound.push(...(data.not_found || []).map(nf => nf.name))
  }

  return { found, notFound }
}

export async function autocompleteCard(query) {
  if (!query || query.length < 2) return []
  const res = await fetch(`${API_BASE}/cards/autocomplete?q=${encodeURIComponent(query)}`)
  if (!res.ok) return []
  const data = await res.json()
  return data.data || []
}

export async function fetchCardByName(name) {
  const res = await fetch(`${API_BASE}/cards/named?exact=${encodeURIComponent(name)}`)
  if (!res.ok) return null
  return await res.json()
}

const dfcCache = new Map()

export async function fetchCardBackImage(scryfallId) {
  if (dfcCache.has(scryfallId)) return dfcCache.get(scryfallId)
  const res = await fetch(`${API_BASE}/cards/${scryfallId}`)
  if (!res.ok) return null
  const card = await res.json()
  const backImage = card.card_faces?.[1]?.image_uris?.normal || null
  dfcCache.set(scryfallId, backImage)
  return backImage
}

export function getCardArtCrop(card) {
  return card?.image_uris?.art_crop
    || card?.card_faces?.[0]?.image_uris?.art_crop
    || null
}

export function getCardNormalImage(card) {
  return card?.image_uris?.normal
    || card?.card_faces?.[0]?.image_uris?.normal
    || null
}

const USD_TO_EUR = 0.92

function pickPrice(prices) {
  if (!prices) return { price: null, isFoil: false }
  if (prices.eur) return { price: parseFloat(prices.eur), isFoil: false }
  if (prices.usd) return { price: parseFloat(prices.usd) * USD_TO_EUR, isFoil: false }
  if (prices.eur_foil) return { price: parseFloat(prices.eur_foil), isFoil: true }
  if (prices.usd_foil) return { price: parseFloat(prices.usd_foil) * USD_TO_EUR, isFoil: true }
  return { price: null, isFoil: false }
}

export function getPartnerType(scryfallCard) {
  const keywords = scryfallCard.keywords || []
  const oracleText = scryfallCard.oracle_text || scryfallCard.card_faces?.[0]?.oracle_text || ''

  if (keywords.includes('Partner with')) {
    const match = oracleText.match(/Partner with ([^\n(]+)/)
    return { type: 'partner_with', partnerName: match ? match[1].trim() : null }
  }
  if (keywords.includes('Partner')) return { type: 'partner' }
  if (keywords.includes('Friends forever')) return { type: 'friends_forever' }
  if (keywords.includes('Choose a Background')) return { type: 'choose_background' }
  if (keywords.includes("Doctor's companion")) return { type: 'doctors_companion' }
  return null
}

export function extractTokenRefs(scryfallCards) {
  const tokenMap = new Map()
  for (const card of scryfallCards) {
    if (!card.all_parts) continue
    for (const part of card.all_parts) {
      const isToken = part.component === 'token'
      const isEmblem = part.component === 'combo_piece' && part.type_line?.startsWith('Emblem')
      if ((isToken || isEmblem) && !tokenMap.has(part.id)) {
        tokenMap.set(part.id, part.uri)
      }
    }
  }
  return tokenMap
}

export async function fetchTokenDetails(tokenMap) {
  const tokens = []
  const uris = [...tokenMap.values()]

  for (let i = 0; i < uris.length; i++) {
    if (i > 0) await delay(80)
    try {
      const res = await fetch(uris[i])
      if (!res.ok) continue
      const data = await res.json()
      const image = data.image_uris?.normal || data.card_faces?.[0]?.image_uris?.normal
      if (image) {
        tokens.push({ name: data.name, image, type_line: data.type_line || '' })
      }
    } catch { /* skip failed tokens */ }
  }
  return tokens
}

export async function fetchCheapestPrice(cardName) {
  const name = cardName.includes(' // ') ? cardName.split(' // ')[0] : cardName
  const q = `!"${name}" -is:digital`
  const url = `${API_BASE}/cards/search?q=${encodeURIComponent(q)}&unique=prints&order=eur&dir=asc`
  let res = await fetch(url)
  // Retry once on rate limit (429)
  if (res.status === 429) {
    await delay(1000)
    res = await fetch(url)
  }
  if (!res.ok) return { price: null, isFoil: false }
  const data = await res.json()
  // Results sorted by EUR asc — scan for first card with a price
  for (const c of (data.data || [])) {
    const p = c.prices || {}
    if (p.eur) return { price: parseFloat(p.eur), isFoil: false }
    if (p.usd) return { price: parseFloat(p.usd) * USD_TO_EUR, isFoil: false }
  }
  // No non-foil price found, try foil
  for (const c of (data.data || [])) {
    const p = c.prices || {}
    if (p.eur_foil) return { price: parseFloat(p.eur_foil), isFoil: true }
    if (p.usd_foil) return { price: parseFloat(p.usd_foil) * USD_TO_EUR, isFoil: true }
  }
  return { price: null, isFoil: false }
}

export async function fetchCardPrintings(cardName) {
  const url = `${API_BASE}/cards/search?q=!"${encodeURIComponent(cardName)}"&unique=prints&order=released`
  const res = await fetch(url)
  if (!res.ok) return []
  const data = await res.json()
  const EXCLUDED_SET_TYPES = ['promo', 'treasure_chest', 'token']
  return (data.data || []).filter(c => {
    if (c.finishes && c.finishes.length === 1 && c.finishes[0] !== 'nonfoil') return false
    if (c.digital) return false
    if (c.promo) return false
    if (EXCLUDED_SET_TYPES.includes(c.set_type)) return false
    const img = c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal
    return img != null
  }).map(c => ({
    scryfall_id: c.id,
    set: c.set_name,
    set_code: c.set,
    released: c.released_at,
    image_normal: c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal,
    image_png: c.image_uris?.png || c.card_faces?.[0]?.image_uris?.png,
  }))
}

export function extractCardData(scryfallCard) {
  const imageUri = scryfallCard.image_uris?.normal
    || scryfallCard.card_faces?.[0]?.image_uris?.normal
    || null

  return {
    name: scryfallCard.name,
    scryfall_id: scryfallCard.id,
    type_line: scryfallCard.type_line || '',
    mana_cost: scryfallCard.mana_cost || '',
    cmc: scryfallCard.cmc || 0,
    image_uri: imageUri,
    price_eur: pickPrice(scryfallCard.prices).price,
    price_is_foil: pickPrice(scryfallCard.prices).isFoil,
    price_updated_at: new Date().toISOString(),
    commander_legality: scryfallCard.legalities?.commander || 'not_legal',
  }
}

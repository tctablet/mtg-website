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

    const identifiers = chunks[i].map(name => ({ name }))
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

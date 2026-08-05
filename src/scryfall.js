const API_BASE = 'https://api.scryfall.com'

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// fetch with an abort timeout so a hung connection eventually rejects (and can
// be retried) instead of leaving a spinner stuck forever.
// Exported: auch src/edhrec.js nutzt es (statt Duplikat).
export function fetchWithTimeout(url, ms, opts = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer))
}

// Kann diese Karte ein Commander sein? (aus deck-import.js hierher gezogen —
// der Commander-Scan braucht dieselbe Prüfung)
export function isCommanderEligible(scryfallCard) {
  const typeLine = scryfallCard.type_line || ''
  const oracleText = scryfallCard.oracle_text || scryfallCard.card_faces?.[0]?.oracle_text || ''

  // Legendary Creature
  if (typeLine.includes('Legendary') && typeLine.includes('Creature')) return true
  // Planeswalker that can be commander
  if (typeLine.includes('Planeswalker') && oracleText.includes('can be your commander')) return true
  // Some cards explicitly say they can be your commander
  if (oracleText.includes('can be your commander')) return true

  return false
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

// Returns an array of printings on success (possibly empty = card genuinely has
// no eligible printings), or null on failure (network error/timeout/rate-limit
// exhausted after retries). Callers cache arrays but never null, so a transient
// failure doesn't stick as "no printings" for the session.
export async function fetchCardPrintings(cardName, retries = 2) {
  const url = `${API_BASE}/cards/search?q=!"${encodeURIComponent(cardName)}"&unique=prints&order=released`
  let res
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetchWithTimeout(url, 10000)
    } catch (err) {
      // Thrown network error (WebKit "Load failed") or timeout — back off and
      // retry, then signal failure. Bursting Scryfall's rate limit makes these
      // transient, so a retry usually succeeds.
      if (attempt >= retries) {
        console.warn(`fetchCardPrintings: "${cardName}" failed after ${retries + 1} tries:`, err.message)
        return null
      }
      await delay(400 * (attempt + 1))
      continue
    }
    if (res.status === 429 && attempt < retries) {
      const retryAfter = parseFloat(res.headers.get('retry-after'))
      const wait = Number.isFinite(retryAfter) ? retryAfter * 1000 : 500 * (attempt + 1)
      await delay(Math.min(wait, 5000)) // cap so the spinner can't hang for long
      continue
    }
    break
  }
  if (!res.ok) return res.status === 404 ? [] : null // 404 = no such card (genuine empty)
  const data = await res.json()
  return (data.data || []).filter(keepPrinting).map(toPrinting)
}

const EXCLUDED_SET_TYPES = ['promo', 'treasure_chest', 'token']

export function keepPrinting(c) {
  if (c.finishes && c.finishes.length === 1 && c.finishes[0] !== 'nonfoil') return false
  if (c.digital) return false
  if (c.promo) return false
  if (EXCLUDED_SET_TYPES.includes(c.set_type)) return false
  return (c.image_uris?.normal || c.card_faces?.[0]?.image_uris?.normal) != null
}

export function toPrinting(c) {
  const img = c.image_uris || c.card_faces?.[0]?.image_uris || {}
  return {
    scryfall_id: c.id,
    set: c.set_name,
    set_code: c.set,
    released: c.released_at,
    // small (~11 KB) fürs Auswahl-Grid, normal/png erst für die getroffene Wahl
    image_small: img.small || img.normal,
    image_normal: img.normal,
    image_png: img.png || img.normal,
  }
}

/**
 * Holt die Printings vieler Karten mit möglichst wenigen Requests.
 * Scryfall erlaubt `!"A" or !"B" or …` und liefert 175 Treffer pro Seite —
 * für ein 100-Karten-Deck sind das ~10 Abrufe statt ~100.
 * Liefert eine Map (kleingeschriebener Name → Printings). Namen, für die
 * nichts zurückkam, fehlen in der Map und bleiben dem Einzelabruf überlassen.
 */
// Scryfall schneidet ein zu langes q still ab und antwortet dann mit HTTP 200
// auf eine sinnlose Query (praktisch der gesamte Katalog). Die Grenze liegt bei
// rund 1000 Zeichen im unkodierten q — 700 lässt reichlich Luft.
const MAX_QUERY_CHARS = 700
// Eine Karte hat selbst im Extremfall keine 400 Druckvarianten. Deutlich mehr
// heißt: die Query wurde verstümmelt, das Ergebnis gehört nicht uns.
const MAX_PLAUSIBLE_PER_NAME = 400

function chunkByQueryLength(names, maxNames) {
  // `!"Name"` sind 3 Zeichen Zuschlag, ` or ` als Trenner nochmal 4
  const costOf = (name, isFirst) => name.length + 3 + (isFirst ? 0 : 4)
  const chunks = []
  let current = []
  let length = 0
  for (const name of names) {
    const wouldExceed = length + costOf(name, false) > MAX_QUERY_CHARS
    if (current.length && (wouldExceed || current.length >= maxNames)) {
      chunks.push(current)
      current = []
      length = 0
    }
    length += costOf(name, current.length === 0)
    current.push(name)
  }
  if (current.length) chunks.push(current)
  return chunks
}

export async function fetchPrintingsBulk(cardNames, { chunkSize = 12, onChunk } = {}) {
  const result = new Map()
  for (const chunk of chunkByQueryLength(cardNames, chunkSize)) {
    const q = chunk.map(n => `!"${n.replace(/"/g, '')}"`).join(' or ')
    try {
      for (let page = 1; page <= 20; page++) {
        const url = `${API_BASE}/cards/search?q=${encodeURIComponent(q)}&unique=prints&order=released&page=${page}`
        const res = await fetchWithTimeout(url, 15000)
        if (!res.ok) break // inkl. 404 = kein Treffer im ganzen Chunk
        const data = await res.json()
        // Absturzsicherung gegen die still abgeschnittene Query: lieber nichts
        // übernehmen als fremde Printings, und keine 20 Seiten leerlaufen
        if (page === 1 && data.total_cards > chunk.length * MAX_PLAUSIBLE_PER_NAME) {
          console.warn(
            `fetchPrintingsBulk: implausible Antwort (${data.total_cards} Treffer für ${chunk.length} Namen) — Chunk verworfen`
          )
          break
        }
        for (const c of data.data || []) {
          if (!keepPrinting(c)) continue
          const key = c.name.toLowerCase()
          if (!result.has(key)) result.set(key, [])
          result.get(key).push(toPrinting(c))
        }
        if (!data.has_more) break
        if (page === 20) console.warn('fetchPrintingsBulk: Seitenlimit erreicht, Rest übersprungen')
        await delay(100)
      }
      if (onChunk) onChunk(result)
    } catch (err) {
      // Chunk übersprungen — die betroffenen Namen holt der Einzelabruf nach
      console.warn('fetchPrintingsBulk: chunk failed', err.message)
    }
    await delay(100)
  }
  return result
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

import { createClient } from '@supabase/supabase-js'
import { groupPrintingRows } from './printings.js'

const SUPABASE_URL = 'https://jcbdjlqxmlsfqfenltws.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpjYmRqbHF4bWxzZnFmZW5sdHdzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0NzczNDUsImV4cCI6MjA4OTA1MzM0NX0.S87-oIgyMjB1Jdc-2LW4b0mlnUkoFw_SjltpMAB6lvc'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// --- Player ---

export async function loginWithCode(code) {
  const { data, error } = await supabase
    .from('players')
    .select('*')
    .eq('code', code)
    .single()

  if (error || !data) return null
  return data
}

export async function getAllPlayers() {
  const { data } = await supabase
    .from('players')
    .select('id, name')
    .order('name', { ascending: true })
  return data || []
}

// --- Decks ---

// Lese-Fehler werfen statt sie als [] zu tarnen — ein Netzfehler sah sonst
// exakt aus wie "keine Decks vorhanden" (die Seiten fangen und zeigen Retry).

export async function getPlayerDecks(playerId) {
  const { data, error } = await supabase
    .from('decks')
    .select('*')
    .eq('player_id', playerId)
    .eq('for_sale', false)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

export async function getAllDecksWithPlayers() {
  const { data, error } = await supabase
    .from('decks')
    .select('*, players(name)')
    .eq('for_sale', false)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

export async function getResterampeDecks() {
  const { data, error } = await supabase
    .from('decks')
    .select('*, players(name)')
    .eq('for_sale', true)
    .order('sold', { ascending: true })
    .order('created_at', { ascending: false })
  if (error) throw error
  return data || []
}

export async function createDeck(playerId, name, commander, commanderImage, commander2 = null, commander2Image = null) {
  const row = { player_id: playerId, name, commander, commander_image: commanderImage }
  if (commander2) {
    row.commander2 = commander2
    row.commander2_image = commander2Image
  }
  const { data, error } = await supabase
    .from('decks')
    .insert(row)
    .select()
    .single()
  if (error) throw error
  return data
}

export async function deleteDeck(deckId) {
  const { error } = await supabase.from('decks').delete().eq('id', deckId)
  if (error) throw error
}

export async function getDeck(deckId) {
  // maybeSingle: fehlendes Deck bleibt null ("Deck nicht gefunden"),
  // nur echte Fehler werfen
  const { data, error } = await supabase
    .from('decks')
    .select('*, players(name)')
    .eq('id', deckId)
    .maybeSingle()
  if (error) throw error
  return data
}

// --- Cards ---

export async function getDeckCards(deckId) {
  const { data, error } = await supabase
    .from('cards')
    .select('*')
    .eq('deck_id', deckId)
    .order('type_category', { ascending: true })
    .order('name', { ascending: true })
  if (error) throw error
  return data || []
}

export async function insertCards(cards) {
  const { error } = await supabase.from('cards').insert(cards)
  if (error) throw error
}

// Resolves the cheapest EUR price per card name from the pre-synced
// scryfall_prices table (cheapest across all printings), with a DFC front-face
// fallback. Returns Map<name, { price, isFoil }>. Used by import/add so a card
// never stores a null price when a cheapest price exists — Scryfall's
// per-printing price is often null for digital/token printings.
export async function fetchCheapestPrices(names) {
  const unique = [...new Set(names)]
  const lookup = new Map()

  const queryChunked = async (queryNames, onRow) => {
    for (let i = 0; i < queryNames.length; i += 150) {
      const chunk = queryNames.slice(i, i + 150)
      if (!chunk.length) continue
      const { data, error } = await supabase
        .from('scryfall_prices')
        .select('name, cheapest_eur, is_foil')
        .in('name', chunk)
      if (error) {
        // Don't throw: callers fall back to the per-printing price. Surface it
        // so a silent DB failure can't quietly re-introduce null prices.
        console.warn('fetchCheapestPrices: scryfall_prices query failed:', error.message)
        continue
      }
      for (const row of data || []) onRow(row)
    }
  }

  await queryChunked(unique, row => {
    lookup.set(row.name, { price: row.cheapest_eur, isFoil: !!row.is_foil })
  })

  // DFC front-face fallback for "A // B" names not matched by full name.
  const missing = unique.filter(n => !lookup.has(n) && n.includes(' // '))
  if (missing.length) {
    const fronts = [...new Set(missing.map(n => n.split(' // ')[0]))]
    const frontLookup = new Map()
    await queryChunked(fronts, row => {
      frontLookup.set(row.name, { price: row.cheapest_eur, isFoil: !!row.is_foil })
    })
    for (const n of missing) {
      const info = frontLookup.get(n.split(' // ')[0])
      if (info) lookup.set(n, info)
    }
  }

  return lookup
}

// Holt die Printings aller angefragten Karten aus dem täglich gesyncten
// card_printings-Cache — eine Query-Runde statt ~86 Scryfall-Requests.
// Rückgabe wie fetchPrintingsBulk: Map<kleingeschriebener Name, Printing[]>;
// Namen ohne Rows fehlen in der Map (Scryfall-Fallback übernimmt sie).
// null = Cache nicht verfügbar (Tabelle fehlt/Query-Fehler) → kompletter Fallback.
let printingsTableUnavailable = false
export async function fetchPrintingsFromDB(names) {
  if (printingsTableUnavailable) return null
  const unique = [...new Set(names)]
  const rows = []
  // PostgREST kappt Antworten hart bei 1000 Rows OHNE error — ein Chunk voller
  // Namen (oder eine einzelne Basic mit ~850 Printings) muss deshalb explizit
  // durchpaginiert werden, sonst landet ein still abgeschnittenes Ergebnis
  // für 7 Tage im localStorage-Cache.
  const PAGE = 1000
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100)
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('card_printings')
        .select('scryfall_id, name, set_code, set_name, released_at, image_small, image_normal, image_png')
        .in('name', chunk)
        .order('scryfall_id')
        .range(from, from + PAGE - 1)
      if (error) {
        console.warn('fetchPrintingsFromDB: card_printings nicht verfügbar:', error.message)
        // Fehlende Tabelle (Migration 003 noch nicht ausgeführt) für die Session
        // merken — erspart jedem Picker-Öffnen den toten Roundtrip.
        if (/card_printings/.test(error.message) && /find|exist|cache/i.test(error.message)) {
          printingsTableUnavailable = true
        }
        return null
      }
      rows.push(...(data || []))
      if (!data || data.length < PAGE) break
    }
  }
  return groupPrintingRows(rows, unique)
}

export async function updateCardPrices(deckId, priceMap, legalityMap = {}) {
  const now = new Date().toISOString()
  const entries = Object.entries(priceMap)

  // Batch in chunks of 20 to avoid connection limits
  for (let i = 0; i < entries.length; i += 20) {
    const chunk = entries.slice(i, i + 20)
    await Promise.all(chunk.map(([cardId, info]) => {
      const price = typeof info === 'object' ? info.price : info
      const isFoil = typeof info === 'object' ? info.isFoil : false
      const update = { price_eur: price, price_is_foil: isFoil, price_updated_at: now }
      if (legalityMap[cardId]) {
        update.commander_legality = legalityMap[cardId]
      }
      return supabase
        .from('cards')
        .update(update)
        .eq('id', cardId)
    }))
  }
}

export async function deleteCard(cardId) {
  const { error } = await supabase.from('cards').delete().eq('id', cardId)
  if (error) throw error
}

export async function updateCardQuantity(cardId, quantity) {
  const { error } = await supabase.from('cards').update({ quantity }).eq('id', cardId)
  if (error) throw error
}

export async function updateCardProxyImage(cardId, proxyImageUri) {
  const { error } = await supabase
    .from('cards')
    .update({ proxy_image_uri: proxyImageUri })
    .eq('id', cardId)
  if (error) throw error
}

export async function updateDeck(deckId, updates) {
  const { error } = await supabase.from('decks').update(updates).eq('id', deckId)
  if (error) throw error
}

export async function getDeckValue(deckId) {
  const cards = await getDeckCards(deckId)
  return cards.reduce((sum, c) => sum + (parseFloat(c.price_eur) || 0) * c.quantity, 0)
}

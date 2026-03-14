import { createClient } from '@supabase/supabase-js'

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

export async function getPlayerDecks(playerId) {
  const { data } = await supabase
    .from('decks')
    .select('*')
    .eq('player_id', playerId)
    .order('created_at', { ascending: false })
  return data || []
}

export async function getAllDecksWithPlayers() {
  const { data } = await supabase
    .from('decks')
    .select('*, players(name)')
    .order('created_at', { ascending: false })
  return data || []
}

export async function createDeck(playerId, name, commander, commanderImage) {
  const { data, error } = await supabase
    .from('decks')
    .insert({ player_id: playerId, name, commander, commander_image: commanderImage })
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
  const { data } = await supabase
    .from('decks')
    .select('*, players(name)')
    .eq('id', deckId)
    .single()
  return data
}

// --- Cards ---

export async function getDeckCards(deckId) {
  const { data } = await supabase
    .from('cards')
    .select('*')
    .eq('deck_id', deckId)
    .order('type_category', { ascending: true })
    .order('name', { ascending: true })
  return data || []
}

export async function insertCards(cards) {
  const { error } = await supabase.from('cards').insert(cards)
  if (error) throw error
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

export async function updateDeck(deckId, updates) {
  const { error } = await supabase.from('decks').update(updates).eq('id', deckId)
  if (error) throw error
}

export async function getDeckValue(deckId) {
  const cards = await getDeckCards(deckId)
  return cards.reduce((sum, c) => sum + (parseFloat(c.price_eur) || 0) * c.quantity, 0)
}

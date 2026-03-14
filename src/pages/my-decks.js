import { getPlayer } from '../auth.js'
import { navigate } from '../router.js'
import { getPlayerDecks, getDeckCards, deleteDeck } from '../supabase.js'
import { formatTotalPrice } from '../utils.js'

export async function renderMyDecks(container) {
  const player = getPlayer()
  if (!player) { navigate('#/login'); return }

  container.innerHTML = '<p class="loading">Lade Decks...</p>'

  const decks = await getPlayerDecks(player.id)

  container.innerHTML = `
    <div class="page">
      <div class="page-header">
        <h2>Meine Decks</h2>
        <button id="new-deck-btn" class="btn">+ Neues Deck importieren</button>
      </div>
      <div id="deck-grid" class="deck-grid">
        ${decks.length === 0 ? '<p class="empty">Noch keine Decks. Importiere dein erstes!</p>' : ''}
      </div>
    </div>
  `

  document.getElementById('new-deck-btn').addEventListener('click', () => {
    navigate('#/import')
  })

  if (decks.length > 0) {
    const grid = document.getElementById('deck-grid')
    for (const deck of decks) {
      const cards = await getDeckCards(deck.id)
      grid.appendChild(createDeckCard(deck, cards, true))
    }
  }
}

export function createDeckCard(deck, cards, showDelete = false) {
  const card = document.createElement('div')
  card.className = 'deck-card'

  const totalPrice = formatTotalPrice(cards)
  const bgImage = deck.commander_image
    ? `background-image: url('${deck.commander_image}')`
    : ''

  card.innerHTML = `
    <div class="deck-card-art" style="${bgImage}"></div>
    <div class="deck-card-info">
      <h3>${deck.name}</h3>
      <p class="deck-commander">${deck.commander}</p>
      <div class="deck-card-stats">
        <span>${cards.reduce((s, c) => s + (c.quantity || 1), 0)} Karten</span>
        <span class="deck-card-value">${totalPrice}</span>
      </div>
    </div>
    ${showDelete ? '<button class="deck-delete" title="Deck löschen">&times;</button>' : ''}
  `

  card.addEventListener('click', (e) => {
    if (e.target.closest('.deck-delete')) return
    navigate(`#/deck/${deck.id}`)
  })

  if (showDelete) {
    card.querySelector('.deck-delete').addEventListener('click', async (e) => {
      e.stopPropagation()
      if (confirm(`Deck "${deck.name}" wirklich löschen?`)) {
        await deleteDeck(deck.id)
        card.remove()
      }
    })
  }

  return card
}

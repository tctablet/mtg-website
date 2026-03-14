import { getAllDecksWithPlayers, getDeckCards, getAllPlayers } from '../supabase.js'
import { formatPrice } from '../utils.js'
import { navigate } from '../router.js'
import { getPlayer } from '../auth.js'

export async function renderOverview(container) {
  if (!getPlayer()) { navigate('#/login'); return }

  container.innerHTML = '<p class="loading">Lade Übersicht...</p>'

  const [decks, allPlayers] = await Promise.all([
    getAllDecksWithPlayers(),
    getAllPlayers(),
  ])

  // Group decks by player and calculate values
  const playerMap = {}
  for (const p of allPlayers) {
    playerMap[p.id] = { id: p.id, name: p.name, decks: [], totalValue: 0 }
  }

  for (const deck of decks) {
    const pid = deck.player_id
    if (!playerMap[pid]) {
      const name = deck.players?.name || 'Unbekannt'
      playerMap[pid] = { id: pid, name, decks: [], totalValue: 0 }
    }
    const cards = await getDeckCards(deck.id)
    const value = cards.reduce((s, c) => s + (parseFloat(c.price_eur) || 0) * c.quantity, 0)
    playerMap[pid].decks.push({ ...deck, value })
    playerMap[pid].totalValue += value
  }

  const players = Object.values(playerMap).sort((a, b) => b.totalValue - a.totalValue)

  container.innerHTML = `
    <div class="page">
      <h2>Übersicht</h2>
      ${players.map(p => `
        <div class="player-section">
          <div class="player-section-header">
            <h3>${p.name}</h3>
            ${p.decks.length ? `<span class="player-section-total">${formatPrice(p.totalValue)}</span>` : ''}
          </div>
          ${p.decks.length ? `
            <div class="overview-deck-grid">
              ${p.decks.map(d => `
                <a href="#/deck/${d.id}" class="deck-tile" ${d.commander_image ? `style="background-image: linear-gradient(to bottom, rgba(15,15,20,0.1) 0%, rgba(15,15,20,0.85) 70%), url('${d.commander_image}'); background-size: cover; background-position: center top;"` : ''}>
                  <div class="deck-tile-bottom">
                    <span class="deck-tile-name">${d.name}</span>
                    <span class="deck-tile-commander">${d.commander}</span>
                    <div class="deck-tile-meta">
                      <span class="deck-tile-value">${formatPrice(d.value)}</span>
                    </div>
                  </div>
                </a>
              `).join('')}
            </div>
          ` : `
            <p class="player-no-decks">Noch keine Decks</p>
          `}
        </div>
      `).join('')}
    </div>
  `
}

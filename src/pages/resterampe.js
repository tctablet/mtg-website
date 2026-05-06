import { getPlayer } from '../auth.js'
import { navigate } from '../router.js'
import { getResterampeDecks, getDeckCards } from '../supabase.js'
import { formatPrice, formatTotalPrice } from '../utils.js'

export async function renderResterampe(container) {
  const player = getPlayer()
  if (!player) { navigate('#/login'); return }

  container.innerHTML = '<p class="loading">Lade Resterampe...</p>'

  const decks = await getResterampeDecks()

  container.innerHTML = `
    <div class="page">
      <div class="resterampe-header">
        <h2>Philips Resterampe</h2>
        <p class="resterampe-intro">
          Ich löse meine Magic-Sammlung auf und biete hier Precon-Decks zum Verkauf an.
          Jedes Deck zeigt den aktuellen Singles-Marktwert (Cardmarket Cheapest) sowie den
          Sealed-Preis, falls man das Deck noch original verpackt kaufen würde.
        </p>
      </div>
      <div id="resterampe-grid" class="deck-grid">
        ${decks.length === 0 ? '<p class="empty">Aktuell keine Decks im Verkauf.</p>' : ''}
      </div>
    </div>
  `

  if (decks.length === 0) return

  const grid = document.getElementById('resterampe-grid')
  for (const deck of decks) {
    const cards = await getDeckCards(deck.id)
    grid.appendChild(createResterampeCard(deck, cards))
  }
}

function createResterampeCard(deck, cards) {
  const card = document.createElement('div')
  card.className = 'deck-card resterampe-card' + (deck.sold ? ' resterampe-card-sold' : '')

  const singlesTotal = formatTotalPrice(cards)
  const sealedPrice = deck.sealed_price_eur != null ? formatPrice(deck.sealed_price_eur) : '—'
  const bgImage = deck.commander_image
    ? `background-image: url('${deck.commander_image}')`
    : ''

  const archetypeHtml = deck.archetype
    ? `<span class="resterampe-archetype">${escapeHtml(deck.archetype)}</span>`
    : ''
  const playstyleHtml = deck.playstyle
    ? `<p class="resterampe-playstyle">${escapeHtml(deck.playstyle)}</p>`
    : ''

  card.innerHTML = `
    ${deck.sold ? '<span class="sold-badge">Verkauft</span>' : ''}
    <div class="deck-card-art" style="${bgImage}"></div>
    <div class="deck-card-info">
      <h3>${escapeHtml(deck.name)}</h3>
      <p class="deck-commander">${escapeHtml(deck.commander)}${deck.commander2 ? ' + ' + escapeHtml(deck.commander2) : ''}</p>
      ${archetypeHtml}
      ${playstyleHtml}
      <div class="resterampe-prices">
        <div class="resterampe-price-row">
          <span class="resterampe-price-label">Singles</span>
          <span class="resterampe-price-value">${singlesTotal}</span>
        </div>
        <div class="resterampe-price-row resterampe-price-sealed">
          <span class="resterampe-price-label">Sealed</span>
          <span class="resterampe-price-value">${sealedPrice}</span>
        </div>
      </div>
    </div>
  `

  card.addEventListener('click', () => {
    navigate(`#/deck/${deck.id}`)
  })

  return card
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c])
}

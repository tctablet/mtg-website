import { navigate } from '../router.js'
import { getResterampeDecks, getDeckCards } from '../supabase.js'
import { formatPrice, formatTotalPrice } from '../utils.js'

export async function renderResterampe(container) {
  container.innerHTML = '<p class="loading">Lade Resterampe...</p>'

  const decks = await getResterampeDecks()

  container.innerHTML = `
    <div class="page">
      <div class="resterampe-header">
        <h2>Philips Resterampe</h2>
        <p class="resterampe-intro">
          Ich löse meine Magic-Sammlung auf und biete hier Decks zum Verkauf an.
          Bei Precons zeigt die Karte zusätzlich den Sealed-Preis (falls man das Deck
          neu original verpackt kaufen würde).
        </p>
      </div>
      <section class="resterampe-section" id="section-custom">
        <h3 class="resterampe-section-title">Custom Decks</h3>
        <div id="grid-custom" class="deck-grid"></div>
      </section>
      <section class="resterampe-section" id="section-precon">
        <h3 class="resterampe-section-title">Precon Decks</h3>
        <div id="grid-precon" class="deck-grid"></div>
      </section>
    </div>
  `

  if (decks.length === 0) {
    document.getElementById('section-custom').remove()
    document.getElementById('section-precon').remove()
    container.querySelector('.page').insertAdjacentHTML('beforeend',
      '<p class="empty">Aktuell keine Decks im Verkauf.</p>')
    return
  }

  const customDecks = decks.filter(d => d.deck_type === 'custom')
  const preconDecks = decks.filter(d => d.deck_type !== 'custom')

  const customGrid = document.getElementById('grid-custom')
  const preconGrid = document.getElementById('grid-precon')

  if (customDecks.length === 0) {
    document.getElementById('section-custom').remove()
  } else {
    for (const deck of customDecks) {
      const cards = await getDeckCards(deck.id)
      customGrid.appendChild(createResterampeCard(deck, cards))
    }
  }

  if (preconDecks.length === 0) {
    document.getElementById('section-precon').remove()
  } else {
    for (const deck of preconDecks) {
      const cards = await getDeckCards(deck.id)
      preconGrid.appendChild(createResterampeCard(deck, cards))
    }
  }
}

function createResterampeCard(deck, cards) {
  const card = document.createElement('div')
  card.className = 'deck-card resterampe-card' + (deck.sold ? ' resterampe-card-sold' : '')

  const isCustom = deck.deck_type === 'custom'
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

  const pricesHtml = isCustom
    ? `
      <div class="resterampe-prices resterampe-prices-single">
        <div class="resterampe-price-row">
          <span class="resterampe-price-label">Singles-Wert</span>
          <span class="resterampe-price-value">${singlesTotal}</span>
        </div>
      </div>
    `
    : `
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
    `

  card.innerHTML = `
    ${deck.sold ? '<span class="sold-badge">Verkauft</span>' : ''}
    <div class="deck-card-art" style="${bgImage}"></div>
    <div class="deck-card-info">
      <h3>${escapeHtml(deck.name)}</h3>
      <p class="deck-commander">${escapeHtml(deck.commander)}${deck.commander2 ? ' + ' + escapeHtml(deck.commander2) : ''}</p>
      ${archetypeHtml}
      ${playstyleHtml}
      ${pricesHtml}
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

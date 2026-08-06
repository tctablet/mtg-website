import { navigate } from '../router.js'
import { getResterampeDecks, getDeckCards } from '../supabase.js'
import { formatPrice, formatTotalPrice, getDeckColors, renderLoadError, escapeHtml, applyPrintingPrices } from '../utils.js'
import { fetchPrintingPricesCached } from '../printing-prices.js'
import { refade } from '../components/loading.js'

export async function renderResterampe(container) {
  container.innerHTML = '<p class="loading">Lade Resterampe...</p>'

  let decks
  try {
    decks = await getResterampeDecks()
  } catch (err) {
    renderLoadError(container, err, () => renderResterampe(container))
    return
  }

  container.innerHTML = `
    <div class="page">
      <div class="resterampe-header">
        <h2>Philips Resterampe</h2>
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

  // Beide Sektionen parallel laden statt Deck fuer Deck nacheinander
  const fill = async (decks, grid, exactPrintings = false) => {
    const cardLists = await Promise.all(decks.map(d => getDeckCards(d.id)))
    // Schlug die Schwester-Sektion fehl, hat renderLoadError den Container
    // ersetzt — dann nicht mehr in den losgelösten Grid-Knoten rendern
    if (!grid.isConnected) return
    const frag = document.createDocumentFragment()
    const cardEls = decks.map((deck, i) => {
      const el = createResterampeCard(deck, cardLists[i], i)
      frag.appendChild(el)
      return el
    })
    grid.appendChild(frag)

    // Precons werden mit den EXAKTEN Printing-Preisen bewertet (live von
    // Scryfall, Session-Cache) — aber ERST NACH dem Render nachgezogen:
    // die Sektion wartet nicht auf den Scryfall-Roundtrip (User-Feedback
    // 06.08.2026: „erst nach langem Laden"). Bis dahin steht der günstigste
    // Namens-Preis, der bei Fehlern auch ehrlich stehen bleibt.
    if (exactPrintings) {
      try {
        const prices = await fetchPrintingPricesCached(
          cardLists.flat().map(c => c.scryfall_id)
        )
        if (!grid.isConnected) return
        decks.forEach((deck, i) => {
          if (applyPrintingPrices(cardLists[i], prices) === 0) return
          const valueEl = cardEls[i].querySelector('.resterampe-price-value')
          if (valueEl) {
            valueEl.textContent = formatTotalPrice(cardLists[i])
            refade(valueEl)
          }
        })
      } catch { /* günstigste Namens-Preise als ehrlicher Fallback */ }
    }
  }

  try {
    await Promise.all([
      customDecks.length === 0
        ? Promise.resolve(document.getElementById('section-custom').remove())
        : fill(customDecks, customGrid),
      preconDecks.length === 0
        ? Promise.resolve(document.getElementById('section-precon').remove())
        : fill(preconDecks, preconGrid, true),
    ])
  } catch (err) {
    renderLoadError(container, err, () => renderResterampe(container))
  }
}

function createResterampeCard(deck, cards, index = 0) {
  const card = document.createElement('div')
  card.className = 'deck-card resterampe-card' + (deck.sold ? ' resterampe-card-sold' : '')
  card.style.setProperty('--stagger', String(Math.min(index, 8)))

  const isCustom = deck.deck_type === 'custom'
  const singlesTotal = formatTotalPrice(cards)
  const sealedPrice = deck.sealed_price_eur != null ? formatPrice(deck.sealed_price_eur) : '—'
  const bgImage = deck.commander_image
    ? `background-image: url('${deck.commander_image}')`
    : ''

  const colors = getDeckColors(cards)
  const colorPipsHtml = colors.length
    ? `<div class="mana-pips">${colors.map(c =>
        `<img class="mana-pip" src="https://svgs.scryfall.io/card-symbols/${c}.svg" alt="${c}" />`
      ).join('')}</div>`
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
      <div class="deck-card-title-row">
        <h3>${escapeHtml(deck.name)}</h3>
        ${colorPipsHtml}
      </div>
      <p class="deck-commander">${escapeHtml(deck.commander)}${deck.commander2 ? ' + ' + escapeHtml(deck.commander2) : ''}</p>
      ${archetypeHtml}
      ${playstyleHtml}
      ${pricesHtml}
    </div>
  `

  card.addEventListener('click', () => {
    navigate(`/deck/${deck.id}`)
  })

  return card
}

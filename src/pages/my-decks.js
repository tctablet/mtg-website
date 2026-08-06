import { getPlayer } from '../auth.js'
import { navigate } from '../router.js'
import { getPlayerDecks, getDeckCards, deleteDeck } from '../supabase.js'
import { formatTotalPrice, renderLoadError } from '../utils.js'

export async function renderMyDecks(container) {
  const player = getPlayer()
  if (!player) { navigate('/login'); return }

  container.innerHTML = '<p class="loading">Lade Decks...</p>'

  let decks
  try {
    decks = await getPlayerDecks(player.id)
  } catch (err) {
    renderLoadError(container, err, () => renderMyDecks(container))
    return
  }

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
    navigate('/import')
  })

  if (decks.length > 0) {
    const grid = document.getElementById('deck-grid')
    try {
      // Alle Decks parallel laden und in einem Rutsch einhaengen — sonst
      // schiebt sich die Liste beim Scrollen Karte fuer Karte auseinander
      const cardLists = await Promise.all(decks.map(d => getDeckCards(d.id)))
      const frag = document.createDocumentFragment()
      decks.forEach((deck, i) => {
        const el = createDeckCard(deck, cardLists[i], true)
        // Gestaffelter Einflug wie auf der Resterampe (Motion-Sweep);
        // Deckelung, damit spaete Karten nicht sichtbar nachhinken
        el.style.setProperty('--stagger', String(Math.min(i, 8)))
        frag.appendChild(el)
      })
      grid.appendChild(frag)
    } catch (err) {
      renderLoadError(container, err, () => renderMyDecks(container))
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
    navigate(`/deck/${deck.id}`)
  })

  if (showDelete) {
    const delBtn = card.querySelector('.deck-delete')
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation()
      if (!confirm(`Deck "${deck.name}" wirklich löschen?`)) return
      delBtn.disabled = true
      // Busy-State per Klasse statt Inline-Style — Inline-opacity wuerde
      // spaeter den .deck-card-leave-Fade ueberstimmen (Critic)
      card.classList.add('deck-card-busy')
      try {
        await deleteDeck(deck.id)
      } catch (err) {
        delBtn.disabled = false
        card.classList.remove('deck-card-busy')
        alert(`Löschen fehlgeschlagen: ${err.message}`)
        return
      }
      // Exit-Fade statt Hartschnitt; 220 = var(--dur-base) (Motion-Sweep)
      card.classList.remove('deck-card-busy')
      card.classList.add('deck-card-leave')
      setTimeout(() => {
        card.remove()
        // Letztes Deck weg → Leerzustand wiederherstellen (entsteht sonst nur
        // beim initialen Render)
        const grid = document.getElementById('deck-grid')
        if (grid && !grid.querySelector('.deck-card')) {
          grid.innerHTML = '<p class="empty">Noch keine Decks. Importiere dein erstes!</p>'
        }
      }, 220)
    })
  }

  return card
}

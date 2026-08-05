// swap-picker.js — Einzelkarten-Swap: Karte X raus, Karte Y rein.
// Shell nach dem Artwork-Picker-Muster (Singleton, Route-Change-Guard, Escape,
// modal-open, visible/closing) — Desktop zentriertes Modal, Mobile Fullscreen-
// Bottom-Sheet (CSS). Suchfeld sitzt GANZ OBEN im Sheet (iOS-Tastatur).
//
// Confirm-Friction nach Risiko (UX-Research): Swap ist reversibel → KEIN
// Extra-Confirm. „Tauschen" führt sofort aus; der Undo-Toast (deck-view) macht
// den Gegen-Swap verlustfrei. Budget-Gate mit apply.mjs-Parität: Preis
// unbekannt zählt NIE als 0 €, over-budget blockt.

import { swapBudget, swapCard, applyLocalDelete } from '../deck-mutations.js'
import { deleteCard } from '../supabase.js'
import { attachCardAutocomplete } from './autocomplete.js'
import { formatPrice, escapeHtml } from '../utils.js'

let closeActiveSwapPicker = null

export function openSwapPicker({ card, deckId, cards, onSwapped }) {
  if (closeActiveSwapPicker) closeActiveSwapPicker()
  document.getElementById('swap-picker-modal')?.remove()

  const cutValue = (parseFloat(card.price_eur) || 0) * (card.quantity || 1)
  const currentTotal = cards.reduce((s, c) => s + (parseFloat(c.price_eur) || 0) * (c.quantity || 1), 0)

  const modal = document.createElement('div')
  modal.id = 'swap-picker-modal'
  modal.className = 'swap-picker-overlay'
  modal.innerHTML = `
    <div class="swap-picker" role="dialog" aria-modal="true" aria-label="Karte tauschen: ${escapeHtml(card.name)}" tabindex="-1">
      <div class="swap-picker-header">
        <div class="swap-picker-title">
          <h3>Tauschen: ${escapeHtml(card.name)}</h3>
          <span class="swap-cut-info">${card.quantity > 1 ? `${card.quantity}× ` : ''}${formatPrice(card.price_eur)} raus</span>
        </div>
        <button class="swap-picker-close" aria-label="Schließen">&times;</button>
        <div class="autocomplete-wrapper swap-search-wrapper">
          <input type="text" class="swap-search" placeholder="Neue Karte suchen..." autocomplete="off"
            autocapitalize="none" autocorrect="off" spellcheck="false" />
          <div class="autocomplete-list swap-suggestion-list" hidden></div>
        </div>
      </div>
      <div class="swap-picker-body">
        <p class="swap-hint">Karte suchen und auswählen — das Budget-Delta erscheint hier, bevor getauscht wird.</p>
        ${card.proxy_image_uri ? '<p class="swap-proxy-warning">Diese Karte hat ein gewähltes Proxy-Artwork — es geht beim Tausch verloren (Rückgängig stellt es wieder her).</p>' : ''}
        <div class="swap-selected" hidden></div>
      </div>
      <div class="swap-picker-footer">
        <div class="swap-budget" hidden></div>
        <div class="swap-footer-buttons">
          <button class="btn btn-secondary swap-cancel">Abbrechen</button>
          <button class="btn swap-execute" disabled>Tauschen</button>
        </div>
      </div>
    </div>
  `
  document.body.appendChild(modal)
  document.body.classList.add('modal-open')
  requestAnimationFrame(() => modal.classList.add('visible'))

  // Anders als der Artwork-Picker schließt der Swap-Picker bei JEDEM
  // route-change — auch refreshRoute() ohne Pfadwechsel baut #content samt
  // cards-Array/Closures neu auf; ein offener Picker würde danach mit
  // veraltetem State in den frischen DOM schreiben (Critic [HIGH]).
  function onRouteChange() {
    closeModal()
  }
  function onKeyDown(e) {
    if (e.key === 'Escape') closeModal()
  }
  let closing = false
  function closeModal() {
    if (closing) return
    closing = true
    autocomplete.destroy()
    window.removeEventListener('route-change', onRouteChange)
    document.removeEventListener('keydown', onKeyDown)
    if (viewportCleanup) viewportCleanup()
    document.body.classList.remove('modal-open')
    if (closeActiveSwapPicker === closeModal) closeActiveSwapPicker = null
    modal.classList.remove('visible')
    modal.classList.add('closing')
    // Timer statt transitionend: feuert auch bei reduced motion zuverlässig
    setTimeout(() => modal.remove(), 300)
  }
  closeActiveSwapPicker = closeModal

  modal.querySelector('.swap-picker-close').addEventListener('click', closeModal)
  modal.querySelector('.swap-cancel').addEventListener('click', closeModal)
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal() })
  window.addEventListener('route-change', onRouteChange)
  document.addEventListener('keydown', onKeyDown)

  const dialog = modal.querySelector('.swap-picker')
  const searchInput = modal.querySelector('.swap-search')
  const listEl = modal.querySelector('.swap-suggestion-list')
  const bodyEl = modal.querySelector('.swap-picker-body')
  const selectedEl = modal.querySelector('.swap-selected')
  const hintEl = modal.querySelector('.swap-hint')
  const budgetEl = modal.querySelector('.swap-budget')
  const executeBtn = modal.querySelector('.swap-execute')

  dialog.focus()

  // iOS-Tastatur: Sheet-Höhe an den sichtbaren Viewport koppeln — nur mit
  // Feature-Check, Fallback ist das 100dvh-Sheet + scrollIntoView (Plan-Critic)
  let viewportCleanup = null
  if ('visualViewport' in window && window.matchMedia('(max-width: 480px)').matches) {
    const vv = window.visualViewport
    const applyHeight = () => { dialog.style.height = `${vv.height}px` }
    vv.addEventListener('resize', applyHeight)
    viewportCleanup = () => {
      vv.removeEventListener('resize', applyHeight)
      dialog.style.height = ''
    }
  } else {
    searchInput.addEventListener('focus', () => {
      setTimeout(() => searchInput.scrollIntoView({ block: 'start' }), 250)
    })
  }

  let selected = null
  let lastGate = null

  function renderSelection() {
    if (!selected) {
      selectedEl.hidden = true
      budgetEl.hidden = true
      hintEl.hidden = false
      executeBtn.disabled = true
      return
    }
    hintEl.hidden = true
    selectedEl.hidden = false

    const duplicate = cards.some(c => c.name.toLowerCase() === selected.name.toLowerCase())
    selectedEl.innerHTML = `
      <div class="swap-pair">
        <span class="swap-pair-out">− ${escapeHtml(card.name)} <em>${formatPrice(card.price_eur)}</em></span>
        <span class="swap-pair-arrow">→</span>
        <span class="swap-pair-in">+ ${escapeHtml(selected.name)} <em>${selected.price != null ? formatPrice(selected.price) : 'Preis unbekannt'}</em></span>
      </div>
      ${duplicate ? '<p class="swap-error">Diese Karte ist bereits im Deck.</p>' : ''}
    `

    if (duplicate) {
      budgetEl.hidden = true
      executeBtn.disabled = true
      lastGate = null
      return
    }

    lastGate = swapBudget({ cards, cutCard: card, addName: selected.name, addPrice: selected.price })
    budgetEl.hidden = false

    if (lastGate.reason === 'unknown-price') {
      budgetEl.innerHTML = '<p class="swap-error">Preis unbekannt — zählt nie als 0 €, Tausch geblockt (Preis kommt mit dem nächsten Sync).</p>'
      executeBtn.disabled = true
      return
    }

    const total = lastGate.total
    const limit = lastGate.limit
    const delta = total - currentTotal
    const deltaText = `${delta >= 0 ? '+' : '−'}${formatPrice(Math.abs(delta)).replace(' €', '')} €`
    const pct = Math.min(100, (total / limit) * 100)
    budgetEl.innerHTML = `
      <div class="swap-budget-line${lastGate.ok ? '' : ' swap-budget-over'}">
        <span>Δ ${deltaText}</span>
        <span>${formatPrice(total)} / ${formatPrice(limit)}</span>
      </div>
      <div class="swap-budget-bar"><div class="swap-budget-fill${lastGate.ok ? '' : ' over'}" style="width:${pct}%"></div></div>
      ${lastGate.ok ? '' : '<p class="swap-error">Über dem 500-€-Limit — Tausch geblockt.</p>'}
    `
    executeBtn.disabled = !lastGate.ok
  }

  const autocomplete = attachCardAutocomplete({
    input: searchInput,
    listEl,
    onPick: (item) => {
      selected = item
      autocomplete.clear()
      searchInput.value = item.name
      renderSelection()
    },
  })

  searchInput.addEventListener('input', () => {
    // Neue Eingabe invalidiert die Auswahl — nie mit alter Auswahl tauschen
    if (selected && searchInput.value.trim() !== selected.name) {
      selected = null
      renderSelection()
    }
  })

  function showExecuteError(message, { retryDelete = false, newRow = null } = {}) {
    budgetEl.hidden = false
    budgetEl.innerHTML = `
      <p class="swap-error">${escapeHtml(message)}</p>
      ${retryDelete ? '<button class="btn btn-secondary swap-retry-delete">Entfernen nochmal versuchen</button>' : ''}
    `
    if (retryDelete) {
      budgetEl.querySelector('.swap-retry-delete').addEventListener('click', async () => {
        try {
          await deleteCard(card.id)
          applyLocalDelete(cards, card.id)
          closeModal()
          onSwapped({ status: 'ok', newRow, removedRow: card })
        } catch (err) {
          showExecuteError(`Entfernen weiterhin fehlgeschlagen: ${err.message}`, { retryDelete: true, newRow })
        }
      })
    }
  }

  executeBtn.addEventListener('click', async () => {
    if (!selected || !lastGate?.ok || executeBtn.disabled) return
    executeBtn.disabled = true
    executeBtn.textContent = 'Tausche…'
    try {
      const result = await swapCard({ deckId, cards, cutCard: card, addName: selected.name })
      if (result.status === 'ok') {
        closeModal()
        onSwapped(result)
      } else if (result.status === 'delete-failed') {
        // Insert war erfolgreich — Deck hat 101 Karten, nie zu wenige
        executeBtn.textContent = 'Tauschen'
        showExecuteError(
          `„${selected.name}" ist drin, aber „${card.name}" konnte nicht entfernt werden.`,
          { retryDelete: true, newRow: result.newRow }
        )
      } else {
        executeBtn.disabled = false
        executeBtn.textContent = 'Tauschen'
        showExecuteError(`Scryfall kennt „${selected.name}" nicht — nichts geändert.`)
      }
    } catch (err) {
      executeBtn.disabled = false
      executeBtn.textContent = 'Tauschen'
      showExecuteError(`Fehler beim Tauschen: ${err.message} — nichts gelöscht.`)
    }
  })

  // Auto-Focus nur auf Geräten mit Maus — auf Touch würde sofort die Tastatur aufspringen
  if (window.matchMedia('(hover: hover)').matches) searchInput.focus()

  return closeModal
}

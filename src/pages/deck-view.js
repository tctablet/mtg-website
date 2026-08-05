import { getDeck, getDeckCards, updateCardPrices, updateDeck, updateCardProxyImage, insertCardsReturning, fetchCheapestPrices, fetchPrintingsFromDB } from '../supabase.js'
import { fetchCardCollection, fetchCardByName, getCardArtCrop, getPartnerType, extractTokenRefs, fetchTokenDetails, fetchCardPrintings, fetchPrintingsBulk, autocompleteCard } from '../scryfall.js'
import { groupCardsByType, formatPrice, formatTotalPrice, isPriceStale, getTypeCategory, renderLoadError, escapeHtml } from '../utils.js'
import { createCardRow, setEditMode, isEditMode } from '../components/card-row.js'
import { renderCardGroups, matchCommander, updateGroupHeader, addCardToGroups } from '../components/card-list.js'
import { buildCardInsertRow, applyLocalDelete, undoSwap } from '../deck-mutations.js'
import { openSwapPicker } from '../components/swap-picker.js'
import { showToast } from '../components/toast.js'
import { attachCardAutocomplete } from '../components/autocomplete.js'
import { setDefaultPreview } from '../components/card-preview.js'
import { estimateBracket } from '../bracket.js'
import { getPlayer } from '../auth.js'
import { navigate, refreshRoute, routeHref } from '../router.js'

// Render-Generation: async Abschlüsse (Swap, Undo, Add), die NACH einem
// refreshRoute()/Re-Render zurückkommen, dürfen nicht mit veralteten Closures
// in den frischen DOM patchen — bei Generationswechsel wird stattdessen die
// Route neu geladen (holt den echten DB-Stand). Critic [HIGH].
let renderGeneration = 0

export async function renderDeckView(container, params) {
  const { id } = params
  const myGeneration = ++renderGeneration
  const isStale = () => myGeneration !== renderGeneration
  container.innerHTML = '<p class="loading">Lade Deck...</p>'

  let deck, cards
  try {
    ;[deck, cards] = await Promise.all([getDeck(id), getDeckCards(id)])
  } catch (err) {
    if (isStale()) return
    renderLoadError(container, err, () => renderDeckView(container, params))
    return
  }
  // Doppel-Navigation-Race (Critic R2 [BLOCKER]): löst eine ÄLTERE, langsamere
  // Deck-Anfrage nach einer neueren auf, darf sie die fertige Seite nicht
  // überschreiben — sonst zeigt die URL Deck B und der Inhalt Deck A.
  if (isStale()) return

  if (!deck) {
    container.innerHTML = '<p>Deck nicht gefunden.</p>'
    return
  }

  const player = getPlayer()
  if (!player && !deck.for_sale) {
    navigate('/login')
    return
  }
  const isOwner = player && player.id === deck.player_id
  const stale = cards.some(c => isPriceStale(c.price_updated_at))
  const totalPrice = formatTotalPrice(cards)
  const isForSale = !!deck.for_sale
  const backHref = isForSale ? routeHref('/resterampe') : routeHref('/my-decks')
  const backLabel = isForSale ? 'Zur Resterampe' : 'Zurück'

  const headerBg = deck.commander_image
    ? `background-image: linear-gradient(to bottom, rgba(15,15,20,0.3), rgba(15,15,20,0.95) 80%), url('${deck.commander_image}')`
    : ''

  // Find commander card image(s) for default preview
  const commanderCard = cards.find(c => matchCommander(c.name, deck.commander))
  const commander2Card = deck.commander2 ? cards.find(c => matchCommander(c.name, deck.commander2)) : null
  const commanderCardImage = commanderCard?.proxy_image_uri || commanderCard?.image_uri || null

  container.innerHTML = `
    <div class="page">
      <div class="deck-header-banner" style="${headerBg}">
        <div class="deck-header">
          <div>
            <a href="${backHref}" class="back-link">&larr; ${backLabel}</a>
            <h2>${deck.name} ${isOwner ? '<button id="edit-deck-meta" class="btn-edit-meta" title="Name/Commander bearbeiten">&#9998;</button>' : ''}</h2>
            <p class="deck-meta">
              Commander: <strong>${deck.commander}</strong>${deck.commander2 ? ` + <strong>${deck.commander2}</strong>` : ''}
              &middot; Spieler: <strong>${deck.players?.name || 'Unbekannt'}</strong>
              &middot; <span id="deck-card-count">${cards.reduce((s, c) => s + (c.quantity || 1), 0)}</span> Karten
            </p>
          </div>
          <div class="deck-value">
            <span class="value-label">Gesamtwert</span>
            <span class="value-amount">${totalPrice}</span>
            ${stale ? '<span class="stale-hint">(veraltet)</span>' : ''}
          </div>
        </div>
      </div>
      ${isForSale ? renderSaleBanner(deck, totalPrice, isOwner) : ''}
      <div class="deck-actions">
        <div class="deck-actions-buttons">
          ${isOwner ? '<button id="refresh-prices" class="btn">Preise aktualisieren</button>' : ''}
          ${isOwner ? '<button id="toggle-edit" class="btn btn-secondary">Bearbeiten</button>' : ''}
          <button id="export-deck" class="btn btn-secondary">Exportieren</button>
          ${isOwner && isForSale ? '<button id="remove-from-sale" class="btn btn-secondary">Aus Resterampe</button>' : ''}
          <div class="sort-controls">
            <label class="sort-label" for="sort-select">Sortierung:</label>
            <select id="sort-select" class="sort-select">
              <option value="type">Typ</option>
              <option value="name">Name</option>
              <option value="cmc">Manakosten</option>
              <option value="price-desc">Preis ↓</option>
              <option value="price-asc">Preis ↑</option>
            </select>
          </div>
        </div>
        ${isOwner ? `
        <div id="add-card-bar" class="add-card-bar" hidden>
          <div class="autocomplete-wrapper">
            <input type="text" id="add-card-input" class="add-card-input" placeholder="Karte hinzufügen..." autocomplete="off" />
            <div id="add-card-list" class="autocomplete-list" hidden></div>
          </div>
          <span id="add-card-status" class="add-card-status"></span>
        </div>
        ` : ''}
      </div>
      <div class="deck-tabs">
        <button class="deck-tab deck-tab-active" data-tab="cards">Karten</button>
        <button class="deck-tab" data-tab="proxy">Proxy Artworks</button>
        ${isOwner ? '<button class="deck-tab" data-tab="wizard">Optimieren</button>' : ''}
      </div>
      <div id="tab-cards">
        <div class="deck-layout">
          <aside class="deck-sidebar">
            <div class="deck-preview-sticky">
              <div id="deck-card-preview">
                ${commanderCardImage ? `<img src="${commanderCardImage}" alt="${deck.commander}" />` : ''}
              </div>
              <div id="deck-stats" class="deck-stats"></div>
            </div>
          </aside>
          <div id="card-groups"></div>
        </div>
        <div id="token-gallery" class="token-gallery" style="display:none">
          <h3 class="group-header">Tokens <button id="copy-tokens" class="btn-copy-tokens" title="Token-Liste kopieren">Kopieren</button></h3>
          <div class="token-grid"></div>
        </div>
      </div>
      <div id="tab-proxy" style="display:none">
        <div id="proxy-artwork-grid" class="proxy-artwork-grid"></div>
      </div>
      <div id="tab-wizard" style="display:none"></div>
    </div>
  `

  setDefaultPreview(commanderCardImage)
  setEditMode(false)
  renderDeckStats(cards)

  // Header-Wert, Kartenzähler und Stats live nachziehen — vorher statisch
  // (Bug c) bzw. nie aufgerufen (Bug b: onChanged wurde nicht durchgereicht).
  // deckMutationCount: jede Deck-Mutation läuft hier durch — der Wizard-Tab
  // nutzt den Zähler, um seine Analyse bei Fremdänderungen zu invalidieren.
  let deckMutationCount = 0
  const updateHeaderAndStats = () => {
    deckMutationCount++
    const amountEl = container.querySelector('.value-amount')
    if (amountEl) amountEl.textContent = formatTotalPrice(cards)
    const countEl = document.getElementById('deck-card-count')
    if (countEl) countEl.textContent = cards.reduce((s, c) => s + (c.quantity || 1), 0)
    renderDeckStats(cards)
  }
  const onCardChanged = (card, section, info = {}) => {
    if (info.removed) applyLocalDelete(cards, card.id)
    if (section) updateGroupHeader(section)
    updateHeaderAndStats()
  }

  let currentSort = 'type'
  const rerender = () => renderCardGroups({
    cards,
    commander: deck.commander,
    commander2: deck.commander2,
    sortMode: currentSort,
    onChanged: onCardChanged,
  })
  rerender()

  // In-Place-Update nach einem Swap: gleiche Typ-Gruppe → Zeile ersetzen
  // (null Scroll-Verlust), sonst alte Zeile raus + neue einsortieren.
  const applySwapToUi = (newRow, oldTr) => {
    const section = oldTr?.closest('.card-group')
    const sameGroup = currentSort === 'type'
      && section?.dataset.category === (newRow.type_category || 'other')
    if (sameGroup) {
      oldTr.replaceWith(createCardRow(newRow, onCardChanged))
      updateGroupHeader(section)
    } else {
      oldTr?.remove()
      if (section) updateGroupHeader(section)
      addCardToGroups(newRow, { sortMode: currentSort, onChanged: onCardChanged })
    }
    updateHeaderAndStats()
  }

  const handleSwapped = ({ newRow, removedRow }, oldTr) => {
    if (isStale()) { refreshRoute(); return }
    applySwapToUi(newRow, oldTr)
    showToast({
      message: `${removedRow.name} → ${newRow.name} getauscht`,
      actionLabel: 'Rückgängig',
      onAction: async () => {
        try {
          const res = await undoSwap({ deckId: id, cards, originalRow: removedRow, newRow })
          // Ansicht wurde inzwischen neu aufgebaut? Frisch laden statt mit
          // veralteten Closures in den neuen DOM zu patchen.
          if (isStale()) { refreshRoute(); return }
          // Zeile der getauschten Karte entfernen (falls Undo sie gelöscht hat)
          if (res.status === 'ok') {
            const newTr = [...document.querySelectorAll('#card-groups tbody tr')]
              .find(t => t._card?.id === newRow.id)
            const sec = newTr?.closest('.card-group')
            newTr?.remove()
            if (sec) updateGroupHeader(sec)
          }
          addCardToGroups(res.restored, { sortMode: currentSort, onChanged: onCardChanged })
          updateHeaderAndStats()
          showToast({
            message: res.status === 'ok'
              ? `Rückgängig: ${removedRow.name} ist wieder drin`
              : `„${removedRow.name}" ist wieder drin — „${newRow.name}" bitte manuell entfernen`,
          })
        } catch (err) {
          showToast({ message: `Rückgängig fehlgeschlagen: ${err.message}` })
        }
      },
    })
  }

  document.getElementById('card-groups').addEventListener('card-swap-request', (e) => {
    const { card, tr } = e.detail
    openSwapPicker({
      card,
      deckId: id,
      cards,
      onSwapped: (result) => handleSwapped(result, tr),
    })
  })

  document.getElementById('sort-select')?.addEventListener('change', (e) => {
    currentSort = e.target.value
    rerender()
  })

  document.getElementById('toggle-edit')?.addEventListener('click', () => {
    const btn = document.getElementById('toggle-edit')
    setEditMode(!isEditMode())
    btn.textContent = isEditMode() ? 'Fertig' : 'Bearbeiten'
    btn.classList.toggle('btn-active', isEditMode())
    const addBar = document.getElementById('add-card-bar')
    if (addBar) {
      addBar.hidden = !isEditMode()
      if (!isEditMode()) {
        document.getElementById('add-card-input').value = ''
        document.getElementById('add-card-list').hidden = true
      }
    }
    rerender()
  })

  if (isOwner) {
    document.getElementById('refresh-prices')?.addEventListener('click', async () => {
      // Nach Wegnavigieren keine fremde Seite zwangs-rerendern (Critic R2 [HIGH])
      await refreshPrices(id, cards, () => { if (!isStale()) refreshRoute() })
    })
  }

  document.getElementById('export-deck')?.addEventListener('click', () => {
    exportDeck(deck, cards)
  })

  document.getElementById('edit-deck-meta')?.addEventListener('click', () => {
    showMetaEditor(deck, () => { if (!isStale()) refreshRoute() })
  })

  // Zwei-Stufen-Button statt natives confirm(): erster Klick scharfschalten,
  // zweiter Klick führt aus; 5s ohne zweiten Klick entschärft wieder
  const removeFromSaleBtn = document.getElementById('remove-from-sale')
  removeFromSaleBtn?.addEventListener('click', async () => {
    if (removeFromSaleBtn.dataset.armed !== '1') {
      removeFromSaleBtn.dataset.armed = '1'
      removeFromSaleBtn.textContent = 'Wirklich entfernen?'
      removeFromSaleBtn.classList.add('btn-danger-armed')
      setTimeout(() => {
        removeFromSaleBtn.dataset.armed = ''
        removeFromSaleBtn.textContent = 'Aus Resterampe'
        removeFromSaleBtn.classList.remove('btn-danger-armed')
      }, 5000)
      return
    }
    await updateDeck(deck.id, { for_sale: false, sold: false })
    if (isStale()) return
    refreshRoute()
  })

  document.getElementById('toggle-sold')?.addEventListener('click', async () => {
    const newSold = !deck.sold
    await updateDeck(deck.id, { sold: newSold })
    if (isStale()) return
    refreshRoute()
  })

  document.getElementById('edit-sale-meta')?.addEventListener('click', () => {
    showSaleMetaEditor(deck, () => { if (!isStale()) refreshRoute() })
  })

  // Tab switching (Karten / Proxy Artworks / Optimieren)
  // -1 = nie gerendert; sonst der deckMutationCount des letzten Wizard-Renders —
  // Edits im Karten-Tab invalidieren die Wizard-Analyse (Critic-Fund)
  let wizardRenderedFor = -1
  container.querySelectorAll('.deck-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      // Klick auf den bereits aktiven Tab: nichts neu rendern/animieren
      if (tab.classList.contains('deck-tab-active')) return
      container.querySelectorAll('.deck-tab').forEach(t => t.classList.remove('deck-tab-active'))
      tab.classList.add('deck-tab-active')
      const target = tab.dataset.tab
      for (const key of ['cards', 'proxy', 'wizard']) {
        const el = document.getElementById(`tab-${key}`)
        if (el) el.style.display = target === key ? '' : 'none'
      }
      if (target === 'proxy') {
        renderProxyArtworks(cards, isOwner)
      }
      if (target === 'wizard' && wizardRenderedFor !== deckMutationCount) {
        wizardRenderedFor = deckMutationCount
        const wizardEl = document.getElementById('tab-wizard')
        wizardEl.innerHTML = '<p class="loading">Lade Optimierer…</p>'
        // Lazy: Vite code-splittet den Wizard — die Deck-Seite zahlt nichts,
        // solange das Tab nie geöffnet wird
        import('../wizard/index.js')
          .then(m => m.renderWizard({
            container: wizardEl,
            deck,
            cards,
            onDeckChanged: () => {
              if (isStale()) return
              rerender()
              updateHeaderAndStats()
              // Wizard hat das Deck selbst geändert — sein Re-Render deckt das ab
              wizardRenderedFor = deckMutationCount
            },
          }))
          .catch(err => {
            wizardRenderedFor = -1
            wizardEl.innerHTML = `<p class="empty">Optimierer konnte nicht geladen werden: ${escapeHtml(err.message)}</p>`
          })
      }
      const panel = document.getElementById(`tab-${target}`)
      panel.classList.remove('tab-panel-enter')
      void panel.offsetWidth // Reflow erzwingen, sonst startet die Animation nicht neu
      panel.classList.add('tab-panel-enter')
    })
  })

  // Add card autocomplete — neue Karte wird gezielt einsortiert statt
  // Voll-Rerender (Scroll-/Fokus-Erhalt)
  if (isOwner) {
    setupAddCard(id, cards, deck, (newRow) => {
      if (isStale()) { refreshRoute(); return }
      currentSort = document.getElementById('sort-select')?.value || 'type'
      addCardToGroups(newRow, { sortMode: currentSort, onChanged: onCardChanged })
      updateHeaderAndStats()
    })
  }

  // Load tokens in background
  loadTokens(cards)
}

function setupAddCard(deckId, cards, deck, onAdded) {
  const input = document.getElementById('add-card-input')
  const list = document.getElementById('add-card-list')
  const status = document.getElementById('add-card-status')
  if (!input || !list) return

  // Geteilter Autocomplete-Kern (Race-Guard + Thumbnails/Preise) — dieselbe
  // Komponente wie im Swap-Picker
  const autocomplete = attachCardAutocomplete({
    input,
    listEl: list,
    limit: 8,
    onPick: (item) => addCardToDeck(item.name),
  })

  async function addCardToDeck(cardName) {
    autocomplete.clear()
    input.value = ''

    // Check if card already exists in deck
    const existing = cards.find(c => c.name.toLowerCase() === cardName.toLowerCase())
    if (existing) {
      status.textContent = `"${cardName}" ist bereits im Deck`
      status.className = 'add-card-status add-card-status-warn'
      setTimeout(() => { status.textContent = '' }, 2500)
      input.focus()
      return
    }

    status.textContent = 'Lade...'
    status.className = 'add-card-status'

    try {
      // Row-Aufbau + cheapest_eur-Override leben jetzt in deck-mutations.js
      // (eine Wahrheit für Add-Bar, Swap-Picker und Wizard-Apply)
      const cardRow = await buildCardInsertRow(deckId, cardName)
      if (!cardRow) {
        status.textContent = `"${cardName}" nicht gefunden`
        status.className = 'add-card-status add-card-status-warn'
        setTimeout(() => { status.textContent = '' }, 2500)
        return
      }

      // .select() liefert die Row inkl. DB-ID zurück — kein Voll-Refetch mehr
      const [newRow] = await insertCardsReturning([cardRow])
      cards.push(newRow)

      status.textContent = `${newRow.name} hinzugefügt`
      status.className = 'add-card-status add-card-status-ok'
      setTimeout(() => { status.textContent = '' }, 2000)

      onAdded(newRow)
      input.focus()
    } catch (err) {
      status.textContent = `Fehler: ${err.message}`
      status.className = 'add-card-status add-card-status-warn'
      setTimeout(() => { status.textContent = '' }, 3000)
    }
  }
}

async function loadTokens(cards) {
  try {
    const names = cards.map(c => c.name)
    const { found } = await fetchCardCollection(names)
    const tokenMap = extractTokenRefs(found)
    if (tokenMap.size === 0) return

    const tokens = await fetchTokenDetails(tokenMap)
    if (tokens.length === 0) return

    const gallery = document.getElementById('token-gallery')
    if (!gallery) return

    const grid = gallery.querySelector('.token-grid')
    grid.innerHTML = tokens.map(t =>
      `<div class="token-card">
        <img src="${t.image}" alt="${t.name}" loading="lazy" />
        <span class="token-name">${t.name}</span>
      </div>`
    ).join('')
    gallery.style.display = ''

    document.getElementById('copy-tokens')?.addEventListener('click', () => {
      const list = tokens.map(t => `1 ${t.name}`).join('\n')
      navigator.clipboard.writeText(list).then(() => {
        const btn = document.getElementById('copy-tokens')
        btn.textContent = 'Kopiert!'
        setTimeout(() => { btn.textContent = 'Kopieren' }, 1500)
      })
    })
  } catch { /* tokens are non-critical */ }
}

// matchCommander/renderCardGroups/getSortFn/buildGroupSection leben jetzt in
// src/components/card-list.js — Edit v2 braucht dort In-Place-Updates.

function renderDeckStats(cards) {
  const el = document.getElementById('deck-stats')
  if (!el) return

  // Mana curve (exclude lands)
  const cmcBuckets = {}
  let maxCount = 0
  for (const c of cards) {
    if (c.type_category === 'land') continue
    const cmc = Math.min(c.cmc || 0, 7) // 7+ grouped
    const label = cmc >= 7 ? '7+' : String(cmc)
    cmcBuckets[label] = (cmcBuckets[label] || 0) + c.quantity
    if (cmcBuckets[label] > maxCount) maxCount = cmcBuckets[label]
  }

  const bucketLabels = ['0', '1', '2', '3', '4', '5', '6', '7+']
  const curveHtml = bucketLabels.map(label => {
    const count = cmcBuckets[label] || 0
    const pct = maxCount > 0 ? (count / maxCount) * 100 : 0
    return `
      <div class="curve-col">
        <span class="curve-count">${count || ''}</span>
        <div class="curve-bar-wrap"><div class="curve-bar" style="height:${pct}%"></div></div>
        <span class="curve-label">${label}</span>
      </div>
    `
  }).join('')

  // Average CMC (exclude lands)
  const nonLands = cards.filter(c => c.type_category !== 'land')
  const totalCmc = nonLands.reduce((s, c) => s + (c.cmc || 0) * c.quantity, 0)
  const totalNonLand = nonLands.reduce((s, c) => s + c.quantity, 0)
  const avgCmc = totalNonLand > 0 ? (totalCmc / totalNonLand).toFixed(1) : '0'

  // Bracket estimation
  const bracket = estimateBracket(cards)
  const bracketDots = [1, 2, 3, 4, 5].map(i =>
    `<span class="bracket-dot ${i <= bracket.bracket ? 'bracket-dot-active' : ''}">${i}</span>`
  ).join('')

  const gcHtml = bracket.gameChangerCount > 0
    ? `<div class="bracket-detail bracket-detail-gc">${bracket.gameChangerCount} Game Changer${bracket.gameChangerCount > 1 ? '' : ''}</div>`
    : ''
  const tutorHtml = bracket.tutorCount > 0
    ? `<div class="bracket-detail bracket-detail-tutor">${bracket.tutorCount} Tutors</div>`
    : ''
  const flagsHtml = [
    bracket.hasExtraTurns ? '<div class="bracket-detail bracket-detail-extra">Extra Turns</div>' : '',
    bracket.hasMLD ? '<div class="bracket-detail bracket-detail-mld">MLD</div>' : '',
  ].filter(Boolean).join('')

  // Legality check
  const illegalCards = cards.filter(c => c.commander_legality && c.commander_legality !== 'legal')
  const bannedCards = illegalCards.filter(c => c.commander_legality === 'banned')
  const notLegalCards = illegalCards.filter(c => c.commander_legality === 'not_legal')
  const restrictedCards = illegalCards.filter(c => c.commander_legality === 'restricted')

  let legalityHtml = ''
  if (illegalCards.length > 0) {
    const items = []
    if (bannedCards.length > 0) items.push(`<span class="legality-stat-banned">${bannedCards.length} banned</span>`)
    if (notLegalCards.length > 0) items.push(`<span class="legality-stat-notlegal">${notLegalCards.length} not legal</span>`)
    if (restrictedCards.length > 0) items.push(`<span class="legality-stat-restricted">${restrictedCards.length} restricted</span>`)

    legalityHtml = `
    <div class="stat-section">
      <div class="stat-header">Legalität</div>
      <div class="legality-warning">
        <span class="legality-warning-icon">⚠</span>
        <span>${illegalCards.length} Karte${illegalCards.length > 1 ? 'n' : ''} nicht legal</span>
      </div>
      <div class="legality-breakdown">${items.join(' · ')}</div>
      <div class="legality-card-list">
        ${illegalCards.map(c => `<div class="legality-card-item">${c.name}</div>`).join('')}
      </div>
    </div>`
  } else {
    legalityHtml = `
    <div class="stat-section">
      <div class="stat-header">Legalität</div>
      <div class="legality-ok">✓ Commander-legal</div>
    </div>`
  }

  el.innerHTML = `
    <div class="stat-section">
      <div class="stat-header">Manakurve <span class="stat-hint">⌀ ${avgCmc}</span></div>
      <div class="mana-curve">${curveHtml}</div>
    </div>
    <div class="stat-section">
      <div class="stat-header">Bracket</div>
      <div class="bracket-display">
        <div class="bracket-dots">${bracketDots}</div>
        <span class="bracket-label">${bracket.label}</span>
      </div>
      <div class="bracket-details">
        ${gcHtml}${tutorHtml}${flagsHtml}
      </div>
    </div>
    ${legalityHtml}
  `
}

function showMetaEditor(deck, onSaved = refreshRoute) {
  const btn = document.getElementById('edit-deck-meta')
  if (document.getElementById('meta-editor')) return

  const editor = document.createElement('div')
  editor.id = 'meta-editor'
  editor.className = 'meta-editor'
  editor.innerHTML = `
    <label>
      Deckname
      <input type="text" id="edit-deck-name" value="${deck.name}" />
    </label>
    <label>
      Commander
      <input type="text" id="edit-deck-commander" value="${deck.commander}" />
    </label>
    <label>
      Partner Commander <span class="meta-hint">(leer lassen wenn kein Partner)</span>
      <input type="text" id="edit-deck-commander2" value="${deck.commander2 || ''}" />
    </label>
    <div class="meta-editor-actions">
      <button id="save-meta" class="btn">Speichern</button>
      <button id="cancel-meta" class="btn btn-secondary">Abbrechen</button>
    </div>
  `

  btn.closest('.deck-header').querySelector('div').appendChild(editor)

  document.getElementById('cancel-meta').addEventListener('click', () => {
    editor.remove()
  })

  document.getElementById('save-meta').addEventListener('click', async () => {
    const newName = document.getElementById('edit-deck-name').value.trim()
    const newCommander = document.getElementById('edit-deck-commander').value.trim()
    const newCommander2 = document.getElementById('edit-deck-commander2').value.trim() || null
    if (!newName || !newCommander) return

    const saveBtn = document.getElementById('save-meta')
    saveBtn.disabled = true
    saveBtn.textContent = 'Speichere...'

    try {
      const updates = { name: newName, commander: newCommander, commander2: newCommander2 }

      // Update commander image if commander changed
      if (newCommander.toLowerCase() !== deck.commander.toLowerCase()) {
        const card = await fetchCardByName(newCommander)
        updates.commander_image = card ? getCardArtCrop(card) : null
      }

      // Update commander2 image if changed
      if ((newCommander2 || '') !== (deck.commander2 || '')) {
        if (newCommander2) {
          const card2 = await fetchCardByName(newCommander2)
          updates.commander2_image = card2 ? getCardArtCrop(card2) : null
        } else {
          updates.commander2_image = null
        }
      }

      await updateDeck(deck.id, updates)
      onSaved()
    } catch (err) {
      saveBtn.textContent = `Fehler: ${err.message}`
      saveBtn.disabled = false
    }
  })
}

async function refreshPrices(deckId, cards, onDone = refreshRoute) {
  const btn = document.getElementById('refresh-prices')
  btn.disabled = true

  // Fortschritt IM Button statt replaceWith — der Button behält seine Box,
  // nichts im Aktionsbereich verschiebt sich (min-width fixiert die Breite)
  btn.style.minWidth = `${btn.offsetWidth}px`
  btn.classList.add('btn-progress')
  btn.innerHTML = `
    <span class="btn-progress-fill" id="progress-fill"></span>
    <span class="btn-progress-text" id="progress-text">Scryfall abfragen...</span>
  `

  const fill = document.getElementById('progress-fill')
  const text = document.getElementById('progress-text')

  const setProgress = (pct, label) => {
    fill.style.width = `${pct}%`
    text.textContent = label
  }

  try {
    // Step 1: Fetch legality from Scryfall collection API
    setProgress(10, 'Legalität prüfen...')
    const names = cards.map(c => c.name)
    const { found } = await fetchCardCollection(names)

    const nameToId = {}
    for (const c of cards) {
      nameToId[c.name.toLowerCase()] = c.id
    }

    const legalityMap = {}
    for (const sc of found) {
      const cardId = nameToId[sc.name.toLowerCase()]
      if (cardId && sc.legalities?.commander) {
        legalityMap[cardId] = sc.legalities.commander
      }
    }

    // Step 2: Fetch cheapest prices from pre-synced Supabase table
    setProgress(40, 'Günstigste Preise laden...')
    const priceLookup = await fetchCheapestPrices(cards.map(c => c.name))

    const priceMap = {}
    for (const c of cards) {
      const info = priceLookup.get(c.name)
      if (info) priceMap[c.id] = info
    }

    setProgress(70, `${Object.keys(priceMap).length} Preise speichern...`)
    await updateCardPrices(deckId, priceMap, legalityMap)

    setProgress(100, 'Fertig!')
    setTimeout(() => {
      // Re-Render über den Aufrufer — der prüft, ob die Seite noch aktiv ist
      onDone()
    }, 500)
  } catch (err) {
    setProgress(0, `Fehler: ${err.message}`)
    // Nach Fehler wieder klickbar machen, Button-Label + Breiten-Lock zurücksetzen
    setTimeout(() => {
      btn.classList.remove('btn-progress')
      btn.textContent = 'Preise aktualisieren'
      btn.style.minWidth = ''
      btn.disabled = false
    }, 3000)
  }
}

// escapeHtml kommt aus src/utils.js (eine geteilte Wahrheit statt lokaler Kopien)

// Basics haben je ~850 Druckvarianten — vom Vorladen ausgenommen (s. renderProxyArtworks)
const BASIC_LANDS = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes'])

// --- Printings Cache ---
// v4: image_small ergänzt, Ablage in localStorage statt sessionStorage
const PRINTS_CACHE_VER = 'v4'
const PRINTS_TTL_MS = 7 * 24 * 60 * 60 * 1000
const printingsCache = new Map()
let prefetchInFlight = false

function clearStoredPrintings() {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('prints:')) localStorage.removeItem(key)
  }
}

// Alte Cache-Versionen verwerfen — auch die frühere sessionStorage-Ablage
if (localStorage.getItem('prints:ver') !== PRINTS_CACHE_VER) {
  clearStoredPrintings()
  localStorage.setItem('prints:ver', PRINTS_CACHE_VER)
}
for (const key of Object.keys(sessionStorage)) {
  if (key.startsWith('prints:')) sessionStorage.removeItem(key)
}

function readStoredPrintings(name) {
  const raw = localStorage.getItem(`prints:${name}`)
  if (!raw) return null
  try {
    const { t, p } = JSON.parse(raw)
    if (!Array.isArray(p) || !t || Date.now() - t > PRINTS_TTL_MS) {
      localStorage.removeItem(`prints:${name}`)
      return null
    }
    return p
  } catch {
    localStorage.removeItem(`prints:${name}`)
    return null
  }
}

function storePrintings(name, printings) {
  const payload = JSON.stringify({ t: Date.now(), p: printings })
  try {
    localStorage.setItem(`prints:${name}`, payload)
  } catch {
    // Quota voll: alten Bestand verwerfen und diesen Eintrag nochmal versuchen
    clearStoredPrintings()
    localStorage.setItem('prints:ver', PRINTS_CACHE_VER)
    try {
      localStorage.setItem(`prints:${name}`, payload)
    } catch { /* dann eben nur im Speicher */ }
  }
}

function cachePrintings(name, printings) {
  const key = name.toLowerCase()
  printingsCache.set(key, printings)
  storePrintings(key, printings)
}

async function prefetchPrintings(cardNames) {
  // Re-entrancy guard: renderProxyArtworks() re-runs on every tab switch, and a
  // sequential prefetch of a big deck takes a while. Without this, overlapping
  // runs would request the same uncached names concurrently — reproducing the
  // very burst this throttling is meant to prevent.
  if (prefetchInFlight) return
  prefetchInFlight = true
  try {
    const toFetch = cardNames.filter(n => !printingsCache.has(n.toLowerCase()))
    // Was schon auf der Platte liegt, muss nicht erneut geholt werden
    for (let i = toFetch.length - 1; i >= 0; i--) {
      const cached = readStoredPrintings(toFetch[i].toLowerCase())
      if (cached) {
        printingsCache.set(toFetch[i].toLowerCase(), cached)
        toFetch.splice(i, 1)
      }
    }
    if (toFetch.length === 0) return

    // Erste Wahl: der täglich gesyncte card_printings-Cache — eine Supabase-
    // Query-Runde fürs ganze Deck, kein Rate-Limit, kein Warten.
    let rest = toFetch
    const fromDb = await fetchPrintingsFromDB(toFetch)
    if (fromDb) {
      rest = []
      for (const name of toFetch) {
        const hit = fromDb.get(name.toLowerCase())
        if (hit) cachePrintings(name, hit)
        else rest.push(name)
      }
    }
    if (rest.length === 0) return

    // Scryfall-Fallback (Tabelle fehlt / Name noch nicht gesynct): Sammel-
    // Abfrage, ~10 Abrufe für ein ganzes Deck statt einem pro Karte. Namen,
    // die dabei nichts liefern, holt der Einzelabruf beim Öffnen nach (der
    // kennt Retries) — ein Fehlschlag darf sich nie als leeres Ergebnis im
    // Cache festsetzen.
    const found = await fetchPrintingsBulk(rest, {
      onChunk: (map) => {
        for (const [key, printings] of map) {
          if (!printingsCache.has(key)) cachePrintings(key, printings)
        }
      },
    })
    for (const [key, printings] of found) {
      if (!printingsCache.has(key)) cachePrintings(key, printings)
    }
  } catch (err) {
    console.warn('prefetchPrintings failed:', err)
  } finally {
    prefetchInFlight = false
  }
}

function renderProxyArtworks(cards, isOwner) {
  const container = document.getElementById('proxy-artwork-grid')
  if (!container) return

  // Group by type like cards tab
  const groups = groupCardsByType(cards)
  container.innerHTML = ''

  for (const group of groups) {
    // Deduplicate within group
    const unique = []
    const seen = new Set()
    for (const c of group.cards) {
      if (seen.has(c.name.toLowerCase())) continue
      seen.add(c.name.toLowerCase())
      unique.push(c)
    }

    const section = document.createElement('div')
    section.className = 'proxy-group'
    section.innerHTML = `<h3 class="group-header">${group.label} (${unique.length})</h3>`

    const grid = document.createElement('div')
    grid.className = 'proxy-card-grid'

    unique.forEach((c, i) => {
      const imgSrc = c.proxy_image_uri || c.image_uri
      const div = document.createElement('div')
      div.className = 'proxy-card'
      div.style.setProperty('--stagger', String(Math.min(i, 8)))
      div.dataset.cardId = c.id
      div.dataset.cardName = c.name
      div.innerHTML = `
        <div class="proxy-card-img-wrap">
          <img src="${imgSrc || ''}" alt="${c.name}" loading="lazy" />
          ${c.proxy_image_uri ? '<span class="proxy-custom-badge">Custom</span>' : ''}
        </div>
        <div class="proxy-card-info">
          <span class="proxy-card-name">${c.name}</span>
          <span class="proxy-card-qty">${c.quantity}x</span>
        </div>
      `
      if (isOwner) {
        div.style.cursor = 'pointer'
        div.addEventListener('click', () => openArtworkPicker(c, div, cards))
      }
      grid.appendChild(div)
    })

    section.appendChild(grid)
    container.appendChild(section)
  }

  // Im Hintergrund vorladen — in ANZEIGE-Reihenfolge, damit die Karten oben
  // im Raster (die zuerst angetippt werden) als erste bereit sind.
  // Basics bleiben aussen vor: Island/Plains/Swamp haben zusammen ~2500
  // Druckvarianten und dominieren damit die Ladezeit. Beim Antippen werden
  // sie ganz normal einzeln geholt (~0,3s).
  const displayOrder = [...new Set(
    [...container.querySelectorAll('.proxy-card')].map(el => el.dataset.cardName)
  )].filter(n => !BASIC_LANDS.has(n))
  prefetchPrintings(displayOrder)
}

let closeActiveArtworkPicker = null

// Inline-Fehlerzeile im Picker statt natives alert() — bricht das Sheet-Design
// nicht und verschwindet von selbst
function showPickerError(pickerGrid, message) {
  let el = pickerGrid.querySelector('.artwork-picker-error')
  if (!el) {
    el = document.createElement('p')
    el.className = 'artwork-picker-error'
    pickerGrid.prepend(el)
  }
  el.textContent = `Fehler beim Speichern: ${message}`
  clearTimeout(el._timer)
  el._timer = setTimeout(() => el.remove(), 4000)
}

async function openArtworkPicker(card, cardEl, allCards) {
  // Alte Instanz sauber schließen (inkl. Listener), nie roh entfernen
  if (closeActiveArtworkPicker) closeActiveArtworkPicker()
  // Eine noch ausblendende Instanz sofort entfernen — sonst doppelte IDs
  document.getElementById('artwork-picker-modal')?.remove()

  const modal = document.createElement('div')
  modal.id = 'artwork-picker-modal'
  modal.className = 'artwork-picker-overlay'
  modal.innerHTML = `
    <div class="artwork-picker" role="dialog" aria-modal="true" aria-label="Artwork wählen: ${card.name}" tabindex="-1">
      <div class="artwork-picker-header">
        <h3>${card.name}</h3>
        <input type="text" class="artwork-search" placeholder="Set suchen..." />
        <button class="artwork-picker-close" aria-label="Schließen">&times;</button>
        <select class="artwork-set-select" aria-label="Set auswählen" hidden></select>
      </div>
      <div class="artwork-picker-grid">
        <p class="loading">Lade Printings...</p>
      </div>
    </div>
  `
  document.body.appendChild(modal)
  document.body.classList.add('modal-open')
  requestAnimationFrame(() => modal.classList.add('visible'))

  const openPath = location.pathname
  function onRouteChange() {
    // refreshRoute() re-rendert ohne Pfadwechsel (z.B. nach Preis-Refresh)
    // — nur bei ECHTER Navigation schließen
    if (location.pathname !== openPath) closeModal()
  }
  function onKeyDown(e) {
    if (e.key === 'Escape') closeModal()
  }
  let closing = false
  function closeModal() {
    if (closing) return
    closing = true
    window.removeEventListener('route-change', onRouteChange)
    document.removeEventListener('keydown', onKeyDown)
    document.body.classList.remove('modal-open')
    if (closeActiveArtworkPicker === closeModal) closeActiveArtworkPicker = null
    modal.classList.remove('visible')
    modal.classList.add('closing')
    // Timer statt transitionend: feuert auch bei reduced motion zuverlaessig
    setTimeout(() => modal.remove(), 300)
  }
  closeActiveArtworkPicker = closeModal

  modal.querySelector('.artwork-picker-close').addEventListener('click', closeModal)
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal() })
  window.addEventListener('route-change', onRouteChange)
  document.addEventListener('keydown', onKeyDown)

  // aria-modal verlangt, dass der Fokus in den Dialog wandert — auf ALLEN
  // Geräten und vor jedem Early-Return (Fehler-/Leer-Zustand)
  modal.querySelector('.artwork-picker').focus()

  const pickerGrid = modal.querySelector('.artwork-picker-grid')
  const searchInput = modal.querySelector('.artwork-search')

  try {
    // Quellen-Reihenfolge: Cache → card_printings-DB (eine schnelle Query,
    // deckt auch Basics ab) → Scryfall-Einzelabruf als letzter Fallback.
    let printings = printingsCache.get(card.name.toLowerCase())
      || readStoredPrintings(card.name.toLowerCase())
    if (!printings) {
      const fromDb = await fetchPrintingsFromDB([card.name])
      printings = fromDb?.get(card.name.toLowerCase()) || null
    }
    if (!printings) {
      printings = await fetchCardPrintings(card.name)
    }
    // Cache a real result (incl. a genuine empty array) but never a null
    // failure — that would stick for the session; on reopen it retries.
    if (printings && !printingsCache.has(card.name.toLowerCase())) {
      cachePrintings(card.name, printings)
    }

    if (printings === null) {
      pickerGrid.innerHTML = '<p>Konnte Artworks nicht laden. Bitte nochmal öffnen.</p>'
      return
    }

    if (printings.length === 0) {
      pickerGrid.innerHTML = '<p>Keine Printings gefunden.</p>'
      return
    }

    // Set-Auswahl füllen: jedes Set einmal, neueste zuerst, mit Anzahl
    const setSelect = modal.querySelector('.artwork-set-select')
    const setsByCode = new Map()
    for (const p of printings) {
      const entry = setsByCode.get(p.set_code)
      if (entry) {
        entry.count++
        if (p.released && p.released > entry.released) entry.released = p.released
      } else {
        setsByCode.set(p.set_code, { name: p.set, code: p.set_code, released: p.released || '', count: 1 })
      }
    }
    const sets = [...setsByCode.values()].sort((a, b) => b.released.localeCompare(a.released))
    setSelect.innerHTML = `<option value="">Alle Sets (${printings.length})</option>`
      + sets.map(s =>
        `<option value="${escapeHtml(s.code)}">${escapeHtml(s.name)} (${s.released.substring(0, 4) || '?'})${s.count > 1 ? ` · ${s.count}` : ''}</option>`
      ).join('')
    // Bei nur einem Set bringt die Auswahl nichts
    setSelect.hidden = sets.length < 2

    // animate nur beim ersten Aufbau — sonst flackert das Grid bei jedem
    // Tastendruck in der Suche neu ein
    function renderPrintings(filter, animate = false) {
      const query = (filter || '').toLowerCase()
      const setCode = setSelect.value
      const filtered = printings.filter(p => {
        if (setCode && p.set_code !== setCode) return false
        if (!query) return true
        return p.set.toLowerCase().includes(query) || p.set_code.toLowerCase().includes(query)
      })

      // Die Reset-Kachel ist ein Bedienelement, kein Printing — sie bleibt
      // auch bei aktivem Set-Filter erreichbar
      let resetHtml = ''
      if (card.proxy_image_uri && !query) {
        resetHtml = `
          <div class="artwork-option artwork-reset" data-action="reset">
            <div class="artwork-option-img-wrap">
              <img src="${card.image_uri}" alt="Default" decoding="async" />
            </div>
            <span class="artwork-option-set">Default zuruecksetzen</span>
          </div>
        `
      }

      pickerGrid.innerHTML = resetHtml + (filtered.length === 0
        ? `<p class="artwork-no-results">Kein Artwork gefunden${filter ? ` für "${escapeHtml(filter)}"` : ''}${setCode ? ` im Set ${escapeHtml(setsByCode.get(setCode)?.name || setCode)}` : ''}</p>`
        : filtered.map(p => {
          const isSelected = card.proxy_image_uri === p.image_normal || (!card.proxy_image_uri && card.image_uri === p.image_normal)
          return `
            <div class="artwork-option ${isSelected ? 'artwork-selected' : ''}" data-image="${p.image_normal}" data-png="${p.image_png || p.image_normal}">
              <div class="artwork-option-img-wrap">
                <img src="${p.image_small || p.image_normal}" alt="${escapeHtml(p.set)}" loading="lazy" decoding="async" />
              </div>
              <span class="artwork-option-set">${escapeHtml(p.set)} (${p.released?.substring(0, 4) || '?'})</span>
            </div>
          `
        }).join(''))

      pickerGrid.querySelectorAll('.artwork-option').forEach((opt, i) => {
        if (animate) {
          // Nur die ersten Reihen staffeln — sonst warten spaete Optionen sichtbar
          opt.style.setProperty('--stagger', String(Math.min(i, 8)))
        } else {
          opt.style.animation = 'none'
        }
        opt.addEventListener('click', async () => {
          if (opt.classList.contains('artwork-picking')) return
          opt.classList.add('artwork-picking')
          const isReset = opt.dataset.action === 'reset'
          const newUri = isReset ? null : opt.dataset.png || opt.dataset.image

          try {
            await updateCardProxyImage(card.id, newUri)
            card.proxy_image_uri = newUri

            for (const c of allCards) {
              if (c.name.toLowerCase() === card.name.toLowerCase()) {
                c.proxy_image_uri = newUri
              }
            }

            const img = cardEl.querySelector('img')
            img.src = newUri || card.image_uri
            const badge = cardEl.querySelector('.proxy-custom-badge')
            if (newUri && !badge) {
              cardEl.querySelector('.proxy-card-img-wrap').insertAdjacentHTML('beforeend', '<span class="proxy-custom-badge">Custom</span>')
            } else if (!newUri && badge) {
              badge.remove()
            }

            closeModal()
          } catch (err) {
            opt.classList.remove('artwork-picking')
            showPickerError(pickerGrid, err.message)
          }
        })
      })
    }

    renderPrintings('', true)
    searchInput.addEventListener('input', () => renderPrintings(searchInput.value))
    setSelect.addEventListener('change', () => renderPrintings(searchInput.value))
    // Auto-Focus nur auf Geraeten mit Maus — auf Touch wuerde sofort die Tastatur aufspringen
    if (window.matchMedia('(hover: hover)').matches) searchInput.focus()
  } catch (err) {
    pickerGrid.innerHTML = `<p>Fehler: ${err.message}</p>`
  }
}

function exportDeck(deck, cards) {
  const cmdLine = deck.commander2 ? `// Commander: ${deck.commander} + ${deck.commander2}` : `// Commander: ${deck.commander}`
  const lines = [`// ${deck.name}`, cmdLine, '']
  for (const card of cards) {
    lines.push(`${card.quantity} ${card.name}`)
  }
  const text = lines.join('\n')

  const blob = new Blob([text], { type: 'text/plain' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = `${deck.name.replace(/[^a-zA-Z0-9äöüÄÖÜß ]/g, '')}.txt`
  a.click()
  URL.revokeObjectURL(a.href)
}

function renderSaleBanner(deck, singlesTotal, isOwner) {
  const isCustom = deck.deck_type === 'custom'
  const sealed = deck.sealed_price_eur != null ? formatPrice(deck.sealed_price_eur) : '—'
  const archetype = deck.archetype || ''
  const playstyle = deck.playstyle || ''
  const tagLabel = deck.sold
    ? 'Verkauft'
    : (isCustom ? 'Custom · Zum Verkauf' : 'Precon · Zum Verkauf')

  const pricesHtml = isCustom
    ? `
      <div class="sale-banner-prices">
        <div class="sale-price">
          <span class="sale-price-label">Singles-Wert</span>
          <span class="sale-price-value">${singlesTotal}</span>
        </div>
      </div>
    `
    : `
      <div class="sale-banner-prices">
        <div class="sale-price">
          <span class="sale-price-label">Singles</span>
          <span class="sale-price-value">${singlesTotal}</span>
        </div>
        <div class="sale-price sale-price-sealed">
          <span class="sale-price-label">Sealed</span>
          <span class="sale-price-value">${sealed}</span>
        </div>
      </div>
    `

  return `
    <div class="sale-banner ${deck.sold ? 'sale-banner-sold' : ''}">
      <div class="sale-banner-main">
        <div class="sale-banner-info">
          <div class="sale-banner-title">
            <span class="sale-banner-tag">${tagLabel}</span>
            ${archetype ? `<span class="sale-banner-archetype">${escapeAttr(archetype)}</span>` : ''}
          </div>
          ${playstyle ? `<p class="sale-banner-playstyle">${escapeAttr(playstyle)}</p>` : ''}
        </div>
        ${pricesHtml}
      </div>
      ${isOwner ? `
        <div class="sale-banner-actions">
          <button id="edit-sale-meta" class="btn btn-secondary btn-small">Verkaufs-Info bearbeiten</button>
          <button id="toggle-sold" class="btn ${deck.sold ? 'btn-secondary' : ''} btn-small">${deck.sold ? 'Wieder verfügbar' : 'Als verkauft markieren'}</button>
        </div>
      ` : ''}
    </div>
  `
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c])
}

function showSaleMetaEditor(deck, onSaved = refreshRoute) {
  if (document.getElementById('sale-meta-editor')) return

  const overlay = document.createElement('div')
  overlay.id = 'sale-meta-editor'
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="Verkaufs-Info bearbeiten" tabindex="-1">
      <h3>Verkaufs-Info bearbeiten</h3>
      <label>
        Sealed-Preis (€)
        <input type="number" step="0.01" min="0" id="edit-sealed-price" value="${deck.sealed_price_eur ?? ''}" placeholder="z.B. 39.90" />
      </label>
      <label>
        Archetype
        <input type="text" id="edit-archetype" value="${escapeAttr(deck.archetype || '')}" placeholder="z.B. Token Aggro" />
      </label>
      <label>
        Playstyle (1-2 Sätze)
        <textarea id="edit-playstyle" rows="3" placeholder="Kurze Beschreibung wie sich das Deck spielt...">${escapeAttr(deck.playstyle || '')}</textarea>
      </label>
      <div class="modal-actions">
        <button id="save-sale-meta" class="btn">Speichern</button>
        <button id="cancel-sale-meta" class="btn btn-secondary">Abbrechen</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  document.body.classList.add('modal-open')
  requestAnimationFrame(() => overlay.classList.add('visible'))

  // Dirty-Guard: Wer auf dem Handy neben das Modal tippt (um die Tastatur
  // loszuwerden), darf dabei nicht ungefragt seinen Text verlieren.
  const fields = ['edit-sealed-price', 'edit-archetype', 'edit-playstyle']
    .map(id => document.getElementById(id))
  const initialValues = fields.map(f => f.value)
  const isDirty = () => fields.some((f, i) => f.value !== initialValues[i])

  let closing = false
  const close = () => {
    if (closing) return
    closing = true
    window.removeEventListener('route-change', onRouteChange)
    document.removeEventListener('keydown', onKeyDown)
    document.body.classList.remove('modal-open')
    overlay.classList.remove('visible')
    overlay.classList.add('closing')
    // Timer statt transitionend: feuert auch bei reduced motion zuverlaessig
    setTimeout(() => overlay.remove(), 300)
  }
  const requestClose = () => {
    if (isDirty() && !confirm('Änderungen verwerfen?')) return
    close()
  }
  const openPath = location.pathname
  function onRouteChange() {
    if (location.pathname === openPath) return
    // Navigation (Back-Geste etc.) ist zu diesem Zeitpunkt schon passiert —
    // aufhalten geht nicht mehr. Bei ungespeicherten Eingaben entscheidet der
    // Nutzer: behalten (Modal bleibt bewusst über der neuen Seite offen,
    // Speichern wirkt weiter auf dieses Deck) oder verwerfen (Modal schließt,
    // die neue Seite ist frei). Sauberes Modal schließt kommentarlos.
    if (isDirty() && confirm('Ungespeicherte Verkaufs-Infos behalten?')) return
    close()
  }
  function onKeyDown(e) {
    if (e.key === 'Escape') requestClose()
  }
  window.addEventListener('route-change', onRouteChange)
  document.addEventListener('keydown', onKeyDown)
  overlay.addEventListener('click', e => { if (e.target === overlay) requestClose() })
  document.getElementById('cancel-sale-meta').addEventListener('click', requestClose)
  overlay.querySelector('.modal').focus()

  document.getElementById('save-sale-meta').addEventListener('click', async () => {
    const priceVal = document.getElementById('edit-sealed-price').value.trim()
    const archetype = document.getElementById('edit-archetype').value.trim() || null
    const playstyle = document.getElementById('edit-playstyle').value.trim() || null
    const sealed_price_eur = priceVal === '' ? null : parseFloat(priceVal)

    const btn = document.getElementById('save-sale-meta')
    btn.disabled = true
    btn.textContent = 'Speichere...'

    try {
      await updateDeck(deck.id, { sealed_price_eur, archetype, playstyle })
      close()
      onSaved()
    } catch (err) {
      btn.disabled = false
      btn.textContent = `Fehler: ${err.message}`
    }
  })
}

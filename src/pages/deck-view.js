import { getDeck, getDeckCards, updateCardPrices, updateDeck } from '../supabase.js'
import { fetchCardCollection, extractCardData, fetchCardByName, getCardArtCrop, getPartnerType, extractTokenRefs, fetchTokenDetails } from '../scryfall.js'
import { groupCardsByType, formatPrice, formatTotalPrice, isPriceStale } from '../utils.js'
import { createCardRow, setEditMode, isEditMode } from '../components/card-row.js'
import { setDefaultPreview } from '../components/card-preview.js'
import { estimateBracket } from '../bracket.js'
import { getPlayer } from '../auth.js'
import { navigate } from '../router.js'

export async function renderDeckView(container, params) {
  const { id } = params
  container.innerHTML = '<p class="loading">Lade Deck...</p>'

  const [deck, cards] = await Promise.all([getDeck(id), getDeckCards(id)])

  if (!deck) {
    container.innerHTML = '<p>Deck nicht gefunden.</p>'
    return
  }

  const player = getPlayer()
  const isOwner = player && player.id === deck.player_id
  const stale = cards.some(c => isPriceStale(c.price_updated_at))
  const totalPrice = formatTotalPrice(cards)

  const headerBg = deck.commander_image
    ? `background-image: linear-gradient(to bottom, rgba(15,15,20,0.3), rgba(15,15,20,0.95) 80%), url('${deck.commander_image}')`
    : ''

  // Find commander card image(s) for default preview
  const commanderCard = cards.find(c => c.name.toLowerCase() === deck.commander?.toLowerCase())
  const commander2Card = deck.commander2 ? cards.find(c => c.name.toLowerCase() === deck.commander2.toLowerCase()) : null
  const commanderCardImage = commanderCard?.image_uri || null

  container.innerHTML = `
    <div class="page">
      <div class="deck-header-banner" style="${headerBg}">
        <div class="deck-header">
          <div>
            <a href="#/my-decks" class="back-link">&larr; Zurück</a>
            <h2>${deck.name} ${isOwner ? '<button id="edit-deck-meta" class="btn-edit-meta" title="Name/Commander bearbeiten">&#9998;</button>' : ''}</h2>
            <p class="deck-meta">
              Commander: <strong>${deck.commander}</strong>${deck.commander2 ? ` + <strong>${deck.commander2}</strong>` : ''}
              &middot; Spieler: <strong>${deck.players?.name || 'Unbekannt'}</strong>
              &middot; ${cards.reduce((s, c) => s + (c.quantity || 1), 0)} Karten
            </p>
          </div>
          <div class="deck-value">
            <span class="value-label">Gesamtwert</span>
            <span class="value-amount">${totalPrice}</span>
            ${stale ? '<span class="stale-hint">(veraltet)</span>' : ''}
          </div>
        </div>
      </div>
      <div class="deck-actions">
        ${isOwner ? '<button id="refresh-prices" class="btn">Preise aktualisieren</button>' : ''}
        ${isOwner ? '<button id="toggle-edit" class="btn btn-secondary">Bearbeiten</button>' : ''}
        <button id="export-deck" class="btn btn-secondary">Exportieren</button>
        <div class="sort-controls">
          <span class="sort-label">Sortierung:</span>
          <select id="sort-select" class="sort-select">
            <option value="type">Typ</option>
            <option value="name">Name</option>
            <option value="cmc">Manakosten</option>
            <option value="price-desc">Preis ↓</option>
            <option value="price-asc">Preis ↑</option>
          </select>
        </div>
      </div>
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
        <h3 class="group-header">Tokens</h3>
        <div class="token-grid"></div>
      </div>
    </div>
  `

  setDefaultPreview(commanderCardImage)
  setEditMode(false)
  renderDeckStats(cards)

  let currentSort = 'type'
  const rerender = () => renderCardGroups(cards, deck.commander, currentSort, deck.commander2)
  rerender()

  document.getElementById('sort-select')?.addEventListener('change', (e) => {
    currentSort = e.target.value
    rerender()
  })

  document.getElementById('toggle-edit')?.addEventListener('click', () => {
    const btn = document.getElementById('toggle-edit')
    setEditMode(!isEditMode())
    btn.textContent = isEditMode() ? 'Fertig' : 'Bearbeiten'
    btn.classList.toggle('btn-active', isEditMode())
    rerender()
  })

  if (isOwner) {
    document.getElementById('refresh-prices')?.addEventListener('click', async () => {
      await refreshPrices(id, cards)
    })
  }

  document.getElementById('export-deck')?.addEventListener('click', () => {
    exportDeck(deck, cards)
  })

  document.getElementById('edit-deck-meta')?.addEventListener('click', () => {
    showMetaEditor(deck)
  })

  // Load tokens in background
  loadTokens(cards)
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
  } catch { /* tokens are non-critical */ }
}

function renderCardGroups(cards, commanderName, sortMode, commander2Name) {
  const groupsEl = document.getElementById('card-groups')
  groupsEl.innerHTML = ''

  // Extract commander cards and show them first
  const commanderCard = cards.find(c => c.name.toLowerCase() === commanderName?.toLowerCase())
  const commander2Card = commander2Name ? cards.find(c => c.name.toLowerCase() === commander2Name.toLowerCase()) : null
  const commanderCards = [commanderCard, commander2Card].filter(Boolean)
  const remainingCards = cards.filter(c => !commanderCards.includes(c))

  if (commanderCards.length > 0) {
    groupsEl.appendChild(buildGroupSection('Commander', commanderCards))
  }

  if (sortMode === 'type') {
    const groups = groupCardsByType(remainingCards)
    for (const group of groups) {
      groupsEl.appendChild(buildGroupSection(group.label, group.cards))
    }
  } else {
    const sorted = [...remainingCards].sort(getSortFn(sortMode))
    groupsEl.appendChild(buildGroupSection('Alle Karten', sorted))
  }
}

function getSortFn(mode) {
  switch (mode) {
    case 'name': return (a, b) => a.name.localeCompare(b.name)
    case 'cmc': return (a, b) => (a.cmc || 0) - (b.cmc || 0) || a.name.localeCompare(b.name)
    case 'price-desc': return (a, b) => ((parseFloat(b.price_eur) || 0) * b.quantity) - ((parseFloat(a.price_eur) || 0) * a.quantity)
    case 'price-asc': return (a, b) => ((parseFloat(a.price_eur) || 0) * a.quantity) - ((parseFloat(b.price_eur) || 0) * b.quantity)
    default: return (a, b) => a.name.localeCompare(b.name)
  }
}

function buildGroupSection(label, cards) {
  const section = document.createElement('div')
  section.className = 'card-group'

  const groupTotal = cards.reduce((s, c) => s + (parseFloat(c.price_eur) || 0) * c.quantity, 0)
  const count = cards.reduce((s, c) => s + c.quantity, 0)

  section.innerHTML = `
    <h3 class="group-header">
      ${label} (${count})
      <span class="group-total">${formatPrice(groupTotal)}</span>
    </h3>
    <table class="card-table">
      <thead>
        <tr>
          <th class="th-qty">#</th>
          <th class="th-name">Karte</th>
          <th class="th-mana">Mana</th>
          <th class="th-price">Preis</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  `

  const tbody = section.querySelector('tbody')
  for (const card of cards) {
    tbody.appendChild(createCardRow(card))
  }

  return section
}

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
    ? `<div class="bracket-detail">${bracket.gameChangerCount} Game Changer${bracket.gameChangerCount > 1 ? '' : ''}</div>`
    : ''
  const tutorHtml = bracket.tutorCount > 0
    ? `<div class="bracket-detail">${bracket.tutorCount} Tutors</div>`
    : ''
  const flagsHtml = [
    bracket.hasExtraTurns ? 'Extra Turns' : '',
    bracket.hasMLD ? 'MLD' : '',
  ].filter(Boolean).map(f => `<div class="bracket-detail bracket-flag">${f}</div>`).join('')

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

function showMetaEditor(deck) {
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
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    } catch (err) {
      saveBtn.textContent = `Fehler: ${err.message}`
      saveBtn.disabled = false
    }
  })
}

async function refreshPrices(deckId, cards) {
  const btn = document.getElementById('refresh-prices')
  btn.disabled = true

  // Replace button with progress bar
  const progress = document.createElement('div')
  progress.className = 'price-progress'
  progress.innerHTML = `
    <div class="progress-bar"><div class="progress-fill" id="progress-fill"></div></div>
    <span class="progress-text" id="progress-text">Scryfall abfragen...</span>
  `
  btn.replaceWith(progress)

  const fill = document.getElementById('progress-fill')
  const text = document.getElementById('progress-text')

  const setProgress = (pct, label) => {
    fill.style.width = `${pct}%`
    text.textContent = label
  }

  try {
    setProgress(10, 'Preise von Scryfall laden...')
    const names = cards.map(c => c.name)
    const { found } = await fetchCardCollection(names)

    setProgress(50, `${found.length} Karten gefunden, speichere...`)

    const priceMap = {}
    const nameToId = {}
    for (const c of cards) {
      nameToId[c.name.toLowerCase()] = c.id
    }

    const USD_TO_EUR = 0.92
    const legalityMap = {}
    for (const sc of found) {
      const cardId = nameToId[sc.name.toLowerCase()]
      const p = sc.prices || {}
      let eur = null, isFoil = false
      if (p.eur) eur = parseFloat(p.eur)
      else if (p.usd) eur = parseFloat(p.usd) * USD_TO_EUR
      else if (p.eur_foil) { eur = parseFloat(p.eur_foil); isFoil = true }
      else if (p.usd_foil) { eur = parseFloat(p.usd_foil) * USD_TO_EUR; isFoil = true }
      if (cardId && eur) {
        priceMap[cardId] = { price: eur, isFoil }
      }
      if (cardId && sc.legalities?.commander) {
        legalityMap[cardId] = sc.legalities.commander
      }
    }

    setProgress(70, `${Object.keys(priceMap).length} Preise speichern...`)
    await updateCardPrices(deckId, priceMap, legalityMap)

    setProgress(100, 'Fertig!')
    setTimeout(() => {
      // Force re-render even if hash unchanged
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    }, 500)
  } catch (err) {
    setProgress(0, `Fehler: ${err.message}`)
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

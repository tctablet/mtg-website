import { getDeck, getDeckCards, updateCardPrices, updateDeck, updateCardProxyImage } from '../supabase.js'
import { fetchCardCollection, extractCardData, fetchCardByName, getCardArtCrop, getPartnerType, extractTokenRefs, fetchTokenDetails, fetchCardPrintings } from '../scryfall.js'
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
  const commanderCardImage = commanderCard?.proxy_image_uri || commanderCard?.image_uri || null

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
      <div class="deck-tabs">
        <button class="deck-tab deck-tab-active" data-tab="cards">Karten</button>
        <button class="deck-tab" data-tab="proxy">Proxy Artworks</button>
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

  // Tab switching
  container.querySelectorAll('.deck-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      container.querySelectorAll('.deck-tab').forEach(t => t.classList.remove('deck-tab-active'))
      tab.classList.add('deck-tab-active')
      const target = tab.dataset.tab
      document.getElementById('tab-cards').style.display = target === 'cards' ? '' : 'none'
      document.getElementById('tab-proxy').style.display = target === 'proxy' ? '' : 'none'
      if (target === 'proxy') {
        renderProxyArtworks(cards, isOwner)
      }
    })
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

// --- Printings Cache ---
const PRINTS_CACHE_VER = 'v2'
const printingsCache = new Map()

// Invalidate old cache versions
if (sessionStorage.getItem('prints:ver') !== PRINTS_CACHE_VER) {
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith('prints:')) sessionStorage.removeItem(key)
  }
  sessionStorage.setItem('prints:ver', PRINTS_CACHE_VER)
}

async function prefetchPrintings(cardNames) {
  const toFetch = cardNames.filter(n => !printingsCache.has(n.toLowerCase()))
  // Check sessionStorage
  for (let i = toFetch.length - 1; i >= 0; i--) {
    const cached = sessionStorage.getItem(`prints:${toFetch[i].toLowerCase()}`)
    if (cached) {
      try {
        printingsCache.set(toFetch[i].toLowerCase(), JSON.parse(cached))
        toFetch.splice(i, 1)
      } catch { /* ignore corrupt cache */ }
    }
  }
  if (toFetch.length === 0) return

  // Fetch in parallel batches, 10 per second (Scryfall rate limit)
  const BATCH = 10
  for (let i = 0; i < toFetch.length; i += BATCH) {
    const batch = toFetch.slice(i, i + BATCH)
    await Promise.all(batch.map(async name => {
      try {
        const printings = await fetchCardPrintings(name)
        printingsCache.set(name.toLowerCase(), printings)
        sessionStorage.setItem(`prints:${name.toLowerCase()}`, JSON.stringify(printings))
      } catch { /* skip failures */ }
    }))
    if (i + BATCH < toFetch.length) await new Promise(r => setTimeout(r, 120))
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

    for (const c of unique) {
      const imgSrc = c.proxy_image_uri || c.image_uri
      const div = document.createElement('div')
      div.className = 'proxy-card'
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
    }

    section.appendChild(grid)
    container.appendChild(section)
  }

  // Prefetch all printings in background
  const allNames = [...new Set(cards.map(c => c.name))]
  prefetchPrintings(allNames)
}

async function openArtworkPicker(card, cardEl, allCards) {
  document.getElementById('artwork-picker-modal')?.remove()

  const modal = document.createElement('div')
  modal.id = 'artwork-picker-modal'
  modal.className = 'artwork-picker-overlay'
  modal.innerHTML = `
    <div class="artwork-picker">
      <div class="artwork-picker-header">
        <h3>${card.name}</h3>
        <input type="text" class="artwork-search" placeholder="Set suchen..." />
        <button class="artwork-picker-close">&times;</button>
      </div>
      <div class="artwork-picker-grid">
        <p class="loading">Lade Printings...</p>
      </div>
    </div>
  `
  document.body.appendChild(modal)

  modal.querySelector('.artwork-picker-close').addEventListener('click', () => modal.remove())
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove() })

  const pickerGrid = modal.querySelector('.artwork-picker-grid')
  const searchInput = modal.querySelector('.artwork-search')

  try {
    // Use cache if available, otherwise fetch
    let printings = printingsCache.get(card.name.toLowerCase())
    if (!printings) {
      printings = await fetchCardPrintings(card.name)
      printingsCache.set(card.name.toLowerCase(), printings)
      sessionStorage.setItem(`prints:${card.name.toLowerCase()}`, JSON.stringify(printings))
    }

    if (printings.length === 0) {
      pickerGrid.innerHTML = '<p>Keine Printings gefunden.</p>'
      return
    }

    function renderPrintings(filter) {
      const query = (filter || '').toLowerCase()
      const filtered = query
        ? printings.filter(p => p.set.toLowerCase().includes(query) || p.set_code.toLowerCase().includes(query))
        : printings

      let resetHtml = ''
      if (card.proxy_image_uri && !query) {
        resetHtml = `
          <div class="artwork-option artwork-reset" data-action="reset">
            <div class="artwork-option-img-wrap">
              <img src="${card.image_uri}" alt="Default" />
            </div>
            <span class="artwork-option-set">Default zuruecksetzen</span>
          </div>
        `
      }

      pickerGrid.innerHTML = resetHtml + (filtered.length === 0
        ? `<p class="artwork-no-results">Kein Set gefunden fuer "${filter}"</p>`
        : filtered.map(p => {
          const isSelected = card.proxy_image_uri === p.image_normal || (!card.proxy_image_uri && card.image_uri === p.image_normal)
          return `
            <div class="artwork-option ${isSelected ? 'artwork-selected' : ''}" data-image="${p.image_normal}" data-png="${p.image_png || p.image_normal}">
              <div class="artwork-option-img-wrap">
                <img src="${p.image_normal}" alt="${p.set}" loading="lazy" />
              </div>
              <span class="artwork-option-set">${p.set} (${p.released?.substring(0, 4) || '?'})</span>
            </div>
          `
        }).join(''))

      pickerGrid.querySelectorAll('.artwork-option').forEach(opt => {
        opt.addEventListener('click', async () => {
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

            modal.remove()
          } catch (err) {
            alert('Fehler beim Speichern: ' + err.message)
          }
        })
      })
    }

    renderPrintings('')
    searchInput.addEventListener('input', () => renderPrintings(searchInput.value))
    searchInput.focus()
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

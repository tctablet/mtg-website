import { getPlayer } from '../auth.js'
import { navigate } from '../router.js'
import { createDeck, insertCards } from '../supabase.js'
import { fetchCardCollection, extractCardData, getCardArtCrop, getPartnerType, getCardNormalImage } from '../scryfall.js'
import { parseDeckList, getTypeCategory } from '../utils.js'

// State shared between steps
let scryfallMap = {}
let parsedCards = []
let commanderCandidates = []
let selectedCommander = null
let selectedCommander2 = null

export async function renderDeckImport(container) {
  const player = getPlayer()
  if (!player) { navigate('#/login'); return }

  scryfallMap = {}
  parsedCards = []
  commanderCandidates = []
  selectedCommander = null
  selectedCommander2 = null

  container.innerHTML = `
    <div class="page">
      <h2>Deck importieren</h2>
      <div class="import-form">
        <label>Deckname
          <input type="text" id="deck-name" placeholder="z.B. Atraxa Superfriends" />
        </label>
        <label>Kartenliste
          <textarea id="deck-list" rows="20" placeholder="1 Sol Ring
1 Command Tower
1x Arcane Signet
..."></textarea>
        </label>
        <div class="import-actions">
          <label class="file-upload">
            <input type="file" id="file-input" accept=".txt,.dec,.mwDeck" />
            Datei laden
          </label>
          <button id="next-btn" class="btn">Weiter</button>
        </div>
        <div id="import-status" hidden></div>
        <div id="import-errors" hidden></div>
        <div id="commander-picker" hidden></div>
      </div>
    </div>
  `

  document.getElementById('file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0]
    if (!file) return
    document.getElementById('deck-list').value = await file.text()
  })

  document.getElementById('next-btn').addEventListener('click', doAnalyze)
}

function isCommanderEligible(scryfallCard) {
  const typeLine = scryfallCard.type_line || ''
  const oracleText = scryfallCard.oracle_text || scryfallCard.card_faces?.[0]?.oracle_text || ''

  // Legendary Creature
  if (typeLine.includes('Legendary') && typeLine.includes('Creature')) return true
  // Planeswalker that can be commander
  if (typeLine.includes('Planeswalker') && oracleText.includes('can be your commander')) return true
  // Some cards explicitly say they can be your commander
  if (oracleText.includes('can be your commander')) return true

  return false
}

async function doAnalyze() {
  const nameEl = document.getElementById('deck-name')
  const listEl = document.getElementById('deck-list')
  const statusEl = document.getElementById('import-status')
  const errorsEl = document.getElementById('import-errors')
  const btn = document.getElementById('next-btn')

  const deckName = nameEl.value.trim()
  const listText = listEl.value.trim()

  if (!deckName || !listText) {
    showStatus(statusEl, 'Bitte Deckname und Kartenliste ausfuellen.', 'error')
    return
  }

  parsedCards = parseDeckList(listText)
  if (parsedCards.length === 0) {
    showStatus(statusEl, 'Keine Karten erkannt. Format: "1 Kartenname" pro Zeile.', 'error')
    return
  }

  btn.disabled = true
  btn.textContent = 'Lade...'
  showStatus(statusEl, `${parsedCards.length} Karten erkannt. Lade Daten von Scryfall...`)

  try {
    const uniqueNames = [...new Set(parsedCards.map(c => c.name))]
    const { found, notFound } = await fetchCardCollection(uniqueNames)

    scryfallMap = {}
    for (const card of found) {
      scryfallMap[card.name.toLowerCase()] = card
      // Also index DFC cards by front face name
      if (card.name.includes(' // ')) {
        scryfallMap[card.name.split(' // ')[0].toLowerCase()] = card
      }
    }

    if (notFound.length > 0) {
      errorsEl.innerHTML = `
        <p><strong>${notFound.length} Karten nicht gefunden:</strong></p>
        <ul>${notFound.map(n => `<li>${n}</li>`).join('')}</ul>
      `
      errorsEl.hidden = false
    } else {
      errorsEl.hidden = true
    }

    // Collect all colors used in the deck (excluding commander candidates)
    const allEligible = found.filter(c => isCommanderEligible(c))
    const eligibleNames = new Set(allEligible.map(c => c.name.toLowerCase()))
    const deckColors = new Set()
    for (const card of found) {
      if (eligibleNames.has(card.name.toLowerCase())) continue
      for (const color of (card.color_identity || [])) {
        deckColors.add(color)
      }
    }

    // Filter: commander's color_identity must cover all deck colors
    commanderCandidates = allEligible.filter(c => {
      const cmdrColors = new Set(c.color_identity || [])
      for (const color of deckColors) {
        if (!cmdrColors.has(color)) return false
      }
      return true
    })

    if (commanderCandidates.length === 0) {
      // Fallback: show all eligible if no candidate covers all colors
      commanderCandidates = allEligible
      if (commanderCandidates.length === 0) {
        showStatus(statusEl, 'Keine Commander-faehigen Karten in der Liste gefunden. Bitte pruefe die Kartenliste.', 'error')
        btn.disabled = false
        btn.textContent = 'Weiter'
        return
      }
    }

    // Disable step 1 inputs
    nameEl.disabled = true
    listEl.disabled = true
    btn.hidden = true
    document.querySelector('.file-upload').hidden = true

    // Auto-select commander if marked with # !Commander
    const taggedCommander = parsedCards.find(c => c.isCommander)
    if (taggedCommander) {
      const cmdrCard = scryfallMap[taggedCommander.name.toLowerCase()]
      if (cmdrCard) {
        selectedCommander = cmdrCard
        // Check for second commander tag
        const taggedCommander2 = parsedCards.find(c => c.isCommander && c.name.toLowerCase() !== taggedCommander.name.toLowerCase())
        if (taggedCommander2) {
          selectedCommander2 = scryfallMap[taggedCommander2.name.toLowerCase()] || null
        }
      }
    }

    showStatus(statusEl, `${found.length} Karten geladen. Waehle deinen Commander:`)
    renderCommanderPicker()

    // Scroll to commander picker
    document.getElementById('commander-picker')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  } catch (err) {
    showStatus(statusEl, `Fehler: ${err.message}`, 'error')
    btn.disabled = false
    btn.textContent = 'Weiter'
  }
}

function renderCommanderPicker() {
  const picker = document.getElementById('commander-picker')
  picker.hidden = false

  picker.innerHTML = `
    <div class="cmdr-picker">
      <div class="cmdr-picker-header">
        <h3>Commander waehlen</h3>
        <input type="text" id="cmdr-filter" class="cmdr-filter" placeholder="Karten filtern..." />
      </div>
      <div id="cmdr-grid" class="cmdr-grid"></div>
      <div id="partner-picker" hidden>
        <div class="cmdr-picker-header">
          <h3 id="partner-picker-title">Partner Commander waehlen</h3>
          <input type="text" id="partner-filter" class="cmdr-filter" placeholder="Partner filtern..." />
        </div>
        <div id="partner-grid" class="cmdr-grid"></div>
      </div>
      <div id="cmdr-selection" class="cmdr-selection" hidden>
        <div id="cmdr-selection-preview" class="cmdr-selection-preview"></div>
        <button id="import-btn" class="btn">Deck importieren</button>
      </div>
    </div>
  `

  renderCandidateGrid('cmdr-grid', commanderCandidates, '', selectMainCommander)

  document.getElementById('cmdr-filter').addEventListener('input', (e) => {
    renderCandidateGrid('cmdr-grid', commanderCandidates, e.target.value, selectMainCommander)
  })

  document.getElementById('partner-filter')?.addEventListener('input', (e) => {
    const partnerCandidates = getPartnerCandidates()
    renderCandidateGrid('partner-grid', partnerCandidates, e.target.value, selectPartnerCommander)
  })

  document.getElementById('import-btn').addEventListener('click', doImport)
}

function renderCandidateGrid(gridId, candidates, filter, onSelect) {
  const grid = document.getElementById(gridId)
  const query = (filter || '').toLowerCase()
  const filtered = query
    ? candidates.filter(c => c.name.toLowerCase().includes(query) || (c.type_line || '').toLowerCase().includes(query))
    : candidates

  grid.innerHTML = filtered.map(c => {
    const img = getCardNormalImage(c) || ''
    const isSelected = (selectedCommander && c.name === selectedCommander.name) ||
                       (selectedCommander2 && c.name === selectedCommander2.name)
    return `
      <div class="cmdr-card ${isSelected ? 'cmdr-card-selected' : ''}" data-name="${c.name.replace(/"/g, '&quot;')}">
        <img src="${img}" alt="${c.name}" loading="lazy" />
        <span class="cmdr-card-name">${c.name}</span>
      </div>
    `
  }).join('')

  if (filtered.length === 0) {
    grid.innerHTML = `<p class="cmdr-empty">Keine Karten gefunden${query ? ` fuer "${filter}"` : ''}</p>`
  }

  grid.querySelectorAll('.cmdr-card').forEach(el => {
    el.addEventListener('click', () => {
      const name = el.dataset.name
      const card = candidates.find(c => c.name === name)
      if (card) onSelect(card)
    })
  })
}

function selectMainCommander(card) {
  selectedCommander = card
  selectedCommander2 = null

  // Check for partner abilities
  const partner = getPartnerType(card)
  const partnerPicker = document.getElementById('partner-picker')
  const partnerTitle = document.getElementById('partner-picker-title')

  if (partner) {
    const labels = {
      partner: 'Partner Commander',
      partner_with: 'Partner Commander',
      friends_forever: 'Friends Forever Partner',
      choose_background: 'Background',
      doctors_companion: "Doctor's Companion",
    }
    partnerTitle.textContent = `${labels[partner.type] || 'Partner'} waehlen (optional)`
    partnerPicker.hidden = false

    // For "Partner with [Name]", auto-select if in deck
    if (partner.type === 'partner_with' && partner.partnerName) {
      const partnerCard = commanderCandidates.find(c => c.name.toLowerCase() === partner.partnerName.toLowerCase())
      if (partnerCard) {
        selectedCommander2 = partnerCard
      }
    }

    const partnerCandidates = getPartnerCandidates()
    renderCandidateGrid('partner-grid', partnerCandidates, '', selectPartnerCommander)
  } else {
    partnerPicker.hidden = true
  }

  // Re-render main grid to show selection
  const filterVal = document.getElementById('cmdr-filter')?.value || ''
  renderCandidateGrid('cmdr-grid', commanderCandidates, filterVal, selectMainCommander)

  updateSelectionPreview()
}

function getPartnerCandidates() {
  const mainPartner = getPartnerType(selectedCommander)
  if (!mainPartner) return []

  return commanderCandidates.filter(c => {
    if (c.name === selectedCommander.name) return false
    const p = getPartnerType(c)
    if (!p) return false

    // Match compatible partner types
    if (mainPartner.type === 'partner' && p.type === 'partner') return true
    if (mainPartner.type === 'partner_with' && p.type === 'partner_with') return true
    if (mainPartner.type === 'friends_forever' && p.type === 'friends_forever') return true
    if (mainPartner.type === 'choose_background') {
      return (c.type_line || '').includes('Background')
    }
    if (mainPartner.type === 'doctors_companion' && p.type === 'doctors_companion') return true
    return false
  })
}

function selectPartnerCommander(card) {
  // Toggle off if already selected
  if (selectedCommander2 && selectedCommander2.name === card.name) {
    selectedCommander2 = null
  } else {
    selectedCommander2 = card
  }

  const filterVal = document.getElementById('partner-filter')?.value || ''
  const partnerCandidates = getPartnerCandidates()
  renderCandidateGrid('partner-grid', partnerCandidates, filterVal, selectPartnerCommander)
  updateSelectionPreview()
}

function updateSelectionPreview() {
  const selection = document.getElementById('cmdr-selection')
  const preview = document.getElementById('cmdr-selection-preview')

  if (!selectedCommander) {
    selection.hidden = true
    return
  }

  selection.hidden = false
  const img1 = getCardNormalImage(selectedCommander) || ''
  let html = `
    <div class="cmdr-selected-card">
      <img src="${img1}" alt="${selectedCommander.name}" />
      <span>${selectedCommander.name}</span>
    </div>
  `

  if (selectedCommander2) {
    const img2 = getCardNormalImage(selectedCommander2) || ''
    html += `
      <span class="cmdr-plus">+</span>
      <div class="cmdr-selected-card">
        <img src="${img2}" alt="${selectedCommander2.name}" />
        <span>${selectedCommander2.name}</span>
      </div>
    `
  }

  preview.innerHTML = html
}

async function doImport() {
  const statusEl = document.getElementById('import-status')
  const btn = document.getElementById('import-btn')
  const deckName = document.getElementById('deck-name').value.trim()

  if (!selectedCommander) {
    showStatus(statusEl, 'Bitte waehle einen Commander.', 'error')
    return
  }

  btn.disabled = true
  btn.textContent = 'Importiere...'
  showStatus(statusEl, 'Speichere Deck...')

  try {
    const commanderImage = getCardArtCrop(selectedCommander)
    const commander2Name = selectedCommander2?.name || null
    const commander2Image = selectedCommander2 ? getCardArtCrop(selectedCommander2) : null

    const player = JSON.parse(localStorage.getItem('mtg_player'))
    const deck = await createDeck(player.id, deckName, selectedCommander.name, commanderImage, commander2Name, commander2Image)

    const cardRows = []
    const skipped = []
    for (const c of parsedCards) {
      const scData = scryfallMap[c.name.toLowerCase()]
      if (!scData) {
        skipped.push(c.name)
        continue
      }
      const sd = extractCardData(scData)
      cardRows.push({
        deck_id: deck.id,
        quantity: c.quantity,
        name: sd.name,
        scryfall_id: sd.scryfall_id,
        type_line: sd.type_line,
        type_category: getTypeCategory(sd.type_line),
        mana_cost: sd.mana_cost,
        cmc: sd.cmc,
        image_uri: sd.image_uri,
        price_eur: sd.price_eur,
        price_updated_at: sd.price_updated_at,
      })
    }

    if (cardRows.length > 0) {
      await insertCards(cardRows)
    }

    const errorsEl = document.getElementById('import-errors')
    if (skipped.length > 0) {
      console.warn('Import: Karten uebersprungen (nicht in Scryfall gefunden):', skipped)
      errorsEl.innerHTML = `
        <p><strong>${skipped.length} Karte${skipped.length > 1 ? 'n' : ''} uebersprungen:</strong></p>
        <ul>${skipped.map(n => `<li>${n}</li>`).join('')}</ul>
      `
      errorsEl.hidden = false
      showStatus(statusEl, `Deck "${deckName}" mit ${cardRows.length} Karten gespeichert (${skipped.length} uebersprungen).`, 'success')
      setTimeout(() => navigate(`#/deck/${deck.id}`), 3000)
    } else {
      errorsEl.hidden = true
      showStatus(statusEl, `Deck "${deckName}" mit ${cardRows.length} Karten gespeichert!`, 'success')
      setTimeout(() => navigate(`#/deck/${deck.id}`), 1500)
    }
  } catch (err) {
    showStatus(statusEl, `Fehler: ${err.message}`, 'error')
    btn.disabled = false
    btn.textContent = 'Deck importieren'
  }
}

function showStatus(el, msg, type = 'info') {
  el.textContent = msg
  el.className = `import-status status-${type}`
  el.hidden = false
}

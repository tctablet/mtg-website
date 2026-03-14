import { getPlayer } from '../auth.js'
import { navigate } from '../router.js'
import { createDeck, insertCards } from '../supabase.js'
import { fetchCardCollection, extractCardData, autocompleteCard, fetchCardByName, getCardArtCrop } from '../scryfall.js'
import { parseDeckList, getTypeCategory } from '../utils.js'

let selectedCommanderImage = null
let debounceTimer = null

export async function renderDeckImport(container) {
  const player = getPlayer()
  if (!player) { navigate('#/login'); return }

  selectedCommanderImage = null

  container.innerHTML = `
    <div class="page">
      <h2>Deck importieren</h2>
      <div class="import-form">
        <label>Deckname
          <input type="text" id="deck-name" placeholder="z.B. Atraxa Superfriends" />
        </label>
        <label>Commander
          <div class="commander-field">
            <div class="autocomplete-wrapper">
              <input type="text" id="deck-commander" placeholder="z.B. Atraxa, Praetors' Voice" autocomplete="off" />
              <div id="autocomplete-list" class="autocomplete-list" hidden></div>
            </div>
            <div id="commander-preview" class="commander-preview" hidden>
              <img id="commander-preview-img" alt="Commander Artwork" />
            </div>
          </div>
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
          <button id="import-btn" class="btn">Importieren</button>
        </div>
        <div id="import-status" hidden></div>
        <div id="import-errors" hidden></div>
      </div>
    </div>
  `

  setupAutocomplete()

  const fileInput = document.getElementById('file-input')
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0]
    if (!file) return
    const text = await file.text()
    document.getElementById('deck-list').value = text
  })

  document.getElementById('import-btn').addEventListener('click', doImport)
}

function setupAutocomplete() {
  const input = document.getElementById('deck-commander')
  const list = document.getElementById('autocomplete-list')

  input.addEventListener('input', () => {
    clearTimeout(debounceTimer)
    const query = input.value.trim()

    if (query.length < 2) {
      list.hidden = true
      return
    }

    debounceTimer = setTimeout(async () => {
      const suggestions = await autocompleteCard(query)
      if (suggestions.length === 0) {
        list.hidden = true
        return
      }

      list.innerHTML = suggestions
        .slice(0, 8)
        .map(name => `<div class="autocomplete-item">${name}</div>`)
        .join('')
      list.hidden = false

      list.querySelectorAll('.autocomplete-item').forEach(item => {
        item.addEventListener('click', () => selectCommander(item.textContent))
      })
    }, 250)
  })

  input.addEventListener('keydown', (e) => {
    const items = list.querySelectorAll('.autocomplete-item')
    const active = list.querySelector('.autocomplete-item.active')
    let idx = [...items].indexOf(active)

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (active) active.classList.remove('active')
      idx = (idx + 1) % items.length
      items[idx]?.classList.add('active')
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (active) active.classList.remove('active')
      idx = idx <= 0 ? items.length - 1 : idx - 1
      items[idx]?.classList.add('active')
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (active) {
        selectCommander(active.textContent)
      } else if (items.length > 0) {
        selectCommander(items[0].textContent)
      }
    } else if (e.key === 'Escape') {
      list.hidden = true
    }
  })

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.autocomplete-wrapper')) {
      list.hidden = true
    }
  })
}

async function selectCommander(name) {
  const input = document.getElementById('deck-commander')
  const list = document.getElementById('autocomplete-list')
  const preview = document.getElementById('commander-preview')
  const previewImg = document.getElementById('commander-preview-img')

  input.value = name
  list.hidden = true

  // Fetch card data for artwork
  const card = await fetchCardByName(name)
  if (card) {
    const artCrop = getCardArtCrop(card)
    if (artCrop) {
      previewImg.src = artCrop
      preview.hidden = false
      selectedCommanderImage = artCrop
    }
  }
}

async function doImport() {
  const nameEl = document.getElementById('deck-name')
  const commanderEl = document.getElementById('deck-commander')
  const listEl = document.getElementById('deck-list')
  const statusEl = document.getElementById('import-status')
  const errorsEl = document.getElementById('import-errors')
  const btn = document.getElementById('import-btn')

  const deckName = nameEl.value.trim()
  const commander = commanderEl.value.trim()
  const listText = listEl.value.trim()

  if (!deckName || !commander || !listText) {
    showStatus(statusEl, 'Bitte alle Felder ausfüllen.', 'error')
    return
  }

  const parsed = parseDeckList(listText)
  if (parsed.length === 0) {
    showStatus(statusEl, 'Keine Karten erkannt. Format: "1 Kartenname" pro Zeile.', 'error')
    return
  }

  btn.disabled = true
  showStatus(statusEl, `${parsed.length} Karten erkannt. Lade Daten von Scryfall...`)

  try {
    const uniqueNames = [...new Set(parsed.map(c => c.name))]
    const { found, notFound } = await fetchCardCollection(uniqueNames)

    const scryfallMap = {}
    for (const card of found) {
      scryfallMap[card.name.toLowerCase()] = card
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

    // Use pre-selected commander image, or fall back to scryfall lookup
    let commanderImage = selectedCommanderImage
    if (!commanderImage) {
      const commanderData = scryfallMap[commander.toLowerCase()]
      commanderImage = commanderData
        ? (commanderData.image_uris?.art_crop || commanderData.card_faces?.[0]?.image_uris?.art_crop || null)
        : null
    }

    showStatus(statusEl, 'Speichere Deck...')

    const player = JSON.parse(localStorage.getItem('mtg_player'))
    const deck = await createDeck(player.id, deckName, commander, commanderImage)

    const cardRows = parsed
      .filter(c => scryfallMap[c.name.toLowerCase()])
      .map(c => {
        const sd = extractCardData(scryfallMap[c.name.toLowerCase()])
        return {
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
        }
      })

    if (cardRows.length > 0) {
      await insertCards(cardRows)
    }

    showStatus(statusEl, `Deck "${deckName}" mit ${cardRows.length} Karten gespeichert!`, 'success')

    setTimeout(() => navigate(`#/deck/${deck.id}`), 1500)
  } catch (err) {
    showStatus(statusEl, `Fehler: ${err.message}`, 'error')
    btn.disabled = false
  }
}

function showStatus(el, msg, type = 'info') {
  el.textContent = msg
  el.className = `import-status status-${type}`
  el.hidden = false
}

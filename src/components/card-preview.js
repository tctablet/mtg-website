import { fetchCardBackImage } from '../scryfall.js'

let defaultImage = null
let currentDfc = null // { frontUri, scryfallId, showingBack }

export function setDefaultPreview(imageUri) {
  defaultImage = imageUri
  const el = document.getElementById('deck-card-preview')
  if (!el) return
  // Ohne Bild KEIN leeres <img> anlegen — das renderte als kaputtes Icon
  // direkt neben dem .preview-noimg-Namens-Fallback (Critic R6, live belegt)
  if (imageUri) {
    ensureImg(el)
    el.querySelector('img').src = imageUri
  }
  hideFlipButton()
}

export function showPreview(imageUri, dfcInfo, bracketCat) {
  const el = document.getElementById('deck-card-preview')
  if (!el || !imageUri) return
  const img = ensureImg(el)
  img.src = imageUri
  setBracketClass(el, bracketCat)

  if (dfcInfo?.scryfallId) {
    currentDfc = { frontUri: imageUri, scryfallId: dfcInfo.scryfallId, showingBack: false }
    showFlipButton(el)
  } else {
    currentDfc = null
    hideFlipButton()
  }
}

function setBracketClass(el, bracketCat) {
  el.classList.remove('bracket-gc', 'bracket-tutor', 'bracket-extra', 'bracket-mld')
  if (bracketCat) el.classList.add(`bracket-${bracketCat}`)
}

export function movePreview() {}

export function hidePreview() {
  // Keep last hovered card visible — only showPreview replaces it
}

function ensureImg(container) {
  let img = container.querySelector('img')
  if (!img) {
    // Namens-Fallback weicht, sobald wieder ein echtes Bild kommt (Hover)
    container.querySelector('.preview-noimg')?.remove()
    img = document.createElement('img')
    img.alt = 'Kartenvorschau'
    container.appendChild(img)
  }
  return img
}

function showFlipButton(previewEl) {
  let btn = previewEl.querySelector('.flip-btn')
  if (!btn) {
    btn = document.createElement('button')
    btn.className = 'flip-btn'
    btn.title = 'Karte umdrehen'
    btn.setAttribute('aria-label', 'Karte umdrehen')
    btn.innerHTML = '&#x21C4;'
    btn.addEventListener('click', handleFlip)
    previewEl.appendChild(btn)
  }
  btn.style.display = ''
}

function hideFlipButton() {
  const btn = document.querySelector('#deck-card-preview .flip-btn')
  if (btn) btn.style.display = 'none'
}

async function handleFlip() {
  if (!currentDfc) return
  const el = document.getElementById('deck-card-preview')
  if (!el) return
  const img = el.querySelector('img')
  if (!img) return

  if (currentDfc.showingBack) {
    img.src = currentDfc.frontUri
    currentDfc.showingBack = false
  } else {
    const backUri = await fetchCardBackImage(currentDfc.scryfallId)
    if (backUri) {
      img.src = backUri
      currentDfc.showingBack = true
    }
  }
}

// Raeumt den keydown-Listener der aktuell offenen Vorschau auf
let releaseMobilePreview = null

function dismissMobilePreview(overlay) {
  if (!overlay || overlay.dataset.closing === '1') return
  overlay.dataset.closing = '1'
  if (releaseMobilePreview) releaseMobilePreview()
  overlay.classList.remove('visible')
  overlay.classList.add('closing')
  // Timer statt transitionend: feuert auch bei reduced motion und wenn
  // die Transition gar nicht erst startet
  setTimeout(() => overlay.remove(), 300)
}

// Alle Karten-Zeilen in Anzeigereihenfolge, die eine Vorschau haben.
// Wird bei jedem Blättern frisch gelesen, damit Sortierung/Bearbeiten stimmen.
// Scope: Vor/Zurück blättert nur innerhalb des nächsten [data-preview-scope]-
// Containers der Ausgangszeile — auf /scan stehen mehrere Listen gleichzeitig
// im DOM (Average + bewertete Decks), ohne Scope liefe die Navigation über
// Deck-Grenzen in fremde Karten. Ohne Attribut (deck-view): wie bisher global.
function previewRows(fromRow) {
  const scope = fromRow?.closest?.('[data-preview-scope]') || document
  return [...scope.querySelectorAll('.card-row')].filter(r => r._cardPreview)
}

export function showMobilePreview(imageUri, cardName, dfcInfo, bracketCat, rowEl) {
  // Offene Vorschau direkt ersetzen — ein Tap auf die naechste Karte soll
  // sie zeigen, nicht nur die alte schliessen
  if (releaseMobilePreview) releaseMobilePreview()
  document.getElementById('mobile-card-overlay')?.remove()

  const overlay = document.createElement('div')
  overlay.id = 'mobile-card-overlay'
  overlay.className = 'mobile-card-overlay'
  overlay.innerHTML = `
    <div class="mobile-card-content">
      <img alt="" />
      <button class="flip-btn flip-btn-mobile" title="Karte umdrehen" aria-label="Karte umdrehen" hidden>&#x21C4;</button>
      <div class="mobile-card-nav">
        <button class="mobile-nav-btn" data-dir="-1" aria-label="Vorherige Karte">&#8249;</button>
        <span class="mobile-nav-label"></span>
        <button class="mobile-nav-btn" data-dir="1" aria-label="Nächste Karte">&#8250;</button>
      </div>
    </div>
  `

  const img = overlay.querySelector('img')
  const flipBtn = overlay.querySelector('.flip-btn')
  const label = overlay.querySelector('.mobile-nav-label')
  const navBtns = [...overlay.querySelectorAll('.mobile-nav-btn')]

  let current = { imageUri, cardName, dfcInfo, bracketCat, row: rowEl }
  let showingBack = false

  function render(data, animate) {
    current = data
    showingBack = false
    img.src = data.imageUri
    img.alt = data.cardName || ''
    label.textContent = data.cardName || ''
    flipBtn.hidden = !data.dfcInfo?.scryfallId
    overlay.classList.remove('bracket-gc', 'bracket-tutor', 'bracket-extra', 'bracket-mld')
    if (data.bracketCat) overlay.classList.add(`bracket-${data.bracketCat}`)

    const rows = previewRows(data.row)
    const i = data.row ? rows.indexOf(data.row) : -1
    navBtns.forEach(b => {
      const target = i < 0 ? -1 : i + Number(b.dataset.dir)
      b.disabled = i < 0 || target < 0 || target >= rows.length
    })
    // Blaettern nur zeigen, wenn es ueberhaupt Nachbarn gibt
    overlay.querySelector('.mobile-card-nav').hidden = rows.length < 2 || i < 0

    if (animate) {
      img.classList.remove('card-swap')
      void img.offsetWidth
      img.classList.add('card-swap')
    }
  }

  function step(dir) {
    const rows = previewRows(current.row)
    const i = rows.indexOf(current.row)
    const next = rows[i + dir]
    if (!next?._cardPreview) return
    render({ ...next._cardPreview, row: next }, true)
  }

  overlay.addEventListener('click', (e) => {
    if (e.target.closest('.flip-btn') || e.target.closest('.mobile-card-nav')) return
    dismissMobilePreview(overlay)
  })

  navBtns.forEach(b => b.addEventListener('click', () => step(Number(b.dataset.dir))))

  flipBtn.addEventListener('click', async () => {
    if (!current.dfcInfo?.scryfallId) return
    if (showingBack) {
      img.src = current.imageUri
      showingBack = false
      return
    }
    const backUri = await fetchCardBackImage(current.dfcInfo.scryfallId)
    // Waehrend des Ladens kann weitergeblaettert worden sein
    if (backUri && current.dfcInfo?.scryfallId) {
      img.src = backUri
      showingBack = true
    }
  })

  render(current, false)
  document.body.appendChild(overlay)
  overlay.offsetHeight
  overlay.classList.add('visible')

  const onKey = (e) => {
    if (e.key === 'Escape') dismissMobilePreview(overlay)
    else if (e.key === 'ArrowLeft') step(-1)
    else if (e.key === 'ArrowRight') step(1)
  }
  // Routenwechsel schließt das Overlay (Critic-Fund: der Router leert nur
  // #content — das Overlay hängt am Body und stünde sonst fixiert über der
  // neuen Seite; gleiches Muster wie Lightbox/Swap-Picker)
  const onRoute = () => dismissMobilePreview(overlay)
  document.addEventListener('keydown', onKey)
  window.addEventListener('route-change', onRoute)
  const release = () => {
    document.removeEventListener('keydown', onKey)
    window.removeEventListener('route-change', onRoute)
    if (releaseMobilePreview === release) releaseMobilePreview = null
  }
  releaseMobilePreview = release
}

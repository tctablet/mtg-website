import { fetchCardBackImage } from '../scryfall.js'

let defaultImage = null
let currentDfc = null // { frontUri, scryfallId, showingBack }

export function setDefaultPreview(imageUri) {
  defaultImage = imageUri
  const el = document.getElementById('deck-card-preview')
  if (!el) return
  ensureImg(el)
  if (imageUri) {
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

export function showMobilePreview(imageUri, cardName, dfcInfo, bracketCat) {
  // Offene Vorschau direkt ersetzen — ein Tap auf die naechste Karte soll
  // sie zeigen, nicht nur die alte schliessen
  if (releaseMobilePreview) releaseMobilePreview()
  document.getElementById('mobile-card-overlay')?.remove()

  const overlay = document.createElement('div')
  overlay.id = 'mobile-card-overlay'
  overlay.className = 'mobile-card-overlay' + (bracketCat ? ` bracket-${bracketCat}` : '')
  overlay.innerHTML = `
    <div class="mobile-card-content">
      <img src="${imageUri}" alt="${cardName || ''}" />
      ${dfcInfo?.scryfallId ? '<button class="flip-btn flip-btn-mobile" title="Karte umdrehen">&#x21C4;</button>' : ''}
    </div>
  `

  let showingBack = false

  overlay.addEventListener('click', (e) => {
    if (e.target.closest('.flip-btn')) return
    dismissMobilePreview(overlay)
  })

  if (dfcInfo?.scryfallId) {
    overlay.querySelector('.flip-btn').addEventListener('click', async () => {
      const img = overlay.querySelector('img')
      if (!img) return
      if (showingBack) {
        img.src = imageUri
        showingBack = false
      } else {
        const backUri = await fetchCardBackImage(dfcInfo.scryfallId)
        if (backUri) {
          img.src = backUri
          showingBack = true
        }
      }
    })
  }

  document.body.appendChild(overlay)
  overlay.offsetHeight
  overlay.classList.add('visible')

  const onKey = (e) => {
    if (e.key === 'Escape') dismissMobilePreview(overlay)
  }
  document.addEventListener('keydown', onKey)
  const release = () => {
    document.removeEventListener('keydown', onKey)
    if (releaseMobilePreview === release) releaseMobilePreview = null
  }
  releaseMobilePreview = release
}

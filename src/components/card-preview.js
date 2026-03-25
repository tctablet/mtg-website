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

export function showPreview(imageUri, dfcInfo) {
  const el = document.getElementById('deck-card-preview')
  if (!el || !imageUri) return
  const img = ensureImg(el)
  img.src = imageUri

  if (dfcInfo?.scryfallId) {
    currentDfc = { frontUri: imageUri, scryfallId: dfcInfo.scryfallId, showingBack: false }
    showFlipButton(el)
  } else {
    currentDfc = null
    hideFlipButton()
  }
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

export function showMobilePreview(imageUri, cardName, dfcInfo) {
  // Close existing overlay with animation
  const existing = document.getElementById('mobile-card-overlay')
  if (existing) {
    existing.classList.add('closing')
    existing.addEventListener('transitionend', () => existing.remove(), { once: true })
    return
  }

  const overlay = document.createElement('div')
  overlay.id = 'mobile-card-overlay'
  overlay.className = 'mobile-card-overlay'
  overlay.innerHTML = `
    <div class="mobile-card-content">
      <img src="${imageUri}" alt="${cardName || ''}" />
      ${dfcInfo?.scryfallId ? '<button class="flip-btn flip-btn-mobile" title="Karte umdrehen">&#x21C4;</button>' : ''}
    </div>
  `

  let showingBack = false

  overlay.addEventListener('click', (e) => {
    if (e.target.closest('.flip-btn')) return
    overlay.classList.add('closing')
    overlay.addEventListener('transitionend', () => overlay.remove(), { once: true })
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
}

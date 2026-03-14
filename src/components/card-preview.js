let defaultImage = null

export function setDefaultPreview(imageUri) {
  defaultImage = imageUri
  const el = document.getElementById('deck-card-preview')
  if (!el) return
  ensureImg(el)
  if (imageUri) {
    el.querySelector('img').src = imageUri
  }
}

export function showPreview(imageUri) {
  const el = document.getElementById('deck-card-preview')
  if (!el || !imageUri) return
  const img = ensureImg(el)
  img.src = imageUri
}

export function movePreview() {}

export function hidePreview() {
  const el = document.getElementById('deck-card-preview')
  if (!el) return
  const img = ensureImg(el)
  img.src = defaultImage || ''
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

export function showMobilePreview(imageUri, cardName) {
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
    </div>
  `

  overlay.addEventListener('click', () => {
    overlay.classList.add('closing')
    overlay.addEventListener('transitionend', () => overlay.remove(), { once: true })
  })

  document.body.appendChild(overlay)
  overlay.offsetHeight
  overlay.classList.add('visible')
}

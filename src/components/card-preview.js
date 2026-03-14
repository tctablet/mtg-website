let defaultImage = null

export function setDefaultPreview(imageUri) {
  defaultImage = imageUri
  const el = document.getElementById('deck-card-preview')
  if (el && imageUri) {
    el.innerHTML = `<img src="${imageUri}" alt="Commander" />`
  }
}

export function showPreview(imageUri) {
  const el = document.getElementById('deck-card-preview')
  if (!el || !imageUri) return
  el.innerHTML = `<img src="${imageUri}" alt="Kartenvorschau" />`
}

export function movePreview() {}

export function hidePreview() {
  const el = document.getElementById('deck-card-preview')
  if (!el) return
  if (defaultImage) {
    el.innerHTML = `<img src="${defaultImage}" alt="Commander" />`
  } else {
    el.innerHTML = ''
  }
}

export function showMobilePreview(imageUri, cardName) {
  // Remove existing overlay if any
  const existing = document.getElementById('mobile-card-overlay')
  if (existing) { existing.remove(); return }

  const overlay = document.createElement('div')
  overlay.id = 'mobile-card-overlay'
  overlay.className = 'mobile-card-overlay'
  overlay.innerHTML = `
    <div class="mobile-card-content">
      <img src="${imageUri}" alt="${cardName || ''}" />
    </div>
  `
  overlay.addEventListener('click', () => overlay.remove())
  document.body.appendChild(overlay)
}

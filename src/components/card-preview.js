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

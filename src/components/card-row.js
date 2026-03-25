import { showPreview, hidePreview, showMobilePreview } from './card-preview.js'
import { formatPrice } from '../utils.js'
import { deleteCard, updateCardQuantity } from '../supabase.js'

let editMode = false

export function setEditMode(enabled) {
  editMode = enabled
}

export function isEditMode() {
  return editMode
}

export function createCardRow(card, onChanged) {
  const tr = document.createElement('tr')
  const isIllegal = card.commander_legality && card.commander_legality !== 'legal'
  tr.className = 'card-row'

  if (editMode) {
    tr.innerHTML = `
      <td class="card-qty">
        <input type="number" class="qty-input" value="${card.quantity}" min="1" max="99" />
      </td>
      <td class="card-name${isIllegal ? ' card-name-illegal' : ''}">${card.name}</td>
      <td class="card-mana">${formatManaCost(card.mana_cost)}</td>
      <td class="card-price card-edit-actions">
        <button class="btn-delete-card" title="Karte entfernen">&times;</button>
      </td>
    `

    const qtyInput = tr.querySelector('.qty-input')
    qtyInput.addEventListener('change', async () => {
      const newQty = parseInt(qtyInput.value, 10)
      if (newQty > 0 && newQty !== card.quantity) {
        await updateCardQuantity(card.id, newQty)
        card.quantity = newQty
        if (onChanged) onChanged()
      }
    })

    tr.querySelector('.btn-delete-card').addEventListener('click', async () => {
      if (confirm(`"${card.name}" entfernen?`)) {
        await deleteCard(card.id)
        tr.remove()
        if (onChanged) onChanged()
      }
    })
  } else {
    tr.innerHTML = `
      <td class="card-qty">${card.quantity}</td>
      <td class="card-name${isIllegal ? ' card-name-illegal' : ''}">${card.name}</td>
      <td class="card-mana">${formatManaCost(card.mana_cost)}</td>
      <td class="card-price">${card.price_is_foil ? '<span class="foil-badge" title="Nur als Foil verfügbar">✦</span>' : ''}${formatPrice(card.price_eur)}</td>
    `
  }

  const previewUri = card.proxy_image_uri || card.image_uri
  const isDfc = card.name?.includes(' // ')
  const dfcInfo = isDfc && card.scryfall_id ? { scryfallId: card.scryfall_id } : null
  if (previewUri) {
    tr.addEventListener('mouseenter', () => showPreview(previewUri, dfcInfo))
    tr.addEventListener('mouseleave', () => hidePreview())
    tr.addEventListener('click', (e) => {
      if (editMode) return
      if (!('ontouchstart' in window)) return
      e.preventDefault()
      showMobilePreview(previewUri, card.name, dfcInfo)
    })
  }

  return tr
}

function formatManaCost(manaCost) {
  if (!manaCost) return ''
  return manaCost.replace(/\{([^}]+)\}/g, (_, symbol) => {
    let cls = symbol.toLowerCase().replace(/\//g, '')
    const special = { t: 'tap', q: 'untap' }
    if (special[cls]) cls = special[cls]
    return `<i class="ms ms-${cls} ms-cost ms-shadow"></i>`
  })
}

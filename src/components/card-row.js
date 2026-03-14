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
  tr.className = `card-row${isIllegal ? ' card-row-illegal' : ''}`

  if (editMode) {
    const editLegalityBadge = card.commander_legality === 'banned'
      ? '<span class="legality-badge legality-banned" title="Banned in Commander">banned</span>'
      : card.commander_legality === 'not_legal'
        ? '<span class="legality-badge legality-not-legal" title="Nicht legal in Commander">not legal</span>'
        : card.commander_legality === 'restricted'
          ? '<span class="legality-badge legality-restricted" title="Restricted in Commander">restricted</span>'
          : ''

    tr.innerHTML = `
      <td class="card-qty">
        <input type="number" class="qty-input" value="${card.quantity}" min="1" max="99" />
      </td>
      <td class="card-name">${card.name}${editLegalityBadge ? ' ' + editLegalityBadge : ''}</td>
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
    const legalityBadge = card.commander_legality === 'banned'
      ? '<span class="legality-badge legality-banned" title="Banned in Commander">banned</span>'
      : card.commander_legality === 'not_legal'
        ? '<span class="legality-badge legality-not-legal" title="Nicht legal in Commander">not legal</span>'
        : card.commander_legality === 'restricted'
          ? '<span class="legality-badge legality-restricted" title="Restricted in Commander">restricted</span>'
          : ''

    tr.innerHTML = `
      <td class="card-qty">${card.quantity}</td>
      <td class="card-name">${card.name}${legalityBadge ? ' ' + legalityBadge : ''}</td>
      <td class="card-mana">${formatManaCost(card.mana_cost)}</td>
      <td class="card-price">${card.price_is_foil ? '<span class="foil-badge" title="Nur als Foil verfügbar">✦</span>' : ''}${formatPrice(card.price_eur)}</td>
    `
  }

  if (card.image_uri) {
    tr.addEventListener('mouseenter', () => showPreview(card.image_uri))
    tr.addEventListener('mouseleave', () => hidePreview())
    tr.addEventListener('click', (e) => {
      if (editMode) return
      if (!('ontouchstart' in window)) return
      e.preventDefault()
      showMobilePreview(card.image_uri, card.name)
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

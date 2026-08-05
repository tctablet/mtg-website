import { showPreview, hidePreview, showMobilePreview } from './card-preview.js'
import { formatPrice, escapeHtml, formatManaCost } from '../utils.js'
import { deleteCard, updateCardQuantity } from '../supabase.js'
import { classifyCard } from '../bracket.js'

let editMode = false

export function setEditMode(enabled) {
  editMode = enabled
}

export function isEditMode() {
  return editMode
}

// onChanged(card, section, info): section = die .card-group der Zeile (VOR der
// DOM-Mutation ermittelt, damit der Aufrufer Gruppen-Header nachziehen kann),
// info.removed = true wenn die Karte gelöscht wurde.
// Swap-Wunsch wird als bubbelndes CustomEvent 'card-swap-request' gemeldet
// (detail: { card, tr }) — entkoppelt card-row vom Swap-Picker.
// opts.editLocked: Zeile bleibt auch im Edit-Modus ohne Stepper/Aktionen —
// Commander wird nie über die Zeilen-UI getauscht/gelöscht (Meta-Editor ist
// der Weg; Critic-Fund analog zur apply.mjs-Regel „Commander nie Cut").
export function createCardRow(card, onChanged, { editLocked = false } = {}) {
  const tr = document.createElement('tr')
  const isIllegal = card.commander_legality && card.commander_legality !== 'legal'
  const bracketCat = classifyCard(card.name)
  tr.className = 'card-row' + (bracketCat ? ` card-row-bracket-${bracketCat}` : '')
  // Karte an der Zeile hinterlegen — Gruppen-Header-Refresh (card-list.js)
  // und In-Place-Updates lesen den Zustand direkt aus dem DOM
  tr._card = card
  const nameClass = 'card-name'
    + (isIllegal ? ' card-name-illegal' : '')
    + (bracketCat ? ` card-name-bracket-${bracketCat}` : '')
  const priceHtml = `${card.price_is_foil ? '<span class="foil-badge" role="img" aria-label="Nur als Foil verfügbar" title="Nur als Foil verfügbar">✦</span>' : ''}${formatPrice(card.price_eur)}`

  if (editMode && !editLocked) {
    tr.innerHTML = `
      <td class="card-qty">
        <div class="qty-stepper">
          <button class="qty-dec" aria-label="Menge verringern">&minus;</button>
          <input type="number" class="qty-input" value="${card.quantity}" min="1" max="99" aria-label="Anzahl" />
          <button class="qty-inc" aria-label="Menge erhöhen">+</button>
        </div>
      </td>
      <td class="${nameClass}">${escapeHtml(card.name)}</td>
      <td class="card-mana">${formatManaCost(card.mana_cost)}</td>
      <td class="card-price">${priceHtml}</td>
      <td class="card-edit-actions">
        <button class="btn-swap-card" title="Karte tauschen" aria-label="Karte tauschen">&#8646;</button>
        <button class="btn-delete-card" title="Karte entfernen" aria-label="Karte entfernen">&times;</button>
      </td>
    `

    const qtyInput = tr.querySelector('.qty-input')
    // Optimistic-Update, aber Writes SERIALISIERT (Promise-Kette) und Rollback
    // nur auf den letzten BESTÄTIGTEN Wert — überlappende Requests bei
    // schnellen +/−-Klicks konnten sonst mit einem verspäteten Fehler
    // erfolgreiche spätere Updates lokal überschreiben (Critic [HIGH]).
    let lastPersistedQty = card.quantity
    let writeChain = Promise.resolve()
    const updateQty = (newQty) => {
      if (!(newQty > 0) || newQty > 99 || newQty === card.quantity) {
        qtyInput.value = card.quantity
        return
      }
      qtyInput.value = newQty
      card.quantity = newQty
      const section = tr.closest('.card-group')
      if (onChanged) onChanged(card, section, {})
      writeChain = writeChain.then(async () => {
        if (lastPersistedQty === newQty) return
        try {
          await updateCardQuantity(card.id, newQty)
          lastPersistedQty = newQty
        } catch {
          // Nur zurückrollen, wenn kein neuerer Klick das Ziel schon geändert hat
          if (card.quantity === newQty) {
            card.quantity = lastPersistedQty
            qtyInput.value = lastPersistedQty
            if (onChanged) onChanged(card, section, {})
          }
        }
      })
    }

    qtyInput.addEventListener('change', () => updateQty(parseInt(qtyInput.value, 10)))
    tr.querySelector('.qty-dec').addEventListener('click', (e) => {
      e.stopPropagation()
      updateQty(card.quantity - 1)
    })
    tr.querySelector('.qty-inc').addEventListener('click', (e) => {
      e.stopPropagation()
      updateQty(card.quantity + 1)
    })

    tr.querySelector('.btn-swap-card').addEventListener('click', (e) => {
      e.stopPropagation()
      tr.dispatchEvent(new CustomEvent('card-swap-request', { bubbles: true, detail: { card, tr } }))
    })

    tr.querySelector('.btn-delete-card').addEventListener('click', (e) => {
      e.stopPropagation()
      showDeleteConfirm(tr, card, onChanged)
    })
  } else {
    tr.innerHTML = `
      <td class="card-qty">${card.quantity}</td>
      <td class="${nameClass}">${escapeHtml(card.name)}</td>
      <td class="card-mana">${formatManaCost(card.mana_cost)}</td>
      <td class="card-price">${priceHtml}</td>
    `
  }

  const previewUri = card.proxy_image_uri || card.image_uri
  const isDfc = card.name?.includes(' // ')
  const dfcInfo = isDfc && card.scryfall_id ? { scryfallId: card.scryfall_id } : null
  if (previewUri) {
    // Vorschau-Daten an der Zeile hinterlegen, damit die Vollbild-Ansicht
    // zur naechsten/vorherigen Karte blaettern kann
    tr._cardPreview = { imageUri: previewUri, cardName: card.name, dfcInfo, bracketCat }
    tr.addEventListener('mouseenter', () => showPreview(previewUri, dfcInfo, bracketCat))
    tr.addEventListener('mouseleave', () => hidePreview())
    tr.addEventListener('click', (e) => {
      if (!('ontouchstart' in window)) return
      // Aktions-Controls (Stepper/Swap/Delete/Confirm) öffnen NIE die Preview —
      // im Edit-Modus triggert nur die Namens-Zelle (Critic R2 [HIGH])
      if (e.target.closest('button, input')) return
      if (editMode && !e.target.closest('.card-name')) return
      e.preventDefault()
      showMobilePreview(previewUri, card.name, dfcInfo, bracketCat, tr)
    })
  }

  return tr
}

// Inline-Confirm in der Zeile statt natives confirm(): kein Modal, kein
// Scroll-Verlust; 5s-Timeout oder Abbrechen stellt die Zeile wieder her.
function showDeleteConfirm(tr, card, onChanged) {
  const colCount = tr.children.length
  tr.classList.add('card-row-confirm')
  tr.innerHTML = `
    <td colspan="${colCount}" class="confirm-cell">
      <span class="confirm-text">„${escapeHtml(card.name)}“ entfernen?</span>
      <button class="btn-confirm-delete">Entfernen</button>
      <button class="btn-cancel-delete">Abbrechen</button>
    </td>
  `

  const restore = () => {
    clearTimeout(timer)
    tr.replaceWith(createCardRow(card, onChanged))
  }
  const timer = setTimeout(restore, 5000)

  tr.querySelector('.btn-cancel-delete').addEventListener('click', (e) => {
    e.stopPropagation()
    restore()
  })
  tr.querySelector('.btn-confirm-delete').addEventListener('click', async (e) => {
    e.stopPropagation()
    clearTimeout(timer)
    const confirmBtn = tr.querySelector('.btn-confirm-delete')
    confirmBtn.disabled = true
    try {
      await deleteCard(card.id)
    } catch {
      tr.querySelector('.confirm-text').textContent = 'Fehler beim Löschen'
      setTimeout(restore, 1500)
      return
    }
    // Section VOR dem Entfernen greifen — danach ist tr.closest() tot
    const section = tr.closest('.card-group')
    tr.remove()
    if (onChanged) onChanged(card, section, { removed: true })
  })
}


// card-list.js — Kartenlisten-Rendering, aus deck-view.js extrahiert, damit
// Edit v2 (Qty/Delete/Swap) chirurgische In-Place-Updates machen kann statt
// Voll-Rerender: jede Gruppen-Section kennt ihre Kategorie (dataset.category),
// jede Zeile ihre Karte (tr._card, gesetzt in createCardRow).

import { createCardRow, isEditMode } from './card-row.js'
import { groupCardsByType, getTypeCategoryLabel, formatPrice } from '../utils.js'
import { summarizeCards, categoryOrderIndex, insertIndexFor } from './card-list-core.js'

export function matchCommander(cardName, commanderName) {
  if (!cardName || !commanderName) return false
  const a = cardName.toLowerCase()
  const b = commanderName.toLowerCase()
  // Exact match, or DFC front-face match (card "A" matches commander "A // B" and vice versa)
  return a === b || a.startsWith(b.split(' // ')[0]) || b.startsWith(a.split(' // ')[0])
}

export function getSortFn(mode) {
  switch (mode) {
    case 'name': return (a, b) => a.name.localeCompare(b.name)
    case 'cmc': return (a, b) => (a.cmc || 0) - (b.cmc || 0) || a.name.localeCompare(b.name)
    case 'price-desc': return (a, b) => ((parseFloat(b.price_eur) || 0) * b.quantity) - ((parseFloat(a.price_eur) || 0) * a.quantity)
    case 'price-asc': return (a, b) => ((parseFloat(a.price_eur) || 0) * a.quantity) - ((parseFloat(b.price_eur) || 0) * b.quantity)
    default: return (a, b) => a.name.localeCompare(b.name)
  }
}

export function renderCardGroups({ cards, commander, commander2, sortMode, onChanged }) {
  const groupsEl = document.getElementById('card-groups')
  groupsEl.innerHTML = ''

  // Extract commander cards and show them first
  const commanderCard = cards.find(c => matchCommander(c.name, commander))
  const commander2Card = commander2 ? cards.find(c => matchCommander(c.name, commander2)) : null
  const commanderCards = [commanderCard, commander2Card].filter(Boolean)
  const remainingCards = cards.filter(c => !commanderCards.includes(c))

  if (commanderCards.length > 0) {
    groupsEl.appendChild(buildGroupSection('Commander', commanderCards, { category: 'commander', onChanged }))
  }

  if (sortMode === 'type') {
    const groups = groupCardsByType(remainingCards)
    for (const group of groups) {
      groupsEl.appendChild(buildGroupSection(group.label, group.cards, { category: group.category, onChanged }))
    }
  } else {
    const sorted = [...remainingCards].sort(getSortFn(sortMode))
    groupsEl.appendChild(buildGroupSection('Alle Karten', sorted, { category: 'all', onChanged }))
  }
}

export function buildGroupSection(label, cards, { category = '', onChanged } = {}) {
  const section = document.createElement('div')
  section.className = 'card-group'
  section.dataset.category = category
  section.dataset.label = label

  // Commander wird nie über die Zeilen-UI getauscht/gelöscht (Meta-Editor ist
  // der Weg) — die Section bleibt auch im Edit-Modus gesperrt
  const editLocked = category === 'commander'
  const { count, total } = summarizeCards(cards)

  section.innerHTML = `
    <h3 class="group-header">
      ${label} (${count})
      <span class="group-total">${formatPrice(total)}</span>
    </h3>
    <table class="card-table">
      <thead>
        <tr>
          <th class="th-qty">#</th>
          <th class="th-name">Karte</th>
          <th class="th-mana">Mana</th>
          <th class="th-price">Preis</th>
          ${isEditMode() && !editLocked ? '<th class="th-actions"></th>' : ''}
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  `

  const tbody = section.querySelector('tbody')
  for (const card of cards) {
    tbody.appendChild(createCardRow(card, onChanged, { editLocked }))
  }

  return section
}

// Kopfzeile (Anzahl + Summe) einer Gruppen-Section aus den aktuell vorhandenen
// Zeilen neu berechnen — Subtotals waren vorher statisch eingebacken und wurden
// nach Qty-Änderung/Delete/Swap stale. Leere Section verschwindet komplett
// (wie beim Initial-Render, das nur nicht-leere Gruppen erzeugt).
export function updateGroupHeader(section) {
  if (!section || !section.isConnected) return
  const rowCards = [...section.querySelectorAll('tbody tr')]
    .map(tr => tr._card)
    .filter(Boolean)
  if (rowCards.length === 0) {
    section.remove()
    return
  }
  const { count, total } = summarizeCards(rowCards)
  const header = section.querySelector('.group-header')
  if (!header) return
  header.innerHTML = `
      ${section.dataset.label} (${count})
      <span class="group-total">${formatPrice(total)}</span>
  `
}

// Neue Karte gezielt in die bestehende Gruppen-Ansicht einfügen — statt
// Voll-Rerender (Scroll-/Fokus-Erhalt). Gibt die neue <tr> zurück.
export function addCardToGroups(card, { sortMode, onChanged }) {
  const groupsEl = document.getElementById('card-groups')
  if (!groupsEl) return null

  let section, insertBeforeRow = null

  if (sortMode === 'type') {
    const cat = card.type_category || 'other'
    section = groupsEl.querySelector(`.card-group[data-category="${cat}"]`)
    if (!section) {
      section = buildGroupSection(getTypeCategoryLabel(cat), [card], { category: cat, onChanged })
      const newIdx = categoryOrderIndex(cat)
      const siblings = [...groupsEl.querySelectorAll('.card-group')]
        .filter(s => s.dataset.category && s.dataset.category !== 'commander')
      const anchor = siblings.find(s => categoryOrderIndex(s.dataset.category) > newIdx)
      groupsEl.insertBefore(section, anchor || null)
      return section.querySelector('tbody tr')
    }
    // Innerhalb der Gruppe alphabetisch (entspricht der DB-Sortierung name asc)
    const rows = [...section.querySelectorAll('tbody tr')]
    const idx = insertIndexFor(rows.map(tr => tr._card).filter(Boolean), card, getSortFn('name'))
    insertBeforeRow = idx === -1 ? null : rows[idx]
  } else {
    section = groupsEl.querySelector('.card-group[data-category="all"]')
    if (!section) {
      section = buildGroupSection('Alle Karten', [card], { category: 'all', onChanged })
      groupsEl.appendChild(section)
      return section.querySelector('tbody tr')
    }
    const rows = [...section.querySelectorAll('tbody tr')]
    const idx = insertIndexFor(rows.map(tr => tr._card).filter(Boolean), card, getSortFn(sortMode))
    insertBeforeRow = idx === -1 ? null : rows[idx]
  }

  const tr = createCardRow(card, onChanged)
  // Einzeln eingefuegte Zeilen (Add/Swap/Undo) faden ein (Motion-Sweep)
  tr.classList.add('card-row-enter')
  const tbody = section.querySelector('tbody')
  tbody.insertBefore(tr, insertBeforeRow)
  updateGroupHeader(section)
  return tr
}

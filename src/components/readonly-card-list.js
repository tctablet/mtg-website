// readonly-card-list.js — Kartenliste im Deck-View-Look OHNE Edit-Kopplung.
// card-row.js hängt an Supabase-Writes/Edit-Mode und ist hier bewusst tabu;
// die CSS-Klassen (.card-group/.card-table/.card-row/Gruppen-Header) tragen
// den Look. Genutzt vom Commander-Scan: EDHREC-Listen, angereichert mit
// Scryfall-Daten (Typ, Mana, CMC, Bild) + unseren Preisen.
//
// Preview-Verhalten wie in der Deck-Ansicht: mit hoverSidebar aktualisiert
// Hover die sticky Sidebar (#deck-card-preview) und Tap öffnet das Overlay
// (Touch); ohne Sidebar (Listen in der Echte-Decks-Tabelle) öffnet Klick das
// Overlay überall. Der Container bekommt data-preview-scope, damit Vor/Zurück
// nur innerhalb DIESER Liste blättert (auf /scan stehen mehrere Listen im DOM).

import { groupCardsByType, getTypeCategory, formatPrice, formatManaCost, escapeHtml } from '../utils.js'
import { getCardNormalImage } from '../scryfall.js'
import { showPreview, hidePreview, showMobilePreview } from './card-preview.js'
import { matchCommander, getSortFn } from './card-list.js'
import { classifyCard } from '../bracket.js'

// EDHREC-Liste ({name, quantity}) + Scryfall-Collection + Preis-Infos zu
// render-fertigen Karten mergen (pure, node-testbar).
// Der Index enthält Voll-Namen UND Front-Face (DFC: EDHREC sagt "A",
// Scryfall "A // B").
export function buildScryfallIndex(scryfallCards) {
  const index = new Map()
  for (const card of scryfallCards || []) {
    if (!card?.name) continue
    index.set(card.name.toLowerCase(), card)
    if (card.name.includes(' // ')) {
      const front = card.name.split(' // ')[0].toLowerCase()
      if (!index.has(front)) index.set(front, card)
    }
  }
  return index
}

// Scryfall-Collection-Karte auf das reduzieren, was enrichCards/renderDeckStats
// brauchen — volle Karten sprengen den sessionStorage (100 Karten ≈ 300+ KB,
// slim ≈ 30 KB) und der Scan cached die Collection pro Commander (pure, testbar).
export function slimCollectionCard(c) {
  return {
    name: c.name,
    type_line: c.type_line || c.card_faces?.[0]?.type_line || '',
    cmc: typeof c.cmc === 'number' ? c.cmc : 0,
    id: c.id,
    mana_cost: c.mana_cost || undefined,
    image_uris: c.image_uris?.normal ? { normal: c.image_uris.normal } : undefined,
    card_faces: c.card_faces ? [{
      name: c.card_faces[0]?.name,
      mana_cost: c.card_faces[0]?.mana_cost,
      image_uris: c.card_faces[0]?.image_uris?.normal
        ? { normal: c.card_faces[0].image_uris.normal }
        : undefined,
    }] : undefined,
  }
}

export function enrichCards(cards, scryfallIndex, priced) {
  const priceByName = new Map((priced || []).map(p => [p.name, p]))
  return (cards || []).map(({ name, quantity }) => {
    const sf = scryfallIndex?.get?.(name.toLowerCase()) || null
    const p = priceByName.get(name)
    return {
      name,
      quantity: quantity || 1,
      // Feldnamen wie in der cards-Tabelle — Gruppierung, Sortierung und
      // renderDeckStats teilen sich die Logik mit der Deck-Ansicht
      price_eur: p?.price ?? null,
      price_is_foil: !!p?.isFoil,
      type_category: sf ? getTypeCategory(sf.type_line) : 'other',
      mana_cost: sf?.mana_cost || sf?.card_faces?.[0]?.mana_cost || '',
      cmc: typeof sf?.cmc === 'number' ? sf.cmc : 0,
      image_uri: sf ? getCardNormalImage(sf) : null,
      scryfall_id: sf?.id || null,
    }
  })
}

// Liste im Deck-View-Look rendern: Commander-Sektion zuerst, dann Typ-Gruppen
// (sortMode 'type') bzw. eine sortierte Gesamtliste (Name/CMC/Preis — dieselben
// Modi wie die Deck-Ansicht, getSortFn ist geteilt).
export function renderReadonlyCardGroups(container, cards, { commanders = [], sortMode = 'type', hoverSidebar = false } = {}) {
  container.innerHTML = ''
  container.dataset.previewScope = '1'

  const commanderCards = commanders.length
    ? cards.filter(c => commanders.some(n => matchCommander(c.name, n)))
    : []
  const rest = cards.filter(c => !commanderCards.includes(c))

  const sections = []
  if (commanderCards.length) sections.push({ label: 'Commander', cards: commanderCards })
  if (sortMode === 'type') {
    for (const g of groupCardsByType(rest)) sections.push({ label: g.label, cards: g.cards })
  } else {
    sections.push({ label: 'Alle Karten', cards: [...rest].sort(getSortFn(sortMode)) })
  }

  for (const group of sections) {
    const count = group.cards.reduce((s, c) => s + (c.quantity || 1), 0)
    const total = group.cards.reduce((s, c) => s + (parseFloat(c.price_eur) || 0) * (c.quantity || 1), 0)
    const section = document.createElement('div')
    section.className = 'card-group'
    section.innerHTML = `
      <h3 class="group-header">
        ${escapeHtml(group.label)} (${count})
        <span class="group-total">${formatPrice(total)}</span>
      </h3>
      <table class="card-table">
        <thead>
          <tr>
            <th class="th-qty">#</th>
            <th class="th-name">Karte</th>
            <th class="th-mana">Mana</th>
            <th class="th-price">Preis</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    `
    const tbody = section.querySelector('tbody')
    for (const card of group.cards) {
      tbody.appendChild(buildReadonlyRow(card, { hoverSidebar }))
    }
    container.appendChild(section)
  }
}

function buildReadonlyRow(card, { hoverSidebar }) {
  const tr = document.createElement('tr')
  const bracketCat = classifyCard(card.name)
  tr.className = 'card-row card-row-readonly' + (bracketCat ? ` card-row-bracket-${bracketCat}` : '')
  const priceHtml = `${card.price_is_foil ? '<span class="foil-badge" title="Nur als Foil verfügbar">✦</span>' : ''}${card.price_eur != null ? formatPrice(card.price_eur) : '–'}`
  tr.innerHTML = `
    <td class="card-qty">${card.quantity}</td>
    <td class="card-name${bracketCat ? ` card-name-bracket-${bracketCat}` : ''}">${escapeHtml(card.name)}</td>
    <td class="card-mana">${formatManaCost(card.mana_cost)}</td>
    <td class="card-price">${priceHtml}</td>
  `

  if (card.image_uri) {
    const isDfc = card.name.includes(' // ')
    const dfcInfo = isDfc && card.scryfall_id ? { scryfallId: card.scryfall_id } : null
    tr._cardPreview = { imageUri: card.image_uri, cardName: card.name, dfcInfo, bracketCat }
    const openOverlay = () => showMobilePreview(card.image_uri, card.name, dfcInfo, bracketCat, tr)

    if (hoverSidebar) {
      // Exakt das card-row-Muster der Deck-Ansicht: Hover → Sidebar,
      // Tap (Touch) → Vollbild-Overlay
      tr.addEventListener('mouseenter', () => showPreview(card.image_uri, dfcInfo, bracketCat))
      tr.addEventListener('mouseleave', () => hidePreview())
      tr.addEventListener('click', (e) => {
        if (!('ontouchstart' in window)) return
        if (e.target.closest('button, input')) return
        e.preventDefault()
        openOverlay()
      })
    } else {
      tr.tabIndex = 0
      tr.setAttribute('role', 'button')
      tr.setAttribute('aria-label', `${card.name} — Karte anzeigen`)
      tr.addEventListener('click', openOverlay)
      tr.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        openOverlay()
      })
    }
  }
  return tr
}

// autocomplete.js — geteilter Debounce-/Keyboard-Nav-Kern für Add-Bar und
// Swap-Picker (extrahiert aus dem alten setupAddCard in deck-view.js).
//
// PFLICHT-Race-Guard (Plan-Critic [HIGH]): pro Eingabe-Fenster ein monotoner
// Sequenz-Token — nur die Response des JÜNGSTEN Requests darf rendern
// (latest-wins). Ohne das könnte eine langsame alte Response die aktuelle
// Kandidatenliste überschreiben, und der Confirm-lose Sofort-Swap würde auf
// veralteten Daten ausgeführt. Zusätzliche Sicherung: jeder gerenderte
// Vorschlag trägt SEIN Datenobjekt am Element — Aktionen wirken immer auf den
// tatsächlich angetippten Kandidaten, nie auf globalen State.

import { autocompleteCard, fetchCardCollection } from '../scryfall.js'
import { fetchCheapestPrices } from '../supabase.js'
import { formatPrice, escapeHtml } from '../utils.js'

// Pure + testbar: latest-wins-Token
export function createLatestGuard() {
  let current = 0
  return {
    begin() { return ++current },
    isCurrent(id) { return id === current },
  }
}

// Pure + testbar: Scryfall-Collection + Preis-Map zu Vorschlags-Items mappen.
// DFC-Falle: die Autocomplete-API liefert oft Front-Face-Namen ("A"), die
// Collection den vollen Namen ("A // B") — deshalb beides indexieren und
// Preise über den AUFGELÖSTEN vollen Namen nachschlagen.
export function mapSuggestions(names, found, prices) {
  const byName = new Map()
  for (const sc of found) {
    byName.set(sc.name.toLowerCase(), sc)
    if (sc.name.includes(' // ')) {
      byName.set(sc.name.split(' // ')[0].toLowerCase(), sc)
    }
  }
  return names.map(n => {
    const sc = byName.get(n.toLowerCase())
    const resolvedName = sc?.name || n
    const price = prices.get(resolvedName) ?? prices.get(n)
    return {
      name: resolvedName,
      thumb: sc?.image_uris?.small || sc?.card_faces?.[0]?.image_uris?.small || null,
      // normal-Auflösung für große Darstellungen (Swap-Picker-Kartenvergleich)
      image: sc?.image_uris?.normal || sc?.card_faces?.[0]?.image_uris?.normal || null,
      mana: sc?.mana_cost || sc?.card_faces?.[0]?.mana_cost || '',
      price: price?.price ?? null,
      isFoil: !!price?.isFoil,
    }
  })
}

// Angereicherte Vorschläge: Namen → volle Karten (Bild/Mana) → DB-Preise.
// Sequenziell, weil der Preis-Lookup die aufgelösten vollen Namen braucht.
export async function fetchCardSuggestions(query, { limit = 6 } = {}) {
  const names = (await autocompleteCard(query)).slice(0, limit)
  if (!names.length) return []
  const { found } = await fetchCardCollection(names)
  const resolved = [...new Set([...names, ...found.map(c => c.name)])]
  const prices = await fetchCheapestPrices(resolved)
  return mapSuggestions(names, found, prices)
}

function renderSuggestionItem(item) {
  const priceText = item.price != null
    ? `${item.isFoil ? '<span class="foil-badge" role="img" aria-label="Nur als Foil verfügbar" title="Nur als Foil verfügbar">✦</span>' : ''}${formatPrice(item.price)}`
    : '<span class="suggestion-no-price">–</span>'
  return `
    <div class="suggestion-thumb">${item.thumb ? `<img src="${escapeHtml(item.thumb)}" alt="" loading="lazy" />` : ''}</div>
    <span class="suggestion-name">${escapeHtml(item.name)}</span>
    <span class="suggestion-price">${priceText}</span>
  `
}

// Verdrahtet Input + Liste. Rückgabe: { destroy, clear }.
// onPick(item) bekommt das am Element gebundene Datenobjekt.
export function attachCardAutocomplete({ input, listEl, onPick, limit = 6, debounceMs = 250, minLen = 2 }) {
  const guard = createLatestGuard()
  let timer = null

  const clear = () => {
    listEl.hidden = true
    listEl.innerHTML = ''
  }

  const render = (items) => {
    if (!items.length) { clear(); return }
    listEl.innerHTML = ''
    for (const item of items) {
      const el = document.createElement('div')
      el.className = 'autocomplete-item autocomplete-item-rich'
      el.innerHTML = renderSuggestionItem(item)
      el._item = item // Datenbindung am Element (Race-Sicherung Stufe 2)
      el.addEventListener('click', () => onPick(el._item))
      listEl.appendChild(el)
    }
    listEl.hidden = false
  }

  const onInput = () => {
    clearTimeout(timer)
    const query = input.value.trim()
    if (query.length < minLen) { clear(); return }
    timer = setTimeout(async () => {
      const token = guard.begin()
      try {
        const items = await fetchCardSuggestions(query, { limit })
        if (!guard.isCurrent(token)) return // stale Response verwerfen
        // Query könnte inzwischen gelöscht sein
        if (input.value.trim().length < minLen) { clear(); return }
        render(items)
      } catch {
        if (guard.isCurrent(token)) clear()
      }
    }, debounceMs)
  }

  const onKeyDown = (e) => {
    const items = listEl.querySelectorAll('.autocomplete-item')
    const active = listEl.querySelector('.autocomplete-item.active')
    let idx = [...items].indexOf(active)

    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (active) active.classList.remove('active')
      idx = (idx + 1) % items.length
      items[idx]?.classList.add('active')
      items[idx]?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (active) active.classList.remove('active')
      idx = idx <= 0 ? items.length - 1 : idx - 1
      items[idx]?.classList.add('active')
      items[idx]?.scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = active || items[0]
      if (target?._item) onPick(target._item)
    } else if (e.key === 'Escape') {
      clear()
    }
  }

  input.addEventListener('input', onInput)
  input.addEventListener('keydown', onKeyDown)

  return {
    clear,
    destroy() {
      clearTimeout(timer)
      input.removeEventListener('input', onInput)
      input.removeEventListener('keydown', onKeyDown)
      clear()
    },
  }
}

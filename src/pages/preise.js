// preise.js — Preisdatenbank-Unterseite: durchsuchbare Sicht auf die täglich
// gesyncte scryfall_prices-Tabelle (~38k Kartennamen, günstigster EUR-Preis).
//
// Öffentlich (nur anon-lesbare Daten, wie /resterampe). Desktop: klickbare
// Spalten-Header als Sort + Seiten-Pagination. Mobile (≤480): Sort-Select +
// „Mehr laden"-Append, „Aktualisiert"-Spalte weicht (Column-Priority) — beide
// Bedienungen laufen auf demselben State, CSS blendet die jeweils andere aus.
// URL spiegelt ?q=&sort=&dir=&page= via history.replaceState (Deep-Links).

import { searchPrices, getPriceDbInfo, fetchPrintingsFromDB } from '../supabase.js'
import { fetchCardByName, getCardNormalImage } from '../scryfall.js'
import { formatPrice, isPriceStale, escapeHtml, parseSortValue, renderLoadError } from '../utils.js'

const PAGE_SIZE = 50

export async function renderPreise(container) {
  container.innerHTML = '<p class="loading">Lade Preisdatenbank...</p>'

  let info
  try {
    info = await getPriceDbInfo()
  } catch (err) {
    renderLoadError(container, err, () => renderPreise(container))
    return
  }

  // State aus der URL (Deep-Link) — Render setzt Modul-Zombies zurück.
  // dir-Default folgt der Header-Klick-Konvention (Critic-Fund: geteilte
  // ?sort=price-Links müssen wie der Klick absteigend starten)
  const params = new URLSearchParams(location.search)
  const urlSort = params.get('sort') || 'name'
  const urlDir = params.get('dir') || (urlSort === 'name' ? 'asc' : 'desc')
  const initial = parseSortValue(`${urlSort}-${urlDir}`)
  const state = {
    query: params.get('q') || '',
    sort: initial.sort,
    ascending: initial.ascending,
    page: Math.max(0, parseInt(params.get('page') || '0', 10) || 0),
    // rows = ALLE aktuell angezeigten Zeilen (im Append-Modus kumulativ!);
    // appendBase = Seite, ab der die Akkumulation läuft (Offset-Rechnung)
    rows: [],
    appendBase: 0,
    total: 0,
  }

  const stale = info.lastUpdated ? isPriceStale(info.lastUpdated) : true
  const standDate = info.lastUpdated
    ? new Date(info.lastUpdated).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : 'unbekannt'

  container.innerHTML = `
    <div class="page">
      <h2>Preisdatenbank</h2>
      <p class="price-db-meta">
        Stand: <strong>${standDate}</strong> &middot; ${info.total.toLocaleString('de-DE')} Karten
        &middot; günstigster EUR-Preis über alle Printings
      </p>
      ${stale ? '<p class="price-db-stale">Preisdaten sind älter als 7 Tage — der tägliche Sync ist womöglich rot.</p>' : ''}
      <div class="price-controls">
        <input type="text" id="price-search" class="price-search" placeholder="Karte suchen..."
          autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false"
          value="${escapeHtml(state.query)}" />
        <select id="price-sort-select" class="sort-select price-sort-select" aria-label="Sortierung">
          <option value="name-asc">Name A–Z</option>
          <option value="name-desc">Name Z–A</option>
          <option value="price-desc">Preis absteigend</option>
          <option value="price-asc">Preis aufsteigend</option>
          <option value="updated-desc">Zuletzt aktualisiert</option>
        </select>
      </div>
      <div class="price-table-wrap">
        <table class="card-table price-table">
          <thead>
            <tr>
              <th class="th-name th-sortable" data-sort="name">Karte <span class="sort-indicator"></span></th>
              <th class="th-price th-sortable" data-sort="price">Preis <span class="sort-indicator"></span></th>
              <th class="th-updated th-sortable" data-sort="updated">Aktualisiert <span class="sort-indicator"></span></th>
            </tr>
          </thead>
          <tbody id="price-rows"></tbody>
        </table>
      </div>
      <div class="price-pagination" id="price-pagination"></div>
      <button class="btn btn-secondary price-load-more" id="price-load-more" hidden>Mehr laden</button>
    </div>
  `

  const searchInput = document.getElementById('price-search')
  const sortSelect = document.getElementById('price-sort-select')
  const tbody = document.getElementById('price-rows')
  const paginationEl = document.getElementById('price-pagination')
  const loadMoreBtn = document.getElementById('price-load-more')

  const syncControls = () => {
    sortSelect.value = `${state.sort}-${state.ascending ? 'asc' : 'desc'}`
    container.querySelectorAll('.th-sortable').forEach(th => {
      const active = th.dataset.sort === state.sort
      th.classList.toggle('th-sort-active', active)
      th.setAttribute('aria-sort', active ? (state.ascending ? 'ascending' : 'descending') : 'none')
      th.querySelector('.sort-indicator').textContent = active ? (state.ascending ? '▲' : '▼') : '⇅'
    })
  }

  const syncUrl = () => {
    const p = new URLSearchParams()
    if (state.query) p.set('q', state.query)
    if (state.sort !== 'name' || !state.ascending) {
      p.set('sort', state.sort)
      p.set('dir', state.ascending ? 'asc' : 'desc')
    }
    if (state.page > 0) p.set('page', String(state.page))
    const qs = p.toString()
    history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''))
  }

  const relativeDate = (ts) => {
    if (!ts) return '–'
    const days = Math.floor((Date.now() - new Date(ts).getTime()) / 86400000)
    if (days <= 0) return 'heute'
    if (days === 1) return 'gestern'
    return `vor ${days} Tagen`
  }

  const renderRows = () => {
    // rendert IMMER den kompletten state.rows-Stand — kein DOM-Concat-Trick,
    // damit der Detail-Klick jede sichtbare Zeile in state.rows findet
    // (Critic [HIGH]: Append durfte ältere Zeilen nicht aus dem State werfen)
    if (!state.rows.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="empty">Keine Karten gefunden.</td></tr>'
    } else {
      tbody.innerHTML = state.rows.map(r => `
        <tr class="price-row" data-name="${escapeHtml(r.name)}" tabindex="0" role="button" aria-label="${escapeHtml(r.name)} — Details">
          <td class="card-name">${escapeHtml(r.name)}</td>
          <td class="card-price">${r.is_foil ? '<span class="foil-badge" title="Nur als Foil verfügbar">✦</span>' : ''}${formatPrice(r.cheapest_eur)}</td>
          <td class="price-updated">${relativeDate(r.updated_at)}</td>
        </tr>
      `).join('')
    }

    const totalPages = Math.max(1, Math.ceil(state.total / PAGE_SIZE))
    paginationEl.innerHTML = `
      <button class="btn-small" id="price-prev" ${state.page <= 0 ? 'disabled' : ''}>&larr; Zurück</button>
      <span class="price-page-info">Seite ${Math.min(state.page + 1, totalPages)}/${totalPages} &middot; ${state.total.toLocaleString('de-DE')} Treffer</span>
      <button class="btn-small" id="price-next" ${(state.page + 1) >= totalPages ? 'disabled' : ''}>Weiter &rarr;</button>
    `
    document.getElementById('price-prev').addEventListener('click', () => loadPage(state.page - 1))
    document.getElementById('price-next').addEventListener('click', () => loadPage(state.page + 1))

    // Mobile-Append: Offset = Startseite der Akkumulation + bereits geladene Zeilen
    const consumed = state.appendBase * PAGE_SIZE + state.rows.length
    const remaining = Math.max(0, state.total - consumed)
    loadMoreBtn.hidden = remaining <= 0 || !state.rows.length
    loadMoreBtn.disabled = false
    loadMoreBtn.textContent = `Mehr laden (${Math.min(PAGE_SIZE, remaining)} von ${remaining.toLocaleString('de-DE')} weiteren)`
    delete loadMoreBtn.dataset.label
  }

  // Search-as-you-type: Debounce ~200ms + AbortController + latest-wins über
  // den Controller selbst (neue Anfrage bricht die alte ab)
  let activeController = null
  let debounceTimer = null

  // Buttons während des Fetches sperren (Critic R2 [HIGH]: Doppel-Tap auf
  // „Mehr laden" abortete sonst die laufende Seite und verlor sie still)
  const setBusy = (busy) => {
    loadMoreBtn.disabled = busy
    if (busy) loadMoreBtn.dataset.label = loadMoreBtn.textContent
    loadMoreBtn.textContent = busy ? 'Lädt…' : (loadMoreBtn.dataset.label || loadMoreBtn.textContent)
    paginationEl.querySelectorAll('button').forEach(b => { b.disabled = busy || b.disabled })
  }

  async function loadPage(page, { append = false } = {}) {
    const targetPage = Math.max(0, page)
    activeController?.abort()
    const controller = new AbortController()
    activeController = controller
    setBusy(true)
    try {
      const { rows, total } = await searchPrices({
        query: state.query,
        sort: state.sort,
        ascending: state.ascending,
        page: targetPage,
        pageSize: PAGE_SIZE,
        signal: controller.signal,
      })
      if (controller !== activeController) return // stale Response
      // state.page erst NACH Erfolg vorrücken — ein abgebrochener/gescheiterter
      // Append darf keine Lücke in der Akkumulation hinterlassen
      state.page = targetPage
      state.total = total
      if (append) {
        state.rows = state.rows.concat(rows) // kumulativ — State == DOM
      } else {
        state.rows = rows
        state.appendBase = state.page
      }
      renderRows()
      syncControls()
      syncUrl()
    } catch (err) {
      if (controller !== activeController) return // Abort der alten Anfrage
      loadMoreBtn.disabled = false
      if (loadMoreBtn.dataset.label) {
        loadMoreBtn.textContent = loadMoreBtn.dataset.label
        delete loadMoreBtn.dataset.label
      }
      paginationEl.querySelectorAll('button').forEach(b => { b.disabled = false })
      tbody.innerHTML = `<tr><td colspan="3" class="empty">Fehler: ${escapeHtml(err.message)} <button class="btn-small" id="price-retry">Nochmal</button></td></tr>`
      document.getElementById('price-retry')?.addEventListener('click', () => loadPage(targetPage, { append }))
    }
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      state.query = searchInput.value.trim()
      loadPage(0) // Suche setzt die Seite zurück
    }, 200)
  })

  sortSelect.addEventListener('change', () => {
    const { sort, ascending } = parseSortValue(sortSelect.value)
    state.sort = sort
    state.ascending = ascending
    loadPage(0)
  })

  container.querySelectorAll('.th-sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort
      if (state.sort === col) {
        state.ascending = !state.ascending
      } else {
        state.sort = col
        // Preis + Aktualisiert starten absteigend (teuerste/frischste zuerst)
        state.ascending = col === 'name'
      }
      loadPage(0)
    })
  })

  loadMoreBtn.addEventListener('click', () => loadPage(state.page + 1, { append: true }))

  // Karten-Detail (Delegation — überlebt jedes Rows-Rerender; auch Tastatur)
  const openDetailFor = (tr) => {
    const row = state.rows.find(r => r.name === tr.dataset.name)
      || { name: tr.dataset.name, cheapest_eur: null, is_foil: false, updated_at: null }
    openPriceDetail(row)
  }
  tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('.price-row')
    if (tr) openDetailFor(tr)
  })
  tbody.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    const tr = e.target.closest('.price-row')
    if (!tr) return
    e.preventDefault()
    openDetailFor(tr)
  })

  syncControls()
  await loadPage(state.page)
}

// Detail-Modal: Bild + Printings aus dem card_printings-Cache (nur Deck-Karten
// enthalten), Scryfall-Fallback nur fürs Bild. Nutzt die Artwork-Picker-CSS
// (inkl. Mobile-Bottom-Sheet) mit Zusatzklasse .price-detail.
let closeActivePriceDetail = null

function openPriceDetail(priceRow) {
  if (closeActivePriceDetail) closeActivePriceDetail()
  document.getElementById('price-detail-modal')?.remove()

  const modal = document.createElement('div')
  modal.id = 'price-detail-modal'
  modal.className = 'artwork-picker-overlay'
  modal.innerHTML = `
    <div class="artwork-picker price-detail" role="dialog" aria-modal="true" aria-label="${escapeHtml(priceRow.name)}" tabindex="-1">
      <div class="artwork-picker-header">
        <h3>${escapeHtml(priceRow.name)}</h3>
        <span class="price-detail-price">${priceRow.is_foil ? '<span class="foil-badge">✦</span>' : ''}${formatPrice(priceRow.cheapest_eur)}</span>
        <button class="artwork-picker-close" aria-label="Schließen">&times;</button>
      </div>
      <div class="artwork-picker-grid price-detail-body">
        <div class="price-detail-image"><p class="loading">Lade Bild...</p></div>
        <div class="price-detail-printings"><p class="loading">Lade Printings...</p></div>
      </div>
    </div>
  `
  document.body.appendChild(modal)
  document.body.classList.add('modal-open')
  requestAnimationFrame(() => modal.classList.add('visible'))

  function onRouteChange() { closeModal() }
  function onKeyDown(e) { if (e.key === 'Escape') closeModal() }
  let closing = false
  function closeModal() {
    if (closing) return
    closing = true
    window.removeEventListener('route-change', onRouteChange)
    document.removeEventListener('keydown', onKeyDown)
    document.body.classList.remove('modal-open')
    if (closeActivePriceDetail === closeModal) closeActivePriceDetail = null
    modal.classList.remove('visible')
    modal.classList.add('closing')
    setTimeout(() => modal.remove(), 300)
  }
  closeActivePriceDetail = closeModal

  modal.querySelector('.artwork-picker-close').addEventListener('click', closeModal)
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal() })
  window.addEventListener('route-change', onRouteChange)
  document.addEventListener('keydown', onKeyDown)
  modal.querySelector('.artwork-picker').focus()

  const imageEl = modal.querySelector('.price-detail-image')
  const printingsEl = modal.querySelector('.price-detail-printings')

  ;(async () => {
    let printings = null
    try {
      const map = await fetchPrintingsFromDB([priceRow.name])
      printings = map?.get(priceRow.name.toLowerCase()) || null
    } catch { /* Cache optional — Scryfall-Fallback unten */ }

    if (!modal.isConnected) return

    if (printings?.length) {
      // Printing-Shape aus printings.js: { set (= Set-NAME), set_code, released, image_normal, ... }
      imageEl.innerHTML = `<img src="${escapeHtml(printings[0].image_normal || printings[0].image_small || '')}" alt="${escapeHtml(priceRow.name)}" />`
      printingsEl.innerHTML = `
        <h4>Printings (${printings.length})</h4>
        <ul class="price-printings-list">
          ${printings.map(p => `
            <li>
              <span class="printing-set">${escapeHtml(p.set || '')}</span>
              <span class="printing-meta">${escapeHtml((p.set_code || '').toUpperCase())}${p.released ? ` · ${String(p.released).slice(0, 4)}` : ''}</span>
            </li>
          `).join('')}
        </ul>
      `
    } else {
      // Kein Cache-Treffer (Karte liegt in keinem Deck) → Scryfall nur fürs Bild
      printingsEl.innerHTML = '<p class="price-detail-hint">Keine Printings im Cache — die Karte liegt in keinem Deck der Runde.</p>'
      try {
        const card = await fetchCardByName(priceRow.name)
        if (!modal.isConnected) return
        const img = card ? getCardNormalImage(card) : null
        imageEl.innerHTML = img
          ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(priceRow.name)}" />`
          : '<p class="price-detail-hint">Kein Bild verfügbar.</p>'
      } catch {
        if (modal.isConnected) imageEl.innerHTML = '<p class="price-detail-hint">Kein Bild verfügbar.</p>'
      }
      return
    }
  })()
}

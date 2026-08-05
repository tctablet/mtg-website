// preise.js — Preisdatenbank mit zwei Views:
//
// „Sets" (Default): der VOLLE Scryfall-Katalog wie auf scryfall.com — Sets
// nach Release absteigend, Set öffnen → Karten-Grid in Collector-Reihenfolge
// mit Bildern, darüber liegen UNSERE Preise (scryfall_prices, günstigster
// EUR über alle Printings). Kartenklick = große Karte + Preis (Lightbox,
// bewusst ohne Printings-Liste — User-Ansage).
//
// „Alle Karten": die bestehende durchsuchbare Tabelle über alle ~38k Namen
// (Header-Sort Desktop, Select + „Mehr laden" Mobile, URL-Deep-Links).
// Back-Compat: alte Links mit ?q=/sort=/page= ohne view-Param landen
// automatisch hier, nie im Sets-View.

import {
  searchPrices, getPriceDbInfo, fetchPrintingsFromDB, fetchCheapestPrices,
} from '../supabase.js'
import { fetchCardByName, fetchCardCollection, getCardNormalImage, fetchAllSets, fetchSetCardsPage } from '../scryfall.js'
import { slimSet, filterSets, groupSetsByYear, setSearchUrl, extractSetCardsPage, mergeOurPrices } from '../sets.js'
import { buildScryfallIndex } from '../components/readonly-card-list.js'
import { createLatestGuard } from '../components/autocomplete.js'
import { formatPrice, isPriceStale, escapeHtml, parseSortValue, renderLoadError } from '../utils.js'
import { loadingHtml, refade } from '../components/loading.js'

const PAGE_SIZE = 50

// Bild-Auflösung fürs Alle-Karten-Grid: EIN collection-Batch pro Seite statt
// 50 einzelner named?format=image-Requests (Scryfall drosselt auf ~10/s und
// bittet ausdrücklich, die API nicht als Bild-Server zu nutzen — der alte Weg
// war der Haupt-Bremser auf dem Handy). Name (lowercase) → CDN-URL | null
// (null = bei Scryfall nicht gefunden, Kachel zeigt den Namen).
const cardImageCache = new Map()

async function resolveCardImages(names) {
  const missing = [...new Set(names)].filter(n => !cardImageCache.has(n.toLowerCase()))
  if (!missing.length) return
  const { found } = await fetchCardCollection(missing)
  const idx = buildScryfallIndex(found)
  const collectionMisses = []
  for (const n of missing) {
    const card = idx.get(n.toLowerCase()) || idx.get(n.split(' // ')[0].toLowerCase())
    if (card) {
      cardImageCache.set(n.toLowerCase(), getCardNormalImage(card))
    } else {
      collectionMisses.push(n)
    }
  }
  // Scryfall-Eigenheit: der collection-Endpoint kennt manche legale Namen
  // nicht, die named?exact sehr wohl findet ("_____", Unhinged — Critic-Fund).
  // Einzel-Fallback nur für diese seltenen Misses, hart gedeckelt.
  for (const n of collectionMisses.slice(0, 5)) {
    try {
      const card = await fetchCardByName(n)
      cardImageCache.set(n.toLowerCase(), card ? getCardNormalImage(card) : null)
    } catch {
      cardImageCache.set(n.toLowerCase(), null)
    }
  }
  for (const n of collectionMisses.slice(5)) {
    cardImageCache.set(n.toLowerCase(), null)
  }
}

const cachedCardImage = (name) => cardImageCache.get(name.toLowerCase())

const skeletonTiles = (n) => Array.from({ length: n }, () =>
  '<div class="card-tile"><span class="card-tile-frame card-tile-frame-loading"></span></div>'
).join('')

export async function renderPreise(container) {
  const params = new URLSearchParams(location.search)
  // Back-Compat (Critic): geteilte Such-Links (?q=…) implizieren die Liste
  const hasListParams = params.has('q') || params.has('sort') || params.has('page')
  let view = params.get('view') || (hasListParams ? 'liste' : 'sets')
  if (view !== 'sets' && view !== 'liste') view = 'sets'

  container.innerHTML = `
    <div class="page preise-page">
      <div class="preise-head">
        <h2>Preisdatenbank</h2>
        <div class="view-toggle" role="tablist" aria-label="Ansicht">
          <button class="view-toggle-btn" data-view="sets" role="tab">Sets</button>
          <button class="view-toggle-btn" data-view="liste" role="tab">Alle Karten</button>
        </div>
      </div>
      <div id="preise-sets-view" hidden></div>
      <div id="preise-liste-view" hidden></div>
    </div>
  `

  const setsEl = document.getElementById('preise-sets-view')
  const listeEl = document.getElementById('preise-liste-view')
  const toggleBtns = [...container.querySelectorAll('.view-toggle-btn')]
  const inited = { sets: false, liste: false }
  // Jeder View registriert seine URL-Sync-Funktion — der Tab-Wechsel stellt
  // damit den Deep-Link-State des Ziel-Views wieder her (Critic-Fund: ein
  // offenes ?set=neo ging beim Hin-und-Her-Wechseln sonst verloren)
  const viewSync = { sets: null, liste: null }

  const activate = (v) => {
    view = v
    setsEl.hidden = v !== 'sets'
    listeEl.hidden = v !== 'liste'
    toggleBtns.forEach(b => {
      const active = b.dataset.view === v
      b.classList.toggle('view-toggle-active', active)
      b.setAttribute('aria-selected', active ? 'true' : 'false')
    })
    if (v === 'sets' && !inited.sets) {
      inited.sets = true
      viewSync.sets = initSetsView(setsEl)
    }
    if (v === 'liste' && !inited.liste) {
      inited.liste = true
      initListeView(listeEl).then(sync => { viewSync.liste = sync })
    }
  }

  toggleBtns.forEach(b => b.addEventListener('click', () => {
    if (view === b.dataset.view) return
    activate(b.dataset.view)
    if (viewSync[b.dataset.view]) {
      viewSync[b.dataset.view]()
    } else {
      const p = new URLSearchParams()
      if (b.dataset.view === 'liste') p.set('view', 'liste')
      history.replaceState(null, '', location.pathname + (p.toString() ? `?${p}` : ''))
    }
  }))

  activate(view)
}

// ---------------------------------------------------------------------------
// Sets-View: Katalog-Browser (Scryfall-API) + unsere Preise
// ---------------------------------------------------------------------------

function initSetsView(root) {
  const params = new URLSearchParams(location.search)
  const state = {
    sets: null,
    query: params.get('setq') || '',
    showAll: params.get('types') === 'all',
    activeSet: params.get('set') || null,
    // Set-Detail-State (bleibt beim „Mehr laden" kumulativ)
    cards: [],
    nextPage: null,
    totalCards: 0,
  }
  const detailGuard = createLatestGuard()

  root.innerHTML = `
    <p class="preise-sets-intro">
      Alle Magic-Sets wie bei Scryfall — Preise aus unserer täglich
      gesyncten Preisliste.
    </p>
    <div class="sets-controls">
      <input type="text" id="sets-search" class="price-search" placeholder="Set suchen (Name oder Code)..."
        autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false"
        value="${escapeHtml(state.query)}" />
      <label class="sets-showall">
        <input type="checkbox" id="sets-showall" ${state.showAll ? 'checked' : ''} />
        Alle Set-Typen
      </label>
    </div>
    <div id="sets-index"></div>
    <div id="set-detail" hidden></div>
  `

  const indexEl = root.querySelector('#sets-index')
  const detailEl = root.querySelector('#set-detail')
  const searchInput = root.querySelector('#sets-search')
  const showAllInput = root.querySelector('#sets-showall')
  const controlsEl = root.querySelector('.sets-controls')

  const syncUrl = () => {
    const p = new URLSearchParams()
    if (state.activeSet) p.set('set', state.activeSet)
    if (state.query) p.set('setq', state.query)
    if (state.showAll) p.set('types', 'all')
    const qs = p.toString()
    history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : ''))
  }

  // Kachel-Übersicht mit Jahres-Trennern (User-Ansage): großes Icon, darunter
  // der volle Set-Name, alles in einer durchscrollbaren Liste nach Jahren.
  const renderIndex = () => {
    if (!state.sets) return
    const visible = filterSets(state.sets, { query: state.query, showAll: state.showAll })
    if (!visible.length) {
      indexEl.innerHTML = '<p class="empty">Keine Sets gefunden.</p>'
      return
    }
    indexEl.innerHTML = groupSetsByYear(visible).map(group => `
      <div class="sets-year-divider">${escapeHtml(group.year)}</div>
      <div class="set-tile-grid">
        ${group.sets.map(s => `
          <button class="set-tile" data-code="${escapeHtml(s.code)}" aria-label="${escapeHtml(s.name)} öffnen">
            <span class="set-tile-icon-wrap">
              ${s.icon ? `<img class="set-tile-icon" src="${escapeHtml(s.icon)}" alt="" loading="lazy" onerror="this.hidden=true" />` : ''}
            </span>
            <span class="set-tile-name">${escapeHtml(s.name)}</span>
            <span class="set-tile-count">${s.cardCount} Karten</span>
          </button>
        `).join('')}
      </div>
    `).join('')
    refade(indexEl)
  }

  // Ein Klick-Handler für den ganzen Index (überlebt jedes Rerender)
  indexEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.set-tile')
    if (btn) openSet(btn.dataset.code)
  })

  let debounce = null
  searchInput.addEventListener('input', () => {
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      state.query = searchInput.value.trim()
      renderIndex()
      syncUrl()
    }, 150)
  })
  showAllInput.addEventListener('change', () => {
    state.showAll = showAllInput.checked
    renderIndex()
    syncUrl()
  })

  const showIndex = () => {
    state.activeSet = null
    state.cards = []
    state.nextPage = null
    detailGuard.begin() // laufende Detail-Fetches verwerfen
    detailEl.hidden = true
    detailEl.innerHTML = ''
    indexEl.hidden = false
    controlsEl.hidden = false
    syncUrl()
  }

  async function openSet(code) {
    const token = detailGuard.begin()
    state.detailToken = token
    state.activeSet = code
    state.cards = []
    state.nextPage = null
    state.totalCards = 0
    indexEl.hidden = true
    controlsEl.hidden = true
    detailEl.hidden = false
    syncUrl()

    const meta = state.sets?.find(s => s.code === code)
    state.setSort = 'collector'
    detailEl.innerHTML = `
      <div class="set-detail-head">
        <button class="btn-small set-back" id="set-back">&larr; Alle Sets</button>
        <div class="set-detail-title">
          ${meta?.icon ? `<img class="set-detail-icon" src="${escapeHtml(meta.icon)}" alt="" onerror="this.hidden=true" />` : ''}
          <h3>${escapeHtml(meta?.name || code.toUpperCase())}</h3>
          <span class="set-detail-meta" id="set-detail-meta">${meta ? `${meta.cardCount} Karten${meta.released ? ` · ${meta.released.slice(0, 4)}` : ''}` : ''}</span>
          <div class="sort-controls">
            <select id="set-sort" class="sort-select" aria-label="Sortierung">
              <option value="collector">Collector-Nr.</option>
              <option value="name">Name</option>
              <option value="price-desc">Preis &darr;</option>
              <option value="price-asc">Preis &uarr;</option>
            </select>
          </div>
        </div>
      </div>
      <div id="set-cards" class="set-card-grid">${skeletonTiles(10)}</div>
      <div id="set-more-wrap"></div>
    `
    detailEl.querySelector('#set-back').addEventListener('click', showIndex)
    detailEl.querySelector('#set-sort').addEventListener('change', (e) => {
      state.setSort = e.target.value
      if (state.cards.length) renderCards()
    })

    await loadPage(setSearchUrl(code), token)
  }

  // Anzeige-Reihenfolge im Set: Fetch-Reihenfolge IST Collector-Reihenfolge
  // (order=set); Name/Preis sortieren client-seitig, Karten ohne Preis zuletzt.
  // Liefert [karte, Original-Index] — die Preis-Annotation patcht über den
  // Original-Index, egal wie sortiert ist.
  const sortedSetCards = () => {
    const entries = state.cards.map((c, i) => [c, i])
    if (state.setSort === 'name') {
      entries.sort((a, b) => a[0].name.localeCompare(b[0].name))
    } else if (state.setSort === 'price-desc' || state.setSort === 'price-asc') {
      const dir = state.setSort === 'price-desc' ? -1 : 1
      entries.sort((a, b) => {
        const pa = a[0].ourPrice, pb = b[0].ourPrice
        if (pa == null && pb == null) return a[0].name.localeCompare(b[0].name)
        if (pa == null) return 1
        if (pb == null) return -1
        return (pa - pb) * dir || a[0].name.localeCompare(b[0].name)
      })
    }
    return entries
  }

  async function loadPage(url, token) {
    const gridEl = detailEl.querySelector('#set-cards')
    const moreWrap = detailEl.querySelector('#set-more-wrap')
    try {
      const page = extractSetCardsPage(await fetchSetCardsPage(url))
      if (!detailGuard.isCurrent(token)) return
      const offset = state.cards.length
      state.cards = state.cards.concat(mergeOurPrices(page.cards, null))
      state.nextPage = page.hasMore ? page.nextPage : null
      state.totalCards = page.totalCards
      renderCards()
      // Preise NACH dem Grid-Render mergen — Bilder warten nie auf die DB
      annotatePrices(page.cards.map(c => c.name), offset, token)
    } catch (err) {
      if (!detailGuard.isCurrent(token)) return
      // Fehler beim Nachladen behält den geladenen Stand — Retry NUR für
      // die fehlgeschlagene Seite (Critic R2)
      if (state.cards.length) {
        moreWrap.innerHTML = `
          <p class="scan-error-detail">Nachladen fehlgeschlagen: ${escapeHtml(err.message)}</p>
          <button class="btn btn-secondary set-load-more" id="set-more">Nochmal versuchen</button>
        `
        moreWrap.querySelector('#set-more').addEventListener('click', () => loadPage(url, token))
      } else {
        gridEl.innerHTML = `
          <div class="scan-error-box">
            <p>Karten konnten nicht geladen werden.</p>
            <p class="scan-error-detail">${escapeHtml(err.message)}</p>
            <div class="scan-error-actions"><button class="btn btn-secondary" id="set-retry">Nochmal versuchen</button></div>
          </div>
        `
        gridEl.querySelector('#set-retry').addEventListener('click', () => loadPage(url, token))
      }
    }
  }

  const renderCards = () => {
    const gridEl = detailEl.querySelector('#set-cards')
    const moreWrap = detailEl.querySelector('#set-more-wrap')
    if (!state.cards.length) {
      gridEl.innerHTML = '<p class="empty">Keine Karten in diesem Set — vermutlich kein Paper-Produkt.</p>'
      moreWrap.innerHTML = ''
      return
    }
    const frag = document.createDocumentFragment()
    for (const [c, idx] of sortedSetCards()) {
      const tile = document.createElement('button')
      tile.className = 'card-tile'
      tile.dataset.idx = String(idx)
      tile.innerHTML = `
        <span class="card-tile-frame">
          ${c.image
            ? `<img src="${escapeHtml(c.image)}" alt="${escapeHtml(c.name)}" loading="lazy" decoding="async" />`
            : `<span class="card-tile-noimg">${escapeHtml(c.name)}</span>`}
        </span>
        <span class="card-tile-name">${escapeHtml(c.name)}</span>
        <span class="card-tile-price" data-price-idx="${idx}">${c.ourPrice != null
          ? `${c.isFoil ? '<span class="foil-badge" title="Nur als Foil verfügbar">✦</span>' : ''}${formatPrice(c.ourPrice)}`
          : (c.priceResolved ? '<span class="card-tile-noprice">–</span>' : '…')}</span>
      `
      frag.appendChild(tile)
    }
    gridEl.replaceChildren(frag)

    const remaining = Math.max(0, state.totalCards - state.cards.length)
    moreWrap.innerHTML = state.nextPage
      ? `<button class="btn btn-secondary set-load-more" id="set-more">Mehr laden (${remaining} weitere)</button>`
      : ''
    if (state.nextPage) {
      moreWrap.querySelector('#set-more').addEventListener('click', () => {
        moreWrap.querySelector('#set-more').disabled = true
        loadPage(state.nextPage, state.detailToken)
      })
    }
  }

  // Unsere DB-Preise für einen Seiten-Abschnitt nachziehen (in-place)
  async function annotatePrices(names, offset, token) {
    let lookup
    try {
      lookup = await fetchCheapestPrices(names, { throwOnError: true })
    } catch {
      // DB nicht erreichbar → ehrlich „–" zeigen statt ewig „…"
      lookup = new Map()
    }
    if (!detailGuard.isCurrent(token) || !detailEl.isConnected) return
    const merged = mergeOurPrices(state.cards.slice(offset, offset + names.length), lookup)
    merged.forEach((c, i) => {
      // priceResolved: „kein Preis" (–) von „Preis lädt noch" (…) unterscheiden
      state.cards[offset + i] = { ...c, priceResolved: true }
      const el = detailEl.querySelector(`[data-price-idx="${offset + i}"]`)
      if (el) {
        el.innerHTML = c.ourPrice != null
          ? `${c.isFoil ? '<span class="foil-badge" title="Nur als Foil verfügbar">✦</span>' : ''}${formatPrice(c.ourPrice)}`
          : '<span class="card-tile-noprice">–</span>'
      }
    })
    // Preis-Sortierung war vor dem Eintreffen der Preise nur vorläufig —
    // einmal neu ordnen, sobald die Zahlen da sind
    if (state.setSort === 'price-desc' || state.setSort === 'price-asc') renderCards()
  }

  // Kartenklick → Lightbox (Bild liegt schon vor)
  detailEl.addEventListener('click', (e) => {
    const tile = e.target.closest('.card-tile')
    if (!tile) return
    const c = state.cards[Number(tile.dataset.idx)]
    if (c) openCardLightbox({ name: c.name, image: c.image, price: c.ourPrice, isFoil: c.isFoil })
  })

  // Sets laden (Index ODER Deep-Link-Detail)
  ;(async () => {
    indexEl.innerHTML = loadingHtml('Lade Sets...')
    try {
      state.sets = await fetchAllSets({ slim: slimSet })
    } catch (err) {
      if (!root.isConnected) return
      indexEl.innerHTML = `
        <div class="scan-error-box">
          <p>Scryfall-Sets konnten nicht geladen werden.</p>
          <p class="scan-error-detail">${escapeHtml(err.message)}</p>
          <div class="scan-error-actions"><button class="btn btn-secondary" id="sets-retry">Nochmal versuchen</button></div>
        </div>
      `
      indexEl.querySelector('#sets-retry').addEventListener('click', () => initSetsView(root))
      return
    }
    if (!root.isConnected) return
    if (state.activeSet) {
      openSet(state.activeSet)
    } else {
      renderIndex()
    }
  })()

  return syncUrl
}

// ---------------------------------------------------------------------------
// Alle-Karten-View: die bestehende durchsuchbare Tabelle (Verhalten unverändert)
// ---------------------------------------------------------------------------

async function initListeView(root) {
  root.innerHTML = loadingHtml('Lade Preisdatenbank...')

  let info
  try {
    info = await getPriceDbInfo()
  } catch (err) {
    renderLoadError(root, err, () => initListeView(root))
    return
  }
  if (!root.isConnected) return

  // State aus der URL (Deep-Link). dir-Default folgt der Header-Klick-
  // Konvention (geteilte ?sort=price-Links starten wie der Klick absteigend)
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

  root.innerHTML = `
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
    <div id="price-grid" class="set-card-grid price-grid"></div>
    <div class="price-pagination" id="price-pagination"></div>
    <button class="btn btn-secondary price-load-more" id="price-load-more" hidden>Mehr laden</button>
  `

  const searchInput = root.querySelector('#price-search')
  const sortSelect = root.querySelector('#price-sort-select')
  const gridEl = root.querySelector('#price-grid')
  const paginationEl = root.querySelector('#price-pagination')
  const loadMoreBtn = root.querySelector('#price-load-more')

  const syncControls = () => {
    sortSelect.value = `${state.sort}-${state.ascending ? 'asc' : 'desc'}`
  }

  const syncUrl = () => {
    const p = new URLSearchParams()
    p.set('view', 'liste')
    if (state.query) p.set('q', state.query)
    if (state.sort !== 'name' || !state.ascending) {
      p.set('sort', state.sort)
      p.set('dir', state.ascending ? 'asc' : 'desc')
    }
    if (state.page > 0) p.set('page', String(state.page))
    history.replaceState(null, '', `${location.pathname}?${p.toString()}`)
  }

  // Karten-Grid statt Tabelle (User-Ansage): Grid rendert SOFORT (Skeleton-
  // Frames), die Bilder kommen als EIN collection-Batch nach und werden
  // in-place gepatcht. rendert IMMER den kompletten state.rows-Stand.
  const tileFrameHtml = (name) => {
    const img = cachedCardImage(name)
    if (img) {
      return `<img src="${escapeHtml(img)}" alt="${escapeHtml(name)}" loading="lazy" decoding="async" />`
    }
    if (img === null) return `<span class="card-tile-noimg">${escapeHtml(name)}</span>`
    return '' // noch nicht aufgelöst → Skeleton-Frame
  }

  const renderRows = () => {
    if (!state.rows.length) {
      gridEl.innerHTML = '<p class="empty">Keine Karten gefunden.</p>'
    } else {
      gridEl.innerHTML = state.rows.map((r, i) => {
        const resolved = cachedCardImage(r.name) !== undefined
        return `
        <button class="card-tile price-card-tile" data-idx="${i}" aria-label="${escapeHtml(r.name)} — Karte anzeigen">
          <span class="card-tile-frame${resolved ? '' : ' card-tile-frame-loading'}" data-frame-idx="${i}">
            ${tileFrameHtml(r.name)}
          </span>
          <span class="card-tile-name">${escapeHtml(r.name)}</span>
          <span class="card-tile-price">${r.is_foil ? '<span class="foil-badge" title="Nur als Foil verfügbar">✦</span>' : ''}${formatPrice(r.cheapest_eur)}</span>
        </button>
      `}).join('')
      refade(gridEl)
      hydrateImages()
    }

    const totalPages = Math.max(1, Math.ceil(state.total / PAGE_SIZE))
    paginationEl.innerHTML = `
      <button class="btn-small" id="price-prev" ${state.page <= 0 ? 'disabled' : ''}>&larr; Zurück</button>
      <span class="price-page-info">Seite ${Math.min(state.page + 1, totalPages)}/${totalPages} &middot; ${state.total.toLocaleString('de-DE')} Treffer</span>
      <button class="btn-small" id="price-next" ${(state.page + 1) >= totalPages ? 'disabled' : ''}>Weiter &rarr;</button>
    `
    paginationEl.querySelector('#price-prev').addEventListener('click', () => loadPage(state.page - 1))
    paginationEl.querySelector('#price-next').addEventListener('click', () => loadPage(state.page + 1))

    // Mobile-Append: Offset = Startseite der Akkumulation + bereits geladene Zeilen
    const consumed = state.appendBase * PAGE_SIZE + state.rows.length
    const remaining = Math.max(0, state.total - consumed)
    loadMoreBtn.hidden = remaining <= 0 || !state.rows.length
    loadMoreBtn.disabled = false
    loadMoreBtn.textContent = `Mehr laden (${Math.min(PAGE_SIZE, remaining)} von ${remaining.toLocaleString('de-DE')} weiteren)`
    delete loadMoreBtn.dataset.label
  }

  // Bilder für den aktuellen Grid-Stand nachladen und in-place patchen
  // (latest-wins über Token — ein Seitenwechsel während des Batches darf
  // keine fremden Frames patchen)
  let imgToken = 0
  async function hydrateImages() {
    const token = ++imgToken
    const names = state.rows.map(r => r.name)
    try {
      await resolveCardImages(names)
    } catch { /* Scryfall down → Frames zeigen gleich den Namens-Fallback */ }
    if (token !== imgToken || !root.isConnected) return
    state.rows.forEach((r, i) => {
      const frame = gridEl.querySelector(`[data-frame-idx="${i}"]`)
      if (!frame) return
      const img = cachedCardImage(r.name)
      frame.classList.remove('card-tile-frame-loading')
      frame.innerHTML = img
        ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(r.name)}" loading="lazy" decoding="async" />`
        : `<span class="card-tile-noimg">${escapeHtml(r.name)}</span>`
    })
  }

  // Search-as-you-type: Debounce ~200ms + AbortController + latest-wins
  let activeController = null
  let debounceTimer = null

  // Buttons während des Fetches sperren (Doppel-Tap auf „Mehr laden" abortete
  // sonst die laufende Seite und verlor sie still)
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
      gridEl.innerHTML = `<p class="empty">Fehler: ${escapeHtml(err.message)} <button class="btn-small" id="price-retry">Nochmal</button></p>`
      gridEl.querySelector('#price-retry')?.addEventListener('click', () => loadPage(targetPage, { append }))
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

  loadMoreBtn.addEventListener('click', () => loadPage(state.page + 1, { append: true }))

  // Kachel-Klick → Lightbox (aufgelöstes CDN-Bild; ungelöst → Lightbox-eigene
  // Stufen-Auflösung übernimmt)
  gridEl.addEventListener('click', (e) => {
    const tile = e.target.closest('.price-card-tile')
    if (!tile) return
    const row = state.rows[Number(tile.dataset.idx)]
    if (!row) return
    openCardLightbox({
      name: row.name,
      image: cachedCardImage(row.name) || null,
      price: row.cheapest_eur,
      isFoil: !!row.is_foil,
    })
  })

  syncControls()
  gridEl.innerHTML = skeletonTiles(10)
  await loadPage(state.page)

  return syncUrl
}

// ---------------------------------------------------------------------------
// Karten-Lightbox: NUR großes Bild + Preis (User-Ansage — keine Printings-
// Liste, kein Cache-Hinweis). Content-hugging auf Mobile statt Vollbild-Sheet.
// ---------------------------------------------------------------------------

let closeActiveLightbox = null

export function openCardLightbox({ name, image, price, isFoil }) {
  if (closeActiveLightbox) closeActiveLightbox()
  document.getElementById('card-lightbox')?.remove()

  const overlay = document.createElement('div')
  overlay.id = 'card-lightbox'
  overlay.className = 'card-lightbox-overlay'
  overlay.innerHTML = `
    <div class="card-lightbox" role="dialog" aria-modal="true" aria-label="${escapeHtml(name)}" tabindex="-1">
      <button class="card-lightbox-close" aria-label="Schließen">&times;</button>
      <div class="card-lightbox-frame">
        ${image
          ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(name)}" />`
          : '<p class="loading">Lade Bild...</p>'}
      </div>
      <div class="card-lightbox-caption">
        <span class="card-lightbox-name">${escapeHtml(name)}</span>
        <span class="card-lightbox-price">${isFoil ? '<span class="foil-badge" title="Nur als Foil verfügbar">✦</span>' : ''}${formatPrice(price)}</span>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  document.body.classList.add('modal-open')
  requestAnimationFrame(() => overlay.classList.add('visible'))

  let closing = false
  function onRouteChange() { close() }
  function onKeyDown(e) { if (e.key === 'Escape') close() }
  function close() {
    if (closing) return
    closing = true
    window.removeEventListener('route-change', onRouteChange)
    document.removeEventListener('keydown', onKeyDown)
    document.body.classList.remove('modal-open')
    if (closeActiveLightbox === close) closeActiveLightbox = null
    overlay.classList.remove('visible')
    setTimeout(() => overlay.remove(), 200)
  }
  closeActiveLightbox = close

  overlay.querySelector('.card-lightbox-close').addEventListener('click', close)
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close() })
  window.addEventListener('route-change', onRouteChange)
  document.addEventListener('keydown', onKeyDown)
  overlay.querySelector('.card-lightbox').focus()

  // Bild fehlt (Listen-View) → gestaffelt auflösen: card_printings-Cache →
  // Scryfall exakt → DFC-Front-Face (deckt auch die alten "A // A"-Geister-
  // Rows ab, bis der gefixte Preis-Sync sie weggeräumt hat)
  if (!image) {
    ;(async () => {
      const frame = overlay.querySelector('.card-lightbox-frame')
      let resolved = null
      try {
        const map = await fetchPrintingsFromDB([name])
        resolved = map?.get(name.toLowerCase())?.[0]?.image_normal || null
      } catch { /* Cache optional */ }
      if (!resolved) {
        try {
          let card = await fetchCardByName(name)
          if (!card && name.includes(' // ')) card = await fetchCardByName(name.split(' // ')[0])
          resolved = card ? getCardNormalImage(card) : null
        } catch { /* Scryfall optional */ }
      }
      if (!overlay.isConnected) return
      frame.innerHTML = resolved
        ? `<img src="${escapeHtml(resolved)}" alt="${escapeHtml(name)}" />`
        : '<p class="card-lightbox-noimg">Kein Bild verfügbar</p>'
    })()
  }
}

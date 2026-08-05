// scan.js — Commander-Scan mit EDHREC-artiger Landing:
//
// Landing: „Beliebte Commander" als Karten-Grid (Bilder direkt von der
// Scryfall-CDN über die EDHREC-mitgelieferte ID), Perioden-Tabs
// (Woche/Monat/2 Jahre) + WUBRG+C-Farbfilter (EDHREC-Farbidentitäts-Seiten).
// Ein Klick auf eine Karte startet den Scan — über die Scryfall-ID, nie über
// einen fehleranfälligen Namens-Lookup.
//
// Scan: EDHREC-Average-Deck + echte Decks, bepreist mit UNSEREN DB-Preisen
// (scryfall_prices). Listen rendern im Deck-View-Look (Typ-Gruppen,
// Karten-Preview-Overlay) — Anreicherung via Scryfall-Collection.
// Öffentlich; die Import-Brücke erscheint nur eingeloggt.

import { getPlayer } from '../auth.js'
import { navigate } from '../router.js'
import { fetchCheapestPrices, fetchPricesByFrontFace } from '../supabase.js'
import { fetchCardByName, fetchCardById, fetchCardCollection, isCommanderEligible, getPartnerType, getCardArtCrop, getCardNormalImage, namedImageUrl } from '../scryfall.js'
import { attachCardAutocomplete, createLatestGuard } from '../components/autocomplete.js'
import { renderReadonlyCardGroups, buildScryfallIndex, enrichCards, slimCollectionCard } from '../components/readonly-card-list.js'
import { setDefaultPreview } from '../components/card-preview.js'
import { renderDeckStats } from '../components/deck-stats.js'
import {
  edhrecSlug, partnerSlug, serializeDeckForImport,
  fetchAverageDeck, fetchRealDecks, fetchDeckPreview,
  fetchTopCommanders, colorPageSlug, commanderImageUrl, isPartnerPairName,
} from '../edhrec.js'
import { formatPrice, escapeHtml } from '../utils.js'
import { loadingHtml, updateLoadingLabel, refade } from '../components/loading.js'

const REAL_DECKS_LIMIT = 20
const LANDING_LIMIT = 20

const PERIODS = [
  { key: 'week', label: 'Woche' },
  { key: 'month', label: 'Monat' },
  { key: 'year', label: '2 Jahre' },
]
const COLOR_ICONS = [
  { key: 'w', label: 'Weiß' },
  { key: 'u', label: 'Blau' },
  { key: 'b', label: 'Schwarz' },
  { key: 'r', label: 'Rot' },
  { key: 'g', label: 'Grün' },
  { key: 'c', label: 'Farblos' },
]

// Partner-Kompatibilität — dieselben Regeln wie getPartnerCandidates() im
// Deck-Import (irgendein legaler Commander ist NICHT automatisch ein gültiger
// Partner; ein inkompatibles Paar erzeugt nur einen toten Slug)
function isCompatiblePartner(commanderCard, partnerCard) {
  const main = getPartnerType(commanderCard)
  if (!main) return false
  const p = getPartnerType(partnerCard)
  if (main.type === 'partner' && p?.type === 'partner') return true
  if (main.type === 'partner_with' && p?.type === 'partner_with') return true
  if (main.type === 'friends_forever' && p?.type === 'friends_forever') return true
  if (main.type === 'choose_background') return (partnerCard.type_line || '').includes('Background')
  if (main.type === 'doctors_companion' && p?.type === 'doctors_companion') return true
  return false
}

// EDHREC-URLs sind Fremddaten: escapeHtml schützt das Attribut, nicht das
// Scheme — javascript:-URIs bleiben draußen
function safeExternalUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null
}

export async function renderScan(container) {
  // State pro Render zurücksetzen (kein Modul-Zombie)
  const state = {
    commander: null, partner: null, slug: null,
    period: 'week', colors: new Set(),
  }
  // Race-Guards: je Fläche der jüngste Auslöser gewinnt (etabliertes Muster)
  const scanGuard = createLatestGuard()
  const selectGuard = createLatestGuard()
  const landingGuard = createLatestGuard()

  container.innerHTML = `
    <div class="page scan-page">
      <h2>Commander-Scan</h2>
      <p class="scan-intro">
        Commander wählen oder suchen — wir holen die EDHREC-Listen und rechnen
        sie mit den Preisen unserer <a href="#" id="scan-preise-link">Preisdatenbank</a> durch.
      </p>
      <div class="scan-search-hero">
        <div class="autocomplete-wrapper">
          <input type="text" id="scan-commander-input" class="scan-search-input" placeholder="Commander suchen..."
            autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" />
          <div id="scan-commander-list" class="autocomplete-list" hidden></div>
        </div>
        <div class="autocomplete-wrapper" id="scan-partner-wrap" hidden>
          <input type="text" id="scan-partner-input" class="scan-search-input" placeholder="Partner hinzufügen (optional)..."
            autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" />
          <div id="scan-partner-list" class="autocomplete-list" hidden></div>
        </div>
        <p id="scan-search-status" class="scan-search-status" hidden></p>
      </div>
      <div id="scan-landing">
        <div class="scan-landing-head">
          <h3>Beliebte Commander</h3>
          <div class="scan-filters">
            <div class="scan-period-tabs" role="tablist" aria-label="Zeitraum">
              ${PERIODS.map(p => `
                <button class="scan-period-btn" data-period="${p.key}" role="tab">${p.label}</button>
              `).join('')}
            </div>
            <div class="scan-color-filter" role="group" aria-label="Farbidentität">
              ${COLOR_ICONS.map(c => `
                <button class="scan-color-btn" data-color="${c.key}" aria-pressed="false"
                  aria-label="${c.label}" title="${c.label}">
                  <i class="ms ms-${c.key} ms-cost"></i>
                </button>
              `).join('')}
            </div>
          </div>
        </div>
        <div id="scan-landing-grid"></div>
      </div>
      <button class="btn-small scan-back" id="scan-back" hidden>&larr; Beliebte Commander</button>
      <div id="scan-result" hidden></div>
      <div id="scan-real-decks" hidden></div>
    </div>
  `

  document.getElementById('scan-preise-link').addEventListener('click', (e) => {
    e.preventDefault()
    navigate('/preise')
  })

  const searchStatus = document.getElementById('scan-search-status')
  const landingEl = document.getElementById('scan-landing')
  const landingGrid = document.getElementById('scan-landing-grid')
  const backBtn = document.getElementById('scan-back')
  const resultEl = document.getElementById('scan-result')
  const realDecksEl = document.getElementById('scan-real-decks')

  const showSearchStatus = (msg, isError = false) => {
    searchStatus.hidden = !msg
    searchStatus.textContent = msg || ''
    searchStatus.classList.toggle('scan-status-error', isError)
  }

  // --- Landing: Top-Commander-Grid mit Perioden-Tabs + Farbfilter ---

  const syncFilterControls = () => {
    const colorActive = state.colors.size > 0
    landingEl.querySelectorAll('.scan-period-btn').forEach(b => {
      b.classList.toggle('scan-period-active', !colorActive && b.dataset.period === state.period)
      // Farbseiten kennen keine Zeiträume — Tabs sichtbar deaktivieren
      b.disabled = colorActive
      b.setAttribute('aria-selected', String(!colorActive && b.dataset.period === state.period))
    })
    landingEl.querySelectorAll('.scan-color-btn').forEach(b => {
      const active = state.colors.has(b.dataset.color)
      b.classList.toggle('scan-color-active', active)
      b.setAttribute('aria-pressed', String(active))
    })
  }

  async function loadLanding() {
    const token = landingGuard.begin()
    syncFilterControls()
    const pageSlug = colorPageSlug([...state.colors]) || state.period
    // Sanfter Übergang statt Wipe (User-Feedback: Filterwechsel „clippte" und
    // lud unruhig): bestehendes Grid bleibt gedimmt stehen, bis die neuen
    // Daten da sind — nur beim allerersten Laden gibt es einen Spinner.
    const hadGrid = !!landingGrid.querySelector('.cmdr-grid')
    if (!hadGrid) landingGrid.innerHTML = loadingHtml('Lade beliebte Commander...')
    landingGrid.classList.add('landing-refreshing')
    let top
    try {
      top = await fetchTopCommanders(pageSlug)
      if (!landingGuard.isCurrent(token)) return
    } catch (err) {
      if (!landingGuard.isCurrent(token)) return
      landingGrid.classList.remove('landing-refreshing')
      // Landing ist Zusatzfläche — Fehler inline, die Suche bleibt bedienbar;
      // ein vorhandenes Grid bleibt stehen (Fehlerzeile davor statt Wipe)
      const errorHtml = `
        <div class="scan-error-box" id="scan-landing-error">
          <p>Beliebte Commander konnten nicht geladen werden.</p>
          <p class="scan-error-detail">${escapeHtml(err.message)}</p>
          <div class="scan-error-actions"><button class="btn btn-secondary" id="scan-landing-retry">Nochmal versuchen</button></div>
        </div>
      `
      if (hadGrid) {
        landingGrid.querySelector('#scan-landing-error')?.remove()
        landingGrid.insertAdjacentHTML('afterbegin', errorHtml)
      } else {
        landingGrid.innerHTML = errorHtml
      }
      landingGrid.querySelector('#scan-landing-retry').addEventListener('click', loadLanding)
      return
    }

    const commanders = top.commanders.slice(0, LANDING_LIMIT)
    landingGrid.innerHTML = `
      ${top.header ? `<p class="scan-landing-sub">${escapeHtml(top.header)}</p>` : ''}
      <div class="cmdr-grid">
        ${commanders.map((c, i) => renderCmdrTile(c, i)).join('')}
      </div>
    `
    landingGrid.classList.remove('landing-refreshing')
    refade(landingGrid)
    landingGrid.querySelectorAll('.cmdr-tile').forEach(tile => {
      // Groß/Klein-Switch beim Partner-Paar: nur Klasse toggeln, kein Scan
      tile.querySelector('.cmdr-pair-swap')?.addEventListener('click', (e) => {
        e.stopPropagation()
        tile.querySelector('.cmdr-frame').classList.toggle('cmdr-pair-swapped')
      })
      tile.addEventListener('click', () => {
        const c = commanders[Number(tile.dataset.idx)]
        if (!c) return
        if (isPartnerPairName(c.name, c.slug)) {
          const [a, b] = c.name.split(' // ')
          document.getElementById('scan-commander-input').value = a
          selectPair(a, b, c.scryfallId)
        } else {
          document.getElementById('scan-commander-input').value = c.name
          selectCommander(c.name, { scryfallId: c.scryfallId })
        }
      })
    })
  }

  // Tile: Partner-Paare zeigen BEIDE Karten — eine groß vorn, eine klein
  // dahinter; ⇄ (oder Hover am Desktop) tauscht sie animiert (User-Ansage).
  // Beide Namen stehen voll ausgeschrieben untereinander.
  function renderCmdrTile(c, i) {
    const pair = isPartnerPairName(c.name, c.slug)
    const [nameA, nameB] = pair ? c.name.split(' // ') : [c.name, null]
    // Paare: A IMMER namensbasiert — die EDHREC-ID kann auf B zeigen und
    // zeigte dann dasselbe Artwork in beiden Slots (Critic R2)
    const imgA = pair ? namedImageUrl(nameA) : (commanderImageUrl(c.scryfallId) || namedImageUrl(nameA))
    const decksHtml = c.numDecks != null ? `<span class="cmdr-decks">${c.numDecks.toLocaleString('de-DE')} Decks</span>` : ''

    if (pair) {
      const imgB = namedImageUrl(nameB)
      return `
        <button class="cmdr-tile" data-idx="${i}" aria-label="${escapeHtml(nameA)} und ${escapeHtml(nameB)} scannen">
          ${c.rank ? `<span class="cmdr-rank">#${c.rank}</span>` : ''}
          <span class="cmdr-frame cmdr-frame-pair">
            <img class="cmdr-pair-a" src="${escapeHtml(imgA)}" alt="" loading="lazy" decoding="async" onerror="this.remove()" />
            <img class="cmdr-pair-b" src="${escapeHtml(imgB)}" alt="" loading="lazy" decoding="async" onerror="this.remove()" />
            <span class="cmdr-pair-swap" role="button" aria-label="Partner tauschen" title="Partner tauschen">&#8646;</span>
          </span>
          <span class="cmdr-name">${escapeHtml(nameA)}</span>
          <span class="cmdr-name cmdr-name-partner">+ ${escapeHtml(nameB)}</span>
          ${decksHtml}
        </button>
      `
    }
    return `
      <button class="cmdr-tile" data-idx="${i}" aria-label="${escapeHtml(c.name)} scannen">
        ${c.rank ? `<span class="cmdr-rank">#${c.rank}</span>` : ''}
        <span class="cmdr-frame">
          ${imgA
            ? `<img src="${escapeHtml(imgA)}" alt="" loading="lazy" decoding="async" onerror="this.closest('.cmdr-frame').classList.add('cmdr-frame-noimg'); this.remove()" />`
            : ''}
          <span class="cmdr-noimg-name">${escapeHtml(c.name)}</span>
        </span>
        <span class="cmdr-name">${escapeHtml(c.name)}</span>
        ${decksHtml}
      </button>
    `
  }

  // Partner-Paar aus dem Grid: BEIDE Karten auflösen, EIN Scan (nicht zwei).
  // Die EDHREC-ID kann auf eine der beiden Karten zeigen — Namensabgleich
  // entscheidet, sonst Namens-Lookup.
  async function selectPair(nameA, nameB, scryfallId) {
    const token = selectGuard.begin()
    showSearchStatus('Prüfe Karten...')
    let cardA = scryfallId ? await fetchCardById(scryfallId) : null
    if (cardA && cardA.name !== nameA && cardA.name.split(' // ')[0] !== nameA) cardA = null
    if (!cardA) cardA = await fetchCardByName(nameA)
    const cardB = await fetchCardByName(nameB)
    if (!selectGuard.isCurrent(token)) return
    if (!cardA || !cardB) {
      showSearchStatus(`Partner-Paar „${nameA} + ${nameB}" konnte nicht aufgelöst werden.`, true)
      return
    }
    showSearchStatus('')
    state.commander = { name: cardA.name, card: cardA }
    state.partner = { name: cardB.name, card: cardB }
    document.getElementById('scan-commander-input').value = cardA.name
    document.getElementById('scan-partner-input').value = cardB.name
    document.getElementById('scan-partner-wrap').hidden = !getPartnerType(cardA)
    await runScan()
  }

  landingEl.querySelectorAll('.scan-period-btn').forEach(b => {
    b.addEventListener('click', () => {
      if (state.period === b.dataset.period && !state.colors.size) return
      state.period = b.dataset.period
      loadLanding()
    })
  })
  landingEl.querySelectorAll('.scan-color-btn').forEach(b => {
    b.addEventListener('click', () => {
      const key = b.dataset.color
      if (key === 'c') {
        // Farblos ist exklusiv
        const wasActive = state.colors.has('c')
        state.colors.clear()
        if (!wasActive) state.colors.add('c')
      } else {
        state.colors.delete('c')
        if (state.colors.has(key)) state.colors.delete(key)
        else state.colors.add(key)
      }
      loadLanding()
    })
  })

  const showLanding = () => {
    landingEl.hidden = false
    backBtn.hidden = true
    resultEl.hidden = true
    resultEl.innerHTML = ''
    realDecksEl.hidden = true
    realDecksEl.innerHTML = ''
    scanGuard.begin() // laufende Scans verwerfen
  }
  const hideLanding = () => {
    landingEl.hidden = true
    backBtn.hidden = false
  }
  backBtn.addEventListener('click', showLanding)

  // --- Commander-Auswahl (Grid-Klick via ID, Suche via Name) ---

  async function selectCommander(name, { asPartner = false, scryfallId = null } = {}) {
    const selectToken = selectGuard.begin()
    showSearchStatus('Prüfe Karte...')
    // ID zuerst (Grid-Klick: exakt, kein Namens-Drift) — Name nur als Fallback
    let card = scryfallId ? await fetchCardById(scryfallId) : null
    if (!card) card = await fetchCardByName(name)
    if (!selectGuard.isCurrent(selectToken)) return // neuere Auswahl gewinnt
    if (!card) {
      showSearchStatus(`„${name}" wurde bei Scryfall nicht gefunden.`, true)
      return
    }
    if (!isCommanderEligible(card)) {
      showSearchStatus(`„${card.name}" ist kein legaler Commander.`, true)
      return
    }
    showSearchStatus('')

    if (asPartner) {
      if (!state.commander) {
        showSearchStatus('Erst einen Commander wählen.', true)
        return
      }
      if (!isCompatiblePartner(state.commander.card, card)) {
        showSearchStatus(`„${card.name}" kann nicht mit „${state.commander.name}" kombiniert werden.`, true)
        return
      }
      state.partner = { name: card.name, card }
    } else {
      state.commander = { name: card.name, card }
      state.partner = null
      document.getElementById('scan-partner-input').value = ''
      // Partner-Feld nur zeigen, wenn der Commander partner-fähig ist
      document.getElementById('scan-partner-wrap').hidden = !getPartnerType(card)
    }
    await runScan()
  }

  // .clear() als erste onPick-Zeile — etabliertes Muster; ohne das bleibt das
  // Dropdown nach dem Klick offen und weiter anklickbar
  const commanderAc = attachCardAutocomplete({
    input: document.getElementById('scan-commander-input'),
    listEl: document.getElementById('scan-commander-list'),
    limit: 6,
    onPick: (item) => {
      commanderAc.clear()
      document.getElementById('scan-commander-input').value = item.name
      selectCommander(item.name)
    },
  })
  const partnerAc = attachCardAutocomplete({
    input: document.getElementById('scan-partner-input'),
    listEl: document.getElementById('scan-partner-list'),
    limit: 6,
    onPick: (item) => {
      partnerAc.clear()
      document.getElementById('scan-partner-input').value = item.name
      selectCommander(item.name, { asPartner: true })
    },
  })

  // --- Scan: Average-Deck + echte Decks ---

  async function runScan() {
    if (!state.commander) return
    const scanToken = scanGuard.begin()
    state.slug = state.partner
      ? partnerSlug(state.commander.name, state.partner.name)
      : edhrecSlug(state.commander.name)

    hideLanding()
    realDecksEl.hidden = true
    realDecksEl.innerHTML = ''
    resultEl.hidden = false
    resultEl.innerHTML = loadingHtml('Lade EDHREC-Average-Deck...')

    let avg
    try {
      avg = await fetchAverageDeck(state.slug)
      if (!scanGuard.isCurrent(scanToken)) return
    } catch (err) {
      if (!scanGuard.isCurrent(scanToken)) return
      resultEl.innerHTML = `
        <div class="scan-error-box">
          <p>EDHREC-Average-Deck konnte nicht geladen werden (Slug: <code>${escapeHtml(state.slug)}</code>).</p>
          <p class="scan-error-detail">${escapeHtml(err.message)}</p>
          <div class="scan-error-actions">
            <button class="btn btn-secondary" id="scan-retry">Nochmal versuchen</button>
            <a class="btn-small" href="https://edhrec.com/average-decks/${escapeHtml(state.slug)}" target="_blank" rel="noopener">Auf EDHREC prüfen</a>
          </div>
        </div>
      `
      resultEl.querySelector('#scan-retry')?.addEventListener('click', runScan)
      return
    }

    // Commander gehören zum Deck: sie stehen in der Liste (eigene Sektion)
    // und zählen in Wert + Kartenzahl — exakt wie in der Deck-Ansicht
    const commanders = avg.commanders.length
      ? avg.commanders
      : [state.commander.name, state.partner?.name].filter(Boolean)
    const fullList = [
      ...commanders.map(n => ({ name: n, quantity: 1 })),
      ...avg.cards.filter(c => !commanders.some(n => n.toLowerCase() === c.name.toLowerCase())),
    ]

    updateLoadingLabel(resultEl, 'Preise & Kartendetails laden...')

    // Preise (Supabase) und Kartendetails (Scryfall-Collection) sind
    // unabhängig → PARALLEL statt Wasserfall (~0,5-1s gespart). Preise sind
    // Pflicht (Fehler-UI), Collection ist optional (Liste fällt sonst auf
    // die eigene Nachlade-Stufe zurück).
    const [pricingRes, collectionRes] = await Promise.allSettled([
      priceList(fullList),
      fetchScanCollection(`scan:coll:${state.slug}`, fullList),
    ])
    if (!scanGuard.isCurrent(scanToken)) return
    if (pricingRes.status === 'rejected') {
      resultEl.innerHTML = `
        <div class="scan-error-box">
          <p>Preisdatenbank nicht erreichbar — Liste geladen, aber nicht bepreisbar.</p>
          <p class="scan-error-detail">${escapeHtml(pricingRes.reason?.message || String(pricingRes.reason))}</p>
          <div class="scan-error-actions"><button class="btn btn-secondary" id="scan-retry-prices">Nochmal versuchen</button></div>
        </div>
      `
      resultEl.querySelector('#scan-retry-prices')?.addEventListener('click', runScan)
      return
    }
    const pricing = pricingRes.value
    const collection = collectionRes.status === 'fulfilled' ? collectionRes.value : null

    renderAverage(fullList, commanders, pricing, scanToken, collection)
    renderRealDecksSection()
  }

  // Collection mit Session-Cache (30min, geslimmt): wiederholter Scan
  // desselben Commanders rendert die Liste ohne Scryfall-Roundtrip
  async function fetchScanCollection(cacheKey, cards) {
    try {
      const raw = sessionStorage.getItem(cacheKey)
      if (raw) {
        const { t, data } = JSON.parse(raw)
        if (Date.now() - t < 30 * 60 * 1000 && Array.isArray(data)) return data
      }
    } catch { /* Cache optional */ }
    const { found } = await fetchCardCollection(cards.map(c => c.name))
    const slim = found.map(slimCollectionCard)
    try {
      sessionStorage.setItem(cacheKey, JSON.stringify({ t: Date.now(), data: slim }))
    } catch { /* QuotaExceeded — Cache ist optional */ }
    return slim
  }

  // Average-Deck in EXAKT der Ansicht unserer gebauten Decks (User-Ansage):
  // Commander-Art-Banner, Gesamtwert, Sortierung, Sidebar mit Preview + Stats,
  // Commander-Sektion zuerst.
  function renderAverage(fullList, commanders, pricing, scanToken, collection = null) {
    const cardCount = fullList.reduce((s, c) => s + c.quantity, 0)
    const artCrop = getCardArtCrop(state.commander.card)
    const headerBg = artCrop
      ? `background-image: linear-gradient(to bottom, rgba(15,15,20,0.3), rgba(15,15,20,0.95) 80%), url('${escapeHtml(artCrop)}')`
      : ''
    const commanderImage = getCardNormalImage(state.commander.card)

    resultEl.innerHTML = `
      <div class="deck-header-banner" style="${headerBg}">
        <div class="deck-header">
          <div>
            <h2>${commanders.map(escapeHtml).join(' + ')}</h2>
            <p class="deck-meta">
              EDHREC Average Deck &middot; <strong>${cardCount}</strong> Karten
              ${pricing.missing.length ? `&middot; ${pricing.missing.length} ohne Preis` : ''}
            </p>
          </div>
          <div class="deck-value">
            <span class="value-label">Unser Wert</span>
            <span class="value-amount">${formatPrice(pricing.total)}</span>
          </div>
        </div>
      </div>
      <div class="deck-actions">
        <div class="deck-actions-buttons">
          ${getPlayer() ? `<button class="btn scan-import-btn" data-kind="avg">Als Deck importieren</button>` : ''}
          <div class="sort-controls">
            <label class="sort-label" for="scan-sort-select">Sortierung:</label>
            <select id="scan-sort-select" class="sort-select">
              <option value="type">Typ</option>
              <option value="name">Name</option>
              <option value="cmc">Manakosten</option>
              <option value="price-desc">Preis &darr;</option>
              <option value="price-asc">Preis &uarr;</option>
            </select>
          </div>
        </div>
      </div>
      ${pricing.missing.length ? `
        <details class="scan-missing">
          <summary>${pricing.missing.length} Karten ohne DB-Preis</summary>
          <ul>${pricing.missing.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>
        </details>
      ` : ''}
      <div class="deck-layout">
        <aside class="deck-sidebar">
          <div class="deck-preview-sticky">
            <div id="deck-card-preview">
              ${commanderImage ? `<img src="${escapeHtml(commanderImage)}" alt="${escapeHtml(state.commander.name)}" />` : ''}
            </div>
            <div id="deck-stats" class="deck-stats"></div>
          </div>
        </aside>
        <div id="scan-avg-list" class="scan-card-list">${loadingHtml('Kartendetails laden...')}</div>
      </div>
    `
    setDefaultPreview(commanderImage)
    refade(resultEl)

    resultEl.querySelector('.scan-import-btn')?.addEventListener('click', () => {
      startImport({
        name: `${commanders.join(' + ')} (EDHREC Average)`,
        commanders,
        cards: fullList.filter(c => !commanders.some(n => n.toLowerCase() === c.name.toLowerCase())),
      })
    })

    state.avgSort = 'type'
    state.avgEnriched = null
    const listEl = resultEl.querySelector('#scan-avg-list')
    resultEl.querySelector('#scan-sort-select').addEventListener('change', (e) => {
      state.avgSort = e.target.value
      if (state.avgEnriched && listEl.isConnected) {
        renderReadonlyCardGroups(listEl, state.avgEnriched, {
          commanders, sortMode: state.avgSort, hoverSidebar: true,
        })
      }
    })

    renderDeckList(listEl, fullList, pricing, scanToken, commanders, collection)
  }

  // Liste im Deck-View-Look. Die Collection kommt normal schon parallel aus
  // runScan (ggf. aus dem Session-Cache) — nur wenn das schiefging, lädt die
  // Liste hier selbst nach; niemals Sackgasse.
  async function renderDeckList(listEl, cards, pricing, scanToken, commanders, collection = null) {
    const finish = (enriched) => {
      state.avgEnriched = enriched
      renderReadonlyCardGroups(listEl, enriched, {
        commanders, sortMode: state.avgSort, hoverSidebar: true,
      })
      renderDeckStats(enriched)
    }
    if (collection) {
      finish(enrichCards(cards, buildScryfallIndex(collection), pricing.priced))
      return
    }
    try {
      const { found } = await fetchCardCollection(cards.map(c => c.name))
      if (!scanGuard.isCurrent(scanToken) || !listEl.isConnected) return
      finish(enrichCards(cards, buildScryfallIndex(found), pricing.priced))
    } catch (err) {
      if (!scanGuard.isCurrent(scanToken) || !listEl.isConnected) return
      // Fallback ohne Scryfall: flache Liste mit Preisen
      finish(enrichCards(cards, new Map(), pricing.priced))
    }
  }

  function renderRealDecksSection() {
    realDecksEl.hidden = false
    realDecksEl.innerHTML = `
      <div class="scan-real-header">
        <h3>Echte Decks</h3>
        <button class="btn btn-secondary" id="scan-load-decks">
          Echte Decks laden (Top ${REAL_DECKS_LIMIT})
          <span class="scan-btn-subtext">kann bei beliebten Commandern mehrere MB laden — WLAN empfohlen</span>
        </button>
      </div>
      <div id="scan-decks-table"></div>
    `
    document.getElementById('scan-load-decks').addEventListener('click', loadRealDecks)
  }

  async function loadRealDecks() {
    const btn = document.getElementById('scan-load-decks')
    const tableEl = document.getElementById('scan-decks-table')
    btn.disabled = true
    btn.textContent = 'Lade Deck-Tabelle…'
    tableEl.innerHTML = loadingHtml('Lade Deck-Tabelle — kann bei beliebten Commandern mehrere MB wiegen...')
    try {
      const decks = await fetchRealDecks(state.slug, REAL_DECKS_LIMIT)
      if (!decks.length) {
        tableEl.innerHTML = '<p class="empty">Keine echten Decks gefunden.</p>'
        btn.remove()
        return
      }
      btn.remove()
      // data-label + CSS: Desktop echte Tabelle, mobil gestapelte Karten
      // (die 5-Spalten-Tabelle war der H-Scroll-Täter aus dem User-Screenshot)
      tableEl.innerHTML = `
        <table class="card-table scan-decks-table">
          <thead>
            <tr>
              <th>Datum</th><th>EDHREC-Preis</th><th>Salt</th><th>Bracket</th><th></th>
            </tr>
          </thead>
          <tbody>
            ${decks.map((d, i) => `
              <tr class="scan-deck-row" data-hash="${escapeHtml(d.urlhash)}" data-idx="${i}">
                <td data-label="Datum">${escapeHtml(d.savedate || '–')}</td>
                <td data-label="EDHREC-Preis">${d.price != null ? `$${d.price.toLocaleString('de-DE')}` : '–'}</td>
                <td data-label="Salt">${d.salt ?? '–'}</td>
                <td data-label="Bracket">${d.bracket ?? '–'}</td>
                <td class="scan-deck-action"><button class="btn-small scan-eval-btn">Mit unseren Preisen bewerten</button></td>
              </tr>
              <tr class="scan-deck-detail" data-detail="${escapeHtml(d.urlhash)}" hidden><td colspan="5"></td></tr>
            `).join('')}
          </tbody>
        </table>
      `
      refade(tableEl)
      tableEl.querySelectorAll('.scan-eval-btn').forEach(evalBtn => {
        evalBtn.addEventListener('click', () => evaluateDeck(evalBtn))
      })
    } catch (err) {
      btn.disabled = false
      btn.textContent = `Fehler — nochmal versuchen`
      tableEl.innerHTML = `<p class="scan-error-detail">${escapeHtml(err.message)}</p>`
    }
  }

  async function evaluateDeck(evalBtn) {
    const row = evalBtn.closest('.scan-deck-row')
    const hash = row.dataset.hash
    const detailRow = realDecksEl.querySelector(`.scan-deck-detail[data-detail="${CSS.escape(hash)}"]`)
    const cell = detailRow.querySelector('td')
    detailRow.hidden = false
    cell.innerHTML = loadingHtml('Lade Liste + Preise…')
    evalBtn.disabled = true
    try {
      const preview = await fetchDeckPreview(hash)

      // EDHREC-Datenloch: manche Previews (private/kaputte Quell-Decks) haben
      // nur 1-2 Zeilen. Eine "Bewertung" über 4 € für ein $800-Deck wäre
      // irreführend — ehrlich kennzeichnen statt Schein-Zahlen zeigen.
      const qtySum = preview.cards.reduce((s, c) => s + c.quantity, 0)
      const originalUrl = safeExternalUrl(preview.url)
      if (qtySum < 90) {
        cell.innerHTML = `
          <div class="scan-deck-mini">
            <span>EDHREC liefert für dieses Deck nur ${qtySum} von ~100 Karten — keine belastbare Bewertung möglich.</span>
            ${originalUrl ? `<span class="scan-deck-links"><a href="${escapeHtml(originalUrl)}" target="_blank" rel="noopener">Original-Deck ansehen</a></span>` : ''}
          </div>
        `
        evalBtn.textContent = 'Unvollständig'
        return
      }

      const pricing = await priceList(preview.cards)
      cell.innerHTML = `
        <div class="scan-deck-mini">
          <span><strong>${formatPrice(pricing.total)}</strong> lt. unserer DB${preview.price != null ? ` · $${preview.price.toLocaleString('de-DE')} lt. EDHREC` : ''}</span>
          ${pricing.missing.length ? `<span>${pricing.missing.length} ohne Preis</span>` : ''}
          <span class="scan-deck-links">
            ${originalUrl ? `<a href="${escapeHtml(originalUrl)}" target="_blank" rel="noopener">Original-Deck</a>` : ''}
            ${getPlayer() ? `<button class="btn-small scan-import-real">Als Deck importieren</button>` : ''}
          </span>
        </div>
        <div class="scan-card-list scan-deck-cards">${loadingHtml('Kartendetails laden...')}</div>
      `
      cell.querySelector('.scan-import-real')?.addEventListener('click', () => {
        startImport({
          name: `${preview.commanders.join(' + ') || state.commander.name} (EDHREC ${hash.slice(0, 6)})`,
          commanders: preview.commanders,
          cards: preview.cards,
        })
      })
      evalBtn.textContent = 'Bewertet'
      refade(cell)

      // Liste im Deck-View-Look, eigener Preview-Scope pro bewertetem Deck
      const listEl = cell.querySelector('.scan-deck-cards')
      const listOpts = { commanders: preview.commanders, sortMode: 'type' }
      try {
        const coll = await fetchScanCollection(`scan:coll:deck:${hash}`, preview.cards)
        if (!listEl.isConnected) return
        renderReadonlyCardGroups(listEl, enrichCards(preview.cards, buildScryfallIndex(coll), pricing.priced), listOpts)
      } catch {
        if (!listEl.isConnected) return
        renderReadonlyCardGroups(listEl, enrichCards(preview.cards, new Map(), pricing.priced), listOpts)
      }
    } catch (err) {
      cell.innerHTML = `<p class="scan-error-detail">${escapeHtml(err.message)}</p>`
      evalBtn.disabled = false
    }
  }

  // Preis-Pipeline: exakte Namen → DFC-Front-Face-Fallback → missing-Liste.
  // throwOnError: DB-Ausfall ist ein eigener Fehlerzustand, nicht "alles 0 €".
  async function priceList(cards) {
    const names = cards.map(c => c.name)
    const lookup = await fetchCheapestPrices(names, { throwOnError: true })
    const misses = [...new Set(names.filter(n => !lookup.has(n)))]
    const frontLookup = misses.length ? await fetchPricesByFrontFace(misses) : new Map()

    const priced = []
    const missing = []
    let total = 0
    for (const { name, quantity } of cards) {
      const info = lookup.get(name) || frontLookup.get(name)
      if (info?.price != null) {
        const lineTotal = info.price * quantity
        total += lineTotal
        priced.push({ name, quantity, price: info.price, lineTotal, isFoil: !!info.isFoil })
      } else {
        missing.push(name)
        priced.push({ name, quantity, price: null, lineTotal: 0, isFoil: false })
      }
    }
    return { priced, missing, total: Math.round(total * 100) / 100 }
  }

  function startImport({ name, commanders, cards }) {
    const list = serializeDeckForImport({ commanders, cards })
    try {
      sessionStorage.setItem('mtg_import_prefill', JSON.stringify({ name, list }))
    } catch { /* voll? Import geht auch mit leerem Prefill */ }
    navigate('/import')
  }

  // Landing sofort laden (cache-gestützt, blockt nie die Suche)
  loadLanding()
}

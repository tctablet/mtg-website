// scan.js — Commander-Scan mit EDHREC-artiger Landing:
//
// Landing: „Beliebte Commander" als Karten-Grid (Bilder direkt von der
// Scryfall-CDN über die EDHREC-mitgelieferte ID), Perioden-Tabs
// (Woche/Monat/2 Jahre) + WUBRG+C-Farbfilter (EDHREC-Farbidentitäts-Seiten).
// Ein Klick auf eine Karte startet den Scan — über die Scryfall-ID, nie über
// einen fehleranfälligen Namens-Lookup.
//
// Scan: Commander-Klick → Deck-Übersicht als KACHEL-Grid (User-Ansage
// 06.08.2026): eine Kachel fürs EDHREC-Average-Deck + eine pro echtem Deck
// (Top 20). Unsere DB-Preise laden AUTOMATISCH und gebatcht (alle Previews
// parallel, EIN Preis-Lookup über die Namens-Union) und werden in die
// Kacheln gepatcht — kein Klick-pro-Deck mehr. Kachel-Klick → Detail im
// Deck-View-Look (Typ-Gruppen, Sidebar-Preview, Stats).
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
import { loadingHtml, refade } from '../components/loading.js'

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

// Begrenzte Parallelität: N Worker ziehen Items von einem gemeinsamen Cursor.
// Für die 20 Deck-Previews — parallel, aber ohne EDHREC mit 20 gleichzeitigen
// Requests zu fluten.
async function mapPool(items, size, worker) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await worker(items[i], i)
    }
  }))
  return results
}

export async function renderScan(container) {
  // State pro Render zurücksetzen (kein Modul-Zombie)
  const state = {
    commander: null, partner: null, slug: null,
    period: 'week', colors: new Set(),
    // screen: 'landing' | 'overview' | 'detail' — steuert den Back-Button
    screen: 'landing',
    scanToken: null,
    overview: null,
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
          <span class="cmdr-frame cmdr-frame-pair">
            ${c.rank ? `<span class="cmdr-rank">#${c.rank}</span>` : ''}
            <img class="cmdr-pair-a" src="${escapeHtml(imgA)}" alt="" loading="lazy" decoding="async"
              onerror="const f=this.closest('.cmdr-frame');this.remove();if(!f.querySelector('img'))f.classList.add('cmdr-frame-noimg')" />
            <img class="cmdr-pair-b" src="${escapeHtml(imgB)}" alt="" loading="lazy" decoding="async"
              onerror="const f=this.closest('.cmdr-frame');this.remove();if(!f.querySelector('img'))f.classList.add('cmdr-frame-noimg')" />
            <span class="cmdr-noimg-name">${escapeHtml(nameA)} + ${escapeHtml(nameB)}</span>
            <span class="cmdr-pair-swap" aria-hidden="true" title="Partner tauschen">&#8646;</span>
          </span>
          <span class="cmdr-name">${escapeHtml(nameA)}</span>
          <span class="cmdr-name cmdr-name-partner">+ ${escapeHtml(nameB)}</span>
          ${decksHtml}
        </button>
      `
    }
    return `
      <button class="cmdr-tile" data-idx="${i}" aria-label="${escapeHtml(c.name)} scannen">
        <span class="cmdr-frame">
          ${c.rank ? `<span class="cmdr-rank">#${c.rank}</span>` : ''}
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
    state.screen = 'landing'
    landingEl.hidden = false
    backBtn.hidden = true
    resultEl.hidden = true
    resultEl.innerHTML = ''
    scanGuard.begin() // laufende Scans verwerfen
  }
  const hideLanding = () => {
    landingEl.hidden = true
    backBtn.hidden = false
  }
  // Back-Navigation: Detail → Kachel-Übersicht (aus dem Speicher, kein
  // Refetch) → Landing
  backBtn.addEventListener('click', () => {
    if (state.screen === 'detail' && state.overview) renderOverview()
    else showLanding()
  })

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

  // --- Scan: Kachel-Übersicht (Average-Deck + echte Decks) ---

  async function runScan() {
    if (!state.commander) return
    const scanToken = scanGuard.begin()
    state.scanToken = scanToken
    state.slug = state.partner
      ? partnerSlug(state.commander.name, state.partner.name)
      : edhrecSlug(state.commander.name)
    state.overview = {
      avg: null, avgError: null,
      decks: null, decksError: null,
      // urlhash → { status: 'ok'|'incomplete'|'error', preview?, pricing?, qtySum? }
      totals: new Map(),
      pricesFailed: false,
    }

    hideLanding()
    renderOverview()
    // Average und Deck-Tabelle sind unabhängig → beide parallel anstoßen,
    // jede Fläche patcht ihre Kacheln selbst
    loadAverage(scanToken)
    loadRealDecks(scanToken)
  }

  // Average-Deck laden + bepreisen → Kachel patchen. Fehler landen IN der
  // Kachel (Klick = Retry), nie als Vollflächen-Wipe der Übersicht.
  async function loadAverage(token) {
    try {
      const avg = await fetchAverageDeck(state.slug)
      if (!scanGuard.isCurrent(token)) return

      // Commander gehören zum Deck: sie stehen in der Liste (eigene Sektion)
      // und zählen in Wert + Kartenzahl — exakt wie in der Deck-Ansicht
      const commanders = avg.commanders.length
        ? avg.commanders
        : [state.commander.name, state.partner?.name].filter(Boolean)
      const fullList = [
        ...commanders.map(n => ({ name: n, quantity: 1 })),
        ...avg.cards.filter(c => !commanders.some(n => n.toLowerCase() === c.name.toLowerCase())),
      ]

      // Preise (Supabase) und Kartendetails (Scryfall-Collection) sind
      // unabhängig → PARALLEL. Preise sind Pflicht (Fehler-Kachel),
      // Collection ist optional (Detail lädt sonst selbst nach).
      const [pricingRes, collectionRes] = await Promise.allSettled([
        priceList(fullList),
        fetchScanCollection(`scan:coll:${state.slug}`, fullList),
      ])
      if (!scanGuard.isCurrent(token)) return
      if (pricingRes.status === 'rejected') throw pricingRes.reason

      state.overview.avg = {
        fullList,
        commanders,
        pricing: pricingRes.value,
        collection: collectionRes.status === 'fulfilled' ? collectionRes.value : null,
      }
      state.overview.avgError = null
    } catch (err) {
      if (!scanGuard.isCurrent(token)) return
      state.overview.avgError = err
    }
    refreshOverviewGrid()
  }

  // Deck-Tabelle → Kacheln sofort rendern → alle Previews parallel (Pool) →
  // EIN gebatchter Preis-Lookup über die Namens-Union → Kacheln patchen.
  // So sind unsere Preise für ALLE Decks da, ohne 20 Einzel-Klicks.
  async function loadRealDecks(token) {
    let decks
    try {
      decks = await fetchRealDecks(state.slug, REAL_DECKS_LIMIT)
      if (!scanGuard.isCurrent(token)) return
    } catch (err) {
      if (!scanGuard.isCurrent(token)) return
      state.overview.decksError = err
      refreshOverviewGrid()
      return
    }
    state.overview.decks = decks
    state.overview.decksError = null
    refreshOverviewGrid()
    if (!decks.length) return

    // Previews parallel, aber gedrosselt (Pool 6) — fehlertolerant pro Deck
    const previews = await mapPool(decks, 6, async (d) => {
      try {
        return await fetchDeckPreview(d.urlhash)
      } catch {
        return null
      }
    })
    if (!scanGuard.isCurrent(token)) return

    // Namens-Union der vollständigen Decks → ein Preis-Lookup für alles
    const nameSet = new Set()
    previews.forEach(p => {
      if (p && p.cards.reduce((s, c) => s + c.quantity, 0) >= 90) {
        p.cards.forEach(c => nameSet.add(c.name))
      }
    })
    let priceCtx = null
    try {
      priceCtx = nameSet.size
        ? await buildPriceLookup([...nameSet])
        : { lookup: new Map(), frontLookup: new Map() }
    } catch { /* DB down → Kacheln zeigen den Fehlerzustand */ }
    if (!scanGuard.isCurrent(token)) return

    state.overview.pricesFailed = !priceCtx
    decks.forEach((d, i) => {
      const p = previews[i]
      if (!p) {
        state.overview.totals.set(d.urlhash, { status: 'error' })
        return
      }
      const qtySum = p.cards.reduce((s, c) => s + c.quantity, 0)
      // EDHREC-Datenloch: manche Previews (private/kaputte Quell-Decks) haben
      // nur 1-2 Zeilen — ehrlich kennzeichnen statt Schein-Preis zeigen
      if (qtySum < 90) {
        state.overview.totals.set(d.urlhash, { status: 'incomplete', qtySum, preview: p })
        return
      }
      if (!priceCtx) {
        state.overview.totals.set(d.urlhash, { status: 'error', preview: p })
        return
      }
      state.overview.totals.set(d.urlhash, {
        status: 'ok', preview: p, pricing: priceWithLookup(p.cards, priceCtx),
      })
    })
    refreshOverviewGrid()
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

  // --- Übersicht: Kachel-Grid rendern & aus dem State patchen ---

  const formatSavedate = (savedate) => {
    if (!savedate) return null
    const d = new Date(savedate)
    return Number.isNaN(d.getTime())
      ? String(savedate)
      : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
  }

  function renderOverview() {
    state.screen = 'overview'
    backBtn.textContent = '← Beliebte Commander'
    resultEl.hidden = false
    const artCrop = getCardArtCrop(state.commander.card)
    const headerBg = artCrop
      ? `background-image: linear-gradient(to bottom, rgba(15,15,20,0.3), rgba(15,15,20,0.95) 80%), url('${escapeHtml(artCrop)}')`
      : ''
    const names = [state.commander.name, state.partner?.name].filter(Boolean)
    resultEl.innerHTML = `
      <div class="deck-header-banner" style="${headerBg}">
        <div class="deck-header">
          <div>
            <h2>${names.map(escapeHtml).join(' + ')}</h2>
            <p class="deck-meta">Deck-Übersicht &middot; Durchschnittsdeck + Top ${REAL_DECKS_LIMIT} echte Decks, alle mit unserem Preis</p>
          </div>
        </div>
      </div>
      <div id="scan-deck-grid" class="scan-deck-grid">${overviewGridHtml()}</div>
    `
    refade(resultEl)

    // EIN delegierter Listener auf dem Grid — überlebt jedes State-Patch-
    // Rerender der Kacheln
    resultEl.querySelector('#scan-deck-grid').addEventListener('click', (e) => {
      const retry = e.target.closest('.scan-decks-retry')
      if (retry) {
        state.overview.decksError = null
        state.overview.pricesFailed = false
        // error-Einträge zurück auf „lädt" — damit verschwindet auch der
        // Retry-Button bis zum Batch-Ende (blockt den Doppel-Klick, Critic)
        for (const [hash, t] of [...state.overview.totals]) {
          if (t.status === 'error') state.overview.totals.delete(hash)
        }
        refreshOverviewGrid()
        loadRealDecks(state.scanToken)
        return
      }
      const tile = e.target.closest('.scan-deck-tile')
      if (!tile || tile.disabled) return
      if (tile.dataset.kind === 'avg') {
        if (state.overview.avgError) {
          // Fehler-Kachel: Klick = Retry
          state.overview.avgError = null
          refreshOverviewGrid()
          loadAverage(state.scanToken)
        } else if (state.overview.avg) {
          openAverage()
        }
        return
      }
      const hash = tile.dataset.hash
      if (hash && state.overview.totals.get(hash)?.status === 'ok') openRealDeck(hash)
    })
  }

  // Kacheln sind eine PURE Funktion des Overview-States — jedes Patch ist ein
  // komplettes Grid-Rerender (billig, ~21 Kacheln), kein DOM-Gefummel
  function refreshOverviewGrid() {
    if (state.screen !== 'overview') return
    const grid = resultEl.querySelector('#scan-deck-grid')
    if (!grid) return
    grid.innerHTML = overviewGridHtml()
    // Jeder State-Patch (Preise da, Average da, Retry) faded statt zu blinken
    refade(grid)
  }

  function overviewGridHtml() {
    return avgTileHtml() + deckTilesHtml()
  }

  function avgTileHtml() {
    const o = state.overview
    const artCrop = getCardArtCrop(state.commander.card)
    const artHtml = artCrop
      ? `<span class="scan-deck-art" style="background-image:url('${escapeHtml(artCrop)}')"></span>`
      : ''
    let bodyHtml
    let disabled = false
    let ariaLabel = 'Durchschnittsdeck öffnen'
    if (o.avgError) {
      ariaLabel = 'Durchschnittsdeck nochmal laden'
      bodyHtml = `
        <span class="scan-deck-note scan-deck-error">Konnte nicht geladen werden — tippen zum Nochmal-Versuchen</span>
        <span class="scan-deck-meta">${escapeHtml(o.avgError.message || 'Fehler')}</span>
      `
    } else if (!o.avg) {
      disabled = true
      bodyHtml = `
        <span class="scan-deck-meta">~100 Karten</span>
        <span class="scan-deck-price-row"><span class="scan-deck-price scan-deck-price-loading">Preis lädt…</span></span>
      `
    } else {
      const count = o.avg.fullList.reduce((s, c) => s + c.quantity, 0)
      const missing = o.avg.pricing.missing.length
      bodyHtml = `
        <span class="scan-deck-meta">${count} Karten${missing ? ` · ${missing} ohne Preis` : ''}</span>
        <span class="scan-deck-price-row"><span class="scan-deck-price">${formatPrice(o.avg.pricing.total)}</span></span>
      `
    }
    return `
      <button class="scan-deck-tile scan-deck-tile-avg" data-kind="avg" ${disabled ? 'disabled' : ''}
        aria-label="${ariaLabel}">
        ${artHtml}
        <span class="scan-deck-body">
          <span class="scan-deck-badge">Durchschnittsdeck</span>
          <span class="scan-deck-title">EDHREC Average</span>
          ${bodyHtml}
        </span>
      </button>
    `
  }

  function deckTileHtml(d, i) {
    const t = state.overview.totals.get(d.urlhash)
    const dateText = formatSavedate(d.savedate)
    const metaBits = []
    if (d.salt != null) metaBits.push(`Salt ${d.salt}`)
    if (d.bracket != null) metaBits.push(`Bracket ${d.bracket}`)
    const edhrecPrice = d.price != null ? `$${d.price.toLocaleString('de-DE')} lt. EDHREC` : ''
    const rankHtml = `<span class="scan-deck-rank">#${i + 1}</span>`
    const headHtml = `
      <span class="scan-deck-title">${dateText ? `Deck vom ${escapeHtml(dateText)}` : 'EDHREC-Deck'}</span>
      ${metaBits.length ? `<span class="scan-deck-meta">${metaBits.join(' · ')}</span>` : ''}
    `

    // Sackgassen-Fälle als STATISCHE Kachel (div statt button): der Original-
    // Deck-Link bleibt als echtes <a> erreichbar, EDHREC-Preis bleibt sichtbar
    // (Critic [HIGH]: preview.url lag im State, wurde aber nie gerendert)
    if (t && t.status !== 'ok') {
      // Fehlerursachen unterscheiden (Critic R2): ohne preview ist das DECK
      // nicht ladbar, mit preview fehlt nur unser Preis
      const note = t.status === 'incomplete'
        ? `EDHREC liefert nur ${t.qtySum} von ~100 Karten — keine belastbare Bewertung`
        : (t.preview ? 'Preis gerade nicht ladbar' : 'Deck konnte von EDHREC nicht geladen werden')
      const originalUrl = safeExternalUrl(t.preview?.url)
      return `
        <div class="scan-deck-tile scan-deck-tile-static">
          ${rankHtml}
          <span class="scan-deck-body">
            ${headHtml}
            <span class="scan-deck-note">${note}</span>
            ${edhrecPrice ? `<span class="scan-deck-price-sub">${edhrecPrice}</span>` : ''}
            ${originalUrl ? `<a class="scan-deck-link" href="${escapeHtml(originalUrl)}" target="_blank" rel="noopener">Original-Deck ansehen</a>` : ''}
          </span>
        </div>
      `
    }

    const priceHtml = !t
      ? '<span class="scan-deck-price scan-deck-price-loading">Preis lädt…</span>'
      : `
        <span class="scan-deck-price">${formatPrice(t.pricing.total)}</span>
        ${edhrecPrice || t.pricing.missing.length ? `<span class="scan-deck-price-sub">${[edhrecPrice, t.pricing.missing.length ? `${t.pricing.missing.length} ohne Preis` : ''].filter(Boolean).join(' · ')}</span>` : ''}
      `
    return `
      <button class="scan-deck-tile" data-hash="${escapeHtml(d.urlhash)}" ${t ? '' : 'disabled'}
        aria-label="${dateText ? `Echtes Deck vom ${escapeHtml(dateText)} öffnen` : 'Echtes Deck öffnen'}">
        ${rankHtml}
        <span class="scan-deck-body">
          ${headHtml}
          <span class="scan-deck-price-row">${priceHtml}</span>
        </span>
      </button>
    `
  }

  function deckTilesHtml() {
    const o = state.overview
    // Exklusive Fehlerbox NUR solange es noch keine Kacheln gibt — ein
    // gescheiterter RETRY darf die bereits geladenen/bepreisten Kacheln nie
    // aus der Anzeige wischen (Critic R2 [HIGH]: Fehlerzeile statt Wipe)
    if (o.decksError && !o.decks) {
      return `
        <div class="scan-deck-status scan-error-box">
          <p>Echte Decks konnten nicht geladen werden.</p>
          <p class="scan-error-detail">${escapeHtml(o.decksError.message || 'Fehler')}</p>
          <div class="scan-error-actions"><button class="btn btn-secondary scan-decks-retry">Nochmal versuchen</button></div>
        </div>
      `
    }
    if (!o.decks) {
      // Tabelle lädt noch — Datenverbrauchs-Hinweis bleibt erhalten (Critic:
      // der alte Opt-in-Button trug die WLAN-Warnung, die Last ist unverändert)
      return Array.from({ length: 6 }, () => '<div class="scan-deck-tile scan-deck-skeleton" aria-hidden="true"></div>').join('')
        + '<p class="scan-deck-status scan-deck-loadnote">Lade echte Decks — kann bei beliebten Commandern mehrere MB laden (WLAN empfohlen).</p>'
    }
    if (!o.decks.length) {
      return '<p class="empty scan-deck-status">Keine echten Decks gefunden.</p>'
    }
    const tiles = o.decks.map((d, i) => deckTileHtml(d, i)).join('')
    const anyError = o.decksError || o.pricesFailed
      || (o.totals.size > 0 && o.decks.some(d => o.totals.get(d.urlhash)?.status === 'error'))
    const retryHtml = anyError ? `
      <div class="scan-deck-status">
        <p class="scan-error-detail">${o.decksError
          ? escapeHtml(o.decksError.message || 'Echte Decks konnten nicht neu geladen werden.')
          : 'Einige Previews/Preise konnten nicht geladen werden.'}</p>
        <button class="btn btn-secondary scan-decks-retry">Fehlende nochmal versuchen</button>
        <p class="scan-deck-loadnote">Kann erneut mehrere MB laden (WLAN empfohlen).</p>
      </div>
    ` : ''
    return tiles + retryHtml
  }

  // --- Detail-Screens (Average + echtes Deck) im Deck-View-Look ---

  function openAverage() {
    const a = state.overview.avg
    if (!a) return
    renderDeckScreen({
      titleText: a.commanders.join(' + '),
      metaBits: ['EDHREC Average Deck'],
      cards: a.fullList,
      commanders: a.commanders,
      pricing: a.pricing,
      importName: `${a.commanders.join(' + ')} (EDHREC Average)`,
      loadCollection: async () => a.collection || fetchScanCollection(`scan:coll:${state.slug}`, a.fullList),
    })
  }

  function openRealDeck(hash) {
    const d = state.overview.decks?.find(x => x.urlhash === hash)
    const t = state.overview.totals.get(hash)
    if (!d || t?.status !== 'ok') return
    const { preview, pricing } = t
    const commanders = preview.commanders.length
      ? preview.commanders
      : [state.commander.name, state.partner?.name].filter(Boolean)
    const dateText = formatSavedate(d.savedate)
    // Nur typgeprüfte Zahlen (extractDeckTable/extractDeckPreview) — HTML-safe
    const metaBits = ['Echtes EDHREC-Deck']
    if (d.salt != null) metaBits.push(`Salt ${d.salt}`)
    if (d.bracket != null) metaBits.push(`Bracket ${d.bracket}`)
    if (preview.price != null) metaBits.push(`$${preview.price.toLocaleString('de-DE')} lt. EDHREC`)
    const originalUrl = safeExternalUrl(preview.url)
    renderDeckScreen({
      titleText: dateText ? `Deck vom ${dateText}` : 'EDHREC-Deck',
      metaBits,
      cards: preview.cards,
      commanders,
      pricing,
      importName: `${commanders.join(' + ') || state.commander.name} (EDHREC ${hash.slice(0, 6)})`,
      extraActionsHtml: originalUrl
        ? `<a class="btn-small scan-original-link" href="${escapeHtml(originalUrl)}" target="_blank" rel="noopener">Original-Deck</a>`
        : '',
      loadCollection: () => fetchScanCollection(`scan:coll:deck:${hash}`, preview.cards),
    })
  }

  // Gemeinsames Detail-Gerüst (User-Ansage: Deck-View-Look): Commander-Art-
  // Banner, Gesamtwert, Sortierung, Sidebar mit Preview + Stats.
  function renderDeckScreen({ titleText, metaBits, cards, commanders, pricing, importName, extraActionsHtml = '', loadCollection }) {
    state.screen = 'detail'
    backBtn.textContent = '← Deck-Übersicht'
    const scanToken = state.scanToken
    const cardCount = cards.reduce((s, c) => s + c.quantity, 0)
    const artCrop = getCardArtCrop(state.commander.card)
    const headerBg = artCrop
      ? `background-image: linear-gradient(to bottom, rgba(15,15,20,0.3), rgba(15,15,20,0.95) 80%), url('${escapeHtml(artCrop)}')`
      : ''
    const commanderImage = getCardNormalImage(state.commander.card)

    resultEl.innerHTML = `
      <div class="deck-header-banner" style="${headerBg}">
        <div class="deck-header">
          <div>
            <h2>${escapeHtml(titleText)}</h2>
            <p class="deck-meta">
              ${metaBits.join(' &middot; ')} &middot; <strong>${cardCount}</strong> Karten
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
          ${getPlayer() ? `<button class="btn scan-import-btn">Als Deck importieren</button>` : ''}
          ${extraActionsHtml}
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
            <!-- bewusst leer: setDefaultPreview befüllt — NUR die Komponente
                 erzeugt Sidebar-imgs, damit jedes den Fehler-Fallback trägt -->
            <div id="deck-card-preview"></div>
            <div id="deck-stats" class="deck-stats"></div>
          </div>
        </aside>
        <div id="scan-deck-list" class="scan-card-list">${loadingHtml('Kartendetails laden...')}</div>
      </div>
    `
    // Fehler-Fallback (tote URL → Namens-Kasten) übernimmt die Komponente
    // selbst für JEDES Sidebar-Bild inkl. Hover-Zyklen (Critic R7)
    setDefaultPreview(commanderImage, state.commander.name)
    refade(resultEl)

    resultEl.querySelector('.scan-import-btn')?.addEventListener('click', () => {
      startImport({
        name: importName,
        commanders,
        cards: cards.filter(c => !commanders.some(n => n.toLowerCase() === c.name.toLowerCase())),
      })
    })

    const listEl = resultEl.querySelector('#scan-deck-list')
    let sortMode = 'type'
    let enriched = null
    const rerenderList = () => {
      renderReadonlyCardGroups(listEl, enriched, { commanders, sortMode, hoverSidebar: true })
      // Sortier-Wechsel + Collection-Eintreffen faden (Motion-Sweep)
      refade(listEl)
    }
    resultEl.querySelector('#scan-sort-select').addEventListener('change', (e) => {
      sortMode = e.target.value
      if (enriched && listEl.isConnected) rerenderList()
    })

    // Collection nachziehen (Overview hat sie fürs Average meist schon);
    // Fehler → flache Liste nur mit Preisen, niemals Sackgasse
    ;(async () => {
      let collection = null
      try {
        collection = await loadCollection()
      } catch { /* Fallback unten */ }
      if (!scanGuard.isCurrent(scanToken) || !listEl.isConnected) return
      enriched = enrichCards(cards, buildScryfallIndex(collection || []), pricing.priced)
      rerenderList()
      renderDeckStats(enriched)
    })()
  }

  // Preis-Pipeline: exakte Namen → DFC-Front-Face-Fallback → missing-Liste.
  // throwOnError: DB-Ausfall ist ein eigener Fehlerzustand, nicht "alles 0 €".
  // Lookup (DB-Runde) und Auswertung (pure Rechnung) sind getrennt, damit die
  // Deck-Übersicht EINEN gebatchten Lookup über alle 20 Decks fahren kann.
  async function buildPriceLookup(names) {
    const unique = [...new Set(names)]
    const lookup = await fetchCheapestPrices(unique, { throwOnError: true })
    const misses = unique.filter(n => !lookup.has(n))
    const frontLookup = misses.length ? await fetchPricesByFrontFace(misses) : new Map()
    return { lookup, frontLookup }
  }

  function priceWithLookup(cards, { lookup, frontLookup }) {
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

  async function priceList(cards) {
    return priceWithLookup(cards, await buildPriceLookup(cards.map(c => c.name)))
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

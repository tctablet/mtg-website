// scan.js — Commander-Scan: Commander eingeben → EDHREC-Decklisten holen →
// mit UNSEREN DB-Preisen (scryfall_prices) bepreisen. Öffentlich; die
// Import-Brücke (vorbefüllter Deck-Import) erscheint nur eingeloggt.
//
// Average-Deck lädt automatisch (54 KB). Echte Decks NUR lazy hinter einem
// Button mit Größenwarnung — die decks-Tabelle kann bei Mega-Commandern
// ~10 MB wiegen (Mobilfunk!). EDHREC-Fehler bleiben inline, die Suche
// bleibt immer bedienbar.

import { getPlayer } from '../auth.js'
import { navigate } from '../router.js'
import { fetchCheapestPrices, fetchPricesByFrontFace } from '../supabase.js'
import { fetchCardByName, isCommanderEligible, getPartnerType } from '../scryfall.js'
import { attachCardAutocomplete, createLatestGuard } from '../components/autocomplete.js'
import {
  edhrecSlug, partnerSlug, serializeDeckForImport,
  fetchAverageDeck, fetchRealDecks, fetchDeckPreview,
} from '../edhrec.js'
import { formatPrice, escapeHtml } from '../utils.js'

const REAL_DECKS_LIMIT = 20

// Partner-Kompatibilität — dieselben Regeln wie getPartnerCandidates() im
// Deck-Import (Critic-Fund: irgendein legaler Commander ist NICHT automatisch
// ein gültiger Partner; ein inkompatibles Paar erzeugt nur einen toten Slug)
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
// Scheme — javascript:-URIs bleiben draußen (Critic-Fund)
function safeExternalUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null
}

export async function renderScan(container) {
  // State pro Render zurücksetzen (kein Modul-Zombie)
  const state = { commander: null, partner: null, slug: null }
  // Race-Guards: scanGuard = nur der jüngste Scan rendert; selectGuard = der
  // zuletzt GEKLICKTE Commander gewinnt (nicht der zuletzt auflösende
  // fetchCardByName — Critic R2 [HIGH])
  const scanGuard = createLatestGuard()
  const selectGuard = createLatestGuard()

  container.innerHTML = `
    <div class="page scan-page">
      <h2>Commander-Scan</h2>
      <p class="scan-intro">
        Commander eingeben — wir holen die EDHREC-Listen und rechnen sie mit den
        Preisen unserer <a href="#" id="scan-preise-link">Preisdatenbank</a> durch.
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
      <div id="scan-result" hidden></div>
      <div id="scan-real-decks" hidden></div>
    </div>
  `

  document.getElementById('scan-preise-link').addEventListener('click', (e) => {
    e.preventDefault()
    navigate('/preise')
  })

  const searchStatus = document.getElementById('scan-search-status')
  const resultEl = document.getElementById('scan-result')
  const realDecksEl = document.getElementById('scan-real-decks')

  const showSearchStatus = (msg, isError = false) => {
    searchStatus.hidden = !msg
    searchStatus.textContent = msg || ''
    searchStatus.classList.toggle('scan-status-error', isError)
  }

  async function selectCommander(name, { asPartner = false } = {}) {
    const selectToken = selectGuard.begin()
    showSearchStatus('Prüfe Karte...')
    const card = await fetchCardByName(name)
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

  // .clear() als erste onPick-Zeile — etabliertes Muster aus deck-view.js;
  // ohne das bleibt das Dropdown nach dem Klick offen und weiter anklickbar
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

  async function runScan() {
    if (!state.commander) return
    const scanToken = scanGuard.begin()
    state.slug = state.partner
      ? partnerSlug(state.commander.name, state.partner.name)
      : edhrecSlug(state.commander.name)

    realDecksEl.hidden = true
    realDecksEl.innerHTML = ''
    resultEl.hidden = false
    resultEl.innerHTML = '<p class="loading">Lade EDHREC-Average-Deck...</p>'

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
      document.getElementById('scan-retry')?.addEventListener('click', runScan)
      return
    }

    let pricing
    try {
      pricing = await priceList(avg.cards)
      if (!scanGuard.isCurrent(scanToken)) return
    } catch (err) {
      if (!scanGuard.isCurrent(scanToken)) return
      resultEl.innerHTML = `
        <div class="scan-error-box">
          <p>Preisdatenbank nicht erreichbar — Liste geladen, aber nicht bepreisbar.</p>
          <p class="scan-error-detail">${escapeHtml(err.message)}</p>
          <div class="scan-error-actions"><button class="btn btn-secondary" id="scan-retry-prices">Nochmal versuchen</button></div>
        </div>
      `
      document.getElementById('scan-retry-prices')?.addEventListener('click', runScan)
      return
    }

    renderAverage(avg, pricing)
    renderRealDecksSection()
  }

  function renderAverage(avg, pricing) {
    const commanders = avg.commanders.length
      ? avg.commanders
      : [state.commander.name, state.partner?.name].filter(Boolean)
    const cardCount = avg.cards.reduce((s, c) => s + c.quantity, 0) + commanders.length
    const top10 = [...pricing.priced].sort((a, b) => b.lineTotal - a.lineTotal).slice(0, 10)

    resultEl.innerHTML = `
      <div class="scan-summary">
        <h3 class="scan-deck-title">Average Deck: ${commanders.map(escapeHtml).join(' + ')}</h3>
        <div class="scan-tiles">
          <div class="scan-tile">
            <span class="scan-tile-label">Unser Wert</span>
            <span class="scan-tile-value">${formatPrice(pricing.total)}</span>
          </div>
          <div class="scan-tile">
            <span class="scan-tile-label">Karten</span>
            <span class="scan-tile-value">${cardCount}</span>
          </div>
          <div class="scan-tile">
            <span class="scan-tile-label">Ohne Preis</span>
            <span class="scan-tile-value">${pricing.missing.length}</span>
          </div>
          <div class="scan-tile">
            <span class="scan-tile-label">Teuerste</span>
            <span class="scan-tile-value scan-tile-small">${top10[0] ? `${escapeHtml(top10[0].name)}<br>${formatPrice(top10[0].lineTotal)}` : '–'}</span>
          </div>
        </div>
        ${getPlayer() ? `<button class="btn scan-import-btn" data-kind="avg">Als Deck importieren</button>` : ''}
      </div>
      <div class="scan-tables">
        <div class="scan-top10">
          <h4>Teuerste Karten (unsere Preise)</h4>
          <table class="card-table">
            <thead><tr><th class="th-qty">#</th><th class="th-name">Karte</th><th class="th-price">Preis</th></tr></thead>
            <tbody>
              ${top10.map(c => `
                <tr>
                  <td class="card-qty">${c.quantity}</td>
                  <td class="card-name">${escapeHtml(c.name)}</td>
                  <td class="card-price">${c.isFoil ? '<span class="foil-badge">✦</span>' : ''}${formatPrice(c.lineTotal)}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        ${pricing.missing.length ? `
          <details class="scan-missing">
            <summary>${pricing.missing.length} Karten ohne DB-Preis</summary>
            <ul>${pricing.missing.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>
          </details>
        ` : ''}
        <details class="scan-full-list">
          <summary>Komplette Liste (${avg.cards.length} Einträge)</summary>
          <table class="card-table">
            <tbody>
              ${pricing.priced.map(c => `
                <tr>
                  <td class="card-qty">${c.quantity}</td>
                  <td class="card-name">${escapeHtml(c.name)}</td>
                  <td class="card-price">${c.price != null ? formatPrice(c.lineTotal) : '–'}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </details>
      </div>
    `

    resultEl.querySelector('.scan-import-btn')?.addEventListener('click', () => {
      startImport({
        name: `${commanders.join(' + ')} (EDHREC Average)`,
        commanders,
        cards: avg.cards,
      })
    })
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
    try {
      const decks = await fetchRealDecks(state.slug, REAL_DECKS_LIMIT)
      if (!decks.length) {
        tableEl.innerHTML = '<p class="empty">Keine echten Decks gefunden.</p>'
        btn.remove()
        return
      }
      btn.remove()
      tableEl.innerHTML = `
        <table class="card-table scan-decks-table">
          <thead>
            <tr>
              <th>Datum</th><th>EDHREC-Preis</th><th class="th-salt">Salt</th><th class="th-bracket">Bracket</th><th></th>
            </tr>
          </thead>
          <tbody>
            ${decks.map((d, i) => `
              <tr class="scan-deck-row" data-hash="${escapeHtml(d.urlhash)}" data-idx="${i}">
                <td>${escapeHtml(d.savedate || '–')}</td>
                <td>${d.price != null ? `$${d.price.toLocaleString('de-DE')}` : '–'}</td>
                <td class="th-salt">${d.salt ?? '–'}</td>
                <td class="th-bracket">${d.bracket ?? '–'}</td>
                <td><button class="btn-small scan-eval-btn">Mit unseren Preisen bewerten</button></td>
              </tr>
              <tr class="scan-deck-detail" data-detail="${escapeHtml(d.urlhash)}" hidden><td colspan="5"></td></tr>
            `).join('')}
          </tbody>
        </table>
      `
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
    cell.innerHTML = '<p class="loading">Lade Liste + Preise…</p>'
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
      const top3 = [...pricing.priced].sort((a, b) => b.lineTotal - a.lineTotal).slice(0, 3)
      cell.innerHTML = `
        <div class="scan-deck-mini">
          <span><strong>${formatPrice(pricing.total)}</strong> lt. unserer DB${preview.price != null ? ` · $${preview.price.toLocaleString('de-DE')} lt. EDHREC` : ''}</span>
          <span>Top: ${top3.map(c => `${escapeHtml(c.name)} (${formatPrice(c.lineTotal)})`).join(' · ')}</span>
          ${pricing.missing.length ? `<span>${pricing.missing.length} ohne Preis</span>` : ''}
          <span class="scan-deck-links">
            ${originalUrl ? `<a href="${escapeHtml(originalUrl)}" target="_blank" rel="noopener">Original-Deck</a>` : ''}
            ${getPlayer() ? `<button class="btn-small scan-import-real">Als Deck importieren</button>` : ''}
          </span>
        </div>
      `
      cell.querySelector('.scan-import-real')?.addEventListener('click', () => {
        startImport({
          name: `${preview.commanders.join(' + ') || state.commander.name} (EDHREC ${hash.slice(0, 6)})`,
          commanders: preview.commanders,
          cards: preview.cards,
        })
      })
      evalBtn.textContent = 'Bewertet'
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
}

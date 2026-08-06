// wizard/index.js — Recommendation Wizard (Tab „Optimieren" in deck-view).
//
// Komplett client-seitig, ohne LLM: Analyse = buildAnalysis (identisch zum
// CLI), Empfehlungen = Pool-Kandidaten × EDHREC-Konsens, Cuts = deterministische
// Heuristiken, Apply = exakt der Edit-v2-Swap-Pfad (swapCard, Insert-vor-Delete).
//
// EIN State-Objekt, ZWEI Projektionen (Plan F4): Desktop rendert alle vier
// Sektionen untereinander mit Scroll-Spy-Ankerleiste (Dashboard, kein
// Sequenz-Zwang); Mobile (≤768px, CSS-gesteuert) zeigt einen Schritt pro
// Screen mit Fortschrittszeile + sticky Budget-Bar sobald Picks existieren.

import { escapeHtml, formatPrice, formatManaCost } from '../utils.js'
import { refade } from '../components/loading.js'
import { fetchCheapestPrices } from '../supabase.js'
import { fetchCardCollection, getCardNormalImage, namedImageUrl } from '../scryfall.js'
import { showMobilePreview } from '../components/card-preview.js'
import {
  kpiRow, quotaBullets, manaCurveChart, colorSourcesPanel, hypergeoPanel,
  costDriversPanel, goldfishPanel, warnCard, ciPips, auditText,
} from './charts.js'
import { budgetGate, BUDGET_LIMIT_EUR } from '../../scripts/optimizer/lib/budget.mjs'
import { preflightSwapRules } from '../../scripts/optimizer/lib/preflight.mjs'
import { buildCardInsertRow, swapCard } from '../deck-mutations.js'
import { edhrecSlug, partnerSlug, fetchCommanderPage } from '../edhrec.js'
import { loadPool, searchByRole } from './pool.js'
import { analyzeDeck, runGoldfish } from './analysis.js'
import { buildGapRecommendations, unionCandidates } from './recommend.js'
import { buildCutCandidates } from './cuts.js'

const STEPS = ['Analyse', 'Empfehlungen', 'Cuts', 'Review']

export async function renderWizard({ container, deck, cards, onDeckChanged }) {
  const state = {
    pool: null,
    analysis: null,
    enriched: null,
    recommendations: [],
    cutCandidates: [],
    adds: [], // [{ name, price }]
    cuts: [], // [{ name, price }]
    activeStep: 0,
    applying: false,
    // Sim-Ergebnis lebt im STATE, nicht im DOM — jedes render() baut den
    // Container komplett neu und würde ein DOM-only-Panel löschen (Critic R1).
    goldfish: null,
  }

  container.innerHTML = '<p class="loading">Analysiere Deck & lade Kandidaten-Pool...</p>'

  let edhrecRecs = []
  try {
    const slug = deck.commander2
      ? partnerSlug(deck.commander, deck.commander2)
      : edhrecSlug(deck.commander)
    const [pool, deckAnalysis, recs] = await Promise.all([
      loadPool(),
      analyzeDeck({ deck, cards }),
      fetchCommanderPage(slug).catch(() => []), // EDHREC optional — Pool-only-Degradierung
    ])
    state.pool = pool
    state.analysis = deckAnalysis.analysis
    state.enriched = deckAnalysis.enriched
    edhrecRecs = recs
  } catch (err) {
    const isPool = err.code === 'pool-missing' || err.code === 'pool-invalid'
    container.innerHTML = `
      <div class="scan-error-box">
        <p>${isPool ? 'Kandidaten-Pool nicht verfügbar — Supabase-Bucket „assets" prüfen (einmaliges Setup, siehe Workflow build-pool-asset).' : 'Analyse fehlgeschlagen.'}</p>
        <p class="scan-error-detail">${escapeHtml(err.message)}</p>
        <div class="scan-error-actions"><button class="btn btn-secondary" id="wizard-retry">Nochmal versuchen</button></div>
      </div>
    `
    container.querySelector('#wizard-retry').addEventListener('click', () =>
      renderWizard({ container, deck, cards, onDeckChanged }))
    return
  }

  // Empfehlungen: Kandidaten je Lücke = Pool-Top-N ∪ EDHREC-Empfehlungen
  // (unionCandidates in recommend.js — pure + getestet).
  // Deck-CI: kanonisch aus dem Audit (validate.mjs-Vertrag: null = Commander
  // nicht auflösbar, NICHT "farblos") — nur dann auf die aus den aufgelösten
  // Karten abgeleitete CI zurückfallen; das Audit-Finding warnt separat.
  const deckCI = Array.isArray(state.analysis.audit.deckCI)
    ? state.analysis.audit.deckCI
    : [...new Set(state.enriched.flatMap(e => e.record?.color_identity || []))]
  const deckNames = new Set(cards.map(c => c.name.toLowerCase()))
  const gaps = state.analysis.quotas.filter(q => q.status === 'unter')
  const poolByName = new Map(state.pool.cards.map(c => [c.n.toLowerCase(), c]))
  const poolCandidatesByRole = new Map(gaps.map(gap => [
    gap.role,
    unionCandidates({
      base: searchByRole(state.pool, { role: gap.role, ci: deckCI, exclude: deckNames, limit: 12 }),
      edhrecRecs,
      poolByName,
      role: gap.role,
      deckCI,
      deckNames,
      cap: 18,
    }),
  ]))
  const candidateNames = [...poolCandidatesByRole.values()].flat().map(c => c.n)

  // Kartenbilder für die Vorschläge (User-Ansage: Bilder + Preview-Zoom):
  // EIN fetchCardCollection-Batch über alle Kandidaten, parallel zum
  // Preis-Fetch. Fehler degradieren zu Rows ohne Bild — ein Scryfall-Hänger
  // darf den Wizard nie ohne Retry-Pfad aufhängen (Critic R2 [HIGH]).
  const loadCandidateMedia = async (names) => {
    const media = new Map()
    if (!names.length) return media
    try {
      const { found } = await fetchCardCollection(names)
      for (const c of found) {
        const entry = {
          small: c.image_uris?.small || c.card_faces?.[0]?.image_uris?.small || null,
          normal: getCardNormalImage(c),
          // Flip-Button nur, wenn es eine echte Bild-Rückseite gibt
          scryfallId: c.card_faces?.[1]?.image_uris ? c.id : null,
        }
        media.set(c.name.toLowerCase(), entry)
        // DFC: Pool/EDHREC führen teils nur den Front-Face-Namen
        if (c.name.includes(' // ')) media.set(c.name.split(' // ')[0].toLowerCase(), entry)
      }
    } catch { /* ohne Bilder weiter — Zoom fällt auf namedImageUrl zurück */ }
    return media
  }
  const [priceMap, cardMedia] = await Promise.all([
    candidateNames.length ? fetchCheapestPrices(candidateNames) : new Map(),
    loadCandidateMedia([...new Set(candidateNames)]),
  ])
  const headroom = Math.max(0, BUDGET_LIMIT_EUR - state.analysis.budget.total)
  state.recommendations = buildGapRecommendations({
    gaps, poolCandidatesByRole, edhrecRecs, priceMap, headroom,
  })
  state.cutCandidates = buildCutCandidates({ analysis: state.analysis, enriched: state.enriched })

  // Cut-Kandidaten sind Deck-Karten — Bilder kommen aus der DB-Row (image_uri),
  // ohne zusätzlichen Netz-Request.
  for (const cc of state.cutCandidates) {
    const key = cc.name.toLowerCase()
    if (cardMedia.has(key)) continue
    const dbRow = cards.find(cr => cr.name.toLowerCase() === key)
    if (dbRow?.image_uri) {
      cardMedia.set(key, { small: dbRow.image_uri, normal: dbRow.image_uri, scryfallId: null })
    }
  }
  const mediaFor = (name) => cardMedia.get(name.toLowerCase()) || null
  const thumbHtml = (name) => {
    const m = mediaFor(name)
    return m?.small
      ? `<img class="wizard-cand-thumb" src="${escapeHtml(m.small)}" alt="" loading="lazy" />`
      : `<span class="wizard-cand-thumb wizard-thumb-empty" aria-hidden="true"><i class="ms ms-c"></i></span>`
  }

  // ---------- Rendering ----------

  const a = state.analysis
  const assetAgeDays = state.pool.meta.builtAt
    ? Math.floor((Date.now() - Date.parse(state.pool.meta.builtAt)) / 86400000)
    : null

  // Eigene Datenstand-Zeile statt formatDatenstand(): dessen Text enthält den
  // CLI-Hinweis "--refresh", den ein Website-Nutzer nicht ausführen kann
  const builtDate = state.pool.meta.builtAt
    ? new Date(state.pool.meta.builtAt).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : 'unbekannt'
  const analyseHtml = () => `
    <div class="wizard-datenstand">
      Kandidaten-Pool: Stand ${escapeHtml(builtDate)} · ${state.pool.meta.cardCount.toLocaleString('de-DE')} Karten
      ${assetAgeDays != null && assetAgeDays > 7 ? '<span class="wizard-warn">Pool-Asset älter als 7 Tage — der nächtliche Build läuft womöglich nicht.</span>' : ''}
      ${state.pool.warnings.map(w => `<span class="wizard-warn">${escapeHtml(w)}</span>`).join('')}
    </div>
    ${kpiRow(a, headroom)}
    ${warnCard([
      ...(a.budget.missing.length ? [`Preis unbekannt: ${a.budget.missing.join(', ')}`] : []),
      ...a.audit.findings.map(auditText),
    ])}
    ${quotaBullets(a.quotas)}
    ${manaCurveChart(state.enriched, a.manabase.avgMV)}
    ${colorSourcesPanel(a.manabase.colorSources)}
    ${hypergeoPanel(a.hypergeo)}
    ${costDriversPanel(a.budget.top, (name) => cards.find(cr => cr.name.toLowerCase() === name.toLowerCase())?.image_uri || null)}
    <div class="wiz-panel">
      <h4 class="wiz-panel-h">Goldfish-Simulation <span class="wiz-panel-sub">500 Läufe, deterministisch, ohne Gegner</span></h4>
      ${state.goldfish
        ? goldfishPanel(state.goldfish)
        : '<p class="wizard-line anim-skeleton">Simuliere 500 Läufe…</p>'}
    </div>
  `

  // Inclusion% als Mini-Meter im Label; null → nur Text (Critic R1 Null-State)
  const incMeter = (inc) => inc == null ? '' : `
    <span class="wizard-inc" role="img" aria-label="EDHREC-Inclusion ${Math.round(inc)} Prozent"><span class="wizard-inc-fill" style="width:${Math.min(100, Math.max(0, inc))}%"></span></span>`

  // Empfehlungs-Karte: großes Artwork (normal statt small — Karten stehen als
  // 5er-Reihe, User-Ansage), Mobile rendert dieselbe Struktur als Liste (CSS)
  const candidateRow = (c, gapRole) => {
    const m = mediaFor(c.name)
    const img = m?.normal || m?.small || namedImageUrl(c.name)
    return `
    <div class="wizard-cand card-row" data-name="${escapeHtml(c.name)}" data-role="${escapeHtml(gapRole)}">
      ${img
        ? `<img class="wizard-cand-thumb" src="${escapeHtml(img)}" alt="" loading="lazy" />`
        : '<span class="wizard-cand-thumb wizard-thumb-empty" aria-hidden="true"><i class="ms ms-c"></i></span>'}
      <div class="wizard-cand-main">
        <span class="wizard-cand-name" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</span>
        <span class="wizard-cand-metaline">
          <span class="wizard-cand-pips">${ciPips(c.ci)}</span>${c.cmc != null ? `<span class="wizard-chip">MV ${c.cmc}</span>` : ''}${c.gameChanger ? '<span class="wizard-gc" title="Game Changer">GC</span>' : ''}
        </span>
        ${c.inclusionPct != null
          ? `<span class="wizard-cand-label">${incMeter(c.inclusionPct)}<span class="wizard-cand-inc-text">in ${Math.round(c.inclusionPct)}&nbsp;% der Decks</span>${c.synergy != null ? `<span class="wizard-cand-syn">Synergie ${c.synergy > 0 ? '+' : ''}${escapeHtml(String(c.synergy))}</span>` : ''}</span>`
          : `<span class="wizard-cand-label">Beliebtheit${c.edhrecRank != null ? ` · EDHREC-Rang #${c.edhrecRank.toLocaleString('de-DE')}` : ''}</span>`}
      </div>
      <span class="wizard-cand-price${c.overHeadroom ? ' wizard-warn' : ''}">${c.price != null ? formatPrice(c.price) : 'Preis unbekannt'}</span>
      ${state.adds.some(p => p.name === c.name)
        ? '<button class="btn-small wizard-add-pick wizard-picked anim-interactive" disabled>✓ Im Review</button>'
        : '<button class="btn-small wizard-add-pick anim-interactive">+ Review</button>'}
    </div>
  `
  }

  // data-preview-scope pro Lücke: Blättern im Zoom bleibt bewusst innerhalb
  // einer Empfehlungs-Gruppe (Kandidaten derselben Rolle vergleichen).
  const empfehlungenHtml = () => state.recommendations.length
    ? state.recommendations.map(gap => `
        <div class="wizard-gap" data-preview-scope>
          <h4>${escapeHtml(gap.label)}
            <span class="wizard-gap-meter" role="img" aria-label="${gap.have} von mindestens ${gap.min}"><span class="wizard-gap-fill" style="width:${Math.min(100, (gap.have / gap.min) * 100)}%"></span></span>
            <span class="wizard-gap-nums">${gap.have}/${gap.min}–${gap.max}</span>
            <span class="wizard-warn">${gap.min - gap.have} fehlen</span></h4>
          ${gap.candidates.length
            ? `<div class="wizard-gap-cands">${gap.candidates.slice(0, 5).map(c => candidateRow(c, gap.role)).join('')}</div>`
            : '<p class="wizard-line">Keine budget-/farbtauglichen Kandidaten im Pool.</p>'}
        </div>`).join('')
    : '<p class="wizard-line">Keine Quoten-Lücken — das Deck erfüllt das Command-Zone-Template. ✓</p>'

  const cutsHtml = () => state.cutCandidates.length
    ? `<div data-preview-scope>${state.cutCandidates.map(c => {
        const dbRow = cards.find(cr => cr.name.toLowerCase() === c.name.toLowerCase())
        return `
        <div class="wizard-cand card-row" data-name="${escapeHtml(c.name)}">
          ${thumbHtml(c.name)}
          <div class="wizard-cand-main">
            <span class="wizard-cand-name">${escapeHtml(c.name)}
              ${dbRow?.mana_cost ? `<span class="wizard-cand-pips">${formatManaCost(dbRow.mana_cost)}</span>` : ''}</span>
            <span class="wizard-cand-label">${escapeHtml(c.reason)}</span>
          </div>
          <span class="wizard-cand-price">${c.price != null ? formatPrice(c.price) : '—'}</span>
          ${state.cuts.some(p => p.name === c.name)
            ? '<button class="btn-small wizard-cut-pick wizard-picked anim-interactive" disabled>✓ Gewählt</button>'
            : '<button class="btn-small wizard-cut-pick anim-interactive">− Review</button>'}
        </div>`
      }).join('')}</div>`
    : '<p class="wizard-line">Keine offensichtlichen Cut-Kandidaten gefunden.</p>'

  // Tauschen (User-Ansage): JEDE Deck-Karte kann Cut werden, nicht nur die
  // Heuristik-Vorschläge — Suchfeld über die aktuellen Deck-Rows (kein Netz).
  const cutSearchHtml = () => `
    <div class="wizard-cut-search">
      <h4>Tauschen — beliebige Karte aus dem Deck cutten</h4>
      <div class="autocomplete-wrapper">
        <input type="text" id="wizard-cut-input" placeholder="Deck-Karte suchen…" autocomplete="off" />
        <div id="wizard-cut-list" class="autocomplete-list" hidden></div>
      </div>
    </div>
  `

  const reviewHtml = () => {
    const pairs = Math.max(state.adds.length, state.cuts.length)
    if (!pairs) return '<p class="wizard-line">Noch keine Picks — Empfehlungen und Cuts mit den Review-Buttons sammeln.</p>'
    const rows = Array.from({ length: pairs }, (_, i) => {
      const cut = state.cuts[i]
      const add = state.adds[i]
      const pairThumb = (name) => {
        const m = name ? mediaFor(name) : null
        return m?.small ? `<img class="wizard-pair-thumb" src="${escapeHtml(m.small)}" alt="" loading="lazy" />` : ''
      }
      return `
        <div class="wizard-pair">
          <span class="wizard-pair-cut">${cut ? `${pairThumb(cut.name)}− ${escapeHtml(cut.name)} <em>${cut.price != null ? formatPrice(cut.price) : '—'}</em>` : '<span class="wizard-warn">Cut fehlt</span>'}</span>
          <span class="swap-pair-arrow">⇄</span>
          <span class="wizard-pair-add">${add ? `${pairThumb(add.name)}+ ${escapeHtml(add.name)} <em>${add.price != null ? formatPrice(add.price) : 'Preis unbekannt'}</em>` : '<span class="wizard-warn">Add fehlt</span>'}</span>
          <button class="btn-small wizard-pair-remove anim-interactive" data-idx="${i}">×</button>
        </div>`
    }).join('')

    const gate = state.adds.length && state.adds.length === state.cuts.length
      ? budgetGate({
          currentCards: cards,
          cuts: state.cuts.map(c => c.name),
          adds: state.adds.map(aP => ({ name: aP.name, price: aP.price })),
        })
      : null
    const balanced = state.adds.length === state.cuts.length && state.adds.length > 0
    // Budget-SOFTGATE (User-Ansage 06.08.): über dem Limit nur WARNEN,
    // Apply bleibt möglich. Unbekannte Preise blocken weiterhin hart —
    // ohne Preis ist keine Budget-Aussage möglich.
    const overLimit = gate && !gate.ok && gate.reason !== 'unknown-price'
    const gateAllows = gate != null && (gate.ok || overLimit)
    const gateHtml = gate
      ? gate.ok || overLimit
        ? `<div class="swap-budget-line"><span>Nach Apply:</span><span>${formatPrice(gate.total)} / ${formatPrice(gate.limit)}</span></div>
           <div class="swap-budget-bar"><div class="swap-budget-fill${overLimit ? ' swap-budget-over' : ''}" style="width:${Math.min(100, (gate.total / gate.limit) * 100)}%"></div></div>
           ${overLimit ? `<p class="wizard-line wizard-budget-warn">⚠ ${formatPrice(gate.total - gate.limit)} über dem ${formatPrice(gate.limit)}-Limit — erlaubt, aber bewusst entscheiden.</p>` : ''}`
        : `<p class="swap-error">Preis unbekannt: ${gate.cards.map(escapeHtml).join(', ')} — geblockt.</p>`
      : balanced ? '' : '<p class="wizard-line wizard-warn">Cuts und Adds müssen paarweise sein (Deck bleibt bei 100 Karten).</p>'

    return `
      ${rows}
      <div class="wizard-review-gate">${gateHtml}</div>
      <button class="btn wizard-apply" ${balanced && gateAllows && !state.applying ? '' : 'disabled'}>Übernehmen (${state.adds.length} Swaps)</button>
      <div id="wizard-apply-progress"></div>
    `
  }

  const stepStatus = (i) => {
    if (i === 0) return '✓'
    if (i === 1) return state.recommendations.length ? '⚠' : '✓'
    if (i === 2) return state.cutCandidates.length ? '·' : '✓'
    return state.adds.length || state.cuts.length ? String(Math.max(state.adds.length, state.cuts.length)) : '·'
  }

  const render = () => {
    const delta = state.adds.reduce((s, p) => s + (p.price ?? 0), 0) - state.cuts.reduce((s, p) => s + (p.price ?? 0), 0)
    const hasPicks = state.adds.length || state.cuts.length
    container.innerHTML = `
      <div class="wizard${state.applying ? ' wizard-busy' : ''}${hasPicks ? ' wizard-has-sticky' : ''}" data-step="${state.activeStep}">
        <nav class="wizard-rail" aria-label="Wizard-Schritte">
          ${STEPS.map((s, i) => `
            <button class="wizard-rail-item${i === state.activeStep ? ' active' : ''}" data-step="${i}">
              <span class="wizard-rail-status">${stepStatus(i)}</span> ${s}
            </button>`).join('')}
        </nav>
        <div class="wizard-mobile-progress">
          <span>Schritt ${state.activeStep + 1}/4 — ${STEPS[state.activeStep]}</span>
          <div class="wizard-progress-bar"><div style="width:${((state.activeStep + 1) / 4) * 100}%"></div></div>
        </div>
        <div class="wizard-sections">
          <section class="wizard-section" id="wizard-analyse" data-section="0">
            <h3>Analyse</h3>${analyseHtml()}
          </section>
          <section class="wizard-section" id="wizard-empfehlungen" data-section="1">
            <h3>Empfehlungen <span class="wizard-h-sub">[KONSENS]-Daten, kein Funktionsnachweis</span></h3>
            ${empfehlungenHtml()}
          </section>
          <section class="wizard-section" id="wizard-cuts" data-section="2">
            <h3>Cut-Kandidaten</h3>${cutsHtml()}${cutSearchHtml()}
          </section>
          <section class="wizard-section" id="wizard-review" data-section="3">
            <h3>Review & Apply</h3>${reviewHtml()}
          </section>
        </div>
        <div class="wizard-mobile-nav">
          <button class="btn btn-secondary wizard-prev" ${state.activeStep === 0 ? 'disabled' : ''}>Zurück</button>
          <button class="btn wizard-next" ${state.activeStep === 3 ? 'disabled' : ''}>Weiter</button>
        </div>
        ${hasPicks ? `
          <div class="wizard-sticky-bar">
            <span>${Math.max(state.adds.length, state.cuts.length)} Swaps · <span class="${delta >= 0 ? 'wizard-delta-plus' : 'wizard-delta-minus'}">Δ ${delta >= 0 ? '+' : '−'}${formatPrice(Math.abs(delta))}</span></span>
            <button class="btn-small wizard-goto-review anim-interactive">Review</button>
          </div>` : ''}
      </div>
    `
    wire()
    // Sticky-Bar-Höhe MESSEN statt raten: bei Umbruch (viele Swaps, große
    // Beträge) wächst die Bar — das padding-bottom wächst mit (Critic R2).
    const bar = container.querySelector('.wizard-sticky-bar')
    const wiz = container.querySelector('.wizard')
    if (bar && wiz && bar.offsetHeight) wiz.style.setProperty('--wizard-sticky-h', `${bar.offsetHeight}px`)
    // Jede Wizard-Interaktion baut den Container neu — fade statt Blinken
    refade(container)
  }

  const wire = () => {
    container.querySelectorAll('.wizard-rail-item, .wizard-goto-review').forEach(el => {
      el.addEventListener('click', () => {
        state.activeStep = el.classList.contains('wizard-goto-review') ? 3 : Number(el.dataset.step)
        render()
        // Desktop: zur Sektion scrollen (Rail = Anker)
        container.querySelector(`[data-section="${state.activeStep}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      })
    })
    container.querySelector('.wizard-prev')?.addEventListener('click', () => { state.activeStep = Math.max(0, state.activeStep - 1); render() })
    container.querySelector('.wizard-next')?.addEventListener('click', () => { state.activeStep = Math.min(3, state.activeStep + 1); render() })

    // Karten-Zoom (User-Ansage: Bilder + Preview): _cardPreview ist eine
    // Laufzeit-Property, KEIN HTML-Attribut — nach jedem innerHTML-Render
    // neu verdrahten (Critic R2 [HIGH]). Navigation/Swipe im Overlay läuft
    // über .card-row + data-preview-scope (card-preview.js previewRows).
    container.querySelectorAll('.wizard-cand').forEach(row => {
      const name = row.dataset.name
      const m = mediaFor(name)
      const imageUri = m?.normal || namedImageUrl(name)
      if (!imageUri) return
      const dfcInfo = m?.scryfallId ? { scryfallId: m.scryfallId } : null
      row._cardPreview = { imageUri, cardName: name, dfcInfo, bracketCat: null }
      row.querySelector('.wizard-cand-thumb')?.addEventListener('click', () => {
        showMobilePreview(imageUri, name, dfcInfo, null, row)
      })
    })

    container.querySelectorAll('.wizard-add-pick').forEach(btn => {
      btn.addEventListener('click', () => {
        const row = btn.closest('.wizard-cand')
        const gap = state.recommendations.find(g => g.role === row.dataset.role)
        const cand = gap?.candidates.find(c => c.name === row.dataset.name)
        if (cand && !state.adds.some(p => p.name === cand.name)) {
          state.adds.push({ name: cand.name, price: cand.price })
          render()
        }
      })
    })
    container.querySelectorAll('.wizard-cut-pick').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.closest('.wizard-cand').dataset.name
        const cand = state.cutCandidates.find(c => c.name === name)
        if (cand && !state.cuts.some(p => p.name === cand.name)) {
          state.cuts.push({ name: cand.name, price: cand.price })
          render()
        }
      })
    })
    container.querySelectorAll('.wizard-pair-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.idx)
        state.adds.splice(i, 1)
        state.cuts.splice(i, 1)
        render()
      })
    })

    // Tauschen-Suchfeld: beliebige Deck-Karte als Cut (mousedown statt click,
    // damit die Auswahl vor dem blur-Verstecken der Liste greift)
    const cutInput = container.querySelector('#wizard-cut-input')
    const cutList = container.querySelector('#wizard-cut-list')
    if (cutInput && cutList) {
      const commanderNames = new Set([deck.commander, deck.commander2].filter(Boolean).map(n => n.toLowerCase()))
      const refreshCutList = () => {
        const q = cutInput.value.trim().toLowerCase()
        if (q.length < 2) { cutList.hidden = true; cutList.innerHTML = ''; return }
        const hits = cards.filter(c =>
          c.name.toLowerCase().includes(q) &&
          !commanderNames.has(c.name.toLowerCase()) &&
          (c.quantity || 1) === 1 &&
          !state.cuts.some(p => p.name === c.name)
        ).slice(0, 8)
        cutList.innerHTML = hits.length
          ? hits.map(c => {
              const p = parseFloat(c.price_eur)
              return `<div class="autocomplete-item" data-name="${escapeHtml(c.name)}">${escapeHtml(c.name)}${!isNaN(p) ? ` <em>${formatPrice(p)}</em>` : ''}</div>`
            }).join('')
          : '<div class="autocomplete-item autocomplete-empty">Keine passende Karte — Commander und gestapelte Basics sind ausgenommen.</div>'
        cutList.hidden = false
        const pickCut = (name) => {
          const row = cards.find(c => c.name === name)
          const p = parseFloat(row?.price_eur)
          // Suchfeld-Cuts brauchen ihr Bild in Review/Zoom (Critic-Fund):
          // DB-Row liefert es, cardMedia kennt nur Heuristik-Kandidaten
          const key = name.toLowerCase()
          if (!cardMedia.has(key) && row?.image_uri) {
            cardMedia.set(key, { small: row.image_uri, normal: row.image_uri, scryfallId: null })
          }
          state.cuts.push({ name, price: isNaN(p) ? null : p })
          render()
        }
        cutList.querySelectorAll('.autocomplete-item[data-name]').forEach(el => {
          el.addEventListener('mousedown', (e) => {
            e.preventDefault()
            pickCut(el.dataset.name)
          })
        })
        cutList._pickCut = pickCut
      }
      cutInput.addEventListener('input', refreshCutList)
      // Tastatur-Navigation (Critic [HIGH]: ohne Pfeile/Enter/Escape ist das
      // Feld nicht per Tastatur bedienbar) — gleiches Muster wie autocomplete.js
      cutInput.addEventListener('keydown', (e) => {
        if (cutList.hidden) return
        const items = [...cutList.querySelectorAll('.autocomplete-item[data-name]')]
        if (!items.length) { if (e.key === 'Escape') { cutList.hidden = true } return }
        const active = cutList.querySelector('.autocomplete-item.active')
        let idx = items.indexOf(active)
        if (e.key === 'ArrowDown') { e.preventDefault(); idx = (idx + 1) % items.length }
        else if (e.key === 'ArrowUp') { e.preventDefault(); idx = idx <= 0 ? items.length - 1 : idx - 1 }
        else if (e.key === 'Enter') {
          e.preventDefault()
          if (active) cutList._pickCut?.(active.dataset.name)
          return
        } else if (e.key === 'Escape') { cutList.hidden = true; return }
        else return
        items.forEach(el => el.classList.remove('active'))
        items[idx].classList.add('active')
        items[idx].scrollIntoView({ block: 'nearest' })
      })
      cutInput.addEventListener('blur', () => { setTimeout(() => { cutList.hidden = true }, 150) })
    }

    container.querySelector('.wizard-apply')?.addEventListener('click', applyPicks)
  }

  async function applyPicks() {
    if (state.applying) return
    state.applying = true
    render()
    const progress = container.querySelector('#wizard-apply-progress')
    const log = (msg) => { progress.innerHTML += `<p class="wizard-line">${msg}</p>` }

    const cutNames = state.cuts.map(c => c.name)
    const addNames = state.adds.map(aP => aP.name)
    const commanders = [deck.commander, deck.commander2].filter(Boolean)

    // 1) Geteilte Preflight-Regeln (dieselbe Funktion wie apply.mjs)
    const errors = preflightSwapRules({ cards, commanders, cuts: cutNames, adds: addNames })
    if (errors.length) {
      log(`<span class="swap-error">${errors.map(escapeHtml).join('<br>')}</span>`)
      state.applying = false
      container.querySelector('.wizard-apply').disabled = false
      return
    }

    // 2) Budget-Gate mit FRISCHEN Preisen (apply.mjs-Parität)
    const freshPrices = await fetchCheapestPrices(addNames)
    const gate = budgetGate({
      currentCards: cards,
      cuts: cutNames,
      adds: addNames.map(n => ({ name: n, price: freshPrices.get(n)?.price ?? null })),
    })
    if (!gate.ok) {
      if (gate.reason === 'unknown-price') {
        log(`<span class="swap-error">Budget-Gate: Preis unbekannt für ${gate.cards.map(escapeHtml).join(', ')} — nichts geändert.</span>`)
        state.applying = false
        container.querySelector('.wizard-apply').disabled = false
        return
      }
      // Softgate (User-Ansage): über Limit nur warnen, Swaps laufen durch
      log(`<span class="wizard-budget-warn">⚠ Budget nach Apply: ${escapeHtml(formatPrice(gate.total))} — ${escapeHtml(formatPrice(gate.total - gate.limit))} über dem Limit.</span>`)
    }

    // 3) Pro Pick sequenziell: Row bauen → LIVE-Legalität prüfen → swapCard
    let done = 0
    const failed = []
    const failedIdx = new Set()
    const total = state.adds.length
    const fail = (i, msg) => { failed.push(msg); failedIdx.add(i) }
    for (let i = 0; i < state.adds.length; i++) {
      const add = state.adds[i]
      const cutCard = cards.find(c => c.name.toLowerCase() === state.cuts[i].name.toLowerCase())
      if (!cutCard) { fail(i, `${state.cuts[i].name}: nicht mehr im Deck`); continue }
      // Defense-in-depth zur cuts.js-Filterung: eine quantity>1-Row als
      // 1:1-Swap würde das Deck unter 100 Karten drücken
      if ((cutCard.quantity || 1) > 1) {
        fail(i, `${cutCard.name}: liegt ${cutCard.quantity}× im Deck — Mengen bitte im Karten-Tab pflegen`)
        continue
      }
      try {
        const row = await buildCardInsertRow(deck.id, add.name)
        if (!row) { fail(i, `${add.name}: Scryfall kennt die Karte nicht`); continue }
        if (row.commander_legality !== 'legal') {
          fail(i, `${add.name}: nicht commander-legal (${row.commander_legality}) — Banlist-Drift?`)
          continue
        }
        const result = await swapCard(
          { deckId: deck.id, cards, cutCard, addName: add.name },
          { buildRow: async () => row }
        )
        if (result.status === 'ok') {
          done++
          log(`✓ ${escapeHtml(cutCard.name)} → ${escapeHtml(add.name)}`)
        } else if (result.status === 'delete-failed') {
          fail(i, `${cutCard.name}: neue Karte ist drin, alte konnte nicht entfernt werden — DECK HAT +1 KARTE, bitte im Karten-Tab entfernen`)
        } else {
          fail(i, `${add.name}: ${result.status}`)
        }
      } catch (err) {
        fail(i, `${add.name}: ${err.message}`)
      }
    }

    log(`<strong>${done}/${total} Swaps ausgeführt.</strong>`)
    for (const f of failed) log(`<span class="swap-error">${escapeHtml(f)}</span>`)

    // Nur erfolgreiche Picks räumen — fehlgeschlagene bleiben im Review sichtbar
    state.adds = state.adds.filter((_, i) => failedIdx.has(i))
    state.cuts = state.cuts.filter((_, i) => failedIdx.has(i))
    state.applying = false
    onDeckChanged?.()

    if (failed.length === 0) {
      // Analyse auf dem neuen Stand neu rechnen — nur solange der Container lebt
      setTimeout(() => {
        if (container.isConnected) renderWizard({ container, deck, cards, onDeckChanged })
      }, 1200)
    } else {
      // KEIN Auto-Re-Render (Critic R2 [HIGH]): die Fehlermeldungen — teils mit
      // Handlungsauftrag ("+1 Karte entfernen") — müssen lesbar stehen bleiben
      const btn = document.createElement('button')
      btn.className = 'btn btn-secondary'
      btn.textContent = 'Analyse aktualisieren'
      btn.addEventListener('click', () => {
        if (container.isConnected) renderWizard({ container, deck, cards, onDeckChanged })
      })
      progress.appendChild(btn)
      container.querySelector('.wizard-apply')?.removeAttribute('disabled')
    }
  }

  render()

  // Goldfish-Sim automatisch (User-Ansage, ersetzt den Button): NACH dem
  // ersten Paint rechnen — rAF+Timeout hält das Dashboard responsiv, der
  // Skeleton-Platzhalter steht bis dahin. Ergebnis landet in state.goldfish.
  requestAnimationFrame(() => setTimeout(() => {
    if (!container.isConnected || state.goldfish) return
    state.goldfish = runGoldfish(state.enriched)
    render()
  }, 50))
}

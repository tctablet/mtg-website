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

import { escapeHtml, formatPrice } from '../utils.js'
import { fetchCheapestPrices } from '../supabase.js'
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
  const priceMap = candidateNames.length ? await fetchCheapestPrices(candidateNames) : new Map()
  const headroom = Math.max(0, BUDGET_LIMIT_EUR - state.analysis.budget.total)
  state.recommendations = buildGapRecommendations({
    gaps, poolCandidatesByRole, edhrecRecs, priceMap, headroom,
  })
  state.cutCandidates = buildCutCandidates({ analysis: state.analysis, enriched: state.enriched })

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
    <table class="card-table wizard-quota-table">
      <thead><tr><th>Kategorie</th><th class="th-num">Ist</th><th class="th-num">Soll</th><th></th></tr></thead>
      <tbody>
        ${a.quotas.map(q => `
          <tr class="${q.status !== 'ok' ? 'wizard-quota-bad' : ''}">
            <td>${escapeHtml(q.label)}</td>
            <td class="th-num">${q.have}</td>
            <td class="th-num">${q.min}–${q.max}</td>
            <td>${q.status === 'ok' ? '✓' : `⚠ ${q.status}`}</td>
          </tr>`).join('')}
      </tbody>
    </table>
    <p class="wizard-line">Manabase: ${a.manabase.landsHave} Länder · Karsten-Ziel ${a.manabase.landTarget} · Avg MV ${a.manabase.avgMV}</p>
    ${a.manabase.colorSources.filter(c => !c.ok).map(c =>
      `<p class="wizard-line wizard-warn">Farbquellen ${escapeHtml(c.color)}: ${c.sources}/${c.target ?? '—'} — zu wenig</p>`).join('')}
    <p class="wizard-line">Budget: <strong>${formatPrice(a.budget.total)}</strong> / ${formatPrice(a.budget.limit)}${a.budget.total > a.budget.limit ? ' <span class="wizard-warn">ÜBER LIMIT</span>' : ` · ${formatPrice(headroom)} frei`}</p>
    ${a.budget.missing.length ? `<p class="wizard-line wizard-warn">Preis unbekannt: ${a.budget.missing.map(escapeHtml).join(', ')}</p>` : ''}
    <p class="wizard-line">Bracket: ${escapeHtml(a.bracket.bracket)} · Interaktion ${a.interaction.count}/${a.interaction.nonland} nonland (davon ${a.interaction.instantSpeed} instant-speed)</p>
    ${a.audit.findings.length ? `<p class="wizard-line wizard-warn">Audit: ${a.audit.findings.map(f => escapeHtml(`${f.kind}${f.name ? `: ${f.name}` : ''}`)).join(' · ')}</p>` : ''}
    <button class="btn-small" id="wizard-goldfish">Goldfish-Sim (500 Läufe)</button>
    <div id="wizard-goldfish-result"></div>
  `

  const candidateRow = (c, gapRole) => `
    <div class="wizard-cand" data-name="${escapeHtml(c.name)}" data-role="${escapeHtml(gapRole)}">
      <div class="wizard-cand-main">
        <span class="wizard-cand-name">${escapeHtml(c.name)}${c.gameChanger ? ' <span class="wizard-gc" title="Game Changer">GC</span>' : ''}</span>
        <span class="wizard-cand-label">${escapeHtml(c.label)}</span>
      </div>
      <span class="wizard-cand-price${c.overHeadroom ? ' wizard-warn' : ''}">${c.price != null ? formatPrice(c.price) : 'Preis unbekannt'}</span>
      <button class="btn-small wizard-add-pick" ${state.adds.some(p => p.name === c.name) ? 'disabled' : ''}>+ Review</button>
    </div>
  `

  const empfehlungenHtml = () => state.recommendations.length
    ? state.recommendations.map(gap => `
        <div class="wizard-gap">
          <h4>${escapeHtml(gap.label)}: ${gap.have}/${gap.min}–${gap.max} <span class="wizard-warn">— ${gap.min - gap.have} fehlen</span></h4>
          ${gap.candidates.length
            ? gap.candidates.map(c => candidateRow(c, gap.role)).join('')
            : '<p class="wizard-line">Keine budget-/farbtauglichen Kandidaten im Pool.</p>'}
        </div>`).join('')
    : '<p class="wizard-line">Keine Quoten-Lücken — das Deck erfüllt das Command-Zone-Template. ✓</p>'

  const cutsHtml = () => state.cutCandidates.length
    ? state.cutCandidates.map(c => `
        <div class="wizard-cand" data-name="${escapeHtml(c.name)}">
          <div class="wizard-cand-main">
            <span class="wizard-cand-name">${escapeHtml(c.name)}</span>
            <span class="wizard-cand-label">${escapeHtml(c.reason)}</span>
          </div>
          <span class="wizard-cand-price">${c.price != null ? formatPrice(c.price) : '—'}</span>
          <button class="btn-small wizard-cut-pick" ${state.cuts.some(p => p.name === c.name) ? 'disabled' : ''}>− Review</button>
        </div>`).join('')
    : '<p class="wizard-line">Keine offensichtlichen Cut-Kandidaten gefunden.</p>'

  const reviewHtml = () => {
    const pairs = Math.max(state.adds.length, state.cuts.length)
    if (!pairs) return '<p class="wizard-line">Noch keine Picks — Empfehlungen und Cuts mit den Review-Buttons sammeln.</p>'
    const rows = Array.from({ length: pairs }, (_, i) => {
      const cut = state.cuts[i]
      const add = state.adds[i]
      return `
        <div class="wizard-pair">
          <span class="wizard-pair-cut">${cut ? `− ${escapeHtml(cut.name)} <em>${cut.price != null ? formatPrice(cut.price) : '—'}</em>` : '<span class="wizard-warn">Cut fehlt</span>'}</span>
          <span class="swap-pair-arrow">⇄</span>
          <span class="wizard-pair-add">${add ? `+ ${escapeHtml(add.name)} <em>${add.price != null ? formatPrice(add.price) : 'Preis unbekannt'}</em>` : '<span class="wizard-warn">Add fehlt</span>'}</span>
          <button class="btn-small wizard-pair-remove" data-idx="${i}">×</button>
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
    const gateHtml = gate
      ? gate.ok
        ? `<div class="swap-budget-line"><span>Nach Apply:</span><span>${formatPrice(gate.total)} / ${formatPrice(gate.limit)}</span></div>
           <div class="swap-budget-bar"><div class="swap-budget-fill" style="width:${Math.min(100, (gate.total / gate.limit) * 100)}%"></div></div>`
        : `<p class="swap-error">${gate.reason === 'unknown-price' ? `Preis unbekannt: ${gate.cards.map(escapeHtml).join(', ')} — geblockt.` : `Über dem ${formatPrice(gate.limit)}-Limit (${formatPrice(gate.total)}) — geblockt.`}</p>`
      : balanced ? '' : '<p class="wizard-line wizard-warn">Cuts und Adds müssen paarweise sein (Deck bleibt bei 100 Karten).</p>'

    return `
      ${rows}
      <div class="wizard-review-gate">${gateHtml}</div>
      <button class="btn wizard-apply" ${balanced && gate?.ok && !state.applying ? '' : 'disabled'}>Übernehmen (${state.adds.length} Swaps)</button>
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
    container.innerHTML = `
      <div class="wizard${state.applying ? ' wizard-busy' : ''}" data-step="${state.activeStep}">
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
            <h3>Cut-Kandidaten</h3>${cutsHtml()}
          </section>
          <section class="wizard-section" id="wizard-review" data-section="3">
            <h3>Review & Apply</h3>${reviewHtml()}
          </section>
        </div>
        <div class="wizard-mobile-nav">
          <button class="btn btn-secondary wizard-prev" ${state.activeStep === 0 ? 'disabled' : ''}>Zurück</button>
          <button class="btn wizard-next" ${state.activeStep === 3 ? 'disabled' : ''}>Weiter</button>
        </div>
        ${(state.adds.length || state.cuts.length) ? `
          <div class="wizard-sticky-bar">
            <span>${Math.max(state.adds.length, state.cuts.length)} Swaps · Δ ${delta >= 0 ? '+' : '−'}${formatPrice(Math.abs(delta))}</span>
            <button class="btn-small wizard-goto-review">Review</button>
          </div>` : ''}
      </div>
    `
    wire()
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

    container.querySelector('#wizard-goldfish')?.addEventListener('click', () => {
      const el = container.querySelector('#wizard-goldfish-result')
      el.innerHTML = '<p class="loading">Simuliere…</p>'
      // rAF, damit der Loading-State vor der CPU-Arbeit gemalt wird
      requestAnimationFrame(() => setTimeout(() => {
        const sim = runGoldfish(state.enriched)
        el.innerHTML = `<p class="wizard-line">Keep-Rate ${Math.round(sim.keepRate * 100)}% · Ø Länder T1–${sim.landsAvg.length}: ${sim.landsAvg.map(v => v.toFixed(1)).join(' → ')}${sim.clocks?.combat ? ` · Combat-Clock ~T${sim.clocks.combat}` : ''}</p>`
      }, 30))
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
      log(`<span class="swap-error">Budget-Gate: ${gate.reason === 'unknown-price' ? `Preis unbekannt für ${gate.cards.join(', ')}` : `${formatPrice(gate.total)} > ${formatPrice(gate.limit)}`} — nichts geändert.</span>`)
      state.applying = false
      container.querySelector('.wizard-apply').disabled = false
      return
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
}

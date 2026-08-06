// wizard/charts.js — pure Render-Helfer für das Analyse-Dashboard (testbar).
//
// Bau-Verträge (Plan Rev. 2, Critic R1/R2):
// - JEDES interpolierte Label läuft durch escapeHtml.
// - SVG nur mit viewBox + width:100% (CSS) — nie feste Pixel-Breite.
// - Info-SVGs tragen role="img" + aria-label; alle Werte stehen zusätzlich
//   als Text (Direct Labels), nie Farbe/Grafik allein.
// - Brüche 0..1 → pct(); null-Werte haben explizite Textpfade.
// - Mana-Pips (Mana-Font) IMMER im Inline-Kontext, kein eigener Flex-Container.

import { escapeHtml, formatPrice } from '../utils.js'

export const pct = (x) => Math.round((x ?? 0) * 100)

// CI-String ("WUB") oder Array → Mana-Font-Pips. Leer = farblos ({C}).
export function ciPips(ci) {
  const colors = typeof ci === 'string' ? [...ci] : (ci || [])
  if (!colors.length) return '<i class="ms ms-c ms-cost" title="farblos"></i>'
  return colors.map(c => `<i class="ms ms-${escapeHtml(String(c).toLowerCase())} ms-cost"></i>`).join('​')
}

// ---------- KPI-Zeile ----------

// Meter-Severity: fill trägt den Zustand (accent → amber → rot über Limit).
function budgetSeverity(total, limit) {
  if (total > limit) return 'over'
  if (total >= limit * 0.92) return 'warn'
  return 'ok'
}

export function kpiRow(a, headroom) {
  const b = a.budget
  const fillPct = Math.min(100, (b.total / b.limit) * 100)
  const sev = budgetSeverity(b.total, b.limit)
  const budgetSub = b.total > b.limit
    ? `<span class="wiz-bad">${escapeHtml(formatPrice(b.total - b.limit))} über Limit</span>`
    : `${escapeHtml(formatPrice(headroom))} frei`
  return `
    <div class="wiz-kpis">
      <div class="wiz-tile">
        <span class="wiz-tile-label">Budget</span>
        <span class="wiz-tile-value">${escapeHtml(formatPrice(b.total))}<em class="wiz-tile-of"> / ${escapeHtml(formatPrice(b.limit))}</em></span>
        <div class="wiz-meter wiz-meter-${sev}" role="img" aria-label="Budget ${escapeHtml(formatPrice(b.total))} von ${escapeHtml(formatPrice(b.limit))}">
          <div class="wiz-meter-fill" style="width:${fillPct}%"></div>
        </div>
        <span class="wiz-tile-sub">${budgetSub}</span>
      </div>
      <div class="wiz-tile">
        <span class="wiz-tile-label">Bracket</span>
        <span class="wiz-tile-value">${escapeHtml(a.bracket.bracket)}</span>
        <span class="wiz-tile-sub">${a.bracket.gameChangers.length} Game Changer</span>
      </div>
      <div class="wiz-tile">
        <span class="wiz-tile-label">Interaktion</span>
        <span class="wiz-tile-value">${a.interaction.count}<em class="wiz-tile-of"> Karten</em></span>
        <span class="wiz-tile-sub">${pct(a.interaction.density)}&nbsp;% der ${a.interaction.nonland} Nonland · ${a.interaction.instantSpeed} instant-speed</span>
      </div>
      <div class="wiz-tile">
        <span class="wiz-tile-label">Ø Manawert</span>
        <span class="wiz-tile-value">${escapeHtml(String(a.manabase.avgMV))}</span>
        <span class="wiz-tile-sub">Karsten-Ziel ${escapeHtml(String(a.manabase.landTarget))} Länder</span>
      </div>
    </div>
  `
}

// ---------- Quoten-Kacheln ----------
// Kachel-Icon-System statt Balkenlisten (User-Ansage 06.08.: per-Zeile
// skalierte Balken wirken verbuggt). Meter-Füllung = Ist/Soll-Obergrenze —
// alle Kacheln teilen dieselbe Semantik.

// Rollen-Icons: Mana-Font wo semantisch sauber, sonst schlichte Inline-SVGs
// (stroke: currentColor, erben die Textfarbe der Kachel).
const QUOTA_ICONS = {
  land: '<i class="ms ms-land" aria-hidden="true"></i>',
  ramp: '<i class="ms ms-c" aria-hidden="true"></i>',
  draw: '<svg class="wiz-qsvg" viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="8" height="11" rx="1.5"/><rect x="6" y="1.5" width="8" height="11" rx="1.5"/></svg>',
  removal: '<svg class="wiz-qsvg" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><line x1="8" y1="0.5" x2="8" y2="4"/><line x1="8" y1="12" x2="8" y2="15.5"/><line x1="0.5" y1="8" x2="4" y2="8"/><line x1="12" y1="8" x2="15.5" y2="8"/></svg>',
  wipe: '<svg class="wiz-qsvg" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.5 Q5 1.5 8 4.5 T14.5 4.5"/><path d="M1.5 8.5 Q5 5.5 8 8.5 T14.5 8.5"/><path d="M1.5 12.5 Q5 9.5 8 12.5 T14.5 12.5"/></svg>',
}

export function quotaBullets(quotas) {
  if (!quotas?.length) return ''
  const tiles = quotas.map(q => {
    const bad = q.status !== 'ok'
    const ratio = Math.min(100, (q.have / (q.max || 1)) * 100)
    const statusText = q.status === 'ok' ? '✓ im Soll' : q.status === 'unter' ? '⚠ unter Soll' : '⚠ über Soll'
    return `
      <div class="wiz-color-tile${bad ? ' wq-bad' : ''}" role="img"
        aria-label="${escapeHtml(q.label)}: ${q.have} von ${q.min} bis ${q.max} — ${escapeHtml(q.status)}">
        <span class="wiz-qlabel">${QUOTA_ICONS[q.role] || ''}${escapeHtml(q.label)}</span>
        <span class="wiz-color-nums">${q.have}<em> / ${q.min}–${q.max}</em></span>
        <div class="wiz-meter ${bad ? 'wiz-meter-warn' : 'wiz-meter-ok'}"><div class="wiz-meter-fill" style="width:${ratio}%"></div></div>
        <span class="wiz-color-status">${statusText}</span>
      </div>
    `
  }).join('')
  return `<div class="wiz-panel"><h4 class="wiz-panel-h">Deck-Quoten <span class="wiz-panel-sub">Ist vs. Command-Zone-Soll</span></h4><div class="wiz-color-grid">${tiles}</div></div>`
}

// ---------- Manakurve ----------

export function computeManaCurve(enriched) {
  const bins = [0, 0, 0, 0, 0, 0, 0, 0] // CMC 0..6, 7+
  for (const e of enriched) {
    if (e.roles.includes('land')) continue
    const cmc = Math.max(0, Math.round(e.effective?.cmc ?? 0))
    bins[Math.min(cmc, 7)] += e.quantity || 1
  }
  return bins
}

// Säulen mit 4px gerundeter Datenkante, Baseline eckig (Mark-Spec).
function roundedColumn(x, y, w, h, r) {
  if (h <= 0) return ''
  const rr = Math.min(r, h, w / 2)
  return `M${x},${y + h} L${x},${y + rr} Q${x},${y} ${x + rr},${y} L${x + w - rr},${y} Q${x + w},${y} ${x + w},${y + rr} L${x + w},${y + h} Z`
}

export function manaCurveChart(enriched, avgMV) {
  const bins = computeManaCurve(enriched)
  const maxCount = Math.max(...bins, 1)
  const W = 320, plotH = 96, axisH = 16, labelH = 12
  const H = plotH + axisH + labelH
  const slot = W / bins.length
  const barW = Math.min(24, slot - 8)
  const cols = bins.map((count, i) => {
    const h = (count / maxCount) * (plotH - 4)
    const x = i * slot + (slot - barW) / 2
    const y = labelH + (plotH - h)
    const label = count > 0
      ? `<text class="wc-count" x="${i * slot + slot / 2}" y="${y - 3}" text-anchor="middle">${count}</text>`
      : ''
    return `<path class="wc-col" d="${roundedColumn(x, y, barW, h, 4)}"/>${label}`
  }).join('')
  const ticks = bins.map((_, i) =>
    `<text class="wc-tick" x="${i * slot + slot / 2}" y="${H - 3}" text-anchor="middle">${i === 7 ? '7+' : i}</text>`
  ).join('')
  // Ø-MV-Marker: Position auf der CMC-Achse (Slot-Mitte = ganzzahliger CMC)
  const avg = Math.min(7.4, Math.max(0, avgMV ?? 0))
  const avgX = avg * slot + slot / 2
  const marker = `
    <line class="wc-avg" x1="${avgX}" y1="${labelH}" x2="${avgX}" y2="${labelH + plotH}"/>
    <text class="wc-avg-label" x="${avgX + 4}" y="${labelH + 9}">Ø ${escapeHtml(String(avgMV))}</text>
  `
  const total = bins.reduce((s, c) => s + c, 0)
  return `
    <div class="wiz-panel">
      <h4 class="wiz-panel-h">Manakurve <span class="wiz-panel-sub">${total} Nonland-Karten</span></h4>
      <svg class="wiz-svg" viewBox="0 0 ${W} ${H}" role="img"
        aria-label="Manakurve: ${bins.map((c, i) => `${i === 7 ? '7 plus' : i} Mana: ${c}`).join(', ')}, Durchschnitt ${escapeHtml(String(avgMV))}">
        <line class="wc-base" x1="0" y1="${labelH + plotH}" x2="${W}" y2="${labelH + plotH}"/>
        ${cols}${marker}${ticks}
      </svg>
    </div>
  `
}

// ---------- Farbquellen ----------

// Kacheln statt Balkenliste (User-Ansage 06.08.: per-Zeile skalierte Balken
// wirken "unterschiedlich lang" und unclean). Meter-Füllung = sources/target,
// damit alle Kacheln DIESELBE Skala teilen (vergleichbar).
export function colorSourcesPanel(colorSources) {
  if (!colorSources?.length) return '' // farblos/Eldrazi: Panel entfällt
  const tiles = colorSources.map(c => {
    const target = c.target ?? 0
    const ratio = target ? Math.min(100, (c.sources / target) * 100) : 100
    return `
      <div class="wiz-color-tile${c.ok ? '' : ' wq-bad'}" role="img"
        aria-label="Farbquellen ${escapeHtml(c.color)}: ${c.sources}${target ? ` von ${target} empfohlenen` : ''} — ${c.ok ? 'ausreichend' : 'zu wenig'}">
        <span class="wiz-color-pip">${ciPips(c.color)}</span>
        <span class="wiz-color-nums">${c.sources}<em>${target ? ` / ${target}` : ''}</em></span>
        <div class="wiz-meter ${c.ok ? 'wiz-meter-ok' : 'wiz-meter-warn'}"><div class="wiz-meter-fill" style="width:${ratio}%"></div></div>
        <span class="wiz-color-status">${c.ok ? '✓ ausreichend' : '⚠ zu wenig'}</span>
        ${c.driver && target ? `<span class="wiz-color-driver" title="Diese Karte fordert die meisten frühen ${escapeHtml(c.color)}-Pips und setzt damit den Richtwert">für ${escapeHtml(c.driver)}</span>` : ''}
      </div>
    `
  }).join('')
  return `
    <div class="wiz-panel">
      <h4 class="wiz-panel-h">Farbquellen <span class="wiz-panel-sub">Empfehlung nach Karsten: Quellen, um die anspruchsvollste Karte der Farbe zuverlässig on-curve zu casten</span></h4>
      <div class="wiz-color-grid">${tiles}</div>
    </div>
  `
}

// ---------- Konsistenz (Hypergeometrie) ----------

export function hypergeoPanel(hypergeo) {
  const entries = Object.entries(hypergeo || {})
  if (!entries.length) return ''
  const tiles = entries.map(([label, p]) => {
    // "P(≥3 Länder bis T3)" → "≥3 Länder bis Zug 3" (lesbares Kachel-Label)
    const readable = label.replace(/^P\(/, '').replace(/\)$/, '').replace(/\bT(\d)/, 'Zug $1')
    return `
    <div class="wiz-color-tile" role="img" aria-label="${escapeHtml(readable)}: ${pct(p)} Prozent">
      <span class="wiz-qlabel">${escapeHtml(readable)}</span>
      <span class="wiz-color-nums">${pct(p)}<em> %</em></span>
      <div class="wiz-meter wiz-meter-ok"><div class="wiz-meter-fill" style="width:${pct(p)}%"></div></div>
    </div>
  `
  }).join('')
  return `<div class="wiz-panel"><h4 class="wiz-panel-h">Konsistenz <span class="wiz-panel-sub">Ziehwahrscheinlichkeiten (Hypergeometrie)</span></h4><div class="wiz-color-grid">${tiles}</div></div>`
}

// ---------- Kostentreiber ----------

// imageFor: optionaler Resolver name → Bild-URL (Deck-Rows haben image_uri) —
// die Karte selbst ist das Icon der Kachel.
export function costDriversPanel(top, imageFor = null) {
  if (!top?.length) return ''
  const tiles = top.map(t => {
    const img = imageFor?.(t.name)
    return `
    <div class="wiz-color-tile wiz-cost-tile" role="img" aria-label="${escapeHtml(t.name)}: ${escapeHtml(formatPrice(t.eur))}">
      ${img ? `<img class="wiz-cost-thumb" src="${escapeHtml(img)}" alt="" loading="lazy" />` : ''}
      <span class="wiz-color-nums">${escapeHtml(formatPrice(t.eur))}</span>
      <span class="wiz-color-driver" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span>
    </div>
  `
  }).join('')
  return `<div class="wiz-panel"><h4 class="wiz-panel-h">Kostentreiber <span class="wiz-panel-sub">teuerste Karten im Deck</span></h4><div class="wiz-color-grid">${tiles}</div></div>`
}

// ---------- Goldfish-Sim ----------

function clockLine(label, clock, iterations) {
  if (!clock || clock.median == null || !clock.hitRate) {
    return `<p class="wiz-line">${escapeHtml(label)}: kein Kill innerhalb von 10 Zügen (${iterations} Läufe)</p>`
  }
  // ceiling/median beziehen sich NUR auf Läufe mit Kill (percentile filtert
  // nulls) — das Label sagt das ehrlich dazu.
  return `<p class="wiz-line">${escapeHtml(label)}: ~Zug ${clock.median} · schnellste Läufe ab Zug ${clock.ceiling} · erreicht in ${pct(clock.hitRate)}&nbsp;% der Läufe</p>`
}

export function goldfishPanel(sim) {
  const W = 320, plotH = 100, axisH = 16, padT = 10, padR = 34
  const H = padT + plotH + axisH
  const turns = sim.landsAvg.length
  const maxY = Math.max(...sim.landsAvg, ...sim.manaAvg, 1)
  const xFor = (i) => 10 + (i * (W - padR - 20)) / (turns - 1)
  const yFor = (v) => padT + plotH - (v / maxY) * plotH
  const line = (vals, cls) => {
    const pts = vals.map((v, i) => `${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`).join(' ')
    const end = vals[vals.length - 1]
    return `
      <polyline class="wg-line ${cls}" points="${pts}"/>
      ${vals.map((v, i) => `<circle class="wg-dot ${cls}" cx="${xFor(i).toFixed(1)}" cy="${yFor(v).toFixed(1)}" r="4"/>`).join('')}
      <text class="wg-end" x="${xFor(turns - 1) + 7}" y="${yFor(end) + 3}">${end.toFixed(1)}</text>
    `
  }
  const ticks = Array.from({ length: turns }, (_, i) =>
    `<text class="wc-tick" x="${xFor(i)}" y="${H - 2}" text-anchor="middle">T${i + 1}</text>`).join('')
  return `
    <div class="wiz-goldfish anim-enter">
      <div class="wiz-kpis wiz-kpis-sim">
        <div class="wiz-tile">
          <span class="wiz-tile-label">Keep-Rate</span>
          <span class="wiz-tile-value">${pct(sim.keepRate)}<em class="wiz-tile-of"> %</em></span>
          <span class="wiz-tile-sub">${sim.iterations} Läufe, 7-Karten-Hände</span>
        </div>
        <div class="wiz-tile">
          <span class="wiz-tile-label">Mana-Entwicklung</span>
          <span class="wiz-tile-sub">Ø über ${sim.iterations} Läufe, Zug 1–${turns}</span>
          <svg class="wiz-svg" viewBox="0 0 ${W} ${H}" role="img"
            aria-label="Ø Länder Zug 1 bis ${turns}: ${sim.landsAvg.map(v => v.toFixed(1)).join(', ')}. Ø verfügbares Mana: ${sim.manaAvg.map(v => v.toFixed(1)).join(', ')}">
            <line class="wc-base" x1="0" y1="${padT + plotH}" x2="${W}" y2="${padT + plotH}"/>
            ${line(sim.manaAvg, 'wg-mana')}
            ${line(sim.landsAvg, 'wg-lands')}
            ${ticks}
          </svg>
          <div class="wg-legend">
            <span class="wg-key"><i class="wg-swatch wg-lands"></i>Länder</span>
            <span class="wg-key"><i class="wg-swatch wg-mana"></i>verfügbares Mana</span>
          </div>
        </div>
      </div>
      ${clockLine('Combat-Clock', sim.clocks?.combat, sim.iterations)}
      ${sim.clocks?.mill?.hitRate ? clockLine('Mill-Clock', sim.clocks.mill, sim.iterations) : ''}
    </div>
  `
}

// ---------- Audit-/Warn-Card ----------

// Audit-Findings in Klartext (User-Ansage 06.08.: keine rohen kind-Codes in
// der UI — bei ALLEN Typen). Unbekannte Kinds fallen lesbar zurück.
const AUDIT_TEXT = {
  'commander-not-found': (f) => `Commander „${f.name}" ist bei Scryfall nicht auffindbar — Schreibweise prüfen.`,
  'ci-check-skipped': (f) => f.detail || 'Color-Identity-Prüfung übersprungen — Commander nicht auflösbar.',
  'not-in-pool': (f) => `„${f.name}" fehlt im Kandidaten-Pool — Rollen und Daten dieser Karte sind unvollständig.`,
  'banned': (f) => `„${f.name}" ist im Commander gebannt.`,
  'preview-not-yet-legal': (f) => `„${f.name}" ist noch nicht erschienen${f.detail ? ` (${f.detail})` : ''} und darum noch nicht legal.`,
  'not-legal': (f) => `„${f.name}" ist im Commander nicht legal${f.detail ? ` (Status: ${f.detail})` : ''}.`,
  'singleton-violation': (f) => `„${f.name}" liegt ${f.detail ? `${f.detail} ` : 'mehrfach '}im Deck — Singleton-Regel verletzt.`,
  'color-identity': (f) => `„${f.name}" passt nicht zur Farbidentität des Commanders${f.detail ? ` (${f.detail})` : ''}.`,
  'card-count': (f) => `Das Deck hat ${f.detail || 'nicht genau 100 Karten'}.`,
}

export function auditText(f) {
  const fmt = AUDIT_TEXT[f?.kind]
  if (fmt) return fmt(f)
  return `${f?.kind ?? 'Audit-Hinweis'}${f?.name ? `: ${f.name}` : ''}${f?.detail ? ` (${f.detail})` : ''}`
}

export function warnCard(items) {
  const list = (items || []).filter(Boolean)
  if (!list.length) return ''
  return `
    <div class="wiz-warncard" role="note">
      ${list.map(w => `<p class="wiz-line">⚠ ${escapeHtml(w)}</p>`).join('')}
    </div>
  `
}

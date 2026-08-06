import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pct, ciPips, computeManaCurve, manaCurveChart, quotaBullets,
  colorSourcesPanel, hypergeoPanel, costDriversPanel, goldfishPanel,
  kpiRow, warnCard, auditText,
} from '../src/wizard/charts.js'

const enrichedCard = (cmc, { land = false, quantity = 1 } = {}) => ({
  effective: { cmc },
  roles: land ? ['land'] : [],
  quantity,
})

test('charts: pct rundet Brüche 0..1 korrekt (Critic R1: hitRate/hypergeo sind Brüche)', () => {
  assert.equal(pct(0.412), 41)
  assert.equal(pct(0.935), 94)
  assert.equal(pct(0), 0)
  assert.equal(pct(null), 0)
})

test('charts: ciPips — WUBRG-String, Array, farblos', () => {
  assert.match(ciPips('WU'), /ms-w/)
  assert.match(ciPips('WU'), /ms-u/)
  assert.match(ciPips(['B', 'R']), /ms-b/)
  assert.match(ciPips(''), /ms-c/, 'leere CI = farblos-Pip')
  assert.match(ciPips(null), /ms-c/)
})

test('charts: computeManaCurve — Länder raus, quantity gewichtet, 7+-Bin', () => {
  const bins = computeManaCurve([
    enrichedCard(0, { land: true, quantity: 30 }),
    enrichedCard(1),
    enrichedCard(2, { quantity: 3 }),
    enrichedCard(9),
    enrichedCard(12),
  ])
  assert.equal(bins[0], 0, 'Länder zählen nicht in die Kurve')
  assert.equal(bins[1], 1)
  assert.equal(bins[2], 3, 'quantity-gewichtet')
  assert.equal(bins[7], 2, 'CMC ≥7 landet im 7+-Bin')
})

test('charts: manaCurveChart — responsive SVG (viewBox, kein width-Attribut) + A11y', () => {
  const html = manaCurveChart([enrichedCard(2)], 2.0)
  assert.match(html, /viewBox=/)
  assert.ok(!/\bwidth="\d/.test(html), 'keine feste Pixel-Breite am SVG (Critic R1)')
  assert.match(html, /role="img"/)
  assert.match(html, /aria-label=/)
})

test('charts: quotaBullets — Status-Klasse + Escaping', () => {
  const html = quotaBullets([
    { label: 'Länder <b>x</b>', have: 34, min: 36, max: 38, status: 'unter' },
    { label: 'Card Draw', have: 11, min: 10, max: 12, status: 'ok' },
  ])
  assert.match(html, /wq-bad/, 'unter → wq-bad')
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/, 'Label wird escaped')
  assert.ok(!html.includes('<b>x</b>'), 'kein rohes HTML aus Labels')
})

test('charts: colorSourcesPanel — Empty-State (farbloses Deck) → leer', () => {
  assert.equal(colorSourcesPanel([]), '')
  assert.equal(colorSourcesPanel(null), '')
  const html = colorSourcesPanel([{ color: 'U', sources: 24, target: 29, ok: false }])
  assert.match(html, /ms-u/, 'Mana-Symbol trägt die Farb-Identität')
  assert.match(html, /zu wenig/)
})

test('charts: hypergeoPanel wandelt 0..1 in Prozent', () => {
  const html = hypergeoPanel({ 'P(≥3 Länder bis T3)': 0.87 })
  assert.match(html, />87</, '0.87 → 87 %')
  assert.ok(!html.includes('>0.87<'))
})

test('charts: costDriversPanel escaped Kartennamen (Kongming-Klasse)', () => {
  const html = costDriversPanel([{ name: 'Kongming, "Sleeping Dragon" <img>', eur: 12.5 }])
  assert.ok(!html.includes('<img>'), 'kein rohes HTML aus Kartennamen')
  assert.match(html, /&lt;img&gt;/)
})

test('charts: goldfishPanel — Null-Clock (Control-Deck) rendert Text statt "~Tnull"', () => {
  const sim = {
    iterations: 500, keepRate: 0.93,
    landsAvg: [1.0, 2.0, 2.9, 3.8, 4.4, 5.0],
    manaAvg: [1.1, 2.2, 3.2, 4.3, 5.1, 6.0],
    clocks: {
      combat: { median: null, ceiling: null, hitRate: 0 },
      mill: { median: null, ceiling: null, hitRate: 0 },
    },
  }
  const html = goldfishPanel(sim)
  assert.ok(!html.includes('null'), 'kein null-Leak (der [object Object]-Nachfolger)')
  assert.match(html, /kein Kill innerhalb von 10 Zügen/)
  assert.ok(!html.includes('Mill-Clock'), 'Mill nur bei hitRate > 0')
  assert.match(html, />93</, 'keepRate 0.93 → 93 %')
})

test('charts: goldfishPanel — echte Clock formatiert Median/Ceiling/HitRate', () => {
  const sim = {
    iterations: 500, keepRate: 1,
    landsAvg: [1, 2, 3, 4, 5, 6], manaAvg: [1, 2, 3, 4, 5, 6],
    clocks: { combat: { median: 8, ceiling: 6, hitRate: 0.41 }, mill: { median: null, ceiling: null, hitRate: 0 } },
  }
  const html = goldfishPanel(sim)
  assert.match(html, /~Zug 8/)
  assert.match(html, /ab Zug 6/)
  assert.match(html, /41&nbsp;%/, 'hitRate 0.41 → 41 %')
})

test('charts: kpiRow — Über-Limit-Zustand + Meter-Severity', () => {
  const a = {
    budget: { total: 512.4, limit: 500, missing: [], top: [] },
    bracket: { bracket: '4–5 (6 GC)', gameChangers: [1, 2, 3, 4, 5, 6] },
    interaction: { count: 11, nonland: 66, instantSpeed: 7 },
    manabase: { avgMV: 4.03, landTarget: 35.9 },
  }
  const html = kpiRow(a, 0)
  assert.match(html, /wiz-meter-over/)
  assert.match(html, /über Limit/)
  const ok = kpiRow({ ...a, budget: { ...a.budget, total: 470.91 } }, 29.09)
  assert.match(ok, /wiz-meter-warn/, '470,91/500 = 94% → warn-Severity')
  assert.match(ok, /frei/)
})

test('charts: auditText — ALLE kind-Codes werden Klartext (User-Ansage 06.08.)', () => {
  // Jeder bekannte Typ liefert deutschen Klartext ohne den rohen kind-Code.
  const cases = [
    [{ kind: 'banned', name: 'Dockside Extortionist' }, /gebannt/],
    [{ kind: 'not-legal', name: 'X', detail: 'not_legal' }, /nicht legal/],
    [{ kind: 'singleton-violation', name: 'Sol Ring', detail: '2x' }, /Singleton/],
    [{ kind: 'color-identity', name: 'Y' }, /Farbidentität/],
    [{ kind: 'card-count', detail: '99 statt 100' }, /99 statt 100/],
    [{ kind: 'not-in-pool', name: 'Z' }, /Kandidaten-Pool/],
    [{ kind: 'commander-not-found', name: 'C' }, /Scryfall/],
    [{ kind: 'preview-not-yet-legal', name: 'P', detail: 'Release 2027-01-01' }, /noch nicht erschienen/],
    [{ kind: 'ci-check-skipped', detail: 'Commander nicht auflösbar — Prüfung übersprungen' }, /übersprungen/],
  ]
  for (const [f, re] of cases) {
    const text = auditText(f)
    assert.match(text, re, `${f.kind} → "${text}"`)
    assert.ok(!text.startsWith(f.kind), `kein roher kind-Code: ${text}`)
  }
  // Unbekannter Typ fällt lesbar zurück statt zu crashen.
  assert.match(auditText({ kind: 'future-kind', name: 'N' }), /future-kind: N/)
})

test('charts: warnCard escaped Findings und ist bei leerer Liste leer', () => {
  assert.equal(warnCard([]), '')
  assert.equal(warnCard(null), '')
  assert.match(warnCard(['Audit: banned: <script>']), /&lt;script&gt;/)
})

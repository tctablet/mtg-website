// deck-stats.js — Sidebar-Statistiken einer Deck-Ansicht (Manakurve, Bracket,
// Legalität). Aus deck-view.js extrahiert: der Commander-Scan rendert das
// Average-Deck in exakt derselben Ansicht und braucht dieselben Stats.
// Erwartet Karten mit { name, quantity, cmc, type_category, commander_legality? }
// und ein #deck-stats-Element im DOM.

import { estimateBracket } from '../bracket.js'

export function renderDeckStats(cards) {
  const el = document.getElementById('deck-stats')
  if (!el) return

  // Mana curve (exclude lands)
  const cmcBuckets = {}
  let maxCount = 0
  for (const c of cards) {
    if (c.type_category === 'land') continue
    const cmc = Math.min(c.cmc || 0, 7) // 7+ grouped
    const label = cmc >= 7 ? '7+' : String(cmc)
    cmcBuckets[label] = (cmcBuckets[label] || 0) + c.quantity
    if (cmcBuckets[label] > maxCount) maxCount = cmcBuckets[label]
  }

  const bucketLabels = ['0', '1', '2', '3', '4', '5', '6', '7+']
  const curveHtml = bucketLabels.map(label => {
    const count = cmcBuckets[label] || 0
    const pct = maxCount > 0 ? (count / maxCount) * 100 : 0
    return `
      <div class="curve-col">
        <span class="curve-count">${count || ''}</span>
        <div class="curve-bar-wrap"><div class="curve-bar" style="height:${pct}%"></div></div>
        <span class="curve-label">${label}</span>
      </div>
    `
  }).join('')

  // Average CMC (exclude lands)
  const nonLands = cards.filter(c => c.type_category !== 'land')
  const totalCmc = nonLands.reduce((s, c) => s + (c.cmc || 0) * c.quantity, 0)
  const totalNonLand = nonLands.reduce((s, c) => s + c.quantity, 0)
  const avgCmc = totalNonLand > 0 ? (totalCmc / totalNonLand).toFixed(1) : '0'

  // Bracket estimation
  const bracket = estimateBracket(cards)
  const bracketDots = [1, 2, 3, 4, 5].map(i =>
    `<span class="bracket-dot ${i <= bracket.bracket ? 'bracket-dot-active' : ''}">${i}</span>`
  ).join('')

  const gcHtml = bracket.gameChangerCount > 0
    ? `<div class="bracket-detail bracket-detail-gc">${bracket.gameChangerCount} Game Changer${bracket.gameChangerCount > 1 ? '' : ''}</div>`
    : ''
  const tutorHtml = bracket.tutorCount > 0
    ? `<div class="bracket-detail bracket-detail-tutor">${bracket.tutorCount} Tutors</div>`
    : ''
  const flagsHtml = [
    bracket.hasExtraTurns ? '<div class="bracket-detail bracket-detail-extra">Extra Turns</div>' : '',
    bracket.hasMLD ? '<div class="bracket-detail bracket-detail-mld">MLD</div>' : '',
  ].filter(Boolean).join('')

  // Legality check
  const illegalCards = cards.filter(c => c.commander_legality && c.commander_legality !== 'legal')
  const bannedCards = illegalCards.filter(c => c.commander_legality === 'banned')
  const notLegalCards = illegalCards.filter(c => c.commander_legality === 'not_legal')
  const restrictedCards = illegalCards.filter(c => c.commander_legality === 'restricted')

  let legalityHtml = ''
  if (illegalCards.length > 0) {
    const items = []
    if (bannedCards.length > 0) items.push(`<span class="legality-stat-banned">${bannedCards.length} banned</span>`)
    if (notLegalCards.length > 0) items.push(`<span class="legality-stat-notlegal">${notLegalCards.length} not legal</span>`)
    if (restrictedCards.length > 0) items.push(`<span class="legality-stat-restricted">${restrictedCards.length} restricted</span>`)

    legalityHtml = `
    <div class="stat-section">
      <div class="stat-header">Legalität</div>
      <div class="legality-warning">
        <span class="legality-warning-icon">⚠</span>
        <span>${illegalCards.length} Karte${illegalCards.length > 1 ? 'n' : ''} nicht legal</span>
      </div>
      <div class="legality-breakdown">${items.join(' · ')}</div>
      <div class="legality-card-list">
        ${illegalCards.map(c => `<div class="legality-card-item">${c.name}</div>`).join('')}
      </div>
    </div>`
  } else {
    legalityHtml = `
    <div class="stat-section">
      <div class="stat-header">Legalität</div>
      <div class="legality-ok">✓ Commander-legal</div>
    </div>`
  }

  el.innerHTML = `
    <div class="stat-section">
      <div class="stat-header">Manakurve <span class="stat-hint">⌀ ${avgCmc}</span></div>
      <div class="mana-curve">${curveHtml}</div>
    </div>
    <div class="stat-section">
      <div class="stat-header">Bracket</div>
      <div class="bracket-display">
        <div class="bracket-dots">${bracketDots}</div>
        <span class="bracket-label">${bracket.label}</span>
      </div>
      <div class="bracket-details">
        ${gcHtml}${tutorHtml}${flagsHtml}
      </div>
    </div>
    ${legalityHtml}
  `
}

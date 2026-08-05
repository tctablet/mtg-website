// validate.mjs — Format-Validierung gegen den Kartenpool (pure, testbar).
//
// Zwei Modi mit bewusst unterschiedlicher Härte (Critic-Finding Runde 2):
//   auditDeck():        Report-Modus — flaggt, bricht NIE ab. Auch eine Karte,
//                       die im Pool fehlt oder illegal ist, wird als Finding
//                       gelistet, die Analyse der restlichen 99 läuft weiter.
//   validateCandidate(): Gate-Modus — harter Fehler bei Pool-Miss (Anti-
//                       Halluzination), Illegalität oder CI-Verstoß.

// pool-core statt cardpool: hält validate.mjs frei von node:fs (Browser-Import
// durch den Wizard — cardpool re-exportiert dieselben Funktionen für CLIs)
import { lookupCard, isCandidate, ciSubset } from './pool-core.mjs'
import { allowsMultiples } from './roles.mjs'

// ci === null heißt: mindestens ein Commander war nicht auflösbar — die CI ist
// UNBEKANNT (nicht "farblos"!). ci === [] ist dagegen ein valider farbloser
// Commander (z.B. Kozilek). Diese Unterscheidung trägt den ganzen Gate-Pfad:
// null → Gate blockt, [] → nur farblose Karten erlaubt (Critic-BLOCKER M1/M2).
export function commanderColorIdentity(index, commanderNames) {
  const ci = new Set()
  const missing = []
  for (const name of commanderNames.filter(Boolean)) {
    const rec = lookupCard(index, name)
    if (!rec) { missing.push(name); continue }
    for (const c of rec.color_identity) ci.add(c)
  }
  return { ci: missing.length > 0 ? null : [...ci], missing }
}

// cards: Deck-Rows ({ name, quantity }); commanderNames: [deck.commander, deck.commander2]
export function auditDeck({ cards, commanderNames, index }) {
  const findings = []
  const givenCommanders = commanderNames.filter(Boolean)
  const { ci: deckCI, missing: cmdrMissing } = commanderColorIdentity(index, givenCommanders)
  for (const name of cmdrMissing) {
    findings.push({ level: 'error', kind: 'commander-not-found', name })
  }
  // Ohne auflösbare Commander-CI kann die Farbprüfung nicht laufen — das darf
  // NIE still passieren: lauter eigener Finding statt leisem Skip.
  const ciCheckActive = givenCommanders.length > 0 && deckCI !== null
  if (givenCommanders.length > 0 && !ciCheckActive) {
    findings.push({
      level: 'warn',
      kind: 'ci-check-skipped',
      detail: 'Commander nicht auflösbar — Color-Identity-Prüfung für das Deck übersprungen',
    })
  }

  let totalCards = 0
  for (const row of cards) {
    const q = row.quantity ?? 1
    totalCards += q
    const rec = lookupCard(index, row.name)
    if (!rec) {
      findings.push({ level: 'warn', kind: 'not-in-pool', name: row.name })
      continue
    }
    if (rec.legal === 'banned') {
      findings.push({ level: 'error', kind: 'banned', name: row.name })
    } else if (rec.legal !== 'legal') {
      // Preview-Karten kommender Sets sind bis zum Release not_legal — das ist
      // beim Proxy-Spielen der Runde kein Fehler, nur ein Hinweis.
      const future = rec.released_at && Date.parse(rec.released_at) > Date.now()
      findings.push(future
        ? { level: 'info', kind: 'preview-not-yet-legal', name: row.name, detail: `Release ${rec.released_at}` }
        : { level: 'error', kind: 'not-legal', name: row.name, detail: rec.legal })
    }
    if (q > 1 && !allowsMultiples(rec)) {
      findings.push({ level: 'error', kind: 'singleton-violation', name: row.name, detail: `${q}x` })
    }
    if (ciCheckActive && !ciSubset(rec.color_identity, deckCI)) {
      findings.push({
        level: 'error',
        kind: 'color-identity',
        name: row.name,
        detail: `${rec.color_identity.join('')} ⊄ ${deckCI.join('') || 'farblos'}`,
      })
    }
  }

  if (totalCards !== 100) {
    findings.push({ level: 'warn', kind: 'card-count', detail: `${totalCards} statt 100` })
  }

  return { findings, deckCI, totalCards }
}

// Gate: wirft nicht, gibt aber ok:false mit hartem Grund zurück — der Aufrufer
// (Skill/apply) DARF bei ok:false unter keinen Umständen weitermachen.
// deckCI muss ein Array sein ([] = valider farbloser Commander). null/undefined
// (Commander-CI unbekannt) blockt hart, statt Off-Color-Karten durchzuwinken.
export function validateCandidate({ name, index, deckCI, existingNames }) {
  if (!Array.isArray(deckCI)) {
    return { ok: false, reason: 'no-deck-ci (Commander-Color-Identity unbekannt)', name }
  }
  const rec = lookupCard(index, name)
  if (!rec) {
    return { ok: false, reason: 'not-in-pool', name }
  }
  if (!isCandidate(rec)) {
    return { ok: false, reason: rec.legal !== 'legal' ? `not-legal (${rec.legal})` : 'not-paper', name }
  }
  if (!ciSubset(rec.color_identity, deckCI)) {
    return { ok: false, reason: `color-identity (${rec.color_identity.join('') || 'C'} ⊄ ${deckCI.join('') || 'farblos'})`, name }
  }
  const lower = rec.name.toLowerCase()
  if (existingNames?.some(n => n.toLowerCase() === lower) && !allowsMultiples(rec)) {
    return { ok: false, reason: 'duplicate', name }
  }
  return { ok: true, record: rec }
}

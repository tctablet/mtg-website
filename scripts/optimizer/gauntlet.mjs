#!/usr/bin/env node
// gauntlet.mjs — die eigene Runde als Meta: Pod-Analyse + Matchup-Tabelle.
//
// Usage:
//   node scripts/optimizer/gauntlet.mjs --scan            # alle Decks analysieren → pod-meta.json
//   node scripts/optimizer/gauntlet.mjs <deck-id|Name>    # Matchup-Report gegen den Pod
//   node scripts/optimizer/gauntlet.mjs <...> --json
//
// pod-meta.json ist ein VERSIONIERTER Snapshot (Benchmarks bleiben stabil, bis
// bewusst neu gescannt wird). KEINE DB-Writes: decks.archetype ist ein
// user-editierbares Marketplace-Feld und wird nur als Hint GELESEN (Plan/Critic).
//
// "Bestehen"-Kriterium (Research-Synthese, kalibrierbar — Stand nach dem
// Anti-Gummistempel-Fix, identisch zu passesAgainst + Konsolen-Footer):
//   Keep-Rate >= 80%
//   UND Interaktions-FLOOR des Gegner-Bands (0.08/0.12/0.15 — Pflicht!)
//   UND (Clock-Parity [eigener Goldfish-Median <= Gegner-Median + 1]
//        ODER volle Antwort-Parity [Dichte >= Benchmark UND >= 40% instant]).
// Decks ohne Goldfish-Kill in 10 Zügen (Combo-/Synergie-Decks) bestehen über
// den Antwort-Pfad — Grenzen der Goldfish-Metrik, Research Kap. 3.

import { readFile, writeFile, rename } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ensurePool, lookupCard, formatDatenstand } from './lib/cardpool.mjs'
import { classifyCard, mergeOverrides, isInteraction, isInstantSpeed } from './lib/roles.mjs'
import { toSimCard, simulate } from './lib/sim.mjs'
import { renderTable, formatPct, heading } from './lib/format.mjs'

const POD_META_FILE = fileURLToPath(new URL('./pod-meta.json', import.meta.url))
const OVERRIDES_FILE = fileURLToPath(new URL('./roles-overrides.json', import.meta.url))
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Interaktionsdichte je Bracket-Band aus den Research-Spannen (B1-2: 8-15%,
// B3: 12-22%, B4-5: 15-28%): FLOOR = Untergrenze (harte Mindestanforderung,
// sonst ist man im Pod nur Zuschauer), BENCHMARK = Mitte (voller
// Antwort-Parity-Nachweis). Der Floor ist die Antwort auf den Critic-BLOCKER
// "Gummistempel": Clock-Parity allein reicht nicht mehr zum Bestehen.
const INTERACTION_FLOOR = { low: 0.08, mid: 0.12, high: 0.15 }
const INTERACTION_BENCHMARK = { low: 0.10, mid: 0.15, high: 0.20 }
const INSTANT_SPEED_SHARE = 0.4
const KEEP_RATE_MIN = 0.8

function bracketBand(gcCount) {
  return gcCount === 0 ? 'low' : gcCount <= 3 ? 'mid' : 'high'
}

async function loadOverrides() {
  try {
    return JSON.parse(await readFile(OVERRIDES_FILE, 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`⚠ roles-overrides.json unlesbar (${err.message}) — Heuristik ohne Overrides.`)
    return {}
  }
}

export function analyzeDeckForPod({ deck, cards, index, overrides }) {
  const enriched = cards.map(row => {
    const record = lookupCard(index, row.name)
    const effective = record ?? {
      name: row.name, type_line: row.type_line ?? '', mana_cost: row.mana_cost ?? '',
      cmc: row.cmc ?? 0, oracle_text: '', power: null, layout: 'normal',
      color_identity: [], keywords: [], produced_mana: [], legal: 'unknown',
      game_changer: false, faces: null,
    }
    const roles = mergeOverrides(row.name, classifyCard(effective), overrides)
    return { effective, record, roles, quantity: row.quantity ?? 1 }
  })

  const nonland = enriched.filter(e => !e.roles.includes('land'))
  const nonlandCount = nonland.reduce((s, e) => s + e.quantity, 0)
  const interactionCards = enriched.filter(e => isInteraction(e.roles))
  const interactionCount = interactionCards.reduce((s, e) => s + e.quantity, 0)
  const instantSpeedCount = interactionCards
    .filter(e => isInstantSpeed(e.effective))
    .reduce((s, e) => s + e.quantity, 0)
  const gcCount = enriched.filter(e => e.record?.game_changer).length

  const sim = simulate(enriched.map(toSimCard), { iterations: 500, seed: 42, turns: 10 })
  const clocks = [sim.clocks.combat.median, sim.clocks.mill.median].filter(c => c !== null)
  const speed = clocks.length ? Math.min(...clocks) : null

  return {
    id: deck.id,
    name: deck.name,
    player: deck.players?.name ?? null,
    commander: deck.commander ?? null,
    archetypeHint: deck.archetype ?? null, // read-only Marketplace-Feld
    gcCount,
    bracketBand: bracketBand(gcCount),
    interaction: {
      count: interactionCount,
      nonland: nonlandCount,
      density: nonlandCount ? +(interactionCount / nonlandCount).toFixed(3) : 0,
      instantSpeed: instantSpeedCount,
    },
    keepRate: +sim.keepRate.toFixed(3),
    clocks: sim.clocks,
    speed,
  }
}

// Pass-Kriterium (Critic-Fix M3-M5): Keep UND Interaktions-Floor sind PFLICHT,
// Clock-Parity ODER volle Antwort-Parity obendrauf. Bei Casual-Pods, deren
// Goldfish-Clocks alle bei T9-T10 clustern, differenziert der Floor — vorher
// war Clock-Parity strukturell immer wahr (506/506, live nachgerechnet).
export function passesAgainst(me, opp) {
  const clockParity = me.speed !== null && (opp.speed === null || me.speed <= opp.speed + 1)
  const floor = INTERACTION_FLOOR[opp.bracketBand] ?? INTERACTION_FLOOR.mid
  const benchmark = INTERACTION_BENCHMARK[opp.bracketBand] ?? INTERACTION_BENCHMARK.mid
  const floorOk = me.interaction.density >= floor
  const answerParity =
    me.interaction.density >= benchmark &&
    me.interaction.count > 0 &&
    me.interaction.instantSpeed / me.interaction.count >= INSTANT_SPEED_SHARE
  const keepOk = me.keepRate >= KEEP_RATE_MIN
  return {
    pass: keepOk && floorOk && (clockParity || answerParity),
    clockParity,
    answerParity,
    floorOk,
    keepOk,
    floor,
    benchmark,
  }
}

async function scanPod() {
  const { getAllDecksWithPlayers, getDeckCards, friendlyDbError } = await import('./lib/supabase.mjs')
  const { index, meta } = await ensurePool({ maxAgeHours: 168, log: console.error })
  const overrides = await loadOverrides()

  let decks
  try {
    decks = await getAllDecksWithPlayers()
  } catch (err) {
    throw new Error(friendlyDbError(err))
  }

  const entries = []
  for (const deck of decks) {
    process.stderr.write(`  analysiere ${deck.name} …\n`)
    const cards = await getDeckCards(deck.id)
    if (cards.length === 0) continue
    entries.push(analyzeDeckForPod({ deck, cards, index, overrides }))
  }

  const podMeta = {
    generatedAt: new Date().toISOString(),
    pool: { fetchedAt: meta.fetchedAt, cardCount: meta.cardCount },
    criteria: { INTERACTION_FLOOR, INTERACTION_BENCHMARK, INSTANT_SPEED_SHARE, KEEP_RATE_MIN, simIterations: 500, simSeed: 42 },
    // Stabile Sortierung + tmp/rename: reproduzierbare Diffs, nie halbe Files
    // (Critic-Finding: direktes writeFile ohne Ordnung → Merge-/Race-Chaos).
    decks: entries.sort((a, b) => a.id.localeCompare(b.id)),
  }
  const tmp = `${POD_META_FILE}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(podMeta, null, 2) + '\n')
  await rename(tmp, POD_META_FILE)
  return podMeta
}

async function loadPodMeta() {
  try {
    return JSON.parse(await readFile(POD_META_FILE, 'utf8'))
  } catch {
    return null
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const json = argv.includes('--json')
  const doScan = argv.includes('--scan')
  const target = argv.filter(a => !a.startsWith('--'))[0]

  if (doScan || !(await loadPodMeta())) {
    console.error(doScan ? 'Scanne Pod …' : 'pod-meta.json fehlt — scanne Pod einmalig …')
    await scanPod()
  }
  const pod = await loadPodMeta()

  if (!target) {
    if (json) { console.log(JSON.stringify(pod, null, 2)); return }
    console.log(`\nPod-Meta: ${pod.decks.length} Decks (Stand ${pod.generatedAt.slice(0, 16).replace('T', ' ')})`)
    console.log(renderTable(
      pod.decks
        .sort((a, b) => (a.speed ?? 99) - (b.speed ?? 99))
        .map(d => ({
          name: d.name.slice(0, 28),
          player: d.player ?? '—',
          band: d.bracketBand === 'low' ? 'B1–2' : d.bracketBand === 'mid' ? 'B3' : 'B4–5',
          speed: d.speed ? `T${d.speed}` : '>T10',
          density: formatPct(d.interaction.density),
          keep: formatPct(d.keepRate),
          hint: d.archetypeHint ?? '',
        })),
      [
        { key: 'name', label: 'Deck' },
        { key: 'player', label: 'Spieler' },
        { key: 'band', label: 'GC-Band' },
        { key: 'speed', label: 'Clock', align: 'right' },
        { key: 'density', label: 'Interakt.', align: 'right' },
        { key: 'keep', label: 'Keep', align: 'right' },
        { key: 'hint', label: 'Archetyp (Hint)' },
      ]
    ))
    return
  }

  const me = UUID_RE.test(target)
    ? pod.decks.find(d => d.id === target)
    : (() => {
        const hits = pod.decks.filter(d => d.name.toLowerCase().includes(target.toLowerCase()))
        if (hits.length !== 1) {
          throw new Error(hits.length === 0
            ? `Kein Pod-Deck matcht "${target}" (ggf. --scan)`
            : `Mehrdeutig: ${hits.map(d => d.name).join(', ')}`)
        }
        return hits[0]
      })()
  if (!me) throw new Error(`Deck ${target} nicht im Pod-Snapshot (--scan ausführen?)`)

  const opponents = pod.decks.filter(d => d.id !== me.id)
  const rows = opponents.map(opp => {
    const r = passesAgainst(me, opp)
    return { opp, r }
  })

  if (json) {
    console.log(JSON.stringify({ me, matchups: rows.map(({ opp, r }) => ({ opponent: { id: opp.id, name: opp.name }, ...r })) }, null, 2))
    return
  }

  const passed = rows.filter(x => x.r.pass).length
  console.log(`\nGauntlet: ${me.name} gegen ${opponents.length} Runden-Decks — besteht ${passed}/${opponents.length}`)
  console.log(`Eigene Werte: Clock ${me.speed ? `T${me.speed}` : '>T10'} · Interaktion ${formatPct(me.interaction.density)} (${me.interaction.instantSpeed}/${me.interaction.count} instant) · Keep ${formatPct(me.keepRate)}`)
  console.log(renderTable(
    rows
      .sort((a, b) => (a.opp.speed ?? 99) - (b.opp.speed ?? 99))
      .map(({ opp, r }) => ({
        opp: opp.name.slice(0, 28),
        speed: opp.speed ? `T${opp.speed}` : '>T10',
        band: opp.bracketBand === 'low' ? 'B1–2' : opp.bracketBand === 'mid' ? 'B3' : 'B4–5',
        pass: r.pass ? '✓' : '✗',
        why: r.pass
          ? (r.answerParity ? 'Antworten' : 'Clock+Floor')
          : !r.keepOk ? 'Keep-Rate < 80%'
          : !r.floorOk ? `Interakt. < Floor ${formatPct(r.floor)}`
          : `zu langsam + Interakt. < ${formatPct(r.benchmark)}`,
      })),
    [
      { key: 'opp', label: 'Gegner' },
      { key: 'speed', label: 'Clock', align: 'right' },
      { key: 'band', label: 'Band' },
      { key: 'pass', label: 'Besteht' },
      { key: 'why', label: 'Grund' },
    ]
  ))
  console.log('\nKriterium: Keep ≥ 80% UND Interaktions-Floor (je Gegner-Band) UND (Clock-Parity ODER Antwort-Parity) — kalibrierbar im Datei-Kopf.')
}

// Direct-Run-Guard (Repo-Muster aus sync-prices.mjs): beim Import durch
// Tests/andere Module darf die CLI nicht mitlaufen.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(err => {
    console.error(`Fehler: ${err.message}`)
    process.exit(1)
  })
}

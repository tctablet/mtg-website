#!/usr/bin/env node
// refs.mjs — Referenzdecks mit Funktionsnachweis (Evidenz-Hierarchie aus
// DECK-OPTIMIZER-RESEARCH.md Kap. 4). Fetch + lokaler Cache mit Provenienz.
//
// Usage:
//   node scripts/optimizer/refs.mjs precons [jahr]      # MTGJSON: Commander-Precons (WotC-getestet)
//   node scripts/optimizer/refs.mjs precon <fileName>   # eine Precon-Liste laden (z.B. WorldShaper_EOC)
//   node scripts/optimizer/refs.mjs cedh [filter]       # cEDH-DB: COMPETITIVE-Referenzen (Turnierumfeld)
//   node scripts/optimizer/refs.mjs edhrec "Commander"  # EDHREC Average Deck (Community-Konsens, best effort)
//
// Evidenz-Label je Quelle:
//   [WOTC-GETESTET]   Precons — professionell getestete Baseline (B2/B3)
//   [CEDH-KURATIERT]  cEDH-DB COMPETITIVE, updated >= 2024 — Turnierumfeld-erprobt
//   [KONSENS]         EDHREC Average — Popularität, KEIN Funktionsnachweis
// Jede Übernahme in ein Deck läuft trotzdem durch validate/budget-Gates.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { renderTable, heading } from './lib/format.mjs'
import { edhrecSlug } from '../../src/edhrec.js'

const CACHE_DIR = fileURLToPath(new URL('./.cache/refs/', import.meta.url))
const UA = { 'User-Agent': 'mtg-website-deck-optimizer/1.0 (+https://github.com/tctablet/mtg-website)' }
const CACHE_HOURS = 7 * 24

async function cachedFetch(key, url, { maxAgeHours = CACHE_HOURS } = {}) {
  await mkdir(CACHE_DIR, { recursive: true })
  const file = CACHE_DIR + key
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'))
    if ((Date.now() - Date.parse(raw.fetchedAt)) / 3.6e6 < maxAgeHours) return raw.data
  } catch {}
  const res = await fetch(url, { headers: UA })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const data = await res.json()
  await writeFile(file, JSON.stringify({ fetchedAt: new Date().toISOString(), source: url, data }))
  return data
}

async function precons(yearFilter) {
  const list = await cachedFetch('mtgjson-decklist.json', 'https://mtgjson.com/api/v5/DeckList.json')
  const decks = (list.data ?? [])
    .filter(d => d.type === 'Commander Deck')
    .filter(d => !yearFilter || (d.releaseDate ?? '').startsWith(yearFilter))
    .sort((a, b) => (b.releaseDate ?? '').localeCompare(a.releaseDate ?? ''))
  console.log(heading(`[WOTC-GETESTET] Commander-Precons${yearFilter ? ` ${yearFilter}` : ''} (MTGJSON, ${decks.length})`))
  console.log(renderTable(
    decks.slice(0, 40).map(d => ({ name: d.name, code: d.code, date: d.releaseDate, file: d.fileName })),
    [
      { key: 'name', label: 'Deck' },
      { key: 'code', label: 'Set' },
      { key: 'date', label: 'Release' },
      { key: 'file', label: 'fileName (für `refs.mjs precon <fileName>`)' },
    ]
  ))
  if (decks.length > 40) console.log(`  … und ${decks.length - 40} weitere (Jahr als Filter angeben)`)
}

async function precon(fileName) {
  const deck = await cachedFetch(`precon-${fileName}.json`, `https://mtgjson.com/api/v5/decks/${fileName}.json`)
  const d = deck.data
  const main = (d.mainBoard ?? []).map(c => ({ name: c.name, quantity: c.count, mv: c.convertedManaCost ?? c.manaValue, rank: c.edhrecRank ?? null }))
  const commanders = (d.commander ?? []).map(c => c.name)
  console.log(heading(`[WOTC-GETESTET] ${d.name} (${d.code}, ${d.releaseDate}) — Commander: ${commanders.join(' + ')}`))
  console.log(`${main.length} Main-Einträge; Top 15 nach EDHREC-Rank:`)
  console.log(renderTable(
    [...main].filter(c => c.rank).sort((a, b) => a.rank - b.rank).slice(0, 15)
      .map(c => ({ name: c.name, rank: c.rank })),
    [{ key: 'name', label: 'Karte' }, { key: 'rank', label: 'EDHREC-Rank', align: 'right' }]
  ))
  console.log(`\nVollständige Liste gecacht unter scripts/optimizer/.cache/refs/precon-${fileName}.json`)
}

async function cedh(filter) {
  const db = await cachedFetch('cedh-db.json',
    'https://raw.githubusercontent.com/cEDH-Decklist-Database/cEDH-Decklist-Database/main/_data/database.json')
  // updated ist ein ISO-Timestamp. Bevorzugt Einträge ab 2024 (Post-Ban-Meta);
  // fällt die Schwelle auf 0 Treffer, ALLE zeigen mit Alters-Spalte — eine
  // leere Referenzliste wäre schlechter als eine ehrlich datierte.
  const competitive = db
    .filter(e => e.section === 'COMPETITIVE')
    .filter(e => !filter || e.title.toLowerCase().includes(filter.toLowerCase()))
  let entries = competitive.filter(e => Date.parse(e.updated ?? 0) >= Date.parse('2024-01-01'))
  let note = 'updated >= 2024'
  if (entries.length === 0) {
    entries = competitive
    note = 'ACHTUNG: alle Einträge älter als 2024 — Meta-Stand prüfen (Post-Ban!)'
  }
  entries = [...entries].sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''))
  console.log(heading(`[CEDH-KURATIERT] cEDH-DB COMPETITIVE, ${note} (${entries.length})`))
  console.log(renderTable(
    entries.slice(0, 25).map(e => ({
      title: e.title.slice(0, 40),
      commander: (e.commander ?? []).map(c => c.name).join(' + ').slice(0, 34),
      updated: (e.updated ?? '').slice(0, 10) || '—',
      link: e.decklists?.[0]?.link ?? '—',
    })),
    [{ key: 'title', label: 'Archetyp/Titel' }, { key: 'commander', label: 'Commander' }, { key: 'updated', label: 'Stand' }, { key: 'link', label: 'Primer' }]
  ))
  console.log('\nHinweis: Pattern-Quelle für B4/5-Techniken — Übernahmen laufen durchs 500-€- und CI-Gate.')
}

// edhrecSlug lebt jetzt in src/edhrec.js (M5) — EIN Slug-Modul für Website
// (Scan/Wizard) und CLI, live-verifizierte Apostroph-Regel inklusive.

async function edhrec(commanderName) {
  const slug = edhrecSlug(commanderName)
  let page
  try {
    page = await cachedFetch(`edhrec-${slug}.json`, `https://json.edhrec.com/pages/commanders/${slug}.json`, { maxAgeHours: 72 })
  } catch (err) {
    console.log(`[KONSENS] EDHREC nicht verfügbar für "${commanderName}" (${err.message})`)
    console.log('Inoffizieller Endpoint — Fallback: Precons/cEDH-DB nutzen oder Karte direkt auf edhrec.com prüfen.')
    return
  }
  const lists = page.container?.json_dict?.cardlists ?? []
  console.log(heading(`[KONSENS] EDHREC Average für ${commanderName} — Popularität, KEIN Funktionsnachweis`))
  for (const list of lists.slice(0, 8)) {
    const top = (list.cardviews ?? []).slice(0, 8).map(c => c.name).join(', ')
    if (top) console.log(`  ${list.header}: ${top}`)
  }
}

async function main() {
  const [cmd, arg] = process.argv.slice(2)
  if (cmd === 'precons') return precons(arg)
  if (cmd === 'precon' && arg) return precon(arg)
  if (cmd === 'cedh') return cedh(arg)
  if (cmd === 'edhrec' && arg) return edhrec(arg)
  console.error('Usage: refs.mjs precons [jahr] | precon <fileName> | cedh [filter] | edhrec "Commander"')
  process.exit(1)
}

// Direct-Run-Guard (Repo-Muster aus sync-prices.mjs): beim Import durch
// Tests/andere Module darf die CLI nicht mitlaufen.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(err => {
    console.error(`Fehler: ${err.message}`)
    process.exit(1)
  })
}

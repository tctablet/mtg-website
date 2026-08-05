// edhrec.js — EDHREC-Anbindung für den Commander-Scan (und später den Wizard).
// Inoffizielle, aber CORS-offene Endpoints (access-control-allow-origin: *,
// live verifiziert 05.08.2026):
//   json.edhrec.com/pages/average-decks/<slug>.json  → deck.commander + deck.cards
//     (deck.cards = Dict Kartentyp → [[name, qty], ...], Summe = 99)
//   json.edhrec.com/pages/decks/<slug>.json          → table: echte Decks
//     (urlhash/savedate/price/salt/bracket; bei Mega-Commandern ~10 MB!)
//   edhrec.com/api/deckpreview/<urlhash>             → deck: ["1 Name", ...]
// Nicht-kanonische Slugs liefern { redirect: "/decks/<slug>" } → einmal folgen.
// Parser sind pure (node-testbar, Fixtures aus echten Responses); Fetches
// cachen NUR die extrahierten (kleinen) Ergebnisse in sessionStorage.

import { fetchWithTimeout } from './scryfall.js'
import { parseDeckList } from './utils.js'

// --- Pure: Slugs ---

// "Atraxa, Praetors' Voice" → "atraxa-praetors-voice"; DFC nutzt die Front-Face;
// Diakritika werden gestrippt (NFD). Apostrophe verschwinden ERSATZLOS
// (live verifiziert: "krrik-son-of-yawgmoth" 200, "k-rrik-…" 403), alles
// andere außer [a-z0-9] wird zu Hyphens.
export function edhrecSlug(name) {
  const front = String(name || '').split(' // ')[0]
  return front
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// Partner-Paar: alphabetisch sortierte Einzel-Slugs, mit '-' gejoint.
// Live verifiziert: die alphabetische Reihenfolge ist kanonisch, die andere
// liefert einen redirect (dem fetchEdhrecJson ohnehin folgt).
export function partnerSlug(nameA, nameB) {
  return [edhrecSlug(nameA), edhrecSlug(nameB)].sort().join('-')
}

// --- Pure: Parser ---

// ["1 Arcane Signet", "4 Forest"] → [{ quantity, name }]
export function parseEdhrecDeckStrings(lines) {
  return parseDeckList((lines || []).join('\n')).map(({ quantity, name }) => ({ quantity, name }))
}

// average-decks-JSON → { commanders, cards } (Kategorien-Dict abgeflacht)
export function extractAverageDeck(json) {
  const deck = json?.deck
  if (!deck || typeof deck.cards !== 'object') {
    throw new Error('EDHREC-Antwort hat eine unerwartete Struktur (kein deck.cards)')
  }
  const commanders = Array.isArray(deck.commander) ? deck.commander : [deck.commander].filter(Boolean)
  const cards = []
  for (const list of Object.values(deck.cards)) {
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (Array.isArray(entry) && typeof entry[0] === 'string') {
        cards.push({ name: entry[0], quantity: Number(entry[1]) || 1 })
      }
    }
  }
  if (!cards.length) throw new Error('EDHREC-Average-Deck ist leer — Struktur geändert?')
  return { commanders, cards }
}

// decks-JSON → Top-N der Tabelle, SOFORT getrimmt (Antwort kann ~10 MB sein —
// nie roh weiterreichen oder cachen)
export function extractDeckTable(json, topN = 20) {
  const table = Array.isArray(json?.table) ? json.table : []
  return table.slice(0, topN).map(row => ({
    urlhash: row.urlhash,
    savedate: row.savedate || null,
    price: typeof row.price === 'number' ? row.price : null,
    salt: typeof row.salt === 'number' ? Math.round(row.salt * 10) / 10 : null,
    bracket: row.bracket ?? null,
  })).filter(r => r.urlhash)
}

// deckpreview-JSON → { commanders, cards, price, salt, url }
export function extractDeckPreview(json) {
  const lines = Array.isArray(json?.deck) ? json.deck : []
  const cards = parseEdhrecDeckStrings(lines)
  if (!cards.length) throw new Error('EDHREC-Deckpreview ist leer — Struktur geändert?')
  return {
    commanders: Array.isArray(json?.commanders) ? json.commanders : [],
    cards,
    price: typeof json?.price === 'number' ? json.price : null,
    salt: typeof json?.salt === 'number' ? Math.round(json.salt * 10) / 10 : null,
    url: json?.url || null,
  }
}

// commanders-Page (Empfehlungslisten mit Inclusion/Synergy) → flache Liste.
// Struktur (live + refs.mjs-Präzedenz): container.json_dict.cardlists[] mit
// header + cardviews[{ name, num_decks, potential_decks, synergy }].
// inclusionPct = num_decks / potential_decks (EDHRECs "x% of y decks").
export function parseEdhrecPage(json) {
  const lists = json?.container?.json_dict?.cardlists ?? []
  const out = []
  for (const list of lists) {
    for (const cv of list.cardviews ?? []) {
      if (typeof cv?.name !== 'string') continue
      const inclusionPct = cv.num_decks && cv.potential_decks
        ? Math.round((cv.num_decks / cv.potential_decks) * 100)
        : null
      out.push({
        name: cv.name,
        inclusionPct,
        synergy: typeof cv.synergy === 'number' ? Math.round(cv.synergy * 100) : null,
        listHeader: list.header ?? '',
      })
    }
  }
  return out
}

export function fetchCommanderPage(slug) {
  return fetchEdhrecExtract({
    url: `https://json.edhrec.com/pages/commanders/${slug}.json`,
    redirectBase: 'https://json.edhrec.com/pages/commanders/',
    cacheKey: `edhrec:cmdr:${slug}`,
    extract: parseEdhrecPage,
  })
}

// Decklist als Import-Text für den bestehenden Deck-Import serialisieren.
// Commander-Zeilen bekommen das "# !Commander"-Suffix (parseDeckList erkennt
// es, der Import selektiert automatisch). Preview-Listen ENTHALTEN die
// Commander bereits — deshalb werden sie aus den cards herausgefiltert und
// vorn markiert eingefügt (nie doppelt).
export function serializeDeckForImport({ commanders = [], cards = [] }) {
  const commanderSet = new Set(commanders.map(n => n.toLowerCase()))
  const lines = commanders.map(n => `1 ${n} # !Commander`)
  for (const { quantity, name } of cards) {
    if (commanderSet.has(name.toLowerCase())) continue
    lines.push(`${quantity} ${name}`)
  }
  return lines.join('\n')
}

// --- Fetch-Layer (Session-Cache TTL 30min, Redirect-Follow, 15s Timeout) ---

const CACHE_TTL_MS = 30 * 60 * 1000
const TIMEOUT_MS = 15000

function readCache(key) {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return null
    const { t, data } = JSON.parse(raw)
    if (Date.now() - t > CACHE_TTL_MS) return null
    return data
  } catch {
    return null
  }
}

function writeCache(key, data) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ t: Date.now(), data }))
  } catch { /* QuotaExceeded o.ä. — Cache ist optional */ }
}

// Holt JSON, folgt genau EINEM { redirect: "/decks/x" } (nicht-kanonischer
// Slug), extrahiert SOFORT und cached nur das kleine Extrakt.
async function fetchEdhrecExtract({ url, cacheKey, extract, redirectBase, timeoutMs = TIMEOUT_MS }) {
  const cached = readCache(cacheKey)
  if (cached) return cached

  let res = await fetchWithTimeout(url, timeoutMs)
  if (!res.ok) throw new Error(`EDHREC antwortet mit HTTP ${res.status}`)
  let json = await res.json()

  if (json && typeof json.redirect === 'string' && redirectBase) {
    const slug = json.redirect.split('/').filter(Boolean).pop()
    res = await fetchWithTimeout(`${redirectBase}${slug}.json`, timeoutMs)
    if (!res.ok) throw new Error(`EDHREC-Redirect antwortet mit HTTP ${res.status}`)
    json = await res.json()
  }

  const extracted = extract(json)
  writeCache(cacheKey, extracted)
  return extracted
}

export function fetchAverageDeck(slug) {
  return fetchEdhrecExtract({
    url: `https://json.edhrec.com/pages/average-decks/${slug}.json`,
    redirectBase: 'https://json.edhrec.com/pages/average-decks/',
    cacheKey: `edhrec:avg:${slug}`,
    extract: extractAverageDeck,
  })
}

export function fetchRealDecks(slug, topN = 20) {
  return fetchEdhrecExtract({
    url: `https://json.edhrec.com/pages/decks/${slug}.json`,
    redirectBase: 'https://json.edhrec.com/pages/decks/',
    cacheKey: `edhrec:decks:${slug}:${topN}`,
    extract: json => extractDeckTable(json, topN),
    // Die Deck-Tabelle kann ~10 MB wiegen — auf langsamen Verbindungen
    // braucht der Download länger als die Standard-15s
    timeoutMs: 45000,
  })
}

export function fetchDeckPreview(urlhash) {
  return fetchEdhrecExtract({
    url: `https://edhrec.com/api/deckpreview/${encodeURIComponent(urlhash)}`,
    redirectBase: null,
    cacheKey: `edhrec:preview:${urlhash}`,
    extract: extractDeckPreview,
  })
}

// tools.mjs — die 6 read-only MCP-Tools (pure Handler, DB via Injection).
//
// Der `db`-Parameter kapselt alle Supabase-Zugriffe (Entry wired die echten,
// Tests injizieren Fakes mit derselben Row-Shape — die select-Strings unten
// sind deshalb exportiert und werden vom Entry UND vom Test benutzt, damit
// Fake und Realität nicht driften können).
//
// Die Deck-Wert-Formel kommt bewusst aus der Optimizer-Lib (Website-Parität
// per tests/optimizer-analyzer.test.mjs abgesichert) — keine Formel-Kopie.

import { deckValue, BUDGET_LIMIT_EUR } from '../../optimizer/lib/budget.mjs'
import { groupPrintingRows } from '../../../src/printings.js'

// Row-Shapes, auf die sich Tools, Entry und Test-Fakes einigen:
export const DECKS_SELECT = 'id, name, commander, commander2, for_sale, players(name)'
export const PRICES_SELECT = 'name, cheapest_eur, is_foil, updated_at'
export const PRINTINGS_SELECT =
  'scryfall_id, name, set_code, set_name, released_at, image_small, image_normal, image_png'

export const SEARCH_LIMIT_DEFAULT = 20
export const SEARCH_LIMIT_MAX = 100
export const MAX_BATCH_NAMES = 500

// ilike-Pattern-Metazeichen entschärfen — aus einer User-Query darf kein
// eigenes Wildcard-Muster werden (Postgres-LIKE-Escape ist Backslash).
// PostgREST ersetzt in like/ilike-Patterns zusätzlich serverseitig * durch %
// (URL-Encoding-Komfort-Alias) — ein escaptes \* würde dadurch zu \% und
// matchte das falsche Literal. Kein Scryfall-Kartenname enthält *, deshalb
// fliegt es ersatzlos raus statt still zum Wildcard zu werden.
export function escapeIlike(s) {
  return String(s)
    .replace(/\*/g, '')
    .replace(/[\\%_]/g, ch => '\\' + ch)
}

export function clampLimit(n, fallback = SEARCH_LIMIT_DEFAULT, max = SEARCH_LIMIT_MAX) {
  const v = Number.isFinite(Number(n)) ? Math.trunc(Number(n)) : fallback
  return Math.min(max, Math.max(1, v))
}

// Paginierte card_printings-Abfrage, latch-frei (bewusst NICHT
// fetchPrintingsFromDB aus src/supabase.js: dessen Modul-Latch ist für
// Browser-Tab-Lebensdauer gedacht und würde diesen langlaufenden Prozess bei
// einem transienten Fehler dauerhaft deaktivieren). Hier extrahiert, damit die
// Schleife OHNE Live-DB testbar ist — PostgREST kappt still bei 1000 Rows,
// genau diese Bug-Klasse muss der Test fangen.
// fetchPage(pattern, from, to) -> Row-Array einer Seite.
export const PRINTINGS_PAGE = 1000
export async function collectPrintingRows(fetchPage, name) {
  const fetchAll = async pattern => {
    const rows = []
    for (let from = 0; ; from += PRINTINGS_PAGE) {
      const page = await fetchPage(pattern, from, from + PRINTINGS_PAGE - 1)
      rows.push(...(page || []))
      if (!page || page.length < PRINTINGS_PAGE) break
    }
    return rows
  }
  // ilike ohne Wildcards = case-insensitiver Exact-Match; DFC-Fallback:
  // Anfrage "A" findet auch die als "A // B" gespeicherte Karte.
  let rows = await fetchAll(escapeIlike(name))
  if (!rows.length && !name.includes(' // ')) {
    rows = await fetchAll(`${escapeIlike(name)} // %`)
  }
  return rows
}

const round2 = n => Math.round(n * 100) / 100

function requireString(args, key) {
  const v = args?.[key]
  if (typeof v !== 'string' || !v.trim()) {
    throw new Error(`Parameter "${key}" (nicht-leerer String) ist erforderlich.`)
  }
  return v.trim()
}

function priceEntry(info) {
  return { cheapest_eur: info.price, is_foil: info.isFoil }
}

function deckLabel(d) {
  return {
    id: d.id,
    name: d.name,
    commander: d.commander ?? null,
    commander2: d.commander2 ?? null,
    player: d.players?.name ?? null,
    for_sale: !!d.for_sale,
  }
}

/**
 * @param db {
 *   fetchCheapestPrices(names) -> Map<name, { price, isFoil }>,
 *   searchPrices(escapedQuery, limit) -> Rows (PRICES_SELECT, DB-seitig
 *     .order('name') + .limit — Determinismus),
 *   getPrintings(name) -> Rows (PRINTINGS_SELECT, paginiert, latch-frei),
 *   listDecks() -> Rows (DECKS_SELECT, UNGEFILTERT — auch for_sale=true,
 *     sonst wären Resterampe-Decks über deck_name unsichtbar),
 *   getDeckCards(deckId) -> Card-Rows (name, price_eur, quantity, ...),
 * }
 */
export function buildTools(db) {
  async function resolveDeck(args) {
    if (args?.deck_id != null && args?.deck_name != null) {
      // Nie still deck_name ignorieren: zeigen id und name auf verschiedene
      // Decks, wäre das beim 500-€-Check ein lautloser Fehlgriff.
      throw new Error('Bitte NUR "deck_id" ODER "deck_name" angeben, nicht beides.')
    }
    const decks = await db.listDecks()
    if (args?.deck_id != null) {
      const deck = decks.find(d => String(d.id) === String(args.deck_id))
      if (!deck) throw new Error(`Kein Deck mit id "${args.deck_id}" gefunden.`)
      return deck
    }
    const name = requireString(args, 'deck_name')
    const lower = name.toLowerCase()
    const exact = decks.filter(d => (d.name || '').toLowerCase() === lower)
    const matches = exact.length
      ? exact
      : decks.filter(d => (d.name || '').toLowerCase().includes(lower))
    if (matches.length === 1) return matches[0]
    if (matches.length === 0) {
      const known = decks.map(d => d.name).sort().join(', ')
      throw new Error(`Kein Deck namens "${name}" gefunden. Vorhandene Decks: ${known}`)
    }
    const candidates = matches.map(d => `"${d.name}" (${d.players?.name ?? '?'}, id ${d.id})`)
    throw new Error(`Deck-Name "${name}" ist mehrdeutig: ${candidates.join('; ')} — bitte deck_id verwenden.`)
  }

  return [
    {
      name: 'get_price',
      description:
        'Günstigster EUR-Preis einer MTG-Karte (über alle Papier-Printings, täglich von Scryfall gesynct). Exakter Kartenname; bei doppelseitigen Karten reicht die Vorderseite.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Exakter englischer Kartenname' } },
        required: ['name'],
      },
      handler: async args => {
        const name = requireString(args, 'name')
        const lookup = await db.fetchCheapestPrices([name])
        const info = lookup.get(name)
        if (!info) {
          return {
            name,
            found: false,
            hint: 'Nicht in scryfall_prices — Schreibweise prüfen (search_cards) oder Karte ist sehr neu (Sync läuft täglich 06:00 UTC).',
          }
        }
        return { name, found: true, ...priceEntry(info) }
      },
    },
    {
      name: 'get_prices',
      description: `Batch-Preisabfrage für bis zu ${MAX_BATCH_NAMES} Kartennamen. Liefert found-Map (name -> Preis) und missing-Liste.`,
      inputSchema: {
        type: 'object',
        properties: {
          names: {
            type: 'array',
            items: { type: 'string' },
            description: `Exakte englische Kartennamen (max ${MAX_BATCH_NAMES})`,
          },
        },
        required: ['names'],
      },
      handler: async args => {
        const names = args?.names
        if (!Array.isArray(names) || names.length === 0 || !names.every(n => typeof n === 'string')) {
          throw new Error('Parameter "names" (nicht-leeres String-Array) ist erforderlich.')
        }
        if (names.length > MAX_BATCH_NAMES) {
          throw new Error(`Zu viele Namen (${names.length}) — max ${MAX_BATCH_NAMES} pro Aufruf.`)
        }
        const trimmed = [...new Set(names.map(n => n.trim()).filter(Boolean))]
        const lookup = await db.fetchCheapestPrices(trimmed)
        const found = {}
        const missing = []
        for (const n of trimmed) {
          const info = lookup.get(n)
          if (info) found[n] = priceEntry(info)
          else missing.push(n)
        }
        return { found, missing }
      },
    },
    {
      name: 'search_cards',
      description:
        'Kartennamen-Suche (case-insensitive Substring) in der Preis-DB — für unsichere Schreibweisen. Liefert Name + Preis, alphabetisch sortiert.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Substring des Kartennamens' },
          limit: {
            type: 'integer',
            description: `Max Treffer, 1-${SEARCH_LIMIT_MAX} (Default ${SEARCH_LIMIT_DEFAULT})`,
          },
        },
        required: ['query'],
      },
      handler: async args => {
        const query = requireString(args, 'query')
        const limit = clampLimit(args?.limit)
        const rows = await db.searchPrices(escapeIlike(query), limit)
        return {
          query,
          count: rows.length,
          results: rows.map(r => ({
            name: r.name,
            cheapest_eur: r.cheapest_eur,
            is_foil: !!r.is_foil,
            updated_at: r.updated_at,
          })),
        }
      },
    },
    {
      name: 'get_printings',
      description:
        'Alle Papier-Printings einer Karte (Set, Erscheinungsdatum, Bild-URLs) aus dem täglich gesyncten card_printings-Cache, neueste zuerst.',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Exakter englischer Kartenname' } },
        required: ['name'],
      },
      handler: async args => {
        const name = requireString(args, 'name')
        const rows = await db.getPrintings(name)
        if (!rows.length) {
          return {
            name,
            found: false,
            hint: 'Keine Printings im Cache — der Cache enthält nur Karten aus Decks der Runde. Für beliebige Karten Scryfall direkt nutzen.',
          }
        }
        // groupPrintingRows erwartet die angefragten Namen — wir übergeben die
        // tatsächlichen Row-Namen (deckt den DFC-Fall "A // B" bei Anfrage "A" ab).
        const grouped = groupPrintingRows(rows, [...new Set(rows.map(r => r.name))])
        const printings = [...grouped.values()].flat()
        return { name: rows[0].name, found: true, count: printings.length, printings }
      },
    },
    {
      name: 'list_decks',
      description:
        'Alle Decks der Runde inkl. Spieler und Commander — auch Verkaufs-Decks (for_sale). Liefert die deck_id für deck_value.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const decks = (await db.listDecks()).map(deckLabel)
        decks.sort(
          (a, b) =>
            (a.player || '').localeCompare(b.player || '') ||
            (a.name || '').localeCompare(b.name || '')
        )
        return { count: decks.length, decks }
      },
    },
    {
      name: 'deck_value',
      description:
        'Gesamtwert eines Decks in EUR (identische Formel wie die Website) inkl. 500-€-Budget-Check. Deck per deck_id ODER deck_name (genau eins von beiden).',
      inputSchema: {
        type: 'object',
        properties: {
          deck_id: { type: 'string', description: 'Deck-ID (aus list_decks)' },
          deck_name: { type: 'string', description: 'Deckname, case-insensitive; Substring erlaubt wenn eindeutig' },
        },
      },
      handler: async args => {
        if (args?.deck_id == null && args?.deck_name == null) {
          throw new Error('Entweder "deck_id" oder "deck_name" angeben (list_decks zeigt beide).')
        }
        const deck = await resolveDeck(args)
        const cards = await db.getDeckCards(deck.id)
        const { total, missing } = deckValue(cards)
        return {
          deck: deckLabel(deck),
          card_rows: cards.length,
          total_cards: cards.reduce((s, c) => s + (c.quantity || 1), 0),
          total_eur: total,
          // Karten ohne Preis zählen 0 in die Summe und stehen hier namentlich:
          missing_prices: missing,
          budget: {
            limit_eur: BUDGET_LIMIT_EUR,
            over: total > BUDGET_LIMIT_EUR,
            headroom_eur: round2(BUDGET_LIMIT_EUR - total),
          },
        }
      },
    },
  ]
}

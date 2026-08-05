#!/usr/bin/env node
// price-server.mjs — stdio-MCP-Server für die Preis-DB des MTG Deck Trackers.
//
// Registrierung in einem anderen Claude-Code-Projekt (Pfad MIT Quotes):
//   claude mcp add mtg-prices -- node "/Users/cpg/Documents/mtg website/scripts/mcp/price-server.mjs"
//
// Voraussetzung: einmal `npm install` in diesem Repo (Datenlayer braucht
// @supabase/supabase-js). Read-only by design — keine Write-Tools, obwohl
// der Anon-Key schreiben könnte. stdout ist Protokollkanal, Logs -> stderr.

import readline from 'node:readline'
import { supabase, fetchCheapestPrices, getDeckCards } from '../../src/supabase.js'
import { getAllRows, friendlyDbError } from '../optimizer/lib/supabase.mjs'
import { createServer } from './lib/jsonrpc.mjs'
import {
  buildTools,
  collectPrintingRows,
  DECKS_SELECT,
  PRICES_SELECT,
  PRINTINGS_SELECT,
} from './lib/tools.mjs'

const db = {
  fetchCheapestPrices,
  getDeckCards,

  // DB-seitig geordnet + limitiert: ohne ORDER BY wäre die Trefferreihenfolge
  // zwischen zwei identischen Calls nicht stabil.
  async searchPrices(escapedQuery, limit) {
    const { data, error } = await supabase
      .from('scryfall_prices')
      .select(PRICES_SELECT)
      .ilike('name', `%${escapedQuery}%`)
      .order('name')
      .limit(limit)
    if (error) throw error
    return data || []
  },

  // Schleifen-/Fallback-Logik liegt testbar in collectPrintingRows (tools.mjs)
  // — hier nur noch der echte Seiten-Fetch.
  getPrintings(name) {
    return collectPrintingRows(async (pattern, from, to) => {
      const { data, error } = await supabase
        .from('card_printings')
        .select(PRINTINGS_SELECT)
        .ilike('name', pattern)
        .order('scryfall_id')
        .range(from, to)
      if (error) throw error
      return data || []
    }, name)
  },

  // UNGEFILTERT (kein for_sale-Filter wie in getAllDecksWithPlayers) — sonst
  // wären Resterampe-Decks über deck_name unsichtbar, über deck_id aber nicht.
  listDecks() {
    return getAllRows('decks', DECKS_SELECT)
  },
}

const server = createServer({
  serverInfo: { name: 'mtg-prices', version: '1.0.0' },
  instructions:
    'Read-only Preis-DB des MTG Deck Trackers (Supabase, täglich von Scryfall gesynct). ' +
    'Kartenpreise: get_price/get_prices/search_cards. Printings: get_printings. ' +
    'Decks der Runde: list_decks, Deck-Gesamtwert + 500-EUR-Budget-Check: deck_value.',
  tools: buildTools(db),
  formatError: friendlyDbError,
})

// Trennt der Client während eines laufenden Calls (Session-Ende, Reload,
// Ctrl+C), stirbt die stdout-Pipe VOR rl.on('close') — ohne diesen Guard
// terminiert Node den Prozess mit unhandled 'error' (EPIPE) statt sauber.
process.stdout.on('error', err => {
  if (err?.code === 'EPIPE') process.exit(0)
  console.error('price-server: stdout-Fehler:', err)
  process.exit(1)
})

const rl = readline.createInterface({ input: process.stdin, terminal: false })

// Jede Zeile sofort dispatchen statt zu serialisieren: JSON-RPC matcht
// Antworten über die id, die Reihenfolge ist egal — so blockiert ein
// hängender Call (30s-Timeout in jsonrpc.mjs) keine unabhängigen parallelen
// Tool-Calls (Claude Code feuert die routinemäßig im selben Turn). Die
// Handler teilen keinen mutablen State, Parallelität ist hier gefahrlos;
// process.stdout.write schreibt jede Antwort als einen Chunk (kein Interleaving).
let inflight = 0
let closed = false
rl.on('line', line => {
  inflight++
  server
    .handleLine(line)
    .then(response => {
      if (response !== null) process.stdout.write(response + '\n')
    })
    .catch(err => {
      // Darf nie passieren (handleLine fängt selbst) — Absicherung, damit der
      // Server nicht still taub wird.
      console.error('price-server: unerwarteter Fehler:', err)
    })
    .finally(() => {
      inflight--
      if (closed && inflight === 0) process.exit(0)
    })
})

rl.on('close', () => {
  closed = true
  if (inflight === 0) process.exit(0)
})

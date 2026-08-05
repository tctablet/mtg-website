import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createServer } from '../scripts/mcp/lib/jsonrpc.mjs'
import {
  buildTools,
  collectPrintingRows,
  escapeIlike,
  clampLimit,
  DECKS_SELECT,
  PRICES_SELECT,
  PRINTINGS_SELECT,
  PRINTINGS_PAGE,
  SEARCH_LIMIT_MAX,
  MAX_BATCH_NAMES,
} from '../scripts/mcp/lib/tools.mjs'

// ---- Fake-DB ----------------------------------------------------------------
// Die Row-Shapes spiegeln die exportierten select-Strings des Entrys (siehe
// Shape-Kopplungs-Tests unten) — insbesondere das verschachtelte players(name)-
// Embed des echten Supabase-Joins. Fake NICHT "vereinfachen", sonst testet die
// Suite nur noch die Mock-Shape statt der echten API-Shape.

const FAKE_DECKS = [
  { id: 'd1', name: 'Saruman Mill', commander: 'Saruman of Many Colors', commander2: null, for_sale: false, players: { name: 'Philip' } },
  { id: 'd2', name: 'Goblins', commander: 'Krenko, Mob Boss', commander2: null, for_sale: false, players: { name: 'Jan' } },
  { id: 'd3', name: 'Goblins Extreme', commander: 'Muxus', commander2: null, for_sale: false, players: { name: 'Jan' } },
  // Resterampe-Deck: MUSS über deck_name auffindbar sein (Critic-Finding —
  // getAllDecksWithPlayers hätte es weggefiltert, listDecks ist ungefiltert).
  { id: 'd9', name: 'Verkaufsdeck Elfen', commander: 'Ezuri, Renegade Leader', commander2: null, for_sale: true, players: { name: 'Philip' } },
]

const FAKE_CARDS = {
  d1: [
    { name: 'Card A', price_eur: '10.50', quantity: 2 },
    { name: 'Card B', price_eur: null, quantity: 1 },
    { name: 'Card C', price_eur: '0.79', quantity: 1 },
  ],
  d9: [{ name: 'Teuer', price_eur: '600', quantity: 1 }],
}

function makeFakeDb(overrides = {}) {
  return {
    fetchCheapestPrices: async names => {
      const map = new Map()
      for (const n of names) {
        if (n === 'Sol Ring') map.set(n, { price: 1.29, isFoil: false })
        if (n === 'Foil Only') map.set(n, { price: 9.99, isFoil: true })
      }
      return map
    },
    searchPrices: async () => [],
    getPrintings: async () => [],
    listDecks: async () => FAKE_DECKS,
    getDeckCards: async id => FAKE_CARDS[id] ?? [],
    ...overrides,
  }
}

function makeServer(dbOverrides = {}, serverOpts = {}) {
  return createServer({
    serverInfo: { name: 'mtg-prices-test', version: '0.0.0' },
    tools: buildTools(makeFakeDb(dbOverrides)),
    ...serverOpts,
  })
}

async function rpc(server, method, params, id = 1) {
  const line = JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })
  const res = await server.handleLine(line)
  return res === null ? null : JSON.parse(res)
}

async function callTool(server, name, args) {
  return rpc(server, 'tools/call', { name, arguments: args }, 42)
}

function toolText(response) {
  assert.equal(response.error, undefined, `Protokollfehler statt Result: ${JSON.stringify(response)}`)
  return response.result.content[0].text
}

// ---- Protokoll --------------------------------------------------------------

test('initialize: echo der Client-protocolVersion + serverInfo + tools-capability', async () => {
  const server = makeServer()
  const res = await rpc(server, 'initialize', { protocolVersion: '2025-06-18' })
  assert.equal(res.result.protocolVersion, '2025-06-18')
  assert.equal(res.result.serverInfo.name, 'mtg-prices-test')
  assert.deepEqual(res.result.capabilities, { tools: {} })
})

test('initialize ohne protocolVersion: Fallback greift', async () => {
  const server = makeServer()
  const res = await rpc(server, 'initialize', {})
  assert.equal(res.result.protocolVersion, '2024-11-05')
})

test('tools/list: 6 Tools, Schemas strukturell valide (Flach-Prüfung, kein Draft-Validator im Repo)', async () => {
  const server = makeServer()
  const res = await rpc(server, 'tools/list')
  const tools = res.result.tools
  assert.equal(tools.length, 6)
  assert.deepEqual(
    tools.map(t => t.name).sort(),
    ['deck_value', 'get_price', 'get_prices', 'get_printings', 'list_decks', 'search_cards']
  )
  for (const t of tools) {
    assert.ok(t.description.length > 20, `${t.name}: Beschreibung zu dünn`)
    assert.equal(t.inputSchema.type, 'object', `${t.name}: inputSchema.type`)
    assert.equal(typeof t.inputSchema.properties, 'object', `${t.name}: properties fehlt`)
    for (const req of t.inputSchema.required ?? []) {
      assert.ok(req in t.inputSchema.properties, `${t.name}: required "${req}" ohne property`)
    }
  }
})

test('Notification (ohne id) bekommt NIE eine Antwort', async () => {
  const server = makeServer()
  const res = await server.handleLine(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  )
  assert.equal(res, null)
})

test('id 0 ist eine echte Request-id, keine Notification', async () => {
  const server = makeServer()
  const res = await rpc(server, 'ping', undefined, 0)
  assert.equal(res.id, 0)
  assert.deepEqual(res.result, {})
})

test('unbekannte Methode -> -32601, kaputtes JSON -> -32700', async () => {
  const server = makeServer()
  const unknown = await rpc(server, 'resources/read')
  assert.equal(unknown.error.code, -32601)
  const broken = JSON.parse(await server.handleLine('{nope'))
  assert.equal(broken.error.code, -32700)
  assert.equal(broken.id, null)
})

test('unbekanntes Tool -> Protokollfehler -32602 (kein isError-Result)', async () => {
  const server = makeServer()
  const res = await callTool(server, 'write_stuff', {})
  assert.equal(res.error.code, -32602)
})

test('Handler-Throw -> isError-Result mit Meldung (kein Protokollfehler)', async () => {
  const server = makeServer({
    listDecks: async () => {
      throw new Error('fetch failed')
    },
  })
  const res = await callTool(server, 'list_decks', {})
  assert.equal(res.result.isError, true)
  assert.match(toolText(res), /fetch failed/)
})

test('formatError wird auf Handler-Fehler angewendet (friendlyDbError-Einhängepunkt)', async () => {
  const server = createServer({
    serverInfo: { name: 't', version: '0' },
    tools: buildTools(makeFakeDb({ listDecks: async () => Promise.reject(new Error('ENOTFOUND db')) })),
    formatError: err => `hübsch: ${err.message}`,
  })
  const res = await callTool(server, 'list_decks', {})
  assert.match(toolText(res), /hübsch: ENOTFOUND db/)
})

test('hängender Handler läuft ins Timeout -> isError statt ewigem Hänger', async () => {
  const server = createServer({
    serverInfo: { name: 't', version: '0' },
    tools: [
      {
        name: 'hang',
        description: 'hängt für immer (Testdouble für Mac-Sleep/WLAN-Hänger)',
        inputSchema: { type: 'object', properties: {} },
        handler: () => new Promise(() => {}),
      },
    ],
    callTimeoutMs: 25,
  })
  const res = await callTool(server, 'hang', {})
  assert.equal(res.result.isError, true)
  assert.match(toolText(res), /Timeout nach 25ms: hang/)
})

// ---- Tools ------------------------------------------------------------------

test('get_price: Treffer und Nicht-Treffer', async () => {
  const server = makeServer()
  const hit = JSON.parse(toolText(await callTool(server, 'get_price', { name: 'Sol Ring' })))
  assert.deepEqual(hit, { name: 'Sol Ring', found: true, cheapest_eur: 1.29, is_foil: false })
  const miss = JSON.parse(toolText(await callTool(server, 'get_price', { name: 'Nope' })))
  assert.equal(miss.found, false)
  assert.match(miss.hint, /search_cards/)
})

test('get_prices: found-Map + missing-Liste, dedupliziert und getrimmt', async () => {
  const server = makeServer()
  const res = JSON.parse(
    toolText(
      await callTool(server, 'get_prices', {
        names: ['Sol Ring', ' Sol Ring ', 'Foil Only', 'Missing Card'],
      })
    )
  )
  assert.deepEqual(Object.keys(res.found).sort(), ['Foil Only', 'Sol Ring'])
  assert.equal(res.found['Foil Only'].is_foil, true)
  assert.deepEqual(res.missing, ['Missing Card'])
})

test('get_prices: Validation — leeres/kein Array und Batch-Cap', async () => {
  const server = makeServer()
  const empty = await callTool(server, 'get_prices', { names: [] })
  assert.equal(empty.result.isError, true)
  const tooMany = await callTool(server, 'get_prices', {
    names: Array.from({ length: MAX_BATCH_NAMES + 1 }, (_, i) => `c${i}`),
  })
  assert.equal(tooMany.result.isError, true)
  assert.match(toolText(tooMany), new RegExp(`max ${MAX_BATCH_NAMES}`))
})

test('search_cards: limit wird geklemmt, Wildcards werden escaped', async () => {
  const seen = []
  const server = makeServer({
    searchPrices: async (q, limit) => {
      seen.push({ q, limit })
      return [{ name: 'Mox 50%', cheapest_eur: 5, is_foil: false, updated_at: '2026-08-05' }]
    },
  })
  await callTool(server, 'search_cards', { query: '50%_\\', limit: 5000 })
  await callTool(server, 'search_cards', { query: 'mox', limit: 0 })
  await callTool(server, 'search_cards', { query: 'mox' })
  assert.equal(seen[0].q, '50\\%\\_\\\\')
  assert.equal(seen[0].limit, SEARCH_LIMIT_MAX)
  assert.equal(seen[1].limit, 1)
  assert.equal(seen[2].limit, 20)
})

test('escapeIlike/clampLimit als pure Bausteine', () => {
  assert.equal(escapeIlike('a%b_c\\d'), 'a\\%b\\_c\\\\d')
  // * ist bei PostgREST ein serverseitiger %-Alias — muss ersatzlos raus,
  // sonst wird "so*ing" still zur Wildcard-Suche (live reproduziertes Finding):
  assert.equal(escapeIlike('so*ing'), 'soing')
  assert.equal(escapeIlike('**'), '')
  assert.equal(clampLimit(undefined), 20)
  assert.equal(clampLimit('nope'), 20)
  assert.equal(clampLimit(-3), 1)
  assert.equal(clampLimit(999), SEARCH_LIMIT_MAX)
})

const FAKE_PRINTING_ROWS = [
  { scryfall_id: 's2', name: 'Delver of Secrets // Insectile Aberration', set_code: 'isd', set_name: 'Innistrad', released_at: '2011-09-30', image_small: 'sm2', image_normal: 'n2', image_png: 'p2' },
  { scryfall_id: 's1', name: 'Delver of Secrets // Insectile Aberration', set_code: 'mid', set_name: 'Midnight Hunt', released_at: '2021-09-24', image_small: 'sm1', image_normal: 'n1', image_png: 'p1' },
]

test('get_printings: gruppiert + DFC-Row-Namen decken Front-Face-Anfrage ab', async () => {
  const rows = FAKE_PRINTING_ROWS
  const server = makeServer({
    getPrintings: async name => (name.startsWith('Delver') ? rows : []),
  })
  const res = JSON.parse(toolText(await callTool(server, 'get_printings', { name: 'Delver of Secrets' })))
  assert.equal(res.found, true)
  assert.equal(res.name, 'Delver of Secrets // Insectile Aberration')
  assert.equal(res.count, 2)
  // groupPrintingRows sortiert neueste zuerst:
  assert.deepEqual(res.printings.map(p => p.set_code), ['mid', 'isd'])
  const miss = JSON.parse(toolText(await callTool(server, 'get_printings', { name: 'Nope' })))
  assert.equal(miss.found, false)
})

test('list_decks: enthält Resterampe-Decks mit for_sale-Flag, sortiert nach Spieler/Name', async () => {
  const server = makeServer()
  const res = JSON.parse(toolText(await callTool(server, 'list_decks', {})))
  assert.equal(res.count, 4)
  const sale = res.decks.find(d => d.name === 'Verkaufsdeck Elfen')
  assert.equal(sale.for_sale, true)
  assert.equal(sale.player, 'Philip')
  assert.deepEqual(
    res.decks.map(d => `${d.player}/${d.name}`),
    ['Jan/Goblins', 'Jan/Goblins Extreme', 'Philip/Saruman Mill', 'Philip/Verkaufsdeck Elfen']
  )
})

test('deck_value per deck_id: ECHTE budget.mjs-Formel (10.50*2 + 0 + 0.79), missing + headroom', async () => {
  const server = makeServer()
  const res = JSON.parse(toolText(await callTool(server, 'deck_value', { deck_id: 'd1' })))
  assert.equal(res.total_eur, 21.79)
  assert.equal(res.card_rows, 3)
  assert.equal(res.total_cards, 4)
  assert.deepEqual(res.missing_prices, ['Card B'])
  assert.deepEqual(res.budget, { limit_eur: 500, over: false, headroom_eur: 478.21 })
  assert.equal(res.deck.player, 'Philip')
})

test('deck_value per deck_name: exakter Match schlägt Substring, case-insensitive', async () => {
  const server = makeServer()
  const res = JSON.parse(toolText(await callTool(server, 'deck_value', { deck_name: 'goblins' })))
  assert.equal(res.deck.id, 'd2')
})

test('deck_value: mehrdeutiger Substring -> Fehler mit Kandidatenliste', async () => {
  const server = makeServer()
  const res = await callTool(server, 'deck_value', { deck_name: 'gobl' })
  assert.equal(res.result.isError, true)
  assert.match(toolText(res), /mehrdeutig/)
  assert.match(toolText(res), /Goblins Extreme/)
})

test('deck_value: Resterampe-Deck per deck_name erreichbar + over-Budget-Flag', async () => {
  const server = makeServer()
  const res = JSON.parse(toolText(await callTool(server, 'deck_value', { deck_name: 'Verkaufsdeck Elfen' })))
  assert.equal(res.deck.for_sale, true)
  assert.equal(res.total_eur, 600)
  assert.deepEqual(res.budget, { limit_eur: 500, over: true, headroom_eur: -100 })
})

test('deck_value: ohne deck_id/deck_name und mit unbekannter id -> klare Fehler', async () => {
  const server = makeServer()
  const none = await callTool(server, 'deck_value', {})
  assert.equal(none.result.isError, true)
  assert.match(toolText(none), /deck_id.*deck_name|deck_name.*deck_id/)
  const bad = await callTool(server, 'deck_value', { deck_id: 'nope' })
  assert.equal(bad.result.isError, true)
  const badName = await callTool(server, 'deck_value', { deck_name: 'Gibtsnicht' })
  assert.match(toolText(badName), /Vorhandene Decks/)
})

test('deck_value: deck_id UND deck_name gleichzeitig -> Fehler statt stillem deck_id-Gewinn', async () => {
  const server = makeServer()
  const res = await callTool(server, 'deck_value', { deck_id: 'd1', deck_name: 'Goblins' })
  assert.equal(res.result.isError, true)
  assert.match(toolText(res), /nicht beides/)
})

// ---- collectPrintingRows: Pagination + DFC-Fallback (Critic-R2-HIGH) --------

test('collectPrintingRows: paginiert über die 1000er-Kappung hinweg, lückenlos', async () => {
  // 2 volle Seiten + Rest — genau die Bug-Klasse "PostgREST kappt still bei
  // 1000 Rows", vor der optimizer/lib/supabase.mjs warnt.
  const TOTAL = 2 * PRINTINGS_PAGE + 7
  const calls = []
  const rows = await collectPrintingRows(async (pattern, from, to) => {
    calls.push({ pattern, from, to })
    assert.equal(to, from + PRINTINGS_PAGE - 1, 'range-Fenster muss exakt eine Seite sein')
    return Array.from(
      { length: Math.max(0, Math.min(TOTAL - from, PRINTINGS_PAGE)) },
      (_, i) => ({ scryfall_id: `s${from + i}` })
    )
  }, 'Island')
  assert.equal(rows.length, TOTAL)
  assert.equal(calls.length, 3)
  assert.deepEqual(calls.map(c => c.from), [0, PRINTINGS_PAGE, 2 * PRINTINGS_PAGE])
  // lückenlos + duplikatfrei über die Seitengrenzen:
  assert.equal(new Set(rows.map(r => r.scryfall_id)).size, TOTAL)
})

test('collectPrintingRows: exakt volle Seite -> genau ein Nachfass-Call, kein Endlos-Loop', async () => {
  const calls = []
  const rows = await collectPrintingRows(async (pattern, from) => {
    calls.push(from)
    return from === 0 ? Array.from({ length: PRINTINGS_PAGE }, (_, i) => ({ scryfall_id: `s${i}` })) : []
  }, 'Island')
  assert.equal(rows.length, PRINTINGS_PAGE)
  assert.deepEqual(calls, [0, PRINTINGS_PAGE])
})

test('collectPrintingRows: DFC-Fallback fragt "Name // %" nach, escaped Wildcards, kein Fallback bei vollem DFC-Namen', async () => {
  const patterns = []
  const rows = await collectPrintingRows(async pattern => {
    patterns.push(pattern)
    return pattern.endsWith(' // %') ? [{ scryfall_id: 'dfc' }] : []
  }, 'Delver 100%')
  assert.deepEqual(patterns, ['Delver 100\\%', 'Delver 100\\% // %'])
  assert.equal(rows.length, 1)

  const noFallback = []
  await collectPrintingRows(async pattern => {
    noFallback.push(pattern)
    return []
  }, 'A // B')
  assert.deepEqual(noFallback, ['A // B'], 'voller DFC-Name darf keinen zweiten Versuch auslösen')
})

// ---- Shape-Kopplung Fake <-> echte Selects ----------------------------------

test('Fake-Rows spiegeln die exportierten select-Strings (players(name)-Embed etc.)', () => {
  assert.match(DECKS_SELECT, /players\(name\)/)
  assert.match(DECKS_SELECT, /for_sale/)
  for (const d of FAKE_DECKS) {
    assert.equal(typeof d.players?.name, 'string', 'players muss als verschachteltes Objekt gefaked sein (echte Join-Shape)')
    for (const key of ['id', 'name', 'commander', 'commander2', 'for_sale']) {
      assert.ok(key in d, `Fake-Deck ohne "${key}"`)
    }
  }
  for (const col of PRICES_SELECT.split(', ')) {
    assert.ok(['name', 'cheapest_eur', 'is_foil', 'updated_at'].includes(col), `unerwartete Preis-Spalte ${col}`)
  }
  // Auch die Printings-Fakes müssen jede Spalte des echten Selects befüllen —
  // die String-Kopplung allein erzwingt das nicht (Critic-R2-Finding).
  for (const row of FAKE_PRINTING_ROWS) {
    for (const col of PRINTINGS_SELECT.split(', ')) {
      assert.ok(col in row, `Fake-Printing-Row ohne "${col}"`)
    }
  }
})

// ---- Entry-Integration (Wiring + stdout-Reinheit, KEINE DB-Calls) -----------

test('price-server.mjs: initialize + tools/list über echtes stdio, stdout bleibt reines JSON', async () => {
  // fileURLToPath statt .pathname: der Repo-Pfad enthält ein Leerzeichen,
  // .pathname lieferte "mtg%20website" -> spawn crasht mit ERR_MODULE_NOT_FOUND.
  const entry = fileURLToPath(new URL('../scripts/mcp/price-server.mjs', import.meta.url))
  const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.resume() // drainen, sonst droht Pipe-Backpressure bei stderr-Output
  try {
    const lines = []
    let buf = ''
    const gotTwo = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout — stdout bisher: ${buf}`)), 15000)
      child.stdout.on('data', chunk => {
        buf += chunk
        for (let i; (i = buf.indexOf('\n')) >= 0; ) {
          lines.push(buf.slice(0, i))
          buf = buf.slice(i + 1)
        }
        if (lines.length >= 2) {
          clearTimeout(timer)
          resolve()
        }
      })
      child.on('error', reject)
      child.on('exit', code => reject(new Error(`Server vorzeitig beendet (code ${code})`)))
    })
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n'
    )
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
    await gotTwo
    // Jede stdout-Zeile MUSS valides JSON-RPC sein — console.log-Verschmutzung
    // im Import-Graph würde hier sofort auffliegen.
    const init = JSON.parse(lines[0])
    const list = JSON.parse(lines[1])
    assert.equal(init.id, 1)
    assert.equal(init.result.serverInfo.name, 'mtg-prices')
    assert.equal(init.result.protocolVersion, '2025-06-18')
    assert.equal(list.id, 2)
    assert.equal(list.result.tools.length, 6)
  } finally {
    child.removeAllListeners('exit')
    child.kill()
  }
})

test('price-server.mjs: Leser trennt mit ausstehender Antwort -> sauberer Exit 0 statt EPIPE-Crash', async () => {
  const entry = fileURLToPath(new URL('../scripts/mcp/price-server.mjs', import.meta.url))
  const child = spawn(process.execPath, [entry], { stdio: ['pipe', 'pipe', 'pipe'] })
  child.stderr.resume()
  child.stdin.on('error', () => {}) // unser eigenes EPIPE nach Kind-Exit ist erwartbar
  try {
    const exited = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Server hat nach Pipe-Trennung nicht beendet')), 10000)
      child.on('exit', code => {
        clearTimeout(timer)
        resolve(code)
      })
      child.on('error', reject)
    })
    // Lese-Ende der stdout-Pipe schließen = Client trennt (Session-Ende/Reload),
    // dann Antworten provozieren: der Write läuft in EPIPE. Ohne den
    // stdout-error-Guard stirbt der Prozess mit unhandled 'error' (Code != 0).
    child.stdout.destroy()
    const poke = setInterval(() => {
      try {
        child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n')
      } catch {
        /* Kind schon weg */
      }
    }, 100)
    try {
      assert.equal(await exited, 0)
    } finally {
      clearInterval(poke)
    }
  } finally {
    child.kill()
  }
})

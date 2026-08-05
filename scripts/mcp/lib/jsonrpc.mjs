// jsonrpc.mjs — MCP-stdio-Protokoll-Layer (pure, testbar).
//
// Newline-delimited JSON-RPC 2.0 wie im MCP-stdio-Transport: eine Nachricht
// pro Zeile, stdout ist reiner Protokollkanal (Logs gehören nach stderr).
// Der Layer kennt keine Supabase — Tools kommen als Daten rein.

const FALLBACK_PROTOCOL_VERSION = '2024-11-05'

// Tool-Handler laufen gegen ein Timeout: ein hängender Fetch (Mac-Sleep,
// WLAN-Wechsel — eine andere Fehlerklasse als das schnelle NXDOMAIN der
// pausierten Free-Tier-Instanz) darf den Server nicht dauerhaft blockieren.
export const DEFAULT_CALL_TIMEOUT_MS = 30_000

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout nach ${ms}ms: ${label}`)), ms)
  })
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer))
}

/**
 * @param serverInfo    { name, version }
 * @param tools         [{ name, description, inputSchema, handler(args) }]
 * @param instructions  optionaler Hinweistext fürs initialize-Result
 * @param formatError   err -> string (Entry hängt hier friendlyDbError ein)
 * @param callTimeoutMs Timeout pro tools/call (Tests injizieren kurze Werte)
 * @returns { handleLine(line): Promise<string|null> } — null = keine Antwort
 */
export function createServer({
  serverInfo,
  tools,
  instructions,
  formatError = err => String(err?.message || err),
  callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
}) {
  const byName = new Map(tools.map(t => [t.name, t]))

  const respond = (id, result) => JSON.stringify({ jsonrpc: '2.0', id, result })
  const respondError = (id, code, message) =>
    JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })

  async function callTool(params) {
    const tool = byName.get(params?.name)
    if (!tool) return { protocolError: [-32602, `Unbekanntes Tool: ${params?.name}`] }
    try {
      const value = await withTimeout(
        tool.handler(params.arguments ?? {}),
        callTimeoutMs,
        params.name
      )
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      return { result: { content: [{ type: 'text', text }] } }
    } catch (err) {
      // Ausführungsfehler als isError-Result, nicht als Protokollfehler —
      // so sieht das aufrufende Modell die Meldung und kann reagieren.
      return {
        result: { content: [{ type: 'text', text: `Fehler: ${formatError(err)}` }], isError: true },
      }
    }
  }

  async function handleLine(line) {
    if (!line.trim()) return null
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      return respondError(null, -32700, 'Parse error')
    }
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
      return respondError(null, -32600, 'Invalid request')
    }

    // Client-Antworten (auf Requests, die wir nie stellen) still ignorieren.
    if (!('method' in msg)) {
      return 'id' in msg && !('result' in msg) && !('error' in msg)
        ? respondError(msg.id, -32600, 'Invalid request')
        : null
    }

    // Notification: hat KEINE id — bekommt NIE eine Antwort.
    // ('id' in msg statt Truthiness: id 0 wäre sonst fälschlich Notification.)
    const isNotification = !('id' in msg)
    if (isNotification) return null

    switch (msg.method) {
      case 'initialize':
        return respond(msg.id, {
          protocolVersion: msg.params?.protocolVersion || FALLBACK_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo,
          ...(instructions ? { instructions } : {}),
        })
      case 'ping':
        return respond(msg.id, {})
      case 'tools/list':
        return respond(msg.id, {
          tools: tools.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        })
      case 'tools/call': {
        const outcome = await callTool(msg.params)
        if (outcome.protocolError) return respondError(msg.id, ...outcome.protocolError)
        return respond(msg.id, outcome.result)
      }
      default:
        return respondError(msg.id, -32601, `Method not found: ${msg.method}`)
    }
  }

  return { handleLine }
}

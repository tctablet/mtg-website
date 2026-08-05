// cardpool.mjs — lokaler Oracle-Bulk-Cache als Metadaten-Ground-Truth.
//
// Lädt Scryfalls "Oracle Cards"-Bulk (1 Objekt pro Oracle-ID, gzipped JSONL)
// nach scripts/optimizer/.cache/ und baut einen Name-Index. Der Index enthält
// ALLE Karten — Legalität ist ein Feld, kein Index-Filter, damit der Deck-Audit
// auch illegale Karten auflösen und als Verstoß ausweisen kann. Nur die
// Kandidatensuche (isCandidate) filtert auf commander-legal + Papier.
//
// Refresh-Politik: Gates (Propose/Apply) verlangen maxAgeHours=24 (Banlist!),
// reine Report-CLIs akzeptieren bis 7 Tage. Jede CLI druckt die Datenstand-Zeile.

import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const CACHE_DIR = fileURLToPath(new URL('../.cache/', import.meta.url))
const INDEX_FILE = CACHE_DIR + 'cardpool-index.json'
// PID im tmp-Namen: zwei parallele Downloads (z.B. zwei Terminals bei leerem
// Cache) schreiben getrennte Dateien; das atomare rename() ist dann
// last-writer-wins mit jeweils VOLLSTÄNDIGEM Inhalt — nie interleaved.
const TMP_FILE = `${CACHE_DIR}cardpool-index.json.${process.pid}.tmp`

const SCRYFALL_HEADERS = {
  'User-Agent': 'mtg-website-deck-optimizer/1.0 (+https://github.com/tctablet/mtg-website)',
  Accept: 'application/json',
}

// Ein gesunder Oracle-Bulk hat ~35k Karten. Deutlich weniger heißt: Download
// abgerissen — dann den alten Index NICHT überschreiben (gleiches Muster wie
// MIN_EXPECTED_NAMES in scripts/sync-prices.mjs).
const MIN_EXPECTED_CARDS = 25000

// ---- pure Bausteine: leben jetzt in pool-core.mjs (M5, browser-tauglich) ----
// Re-Export hält alle bestehenden Importe (CLIs, Tests) stabil.
export {
  toPoolRecord, buildIndex, lookupCard, isCandidate, ciSubset, searchCandidates,
  poolAgeHours, formatDatenstand,
} from './pool-core.mjs'

import { toPoolRecord, buildIndex, poolAgeHours } from './pool-core.mjs'

// ---- Cache-Verwaltung (I/O) ----

// Streamt eine gzipped-JSONL-Datei zeilenweise (gleiches Muster wie
// streamScryfallCards in scripts/sync-prices.mjs — dort wegen fehlendem Export
// nicht importierbar; Logik bewusst identisch gehalten).
async function* streamJsonlGz(url) {
  const res = await fetch(url, { headers: SCRYFALL_HEADERS })
  if (!res.ok) throw new Error(`Bulk-Download fehlgeschlagen: ${res.status}`)
  const gzipped = url.endsWith('.gz') || (res.headers.get('content-type') || '').includes('gzip')
  const source = gzipped ? res.body.pipeThrough(new DecompressionStream('gzip')) : res.body
  const decoder = new TextDecoder('utf-8')
  let buf = ''
  const parseLine = (raw) => {
    const line = raw.trim().replace(/,$/, '')
    if (!line || line === '[' || line === ']') return null
    return JSON.parse(line)
  }
  for await (const chunk of source) {
    buf += decoder.decode(chunk, { stream: true })
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const card = parseLine(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
      if (card) yield card
    }
  }
  buf += decoder.decode()
  const last = parseLine(buf)
  if (last) yield last
}

async function downloadPool() {
  const metaRes = await fetch('https://api.scryfall.com/bulk-data/oracle_cards', {
    headers: SCRYFALL_HEADERS,
  })
  if (!metaRes.ok) throw new Error(`Scryfall bulk-data lookup fehlgeschlagen: ${metaRes.status}`)
  const bulkMeta = await metaRes.json()
  const url = bulkMeta.jsonl_download_uri || bulkMeta.download_uri
  if (!url) throw new Error(`Bulk-Antwort ohne Download-URL. Keys: ${Object.keys(bulkMeta).join(', ')}`)

  const records = []
  for await (const card of streamJsonlGz(url)) {
    records.push(toPoolRecord(card))
  }
  if (records.length < MIN_EXPECTED_CARDS) {
    throw new Error(
      `Nur ${records.length} Karten im Bulk-Stream — erwartet mindestens ${MIN_EXPECTED_CARDS}. ` +
      'Download vermutlich unvollständig; bestehender Index bleibt unangetastet.'
    )
  }

  await mkdir(CACHE_DIR, { recursive: true })
  const payload = {
    meta: {
      fetchedAt: new Date().toISOString(),
      bulkUpdatedAt: bulkMeta.updated_at ?? null,
      cardCount: records.length,
      source: 'scryfall oracle_cards',
    },
    records,
  }
  // tmp + rename: ein abgebrochener Write hinterlässt nie einen halben Index.
  await writeFile(TMP_FILE, JSON.stringify(payload))
  await rename(TMP_FILE, INDEX_FILE)
  return payload
}

async function loadIndexFile() {
  const raw = JSON.parse(await readFile(INDEX_FILE, 'utf8'))
  return raw
}

/**
 * Liefert { index, meta }. Lädt den Bulk automatisch beim ersten Aufruf und
 * refresht, wenn der Cache älter als maxAgeHours ist.
 *
 * Reports rufen mit maxAgeHours=168 (offline-tolerant: bei Netzfehler läuft
 * ein vorhandener, auch veralteter Cache mit Warnung weiter). Gates
 * (Propose/Apply) rufen mit { maxAgeHours: 24, strict: true } — ist dann kein
 * Stand ≤ 24 h erreichbar, wird der Fehler durchgereicht statt mit alter
 * Banlist zu validieren.
 */
export async function ensurePool({ maxAgeHours = 168, refresh = false, strict = false, log = console.error } = {}) {
  let cached = null
  try {
    await stat(INDEX_FILE)
    cached = await loadIndexFile()
  } catch {
    cached = null
  }

  const age = poolAgeHours(cached?.meta)
  const needsDownload = refresh || !cached || age > maxAgeHours

  if (needsDownload) {
    try {
      log(`Lade Oracle-Bulk von Scryfall${cached ? ` (Cache ist ${Math.round(age)} h alt)` : ''} ...`)
      cached = await downloadPool()
    } catch (err) {
      if (!cached) throw err
      if (strict && age > maxAgeHours) {
        throw new Error(
          `Kartenpool ist ${Math.round(age)} h alt (Limit ${maxAgeHours} h) und Refresh schlug fehl: ${err.message}`
        )
      }
      log(`⚠ Bulk-Refresh fehlgeschlagen (${err.message}) — nutze vorhandenen Cache.`)
    }
  }

  const index = buildIndex(cached.records)
  return { index, meta: cached.meta }
}

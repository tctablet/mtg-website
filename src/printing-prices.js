// printing-prices.js — Live-EUR je EXAKTEM Printing (scryfall_id) mit
// Session-Cache. Resterampe und Deck-View bewerten Precon-Decks damit:
// nicht der günstigste Print irgendeines Sets, sondern genau das Printing,
// das im versiegelten Deck steckt (User-Ansage 06.08.2026 — das LTC-Birds-
// of-Paradise kostet ~13 €, der billigste Print 3 €).
//
// Cache: EIN Eintrag mit Stempel (TTL 30min wie die anderen Session-Caches);
// auch null-Preise werden gecacht, sonst refetcht jeder Seitenwechsel
// dieselben preislosen Printings.

import { fetchPrintingPricesByIds } from './scryfall.js'

const CACHE_KEY = 'printing:prices:v1'
const TTL_MS = 30 * 60 * 1000

function readCache() {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const { t, data } = JSON.parse(raw)
    if (Date.now() - t > TTL_MS) return null
    return { t, map: new Map(data) }
  } catch {
    return null
  }
}

// Der Stempel des ERSTEN Schreibens bleibt beim Merge erhalten (Critic):
// wuerde jeder Merge ihn erneuern, lebten die aeltesten Preise beliebig
// lange — so laeuft die ganze Map 30min nach Erstbefuellung ab.
function writeCache(map, t) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t, data: [...map] }))
  } catch { /* QuotaExceeded — Cache ist optional */ }
}

/**
 * @param {Array<string>} ids  scryfall_ids (Duplikate/Falsy ok)
 * @returns {Promise<Map<string, number|null>>} id -> EUR | null
 */
export async function fetchPrintingPricesCached(ids) {
  const unique = [...new Set(ids.filter(Boolean))]
  const cached = readCache()
  const map = cached?.map || new Map()
  const missing = unique.filter(id => !map.has(id))
  if (missing.length) {
    const fresh = await fetchPrintingPricesByIds(missing)
    // Auch echte Misses (Scryfall kennt die ID nicht) als null merken
    for (const id of missing) map.set(id, fresh.has(id) ? fresh.get(id) : null)
    writeCache(map, cached?.t ?? Date.now())
  }
  return map
}

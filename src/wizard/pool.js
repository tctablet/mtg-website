// wizard/pool.js — lädt das schlanke Kandidaten-Pool-Asset (M5) und sucht darin.
//
// Quellen-Reihenfolge: Supabase Storage (täglich vom Workflow hochgeladen,
// .gz primär via DecompressionStream mit Feature-Check, plain als Fallback)
// → lokales Static-Asset (public/pool-slim.json — Dev-Umgebung/Notnagel).
// meta.rolesVersion wird gegen die importierte ROLES_VERSION geprüft:
// Mismatch ⇒ sichtbare Warnung, Empfehlungen laufen weiter (Plan-M5-Vertrag).

import { ROLES_VERSION } from '../../scripts/optimizer/lib/roles.mjs'

const STORAGE_BASE = 'https://jcbdjlqxmlsfqfenltws.supabase.co/storage/v1/object/public/assets/'

// Memory-Cache mit TTL: ein über Nacht offener Tab soll den frischen
// nächtlichen Build irgendwann sehen, ohne Hard-Reload (Critic-Fund)
const CACHE_TTL_MS = 30 * 60 * 1000
let memoryCache = null
let memoryCachedAt = 0

async function fetchGz(url) {
  const res = await fetch(url)
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
  // Gzip-Magic sniffen (0x1f 0x8b): dekomprimiert das CDN transparent
  // (Content-Encoding), kämen hier schon entpackte Bytes an — ein blindes
  // DecompressionStream würde werfen und still auf die 2,8-MB-Plain-Variante
  // degradieren (Critic-Fund). So funktionieren beide Auslieferungsarten.
  const buf = await res.arrayBuffer()
  const bytes = new Uint8Array(buf)
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))
    return new Response(stream).json()
  }
  return JSON.parse(new TextDecoder().decode(buf))
}

async function fetchPlain(url) {
  const res = await fetch(url)
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
  return res.json()
}

async function fetchAsset() {
  const canGunzip = typeof DecompressionStream === 'function'
  const attempts = []
  if (canGunzip) attempts.push(() => fetchGz(STORAGE_BASE + 'pool-slim.json.gz'))
  attempts.push(() => fetchPlain(STORAGE_BASE + 'pool-slim.json'))
  // Dev-/Notfall-Fallback: Vite-Public-Asset (import.meta.env nur hier anfassen —
  // node --test importiert dieses Modul für die pure searchByRole)
  const base = typeof import.meta.env !== 'undefined' ? import.meta.env.BASE_URL : '/'
  attempts.push(() => fetchPlain(`${base}pool-slim.json`))

  let lastErr = null
  for (const attempt of attempts) {
    try {
      return await attempt()
    } catch (err) {
      lastErr = err
    }
  }
  throw Object.assign(
    new Error('Pool-Asset nicht erreichbar — Supabase-Bucket "assets" fehlt/leer und kein lokales Asset.'),
    { code: 'pool-missing', cause: lastErr }
  )
}

export async function loadPool() {
  if (memoryCache && Date.now() - memoryCachedAt < CACHE_TTL_MS) return memoryCache
  const asset = await fetchAsset()
  if (!asset?.meta || !Array.isArray(asset.cards) || asset.cards.length < 1000) {
    throw Object.assign(new Error('Pool-Asset hat eine unerwartete Struktur.'), { code: 'pool-invalid' })
  }
  const warnings = []
  if (asset.meta.rolesVersion !== ROLES_VERSION) {
    warnings.push(
      `Empfehlungsdaten wurden mit einem älteren Regelstand gebaut (v${asset.meta.rolesVersion} statt v${ROLES_VERSION}) ` +
      '— Ergebnis kann abweichen; der nächste nächtliche Build behebt das.'
    )
  }
  memoryCache = { meta: asset.meta, cards: asset.cards, warnings }
  memoryCachedAt = Date.now()
  return memoryCache
}

// Pure Kandidatensuche auf Slim-Records (node-testbar).
// ci: Deck-Color-Identity als Array; Slim-ci ist ein String ("WUB").
export function searchByRole(pool, { role, ci, maxCmc = null, exclude = new Set(), limit = 12 } = {}) {
  const deckCI = new Set(ci || [])
  const out = []
  for (const card of pool.cards) {
    if (role && !card.r.includes(role)) continue
    if (maxCmc != null && card.c > maxCmc) continue
    if (exclude.has(card.n.toLowerCase())) continue
    if (![...card.ci].every(c => deckCI.has(c))) continue
    out.push(card)
    // Asset ist nach edhrec_rank vorsortiert — early-break ist hier korrekt
    if (out.length >= limit) break
  }
  return out
}

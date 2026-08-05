#!/usr/bin/env node
// build-pool-asset.mjs — schlankes Kandidaten-Pool-Asset für den Browser-Wizard.
//
// Usage:
//   node scripts/build-pool-asset.mjs [--out <dir>] [--refresh]
//
// Nimmt den Oracle-Bulk (cardpool.ensurePool), filtert auf isCandidate
// (commander-legal + Papier) und backt die ROLLEN zur Build-Zeit ein — damit
// fliegt oracle_text (der Größentreiber) komplett raus: ~19 MB Vollindex →
// ~2-3 MB raw / <1 MB gzipped. Der Client vergleicht meta.rolesVersion mit
// seiner importierten ROLES_VERSION (Drift ⇒ Warnbanner, Plan M5).
//
// Slim-Record: { n: name, r: roles[], ci: "WUB", c: cmc, t: typeCategory,
//               e: edhrec_rank, gc: game_changer, i: instantSpeedInteraction }
//
// Output: <out>/pool-slim.json + pool-slim.json.gz (beide Varianten — .gz für
// DecompressionStream-Clients, plain als Safari-<16.4-Fallback; Upload macht
// .github/workflows/build-pool-asset.yml in den Supabase-Storage-Bucket).

import { writeFile, mkdir } from 'node:fs/promises'
import { gzipSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ensurePool } from './optimizer/lib/cardpool.mjs'
import { isCandidate } from './optimizer/lib/pool-core.mjs'
import { classifyCard, isInteraction, isInstantSpeed, ROLES_VERSION } from './optimizer/lib/roles.mjs'
import { getTypeCategory } from '../src/utils.js'

// Pure + testbar: Pool-Record → Slim-Record (Rollen eingebacken)
export function toSlimRecord(record) {
  const roles = classifyCard(record)
  return {
    n: record.name,
    r: roles,
    ci: (record.color_identity || []).join(''),
    c: record.cmc ?? 0,
    t: getTypeCategory(record.type_line),
    e: record.edhrec_rank ?? null,
    gc: record.game_changer === true,
    i: isInteraction(roles) && isInstantSpeed(record),
  }
}

export function buildAsset(records, { now = new Date(), bulkUpdatedAt = null } = {}) {
  const slim = []
  for (const r of records) {
    if (!isCandidate(r)) continue
    slim.push(toSlimRecord(r))
  }
  // Populärste zuerst — der Client kann bei Bedarf früh abbrechen/anzeigen
  slim.sort((a, b) => (a.e ?? Infinity) - (b.e ?? Infinity))
  return {
    meta: {
      builtAt: now.toISOString(),
      bulkUpdatedAt,
      cardCount: slim.length,
      rolesVersion: ROLES_VERSION,
    },
    cards: slim,
  }
}

async function main() {
  const args = process.argv.slice(2)
  const outIdx = args.indexOf('--out')
  const outDir = outIdx >= 0 ? args[outIdx + 1] : fileURLToPath(new URL('./optimizer/.cache/', import.meta.url))
  const refresh = args.includes('--refresh')

  const { index, meta } = await ensurePool({ maxAgeHours: 24, refresh, log: console.error })
  const asset = buildAsset([...index.byName.values()], { bulkUpdatedAt: meta.bulkUpdatedAt })

  await mkdir(outDir, { recursive: true })
  const json = JSON.stringify(asset)
  const gz = gzipSync(Buffer.from(json), { level: 9 })
  const plainPath = `${outDir.replace(/\/$/, '')}/pool-slim.json`
  const gzPath = `${plainPath}.gz`
  await writeFile(plainPath, json)
  await writeFile(gzPath, gz)

  console.error(
    `Pool-Asset: ${asset.meta.cardCount} Kandidaten · rolesVersion ${asset.meta.rolesVersion} · ` +
    `${(json.length / 1024 / 1024).toFixed(2)} MB raw / ${(gz.length / 1024).toFixed(0)} KB gz\n` +
    `→ ${plainPath}\n→ ${gzPath}`
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(err => {
    console.error(`Fehler: ${err.message}`)
    process.exit(1)
  })
}

// fix-precon-printings.mjs — zieht die Karten von Precon-Decks auf die
// Printings ihres ECHTEN Sets um (scryfall_id + image_uri in `cards`).
//
// Hintergrund: Der Decklist-Import holt Karten per Namens-Lookup — Scryfall
// liefert dabei irgendein Printing (Fund 06.08.2026: das LTC-Precon zeigte
// auf otc/cma/c21/…). Für die Resterampe sollen Precons aber mit ihren
// exakten Printing-Preisen bewertet werden — dafür müssen die scryfall_ids
// stimmen.
//
// Das Set wird PRO DECK selbst erkannt (kein Mapping pflegen): das Set aus
// card_printings, das >= MIN_COVERAGE der Deck-Namen abdeckt, ist das
// Precon-Set. Erkennt keins die Schwelle, wird das Deck übersprungen.
//
// Usage:
//   SUPABASE_URL=… SUPABASE_KEY=… node scripts/fix-precon-printings.mjs [--apply]
//   (ohne --apply: Dry-Run, zeigt nur, was passieren würde)
//
// RUNBOOK: Am 06.08.2026 mit --apply gegen Prod gelaufen — alle 9 for_sale-
// Precons FIXED (0 SKIP, 0 ohne Ziel-Printing). Nach JEDEM neuen Precon-
// Import oder Karten-Tausch in einem Precon erneut ausführen, sonst bewertet
// die Resterampe die neue Karte mit dem Preis eines zufälligen Printings
// (der Showcase-Guard in applyPrintingPrices deckelt nur die Extremfälle).

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY
const APPLY = process.argv.includes('--apply')
// Haupt-Set muss die Mehrheit stellen (Schutz vor Nicht-Precons, die bei
// ~30% toppen); der Rest kommt greedy aus den nächstbesten Sets
const MIN_COVERAGE = 0.6

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL und SUPABASE_KEY setzen')
  process.exit(1)
}

async function rest(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${await res.text()}`)
  return res
}

// PostgREST in.()-Filter mit Quotes — Namen enthalten Kommas/Apostrophe
const inList = (names) => `in.(${names.map(n => `"${n.replaceAll('"', '\\"')}"`).join(',')})`

// Scryfall-Preise (EUR, usd*0.92-Fallback) per collection-by-id.
// User-Agent UND Accept sind fuer Skripte PFLICHT — ohne antwortet Scryfall 400.
// Lauf-weiter Cache (Staples tauchen in mehreren Precons auf) + Backoff bei 429.
const priceCache = new Map()

async function fetchScryfallPrices(ids) {
  const missing = [...new Set(ids.filter(Boolean))].filter(id => !priceCache.has(id))
  for (let i = 0; i < missing.length; i += 75) {
    await new Promise(r => setTimeout(r, 250))
    let res
    for (let attempt = 0; ; attempt++) {
      res = await fetch('https://api.scryfall.com/cards/collection', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'mtg-deck-tracker/1.0',
          Accept: 'application/json',
        },
        body: JSON.stringify({ identifiers: missing.slice(i, i + 75).map(id => ({ id })) }),
      })
      if (res.status !== 429 || attempt >= 3) break
      await new Promise(r => setTimeout(r, 2500 * (attempt + 1)))
    }
    if (!res.ok) throw new Error(`Scryfall collection: HTTP ${res.status}`)
    const data = await res.json()
    for (const card of data.data || []) {
      const p = card.prices || {}
      const eur = p.eur ?? (p.usd ? String(Number(p.usd) * 0.92) : null) ?? p.eur_foil
      priceCache.set(card.id, eur != null ? Number(eur) : null)
    }
  }
  return priceCache
}

async function fixDeck(deck) {
  const cardsRes = await rest(
    `cards?select=id,name,scryfall_id,quantity&deck_id=eq.${deck.id}`
  )
  const cards = await cardsRes.json()
  const names = [...new Set(cards.map(c => c.name))]

  // Paginiert: 87 Namen x ~20 Printings sprengen das 1000-Row-Cap von
  // PostgREST — ohne Pagination ist die Set-Coverage still abgeschnitten
  const printings = []
  const PAGE = 1000
  for (let offset = 0; ; offset += PAGE) {
    const res = await rest(
      `card_printings?select=name,scryfall_id,set_code,set_name,image_normal&name=${encodeURIComponent(inList(names))}` +
      `&order=scryfall_id&limit=${PAGE}&offset=${offset}`
    )
    const page = await res.json()
    printings.push(...page)
    if (page.length < PAGE) break
  }

  // Set-Erkennung: welches Set deckt die meisten Deck-Namen ab? Precons
  // mischen oft ZWEI Sets (Fund: Tales-Precons = ltc-Neuheiten + ltr-Haupt-
  // set-Karten/Basics) — deshalb GREEDY: Haupt-Set zuerst, ungedeckte Namen
  // aus dem nächstbesten Set usw.
  const coverage = new Map() // set_code -> Set<name>
  for (const p of printings) {
    if (!coverage.has(p.set_code)) coverage.set(p.set_code, new Set())
    coverage.get(p.set_code).add(p.name)
  }
  const ranked = [...coverage.entries()]
    .map(([set, covered]) => ({ set, covered }))
    .sort((a, b) => b.covered.size - a.covered.size)
  const best = ranked[0]
  if (!best || best.covered.size < names.length * MIN_COVERAGE) {
    console.log(`SKIP  ${deck.name}: bestes Set ${best?.set ?? '—'} deckt nur ` +
      `${best?.covered.size ?? 0}/${names.length} Namen (< ${Math.round(MIN_COVERAGE * 100)}%)`)
    return
  }

  // Greedy-Zuordnung: je Name ALLE Kandidaten aus dem bestplatzierten Set,
  // das ihn abdeckt — Sets wie LTC führen unter EINEM Namen auch teure
  // Showcase-/Sammler-Varianten (Fund: 602-€-Sol-Ring). Welcher Kandidat der
  // Precon-Print ist, entscheidet danach der GÜNSTIGSTE Scryfall-Preis.
  const byNameSet = new Map() // `${name}|${set}` -> [printings]
  for (const p of printings) {
    const key = `${p.name}|${p.set_code}`
    if (!byNameSet.has(key)) byNameSet.set(key, [])
    byNameSet.get(key).push(p)
  }
  // Kandidaten: Haupt-Set wenn es den Namen führt — sonst ALLE Printings des
  // Namens (der Preis entscheidet dann). Ein Ranking der Neben-Sets wäre
  // fragil: Secret-Lair-Staple-Überschneidungen rankten sonst vor dem echten
  // Zweit-Set (Fund: Shire Terrace bekam die 11,82-€-SLD- statt der
  // 0,11-€-ltr-Variante).
  const byName = new Map() // name -> [alle printings]
  for (const p of printings) {
    if (!byName.has(p.name)) byName.set(p.name, [])
    byName.get(p.name).push(p)
  }
  const candidates = new Map() // name -> [printings]
  const usedSets = new Map() // set|'other' -> count (für den Report)
  for (const name of names) {
    const inMain = byNameSet.get(`${name}|${best.set}`)
    candidates.set(name, inMain ?? byName.get(name) ?? [])
    const bucket = inMain ? best.set : 'other'
    usedSets.set(bucket, (usedSets.get(bucket) || 0) + 1)
  }

  // Preise NUR fuer Namen mit MEHREREN Kandidaten holen (429-Schutz) —
  // Einzel-Kandidaten brauchen keine Preis-Entscheidung
  const needPricing = [...candidates.values()].filter(l => l.length > 1).flat().map(p => p.scryfall_id)
  const eurById = await fetchScryfallPrices(needPricing)

  // Ziel-Printing = günstigster Kandidat (Precon-Print = Bulk-Variante);
  // alle ohne Preis → erster Kandidat als Fallback
  const target = new Map()
  for (const [name, list] of candidates) {
    const priced = list
      .map(p => ({ p, eur: eurById.get(p.scryfall_id) }))
      .filter(x => x.eur != null)
      .sort((a, b) => a.eur - b.eur)
    target.set(name, priced[0]?.p ?? list[0])
  }

  let toUpdate = 0
  let already = 0
  let noTarget = 0
  for (const c of cards) {
    const t = target.get(c.name)
    if (!t) { noTarget++; continue }
    if (c.scryfall_id === t.scryfall_id) { already++; continue }
    toUpdate++
    if (APPLY) {
      await rest(`cards?id=eq.${c.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: { scryfall_id: t.scryfall_id, image_uri: t.image_normal },
      })
    }
  }
  const setName = printings.find(p => p.set_code === best.set)?.set_name || best.set
  const dist = [...usedSets.entries()].map(([s, n]) => `${s}:${n}`).join(' ')
  console.log(`${APPLY ? 'FIXED' : 'DRY  '} ${deck.name}: Haupt-Set ${best.set} (${setName}) — ` +
    `${toUpdate} umgezogen, ${already} stimmten schon, ${noTarget} ohne Ziel-Printing [${dist}]`)
}

// NUR die Resterampe-Precons — deck_type ist bei Alt-Decks der Default-Wert
// 'precon', erst for_sale grenzt auf die echten Precons ein (Fund im Dry-Run)
const decksRes = await rest(`decks?select=id,name&deck_type=eq.precon&for_sale=eq.true&order=name`)
const decks = await decksRes.json()
console.log(`${decks.length} Precon-Decks${APPLY ? '' : ' (DRY-RUN — mit --apply anwenden)'}\n`)
let failed = 0
for (const d of decks) {
  try {
    await fixDeck(d)
  } catch (err) {
    // Ein Deck-Fehler (transienter 429/Netz) darf die restlichen Decks
    // nicht abreissen (Critic) — Re-Run ist idempotent
    failed++
    console.error(`FEHLER ${d.name}: ${err.message}`)
  }
}
if (failed) {
  console.error(`\n${failed} Deck(s) fehlgeschlagen — Re-Run holt sie nach.`)
  process.exit(1)
}

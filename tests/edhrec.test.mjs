// edhrec.test.mjs — Slugs, Parser und Import-Serialisierung des EDHREC-Moduls.
// Die Fixtures sind GEKÜRZTE ECHTE Responses (05.08.2026) — bricht EDHREC die
// Struktur, schlagen diese Tests beim nächsten Fixture-Refresh sichtbar fehl.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  edhrecSlug, partnerSlug, parseEdhrecDeckStrings,
  extractAverageDeck, extractDeckTable, extractDeckPreview,
  serializeDeckForImport,
  parseTopCommanders, colorPageSlug, commanderImageUrl, isPartnerPairName,
} from '../src/edhrec.js'

const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

// --- Slugs ---

test('edhrecSlug: Kommas, Apostrophe, Umlaute, DFC-Front-Face', () => {
  assert.equal(edhrecSlug("Atraxa, Praetors' Voice"), 'atraxa-praetors-voice')
  assert.equal(edhrecSlug("K'rrik, Son of Yawgmoth"), 'krrik-son-of-yawgmoth')
  assert.equal(edhrecSlug('Jötun Grunt'), 'jotun-grunt')
  assert.equal(edhrecSlug('Esika, God of the Tree // The Prismatic Bridge'), 'esika-god-of-the-tree')
  assert.equal(edhrecSlug('  Weird   Spacing  '), 'weird-spacing')
})

test('partnerSlug: alphabetische Ordnung ist kanonisch (live verifiziert)', () => {
  const a = partnerSlug('Tymna the Weaver', 'Thrasios, Triton Hero')
  const b = partnerSlug('Thrasios, Triton Hero', 'Tymna the Weaver')
  assert.equal(a, b)
  assert.equal(a, 'thrasios-triton-hero-tymna-the-weaver')
})

// --- Parser (echte Fixture-Strukturen) ---

test('extractAverageDeck: Kategorien-Dict wird zu flacher {name, quantity}-Liste', async () => {
  const json = await fixture('edhrec-average-deck.json')
  const { commanders, cards } = extractAverageDeck(json)
  assert.deepEqual(commanders, ["Atraxa, Praetors' Voice"])
  assert.equal(cards.length, 21) // 7 Kategorien × 3 (gekürzte Fixture)
  assert.ok(cards.every(c => typeof c.name === 'string' && c.quantity >= 1))
  assert.ok(cards.some(c => c.name === 'Arcane Signet'))
})

test('extractAverageDeck: kaputte Struktur wirft statt still leer', () => {
  assert.throws(() => extractAverageDeck({}), /unerwartete Struktur/)
  assert.throws(() => extractAverageDeck({ deck: { cards: {} } }), /leer/)
})

test('extractDeckTable: trimmt auf topN und behält nur die gebrauchten Felder', async () => {
  const json = await fixture('edhrec-decks-table.json')
  const rows = extractDeckTable(json, 2)
  assert.equal(rows.length, 2)
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ['bracket', 'price', 'salt', 'savedate', 'tags', 'types', 'urlhash'])
    assert.equal(typeof r.urlhash, 'string')
    assert.ok(Array.isArray(r.tags))
    assert.deepEqual(Object.keys(r.types).sort(),
      ['artifact', 'battle', 'creature', 'enchantment', 'instant', 'land', 'planeswalker', 'sorcery'])
  }
})

test('extractDeckTable: tags/types streng typgeprüft (nie roh ins innerHTML)', () => {
  const rows = extractDeckTable({
    table: [{
      urlhash: 'abc',
      tags: ['Reanimator', 42, { evil: true }, 'Cascade'],
      creature: 21, land: '33', instant: 8,
    }],
  }, 5)
  assert.deepEqual(rows[0].tags, ['Reanimator', 'Cascade'], 'Nicht-Strings fliegen raus')
  assert.equal(rows[0].types.creature, 21)
  assert.equal(rows[0].types.land, null, 'String-Zahl wird nicht durchgereicht')
  assert.equal(rows[0].types.instant, 8)
  // Tag-Kappung: max 4, überlange Strings raus
  const many = extractDeckTable({
    table: [{ urlhash: 'x', tags: ['a', 'b', 'c', 'd', 'e', 'x'.repeat(60)] }],
  }, 5)
  assert.deepEqual(many[0].tags, ['a', 'b', 'c', 'd'])
})

test('extractDeckTable: fehlende table → leere Liste (kein Crash)', () => {
  assert.deepEqual(extractDeckTable({ redirect: '/decks/x' }, 5), [])
})

test('extractDeckPreview: "1 Name"-Strings → {quantity, name}, Meta bleibt', async () => {
  const json = await fixture('edhrec-deckpreview.json')
  const p = extractDeckPreview(json)
  assert.deepEqual(p.commanders, ['Thrasios, Triton Hero', 'Tymna the Weaver'])
  assert.equal(p.cards.length, 12)
  assert.deepEqual(p.cards[0], { quantity: 1, name: 'Thrasios, Triton Hero' })
  assert.ok(p.url.startsWith('https://'))
  assert.equal(typeof p.price, 'number')
})

test('parseEdhrecDeckStrings: Mengen und Sonderzeichen-Namen', () => {
  const cards = parseEdhrecDeckStrings(['4 Forest', "1 An Offer You Can't Refuse"])
  assert.deepEqual(cards, [
    { quantity: 4, name: 'Forest' },
    { quantity: 1, name: "An Offer You Can't Refuse" },
  ])
})

test('parseEdhrecPage: cardlists → flache Empfehlungsliste mit Inclusion% und Synergy', async () => {
  const json = await fixture('edhrec-commander-page.json')
  const { parseEdhrecPage } = await import('../src/edhrec.js')
  const recs = parseEdhrecPage(json)
  assert.ok(recs.length >= 6) // 3 Listen × 3 (gekürzte echte Fixture)
  for (const r of recs) {
    assert.equal(typeof r.name, 'string')
    assert.ok(r.inclusionPct === null || (r.inclusionPct >= 0 && r.inclusionPct <= 100))
    assert.equal(typeof r.listHeader, 'string')
  }
  // num_decks/potential_decks → gerundete Prozent
  const withPct = recs.find(r => r.inclusionPct !== null)
  assert.ok(withPct, 'mindestens ein Eintrag mit Inclusion%')
})

test('parseEdhrecPage: kaputte/leere Struktur → leere Liste, kein Crash', async () => {
  const { parseEdhrecPage } = await import('../src/edhrec.js')
  assert.deepEqual(parseEdhrecPage({}), [])
  assert.deepEqual(parseEdhrecPage({ container: { json_dict: {} } }), [])
})

// --- Import-Serialisierung ---

test('serializeDeckForImport: Commander markiert, aus cards dedupliziert', () => {
  const list = serializeDeckForImport({
    commanders: ['Thrasios, Triton Hero', 'Tymna the Weaver'],
    cards: [
      { quantity: 1, name: 'Thrasios, Triton Hero' }, // Preview enthält Commander
      { quantity: 1, name: 'Sol Ring' },
      { quantity: 4, name: 'Forest' },
    ],
  })
  const lines = list.split('\n')
  assert.equal(lines[0], '1 Thrasios, Triton Hero # !Commander')
  assert.equal(lines[1], '1 Tymna the Weaver # !Commander')
  assert.deepEqual(lines.slice(2), ['1 Sol Ring', '4 Forest'])
  // Commander taucht NICHT doppelt auf
  assert.equal(lines.filter(l => l.includes('Thrasios')).length, 1)
})

// --- Top-Commander-Landing (Scan v2) ---

test('parseTopCommanders: echte Fixture → Name, Slug, Scryfall-ID, Decks, Rank', async () => {
  const json = await fixture('edhrec-top-commanders.json')
  const { header, commanders } = parseTopCommanders(json)
  assert.equal(header, 'Past Week')
  assert.equal(commanders.length, 5)
  const first = commanders[0]
  assert.equal(first.name, "Y'shtola, Night's Blessed")
  assert.equal(first.slug, 'yshtola-nights-blessed')
  assert.match(first.scryfallId, /^[0-9a-f-]{36}$/)
  assert.equal(first.numDecks, 1924)
  assert.equal(first.rank, 1)
})

test('parseTopCommanders: kaputte Struktur wirft (wie die Schwester-Parser)', async () => {
  assert.throws(() => parseTopCommanders(null))
  assert.throws(() => parseTopCommanders({ container: { json_dict: { cardlists: [] } } }))
  assert.throws(() => parseTopCommanders({ container: { json_dict: { cardlists: [{ cardviews: [{ nope: 1 }] }] } } }))
})

test('parseTopCommanders: Einträge ohne ID bleiben drin (Bild-Fallback), ohne Namen fliegen raus', () => {
  const json = { container: { json_dict: { cardlists: [{ header: 'X', cardviews: [
    { name: 'Mit ID', id: 'c7f2c2d5-e052-49e8-b5de-712858c2ea78', num_decks: 5, rank: 1 },
    { name: 'Ohne ID', num_decks: 3, rank: 2 },
    { id: 'nur-id-kein-name' },
  ] }] } } }
  const { commanders } = parseTopCommanders(json)
  assert.equal(commanders.length, 2)
  assert.equal(commanders[1].scryfallId, null)
})

test('colorPageSlug: kanonische EDHREC-Farbrad-Slugs (live verifiziert), C exklusiv', () => {
  assert.equal(colorPageSlug(['u', 'w']), 'wu')      // Azorius
  assert.equal(colorPageSlug(['u', 'g']), 'gu')      // Simic — 'ug' wäre 403!
  assert.equal(colorPageSlug(['w', 'r']), 'rw')      // Boros — 'wr' wäre 403!
  assert.equal(colorPageSlug(['g', 'B', 'w']), 'wbg') // Abzan
  assert.equal(colorPageSlug(['g', 'w', 'u']), 'gwu') // Bant
  assert.equal(colorPageSlug(['r', 'g', 'w', 'u']), 'rgwu') // Ink-Treader
  assert.equal(colorPageSlug(['w', 'u', 'b', 'r', 'g']), 'wubrg')
  assert.equal(colorPageSlug(['c']), 'colorless')
  assert.equal(colorPageSlug(['c', 'w']), 'colorless')
  assert.equal(colorPageSlug([]), null)
  assert.equal(colorPageSlug(null), null)
})

test('commanderImageUrl: CDN-Muster nur für echte UUIDs', () => {
  const id = 'c7f2c2d5-e052-49e8-b5de-712858c2ea78'
  assert.equal(
    commanderImageUrl(id),
    `https://cards.scryfall.io/normal/front/c/7/${id}.jpg`
  )
  assert.equal(commanderImageUrl('nicht-uuid'), null)
  assert.equal(commanderImageUrl(null), null)
  // Pfad-Injection über ein manipuliertes id-Feld bleibt draußen
  assert.equal(commanderImageUrl('../../evil'), null)
})

test('isPartnerPairName: Partner-Paar vs. einzelne DFC (Slug entscheidet)', () => {
  // Paar: Slug = verbundene Einzel-Slugs ≠ Front-Face-Slug
  assert.equal(isPartnerPairName(
    'Thrasios, Triton Hero // Tymna the Weaver',
    'thrasios-triton-hero-tymna-the-weaver'
  ), true)
  // DFC: Slug = Front-Face-Slug
  assert.equal(isPartnerPairName(
    'Esika, God of the Tree // The Prismatic Bridge',
    'esika-god-of-the-tree'
  ), false)
  assert.equal(isPartnerPairName('Sol Ring', 'sol-ring'), false)
  assert.equal(isPartnerPairName('A // B', null), false)
  assert.equal(isPartnerPairName(null, 'x'), false)
})

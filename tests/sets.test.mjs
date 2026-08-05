// sets.test.mjs — pure Helfer des /preise-Set-Browsers.
// Fixtures sind GEKÜRZTE ECHTE Scryfall-Responses (05.08.2026): ändert
// Scryfall die Struktur, fallen diese Tests beim Fixture-Refresh sichtbar um.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  slimSet, filterSets, groupSetsByYear, setSearchUrl, extractSetCardsPage, mergeOurPrices,
  BROWSER_SET_TYPES,
} from '../src/sets.js'

const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'))

const mk = (over = {}) => ({
  code: 'xxx', name: 'Test Set', setType: 'expansion', released: '2024-01-01',
  cardCount: 100, digital: false, icon: null, ...over,
})

// --- slimSet ---

test('slimSet: echte API-Sets → schlankes Shape', async () => {
  const { data } = await fixture('scryfall-sets.json')
  const s = slimSet(data[0])
  assert.deepEqual(Object.keys(s).sort(), ['cardCount', 'code', 'digital', 'icon', 'name', 'released', 'setType'].sort())
  assert.equal(typeof s.code, 'string')
  assert.equal(typeof s.cardCount, 'number')
  // fehlende Felder crashen nicht
  const empty = slimSet({ code: 'x', name: 'X', set_type: 'core' })
  assert.equal(empty.released, null)
  assert.equal(empty.cardCount, 0)
})

// --- filterSets ---

test('filterSets: digital und leere Sets fliegen IMMER raus', () => {
  const sets = [mk(), mk({ code: 'dig', digital: true }), mk({ code: 'leer', cardCount: 0 })]
  const out = filterSets(sets)
  assert.deepEqual(out.map(s => s.code), ['xxx'])
  // auch mit Suche und showAll bleiben sie draußen
  assert.equal(filterSets(sets, { query: 'dig', showAll: true }).length, 0)
})

test('filterSets: ohne Suche nur kuratierte Typen, showAll zeigt alle', () => {
  const sets = [mk(), mk({ code: 'prm', setType: 'promo' }), mk({ code: 'tok', setType: 'token' })]
  assert.deepEqual(filterSets(sets).map(s => s.code), ['xxx'])
  assert.equal(filterSets(sets, { showAll: true }).length, 3)
  assert.ok(BROWSER_SET_TYPES.has('expansion') && !BROWSER_SET_TYPES.has('promo'))
})

test('filterSets: Suche durchsucht ALLE non-digitalen Sets (Name + Code, case-insensitiv)', () => {
  const sets = [
    mk({ code: 'neo', name: 'Kamigawa: Neon Dynasty' }),
    mk({ code: 'pneo', name: 'Neon Dynasty Promos', setType: 'promo' }),
  ]
  assert.equal(filterSets(sets, { query: 'neon' }).length, 2) // Promo trotz Kuratierung
  assert.deepEqual(filterSets(sets, { query: 'PNEO' }).map(s => s.code), ['pneo'])
  assert.equal(filterSets(sets, { query: 'zzz' }).length, 0)
})

test('filterSets: Sortierung released desc, ohne Datum zuletzt', () => {
  const sets = [
    mk({ code: 'alt', released: '2000-05-01' }),
    mk({ code: 'neu', released: '2026-01-01' }),
    mk({ code: 'ohne', released: null }),
    mk({ code: 'mitte', released: '2015-06-01' }),
  ]
  assert.deepEqual(filterSets(sets, { showAll: true }).map(s => s.code), ['neu', 'mitte', 'alt', 'ohne'])
})

test('groupSetsByYear: Jahre absteigend, INNERHALB des Jahres chronologisch (Jan→Dez)', () => {
  const sorted = filterSets([
    mk({ code: 'a26', released: '2026-03-01' }),
    mk({ code: 'b26', released: '2026-01-01' }),
    mk({ code: 'c24', released: '2024-06-01' }),
    mk({ code: 'ohne', released: null }),
  ], { showAll: true })
  const groups = groupSetsByYear(sorted)
  assert.deepEqual(groups.map(g => g.year), ['2026', '2024', 'Ohne Datum'])
  // chronologisch im Jahr: Januar vor März (User-Ansage)
  assert.deepEqual(groups[0].sets.map(s => s.code), ['b26', 'a26'])
  assert.deepEqual(groupSetsByYear([]), [])
})

// --- setSearchUrl ---

test('setSearchUrl: game:paper hält Alchemy-Rebalances draußen (live gesehen bei e:neo)', () => {
  const url = setSearchUrl('neo')
  assert.ok(url.startsWith('https://api.scryfall.com/cards/search?q='))
  assert.ok(url.includes(encodeURIComponent('e:neo game:paper')))
  assert.ok(url.includes('unique=prints'))
  assert.ok(url.includes('order=set'))
})

// --- extractSetCardsPage ---

test('extractSetCardsPage: echte Fixture — digital-Skip, DFC-Front-Bild, Pagination', async () => {
  const json = await fixture('scryfall-set-search.json')
  const page = extractSetCardsPage(json)
  // Fixture hat 4 Karten, eine davon digital (A-Ancestral Katana) → 3
  assert.equal(page.cards.length, 3)
  assert.ok(!page.cards.some(c => c.name.startsWith('A-')))
  // DFC: Bild kommt aus card_faces[0]
  const dfc = page.cards.find(c => c.name.includes(' // '))
  assert.ok(dfc, 'DFC in der Fixture erwartet')
  assert.ok(dfc.image, 'DFC braucht ein Front-Face-Bild')
  assert.ok(page.cards.every(c => typeof c.collector === 'string'))
  assert.equal(page.hasMore, true)
  assert.ok(page.nextPage.includes('scryfall'))
  assert.equal(page.totalCards, json.total_cards)
})

test('extractSetCardsPage: kaputte Struktur wirft, leere Liste ist ok', () => {
  assert.throws(() => extractSetCardsPage(null))
  assert.throws(() => extractSetCardsPage({ data: 'nope' }))
  const empty = extractSetCardsPage({ object: 'list', data: [], has_more: false, total_cards: 0 })
  assert.deepEqual(empty, { cards: [], hasMore: false, nextPage: null, totalCards: 0 })
})

// --- mergeOurPrices ---

test('mergeOurPrices: Treffer bekommen ourPrice, Misses ehrlich null (nie 0)', () => {
  const cards = [{ name: 'Sol Ring' }, { name: 'Obskure Karte' }]
  const lookup = new Map([['Sol Ring', { price: 1.23, isFoil: true }]])
  const [hit, miss] = mergeOurPrices(cards, lookup)
  assert.equal(hit.ourPrice, 1.23)
  assert.equal(hit.isFoil, true)
  assert.equal(miss.ourPrice, null)
  assert.equal(miss.isFoil, false)
  // lookup null (Preise noch nicht geladen) crasht nicht
  assert.equal(mergeOurPrices(cards, null)[0].ourPrice, null)
})

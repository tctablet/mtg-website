import { chromium } from 'playwright-core'

const BASE = 'http://localhost:4173/mtg-website'
const DECK_ID = 'bde62ee1-74c7-4798-9677-0a25e4b2baa0'
const PLAYER_ID = '4669a98d-e04a-422b-b770-6fa0bab8522f'
const results = []
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)

const browser = await chromium.launch({ headless: true })

async function newPage() {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.addInitScript(([pid]) => {
    localStorage.clear()
    localStorage.setItem('mtg_player', JSON.stringify({ id: pid, name: 'E2E', is_admin: false }))
  }, [PLAYER_ID])
  return { ctx, page }
}

async function openPicker(page) {
  await page.goto(`${BASE}/deck/${DECK_ID}`)
  await page.waitForSelector('.deck-tabs', { timeout: 15000 })
  await page.click('[data-tab="proxy"]')
  await page.waitForSelector('.proxy-card', { timeout: 15000 })
  await page.click('.proxy-card')
  await page.waitForSelector('#artwork-picker-modal .artwork-picker-grid', { timeout: 15000 })
}

// ---------- Test A: DB-Pfad (card_printings route-gemockt) ----------
{
  const { ctx, page } = await newPage()
  const scryfallSearches = []
  page.on('request', (r) => { if (r.url().includes('api.scryfall.com/cards/search')) scryfallSearches.push(r.url()) })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.route('**/rest/v1/card_printings*', (route) => {
    const url = new URL(route.request().url())
    const inFilter = url.searchParams.get('name') || ''
    const m = inFilter.match(/^in\.\((.*)\)$/s)
    // PostgREST quotet Werte mit Komma: in.("A, B","C") — quote-bewusst parsen
    const names = m
      ? [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"|([^,]+)/g)].map((x) => (x[1] ?? x[2]).trim()).filter(Boolean)
      : []
    const rows = names.map((name, i) => ({
      scryfall_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      name,
      set_code: 'mck',
      set_name: 'Mock Set',
      released_at: '2024-01-01',
      image_small: 'https://cards.scryfall.io/small/front/0/0/mock.jpg',
      image_normal: 'https://cards.scryfall.io/normal/front/0/0/mock.jpg',
      image_png: 'https://cards.scryfall.io/png/front/0/0/mock.png',
    }))
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) })
  })

  await openPicker(page)
  await page.waitForSelector('.artwork-option', { timeout: 10000 })
  const setLabel = await page.textContent('.artwork-option .artwork-option-set')
  const optionCount = await page.locator('.artwork-option').count()
  check('A: Picker rendert aus DB-Fixture', optionCount >= 1 && (setLabel || '').includes('Mock Set'), `options=${optionCount} set="${(setLabel || '').trim()}"`)
  check('A: kein Scryfall cards/search noetig', scryfallSearches.length === 0, `${scryfallSearches.length} Requests: ${scryfallSearches[0] || ''}`)
  check('A: keine Page-Errors', errors.length === 0, errors.join('; '))
  await ctx.close()
}

// ---------- Test B: Fallback-Pfad (Tabelle existiert live nicht) ----------
{
  const { ctx, page } = await newPage()
  const warns = []
  page.on('console', (msg) => { if (msg.type() === 'warning' || msg.type() === 'warn') warns.push(msg.text()) })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))

  await openPicker(page)
  await page.waitForSelector('.artwork-option', { timeout: 20000 })
  const optionCount = await page.locator('.artwork-option').count()
  check('B: Picker rendert via Scryfall-Fallback', optionCount >= 1, `options=${optionCount}`)
  check('B: card_printings-Fehler nur als console.warn', warns.some((w) => w.includes('card_printings')), warns.slice(0, 2).join(' | '))
  check('B: keine Page-Errors', errors.length === 0, errors.join('; '))
  await ctx.close()
}

// ---------- Test C: >1000 Rows pro Chunk — Pagination muss greifen ----------
{
  const { ctx, page } = await newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const PER_NAME = 15
  const printingsRequests = []

  await page.route('**/rest/v1/card_printings*', (route) => {
    const url = new URL(route.request().url())
    const inFilter = url.searchParams.get('name') || ''
    const m = inFilter.match(/^in\.\((.*)\)$/s)
    const names = m
      ? [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"|([^,]+)/g)].map((x) => (x[1] ?? x[2]).trim()).filter(Boolean)
      : []
    // Alle Rows über alle Namen, PER_NAME pro Name → bei ~96 Namen >1000 gesamt
    const all = names.flatMap((name, j) =>
      Array.from({ length: PER_NAME }, (_, k) => ({
        scryfall_id: `00000000-0000-4000-8000-${String(j * 100 + k).padStart(12, '0')}`,
        name,
        set_code: 'mck',
        set_name: `Mock Set ${k + 1}`,
        released_at: `20${String(10 + k).padStart(2, '0')}-01-01`,
        image_small: 'https://cards.scryfall.io/small/front/0/0/mock.jpg',
        image_normal: 'https://cards.scryfall.io/normal/front/0/0/mock.jpg',
        image_png: 'https://cards.scryfall.io/png/front/0/0/mock.png',
      })))
    // PostgREST-Cap simulieren: offset/limit aus Query oder Range-Header, hart 1000
    const headers = route.request().headers()
    let offset = parseInt(url.searchParams.get('offset') || '0', 10)
    let limit = parseInt(url.searchParams.get('limit') || '9999', 10)
    if (headers['range']) {
      const [a, b] = headers['range'].split('-').map(Number)
      if (Number.isFinite(a)) { offset = a; limit = b - a + 1 }
    }
    const pageRows = all.slice(offset, offset + Math.min(limit, 1000))
    printingsRequests.push({ offset, served: pageRows.length, total: all.length })
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(pageRows) })
  })

  await page.goto(`${BASE}/deck/${DECK_ID}`)
  await page.waitForSelector('.deck-tabs', { timeout: 15000 })
  await page.click('[data-tab="proxy"]')
  await page.waitForSelector('.proxy-card', { timeout: 15000 })
  // Warten bis der Prefetch beide Seiten gezogen hat
  await page.waitForFunction(() => true, null, { timeout: 1000 }).catch(() => {})
  await page.waitForTimeout(1500)

  const paged = printingsRequests.filter((r) => r.offset > 0)
  check('C: Pagination angefordert (offset>0)', paged.length >= 1, JSON.stringify(printingsRequests.slice(0, 4)))

  // Picker auf der LETZTEN Nicht-Basic-Karte — deren Rows kamen erst auf Seite 2
  const lastName = await page.evaluate(() => {
    const basics = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes'])
    const cards = [...document.querySelectorAll('.proxy-card')]
    for (let i = cards.length - 1; i >= 0; i--) {
      if (!basics.has(cards[i].dataset.cardName)) { cards[i].click(); return cards[i].dataset.cardName }
    }
    return null
  })
  await page.waitForSelector('#artwork-picker-modal .artwork-option', { timeout: 10000 })
  const optionCount = await page.locator('.artwork-option:not(.artwork-reset)').count()
  check('C: letzte Karte hat alle Printings aus Seite 2', optionCount === PER_NAME, `"${lastName}": ${optionCount}/${PER_NAME}`)
  check('C: keine Page-Errors', errors.length === 0, errors.join('; '))
  await ctx.close()
}

await browser.close()
console.log(results.join('\n'))
if (results.some((r) => r.startsWith('FAIL'))) process.exit(1)

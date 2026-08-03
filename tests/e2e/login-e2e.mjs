import { chromium } from 'playwright-core'

const BASE = 'http://localhost:4173/mtg-website'
const results = []
const check = (n, ok, d = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`)

const browser = await chromium.launch({ headless: true })

// Test D1: Auto-Submit bei 4. Ziffer, Login-Erfolg (players-Query gemockt)
{
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/rest/v1/players*', (route) => {
    const accept = route.request().headers()['accept'] || ''
    const player = { id: 'e2e-player', name: 'E2E', code: '1234', is_admin: false }
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(accept.includes('pgrst.object') ? player : [player]),
    })
  })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto(`${BASE}/login`)
  await page.waitForSelector('#code-input', { timeout: 10000 })
  await page.type('#code-input', '1234', { delay: 60 })
  await page.waitForURL('**/my-decks', { timeout: 8000 })
  check('D1: 4. Ziffer loggt automatisch ein', page.url().endsWith('/my-decks'), page.url())
  check('D1: keine Page-Errors', errors.length === 0, errors.join('; '))
  await ctx.close()
}

// Test D2: unbekannter Code -> Fehlertext, Feld geleert, Button wieder aktiv
{
  const ctx = await browser.newContext()
  const page = await ctx.newPage()
  await page.addInitScript(() => localStorage.clear())
  await page.route('**/rest/v1/players*', (route) => {
    route.fulfill({ status: 406, contentType: 'application/json', body: JSON.stringify({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }) })
  })
  await page.goto(`${BASE}/login`)
  await page.waitForSelector('#code-input', { timeout: 10000 })
  await page.type('#code-input', '9999', { delay: 60 })
  await page.waitForSelector('#login-error:not([hidden])', { timeout: 8000 })
  const errText = (await page.textContent('#login-error')).trim()
  const inputVal = await page.inputValue('#code-input')
  const btnDisabled = await page.locator('#login-btn').isDisabled()
  check('D2: Fehlertext sichtbar', errText.length > 0, errText)
  check('D2: Feld geleert, Button aktiv', inputVal === '' && !btnDisabled, `val="${inputVal}" disabled=${btnDisabled}`)
  await ctx.close()
}

await browser.close()
console.log(results.join('\n'))
if (results.some((r) => r.startsWith('FAIL'))) process.exit(1)

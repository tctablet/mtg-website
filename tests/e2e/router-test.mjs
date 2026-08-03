import { chromium } from 'playwright-core'

const BASE = 'http://localhost:4173/mtg-website'
const results = []
const check = (name, ok, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
page.on('pageerror', (err) => results.push(`PAGEERROR: ${err.message}`))

// 1. Startseite → rendert Resterampe
await page.goto(BASE + '/')
await page.waitForSelector('#content h2, #content p', { timeout: 10000 })
const h1 = await page.textContent('#content')
check('Startseite rendert', h1.length > 0, (await page.url()))

// 2. Nav-Link-Klick → clean URL ohne #
await page.click('a[href="/mtg-website/login"]')
await page.waitForSelector('#content', { timeout: 5000 })
await page.waitForTimeout(300)
check('Klick auf Login-Link → clean URL', page.url() === BASE + '/login', page.url())

// 3. Deep-Link-Reload auf /login (SPA-Fallback des Preview-Servers)
await page.goto(BASE + '/login')
await page.waitForTimeout(500)
const loginContent = await page.textContent('#content')
check('Deep-Link /login rendert', loginContent.trim().length > 0, page.url())

// 4. Alte Hash-URL wird umgeschrieben
await page.goto(BASE + '/#/login')
await page.waitForTimeout(500)
check('Alter Hash-Link #/login → /login', page.url() === BASE + '/login', page.url())

// 5. 404.html-Decode-Snippet: ?/login → /login
await page.goto(BASE + '/?/login')
await page.waitForTimeout(500)
check('?/login (404-Fallback) → /login', page.url() === BASE + '/login', page.url())

// 6. Back-Button (popstate)
await page.goto(BASE + '/')
await page.waitForTimeout(300)
await page.click('a[href="/mtg-website/login"]')
await page.waitForTimeout(300)
await page.goBack()
await page.waitForTimeout(300)
const backContent = await page.textContent('#content')
check('Back-Button rendert Vorseite', page.url() === BASE + '/' && backContent.trim().length > 0, page.url())

// 7. Unbekannte Route → "Seite nicht gefunden"
await page.goto(BASE + '/gibtsnicht')
await page.waitForTimeout(500)
const nf = await page.textContent('#content')
check('Unbekannte Route → 404-Text', nf.includes('nicht gefunden'), nf.trim().slice(0, 40))

// 8. Screenshot der Startseite für visuelle Kontrolle
await page.goto(BASE + '/')
await page.waitForTimeout(800)
await page.screenshot({ path: new URL('./router-test-home.png', import.meta.url).pathname })

await browser.close()
console.log(results.join('\n'))

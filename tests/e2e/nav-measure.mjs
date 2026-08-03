import { chromium } from 'playwright-core'

const BASE = 'http://localhost:4173/mtg-website'
const PLAYER_ID = '4669a98d-e04a-422b-b770-6fa0bab8522f'
const results = []
const check = (n, ok, d = '') => results.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`)

const browser = await chromium.launch({ headless: true })

for (const width of [390, 375]) {
  const ctx = await browser.newContext({ viewport: { width, height: 844 } })
  const page = await ctx.newPage()
  await page.addInitScript(([pid]) => {
    localStorage.clear()
    localStorage.setItem('mtg_player', JSON.stringify({ id: pid, name: 'Ein Ziemlich Langer Spielername', is_admin: true }))
  }, [PLAYER_ID])
  await page.goto(`${BASE}/resterampe`)
  await page.waitForSelector('#nav .nav-links a', { timeout: 10000 })
  const m = await page.evaluate(() => {
    const nav = document.getElementById('nav')
    const navRect = nav.getBoundingClientRect()
    const links = [...document.querySelectorAll('.nav-links a')].map((a) => {
      const r = a.getBoundingClientRect()
      return { text: a.textContent.trim(), h: r.height, w: r.width, top: r.top }
    })
    const tops = new Set(links.map((l) => Math.round(l.top)))
    const linksEl = document.querySelector('.nav-links')
    return {
      navH: navRect.height,
      navX: navRect.x,
      navW: navRect.width,
      linkRows: tops.size,
      minH: Math.min(...links.map((l) => l.h)),
      minW: Math.min(...links.map((l) => l.w)),
      scrollable: linksEl.scrollWidth >= linksEl.clientWidth,
      spanVisible: !!document.querySelector('.nav-user span') && getComputedStyle(document.querySelector('.nav-user span')).display !== 'none',
      docScrollW: document.documentElement.scrollWidth,
    }
  })
  check(`@${width} Nav einzeilige Linkzeile`, m.linkRows === 1, `rows=${m.linkRows}`)
  check(`@${width} Links >=44px hoch`, m.minH >= 44, `minH=${m.minH}`)
  check(`@${width} Links >=24px breit (WCAG 2.5.8)`, m.minW >= 24, `minW=${m.minW.toFixed(1)}`)
  check(`@${width} Sticky-Nav kompakt (<110px, vorher ~140)`, m.navH < 110, `navH=${m.navH}`)
  check(`@${width} Nav full-bleed`, m.navX <= 0.5 && m.navW >= width - 1, `x=${m.navX} w=${m.navW}`)
  check(`@${width} nav-user span versteckt`, !m.spanVisible)
  check(`@${width} kein horizontaler Page-Scroll`, m.docScrollW <= width, `docW=${m.docScrollW}`)
  await ctx.close()
}

// Desktop-Regression: Nav unverändert nutzbar, span sichtbar
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await ctx.newPage()
  await page.addInitScript(([pid]) => {
    localStorage.clear()
    localStorage.setItem('mtg_player', JSON.stringify({ id: pid, name: 'Desktop User', is_admin: true }))
  }, ['4669a98d-e04a-422b-b770-6fa0bab8522f'])
  await page.goto(`${BASE}/resterampe`)
  await page.waitForSelector('#nav .nav-links a', { timeout: 10000 })
  const m = await page.evaluate(() => {
    const span = document.querySelector('.nav-user span')
    const nav = document.getElementById('nav').getBoundingClientRect()
    return { spanVisible: span && getComputedStyle(span).display !== 'none', navH: nav.height, docScrollW: document.documentElement.scrollWidth }
  })
  check('@1280 span sichtbar, Nav einzeilig', m.spanVisible && m.navH < 70, `navH=${m.navH}`)
  check('@1280 kein horizontaler Scroll', m.docScrollW <= 1280, `docW=${m.docScrollW}`)
  await ctx.close()
}

await browser.close()
console.log(results.join('\n'))
if (results.some((r) => r.startsWith('FAIL'))) process.exit(1)

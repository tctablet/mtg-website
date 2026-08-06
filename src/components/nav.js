import { getPlayer, logout } from '../auth.js'
import { navigate, routeHref } from '../router.js'
import { refade } from './loading.js'

export function renderNav() {
  const nav = document.getElementById('nav')
  const player = getPlayer()

  if (!player) {
    nav.innerHTML = `
      <div class="nav-inner">
        <div class="nav-brand">MTG Deck Tracker</div>
        <div class="nav-links">
          <a href="${routeHref('/resterampe')}">Philips Resterampe</a>
          <a href="${routeHref('/preise')}">Preise</a>
          <a href="${routeHref('/scan')}">Scan</a>
        </div>
        <div class="nav-user">
          <a href="${routeHref('/login')}" class="btn-small">Login</a>
        </div>
      </div>
    `
    return
  }

  nav.innerHTML = `
    <div class="nav-inner">
      <div class="nav-brand">MTG Deck Tracker</div>
      <div class="nav-links">
        <a href="${routeHref('/overview')}">Übersicht</a>
        <a href="${routeHref('/my-decks')}">Meine Decks</a>
        <a href="${routeHref('/resterampe')}">Philips Resterampe</a>
        <a href="${routeHref('/preise')}">Preise</a>
        <a href="${routeHref('/scan')}">Scan</a>
        <a href="${routeHref('/info')}">Info</a>
        ${player.is_admin ? `<a href="${routeHref('/admin')}">Admin</a>` : ''}
      </div>
      <div class="nav-user">
        <span>Eingeloggt als <strong>${player.name}</strong></span>
        <button id="logout-btn" class="btn-small">Abmelden</button>
      </div>
    </div>
  `

  document.getElementById('logout-btn').addEventListener('click', () => {
    logout()
    renderNav()
    // Nav haengt ausserhalb von #content — der Router-Fade deckt sie beim
    // Logout-Rerender nicht ab, deshalb eigener Fade (Motion-Sweep)
    refade(nav)
    navigate('/resterampe')
  })
}

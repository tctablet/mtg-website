import { getPlayer, logout } from '../auth.js'
import { navigate } from '../router.js'

export function renderNav() {
  const nav = document.getElementById('nav')
  const player = getPlayer()

  if (!player) {
    nav.innerHTML = ''
    return
  }

  nav.innerHTML = `
    <div class="nav-inner">
      <div class="nav-brand">MTG Deck Tracker</div>
      <div class="nav-links">
        <a href="#/overview">Übersicht</a>
        <a href="#/my-decks">Meine Decks</a>
        <a href="#/info">Info</a>
        ${player.is_admin ? '<a href="#/admin">Admin</a>' : ''}
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
    navigate('#/login')
  })
}

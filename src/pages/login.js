import { loginWithCode } from '../supabase.js'
import { setPlayer } from '../auth.js'
import { navigate } from '../router.js'
import { renderNav } from '../components/nav.js'

export async function renderLogin(container) {
  container.innerHTML = `
    <div class="login-page">
      <div class="login-card">
        <h1>MTG Deck Tracker</h1>
        <p>Gib deinen 4-stelligen Code ein:</p>
        <div class="login-form">
          <input type="text" id="code-input" maxlength="4" pattern="\\d{4}"
                 placeholder="0000" autocomplete="off" inputmode="numeric" />
          <button id="login-btn" class="btn">Anmelden</button>
        </div>
        <p id="login-error" class="error" hidden></p>
      </div>
    </div>
  `

  const input = document.getElementById('code-input')
  const btn = document.getElementById('login-btn')
  const error = document.getElementById('login-error')

  async function doLogin() {
    const code = input.value.trim()
    if (!/^\d{4}$/.test(code)) {
      error.textContent = 'Bitte einen 4-stelligen Code eingeben.'
      error.hidden = false
      return
    }

    btn.disabled = true
    btn.textContent = 'Lade...'
    error.hidden = true

    const player = await loginWithCode(code)
    if (player) {
      setPlayer(player)
      renderNav()
      navigate('#/my-decks')
    } else {
      error.textContent = 'Code nicht gefunden.'
      error.hidden = false
      btn.disabled = false
      btn.textContent = 'Anmelden'
    }
  }

  btn.addEventListener('click', doLogin)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doLogin()
  })

  input.focus()
}

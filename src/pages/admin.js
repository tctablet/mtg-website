import { getPlayer } from '../auth.js'
import { navigate } from '../router.js'
import { supabase } from '../supabase.js'

export async function renderAdmin(container) {
  const player = getPlayer()
  if (!player || !player.is_admin) {
    navigate('#/my-decks')
    return
  }

  container.innerHTML = '<p class="loading">Lade Spieler...</p>'
  await refreshPlayerList(container)
}

async function refreshPlayerList(container) {
  const { data: players } = await supabase
    .from('players')
    .select('*')
    .order('name', { ascending: true })

  container.innerHTML = `
    <div class="page">
      <h2>Admin – Spieler verwalten</h2>
      <table class="admin-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Code</th>
            <th>Admin</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="player-rows">
          ${(players || []).map(p => playerRow(p)).join('')}
        </tbody>
      </table>
      <div class="admin-add">
        <h3>Neuen Spieler anlegen</h3>
        <div class="admin-add-form">
          <input type="text" id="new-name" placeholder="Name" />
          <input type="text" id="new-code" maxlength="4" placeholder="Code (4-stellig)" inputmode="numeric" />
          <button id="add-player-btn" class="btn">Hinzufügen</button>
        </div>
        <p id="admin-error" class="error" hidden></p>
      </div>
    </div>
  `

  // Edit code handlers
  container.querySelectorAll('.save-code-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id
      const input = container.querySelector(`.code-input[data-id="${id}"]`)
      const code = input.value.trim()
      if (!/^\d{4}$/.test(code)) {
        alert('Code muss 4-stellig sein.')
        return
      }
      const { error } = await supabase.from('players').update({ code }).eq('id', id)
      if (error) {
        alert(`Fehler: ${error.message}`)
      } else {
        btn.textContent = 'Gespeichert!'
        setTimeout(() => btn.textContent = 'Speichern', 1500)
      }
    })
  })

  // Toggle admin handlers
  container.querySelectorAll('.toggle-admin-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id
      const current = btn.dataset.admin === 'true'
      const { error } = await supabase.from('players').update({ is_admin: !current }).eq('id', id)
      if (error) {
        alert(`Fehler: ${error.message}`)
      } else {
        await refreshPlayerList(container)
      }
    })
  })

  // Delete handlers
  container.querySelectorAll('.delete-player-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.name
      if (!confirm(`"${name}" wirklich löschen? Alle Decks gehen verloren!`)) return
      const { error } = await supabase.from('players').delete().eq('id', btn.dataset.id)
      if (error) {
        alert(`Fehler: ${error.message}`)
      } else {
        await refreshPlayerList(container)
      }
    })
  })

  // Add player handler
  document.getElementById('add-player-btn').addEventListener('click', async () => {
    const name = document.getElementById('new-name').value.trim()
    const code = document.getElementById('new-code').value.trim()
    const errorEl = document.getElementById('admin-error')

    if (!name || !/^\d{4}$/.test(code)) {
      errorEl.textContent = 'Name und 4-stelliger Code erforderlich.'
      errorEl.hidden = false
      return
    }

    const { error } = await supabase.from('players').insert({ name, code })
    if (error) {
      errorEl.textContent = error.message.includes('unique')
        ? 'Dieser Code ist bereits vergeben.'
        : `Fehler: ${error.message}`
      errorEl.hidden = false
    } else {
      errorEl.hidden = true
      await refreshPlayerList(container)
    }
  })
}

function playerRow(p) {
  const currentPlayer = getPlayer()
  const isSelf = p.id === currentPlayer.id

  return `
    <tr>
      <td class="admin-name">${p.name}</td>
      <td>
        <div class="admin-code-edit">
          <input type="text" class="code-input" data-id="${p.id}" value="${p.code}" maxlength="4" inputmode="numeric" />
          <button class="btn-small save-code-btn" data-id="${p.id}">Speichern</button>
        </div>
      </td>
      <td>
        <button class="btn-small toggle-admin-btn" data-id="${p.id}" data-admin="${p.is_admin}" ${isSelf ? 'disabled title="Kann sich nicht selbst entfernen"' : ''}>
          ${p.is_admin ? 'Ja' : 'Nein'}
        </button>
      </td>
      <td>
        ${isSelf ? '' : `<button class="btn-small delete-player-btn" data-id="${p.id}" data-name="${p.name}">Löschen</button>`}
      </td>
    </tr>
  `
}

import { getPlayer } from '../auth.js'
import { navigate } from '../router.js'
import { supabase } from '../supabase.js'

export async function renderAdmin(container) {
  const player = getPlayer()
  if (!player || !player.is_admin) {
    navigate('/my-decks')
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
      <div class="admin-table-wrap">
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
            ${(players || []).map((p, i) => playerRow(p, i)).join('')}
          </tbody>
        </table>
      </div>
      <p id="admin-table-error" class="error" hidden></p>
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

  // Ein Fehlerkanal für die Tabelle — inline wie beim Anlege-Formular,
  // keine alert()-Mischung mehr
  const tableError = document.getElementById('admin-table-error')
  const showTableError = (msg) => {
    tableError.textContent = msg
    tableError.hidden = false
  }

  // Edit code handlers
  container.querySelectorAll('.save-code-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id
      const input = container.querySelector(`.code-input[data-id="${id}"]`)
      const code = input.value.trim()
      if (!/^\d{4}$/.test(code)) {
        input.classList.add('input-error')
        showTableError('Code muss 4-stellig sein.')
        input.select()
        return
      }
      input.classList.remove('input-error')
      const { error } = await supabase.from('players').update({ code }).eq('id', id)
      if (error) {
        showTableError(`Fehler: ${error.message}`)
      } else {
        tableError.hidden = true
        // Erfolg ohne Textwechsel (der Button würde sonst breiter springen)
        btn.classList.add('saved')
        setTimeout(() => btn.classList.remove('saved'), 1500)
      }
    })
  })
  container.querySelectorAll('.code-input').forEach(input => {
    input.addEventListener('input', () => input.classList.remove('input-error'))
  })

  // Toggle admin handlers
  container.querySelectorAll('.toggle-admin-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id
      const current = btn.dataset.admin === 'true'
      const { error } = await supabase.from('players').update({ is_admin: !current }).eq('id', id)
      if (error) {
        showTableError(`Fehler: ${error.message}`)
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
        showTableError(`Fehler: ${error.message}`)
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

function playerRow(p, i = 0) {
  const currentPlayer = getPlayer()
  const isSelf = p.id === currentPlayer.id

  return `
    <tr style="--stagger: ${Math.min(i, 8)}">
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

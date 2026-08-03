// Integrations-Probe gegen die ECHTE Supabase-Instanz (scryfall_prices):
// verifiziert die zwei PostgREST-Semantiken, an denen der card_printings-Sync
// hängt, BEVOR er je läuft:
//  (1) POST + Prefer: resolution=merge-duplicates übernimmt updated_at aus dem
//      Body (auch beim Update-Fall) — sonst würde der Cleanup frische Rows essen
//  (2) DELETE ?updated_at=lt.<ts> löscht exakt die älteren Rows
// Sentinel-Rows, werden am Ende restlos entfernt.
const URL_ = process.env.SUPABASE_URL
const KEY = process.env.SUPABASE_SERVICE_KEY
if (!URL_ || !KEY) { console.error('env fehlt'); process.exit(1) }

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }
const api = async (path, opt = {}) => {
  const res = await fetch(`${URL_}/rest/v1/${path}`, { ...opt, headers: { ...H, ...(opt.headers || {}) } })
  if (!res.ok) throw new Error(`${opt.method || 'GET'} ${path}: ${res.status} ${await res.text()}`)
  return res
}

const P1 = '~~printings-probe-1~~'
const P2 = '~~printings-probe-2~~'
const T_OLD = '2000-01-01T00:00:00.000Z'
const T_NEW = new Date().toISOString()
const results = []
const check = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)

try {
  // (1) Insert mit altem updated_at aus dem Body
  await api('scryfall_prices', { method: 'POST', body: JSON.stringify([{ name: P1, cheapest_eur: 0.01, is_foil: false, updated_at: T_OLD }]), headers: { Prefer: 'resolution=merge-duplicates' } })
  let row = await (await api(`scryfall_prices?name=eq.${encodeURIComponent(P1)}&select=updated_at`)).json()
  check('Insert: updated_at aus Body statt Default', row[0]?.updated_at?.startsWith('2000-01-01'), JSON.stringify(row))

  // (2) Merge-Update: Body-updated_at gewinnt auch beim Update-Fall
  await api('scryfall_prices', { method: 'POST', body: JSON.stringify([{ name: P1, cheapest_eur: 0.02, is_foil: false, updated_at: T_NEW }]), headers: { Prefer: 'resolution=merge-duplicates' } })
  row = await (await api(`scryfall_prices?name=eq.${encodeURIComponent(P1)}&select=updated_at,cheapest_eur`)).json()
  check('Merge-Update: updated_at + Wert aus Body', row[0]?.updated_at?.startsWith(T_NEW.slice(0, 10)) && Number(row[0]?.cheapest_eur) === 0.02, JSON.stringify(row))

  // (3) DELETE lt.-Filter: nur die ältere Sentinel-Row fällt
  await api('scryfall_prices', { method: 'POST', body: JSON.stringify([{ name: P2, cheapest_eur: 0.01, is_foil: false, updated_at: T_OLD }]), headers: { Prefer: 'resolution=merge-duplicates' } })
  const del = await api(`scryfall_prices?name=like.${encodeURIComponent('~~printings-probe-*')}&updated_at=lt.${encodeURIComponent(T_NEW)}&select=name`, { method: 'DELETE', headers: { Prefer: 'return=representation' } })
  const deleted = await del.json()
  const left = await (await api(`scryfall_prices?name=like.${encodeURIComponent('~~printings-probe-*')}&select=name`)).json()
  check('DELETE lt: trifft nur die alte Row', deleted.length === 1 && deleted[0].name === P2 && left.length === 1 && left[0].name === P1, `deleted=${JSON.stringify(deleted)} left=${JSON.stringify(left)}`)
} catch (err) {
  results.push(`FAIL Probe abgebrochen: ${err.message.split('\n')[0]}`)
} finally {
  // Cleanup: beide Sentinels restlos weg. Eigenes try/catch — wirft der
  // Cleanup selbst, duerfen die gesammelten Ergebnisse nicht verloren gehen.
  try {
    await api(`scryfall_prices?name=like.${encodeURIComponent('~~printings-probe-*')}`, { method: 'DELETE' })
    const gone = await (await api(`scryfall_prices?name=like.${encodeURIComponent('~~printings-probe-*')}&select=name`)).json()
    check('Cleanup: Sentinels entfernt', gone.length === 0, JSON.stringify(gone))
  } catch (err) {
    check('Cleanup: Sentinels entfernt', false, err.message.split('\n')[0])
  }
}
console.log(results.join('\n'))
if (results.some(r => r.startsWith('FAIL'))) process.exit(1)

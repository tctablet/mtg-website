// supabase.mjs (Optimizer) — dünner Wrapper um die bestehende Datenschicht.
//
// Importiert src/supabase.js direkt (gleicher Client, gleicher Anon-Key, gleiche
// Berechtigungen wie die Website — kein Key-Duplikat wie in tools/*.html).
// Ergänzt nur, was die CLIs zusätzlich brauchen: paginierte Voll-Reads
// (PostgREST kappt still bei 1000 Rows) und einen verständlichen Hinweis,
// wenn die Free-Tier-Instanz pausiert ist (NXDOMAIN nach ~7 Tagen Inaktivität).

export {
  supabase,
  getDeck,
  getDeckCards,
  getAllDecksWithPlayers,
  insertCards,
  deleteCard,
  fetchCheapestPrices,
} from '../../../src/supabase.js'

import { supabase } from '../../../src/supabase.js'

// PostgREST liefert maximal 1000 Rows pro Antwort — breite Reads immer über
// .range() paginieren (BLOCKER-Fund aus dem Printings-Review, gleiche Regel).
export async function getAllRows(table, select = '*', pageSize = 1000) {
  const rows = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .range(from, from + pageSize - 1)
    if (error) throw error
    rows.push(...(data || []))
    if (!data || data.length < pageSize) break
  }
  return rows
}

// Netzfehler gegen die pausierte Free-Tier-Instanz sehen aus wie DNS-Ausfälle.
// CLIs fangen damit kryptische "fetch failed"-Meldungen ab.
export function friendlyDbError(err) {
  const msg = String(err?.message || err)
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|NXDOMAIN/i.test(msg)) {
    return (
      `${msg}\nHinweis: Die Supabase-Free-Tier-Instanz pausiert nach ~7 Tagen Inaktivität. ` +
      'Projekt im Dashboard aufwecken: https://supabase.com/dashboard/project/jcbdjlqxmlsfqfenltws'
    )
  }
  return msg
}

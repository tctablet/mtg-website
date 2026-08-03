// Pures Mapping der card_printings-Rows (Supabase) auf das Printing-Format des
// Artwork-Pickers (identisch zu toPrinting in scryfall.js). Eigenes Modul ohne
// Imports, damit node --test es direkt laden kann.

/**
 * @param {Array} rows  card_printings-Rows aus Supabase
 * @param {Array<string>} requestedNames  die angefragten Kartennamen
 * @returns {Map<string, Array>} kleingeschriebener Name → Printings, sortiert
 *   neueste zuerst (mirrort Scryfalls order=released). Namen ohne Rows fehlen
 *   in der Map — sie gehören dem Scryfall-Fallback, nie als [] werten.
 */
export function groupPrintingRows(rows, requestedNames) {
  const requested = new Set(requestedNames.map(n => n.toLowerCase()))
  const byName = new Map()

  for (const row of rows) {
    const key = row.name.toLowerCase()
    if (!requested.has(key)) continue
    const printing = {
      scryfall_id: row.scryfall_id,
      set: row.set_name,
      set_code: row.set_code,
      released: row.released_at,
      image_small: row.image_small || row.image_normal,
      image_normal: row.image_normal,
      image_png: row.image_png || row.image_normal,
    }
    const list = byName.get(key)
    if (list) list.push(printing)
    else byName.set(key, [printing])
  }

  // PostgREST liefert date-Spalten als 'YYYY-MM-DD' — lexikografisch sortierbar
  for (const list of byName.values()) {
    list.sort((a, b) => String(b.released || '').localeCompare(String(a.released || '')))
  }
  return byName
}

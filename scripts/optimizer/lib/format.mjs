// format.mjs — kompakte Terminal-Tabellen (pure).

export function renderTable(rows, columns) {
  if (rows.length === 0) return '(leer)'
  const widths = columns.map(col =>
    Math.max(col.label.length, ...rows.map(r => String(r[col.key] ?? '').length))
  )
  const line = (cells, pad = ' ') =>
    cells.map((c, i) => {
      const w = widths[i]
      return columns[i].align === 'right' ? String(c).padStart(w, pad) : String(c).padEnd(w, pad)
    }).join('  ')
  const out = [line(columns.map(c => c.label)), line(columns.map((_, i) => ''.padEnd(widths[i], '─')))]
  for (const r of rows) out.push(line(columns.map(c => r[c.key] ?? '')))
  return out.join('\n')
}

export function formatEur(n) {
  if (n == null || isNaN(n)) return '—'
  return n.toFixed(2).replace('.', ',') + ' €'
}

export function formatPct(p) {
  if (p == null || isNaN(p)) return '—'
  return (p * 100).toFixed(1).replace('.', ',') + ' %'
}

export function heading(text) {
  return `\n${text}\n${'═'.repeat(text.length)}`
}

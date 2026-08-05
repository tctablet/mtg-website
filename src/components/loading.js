// loading.js — einheitlicher Ladezustand für lange Ladewege (EDHREC-Decks,
// Scryfall-Collections, Preis-DB): schlanker indeterminierter Ladebalken mit
// Label + Fade-Utility für sanfte Content-Wechsel (User-Ansage: „Ladebalken
// und smoothe css mit fade animationen").
//
// Bewusst indeterminiert: die Quellen liefern keine verlässliche
// Content-Length (gzip/Chunked) — ein ehrlicher Puls schlägt einen
// gelogenen Prozentbalken.

import { escapeHtml } from '../utils.js'

export function loadingHtml(label) {
  return `
    <div class="load-state fade-in">
      <div class="load-bar"><div class="load-bar-fill"></div></div>
      <span class="load-label">${escapeHtml(label)}</span>
    </div>
  `
}

// Label eines bereits gerenderten load-state aktualisieren (Staged Loading:
// „Lade EDHREC-Liste…" → „Preise & Kartendetails…") — ohne den Balken neu zu
// starten.
export function updateLoadingLabel(container, label) {
  const el = container?.querySelector?.('.load-label')
  if (el) el.textContent = label
}

// Fade-Animation auf einem Element (re-)triggern — für Content-Swaps nach
// dem Laden. reflow-Trick, damit die Animation auch bei erneutem Aufruf läuft.
export function refade(el) {
  if (!el) return
  el.classList.remove('fade-in')
  void el.offsetWidth
  el.classList.add('fade-in')
}

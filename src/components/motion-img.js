// motion-img.js — zentraler Bild-Lade-Vertrag des Motion-Systems.
//
// Bei langsamem Netz poppen Bilder sonst hart in leere Rahmen (User-Ansage
// 06.08.2026). Statt jeden Render-Pfad einzeln zu verkabeln, beobachtet EIN
// MutationObserver den ganzen Body: JEDES eingefügte <img> — heutige und
// zukünftige — wird automatisch angeschlossen:
//   - .img-fade: unsichtbar (opacity 0), bis das Bild wirklich geladen ist
//   - .img-ready bei load/error: faded über die Motion-Tokens ein
//   - solange nicht ready, pulsen die bekannten Kartenrahmen via :has()
//     (Regeln in style.css) wie die Skeleton-Frames
//
// error setzt AUCH ready: die bestehenden Fehler-Fallbacks (Namens-Kasten,
// Critic R7-Vertrag) ersetzen das Bild ohnehin — nichts darf unsichtbar
// hängen bleiben. src-Wechsel auf demselben <img> (Sidebar-Hover, DFC-Flip)
// bleiben sichtbar — nur das ERSTE Laden faded (kein Hover-Geflacker).

function arm(img) {
  // ACHTUNG: img.src (Property) liefert bei src=""-ATTRIBUT die Seiten-URL —
  // deshalb das Attribut prüfen, sonst gilt ein leeres Bild als „fertig"
  const srcAttr = img.getAttribute('src')
  // Bereits fertig (Cache-Hit oder kaputte gecachte URL) → sofort zeigen,
  // kein Fade-Delay; Fehler-Fallbacks der App übernehmen kaputte Bilder
  if (img.complete && (img.naturalWidth > 0 || srcAttr)) {
    img.classList.add('img-ready')
    return
  }
  const ready = () => img.classList.add('img-ready')
  img.addEventListener('load', ready, { once: true })
  img.addEventListener('error', ready, { once: true })
}

function wire(img) {
  if (img.classList.contains('img-fade')) return
  img.classList.add('img-fade')
  arm(img)
}

// Für Blättern auf DEMSELBEN <img> (Big-Picture-Overlay): nach dem src-Wechsel
// aufrufen — das alte Bild verschwindet, der Skeleton übernimmt, das neue
// Bild faded ein. Ohne rearm bliebe das ALTE Bild zum NEUEN Namen stehen
// (Critic, per Screenshot belegt).
export function rearmImgFade(img) {
  img.classList.add('img-fade')
  img.classList.remove('img-ready')
  arm(img)
}

export function startImageFades() {
  document.querySelectorAll('img').forEach(wire)
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue
        if (node.tagName === 'IMG') wire(node)
        else node.querySelectorAll?.('img').forEach(wire)
      }
    }
  }).observe(document.body, { childList: true, subtree: true })
}

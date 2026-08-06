// swipe.js — horizontaler Touch-Swipe fuer Karten-Overlays (Big-Picture-
// Blaettern auf mobile). Bewusst passive Listener: wir verhindern kein
// Scrollen, sondern werten nur am Touch-Ende aus, ob die Geste klar
// horizontal war (Dominanz-Check gegen versehentliche Scroll-Gesten).
//
// onSwipe(dir): dir = 1 (nach links gewischt → naechste Karte),
//               dir = -1 (nach rechts gewischt → vorherige Karte)
export function attachSwipe(el, onSwipe, { threshold = 48 } = {}) {
  let startX = null
  let startY = null

  const onTouchStart = (e) => {
    const t = e.touches[0]
    startX = t.clientX
    startY = t.clientY
  }
  const onTouchEnd = (e) => {
    if (startX == null) return
    const t = e.changedTouches[0]
    const dx = t.clientX - startX
    const dy = t.clientY - startY
    startX = null
    startY = null
    if (Math.abs(dx) >= threshold && Math.abs(dx) > 1.5 * Math.abs(dy)) {
      onSwipe(dx < 0 ? 1 : -1)
    }
  }

  el.addEventListener('touchstart', onTouchStart, { passive: true })
  el.addEventListener('touchend', onTouchEnd, { passive: true })
  return () => {
    el.removeEventListener('touchstart', onTouchStart)
    el.removeEventListener('touchend', onTouchEnd)
  }
}

// toast.js — unaufdringliche Bestätigung mit optionaler Aktion (z.B. Undo).
// Singleton: ein neuer Toast ersetzt den alten. Räumt sich bei Navigation auf.

let activeToast = null

export function showToast({ message, actionLabel = null, onAction = null, duration = 6000 }) {
  dismissToast()

  const el = document.createElement('div')
  el.className = 'toast'
  el.setAttribute('role', 'status')
  const msg = document.createElement('span')
  msg.className = 'toast-message'
  msg.textContent = message
  el.appendChild(msg)

  let actionUsed = false
  if (actionLabel && onAction) {
    const btn = document.createElement('button')
    btn.className = 'toast-action'
    btn.textContent = actionLabel
    btn.addEventListener('click', () => {
      if (actionUsed) return
      actionUsed = true
      dismissToast()
      onAction()
    })
    el.appendChild(btn)
  }

  document.body.appendChild(el)
  requestAnimationFrame(() => el.classList.add('visible'))

  const timer = setTimeout(dismissToast, duration)
  const onRouteChange = () => dismissToast()
  window.addEventListener('route-change', onRouteChange)

  activeToast = {
    el,
    cleanup() {
      clearTimeout(timer)
      window.removeEventListener('route-change', onRouteChange)
    },
  }
  return dismissToast
}

export function dismissToast() {
  if (!activeToast) return
  const { el, cleanup } = activeToast
  activeToast = null
  cleanup()
  el.classList.remove('visible')
  el.classList.add('closing')
  // Timer statt transitionend: feuert auch bei reduced motion zuverlässig.
  // 300 = var(--dur-slow) aus motion.css — Timer muss >= CSS-Dauer bleiben
  setTimeout(() => el.remove(), 300)
}

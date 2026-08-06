const routes = {}

// Vite-Base ohne Trailing-Slash, z.B. '/mtg-website'
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '')

export function registerRoute(path, renderFn) {
  routes[path] = renderFn
}

// Voller href fuer Template-Links, z.B. routeHref('/deck/5') -> '/mtg-website/deck/5'
export function routeHref(path) {
  return BASE + path
}

export function navigate(path) {
  history.pushState(null, '', BASE + path)
  handleRoute()
}

// Aktuelle Route neu rendern ohne Navigation (Ersatz fuer synthetische hashchange-Events)
export function refreshRoute() {
  handleRoute()
}

export function getCurrentRoute() {
  let path = window.location.pathname
  if (path.startsWith(BASE)) path = path.slice(BASE.length)
  path = path.replace(/\/$/, '')
  return path || '/resterampe'
}

function matchRoute(path) {
  // Exact match first
  if (routes[path]) return { render: routes[path], params: {} }

  // Pattern match (e.g., /deck/:id)
  for (const [pattern, render] of Object.entries(routes)) {
    const paramNames = []
    const regex = pattern.replace(/:(\w+)/g, (_, name) => {
      paramNames.push(name)
      return '([^/]+)'
    })

    const match = path.match(new RegExp(`^${regex}$`))
    if (match) {
      const params = {}
      paramNames.forEach((name, i) => {
        params[name] = match[i + 1]
      })
      return { render, params }
    }
  }

  return null
}

// Jeder Seitenwechsel faded automatisch (View Transitions API, Cross-Fade —
// Dauer/Easing kommen aus motion.css ::view-transition-*). Damit ist der
// Navigations-Fade STRUKTURELL unvergessbar: neue Pages erben ihn, ohne je
// eigene Fade-Logik zu bauen. Fallback (alte Browser, reduced motion): direkt.
let inTransitionUpdate = false
function renderWithTransition(update) {
  // Reentrancy-Guard (Critic [HIGH]): Login-Redirects rufen navigate()
  // SYNCHRON aus dem Render heraus (my-decks/admin/overview/import/info) —
  // das landet hier verschachtelt, waehrend der aeussere Transition-Callback
  // noch laeuft. Dann NICHT erneut startViewTransition (wuerde die aeussere
  // Transition skippen → harter Schnitt/Blank-Flash), sondern direkt rendern:
  // die aeussere Transition faengt den Endzustand (z.B. Login) als EIN Fade ein.
  if (inTransitionUpdate
    || !document.startViewTransition
    || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    update()
    return
  }
  // finished nie awaiten/werfen lassen — eine uebersprungene Transition
  // (schneller Doppel-Klick) ist kein Fehler
  document.startViewTransition(() => {
    inTransitionUpdate = true
    try {
      update()
    } finally {
      inTransitionUpdate = false
    }
  }).finished.catch(() => {})
}

async function handleRoute() {
  // Fuer Listener wie das Artwork-Picker-Modal, die auf Navigation reagieren
  window.dispatchEvent(new Event('route-change'))

  const path = getCurrentRoute()
  const content = document.getElementById('content')
  const result = matchRoute(path)

  // Der Transition-Callback bleibt SYNCHRON: er faengt den ersten Paint der
  // neuen Seite ein (Pages rendern ihren Lade-/Grundzustand synchron, Daten
  // kommen danach). Das Render-Promise wird AUSSERHALB awaited — sonst wuerde
  // startViewTransition die Seite einfrieren, bis alle Fetches durch sind.
  let renderPromise = null
  renderWithTransition(() => {
    if (result) {
      content.innerHTML = ''
      renderPromise = result.render(content, result.params)
    } else {
      content.innerHTML = '<p>Seite nicht gefunden.</p>'
    }
  })
  if (renderPromise) await renderPromise
}

export function startRouter() {
  // Alte Hash-Bookmarks (#/deck/5) auf saubere Pfade umleiten
  if (window.location.hash.startsWith('#/')) {
    history.replaceState(null, '', BASE + window.location.hash.slice(1))
  }

  window.addEventListener('popstate', handleRoute)

  // Interne Links abfangen statt volle Page-Loads
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0) return
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const link = e.target.closest('a[href]')
    if (!link || link.target || link.hasAttribute('download')) return
    if (link.origin !== location.origin) return
    if (!link.pathname.startsWith(BASE + '/')) return
    e.preventDefault()
    // Query-String mitnehmen — interne Links wie /preise?q=... behalten ihre Parameter
    navigate(link.pathname.slice(BASE.length) + link.search)
  })

  handleRoute()
}

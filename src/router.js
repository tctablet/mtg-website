const routes = {}

export function registerRoute(hash, renderFn) {
  routes[hash] = renderFn
}

export function navigate(hash) {
  window.location.hash = hash
}

export function getCurrentRoute() {
  return window.location.hash || '#/login'
}

function matchRoute(hash) {
  // Exact match first
  if (routes[hash]) return { render: routes[hash], params: {} }

  // Pattern match (e.g., #/deck/:id)
  for (const [pattern, render] of Object.entries(routes)) {
    const paramNames = []
    const regex = pattern.replace(/:(\w+)/g, (_, name) => {
      paramNames.push(name)
      return '([^/]+)'
    })

    const match = hash.match(new RegExp(`^${regex}$`))
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

export function startRouter() {
  async function handleRoute() {
    const hash = getCurrentRoute()
    const content = document.getElementById('content')
    const result = matchRoute(hash)

    if (result) {
      content.innerHTML = ''
      await result.render(content, result.params)
    } else {
      content.innerHTML = '<p>Seite nicht gefunden.</p>'
    }
  }

  window.addEventListener('hashchange', handleRoute)
  handleRoute()
}

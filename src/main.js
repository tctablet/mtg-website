import './style.css'
import { registerRoute, startRouter } from './router.js'
import { renderNav } from './components/nav.js'
import { renderLogin } from './pages/login.js'
import { renderOverview } from './pages/overview.js'
import { renderMyDecks } from './pages/my-decks.js'
import { renderDeckView } from './pages/deck-view.js'
import { renderDeckImport } from './pages/deck-import.js'
import { renderAdmin } from './pages/admin.js'
import { renderInfo } from './pages/info.js'

// Routes registrieren
registerRoute('#/login', renderLogin)
registerRoute('#/overview', renderOverview)
registerRoute('#/my-decks', renderMyDecks)
registerRoute('#/deck/:id', renderDeckView)
registerRoute('#/import', renderDeckImport)
registerRoute('#/admin', renderAdmin)
registerRoute('#/info', renderInfo)

// Navigation rendern
renderNav()

// Router starten
startRouter()

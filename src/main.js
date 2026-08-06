import './motion.css'
import './style.css'
import { startImageFades } from './components/motion-img.js'
import { registerRoute, startRouter } from './router.js'
import { renderNav } from './components/nav.js'
import { renderLogin } from './pages/login.js'
import { renderOverview } from './pages/overview.js'
import { renderMyDecks } from './pages/my-decks.js'
import { renderDeckView } from './pages/deck-view.js'
import { renderDeckImport } from './pages/deck-import.js'
import { renderAdmin } from './pages/admin.js'
import { renderInfo } from './pages/info.js'
import { renderResterampe } from './pages/resterampe.js'
import { renderPreise } from './pages/preise.js'
import { renderScan } from './pages/scan.js'

// Routes registrieren
registerRoute('/login', renderLogin)
registerRoute('/overview', renderOverview)
registerRoute('/my-decks', renderMyDecks)
registerRoute('/deck/:id', renderDeckView)
registerRoute('/import', renderDeckImport)
registerRoute('/admin', renderAdmin)
registerRoute('/info', renderInfo)
registerRoute('/resterampe', renderResterampe)
registerRoute('/preise', renderPreise)
registerRoute('/scan', renderScan)

// Navigation rendern
renderNav()

// Router starten
// VOR dem Router starten: der Observer muss die Bilder des ersten Renders
// schon sehen (Bild-Lade-Vertrag, motion-img.js)
startImageFades()
startRouter()

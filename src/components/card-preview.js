import { fetchCardBackImage } from '../scryfall.js'
import { attachSwipe } from './swipe.js'

// Karten-Wechsel-Animation auf einem BESTEHENDEN <img> neu anstossen —
// src-Wechsel allein re-triggert CSS-Animationen nicht (Motion-Sweep)
function retriggerCardAnim(img, cls = 'card-swap') {
  img.classList.remove('card-swap', 'card-step-next', 'card-step-prev')
  void img.offsetWidth
  img.classList.add(cls)
}

let defaultImage = null
let currentDfc = null // { frontUri, scryfallId, showingBack }
// Name der zuletzt angezeigten Karte — der Bild-Fehler-Fallback der Sidebar
// zeigt IHREN Namen, nicht den des Commanders (Critic R7: falsche Identität
// ist schlimmer als fehlendes Bild)
let currentName = null

// Fehler-Vertrag lebt IN der Komponente (Critic R7): jedes hier erzeugte
// Sidebar-<img> fällt bei toter URL selbst auf den Namens-Kasten zurück —
// egal welcher Call-Site (scan, deck-view, Hover-Zyklen) es nutzt.
function showNoImage(container, name) {
  container.querySelector('img')?.remove()
  let span = container.querySelector('.preview-noimg')
  if (!span) {
    span = document.createElement('span')
    span.className = 'preview-noimg'
    container.appendChild(span)
  }
  span.textContent = name || 'Kein Bild verfügbar'
}

export function setDefaultPreview(imageUri, name = null) {
  defaultImage = imageUri
  currentName = name
  const el = document.getElementById('deck-card-preview')
  if (!el) return
  if (imageUri) {
    ensureImg(el).src = imageUri
  } else {
    // Ohne Bild KEIN leeres <img> (renderte als kaputtes Icon, Critic R6) —
    // stattdessen direkt der Namens-Kasten
    showNoImage(el, name)
  }
  hideFlipButton()
}

export function showPreview(imageUri, dfcInfo, bracketCat, name = null) {
  const el = document.getElementById('deck-card-preview')
  if (!el || !imageUri) return
  currentName = name
  const img = ensureImg(el)
  img.src = imageUri
  setBracketClass(el, bracketCat)

  if (dfcInfo?.scryfallId) {
    currentDfc = { frontUri: imageUri, scryfallId: dfcInfo.scryfallId, showingBack: false }
    showFlipButton(el)
  } else {
    currentDfc = null
    hideFlipButton()
  }
}

function setBracketClass(el, bracketCat) {
  el.classList.remove('bracket-gc', 'bracket-tutor', 'bracket-extra', 'bracket-mld')
  if (bracketCat) el.classList.add(`bracket-${bracketCat}`)
}

export function movePreview() {}

export function hidePreview() {
  // Keep last hovered card visible — only showPreview replaces it
}

function ensureImg(container) {
  let img = container.querySelector('img')
  if (!img) {
    // Namens-Fallback weicht, sobald wieder ein echtes Bild kommt (Hover)
    container.querySelector('.preview-noimg')?.remove()
    img = document.createElement('img')
    img.alt = 'Kartenvorschau'
    // Listener hängt an JEDEM erzeugten img — überlebt damit per Konstruktion
    // beliebig viele Fallback→Hover→Fallback-Zyklen (Critic R7)
    img.addEventListener('error', () => showNoImage(container, currentName))
    container.appendChild(img)
  }
  return img
}

function showFlipButton(previewEl) {
  let btn = previewEl.querySelector('.flip-btn')
  if (!btn) {
    btn = document.createElement('button')
    btn.className = 'flip-btn'
    btn.title = 'Karte umdrehen'
    btn.setAttribute('aria-label', 'Karte umdrehen')
    btn.innerHTML = '&#x21C4;'
    btn.addEventListener('click', handleFlip)
    previewEl.appendChild(btn)
  }
  btn.hidden = false
}

function hideFlipButton() {
  const btn = document.querySelector('#deck-card-preview .flip-btn')
  if (btn) btn.hidden = true
}

async function handleFlip() {
  if (!currentDfc) return
  const el = document.getElementById('deck-card-preview')
  if (!el) return
  const img = el.querySelector('img')
  if (!img) return

  if (currentDfc.showingBack) {
    img.src = currentDfc.frontUri
    currentDfc.showingBack = false
    retriggerCardAnim(img)
  } else {
    const backUri = await fetchCardBackImage(currentDfc.scryfallId)
    if (backUri) {
      img.src = backUri
      currentDfc.showingBack = true
      retriggerCardAnim(img)
    }
  }
}

// Raeumt den keydown-Listener der aktuell offenen Vorschau auf
let releaseMobilePreview = null

function dismissMobilePreview(overlay) {
  if (!overlay || overlay.dataset.closing === '1') return
  overlay.dataset.closing = '1'
  if (releaseMobilePreview) releaseMobilePreview()
  overlay.classList.remove('visible')
  overlay.classList.add('closing')
  // Timer statt transitionend: feuert auch bei reduced motion und wenn
  // die Transition gar nicht erst startet
  setTimeout(() => overlay.remove(), 300)
}

// Alle Karten-Zeilen in Anzeigereihenfolge, die eine Vorschau haben.
// Wird bei jedem Blättern frisch gelesen, damit Sortierung/Bearbeiten stimmen.
// Scope: Vor/Zurück blättert nur innerhalb des nächsten [data-preview-scope]-
// Containers der Ausgangszeile — auf /scan stehen mehrere Listen gleichzeitig
// im DOM (Average + bewertete Decks), ohne Scope liefe die Navigation über
// Deck-Grenzen in fremde Karten. Ohne Attribut (deck-view): wie bisher global.
function previewRows(fromRow) {
  const scope = fromRow?.closest?.('[data-preview-scope]') || document
  return [...scope.querySelectorAll('.card-row')].filter(r => r._cardPreview)
}

export function showMobilePreview(imageUri, cardName, dfcInfo, bracketCat, rowEl) {
  // Offene Vorschau direkt ersetzen — ein Tap auf die naechste Karte soll
  // sie zeigen, nicht nur die alte schliessen
  if (releaseMobilePreview) releaseMobilePreview()
  document.getElementById('mobile-card-overlay')?.remove()

  const overlay = document.createElement('div')
  overlay.id = 'mobile-card-overlay'
  overlay.className = 'mobile-card-overlay'
  overlay.innerHTML = `
    <div class="mobile-card-content">
      <img alt="" />
      <span class="preview-noimg overlay-noimg" hidden></span>
      <button class="flip-btn flip-btn-mobile" title="Karte umdrehen" aria-label="Karte umdrehen" hidden>&#x21C4;</button>
      <div class="mobile-card-nav">
        <button class="mobile-nav-btn" data-dir="-1" aria-label="Vorherige Karte">&#8249;</button>
        <span class="mobile-nav-label"></span>
        <button class="mobile-nav-btn" data-dir="1" aria-label="Nächste Karte">&#8250;</button>
      </div>
    </div>
  `

  const img = overlay.querySelector('img')
  const flipBtn = overlay.querySelector('.flip-btn')
  const label = overlay.querySelector('.mobile-nav-label')
  const navBtns = [...overlay.querySelectorAll('.mobile-nav-btn')]
  const noimgEl = overlay.querySelector('.overlay-noimg')

  let current = { imageUri, cardName, dfcInfo, bracketCat, row: rowEl }
  let showingBack = false

  // Gleiche no-blank-image-Regel wie in der Sidebar: tote URL → Namens-Kasten,
  // nächstes erfolgreiches Bild stellt die Anzeige wieder her (Critic R7)
  img.addEventListener('error', () => {
    img.hidden = true
    noimgEl.textContent = current.cardName || 'Kein Bild verfügbar'
    noimgEl.hidden = false
  })
  img.addEventListener('load', () => {
    img.hidden = false
    noimgEl.hidden = true
  })

  // dir: 0 = kein Uebergang (Erst-Render), 1 = vorwaerts, -1 = rueckwaerts
  function render(data, dir) {
    current = data
    showingBack = false
    img.src = data.imageUri
    img.alt = data.cardName || ''
    label.textContent = data.cardName || ''
    flipBtn.hidden = !data.dfcInfo?.scryfallId
    overlay.classList.remove('bracket-gc', 'bracket-tutor', 'bracket-extra', 'bracket-mld')
    if (data.bracketCat) overlay.classList.add(`bracket-${data.bracketCat}`)

    const rows = previewRows(data.row)
    const i = data.row ? rows.indexOf(data.row) : -1
    navBtns.forEach(b => {
      const target = i < 0 ? -1 : i + Number(b.dataset.dir)
      b.disabled = i < 0 || target < 0 || target >= rows.length
    })
    // Blaettern nur zeigen, wenn es ueberhaupt Nachbarn gibt
    overlay.querySelector('.mobile-card-nav').hidden = rows.length < 2 || i < 0

    if (dir) retriggerCardAnim(img, dir > 0 ? 'card-step-next' : 'card-step-prev')
  }

  function step(dir) {
    const rows = previewRows(current.row)
    const i = rows.indexOf(current.row)
    const next = rows[i + dir]
    if (!next?._cardPreview) return
    render({ ...next._cardPreview, row: next }, dir)
  }

  // Big-Picture-Swipe (User-Ansage): wischen blaettert wie die Pfeile
  attachSwipe(overlay, step)

  overlay.addEventListener('click', (e) => {
    if (e.target.closest('.flip-btn') || e.target.closest('.mobile-card-nav')) return
    dismissMobilePreview(overlay)
  })

  navBtns.forEach(b => b.addEventListener('click', () => step(Number(b.dataset.dir))))

  flipBtn.addEventListener('click', async () => {
    if (!current.dfcInfo?.scryfallId) return
    if (showingBack) {
      img.src = current.imageUri
      showingBack = false
      retriggerCardAnim(img)
      return
    }
    const backUri = await fetchCardBackImage(current.dfcInfo.scryfallId)
    // Waehrend des Ladens kann weitergeblaettert worden sein
    if (backUri && current.dfcInfo?.scryfallId) {
      img.src = backUri
      showingBack = true
      retriggerCardAnim(img)
    }
  })

  render(current, 0)
  document.body.appendChild(overlay)
  overlay.offsetHeight
  overlay.classList.add('visible')

  const onKey = (e) => {
    if (e.key === 'Escape') dismissMobilePreview(overlay)
    else if (e.key === 'ArrowLeft') step(-1)
    else if (e.key === 'ArrowRight') step(1)
  }
  // Routenwechsel schließt das Overlay (Critic-Fund: der Router leert nur
  // #content — das Overlay hängt am Body und stünde sonst fixiert über der
  // neuen Seite; gleiches Muster wie Lightbox/Swap-Picker)
  const onRoute = () => dismissMobilePreview(overlay)
  document.addEventListener('keydown', onKey)
  window.addEventListener('route-change', onRoute)
  const release = () => {
    document.removeEventListener('keydown', onKey)
    window.removeEventListener('route-change', onRoute)
    if (releaseMobilePreview === release) releaseMobilePreview = null
  }
  releaseMobilePreview = release
}

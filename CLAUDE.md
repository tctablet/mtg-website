# MTG Deck Tracker

## Projektstruktur

- `src/` — Vite-basierte Hauptanwendung (Deck Tracker)
- `tools/` — Standalone HTML-Tools (nicht Teil des Vite-Builds)
  - `tools/foil-designer.html` — Foil Designer Masking Tool
  - `tools/proxy-print.html` — Proxy Print PDF Generator
  - `tools/proxy-print.py` — Upscale-Server (upscayl-bin Backend)

## Tools

### Foil Designer (`tools/foil-designer.html`)

Standalone Web-App zum Erstellen von Foil-Masken fuer MTG Proxy-Karten. Exportiert SVG fuer Silhouette Cameo 5 Heat Pen.

**Zweck:** Dezente Foil-Akzente auf Proxy-Karten setzen — der Heat Pen zeichnet die erkannten Elemente (Text, Symbole, Leuchteffekte) nach. KEINE grossen gefuellten Flaechen.

**Tech-Stack:** Vanilla JS + OpenCV.js 4.x (WASM, ~8MB, CDN) — kein Build-System, kein Tesseract, kein SlimSAM

**Vollautomatischer Workflow:** Karte suchen → OpenCV-Analyse laeuft sofort → alle Zonen automatisch aktiviert → SVG Export bereit. Kein manuelles Aktivieren noetig.

**Masken-Analyse-Pipeline (OpenCV.js):**
- 9 Zonen: Legendary Crown, Kartenname, Manakosten, Typzeile, Regeltext, Power/Toughness, Set-Symbol, Rahmenlinien, Artwork Akzente
- Region Templates fuer normal/legendary/planeswalker (672x936px Scryfall-Bilder)

**Text-Zonen v6 (Single-Pass Detection):**
- Einzelner `cv.adaptiveThreshold` (GAUSSIAN, blockSize=15, C=8) auf gesamte Karte
- Artwork-Region wird vor Threshold mit lokalem Mittelwert maskiert (unterdrueckt Artwork-Textur)
- Connected Components werden per Centroid-Position in Zonen klassifiziert (`CLASSIFY_ZONES`)
- Klassifizierungs-Reihenfolge: pt → loyalty → manacost → setsymbol → crown → name → typeline → textbox
- MORPH_OPEN (2x2) + MORPH_CLOSE (2x2) gegen JPEG-Rauschen
- 2x2 Ellipse Dilation fuer duenne Heat-Pen-taugliche Striche
- WICHTIG: Kein Zone-Cropping — loest Clipping-Probleme bei gelayerten Zonen (P/T auf Textbox)

**Artwork Akzente (Canny Edge Detection):**
- `cv.GaussianBlur(3x3)` → `cv.Canny(40, 120)` — strukturelle Konturen im Artwork
- Post-Canny Border-Mask (16px Inset) verhindert Art-Frame-Doppelkanten
- `cv.dilate(3x3 ELLIPSE)` — verdickt Kanten fuer Heat Pen
- CC Filter (minArea=8) entfernt JPEG-Rauschen

**Rahmenlinien:**
- Canvas `stroke()` mit 2px Linienstaerke — Outer/Inner Border, Pinlines, Textbox-Rahmen
- Art-Frame roundRect entfernt (wird von Canny im Artwork erfasst)

**Preview & Foil-Effekt:**
- Foil nur auf maskierten Bereichen (CSS mask-image)
- Masken-Overlay Toggle + Nur-Masken-Ansicht zur Qualitaetskontrolle
- GPU-beschleunigte Tilt-Animation (rAF + LERP)
- 5 Foil-Farben, 4 Effekt-Stile, Intensitaets-Slider

**Export:**
- SVG: OpenCV findContours + approxPolyDP (epsilon=2.0), mm-Koordinaten (63x88mm), Registrierungsmarken

**Testumgebung (`tools/foil-test.js`):**
- Node.js Headless-Runner mit `opencv-wasm` + `canvas` — kein Browser noetig
- Presets: v3, subtle, balanced, detailed, bold, edges_only, highlights, fullcard, v6
- v6: Single-Pass Text Detection mit Post-Hoc Zone Classification
- Usage: `node foil-test.js [preset|all|v6] [card-name]`
- Ergebnisse: PNG-Masken in `/tmp/foil-test/`

### Proxy Print (`tools/proxy-print.html` + `tools/proxy-print.py`)

PDF-Generator fuer MTG Proxy-Karten mit AI-Upscaling. Decklist eingeben → Scryfall-Bilder holen → Upscaling → druckfertiges PDF.

**Architektur:** Browser-Frontend + lokaler Python-Server (upscayl-bin Backend)

**Server starten:** `python3 tools/proxy-print.py` (oeffnet http://127.0.0.1:8765)

**Upscaling-Pipeline:**
- Backend: upscayl-bin mit remacri-4x Modell (NCNN/Vulkan GPU)
- Fallback: Pillow LANCZOS (ohne GPU)
- Modi: Off (300 DPI), 2x (600 DPI), 4x (1200 DPI, Default)
- JPEG-Kompression: `-c 0` (verlustfrei) — Dateigröße egal, Qualität hat Priorität
- Disk-Cache in `tools/.proxy_cache/upscaled/` (Hash + Scale im Key)

**Frontend:**
- Decklist-Parser: Unterstuetzt `1 Cardname`, `1x Cardname`, MTGA-Export, Deduplizierung
- JPEG-Quality: Q100 Default (verlustfrei) — kein Re-Encoding bei server-seitigen JPEGs
- Paralleles Fetching, sequentielles GPU-Upscaling (M4 GPU Single-Queue-Limitation)
- jsPDF fuer PDF-Generierung mit Schnittmarken

**Supabase-Integration:**
- Laedt Decks direkt aus Supabase (Dropdown gruppiert nach Spieler)
- Verwendet `proxy_image_uri` fuer benutzerdefinierte Artwork-Auswahl (Fallback: `image_uri`)
- Kartenvorschau nach Typ gruppiert (Kreaturen, Artefakte, Laender, etc.)
- Konvertiert Scryfall normal-URLs zu PNG fuer optimale Upscaling-Qualitaet

### Deck Import (`src/pages/deck-import.js`)

2-Schritt-Import-Flow: Decklist analysieren → Commander aus Thumbnails waehlen → Import.

**Schritt 1 — Decklist eingeben:**
- Deckname + Kartenliste (Textarea oder Datei-Upload: `.txt`, `.dec`, `.mwDeck`)
- Formate: `1 Cardname`, `1x Cardname`, MTGA-Export
- "Weiter" → Scryfall Batch-Lookup (`fetchCardCollection`, Chunks à 75)

**Schritt 2 — Commander waehlen:**
- Identifiziert Commander-faehige Karten: Legendary Creature, Planeswalker mit "can be your commander"
- **Color-Identity-Filter:** Nur Commander deren `color_identity` alle Deck-Farben abdeckt (Superset-Pruefung)
- Fallback: Zeigt alle eligible Karten falls kein Kandidat alle Farben abdeckt
- Thumbnail-Grid mit Kartenbildern + Suchfilter
- Partner-Erkennung: Partner, Friends Forever, Choose a Background, Doctor's Companion
- Auto-Select bei "Partner with [Name]"
- Autoscroll zum Commander-Picker nach Analyse

**DFC-Handling (Double-Faced Cards):**
- `scryfallMap` indexiert sowohl vollen Namen (`"A // B"`) als auch Front-Face (`"A"`)
- `matchCommander()` in deck-view.js matcht Front-Face-Namen fuer Commander-Sektion

**Import-Logging:**
- Scryfall `notFound` → Fehlerliste nach Schritt 1
- Karten ohne scryfallMap-Match → Warnliste + `console.warn()` nach Import
- Statusmeldung zeigt Anzahl uebersprungener Karten, 3s Redirect-Delay bei Warnungen

### Deck Editing (`src/pages/deck-view.js`)

**Karten hinzufuegen (Edit-Modus):**
- Suchfeld "Karte hinzufuegen..." erscheint bei "Bearbeiten"-Toggle
- Scryfall-Autocomplete (debounced 250ms, max 8 Vorschlaege)
- Keyboard-Navigation: Pfeiltasten, Enter, Escape
- Duplikat-Check: Warnung wenn Karte bereits im Deck
- Holt vollstaendige Kartendaten (Typ, Mana, CMC, Preis, Legalitaet, Bild)
- Re-fetcht Deck-Cards nach Insert fuer korrekte DB-IDs
- Statusmeldungen: gruen (Erfolg), gelb (Warnung/Fehler)

**Karten bearbeiten (Edit-Modus):**
- Quantity-Input (1-99) pro Karte
- Karte loeschen mit Bestaetigung

**Deck-Metadaten bearbeiten (Stift-Icon, Owner-only):**
- Name, Commander, Partner-Commander aendern
- Scryfall-Lookup fuer Commander-Artwork bei Aenderung

### Proxy Artwork Selection (Deck-View Feature)

Artwork-Auswahl pro Karte pro Deck fuer den Proxy-Druck.

**Datenbank:** `cards.proxy_image_uri` (text, nullable) — speichert gewaehlte Scryfall-Bild-URL

**UI:** "Proxy Artworks" Tab im Deck-View
- Grid nach Kartentyp gruppiert (3-spaltig), gleiche Gruppierung wie Karten-Tab
- Klick oeffnet Artwork-Picker-Modal mit allen Scryfall-Printings
- Set-Suchfeld zum Filtern nach Set-Name/Code
- "Custom" Badge bei manuell gewaehlten Artworks
- Nur Deck-Owner koennen Artworks aendern

**Scryfall-Filter (`fetchCardPrintings`):**
- Filtert: Foil-only, digitale Sets (MTGO/Arena), Promos, Promo-Set-Typ, Treasure Chest
- Felder: `digital`, `promo`, `finishes`, `set_type`

**Performance:**
- Prefetch aller Printings beim Tab-Oeffnen (10 req/sec, Scryfall Rate-Limit)
- SessionStorage-Cache mit Versionierung (Cache-Key `prints:ver`)
- Zweiter Klick auf Karte = instant (aus Cache)

**Integration mit Karten-Tab:**
- Hover-Preview im Sidebar zeigt `proxy_image_uri` statt Default
- Commander-Preview nutzt Proxy-Artwork wenn vorhanden

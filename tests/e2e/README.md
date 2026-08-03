# E2E-Suiten (Playwright headless)

Laufen gegen `npm run preview` (Port 4173). Brauchen `playwright-core` +
einen installierten Chromium (nicht in package.json — einmalig
`npm i -D playwright-core && npx playwright-core install chromium`
oder NODE_PATH auf ein Repo mit vorhandenem playwright-core zeigen).

- `router-test.mjs` — History-API-Routing, Hash-Redirect, 404-Fallback
- `nav-measure.mjs` — Mobile-Nav-Messungen @390/375/1280 (44px-Ziele, sticky-Höhe)
- `picker-e2e.mjs` — Artwork-Picker: DB-Pfad (gemockt), Scryfall-Fallback,
  >1000-Rows-Pagination
- `login-e2e.mjs` — Auto-Submit bei 4. Ziffer, Fehlerpfad

Aufruf je Datei: `node tests/e2e/<datei>.mjs`

# mtg-prices — MCP-Server für die Preis-DB

Stellt die Preis-Datenbank des MTG Deck Trackers (Supabase, täglich von
Scryfall gesynct) anderen Claude-Code-Instanzen als stdio-MCP-Server zur
Verfügung. **Read-only by design** — es gibt keine Write-Tools.

## Voraussetzung (WICHTIG, zuerst prüfen)

Einmal `npm install` in diesem Repo (`/Users/cpg/Documents/mtg website`)
ausgeführt haben — der Datenlayer braucht `@supabase/supabase-js` aus
`node_modules`. Ohne das crasht der Server **vor dem ersten JSON-RPC-Byte**
und Claude Code meldet nur „MCP server failed to start".

## Registrierung im anderen Projekt

```bash
claude mcp add mtg-prices -- node "/Users/cpg/Documents/mtg website/scripts/mcp/price-server.mjs"
```

Pfad **mit Quotes** — das Verzeichnis enthält ein Leerzeichen. Der absolute
Pfad macht die Registrierung cwd-unabhängig; alle Imports lösen relativ zur
Serverdatei auf.

## Tools

| Tool | Input | Liefert |
|---|---|---|
| `get_price` | `{ name }` | Günstigster EUR-Preis der Karte (über alle Papier-Printings) |
| `get_prices` | `{ names[] }` (max 500) | Batch: found-Map + missing-Liste |
| `search_cards` | `{ query, limit? }` (1–100, Default 20) | Namenssuche (case-insensitive Substring), alphabetisch |
| `get_printings` | `{ name }` | Alle Papier-Printings (Set, Datum, Bild-URLs), neueste zuerst |
| `list_decks` | `{}` | Alle Decks der Runde inkl. Spieler, Commander, `for_sale`-Flag |
| `deck_value` | `{ deck_id }` oder `{ deck_name }` | Deck-Gesamtwert (exakt die Website-Formel) + 500-€-Budget-Check |

Hinweise:

- Kartennamen sind die **exakten englischen Scryfall-Namen**. Bei
  doppelseitigen Karten reicht die Vorderseite (`Delver of Secrets` findet
  `Delver of Secrets // Insectile Aberration`).
- `deck_value.missing_prices`: Karten ohne Preis zählen 0 € in die Summe und
  werden namentlich gelistet — die Summe ist dann eine Untergrenze.
- `get_printings` kennt nur Karten, die in Decks der Runde vorkommen
  (der Cache wird aus den Decklisten befüllt). Preise (`get_price`) decken
  dagegen ALLE ~34k Kartennamen ab.
- Tool-Calls haben serverseitig 30s Timeout; Fehler kommen als
  `isError`-Result mit deutscher Meldung zurück (inkl. Hinweis, wenn die
  Free-Tier-Instanz pausiert ist).

## Copy-Paste-Block für die CLAUDE.md des anderen Projekts

```markdown
## MTG-Preis-DB (MCP-Server `mtg-prices`)

Kartenpreise & Deck-Werte des MTG Deck Trackers. Read-only.
- Einzelpreis: `get_price {name}` — exakter englischer Kartenname.
- Viele Preise: `get_prices {names[]}` (max 500) — nutzt found/missing.
- Name unsicher: erst `search_cards {query}`.
- Deck-Wert + 500-€-Check: `deck_value {deck_name}` (Decks via `list_decks`).
- Fehler „MCP server failed to start": einmal `npm install` in
  `/Users/cpg/Documents/mtg website` ausführen.
- Fehler mit „pausiert"-Hinweis: Supabase-Free-Tier schläft nach ~7 Tagen —
  im Dashboard aufwecken (der Betreiber kennt den Link).
```

## REST-Fallback (ohne MCP, direkt PostgREST)

Supabase stellt die Tabellen automatisch als REST-API bereit. Der Anon-Key
ist derselbe, der öffentlich im Frontend-Bundle steckt (keine neue
Exposition). **Nur lesend verwenden** — der Key hat durch die offene
RLS-Policy auch Schreibrechte!

```bash
SUPA=https://jcbdjlqxmlsfqfenltws.supabase.co/rest/v1
KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpjYmRqbHF4bWxzZnFmZW5sdHdzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0NzczNDUsImV4cCI6MjA4OTA1MzM0NX0.S87-oIgyMjB1Jdc-2LW4b0mlnUkoFw_SjltpMAB6lvc'

# Einzelpreis
curl -s "$SUPA/scryfall_prices?name=eq.Sol%20Ring&select=name,cheapest_eur,is_foil" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY"

# Namenssuche (ilike, Wildcard %)
curl -s "$SUPA/scryfall_prices?name=ilike.*delver*&select=name,cheapest_eur&order=name&limit=20" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY"

# Decks + Spieler
curl -s "$SUPA/decks?select=id,name,commander,for_sale,players(name)" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY"
```

Stolperfallen:

1. **1000-Row-Cap:** PostgREST kappt Antworten still bei 1000 Zeilen — breite
   Queries mit `Range:`-Header bzw. `offset`/`limit` paginieren.
2. **Free-Tier-Auto-Pause:** Nach ~7 Tagen Inaktivität pausiert die Instanz;
   Symptom ist NXDOMAIN beim DNS-Lookup. Fix: im Supabase-Dashboard
   „Restore" drücken (Projekt `jcbdjlqxmlsfqfenltws`).
3. **Schreibrechte:** Der Anon-Key darf schreiben (vertrauenswürdige Runde) —
   externe Konsumenten müssen sich selbst auf GET beschränken. Der MCP-Server
   erzwingt das; rohes curl nicht.

## Entwicklung

- Protokoll-Layer: [lib/jsonrpc.mjs](lib/jsonrpc.mjs) (pure, newline-delimited
  JSON-RPC 2.0 / MCP-stdio).
- Tools + Query-Bausteine: [lib/tools.mjs](lib/tools.mjs) (DB via Injection,
  Deck-Formel aus `scripts/optimizer/lib/budget.mjs` — Website-Parität).
- Entry/Wiring: [price-server.mjs](price-server.mjs).
- Tests (ohne Live-DB): `node --test tests/price-mcp.test.mjs`.
- Manueller Smoke gegen die echte DB:
  `echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_price","arguments":{"name":"Sol Ring"}}}' | node scripts/mcp/price-server.mjs`

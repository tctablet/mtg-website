# Deck-Optimizer — Deep-Research: State of the Art (Stand 04.08.2026)

Recherche-Basis für das geplante EDH-Deckbau- & Optimierungs-Tool auf der Website.
Erstellt per Multi-Agent-Workflow (7 Web-Research-Agents + Codebase-Scout + Completeness-Critic
+ 3 Gap-Fill-Agents, davon 2 mit **Live-API-Tests** und **DB-Verifikation**).

---

## 1. EDH-Deckbau-Regeln (State of the Art 2026)

### Quoten-Konsens (Command Zone Template Ep. 658, Feb 2025 „New Era")

| Kategorie | Anzahl | Anmerkung |
|---|---|---|
| Länder | 36–38 | Ziel gesamt ~43–50 Mana-Quellen (Länder + Ramp) |
| Ramp | 10–12 | 2-Mana-Rocks zählen als ~0,5 Land |
| Card Draw | 10+ | |
| Gezieltes Removal | 10–12 | Früher ~5 — fast verdoppelt (Format schneller geworden) |
| Board Wipes | 3–4 | Früher 5 — reduziert |
| Wincons | 7–10 | |
| Synergie | 15–20 | Framework: ~40% Enabler / ~35% Payoffs / ~25% Enhancer |

Archetyp-Anpassungen: Control 12–15 Removal + 5–7 Wipes · Aggro 5–6 Removal + 34–36 Länder · Combo 10–12 Draw + 4–6 Protection.
Kategorien dürfen überlappen (Summe > 100 erlaubt).

### Mathematische Basis (implementierbar)

- **Karsten-Landcount-Formel** für 100er-Singleton:
  `((100 - Cmdr) / 60) * (19.59 + 1.90*avgMV + 0.27*Cmdr) - 0.28*(Ramp+Draw) - FastMana - 0.74*MDFC_tapped - 0.38*MDFC_untapped - 1.35`
  (90%-Konsistenz-Schwelle; -1,35 = Free Mulligan + garantierter T1-Draw).
  Quelle: canadianhighlander.ca/2023/07/17/how-to-build-a-manabase-for-singleton-formats/
- **Colored Sources**: Karstens 60er-Zahlen × ~1,6 → Single Pip ~22 Quellen, Double Pip ~29.
- **Hypergeometrik-Faustwerte**: 25 Karten eines Effekttyps → 77% auf 2 bis T3; 30 Karten → 86,9%.

### Bracket-System (offiziell, Beta — letzter Stand 09.02.2026)

| Bracket | Name | Turn-Fenster (seit Okt 2025) | Game Changers |
|---|---|---|---|
| 1 | Exhibition | Wins ab T9+ | 0 |
| 2 | Core | T8+ | 0 |
| 3 | Upgraded | T6+ | max. 3 |
| 4 | Optimized | T4+ | unbegrenzt |
| 5 | cEDH | beliebig | unbegrenzt |

- Game-Changers-Liste: **53 Karten** (Feb 2026: +Farewell, +Biorhythm; Okt 2025: 10 entfernt, u.a. Kinnan, Urza, Yuriko).
- Tutor-Limits wurden Okt 2025 gestrichen. Precons sind seit Ende 2025 NICHT mehr automatisch B2.
- MLD, verkettete Extra Turns, frühe 2-Karten-Combos → B4/B5.
- **Maschinenlesbar via Scryfall**: Boolean-Feld `game_changer` + Query `is:gamechanger` (live verifiziert: 53 Treffer).
- Banlist Feb 2026: Biorhythm + Lutri unbanned (Lutri als erste „banned as companion"-Karte). Governance seit Sept 2024 bei WotC (Gavin Verhey + Commander Format Panel).
- Nächste Änderungen erst nach den MagicCons 2026 (Review-Zyklus ~3–4 Monate).

---

## 2. Archetypen & Metagame

### Taxonomie

- **Makro**: Aggro, Control, Combo, Midrange, Stax.
- **Casual-Themen** (Draftsim: 27; praktikabel: ScrollVaults **14 Synergie-Achsen**): Sacrifice/Aristocrats, +1/+1 Counters, Tokens, Landfall, ETB/Blink, Graveyard/Reanimator, Creature Cheat, Spellslinger, Artifacts, Enchantress, Voltron, Stax, Lifegain, Wheels.
- **cEDH** (cEDH Decklist Database): Turbo/Storm, Midrange/Combo, Control/Stax, Aggro/Tempo, Reanimator.

### Meta 2026

| Segment | Spitze |
|---|---|
| cEDH (EDHTop16, Post-Ban, live abgefragt) | Kraum/Tymna 10.573 Entries / 31,5% Conversion · Kinnan · Rograkh/Thrasios · Rograkh/Silas · Blue Farm · Sisay |
| Casual (EDHREC 2025) | Y'shtola (23,6k Decks), Edgar Markov, Vivi Ornitier, Teval, Ur-Dragon; 47 der Top 100 aus Precons |
| Set-Einfluss | Final Fantasy (Jun 2025) ≈ 9% aller 2025er-Decks; Avatar TLA + Spider-Man stark; 2026: Lorwyn Eclipsed, TMNT, Strixhaven SOS, Marvel MSH |

---

## 3. Deck-Testing: Was geht wirklich (Realismus-Check)

**Kernbefund: Vollautomatische 4-Spieler-EDH-Simulation ist 2026 NICHT praxistauglich.**

| Ansatz | Status | Problem |
|---|---|---|
| Forge headless (`forge sim -f commander -p 4`) | Einzige rules-complete Option | AI schwach bei Combo/Control, ~0,04 Sims/s (JVM pro Spiel) |
| XMage / mage-bench (LLMs spielen 4er-Pods) | Proof-of-Concept | Keine veröffentlichten Ergebnisse, teuer |
| Akademisch (MTG-Causal-RL, MageZero) | Früh | Selbst 1v1-MTG ungelöst |
| LLM-Goldfishing | Schwach | LLMs bewerten Züge besser als sie sie generieren (MTG Bench) |

**State of the Art = Proxy-Metriken** (ScrollVault-Methodik als Blaupause — 97,2% bracket-exakt gegen Referenzset, kalibriert an 7.315 Topdeck-Turnierlisten):

1. **Monte-Carlo-Goldfish** (1.000 seeded Hände, mit Mulligans/Ramp/Draw/Tutoren): Median + Ceiling „Turns-to-win" über 4 Wincon-Typen (Combat, 2-Karten-Combos, Poison, Commander-Damage) → direkt auf die offiziellen Bracket-Turn-Fenster mappbar.
2. **Keep-Rate** (ManaTap/EDHcheck-Muster: 10.000 Sims, Kriterien z.B. ≥2 Länder + 1 Spell + Primärfarbe).
3. **Interaktionsdichte-Benchmarks**: B1–2: 8–15%, B3: 12–22%, B4–5: 15–28% der Nonland-Karten; plus Instant-Speed-Ratio (Antworten in gegnerischen Zügen) gegen Turbo/Combo.
4. **Karsten-Farbquellen/Curve-Checks** (deterministisch, in Code).
5. **Combo-Detection** via Commander Spellbook API (deterministisch statt LLM-Raten).

**ScrollVault-Scoring** (dokumentiert, nachbaubar): Soft-Score 0–15/16–30/31–50/51–75 → B1–B4; Hard-Floors (1 GC → min. B3; S/R-2-Karten-Combo + Acceleration ≥4 → B4); Archetyp-Multiplikatoren (Stax ×1,15, Aggro ×0,90); Synergy = min(Enabler, Payoffs) je Achse.

**Vorgeschlagene „Bestehen"-Definition gegen ein Gauntlet-Deck in Bracket X** (Synthese, kein Standard existiert):
- (1) eigener Goldfish-Median ≤ Turn-Fenster von Bracket X (Clock-Parity), **oder**
- (2) Interaktionsdichte erreicht Benchmark von Bracket X **und** Mindestanteil instant-speed (Antwort-Parity),
- **und** (3) Keep-Rate ≥ Schwellwert (~80%, muss selbst kalibriert werden).

---

## 4. Referenzdecks mit Funktionsnachweis (+ Realismus pro Bracket)

**Ehrliche Einschätzung:**

| Bracket | „Turnier-bewiesen" realistisch? | Beste Evidenz |
|---|---|---|
| 5 (cEDH) | **Ja, voll** | Topdeck.gg-Turnierdaten, EDHTop16, cEDH Decklist DB (50 COMPETITIVE-Decks) |
| 4 | Teilweise | Topdeck-Daten sind fast komplett cEDH; kuratierte High-Power-Listen |
| 2–3 | **Nein — strukturell nicht** | Casual ist bewusst kein Turnierformat; LGS-„Bracket-3-Turniere" sind anekdotisch. **Keine Turnier-API hat eine Bracket-Dimension (live verifiziert: weder Topdeck V2 noch EDHTop16-Schema).** |

**Ersatz-Evidenz-Hierarchie für B2–3** (absteigend):
1. **Playgroup.gg**: >630.000 getrackte Realspiele, Precon-Tierlist aus 11.120 Stock-Games (normalisiert auf 25%-Baseline) — einzige Casual-Winrate-Quelle; kein API, ggf. Kooperation anfragen. Selection-Bias beachten.
2. **Offizielle Precons** (WotC-intern getestet): via **MTGJSON maschinenlesbar** — alle 35 Commander-Precons seit 2025 als komplette 99er-JSONs inkl. `edhrecRank` pro Karte (`mtgjson.com/api/v5/decks/<file>.json`). ScrollVault scored 70 Precons (53× B2, 17× B3).
3. **Kuratierte Upgrade-Guides / Creator-Decks**: MTGGoldfish Budget Commander ($25–50-Pfade), Game-Knights-/Command-Zone-Decks vollständig auf Archidekt (`archidekt.com/u/GameKnights`).
4. **EDHREC-Konsens** (Average Deck, Inclusion-Rates, Synergy-Scores) — Popularität, kein Funktionsnachweis.
5. Ungetestete Einzellisten (ausschließen).

→ Für B2–3 sollte das Tool „bewiesen" ehrlich als **„getestet/etabliert"** ausweisen; Winrate ist dort nicht mal das richtige Zielmaß (ein B2/B3-Deck „funktioniert", wenn es seinen Gameplan konsistent ausspielt).

### Konkretes Gauntlet-Kandidatenset (alle Quellen belegt)

| Bracket | Quelle | Inhalt |
|---|---|---|
| B1–B2 | ScrollVault-Referenzset + MTGJSON | 11 Stock-Precons (u.a. Strixhaven-Zyklus, Eternal Might, Living Energy) |
| B3 | ScrollVault + MTGJSON | 6 Game-Changer-Precons (Abzan Armor, Counter Blitz FFX, 20 Ways to Win, Creative Energy, Deadly Disguise, Deep Clue Sea) |
| B4 | ScrollVault (Moxfield-Links) | 3 Decks (Ur-Dragon High-Power, 2× Atraxa Superfriends) — **dünn, Lücke!** |
| B5 | cEDH Decklist DB (JSON) + EDHTop16 | 16 cEDH-Archetypen (Kinnan, Blue Farm, Najeela, Tivit Stax, Rograkh+Silas Turbo, Yuriko, Sisay …); 50 COMPETITIVE-Einträge mit Moxfield-Primer-Links |

- ScrollVault-Validierungsseite: `scrollvault.net/methodology/bracket-validation.html` (36 Kern + 14 Boundary, alle Quell-URLs im HTML).
- cEDH-DB als Raw-JSON (164 KB, 135 Einträge): `raw.githubusercontent.com/cEDH-Decklist-Database/cEDH-Decklist-Database/main/_data/database.json` — Einträge mit `updated < 2024` vorher ausfiltern.
- B4- und Casual-Themen-Lücken (Voltron, Reanimator, Enchantress, Tokens laut EDHREC am populärsten) mit kuratierten Community-Listen schließen.

---

## 5. KI/LLM-Deckbau: Konsens-Architektur

**Naive Chatbot-Nutzung scheitert reproduzierbar**: erfundene Karten, 76/100-Karten-Decks, Singleton-/Color-Identity-Verstöße, Kontextverlust, veralteter Kartenpool (dokumentiert u.a. farseek.ai-Blog, TappedOut-Praxistest). Halluzinationsraten bei Standalone-LLMs ~36%.

**Das dominante Pattern („Stochastic-Deterministic Boundary", arXiv 2605.20173):**

| Schicht | Zuständig für | Warum |
|---|---|---|
| **LLM (Proposer)** | Synergie-Bewertung, Kartenauswahl aus validierten Kandidatenlisten, Archetyp-Kohärenz, Cut-Debatte | Semantik ist LLM-Stärke |
| **Code (Verifier)** | Legalität, Singleton, Color Identity, Banlist, Budget, Landformeln, Hypergeometrik, Curve | Deterministisch, 10–33× billiger, halluzinationsfrei |
| **Ground Truth** | Lokale Scryfall-Bulk-DB / Supabase — **jede Kartennennung wird gegen die DB aufgelöst**, bevor sie ins Deck kommt | Anti-Halluzination + aktueller Kartenpool |

- **Critic-Loops**: Anthropic Evaluator-Optimizer-Pattern; ABER Forschung 2025/26 zeigt: LLM-as-judge allein reicht nicht (JETTS: Pass-Rates steigen, echte Qualität stagniert) → **Critic immer mit objektiven Signalen verankern** (Goldfish-Sim, Spellbook-Combos, deterministische Checks). Genau unser tc-loop-Prinzip.
- **Referenzprojekte**:
  - `dan-blanchard/mtg-skills` — Claude-Code-Skills, 12-Schritt-Tuning-Pipeline, Zwei-Agenten-Debatte, deterministische `mtg_utils`-CLI (Mana/Legality/Preis), lokale Scryfall-Bulk-Daten (~500 MB).
  - `KoalaTrapLord/commander-ai-lab` — 7-Schritt-LLM-Pipeline + Forge/Monte-Carlo-Feedback-Loop, gelernte Karten-Gewichte fließen in Prompts zurück.
  - „MTG Commander Deck Architect"-Skill — 4-stufig adversarial (Builder → Rules Judge → Synergy → Price) mit Loop-Limits.
  - `kscius/mtg-commander-analyzer-mcp` — lokale SQLite als Ground Truth, Banlist-Datei, Bracket-3-Checks, iterativer `optimize_deck`-Loop (architektonisch am nächsten an unserem Supabase-Ansatz).
- MCP-Ökosystem: ≥10 Scryfall/MTG-MCP-Server; größter: `j4th/mtg-mcp-server` (69 Tools, 7 Datenquellen, `claude mcp add mtg -- uvx mtg-mcp-server`).

---

## 6. Datenquellen & Aktualität

### Live verifizierte APIs (Hands-on-Tests vom 04.08.2026)

| API | Status | Befund |
|---|---|---|
| **Commander Spellbook** (`backend.commanderspellbook.com`) | ✅ **produktionsreif, end-to-end getestet** | `/find-my-combos` + `/estimate-bracket` mit echter Saruman-Liste aus unserer Supabase: HTTP 200, 12 Combos, bracketTag „R" (Ruthless); 10 Requests ohne 429. BracketTag-Enum: R/S/P/O/C/E/B. Kein Key nötig. |
| **EDHTop16 GraphQL** (`edhtop16.com/api/graphql`) | ✅ offen, live | Keine Auth, Introspection offen, 16 Query-Felder; Post-Ban-Meta abgefragt. Kein öffentliches Repo mehr (Self-Hosting unmöglich), kein SLA → Schema-Snapshot versionieren. |
| **Topdeck.gg V2** | ⚠️ Key nötig | API live (saubere 401), Key kostenlos aber nur mit Topdeck-Account (`topdeck.gg/developers`) — **einmalige User-Aktion**. 100 req/min, Attribution-Pflicht. Formate nur „EDH"/„Casual EDH", **kein Bracket-Feld**. |
| **MTGJSON Decks** (`mtgjson.com/api/v5/`) | ✅ verifiziert | `DeckList.json` → 35 Commander-Precons seit 2025, Einzeldecks komplett inkl. edhrecRank. |
| **Supabase (eigene DB)** | ✅ verifiziert | s.u. |

### Scryfall (Primärquelle — wichtige Änderungen!)

- **Seit 20.07.2026 Bulk-Daten NUR noch als gzipped JSONL** (`jsonl_download_uri`); altes `download_uri` abgeschafft → **unser sync-prices.mjs prüfen, ob es das alte Feld nutzt!**
- Neuer `/cards/manifest`-Endpoint (01.07.2026) für Delta-Sync (10/min).
- Rate Limits: Karten-Endpoints 2/s, Rest 10/s, Bulk-Downloads unlimitiert; Pflicht-User-Agent.
- Lizenz: frei unter WotC Fan Content Policy; kein Paywalling der Kartendaten.
- Sets 2026: Lorwyn Eclipsed (Jan), TMNT (Mär), Secrets of Strixhaven (Apr), Marvel Super Heroes (Jun); **The Hobbit 14.08.2026**, Reality Fracture (Okt), Star Trek (Nov).
- Best Practice Sync: GitHub Action (nicht Edge Function — Memory-Limits), JSONL-Streaming, Batch-Upserts (~500), 1×/Tag.

---

## 7. Eigene Website: Integrationspunkte & DB-Zustand (verifiziert)

### Codebase

- Vanilla-JS-SPA (Vite, kein Framework), Router in `src/router.js`, Registrierung in `src/main.js` (`/deck/:id`-Patterns möglich).
- **Bester Andockpunkt**: drittes Tab in `src/pages/deck-view.js` (Tab-System existiert: Karten / Proxy Artworks; deck+cards dort schon geladen).
- Wiederverwendbar: `src/bracket.js` (estimateBracket + GC/Tutor/ExtraTurn/MLD-Listen), `renderDeckStats()` (Manakurve/Avg-CMC/Legalität), `src/scryfall.js` (Batch-Collection 75er-Chunks, Autocomplete, 429-Retry), Schreib-Helper (`insertCards`, `deleteCard`, `updateCardQuantity`), `parseDeckList`, `getTypeCategory`.
- Alternative: Standalone-HTML in `tools/` nach `proxy-print.html`-Muster (UMD-Supabase, Key-Duplikation).
- Tests: `node --test tests/*.test.mjs` — Scoring-Logik import-frei halten wie `printings.js`.

### DB (Live-Checks 04.08.2026)

| Fakt | Status |
|---|---|
| Migration 003 / `card_printings` | ✅ LIVE, 16.039 Rows, Cron pflegt nach (Memory-Index korrigiert) |
| Row-Counts | decks 34 · cards 2.919 · players 11 · scryfall_prices 34.126 |
| RLS anon auf decks/cards/players | **Voller INSERT/UPDATE/DELETE** (9/9 CRUD-Tests) → Optimizer KANN direkt schreiben |
| RLS anon auf card_printings/scryfall_prices | Read-only (42501 bei Write) — nur Cron mit Service-Key |
| `cards`-Schema | **KEIN oracle_text, KEINE color_identity, keine Keywords** → Migration 004 oder Live-Scryfall nötig |
| DDL-Zugang | Nur manuell via SQL-Editor (Service-Key nur als GitHub-Secret) |
| PostgREST | Kappt still bei 1000 Rows → `.range()`-Pagination Pflicht |

---

## 8. Offene Entscheidungen für die Plan-Phase

1. **Integration**: SPA-Tab in deck-view (empfohlen: Login/Owner-Gating + src/-Module) vs. Standalone-Tool in `tools/`.
2. **Datenlücke** oracle_text/color_identity: Migration 004 auf `cards` vs. separate Cache-Tabelle (Cron-befüllt) vs. Live-Scryfall pro Aufruf.
3. **Schreibmodell**: Optimizer schreibt direkt (technisch möglich) vs. Empfehlungsliste mit „Übernehmen"-Button (empfohlen: Vorschlag + expliziter Apply).
4. **Topdeck-Key**: einmalig Account + Key holen (nur nötig für eigene Turnier-Aggregation; EDHTop16 deckt Meta bereits ab).
5. **„Bestehen"-Kriterium**: vorgeschlagene Pass-Definition (Kap. 3) bestätigen/kalibrieren; Keep-Rate-Schwelle selbst definieren.
6. **B4-Gauntlet-Lücke**: 3 Decks reichen nicht — kuratierte Optimized-Listen ergänzen.
7. **sync-prices.mjs auf JSONL-Migration prüfen** (Scryfall-Breaking-Change 20.07.2026) — unabhängig vom Optimizer dringend.

## 9. Wichtigste Quellen (Kurzliste)

| Quelle | Nutzen | API |
|---|---|---|
| scrollvault.net (Bracket-Calc, Methodik, Validation, Precons) | Blaupause Scoring + Goldfish + Referenzset | nein (Methodik voll dokumentiert) |
| Commander Spellbook | Combo-Detection + Bracket-Schätzung | ✅ frei, getestet |
| EDHTop16 | cEDH-Meta/Conversion | ✅ GraphQL, getestet |
| cEDH Decklist Database | B5-Referenzdecks | ✅ Raw-JSON auf GitHub |
| MTGJSON | Precon-Decklisten + edhrecRank | ✅ frei |
| Topdeck.gg V2 | Turnier-Rohdaten | ⚠️ Key (Account nötig) |
| Playgroup.gg | Casual-Realspiel-Winrates | nein (ggf. anfragen) |
| Scryfall | Kartendaten, GC-Flag, Legalität | ✅ (JSONL-Umstellung beachten) |
| EDHREC | Konsens/Themes/Salt | inoffizielle JSON-Endpoints |
| dan-blanchard/mtg-skills, commander-ai-lab, kscius/mtg-commander-analyzer-mcp | Architektur-Vorbilder | Open Source |
| Anthropic „Building Effective Agents" + SDB-Paper (arXiv 2605.20173) | Loop-/Verifier-Patterns | — |

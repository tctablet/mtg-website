import { getPlayer } from '../auth.js'
import { navigate } from '../router.js'

export function renderInfo(container) {
  if (!getPlayer()) { navigate('#/login'); return }

  container.innerHTML = `
    <div class="page info-page">
      <a href="#/my-decks" class="back-link">&larr; Zurück</a>
      <h2>Wie funktioniert's?</h2>

      <section class="info-section">
        <h3>Preisberechnung</h3>
        <p>
          Kartenpreise stammen aus der <strong>Scryfall Bulk Data</strong>, die täglich automatisch
          synchronisiert wird. Pro Karte wird der <em>günstigste verfügbare Preis über alle Editionen</em>
          nach folgender Priorität gewählt:
        </p>
        <ol>
          <li><strong>EUR (non-foil)</strong> — Günstigstes Printing in Euro auf dem europäischen Markt</li>
          <li><strong>USD (non-foil) &times; 0.92</strong> — Falls kein EUR-Preis vorhanden, wird der US-Dollar-Preis mit einem festen Wechselkurs umgerechnet</li>
          <li><strong>EUR Foil</strong> — Manche Karten existieren nur als Foil-Version (z.B. Commander-Precon-Exklusives). Diese werden mit einem <span class="foil-badge">✦</span> markiert</li>
          <li><strong>USD Foil &times; 0.92</strong> — Letzter Fallback für Karten die nur als Foil in USD gelistet sind</li>
        </ol>
        <p class="info-note">
          Die Preisdatenbank wird täglich um 08:00 Uhr aus dem Scryfall-Gesamtkatalog (~90.000 Printings) aktualisiert.
          "Preise aktualisieren" liest aus dieser vorberechneten Datenbank — kein langsames Karte-für-Karte-Abfragen mehr.
          Der Gesamtwert eines Decks errechnet sich aus der Summe aller Einzelpreise multipliziert mit der jeweiligen Kartenanzahl.
          Preise älter als 7 Tage werden als "veraltet" markiert.
        </p>
      </section>

      <section class="info-section">
        <h3>Bracket Estimation</h3>
        <p>
          Die Bracket-Einschätzung basiert auf dem offiziellen
          <strong>Commander Bracket System</strong> von Wizards of the Coast (April 2025).
          Das System teilt Decks in 5 Stufen ein:
        </p>
        <div class="info-brackets">
          <div class="info-bracket">
            <span class="info-bracket-num">1</span>
            <div>
              <strong>Exhibition</strong>
              <p>Thema vor Funktion. Keine Game Changers, kein MLD, keine Extra Turns, keine 2-Karten-Combos.</p>
            </div>
          </div>
          <div class="info-bracket">
            <span class="info-bracket-num">2</span>
            <div>
              <strong>Core</strong>
              <p>Fokussiert, aber nicht maximiert. Vergleichbar mit einem aktuellen Precon. Keine Game Changers.</p>
            </div>
          </div>
          <div class="info-bracket">
            <span class="info-bracket-num">3</span>
            <div>
              <strong>Upgraded</strong>
              <p>Über Precon-Niveau. Maximal 3 Game Changers erlaubt. Keine Extra Turns vor Runde 6.</p>
            </div>
          </div>
          <div class="info-bracket">
            <span class="info-bracket-num">4</span>
            <div>
              <strong>Optimized</strong>
              <p>Alle legalen Karten erlaubt. Viele Game Changers, Tutors, optimierte Manabasis.</p>
            </div>
          </div>
          <div class="info-bracket">
            <span class="info-bracket-num">5</span>
            <div>
              <strong>cEDH</strong>
              <p>Kompetitiv. Nur die stärksten Strategien, gebaut um im cEDH-Metagame zu bestehen.</p>
            </div>
          </div>
        </div>
      </section>

      <section class="info-section">
        <h3>Bewertungskriterien</h3>
        <p>Folgende Faktoren fließen in die automatische Einschätzung ein:</p>
        <div class="info-criteria">
          <div class="info-criterion">
            <strong>Game Changers</strong>
            <p>56 offizielle Karten die das Spiel stark beeinflussen (z.B. Rhystic Study, Demonic Tutor, Cyclonic Rift, Mana Vault). Mehr Game Changers = höheres Bracket.</p>
          </div>
          <div class="info-criterion">
            <strong>Tutors</strong>
            <p>Karten die gezielt andere Karten suchen. Erhöhen die Konsistenz und damit die Stärke eines Decks erheblich.</p>
          </div>
          <div class="info-criterion">
            <strong>Extra Turns</strong>
            <p>Karten die zusätzliche Züge gewähren (Time Warp, Expropriate, etc.). Nicht erlaubt in Bracket 1-2.</p>
          </div>
          <div class="info-criterion">
            <strong>Mass Land Destruction (MLD)</strong>
            <p>Armageddon, Obliterate und ähnliche. Nicht erlaubt in Bracket 1-3.</p>
          </div>
          <div class="info-criterion">
            <strong>Durchschnittliche Manakosten</strong>
            <p>Niedrigerer Durchschnitt deutet auf ein optimierteres Deck hin (&lt; 2.5 = stark optimiert).</p>
          </div>
          <div class="info-criterion">
            <strong>Deckwert</strong>
            <p>Teurere Decks nutzen tendenziell stärkere Karten. Ab 500€ und 1500€ gibt es Zuschläge.</p>
          </div>
        </div>
        <p class="info-note">
          Die Einschätzung ist eine <em>Näherung</em> — das offizielle Bracket-System betont,
          dass die Spielabsicht wichtiger ist als eine reine Checkliste.
          Im Zweifel ist das eigene Urteil entscheidend.
        </p>
      </section>

      <section class="info-section">
        <h3>Quellen</h3>
        <ul class="info-sources">
          <li><a href="https://scryfall.com/docs/api" target="_blank">Scryfall REST API</a> — Kartenpreise & Daten</li>
          <li><a href="https://magic.wizards.com/en/news/announcements/commander-brackets-beta-update-april-22-2025" target="_blank">Commander Brackets Beta Update (April 2025)</a> — Offizielle Bracket-Kriterien & Game Changers</li>
          <li><a href="https://andrewgioia.github.io/Mana/" target="_blank">Mana Font</a> — Mana-Symbol-Icons</li>
        </ul>
      </section>
    </div>
  `
}

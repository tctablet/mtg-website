// roles.mjs — deterministische Karten-Rollen-Klassifikation (pure, testbar).
//
// Regex-Heuristik auf type_line + oracle_text eines Pool-Records. Eine Karte
// kann mehrere Rollen haben. Was keine Rolle trifft, ist "Synergie/unklassifiziert"
// — die Skill-Session kann solche Karten nachklassifizieren; das Ergebnis landet
// versioniert in scripts/optimizer/roles-overrides.json (mergeOverrides), nie
// still in einer Datenbank.
//
// Rollen-Vokabular (Command-Zone-Template Ep. 658 + Mill für das Saruman-Deck):
//   land, ramp, draw, removal, counter, wipe, tutor, protection, mill
// "interaction" ist keine eigene Rolle, sondern removal + counter + wipe
// (für die Dichte-Metrik im Gauntlet).

// Versioniert die Klassifikations-REGELN (nicht die Datei): das Pool-Asset des
// Wizards backt Rollen zur Build-Zeit ein — ändert sich die Heuristik, MUSS
// diese Zahl hochgezählt werden, damit der Client den Drift erkennt und ein
// Warnbanner zeigt (Plan M5, rolesVersion-Vertrag). Test erzwingt Konsistenz.
export const ROLES_VERSION = 1

const RE = {
  // Ramp: Mana-Artefakte/-Kreaturen ("{T}: Add …") oder Land-Ramp
  // ("search your library for a … land … battlefield"). Länder selbst zählen nie.
  manaAbility: /\{t\}(?:, [^:]+)?: add /,
  anyAdd: /\badd (?:\{|one mana|two mana|x mana|an amount of mana)/,
  landRamp: /search (?:your|their) library for .{0,40}land .{0,80}(?:onto the battlefield|battlefield)/,
  putLandFromHand: /put (?:a|up to \w+) land cards? from your hand onto the battlefield/,
  treasure: /create .{0,40}treasure token/,

  draw: /draws? (?:a|an additional|two|three|four|five|six|seven|x|that many) cards?|draws? cards equal to/,
  // Gegner-Draw-Filter, zweistufig (Critic-Regression Runde 2 beachtet):
  // - opponentDraw: Subjekte, die IMMER Gegner sind ("its controller",
  //   "each opponent", "target opponent" …) — werden immer gestrippt.
  // - victimDraw: "that player draws" ist nur dann der Gegner, wenn davor ein
  //   gezielter Removal-Effekt steht (Baleful Mastery: Exil-Opfer zieht als
  //   Kompensation). Ohne Removal-Kontext ("each player's draw step, that
  //   player draws" — Howling Mine) bleibt es Draw.
  // "Target player draws X cards" (Stroke of Genius, Blue Sun's Zenith) wird
  // NICHT gestrippt — in EDH praktisch immer selbst-targeted.
  opponentDraw: /(?:that spell's controller|its controller|target opponent|an opponent|each opponent|defending player|each other player) (?:may )?draws? [^.\n]*(?:\.|$)/g,
  victimDraw: /that player (?:may )?draws? [^.\n]*(?:\.|$)/g,
  removalContext: /(?:destroy|exile)s? (?:up to \w+ )?target |deals? (?:\d+|x) damage to (?:target|any target)/,

  // Spot-Removal: gezieltes Zerstören/Exilen/Schaden/Sacrifice-Zwang.
  // Lookahead prüft nur das direkte Ziel — "destroy target land" ist kein
  // Removal-Slot, aber "exile target creature … search for a basic land"
  // (Path to Exile) sehr wohl.
  destroyTarget: /(?:destroy|exile)s? (?:up to \w+ )?target (?!land\b)/,
  damageTarget: /deals? (?:\d+|x) damage to (?:target|any target|each of up to)|damage divided (?:as you choose )?among/,
  fightBite: /fights? (?:up to one )?target|deals damage equal to its power to target/,
  sacrificeEdict: /(?:each|target) (?:other )?(?:opponent|player) sacrifices? (?:a|an|one|two) /,
  minusTarget: /target creature gets? [-−]\d+\/[-−]\d+/,

  counter: /counter target/,

  // Wipes: symmetrische Massen-Effekte. Bewusst eng — "each creature you
  // control gets +1/+1" (Anthem) darf NICHT matchen.
  wipe: /(?:destroy|exile) all |deals? \d+ damage to each creature|each creature gets? [-−]|all creatures get [-−]|sacrifices? all /,

  // Tutor: Bibliothekssuche, die KEIN Land-Ramp ist.
  tutorSearch: /search your library for (?!.{0,40}(?:basic )?land)/,

  protection: /(?:gains? |have |gain )(?:hexproof|indestructible|protection from|shroud)|phases? out|can't be targeted/,

  mill: /\bmills?\b|puts? the top .{0,30}cards? of (?:their|your|his or her|that player's|each player's|target player's) library into (?:their|your|his or her|its owner's) graveyard/,

  anyNumber: /a deck can have any number of cards named/i,
}

export function classifyCard(record) {
  const roles = new Set()
  const type = (record.type_line || '').toLowerCase()
  const text = (record.oracle_text || '').toLowerCase()

  if (type.includes('land')) {
    roles.add('land')
    // MDFC mit Land-Rückseite zählt als Land-Slot UND behält Spell-Rollen der
    // Vorderseite (unten weiter klassifiziert).
    if (!type.includes('//') && record.layout !== 'modal_dfc') return [...roles]
  }

  const isMana =
    (RE.manaAbility.test(text) || RE.anyAdd.test(text)) &&
    !type.includes('land')
  if (isMana || RE.landRamp.test(text) || RE.putLandFromHand.test(text) || RE.treasure.test(text)) {
    roles.add('ramp')
  }
  // Gegner-Draw-Sätze entfernen, bevor der Draw-Match läuft (Baleful-Mastery-
  // Klasse: Removal mit "that player draws a card"-Kompensation ist kein Draw).
  let ownText = text.replace(RE.opponentDraw, '')
  if (RE.removalContext.test(text)) ownText = ownText.replace(RE.victimDraw, '')
  if (RE.draw.test(ownText)) roles.add('draw')
  if (
    RE.destroyTarget.test(text) || RE.damageTarget.test(text) ||
    RE.fightBite.test(text) || RE.sacrificeEdict.test(text) || RE.minusTarget.test(text)
  ) {
    roles.add('removal')
  }
  if (RE.counter.test(text)) roles.add('counter')
  if (RE.wipe.test(text)) roles.add('wipe')
  if (RE.tutorSearch.test(text) && !RE.landRamp.test(text)) roles.add('tutor')
  if (RE.protection.test(text)) roles.add('protection')
  if (RE.mill.test(text)) roles.add('mill')

  return [...roles]
}

// Overrides (aus roles-overrides.json): { "Card Name": ["ramp", ...] } —
// ersetzen die Heuristik-Rollen der Karte komplett (bewusste menschliche/
// LLM-Entscheidung schlägt Regex).
export function mergeOverrides(name, heuristicRoles, overrides) {
  const o = overrides?.[name]
  return Array.isArray(o) ? [...o] : heuristicRoles
}

// Darf mehrfach im Deck liegen? (Basics + "any number"-Karten wie Relentless Rats)
export function allowsMultiples(record) {
  const type = (record.type_line || '')
  if (/\bBasic\b/.test(type) && /\bLand\b/.test(type)) return true
  return RE.anyNumber.test(record.oracle_text || '')
}

// Instant-Speed-Anteil für die Antwort-Parity-Metrik: zählt Interaktion,
// die in gegnerischen Zügen spielbar ist (Instant oder Flash).
export function isInstantSpeed(record) {
  const type = (record.type_line || '').toLowerCase()
  return type.includes('instant') || (record.keywords || []).includes('Flash')
}

export const INTERACTION_ROLES = ['removal', 'counter', 'wipe']

export function isInteraction(roles) {
  return roles.some(r => INTERACTION_ROLES.includes(r))
}

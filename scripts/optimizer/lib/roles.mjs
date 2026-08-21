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
export const ROLES_VERSION = 3

const RE = {
  // Ramp: Mana-Artefakte/-Kreaturen ("{T}: Add …") oder Land-Ramp
  // ("search your library for a … land … battlefield"). Länder selbst zählen nie.
  manaAbility: /\{t\}(?:, [^:]+)?: add /,
  anyAdd: /\badd (?:\{|one mana|two mana|x mana|an amount of mana)/,
  landRamp: /search (?:your|their) library for .{0,40}land .{0,80}(?:onto the battlefield|battlefield)/,
  putLandFromHand: /put (?:a|up to \w+) land cards? from your hand onto the battlefield/,
  // Nur Eigenproduktion ("create …"): die 3.-Person-Form "creates" ist fast
  // immer ein anderer Spieler (Gonti-Klasse: "that player creates a Treasure").
  treasure: /create [^.\n]{0,40}treasure token/,
  // Replacement-Modifikator (Bilbo-Klasse: "If you WOULD create a Food token,
  // instead create … and a Treasure token") — modifiziert ein fremdes Event,
  // keine eigene Manaproduktion. Eigene bedingte Eskalationen ("If you rolled
  // 6 or higher, instead create that token and a Treasure token" — Mr. House)
  // haben kein "would create" und bleiben Ramp. Satzweise geprüft (classifyCard).
  treasureReplacement: /would create [^.\n]{0,80}instead[^.\n]{0,80}treasure token/,

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
  // Selbst-Ziel (Conjurer's-Closet-Blink): "you control" muss das direkt vom
  // Verb getroffene Ziel-Nomen modifizieren (Verb-Anker + max. 2 Zwischen-
  // wörter). Relativsätze/Präpositionen ("target creature that's attacking …
  // a planeswalker you control", "target Aura attached to a creature you
  // control") und spätere target-Referenzen im selben Satz (Calix-Klasse:
  // "… until target enchantment you control leaves") bleiben Removal.
  // "you don't control" matcht den String "you control" nicht.
  // Satzweise geprüft (classifyCard), analog zur Bounce-Regel.
  selfTarget: /(?:destroy|exile)s? (?:up to \w+ )?target (?:[a-z']+ ){0,2}(?:creature|permanent|artifact|enchantment|planeswalker|aura|token|card)s? you control\b/,
  damageTarget: /deals? (?:\d+|x) damage to (?:target|any target|each of up to)|damage divided (?:as you choose )?among/,
  fightBite: /fights? (?:up to one )?target|deals damage equal to its power to target/,
  sacrificeEdict: /(?:each|target) (?:other )?(?:opponent|player) sacrifices? (?:a|an|one|two) /,
  minusTarget: /target creature gets? [-−]\d+\/[-−]\d+/,

  counter: /counter target/,

  // Bounce als Removal (Cyclonic-Rift-Klasse, User-Fund 06.08.): "return
  // target/all … <Permanent-Typ> … to its owner's hand". Typ-Wort ist Pflicht —
  // "return IT to its owner's hand" (Selbst-Rückholer) darf nie matchen.
  // "(creature) CARD" ausgeschlossen: Karten in Friedhof/Exil sind Rekursion,
  // kein Board-Removal (Critic-Fund: Called-Back-Klasse).
  // Selbst-Bounce ("… you control") zählt nicht, außer "you DON'T control".
  bounce: /returns? (?:each |all |up to \w+ )?(?:target |any number of )?[^.\n]{0,40}?(?:creature|permanent|artifact|enchantment|planeswalker|nonland)(?!s? cards?\b)[^.\n]{0,40}to (?:its|their) owner(?:'s|s') hands?/,

  // Wipes: symmetrische Massen-Effekte. Bewusst eng — "each creature you
  // control gets +1/+1" (Anthem) darf NICHT matchen.
  wipe: /(?:destroy|exile) all |deals? \d+ damage to each creature|each creature gets? [-−]|all creatures get [-−]|sacrifices? all /,

  // Tutor: Bibliothekssuche, die KEIN Land-Ramp ist.
  tutorSearch: /search your library for (?!.{0,40}(?:basic )?land)/,

  protection: /(?:gains? |has |have )(?:hexproof|indestructible|protection from|shroud)|phases? out|can't be targeted/,

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
  // Treasure satzweise: nur Sätze ohne "would create … instead"-Replacement
  // (Bilbo-Klasse) zählen als eigene Manaproduktion.
  const treasureRamp = RE.treasure.test(text) &&
    (text.match(/[^.\n]*create [^.\n]*treasure token[^.\n]*/g) || [])
      .some(s => RE.treasure.test(s) && !RE.treasureReplacement.test(s))
  if (isMana || RE.landRamp.test(text) || RE.putLandFromHand.test(text) || treasureRamp) {
    roles.add('ramp')
  }
  // Gegner-Draw-Sätze entfernen, bevor der Draw-Match läuft (Baleful-Mastery-
  // Klasse: Removal mit "that player draws a card"-Kompensation ist kein Draw).
  // Sätze, in denen als Folge DU ziehst ("Whenever an opponent draws a card,
  // you may draw two cards" — Consecrated-Sphinx-Klasse), bleiben stehen:
  // das ist eine eigene Draw-Engine, kein Gegner-Draw.
  let ownText = text.replace(RE.opponentDraw, (m) => (/\byou (?:may )?draw/.test(m) ? m : ''))
  if (RE.removalContext.test(text)) ownText = ownText.replace(RE.victimDraw, '')
  if (RE.draw.test(ownText)) roles.add('draw')
  // destroyTarget satzweise: Sätze, deren Ziel ein Selbst-Permanent ist
  // ("exile target creature you control" — Blink), zählen nicht.
  const destroyRemoval = RE.destroyTarget.test(text) &&
    (text.match(/[^.\n]*(?:destroy|exile)[^.\n]*/g) || [])
      .some(s => RE.destroyTarget.test(s) && !RE.selfTarget.test(s))
  if (
    destroyRemoval || RE.damageTarget.test(text) ||
    RE.fightBite.test(text) || RE.sacrificeEdict.test(text) || RE.minusTarget.test(text)
  ) {
    roles.add('removal')
  }
  // Bounce satzweise prüfen: der Satz darf kein Selbst-Bounce sein —
  // weder "you control" (ohne "don't") noch "return this creature"-
  // Selbstschutz (Critic-Fund). Rift ("you don't control") bleibt drin.
  if (RE.bounce.test(text)) {
    const sentences = text.match(/[^.\n]*returns? [^.\n]*owner[^.\n]*hands?[^.\n]*/g) || []
    if (sentences.some(s =>
      RE.bounce.test(s) &&
      !/returns? (?:this|that) /.test(s) &&
      (!/you control/.test(s) || /don't control/.test(s))
    )) {
      roles.add('removal')
    }
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

// Import-Skript für die 3 Resterampe-Precons.
// Voraussetzung: SQL-Migration migrations/001_resterampe.sql ist ausgeführt.
// Run: node scripts/import-precons.mjs

const SUPABASE_URL = 'https://jcbdjlqxmlsfqfenltws.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpjYmRqbHF4bWxzZnFmZW5sdHdzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0NzczNDUsImV4cCI6MjA4OTA1MzM0NX0.S87-oIgyMjB1Jdc-2LW4b0mlnUkoFw_SjltpMAB6lvc'
const PHILIP_ID = '4669a98d-e04a-422b-b770-6fa0bab8522f'

const SCRYFALL = 'https://api.scryfall.com'
const USD_TO_EUR = 0.92

const TYPE_ORDER = [
  ['creature', 'Creature'],
  ['planeswalker', 'Planeswalker'],
  ['instant', 'Instant'],
  ['sorcery', 'Sorcery'],
  ['enchantment', 'Enchantment'],
  ['artifact', 'Artifact'],
  ['land', 'Land'],
  ['battle', 'Battle'],
]

function getTypeCategory(typeLine) {
  if (!typeLine) return 'other'
  for (const [key, match] of TYPE_ORDER) {
    if (typeLine.includes(match)) return key
  }
  return 'other'
}

function pickPrice(prices) {
  if (!prices) return { price: null, isFoil: false }
  if (prices.eur) return { price: parseFloat(prices.eur), isFoil: false }
  if (prices.usd) return { price: parseFloat(prices.usd) * USD_TO_EUR, isFoil: false }
  if (prices.eur_foil) return { price: parseFloat(prices.eur_foil), isFoil: true }
  if (prices.usd_foil) return { price: parseFloat(prices.usd_foil) * USD_TO_EUR, isFoil: true }
  return { price: null, isFoil: false }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)) }

function parseList(text) {
  const out = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('//') || t.startsWith('#')) continue
    const m = t.match(/^(\d+)\s+(.+)$/)
    if (m) out.push({ quantity: parseInt(m[1], 10), name: m[2].trim() })
  }
  return out
}

async function scryfallCollection(names) {
  const found = []
  const notFound = []
  for (let i = 0; i < names.length; i += 75) {
    if (i > 0) await delay(120)
    const identifiers = names.slice(i, i + 75).map(name => ({
      name: name.includes(' // ') ? name.split(' // ')[0] : name
    }))
    const res = await fetch(`${SCRYFALL}/cards/collection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifiers }),
    })
    if (!res.ok) throw new Error(`Scryfall: ${res.status}`)
    const data = await res.json()
    found.push(...(data.data || []))
    notFound.push(...(data.not_found || []).map(x => x.name))
  }
  return { found, notFound }
}

async function fetchByName(name) {
  const res = await fetch(`${SCRYFALL}/cards/named?exact=${encodeURIComponent(name)}`)
  if (!res.ok) return null
  return await res.json()
}

function getArtCrop(card) {
  return card?.image_uris?.art_crop
    || card?.card_faces?.[0]?.image_uris?.art_crop
    || null
}

function getNormalImage(card) {
  return card?.image_uris?.normal
    || card?.card_faces?.[0]?.image_uris?.normal
    || null
}

function extractCardData(sc) {
  const p = pickPrice(sc.prices)
  return {
    name: sc.name,
    scryfall_id: sc.id,
    type_line: sc.type_line || '',
    type_category: getTypeCategory(sc.type_line || ''),
    mana_cost: sc.mana_cost || '',
    cmc: sc.cmc || 0,
    image_uri: getNormalImage(sc),
    price_eur: p.price,
    price_is_foil: p.isFoil,
    price_updated_at: new Date().toISOString(),
    commander_legality: sc.legalities?.commander || 'not_legal',
  }
}

async function supa(method, path, body) {
  const headers = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation',
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    const txt = await res.text()
    throw new Error(`Supabase ${method} ${path}: ${res.status} ${txt}`)
  }
  return await res.json()
}

async function importDeck({ name, commander, archetype, playstyle, sealedPrice, decklist }) {
  console.log(`\n=== ${name} (${commander}) ===`)
  const cards = parseList(decklist)
  console.log(`  ${cards.length} unique entries, ${cards.reduce((s, c) => s + c.quantity, 0)} total cards`)

  const names = cards.map(c => c.name)
  const { found, notFound } = await scryfallCollection(names)
  if (notFound.length) {
    console.error(`  ❌ Not found: ${notFound.join(', ')}`)
    throw new Error(`Cards not found: ${notFound.join(', ')}`)
  }

  const byName = new Map()
  for (const c of found) {
    byName.set(c.name.toLowerCase(), c)
    if (c.name.includes(' // ')) {
      byName.set(c.name.split(' // ')[0].toLowerCase(), c)
    }
  }

  const commanderCard = await fetchByName(commander)
  if (!commanderCard) throw new Error(`Commander not found: ${commander}`)
  const commanderImage = getArtCrop(commanderCard)

  const [deck] = await supa('POST', '/decks', [{
    player_id: PHILIP_ID,
    name,
    commander,
    commander_image: commanderImage,
    for_sale: true,
    sold: false,
    sealed_price_eur: sealedPrice,
    archetype,
    playstyle,
  }])
  console.log(`  ✓ Deck created: ${deck.id}`)

  const cardRows = []
  for (const entry of cards) {
    const sc = byName.get(entry.name.toLowerCase())
    if (!sc) {
      console.warn(`  ⚠ Skipping ${entry.name} (no Scryfall match)`)
      continue
    }
    cardRows.push({ deck_id: deck.id, ...extractCardData(sc), quantity: entry.quantity })
  }

  // Insert in chunks of 50
  for (let i = 0; i < cardRows.length; i += 50) {
    await supa('POST', '/cards', cardRows.slice(i, i + 50))
  }
  console.log(`  ✓ ${cardRows.length} cards inserted`)
}

const SATYA = `
1 Satya, Aetherflux Genius
1 Aethergeode Miner
1 Amped Raptor
1 Aurora Shifter
1 Grenzo, Havoc Raiser
1 Roil Cartographer
1 Burnished Hart
1 Overclocked Electromancer
1 Professional Face-Breaker
1 Razorfield Ripper
1 Skyclave Apparition
1 Whirler Virtuoso
1 Aetherstorm Roc
1 Cayth, Famed Mechanist
1 Solemn Simulacrum
1 Angel of Invention
1 Goldspan Dragon
1 Lightning Runner
1 Silverquill Lecturer
1 Sphinx of the Revelation
1 Aethertide Whale
1 Brudiclad, Telchor Engineer
1 Combustible Gearhulk
1 Aethersquall Ancient
1 Myr Battlesphere
1 Blaster Hulk
1 Salvation Colossus
1 Swords to Plowshares
1 Akroma's Will
1 Glimmer of Genius
1 Jolted Awake
1 Tezzeret's Gambit
1 Confiscation Coup
1 Localized Destruction
1 Austere Command
1 Farewell
1 Sol Ring
1 Wayfarer's Bauble
1 Arcane Signet
1 Decoction Module
1 Izzet Generatorium
1 Solar Transformer
1 Talisman of Conviction
1 Talisman of Creativity
1 Talisman of Progress
1 Unstable Amulet
1 Aethersphere Harvester
1 Coalition Relic
1 Conversion Apparatus
1 Hourglass of the Lost
1 Midnight Clock
1 Aetherworks Marvel
1 Bespoke Battlewagon
1 Filigree Racer
1 Stone Idol Generator
1 Aether Refinery
1 Coveted Jewel
1 Gonti's Aether Heart
1 Era of Innovation
1 Bident of Thassa
1 Scurry of Gremlins
1 Legion Loyalty
1 Adarkar Wastes
1 Aether Hub
1 Azorius Chancery
1 Battlefield Forge
1 Castle Vantress
1 Command Tower
1 Demolition Field
1 Frostboil Snarl
1 Furycalm Snarl
5 Island
1 Izzet Boilerworks
5 Mountain
1 Mystic Gate
1 Mystic Monastery
10 Plains
1 Port Town
1 Prairie Stream
1 Shivan Reef
1 Temple of Enlightenment
1 Temple of Epiphany
1 Temple of Triumph
`

const NEYALI = `
1 Neyali, Suns' Vanguard
1 Dragonmaster Outcast
1 Loyal Apprentice
1 Legion Warboss
1 Mentor of the Meek
1 Prava of the Steel Legion
1 Emeria Angel
1 Goldnight Commander
1 Phantom General
1 Solemn Simulacrum
1 Adriana, Captain of the Guard
1 Jor Kadeen, the Prevailer
1 Otharri, Suns' Glory
1 Siege-Gang Commander
1 Harmonious Archon
1 Silverwing Squadron
1 Myr Battlesphere
1 Elspeth Tirel
1 Path to Exile
1 Boros Charm
1 Call the Coppercoats
1 Flawless Maneuver
1 Generous Gift
1 Midnight Haunting
1 White Sun's Zenith
1 Clever Concealment
1 Finale of Glory
1 Martial Coup
1 Rip Apart
1 Collective Effort
1 Cut a Deal
1 Hordeling Outburst
1 Battle Screech
1 Chain Reaction
1 Hate Mirage
1 Heroic Reinforcements
1 Increasing Devotion
1 Hour of Reckoning
1 Goldwardens' Gambit
1 Sol Ring
1 Soul-Guide Lantern
1 Arcane Signet
1 Boros Signet
1 Fellwar Stone
1 Glimmer Lens
1 Idol of Oblivion
1 Mask of Memory
1 Mind Stone
1 Staff of the Storyteller
1 Talisman of Conviction
1 Commander's Sphere
1 Loxodon Warhammer
1 Mace of the Valiant
1 Maul of the Skyclaves
1 Vulshok Factory
1 Kemba's Banner
1 Hexplate Wallbreaker
1 Intangible Virtue
1 Roar of Resistance
1 Court of Grace
1 Felidar Retreat
1 Assemble the Legion
1 Boros Garrison
1 Buried Ruin
1 Castle Ardenvale
1 Castle Embereth
1 Command Tower
1 Exotic Orchard
1 Forgotten Cave
1 Furycalm Snarl
1 Kher Keep
11 Mountain
1 Myriad Landscape
1 Path of Ancestry
11 Plains
1 Secluded Steppe
1 Slayers' Stronghold
1 Temple of Triumph
1 Temple of the False God
1 Windbrisk Heights
`

const FIRKRAAG = `
1 Firkraag, Cunning Instigator
1 Sprite Dragon
1 Agitator Ant
1 Bothersome Quasit
1 Burnished Hart
1 Chaos Dragon
1 Goblin Spymaster
1 Mocking Doppelganger
1 Sly Instigator
1 Solemn Simulacrum
1 Territorial Hellkite
1 Vengeful Ancestor
1 Baeloth Barrityl, Entertainer
1 Brash Taunter
1 Kazuul, Tyrant of the Cliffs
1 Stuffy Doll
1 Death Kiss
1 Geode Rager
1 Keiga, the Tide Star
1 Niv-Mizzet, Parun
1 Ryusei, the Falling Star
1 Steel Hellkite
1 Warmonger Hellkite
1 Angler Turtle
1 Drakuseth, Maw of Flames
1 Pursued Whale
1 Thunder Dragon
1 Astral Dragon
1 Avatar of Slaughter
1 Rowan Kenrith
1 Will Kenrith
1 Chaos Warp
1 Domineering Will
1 Reins of Power
1 Curse of the Swine
1 Spectacular Showdown
1 Compulsive Research
1 Chain Reaction
1 Disrupt Decorum
1 Aether Gale
1 Blasphemous Act
1 Sol Ring
1 Wayfarer's Bauble
1 Arcane Signet
1 Bloodthirsty Blade
1 Fellwar Stone
1 Izzet Signet
1 Mind Stone
1 Talisman of Creativity
1 Dragon's Hoard
1 Midnight Clock
1 Hedron Archive
1 Curse of Opulence
1 Artificer Class
1 Clan Crafter
1 Curse of Verbosity
1 Propaganda
1 Psychic Impetus
1 Shiny Impetus
1 Dissipation Field
1 Loot Dispute
1 The Akroan War
1 Ash Barrens
1 Castle Vantress
1 Command Tower
1 Desolate Lighthouse
12 Island
1 Izzet Boilerworks
1 Kher Keep
12 Mountain
1 Myriad Landscape
1 Path of Ancestry
1 Prismari Campus
1 Reliquary Tower
1 Temple of Epiphany
1 Temple of the False God
1 Terrain Generator
1 Wandering Fumarole
`

const DECKS = [
  {
    name: 'Creative Energy (MH3 Precon)',
    commander: 'Satya, Aetherflux Genius',
    archetype: 'Energy / Artifacts / Time-Counter',
    playstyle: 'Generiere Energie über Artefakte und ETB-Effekte und nutze Time-Counter für zusätzliche Combat-Phasen. Snowball-Plan: Satya kopiert deine besten Karten und du hämmerst mit doppelten Trigger-Stacks zu.',
    sealedPrice: 49.90,
    decklist: SATYA,
  },
  {
    name: "Rebellion Rising (ONE Precon)",
    commander: "Neyali, Suns' Vanguard",
    archetype: 'Boros Token Aggro',
    playstyle: 'Flutet das Board mit weißen Soldaten- und Inspired-Tokens und greift parallel mit doppeltem Damage-Trigger an. Wide-Aggro mit Anthems, double-strike Synergien und Equipment-Support.',
    sealedPrice: 59.90,
    decklist: NEYALI,
  },
  {
    name: 'Draconic Dissent (CLB Precon)',
    commander: 'Firkraag, Cunning Instigator',
    archetype: 'Izzet Goad / Group Slug',
    playstyle: 'Goade Gegner-Kreaturen damit sie sich gegenseitig zerlegen, ziehe selbst Karten von ihren Angriffen und schließe mit fetten Drachen ab. Politisch wertvoll — du bist nie das primäre Ziel.',
    sealedPrice: 89.90,
    decklist: FIRKRAAG,
  },
]

async function main() {
  const skip = (process.env.SKIP || '').split(';').map(s => s.trim()).filter(Boolean)
  const only = (process.env.ONLY || '').split(';').map(s => s.trim()).filter(Boolean)
  for (const deck of DECKS) {
    if (only.length && !only.includes(deck.commander)) continue
    if (skip.includes(deck.commander)) {
      console.log(`\n=== Skip ${deck.name} ===`)
      continue
    }
    try {
      await importDeck(deck)
    } catch (err) {
      console.error(`❌ ${deck.name}: ${err.message}`)
      process.exit(1)
    }
  }
  console.log('\n✓ Import complete. Open #/resterampe to verify.')
}

main()

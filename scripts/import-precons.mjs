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

// Parses both plain "N Name" lists and MTGA exports like "N Name (SET) 123 *F*".
// Aggregates multiple entries with the same canonical name (e.g. multiple
// Mountain printings get summed into one entry).
function parseList(text) {
  const counts = new Map()
  const order = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    if (/^\/\//.test(line)) continue
    if (/^#(?!\s*!)/.test(line)) continue
    if (/^SB:\s*/i.test(line)) continue
    if (/^(commander|deck|sideboard|companion|maybeboard):?$/i.test(line)) continue

    const m = line.match(/^(\d+)x?\s+(.+?)(?:\s*\(([\w-]+)\)\s*[\w-]*)?(?:\s*\*F\*)?$/)
    if (!m) continue
    const qty = parseInt(m[1], 10)
    let name = m[2].trim().replace(/\s*#.*$/, '').trim()
    // Strip leading [SET] (deckstats variant)
    name = name.replace(/^\[[\w-]+\]\s*/, '').trim()
    if (!name) continue
    if (counts.has(name)) {
      counts.set(name, counts.get(name) + qty)
    } else {
      counts.set(name, qty)
      order.push(name)
    }
  }
  return order.map(name => ({ name, quantity: counts.get(name) }))
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

async function importDeck({ name, commander, commander2, archetype, playstyle, sealedPrice, decklist, deckType = 'precon' }) {
  console.log(`\n=== ${name} (${commander}${commander2 ? ' + ' + commander2 : ''}) ===`)
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

  let commander2Image = null
  if (commander2) {
    const c2 = await fetchByName(commander2)
    if (!c2) throw new Error(`Partner commander not found: ${commander2}`)
    commander2Image = getArtCrop(c2)
  }

  const deckRow = {
    player_id: PHILIP_ID,
    name,
    commander,
    commander_image: commanderImage,
    for_sale: true,
    sold: false,
    sealed_price_eur: sealedPrice ?? null,
    archetype,
    playstyle,
    deck_type: deckType,
  }
  if (commander2) {
    deckRow.commander2 = commander2
    deckRow.commander2_image = commander2Image
  }
  const [deck] = await supa('POST', '/decks', [deckRow])
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

const KAUST = `
1 Kaust, Eyes of the Glade
1 Ainok Survivalist
1 Broodhatch Nantuko
1 Den Protector
1 Hidden Dragonslayer
1 Hooded Hydra
1 Master of Pearls
1 Nervous Gardener
1 Printlifter Ooze
1 Sakura-Tribe Elder
1 Deathmist Raptor
1 Mirror Entity
1 Welcoming Vampire
1 Ashcloud Phoenix
1 Beast Whisperer
1 Boltbender
1 Experiment Twelve
1 Nantuko Vigilante
1 Salt Road Ambushers
1 Saryth, the Viper's Fang
1 Sidar Kondo of Jamuraa
1 Tesak, Judith's Hellhound
1 Thelonite Hermit
1 Toski, Bearer of Secrets
1 Duskana, the Rage Mother
1 Neheb, the Eternal
1 Ohran Frostfang
1 Seedborn Muse
1 Whisperwood Elemental
1 Yedora, Grave Gardener
1 Exalted Angel
1 Root Elemental
1 Scourge of the Throne
1 Temur War Shaman
1 Imperial Hellkite
1 Akroma, Angel of Fury
1 Krosan Colossus
1 Krosan Cloudscraper
1 Path to Exile
1 Chaos Warp
1 Unexplained Absence
1 Return of the Wildspeaker
1 Showstopping Surprise
1 Nature's Lore
1 Three Visits
1 Jeska's Will
1 Decimate
1 Fell the Mighty
1 Austere Command
1 Dusk // Dawn
1 Ransom Note
1 Sol Ring
1 Arcane Signet
1 Lifecrafter's Bestiary
1 Scroll of Fate
1 Panoptic Projektor
1 Obscuring Aether
1 Wild Growth
1 Mastery of the Unseen
1 Trail of Mystery
1 True Identity
1 Ugin's Mastery
1 Veiled Ascension
1 Boros Garrison
1 Branch of Vitu-Ghazi
1 Canopy Vista
1 Cinder Glade
1 Command Tower
1 Exotic Orchard
4 Forest
1 Fortified Village
1 Furycalm Snarl
1 Game Trail
1 Gruul Turf
1 Jungle Shrine
1 Kessig Wolf Run
1 Krosan Verge
1 Mossfire Valley
1 Mosswort Bridge
3 Mountain
4 Plains
1 Sacred Peaks
1 Scattered Groves
1 Selesnya Sanctuary
1 Sheltered Thicket
1 Shrine of the Forsaken Gods
1 Sungrass Prairie
1 Temple of Abandon
1 Temple of Plenty
1 Temple of Triumph
1 Temple of the False God
1 Zoetic Cavern
`

const FRODO_SAM = `
1 Frodo, Adventurous Hobbit
1 Sam, Loyal Attendant
1 Birds of Paradise
1 Essence Warden
1 Gilded Goose
1 Banquet Guests
1 Farmer Cotton
1 Feasting Hobbit
1 Gollum, Obsessed Stalker
1 Pippin, Warden of Isengard
1 Prize Pig
1 Prosperous Innkeeper
1 Shire Shirriff
1 Bilbo, Birthday Celebrant
1 Lobelia, Defender of Bag End
1 Mentor of the Meek
1 Merry, Warden of Isengard
1 Rapacious Guest
1 Rosie Cotton of South Lane
1 Savvy Hunter
1 The Gaffer
1 Tireless Provisioner
1 Butterbur, Bree Innkeeper
1 Mirkwood Bats
1 Treebeard, Gracious Host
1 Gwaihir, Greatest of the Eagles
1 Landroval, Horizon Witness
1 Motivated Pony
1 Eagles of the North
1 Generous Ent
1 Great Oak Guardian
1 Orchard Strider
1 Woodfall Primus
1 Swords to Plowshares
1 Go for the Throat
1 Anguished Unmaking
1 Crypt Incursion
1 Mortify
1 Sylvan Offering
1 Farseek
1 Night's Whisper
1 Revive the Shire
1 Cultivate
1 Toxic Deluge
1 Harmonize
1 Fell the Mighty
1 Fumigate
1 Dusk // Dawn
1 Sol Ring
1 Arcane Signet
1 Hithlain Rope
1 Chromatic Lantern
1 Commander's Sphere
1 Field-Tested Frying Pan
1 Pristine Talisman
1 Trading Post
1 Well of Lost Dreams
1 Dawn of Hope
1 Of Herbs and Stewed Rabbit
1 Assemble the Entmoot
1 Call for Unity
1 Sanguine Bond
1 Access Tunnel
1 Ash Barrens
1 Brushland
1 Canopy Vista
1 Command Tower
1 Evolving Wilds
1 Exotic Orchard
8 Forest
1 Fortified Village
1 Ghost Quarter
1 Graypelt Refuge
1 Isolated Chapel
1 Murmuring Bosk
1 Necroblossom Snarl
1 Path of Ancestry
4 Plains
1 Rogue's Passage
1 Sandsteppe Citadel
1 Scattered Groves
1 Scoured Barrens
1 Shineshadow Snarl
1 Shire Terrace
1 Sunpetal Grove
4 Swamp
1 Woodland Cemetery
`

const JARED = `
1 Jared Carthalion
1 Baleful Strix
1 Coiling Oracle
1 Hero of Precinct One
1 Jenson Carthalion, Druid Exile
1 Tiller Engine
1 Faeburrow Elder
1 Fallaji Wayfarer
1 Selvala, Explorer Returned
1 Archelos, Lagoon Mystic
1 Atla Palani, Nest Tender
1 Glint-Eye Nephilim
1 Knight of New Alara
1 Solemn Simulacrum
1 Transguild Courier
1 Zaxara, the Exemplary
1 Chromanticore
1 Fusion Elemental
1 Illuna, Apex of Wishes
1 Maelstrom Archangel
1 Nethroi, Apex of Death
1 Rienne, Angel of Rebirth
1 Surrak Dragonclaw
1 Xyris, the Writhing Storm
1 O-Kagachi, Vengeful Kami
1 Two-Headed Hellkite
1 Primeval Spawn
1 Path to Exile
1 Echoing Truth
1 Growth Spiral
1 Terminate
1 Abzan Charm
1 Beast Within
1 Naya Charm
1 Sultai Charm
1 Sylvan Reclamation
1 Unite the Coalition
1 Explore
1 Farseek
1 Cultivate
1 Kodama's Reach
1 Lavalanche
1 Painful Truths
1 Radiant Flames
1 Search for Tomorrow
1 Explosive Vegetation
1 Migration Path
1 Iridian Maelstrom
1 Time Wipe
1 Merciless Eviction
1 Duneblast
1 Arcane Signet
1 Fellwar Stone
1 Obsidian Obelisk
1 Prophetic Prism
1 Coalition Relic
1 Commander's Sphere
1 Abundant Growth
1 Path to the World Tree
1 Mana Cannons
1 Maelstrom Nexus
1 Arcane Sanctum
1 Bad River
1 Canopy Vista
1 Cascading Cataracts
1 Cinder Glade
1 Command Tower
1 Crumbling Necropolis
1 Crystal Quarry
1 Evolving Wilds
1 Exotic Orchard
1 Flood Plain
3 Forest
1 Frontier Bivouac
1 Grasslands
2 Island
1 Jungle Shrine
1 Krosan Verge
2 Mountain
1 Mountain Valley
1 Murmuring Bosk
1 Mystic Monastery
1 Nomad Outpost
1 Opulent Palace
2 Plains
1 Prairie Stream
1 Rocky Tar Pit
1 Sandsteppe Citadel
1 Savage Lands
1 Seaside Citadel
1 Smoldering Marsh
1 Sunken Hollow
2 Swamp
1 Terramorphic Expanse
`

const PROSPER = `
// COMMANDER
1 Prosper, Tome-Bound (AFC) 2 *F*

1 Apex of Power
1 Arcane Signet
1 Bedevil
1 Bituminous Blast
1 Bojuka Bog
1 Breeches, Eager Pillager
1 Bucknard's Everfull Purse
1 Chaos Channeler
1 Chaos Wand
1 Chaos Warp
1 Command Tower
1 Commander's Sphere
1 Commune with Lava
1 Consuming Vapors
1 Dead Man's Chest
1 Dire Fleet Daredevil
1 Dream Devourer
1 Dream Pillager
1 Etali, Primal Storm
1 Exotic Orchard
1 Fellwar Stone
1 Fevered Suspicion
1 Florian, Voldaren Scion
1 Foreboding Ruins
1 Gonti, Lord of Luxury
1 Grim Hireling
1 Haunted Ridge
1 Hex
1 Hidetsugu, Devouring Chaos
1 Hit the Mother Lode
1 Hurl Through Hell
1 Ignite the Future
1 Ingenious Artillerist
1 Izzet Chemister
1 Juri, Master of the Revue
1 Kalain, Reclusive Painter
1 Magmatic Channeler
1 Marionette Master
1 Mayhem Devil
1 Mind Stone
1 Mirkwood Bats
1 Mortuary Mire
3 Mountain (AFR) 277
2 Mountain (AFR) 275
1 Mountain (VOW) 274
1 Mountain (NEO) 299
1 Mountain (DSK) 284
1 Nadier's Nightblade
1 Oracle's Vault
1 Orazca Relic
1 Outpost Siege
1 Poison the Cup
1 Pontiff of Blight
1 Rakdos Carnarium
1 Rakdos Charm
1 Rakdos Signet
1 Reckless Endeavor
1 Shadowblood Ridge
1 Smoldering Marsh
5 Snow-Covered Mountain
6 Snow-Covered Swamp
1 Sol Ring
1 Spinerock Knoll
1 Stolen Strategy
1 Swamp (VOW) 273
1 Swamp (UNF) 237 *F*
1 Swamp (MOM) 286
1 Swamp (WHO) 201
1 Swamp (WHO) 201 *F*
1 Swamp (LCI) 289 *F*
1 Tainted Peak
1 Talisman of Indulgence
1 Tectonic Giant
1 Terminate
1 The Ruinous Powers
1 Theater of Horrors
1 Throes of Chaos
1 Two-Headed Hunter
1 Underdark Rift
1 Unstable Obelisk
1 Valakut Exploration
1 Vandalblast
1 Visions of Phyrexia
1 Wild-Magic Sorcerer
1 You Find Some Prisoners
1 Zhalfirin Void
`

const ALANIA = `
// COMMANDER
1 Alania, Divergent Storm

1 Aetherize
1 Alania's Pathmaker
1 Arcane Signet
1 Archmage Emeritus
1 Big Score
1 Blasphemous Act
1 Brainstorm
1 Bria, Riptide Rogue
1 Cascade Bluffs
1 Case of the Ransacked Lab
1 Chaos Warp
1 Command Tower
1 Commander's Sphere
1 Conduct Electricity
1 Coruscation Mage
1 Counterspell
1 Daring Waverider
1 Deflecting Swat
1 Disrupt
1 Distant Melody
1 Eon Frolicker
1 Eroded Canyon
1 Expedite
1 Ferrous Lake
1 Flame of Anor
1 Forger's Foundry
1 Frantic Search
1 Frolicking Familiar
1 Halimar Depths
1 Harmonic Prodigy
1 Harnesser of Storms
1 Haze of Rage
2 Island (BLB) 266
3 Island (BLB) 269
3 Island (BLB) 268
3 Island (BLB) 267
1 Izzet Signet
1 Jin-Gitaxias, Progress Tyrant
1 Kindlespark Duo
1 Kitsa, Otterball Elite
1 Lightning Greaves
1 Lightshell Duo
3 Mountain (BLB) 275
3 Mountain (BLB) 276
3 Mountain (BLB) 277
3 Mountain (BLB) 274
1 Mystic Sanctuary
1 Opt
1 Otterball Antics
1 Pearl of Wisdom
1 Pongify
1 Poppet Stitcher
1 Preordain
1 Pull from Tomorrow
1 Ral, Crackling Wit
1 Rapid Augmenter
1 Reliquary Tower
1 Riptide Laboratory
1 River's Rebuke
1 Rogue's Passage
1 Run Away Together
1 Season of Weaving
1 Slick Sequence
1 Slip Through Space
1 Snap
1 Sol Ring
1 Song of Totentanz
1 Storm-Kiln Artist
1 Stormcarved Coast
1 Stormcatch Mentor
1 Stormchaser's Talent
1 Stormsplitter
1 Sulfur Falls
1 Talisman of Creativity
1 Tempest Angler
1 Thieving Otter
1 Thrill of Possibility
1 Thunderclap Drake
1 Thundertrap Trainer
1 Twinning Staff
1 Unsummon
1 Valley Floodcaller
1 Vandalblast
1 Veyran, Voice of Duality
`

const PERRIE = `
1 Perrie, the Pulverizer
1 Aven Courier
1 Devoted Druid
1 Grateful Apparition
1 Incubation Druid
1 Luminarch Aspirant
1 Scavenging Ooze
1 Skyship Plunderer
1 Steelbane Hydra
1 Thrummingbird
1 Wall of Roots
1 Angelic Sleuth
1 Aven Mimeomancer
1 Crystalline Giant
1 Evolution Sage
1 Jenara, Asura of War
1 Park Heights Maverick
1 Rishkar, Peema Renegade
1 Vorel of the Hull Clade
1 Wingspan Mentor
1 Denry Klin, Editor in Chief
1 Fathom Mage
1 Forgotten Ancient
1 Kros, Defense Contractor
1 Slippery Bogbonder
1 Wickerbough Elder
1 Avenging Huntbonder
1 Roalesk, Apex Hybrid
1 Shield Broker
1 Skyboon Evangelist
1 Bribe Taker
1 Ajani Unyielding
1 Bant Charm
1 Brokers Charm
1 Contractual Safeguard
1 Exotic Pets
1 Generous Gift
1 Storm of Forms
1 Brokers Confluence
1 Declaration in Stone
1 Tezzeret's Gambit
1 Damning Verdict
1 Planar Outburst
1 Urban Evolution
1 Rishkar's Expertise
1 Everflowing Chalice
1 Sol Ring
1 Arcane Signet
1 Fellwar Stone
1 Gavel of the Righteous
1 Power Conduit
1 Swiftfoot Boots
1 Agent's Toolkit
1 Commander's Sphere
1 Midnight Clock
1 Oblivion Stone
1 Oracle's Vault
1 Hoofprints of the Stag
1 Together Forever
1 Family's Favor
1 Primal Empathy
1 Resourceful Defense
1 Ash Barrens
1 Bant Panorama
1 Brokers Hideout
1 Canopy Vista
1 Command Tower
1 Exotic Orchard
1 Flooded Grove
5 Forest
1 Fortified Village
1 Gavony Township
4 Island
1 Karn's Bastion
1 Littjara Mirrorlake
1 Llanowar Reborn
1 Myriad Landscape
1 Nesting Grounds
1 Path of Ancestry
5 Plains
1 Port Town
1 Prairie Stream
1 Seaside Citadel
1 Skycloud Expanse
1 Sungrass Prairie
1 Temple of Mystery
1 Vivid Creek
1 Vivid Grove
1 Vivid Meadow
`

const DAXOS = `
1 Daxos the Returned
1 Karlov of the Ghost Council
1 Oreskos Explorer
1 Underworld Coinsmith
1 Bastion Protector
1 Burnished Hart
1 Dawnglare Invoker
1 Ghostblade Eidolon
1 Kor Sanctifiers
1 Mesa Enchantress
1 Monk Idealist
1 Nighthowler
1 Ajani's Chosen
1 Corpse Augur
1 Fate Unraveler
1 Banshee of the Dread Choir
1 Celestial Ancient
1 Celestial Archon
1 Doomwake Giant
1 Dreadbringer Lampads
1 Herald of the Host
1 Thief of Blood
1 Treasury Thrull
1 Sandstone Oracle
1 Silent Sentinel
1 Teysa, Envoy of Ghosts
1 Death Grasp
1 Ancient Craving
1 Dawn to Dusk
1 Gild
1 Righteous Confluence
1 Deadly Tempest
1 Open the Vaults
1 Sol Ring
1 Wayfarer's Bauble
1 Lightning Greaves
1 Orzhov Signet
1 Thought Vessel
1 Crystal Chimes
1 Orzhov Cluestone
1 Phyrexian Reclamation
1 Grave Peril
1 Seal of Cleansing
1 Aura of Silence
1 Banishing Light
1 Cage of Hands
1 Fallen Ideal
1 Grasp of Fate
1 Karmic Justice
1 Phyrexian Arena
1 Seal of Doom
1 Shielded by Faith
1 Underworld Connections
1 Vow of Duty
1 Vow of Malice
1 Daxos's Torment
1 Marshal's Anthem
1 Black Market
1 Dictate of Heliod
1 Sigil of the Empty Throne
1 Necromancer's Covenant
1 Barren Moor
1 Command Tower
1 Evolving Wilds
1 Ghost Quarter
1 New Benalia
1 Orzhov Basilica
1 Orzhov Guildgate
11 Plains
1 Rogue's Passage
1 Scoured Barrens
1 Secluded Steppe
13 Swamp
1 Tainted Field
1 Temple of the False God
1 Terramorphic Expanse
1 Vivid Marsh
1 Vivid Meadow
`

const ZINNIA = `
1 Zinnia, Valley's Voice
1 Agate Instigator
1 Jacked Rabbit
1 Loyal Warhound
1 Ornithopter of Paradise
1 Plumecreed Escort
1 Pollywog Prodigy
1 Selfless Spirit
1 Spirited Companion
1 Tetsuko Umezawa, Fugitive
1 Aether Channeler
1 Blade Splicer
1 Circuit Mender
1 Combat Celebrant
1 Devilish Valet
1 Hanged Executioner
1 Inspiring Overseer
1 Rapid Augmenter
1 Skyclave Apparition
1 Thopter Engineer
1 Curiosity Crafter
1 Jazal Goldmane
1 Luminous Broodmoth
1 Restoration Angel
1 Rose Room Treasurer
1 Solemn Simulacrum
1 Arthur, Marigold Knight
1 Boss's Chauffeur
1 Cloudblazer
1 Illusory Ambusher
1 Shield Broker
1 Siege-Gang Commander
1 Inferno Titan
1 Sun Titan
1 Angel of the Ruins
1 Junk Winder
1 Elspeth, Sun's Champion
1 Path to Exile
1 Rapid Hybridization
1 Echoing Assault
1 Pull from Tomorrow
1 Aetherize
1 Rowdy Research
1 Chart a Course
1 Martial Coup
1 Stolen by the Fae
1 Cut a Deal
1 Time Wipe
1 Storm of Souls
1 Calamity of Cinders
1 Dusk // Dawn
1 Sol Ring
1 Arcane Signet
1 Azorius Signet
1 Boros Signet
1 Fellwar Stone
1 Izzet Signet
1 Mind Stone
1 Helm of the Host
1 Fortune Teller's Talent
1 Bident of Thassa
1 Murmuration
1 Adarkar Wastes
1 Battlefield Forge
1 Cascade Bluffs
1 Castle Ardenvale
1 Clifftop Retreat
1 Command Tower
1 Evolving Wilds
1 Exotic Orchard
1 Ferrous Lake
1 Glacial Fortress
4 Mountain
1 Mystic Monastery
1 Path of Ancestry
9 Plains
1 Rugged Prairie
1 Seachrome Coast
1 Shivan Reef
1 Skycloud Expanse
1 Sulfur Falls
1 Sunscorched Divide
1 Temple of Enlightenment
1 Temple of Epiphany
1 Temple of Triumph
1 Terramorphic Expanse
1 Thriving Bluff
1 Thriving Heath
1 Thriving Isle
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
  {
    name: 'Deadly Disguise (MKM Precon)',
    commander: 'Kaust, Eyes of the Glade',
    archetype: 'Naya Disguise / Morph',
    playstyle: 'Spiele Kreaturen verdeckt als Disguise/Morph und nutze die Unsicherheit deiner Gegner aus. Beim Aufdecken kommen mächtige Trigger und Combat-Tricks ins Spiel — Bluff trifft auf Beatdown.',
    sealedPrice: 34.90,
    decklist: KAUST,
  },
  {
    name: 'Food and Fellowship (LTR Precon)',
    commander: 'Frodo, Adventurous Hobbit',
    commander2: 'Sam, Loyal Attendant',
    archetype: 'Abzan Food / Lifegain',
    playstyle: 'Generiere Food-Tokens, gewinne Leben und ziehe Karten dank Frodos Ring-tempting Triggern. Sam reduziert die Food-Kosten und Sanguine Bond schließt das Spiel mit Lifegain-Drains ab.',
    sealedPrice: 44.90,
    decklist: FRODO_SAM,
  },
  {
    name: 'Painbow (DMU Precon)',
    commander: 'Jared Carthalion',
    archetype: '5-Color Goodstuff / Painbow',
    playstyle: 'Spielst alle fünf Farben — die besten Charms, Wraths und Bomben aus dem ganzen Spektrum. Jared zieht je nach Schadensfarbe Karten oder pumpt sich selbst, du nutzt jede Painlands-Aktivierung doppelt.',
    sealedPrice: 29.90,
    decklist: JARED,
  },
  {
    name: 'Family Matters (BLB Precon)',
    commander: "Zinnia, Valley's Voice",
    archetype: 'Jeskai Token Doubling',
    playstyle: 'Erzeugt Token-Schwärme und verdoppelt Trigger-Effekte mit Zinnias Ability. Wide-Boards aus Birds, Soldiers und Spirits werden über Anthems und Combat-Tricks zur Lawine.',
    sealedPrice: 39.90,
    decklist: ZINNIA,
  },
  {
    name: 'Bedecked Brokers (SNC Precon)',
    commander: 'Perrie, the Pulverizer',
    archetype: 'Bant Counter Voltron',
    playstyle: 'Verteilt verschiedene Counter-Arten auf deinen Permanents und schlägt mit Perrie für massiven Trampelschaden zu — je mehr unterschiedliche Counter, desto härter der Hit. Proliferate-Engine als Multiplikator.',
    sealedPrice: 24.90,
    decklist: PERRIE,
  },
  {
    name: 'Call the Spirits (C15 Precon)',
    commander: 'Daxos the Returned',
    archetype: 'Orzhov Enchantress / Spirit Tokens',
    playstyle: 'Spielst Verzauberungen für Wert und erzeugst Spirit-Tokens mit Daxos Devotion-Trigger. Sigil of the Empty Throne und Necromancer\'s Covenant verwandeln dein Enchantment-Board in eine Wand aus fliegenden Geistern.',
    sealedPrice: 39.90,
    decklist: DAXOS,
  },
  {
    name: 'Prosper, Tome-Bound',
    commander: 'Prosper, Tome-Bound',
    archetype: 'Rakdos Impulse-Draw / Treasure',
    playstyle: 'Exiliert Karten oben vom Deck, spielt sie noch im selben Zug für Tempo aus und macht nebenbei einen Treasure pro Cast. Rakdos-Goodstuff trifft auf eine Card-Advantage-Engine, die wahnsinnig schwer auszuhungern ist.',
    sealedPrice: null,
    deckType: 'custom',
    decklist: PROSPER,
  },
  {
    name: 'Alania, Divergent Storm',
    commander: 'Alania, Divergent Storm',
    archetype: 'Izzet Spellslinger / Otter Storm',
    playstyle: 'Castet günstige Instants und Sorceries — Alania kopiert das erste Spell pro Zug und buffed dazu deine Otter-Token. Combo aus Spell-Triggern, Storm-Count und Anthem-Synergien für lethal aus dem Nichts.',
    sealedPrice: null,
    deckType: 'custom',
    decklist: ALANIA,
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

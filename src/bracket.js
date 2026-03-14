// Commander Bracket Estimation based on official WotC criteria (April 2025)
// https://magic.wizards.com/en/news/announcements/commander-brackets-beta-update-april-22-2025

const GAME_CHANGERS = new Set([
  'drannith magistrate', 'enlightened tutor', 'humility', "serra's sanctum",
  'smothering tithe', "teferi's protection", 'consecrated sphinx', 'cyclonic rift',
  'expropriate', 'force of will', 'fierce guardianship', 'gifts ungiven',
  'intuition', 'jin-gitaxias, core augur', 'mystical tutor', 'narset, parter of veils',
  'rhystic study', 'sway of the stars', "thassa's oracle", 'urza, lord high artificer',
  "bolas's citadel", 'braids, cabal minion', 'demonic tutor', 'imperial seal',
  'necropotence', 'opposition agent', 'orcish bowmasters', 'tergrid, god of fright',
  'vampiric tutor', 'ad nauseam', 'deflecting swat', 'gamble', "jeska's will",
  'underworld breach', 'crop rotation', 'food chain', "gaea's cradle",
  'natural order', 'seedborn muse', 'survival of the fittest', 'vorinclex, voice of hunger',
  'worldly tutor', 'aura shards', 'coalition victory', 'grand arbiter augustin iv',
  'kinnan, bonder prodigy', 'yuriko, the tiger\'s shadow', 'notion thief',
  'winota, joiner of forces', 'ancient tomb', 'chrome mox', 'field of the dead',
  'glacial chasm', 'grim monolith', "lion's eye diamond", 'mana vault',
  "mishra's workshop", 'mox diamond', 'panoptic mirror', 'the one ring',
  'the tabernacle at pendrell vale',
])

// Common tutors beyond the Game Changers list
const TUTORS = new Set([
  'demonic tutor', 'vampiric tutor', 'imperial seal', 'mystical tutor',
  'enlightened tutor', 'worldly tutor', 'gamble', 'crop rotation',
  'natural order', 'survival of the fittest', 'gifts ungiven', 'intuition',
  'diabolic tutor', 'diabolic intent', 'scheming symmetry', 'wishclaw talisman',
  'sidisi, undead vizier', 'razaketh, the foulblooded', 'rune-scarred demon',
  'dark petition', 'grim tutor', 'cruel tutor', 'beseech the mirror',
  'profane tutor', 'fabricate', 'tinker', 'trophy mage', 'tribute mage',
  'treasure mage', 'ranger of eos', 'recruiter of the guard',
  'imperial recruiter', 'eldritch evolution', 'birthing pod', 'neoform',
  'finale of devastation', 'chord of calling', 'green sun\'s zenith',
  'tooth and nail', 'defense of the heart',
])

// Extra turn spells
const EXTRA_TURNS = new Set([
  'expropriate', 'time warp', 'temporal manipulation', 'capture of jingzhou',
  'temporal mastery', 'time stretch', 'beacon of tomorrows', 'nexus of fate',
  'alrund\'s epiphany', 'extra turn', 'karn\'s temporal sundering',
  'sage of hours', 'medomai the ageless',
])

// Mass land destruction
const MLD = new Set([
  'armageddon', 'ravages of war', 'obliterate', 'jokulhaups',
  'decree of annihilation', 'ruination', 'from the ashes',
  'catastrophe', 'devastation', 'boom // bust', 'sunder',
  'keldon firebombers', 'global ruin', 'thoughts of ruin',
])

export function estimateBracket(cards, commanderName) {
  const names = cards.map(c => c.name.toLowerCase())

  const gameChangerCount = names.filter(n => GAME_CHANGERS.has(n)).length
  const gameChangerCards = cards.filter(c => GAME_CHANGERS.has(c.name.toLowerCase()))
  const tutorCount = names.filter(n => TUTORS.has(n)).length
  const hasExtraTurns = names.some(n => EXTRA_TURNS.has(n))
  const hasMLD = names.some(n => MLD.has(n))

  // Average CMC (lower = more optimized)
  const nonLands = cards.filter(c => c.type_category !== 'land')
  const totalCards = nonLands.reduce((s, c) => s + c.quantity, 0)
  const avgCmc = totalCards > 0
    ? nonLands.reduce((s, c) => s + (c.cmc || 0) * c.quantity, 0) / totalCards
    : 0

  // Total deck value as a rough proxy for optimization
  const totalValue = cards.reduce((s, c) => s + (parseFloat(c.price_eur) || 0) * c.quantity, 0)

  // Scoring
  let score = 0

  // Game Changers are the primary signal
  if (gameChangerCount === 0) score += 0
  else if (gameChangerCount <= 3) score += 2
  else if (gameChangerCount <= 6) score += 3
  else score += 4

  // Tutors accelerate consistency
  if (tutorCount >= 5) score += 2
  else if (tutorCount >= 3) score += 1

  // Extra turns / MLD push bracket up
  if (hasExtraTurns) score += 1
  if (hasMLD) score += 1

  // Low avg CMC = more optimized
  if (avgCmc < 2.5) score += 2
  else if (avgCmc < 3.0) score += 1

  // High value decks tend to be more optimized
  if (totalValue > 500) score += 1
  if (totalValue > 1500) score += 1

  // Map score to bracket
  let bracket
  if (score <= 1) bracket = 1
  else if (score <= 3) bracket = 2
  else if (score <= 5) bracket = 3
  else if (score <= 8) bracket = 4
  else bracket = 5

  const labels = {
    1: 'Exhibition',
    2: 'Core',
    3: 'Upgraded',
    4: 'Optimized',
    5: 'cEDH',
  }

  return {
    bracket,
    label: labels[bracket],
    gameChangerCount,
    gameChangerCards,
    tutorCount,
    hasExtraTurns,
    hasMLD,
    avgCmc,
    totalValue,
  }
}

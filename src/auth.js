const STORAGE_KEY = 'mtg_player'

export function getPlayer() {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function setPlayer(player) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(player))
}

export function logout() {
  localStorage.removeItem(STORAGE_KEY)
}

export function isLoggedIn() {
  return getPlayer() !== null
}

// The proof that somebody already gave a room its password, kept so leaving does not mean typing it
// again.
//
// What is stored is the room session the server issued -- signed, bound to one room and to one site
// session, and already carrying its own expiry. So this is a convenience, not a second way in: the
// server still decides whether the thing presented is good, and a seat copied to another machine is
// refused because the site session it names is not that machine's.
//
// Per platform by construction. The browser and the desktop app keep separate storage, so a seat
// earned in one is invisible to the other and the password is asked again -- which is the intent.
const KEY = 'telasshare-room-seats'

const load = (storage) => {
  try {
    const parsed = JSON.parse(storage?.getItem(KEY) || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    // Only strings survive the read. Anything else stored under this key came from somewhere it should
    // not have, and handing it to the server as a credential is not a thing to do politely.
    const kept = {}
    for (const [id, seat] of Object.entries(parsed)) if (typeof seat === 'string' && seat) kept[id] = seat
    return kept
  } catch { return {} }
}

export function createRoomSeats({ storage = typeof localStorage === 'undefined' ? null : localStorage } = {}) {
  let seats = load(storage)
  const save = () => {
    try { storage?.setItem(KEY, JSON.stringify(seats)) } catch { /* a private store is not worth failing over */ }
  }
  return {
    get: (roomId) => seats[roomId] || '',
    remember(roomId, seat) {
      if (!roomId || typeof seat !== 'string' || !seat) return false
      if (seats[roomId] === seat) return false
      seats = { ...seats, [roomId]: seat }
      save()
      return true
    },
    // One room's seat stops working -- the password changed, the room went, the seat aged out. Keeping
    // it would mean silently trying it again on every visit and falling back to the password anyway.
    forget(roomId) {
      if (!(roomId in seats)) return false
      const rest = {}
      for (const [id, seat] of Object.entries(seats)) if (id !== roomId) rest[id] = seat
      seats = rest
      save()
      return true
    },
    // Leaving the site is leaving the site: the seats belong to the session that earned them.
    clear() { seats = {}; save() },
    get rooms() { return Object.keys(seats) },
  }
}

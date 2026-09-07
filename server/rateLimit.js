// What one connection is allowed to send.
//
// Measured before this existed: a single client had 50,871 messages accepted in one second. Nothing in
// the app was doing that, but nothing stopped it either -- and every one of those messages is relayed to
// other people in the room, so the cost lands on them as much as on the server.
//
// Token buckets rather than a fixed count per window. Signalling is bursty by nature: joining a room with
// several people opens several connections at once and each gathers its ICE candidates in a rush, so a
// window that is strict enough to matter would cut exactly the traffic that has to get through. A bucket
// absorbs the burst and still holds the sustained rate down.

// Room for the worst honest burst: a dozen connections gathering candidates at the same moment. Ordinary
// traffic is a heartbeat every twenty seconds and the occasional message, so the sustained rate is orders
// of magnitude below this and a flood is orders of magnitude above.
export const MESSAGE_BUCKET = { capacity: 400, perSecond: 120 }
// Counting messages alone is not enough: an offer may be tens of kilobytes, and the relay multiplies it
// by everyone in the room. This is the ceiling on that.
export const BYTE_BUCKET = { capacity: 2_000_000, perSecond: 512_000 }
// Typing, not signalling, and deliberately not a bucket. A bucket drips: it hands back one message
// every couple of seconds, which is exactly the pace at which a conversation feels throttled even though
// the average is fine. A window is blunter and reads better -- ten messages, and five seconds later ten
// again, whole.
export const CHAT_WINDOW = { limit: 10, windowMs: 5_000 }

// A connection that keeps hitting the ceiling is not bursting, it is flooding. Strikes decay, so an
// honest burst that overshoots once is forgiven long before it reaches the limit.
export const STRIKE_LIMIT = 300
export const STRIKE_DECAY_PER_SECOND = 10
// One complaint per second at most. Answering every dropped message would be its own amplification.
export const ERROR_INTERVAL_MS = 1_000

const fill = (spec) => ({ ...spec, tokens: spec.capacity, at: null })

export function createRateLimiter({ now = () => Date.now() } = {}) {
  const buckets = { messages: fill(MESSAGE_BUCKET), bytes: fill(BYTE_BUCKET) }
  let chatWindowAt = null
  let chatCount = 0
  let strikes = 0
  let strikesAt = null
  let lastErrorAt = null

  const take = (bucket, amount) => {
    const at = now()
    if (bucket.at !== null) bucket.tokens = Math.min(bucket.capacity, bucket.tokens + ((at - bucket.at) / 1000) * bucket.perSecond)
    bucket.at = at
    if (bucket.tokens < amount) return false
    bucket.tokens -= amount
    return true
  }

  // Decay is applied on every read, not only when a new strike lands. Applying it only inside strike()
  // meant a connection that stopped misbehaving kept its strikes forever: they were frozen at whatever
  // the last burst left behind, and the next honest overshoot would pile on top of them until a
  // perfectly well-behaved connection was closed for something that happened minutes earlier.
  const settle = () => {
    const at = now()
    if (strikesAt !== null) strikes = Math.max(0, strikes - ((at - strikesAt) / 1000) * STRIKE_DECAY_PER_SECOND)
    strikesAt = at
    return strikes
  }
  const strike = () => { settle(); strikes += 1 }

  return {
    get strikes() { return Math.round(settle()) },

    // Every inbound frame, counted before it is parsed: a flood of malformed JSON costs the same to
    // receive as a flood of valid messages, so the limit cannot sit behind the parser.
    accept(bytes = 0) {
      if (!take(buckets.messages, 1)) { strike(); return { ok: false, reason: 'messages' } }
      if (!take(buckets.bytes, bytes)) { strike(); return { ok: false, reason: 'bytes' } }
      return { ok: true }
    },

    // Chat has its own budget on top of the shared one. Refused here is a person typing too fast, which
    // is worth a word back rather than a strike -- flooding through this costs a connection anyway.
    acceptChat() {
      const at = now()
      if (chatWindowAt === null || at - chatWindowAt >= CHAT_WINDOW.windowMs) { chatWindowAt = at; chatCount = 0 }
      if (chatCount >= CHAT_WINDOW.limit) return false
      chatCount += 1
      return true
    },

    // True when a complaint is worth sending, so that answering a flood does not become the flood.
    shouldWarn() {
      const at = now()
      if (lastErrorAt !== null && at - lastErrorAt < ERROR_INTERVAL_MS) return false
      lastErrorAt = at
      return true
    },

    // Sustained abuse rather than a burst. The client reconnects on its own, so a connection closed in
    // error costs a reconnection and nothing more -- broadcasts and voice both survive it.
    get flooding() { return settle() >= STRIKE_LIMIT },
  }
}

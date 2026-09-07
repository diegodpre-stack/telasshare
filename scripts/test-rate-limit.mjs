import assert from 'node:assert/strict'
import { createRateLimiter, BYTE_BUCKET, CHAT_WINDOW, MESSAGE_BUCKET, STRIKE_LIMIT } from '../server/rateLimit.js'

// The clock is driven by the test, so refill and decay are decisions that can be checked rather than
// things that only happen after a real wait.
function harness() {
  let clock = 1_000_000
  const limiter = createRateLimiter({ now: () => clock })
  return {
    limiter,
    advance: (ms) => { clock += ms },
    // Sends n messages instantly, as a flood does, and reports how many were accepted.
    flood: (count, bytes = 100) => {
      let accepted = 0
      for (let i = 0; i < count; i += 1) if (limiter.accept(bytes).ok) accepted += 1
      return accepted
    },
  }
}

// --- the burst that has to get through ------------------------------------
// Joining a room opens several connections at once and each gathers its ICE candidates in a rush. That
// burst is the traffic the app depends on, so the ceiling has to sit above it or the limit would break
// exactly what it exists to protect.
const burst = harness()
assert.equal(burst.flood(MESSAGE_BUCKET.capacity), MESSAGE_BUCKET.capacity, 'a full bucket is a full bucket')
assert.equal(burst.limiter.strikes, 0)

// And it refills, so a second burst a few seconds later is fine too.
burst.advance(4_000)
assert.equal(burst.flood(MESSAGE_BUCKET.capacity), MESSAGE_BUCKET.capacity)
assert.equal(burst.limiter.strikes, 0, 'nothing about that was abuse')

// --- the flood that must not ----------------------------------------------
// Measured against the real server before this existed: 50,871 messages accepted in one second.
const flood = harness()
const accepted = flood.flood(50_871)
assert.ok(accepted <= MESSAGE_BUCKET.capacity, `an instant flood gets a bucketful and no more (${accepted})`)
assert.ok(flood.limiter.flooding, 'and it is recognised as a flood rather than a burst')

// Sustained, the ceiling is the refill rate and nothing more.
const sustained = harness()
sustained.flood(MESSAGE_BUCKET.capacity)
let over10Seconds = 0
for (let second = 0; second < 10; second += 1) {
  sustained.advance(1_000)
  over10Seconds += sustained.flood(10_000)
}
assert.equal(over10Seconds, MESSAGE_BUCKET.perSecond * 10, 'ten seconds of flooding buys ten seconds of refill')

// --- bytes as well as messages --------------------------------------------
// Counting messages alone is not enough: an offer can be tens of kilobytes and the relay multiplies it
// by everyone in the room.
const heavy = harness()
const big = 100_000
const accepted_heavy = heavy.flood(100, big)
assert.ok(accepted_heavy * big <= BYTE_BUCKET.capacity, `the byte ceiling holds (${accepted_heavy} x ${big})`)
assert.ok(accepted_heavy < 100, 'so a small number of very large messages is refused too')

// --- strikes forgive a burst and remember a flood -------------------------
const forgiven = harness()
forgiven.flood(MESSAGE_BUCKET.capacity + 40)
assert.ok(forgiven.limiter.strikes > 0, 'overshooting is noticed')
assert.ok(!forgiven.limiter.flooding, 'but a single overshoot is not a flood')
forgiven.advance(10_000)
forgiven.limiter.accept(10)
assert.equal(forgiven.limiter.strikes, 0, 'and it is forgotten after a while')

// A connection that keeps hitting the ceiling is not bursting.
const relentless = harness()
for (let round = 0; round < 40; round += 1) { relentless.advance(100); relentless.flood(200) }
assert.ok(relentless.limiter.flooding, `sustained abuse reaches the limit (${relentless.limiter.strikes} >= ${STRIKE_LIMIT})`)

// --- chat has its own budget ----------------------------------------------
// A window rather than a bucket, and the difference is the whole point: a bucket drips one message back
// every couple of seconds, which is the pace at which a conversation feels throttled even where the
// average is generous. This hands the whole allowance back at once.
const chat = harness()
let sentNow = 0
while (chat.limiter.acceptChat()) sentNow += 1
assert.equal(sentNow, CHAT_WINDOW.limit, 'ten in hand')
assert.equal(chat.limiter.acceptChat(), false)

// Part-way through the window, nothing has come back yet.
chat.advance(CHAT_WINDOW.windowMs - 100)
assert.equal(chat.limiter.acceptChat(), false, 'the window has not turned over')

// And when it turns, the whole allowance is there again -- not one message, all ten.
chat.advance(200)
let afterWindow = 0
while (chat.limiter.acceptChat()) afterWindow += 1
assert.equal(afterWindow, CHAT_WINDOW.limit, 'the allowance renews whole')
// Being told to slow down is not abuse: somebody typing fast must not lose their connection over it.
assert.ok(!chat.limiter.flooding)
// Nor does it touch the budget the rest of the app is using.
assert.equal(chat.flood(MESSAGE_BUCKET.capacity), MESSAGE_BUCKET.capacity)

// --- complaining must not become the flood --------------------------------
const warn = harness()
assert.equal(warn.limiter.shouldWarn(), true)
assert.equal(warn.limiter.shouldWarn(), false, 'a second complaint in the same instant is not sent')
warn.advance(1_000)
assert.equal(warn.limiter.shouldWarn(), true)

console.log('PASS: an honest burst passes whole, 50,871 messages a second gets a bucketful and is recognised as a flood, large messages are capped by bytes as well as by count, strikes forgive a burst and remember a flood, chat has a separate budget that costs no connection, and complaints are rate limited themselves.')

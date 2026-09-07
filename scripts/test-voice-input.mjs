import assert from 'node:assert/strict'
import {
  clampThreshold, createVoiceInput, decibelFraction, toDecibels,
  DEFAULT_THRESHOLD_DB, MAX_THRESHOLD_DB, MIN_THRESHOLD_DB, SILENCE_DB,
} from '../src/voiceInput.js'

// A stand-in for Web Audio. Every node is named, so the wiring itself is something the test can read
// back rather than something taken on trust, and the analyser reports whatever amplitude is asked for.
function fakeContext() {
  const state = { amplitude: 0, gains: [], edges: new Set() }
  let gains = 0
  const node = (name) => ({
    name,
    connect(target) { state.edges.add(`${name}->${target?.name || 'destination'}`) },
    disconnect(target) {
      for (const edge of [...state.edges]) {
        if (edge.startsWith(`${name}->`) && (!target || edge.endsWith(`->${target.name}`))) state.edges.delete(edge)
      }
    },
  })
  return {
    state,
    currentTime: 0,
    wiring: () => [...state.edges].sort(),
    createMediaStreamSource: () => node('source'),
    createAnalyser: () => ({
      ...node('analyser'),
      fftSize: 1024,
      smoothingTimeConstant: 0,
      // A square wave at the requested amplitude, so the RMS the module computes comes out as exactly
      // the amplitude asked for. Float, because 8-bit bytes cannot express a quiet room at all.
      getFloatTimeDomainData(target) { target.fill(state.amplitude) },
    }),
    createGain: () => {
      gains += 1
      // The gate is built first, the entry junction second.
      const built = node(gains === 1 ? 'gate' : 'entry')
      built.gain = { value: 0, setTargetAtTime: (target) => { built.gain.value = target; state.gains.push(target) } }
      return built
    },
    createMediaStreamDestination: () => ({ stream: { id: 'processed', getAudioTracks: () => [{ stop() {} }] } }),
  }
}

// A model that takes as long to arrive as the test wants it to.
function fakeSuppressor() {
  let resolve
  const ready = new Promise((r) => { resolve = r })
  const node = { name: 'rnnoise', destroyed: false, connect() {}, disconnect() {}, destroy() { node.destroyed = true } }
  return { node, create: () => ready, arrive: (value = node) => { resolve(value); return ready } }
}

const fakeStorage = (initial = {}) => {
  const store = { ...initial }
  return { store, getItem: (key) => store[key] ?? null, setItem: (key, value) => { store[key] = value } }
}

const decibelsToAmplitude = (db) => 10 ** (db / 20)

// Builds an input whose clock the test drives, so hold and release are checked as decisions rather than
// as things that happen after a real wait.
function harness({ storage = fakeStorage(), amplitude = 0, createSuppressor = null } = {}) {
  const context = fakeContext()
  context.state.amplitude = amplitude
  let clock = 10_000
  const input = createVoiceInput({ audioContext: context, stream: { id: 'raw' }, storage, createSuppressor, now: () => clock })
  return {
    input,
    context,
    advance: (ms) => { clock += ms },
    speak: (db) => { context.state.amplitude = decibelsToAmplitude(db) },
    // One tick per 25 ms of audio, which is what the interval does in the browser.
    run: (ticks, ms = 25) => { for (let i = 0; i < ticks; i += 1) { clock += ms; input.tick() } },
    // Speech is not a level, it is a level that moves. A steady tone is a fan however loud it is, so
    // anything standing in for a voice has to have syllables in it.
    talk: (ticks, loudDb, quietDb = loudDb - 20, syllable = 6) => {
      for (let i = 0; i < ticks; i += 1) {
        context.state.amplitude = decibelsToAmplitude(Math.floor(i / syllable) % 2 ? quietDb : loudDb)
        clock += 25
        input.tick()
      }
    },
  }
}

// --- the scale ------------------------------------------------------------
// A slider over amplitude would be unusable: speech and a keystroke are three orders of magnitude apart.
assert.equal(toDecibels(1), 0)
assert.equal(Math.round(toDecibels(0.5)), -6)
assert.equal(toDecibels(0), SILENCE_DB, 'silence is a number, not negative infinity')
assert.equal(decibelFraction(MIN_THRESHOLD_DB), 0)
assert.equal(decibelFraction(MAX_THRESHOLD_DB), 1)
assert.equal(decibelFraction(SILENCE_DB), 0, 'below the scale pins to the bottom rather than going negative')
assert.equal(clampThreshold(-200), MIN_THRESHOLD_DB)
assert.equal(clampThreshold(0), MAX_THRESHOLD_DB)
assert.equal(clampThreshold('-45'), -45, 'a range input hands back a string')
for (const bad of [undefined, null, NaN, 'alto', {}]) assert.equal(clampThreshold(bad), DEFAULT_THRESHOLD_DB)

// --- the chain ------------------------------------------------------------
// The raw microphone must never reach a connection: the gate sits between it and what peers get.
const built = harness()
assert.deepEqual(built.context.wiring(), ['entry->analyser', 'entry->gate', 'gate->destination', 'source->entry'])
assert.equal(built.input.stream.id, 'processed', 'the stream handed out is the processed one')

// --- the noise suppressor -------------------------------------------------
// Loading a model takes as long as it takes, and voice has to work from the moment someone joins. So the
// chain is complete without it, and the model is spliced in whenever it arrives.
const model = fakeSuppressor()
const withModel = harness({ createSuppressor: model.create })
assert.equal(withModel.input.suppressionReady, false, 'not reported as running before it is')
assert.deepEqual(withModel.context.wiring(), ['entry->analyser', 'entry->gate', 'gate->destination', 'source->entry'])
withModel.speak(-20); withModel.run(2)
assert.equal(withModel.input.open, true, 'and the microphone works in the meantime')

await model.arrive()
assert.equal(withModel.input.suppressionReady, true)
assert.deepEqual(withModel.context.wiring(), ['entry->analyser', 'entry->gate', 'gate->destination', 'source->rnnoise'],
  'the model sits ahead of everything, so the meter and the gate judge what it produced')

// Turning it off puts the microphone straight back rather than leaving a dead node in the path.
withModel.input.setSuppression(false)
assert.deepEqual(withModel.context.wiring(), ['entry->analyser', 'entry->gate', 'gate->destination', 'source->entry'])
withModel.input.setSuppression(true)
assert.deepEqual(withModel.context.wiring(), ['entry->analyser', 'entry->gate', 'gate->destination', 'source->rnnoise'])

// A model that fails to load must cost nothing more than itself.
const failed = fakeSuppressor()
const withoutModel = harness({ createSuppressor: failed.create })
await failed.arrive(null)
assert.equal(withoutModel.input.suppressionReady, false)
assert.deepEqual(withoutModel.context.wiring(), ['entry->analyser', 'entry->gate', 'gate->destination', 'source->entry'])
withoutModel.speak(-20); withoutModel.run(2)
assert.equal(withoutModel.input.open, true, 'the microphone is unaffected by a model that never arrived')

// One that lands after the session is over is released rather than left running.
const late = fakeSuppressor()
const closed = harness({ createSuppressor: late.create })
closed.input.close()
await late.arrive()
assert.equal(late.node.destroyed, true, 'a model that arrives too late is destroyed, not leaked')

// The choice is remembered, and defaults to on.
const suppressionStorage = fakeStorage()
assert.equal(harness({ storage: suppressionStorage }).input.suppression, true)
harness({ storage: suppressionStorage }).input.setSuppression(false)
assert.equal(harness({ storage: suppressionStorage }).input.suppression, false, 'turning it off survives the session')

// --- the gate -------------------------------------------------------------
const gate = harness({ storage: fakeStorage() })
gate.input.setAuto(false)
gate.input.setThreshold(-50)

// Typing at -60 dB is below the threshold, so nothing is let through at all.
gate.speak(-60)
gate.run(10)
assert.equal(gate.input.open, false, 'a keystroke under the threshold never opens the gate')
assert.equal(gate.context.state.gains.at(-1), 0)

// Speech at -30 dB opens it on the very first tick: waiting would clip the first syllable.
gate.speak(-30)
gate.run(1)
assert.equal(gate.input.open, true)
assert.equal(gate.context.state.gains.at(-1), 1)

// Falling quiet does not close it immediately. A dip inside a word must not cut the word in half.
gate.speak(-70)
gate.run(4)
assert.equal(gate.input.open, true, 'the hold keeps the tail of a word')
// But staying quiet does close it, and then typing is silent again.
gate.run(12)
assert.equal(gate.input.open, false)
assert.equal(gate.context.state.gains.at(-1), 0)

// --- the automatic threshold ---------------------------------------------
// The setting almost nobody can name for their own room. It follows the quiet part of the recent past,
// so a noisy room raises the bar rather than leaving the gate permanently open.
const quiet = harness()
quiet.speak(-72)
quiet.run(400)
const quietThreshold = quiet.input.thresholdDb
assert.ok(quietThreshold > -72 && quietThreshold < -50, `a quiet room sits just above its own floor (${quietThreshold})`)
assert.equal(quiet.input.open, false, 'and the room itself does not hold the gate open')

const noisy = harness()
noisy.speak(-45)
noisy.run(400)
assert.ok(noisy.input.thresholdDb > quietThreshold, 'a noisier room ends up with a higher bar')
// The point of all of it: in either room, speech well above the floor still gets through.
for (const room of [quiet, noisy]) {
  room.speak(-20)
  room.run(1)
  assert.equal(room.open ?? room.input.open, true, 'speech opens the gate in both rooms')
}

// A single silent frame must not drop the floor and fling the gate open on everything after it.
const dip = harness()
dip.speak(-45)
dip.run(400)
const settled = dip.input.thresholdDb
dip.speak(-100)
dip.run(2)
dip.speak(-45)
assert.ok(Math.abs(dip.input.thresholdDb - settled) <= 3, 'one silent frame barely moves the floor')

// Sustained speech must never gate out the person speaking. Measured in the browser before the headroom
// cap existed: a continuous voice dragged the automatic threshold up past itself and would have cut off
// whoever was still talking. The invariant is not that the bar holds still -- it is free to move -- but
// that it can never climb above the voice it is listening to.
const sustained = harness()
sustained.speak(-65)
sustained.run(400)
const restingThreshold = sustained.input.thresholdDb
// Checked all the way through rather than only at the end, because the failure was gradual.
for (let step = 1; step <= 40; step += 1) {
  sustained.talk(10, -18)
  assert.equal(sustained.input.open, true, `still heard after ${step * 250} ms of unbroken speech`)
  assert.ok(sustained.input.thresholdDb < -18, `the bar stayed under the voice at ${step * 250} ms`)
}
// Once they stop, the room is measured again as usual and the bar goes back to being about the room.
sustained.speak(-65)
sustained.run(400)
assert.ok(Math.abs(sustained.input.thresholdDb - restingThreshold) <= 2, 'and the floor is picked back up afterwards')
assert.equal(sustained.input.open, false)

// The deadlock: the window is only filled while the gate is shut, so anything holding it open freezes
// the window, the room is never measured again and the gate never closes. Measured in the browser as a
// microphone stuck open. Whatever opens it, it has to be able to shut again.
const unstick = harness()
unstick.talk(400, -30)
assert.equal(unstick.input.open, true)
unstick.speak(-70)
unstick.run(600)
assert.equal(unstick.input.open, false, 'the gate still shuts once the speaking stops')

// The same deadlock reached the other way: a sound that arrives loud, holds the gate open, and never
// varies. The window has to start moving again on its own rather than waiting for a silence that is
// not coming.
const stuckOpen = harness()
stuckOpen.talk(100, -25)
assert.equal(stuckOpen.input.open, true, 'speech opens it')
stuckOpen.speak(-25)
stuckOpen.run(1200)
assert.equal(stuckOpen.input.open, false, 'and a steady drone at the same level is eventually shut out')

// A fan is not a voice however loud it gets. Level alone cannot tell them apart -- a first attempt drew
// the line at a level and steady noise just above it held the gate open indefinitely, measured in the
// browser. What separates them is that speech moves and a fan does not.
for (const fan of [-60, -46, -38, -30]) {
  const room = harness()
  room.speak(fan)
  room.run(400)
  assert.equal(room.input.open, false, `steady noise at ${fan} dB is still noise`)
  assert.ok(room.input.thresholdDb > fan, `and the bar sits above it (${room.input.thresholdDb})`)
}

// Joining while sound is already arriving must not lock the gate shut. The window gets seeded from
// whatever is present, and if that is a voice rather than a room, a bar set from the floor lands above
// it. Measured in the browser before this was fixed: a bar of -21 dB against a steady -32 dB signal,
// which is a microphone that stays off until the room happens to go quiet for three seconds.
const joinedTalking = harness()
joinedTalking.talk(200, -32)
assert.ok(joinedTalking.input.thresholdDb < -32, `the bar stays under what is being heard (${joinedTalking.input.thresholdDb})`)
assert.equal(joinedTalking.input.open, true, 'so whoever was already speaking is heard')
// And once they stop, the room is measured properly and the bar goes back to being about the room.
joinedTalking.speak(-68)
joinedTalking.run(200)
assert.ok(joinedTalking.input.thresholdDb > -68 && joinedTalking.input.thresholdDb < -45, 'the room takes over again')
assert.equal(joinedTalking.input.open, false)

// --- what is remembered ---------------------------------------------------
// Moving the slider is a statement that the automatic choice was wrong, so it takes over rather than
// being quietly overruled on the next tick.
const storage = fakeStorage()
const chosen = harness({ storage })
assert.equal(chosen.input.auto, true, 'automatic is the default')
chosen.input.setThreshold(-38)
assert.equal(chosen.input.auto, false)
assert.equal(chosen.input.thresholdDb, -38)
chosen.speak(-70)
chosen.run(400)
assert.equal(chosen.input.thresholdDb, -38, 'and the floor does not move a threshold that was set by hand')

const reopened = harness({ storage })
assert.equal(reopened.input.manualThresholdDb, -38, 'the choice survives the session')
assert.equal(reopened.input.auto, false)
reopened.input.setAuto(true)
assert.equal(harness({ storage }).input.auto, true, 'and so does going back to automatic')

// Junk in storage must leave the microphone working on the defaults rather than break the call.
for (const broken of ['nao e json', '[]', 'null', '{"thresholdDb":"alto"}']) {
  const recovered = harness({ storage: fakeStorage({ 'entretelas-microfone': broken }) })
  assert.equal(recovered.input.manualThresholdDb, DEFAULT_THRESHOLD_DB, `${broken} must not silence the microphone`)
}
// A browser that refuses storage must not take the call down with it.
assert.doesNotThrow(() => harness({ storage: null }).input.setThreshold(-44))

// --- the meter ------------------------------------------------------------
// The analyser reads before the gate, so the level bar keeps showing the microphone even while nothing
// is being let through -- which is the only way to see where to put the threshold.
const meter = harness()
meter.input.setAuto(false)
meter.input.setThreshold(-30)
meter.speak(-55)
meter.run(4)
assert.equal(meter.input.open, false)
assert.ok(meter.input.level > 0, 'a gated microphone still reports its level')
assert.ok(meter.input.level < meter.input.thresholdLevel, 'and reads below the marker, which is why it is closed')

console.log('PASS: decibel scale and clamping, a model spliced in when it arrives and removed when refused, the raw microphone never reaching a connection, the gate opening instantly and closing on a hold, an automatic threshold that follows the room without chasing one silent frame, a manual choice that persists and wins, and a meter that reads before the gate.')

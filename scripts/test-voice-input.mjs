import assert from 'node:assert/strict'
import {
  clampThreshold, createVoiceInput, decibelFraction, toDecibels,
  DEFAULT_THRESHOLD_DB, MAX_THRESHOLD_DB, MIN_THRESHOLD_DB, SILENCE_DB,
} from '../src/voiceInput.js'

// A stand-in for Web Audio whose analyser reports whatever amplitude the test asks for.
function fakeContext() {
  const state = { amplitude: 0, gains: [], connections: [] }
  const node = (kind) => ({
    kind,
    connect(target) { state.connections.push([kind, target?.kind || 'destination']) },
    disconnect() {},
  })
  return {
    state,
    currentTime: 0,
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
      const gain = { value: 0, setTargetAtTime: (target) => { gain.value = target; state.gains.push(target) } }
      return { ...node('gain'), gain }
    },
    createMediaStreamDestination: () => ({ stream: { id: 'processed', getAudioTracks: () => [{ stop() {} }] } }),
  }
}

const fakeStorage = (initial = {}) => {
  const store = { ...initial }
  return { store, getItem: (key) => store[key] ?? null, setItem: (key, value) => { store[key] = value } }
}

const decibelsToAmplitude = (db) => 10 ** (db / 20)

// Builds an input whose clock the test drives, so hold and release are checked as decisions rather than
// as things that happen after a real wait.
function harness({ storage = fakeStorage(), amplitude = 0 } = {}) {
  const context = fakeContext()
  context.state.amplitude = amplitude
  let clock = 10_000
  const input = createVoiceInput({ audioContext: context, stream: { id: 'raw' }, storage, now: () => clock })
  return {
    input,
    context,
    advance: (ms) => { clock += ms },
    speak: (db) => { context.state.amplitude = decibelsToAmplitude(db) },
    // One tick per 25 ms of audio, which is what the interval does in the browser.
    run: (ticks, ms = 25) => { for (let i = 0; i < ticks; i += 1) { clock += ms; input.tick() } },
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
assert.deepEqual(built.context.state.connections, [['source', 'analyser'], ['source', 'gain'], ['gain', 'destination']])
assert.equal(built.input.stream.id, 'processed', 'the stream handed out is the processed one')

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
quiet.run(130)
const quietThreshold = quiet.input.thresholdDb
assert.ok(quietThreshold > -72 && quietThreshold < -50, `a quiet room sits just above its own floor (${quietThreshold})`)
assert.equal(quiet.input.open, false, 'and the room itself does not hold the gate open')

const noisy = harness()
noisy.speak(-45)
noisy.run(130)
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
dip.run(100)
const settled = dip.input.thresholdDb
dip.speak(-100)
dip.run(2)
dip.speak(-45)
assert.ok(Math.abs(dip.input.thresholdDb - settled) <= 3, 'one silent frame barely moves the floor')

// Sustained speech must not raise the bar to the speaker's own level. Measured in the browser before
// this was fixed: a continuous voice drove the automatic threshold to the top of the scale, which would
// have closed the gate on whoever was still talking.
const sustained = harness()
sustained.speak(-65)
sustained.run(130)
const restingThreshold = sustained.input.thresholdDb
sustained.speak(-18)
sustained.run(400)
assert.equal(sustained.input.open, true, 'someone talking for ten seconds is still being heard at the end of it')
assert.equal(sustained.input.thresholdDb, restingThreshold, 'and their own voice never became the noise floor')
// Once they stop, the room is measured again as usual.
sustained.speak(-65)
sustained.run(130)
assert.ok(Math.abs(sustained.input.thresholdDb - restingThreshold) <= 2, 'and the floor is picked back up afterwards')

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
chosen.run(130)
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

console.log('PASS: decibel scale and clamping, the raw microphone never reaching a connection, the gate opening instantly and closing on a hold, an automatic threshold that follows the room without chasing one silent frame, a manual choice that persists and wins, and a meter that reads before the gate.')

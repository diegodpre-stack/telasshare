// What actually leaves the microphone.
//
// The browser's own noise suppression is already on, and it is the wrong tool for the complaint: it is
// built for steady noise -- a fan, an air conditioner -- and barely touches short transients. A keyboard
// and a knock on the desk are transients, which is why they come through untouched.
//
// What stops those is a gate: below a level, nothing is sent at all. It costs nothing, it needs no model
// and no extra download, and it covers the case that actually happens -- typing while not talking. It
// does not separate a keystroke from a voice that is speaking at the same moment; nothing this cheap can.
//
// The raw microphone is never handed to the connection. It goes through this chain first, and the
// processed stream is what peers receive.
export const MIN_THRESHOLD_DB = -80
export const MAX_THRESHOLD_DB = -20
export const DEFAULT_THRESHOLD_DB = -50
// Below this the reading is silence rather than a number worth acting on.
export const SILENCE_DB = -100

const STORAGE_KEY = 'entretelas-microfone'
// Opening has to be instant or the first syllable is clipped; closing has to be slow or the gate itself
// becomes a click. The hold is what keeps the tail of a word from being cut when the level dips inside it.
const ATTACK_SECONDS = 0.004
const RELEASE_SECONDS = 0.08
const HOLD_MS = 260
export const TICK_MS = 25
// Ten seconds of readings. The window has to be long enough that ordinary pauses between sentences
// dominate its quiet end, because that quiet end is what the room is judged by. The two percentiles are
// taken from the same window: a mean would be dragged up by speech and a minimum down by one silent
// frame, while a percentile at either end is steady against both.
const FLOOR_WINDOW = 400
const FLOOR_PERCENTILE = 0.2
const PEAK_PERCENTILE = 0.9
// Sorting the window on every tick would be forty times a second for nothing; a fifth of a second is
// far faster than a threshold needs to move.
const MEASURE_EVERY = 8
// How long the gate may stay open before the room is measured again regardless. Normally the window is
// only filled while the gate is shut, so that a voice can never become the noise floor. That alone
// deadlocks: anything that holds the gate open freezes the window, the room is never measured again and
// the gate never closes -- measured in the browser as a microphone stuck open. Past this, sampling
// resumes even while open, and the headroom cap is what keeps a real voice audible while it does.
const STUCK_OPEN_MS = 6_000
// How far above the floor a sound has to be to count as someone speaking rather than the room.
const AUTO_MARGIN_DB = 11
// And how far below the loudest thing recently heard the bar is never allowed to sit. Without this,
// joining while sound is already arriving seeds the floor from that sound and puts the bar above it --
// measured in the browser at a bar of -21 dB against a steady -32 dB signal, which is a microphone that
// is simply off until the room happens to go quiet.
const AUTO_HEADROOM_DB = 10
// The cap must not apply to a room, or it would hold the gate open on the room itself. What separates
// the two is not how loud the sound is -- a first attempt used a level for this and a fan just above the
// line held the gate open indefinitely -- but whether it moves. Speech is syllables: its quiet end and
// its loud end are far apart over any few seconds. A fan, a hiss, a hum sit still. So the window's own
// spread is the test, and it needs no assumption about how loud anybody is or how hot their microphone is.
const SPEECH_SPREAD_DB = 8

export const clampThreshold = (value) => {
  const number = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(number)) return DEFAULT_THRESHOLD_DB
  return Math.min(MAX_THRESHOLD_DB, Math.max(MIN_THRESHOLD_DB, Math.round(number)))
}

// Amplitude is useless to reason about directly: speech and a keystroke are a factor of a thousand apart
// on a scale where a slider has to be usable. Decibels are what make a threshold something a person can set.
export const toDecibels = (amplitude) => (amplitude > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(amplitude)) : SILENCE_DB)
// Where a reading sits on the slider's own scale, so the meter and the threshold marker share one axis.
export const decibelFraction = (db) => Math.min(1, Math.max(0, (db - MIN_THRESHOLD_DB) / (MAX_THRESHOLD_DB - MIN_THRESHOLD_DB)))

function readStored(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) || '{}')
    if (!parsed || typeof parsed !== 'object') return {}
    return { thresholdDb: clampThreshold(parsed.thresholdDb), auto: parsed.auto !== false, suppression: parsed.suppression !== false }
  } catch { return {} }
}

export function createVoiceInput({
  audioContext,
  stream,
  storage = typeof localStorage === 'undefined' ? null : localStorage,
  onChange,
  now = () => Date.now(),
  // Returns a node to splice in ahead of everything else, or null. Injected rather than imported so this
  // file stays free of anything a bundler has to resolve, which is what lets the gate be tested at all.
  createSuppressor = null,
} = {}) {
  const context = audioContext || new (globalThis.AudioContext || globalThis.webkitAudioContext)({ sampleRate: 48000 })
  const stored = readStored(storage)
  let manualThreshold = clampThreshold(stored.thresholdDb ?? DEFAULT_THRESHOLD_DB)
  // Automatic by default, and it is the honest default: almost nobody knows what number their room is,
  // and the one setting that is always wrong is a fixed threshold on a machine it was not chosen for.
  let auto = stored.auto !== false
  let suppression = stored.suppression !== false
  let suppressor = null
  let disposed = false
  let openUntil = 0
  let inputDb = SILENCE_DB
  let floorDb = SILENCE_DB
  let peakDb = SILENCE_DB
  let ticks = 0
  let openedAt = null
  const history = []
  let timer = null

  const source = context.createMediaStreamSource(stream)
  const analyser = context.createAnalyser()
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0.2
  // Float, not bytes. getByteTimeDomainData quantises to 8 bits, which is about 48 dB of range in total:
  // a genuinely quiet room reads as exact silence, the noise floor comes out as nothing, and an automatic
  // threshold computed from it would sit at the bottom of the scale and let everything through.
  const samples = new Float32Array(analyser.fftSize)
  const byteSamples = new Uint8Array(analyser.fftSize)
  const gate = context.createGain()
  gate.gain.value = 0
  const destination = context.createMediaStreamDestination()
  // A junction the model can be spliced in front of. Voice has to work from the moment someone joins,
  // and loading a model takes as long as it takes -- so the chain is complete without it and the model
  // joins whenever it is ready.
  const entry = context.createGain()
  // The analyser is a tap, not a link in the chain: it reads the microphone before the gate, so the
  // meter keeps showing what is arriving even while nothing is being let through. It reads after the
  // model, though, which is the point -- the level the meter shows is the level being judged and sent.
  entry.connect(analyser)
  entry.connect(gate)
  gate.connect(destination)

  const route = () => {
    try { source.disconnect() } catch { /* nothing connected yet */ }
    try { suppressor?.disconnect() } catch { /* nothing connected yet */ }
    if (suppressor && suppression) { source.connect(suppressor); suppressor.connect(entry) }
    else source.connect(entry)
  }
  route()

  const save = () => {
    try { storage?.setItem(STORAGE_KEY, JSON.stringify({ thresholdDb: manualThreshold, auto, suppression })) } catch { /* a private store is not worth failing over */ }
  }
  const announce = () => onChange?.()

  if (createSuppressor) {
    Promise.resolve(createSuppressor(context)).then((node) => {
      if (disposed) { node?.destroy?.(); return }
      suppressor = node || null
      route()
      announce()
    }).catch(() => { /* the gate alone is still an improvement on nothing */ })
  }

  // Two readings from the same window. A mean would be dragged up by speech and a minimum dragged down
  // by a single silent frame, so both ends are taken as percentiles, which are steady against both.
  const percentile = (fraction) => {
    if (!history.length) return SILENCE_DB
    const sorted = [...history].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]
  }
  const measureRoom = () => { floorDb = percentile(FLOOR_PERCENTILE); peakDb = percentile(PEAK_PERCENTILE) }
  const automaticThreshold = () => {
    const wanted = floorDb + AUTO_MARGIN_DB
    // With a voice in the window the bar can never be set above it. With only a room in there, the cap
    // stands aside and the floor decides, which is what keeps the gate shut on a fan however loud it is.
    const speaking = peakDb - floorDb >= SPEECH_SPREAD_DB
    return clampThreshold(speaking ? Math.min(wanted, peakDb - AUTO_HEADROOM_DB) : wanted)
  }
  const effectiveThreshold = () => (auto ? automaticThreshold() : manualThreshold)

  const applyGain = (open) => {
    const target = open ? 1 : 0
    if (typeof gate.gain.setTargetAtTime === 'function') {
      gate.gain.setTargetAtTime(target, context.currentTime || 0, open ? ATTACK_SECONDS : RELEASE_SECONDS)
    } else gate.gain.value = target
  }

  // Driven by an interval in the browser and called directly by the tests, so the decision is something
  // that can be checked rather than something that only happens in real time.
  const tick = () => {
    try {
      let sum = 0
      if (typeof analyser.getFloatTimeDomainData === 'function') {
        analyser.getFloatTimeDomainData(samples)
        for (const sample of samples) sum += sample * sample
        inputDb = toDecibels(Math.sqrt(sum / samples.length))
      } else {
        analyser.getByteTimeDomainData(byteSamples)
        for (const sample of byteSamples) { const centred = (sample - 128) / 128; sum += centred * centred }
        inputDb = toDecibels(Math.sqrt(sum / byteSamples.length))
      }
    } catch { inputDb = SILENCE_DB }
    const at = now()
    const wasOpen = at < openUntil
    if (!wasOpen) openedAt = null
    else if (openedAt === null) openedAt = at
    // The room is measured while the gate is shut, so that a voice can never become the noise floor.
    // The two exceptions are the first window, when there is no floor to judge by and it has to learn
    // from whatever is arriving, and a gate that has been held open too long, which is the deadlock.
    if (!wasOpen || at - openedAt >= STUCK_OPEN_MS || history.length < FLOOR_WINDOW) {
      history.push(inputDb)
      if (history.length > FLOOR_WINDOW) history.shift()
      ticks += 1
      if (ticks % MEASURE_EVERY === 0 || history.length <= 1) measureRoom()
    }
    if (inputDb >= effectiveThreshold()) openUntil = at + HOLD_MS
    applyGain(at < openUntil)
    return inputDb
  }

  return {
    // The stream peers receive. Never the raw microphone.
    stream: destination.stream,
    get inputDb() { return inputDb },
    get level() { return decibelFraction(inputDb) },
    get open() { return now() < openUntil },
    get thresholdDb() { return effectiveThreshold() },
    get thresholdLevel() { return decibelFraction(effectiveThreshold()) },
    get manualThresholdDb() { return manualThreshold },
    get auto() { return auto },
    get floorDb() { return floorDb },
    get suppression() { return suppression },
    // Whether the model is in the chain rather than merely wanted, so the interface can say "loading"
    // instead of claiming something that is not running yet.
    get suppressionReady() { return suppressor !== null },

    setSuppression(value) {
      suppression = value === true
      route()
      save(); announce()
      return suppression
    },

    setThreshold(value) {
      manualThreshold = clampThreshold(value)
      // Moving the slider is a statement that the automatic choice was wrong, so it switches over rather
      // than being silently overruled on the next tick.
      auto = false
      save(); announce()
      return manualThreshold
    },
    setAuto(value) {
      auto = value === true
      save(); announce()
      return auto
    },

    tick,
    start() {
      if (timer) return
      timer = setInterval(tick, TICK_MS)
      timer.unref?.()
    },
    close() {
      disposed = true
      clearInterval(timer); timer = null
      try { suppressor?.disconnect(); suppressor?.destroy?.() } catch { /* already torn down */ }
      suppressor = null
      try { source.disconnect(); entry.disconnect(); analyser.disconnect(); gate.disconnect() } catch { /* already torn down */ }
      for (const track of destination.stream.getAudioTracks?.() || []) track.stop?.()
    },
  }
}

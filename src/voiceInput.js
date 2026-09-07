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
// Roughly three seconds of readings. The quiet fifth of that window is taken as the noise floor: long
// enough not to be moved by one pause in speech, short enough to follow a fan being switched on.
const FLOOR_WINDOW = 120
const FLOOR_PERCENTILE = 0.2
// How far above the floor a sound has to be to count as someone speaking rather than the room.
const AUTO_MARGIN_DB = 11

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
    return { thresholdDb: clampThreshold(parsed.thresholdDb), auto: parsed.auto !== false }
  } catch { return {} }
}

export function createVoiceInput({
  audioContext,
  stream,
  storage = typeof localStorage === 'undefined' ? null : localStorage,
  onChange,
  now = () => Date.now(),
} = {}) {
  const context = audioContext || new (globalThis.AudioContext || globalThis.webkitAudioContext)({ sampleRate: 48000 })
  const stored = readStored(storage)
  let manualThreshold = clampThreshold(stored.thresholdDb ?? DEFAULT_THRESHOLD_DB)
  // Automatic by default, and it is the honest default: almost nobody knows what number their room is,
  // and the one setting that is always wrong is a fixed threshold on a machine it was not chosen for.
  let auto = stored.auto !== false
  let openUntil = 0
  let inputDb = SILENCE_DB
  let floorDb = SILENCE_DB
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
  // The analyser is a tap, not a link in the chain: it reads the microphone before the gate, so the
  // meter keeps showing what is arriving even while nothing is being let through.
  source.connect(analyser)
  source.connect(gate)
  gate.connect(destination)

  const save = () => {
    try { storage?.setItem(STORAGE_KEY, JSON.stringify({ thresholdDb: manualThreshold, auto })) } catch { /* a private store is not worth failing over */ }
  }
  const announce = () => onChange?.()

  // The quiet end of the recent past. A mean would be dragged up by speech, and a minimum would be
  // dragged down by a single silent frame; a low percentile is steady against both.
  const noiseFloor = () => {
    if (!history.length) return SILENCE_DB
    const sorted = [...history].sort((a, b) => a - b)
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * FLOOR_PERCENTILE))]
  }
  const effectiveThreshold = () => (auto ? clampThreshold(floorDb + AUTO_MARGIN_DB) : manualThreshold)

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
    // The room is only sampled while the gate is shut. Folding speech into the noise floor raises the
    // bar towards the speaker's own level, and a few seconds of steady talking would then close the gate
    // on the person talking -- measured in the browser, a continuous voice drove the threshold to the top
    // of the scale. The exception is the first window: with no history there is no floor to judge by, so
    // it has to learn from whatever is arriving, and it corrects itself as soon as the room goes quiet.
    if (at >= openUntil || history.length < FLOOR_WINDOW) {
      history.push(inputDb)
      if (history.length > FLOOR_WINDOW) history.shift()
      floorDb = noiseFloor()
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
      clearInterval(timer); timer = null
      try { source.disconnect(); analyser.disconnect(); gate.disconnect() } catch { /* already torn down */ }
      for (const track of destination.stream.getAudioTracks?.() || []) track.stop?.()
    },
  }
}

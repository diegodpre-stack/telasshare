// Per-listener control over what everyone else sounds like.
//
// The obvious way to do this is <audio>.volume, and it cannot work: that property is capped at 1.0, so
// a friend whose microphone is too quiet can never be raised. Everything here runs through Web Audio
// instead, where a gain node has no such ceiling -- 200% is a gain of 2.
//
// Every setting is one listener's own. Turning someone down here changes nothing for anyone else, which
// is the point: the same person can be too loud for one listener and too quiet for another.
export const MIN_VOLUME = 0
export const MAX_VOLUME = 200
export const DEFAULT_VOLUME = 100

// Anything unusable becomes the default rather than silence: a stored value that has gone bad should
// leave someone audible, not quietly mute a friend for good.
export function clampVolume(value) {
  const number = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(number)) return DEFAULT_VOLUME
  return Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, Math.round(number)))
}

const STORAGE_KEY = 'entretelas-volumes'

// Kept by name, which is what survives here: connection ids change with every session, and the same
// friend being too loud is a fact about them rather than about this particular call.
function readStored(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) || '{}')
    if (!parsed || typeof parsed !== 'object') return {}
    return Object.fromEntries(Object.entries(parsed).map(([name, value]) => [name, clampVolume(value)]))
  } catch { return {} }
}

export function createVoiceMixer({
  audioContext,
  storage = typeof localStorage === 'undefined' ? null : localStorage,
  onChange,
} = {}) {
  const context = audioContext || new (globalThis.AudioContext || globalThis.webkitAudioContext)()
  const voices = new Map()
  const volumes = readStored(storage)
  let deafened = false
  let muted = false
  let microphone = null
  let micMeter = null

  const save = () => {
    try { storage?.setItem(STORAGE_KEY, JSON.stringify(volumes)) } catch { /* a full or private store is not worth failing over */ }
  }

  const gainFor = (name) => (deafened ? 0 : clampVolume(volumes[name] ?? DEFAULT_VOLUME) / 100)
  const applyAll = () => { for (const [name, voice] of voices) voice.gain.gain.value = gainFor(name) }
  const announce = () => onChange?.()

  // A meter tapped off the source, before the gain: it reports whether someone is actually speaking,
  // which is a fact about them and must not change because this listener turned them down or deafened.
  // Optional throughout -- a context without an analyser simply reports no levels rather than failing.
  const meterFor = (stream) => {
    try {
      const analyser = context.createAnalyser?.()
      if (!analyser) return null
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.5
      const source = context.createMediaStreamSource(stream)
      source.connect(analyser)
      return { analyser, source, samples: new Uint8Array(analyser.fftSize) }
    } catch { return null }
  }
  const readMeter = (meter) => {
    if (!meter) return 0
    try {
      meter.analyser.getByteTimeDomainData(meter.samples)
      let sum = 0
      for (const sample of meter.samples) { const centred = (sample - 128) / 128; sum += centred * centred }
      // Root mean square, then a gentle curve: raw RMS on speech sits so low that a linear bar looks dead.
      return Math.min(1, Math.sqrt(sum / meter.samples.length) * 4)
    } catch { return 0 }
  }
  // Chromium will not pull audio out of a remote MediaStream through Web Audio alone: the source node
  // is created happily and then delivers silence. Attaching the same stream to a media element as well
  // is what starts it flowing. The element is muted and never heard -- the gain node is still what
  // reaches the speakers, so per-person volume and deafen keep working exactly as they read.
  const keepFlowing = (stream) => {
    if (typeof document === 'undefined') return null
    try {
      const element = document.createElement('audio')
      element.muted = true
      element.autoplay = true
      element.srcObject = stream
      element.play?.().catch(() => {})
      return element
    } catch { return null }
  }
  const releaseFlow = (element) => {
    if (!element) return
    try { element.pause?.(); element.srcObject = null } catch { /* already detached */ }
  }
  const releaseMeter = (meter) => {
    if (!meter) return
    try { meter.source.disconnect(); meter.analyser.disconnect() } catch { /* already torn down */ }
  }

  return {
    get deafened() { return deafened },
    get muted() { return muted },
    // Browsers start an AudioContext suspended until a gesture, and a suspended one plays nothing at all.
    resume: () => context.resume?.(),

    // One gain node per person, so each can be moved without touching the others.
    attach(name, stream) {
      if (voices.has(name)) this.detach(name)
      const source = context.createMediaStreamSource(stream)
      const gain = context.createGain()
      gain.gain.value = gainFor(name)
      source.connect(gain)
      gain.connect(context.destination)
      voices.set(name, { source, gain, stream, meter: meterFor(stream), flow: keepFlowing(stream) })
      return gain
    },

    detach(name) {
      const voice = voices.get(name)
      if (!voice) return false
      try { voice.source.disconnect(); voice.gain.disconnect() } catch { /* already torn down */ }
      releaseMeter(voice.meter)
      releaseFlow(voice.flow)
      voices.delete(name)
      return true
    },

    // How loud each person is right now, 0 to 1, sampled on demand rather than pushed: the interface
    // decides how often it wants to redraw, and nothing runs when nobody is looking.
    levels() {
      const result = {}
      for (const [name, voice] of voices) result[name] = readMeter(voice.meter)
      return result
    },
    // The same reading for the microphone, so someone can see that they are being picked up before
    // asking a friend whether they can be heard. Zero while muted, because nothing is being sent.
    micLevel: () => (muted ? 0 : readMeter(micMeter)),

    getVolume: (name) => clampVolume(volumes[name] ?? DEFAULT_VOLUME),

    setVolume(name, value) {
      const volume = clampVolume(value)
      volumes[name] = volume
      save()
      const voice = voices.get(name)
      if (voice) voice.gain.gain.value = gainFor(name)
      announce()
      return volume
    },

    // Deafening silences everyone without forgetting how loud each of them was.
    setDeafened(value) {
      deafened = value === true
      applyAll()
      announce()
      return deafened
    },

    // The microphone is the one thing muting must reach at the source rather than at playback: a muted
    // track sends nothing, so nobody has to be trusted to honour it.
    useMicrophone(stream) {
      microphone = stream || null
      releaseMeter(micMeter)
      // Never connected to the destination: metering the microphone must not play it back into the room.
      micMeter = microphone ? meterFor(microphone) : null
      this.setMuted(muted)
      return microphone
    },

    setMuted(value) {
      muted = value === true
      for (const track of microphone?.getAudioTracks?.() || []) track.enabled = !muted
      announce()
      return muted
    },

    get names() { return [...voices.keys()] },

    close() {
      for (const name of [...voices.keys()]) this.detach(name)
      releaseMeter(micMeter)
      micMeter = null
      microphone = null
      return context.close?.()
    },
  }
}

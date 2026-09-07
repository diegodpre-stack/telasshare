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

  const save = () => {
    try { storage?.setItem(STORAGE_KEY, JSON.stringify(volumes)) } catch { /* a full or private store is not worth failing over */ }
  }

  const gainFor = (name) => (deafened ? 0 : clampVolume(volumes[name] ?? DEFAULT_VOLUME) / 100)
  const applyAll = () => { for (const [name, voice] of voices) voice.gain.gain.value = gainFor(name) }
  const announce = () => onChange?.()

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
      voices.set(name, { source, gain, stream })
      return gain
    },

    detach(name) {
      const voice = voices.get(name)
      if (!voice) return false
      try { voice.source.disconnect(); voice.gain.disconnect() } catch { /* already torn down */ }
      voices.delete(name)
      return true
    },

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
      microphone = null
      return context.close?.()
    },
  }
}

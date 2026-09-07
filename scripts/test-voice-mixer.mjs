import assert from 'node:assert/strict'
import { clampVolume, createVoiceMixer, MAX_VOLUME, DEFAULT_VOLUME } from '../src/voiceMixer.js'

// A stand-in for Web Audio: enough to watch what gets connected and what each gain is set to.
function fakeContext() {
  const state = { closed: false, resumed: 0, connections: [] }
  const node = (kind) => ({
    kind,
    gain: { value: 1 },
    connect(target) { state.connections.push([kind, target?.kind || 'destination']) },
    disconnect() { state.connections = state.connections.filter(([from]) => from !== kind) },
  })
  return {
    state,
    destination: { kind: 'destination' },
    createMediaStreamSource: () => node('source'),
    createGain: () => node('gain'),
    resume: () => { state.resumed += 1 },
    close: () => { state.closed = true },
  }
}

const fakeStorage = (initial = {}) => {
  const store = { ...initial }
  return { store, getItem: (key) => store[key] ?? null, setItem: (key, value) => { store[key] = value } }
}

const streamWith = (...tracks) => ({ getAudioTracks: () => tracks })

// --- the range ------------------------------------------------------------
// The whole reason this exists: <audio>.volume stops at 1.0, so a quiet friend could never be raised.
assert.equal(MAX_VOLUME, 200)
assert.equal(clampVolume(130), 130)
assert.equal(clampVolume(250), 200, 'above the range is the ceiling, not a rejection')
assert.equal(clampVolume(-10), 0)
assert.equal(clampVolume('60'), 60, 'a range input hands back a string')
assert.equal(clampVolume(72.6), 73)
// Unusable values become the default rather than silence: a corrupted setting must not mute a friend
// permanently, with nothing on screen to explain why they went quiet.
for (const bad of [undefined, null, NaN, 'loud', {}]) assert.equal(clampVolume(bad), DEFAULT_VOLUME)

// --- one gain per person --------------------------------------------------
const context = fakeContext()
const storage = fakeStorage()
let changes = 0
const mixer = createVoiceMixer({ audioContext: context, storage, onChange: () => { changes += 1 } })

mixer.attach('Ana', streamWith())
mixer.attach('Bruno', streamWith())
assert.deepEqual(mixer.names, ['Ana', 'Bruno'])
assert.deepEqual(context.state.connections, [['source', 'gain'], ['gain', 'destination'], ['source', 'gain'], ['gain', 'destination']])

// Turning one person down leaves everyone else exactly where they were.
mixer.setVolume('Ana', 60)
assert.equal(mixer.getVolume('Ana'), 60)
assert.equal(mixer.getVolume('Bruno'), DEFAULT_VOLUME)
mixer.setVolume('Bruno', 130)
assert.equal(mixer.getVolume('Bruno'), 130, 'past 100% is the point of this module')

// A volume set before someone joins has to apply the moment they do.
mixer.setVolume('Carla', 40)
const carla = mixer.attach('Carla', streamWith())
assert.equal(carla.gain.value, 0.4)

// --- deafen ---------------------------------------------------------------
// Silences everyone without forgetting how loud each of them was.
mixer.setDeafened(true)
assert.equal(mixer.deafened, true)
mixer.setVolume('Ana', 80)
assert.equal(mixer.getVolume('Ana'), 80, 'a change made while deafened is remembered')
mixer.setDeafened(false)
assert.equal(mixer.getVolume('Ana'), 80)
assert.equal(mixer.getVolume('Bruno'), 130, 'and everyone else comes back as they were')

// --- the microphone -------------------------------------------------------
// Muting has to stop the track itself: a muted track sends nothing, so nobody has to be trusted with it.
// The stream here is the processed one from voiceInput, so muting reaches what peers actually receive.
const microphone = { enabled: true }
mixer.useMicrophone(streamWith(microphone))
mixer.setMuted(true)
assert.equal(microphone.enabled, false)
assert.equal(mixer.muted, true)
mixer.setMuted(false)
assert.equal(microphone.enabled, true)
// Replacing the microphone must not quietly unmute it.
mixer.setMuted(true)
const replacement = { enabled: true }
mixer.useMicrophone(streamWith(replacement))
assert.equal(replacement.enabled, false, 'a new microphone arrives muted if that is the state')
assert.doesNotThrow(() => mixer.useMicrophone(null))

// --- what is remembered ---------------------------------------------------
// Volumes are kept by name: connection ids change every session, while a friend being too loud does not.
const reopened = createVoiceMixer({ audioContext: fakeContext(), storage })
assert.equal(reopened.getVolume('Bruno'), 130, 'a volume set in an earlier session still applies')
assert.equal(reopened.getVolume('Ninguém'), DEFAULT_VOLUME)
assert.equal(reopened.deafened, false, 'deafen is a state for this session, not a preference')

// Junk in storage must leave everyone audible rather than break the mixer.
for (const broken of ['not json', '[]', 'null', '{"Ana":"muito alto"}']) {
  const recovered = createVoiceMixer({ audioContext: fakeContext(), storage: fakeStorage({ 'entretelas-volumes': broken }) })
  assert.equal(recovered.getVolume('Ana'), DEFAULT_VOLUME, `${broken} must not silence anyone`)
}
// A browser that refuses storage must not take the call down with it.
const noStorage = createVoiceMixer({ audioContext: fakeContext(), storage: null })
assert.doesNotThrow(() => noStorage.setVolume('Ana', 50))
assert.equal(noStorage.getVolume('Ana'), 50)

// --- lifecycle ------------------------------------------------------------
assert.ok(changes > 0, 'the interface has to hear about changes to redraw')
mixer.attach('Ana', streamWith())
assert.equal(mixer.names.filter((name) => name === 'Ana').length, 1, 'reattaching replaces rather than stacks')
assert.equal(mixer.detach('Ana'), true)
assert.equal(mixer.detach('Ana'), false, 'detaching twice is not an error')
mixer.close()
assert.equal(context.state.closed, true)
assert.deepEqual(mixer.names, [], 'closing releases every voice')

console.log('PASS: 0-200% per listener, gain per person, deafen without forgetting, microphone muted at the track, volumes remembered by name and unusable settings left audible.')

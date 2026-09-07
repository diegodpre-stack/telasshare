// RNNoise, from the same people as Opus, running as an AudioWorklet.
//
// This is the only file that knows the model exists. Everything else takes a node and connects it, which
// is what keeps voiceInput testable outside a browser: the imports below are resolved by the bundler and
// mean nothing to Node.
//
// It is not Krisp. Krisp is a large proprietary model behind a subscription; this is a small one from
// 2017 that runs in about a percent of a core. It is very good at anything with a steady character --
// a fan, a hiss, a hum, room tone -- and partial on sharp transients like a key being struck. Combined
// with the gate, which already removes everything while nobody is speaking, what is left is the case of
// typing while talking, and that is where the difference between this and Krisp shows.
import { RnnoiseWorkletNode, loadRnnoise } from '@sapphi-red/web-noise-suppressor'
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'

// Fetched once per page rather than once per voice session: the second time someone joins, the model is
// already here and the chain is complete before they finish clicking.
let binary = null

export async function createRnnoiseSuppressor(context) {
  try {
    // Picks the SIMD build where the browser has it, which is everywhere the app actually runs.
    binary ||= await loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl })
    await context.audioWorklet.addModule(rnnoiseWorkletUrl)
    // A copy each time: the worklet takes ownership of the buffer it is given, and a detached one would
    // leave the second session in the same page with nothing to load.
    return new RnnoiseWorkletNode(context, { maxChannels: 1, wasmBinary: binary.slice(0) })
  } catch {
    // A model that will not load must cost nothing more than itself. The microphone keeps working with
    // the gate and the browser's own suppression, which is exactly what it had before this existed.
    return null
  }
}

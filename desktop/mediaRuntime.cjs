// Hardware encoding and zero-copy desktop capture are independent: the first is about which encoder
// runs, the second about how a captured frame reaches it. Chromium 152 defaults ZeroCopyDesktopCapture
// off (media/base/media_switches.cc), and off means every frame is read back from the GPU into system
// memory and converted to I420 on one thread before being uploaded again to encode. At 1440p that is
// 14.7 MB per frame, about 880 MB/s at 60 FPS, and it is what holds a capture that should reach 60 at
// 35 — the capture loop polls on a 16.6 ms budget, so overshooting it at all costs the whole slot.
//
// So we turn it on. Chromium keeps it off because the path depends on the driver, the surface format
// and the encoder accepting the texture directly; when a link in that chain fails the symptom is a dead
// GPU process, not a slower one. That is a failure we can observe, so the opt-in is self-correcting
// rather than permanent: main.cjs counts GPU deaths that happen while this is on and hands the count
// back here, and after two the app returns to the safe path on its own.
const ZERO_COPY_CRASH_LIMIT = 2

// A crash count is only meaningful for runs that actually used the fast path, so main.cjs records one
// only while zeroCopyCapture was true. `1` still forces the path on, which is also how someone who was
// auto-disabled by a since-fixed driver asks for it back; `0` remains the full opt-out.
function mediaFeaturePolicy(env = process.env, state = {}) {
  const forced = env.ENTRETELAS_GPU_CAPTURE === '1'
  const crashes = Number.isInteger(state.zeroCopyCrashes) ? state.zeroCopyCrashes : 0
  const disabledByCrashes = !forced && crashes >= ZERO_COPY_CRASH_LIMIT
  const zeroCopyCapture = forced || (env.ENTRETELAS_GPU_CAPTURE !== '0' && !disabledByCrashes)
  // Preserve the old explicit opt-out: 0 also restores Chromium's low-resolution encoder policy.
  const lowResolutionHardware = env.ENTRETELAS_GPU_CAPTURE !== '0'
  return {
    zeroCopyCapture,
    // Kept separate from the flag itself so the diagnostics report can say "off because it crashed"
    // rather than leaving someone guessing why their capture is slow again.
    zeroCopyDisabledByCrashes: disabledByCrashes,
    lowResolutionHardware,
    enabledFeatures: zeroCopyCapture ? ['ZeroCopyDesktopCapture'] : [],
    disabledFeatures: [
      'WebRtcHideLocalIpsWithMdns',
      ...(!zeroCopyCapture ? ['ZeroCopyDesktopCapture'] : []),
      ...(lowResolutionHardware ? ['ForceSoftwareForRtcLowResolutions'] : []),
    ],
  }
}

// Memory only; deliberately omit PIDs, process names, paths, URLs and crash dumps.
function createMediaRuntimeLog(policy, versions = process.versions) {
  const events = []
  return {
    record(type, details = {}) {
      events.push({ time: new Date().toISOString(), type,
        reason: ['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'memory-eviction'].includes(details.reason) ? details.reason : 'unknown',
        exitCode: Number.isInteger(details.exitCode) ? details.exitCode : null })
      if (events.length > 20) events.shift()
    },
    snapshot() {
      return {
        electron: versions.electron || null, chromium: versions.chrome || null,
        zeroCopyCapture: policy.zeroCopyCapture,
        zeroCopyDisabledByCrashes: policy.zeroCopyDisabledByCrashes === true,
        lowResolutionHardware: policy.lowResolutionHardware,
        events: events.map((event) => ({ ...event })),
      }
    },
  }
}

// A GPU process that exits cleanly, is killed, or is evicted for memory says nothing about the capture
// path. Only these mean it died on its own while we were asking it to hand textures straight to the
// encoder, which is the fault the fallback exists for.
const ZERO_COPY_FAILURE_REASONS = ['crashed', 'oom', 'launch-failed', 'integrity-failure']

// The state file is written by whatever the app happened to be doing last, and by hand-editing, and by
// half-finished writes on a machine that lost power. Everything that is not a plain non-negative
// integer means "no history", which is the same answer as a machine that has never run this build.
function readZeroCopyState(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    const crashes = parsed?.zeroCopyCrashes
    return { zeroCopyCrashes: Number.isInteger(crashes) && crashes >= 0 ? crashes : 0 }
  } catch { return { zeroCopyCrashes: 0 } }
}

// Returns the state to persist, or null when nothing changed — so callers can skip the write entirely
// rather than rewriting the same file on every uninteresting GPU event.
function recordZeroCopyFailure(state, details, policy) {
  if (!policy?.zeroCopyCapture) return null
  if (!ZERO_COPY_FAILURE_REASONS.includes(details?.reason)) return null
  return { zeroCopyCrashes: readZeroCopyState(state).zeroCopyCrashes + 1 }
}

// One bad driver day should not cost the fast path forever. A run that got this far without the GPU
// process dying is evidence the path works on this machine, so the history goes back to zero.
function clearZeroCopyFailures(state) {
  return readZeroCopyState(state).zeroCopyCrashes === 0 ? null : { zeroCopyCrashes: 0 }
}

module.exports = {
  mediaFeaturePolicy, createMediaRuntimeLog,
  readZeroCopyState, recordZeroCopyFailure, clearZeroCopyFailures,
  ZERO_COPY_CRASH_LIMIT,
}

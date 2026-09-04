// Hardware encoding and zero-copy desktop capture are independent. Keep hardware-friendly
// codec selection, but don't force Chromium's experimental capture path on every driver.
// Chromium 152 defaults ZeroCopyDesktopCapture off (media/base/media_switches.cc).
function mediaFeaturePolicy(env = process.env) {
  const zeroCopyCapture = env.ENTRETELAS_GPU_CAPTURE === '1'
  // Preserve the old explicit opt-out: 0 also restores Chromium's low-resolution encoder policy.
  const lowResolutionHardware = env.ENTRETELAS_GPU_CAPTURE !== '0'
  return {
    zeroCopyCapture,
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
        lowResolutionHardware: policy.lowResolutionHardware,
        events: events.map((event) => ({ ...event })),
      }
    },
  }
}

module.exports = { mediaFeaturePolicy, createMediaRuntimeLog }

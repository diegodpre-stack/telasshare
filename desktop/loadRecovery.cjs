// Getting the window back when the page never draws.
//
// Found on a machine whose HTTP cache held a damaged copy of one of the site's files -- most likely
// written as the power went -- so every launch served the broken copy, the page failed with
// ERR_CONTENT_DECODING_FAILED, and all anybody saw was the window's own background colour. Nothing on
// screen said why, and the cure was deleting a folder nobody would think to look for.
//
// So the app checks for itself: once the page has loaded it waits a moment and asks whether the app
// actually mounted. If it did not -- or if the page failed to load at all -- the HTTP cache is cleared
// and the page reloaded, bypassing whatever was stored. Only the cache: settings, the remembered name
// and the room seats live elsewhere and are left alone.
//
// Once per launch. A second failure is not something clearing the cache again would fix, and a window
// that reloads itself in a loop is worse than one that stays still.
const MOUNT_CHECK_DELAY_MS = 12_000
// A navigation the app itself cancelled is not a failure.
const ERR_ABORTED = -3

function createLoadRecovery({
  checkMounted, clearCache, reload, record = () => {},
  delayMs = MOUNT_CHECK_DELAY_MS, schedule = setTimeout, cancel = clearTimeout,
} = {}) {
  let attempted = false
  let gaveUp = false
  let timer = null

  const recover = async (reason, detail) => {
    if (attempted) {
      if (!gaveUp) { gaveUp = true; record('load-recovery-failed', { reason, ...detail }) }
      return false
    }
    attempted = true
    record('load-recovery', { reason, ...detail })
    try { await clearCache() } catch { /* reloading bypasses the cache anyway */ }
    reload()
    return true
  }

  return {
    get attempted() { return attempted },

    onLoaded() {
      if (timer) cancel(timer)
      timer = schedule(async () => {
        timer = null
        let mounted = true
        // Asked, not assumed: a page that cannot answer is treated as fine, because recovering from a
        // failure that may not exist costs a reload somebody did not ask for.
        try { mounted = await checkMounted() } catch { mounted = true }
        if (!mounted) await recover('not-mounted')
      }, delayMs)
    },

    onFailedLoad(errorCode, isMainFrame) {
      // A picture or a font failing is not the page failing, and an aborted navigation is deliberate.
      if (!isMainFrame || errorCode === ERR_ABORTED) return false
      if (timer) { cancel(timer); timer = null }
      return recover('load-failed', { errorCode })
    },

    dispose() { if (timer) { cancel(timer); timer = null } },
  }
}

module.exports = { createLoadRecovery, MOUNT_CHECK_DELAY_MS }

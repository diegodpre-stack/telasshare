// A window that stays on its background colour and never draws the page. The recovery has to happen
// when that is what is going on, and must not happen when it is not -- a reload nobody asked for, or a
// window reloading itself forever, is its own kind of broken.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLoadRecovery } = require('../desktop/loadRecovery.cjs')

// Timers held in hand, so a twelve-second wait is a function call.
const harness = ({ mounted = true, clearFails = false } = {}) => {
  const log = { cleared: 0, reloads: 0, records: [], pending: [] }
  const recovery = createLoadRecovery({
    checkMounted: async () => (typeof mounted === 'function' ? mounted() : mounted),
    clearCache: async () => { log.cleared += 1; if (clearFails) throw new Error('no') },
    reload: () => { log.reloads += 1 },
    record: (event, detail) => log.records.push([event, detail]),
    schedule: (fn) => { const t = { fn }; log.pending.push(t); return t },
    cancel: (t) => { log.pending = log.pending.filter((p) => p !== t) },
  })
  const tick = async () => { const due = log.pending.splice(0); for (const t of due) await t.fn() }
  return { recovery, log, tick }
}

// --- a page that draws is left alone ------------------------------------------
{
  const { recovery, log, tick } = harness({ mounted: true })
  recovery.onLoaded()
  assert.equal(log.reloads, 0, 'nothing happens before the check')
  await tick()
  assert.equal(log.reloads, 0, 'a mounted page is not reloaded')
  assert.equal(log.cleared, 0)
  assert.equal(recovery.attempted, false)
}

// --- the case that was found: loaded, never mounted ---------------------------
{
  const { recovery, log, tick } = harness({ mounted: false })
  recovery.onLoaded()
  await tick()
  assert.equal(log.cleared, 1, 'the cache is cleared')
  assert.equal(log.reloads, 1, 'and the page reloaded')
  assert.equal(log.records[0][0], 'load-recovery', 'and it is written down, so a report shows it happened')
  assert.equal(log.records[0][1].reason, 'not-mounted')
}

// --- a page that fails to load at all -----------------------------------------
{
  const { recovery, log } = harness()
  assert.equal(await recovery.onFailedLoad(-330, true), true, 'ERR_CONTENT_DECODING_FAILED on the page itself recovers')
  assert.equal(log.cleared, 1)
  assert.equal(log.records[0][1].errorCode, -330)
}
{
  const { recovery, log } = harness()
  // A picture or a font failing is not the page failing.
  assert.equal(await recovery.onFailedLoad(-330, false), false, 'a subresource is not the page')
  // And a navigation the app cancelled itself is not a failure at all.
  assert.equal(await recovery.onFailedLoad(-3, true), false, 'an aborted navigation is deliberate')
  assert.equal(log.reloads, 0)
}

// --- once per launch, never a loop --------------------------------------------
{
  const { recovery, log, tick } = harness({ mounted: false })
  recovery.onLoaded(); await tick()
  // The reload happens, the page loads again, and it is still broken.
  recovery.onLoaded(); await tick()
  recovery.onLoaded(); await tick()
  assert.equal(log.reloads, 1, 'a second failure is not reloaded again')
  assert.equal(log.cleared, 1)
  const failed = log.records.filter(([event]) => event === 'load-recovery-failed')
  assert.equal(failed.length, 1, 'giving up is written down once, not on every load')
}
{
  const { recovery, log } = harness()
  await recovery.onFailedLoad(-330, true)
  await recovery.onFailedLoad(-330, true)
  assert.equal(log.reloads, 1, 'the same applies to failed loads')
}

// --- and the recovery itself cannot be what breaks ----------------------------
{
  const { recovery, log, tick } = harness({ mounted: false, clearFails: true })
  recovery.onLoaded(); await tick()
  assert.equal(log.reloads, 1, 'a cache that refuses to clear still gets a reload that bypasses it')
}
{
  // A page that cannot be asked -- navigated away, renderer gone -- is not treated as broken.
  const { recovery, log, tick } = harness({ mounted: () => { throw new Error('gone') } })
  recovery.onLoaded(); await tick()
  assert.equal(log.reloads, 0, 'not being able to ask is not evidence of a failure')
}
{
  // Loading twice before the check only checks once, against the latest load.
  const { recovery, log, tick } = harness({ mounted: true })
  recovery.onLoaded(); recovery.onLoaded(); recovery.onLoaded()
  assert.equal(log.pending.length, 1, 'one pending check, not three')
  await tick()
}
{
  // A failed load cancels a check still waiting, so the two cannot both recover.
  const { recovery, log, tick } = harness({ mounted: false })
  recovery.onLoaded()
  await recovery.onFailedLoad(-330, true)
  await tick()
  assert.equal(log.reloads, 1)
}

console.log('PASS: a page that draws is left alone; one that loads without mounting, or fails to load itself, has its HTTP cache cleared and is reloaded; a failing picture or a deliberate abort is not a failure; it happens once per launch and giving up is recorded once; a cache that will not clear still gets a reload, a page that cannot be asked is not assumed broken, and repeated loads schedule one check.')

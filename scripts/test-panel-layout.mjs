import assert from 'node:assert/strict'
import { clampSize, createPanelLayout, movePanel, normalizeOrder, PANELS, PANEL_LIMITS } from '../src/panelLayout.js'

const fakeStorage = (initial = {}) => {
  const store = { ...initial }
  return { store, getItem: (key) => store[key] ?? null, setItem: (key, value) => { store[key] = value } }
}
const KEY = 'telasshare-layout'

// --- sizes are clamped, never trusted -------------------------------------
// A panel restored at four pixels wide, or at a width from a much larger monitor, is worse than one
// restored at its default: it looks like the app is broken with nothing on screen to explain it.
assert.deepEqual(clampSize('people', { width: 320, height: 500 }), { width: 320, height: 500 })
assert.equal(clampSize('people', { width: 4 }).width, PANEL_LIMITS.people.minWidth)
assert.equal(clampSize('people', { width: 9000 }).width, PANEL_LIMITS.people.maxWidth)
assert.equal(clampSize('people', { width: '340' }).width, 340, 'a measured width can arrive as a string')
assert.equal(clampSize('people', { width: 320.6 }).width, 321)
// The stage takes what is left, so it has no width to store and must not invent one.
assert.deepEqual(clampSize('stage', { width: 800, height: 600 }), { height: 600 })
for (const bad of [null, undefined, 'grande', 42, []]) assert.deepEqual(clampSize('people', bad), {})
for (const bad of [{ width: NaN }, { width: null }, { width: 'grande' }]) assert.deepEqual(clampSize('people', bad), {})
assert.deepEqual(clampSize('inexistente', { width: 300 }), {})

// --- the order is repaired rather than rejected ---------------------------
assert.deepEqual(normalizeOrder(['chat', 'stage']), ['chat', 'stage', 'people', 'settings'], 'the rest keep their usual places')
assert.deepEqual(normalizeOrder(['chat', 'chat', 'chat']), ['chat', ...PANELS.filter((id) => id !== 'chat')])
assert.deepEqual(normalizeOrder(['inventado', 'chat']), ['chat', ...PANELS.filter((id) => id !== 'chat')])
for (const bad of [null, undefined, 'chat', 42, {}]) assert.deepEqual(normalizeOrder(bad), PANELS)

// --- moving one panel to another's place ----------------------------------
assert.deepEqual(movePanel(PANELS, 'chat', 'people'), ['chat', 'people', 'stage', 'settings'])
assert.deepEqual(movePanel(PANELS, 'people', 'settings'), ['stage', 'chat', 'people', 'settings'])
// Dropped on itself, or on nothing, the order stands rather than throwing.
assert.deepEqual(movePanel(PANELS, 'chat', 'chat'), PANELS)
assert.deepEqual(movePanel(PANELS, 'nao-existe', 'chat'), PANELS)
assert.deepEqual(movePanel(PANELS, 'chat', 'nao-existe'), ['people', 'stage', 'settings', 'chat'], 'dropped past the end goes last')

// --- what is remembered ---------------------------------------------------
const storage = fakeStorage()
let changes = 0
const layout = createPanelLayout({ storage, onChange: () => { changes += 1 } })
assert.deepEqual(layout.order, PANELS)
assert.equal(layout.customised, false)
assert.deepEqual(layout.sizeOf('chat'), {})

assert.equal(layout.resize('chat', { width: 380, height: 520 }), true)
assert.deepEqual(layout.sizeOf('chat'), { width: 380, height: 520 })
assert.equal(layout.customised, true)
// The same size again is not a change: the observer fires constantly while a panel is being dragged,
// and writing storage and redrawing on every pixel of that would be the whole cost of the feature.
assert.equal(layout.resize('chat', { width: 380, height: 520 }), false)
const after = changes
assert.equal(layout.resize('chat', { width: 380.4, height: 520 }), false, 'rounding to the same pixel is the same size')
assert.equal(changes, after)

assert.equal(layout.move('chat', 'people'), true)
assert.deepEqual(layout.order, ['chat', 'people', 'stage', 'settings'])
assert.equal(layout.indexOf('chat'), 0)
assert.equal(layout.move('chat', 'chat'), false, 'a move that changes nothing is not a change')

// It survives the session, clamped again on the way back in.
const reopened = createPanelLayout({ storage })
assert.deepEqual(reopened.order, ['chat', 'people', 'stage', 'settings'])
assert.deepEqual(reopened.sizeOf('chat'), { width: 380, height: 520 })

// --- one way back ---------------------------------------------------------
reopened.reset()
assert.deepEqual(reopened.order, PANELS)
assert.deepEqual(reopened.sizeOf('chat'), {})
assert.equal(reopened.customised, false)
assert.deepEqual(createPanelLayout({ storage }).order, PANELS, 'and the reset is remembered too')

// --- a stored value that has gone bad -------------------------------------
// Anything unusable costs the arrangement and never the app.
for (const broken of ['nao e json', '[]', 'null', '{"order":"chat"}', '{"sizes":{"chat":{"width":"enorme"}}}', '{"sizes":null}']) {
  const recovered = createPanelLayout({ storage: fakeStorage({ [KEY]: broken }) })
  assert.deepEqual(recovered.order, PANELS, `${broken} must not scramble the order`)
  assert.deepEqual(recovered.sizeOf('chat'), {}, `${broken} must not produce a size`)
}
// A width saved on a much larger monitor comes back inside this one's limits.
const huge = createPanelLayout({ storage: fakeStorage({ [KEY]: '{"sizes":{"chat":{"width":5000}}}' }) })
assert.equal(huge.sizeOf('chat').width, PANEL_LIMITS.chat.maxWidth)

// A browser that refuses storage must not take the room down with it.
const noStorage = createPanelLayout({ storage: null })
assert.doesNotThrow(() => { noStorage.resize('chat', { width: 300 }); noStorage.move('chat', 'people') })
assert.deepEqual(noStorage.sizeOf('chat'), { width: 300 }, 'it still works for this session')

console.log('PASS: sizes clamped on the way in and out, the stage never stores a width, a damaged order repaired rather than rejected, moving a panel onto another or onto nothing, a redundant resize costing neither a write nor a redraw, the arrangement surviving the session, and a reset that is remembered.')

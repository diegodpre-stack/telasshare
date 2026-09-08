import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  clampSize, createPanelLayout, dropRegion, normalizeColumns, placePanel,
  DEFAULT_COLUMNS, PANELS, PANEL_LIMITS,
} from '../src/panelLayout.js'

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
for (const bad of [null, undefined, 'grande', 42, []]) assert.deepEqual(clampSize('people', bad), {})
for (const bad of [{ width: NaN }, { width: null }, { width: 'grande' }]) assert.deepEqual(clampSize('people', bad), {})
assert.deepEqual(clampSize('inexistente', { width: 300 }), {})

// --- the arrangement is repaired rather than rejected ---------------------
assert.deepEqual(normalizeColumns([['people', 'chat'], ['stage']]), [['people', 'chat'], ['stage'], ['settings']])
assert.deepEqual(normalizeColumns([['people', 'people'], ['people']]), [['people'], ['stage'], ['chat'], ['settings']], 'a panel appears once')
assert.deepEqual(normalizeColumns([[], ['chat'], []]), [['chat'], ['people'], ['stage'], ['settings']], 'empty columns are dropped')
assert.deepEqual(normalizeColumns([['inventado', 'chat']]), [['chat'], ['people'], ['stage'], ['settings']])
for (const bad of [null, undefined, 'chat', 42, {}, [1, 2], ['chat']]) {
  assert.deepEqual(normalizeColumns(bad), DEFAULT_COLUMNS, `${JSON.stringify(bad)} falls back to the default`)
}

// --- where a drop means what ----------------------------------------------
// The sides are narrow because they are the unusual intention: most drops are meant to stack.
const rect = { left: 100, top: 100, width: 400, height: 400 }
assert.equal(dropRegion(rect, 110, 300), 'left')
assert.equal(dropRegion(rect, 490, 300), 'right')
assert.equal(dropRegion(rect, 300, 150), 'above')
assert.equal(dropRegion(rect, 300, 450), 'below')
// Most of the panel stacks rather than splits.
assert.equal(dropRegion(rect, 300, 300), 'below')
assert.equal(dropRegion(rect, 200, 200), 'above')
assert.equal(dropRegion({ width: 0, height: 0 }, 0, 0), 'below', 'a panel with no size still answers')

// --- stacking, which is the point -----------------------------------------
// The conversation under the friends list: one column holding both, and the rest untouched.
const stacked = placePanel(DEFAULT_COLUMNS, 'chat', 'people', 'below')
assert.deepEqual(stacked, [['people', 'chat'], ['stage'], ['settings']])
assert.deepEqual(placePanel(DEFAULT_COLUMNS, 'chat', 'people', 'above'), [['chat', 'people'], ['stage'], ['settings']])
// And back out into a column of its own.
assert.deepEqual(placePanel(stacked, 'chat', 'stage', 'right'), [['people'], ['stage'], ['chat'], ['settings']])
assert.deepEqual(placePanel(stacked, 'chat', 'people', 'left'), [['chat'], ['people'], ['stage'], ['settings']])

// Three in one column, in the order they were dropped.
const three = placePanel(placePanel(DEFAULT_COLUMNS, 'chat', 'people', 'below'), 'settings', 'chat', 'below')
assert.deepEqual(three, [['people', 'chat', 'settings'], ['stage']])
// Moving the middle one out must not leave a hole or a stray empty column.
assert.deepEqual(placePanel(three, 'chat', 'stage', 'right'), [['people', 'settings'], ['stage'], ['chat']])

// A column emptied by the move disappears rather than lingering as a gap.
const emptied = placePanel([['people'], ['chat']], 'chat', 'people', 'below')
assert.deepEqual(emptied, [['people', 'chat'], ['stage'], ['settings']])

// Nonsense leaves the arrangement exactly as it was.
assert.deepEqual(placePanel(DEFAULT_COLUMNS, 'chat', 'chat', 'below'), DEFAULT_COLUMNS)
assert.deepEqual(placePanel(DEFAULT_COLUMNS, 'nao-existe', 'chat', 'below'), DEFAULT_COLUMNS)
assert.deepEqual(placePanel(DEFAULT_COLUMNS, 'chat', 'nao-existe', 'below'), DEFAULT_COLUMNS)

// --- what is remembered ---------------------------------------------------
const storage = fakeStorage()
let changes = 0
const layout = createPanelLayout({ storage, onChange: () => { changes += 1 } })
assert.deepEqual(layout.columns, DEFAULT_COLUMNS)
assert.equal(layout.customised, false)

assert.equal(layout.place('chat', 'people', 'below'), true)
assert.deepEqual(layout.columns, [['people', 'chat'], ['stage'], ['settings']])
assert.equal(layout.customised, true)
assert.equal(layout.place('chat', 'chat', 'below'), false, 'a move that changes nothing is not a change')

// Only the panel at the top of a column carries that column's width, so it is the only one that may be
// dragged sideways.
assert.equal(layout.leads('people'), true)
assert.equal(layout.leads('chat'), false, 'the one underneath stretches to the column instead')
assert.equal(layout.leads('stage'), true)

assert.equal(layout.resize('chat', { height: 320 }), true)
assert.deepEqual(layout.sizeOf('chat'), { height: 320 })
// A height and a width arrive from different observers, so setting one must not forget the other.
assert.equal(layout.resize('chat', { width: 400 }), true)
assert.deepEqual(layout.sizeOf('chat'), { height: 320, width: 400 })
// The same size again is not a change: the observer fires constantly while a panel is being dragged,
// and writing storage and redrawing on every pixel of that would be the whole cost of the feature.
const before = changes
assert.equal(layout.resize('chat', { width: 400 }), false)
assert.equal(layout.resize('chat', { width: 400.4 }), false, 'rounding to the same pixel is the same size')
assert.equal(changes, before)

// It survives the session, clamped again on the way back in.
const reopened = createPanelLayout({ storage })
assert.deepEqual(reopened.columns, [['people', 'chat'], ['stage'], ['settings']])
assert.deepEqual(reopened.sizeOf('chat'), { height: 320, width: 400 })

// --- an arrangement from the version that had only one row ----------------
// It stored an order; each panel simply becomes its own column, which is what that row was.
const older = createPanelLayout({ storage: fakeStorage({ [KEY]: '{"order":["chat","stage","people","settings"],"sizes":{"chat":{"width":380}}}' }) })
assert.deepEqual(older.columns, [['chat'], ['stage'], ['people'], ['settings']])
assert.deepEqual(older.sizeOf('chat'), { width: 380 }, 'and the sizes carry over')

// --- one way back ---------------------------------------------------------
reopened.reset()
assert.deepEqual(reopened.columns, DEFAULT_COLUMNS)
assert.deepEqual(reopened.sizeOf('chat'), {})
assert.equal(reopened.customised, false)
assert.deepEqual(createPanelLayout({ storage }).columns, DEFAULT_COLUMNS, 'and the reset is remembered too')

// --- a stored value that has gone bad -------------------------------------
for (const broken of ['nao e json', '[]', 'null', '{"columns":"chat"}', '{"columns":[[]]}', '{"sizes":{"chat":{"width":"enorme"}}}', '{"sizes":null}']) {
  const recovered = createPanelLayout({ storage: fakeStorage({ [KEY]: broken }) })
  assert.deepEqual(recovered.columns, DEFAULT_COLUMNS, `${broken} must not scramble the arrangement`)
  assert.deepEqual(recovered.sizeOf('chat'), {}, `${broken} must not produce a size`)
}
const huge = createPanelLayout({ storage: fakeStorage({ [KEY]: '{"sizes":{"chat":{"width":5000}}}' }) })
assert.equal(huge.sizeOf('chat').width, PANEL_LIMITS.chat.maxWidth)

// A browser that refuses storage must not take the room down with it.
const noStorage = createPanelLayout({ storage: null })
assert.doesNotThrow(() => { noStorage.resize('chat', { width: 300 }); noStorage.place('chat', 'people', 'below') })
assert.deepEqual(noStorage.columns, [['people', 'chat'], ['stage'], ['settings']], 'it still works for this session')

// --- the rule has to actually reach an element ---------------------------
// A resize rule written for a class the JSX never emits is a rule that does nothing, and nothing about
// it looks wrong: the CSS is valid, the selector is spelled correctly, and the panel simply refuses to
// be dragged downwards. That is exactly how `.panel.resizable` sat dead until somebody tried to resize
// a panel and could not. So the two halves are checked against each other.
const source = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
for (const name of ['panel', 'resizable']) {
  assert.ok(source.includes(`panel ${name === 'panel' ? '' : name}`.trim()), `App.jsx must emit the ${name} class`)
}
assert.ok(/className: `panel resizable /.test(source), 'every panel is built with the class its resize rule needs')
assert.ok(/\.panel\.resizable\{[^}]*resize:vertical/.test(css), 'and that class is what carries the vertical resize')
// The picture panel has to be able to scroll, or a stretched live sits outside it with its own grip
// out of reach and no way back.
assert.ok(/\.panel\.stage\{[^}]*display:flex/.test(css), 'the stage panel is a column')
assert.ok(/\.panel\.stage \.screens-grid\{[^}]*overflow-y:auto[^}]*min-height:0/.test(css), 'so its grid scrolls instead of overflowing')

console.log('PASS: panels stack into columns and split back out, a drop reads as above, below or to either side, an emptied column disappears, sizes are clamped and merged rather than overwritten, an arrangement from the one-row version is carried over, a damaged one is repaired, and a reset is remembered; and the resize rules reach a class the app actually emits.')

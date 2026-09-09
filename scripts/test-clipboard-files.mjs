// What a paste is allowed to turn into. Pasting a screenshot straight into the conversation is the
// point, so the interesting cases are the ones that must not become an upload: plain text, an empty
// clipboard, and the drag of a file with no bytes in it.
import assert from 'node:assert/strict'
import { clipboardFiles } from '../src/clipboardFiles.js'

// Real File objects, because the code wraps what it is handed in a new one to rename it -- and a plain
// object would be stringified into fifteen bytes of "[object Object]" instead, which the first attempt
// at this test discovered.
const asFile = (name, type, size = 10) => new File([new Uint8Array(size)], name, { type })
const item = (file, kind = 'file') => ({ kind, getAsFile: () => file })
const momento = new Date(2026, 8, 9, 14, 5, 7)

// --- nothing to upload ------------------------------------------------------
assert.deepEqual(clipboardFiles(null), [], 'no clipboard at all')
assert.deepEqual(clipboardFiles({}), [], 'an empty one')
assert.deepEqual(clipboardFiles({ items: [{ kind: 'string', getAsFile: () => null }] }), [], 'pasted text stays text')
assert.deepEqual(clipboardFiles({ items: [item(null)] }), [], 'an item that yields no file')
assert.deepEqual(clipboardFiles({ items: [item(asFile('vazio.png', 'image/png', 0))] }), [], 'a file with no bytes is not a file')
assert.deepEqual(clipboardFiles({ files: [asFile('vazio.png', 'image/png', 0)] }), [], 'and neither is an empty one from the explorer')

// --- a file copied from the explorer keeps its own name ----------------------
const doExplorador = asFile('férias.jpg', 'image/jpeg')
assert.deepEqual(clipboardFiles({ files: [doExplorador] }, momento), [doExplorador], 'it already has a name, so it keeps it')

// --- a screenshot has no name, so it is given one ---------------------------
// Chromium calls every pasted screenshot "image.png". Keeping that would put a conversation full of
// files that are all called the same thing into the room's permanent list.
const colado = clipboardFiles({ items: [item(asFile('image.png', 'image/png', 4096))] }, momento)
assert.equal(colado.length, 1)
assert.equal(colado[0].name, 'colado-20260909140507.png', 'named for the moment it was pasted')
assert.equal(colado[0].type, 'image/png')
assert.equal(colado[0].size, 4096, 'and the bytes are carried across, not just the name')
// The date is padded, or a paste in the first minutes of the day sorts before one from the night before.
const cedo = clipboardFiles({ items: [item(asFile('image.png', 'image/png', 1))] }, new Date(2026, 0, 2, 3, 4, 5))
assert.equal(cedo[0].name, 'colado-20260102030405.png')

for (const [type, extension] of [['image/jpeg', 'jpg'], ['image/gif', 'gif'], ['image/webp', 'webp']]) {
  const [file] = clipboardFiles({ items: [item(asFile('image.png', type, 9))] }, momento)
  assert.ok(file.name.endsWith(`.${extension}`), `${type} becomes .${extension}`)
}
// Something unrecognised still gets a usable name rather than one with a slash or a space in it.
const estranho = clipboardFiles({ items: [item(asFile('image.png', 'application/x-coisa estranha/', 9))] }, momento)
assert.match(estranho[0].name, /^colado-\d{14}\.[a-z0-9]+$/i, 'no separators, nothing a path could be built from')
const semTipo = clipboardFiles({ items: [item(asFile('image.png', '', 9))] }, momento)
assert.match(semTipo[0].name, /^colado-\d{14}\.bin$/)

// --- a real name from the clipboard survives --------------------------------
// Some tools do put one there, and inventing over it would lose what somebody chose.
const nomeado = clipboardFiles({ items: [item(asFile('diagrama.png', 'image/png'))] }, momento)
assert.equal(nomeado[0].name, 'diagrama.png')

// --- one paste, one upload --------------------------------------------------
// Chromium fills both lists for the same paste; taking both would upload the same image twice.
const ambos = clipboardFiles({ files: [asFile('uma.png', 'image/png')], items: [item(asFile('uma.png', 'image/png'))] }, momento)
assert.equal(ambos.length, 1, 'one paste, one upload')

// And this is what a real pasted screenshot looks like: both lists filled, both called image.png. The
// first version of this preferred the `files` list and so never renamed anything a browser actually
// pastes -- which the unit test missed and pasting into the real page did not.
const capturaReal = clipboardFiles({
  files: [asFile('image.png', 'image/png', 4096)],
  items: [item(asFile('image.png', 'image/png', 4096))],
}, momento)
assert.equal(capturaReal.length, 1)
assert.equal(capturaReal[0].name, 'colado-20260909140507.png', 'renamed wherever it came from')
assert.equal(capturaReal[0].size, 4096)
// Some tools paste with no name at all rather than the generic one.
assert.equal(clipboardFiles({ files: [asFile('', 'image/png')] }, momento)[0].name, 'colado-20260909140507.png')

// --- several at once --------------------------------------------------------
const varios = clipboardFiles({ files: [asFile('a.png', 'image/png'), asFile('b.png', 'image/png')] }, momento)
assert.equal(varios.length, 2, 'copying two files pastes two files')

console.log('PASS: pasted text and empty clipboards produce no upload, a file copied from the explorer keeps its own name, a screenshot with no name is given one from the moment it was pasted with a padded date and an extension from its type, an unrecognised type still yields a name nothing can be built from, a name the clipboard did provide is kept, and a copy that fills both lists uploads once rather than twice.')

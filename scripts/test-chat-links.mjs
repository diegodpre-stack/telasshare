import assert from 'node:assert/strict'
import { safeHref, splitLinks } from '../src/chatLinks.js'

const linksIn = (text) => splitLinks(text).filter((piece) => piece.type === 'link')
const rebuild = (text) => splitLinks(text).map((piece) => piece.value).join('')

// --- what becomes clickable ----------------------------------------------
assert.equal(safeHref('https://exemplo.com/pagina'), 'https://exemplo.com/pagina')
assert.equal(safeHref('http://exemplo.com'), 'http://exemplo.com/')
// Pasted without a scheme, which is how most links arrive. https is assumed rather than http: guessing
// the insecure one on somebody else's behalf is not a guess worth making.
assert.equal(safeHref('www.exemplo.com'), 'https://www.exemplo.com/')

// --- what must never become clickable ------------------------------------
// This is the whole reason the module exists. Each of these is left as text: visible, and inert.
for (const hostile of [
  'javascript:alert(1)',
  'JavaScript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'file:///C:/Windows/System32/calc.exe',
  'ms-msdt:/id',
  'steam://run/730',
  'about:blank',
  'blob:https://exemplo.com/abc',
]) {
  assert.equal(safeHref(hostile), null, `${hostile} must never produce a link`)
  assert.deepEqual(linksIn(`olha isso ${hostile} agora`), [], `${hostile} must not survive the splitter either`)
}
// A scheme with nothing that could be a host is not a link.
assert.equal(safeHref('https://'), null)
assert.equal(safeHref('http://localhost'), null, 'no dot, no host worth opening')
assert.equal(safeHref(''), null)
assert.equal(safeHref(null), null)

// --- splitting ------------------------------------------------------------
// Nothing may be lost: every piece put together again is exactly what was typed.
for (const text of [
  'sem link nenhum',
  'olha https://exemplo.com/a agora',
  'https://um.com e https://dois.com',
  'link no fim: https://exemplo.com',
  'javascript:alert(1) e https://exemplo.com',
  '',
]) assert.equal(rebuild(text), text, `nothing may be dropped from: ${text}`)

const two = splitLinks('veja https://um.com/a e https://dois.com/b hoje')
assert.deepEqual(two.map((piece) => piece.type), ['text', 'link', 'text', 'link', 'text'])
assert.equal(two[1].href, 'https://um.com/a')
assert.equal(two[3].href, 'https://dois.com/b')

// Punctuation that ended the sentence is not part of the address.
assert.equal(linksIn('entra em https://exemplo.com.')[0].href, 'https://exemplo.com/')
assert.equal(linksIn('viu https://exemplo.com/a?')[0].href, 'https://exemplo.com/a')
assert.equal(linksIn('"https://exemplo.com/a"')[0].value, 'https://exemplo.com/a')
// But a bracket the address really contains is kept.
assert.equal(linksIn('https://pt.wikipedia.org/wiki/Teste_(desambiguacao)')[0].href, 'https://pt.wikipedia.org/wiki/Teste_(desambiguacao)')
assert.equal(linksIn('(veja https://exemplo.com/a)')[0].href, 'https://exemplo.com/a')

// --- markup can never come back -------------------------------------------
// The splitter hands back text and addresses, never markup, so a message cannot introduce HTML no
// matter what is in it. The interface builds elements from these pieces and React escapes the text.
const injected = splitLinks('<img src=x onerror=alert(1)> https://exemplo.com/<script>')
assert.ok(injected.every((piece) => typeof piece.value === 'string'))
assert.ok(injected.filter((piece) => piece.type === 'link').every((piece) => piece.href.startsWith('https://')))
assert.ok(!('html' in injected[0]), 'there is no way to hand back markup')

// A link inside an attribute-looking string is still just a link, and the quote is not part of it.
assert.equal(linksIn('onerror="https://mau.com"')[0].href, 'https://mau.com/')

console.log('PASS: http, https and bare www become links; javascript, data, file, blob and every other scheme stay inert text; nothing typed is ever dropped; trailing punctuation is trimmed without eating brackets that belong to the address.')

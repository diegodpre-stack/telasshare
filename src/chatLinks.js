// Turning what someone typed into clickable links.
//
// This is the one place in the app where text written by another person becomes something you can click,
// which makes it the one place worth being paranoid about. Two rules hold the line:
//
// The result is a list of plain pieces, never HTML. The interface builds React elements from it, so the
// text is escaped by React exactly as it always was and a message can never introduce markup.
//
// A link is only produced for http and https. Everything else -- javascript:, data:, file:, a custom
// protocol some other program registered -- is left as ordinary text, so it is readable and inert.
const SCHEMES = ['http:', 'https:']
// Matched loosely on purpose, then validated properly below: a regular expression is a bad judge of what
// a URL is, and the URL parser is right there.
//
// The lookbehind is the part that matters. Without it the match can start in the middle of a longer
// token: "blob:https://exemplo.com" produced a working link to the inside of it, and so would
// "javascript:https://...". Both would still have produced a safe https address -- safeHref sees to
// that -- but they misrepresent what somebody typed, which is not a habit to have in the one place
// where another person's text becomes clickable. A link may only begin the message or follow a space
// or an opening bracket or quote.
const CANDIDATE = /(?<![^\s([{<"'])(https?:\/\/[^\s<>]+|www\.[^\s<>]+)/gi
// A link at the end of a sentence collects the punctuation that ended it. Brackets are only trimmed when
// they are unbalanced, so a URL that legitimately contains them survives.
const TRAILING = /[.,;:!?'"]+$/

const trimTrailing = (value) => {
  let text = value.replace(TRAILING, '')
  while (text.endsWith(')') && (text.match(/\(/g) || []).length < (text.match(/\)/g) || []).length) text = text.slice(0, -1)
  while (text.endsWith(']') && (text.match(/\[/g) || []).length < (text.match(/\]/g) || []).length) text = text.slice(0, -1)
  return text.replace(TRAILING, '')
}

// The address a click will actually go to, or null when there is no safe one. Anything returning null is
// rendered as text, which is the failure everybody wants: visible, and doing nothing.
export function safeHref(value) {
  const text = String(value || '').trim()
  if (!text) return null
  // Written without a scheme, which is how most people paste a link. It is assumed to be https rather
  // than http: guessing the insecure one on someone's behalf is not a guess worth making.
  const candidate = /^www\./i.test(text) ? `https://${text}` : text
  let url
  try { url = new URL(candidate) } catch { return null }
  if (!SCHEMES.includes(url.protocol)) return null
  // A hostname is what separates a link from a scheme with something after it.
  if (!url.hostname || !url.hostname.includes('.')) return null
  return url.href
}

// Splits a message into pieces to render. Every piece is either text to print or a link to make
// clickable; the caller never has to decide which, and never sees markup either way.
export function splitLinks(text) {
  const value = String(text || '')
  const pieces = []
  let index = 0
  for (const match of value.matchAll(CANDIDATE)) {
    const raw = trimTrailing(match[0])
    const href = safeHref(raw)
    // No safe address: leave the whole match where it is, as text. Skipping it would silently delete
    // part of what somebody wrote.
    if (!href) continue
    if (match.index > index) pieces.push({ type: 'text', value: value.slice(index, match.index) })
    pieces.push({ type: 'link', value: raw, href })
    index = match.index + raw.length
  }
  if (index < value.length) pieces.push({ type: 'text', value: value.slice(index) })
  return pieces
}

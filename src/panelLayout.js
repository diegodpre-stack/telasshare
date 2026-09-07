// Where the panels are and how big they are, remembered between sessions.
//
// Four panels can be open at once and they were laid out by a fixed grid, which meant the only person
// the arrangement suited was whoever picked the numbers. This keeps the arrangement itself: the width
// and height each panel was dragged to, and the order they were dragged into.
//
// Every stored value is clamped on the way back in rather than trusted. A panel restored at four pixels
// wide, or at a width from a much larger monitor, is worse than one restored at its default -- it looks
// like the app is broken and there is nothing on screen to explain it.
export const PANELS = ['people', 'stage', 'chat', 'settings']

// The stage has no stored width: it takes whatever is left, so the others are set relative to the
// picture rather than the picture being squeezed by arithmetic nobody can see.
export const PANEL_LIMITS = {
  people: { minWidth: 200, maxWidth: 620, minHeight: 200, maxHeight: 1400 },
  stage: { minHeight: 240, maxHeight: 2000 },
  chat: { minWidth: 220, maxWidth: 680, minHeight: 200, maxHeight: 1400 },
  settings: { minWidth: 220, maxWidth: 680, minHeight: 200, maxHeight: 1600 },
}

const STORAGE_KEY = 'telasshare-layout'

const clamp = (value, low, high) => {
  const number = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(number) || low === undefined) return null
  return Math.round(Math.min(high, Math.max(low, number)))
}

export function clampSize(id, size) {
  const limits = PANEL_LIMITS[id]
  if (!limits || !size || typeof size !== 'object') return {}
  const result = {}
  const width = clamp(size.width, limits.minWidth, limits.maxWidth)
  const height = clamp(size.height, limits.minHeight, limits.maxHeight)
  if (width !== null) result.width = width
  if (height !== null) result.height = height
  return result
}

// A stored order is only usable if it is still a permutation of the panels that exist. Anything else --
// a panel removed by a later version, a duplicate, junk -- is repaired rather than rejected, so a bad
// value costs the arrangement and never the app.
export function normalizeOrder(value) {
  const seen = []
  for (const id of Array.isArray(value) ? value : []) {
    if (PANELS.includes(id) && !seen.includes(id)) seen.push(id)
  }
  for (const id of PANELS) if (!seen.includes(id)) seen.push(id)
  return seen
}

// Moves one panel to sit where another one is. Dropping a panel on itself, or on something that is not
// a panel, leaves the order exactly as it was rather than throwing.
export function movePanel(order, id, beforeId) {
  const current = normalizeOrder(order)
  if (!PANELS.includes(id) || id === beforeId) return current
  const without = current.filter((panel) => panel !== id)
  const at = without.indexOf(beforeId)
  if (at === -1) return [...without, id]
  return [...without.slice(0, at), id, ...without.slice(at)]
}

function readStored(storage) {
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { order: normalizeOrder([]), sizes: {} }
    const sizes = {}
    for (const id of PANELS) {
      const size = clampSize(id, parsed.sizes?.[id])
      if (Object.keys(size).length) sizes[id] = size
    }
    return { order: normalizeOrder(parsed.order), sizes }
  } catch { return { order: normalizeOrder([]), sizes: {} } }
}

export function createPanelLayout({
  storage = typeof localStorage === 'undefined' ? null : localStorage,
  onChange,
} = {}) {
  let { order, sizes } = readStored(storage)

  const save = () => {
    try { storage?.setItem(STORAGE_KEY, JSON.stringify({ order, sizes })) } catch { /* a private store is not worth failing over */ }
  }
  const announce = () => onChange?.()

  return {
    get order() { return [...order] },
    // Where a panel sits among the ones actually on screen, which is what a flex order needs.
    indexOf: (id) => order.indexOf(id),
    sizeOf: (id) => ({ ...(sizes[id] || {}) }),

    resize(id, size) {
      const next = clampSize(id, size)
      const before = sizes[id] || {}
      if (next.width === before.width && next.height === before.height) return false
      if (!Object.keys(next).length) return false
      sizes[id] = next
      save()
      announce()
      return true
    },

    move(id, beforeId) {
      const next = movePanel(order, id, beforeId)
      if (next.join() === order.join()) return false
      order = next
      save()
      announce()
      return true
    },

    // One way back for somebody who has dragged themselves into a corner. Without it the only cure for
    // a layout gone wrong is knowing which key to clear in a browser's developer tools.
    reset() {
      order = normalizeOrder([])
      sizes = {}
      save()
      announce()
    },

    get customised() { return Object.keys(sizes).length > 0 || order.join() !== PANELS.join() },
  }
}

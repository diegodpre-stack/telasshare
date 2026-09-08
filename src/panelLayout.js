// Where the panels are and how big they are, remembered between sessions.
//
// The arrangement is a list of columns, each column a stack of panels. A single row could only ever put
// things side by side, so a narrow panel next to a tall one wasted the whole height beside it -- the
// conversation belongs under the friends list, not beside it.
//
// Every stored value is clamped on the way back in rather than trusted. A panel restored at four pixels
// wide, or at a width from a much larger monitor, is worse than one restored at its default: it looks
// like the app is broken and there is nothing on screen to explain it.
export const PANELS = ['people', 'stage', 'chat', 'files', 'settings']

// A column is as wide as the panel at the top of it, and each panel keeps its own height. So the width
// stored against a panel only means anything while that panel leads a column, which is also the only
// time it can be dragged.
export const PANEL_LIMITS = {
  people: { minWidth: 200, maxWidth: 900, minHeight: 160, maxHeight: 1600 },
  stage: { minWidth: 320, maxWidth: 2400, minHeight: 200, maxHeight: 2000 },
  chat: { minWidth: 220, maxWidth: 900, minHeight: 160, maxHeight: 1600 },
  files: { minWidth: 240, maxWidth: 900, minHeight: 160, maxHeight: 1600 },
  settings: { minWidth: 220, maxWidth: 900, minHeight: 160, maxHeight: 1800 },
}

const STORAGE_KEY = 'telasshare-layout'
export const DEFAULT_COLUMNS = [['people'], ['stage'], ['chat', 'files'], ['settings']]

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

// Anything unusable is repaired rather than rejected: a panel added by a later version, a duplicate, an
// empty column, junk. A bad value costs the arrangement and never the app.
export function normalizeColumns(value) {
  const columns = []
  const seen = new Set()
  for (const column of Array.isArray(value) ? value : []) {
    const kept = []
    for (const id of Array.isArray(column) ? column : []) {
      if (PANELS.includes(id) && !seen.has(id)) { seen.add(id); kept.push(id) }
    }
    if (kept.length) columns.push(kept)
  }
  // Nothing usable in there at all -- junk, or a store that has never been written -- means the default,
  // not one column per panel. The two used to be the same arrangement, so this was never exercised; the
  // moment the default stacked two panels together they parted company.
  if (!columns.length) return DEFAULT_COLUMNS.map((column) => [...column])
  // Whatever the stored arrangement never mentioned gets a column of its own at the end, which is where
  // a panel this version added would want to be anyway.
  for (const id of PANELS) if (!seen.has(id)) columns.push([id])
  return columns
}

// Which half or edge of a panel the pointer is over, and so what dropping there should mean. The sides
// are narrow because they are the unusual intention: most drops are meant to stack.
export const EDGE_FRACTION = 0.22
export function dropRegion(rect, x, y) {
  if (!rect || !rect.width || !rect.height) return 'below'
  const across = (x - rect.left) / rect.width
  const down = (y - rect.top) / rect.height
  if (across < EDGE_FRACTION) return 'left'
  if (across > 1 - EDGE_FRACTION) return 'right'
  return down < 0.5 ? 'above' : 'below'
}

// Moves one panel next to another: into its column above or below it, or into a new column of its own
// on either side. Dropping a panel on itself, or on something that is not a panel, leaves the
// arrangement exactly as it was rather than throwing.
export function placePanel(columns, id, targetId, where) {
  const current = normalizeColumns(columns)
  if (!PANELS.includes(id) || !PANELS.includes(targetId) || id === targetId) return current
  const stripped = current.map((column) => column.filter((panel) => panel !== id)).filter((column) => column.length)
  const columnIndex = stripped.findIndex((column) => column.includes(targetId))
  if (columnIndex === -1) return current
  if (where === 'left' || where === 'right') {
    const at = where === 'left' ? columnIndex : columnIndex + 1
    return [...stripped.slice(0, at), [id], ...stripped.slice(at)]
  }
  const column = stripped[columnIndex]
  const at = column.indexOf(targetId) + (where === 'below' ? 1 : 0)
  const rebuilt = [...column.slice(0, at), id, ...column.slice(at)]
  return stripped.map((existing, index) => (index === columnIndex ? rebuilt : existing))
}

function readStored(storage) {
  const empty = { columns: normalizeColumns(null), sizes: {} }
  try {
    const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty
    const sizes = {}
    for (const id of PANELS) {
      const size = clampSize(id, parsed.sizes?.[id])
      if (Object.keys(size).length) sizes[id] = size
    }
    // An arrangement saved by the version that only had one row: each panel becomes its own column,
    // which is exactly what that row was.
    const columns = Array.isArray(parsed.columns) ? parsed.columns
      : Array.isArray(parsed.order) ? parsed.order.map((id) => [id])
        : null
    return { columns: normalizeColumns(columns), sizes }
  } catch { return empty }
}

export function createPanelLayout({
  storage = typeof localStorage === 'undefined' ? null : localStorage,
  onChange,
} = {}) {
  let { columns, sizes } = readStored(storage)

  const save = () => {
    try { storage?.setItem(STORAGE_KEY, JSON.stringify({ columns, sizes })) } catch { /* a private store is not worth failing over */ }
  }
  const announce = () => onChange?.()

  return {
    get columns() { return columns.map((column) => [...column]) },
    sizeOf: (id) => ({ ...(sizes[id] || {}) }),
    // Only the panel leading a column carries the column's width, so it is the only one that may be
    // dragged sideways. The rest set their own height and stretch to the column.
    leads: (id) => columns.some((column) => column[0] === id),

    resize(id, size) {
      const next = clampSize(id, size)
      if (!Object.keys(next).length) return false
      const before = sizes[id] || {}
      // Compared after merging, not before. A width and a height arrive from two different observers, so
      // one of them is always absent from `next` -- comparing that absence against a stored value made
      // every width report look like a change and wrote to storage on every pixel of a drag.
      const merged = { ...before, ...next }
      if (merged.width === before.width && merged.height === before.height) return false
      sizes[id] = merged
      save()
      announce()
      return true
    },

    place(id, targetId, where) {
      const next = placePanel(columns, id, targetId, where)
      if (JSON.stringify(next) === JSON.stringify(columns)) return false
      columns = next
      save()
      announce()
      return true
    },

    // One way back for somebody who has dragged themselves into a corner. Without it the only cure for
    // an arrangement gone wrong is knowing which key to clear in a browser's developer tools.
    reset() {
      columns = normalizeColumns(null)
      sizes = {}
      save()
      announce()
    },

    get customised() {
      return Object.keys(sizes).length > 0 || JSON.stringify(columns) !== JSON.stringify(DEFAULT_COLUMNS)
    },
  }
}

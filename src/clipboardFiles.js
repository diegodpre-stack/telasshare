// What a paste actually contains, which is not a file in the sense the upload button means.
//
// An image copied from a screenshot tool arrives as bytes and a MIME type and nothing else: no name, no
// path. So a name is made here, from the date, because both the conversation and the file list show one
// and "image.png" for every screenshot anybody ever pastes is not a name.
const CLIPBOARD_EXTENSIONS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
// What Chromium calls a pasted screenshot. It fills both lists when you paste one, so taking whichever
// list came first was not enough: the name has to be judged on its own, wherever the file came from.
const NAMELESS = ['image.png', 'image', '']

export function clipboardFiles(clipboard, agora = new Date()) {
  if (!clipboard) return []
  const stamp = [agora.getFullYear(), agora.getMonth() + 1, agora.getDate(), agora.getHours(), agora.getMinutes(), agora.getSeconds()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0')).join('')

  // `files` is what a copy from the file manager fills; `items` is what a pasted screenshot fills. A
  // paste often fills both with the same thing, so one is taken and the other ignored.
  const found = []
  for (const file of clipboard.files || []) if (file && file.size) found.push(file)
  if (!found.length) {
    for (const item of clipboard.items || []) {
      if (item.kind !== 'file') continue
      const file = item.getAsFile?.()
      if (file && file.size) found.push(file)
    }
  }

  // A screenshot has no name of its own, and a room whose file list is twenty entries all called
  // image.png is a list nobody can use. A name somebody actually chose is left alone.
  return found.map((file) => {
    if (!NAMELESS.includes(file.name || '')) return file
    const extension = CLIPBOARD_EXTENSIONS[file.type] || (String(file.type).split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '') || 'bin'
    return new File([file], `colado-${stamp}.${extension}`, { type: file.type })
  })
}

// Files on disk, and the rules about what may be done with them.
//
// Two things here are worth more than the rest of the file. The first is that the bytes are written as
// they arrive and the size is checked while they arrive: a caller that promises 1 MB and sends 10 GB
// would otherwise fill the disk before anybody looked. The second is that the type is read from the
// bytes and never from what the sender claimed, because the sender's claim is exactly what an attacker
// controls.
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import crypto from 'node:crypto'

// Big enough for a photo or a short clip, small enough that one upload cannot be a denial of service.
export const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES) || 25 * 1024 * 1024
// A room's share of the disk. Without it the first person to discover video takes the space of every
// other room.
export const MAX_ROOM_BYTES = Number(process.env.MAX_ROOM_BYTES) || 5 * 1024 * 1024 * 1024

// What the first bytes of a file say it is. Only formats that are safe to hand a browser to render are
// listed as inline; everything else is still accepted, just never displayed by the browser itself.
//
// SVG is deliberately absent. It is an image by every ordinary definition and it can contain script, so
// rendering one from this origin would run that script with the app's cookies and storage. It uploads
// and downloads like any other file; it simply never renders in place.
const SIGNATURES = [
  { kind: 'image/jpeg', inline: true, magic: [0xff, 0xd8, 0xff] },
  { kind: 'image/png', inline: true, magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { kind: 'image/gif', inline: true, magic: [0x47, 0x49, 0x46, 0x38] },
  { kind: 'image/webp', inline: true, magic: [0x52, 0x49, 0x46, 0x46], also: { at: 8, magic: [0x57, 0x45, 0x42, 0x50] } },
  { kind: 'video/mp4', inline: true, magic: [0x66, 0x74, 0x79, 0x70], at: 4 },
  { kind: 'video/webm', inline: true, magic: [0x1a, 0x45, 0xdf, 0xa3] },
  { kind: 'audio/ogg', inline: true, magic: [0x4f, 0x67, 0x67, 0x53] },
  { kind: 'audio/mpeg', inline: true, magic: [0x49, 0x44, 0x33] },
  { kind: 'audio/wav', inline: true, magic: [0x52, 0x49, 0x46, 0x46], also: { at: 8, magic: [0x57, 0x41, 0x56, 0x45] } },
  { kind: 'application/pdf', inline: false, magic: [0x25, 0x50, 0x44, 0x46] },
  { kind: 'application/zip', inline: false, magic: [0x50, 0x4b, 0x03, 0x04] },
]

const matches = (head, magic, at = 0) => magic.every((byte, index) => head[at + index] === byte)

// Anything unrecognised is a file like any other -- accepted, stored, downloadable -- and simply never
// rendered. Refusing unknown types would turn "send a file" into "send a file from my list".
export function sniff(head) {
  for (const signature of SIGNATURES) {
    if (!matches(head, signature.magic, signature.at ?? 0)) continue
    if (signature.also && !matches(head, signature.also.magic, signature.also.at)) continue
    return { kind: signature.kind, inline: signature.inline }
  }
  return { kind: 'application/octet-stream', inline: false }
}

// The name is only ever shown, never used to build a path: it arrives from outside and a path built
// from it is a directory traversal waiting to happen. Everything that could steer a filesystem is
// removed, and what is left is a label.
export function safeName(value) {
  // Control characters go first: a newline in a name ends up in a header, and a header with a
  // newline in it is two headers. Compared by code point rather than matched by a pattern, because
  // a range of control characters written into a pattern is a thing every layer between here and
  // the file wants to mangle.
  const printable = [...String(value ?? '')]
    .filter((character) => character.codePointAt(0) > 31 && character.codePointAt(0) !== 127)
    .join('')
  // Separators are what turn a name into a direction, and a leading run of dots is how ".." gets in.
  const flattened = printable.split('/').join('_').split(String.fromCharCode(92)).join('_').trim()
  const cleaned = flattened.replace(/^[.]+/, '').slice(-120)
  return cleaned || 'arquivo'
}

export function createFileStorage({ root = process.env.FILES_DIR || 'data/files' } = {}) {
  const base = resolve(root)
  // Built from identifiers this server generated, never from anything a caller sent, and checked anyway:
  // a path that escapes the base is a bug worth failing on rather than following.
  const pathFor = (roomId, fileId) => {
    const full = resolve(join(base, roomId, fileId))
    if (!full.startsWith(base + sep)) throw new Error('refusing a path outside the store')
    return full
  }

  return {
    pathFor,

    // Reads the request as it arrives. The size is enforced against the bytes themselves rather than
    // against a header, because a header is a claim and the bytes are the fact.
    async receive({ roomId, stream, limit = MAX_FILE_BYTES, remainingQuota = Infinity }) {
      const id = crypto.randomUUID()
      const destination = pathFor(roomId, id)
      const temporary = `${destination}.part`
      await mkdir(dirname(destination), { recursive: true })

      const hash = crypto.createHash('sha256')
      let bytes = 0
      let head = Buffer.alloc(0)
      let refusal = null

      const counting = async function* () {
        for await (const chunk of stream) {
          bytes += chunk.length
          if (bytes > limit) { refusal = 'too-large'; break }
          if (bytes > remainingQuota) { refusal = 'room-full'; break }
          if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)])
          hash.update(chunk)
          yield chunk
        }
      }

      try {
        await pipeline(counting, createWriteStream(temporary))
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
      // A refusal has to take the half-written file with it, or a rejected upload still costs the disk.
      if (refusal) { await rm(temporary, { force: true }); return { ok: false, reason: refusal } }
      if (!bytes) { await rm(temporary, { force: true }); return { ok: false, reason: 'empty' } }

      await rename(temporary, destination)
      return { ok: true, id, bytes, sha256: hash.digest('hex'), ...sniff(head) }
    },

    // One file rather than a whole room. `force` because the row and the bytes are two separate things
    // and either can already be gone: failing because the file was not there would leave a row nobody
    // can act on, which is the worse of the two states.
    async remove(roomId, fileId) {
      await rm(pathFor(roomId, fileId), { force: true })
    },

    // A room's whole folder, for when the room itself goes. The database forgets the rows in one
    // operation; the disk is the part that needs telling.
    async removeRoom(roomId) {
      await rm(resolve(join(base, roomId)), { recursive: true, force: true })
    },

    async size(roomId, fileId) {
      try { return (await stat(pathFor(roomId, fileId))).size } catch { return null }
    },
  }
}

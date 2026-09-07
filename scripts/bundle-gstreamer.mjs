// Copies a GStreamer runtime into native/gstreamer so the installer can carry it and nobody has to
// install anything separately. Run before electron-builder; the folder is gitignored and rebuilt in CI.
//
// Everything is copied rather than a hand-picked list. Working that list out means following the
// dependency chain of thirteen elements through 271 plugins, and getting it wrong does not raise an
// error -- the plugin silently fails to load, the element is "not found", and native capture quietly
// disappears. Half the failures in this project have been of that shape. Disk is cheaper than that.
import { cp, mkdir, rm, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const target = path.join(projectRoot, 'native', 'gstreamer')

const sources = [
  process.env.ENTRETELAS_GSTREAMER_DIR && path.dirname(process.env.ENTRETELAS_GSTREAMER_DIR),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'gstreamer', '1.0', 'msvc_x86_64'),
  process.env.GSTREAMER_1_0_ROOT_MSVC_X86_64,
  'C:\\gstreamer\\1.0\\msvc_x86_64',
].filter(Boolean)

const megabytes = async (dir) => {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    total += entry.isDirectory() ? (await megabytes(full)) : (await stat(full)).size
  }
  return total
}

const source = sources.find((dir) => existsSync(path.join(dir, 'bin', 'gst-launch-1.0.exe')))
if (!source) {
  console.error('No GStreamer runtime found. Looked in:')
  for (const dir of sources) console.error(`  ${dir}`)
  process.exit(1)
}

await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })

// gst-launch runs the pipeline and gst-inspect answers whether per-process audio loopback exists on
// this machine; the rest of the executables are development tools with no place in a broadcast app.
await mkdir(path.join(target, 'bin'), { recursive: true })
for (const tool of ['gst-launch-1.0.exe', 'gst-inspect-1.0.exe']) {
  await cp(path.join(source, 'bin', tool), path.join(target, 'bin', tool))
}
// Every DLL beside them: these are the libraries the plugins link against, and a missing one is a
// silent failure rather than a loud one.
for (const entry of await readdir(path.join(source, 'bin'), { withFileTypes: true })) {
  if (entry.isFile() && entry.name.toLowerCase().endsWith('.dll')) {
    await cp(path.join(source, 'bin', entry.name), path.join(target, 'bin', entry.name))
  }
}
// Only the plugins themselves. The same folder holds the static libraries used to build against
// GStreamer -- 750 MB of them, against 121 MB of actual plugins -- plus headers and pkgconfig files,
// none of which a running pipeline ever opens.
const pluginsFrom = path.join(source, 'lib', 'gstreamer-1.0')
const pluginsTo = path.join(target, 'lib', 'gstreamer-1.0')
await mkdir(pluginsTo, { recursive: true })
for (const entry of await readdir(pluginsFrom, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.toLowerCase().endsWith('.dll')) {
    await cp(path.join(pluginsFrom, entry.name), path.join(pluginsTo, entry.name))
  }
}

// A partial install produces a bundle that looks fine and fails on the user's machine, because a missing
// plugin is not an error -- the element is simply "not found" and native capture disappears. So the
// build breaks here instead, where somebody is watching. These are the plugins the pipeline cannot run
// without, plus the encoders for the GPUs other people have.
const required = {
  'gstd3d11.dll': 'screen capture and GPU colour conversion',
  'gstwebrtchttp.dll': 'whipsink',
  'gstwebrtc.dll': 'webrtcbin',
  'gstnice.dll': 'ICE',
  'gstdtls.dll': 'DTLS',
  'gstsrtp.dll': 'SRTP',
  'gstrtp.dll': 'RTP payloaders',
  'gstrtpmanager.dll': 'RTP session handling',
  'gstvideoparsersbad.dll': 'h264parse',
  'gstcoreelements.dll': 'queue and tee',
  'gstopus.dll': 'Opus',
  'gstaudioconvert.dll': 'audio conversion',
  'gstaudioresample.dll': 'audio resampling',
  'gstwasapi2.dll': 'system sound',
  'gstamfcodec.dll': 'AMD encoder',
  'gstnvcodec.dll': 'NVIDIA encoder',
  'gstqsv.dll': 'Intel encoder',
  'gstmediafoundation.dll': 'encoder fallback',
}
const missing = Object.entries(required)
  .filter(([file]) => !existsSync(path.join(target, 'lib', 'gstreamer-1.0', file)))
  .map(([file, purpose]) => `  ${file} (${purpose})`)
if (missing.length) {
  console.error('The bundle is incomplete. Missing:')
  for (const line of missing) console.error(line)
  console.error('\nThe GStreamer install is probably partial; a complete one is needed.')
  process.exit(1)
}

console.log(`GStreamer bundled from ${source}`)
console.log(`  ${(await megabytes(target) / 1024 / 1024).toFixed(0)} MB into native/gstreamer`)
console.log(`  ${Object.keys(required).length} required plugins present`)

// The seam between the native pipeline and the signalling the app already has.
//
// whipsink speaks WHIP -- an SDP offer POSTed over HTTP, an answer in the response -- so the app can be
// the server it posts to. Everything that reaches this bridge is handed straight to the existing
// `signal` messages in server/index.js, which is a pure relay and needs no change at all. Nothing here
// listens on anything but the loopback interface, and the port is assigned by the OS: the bridge exists
// for one local child process, never for the network.
//
// Sessions are keyed from the start because phase 3 fans one encoder out to several viewers, each with
// its own whipsink and its own WHIP session. Handling one at a time now would have to be undone then.
const { createServer } = require('node:http')
const { randomUUID } = require('node:crypto')

// Long enough for a viewer to answer over a slow signalling round trip, short enough that a viewer who
// closed the tab does not leave the pipeline waiting on a promise for the rest of the broadcast.
const ANSWER_TIMEOUT_MS = 30_000
const MAX_BODY_BYTES = 256 * 1024

const readBody = (request) => new Promise((resolve, reject) => {
  const chunks = []
  let size = 0
  request.on('data', (chunk) => {
    size += chunk.length
    if (size > MAX_BODY_BYTES) { reject(new Error('body too large')); request.destroy(); return }
    chunks.push(chunk)
  })
  request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  request.on('error', reject)
})

// A trickle-ice-sdpfrag names the m-section its candidates belong to. Count the m-lines rather than
// trusting a mid to be present, since the viewer needs an index either way.
function parseTrickle(fragment) {
  const candidates = []
  let sdpMLineIndex = -1
  let sdpMid = null
  for (const line of String(fragment).split(/\r?\n/)) {
    if (line.startsWith('m=')) { sdpMLineIndex += 1; sdpMid = null }
    else if (line.startsWith('a=mid:')) sdpMid = line.slice(6).trim()
    else if (line.startsWith('a=candidate:')) {
      candidates.push({ candidate: line.slice(2).trim(), sdpMLineIndex: Math.max(0, sdpMLineIndex), sdpMid })
    }
  }
  return candidates
}

// `transform` is where the constrained-baseline rewrite is applied, kept injectable so the bridge stays
// about transport and the codec reasoning stays in nativeCapture.
function createWhipBridge({ onOffer, onCandidate, onClosed, transform = (sdp) => sdp, timeoutMs = ANSWER_TIMEOUT_MS } = {}) {
  const sessions = new Map()
  let server = null
  let port = null

  const endSession = (id, notify) => {
    const session = sessions.get(id)
    if (!session) return
    clearTimeout(session.timer)
    sessions.delete(id)
    // A pipeline still waiting on its POST must be released, or gst-launch hangs until it is killed.
    session.deliver?.(null)
    if (notify) onClosed?.(id)
  }

  server = createServer(async (request, response) => {
    try {
      const [, root, id] = request.url.split('?')[0].split('/')
      const session = root === 'whip' && id ? sessions.get(id) : null
      if (!session) { response.writeHead(404); return response.end('unknown session') }

      if (request.method === 'POST') {
        const offer = transform(await readBody(request))
        if (!offer.includes('v=0')) { response.writeHead(400); return response.end('not an SDP') }
        onOffer?.(id, offer)
        const answer = await new Promise((resolve) => {
          session.deliver = resolve
          // An unarmed seat waits with no clock at all; arm() starts one when a viewer takes it.
          if (session.armed) session.timer = setTimeout(() => resolve(null), timeoutMs)
        })
        clearTimeout(session.timer)
        session.deliver = null
        if (!answer) { response.writeHead(504); return response.end('no answer') }
        response.writeHead(201, {
          'content-type': 'application/sdp',
          // Absolute: the sender builds its PATCH and DELETE URLs from this header, and a relative one
          // leaves it with nowhere to send them.
          location: `http://127.0.0.1:${port}/whip/${id}`,
          'content-length': Buffer.byteLength(answer),
        })
        return response.end(answer)
      }

      if (request.method === 'PATCH') {
        for (const candidate of parseTrickle(await readBody(request))) onCandidate?.(id, candidate)
        response.writeHead(204)
        return response.end()
      }

      if (request.method === 'DELETE') {
        endSession(id, true)
        response.writeHead(204)
        return response.end()
      }

      response.writeHead(405)
      response.end('method not allowed')
    } catch {
      if (!response.headersSent) response.writeHead(500)
      response.end('error')
    }
  })

  return {
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(port) })
    }),
    get port() { return port },
    // Called before the pipeline starts, so the endpoint can be handed to it on the command line.
    //
    // A seat in a shared pipeline offers as soon as the pipeline runs, long before anyone sits in it, and
    // must wait indefinitely rather than time out on a viewer who has not arrived yet. `armed: false`
    // says so; arm() starts the clock once a viewer is actually expected to answer.
    createSession({ armed = true } = {}) {
      if (port === null) throw new Error('bridge is not listening')
      const id = randomUUID()
      sessions.set(id, { deliver: null, timer: null, armed })
      return { id, endpoint: `http://127.0.0.1:${port}/whip/${id}` }
    },

    // A viewer has been given this seat: from here an answer is owed, and not getting one is a failure
    // rather than an empty chair.
    arm(id) {
      const session = sessions.get(id)
      if (!session || session.armed) return false
      session.armed = true
      if (session.deliver && !session.timer) session.timer = setTimeout(() => session.deliver?.(null), timeoutMs)
      return true
    },
    // The viewer's answer, arriving from the signalling socket. False means nobody was waiting for it --
    // a duplicate, or one that came back after the pipeline gave up.
    provideAnswer(id, sdp) {
      const session = sessions.get(id)
      if (!session?.deliver || typeof sdp !== 'string' || !sdp.includes('v=0')) return false
      session.deliver(sdp)
      return true
    },
    hasSession: (id) => sessions.has(id),
    closeSession: (id) => endSession(id, false),
    close() {
      for (const id of [...sessions.keys()]) endSession(id, false)
      return new Promise((resolve) => (server.listening ? server.close(() => resolve()) : resolve()))
    },
  }
}

module.exports = { createWhipBridge, parseTrickle, ANSWER_TIMEOUT_MS }

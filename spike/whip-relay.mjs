// Phase 1 only: prove a native GStreamer pipeline can put 1440p60 into a plain browser over WebRTC.
// Not part of the app, not shipped, no dependencies -- node:http and nothing else, so it runs from a
// clean checkout. Everything here is single-session and in-memory on purpose: a spike that grows a
// session table starts pretending to be the real thing, and the real thing already has a signalling
// server (server/index.js) that phase 2 will reuse instead of this.
//
// WHIP is one HTTP POST: the sender offers, the server answers. Here the "server" is a relay -- it holds
// GStreamer's POST open until a browser has produced the answer, which is why the browser can be opened
// before or after the pipeline starts.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// 8137 rather than a rounder number because 8099 is already taken on this machine, and a spike that
// silently answers on someone else's port wastes an evening before anyone suspects the port.
const PORT = Number(process.env.PORT || 8137)
const viewerPath = fileURLToPath(new URL('./viewer.html', import.meta.url))

let session = null
let lastStats = null
const resetSession = () => { session?.timer && clearTimeout(session.timer); session = null }

const readBody = (request) => new Promise((resolve, reject) => {
  const chunks = []
  let size = 0
  request.on('data', (chunk) => {
    size += chunk.length
    // An SDP is a few kilobytes; anything past this is not one.
    if (size > 256 * 1024) { reject(new Error('body too large')); request.destroy(); return }
    chunks.push(chunk)
  })
  request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  request.on('error', reject)
})

const json = (response, status, payload) => {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  response.end(body)
}

// A trickle-ice-sdpfrag carries the candidates plus the m-line they belong to. The browser needs the
// index, so track how many m-sections have gone by rather than trusting a mid that may not be present.
const parseTrickle = (fragment) => {
  const candidates = []
  let mLineIndex = -1
  let mid = null
  for (const line of fragment.split(/\r?\n/)) {
    if (line.startsWith('m=')) { mLineIndex += 1; mid = null }
    else if (line.startsWith('a=mid:')) mid = line.slice(6).trim()
    else if (line.startsWith('a=candidate:')) {
      candidates.push({ candidate: line.slice(2).trim(), sdpMLineIndex: Math.max(0, mLineIndex), sdpMid: mid })
    }
  }
  return candidates
}

// Chrome only answers H.264 it recognises as Constrained Baseline: profile_idc 0x42 with the constraint
// bits set, so `42e0<level>`. AMF's SPS comes out as `4204<level>` -- baseline, but without those bits --
// and Chrome rejects the whole m-line, answering with port 0 and gathering no candidates at all.
//
// Rewriting the advertised id is safe for a stream that carries no CABAC and no B-frames, which is what
// the pipeline asks the encoder for: constrained baseline is a subset of what it is already producing,
// and level-asymmetry-allowed=1 means the level in the id does not cap the real stream. This belongs in
// the encoder, not here -- it stays as a spike workaround, and the log says whenever it fires.
const normalizeH264Profile = (sdp) => sdp.replace(/profile-level-id=([0-9a-fA-F]{6})/g, (match, id) => {
  if (!/^42/.test(id) || /^42e0/i.test(id)) return match
  console.log(`[relay] profile-level-id ${id} -> 42e01f (Chrome only accepts constrained baseline)`)
  return 'profile-level-id=42e01f'
})

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`)
  const path = url.pathname

  try {
    // --- the browser side -------------------------------------------------
    if (request.method === 'GET' && (path === '/' || path === '/viewer.html')) {
      const html = await readFile(viewerPath)
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return response.end(html)
    }

    if (request.method === 'GET' && path === '/api/offer') {
      if (!session?.offer || session.answered) return json(response, 200, { offer: null })
      return json(response, 200, { offer: session.offer })
    }

    if (request.method === 'POST' && path === '/api/answer') {
      const { sdp } = JSON.parse(await readBody(request) || '{}')
      if (!session || session.answered) return json(response, 409, { error: 'no offer is waiting' })
      if (typeof sdp !== 'string' || !sdp.includes('v=0')) return json(response, 400, { error: 'not an SDP' })
      session.answered = true
      session.deliver(sdp)
      console.log('[relay] answer delivered to the pipeline')
      return json(response, 200, { ok: true })
    }

    // The viewer's own verdict, so a run can be judged without inspecting the browser that ran it.
    if (request.method === 'POST' && path === '/api/stats') {
      const report = JSON.parse(await readBody(request) || '{}')
      // A tab left open from an earlier run keeps reporting its last frozen numbers forever and would
      // overwrite the live session. Only a report from a connection still carrying video counts.
      if (!report.width || !['connected', 'completed'].includes(report.ice)) {
        return json(response, 200, { ok: true, ignored: true })
      }
      lastStats = report
      const { ice, width, height, fps, decoder, decoded, dropped, rttMs, local, remote } = lastStats
      console.log(`[viewer] ice=${ice} ${width || '?'}x${height || '?'} fps=${fps ?? '-'} decoder=${decoder || '-'} `
        + `decoded=${decoded ?? '-'} dropped=${dropped ?? '-'} rtt=${rttMs ?? '-'}ms pair=${local || '?'}/${remote || '?'}`)
      return json(response, 200, { ok: true })
    }

    if (request.method === 'GET' && path === '/api/stats') return json(response, 200, lastStats || {})

    // Candidates GStreamer trickled after its offer. `from` is how many the browser already applied.
    if (request.method === 'GET' && path === '/api/candidates') {
      const from = Number(url.searchParams.get('from') || 0)
      const all = session?.candidates || []
      return json(response, 200, { candidates: all.slice(Number.isFinite(from) ? from : 0) })
    }

    // --- the WHIP side, spoken by whipclientsink --------------------------
    if (request.method === 'POST' && path === '/whip') {
      const offer = normalizeH264Profile(await readBody(request))
      if (!offer.includes('v=0')) { response.writeHead(400); return response.end('not an SDP') }
      resetSession()
      // Whether the offer already carries candidates decides if trickle matters at all here.
      const inOffer = (offer.match(/^a=candidate:/gm) || []).length
      console.log(`[relay] pipeline offered a stream (${inOffer} candidate(s) in the offer); waiting for a browser`)
      const answer = await new Promise((resolve) => {
        session = {
          offer, candidates: [], answered: false, deliver: resolve,
          // Without this the pipeline would hang forever on a browser that never opened.
          timer: setTimeout(() => { console.log('[relay] nobody answered within 120s'); resolve(null) }, 120_000),
        }
      })
      clearTimeout(session?.timer)
      if (!answer) { response.writeHead(504); return response.end('no viewer answered') }
      // Absolute, because the sender builds its PATCH and DELETE URLs from this header and a relative
      // one leaves it with nowhere to trickle candidates to.
      const location = `http://${request.headers.host || `127.0.0.1:${PORT}`}/whip/session`
      response.writeHead(201, {
        'content-type': 'application/sdp',
        'location': location,
        'content-length': Buffer.byteLength(answer),
      })
      return response.end(answer)
    }

    if (request.method === 'PATCH' && path.startsWith('/whip/')) {
      const fragment = await readBody(request)
      const found = parseTrickle(fragment)
      if (session) session.candidates.push(...found)
      console.log(`[relay] ${found.length} candidate(s) from the pipeline`)
      response.writeHead(204)
      return response.end()
    }

    if (request.method === 'DELETE' && path.startsWith('/whip/')) {
      console.log('[relay] pipeline ended the session')
      resetSession()
      response.writeHead(204)
      return response.end()
    }

    if (request.method === 'OPTIONS') {
      response.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST,PATCH,DELETE,GET', 'access-control-allow-headers': '*' })
      return response.end()
    }

    response.writeHead(404)
    response.end('not found')
  } catch (error) {
    console.error('[relay]', error.message)
    if (!response.headersSent) response.writeHead(500)
    response.end('error')
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[relay] open http://127.0.0.1:${PORT}/ in Chrome, then start the pipeline`)
  console.log(`[relay] WHIP endpoint: http://127.0.0.1:${PORT}/whip`)
})

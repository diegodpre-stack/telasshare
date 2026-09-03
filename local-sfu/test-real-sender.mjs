import { chromium } from '@playwright/test'
import { applySenderSettings } from '../src/senderSettings.js'
import assert from 'node:assert/strict'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage()
  await page.goto('http://localhost:8790')
  const result = await page.evaluate(async (functionSource) => {
    const apply = (0, eval)(`(${functionSource})`)
    const a = new RTCPeerConnection({ iceServers: [] }), b = new RTCPeerConnection({ iceServers: [] })
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360
    const ctx = canvas.getContext('2d'); let counter = 0
    const timer = setInterval(() => { ctx.fillStyle = `hsl(${counter++ % 360} 80% 50%)`; ctx.fillRect(0, 0, 640, 360) }, 33)
    const stream = canvas.captureStream(30), sender = a.addTrack(stream.getVideoTracks()[0], stream)
    const pendingA = [], pendingB = []
    a.onicecandidate = ({ candidate }) => { if (candidate) b.remoteDescription ? b.addIceCandidate(candidate) : pendingB.push(candidate) }
    b.onicecandidate = ({ candidate }) => { if (candidate) a.remoteDescription ? a.addIceCandidate(candidate) : pendingA.push(candidate) }
    try {
      await a.setLocalDescription(await a.createOffer()); await b.setRemoteDescription(a.localDescription)
      for (const c of pendingB) await b.addIceCandidate(c)
      await b.setLocalDescription(await b.createAnswer()); await a.setRemoteDescription(b.localDescription)
      for (const c of pendingA) await a.addIceCandidate(c)
      await Promise.race([new Promise((resolve) => { a.onconnectionstatechange = () => { if (a.connectionState === 'connected') resolve() }; if (a.connectionState === 'connected') resolve() }), new Promise((_, reject) => setTimeout(() => reject(Error('P2P timeout')), 10000))])
      await apply(sender, { fps: 30, maxBitrate: 2_500_000 })
      await apply(sender, { fps: 15, maxBitrate: 1_000_000 })
      const encoding = sender.getParameters().encodings[0]
      return { connected: a.connectionState, fps: encoding.maxFramerate, bitrate: encoding.maxBitrate }
    } finally { clearInterval(timer); stream.getTracks().forEach((t) => t.stop()); a.close(); b.close() }
  }, applySenderSettings.toString())
  assert.deepEqual(result, { connected: 'connected', fps: 15, bitrate: 1_000_000 })
  console.log('PASS: real Chrome P2P connected and live sender limits changed to 15 FPS / 1 Mbps.')
} finally { await browser.close() }

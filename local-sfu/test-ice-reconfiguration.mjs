import { chromium } from '@playwright/test'
import { buildIceConfiguration } from '../src/icePolicy.js'
import assert from 'node:assert/strict'
const servers = [{ urls: ['turn:127.0.0.1:9?transport=udp', 'turn:127.0.0.1:9?transport=tcp'], username: 'test', credential: 'test' }]
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage()
  for (const pool of [0, 4]) {
    // Real browser configuration checks after SDP, no paid relay or screen capture.
    await page.evaluate(async (poolSize) => {
      window.peer = new RTCPeerConnection({ iceCandidatePoolSize: poolSize })
      window.peer.createDataChannel('test')
      await window.peer.setLocalDescription(await window.peer.createOffer())
    }, pool)
    const current = await page.evaluate(() => {
      const config = window.peer.getConfiguration()
      delete config.certificates // RTC certificates cannot cross the automation serialization boundary.
      return config
    })
    for (const stage of ['direct', 'udp', 'all']) {
      const config = buildIceConfiguration(servers, stage, false, current)
      const result = await page.evaluate((next) => {
        window.peer.setConfiguration({ ...window.peer.getConfiguration(), ...next })
        window.peer.restartIce()
        return window.peer.getConfiguration().iceCandidatePoolSize
      }, config)
      assert.equal(result, pool)
    }
    await page.evaluate(() => window.peer.close())
  }
  // Confirm the exact previous implementation fails, so this test covers the regression.
  const oldError = await page.evaluate(async () => {
    const pc = new RTCPeerConnection({ iceCandidatePoolSize: 4 })
    try {
      pc.createDataChannel('old'); await pc.setLocalDescription(await pc.createOffer())
      try { pc.setConfiguration({ iceServers: [], iceTransportPolicy: 'all' }); return null } catch (error) { return error.name }
    } finally { pc.close() }
  })
  assert.equal(oldError, 'InvalidModificationError')
  console.log('PASS: old regression reproduced; direct/UDP/all configurations accepted after SDP with pools 0 and 4. Does not test external TURN connectivity.')
} finally { await browser.close() }

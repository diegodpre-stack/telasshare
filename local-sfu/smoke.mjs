import { chromium } from '@playwright/test'
import assert from 'node:assert/strict'
const response = await fetch('http://localhost:8790/token', { method: 'POST', body: '{}' })
assert.equal(response.status, 403, 'cross-origin token request must fail')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const publisher = await browser.newPage(), viewer = await browser.newPage()
  for (const page of [publisher, viewer]) { page.on('pageerror', (error) => console.log(error.message)); page.on('console', (message) => { if (message.type() === 'error') console.log(message.text().replace(/eyJ[^\s]+/g, '[token]')) }) }
  // Synthetic moving video only: this test never captures a user window or screen.
  await publisher.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720
      const ctx = canvas.getContext('2d'); let frame = 0
      setInterval(() => { ctx.fillStyle = `hsl(${frame++ % 360} 80% 40%)`; ctx.fillRect(0, 0, 1280, 720); ctx.fillStyle = 'white'; ctx.font = '60px sans-serif'; ctx.fillText(`Synthetic SFU test ${frame}`, 40, 100) }, 33)
      return canvas.captureStream(30)
    }
  })
  for (const [page, name] of [[publisher, 'Publisher'], [viewer, 'Viewer']]) {
    await page.goto('http://localhost:8790')
    await page.locator('#name').fill(name)
    await page.getByRole('button', { name: 'Entrar no teste' }).click()
    try { await page.locator('#controls').waitFor({ state: 'visible', timeout: 20000 }) } catch (error) { console.log(await page.locator('#status').textContent()); throw error }
  }
  await publisher.locator('#share').click()
  await viewer.waitForFunction(() => document.querySelector('video')?.videoWidth > 0, { timeout: 20000 })
  await viewer.waitForFunction(() => document.getElementById('stats').textContent.includes('RECEPÇÃO'), { timeout: 20000 })
  console.log('PASS: two clients joined local SFU and synthetic video decoded.')
  console.log(await viewer.locator('#stats').textContent())
  await publisher.locator('#stop').click()
  await viewer.waitForFunction(() => !document.querySelector('video'))
  console.log('PASS: stopping publisher removes remote track; unauthorized token denied.')
} finally { await browser.close() }

// The presenter's recorder when the microphone goes away mid-recording (the 1 Oct incident: 34 s of
// audio from a 2 h 57 min workshop, no error). The recording preload bundled with electron stubbed,
// in headless Chromium, with a fake microphone whose track can end and a fake MediaRecorder. Seams:
//  1. chunks stream to main as they arrive (recording:stream-append), not at Stop;
//  2. the input ends and cannot be reopened: the status bar stops saying REC ("Audio stopped",
//     tone lost) and a notice offers "Resume recording";
//  3. Resume opens the input again: a second segment starts, the notice gives way to "Audio is back";
//  4. Stop saves the streamed session with two segments and the gap (no audio buffer over IPC);
//  5. when the input can be reopened at once, recording carries on by itself;
//  6. main refuses a segment's file: the presenter is told audio is not reaching the disk, and every
//     chunk of that segment reaches the save (tail) — none lost;
//  7. Stop pressed while a loss is still closing the segment waits for that segment's last chunk;
//  8. the recording's origin is when the recorder started, not when Record was pressed: mic
//     permission and opening the stream are not in the Run's start time or its slide timings.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const repo = fileURLToPath(new URL('..', import.meta.url))
const bundled = await build({
  entryPoints: [join(repo, 'src/preload/present-recorder.ts')], bundle: true, write: false, format: 'iife', globalName: 'Recorder', platform: 'browser', logLevel: 'silent',
  plugins: [{ name: 'preload-boundaries', setup(b) {
    b.onResolve({ filter: /^electron$|present-edit-bridge$|present-live-bridge$/ }, (args) => ({ path: args.path, namespace: 'test' }))
    b.onLoad({ filter: /.*/, namespace: 'test' }, (args) => ({ contents: args.path === 'electron' ? 'export const ipcRenderer = window.testIpc' : 'export const mountEditBridge = () => {}; export const mountLiveBridge = () => {};', loader: 'js' }))
  } }]
})

const FAKES = () => {
  window.calls = []
  window.micFails = false
  window.micOpens = 0
  window.ctx = { talkSlug: 'deck', talkTitle: 'Deck', timerTargetMin: 0, pathwayId: null, preferredPlannedRunId: null, discardThresholdMs: 0, testMode: false }
  window.testIpc = {
    on: () => {},
    invoke: async (name, payload) => {
      window.calls.push([name, payload && typeof payload === 'object' ? { ...payload, bytes: payload.bytes ? payload.bytes.byteLength : undefined } : payload])
      if (name === 'recording:context') return window.ctx
      if (name === 'recording:stream-open') { if (window.openDelay) await new Promise((r) => setTimeout(r, window.openDelay)); return { ok: true, sessionId: 'sess-x' } }
      if (name === 'recording:stream-segment' && payload.index === window.refuseSegment) return { ok: false, error: 'unsafe-path' }
      if (name === 'recording:save') return { ok: true, sessionId: 'sess-x', kind: 'delivery' }
      return { ok: true }
    }
  }
  class FakeTrack extends EventTarget {
    constructor() { super(); this.readyState = 'live' }
    getSettings() { return { deviceId: 'default', groupId: 'g1' } }
    stop() { this.readyState = 'ended' }
    end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')) }
  }
  window.tracks = []
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia: async () => {
      window.micOpens += 1
      if (window.micDelay) await new Promise((r) => setTimeout(r, window.micDelay))
      if (window.micFails) throw new Error('NotFoundError')
      const track = new FakeTrack()
      window.tracks.push(track)
      return { getTracks: () => [track], getAudioTracks: () => [track] }
    },
    enumerateDevices: async () => [{ kind: 'audioinput', deviceId: 'default', groupId: 'g1' }],
    addEventListener() {}, removeEventListener() {}
  } })
  window.recs = []
  window.MediaRecorder = class {
    static isTypeSupported() { return true }
    constructor(stream) { this.stream = stream; this.state = 'inactive'; this.emitted = 0; window.recs.push(this) }
    start() {
      if (window.recStartedAt === undefined) window.recStartedAt = Date.now()
      this.state = 'recording'
      this.timer = setInterval(() => { if (this.state === 'recording') { this.emitted += 1; this.ondataavailable?.({ data: new Blob(['x'.repeat(64)]) }) } }, 50)
    }
    pause() { this.state = 'paused' }
    resume() { this.state = 'recording' }
    stop() {
      clearInterval(this.timer)
      this.state = 'inactive'
      const finish = () => { this.emitted += 1; this.ondataavailable?.({ data: new Blob(['last']) }); this.onstop?.(new Event('stop')) }
      // Chromium delivers the final chunk and 'stop' after stop() returns; window.asyncStop does too.
      if (window.asyncStop) setTimeout(finish, 80)
      else { this.emitted += 1; this.ondataavailable?.({ data: new Blob(['last']) }); queueMicrotask(() => this.onstop?.(new Event('stop'))) }
    }
  }
}

let failures = 0
async function check(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`) } catch (e) { failures++; console.error(`  FAIL ${name}\n       ${e.message.split('\n')[0]}`) }
}
const browser = await chromium.launch({ headless: true })
const tone = (page) => page.locator('#twrec-module').getAttribute('data-tone')
const label = (page) => page.locator('#twrec-label').textContent()
const callsNamed = (page, name) => page.evaluate((n) => window.calls.filter(([c]) => c === n).map(([, p]) => p), name)
try {
  const page = await browser.newPage()
  await page.setContent('<section class="slide active" data-id="a"></section>')
  await page.evaluate(FAKES)
  await page.addScriptTag({ content: bundled.outputFiles[0].text })

  await check('chunks stream to main while recording, not at Stop', async () => {
    await page.locator('#twrec-primary').click()
    await page.waitForFunction(() => window.calls.filter(([c]) => c === 'recording:stream-append').length >= 3)
    assert.equal(await tone(page), 'recording')
    const opened = await callsNamed(page, 'recording:stream-segment')
    assert.deepEqual(opened.map((p) => p.index), [0])
    const appends = await callsNamed(page, 'recording:stream-append')
    assert.ok(appends.every((p) => p.sessionId === 'sess-x' && p.index === 0 && p.bytes === 64))
  })

  await check('the input ends and cannot be reopened: status bar says "Audio stopped", notice offers Resume', async () => {
    await page.evaluate(() => { window.micFails = true; window.tracks[0].end() })
    await page.waitForFunction(() => document.querySelector('.twrec-lost-note')?.classList.contains('show') && !document.getElementById('twrec-lost-resume').hidden)
    assert.equal(await tone(page), 'lost')
    assert.equal(await label(page), 'Audio stopped')
    assert.match(await page.locator('#twrec-lost-text').textContent(), /^Audio stopped at 00:0\d\. The microphone went away\.$/)
    assert.equal(await page.evaluate(() => window.micOpens), 2, 'one automatic attempt to reopen the input')
    assert.equal(await page.locator('#twrec-pause').isVisible(), false)
    assert.equal(await page.locator('#twrec-stop').isVisible(), true, 'Stop still saves what was recorded')
    const ends = await callsNamed(page, 'recording:stream-segment-end')
    assert.deepEqual(ends.map((p) => p.index), [0], 'the first segment is closed on disk')
  })

  await check('Resume reopens the input: a second segment starts and "Audio is back" shows', async () => {
    await page.evaluate(() => { window.micFails = false })
    await page.locator('#twrec-lost-resume').click({ timeout: 5000 })
    await page.waitForFunction(() => document.querySelector('.twrec-back-note')?.classList.contains('show'))
    assert.equal(await tone(page), 'recording')
    assert.equal(await page.locator('.twrec-lost-note.show').count(), 0)
    assert.match(await page.locator('#twrec-back-text').textContent(), /^Audio is back\. The \d+ s gap is noted in the Run\.$/)
    await page.waitForFunction(() => window.calls.filter(([c, p]) => c === 'recording:stream-append' && p.index === 1).length >= 2)
    // Order on disk: every segment-0 append precedes its end, which precedes segment 1.
    const order = await page.evaluate(() => window.calls.filter(([c]) => c.startsWith('recording:stream-')).map(([c, p]) => `${c.slice(17)}:${p.index ?? ''}`))
    const end0 = order.indexOf('segment-end:0'), seg1 = order.indexOf('segment:1')
    assert.ok(end0 > 0 && seg1 > end0, order.join(' '))
    assert.ok(order.slice(end0 + 1).every((x) => !x.endsWith(':0')), 'no segment-0 append after it closed')
  })

  await check('Stop saves the streamed session with both segments and the gap, no audio buffer', async () => {
    await page.locator('#twrec-stop').click()
    await page.waitForFunction(() => document.querySelector('#twrec-module').dataset.rec === 'saved')
    const [save] = await callsNamed(page, 'recording:save')
    assert.equal(save.audio, undefined)
    assert.equal(save.stream.sessionId, 'sess-x')
    assert.deepEqual(save.stream.tail, [])
    const { segments, gaps, audioMs } = save.audioTimeline
    assert.deepEqual(segments.map((s) => s.index), [0, 1])
    assert.equal(gaps.length, 1)
    assert.equal(gaps[0].reason, 'track-ended')
    assert.equal(gaps[0].startMs, segments[0].endMs)
    assert.equal(gaps[0].endMs, segments[1].startMs)
    assert.equal(audioMs, (segments[0].endMs - segments[0].startMs) + (segments[1].endMs - segments[1].startMs))
  })

  await check('when the input reopens at once, recording carries on by itself', async () => {
    const p2 = await browser.newPage()
    await p2.setContent('<section class="slide active" data-id="a"></section>')
    await p2.evaluate(FAKES)
    await p2.addScriptTag({ content: bundled.outputFiles[0].text })
    await p2.locator('#twrec-primary').click()
    await p2.waitForFunction(() => window.calls.some(([c]) => c === 'recording:stream-append'))
    await p2.evaluate(() => window.tracks[0].end())
    await p2.waitForFunction(() => document.querySelector('.twrec-back-note')?.classList.contains('show'))
    assert.equal(await tone(p2), 'recording')
    assert.equal(await p2.evaluate(() => window.micOpens), 2)
    assert.deepEqual((await callsNamed(p2, 'recording:stream-segment')).map((p) => p.index), [0, 1])
    await p2.close()
  })

  const freshPage = async () => {
    const p = await browser.newPage()
    await p.setContent('<section class="slide active" data-id="a"></section>')
    await p.evaluate(FAKES)
    await p.addScriptTag({ content: bundled.outputFiles[0].text })
    return p
  }

  await check('main refuses a segment file: "not being saved to disk" shows, and every chunk of it reaches the save', async () => {
    const p3 = await freshPage()
    await p3.evaluate(() => { window.refuseSegment = 1 })
    await p3.locator('#twrec-primary').click()
    await p3.waitForFunction(() => window.calls.some(([c]) => c === 'recording:stream-append'))
    await p3.evaluate(() => window.tracks[0].end())
    await p3.waitForFunction(() => document.querySelector('.twrec-disk-note')?.classList.contains('show'), null, { timeout: 5000 })
    assert.match(await p3.locator('.twrec-disk-note').textContent(), /Audio is not being saved to disk\./)
    assert.equal((await callsNamed(p3, 'recording:stream-segment')).filter((c) => c.index === 1).length, 3, 'the open is retried before giving up')
    await p3.waitForTimeout(400)
    await p3.locator('#twrec-stop').click()
    await p3.waitForFunction(() => document.querySelector('#twrec-module').dataset.rec === 'saved')
    const [save] = await callsNamed(p3, 'recording:save')
    const emitted = await p3.evaluate(() => window.recs[1].emitted)
    assert.ok(emitted > 3)
    assert.equal(save.stream.tail.length, emitted, 'every chunk of the refused segment is handed over')
    assert.ok(save.stream.tail.every((c) => c.index === 1))
    assert.equal((await callsNamed(p3, 'recording:stream-append')).filter((c) => c.index === 1).length, 0)
    await p3.close()
  })

  await check('Stop during a loss waits for the lost segment\'s last chunk before taking the tail', async () => {
    const p4 = await freshPage()
    await p4.evaluate(() => { window.asyncStop = true })
    await p4.locator('#twrec-primary').click()
    await p4.waitForFunction(() => window.calls.filter(([c]) => c === 'recording:stream-append').length >= 2)
    // The input ends and cannot be reopened, and Stop is pressed before the recorder's last chunk.
    await p4.evaluate(() => { window.micFails = true; window.tracks[0].end(); document.getElementById('twrec-stop').click() })
    await p4.waitForFunction(() => document.querySelector('#twrec-module').dataset.rec === 'saved', null, { timeout: 5000 })
    const names = await p4.evaluate(() => window.calls.map(([c, p]) => (c === 'recording:stream-append' ? `append:${p.bytes}` : c)))
    const saveAt = names.indexOf('recording:save')
    assert.ok(names.indexOf('append:4') >= 0 && names.indexOf('append:4') < saveAt, 'the last chunk reached the disk before the save')
    const appended = names.filter((n) => n.startsWith('append:')).length
    assert.equal(appended, await p4.evaluate(() => window.recs[0].emitted), 'every chunk of the segment, none left behind')
    const [save] = await callsNamed(p4, 'recording:save')
    assert.deepEqual(save.stream.tail, [])
    await p4.close()
  })

  await check('the Run starts when the recorder starts: setup delay is not in startedAt or the slide timings', async () => {
    const p5 = await freshPage()
    // A slow mic-permission prompt and a slow main: 1.2 s between Record and the recorder starting.
    await p5.evaluate(() => { window.micDelay = 700; window.openDelay = 500 })
    const clickedAt = await p5.evaluate(() => { const t = Date.now(); document.getElementById('twrec-primary').click(); return t })
    await p5.waitForFunction(() => window.calls.filter(([c]) => c === 'recording:stream-append').length >= 4)
    const stoppedAt = await p5.evaluate(() => { const t = Date.now(); document.getElementById('twrec-stop').click(); return t })
    await p5.waitForFunction(() => document.querySelector('#twrec-module').dataset.rec === 'saved')
    const recStartedAt = await p5.evaluate(() => window.recStartedAt)
    assert.ok(recStartedAt - clickedAt >= 1100, `setup took ${recStartedAt - clickedAt} ms`)
    const [save] = await callsNamed(p5, 'recording:save')
    const startedAt = Date.parse(save.startedAt)
    assert.ok(Math.abs(startedAt - recStartedAt) <= 30, `startedAt is ${startedAt - recStartedAt} ms from the recorder start`)
    const [seg0] = await callsNamed(p5, 'recording:stream-segment')
    assert.equal(seg0.startedAt, save.startedAt, 'main is told the same start (the marker, for recovery)')
    // Slide marks share the origin: the stop mark is the time from the recorder start to Stop.
    const stopMark = save.rawMarks.find((m) => m.event === 'stop')
    assert.ok(Math.abs(stopMark.tMs - (stoppedAt - recStartedAt)) <= 60, `stop mark ${stopMark.tMs} vs ${stoppedAt - recStartedAt}`)
    assert.equal(save.rawMarks[0].tMs, 0)
    assert.equal(save.audioTimeline.segments[0].startMs, 0)
    assert.ok(Math.abs(save.audioTimeline.segments[0].endMs - stopMark.tMs) <= 5, 'the audio clock ends where the marks end')
    await p5.close()
  })
} finally {
  await browser.close()
}
if (failures) {
  console.error(`\n${failures} present-audio-loss check(s) failed`)
  process.exit(1)
}
console.log('\npresent-audio-loss: all checks passed')

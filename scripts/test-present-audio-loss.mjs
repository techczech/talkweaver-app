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
//     permission and opening the stream are not in the Run's start time or its slide timings;
//  9. a reconnect that yields no audio leaves no segment (no empty file in main; 9 Nov incident);
// 10. the Microphone menu beside Record lists the inputs by name, the built-in one chosen, with a
//     live level; Record opens exactly that input although a room system became the default;
// 11. a microphone connected during the talk is offered once; Use it moves the recording to it in a
//     new segment with no gap, and remembers it;
// 12. the chosen microphone goes away: no other input is opened, not even by Resume; it is
//     reopened by itself when it comes back with a new device id;
// 13. Use it when the old recorder's last chunk comes late (as in Chromium): the new recorder starts
//     before the old one stops, every chunk of both reaches the disk, the overlap is not a gap;
// 14. an acquisition that times out, or is overtaken by a later pick, never becomes the input in use
//     and its stream is stopped;
// 15. Record never records the system default: with only "default" listed it opens the Microphone
//     menu for a pick; with names hidden until permission, the permission stream is stopped and the
//     built-in microphone is opened exactly; a remembered microphone not connected gives way to the
//     built-in one, and the presenter is told;
// 16. a new recorder that cannot be made or started (NotSupportedError from the constructor or from
//     start()) leaves the old one recording, its loss watch intact, the old input still the one in
//     use, the new stream stopped; the presenter is told and every chunk reaches the save.
import assert from 'node:assert/strict'
import { createRecordingStreams } from '../src/main/recording-stream.ts'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { resolve, join as pathJoin } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const repo = fileURLToPath(new URL('..', import.meta.url))
const bundled = await build({
  entryPoints: [join(repo, 'src/preload/present-recorder.ts')], bundle: true, write: false, format: 'iife', globalName: 'Recorder', platform: 'browser', logLevel: 'silent',
  plugins: [{ name: 'preload-boundaries', setup(b) {
    b.onLoad({ filter: /present-recorder\.ts$/ }, async (args) => ({ contents: readFileSync(args.path,'utf8').replace('mountRecUi(controller', 'window.testController = controller; mountRecUi(controller'), loader: 'ts' }))
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
    getSettings() { return { deviceId: 'mic1', groupId: 'g1' } }
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
    enumerateDevices: async () => [
      { kind: 'audioinput', deviceId: 'default', groupId: 'g1', label: 'Default - MacBook Pro Microphone' },
      { kind: 'audioinput', deviceId: 'mic1', groupId: 'g1', label: 'MacBook Pro Microphone' }
    ],
    addEventListener() {}, removeEventListener() {}
  } })
  window.recs = []
  window.MediaRecorder = class {
    static isTypeSupported() { return true }
    constructor(stream) {
      // window.failNextRec: the next recorder throws, from the constructor or from start().
      const fail = window.failNextRec
      window.failNextRec = null
      if (fail === 'construct') throw new DOMException('not supported', 'NotSupportedError')
      this.failStart = fail === 'start'
      this.stream = stream; this.state = 'inactive'; this.emitted = 0; this.silent = !!window.silentRecs; window.recs.push(this)
    }
    start() {
      if (this.failStart) throw new DOMException('not supported', 'NotSupportedError')
      if (window.recStartedAt === undefined) window.recStartedAt = Date.now()
      this.startedAt = performance.now()
      this.state = 'recording'
      if (this.silent) return
      this.timer = setInterval(() => { if (this.state === 'recording') { this.emitted += 1; this.ondataavailable?.({ data: new Blob(['x'.repeat(64)]) }) } }, 50)
    }
    pause() { this.state = 'paused' }
    resume() { this.state = 'recording' }
    stop() {
      this.stoppedAt = performance.now()
      clearInterval(this.timer)
      this.state = 'inactive'
      if (this.silent) { queueMicrotask(() => this.onstop?.(new Event('stop'))); return }
      const finish = () => { this.emitted += 1; this.ondataavailable?.({ data: new Blob(['last']) }); this.onstop?.(new Event('stop')) }
      // Chromium delivers the final chunk and 'stop' after stop() returns; window.asyncStop does too.
      if (window.asyncStop) setTimeout(finish, 80)
      else { this.emitted += 1; this.ondataavailable?.({ data: new Blob(['last']) }); queueMicrotask(() => this.onstop?.(new Event('stop'))) }
    }
  }
}

// A Mac with named inputs (Chromium's list on macOS): "default" follows the system, the others are
// real devices. getUserMedia opens only the device its constraint names; devicechange can be fired.
const ROOM = () => {
  window.devices = [
    { kind: 'audioinput', deviceId: 'default', groupId: 'g-mbp', label: 'Default - MacBook Pro Microphone (Built-in)' },
    { kind: 'audioinput', deviceId: 'mbp', groupId: 'g-mbp', label: 'MacBook Pro Microphone (Built-in)' },
    { kind: 'audioinput', deviceId: 'airpods', groupId: 'g-air', label: 'AirPods Pro' },
    { kind: 'audiooutput', deviceId: 'spk', groupId: 'g-mbp', label: 'MacBook Pro Speakers (Built-in)' }
  ]
  window.opened = []
  window.discovery = []
  window.openDelays = {}
  const bus = new EventTarget()
  window.fireDeviceChange = () => bus.dispatchEvent(new Event('devicechange'))
  class Track extends EventTarget {
    constructor(dev) { super(); this.readyState = 'live'; this.dev = dev; this.label = dev.label }
    getSettings() { return { deviceId: this.dev.deviceId, groupId: this.dev.groupId } }
    stop() { this.readyState = 'ended' }
    end() { this.readyState = 'ended'; this.dispatchEvent(new Event('ended')) }
  }
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia: async (constraints) => {
      window.micOpens += 1
      const id = constraints?.audio?.deviceId?.exact ?? '(any)'
      window.opened.push(id)
      if (id === '(any)') {
        // The system's current input: grants the permission (names appear); never to be recorded.
        window.granted = true
        const sys = window.devices.find((d) => d.deviceId === 'default') ?? { deviceId: 'default', groupId: '', label: '' }
        const track = new Track(sys)
        window.discovery.push(track)
        return { getTracks: () => [track], getAudioTracks: () => [track] }
      }
      if (window.openDelays[id]) await new Promise((r) => setTimeout(r, window.openDelays[id]))
      const dev = window.devices.find((d) => d.kind === 'audioinput' && d.deviceId === id)
      if (!dev || window.micFails) throw new Error('NotFoundError')
      if (window.realStreams) {
        const ac = new AudioContext(); const osc = ac.createOscillator(); const dest = ac.createMediaStreamDestination()
        osc.connect(dest); osc.start(); void ac.resume()
        return dest.stream
      }
      const track = new Track(dev)
      window.tracks.push(track)
      return { getTracks: () => [track], getAudioTracks: () => [track] }
    },
    // Without the permission Chromium lists one nameless entry per kind, with no ids.
    enumerateDevices: async () => (window.hideNames && !window.granted
      ? [{ kind: 'audioinput', deviceId: '', groupId: '', label: '' }, { kind: 'audiooutput', deviceId: '', groupId: '', label: '' }]
      : window.devices.map((d) => ({ ...d }))),
    addEventListener: (type, fn) => bus.addEventListener(type, fn),
    removeEventListener: (type, fn) => bus.removeEventListener(type, fn)
  } })
}

let failures = 0
async function check(name, fn) {
  try { await fn(); console.log(`  ok  ${name}`) } catch (e) { failures++; console.error(`  FAIL ${name}\n       ${process.env.FULL ? e.message : e.message.split('\n')[0]}`) }
}
const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
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
    assert.match(await page.locator('#twrec-lost-text').textContent(), /^Audio stopped at 00:0\d\. Waiting for MacBook Pro Microphone\. Nothing is being recorded\.$/)
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
    // The second segment's file is opened with its first chunk.
    await p2.waitForFunction(() => window.calls.some(([c, p]) => c === 'recording:stream-segment' && p.index === 1))
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

  await check('a clip mark names the authored reference, else the video address without query or fragment, never a data: URI', async () => {
    const p6 = await browser.newPage()
    await p6.setContent('<section class="slide active" data-id="a"></section>')
    await p6.evaluate(FAKES)
    await p6.addScriptTag({ content: bundled.outputFiles[0].text })
    const names = await p6.evaluate(() => [
      Recorder.clipSource('demo/tour.mp4?x=1', 'data:video/mp4;base64,AAAA'),
      Recorder.clipSource('', 'https://cdn.example/v.mp4?token=SECRET#t=3'),
      Recorder.clipSource('', 'assets/big.mp4'),
      Recorder.clipSource('', 'data:video/mp4;base64,AAAA'),
      Recorder.clipSource('https://cdn.example/v.mp4?token=SECRET', ''),
      Recorder.clipSource(undefined, undefined)
    ])
    assert.deepEqual(names, ['demo/tour.mp4?x=1', 'https://cdn.example/v.mp4', 'assets/big.mp4', '', 'https://cdn.example/v.mp4', ''])
    await p6.close()
  })

  await check('a reconnect that yields no audio leaves no segment and no empty file', async () => {
    const p7 = await freshPage()
    await p7.locator('#twrec-primary').click()
    await p7.waitForFunction(() => window.calls.some(([c]) => c === 'recording:stream-append'))
    // The input comes back at once but gives no audio, then goes again (the 9 Nov room system).
    await p7.evaluate(() => { window.silentRecs = true; window.tracks[0].end() })
    await p7.waitForFunction(() => document.querySelector('.twrec-back-note')?.classList.contains('show'))
    await p7.evaluate(() => window.tracks[1].end())
    await p7.waitForFunction(() => document.querySelector('.twrec-lost-note')?.classList.contains('show') && !document.getElementById('twrec-lost-resume').hidden)
    await p7.evaluate(() => { window.silentRecs = false })
    await p7.locator('#twrec-lost-resume').click({ timeout: 5000 })
    await p7.waitForFunction(() => window.calls.some(([c, p]) => c === 'recording:stream-append' && p.index === 2))
    await p7.locator('#twrec-stop').click()
    await p7.waitForFunction(() => document.querySelector('#twrec-module').dataset.rec === 'saved')
    assert.deepEqual((await callsNamed(p7, 'recording:stream-segment')).map((p) => p.index), [0, 2], 'no file for the silent segment')
    const [save] = await callsNamed(p7, 'recording:save')
    assert.deepEqual(save.audioTimeline.segments.map((seg) => seg.index), [0, 2])
    await p7.close()
  })

  const roomPage = async (setup) => {
    const p = await browser.newPage()
    // A mid-talk fixture: a sole slide legitimately triggers the unrelated Save Run notice.
    await p.setContent('<section class="slide active" data-id="a"></section><section class="slide" data-id="last"></section>')
    await p.evaluate(FAKES)
    await p.evaluate(ROOM)
    if (setup) await p.evaluate(setup)
    await p.addScriptTag({ content: bundled.outputFiles[0].text })
    await p.waitForSelector('#twrec-mic:not([hidden])')
    return p
  }

  await check('layered presenter untouched record cluster opens no devices; menu previews without writing; Preview off closes devices', async () => {
    const p = await roomPage(() => {
      window.ctx.layered = true; window.ctx.captureChoice = 'camera'; window.realStreams = true; window.previewStreams = []
      window.devices.push({kind:'videoinput',deviceId:'fakecam',label:'Fake camera'})
      const invoke = window.testIpc.invoke
      window.testIpc.invoke = (channel,...args) => channel === 'recording:devices'
        ? Promise.resolve({camera:'granted',settings:{camera:'Fake camera',cameraDeviceId:'fakecam'}}) : invoke(channel,...args)
      const acquire = navigator.mediaDevices.getUserMedia
      navigator.mediaDevices.getUserMedia = async constraints => {
        let stream
        if (constraints.video) {
          window.micOpens++
          const canvas=document.createElement('canvas');canvas.width=4;canvas.height=4;canvas.getContext('2d').fillRect(0,0,4,4)
          stream=canvas.captureStream(1)
        } else stream=await acquire(constraints)
        window.previewStreams.push(stream);return stream
      }
    })
    await p.waitForTimeout(350)
    assert.equal(await p.evaluate(() => window.micOpens), 0)
    await p.keyboard.press('ArrowRight'); await p.keyboard.press('ArrowLeft')
    assert.equal(await p.evaluate(() => window.micOpens), 0)
    await p.locator('#twrec-mic').click()
    await p.waitForFunction(() => Number(document.querySelector('#twrec-idle-meter').getAttribute('aria-valuenow')) > 0)
    await p.waitForFunction(() => window.previewStreams.some(stream => stream.getVideoTracks().some(track => track.readyState === 'live')))
    assert.ok(await p.evaluate(() => window.previewStreams.some(stream => stream.getAudioTracks().some(track => track.readyState === 'live'))))
    assert.equal((await callsNamed(p, 'recording:stream-open')).length, 0)
    assert.equal((await callsNamed(p, 'recording:save')).length, 0)
    await p.locator('#twrec-preview').check()
    await p.locator('#twrec-preview').uncheck()
    await p.waitForFunction(() => window.previewStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended')))
    await p.close()
  })

  for (const paused of [false, true]) await check(paused ? 'switch paused, resume, Stop: actual files keep bytes and spans' : 'lost permanently: notice offers another input, new segment resumes, earlier file intact', async () => {
    const disk = mkdtempSync(resolve('.test-mic-disk-'))
    const store = createRecordingStreams({userDataDir:()=>disk})
    let finalised
    const p = await roomPage()
    await p.exposeFunction('diskIpc', async (name,payload) => {
      const id='sess-disk'
      if(name==='recording:stream-open') return store.open(1,{...payload,sessionId:id})
      if(name==='recording:stream-segment') return store.startSegment(1,id,payload.index,payload.startMs)
      if(name==='recording:stream-append') return store.append(1,id,payload.index,Uint8Array.from(payload.bytes))
      if(name==='recording:stream-segment-end') return store.endSegment(1,id,payload.index,payload.endMs)
      if(name==='recording:stream-checkpoint') return store.checkpoint(1,id,payload)
      if(name==='recording:save') { const result=store.finalise(1,id,payload.audioTimeline,payload.stream?.tail?.map(c=>({...c,bytes:Uint8Array.from(c.bytes)}))); finalised=result; return {...result,sessionId:id,kind:'delivery'} }
      return {ok:true}
    })
    await p.evaluate(() => {
      const old=window.testIpc.invoke
      window.testIpc.invoke=async (name,payload) => {
        await old(name,payload)
        const safe=payload?{...payload}:payload
        if(safe?.bytes instanceof ArrayBuffer) safe.bytes=Array.from(new Uint8Array(safe.bytes))
        if(safe?.stream?.tail) safe.stream={...safe.stream,tail:safe.stream.tail.map(c=>({...c,bytes:Array.from(new Uint8Array(c.bytes))}))}
        return window.diskIpc(name,safe)
      }
    })
    try {
      await p.locator('#twrec-primary').click()
      await p.waitForFunction(()=>window.calls.filter(([c])=>c==='recording:stream-append').length>=3)
      assert.equal(await p.locator('#twrec-mic').isVisible(),true)
      if(paused) await p.locator('#twrec-pause').click()
      else {
        await p.evaluate(()=>{window.devices=window.devices.filter(d=>d.groupId!=='g-mbp');window.tracks[0].end()})
        await p.waitForFunction(()=>document.getElementById('twrec-lost-switch').textContent==='Use AirPods Pro')
        assert.match(await p.locator('#twrec-lost-text').textContent(),/Nothing is being recorded/)
      }
      const before=readFileSync(pathJoin(disk,'recordings','sess-disk.webm'))
      if(paused) {
        await p.locator('#twrec-mic').click()
        await p.locator('#twrec-mic-select').selectOption('1')
      } else await p.locator('#twrec-lost-switch').click()
      await p.waitForFunction(()=>window.calls.some(([c,v])=>c==='recording:set-microphone'&&v==='AirPods Pro'))
      if(paused) await p.locator('#twrec-resume').click()
      await p.waitForFunction(()=>window.calls.some(([c,v])=>c==='recording:stream-append'&&v.index===1))
      await p.locator('#twrec-stop').click()
      await p.waitForFunction(()=>document.querySelector('#twrec-module').dataset.rec==='saved')
      assert.equal(finalised.ok,true)
      const files=finalised.segments
      assert.equal(files.length,2)
      for(const seg of files) assert.equal(readFileSync(pathJoin(disk,'recordings',seg.file)).length,seg.bytes)
      assert.ok(readFileSync(pathJoin(disk,'recordings',files[0].file)).subarray(0,before.length).equals(before))
      assert.ok(files.every(seg=>seg.endMs>=seg.startMs))
      assert.ok(files[1].endMs>files[1].startMs)
    } finally { await p.close(); store.closeOwner(1); rmSync(disk,{recursive:true,force:true}) }
  })

  await check('picking the microphone already reconnecting remembers it without a false carries-on error', async () => {
    const p=await roomPage()
    try {
      await p.locator('#twrec-primary').click()
      await p.waitForFunction(()=>window.calls.some(([c])=>c==='recording:stream-append'))
      await p.evaluate(()=>{window.openDelays.mbp=700;window.tracks[0].end()})
      await p.waitForFunction(()=>document.querySelector('#twrec-lost-text').textContent.includes('Reconnecting'))
      await p.locator('#twrec-mic').click()
      await p.locator('#twrec-mic-select').selectOption('0')
      await p.waitForFunction(()=>window.calls.some(([c,v])=>c==='recording:set-microphone'&&v==='MacBook Pro Microphone (Built-in)'))
      assert.equal(await p.locator('.twrec-error').count(),0)
      await p.waitForFunction(()=>document.querySelector('#twrec-module').dataset.tone==='recording')
    } finally { await p.close() }
  })

  await check('double click Use during loss waits, disables the button and remembers the restored input',async()=>{
    const p=await roomPage()
    try {
      await p.locator('#twrec-primary').click()
      await p.waitForFunction(()=>window.calls.some(([c])=>c==='recording:stream-append'))
      await p.evaluate(()=>{
        window.devices=window.devices.filter(d=>d.deviceId!=='mbp'&&d.deviceId!=='default')
        window.openDelays.airpods=500
        window.tracks[0].end()
      })
      await p.waitForFunction(()=>document.querySelector('#twrec-lost-switch').textContent==='Use AirPods Pro')
      await p.evaluate(()=>{const b=document.querySelector('#twrec-lost-switch');b.click();b.click()})
      assert.equal(await p.locator('#twrec-lost-switch').isDisabled(),true)
      assert.equal(await p.locator('#twrec-lost-switch').textContent(),'Still reconnecting…')
      await p.waitForFunction(()=>window.calls.some(([c,v])=>c==='recording:set-microphone'&&v==='AirPods Pro'))
      assert.equal(await p.locator('.twrec-error').count(),0)
      assert.equal(await tone(p),'recording')
      assert.equal(await p.evaluate(()=>window.opened.filter(id=>id==='airpods').length),1)
    } finally {await p.close()}
  })
  await check('failed pick followed by rejecting microphone list restores the lost button label',async()=>{
    const p=await roomPage()
    try {
      await p.locator('#twrec-primary').click()
      await p.waitForFunction(()=>window.calls.some(([c])=>c==='recording:stream-append'))
      await p.evaluate(()=>{
        window.devices=window.devices.filter(d=>d.deviceId!=='mbp'&&d.deviceId!=='default')
        window.tracks[0].end()
      })
      await p.waitForFunction(()=>document.querySelector('#twrec-lost-switch').textContent==='Use AirPods Pro')
      await p.evaluate(()=>{
        window.testController.chooseMicrophone=async()=>false
        window.testController.microphones=async()=>{window.rejectedLists=(window.rejectedLists||0)+1;throw Error('list failed')}
      })
      await p.locator('#twrec-lost-switch').click()
      await p.waitForFunction(()=>window.rejectedLists>0)
      assert.equal(await p.locator('#twrec-lost-switch').isDisabled(),false)
      assert.equal(await p.locator('#twrec-lost-switch').textContent(),'Use AirPods Pro')
      assert.equal(await p.evaluate(()=>window.testController.audioStatus().lost),true)
    } finally {await p.close()}
  })
  await check('deliberate other-device pick during automatic reconnect is honoured after it settles',async()=>{
    const p=await roomPage()
    try {
      await p.locator('#twrec-primary').click()
      await p.waitForFunction(()=>window.calls.some(([c])=>c==='recording:stream-append'))
      await p.evaluate(()=>{window.openDelays.mbp=600;window.tracks[0].end()})
      await p.waitForFunction(()=>document.querySelector('#twrec-lost-text').textContent.includes('Reconnecting'))
      await p.locator('#twrec-lost-switch').click()
      await p.waitForFunction(()=>window.calls.some(([c,v])=>c==='recording:set-microphone'&&v==='AirPods Pro'))
      assert.equal(await p.evaluate(()=>window.opened.at(-1)),'airpods')
      assert.equal(await tone(p),'recording')
      assert.equal(await p.locator('.twrec-error').count(),0)
    } finally {await p.close()}
  })
  await check('picking the in-use microphone while lost cannot report success if reacquisition fails',async()=>{
    const p=await roomPage()
    try {
      await p.locator('#twrec-primary').click()
      await p.waitForFunction(()=>window.calls.some(([c])=>c==='recording:stream-append'))
      await p.evaluate(()=>{window.micFails=true;window.tracks[0].end()})
      await p.waitForFunction(()=>document.querySelector('#twrec-lost-resume') && !document.querySelector('#twrec-lost-resume').hidden)
      await p.locator('#twrec-mic').click()
      await p.locator('#twrec-mic-select').selectOption('0')
      await p.waitForFunction(()=>[...document.querySelectorAll('.twrec-error')].some(n=>n.textContent.includes('Nothing is being recorded.')))
      assert.deepEqual(await callsNamed(p,'recording:set-microphone'),[])
      assert.notEqual(await tone(p),'recording')
    } finally {await p.close()}
  })
  for(const mismatch of [false,true]) await check(mismatch?'start device mismatch names the device and opens the panel':'device vanishes after pick: names the device and opens the panel',async()=>{
    const p=await roomPage()
    try {
      await p.evaluate((mismatch)=>{
        if(mismatch){
          const open=navigator.mediaDevices.getUserMedia
          navigator.mediaDevices.getUserMedia=async c=>{const s=await open(c);s.getAudioTracks()[0].getSettings=()=>({deviceId:'wrong'});return s}
        }else{
          const list=navigator.mediaDevices.enumerateDevices
          let count=0
          navigator.mediaDevices.enumerateDevices=async()=>{const out=await list();if(++count===1)window.devices=window.devices.filter(d=>d.deviceId!=='mbp');return out}
        }
      },mismatch)
      await p.locator('#twrec-primary').click()
      await p.waitForFunction(()=>[...document.querySelectorAll('.twrec-error')].some(n=>n.textContent.includes("isn't connected")))
      assert.equal(await p.locator('#twrec-mic-panel').isVisible(),true)
      const errors=await p.locator('.twrec-error').allTextContents()
      assert.ok(errors.every(t=>!t.includes('enable mic access')))
    }finally{await p.close()}
  })

  const room = await roomPage()
  await check('the Microphone menu lists the inputs by name, the built-in one chosen, with a live level', async () => {
    await room.evaluate(() => { window.realStreams = true })
    await room.locator('#twrec-mic').click()
    await room.waitForSelector('#twrec-mic-panel:not([hidden])')
    await room.waitForFunction(() => document.querySelectorAll('#twrec-mic-select option').length === 2)
    const options = await room.evaluate(() => [...document.querySelectorAll('#twrec-mic-select option')].map((o) => [o.textContent, o.selected]))
    assert.deepEqual(options, [['MacBook Pro Microphone (Built-in)', true], ['AirPods Pro', false]])
    await room.waitForFunction(() => Number(document.querySelector('#twrec-mic-panel [role="meter"]').getAttribute('aria-valuenow')) > 0, null, { timeout: 5000 })
    assert.equal(await room.evaluate(() => window.opened.at(-1)), 'mbp', 'the level is the chosen input\'s own')
    await room.keyboard.press('Escape')
    await room.waitForSelector('#twrec-mic-panel', { state: 'hidden' })
    await room.evaluate(() => { window.realStreams = false })
  })

  await check('Record opens exactly the chosen microphone though a room system became the default; the room one is offered once', async () => {
    await room.evaluate(() => {
      window.devices = [
        { kind: 'audioinput', deviceId: 'default', groupId: 'g-extron', label: 'Default - Extron USB Audio' },
        ...window.devices.filter((d) => d.deviceId !== 'default'),
        { kind: 'audioinput', deviceId: 'extron', groupId: 'g-extron', label: 'Extron USB Audio' }
      ]
      window.fireDeviceChange()
    })
    await room.waitForFunction(() => document.querySelector('.twrec-mic-note')?.classList.contains('show'))
    assert.equal(await room.locator('#twrec-mic-text').textContent(), 'Room microphone available: Extron USB Audio. Use it?')
    await room.locator('#twrec-mic-dismiss').click()
    await room.locator('#twrec-primary').click()
    await room.waitForFunction(() => window.calls.some(([c]) => c === 'recording:stream-append'))
    assert.equal(await room.evaluate(() => window.opened.at(-1)), 'mbp')
    assert.equal(await room.locator('#twrec-mic').isVisible(), true, 'the menu remains available during recording')
    await room.evaluate(() => window.fireDeviceChange())
    await room.waitForTimeout(150)
    assert.equal(await room.locator('.twrec-mic-note.show').count(), 0, 'offered once')
  })

  await check('Use it moves the recording to the room microphone in a new segment, no gap, and remembers it', async () => {
    // A second room input appears during the recording: offered, used.
    await room.evaluate(() => {
      window.devices.push({ kind: 'audioinput', deviceId: 'lectern', groupId: 'g-lectern', label: 'Lectern Mic' })
      window.fireDeviceChange()
    })
    await room.waitForFunction(() => document.querySelector('.twrec-mic-note')?.classList.contains('show'))
    assert.equal(await room.locator('#twrec-mic-text').textContent(), 'Room microphone available: Lectern Mic. Use it?')
    await room.locator('#twrec-mic-use').click()
    await room.waitForFunction(() => window.calls.some(([c, p]) => c === 'recording:stream-append' && p.index === 1))
    assert.equal(await room.evaluate(() => window.opened.at(-1)), 'lectern')
    assert.deepEqual(await callsNamed(room, 'recording:set-microphone'), ['Lectern Mic'])
    assert.equal(await tone(room), 'recording')
    await room.locator('#twrec-stop').click()
    await room.waitForFunction(() => document.querySelector('#twrec-module').dataset.rec === 'saved')
    const [save] = await callsNamed(room, 'recording:save')
    const [a, b] = save.audioTimeline.segments
    assert.deepEqual(save.audioTimeline.gaps, [], 'a switch is not a gap')
    assert.ok(b.startMs <= a.endMs && a.endMs - b.startMs <= 200, `segments meet or overlap by a moment: ${a.endMs} → ${b.startMs}`)
  })
  await room.close()

  await check('the chosen microphone goes away: no other input is opened, not even by Resume; it comes back by itself', async () => {
    const p8 = await roomPage()
    await p8.locator('#twrec-primary').click()
    await p8.waitForFunction(() => window.calls.some(([c]) => c === 'recording:stream-append'))
    const opensBefore = await p8.evaluate(() => window.micOpens)
    // Unplugged: the system default moves to the AirPods; the laptop mic is gone.
    await p8.evaluate(() => {
      window.devices = window.devices.filter((d) => d.groupId !== 'g-mbp')
      window.devices.unshift({ kind: 'audioinput', deviceId: 'default', groupId: 'g-air', label: 'Default - AirPods Pro' })
      window.tracks[0].end()
    })
    await p8.waitForFunction(() => document.querySelector('.twrec-lost-note')?.classList.contains('show') && !document.getElementById('twrec-lost-resume').hidden)
    assert.match(await p8.locator('#twrec-lost-text').textContent(), /^Audio stopped at 00:0\d\. Waiting for MacBook Pro Microphone\. Nothing is being recorded\.$/)
    await p8.locator('#twrec-lost-resume').click()
    await p8.waitForTimeout(200)
    assert.equal(await p8.evaluate(() => window.micOpens), opensBefore, 'no other input is opened')
    assert.equal(await tone(p8), 'lost')
    // Back, with a new device id: reopened by itself.
    await p8.evaluate(() => {
      window.devices.push({ kind: 'audioinput', deviceId: 'mbp-2', groupId: 'g-mbp', label: 'MacBook Pro Microphone (Built-in)' })
      window.fireDeviceChange()
    })
    await p8.waitForFunction(() => document.querySelector('.twrec-back-note')?.classList.contains('show'))
    assert.deepEqual(await p8.evaluate(() => window.opened.slice(-1)), ['mbp-2'])
    assert.equal(await tone(p8), 'recording')
    await p8.close()
  })

  const offerAndUse = async (p, device) => {
    await p.evaluate((d) => { window.devices.push(d); window.fireDeviceChange() }, device)
    await p.waitForFunction((name) => document.querySelector('.twrec-mic-note')?.classList.contains('show') && document.getElementById('twrec-mic-text').textContent.includes(name), device.label)
    await p.locator('#twrec-mic-use').click()
  }
  const LECTERN = { kind: 'audioinput', deviceId: 'lectern', groupId: 'g-lectern', label: 'Lectern Mic' }
  const PODIUM = { kind: 'audioinput', deviceId: 'podium', groupId: 'g-podium', label: 'Podium Mic' }

  await check('Use it with a late last chunk: the new recorder starts first, every chunk of both lands, the overlap is no gap', async () => {
    const p = await roomPage(() => { window.asyncStop = true })
    await p.locator('#twrec-primary').click()
    await p.waitForFunction(() => window.calls.filter(([c]) => c === 'recording:stream-append').length >= 2)
    await offerAndUse(p, LECTERN)
    await p.waitForFunction(() => window.calls.filter(([c, q]) => c === 'recording:stream-append' && q.index === 1).length >= 2)
    await p.locator('#twrec-stop').click()
    await p.waitForFunction(() => document.querySelector('#twrec-module').dataset.rec === 'saved', null, { timeout: 5000 })
    const recs = await p.evaluate(() => window.recs.map((r) => ({ startedAt: r.startedAt, stoppedAt: r.stoppedAt, emitted: r.emitted })))
    assert.equal(recs.length, 2)
    assert.ok(recs[1].startedAt <= recs[0].stoppedAt, 'the new input records before the old one is stopped')
    const appends = await callsNamed(p, 'recording:stream-append')
    assert.equal(appends.filter((c) => c.index === 0).length, recs[0].emitted, 'every chunk of the old segment, its late last one too')
    assert.equal(appends.filter((c) => c.index === 1).length, recs[1].emitted)
    const order = await p.evaluate(() => window.calls.filter(([c]) => c.startsWith('recording:stream-')).map(([c, q]) => `${c.slice(17)}:${q.index ?? ''}`))
    const end0 = order.indexOf('segment-end:0'), seg1 = order.indexOf('segment:1')
    assert.ok(end0 > 0 && seg1 > end0 && order.slice(end0 + 1).every((x) => !x.endsWith(':0')), order.join(' '))
    const [save] = await callsNamed(p, 'recording:save')
    const [a, b] = save.audioTimeline.segments
    assert.deepEqual(save.audioTimeline.gaps, [])
    assert.ok(b.startMs <= a.endMs && a.endMs - b.startMs <= 200, `overlap ${a.endMs - b.startMs} ms`)
    assert.equal(save.audioTimeline.audioMs, b.endMs - a.startMs, 'the overlap is counted once')
    assert.deepEqual(save.stream.tail, [])
    assert.equal(await p.locator('.twrec-disk-note.show').count(), 0)
    await p.close()
  })

  await check('a switch that times out never becomes the input: its late stream is stopped, a later loss reopens the old one', async () => {
    const p = await roomPage(() => { window.ctx.streamTimeoutMs = 200; window.openDelays.lectern = 600 })
    await p.locator('#twrec-primary').click()
    await p.waitForFunction(() => window.calls.some(([c]) => c === 'recording:stream-append'))
    await offerAndUse(p, LECTERN)
    await p.waitForFunction(() => [...document.querySelectorAll('.twrec-error')].some((n) => n.textContent.startsWith('Lectern Mic could not be opened. Recording carries on with MacBook Pro Microphone')))
    await p.waitForFunction(() => window.tracks.some((t) => t.dev.deviceId === 'lectern'), null, { timeout: 3000 })
    await p.waitForTimeout(50)
    assert.equal(await p.evaluate(() => window.tracks.find((t) => t.dev.deviceId === 'lectern').readyState), 'ended', 'the late stream is stopped')
    assert.equal(await p.evaluate(() => window.recs.length), 1, 'never recorded')
    assert.deepEqual(await callsNamed(p, 'recording:set-microphone'), [], 'never remembered')
    // The laptop mic drops: the recorder reopens the laptop mic, not the late one.
    await p.evaluate(() => window.tracks[0].end())
    await p.waitForFunction(() => document.querySelector('.twrec-back-note')?.classList.contains('show'))
    assert.equal(await p.evaluate(() => window.opened.at(-1)), 'mbp')
    assert.equal(await p.evaluate(() => window.recs[1].stream.getAudioTracks()[0].dev.deviceId), 'mbp')
    await p.close()
  })

  await check('a pick overtaken by a later one: the first stream is stopped when it comes, the later one is used', async () => {
    const p = await roomPage(() => { window.openDelays.lectern = 700 })
    await p.locator('#twrec-primary').click()
    await p.waitForFunction(() => window.calls.some(([c]) => c === 'recording:stream-append'))
    await offerAndUse(p, LECTERN)
    await offerAndUse(p, PODIUM)
    await p.waitForFunction(() => window.calls.some(([c, q]) => c === 'recording:stream-append' && q.index === 1))
    await p.waitForFunction(() => window.tracks.some((t) => t.dev.deviceId === 'lectern'), null, { timeout: 3000 })
    await p.waitForTimeout(50)
    assert.equal(await p.evaluate(() => window.tracks.find((t) => t.dev.deviceId === 'lectern').readyState), 'ended')
    assert.deepEqual(await p.evaluate(() => window.recs.map((r) => r.stream.getAudioTracks()[0].dev.deviceId)), ['mbp', 'podium'])
    assert.deepEqual(await callsNamed(p, 'recording:set-microphone'), ['Podium Mic'])
    await p.evaluate(() => window.tracks.find((t) => t.dev.deviceId === 'podium').end())
    await p.waitForFunction(() => document.querySelector('.twrec-back-note')?.classList.contains('show'))
    assert.equal(await p.evaluate(() => window.opened.at(-1)), 'podium', 'the input in use is the later pick')
    await p.close()
  })

  await check('only the "default" entry listed: Record records nothing and opens the Microphone menu for a pick', async () => {
    const p = await roomPage(() => { window.devices = window.devices.filter((d) => d.deviceId === 'default' || d.kind !== 'audioinput') })
    await p.locator('#twrec-primary').click()
    await p.waitForSelector('#twrec-mic-panel:not([hidden])')
    await p.waitForFunction(() => document.getElementById('twrec-mic-panel-note').textContent === 'Choose the microphone to record with, then press Record.')
    assert.deepEqual(await p.evaluate(() => [...document.querySelectorAll('#twrec-mic-select option')].map((o) => o.textContent)), ['No microphone found'])
    assert.equal((await callsNamed(p, 'recording:stream-open')).length, 0)
    assert.equal(await p.evaluate(() => window.recs.length), 0)
    assert.ok(await p.evaluate(() => window.opened.every((id) => id === '(any)')), 'only the permission check opened anything')
    assert.ok(await p.evaluate(() => window.discovery.length > 0 && window.discovery.every((t) => t.readyState === 'ended')), 'its stream is stopped')
    assert.notEqual(await tone(p), 'recording')
    await p.close()
  })

  await check('names hidden until permission: the permission stream is stopped, then the built-in microphone is opened exactly', async () => {
    const p = await roomPage(() => { window.hideNames = true })
    await p.locator('#twrec-primary').click()
    await p.waitForFunction(() => window.calls.some(([c]) => c === 'recording:stream-append'))
    assert.deepEqual(await p.evaluate(() => window.opened), ['(any)', 'mbp'])
    assert.ok(await p.evaluate(() => window.discovery.every((t) => t.readyState === 'ended')))
    assert.equal(await p.evaluate(() => window.recs[0].stream.getAudioTracks()[0].dev.deviceId), 'mbp')
    await p.close()
  })

  await check('the remembered microphone is not connected: the built-in one records, and the presenter is told', async () => {
    const p = await roomPage(() => { window.ctx.microphone = 'Gone USB Mic' })
    await p.locator('#twrec-primary').click()
    await p.waitForFunction(() => window.calls.some(([c]) => c === 'recording:stream-append'))
    assert.equal(await p.evaluate(() => window.opened.at(-1)), 'mbp')
    await p.waitForFunction(() => [...document.querySelectorAll('.twrec-error')].some((n) => n.textContent === "Gone USB Mic isn't connected; recording with the built-in microphone (MacBook Pro Microphone (Built-in))."))
    await p.close()
  })

  await check('the remembered microphone is not connected and no built-in one is identified: the presenter picks', async () => {
    const p = await roomPage(() => {
      window.ctx.microphone = 'Gone USB Mic'
      window.devices = window.devices.filter((d) => d.groupId !== 'g-mbp')
      window.devices.unshift({ kind: 'audioinput', deviceId: 'default', groupId: 'g-air', label: 'Default - AirPods Pro' })
    })
    await p.locator('#twrec-primary').click()
    await p.waitForSelector('#twrec-mic-panel:not([hidden])')
    await p.waitForFunction(() => document.getElementById('twrec-mic-panel-note').textContent === "Gone USB Mic isn't connected. Choose the microphone to record with, then press Record.")
    assert.deepEqual(await p.evaluate(() => [...document.querySelectorAll('#twrec-mic-select option')].map((o) => [o.textContent, o.selected])), [
      ['Choose a microphone', true], ['AirPods Pro', false]
    ])
    assert.equal((await callsNamed(p, 'recording:stream-open')).length, 0)
    assert.equal(await p.evaluate(() => window.micOpens), 0, 'nothing opened, not even the AirPods the system now uses')
    await p.close()
  })

  await check('idle microphone meter is inline and Start again discards only the live take after confirmation', async () => {
    const p = await roomPage()
    // In the bar, but shown only while it moves (Preview on, or the Microphone menu open: the
    // devices are opened only on request since 66a1e055a / 4a94e0397); a still bar says nothing.
    await p.waitForSelector('#twrec-idle-meter', { state: 'attached' })
    assert.equal(await p.locator('#twrec-idle-meter').isVisible(), false)
    assert.equal((await callsNamed(p, 'recording:stream-open')).length, 0)
    await p.locator('#twrec-primary').click()
    await p.waitForFunction(() => window.calls.some(([c]) => c === 'recording:stream-append'))
    await p.locator('#twrec-again').click()
    await p.locator('#twrec-restart-cancel').click()
    assert.equal((await callsNamed(p, 'recording:stream-discard')).length, 0)
    await p.locator('#twrec-pause').click()
    await p.locator('#twrec-again').click()
    await p.locator('#twrec-restart-confirm').click()
    await p.waitForFunction(() => window.calls.some(([c]) => c === 'recording:stream-discard'))
    assert.equal((await callsNamed(p, 'recording:save')).length, 0)
    await p.close()
  })

  for (const where of ['construct', 'start']) {
    await check(`Use it when the new recorder throws (${where === 'construct' ? 'constructor' : 'start()'}): the old one keeps recording and watching, and the presenter is told`, async () => {
      const p = await roomPage()
      await p.locator('#twrec-primary').click()
      await p.waitForFunction(() => window.calls.some(([c]) => c === 'recording:stream-append'))
      await p.evaluate((w) => { window.failNextRec = w }, where)
      await offerAndUse(p, LECTERN)
      await p.waitForFunction(() => [...document.querySelectorAll('.twrec-error')].some((n) => n.textContent === 'Lectern Mic could not be opened. Recording carries on with MacBook Pro Microphone (Built-in).'))
      assert.equal(await p.evaluate(() => window.tracks.find((t) => t.dev.deviceId === 'lectern').readyState), 'ended', 'the new stream is stopped')
      assert.equal(await p.evaluate(() => window.recs[0].state), 'recording')
      assert.equal(await p.evaluate(() => window.tracks[0].readyState), 'live')
      assert.deepEqual(await callsNamed(p, 'recording:set-microphone'), [], 'never remembered')
      assert.equal(await tone(p), 'recording')
      const before = (await callsNamed(p, 'recording:stream-append')).length
      await p.waitForFunction((n) => window.calls.filter(([c, q]) => c === 'recording:stream-append' && q.index === 0).length > n + 1, before)
      // The loss watch is still on the old input, and the input in use is still the laptop mic.
      await p.evaluate(() => window.tracks[0].end())
      await p.waitForFunction(() => document.querySelector('.twrec-back-note')?.classList.contains('show'))
      assert.equal(await p.evaluate(() => window.opened.at(-1)), 'mbp')
      await p.waitForFunction(() => window.calls.some(([c, q]) => c === 'recording:stream-append' && q.index === 1))
      await p.locator('#twrec-stop').click()
      await p.waitForFunction(() => document.querySelector('#twrec-module').dataset.rec === 'saved', null, { timeout: 5000 })
      const [save] = await callsNamed(p, 'recording:save')
      assert.deepEqual(save.audioTimeline.segments.map((seg) => seg.index), [0, 1], 'the failed recorder left no segment')
      assert.equal(save.audioTimeline.gaps.length, 1)
      const appends = await callsNamed(p, 'recording:stream-append')
      assert.equal(appends.filter((c) => c.index === 0).length, await p.evaluate(() => window.recs[0].emitted), 'every chunk of the old recorder is in the Run')
      assert.deepEqual(save.stream.tail, [])
      assert.equal(await p.evaluate(() => window.recs.filter((r) => r.state === 'recording').length), 0, 'no recorder left running after Stop')
      await p.close()
    })
  }
  await check('unknown capture description says unknown, never none, after normal voice save', async () => {
    const p=await browser.newPage()
    await p.setContent('<section class="slide active" data-id="a"></section>')
    await p.evaluate(FAKES)
    await p.evaluate(()=>{const invoke=window.testIpc.invoke;window.testIpc.invoke=async(name,...args)=>name==='recording:save'?{ok:true,sessionId:'sess-x',kind:'delivery',captureUnknown:true}:invoke(name,...args)})
    await p.addScriptTag({content:bundled.outputFiles[0].text})
    await p.locator('#twrec-primary').click()
    await p.waitForFunction(()=>window.calls.some(([c])=>c==='recording:stream-append'))
    await p.locator('#twrec-stop').click()
    await p.waitForFunction(()=>document.querySelector('#twrec-module').dataset.rec==='saved')
    const text=await p.locator('#twrec-saved-text').textContent()
    assert.match(text,/slides: unknown/);assert.match(text,/camera: unknown/);assert.doesNotMatch(text,/: none/)
    await p.close()
  })
} finally {
  await browser.close()
}
if (failures) {
  console.error(`\n${failures} present-audio-loss check(s) failed`)
  process.exit(1)
}
console.log('\npresent-audio-loss: all checks passed')

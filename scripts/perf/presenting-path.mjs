#!/usr/bin/env node
/** The presenting path, timed in a running TalkWeaver reached over its debugging port (see README.md beside this file).
 *
 * Usage: node scripts/perf/presenting-path.mjs --cdp=http://127.0.0.1:9333 --talk="Talk title" --label=A --out=artefacts/perf/a.json
 *   [--steps=120] [--back=60] [--gap=250] [--launch-epoch=<ms since 1970 when the app was started>] [--ps="ssh air"] [--typing=40]
 *
 * Drives a build that allows a debugging port (the Security Test flavour or `electron .`), never the owner's own app.
 * It opens the talk from the startup screen, starts Present (presenter and audience), steps forward and back with the
 * arrow keys, then types in the editor. Every time is read inside the windows (event timestamps and
 * requestAnimationFrame), so the ssh tunnel's own latency is not counted. The output names the talk only by --label:
 * no titles, slide text or paths are written.
 */
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { openTalkByTitle } from '../../e2e/lib/talklist.mjs'

const opt = Object.fromEntries(process.argv.slice(2).map((s) => { const i = s.indexOf('='); return i < 0 ? [s.replace(/^--/, ''), '1'] : [s.slice(2, i), s.slice(i + 1)] }))
for (const k of ['cdp', 'talk', 'label', 'out']) if (!opt[k]) throw Error(`--${k} is required`)
const STEPS = Number(opt.steps ?? 120), BACK = Number(opt.back ?? 60), GAP = Number(opt.gap ?? 250), TYPING = Number(opt.typing ?? 40)
const result = { schema: 1, label: opt.label, created: new Date().toISOString(), host: opt.host || null, measurements: {}, steps: [], errors: [], process: {} }
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const epoch = (page) => page.evaluate(() => performance.timeOrigin + performance.now())
const summary = (a) => {
  const s = a.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((x, y) => x - y)
  const q = (p) => s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))] * 10) / 10 : null
  return { n: s.length, median: q(0.5), p90: q(0.9), worst: s.length ? Math.round(s.at(-1) * 10) / 10 : null }
}

/** Process table of the app under test (rss MB, cumulative CPU seconds), from `ps` here or through --ps (e.g. "ssh air"). */
function processes() {
  const cmd = `ps -axo pid=,rss=,time=,command= | grep -F "${(opt.app || 'TalkWeaver Security Test.app').replace(/"/g, '')}" | grep -v grep || true`
  const out = execSync(opt.ps ? `${opt.ps} '${cmd.replace(/'/g, `'\\''`)}'` : cmd, { encoding: 'utf8' })
  const rows = out.trim().split('\n').filter(Boolean).map((line) => {
    const [pid, rss, time, ...rest] = line.trim().split(/\s+/)
    const [m, s] = time.split(':'); const parts = time.split(':').map(Number)
    const cpu = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : Number(m) * 60 + Number(s)
    const command = rest.join(' ')
    const kind = /--type=renderer/.test(command) ? 'renderer' : /--type=gpu/.test(command) ? 'gpu' : /--type=utility/.test(command) ? 'utility' : /Helper/.test(command) ? 'helper' : 'main'
    return { pid: Number(pid), kind, rssMB: Math.round(Number(rss) / 1024), cpuSeconds: cpu }
  })
  const total = (k) => rows.filter((r) => !k || r.kind === k).reduce((a, r) => ({ rssMB: a.rssMB + r.rssMB, cpuSeconds: Math.round((a.cpuSeconds + r.cpuSeconds) * 100) / 100 }), { rssMB: 0, cpuSeconds: 0 })
  return { all: total(), main: total('main'), renderer: total('renderer'), gpu: total('gpu'), count: rows.length }
}

const browser = await chromium.connectOverCDP(opt.cdp, { timeout: 60000 })
const context = browser.contexts()[0]
const pages = () => context.pages()
async function findPage(test, timeout = 60000) {
  const end = Date.now() + timeout
  for (;;) {
    for (const p of pages()) { try { if (test(p.url())) return p } catch {} }
    if (Date.now() > end) return null
    await pause(100)
  }
}
async function heapMB(page) {
  try {
    const cdp = await context.newCDPSession(page)
    await cdp.send('Performance.enable')
    const { metrics } = await cdp.send('Performance.getMetrics')
    await cdp.detach()
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]))
    return { jsHeapMB: Math.round(m.JSHeapUsedSize / 1048576), nodes: m.Nodes, listeners: m.JSEventListeners, documents: m.Documents, frames: m.Frames }
  } catch (e) { return { error: String(e).slice(0, 120) } }
}

try {
  // 1. Start to usable window: the startup surface is on screen.
  const main = await findPage((u) => /\/renderer\/index\.html|index\.html$/.test(u) && !u.includes('presenter='), 90000)
  if (!main) throw Error('no editor window on the debugging port')
  const explorer = main.getByRole('region', { name: 'Vault Explorer', exact: true })
  const talks = main.locator('aside.talk-list.tl-panel .tl-tree')
  await explorer.or(talks).filter({ visible: true }).first().waitFor({ timeout: 90000 })
  const usable = await epoch(main)
  // First-run offers on a fresh profile (the agent skill step) are answered "Not now", as a new user would.
  for (let i = 0; i < 20; i++) {
    const offer = main.locator('[data-agent-skill-step] button', { hasText: /^Not now$/ }).first()
    if (await offer.isVisible().catch(() => false)) { await offer.click(); break }
    await pause(250)
  }
  if (opt['launch-epoch']) result.measurements.startToUsableMs = Math.round(usable - Number(opt['launch-epoch']))
  result.measurements.rendererNavigationToUsableMs = Math.round(usable - await main.evaluate(() => performance.timeOrigin))
  result.process.idle = processes()
  await pause(1500)

  // 2. Open the talk: the click until the editor shows it and the strip has its compiled slides.
  const openStart = await epoch(main)
  await openTalkByTitle(main, opt.talk, { timeout: 60000 })
  const editorShown = await epoch(main)
  // The compiled slide picture in the Inspector (the default right-hand view) is the talk ready to work on.
  await main.waitForSelector('.tw-inspector-stage iframe', { timeout: 120000 })
  const previewShown = await epoch(main)
  result.measurements.openTalk = { toEditorMs: Math.round(editorShown - openStart), toCompiledPreviewMs: Math.round(previewShown - openStart) }
  result.process.talkOpen = processes()

  // 3. Present: the command until the presenter's Current pane has its picture and the audience shows the slide.
  const before = new Set(pages())
  const presentStart = await epoch(main)
  await main.evaluate(() => { const b = document.querySelector('[data-command="present-presenter"]'); if (!b) throw Error('no Present button'); b.click() })
  const presenter = await findPage((u) => u.includes('presenter=1'), 180000)
  if (!presenter) throw Error('no presenter window')
  const presenterUrlAt = Date.now()
  await presenter.waitForLoadState('domcontentloaded')
  await presenter.waitForSelector('#currentPreview iframe', { timeout: 120000 })
  if (await presenter.locator('#twResume:not([hidden])').count().catch(() => 0)) await presenter.locator('#twResumeNo').click().catch(() => {})
  const presenterReady = await presenter.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.timeOrigin + performance.now())))))
  const presenterOrigin = await presenter.evaluate(() => performance.timeOrigin)
  // The audience window: the other new deck window (the app opens it with the presenter; F5 in the presenter otherwise).
  const isAudience = (p) => { try { return p !== presenter && new URL(p.url()).searchParams.has('audience') && !p.isClosed() } catch { return false } }
  let audience = null, pressedF5 = false
  for (let i = 0; i < 200 && !audience; i++) { audience = pages().find(isAudience) || null; if (!audience) await pause(100) }
  if (!audience) { pressedF5 = true; await presenter.keyboard.press('F5'); for (let i = 0; i < 150 && !audience; i++) { audience = pages().find(isAudience) || null; if (!audience) await pause(100) } }
  if (audience) await audience.waitForLoadState('domcontentloaded')
  const audienceReady = audience ? await audience.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r({ at: performance.timeOrigin + performance.now(), origin: performance.timeOrigin }))))) : null
  result.measurements.present = {
    toPresenterWindowMs: Math.round(presenterOrigin - presentStart),
    toPresenterReadyMs: Math.round(presenterReady - presentStart),
    toAudienceReadyMs: audienceReady ? Math.round(audienceReady.at - presentStart) : null,
    toAudienceWindowMs: audienceReady ? Math.round(audienceReady.origin - presentStart) : null,
    audienceByF5: pressedF5,
    newWindows: pages().filter((p) => !before.has(p)).map((p) => { try { const u = new URL(p.url()); return u.protocol + [...u.searchParams.keys()].join(',') } catch { return '?' } }),
  }
  void presenterUrlAt
  const slideCount = await presenter.evaluate(() => document.querySelectorAll('.stage > .slide, .deck .slide[data-id]').length)
  result.measurements.slides = slideCount
  await pause(2000)
  result.process.presenting = processes()
  result.memory = { presenterStart: await heapMB(presenter), audienceStart: audience ? await heapMB(audience) : null }

  // 4. Steps. Instrument both windows: the presenter's key time, its next painted frame, and its preview panes
  // loaded; the audience's first change after the key and the frame after its last change. Long tasks in both.
  await presenter.evaluate(() => {
    const now = () => performance.timeOrigin + performance.now()
    const s = window.__twPerf = { key: 0, frame: 0, longTasks: [], panesSettled: 0 }
    new PerformanceObserver((l) => { for (const e of l.getEntries()) s.longTasks.push([performance.timeOrigin + e.startTime, e.duration]) }).observe({ type: 'longtask', buffered: false })
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
      s.key = performance.timeOrigin + e.timeStamp; s.frame = 0
      requestAnimationFrame(() => requestAnimationFrame(() => { s.frame = now() }))
    }, true)
    // Panes are settled when no preview is still loading behind the one on show, and every pane frame has a document.
    s.waitPanes = (timeout) => new Promise((resolve) => {
      const start = now()
      const check = () => {
        // Slide pictures only (srcdoc frames): a live web page in the Current pane loads on its own schedule.
        const frames = [...document.querySelectorAll('#currentPreview > iframe[srcdoc], #nextPreview > iframe[srcdoc], #followingPreview > iframe[srcdoc]')]
        const busy = document.querySelector('iframe.preview-incoming') || frames.some((f) => { try { return f.contentDocument?.readyState !== 'complete' } catch { return false } })
        if ((!busy && s.frame) || now() - start > timeout) requestAnimationFrame(() => requestAnimationFrame(() => resolve(now())))
        else setTimeout(check, 4)
      }
      check()
    })
  })
  if (audience) await audience.evaluate(() => {
    const now = () => performance.timeOrigin + performance.now()
    const s = window.__twPerfA = { first: 0, lastFrame: 0, longTasks: [] }
    new PerformanceObserver((l) => { for (const e of l.getEntries()) s.longTasks.push([performance.timeOrigin + e.startTime, e.duration]) }).observe({ type: 'longtask', buffered: false })
    new MutationObserver(() => {
      const t = now()
      if (!s.first) s.first = t
      requestAnimationFrame(() => requestAnimationFrame(() => { s.lastFrame = now() }))
    }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class', 'data-mode-state', 'hidden'] })
    s.take = () => { const r = { first: s.first, lastFrame: s.lastFrame, longTasks: s.longTasks }; s.first = 0; s.lastFrame = 0; s.longTasks = []; return r }
  })
  const where = () => presenter.evaluate(() => {
    const t = document.querySelector('#presenterCount')?.textContent || ''
    const cur = document.querySelector('#currentPreview iframe')?.contentDocument?.querySelector('.slide')
    const kinds = cur ? [cur.querySelector('.card-gallery') && 'carousel', cur.querySelector('img') && 'image', cur.querySelector('video') && 'video', cur.dataset.role === 'section-title' && 'section', cur.querySelector('figure.slide-embed') && 'embed', cur.classList.contains('mode-active') && 'stepped'].filter(Boolean) : []
    return { count: t, kinds }
  }).catch(() => ({ count: '', kinds: [] }))
  await presenter.bringToFront()
  const procBeforeSteps = processes()
  const plan = [...Array(STEPS).fill('ArrowRight'), ...Array(BACK).fill('ArrowLeft')]
  // --trace=N: a timeline trace of the first N steps, summarised as time per event name in the deck windows' renderer
  // (no URLs, text or arguments are kept).
  const TRACE = Number(opt.trace || 0)
  let tracer = null, traceEvents = []
  if (TRACE > 0) {
    tracer = await browser.newBrowserCDPSession()
    tracer.on('Tracing.dataCollected', ({ value }) => { traceEvents.push(...value) })
    await tracer.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'v8', 'blink', 'loading'] } })
  }
  let stepNo = 0
  for (const key of plan) {
    if (tracer && stepNo++ === TRACE) {
      const done = new Promise((r) => tracer.once('Tracing.tracingComplete', r))
      await tracer.send('Tracing.end'); await done
      const byPid = {}, names = {}
      for (const e of traceEvents) if (e.ph === 'X' && e.dur) { byPid[e.pid] = (byPid[e.pid] || 0) + e.dur }
      for (const e of traceEvents) if (e.ph === 'M' && e.name === 'process_labels') names[e.pid] = 'labelled'
      const totals = {}
      for (const e of traceEvents) if (e.ph === 'X' && e.dur >= 0 && e.tid) { const k = `${e.pid}|${e.name}`; totals[k] = (totals[k] || 0) + e.dur / 1000 }
      result.trace = { steps: TRACE, top: Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 60).map(([k, ms]) => ({ pid: Number(k.split('|')[0]), name: k.split('|')[1], ms: Math.round(ms) })) }
      tracer = null
    }
    if (audience) await audience.evaluate(() => window.__twPerfA.take())
    await presenter.evaluate(() => { window.__twPerf.longTasks = [] })
    await presenter.keyboard.press(key)
    const panes = await presenter.evaluate(() => window.__twPerf.waitPanes(5000))
    await pause(GAP)
    const p = await presenter.evaluate(() => ({ key: window.__twPerf.key, frame: window.__twPerf.frame, long: window.__twPerf.longTasks }))
    const a = audience ? await audience.evaluate(() => window.__twPerfA.take()) : null
    const at = await where()
    // --shots=DIR: a picture of the three panes after every step, to compare two builds (kept out of the repo).
    if (opt.shots) {
      await pause(600)
      for (const pane of ['#currentPreview', '#nextPreview', '#followingPreview']) {
        const el = presenter.locator(pane).first()
        if (await el.isVisible().catch(() => false)) await el.screenshot({ path: `${opt.shots}/${String(result.steps.length).padStart(3, '0')}-${pane.slice(1)}.png`, animations: 'disabled' }).catch(() => {})
      }
    }
    result.steps.push({
      key: key === 'ArrowRight' ? 'next' : 'back', at: at.count, kinds: at.kinds,
      presenterFrameMs: p.frame && p.key ? Math.round(p.frame - p.key) : null,
      presenterPanesMs: p.key ? Math.round(panes - p.key) : null,
      presenterLongTaskMs: Math.round(p.long.reduce((x, [, d]) => x + d, 0)),
      audienceChangeMs: a?.first ? Math.round(a.first - p.key) : null,
      audienceFrameMs: a?.lastFrame ? Math.round(a.lastFrame - p.key) : null,
      audienceLongTaskMs: a ? Math.round(a.longTasks.reduce((x, [, d]) => x + d, 0)) : null,
    })
  }
  const procAfterSteps = processes()
  const by = (f, pick) => summary(result.steps.filter(f).map(pick))
  const all = () => true, fwd = (s) => s.key === 'next', back = (s) => s.key === 'back'
  const kinds = ['image', 'carousel', 'section', 'stepped', 'embed', 'video']
  result.measurements.steps = {
    count: result.steps.length,
    presenterFrame: { all: by(all, (s) => s.presenterFrameMs), next: by(fwd, (s) => s.presenterFrameMs), back: by(back, (s) => s.presenterFrameMs) },
    presenterPanes: { all: by(all, (s) => s.presenterPanesMs), next: by(fwd, (s) => s.presenterPanesMs), back: by(back, (s) => s.presenterPanesMs) },
    audienceFrame: { all: by(all, (s) => s.audienceFrameMs), next: by(fwd, (s) => s.audienceFrameMs), back: by(back, (s) => s.audienceFrameMs) },
    presenterLongTask: by(all, (s) => s.presenterLongTaskMs),
    audienceLongTask: by(all, (s) => s.audienceLongTaskMs),
    byKind: Object.fromEntries(kinds.map((k) => [k, { presenterPanes: by((s) => s.kinds.includes(k), (s) => s.presenterPanesMs), audienceFrame: by((s) => s.kinds.includes(k), (s) => s.audienceFrameMs) }])),
    stutters: result.steps.filter((s) => (s.presenterLongTaskMs || 0) > 100 || (s.audienceFrameMs || 0) > 100).length,
    cpuSecondsDuringSteps: { all: Math.round((procAfterSteps.all.cpuSeconds - procBeforeSteps.all.cpuSeconds) * 100) / 100, main: Math.round((procAfterSteps.main.cpuSeconds - procBeforeSteps.main.cpuSeconds) * 100) / 100, renderer: Math.round((procAfterSteps.renderer.cpuSeconds - procBeforeSteps.renderer.cpuSeconds) * 100) / 100, gpu: Math.round((procAfterSteps.gpu.cpuSeconds - procBeforeSteps.gpu.cpuSeconds) * 100) / 100 },
  }
  result.process.afterSteps = procAfterSteps
  result.memory.presenterAfter = await heapMB(presenter)
  result.memory.audienceAfter = audience ? await heapMB(audience) : null
  // Idle CPU after stepping: what the app burns while the presenter talks (10 s).
  const idle0 = processes(); await pause(10000); const idle1 = processes()
  result.measurements.idleCpuPercentWhilePresenting = { all: Math.round((idle1.all.cpuSeconds - idle0.all.cpuSeconds) * 10 * 10) / 10, renderer: Math.round((idle1.renderer.cpuSeconds - idle0.renderer.cpuSeconds) * 10 * 10) / 10, gpu: Math.round((idle1.gpu.cpuSeconds - idle0.gpu.cpuSeconds) * 10 * 10) / 10, main: Math.round((idle1.main.cpuSeconds - idle0.main.cpuSeconds) * 10 * 10) / 10 }

  // 5. Typing in the editor on this talk (second priority): key to the next painted frame, per character.
  if (TYPING > 0) {
    await presenter.close().catch(() => {})
    if (audience) await audience.close().catch(() => {})
    await main.bringToFront()
    await pause(1500)
    await main.evaluate(() => {
      const s = window.__twType = { lat: [] }
      window.addEventListener('keydown', (e) => { const k = performance.timeOrigin + e.timeStamp; requestAnimationFrame(() => requestAnimationFrame(() => s.lat.push(performance.timeOrigin + performance.now() - k))) }, true)
    })
    await main.locator('.cm-content').first().click()
    await main.keyboard.press('Meta+ArrowDown')
    await main.keyboard.press('Enter')
    for (let i = 0; i < TYPING; i++) { await main.keyboard.type('x'); await pause(60) }
    for (let i = 0; i < TYPING + 1; i++) await main.keyboard.press('Backspace')
    await pause(500)
    result.measurements.typing = summary(await main.evaluate(() => window.__twType.lat))
  }
} catch (e) {
  // Only the kind of error and where in this script it was thrown: a message can carry a talk's
  // title or a path, and this file is meant to be safe to keep.
  const where = String(e?.stack || '').match(/presenting-path\.mjs:(\d+)/)
  result.errors.push(`${/^[A-Za-z]+$/.test(String(e?.name)) ? e.name : 'Error'} at presenting-path.mjs:${where ? where[1] : '?'}`)
  console.error('run failed (the message is not saved):', e?.message || e)
} finally {
  mkdirSync(dirname(resolve(opt.out)), { recursive: true })
  writeFileSync(resolve(opt.out), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ label: result.label, measurements: result.measurements, memory: result.memory, process: result.process, errors: result.errors }, null, 1))
  await browser.close().catch(() => {})
}

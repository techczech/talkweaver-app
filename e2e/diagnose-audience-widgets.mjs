// Simulation widgets in the AUDIENCE window of a real presentation (owner report, 12 Nov 2026, on
// 0.44.0: "some of the widgets did not show up in the presentation audience window until I
// expanded them full screen"). TalkWeaver's own talk:present opens the presenter window from a
// scratch vault holding a neutral talk with ten `[Simulation: widgets/…]` pages, and the
// presenter's Audience button opens the audience window, as F5 does. Both windows are shown.
//
// For every widget slide (and its reveal step or carousel card) the audience window is checked
// WITHOUT any interaction: the figure is live, the page in its frame has loaded and is running
// (its requestAnimationFrame counter moves), and the pixels the window composites at the frame's
// centre are the widget's own colour (webContents.capturePage: what the window really shows).
// Varied: first visit and revisit, quick stepping, the audience window hidden or minimised when
// the slide arrives, and two audience sizes.
//
// Run: npm run test:audience-widgets:e2e   (SCEN=first-visit,fullscreen,... picks scenarios; TW_REPO=<other checkout with a build> to run that
// build; SHOTS=<dir> keeps the audience captures; scratch user data and vault under the OS temp dir)
import { _electron as electron } from 'playwright'
import sharp from 'sharp'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = process.env.TW_REPO ? resolve(process.env.TW_REPO) : join(__dirname, '..')
const SHOTS = process.env.SHOTS ? resolve(process.env.SHOTS) : null
if (SHOTS) mkdirSync(SHOTS, { recursive: true })
const HARD_LIMIT_MS = Number(process.env.TW_LIMIT_MS || 800000)
const killer = setTimeout(() => { console.error(`[audience-widgets] hard limit ${HARD_LIMIT_MS} ms reached`); process.exit(2) }, HARD_LIMIT_MS)
const log = (...a) => console.log('[audience-widgets]', ...a)

// ── The neutral talk ────────────────────────────────────────────────────────────────────────────
const page = (name, color, body = '', script = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title><style>html,body{margin:0;height:100%;background:${color};font:32px system-ui;color:#fff}</style></head><body><div id="mark">${name}</div>${body}<script>window.__w={name:${JSON.stringify(name)},raf:0,drawn:false};(function t(){__w.raf++;requestAnimationFrame(t)})();${script}</script></body></html>`
// A canvas that fills the page's viewport as the page measures it, painted once unless told otherwise.
const canvasPage = (name, color, start) => `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title><style>html,body{margin:0;height:100%;background:#fff;overflow:hidden}canvas{display:block}</style></head><body><canvas id="c"></canvas><script>window.__w={name:${JSON.stringify(name)},raf:0,drawn:false,resizes:0,io:[],atScript:[innerWidth,innerHeight],atPaint:null};(function t(){__w.raf++;requestAnimationFrame(t)})();const cv=document.getElementById("c");function size(){cv.width=innerWidth;cv.height=innerHeight}function paint(){const g=cv.getContext("2d");g.fillStyle=${JSON.stringify(color)};g.fillRect(0,0,cv.width,cv.height);__w.atPaint=[cv.width,cv.height];__w.drawn=cv.width>0&&cv.height>0}${start}</script></body></html>`
const WIDGETS = {
  'static.html': page('static', 'rgb(200, 30, 30)', '', '__w.drawn=true'),
  'anim.html': page('anim', 'rgb(30, 160, 60)', '<canvas id="c" width="300" height="150"></canvas>', 'const c=document.getElementById("c").getContext("2d");let x=0;(function d(){c.clearRect(0,0,300,150);c.fillStyle="#fff";c.fillRect(x%300,50,30,30);x+=4;__w.drawn=true;requestAnimationFrame(d)})()'),
  'click.html': page('click', 'rgb(30, 60, 200)', '<button id="b">Press</button><output id="n">0</output>', '__w.drawn=true;document.getElementById("b").onclick=()=>{const o=document.getElementById("n");o.textContent=Number(o.textContent)+1}'),
  'slow.html': `<!doctype html><html><head><meta charset="utf-8"><title>slow</title><style>html,body{margin:0;height:100%;background:#fff}</style></head><body><script>window.__w={name:"slow",raf:0,drawn:false};(function t(){__w.raf++;requestAnimationFrame(t)})();setTimeout(()=>{document.body.style.background="rgb(220, 140, 20)";document.body.textContent="slow";__w.drawn=true},1200)</script></body></html>`,
  'adj a.html': page('adj a', 'rgb(140, 30, 160)', '', '__w.drawn=true'),
  'adj-ü.html': page('adj-ü', 'rgb(20, 150, 150)', '', '__w.drawn=true'),
  // Behind a reveal step and in a carousel card shown later: sized once, at start-up.
  'reveal.html': canvasPage('reveal', 'rgb(160, 120, 20)', 'size();paint()'),
  'card.html': canvasPage('card', 'rgb(90, 90, 200)', 'size();paint()'),
  'from.html': page('from', 'rgb(200, 60, 140)', '', '__w.drawn=true'),
  'big widget é.html': page('big', 'rgb(40, 110, 200)', '<div style="width:1800px;height:1200px;border:8px solid #fff">big</div>', '__w.drawn=true'),
  // Start-up styles of real interactive pages. Each paints its colour only through its own code.
  'canvas-once.html': canvasPage('canvas-once', 'rgb(250, 100, 0)', 'size();paint()'),
  'canvas-resize.html': canvasPage('canvas-resize', 'rgb(0, 120, 90)', 'size();paint();addEventListener("resize",()=>{__w.resizes++;size();paint()})'),
  'observer.html': canvasPage('observer', 'rgb(120, 0, 200)', 'new IntersectionObserver((es)=>{__w.io.push(es.map(e=>e.isIntersecting?1:0).join(""));if(es.some(e=>e.isIntersecting)){size();paint()}}).observe(document.body)'),
  'visible-only.html': canvasPage('visible-only', 'rgb(200, 0, 90)', 'const go=()=>{if(document.visibilityState==="visible"){size();paint()}};go();document.addEventListener("visibilitychange",go)'),
  'raf-start.html': canvasPage('raf-start', 'rgb(0, 90, 200)', 'requestAnimationFrame(()=>{size();paint()})'),
  'focus-self.html': canvasPage('focus-self', 'rgb(90, 140, 0)', 'size();paint();const i=document.createElement("input");document.body.appendChild(i);i.focus();addEventListener("load",()=>{i.focus();window.focus()})'),
  'onload-measure.html': canvasPage('onload-measure', 'rgb(160, 60, 0)', 'addEventListener("load",()=>{size();paint()})'),
}
const COLOR = { 'w-static': [200, 30, 30], 'w-anim': [30, 160, 60], 'w-click': [30, 60, 200], 'w-slow': [220, 140, 20], 'w-adj-a': [140, 30, 160], 'w-adj-b': [20, 150, 150], 'w-reveal': [160, 120, 20], 'w-carousel': [90, 90, 200], 'w-from': [200, 60, 140], 'w-big': [40, 110, 200], 'w-canvas-once': [250, 100, 0], 'w-canvas-resize': [0, 120, 90], 'w-observer': [120, 0, 200], 'w-visible-only': [200, 0, 90], 'w-raf-start': [0, 90, 200], 'w-focus-self': [90, 140, 0], 'w-onload-measure': [160, 60, 0] }
const OUTLINE = `---
title: Widget check
auto_title_slide: false
auto_thanks_slide: false
---

### Opening {id=open}

- A plain slide first

### Static widget {id=w-static}

[Simulation: widgets/static.html]

### Animated widget {id=w-anim}

[Simulation: widgets/anim.html]

### Click widget {id=w-click}

- Words beside the widget

[Simulation: widgets/click.html]

### Slow widget {id=w-slow}

[Simulation: widgets/slow.html]

### Adjacent A {id=w-adj-a}

[Simulation: widgets/adj a.html]

### Adjacent B {id=w-adj-b}

[Simulation: widgets/adj-ü.html]

### Behind a reveal step {id=w-reveal}
{reveal}

- First point
- Second point

[Simulation: widgets/reveal.html]

### Carousel {id=w-carousel}
{carousel}

#### Card one

- Card one text

#### Card two

[Simulation: widgets/card.html]

### Copied slide {id=w-from} {from=another-talk#copied}

[Simulation: widgets/from.html]

### Big widget {id=w-big}

[Simulation: widgets/big widget é.html]

### Canvas sized once {id=w-canvas-once}

[Simulation: widgets/canvas-once.html]

### Canvas that follows resizes {id=w-canvas-resize}

[Simulation: widgets/canvas-resize.html]

### Starts when seen {id=w-observer}

[Simulation: widgets/observer.html]

### Starts when the document is visible {id=w-visible-only}

[Simulation: widgets/visible-only.html]

### Starts in an animation frame {id=w-raf-start}

[Simulation: widgets/raf-start.html]

### Focuses itself {id=w-focus-self}

[Simulation: widgets/focus-self.html]

### Measures at load {id=w-onload-measure}

[Simulation: widgets/onload-measure.html]

### End {id=end}

- Done
`
const ORDER = ['open', 'w-static', 'w-anim', 'w-click', 'w-slow', 'w-adj-a', 'w-adj-b', 'w-reveal', 'w-carousel', 'w-from', 'w-big', 'w-canvas-once', 'w-canvas-resize', 'w-observer', 'w-visible-only', 'w-raf-start', 'w-focus-self', 'w-onload-measure', 'end']
const WIDGET_SLIDES = ORDER.filter((id) => id.startsWith('w-'))

const root = mkdtempSync(join(tmpdir(), 'tw-e2e-audience-widgets-'))
const vault = join(root, 'vault')
const userData = join(root, 'userData')
const talkDir = join(vault, 'widget-check')
const outlinePath = join(talkDir, 'widget-check-outline.md')
mkdirSync(join(talkDir, 'widgets'), { recursive: true })
mkdirSync(userData, { recursive: true })
for (const [name, html] of Object.entries(WIDGETS)) writeFileSync(join(talkDir, 'widgets', name), html)
writeFileSync(outlinePath, OUTLINE, 'utf8')
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2), 'utf8')

const results = []
const record = (scenario, slide, ok, detail) => { results.push({ scenario, slide, ok, detail }); log(`${ok ? 'PASS' : 'FAIL'} ${scenario} ${slide}: ${detail}`) }

if (!process.env.TW_REPO) await ensureFreshBuild(REPO)
log('repo', REPO)
const app = await electron.launch({ args: ['.', '--user-data-dir=' + userData], cwd: REPO, env: { ...process.env, TW_E2E: '1' }, timeout: 60000 })
const errors = []
let exitCode = 1
try {
  const main = await app.firstWindow()
  await main.waitForLoadState('domcontentloaded')
  await main.waitForTimeout(1200)
  const content = readFileSync(outlinePath, 'utf8')
  const opened = app.waitForEvent('window')
  const result = await main.evaluate(({ p, c }) => window.tw.talk.present(p, c, 'presenter'), { p: outlinePath, c: content })
  if (!result?.success) throw new Error(`present failed: ${JSON.stringify(result)}`)
  const presenter = await opened
  presenter.on('pageerror', (e) => errors.push(`presenter: ${e.message}`))
  await presenter.waitForLoadState('domcontentloaded')
  await presenter.waitForSelector('#currentPreview iframe', { timeout: 20000 })
  const audienceOpened = app.waitForEvent('window')
  await presenter.evaluate(() => document.getElementById('presenterAudienceApp')?.click())
  const audience = await audienceOpened
  audience.on('pageerror', (e) => errors.push(`audience: ${e.message}`))
  audience.on('console', (m) => { if (/embed|widget/i.test(m.text())) log('audience console:', m.text()) })
  await audience.waitForLoadState('domcontentloaded')
  await presenter.waitForTimeout(1500)
  log('windows open')

  // Main-process helpers: the deck windows by role, shown as a real presentation shows them.
  const win = (role, fn, arg) => app.evaluate(({ BrowserWindow }, { role, fn, arg }) => {
    const w = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes(role + '=1'))
    if (!w) return null
    // eslint-disable-next-line no-new-func
    return new Function('w', 'arg', fn)(w, arg)
  }, { role, fn, arg })
  await win('presenter', 'w.setBounds({ x: 0, y: 0, width: 1470, height: 920 }); w.show(); w.focus(); return w.getBounds()')
  await win('audience', 'w.setBounds({ x: 40, y: 40, width: arg.w, height: arg.h }); w.showInactive(); return w.getBounds()', { w: 1280, h: 760 })
  await presenter.waitForTimeout(800)
  const capture = async () => {
    const b64 = await win('audience', 'return w.webContents.capturePage().then((img) => ({ png: img.toPNG().toString("base64"), size: img.getSize() }))')
    return b64
  }
  const go = async (id) => { await presenter.evaluate((id) => { location.hash = id }, id) }
  const press = (key = 'ArrowRight') => presenter.keyboard.press(key)

  // What the audience window shows now for its active slide's local pages.
  async function inspect(scenario, slideId, { settle = 1500, expectFrames = 1 } = {}) {
    await audience.waitForTimeout(settle)
    const state = await audience.evaluate(() => {
      const slide = document.querySelector('.slide.active')
      const frames = [...(slide?.querySelectorAll('figure.slide-embed[data-embed="local"] > iframe') || [])]
      return {
        slide: slide?.dataset.id || null,
        hidden: document.visibilityState,
        dpr: devicePixelRatio,
        frames: frames.map((f) => {
          const r = f.getBoundingClientRect()
          const fig = f.closest('figure')
          const cs = getComputedStyle(f)
          return { state: fig.getAttribute('data-embed-state'), stopped: fig.hasAttribute('data-embed-stopped'), srcdoc: f.hasAttribute('srcdoc'), x: r.left, y: r.top, w: r.width, h: r.height, vis: cs.visibility, display: cs.display, inCard: Boolean(f.closest('.card')), cardShown: f.closest('.card') ? f.closest('.card').checkVisibility() : null }
        }),
      }
    })
    const handles = await audience.$$('.slide.active figure.slide-embed[data-embed="local"] > iframe')
    const shot = await capture()
    const png = shot ? Buffer.from(shot.png, 'base64') : null
    let raw = null, info = null
    if (png) ({ data: raw, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true }))
    if (SHOTS && png) writeFileSync(join(SHOTS, `${scenario}-${slideId}.png`.replace(/[^a-z0-9.-]+/gi, '_')), png)
    const want = COLOR[slideId]
    const shown = []
    for (let i = 0; i < state.frames.length; i++) {
      const f = state.frames[i]
      let doc = null
      try {
        const cf = await handles[i]?.contentFrame()
        if (cf) {
          const a = await cf.evaluate(() => window.__w ? { ...window.__w, ready: document.readyState, vis: document.visibilityState } : { none: true, ready: document.readyState, url: location.href })
          await audience.waitForTimeout(250)
          const b = await cf.evaluate(() => window.__w ? window.__w.raf : -1)
          doc = { ...a, rafMoved: b > a.raf }
        }
      } catch (e) { doc = { error: String(e.message).slice(0, 80) } }
      // Pixels at a point a little inside the frame's top-left (the widget text sits at its very top left).
      let pixel = null
      if (raw && f.w > 4 && f.h > 4) {
        const scale = info.width / (await audience.evaluate(() => innerWidth))
        const px = Math.round((f.x + Math.min(f.w - 2, Math.max(2, f.w * 0.7))) * scale)
        const py = Math.round((f.y + Math.min(f.h - 2, Math.max(2, f.h * 0.7))) * scale)
        if (px >= 0 && py >= 0 && px < info.width && py < info.height) {
          const o = (py * info.width + px) * info.channels
          pixel = [raw[o], raw[o + 1], raw[o + 2]]
        }
      }
      const painted = Boolean(pixel && want && pixel.every((v, k) => Math.abs(v - want[k]) < 40))
      shown.push({ ...f, doc, pixel, painted })
    }
    // The presenter's Current pane copy, for comparison (not part of the verdict).
    let pane = null
    try {
      const ph = await presenter.$('#currentPreview > iframe.live-sim-frame[data-embed-local]')
      const pf = ph && await ph.contentFrame()
      pane = pf ? await pf.evaluate(() => window.__w ? { drawn: window.__w.drawn, atScript: window.__w.atScript, resizes: window.__w.resizes } : null) : null
    } catch (e) { pane = { error: String(e.message).slice(0, 60) } }
    const ok = state.slide === slideId && shown.length >= expectFrames && shown.every((s) => s.state === 'live' && s.doc && s.doc.drawn && s.doc.rafMoved && s.painted)
    record(scenario, slideId, ok, JSON.stringify({ active: state.slide, vis: state.hidden, frames: shown.map((s) => ({ state: s.state, stopped: s.stopped, box: [Math.round(s.x), Math.round(s.y), Math.round(s.w), Math.round(s.h)], css: s.vis, doc: s.doc && (s.doc.error || s.doc.none ? s.doc : { drawn: s.doc.drawn, raf: s.doc.raf, moved: s.doc.rafMoved, vis: s.doc.vis, atScript: s.doc.atScript, atPaint: s.doc.atPaint, resizes: s.doc.resizes, io: s.doc.io }), pixel: s.pixel, painted: s.painted })), pane }))
    return ok
  }

  // Walk the talk with Next presses from the opening slide, inspecting each widget slide after
  // the presses that show its widget (the reveal slide's page shows on its last step; the
  // carousel's on its second card).
  async function walk(scenario, { settle = 1500, before = null } = {}) {
    await go('open'); await presenter.waitForTimeout(800)
    const seen = new Set()
    for (let guard = 0; guard < 40; guard++) {
      if (before) await before()
      await press()
      await presenter.waitForTimeout(80)
      const now = await audience.evaluate(() => document.querySelector('.slide.active')?.dataset.id)
      if (now === 'end') break
      if (!now?.startsWith('w-') || seen.has(now)) continue
      // The widget is on screen: not in a carousel card that is not shown, not a reveal unit still hidden.
      const shown = await audience.evaluate(() => {
        const frame = document.querySelector('.slide.active figure.slide-embed > iframe')
        return Boolean(frame && frame.checkVisibility() && !frame.closest('.hidden-fragment, [data-mode-state="hidden"]'))
      })
      if (!shown) continue
      seen.add(now)
      await inspect(scenario, now, { settle })
    }
    const missed = WIDGET_SLIDES.filter((id) => !seen.has(id))
    if (missed.length) record(scenario, 'walk', false, `never reached with the widget shown: ${missed.join(', ')}`)
  }

  // SCEN=<comma list> picks scenarios (default: all).
  const SCEN = (process.env.SCEN || 'first-visit,revisit,quick-steps,hidden,minimised,covered,sizes,fullscreen').split(',')
  const want = (name) => SCEN.includes(name)
  if (want('first-visit')) await walk('first-visit')
  if (want('revisit')) await walk('revisit')
  if (want('quick-steps')) {

  // Quick stepping: Next every 150 ms through to the big widget, then look.
  await go('open'); await presenter.waitForTimeout(800)
  for (let i = 0; i < 40; i++) {
    await press(); await presenter.waitForTimeout(150)
    if ((await audience.evaluate(() => document.querySelector('.slide.active')?.dataset.id)) === 'w-big') break
  }
  await inspect('quick-steps', 'w-big')
  }

  // The audience window hidden when the slide arrives, then shown again (no interaction).
  for (const id of want('hidden') ? ['w-static', 'w-anim', 'w-observer', 'w-visible-only'] : []) {
    await go('open'); await presenter.waitForTimeout(600)
    await win('audience', 'w.hide()')
    await go(id); await presenter.waitForTimeout(1200)
    await win('audience', 'w.showInactive()')
    await inspect('arrived-while-hidden', id)
  }
  // Minimised when the slide arrives.
  for (const id of want('minimised') ? ['w-adj-a', 'w-adj-b', 'w-raf-start'] : []) {
    await go('open'); await presenter.waitForTimeout(600)
    await win('audience', 'w.minimize()')
    await go(id); await presenter.waitForTimeout(1200)
    await win('audience', 'w.restore(); w.showInactive()')
    await inspect('arrived-while-minimised', id)
  }
  // Covered by the presenter window when the slide arrives.
  for (const id of want('covered') ? ['w-from', 'w-click', 'w-canvas-once'] : []) {
    await go('open'); await presenter.waitForTimeout(600)
    await win('presenter', 'w.setBounds({ x: 0, y: 0, width: 1500, height: 960 }); w.moveTop(); w.focus()')
    await go(id); await presenter.waitForTimeout(1500)
    await win('audience', 'w.moveTop()')
    await inspect('arrived-while-covered', id)
  }

  // A small audience window, and a large one.
  for (const [w, h] of want('sizes') ? [[800, 480], [1500, 940]] : []) {
    await win('audience', 'w.setBounds({ x: 10, y: 10, width: arg.w, height: arg.h }); w.showInactive()', { w, h })
    await walk(`size-${w}x${h}`, { settle: 1200 })
  }

  // Why expanding made a page appear (not in the default set: SCEN=expand). On the slide of a page
  // that follows resizes, look, then press Z in the presenter (Embedded page: full screen) and
  // look at the page in the audience window again: its size at start, its resize count, its paint.
  if (process.env.SCEN && want('expand')) {
    // Arrive by Next, as when presenting (a jump by address loads the page later, and often in time).
    await go('w-canvas-once'); await presenter.waitForTimeout(1200)
    await press(); await presenter.waitForTimeout(1500)
    const read = async () => {
      const cf = await (await audience.$('.slide.active figure.slide-embed[data-embed="local"] > iframe'))?.contentFrame()
      return cf ? cf.evaluate(() => ({ atScript: __w.atScript, atPaint: __w.atPaint, resizes: __w.resizes, drawn: __w.drawn })) : null
    }
    const before = await read()
    await presenter.keyboard.press('z'); await presenter.waitForTimeout(1500)
    const expanded = await audience.evaluate(() => document.querySelector('.slide.active')?.classList.contains('embed-full-screen'))
    const after = await read()
    record('expand', 'w-canvas-resize', Boolean(expanded && after?.drawn), JSON.stringify({ before, expanded, after }))
    await presenter.keyboard.press('Escape'); await presenter.waitForTimeout(600)
  }

  // As the app does with a second display: the audience window in native full screen (on one
  // display that is its own Space, so the presenter window is then not on screen).
  if (want('fullscreen')) {
    await go('open'); await presenter.waitForTimeout(600)
    await win('audience', 'w.setFullScreen(true)')
    await presenter.waitForTimeout(2500)
    log('audience bounds in full screen', JSON.stringify(await win('audience', 'return [w.isFullScreen(), w.getBounds()]')))
    await walk('fullscreen', { settle: 1500 })
    await win('audience', 'w.setFullScreen(false)')
    await presenter.waitForTimeout(1500)
  }

  const failed = results.filter((r) => !r.ok)
  log(`${results.length - failed.length}/${results.length} passed`)
  for (const f of failed) log('FAILED', f.scenario, f.slide)
  if (errors.length) log('page errors:\n' + errors.join('\n'))
  exitCode = failed.length || errors.length ? 1 : 0
} catch (error) {
  console.error(error)
} finally {
  // Bounded: closing the app with a presentation open can hang; then its process is ended.
  const closed = await Promise.race([app.close().then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), 15000))])
  if (!closed) { log('app did not close in 15 s; ending its process'); try { app.process().kill('SIGKILL') } catch { /* gone */ } }
  rmSync(root, { recursive: true, force: true })
  clearTimeout(killer)
}
process.exit(exitCode)

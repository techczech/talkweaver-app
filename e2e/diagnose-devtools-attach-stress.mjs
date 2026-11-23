// Stress probe for the Chromium CHECK in DevToolsAgentHostImpl::NotifyCreated (FrameAutoAttacher::
// DidFinishNavigation -> RenderFrameDevToolsAgentHost), seen once in a laptop e2e run (Electron 42.11.16).
// The hidden thumbnail window holds one Electron debugger session with Target.setAutoAttach
// (src/main/capture-network.ts). This drives the real thumbnail queue (src/main/thumbnails.ts) through
// rapid talk switches that cancel or supersede capture mid-navigation, and counts main-process crashes.
//   --mode app         Electron started directly: no Playwright, no remote debugging port (the app alone).
//   --mode playwright  Electron started by Playwright, which also auto-attaches to every target.
//   --iterations N     renders in total (default 400); --chunk M renders per Electron launch (default 100).
// Not in a test tier: it is a diagnostic. Exit 0 when no launch crashed; 1 otherwise.
import { _electron as electron } from 'playwright'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { testProfileEnv } from './lib/test-profile.mjs'

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback }
const mode = arg('mode', 'app')
const total = Number(arg('iterations', '400'))
const chunk = Number(arg('chunk', '100'))
const launchLimitMs = Number(arg('launch-timeout-ms', String(15 * 60_000)))
if (!['app', 'playwright'].includes(mode)) throw Error(`--mode app|playwright, not ${mode}`)
const scratch = mkdtempSync(join(tmpdir(), `tw-devtools-stress-${mode}-`))
console.log(`[stress] mode=${mode} iterations=${total} chunk=${chunk} scratch=${scratch}`)

// Widgets with out-of-process children: local embeds are sandboxed + credentialless frames, and each
// widget keeps navigating its own children (srcdoc swaps, data: and about:blank loads) while captured.
const widget = (n) => `<!doctype html><html><body style="margin:0;background:hsl(${n * 70},60%,70%)">
<h1 id="content">Widget ${n}</h1>
<iframe id="a" srcdoc="<p>a0</p>" width="200" height="80"></iframe>
<iframe id="b" src="data:text/html,<p>b0</p>" width="200" height="80"></iframe>
<iframe id="c" sandbox="allow-scripts" srcdoc="<iframe srcdoc='<p>deep</p>'></iframe>" width="200" height="80"></iframe>
<script>
let k = 0
setInterval(() => {
  k++
  document.getElementById('a').srcdoc = '<p>a' + k + '</p>'
  document.getElementById('b').src = k % 2 ? 'about:blank' : 'data:text/html,<p>b' + k + '</p>'
  if (k % 3 === 0) document.getElementById('c').srcdoc = "<iframe srcdoc='<p>deep " + k + "</p>'></iframe>"
}, 12)
</script></body></html>`
const decks = []
for (let d = 0; d < 3; d++) {
  const dir = join(scratch, `talk-${d}`)
  mkdirSync(dir, { recursive: true })
  let outline = `---\ntitle: Stress ${d}\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n`
  for (let s = 0; s < 4; s++) {
    writeFileSync(join(dir, `w${s}.html`), widget(d * 4 + s))
    outline += `### Slide ${d}.${s}\n{id=s${s}}\n\n[Embed: w${s}.html]\n\n`
  }
  const source = join(dir, 'outline.md')
  writeFileSync(source, outline)
  const model = await prepareSource(source, outline, null, statSync(source))
  const frames = (model.fullHtml.match(/<iframe\b/g) || []).length
  console.log(`[stress] deck ${d}: ${model.fullHtml.length} bytes, ${frames} iframe tags`)
  if (frames < 4) throw Error(`deck ${d} has ${frames} iframes; the probe needs embedded widgets`)
  decks.push({ fullHtml: model.fullHtml, slides: [0, 1, 2, 3].map((index) => ({ key: `s${index}`, index })) })
}
const decksFile = join(scratch, 'decks.json')
writeFileSync(decksFile, JSON.stringify(decks))

// The probe runs the loop itself inside the main process, so the app-only arm needs no driver at all.
const entry = join(scratch, 'probe.cjs')
await build({
  stdin: {
    resolveDir: process.cwd(),
    contents: `
import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderThumbnails, cancelThumbnailRender, recycleRenderWindow } from ${JSON.stringify(resolve('src/main/thumbnails.ts'))}
app.on('window-all-closed', () => {})
// Evidence that the path ran: hidden windows made, child targets auto-attached, child-frame commits, pictures.
const counts = { windows: 0, attached: {}, childCommits: 0, mainLoads: 0, pictures: 0, cancelledOrEmpty: 0 }
app.on('web-contents-created', (_e, wc) => {
  counts.windows++
  wc.debugger.on('message', (_ev, method, params) => {
    if (method === 'Target.attachedToTarget') { const t = params.targetInfo?.type || '?'; counts.attached[t] = (counts.attached[t] || 0) + 1 }
  })
  wc.on('did-frame-navigate', (_ev, _url, _code, _text, isMainFrame) => { if (isMainFrame) counts.mainLoads++; else counts.childCommits++ })
})
const decks = JSON.parse(readFileSync(process.env.TW_STRESS_DECKS, 'utf8'))
const start = Number(process.env.TW_STRESS_START), end = Number(process.env.TW_STRESS_END)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
app.whenReady().then(async () => {
  let outstanding = []
  for (let i = start; i < end; i++) {
    const deck = decks[i % decks.length], key = 'stress:' + (i % 2)
    const run = renderThumbnails({ fullHtml: deck.fullHtml, slides: deck.slides, requestKey: key,
      cacheDir: join(process.env.TW_STRESS_SCRATCH, 'cache', String(i)) })
      .then((r) => { const n = Object.keys(r).length; counts.pictures += n; if (!n) counts.cancelledOrEmpty++; return r }, (e) => ({ error: String(e) }))
    outstanding.push(run)
    const plan = i % 5
    if (plan === 0) { await wait(Math.random() * 40); cancelThumbnailRender(key) }          // switch during the load
    else if (plan === 1) { await wait(40 + Math.random() * 400); cancelThumbnailRender(key) } // switch during capture
    else if (plan === 2) { await wait(Math.random() * 60) }                                   // next talk queues behind it
    else if (plan === 3) { await wait(Math.random() * 25); cancelThumbnailRender('stress:0'); cancelThumbnailRender('stress:1') }
    else { await run }                                                                        // one runs to the end
    if (outstanding.length >= 3) { await Promise.allSettled(outstanding); outstanding = [] }
    if (i % 37 === 36) { await Promise.allSettled(outstanding); outstanding = []; recycleRenderWindow() }
    process.stdout.write('STRESS iter=' + i + '\\n')
  }
  await Promise.allSettled(outstanding)
  process.stdout.write('STRESS counts ' + JSON.stringify(counts) + '\\n')
  process.stdout.write('STRESS done\\n')
  app.exit(0)
})
`
  },
  outfile: entry, bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'sharp'], logLevel: 'silent'
})

const electronPath = createRequire(import.meta.url)('electron')
const launches = []
let next = 0
while (next < total) {
  const end = Math.min(total, next + chunk)
  const profile = join(scratch, `profile-${next}`)
  const env = { ...process.env, TW_E2E: '1', ...testProfileEnv(profile), TW_STRESS_DECKS: decksFile, TW_STRESS_SCRATCH: scratch,
    TW_STRESS_START: String(next), TW_STRESS_END: String(end) }
  delete env.ELECTRON_RUN_AS_NODE
  const args = [entry, `--user-data-dir=${profile}`]
  let child, pwApp
  if (mode === 'app') child = spawn(electronPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
  else { pwApp = await electron.launch({ args, env }); child = pwApp.process() }
  let last = next - 1, done = false, tail = '', counts = null
  child.stdout.on('data', (b) => {
    const text = b.toString()
    for (const m of text.matchAll(/STRESS (iter=(\d+)|done)/g)) { if (m[2]) last = Number(m[2]); else done = true }
    const c = text.match(/STRESS counts (\{.*\})/); if (c) counts = JSON.parse(c[1])
  })
  child.stderr.on('data', (b) => { tail = (tail + b.toString()).slice(-4000) })
  const exit = await new Promise((r) => {
    const timer = setTimeout(() => { r({ code: null, signal: 'TIMEOUT' }); child.kill('SIGKILL') }, launchLimitMs)
    child.on('exit', (code, signal) => { clearTimeout(timer); r({ code, signal }) })
  })
  await pwApp?.close().catch(() => {})
  const crashed = !(done && exit.code === 0)
  const record = { pid: child.pid, from: next, to: end, lastIteration: last, done, ...exit, crashed, counts }
  launches.push(record)
  console.log(`[stress] launch ${JSON.stringify(record)}`)
  if (crashed) console.log(`[stress] stderr tail:\n${tail}`)
  // A crash ends that launch; the next one carries on after the last finished iteration.
  next = crashed ? Math.max(last + 1, next + 1) : end
}
const crashes = launches.filter((l) => l.crashed)
const summary = { mode, iterations: total, launches: launches.length, crashes: crashes.length, crashPids: crashes.map((l) => l.pid), launchPids: launches.map((l) => l.pid) }
writeFileSync(join(scratch, 'summary.json'), JSON.stringify({ summary, launches }, null, 2))
console.log(`[stress] SUMMARY ${JSON.stringify(summary)}`)
// A crash keeps the scratch folder (decks, profiles, summary.json) for inspection; a clean run removes it.
if (crashes.length) process.exitCode = 1
else rmSync(scratch, { recursive: true, force: true })

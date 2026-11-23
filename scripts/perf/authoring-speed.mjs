#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { cpus, release, totalmem } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { scratchVault } from '../../e2e/lib/scratch-vault.mjs'
import { ensureTalksMode } from '../../e2e/lib/talklist.mjs'

const repo = realpathSync(fileURLToPath(new URL('../..', import.meta.url)))
const [outputArg, samplesArg = '20', ...flags] = process.argv.slice(2)
const samples = Number(samplesArg)
const profile = flags.includes('--profile')
const buildHeadArg = flags.find(flag => flag.startsWith('--build-head='))
assert.ok(outputArg && Number.isInteger(samples) && samples > 0 &&
  flags.every(flag => flag === '--profile' || /^--build-head=[0-9a-f]{40}$/.test(flag)),
  'Usage: node scripts/perf/authoring-speed.mjs OUTPUT.json [SAMPLES_PER_SIZE] [--profile] [--build-head=SHA]')
const output = resolve(outputArg)
const build = readFileSync(join(repo, 'out/renderer/index.html'), 'utf8')
assert.ok(build.includes('./assets/'), 'Run npm run build first. The benchmark launches the production bundles.')
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version
const bundleHash = createHash('sha256').update(build).update(readFileSync(join(repo, 'out/main/index.js'))).digest('hex')
let stagedBuildHead
try { stagedBuildHead = readFileSync(join(repo, 'out/.authoring-speed-build-head'), 'utf8').trim() } catch { /* local build */ }
const buildHead = buildHeadArg?.slice('--build-head='.length) ??
  (/^[0-9a-f]{40}$/.test(stagedBuildHead ?? '') ? stagedBuildHead : head)
// Keep finished pairs if the runner or optional profiler stops partway through. A completed
// report or a different bundle starts a fresh round.
let checkpoint
try { checkpoint = JSON.parse(readFileSync(output, 'utf8')) } catch { /* first run */ }
const completed = checkpoint?.complete === false && checkpoint.bundleHash === bundleHash &&
  checkpoint.samplesPerSize === samples && Array.isArray(checkpoint.cases)
  ? checkpoint.cases.filter(record => record.complete) : []
const report = {
  harnessHead: head, buildHead,
  bundleHash, complete: false, version, samplesPerSize: samples,
  host: { platform: process.platform, arch: process.arch, os: release(), cpu: cpus()[0]?.model,
    logicalCores: cpus().length, memoryGiB: Math.round(totalmem() / 2 ** 30), node: process.version },
  cases: completed, summary: {}
}
mkdirSync(dirname(output), { recursive: true })
const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
const now = () => performance.timeOrigin + performance.now()
const timeout = 30_000
const editable = '[data-view="slide"] .cm-content[contenteditable="true"]'
const row = slug => `.tl-tree [data-talk-slug="${slug}"]`
const views = { slide: editable, grid: '[data-view="grid"] .grid-section-cells [data-slide-index]',
  outline: '[data-view="outline"] .cm-content[contenteditable="true"]',
  markdown: '[data-view="markdown"] .cm-content[contenteditable="true"]' }
const meta = process.platform === 'darwin' ? 'Meta' : 'Control'
const marker = size => `Evidence for deck ${size}`
const slug = size => `speed-${size}`

function fixtures(root) {
  const profileDir = join(root, 'profile')
  const home = join(root, 'home')
  const vault = join(root, 'vault')
  for (const dir of [profileDir, home, vault]) mkdirSync(dir)
  const talks = {}
  for (const size of [30, 300]) {
    const dir = join(vault, slug(size))
    mkdirSync(dir)
    for (let picture = 0; picture < 12; picture++) {
      copyFileSync(join(repo, 'demo-vault/layout-sampler/assets/sample-image.png'), join(dir, `picture-${picture}.png`))
    }
    const lines = ['---', 'outline_version: 2', `title: Synthetic talk ${size}`, 'auto_title_slide: false',
      'auto_thanks_slide: false', 'defaults:', '  title: top', '---', '']
    for (let index = 0; index < size; index++) {
      if (index > 0 && index % 10 === 0) lines.push(`## Section ${index / 10 + 1}`, `{id=section-${index}}`, '')
      lines.push(`### Synthetic finding ${index + 1}`, `{id=finding-${index + 1}}`, '',
        `- ${marker(size)} at station ${index + 1}.`, '- Record the observation and compare results.',
        '- Check the next observation in the series.', '', `![Synthetic illustration](picture-${index % 12}.png)`, '')
    }
    const text = lines.join('\n') + '\n'
    const path = join(dir, `${slug(size)}-outline.md`)
    writeFileSync(path, text)
    talks[size] = { path, text }
  }
  writeFileSync(join(profileDir, 'config.json'), JSON.stringify({
    vaultRoot: vault, windowBounds: { width: 1400, height: 900 }, openInView: 'slide'
  }))
  return { profileDir, home, talks }
}

async function until(check, label, limit = timeout) {
  const deadline = now() + limit
  while (now() < deadline) {
    const value = await check()
    if (value) return value
    await delay(15)
  }
  throw Error(`Timed out waiting for ${label}`)
}

// Finish on the first frame after the target became visible. The hidden app cannot prove display latency.
async function ready(page, selector, text = '', image = false, limit = timeout) {
  const handle = await page.waitForFunction(({ selector, text, image }) => {
    const nodes = document.querySelectorAll(selector)
    return [...nodes].some(el => el.getClientRects().length > 0 &&
      (!text || el.textContent.includes(text)) && (!image || el.complete && el.naturalWidth > 0))
  }, { selector, text, image }, { timeout: limit })
  await handle.dispose()
  return page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => {
    resolve(performance.timeOrigin + performance.now())
  })))
}

async function measureClick(page, selector, action, finish) {
  await page.evaluate(selector => {
    globalThis.authoringSpeedInput = null
    const controller = new AbortController()
    const capture = event => {
      if (!event.target.closest(selector)) return
      globalThis.authoringSpeedInput = performance.timeOrigin + performance.now()
      controller.abort()
    }
    document.addEventListener('click', capture, { capture: true, signal: controller.signal })
  }, selector)
  await action()
  const end = await finish()
  const start = await page.evaluate(() => globalThis.authoringSpeedInput)
  assert.ok(Number.isFinite(start) && end >= start, `No click observed for ${selector}`)
  return { start, end }
}

function installDiagnostics({ app, BrowserWindow, ipcMain }, profileDir) {
  if (app.getPath('userData') !== profileDir || app.isPackaged ||
      BrowserWindow.getAllWindows().some(win => win.isVisible())) throw Error('Expected an isolated hidden editor')
  const time = () => performance.timeOrigin + performance.now()
  const trace = []
  globalThis.authoringSpeedTrace = trace
  const fs = process.getBuiltinModule('node:fs')
  const path = process.getBuiltinModule('node:path')
  const compilesFile = path.join(profileDir, 'compile-timings.jsonl')
  app.on('quit', (_event, code) => fs.writeFileSync(path.join(profileDir, 'terminal-quit.json'), JSON.stringify({
    end: time(), code, windows: BrowserWindow.getAllWindows().length
  })))
  for (const [channel, handler] of [...ipcMain._invokeHandlers]) {
    if (!/^(talk:|outline:|slide:|window:|scratchpad:|vault:|layout:)/.test(channel)) continue
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (...args) => {
      const start = time()
      try {
        const result = await handler(...args)
        const end = time()
        if (channel === 'talk:compile') {
          const event = { channel, start, end, file: path.basename(args[1]), authoredSlides: Array.isArray(result)
            ? result.filter(row => /^finding-\d+$/.test(row.slide_id)).length : 0,
            edited: args[2].includes('the series.!') }
          trace.push(event)
          fs.appendFileSync(compilesFile, JSON.stringify(event) + '\n')
        } else trace.push({ channel, start, end })
        return result
      } catch (error) {
        trace.push({ channel, start, end: time(), failed: true })
        throw error
      }
    })
  }
  return process.versions.electron
}

async function startProfiles(app, page) {
  const renderer = await page.context().newCDPSession(page)
  await renderer.send('Profiler.enable')
  await renderer.send('Profiler.start')
  const rendererAt = now()
  const main = await app.evaluate(async () => {
    if (globalThis.authoringSpeedProfiler) return { at: globalThis.authoringSpeedProfiler.at, includesStartup: true }
    const session = new (process.getBuiltinModule('node:inspector').Session)()
    session.connect()
    globalThis.authoringSpeedProfiler = { session }
    session.post('Profiler.enable')
    await new Promise((resolve, reject) => session.post('Profiler.start', error => error ? reject(error) : resolve()))
    return { at: performance.timeOrigin + performance.now(), includesStartup: false }
  })
  return async () => {
    const mainProfile = await app.evaluate(() => new Promise((resolve, reject) => {
      const { session } = globalThis.authoringSpeedProfiler
      session.post('Profiler.stop', (error, data) => {
        session.disconnect()
        if (error) reject(error)
        else resolve(data.profile)
      })
    }))
    const { profile: rendererProfile } = await renderer.send('Profiler.stop')
    await renderer.detach()
    return { mainAt: main.at, includesMainStartup: main.includesStartup, main: mainProfile,
      rendererAt, renderer: rendererProfile }
  }
}

async function quit(app, owned, profileDir) {
  const start = await app.evaluate(({ app, Menu }) => {
    const quit = Menu.getApplicationMenu().items.flatMap(group => group.submenu?.items ?? []).find(item => item.role === 'quit')
    if (!quit?.enabled) throw Error('No enabled Quit menu item')
    // A native role's JS click is inert on a hidden Mac window. Invoke its Electron lifecycle
    // directly so the fixture exercises every before-quit, close and will-quit handler.
    setImmediate(() => app.quit())
    return performance.timeOrigin + performance.now()
  })
  const terminal = await until(() => {
    try { return JSON.parse(readFileSync(join(profileDir, 'terminal-quit.json'), 'utf8')) } catch { return null }
  }, 'native Quit', 15_000)
  assert.equal(terminal.windows, 0)
  assert.equal(terminal.code, 0)
  if (owned.exitCode === null && owned.signalCode === null) {
    // Electron has reached terminal Quit. Release the Playwright 1.60 main debugger so the
    // owned process can exit, as in e2e/diagnose-quit-helpers.mjs.
    const impl = app._connection.toImpl(app)
    assert.equal(impl.process(), owned)
    impl._nodeConnection.close()
    void app.close().catch(() => {})
  }
  await until(() => owned.exitCode !== null || owned.signalCode !== null, 'Electron process exit', 5000)
  assert.equal(owned.exitCode, 0)
  assert.equal(owned.signalCode, null)
  return { start, end: terminal.end }
}

async function run(fixture, record, warm, profiling) {
  const { profileDir, home, talks } = fixture
  const env = { HOME: home, CFFIXED_USER_HOME: home, TW_E2E_HOME: home, TW_E2E: '1', TW_REC_TEST: '1' }
  for (const name of ['PATH', 'TMPDIR', 'LANG', 'USER', 'LOGNAME', 'SHELL', 'DISPLAY']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  const size = record.slides
  const other = size === 30 ? 300 : 30
  const spans = record.spans
  let app
  let owned
  let page
  let phase = 'launch'
  try {
    const profileArgs = []
    if (profiling) {
      // This optional sample is excluded from the timing matrix.
      const preload = join(home, 'main-profile.cjs')
      writeFileSync(preload, `
        const session = new (require('node:inspector').Session)();
        session.connect();
        const at = performance.timeOrigin + performance.now();
        session.post('Profiler.enable');
        session.post('Profiler.start');
        globalThis.authoringSpeedProfiler = { session, at };
      `)
      profileArgs.push('-r', preload)
    }
    const start = now()
    app = await electron.launch({ args: [...profileArgs, repo, `--user-data-dir=${profileDir}`, '--use-mock-keychain'],
      cwd: repo, env, timeout })
    owned = app.process()
    const attached = now()
    page = await app.firstWindow({ timeout })
    page.setDefaultTimeout(timeout)
    const id = warm ? 'Warm' : 'Cold'
    const listReady = await ready(page, row(slug(size)))
    spans[`Start ${id.toLowerCase()} → Talks list`] = { start, end: listReady }
    report.host.electron = await app.evaluate(installDiagnostics, profileDir)
    const stopProfiles = profiling ? await startProfiles(app, page) : null
    if (warm) {
      // The profile was used by the preceding cold launch. The browser quit receipt belongs to that process.
      writeFileSync(join(profileDir, 'terminal-quit.json'), '')
    }
    const open = target => measureClick(page, row(slug(target)),
      () => page.locator(row(slug(target))).first().click({ noWaitAfter: true }),
      () => ready(page, editable, marker(target)))
    phase = 'select first talk'
    const opening = await open(size)
    spans[`Start ${id.toLowerCase()} → first editable slide`] = { start, end: opening.end }
    record[`${id.toLowerCase()}Startup`] = {
      attached,
      ...await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0]
        return { navigation: performance.timeOrigin, domInteractive: performance.timeOrigin + nav.domInteractive,
          domContentLoaded: performance.timeOrigin + nav.domContentLoadedEventEnd }
      })
    }
    const compile = (target, edited, actionStart) => until(() => {
      let lines
      try { lines = readFileSync(join(profileDir, 'compile-timings.jsonl'), 'utf8') } catch { return null }
      // The main-process timestamps make this polling interval irrelevant to the reported duration.
      return lines.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).find(event =>
        event.file === basename(talks[target].path) && event.start >= actionStart &&
        event.edited === edited && event.authoredSlides === target)
    }, 'live compiler rows')
    if (!warm) {
      spans['Open talk → editable slide'] = opening
      phase = 'first compile'
      const initial = await compile(size, false, opening.start)
      spans['Open talk → first compile'] = { start: opening.start, end: initial.end }
      phase = 'switch talks'
      const switchedAway = await open(other)
      await compile(other, false, switchedAway.start)
      const switchedBack = await open(size)
      spans['Switch talk → editable slide'] = switchedBack
      await compile(size, false, switchedBack.start)

      for (const [view, key] of [['grid', '2'], ['outline', '3'], ['markdown', '4'], ['slide', '1']]) {
        phase = `switch to ${view}`
        // Electron can consume a menu accelerator before the renderer sees keydown.
        const viewStart = now()
        await page.keyboard.press(`${meta}+${key}`)
        spans[`Switch view → ${view}`] = { start: viewStart, end: await ready(page, views[view]) }
      }

      phase = 'open Title page for the Designs comparison'
      const panel = page.locator('.tw-inspector')
      const inspectorTab = page.getByRole('tab', { name: 'Slide', exact: true })
      if (await inspectorTab.getAttribute('aria-selected') !== 'true') await inspectorTab.click()
      await panel.locator('.tw-right-adjust').getByRole('button', { name: /^Title\b/ }).click()

      phase = 'recompile after one character'
      await page.locator(editable).evaluate(el => {
        const editor = el.cmTile.root.view
        const offset = editor.state.doc.toString().indexOf('the series.') + 'the series.'.length
        editor.dispatch({ selection: { anchor: offset } })
        editor.focus()
      })
      const editStart = now()
      await page.keyboard.insertText('!')
      const edited = await compile(size, true, editStart)
      spans['One-character edit → recompile'] = { start: editStart, end: edited.end }
      record.recompileIpc = { delayMs: edited.start - editStart, compileMs: edited.end - edited.start }

      phase = 'open Designs'
      // The edit was made on Title so Designs has yet to request pictures for the new text.
      const back = panel.getByRole('button', { name: 'Back', exact: true })
      spans['Open Designs → first picture'] = await measureClick(page, '.tw-right-page button',
        () => back.click(), () => ready(page, '[data-section="designs"] .tw-right-picture img', '', true, 75_000))

      phase = 'open Scratchpad'
      const win = await app.browserWindow(page)
      await win.evaluate(w => w.webContents.send('app:run-command', 'scratchpad-dock'))
      await ready(page, '.sp-dock-host .sp-panel')
      await inspectorTab.click()
      spans['Open Scratchpad tab'] = await measureClick(page, '[data-rc-tab="scratchpad"] button',
        () => page.getByRole('tab', { name: 'Scratchpad', exact: true }).click(),
        () => ready(page, '.sp-dock-host .sp-panel'))
      await ensureTalksMode(page)
      record.ipc = await until(async () => {
        try { return await app.evaluate(() => globalThis.authoringSpeedTrace) } catch (error) {
          // Playwright's Electron inspector can report context loss while a child frame navigates.
          if (!String(error).includes('Execution context was destroyed')) throw error
          return null
        }
      }, 'main IPC timings', 3000)
    }
    if (stopProfiles) writeFileSync(output + '.cpuprofiles.json', JSON.stringify(await stopProfiles()))
    phase = 'quit'
    const quitSpan = await quit(app, owned, profileDir)
    if (!warm) spans.Quit = quitSpan
    phase = 'outline bytes'
    assert.equal(readFileSync(talks[other].path, 'utf8'), talks[other].text, 'Switching must preserve the other outline')
    const expected = talks[size].text.replace('the series.', 'the series.!')
    assert.equal(readFileSync(talks[size].path, 'utf8'), expected, 'The sole edit must survive Quit')
  } catch (error) {
    if (page && !page.isClosed()) {
      record.failureState = await Promise.race([
        page.evaluate(() => ({
          views: [...document.querySelectorAll('[data-view]')].map(el => el.dataset.view),
          inspectorPages: [...document.querySelectorAll('.tw-inspector [data-section]')].map(el => el.dataset.section),
          selectedTabs: [...document.querySelectorAll('[data-rc-tab] [aria-selected="true"]')].map(el => el.getAttribute('aria-label'))
        })).catch(() => null),
        delay(1000, null)
      ])
    }
    throw Error(`${size} slides, ${warm ? 'warm' : 'cold'}, ${phase}: ${error.message}`, { cause: error })
  } finally {
    if (owned?.exitCode === null && owned.signalCode === null) {
      // Failure cleanup applies only to the child we just launched. The sample remains a failure.
      owned.kill('SIGKILL')
      await until(() => owned.exitCode !== null || owned.signalCode !== null, 'fixture process cleanup', 5000)
    }
    if (app) await Promise.race([app.close().catch(() => {}), delay(1000)])
  }
}

function summarise() {
  for (const size of [30, 300]) {
    const metrics = report.summary[size] = {}
    const cases = report.cases.filter(record => record.slides === size && record.complete)
    for (const metric of Object.keys(cases[0]?.spans ?? {})) {
      const sorted = cases.map(record => record.spans[metric].end - record.spans[metric].start).sort((a, b) => a - b)
      const lower = sorted[Math.floor((sorted.length - 1) / 2)]
      const upper = sorted[Math.floor(sorted.length / 2)]
      metrics[metric] = { n: sorted.length, medianMs: Math.round((lower + upper) / 2),
        p95Ms: Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1]) }
    }
  }
}

for (let sample = 1; sample <= samples; sample++) {
  for (const size of sample % 2 === 1 ? [30, 300] : [300, 30]) {
    if (report.cases.some(record => record.sample === sample && record.slides === size)) continue
    const record = { slides: size, sample, spans: {} }
    report.cases.push(record)
    const scratch = scratchVault('tw-speed-')
    try {
      const fixture = fixtures(scratch.root)
      await run(fixture, record, false, false)
      await run(fixture, record, true, false)
      record.complete = true
      console.log(`PASS ${size} slides, sample ${sample}/${samples}`)
    } catch (error) {
      record.error = error.message
      throw error
    } finally {
      summarise()
      save()
      scratch[Symbol.dispose]()
    }
  }
}
if (profile) {
  const scratch = scratchVault('tw-speed-profile-')
  try {
    const record = { slides: 300, spans: {} }
    report.profile = record
    await run(fixtures(scratch.root), record, false, true)
  } finally {
    save()
    scratch[Symbol.dispose]()
  }
}
summarise()
report.complete = true
save()
console.log(JSON.stringify(report.summary, null, 2))

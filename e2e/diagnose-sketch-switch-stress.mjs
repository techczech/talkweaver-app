// Diagnostic, not in a tier: loops the Sketch journey's crash step (reopen the first talk, then click the
// Slide Scratchpad pill) to find whether Chromium's DevToolsAgentHostImpl::NotifyCreated check needs
// Playwright attached. Setup is the Sketch journey (e2e/diagnose-redesign-sketch.mjs) up to that step.
// Arms, all on the same profile and vault:
//   pw-loc  Playwright attached, Playwright locators (as the journey);
//   pw-js   Playwright attached, the step driven by webContents.executeJavaScript (no CDP input);
//   app     Electron started directly with a main-process driver (-r), no Playwright, no debugging port.
// Counts: TW_SWITCH_PW_LOC, TW_SWITCH_PW_JS, TW_SWITCH_APP (iterations). Exit 0 when nothing crashed.
import assert from 'node:assert/strict'
import { openTalkByTitle } from './lib/talklist.mjs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { _electron as electron } from 'playwright'
import { readSlides } from '../src/shared/insert-section.ts'
import { SAMPLE_SKETCH } from '../src/shared/sketch-sample.ts'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
const root = resolve('.')
const scratch = mkdtempSync(join(process.env.TW_SKETCH_E2E_ROOT ?? tmpdir(), 'tw-sketch-switch-'))
console.log('[scratch]', scratch)
const profile = join(scratch, 'profile')
const documents = join(scratch, 'Documents')
const vault = join(documents, 'TalkWeaver')
const dir = join(vault, 'community-garden-update')
const outline = join(dir, 'community-garden-update-outline.md')
const size = (process.env.TW_SKETCH_E2E_SIZE ?? '1280x800').split('x').map(Number)
const colour = process.env.TW_SKETCH_E2E_COLOUR === 'dark' ? 'dark' : 'light'
const screenshots = process.env.TW_SKETCH_E2E_SCREENSHOTS
const env = { TW_E2E: '1' }
for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SHELL', 'DISPLAY']) {
  if (process.env[name] !== undefined) env[name] = process.env[name]
}
mkdirSync(documents)
await ensureFreshBuild(root)
const app = await electron.launch({ cwd: root, args: ['.', `--user-data-dir=${profile}`], env })
let page
async function until(check, why) {
  const end = Date.now() + 20000
  while (Date.now() < end) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(why)
}

try {
  const errors = []
  page = await app.firstWindow()
  await page.emulateMedia({ colorScheme: colour })
  page.on('pageerror', error => { errors.push(error.message); console.error('[renderer]', error) })
  page.setDefaultTimeout(15000)
  await app.evaluate(({ app, BrowserWindow, session, shell }, { documents, size }) => {
    app.setPath('documents', documents)
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, reply) => reply({ cancel: true }))
    shell.showItemInFolder = () => {}
    for (const window of BrowserWindow.getAllWindows()) window.setContentSize(size[0], size[1])
  }, { documents, size })
  assert.ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(window => !window.isVisible())))
  const shot = async name => {
    if (screenshots) await page.screenshot({ path: join(screenshots, `${size.join('x')}-${colour}-${name}.png`) })
  }
  const button = (name) => page.getByRole('button', { name, exact: typeof name === 'string' })
  const editor = page.getByRole('textbox', { name: 'Sketch text' })
  const startScreen = page.getByRole('region', { name: 'Vault Explorer', exact: true })
  await startScreen.getByRole('button', { name: /Make a vault in Documents/ }).click()
  const newTalk = startScreen.getByRole('button', { name: 'New talk', exact: true })
  await newTalk.waitFor()
  if (await newTalk.getAttribute('aria-expanded') === 'false') await newTalk.click()
  await startScreen.getByLabel('Name of the talk').fill('Community Garden Update')
  await startScreen.getByRole('button', { name: /Start with an outline/ }).click()
  await editor.waitFor()
  assert.equal(await editor.inputValue(), '')
  const start = readFileSync(outline)
  const picker = page.locator('.tw-sketch-picker')
  const pickSketch = () => page.getByRole('button', { name: /^Sketches for this talk/ }).click()
  const newSketch = async () => { await pickSketch(); await page.getByRole('menuitem', { name: 'New sketch', exact: true }).click() }
  const openSketchPath = async () => {
    await page.locator('.tw-sketch-picker[data-sketch-name$=".md"]').waitFor()
    return join(dir, 'scratchpad', await picker.getAttribute('data-sketch-name'))
  }
  assert.equal(await picker.getAttribute('data-sketch-name'), '')
  await editor.focus()
  await page.keyboard.insertText(SAMPLE_SKETCH)
  const firstSketch = await openSketchPath()
  await until(() => existsSync(firstSketch) && readFileSync(firstSketch, 'utf8') === SAMPLE_SKETCH, 'pasted sample was not saved')
  assert.equal(SAMPLE_SKETCH.split('\n').length, 21)
  assert.deepEqual(readFileSync(outline), start)
  await pickSketch()
  await page.getByRole('menuitem', { name: 'Rename this sketch' }).click()
  await page.getByRole('textbox', { name: 'Sketch name', exact: true }).fill('Members’ meeting sketch')
  await button('Save name').click()
  await page.getByRole('button', { name: 'Sketches for this talk, Members’ meeting sketch' }).waitFor()
  await editor.evaluate(el => { el.scrollTop = 0 })
  await shot('sketch')

  const prompt = async (title, withMarkers = false) => {
    await button('Copy for agent').click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('heading', { name: title }).waitFor()
    await page.waitForFunction(() => document.querySelector('[aria-label="Request for agent"]')?.value.includes('Do not edit the talk file'))
    const request = await dialog.getByLabel('Request for agent').inputValue()
    assert.match(request, /Do not edit the talk file/)
    if (withMarkers) assert.match(request, /## .*### /)
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  }
  await prompt('Copy for agent: this sketch')

  const allIds = new Set(readSlides(start.toString()).slides.map(slide => slide.id))
  const keepMissingPictureInSketch = async () => {
    const missing = page.locator('.tw-sketch-line-choice', { hasText: 'This picture is missing from the talk' })
    if (await missing.count()) await missing.getByRole('button', { name: 'Leave it in the sketch' }).click()
  }
  async function applyAndUndo({ choice, count, file, sample, decide, copySplit }) {
    await button('Break into slides').click()
    if (copySplit) {
      await page.getByRole('heading', { name: 'Three ways to break this into slides' }).waitFor()
      await shot('breakdowns')
      await prompt('Copy for agent: the breakdown', true)
    }
    if (choice === 'one') await page.locator('[data-breakdown="one"]').click()
    else await button(choice).click()
    const add = button(/^Add \d+ slides? to the talk$/)
    if (copySplit) await shot('review')
    if (decide) {
      assert.equal(await add.isDisabled(), true, 'an undecided line blocks Add')
      await page.locator('.tw-sketch-line-choice', { hasText: 'Thanks to everyone' })
        .getByRole('button', { name: 'Put it in the notes of the slide above' }).click()
    }
    await keepMissingPictureInSketch()
    assert.equal(await add.isEnabled(), true)
    assert.match(await add.textContent(), new RegExp(`Add ${count} slides?`))
    await add.click()
    await page.locator('[data-view="outline"]').waitFor()
    await until(() => !readFileSync(outline).equals(start), `${choice} did not apply`)
    assert.equal(readFileSync(file, 'utf8'), sample)
    const added = readSlides(readFileSync(outline, 'utf8')).slides
    assert.ok(added.length >= count)
    for (const { id } of added) {
      assert.ok(id)
      assert.ok(!allIds.has(id), `id ${id} was taken from a prior apply`)
      allIds.add(id)
    }
    await page.locator('[data-toast-action="success"]').filter({ hasText: 'Undo' }).click()
    await until(() => readFileSync(outline).equals(start), `Undo for ${choice} did not restore the original outline bytes`)
    assert.equal(readFileSync(file, 'utf8'), sample)
    await button('Cancel').click()
    await editor.waitFor()
    console.log(`PASS ${choice}: apply and Undo restored every talk byte and preserved every sketch byte`)
  }
  for (const [choice, count] of [[/^By main point/, 5], [/^One slide per section/, 3], [/^One idea per slide/, 8]]) {
    await applyAndUndo({ choice, count, file: firstSketch, sample: SAMPLE_SKETCH, decide: true, copySplit: count === 5 })
  }

  await newSketch()
  await page.waitForFunction(() => document.querySelector('[aria-label="Sketch text"]')?.value === '')
  const marked = SAMPLE_SKETCH.split('\n').map((line, index) => [0, 9, 18].includes(index) ? '## ' + line
    : [1, 5, 10, 14, 19].includes(index) ? '### ' + line.replace(/^- /, '') : line).join('\n')
  await editor.fill(marked)
  const markedSketch = await openSketchPath()
  assert.notEqual(markedSketch, firstSketch)
  await applyAndUndo({ choice: /^As marked/, count: 5, file: markedSketch, sample: marked })

  await newSketch()
  await page.waitForFunction(() => document.querySelector('[aria-label="Sketch text"]')?.value === '')
  const prose = 'The beans did well. We shared sixty kilos.\n\nThe slugs ate the lettuce.'
  await editor.fill(prose)
  const proseSketch = await openSketchPath()
  for (const [choice, count] of [[/^One slide per paragraph/, 2], [/^One slide per sentence/, 3], ['one', 1]]) {
    await applyAndUndo({ choice, count, file: proseSketch, sample: prose })
  }
  await pickSketch()
  await page.getByRole('menu', { name: 'Sketches for this talk' }).locator(`[data-sketch-file="${basename(firstSketch)}"]`).click()
  await page.waitForFunction(sample => document.querySelector('[aria-label="Sketch text"]')?.value === sample, SAMPLE_SKETCH)
  await button('Break into slides').click()
  await button(/^By main point/).click()
  await page.locator('.tw-sketch-line-choice', { hasText: 'Thanks to everyone' }).getByRole('button', { name: 'Leave it in the sketch' }).click()
  await keepMissingPictureInSketch()
  await button('Not yet: keep in Scratchpad').first().click()
  await button('Add 4 slides to the talk').click()
  await page.locator('[data-view="outline"]').waitFor()
  await until(() => !readFileSync(outline).equals(start), 'final apply did not reach the outline')
  const applied = readFileSync(outline)
  assert.doesNotMatch(applied.toString(), /garden-beds\.jpg/)
  assert.equal(readFileSync(firstSketch, 'utf8'), SAMPLE_SKETCH)

  await page.evaluate(() => window.dispatchEvent(new Event('tw-new-talk')))
  await page.locator('#talk-title').fill('Garden Supplies')
  await button('Create').click()
  await page.locator('.workspace-view-titlebar').getByRole('button', { name: 'Garden Supplies', exact: true }).waitFor()
  await page.getByRole('tab', { name: 'Talks', exact: true }).click()
  await openTalkByTitle(page, 'Community Garden Update')
  await page.locator('.workspace-view-titlebar').getByRole('button', { name: 'Community Garden Update', exact: true }).waitFor()
  console.log('[switch] setup reached the crash step')
} catch (error) {
  console.error('[switch] setup failed', error)
  await app.close().catch(() => {})
  process.exit(2)
}

// ---- the loop -------------------------------------------------------------------------------------
const STEP = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const wait = async (f, why) => { const end = Date.now() + 20000; while (Date.now() < end) { const v = f(); if (v) return v; await sleep(50) } throw new Error('timeout: ' + why) }
  const name = (el) => (el.getAttribute('aria-label') || el.textContent || '').trim()
  const buttons = () => [...document.querySelectorAll('button')]
  const collapse = buttons().find((b) => name(b) === 'Collapse')
  if (collapse) { collapse.click(); await sleep(50) }
  const open = async (slug, title) => {
    const start = document.querySelector('.vault-explorer[role=region]')
    if (start) {
      const row = await wait(() => [...start.querySelectorAll('.vx-talk-open')].find(button => name(button) === title), 'Explorer talk ' + title)
      row.click()
    } else {
      const tab = await wait(() => [...document.querySelectorAll('[role=tab]')].find((t) => name(t) === 'Talks' || (t.textContent || '').trim() === 'Talks'), 'Talks tab')
      tab.click()
      const row = await wait(() => document.querySelector('aside.talk-list .tl-tree [data-talk-slug="' + slug + '"]'), 'row ' + slug)
      for (const type of ['mousedown', 'mouseup', 'click', 'mousedown', 'mouseup', 'click']) row.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }))
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window, detail: 2 }))
    }
    await wait(() => [...document.querySelectorAll('.workspace-view-titlebar button')].some((b) => name(b) === title || (b.textContent || '').trim() === title), 'titlebar ' + title)
  }
  await open('garden-supplies', 'Garden Supplies')
  await sleep(Math.random() * 800)
  await open('community-garden-update', 'Community Garden Update')
  await sleep(Math.random() * 300)
  const pill = await wait(() => buttons().find((b) => /^Slide Scratchpad, \\d+\\. Expand/.test(b.getAttribute('aria-label') || '')), 'Scratchpad pill')
  pill.click()
  await wait(() => buttons().find((b) => name(b) === 'Dock to the right'), 'expanded Scratchpad')
  await sleep(Math.random() * 1500)
  return true
})()`

// Main-process counters (no debugger): sub-frame commits in the main window, its frames' schemes now,
// and hidden windows created. Installed per launch; read back at the end of the launch.
const INSTALL = `(electron) => {
  if (globalThis.__switchCounts) return
  const counts = globalThis.__switchCounts = { mainSubframeCommits: 0, hiddenWindows: 0, mainFrameSchemes: {} }
  const watch = (wc) => {
    wc.on('did-frame-navigate', (_e, url, _c, _t, isMainFrame) => {
      if (isMainFrame || !wc.getURL().includes('/renderer/index.html')) return
      counts.mainSubframeCommits++
    })
  }
  for (const wc of electron.webContents.getAllWebContents()) watch(wc)
  electron.app.on('web-contents-created', (_e, wc) => watch(wc))
  electron.app.on('browser-window-created', (_e, w) => { if (!w.isVisible()) counts.hiddenWindows++ })
  globalThis.__switchSnapshot = () => {
    const main = electron.BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/renderer/index.html'))
    const schemes = {}
    if (main) for (const f of main.webContents.mainFrame.framesInSubtree) { if (f === main.webContents.mainFrame) continue; const k = (f.url || 'none').split(':')[0]; schemes[k] = (schemes[k] || 0) + 1 }
    counts.mainFrameSchemes = schemes
    return counts
  }
}`
const launches = []
const counts = { 'pw-loc': Number(process.env.TW_SWITCH_PW_LOC ?? 60), 'pw-js': Number(process.env.TW_SWITCH_PW_JS ?? 60), app: Number(process.env.TW_SWITCH_APP ?? 150) }
const exitOf = (child) => new Promise((r) => { if (child.exitCode !== null || child.signalCode !== null) r({ code: child.exitCode, signal: child.signalCode }); else child.once('exit', (code, signal) => r({ code, signal })) })

async function preparePlaywright(electronApp) {
  const p = await electronApp.firstWindow()
  p.setDefaultTimeout(20000)
  await electronApp.evaluate(({ app, BrowserWindow, session, shell }, { documents, size }) => {
    app.setPath('documents', documents)
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_request, reply) => reply({ cancel: true }))
    shell.showItemInFolder = () => {}
    for (const window of BrowserWindow.getAllWindows()) window.setContentSize(size[0], size[1])
  }, { documents, size })
  return p
}

async function stepWithLocators(p) {
  const btn = (name) => p.getByRole('button', { name, exact: typeof name === 'string' })
  const collapse = btn('Collapse')
  if (await collapse.count()) await collapse.first().click()
  for (const [slug, title] of [['garden-supplies', 'Garden Supplies'], ['community-garden-update', 'Community Garden Update']]) {
    await openTalkByTitle(p, title)
    await p.locator('.workspace-view-titlebar').getByRole('button', { name: title, exact: true }).waitFor()
    await p.waitForTimeout(Math.random() * (slug === 'garden-supplies' ? 800 : 300))
  }
  await btn(/^Slide Scratchpad, \d+\. Expand/).click()
  await btn('Dock to the right').waitFor()
  await p.waitForTimeout(Math.random() * 1500)
}

let setupAppOpen = true // the setup's own launch is the first pw-loc launch; every later launch is fresh
async function runPlaywrightArm(arm, total) {
  let i = 0, current = app, driverErrors = 0
  while (i < total) {
    const first = setupAppOpen
    setupAppOpen = false
    if (!first) current = await electron.launch({ cwd: root, args: ['.', `--user-data-dir=${profile}`], env })
    const child = current.process(), pid = child.pid
    let p
    try {
      p = first ? page : await preparePlaywright(current)
      await current.evaluate((electron, src) => { (0, eval)(src)(electron) }, INSTALL)
    } catch (error) { console.log(`[switch] ${arm} relaunch failed: ${error.message}`); driverErrors++; if (driverErrors > 5) break; continue }
    const start = i
    let outcome = 'done'
    for (; i < total; i++) {
      try {
        if (arm === 'pw-loc') await stepWithLocators(p)
        else await current.evaluate(({ BrowserWindow }, step) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/renderer/index.html')).webContents.executeJavaScript(step, true), STEP)
        process.stdout.write(`[switch] ${arm} iter=${i}\n`)
      } catch (error) {
        await new Promise((r) => setTimeout(r, 3000))
        if (child.exitCode !== null || child.signalCode !== null) { outcome = 'exited'; i++; break }
        console.log(`[switch] ${arm} step error at ${i}: ${error.message.split('\n')[0]}`)
        if (++driverErrors > 5) { outcome = 'driver-errors'; break }
      }
    }
    let counts = null
    if (outcome !== 'exited') { counts = await current.evaluate(() => globalThis.__switchSnapshot()).catch(() => null); await current.close().catch(() => {}) }
    const exit = await exitOf(child)
    const crashed = outcome === 'exited' || !!(exit.signal && exit.signal !== 'SIGTERM' && exit.signal !== 'SIGKILL')
    const record = { arm, pid, from: start, to: i, outcome, ...exit, crashed, counts }
    launches.push(record)
    console.log(`[switch] launch ${JSON.stringify(record)}`)
    if (outcome === 'driver-errors') break
    await new Promise((r) => setTimeout(r, 1500))
  }
}

async function runAppArm(total) {
  const driver = join(scratch, 'switch-driver.cjs')
  writeFileSync(driver, `
const electron = require('electron')
const { app, BrowserWindow, session } = electron
const out = (line) => process.stdout.write(line + '\\n')
;(0, eval)(process.env.TW_SWITCH_INSTALL)(electron)
app.whenReady().then(async () => {
  app.setPath('documents', process.env.TW_SWITCH_DOCUMENTS)
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_r, reply) => reply({ cancel: true }))
  let win
  for (let t = 0; t < 600 && !win; t++) {
    win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/renderer/index.html'))
    if (!win) await new Promise((r) => setTimeout(r, 100))
  }
  if (!win) { out('SWITCH fatal no main window'); app.exit(3); return }
  win.setContentSize(1280, 800)
  const start = Number(process.env.TW_SWITCH_START), end = Number(process.env.TW_SWITCH_END)
  let errors = 0
  for (let i = start; i < end; i++) {
    try { await win.webContents.executeJavaScript(process.env.TW_SWITCH_STEP, true); out('SWITCH iter=' + i) }
    catch (e) { out('SWITCH error ' + i + ' ' + String(e && e.message || e).split('\\n')[0]); if (++errors > 5) { app.exit(4); return } }
  }
  out('SWITCH counts ' + JSON.stringify(globalThis.__switchSnapshot()))
  out('SWITCH done')
  app.exit(0)
})
`)
  const electronPath = createRequire(import.meta.url)('electron')
  let i = 0, rounds = 0
  while (i < total && rounds++ < 40) {
    const child = spawn(electronPath, ['-r', driver, '.', `--user-data-dir=${profile}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, TW_SWITCH_STEP: STEP, TW_SWITCH_INSTALL: INSTALL, TW_SWITCH_START: String(i), TW_SWITCH_END: String(total), TW_SWITCH_DOCUMENTS: documents } })
    let last = i - 1, done = false, tail = '', counts = null
    child.stdout.on('data', (b) => {
      const text = b.toString()
      const c = text.match(/SWITCH counts (\{.*\})/); if (c) counts = JSON.parse(c[1])
      for (const m of text.matchAll(/SWITCH (iter=(\d+)|done|error .*|fatal .*)/g)) {
        if (m[2]) last = Number(m[2]); else if (m[1] === 'done') done = true; else console.log(`[switch] app ${m[1]}`)
      }
    })
    child.stderr.on('data', (b) => { tail = (tail + b.toString()).slice(-3000) })
    const exit = await Promise.race([exitOf(child), new Promise((r) => setTimeout(() => { child.kill('SIGKILL'); r({ code: null, signal: 'TIMEOUT' }) }, 20 * 60_000))])
    const crashed = !done && exit.code !== 3 && exit.code !== 4 && exit.signal !== 'TIMEOUT'
    const record = { arm: 'app', pid: child.pid, from: i, to: last + 1, done, ...exit, crashed, counts }
    launches.push(record)
    console.log(`[switch] launch ${JSON.stringify(record)}`)
    if (!done && !crashed) { console.log(`[switch] app stderr tail:\n${tail}`); if (exit.code === 3 || exit.code === 4) break }
    i = Math.max(last + 1, done ? total : i + 1)
    await new Promise((r) => setTimeout(r, 1500))
  }
}

await runPlaywrightArm('pw-loc', counts['pw-loc'])
await runPlaywrightArm('pw-js', counts['pw-js'])
await runAppArm(counts.app)
const summary = {}
for (const arm of Object.keys(counts)) {
  const mine = launches.filter((l) => l.arm === arm)
  summary[arm] = { asked: counts[arm], reached: Math.max(0, ...mine.map((l) => l.to)), launches: mine.length, crashes: mine.filter((l) => l.crashed).length, pids: mine.map((l) => l.pid) }
}
writeFileSync(join(scratch, 'summary.json'), JSON.stringify({ summary, launches }, null, 2))
console.log(`[switch] SUMMARY ${JSON.stringify(summary)}`)
// Playwright and child pipes can keep the event loop alive; the result is in.
process.exit(launches.some((l) => l.crashed) ? 1 : 0)

// Real BrowserWindows and production routes. Captures show renderer content of hidden windows.
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { scratchVault } from './lib/scratch-vault.mjs'
import { testProfileEnv } from './lib/test-profile.mjs'
import { chromeCollisions } from './lib/window-chrome-geometry.mjs'

const repo = resolve(import.meta.dirname, '..')
const baseline = process.argv.includes('--baseline')
const shots = process.env.TW_WINDOW_CHROME_SHOTS
const mac = process.platform === 'darwin'
const title = 'Ideas as experiments: AI for exploring research questions'
const content = `---\ntitle: "${title}"\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n## Talk\n\n### A question\n{id=question poll=board}\n\nWhat should we keep, change or try?\n\n- Keep\n- Change\n- Try\n\n### Closing {id=closing}\n\nA synthetic slide.\n`
const scratch = scratchVault('tw-window-chrome-')
const vault = join(scratch.root, 'vault')
const outline = join(vault, 'fixture', 'fixture-outline.md')
mkdirSync(join(vault, 'fixture'), { recursive: true })
writeFileSync(outline, content)
if (!baseline) {
  const pathways = join(vault, '_PRESENTATIONS', 'fixture')
  mkdirSync(pathways, { recursive: true })
  writeFileSync(join(pathways, 'manifest.json'), JSON.stringify({
    pathways: [{ id: 'short', name: 'Short version', slideIds: ['question', 'closing'] }]
  }))
}
mkdirSync(join(vault, 'second'))
writeFileSync(join(vault, 'second', 'second-outline.md'), content.replace(title, 'A second talk for the Slide Browser'))
if (shots) mkdirSync(shots, { recursive: true })

const failures = []
let checks = 0
let app
let server
let site

async function startSite() {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=UTF-8' })
    response.end('<!doctype html><title>Local fixture</title><p>A local page for Capture embed.</p>')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  site = 'http://127.0.0.1:' + server.address().port
}
async function launch(name, withVault) {
  const ud = join(scratch.root, name)
  const env = { ...process.env, ...testProfileEnv(ud), TW_E2E: '1', TW_REC_TEST: '1' }
  if (site) env.TW_E2E_LIVE_PAGE_ALLOW = new URL(site).host
  delete env.ELECTRON_RUN_AS_NODE
  if (withVault) writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault, editorViewMode: 'markdown', recordingDiscardMs: 800 }))
  app = await electron.launch({ cwd: repo, args: ['.', '--user-data-dir=' + ud, '--use-mock-keychain', '--mute-audio', '--use-fake-device-for-media-stream'], env })
  const page = await app.firstWindow()
  page.setDefaultTimeout(15000)
  await page.waitForLoadState('domcontentloaded')
  if (!baseline) assert.equal(await page.evaluate(() => window.twMacInset), mac, 'editor preload and native chrome flag')
  return page
}

async function closeApp() {
  if (!app) return
  await app.evaluate(({ app }) => app.exit(0)).catch(() => {})
  await app.close().catch(() => {})
  app = undefined
}

async function state(win) {
  return win.evaluate(w => ({
    bounds: w.getSize(), minimum: w.getMinimumSize(), content: w.getContentSize(),
    frameTop: w.getContentBounds().y - w.getBounds().y,
    visible: w.isVisible(), fullscreenable: w.isFullScreenable(),
    position: process.platform === 'darwin' ? w.getWindowButtonPosition() : null,
    simpleFullScreen: process.platform === 'darwin' && w.isSimpleFullScreen(),
    fullScreen: w.isFullScreen()
  }))
}

async function check(page, win, name, mode, titles, native) {
  const info = await state(win)
  assert.equal(info.visible, false, name + ' must stay hidden')
  await page.waitForFunction(([w, h]) => innerWidth === w && innerHeight === h, info.content)
  const collisions = await page.evaluate(chromeCollisions, { native, titleSelector: titles })
  if (mac && !native && !info.simpleFullScreen && !info.fullScreen && info.frameTop <= 0) {
    collisions.push('Expected the native title bar above the renderer')
  }
  if (!baseline && name === 'vault-gallery-overview') {
    const box = await page.locator('.vg-crumb.here.top').boundingBox()
    if (!box || box.width <= 45) collisions.push('All vaults must remain readable beside Back and Search')
  }
  if (name === 'slide-browser') {
    for (const button of await page.locator('.lt-topbar .lt-tool-btn, .lt-topbar .lt-steps button').all()) {
      const box = await button.boundingBox()
      if (!box || box.x < 0 || box.x + box.width > info.content[0] + 0.5) {
        collisions.push('Slide Browser header must keep its density, Settings and Help controls in the viewport')
        break
      }
    }
  }
  checks++
  console.log(`${collisions.length ? 'FAIL' : 'PASS'} ${name} / ${mode} ${info.bounds.join('×')}${native ? ' native=' + JSON.stringify(native) : ''}`)
  for (const collision of collisions) failures.push(name + ' / ' + mode + ': ' + collision)
  if (collisions.length) console.error(collisions.join('\n'))
}

async function nativeControls(page, info, custom) {
  if (!mac || !custom) return null
  // Before the fix, hiddenInset uses Electron's default margin of (12,11).
  if (baseline && !info.position) return { left: 12, right: 72, top: 11, bottom: 27 }
  assert.ok(info.position, 'an overlapping native title bar must report its configured position')
  const overlay = await page.waitForFunction(() => {
    const rect = navigator.windowControlsOverlay?.getTitlebarAreaRect()
    return rect?.x > 0 && rect.height > 0 ? { right: rect.x, height: rect.height } : null
  }).then(handle => handle.jsonValue())
  // Electron expands the native button row by its configured margin on both sides.
  const { x, y } = info.position
  return { left: x, top: y, right: overlay.right - x, bottom: overlay.height - y }
}

async function inspect(page, name, { custom = true, titles = '[data-window-title]', fullscreen = true } = {}) {
  const win = await app.browserWindow(page)
  const normal = await state(win)
  if (!baseline && custom) assert.equal(await page.evaluate(() => window.twMacInset), mac, name + ' preload and native chrome flag')
  const native = await nativeControls(page, normal, custom)
  const minimum = normal.minimum.every(n => n > 0) ? normal.minimum : normal.bounds
  try {
    await check(page, win, name, 'default', titles, native)
    if (normal.minimum.every(n => n > 0)) {
      await win.evaluate((w, size) => w.setSize(...size), minimum)
      await check(page, win, name, 'minimum', titles, native)
    } else {
      console.log('N/A ' + name + ' / minimum (host has no app-defined minimum)')
    }
    if (shots) {
      for (const theme of ['light', 'dark']) {
        await app.evaluate(({ nativeTheme }, value) => { nativeTheme.themeSource = value }, theme)
        await page.emulateMedia({ colorScheme: theme })
        await page.screenshot({ path: join(shots, name + '-' + theme + '.png'), animations: 'disabled' })
      }
      await page.emulateMedia({ colorScheme: null })
    }
    if (baseline) return
    if (!fullscreen) {
      assert.equal(normal.fullscreenable, false, name + ' should remain non-fullscreenable')
      console.log('N/A ' + name + ' / fullscreen (disabled by host)')
      return
    }
    await win.evaluate((w, on) => {
      // Use the real host's simple full-screen on macOS to avoid switching the operator's Space.
      if (process.platform === 'darwin') w.setSimpleFullScreen(on)
      else w.setFullScreen(on)
    }, true)
    const full = await state(win)
    assert.ok(full.simpleFullScreen || full.fullScreen, name + ' did not enter Electron fullscreen')
    await check(page, win, name, 'fullscreen', titles, native)
  } finally {
    await win.evaluate((w, size) => {
      if (process.platform === 'darwin' && w.isSimpleFullScreen()) w.setSimpleFullScreen(false)
      else if (w.isFullScreen()) w.setFullScreen(false)
      w.setSize(...size)
    }, normal.bounds)
    await check(page, win, name, 'restored', titles, native)
    await win.dispose()
  }
}

const command = (page, detail) => page.evaluate(detail => window.dispatchEvent(new CustomEvent('tw-workspace-command', { detail })), detail)

async function openWindow(action, urlMatches) {
  const candidate = app.waitForEvent('window', {
    timeout: 20000,
    predicate: async page => {
      try { await page.waitForURL(urlMatches, { timeout: 10000 }); return true }
      catch { return false }
    }
  })
  const [page] = await Promise.all([candidate, action()])
  page.setDefaultTimeout(12000)
  return page
}

try {
  await ensureFreshBuild(repo)
  if (!baseline) {
    await startSite()
    const setup = await launch('setup', false)
    await setup.locator('.tw-welcome-window').waitFor()
    await inspect(setup, 'first-run-setup')
    await closeApp()
  }
  const editor = await launch('editor', true)
  await editor.locator('.tw-welcome-new').waitFor()
  if (!baseline) {
    await inspect(editor, 'editor-welcome', { titles: '.workspace-title' })
    // Crossing the narrow breakpoint collapses the Talks sidebar until the user reopens it.
    const expand = editor.locator('[data-sidebar-expand]')
    if (await expand.isVisible()) await expand.click()
  }
  await editor.locator('[data-talk-slug="fixture"]').first().dblclick()
  await editor.locator('.workspace-view-titlebar').waitFor()
  await editor.locator('.cm-content').waitFor()

  await editor.evaluate(() => window.dispatchEvent(new Event('tw-vault-gallery')))
  const gallery = editor.getByRole('dialog', { name: 'Vault Gallery', exact: true })
  await gallery.locator('.vg-crumb.here.top').waitFor()
  const galleryTitles = { titles: '.vg-crumb.here' }
  await inspect(editor, 'vault-gallery-overview', galleryTitles)
  if (!baseline) {
    await gallery.locator('.vg-trrow button').first().click()
    await gallery.locator('button.vg-crumb.top').waitFor()
    await inspect(editor, 'vault-gallery-library', galleryTitles)
    await gallery.getByRole('treeitem', { name: 'All talks' }).click()
    await gallery.getByLabel('Location').getByText('All talks', { exact: true }).waitFor()
    await inspect(editor, 'vault-gallery-all-talks', galleryTitles)
    await gallery.locator('[data-mode-back]').click()
    await gallery.waitFor({ state: 'detached' })

    const titleBarLabels = '.workspace-view-titlebar .toolbar-btn-content > span'
    const pathwaySwitch = editor.locator('.workspace-pathway-switch')
    await pathwaySwitch.getByRole('button', { name: 'Full talk', exact: true }).waitFor()
    await inspect(editor, 'editor', { titles: titleBarLabels })
    for (const [name, id, selector, titles] of [
      ['slide-focus', 'focus-slide', '.lt-focus-top', '.lt-c-slide'],
      ['slide-browser', 'search', '.lt-browser-root', '.lt-room'],
      ['pathways', 'pathways', '[data-pathway-dock]', titleBarLabels],
      ['sketch', 'new-sketch', '.tw-sketch', '.tw-sketch-head h2']
    ]) {
      await command(editor, id)
      await editor.locator(selector).first().waitFor()
      if (id === 'pathways') {
        await pathwaySwitch.getByRole('button', { name: 'Full talk', exact: true }).click()
        await editor.getByRole('menuitemradio', { name: 'Short version', exact: true }).click()
        await pathwaySwitch.getByRole('button', { name: 'Short version', exact: true }).waitFor()
      }
      await inspect(editor, name, { titles })
      if (id === 'pathways') {
        await pathwaySwitch.getByRole('button', { name: 'Short version', exact: true }).click()
        await editor.getByRole('menuitemradio', { name: 'Full talk', exact: true }).click()
      }
      if (id === 'search') {
        await editor.locator('.lt-card:not(.skeleton)').first().click()
        await editor.keyboard.press('Enter')
        await editor.locator('.lt-viewer').waitFor()
        await inspect(editor, 'slide-browser-insert-viewer')
        await editor.getByTitle('Back to the Browser (Esc)').click()
        await editor.locator('.lt-viewer').waitFor({ state: 'detached' })
      }
      const back = id === 'pathways' ? '[data-pathways-back]' : selector
      await editor.locator(back + ' [data-mode-back]').first().click()
      await editor.locator(selector).first().waitFor({ state: 'detached' })
    }

    await editor.evaluate(outlinePath => window.dispatchEvent(new CustomEvent('tw:conflict-compare', { detail: { outlinePath } })), outline)
    await editor.locator('[data-conflict-compare-screen]').waitFor()
    await inspect(editor, 'conflict-compare', { titles: '.cc-top-title' })
    await editor.locator('[data-conflict-back]').click()

    const capture = await openWindow(async () => {
      const response = await editor.evaluate(({ outlinePath, pageUrl }) => window.tw.livePage.openCapture({
        outlinePath, pageUrl, slideId: 'question', title: 'Local fixture', images: [], alts: []
      }), { outlinePath: outline, pageUrl: site })
      assert.equal(response.ok, true, JSON.stringify(response))
    }, /capture-embed\.html/)
    await capture.locator('#root > *').first().waitFor()
    await inspect(capture, 'capture-embed', { custom: false, titles: 'header h1, header h2' })
    await editor.evaluate(() => window.tw.livePage.closeCapture())

    const settings = await openWindow(() => editor.evaluate(() => window.tw.settingsWindow.open()), /\/settings\.html/)
    await settings.locator('.bsw-nav').first().waitFor()
    await inspect(settings, 'settings', { titles: '.bsw-phead h1, .bsw-phead h2', fullscreen: false })
    await settings.locator('[data-section="setup-folder"]').first().click()
    await inspect(settings, 'settings-setup-folder', { titles: '.bsw-phead h1, .bsw-phead h2', fullscreen: false })

    const tools = await openWindow(() => editor.evaluate(() => window.tw.tools.open('studio')), /[?&]view=studio/)
    await tools.locator('.twstudio').waitFor()
    await inspect(tools, 'studio', { titles: '.tw-tools-bar h2' })
    for (const [view, selector] of [
      ['runs', '[data-tools-view=runs]'], ['importer', '.twi'],
      ['published', '[data-tools-view=published]'], ['workfiles', '[data-tools-view=workfiles]']
    ]) {
      await tools.locator('[data-tools-rail="' + view + '"]').click()
      await tools.locator(selector).waitFor()
      await inspect(tools, view, { titles: '.tw-tools-bar h2, .tw-tools-list > header h2' })
    }
    await editor.evaluate(() => window.tw.tools.open('talktext'))
    await tools.locator('.tt-topbar').waitFor()
    await inspect(tools, 'manage-notes', { titles: '.tt-title' })

    for (const [mode, url, ready, titles] of [
      ['window', /-present\.html/, 'body', '[data-window-title]'],
      ['presenter', /[?&]presenter=1/, '#presenterTitle', '#presenterTitle'],
      ['audience', /[?&]audience=1/, 'body', '[data-window-title]']
    ]) {
      const deck = await openWindow(() => editor.evaluate(([path, text, mode]) => window.tw.talk.present(path, text, mode, 'question'), [outline, content, mode]), url)
      await deck.locator(ready).waitFor()
      if (await deck.locator('#twResume').isVisible()) await deck.locator('#twResumeYes').click()
      await inspect(deck, 'deck-' + mode, { custom: false, titles })
      if (mode === 'window') {
        const popup = await openWindow(() => deck.locator('#presenterBtn').click(), /[?&]presenter=1/)
        await popup.locator('#presenterTitle').waitFor()
        if (await popup.locator('#twResume').isVisible()) await popup.locator('#twResumeYes').click()
        await inspect(popup, 'presenter-popup', { custom: false, titles: '#presenterTitle' })
        await popup.close()
      }
      if (mode === 'presenter') {
        const audience = await openWindow(() => deck.keyboard.press('F5'), /[?&]audience=1/)
        await audience.locator('body').waitFor()
        await inspect(audience, 'audience-popup', { custom: false })
        await audience.close()

        // An authored board can be popped out before it opens to submissions.
        const board = await openWindow(() => deck.locator('#boardPopOut').click(), /^about:blank$/)
        await board.locator('#boardWindowPanel .bp-title').waitFor()
        await inspect(board, 'board-popup', { custom: false, titles: '#boardWindowPanel .bp-title b' })
        await board.locator('#boardPutBack').click()

        await deck.locator('#twrec-primary').waitFor()
        await deck.keyboard.press('Shift+r')
        await deck.locator('.twrec-device-check').waitFor()
        await inspect(deck, 'presenter-recording-setup', { custom: false, titles })
        await deck.waitForFunction(() => !document.querySelector('[data-continue]').disabled)
        await deck.locator('[data-continue]').click()
        await deck.waitForSelector('#twrec-module[data-rec=recording]')
        await inspect(deck, 'presenter-recording-active', { custom: false, titles })
        // With no screenshots, ensure the fixture still exceeds the host's discard threshold.
        await deck.waitForTimeout(850)
        await deck.locator('#twrec-stop').click()
        await deck.waitForSelector('#twrec-module[data-rec=saved]', { timeout: 30000 })
        await deck.locator('#twrec-edit-video').click()
        await tools.locator('[data-recording-panel]').waitFor({ timeout: 30000 })
        await inspect(tools, 'studio-recording', { titles: '.tw-tools-bar h2' })
        await tools.locator('[data-edit-video]').click()
        await tools.locator('[data-recording-editor]').waitFor()
        await inspect(tools, 'recording-editor', { titles: '.tre-what' })
      }
    }
  }
} finally {
  await closeApp()
  if (server) await new Promise(resolve => server.close(resolve))
  scratch[Symbol.dispose]()
}
assert.deepEqual(failures, [], failures.length + ' collisions across ' + checks + ' geometry checks')
console.log('PASS ' + checks + ' window chrome geometry checks')

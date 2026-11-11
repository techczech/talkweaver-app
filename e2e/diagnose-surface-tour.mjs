// Surface tour (consistency review, phase 2): open every user-visible surface listed in
// docs/design/2026-11-05-consistency-review/surfaces.json once, in the real app, and keep a screenshot and a
// faithful record of what actually opened. It is a recording tool for judging consistency later, not a test:
// it never fails the build, it says what it could and could not open.
//
// Safety, as in the other e2e/diagnose-*.mjs scripts: Electron runs hidden and off-screen, on a throwaway copy of
// demo-vault/ and a throwaway user-data folder in the temp directory; the owner's vault, user data and Chrome are
// never touched. Native file/message dialogs are replaced (their wording is recorded, nothing is chosen), external
// links, folders and every non-local network request are blocked. Surfaces whose opening changes data, and
// anything that would publish, upload, delete, record, go live or contact a service, are recorded as skipped.
//
// Run:   npm run diagnose:surface-tour
// Flags: --only=id,id        run just these surfaces and merge them into the existing report
//        --dark-only         only the dark-theme pass of the 7 windows
//        --no-dark           skip the dark-theme pass
//        --report-only       rebuild tour-summary.md and contact-sheet.html from tour-report.json
//        --allow-writes      also open surfaces flagged opening_changes_data (still on the throwaway copy)
//        --out=<dir>         another output folder
//        --size=WxH          content size of every window (default 1440x900; the page viewport is verified against it)
//        --geometry          small-window geometry check (R17) after each surface opens; output goes to
//                            docs/design/2026-11-05-consistency-review/geometry/<W>x<H>/ (see geometry/README.md)
//        --sidebar=<px>      with --geometry: start with the sidebar dragged to this width (stored preference 'tw-sidebar'; the app default is 240).
//                            The owner's MacBook Air window had it at about 325; output goes to geometry/<W>x<H>-sidebar<px>/
//        --base-only         with --geometry: only the base states (no talk, Plain, Markdown, Guide, Research, Image drawer,
//                            Scratchpad, Tools views, Settings, Presenter), not all surfaces
// Output (default): docs/design/2026-11-05-consistency-review/tour/{shots/,tour-report.json,tour-summary.md,contact-sheet.html}
import { _electron as electron } from 'playwright'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openTalkByTitle, ensureTalksMode } from './lib/talklist.mjs'
import { TOUR_RECIPES, fallbackRecipe } from './lib/surface-tour-recipes.mjs'
import { writeSummary, writeContactSheet } from './lib/surface-tour-report.mjs'
import { runGeometry, writeGeometryReport } from './lib/geometry-check.mjs'

const root = process.cwd()
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const REVIEW = join(root, 'docs/design/2026-11-05-consistency-review')
const sizeArg = opt('size') ?? '1440x900'
const sizeMatch = /^(\d{3,5})x(\d{3,5})$/.exec(sizeArg)
if (!sizeMatch) { console.error(`--size must look like 1000x631, got "${sizeArg}"`); process.exit(2) }
const WIDTH = Number(sizeMatch[1])
const HEIGHT = Number(sizeMatch[2])
const geomMode = flag('geometry') || flag('base-only')
const OUT = resolve(opt('out') ?? (geomMode ? join(REVIEW, 'geometry', opt('sidebar') ? `${sizeArg}-sidebar${opt('sidebar')}` : sizeArg) : sizeArg === '1440x900' ? join(REVIEW, 'tour') : join(REVIEW, `tour-${sizeArg}`)))
const SHOTS = join(OUT, 'shots')
const REPORT = join(OUT, 'tour-report.json')
const surfaces = JSON.parse(readFileSync(join(REVIEW, 'surfaces.json'), 'utf8'))
const only = opt('only')?.split(',').filter(Boolean) ?? null
const PER_SURFACE_MS = 15_000
const MAIN_TALK = 'TalkWeaver Layout Showcase'
mkdirSync(SHOTS, { recursive: true })

if (flag('report-only')) {
  const report = JSON.parse(readFileSync(REPORT, 'utf8'))
  writeSummary(OUT, surfaces, report)
  writeContactSheet(OUT, surfaces, report)
  console.log('[tour] rebuilt summary and contact sheet')
  process.exit(0)
}

await ensureFreshBuild(root)
// The Vault Gallery and presenting need the small native helper (macOS); build it once if it is missing.
if (process.platform === 'darwin' && !existsSync(join(root, 'native/vault-gallery'))) {
  console.log('[tour] building the native gallery helper (npm run build:gallery-native:host)')
  spawnSync('npm', ['run', 'build:gallery-native:host'], { cwd: root, stdio: 'inherit' })
}

// ---- the throwaway world -------------------------------------------------------------------------------------
// realpath: macOS temp folders sit behind a symlink (/var → /private/var) and the app refuses to open through one.
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tw-surface-tour-')))
const userData = join(scratch, 'userData')
const vault = join(scratch, 'vault')
mkdirSync(userData, { recursive: true })
cpSync(join(root, 'demo-vault'), vault, { recursive: true })
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, editorViewMode: 'markdown' }))
const { seedWorld } = await import('./lib/surface-tour-recipes.mjs')
const seeded = seedWorld({ vault, userData })

const env = { TW_E2E: '1', TW_REC_TEST: '1' }
for (const name of ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'SHELL', 'DISPLAY']) if (process.env[name] !== undefined) env[name] = process.env[name]
let app
for (let attempt = 1; attempt <= 3 && !app; attempt += 1) {
  try { app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`], cwd: root, env, timeout: 60_000 }) }
  catch (error) { if (attempt === 3) throw error; await new Promise((r) => setTimeout(r, 10_000)) }
}
let mainOutput = ''
app.process().stdout.on('data', (c) => { mainOutput += c })
app.process().stderr.on('data', (c) => { mainOutput += c })

// Hidden, off-screen, fixed size; nothing leaves this computer; native dialogs recorded and declined.
await app.evaluate(({ shell, app: electronApp, BrowserWindow, dialog, session, Menu, ipcMain }, size) => {
  shell.openExternal = async () => {}
  shell.showItemInFolder = () => {}
  shell.openPath = async () => ''
  globalThis.__tourDialogs = []
  const decline = (opts) => {
    const buttons = Array.isArray(opts?.buttons) ? opts.buttons : []
    const cancel = buttons.findIndex((b) => /cancel|not now|no\b|keep|close/i.test(String(b)))
    return opts?.cancelId ?? (cancel >= 0 ? cancel : Math.max(0, buttons.length - 1))
  }
  const note = (kind, args) => {
    const opts = args.find((a) => a && typeof a === 'object' && !a.webContents) ?? {}
    globalThis.__tourDialogs.push({ kind, title: opts.title ?? null, message: opts.message ?? null, detail: opts.detail ?? null, buttons: opts.buttons ?? null, properties: opts.properties ?? null, defaultPath: null })
    return opts
  }
  dialog.showOpenDialog = async (...a) => { note('open', a); return { canceled: true, filePaths: [] } }
  dialog.showSaveDialog = async (...a) => { note('save', a); return { canceled: true } }
  dialog.showMessageBox = async (...a) => { const o = note('message', a); return { response: decline(o), checkboxChecked: false } }
  dialog.showMessageBoxSync = (...a) => decline(note('message', a))
  dialog.showOpenDialogSync = (...a) => { note('open', a); return undefined }
  dialog.showErrorBox = (title, content) => { globalThis.__tourDialogs.push({ kind: 'error', title, message: content }) }
  // Only this computer's own pages and loopback; everything else is refused before it leaves.
  const refuse = (ses) => ses.webRequest.onBeforeRequest((details, cb) => {
    const url = details.url
    const local = /^(file|devtools|chrome-extension|data|blob|about|app|tw|twmedia|talkweaver)[a-z-]*:/i.test(url) || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(url)
    cb({ cancel: !local })
  })
  refuse(session.defaultSession)
  electronApp.on('session-created', refuse)
  const place = (win) => {
    win.setMinimumSize(0, 0)
    win.setBounds({ x: -20000, y: -20000, width: size.w, height: size.h })
    win.setContentSize(size.w, size.h)
    win.hide()
  }
  BrowserWindow.getAllWindows().forEach(place)
  electronApp.on('browser-window-created', (_event, win) => { place(win); win.once('ready-to-show', () => place(win)) })
  if (size.geometry) {
    // The status-bar agent offer is switched off under TW_E2E. The owner's window showed it ("TalkWeaver found Claude Code,
    // Codex, Gemini CLI"), so the geometry check puts it back, with the three agents of his computer and the app's own wording.
    ipcMain.removeHandler('agent-skill:offer')
    ipcMain.handle('agent-skill:offer', () => ({ kind: 'later', via: [], agents: [['claude-code', 'Claude Code'], ['codex', 'Codex'], ['gemini-cli', 'Gemini CLI']].map(([id, name]) => ({ id, name, found: true, state: 'not-installed', canInstall: true })) }))
  }
  globalThis.__tourMenu = () => {
    const walk = (items) => items.map((i) => ({ label: i.label, type: i.type, accelerator: i.accelerator ?? null, enabled: i.enabled, submenu: i.submenu ? walk(i.submenu.items) : undefined }))
    const m = Menu.getApplicationMenu()
    return m ? walk(m.items) : null
  }
}, { w: WIDTH, h: HEIGHT, geometry: geomMode })

const page = await app.firstWindow()
await page.setViewportSize({ width: WIDTH, height: HEIGHT }).catch(() => {})
page.setDefaultTimeout(4000)
await page.waitForLoadState('domcontentloaded')
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(`main: ${e.message.slice(0, 200)}`))
await page.waitForTimeout(2500)

// ---- helpers handed to every recipe ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const kindOf = (p) => {
  const u = p.url()
  if (/settings\.html/.test(u)) return 'settings'
  if (/talk-weaver-thumb|thumb/.test(u) && !/index\.html/.test(u)) return 'thumb'
  if (/view=studio|view=tools|[?&]view=/.test(u)) return 'tools'
  if (/index\.html/.test(u)) return 'main'
  if (/^file:.*\/vault\//.test(u)) return 'present'
  return 'other'
}
const pagesOf = (kind) => app.windows().filter((p) => !p.isClosed() && kindOf(p) === kind)
const seenOther = new Set()
// Hidden worker pages (thumbnails, layout previews, capture) are not surfaces; real windows are main, tools, settings, presenter views.
const allVisibleWindows = () => app.windows().filter((p) => {
  if (p.isClosed()) return false
  const k = kindOf(p)
  if (k === 'other' && !seenOther.has(p.url())) { seenOther.add(p.url()); console.log('[tour] worker page ignored:', p.url().slice(0, 100)) }
  if (k === 'present' && !seenOther.has(p.url())) { seenOther.add(p.url()); console.log('[tour] presenting page:', p.url().slice(-90)) }
  return k !== 'thumb' && k !== 'other'
})

let colourScheme = 'light'
async function prepare(p) {
  if (p.__tourScheme !== colourScheme) { p.__tourScheme = colourScheme; await p.emulateMedia({ colorScheme: colourScheme }).catch(() => {}) }
  if (p.__tourReady) return
  p.__tourReady = true
  await p.setViewportSize({ width: WIDTH, height: HEIGHT }).catch(() => {})
  p.setDefaultTimeout(4000)
  p.on('pageerror', (e) => pageErrors.push(`${kindOf(p)}: ${e.message.slice(0, 200)}`))
}

/** The visible surfaces of a page: dialogs, menus, popovers, sheets and similar. */
const SURFACE_SELECTOR = '[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[aria-modal=true],[role=tooltip],[class*=modal],[class*=sheet],[class*=popover],[class*=flyout],[class*=scrim],[class*=backdrop],[class*=overlay],[class*=popup],[class*=-menu]'
const snapshotJs = (selector) => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 20 && r.height > 14 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0' }
  const els = [...document.querySelectorAll(selector)].filter(visible)
  // keep the outermost matches only
  const outer = els.filter((e) => !els.some((o) => o !== e && o.contains(e)))
  return {
    overlays: outer.map((e) => ({ key: `${e.tagName}.${String(e.className).slice(0, 80)}|${(e.getAttribute('role') ?? '')}`, text: (e.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 600), area: Math.round(e.getBoundingClientRect().width * e.getBoundingClientRect().height) })),
    toasts: [...document.querySelectorAll('[role=status],[role=alert]')].filter(visible).map((e) => (e.innerText ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean),
    text: (document.body?.innerText ?? '').split('\n').map((l) => l.trim()).filter(Boolean),
    focus: document.activeElement ? `${document.activeElement.tagName}.${String(document.activeElement.className).slice(0, 40)}` : ''
  }
}
async function snap(p) {
  try { return await p.evaluate(snapshotJs, SURFACE_SELECTOR) } catch { return { overlays: [], toasts: [], text: [], focus: '' } }
}
function diffSnap(before, after) {
  const known = new Map(before.overlays.map((o) => [o.key, o.text]))
  const fresh = after.overlays.filter((o) => !known.has(o.key) || known.get(o.key) !== o.text)
  const had = new Set(before.text)
  const toastText = (after.toasts ?? []).join(' ')
  const newLines = after.text.filter((l) => !had.has(l) && !(toastText && toastText.includes(l)))
  const toasts = (after.toasts ?? []).filter((x) => !(before.toasts ?? []).includes(x))
  return { fresh, newLines, toasts }
}

const state = { current: null }

function makeTools(surface) {
  const t = {
    surface, page, app, vault, userData, seeded, allowWrites: flag('allow-writes'), sleep, openTalkByTitle, MAIN_TALK, pagesOf, kindOf, prepare, snap,
    /** Window the screenshot is taken of. Recipes may change it (settings, tools, presenter). */
    shootPage: page, shootLabel: 'main', extraShots: [], notes: [], method: null, signal: null, skipReason: null, status: null,
    note(text) { t.notes.push(text) },
    async dialogs() { return app.evaluate(() => globalThis.__tourDialogs ?? []) },
    async clearDialogs() { await app.evaluate(() => { globalThis.__tourDialogs = [] }) },
    /** Send a registry command the way the menu bar does (app:run-command) to a window's page. */
    async command(id, target = page) {
      if (target === page && /^tools-(view|open)/.test(id)) { const tools = await t.openTools(); t.shootPage = tools; t.shootLabel = 'tools'; target = tools }
      const url = target.url()
      await app.evaluate(({ BrowserWindow }, { id: commandId, url: pageUrl }) => {
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL() === pageUrl)
        win?.webContents.send('app:run-command', commandId)
      }, { id, url })
      t.method = t.method ?? `command:${id}`
    },
    /** Type a label into the All commands palette and run the first match. */
    async palette(label, target = page) {
      await target.keyboard.press('Meta+Shift+P')
      await target.waitForTimeout(350)
      await target.keyboard.type(label)
      await target.waitForTimeout(350)
      await target.keyboard.press('Enter')
      t.method = t.method ?? `palette:${label}`
    },
    async click(spec, opts = {}) {
      const target = opts.page ?? page
      let loc
      if (spec instanceof RegExp || typeof spec === 'string') {
        loc = target.locator(opts.within ?? 'body').getByText(spec, { exact: typeof spec === 'string' && opts.exact !== false })
      } else loc = spec
      const visible = loc.filter({ visible: true })
      try { await visible.first().click({ timeout: opts.timeout ?? 3000, force: opts.force, button: opts.button }) }
      catch (error) { await visible.first().click({ timeout: 2500, force: true, button: opts.button }).catch(() => { throw error }) }
      t.method = t.method ?? `click:${String(spec).slice(0, 40)}`
      if (opts.settle !== 0) await target.waitForTimeout(opts.settle ?? 350)
    },
    async button(name, opts = {}) {
      const target = opts.page ?? page
      const scope = opts.within ? target.locator(opts.within) : target
      const loc = scope.getByRole('button', { name, exact: opts.exact ?? typeof name === 'string' }).filter({ visible: true }).first()
      await loc.click({ timeout: opts.timeout ?? 4000, button: opts.button })
      t.method = t.method ?? `click button:${String(name).slice(0, 40)}`
      await target.waitForTimeout(opts.settle ?? 350)
    },
    async key(chord, target = page) { await target.keyboard.press(chord); await target.waitForTimeout(350) },
    async visible(selector, target = page) { return target.locator(selector).filter({ visible: true }).count().then((n) => n > 0).catch(() => false) },
    async waitFor(selector, target = page, timeout = 4000) { await target.locator(selector).filter({ visible: true }).first().waitFor({ state: 'visible', timeout }) },
    async text(selector, target = page) { return target.locator(selector).filter({ visible: true }).first().innerText().catch(() => '') },
    skip(reason) { t.skipReason = reason; throw Object.assign(new Error(reason), { tourSkip: true }) },
    missing(reason) { throw Object.assign(new Error(reason), { tourMissing: true }) },
    async windowOf(kind, timeout = 8000) {
      const end = Date.now() + timeout
      for (;;) {
        const w = pagesOf(kind)[0]
        if (w) { await prepare(w); await w.waitForLoadState('domcontentloaded').catch(() => {}); return w }
        if (Date.now() > end) throw new Error(`no ${kind} window appeared`)
        await sleep(150)
      }
    },
    async openTools(view) {
      let tools = pagesOf('tools')[0]
      if (!tools) { await t.command('studio'); tools = await t.windowOf('tools') }
      await tools.waitForTimeout(1200)
      if (view) { await t.command(view, tools); await tools.waitForTimeout(900) }
      return tools
    },
    async openSettings(section) {
      let sw = pagesOf('settings')[0]
      if (!sw) { await page.keyboard.press('Meta+,'); sw = await t.windowOf('settings') }
      await sw.locator('button.bsw-nav').first().waitFor({ state: 'attached', timeout: 8000 })
      if (section) { await sw.locator(`button.bsw-nav[data-section="${section}"]:visible`).click(); await sw.waitForTimeout(250) }
      return sw
    },
    async openTalk(title = MAIN_TALK) { await openTalkByTitle(page, title); await page.waitForTimeout(900) },
    async selectSlide(n = 3) {
      await page.locator('.tw-slide-card, [data-slide-index]').first().waitFor({ timeout: 4000 }).catch(() => {})
      const cards = page.locator('.tw-slide-card')
      const count = await cards.count()
      if (count > 0) await cards.nth(Math.min(n, count - 1)).click().catch(() => {})
      await page.waitForTimeout(300)
    },
  }
  return t
}

// ---- base state -----------------------------------------------------------------------------------------------
async function closeExtraWindows() {
  for (const p of app.windows()) {
    if (p === page || p.isClosed()) continue
    if (kindOf(p) === 'thumb') continue
    await p.close().catch(() => {})
  }
  for (let i = 0; i < 30 && allVisibleWindows().length > 1; i += 1) await sleep(50)
}
const unexpected = []
let baseStorage = null
const editorUp = () => page.locator('.cm-content').first().isVisible().catch(() => false)
/** Caret on the "About this showcase" slide: the cheap precondition most slide commands want. */
async function placeCaret() {
  const line = page.locator('.cm-line', { hasText: 'About' }).filter({ visible: true }).first()
  await line.click({ position: { x: 60, y: 8 }, timeout: 2500 }).catch(async () => { await page.locator('.cm-content').first().click({ timeout: 1500 }).catch(() => {}) })
  await page.waitForTimeout(250)
}
async function resetBase(label, { hard = true } = {}) {
  await closeExtraWindows()
  for (let i = 0; i < 3; i += 1) {
    const s = await snap(page)
    if (!s.overlays.some((o) => o.area > 4000)) break
    await page.keyboard.press('Escape'); await page.waitForTimeout(150)
  }
  if (hard && baseStorage) {
    // The honest way back to a known state: the page's own stored preferences as they were, a fresh page, the talk reopened.
    await page.evaluate((snapshot) => { localStorage.clear(); for (const [k, v] of Object.entries(snapshot)) localStorage.setItem(k, v) }, baseStorage).catch(() => {})
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {})
    await page.waitForTimeout(1200)
  }
  if (!(await editorUp())) { await openTalkByTitle(page, MAIN_TALK).catch(() => {}); await page.waitForTimeout(700) }
  await placeCaret()
  await ensureTalksMode(page, { timeout: 3000 }).catch(() => {})
  const left = await snap(page)
  const stuck = left.overlays.filter((o) => o.area > 20000)
  if (stuck.length) unexpected.push({ after: label, kind: 'overlay still present after reset', text: stuck.map((o) => o.text.slice(0, 120)).join(' | ') })
}

async function shoot(p, file) {
  await p.screenshot({ path: join(SHOTS, file) })
}

// ---- one surface -----------------------------------------------------------------------------------------------
const results = new Map()
const take = (s) => (only ? only.includes(s.id) : true)

async function runSurface(surface, recipe, theme, opts = {}) {
  const wantShot = !geomMode || !!opts.base
  const shotName = opts.base ? `${opts.base}.png` : `${surface.id}${theme === 'dark' ? '--dark' : ''}.png`
  const started = Date.now()
  const entry = {
    id: surface.id, state: opts.base ? `base:${opts.base}` : surface.id, base: !!opts.base, title: surface.title, feature: surface.feature, surface_type: surface.surface_type,
    status: 'could-not-open', method: null, window: null, screenshot: null, note: '', evidence: null, reason: null, theme
  }
  const t = makeTools(surface)
  if (geomMode && opts.base) t.allowWrites = true
  try {
    if (!recipe) { entry.status = 'could-not-open'; entry.reason = 'no recipe: the surface was not reached by this tour'; return entry }
    if (recipe.skip) { entry.status = 'skipped'; entry.reason = recipe.skip; entry.note = recipe.skipNote ?? ''; return entry }
    if (surface.opening_changes_data && !flag('allow-writes') && !(geomMode && opts.base) && !recipe.openEvenIfFlagged) {
      entry.status = 'skipped'; entry.reason = `opening_changes_data: true (${surface.data_change_note ?? 'opening may change data'})`; return entry
    }
    await resetBase(surface.id)
    await t.clearDialogs()
    const winsBefore = new Set(allVisibleWindows())
    const before = await snap(page)
    const work = (async () => {
      if (recipe.run) await recipe.run(t)
      else if (recipe.cmd) await t.command(recipe.cmd)
      await t.sleep(recipe.settle ?? 700)
    })()
    let timer
    await Promise.race([work, new Promise((_r, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`timed out after ${PER_SURFACE_MS / 1000} s`), { tourTimeout: true })), PER_SURFACE_MS) })])
    clearTimeout(timer)
    for (const w of allVisibleWindows()) await prepare(w)
    const newWindows = allVisibleWindows().filter((w) => !winsBefore.has(w))
    if (t.shootPage === page && newWindows.length && !recipe.shootMain) {
      t.shootPage = newWindows[0]; t.shootLabel = kindOf(newWindows[0])
      await newWindows[0].waitForLoadState('domcontentloaded').catch(() => {}); await sleep(900)
      t.extraShots.push({ label: 'main', page })
    }
    const shootPage = t.shootPage
    const after = await snap(shootPage)
    const d = shootPage === page ? diffSnap(before, after) : { fresh: after.overlays, newLines: after.text, toasts: after.toasts ?? [] }
    const dialogs = await t.dialogs()
    // What counts as "the surface is on screen": the recipe's own check when it has one, else something new appeared.
    let verified = null
    if (recipe.observe) verified = recipe.observe.test((after.text ?? []).join('\n'))
    else if (recipe.verify) verified = await recipe.verify(t, { d, after, newWindows })
    if (process.env.TOUR_DEBUG) {
      const dump = await shootPage.evaluate((selector) => {
        const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4 }
        const roots = [...document.querySelectorAll(selector)].filter(visible)
        const scope = roots.length ? roots.filter((r) => !roots.some((o) => o !== r && o.contains(r))) : [document.body]
        const label = (e) => `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : ''}${e.getAttribute('data-testid') ? '#' + e.getAttribute('data-testid') : ''}[${(e.getAttribute('aria-label') || e.textContent || e.getAttribute('placeholder') || e.value || '').trim().replace(/\s+/g, ' ').slice(0, 34)}]`
        return scope.map((r) => `{${r.tagName.toLowerCase()}.${String(r.className).split(' ')[0]}: ` + [...r.querySelectorAll('button,[role=menuitem],[role=tab],input,select,textarea,a[href],[data-testid]')].filter(visible).map(label).slice(0, 40).join(' ') + '}').join('\n   ')
      }, SURFACE_SELECTOR).catch(() => '')
      console.log(`[debug ${surface.id}] fresh=${JSON.stringify(d.fresh.map((o) => o.key.split('|')[0] + ':' + o.text.slice(0, 60)))} toasts=${JSON.stringify(d.toasts)} wins=${newWindows.map(kindOf)}\n   ${dump}`)
    }
    const appeared = d.fresh.length > 0 || newWindows.length > 0 || d.newLines.length >= 3
    const refusal = d.toasts.find((x) => /first|can.t|cannot|not available|no .* yet|nothing|isn.t|needs|only|has changed|wait for|try again/i.test(x))
    if ((recipe.verify || recipe.observe) ? !verified : (!appeared || (refusal && !d.fresh.length && !newWindows.length))) {
      entry.status = 'could-not-open'
      entry.reason = (recipe.verify || recipe.observe) ? `the check for the surface failed (${recipe.verifyNote ?? 'expected content absent'})` : refusal ? `the app answered with a notice instead: ${refusal.slice(0, 120)}` : 'nothing new appeared on screen after the action'
      entry.method = t.method
      entry.note = (t.notes.join(' ') + ' ' + (dialogs.length ? `native dialog(s): ${JSON.stringify(dialogs).slice(0, 300)}` : '')).trim()
      if (wantShot) { try { entry.screenshot = relative(OUT, join(SHOTS, shotName)); await shoot(shootPage, shotName); entry.window = t.shootLabel } catch { entry.screenshot = null } }
      entry.evidence = 'screenshot kept as evidence of the failed attempt; it does NOT show the surface'
      return entry
    }
    if (geomMode) {
      const label = `${t.shootLabel}`
      const g = await runGeometry(shootPage, label)
      entry.window = label
      entry.viewport = g.viewport
      entry.metrics = g.metrics
      entry.violations = g.violations
      entry.viewport_ok = g.viewport.innerWidth === WIDTH && g.viewport.innerHeight === HEIGHT
    }
    const file = shotName
    if (wantShot) { await shoot(shootPage, file); entry.screenshot = relative(OUT, join(SHOTS, file)) }
    entry.window = t.shootLabel
    for (const extra of (wantShot && !geomMode ? t.extraShots : [])) {
      const f = `${surface.id}--${extra.label}${theme === 'dark' ? '--dark' : ''}.png`
      try { await shoot(extra.page, f); entry.extraShots = [...(entry.extraShots ?? []), { label: extra.label, screenshot: relative(OUT, join(SHOTS, f)) }] } catch { /* window gone */ }
    }
    entry.status = 'opened'
    entry.method = t.method
    const biggest = [...d.fresh].sort((a, b) => b.area - a.area)[0]
    entry.note = (recipe.noteFrom ? await recipe.noteFrom(t) : (biggest?.text || d.newLines.join(' ') || '')).replace(/\s+/g, ' ').slice(0, 200)
    entry.evidence = newWindows.length ? `new window: ${newWindows.map(kindOf).join(', ')}` : d.fresh.length ? `new on screen: ${d.fresh.map((o) => o.key.split('|')[0].slice(0, 50)).join(', ')}` : `${d.newLines.length} new lines of text`
    if (dialogs.length) entry.note += ` [native dialog: ${JSON.stringify(dialogs[0]).slice(0, 160)}]`
    if (recipe.expectedWindows !== undefined) { /* reserved */ }
    const extraWins = newWindows.filter((w) => !(recipe.windows ?? []).includes(kindOf(w)) && kindOf(w) !== t.shootLabel)
    if (extraWins.length) unexpected.push({ after: surface.id, kind: 'extra window', text: extraWins.map(kindOf).join(', ') })
    return entry
  } catch (error) {
    entry.method = t.method
    if (error?.tourSkip) { entry.status = 'skipped'; entry.reason = error.message; return entry }
    if (error?.tourMissing) { entry.status = 'precondition-missing'; entry.reason = error.message; return entry }
    entry.status = 'could-not-open'
    entry.reason = String(error?.message ?? error).split('\n')[0].slice(0, 220)
    if (process.env.TOUR_DEBUG) {
      const sp = t.shootPage.isClosed() ? page : t.shootPage
      const dump = await sp.evaluate((selector) => {
        const visible = (e) => { const r = e.getBoundingClientRect(); return r.width > 4 && r.height > 4 }
        const roots = [...document.querySelectorAll(selector)].filter(visible)
        const scope = roots.length ? roots.filter((r) => !roots.some((o) => o !== r && o.contains(r))) : [document.body]
        const label = (e) => `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? '.' + e.className.split(' ')[0] : ''}[${(e.getAttribute('aria-label') || e.textContent || e.getAttribute('placeholder') || e.value || '').trim().replace(/\s+/g, ' ').slice(0, 30)}]`
        return scope.map((r) => `{${r.tagName.toLowerCase()}.${String(r.className).split(' ')[0]}: ` + [...r.querySelectorAll('button,[role=menuitem],[role=tab],input,select,textarea,a[href]')].filter(visible).map(label).slice(0, 45).join(' ') + '}').join('\n   ')
      }, SURFACE_SELECTOR).catch(() => '')
      console.log(`[fail ${surface.id}] ${entry.reason}\n   ${dump}`)
    }
    if (wantShot) try {
      const file = shotName
      await shoot(t.shootPage.isClosed() ? page : t.shootPage, file)
      entry.screenshot = relative(OUT, join(SHOTS, file)); entry.window = t.shootLabel
      entry.evidence = 'screenshot kept as evidence of the failed attempt; it does NOT show the surface'
    } catch { /* nothing to keep */ }
    return entry
  } finally {
    entry.elapsed_ms = Date.now() - started
  }
}

// ---- the tour --------------------------------------------------------------------------------------------------
let report = { generated: new Date().toISOString(), app_version: null, window: `${WIDTH}x${HEIGHT}`, entries: [], dark: [], unexpected: [], page_errors: [] }
if ((only || flag('dark-only')) && existsSync(REPORT)) report = JSON.parse(readFileSync(REPORT, 'utf8'))
report.app_version = await page.evaluate(() => window.tw?.app?.version?.()).catch(() => null)

let order = surfaces.filter(take)

// ---- geometry mode (R17): base states first, then (unless --base-only) every surface, at the requested size ---------
// The "no talk open" state needs the window as it is at launch, so it is measured before the talk is opened.
const geometryStates = []
if (geomMode) {
  // reload: the page asked for the agent offer before the stand-in above was installed
  if (opt('sidebar')) await page.evaluate((px) => localStorage.setItem('tw-sidebar', px), opt('sidebar'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
}
if (geomMode) {
  const viewportOf = (p) => p.evaluate(() => ({ innerWidth: window.innerWidth, innerHeight: window.innerHeight })).catch(() => null)
  const first = await viewportOf(page)
  console.log(`[geometry] requested ${WIDTH}x${HEIGHT}; main page reports ${first?.innerWidth}x${first?.innerHeight}`)
  {
    const entry = { id: 'no-talk', state: 'base:no-talk', base: true, status: 'opened', screenshot: null }
    const talkOpen = await editorUp()
    if (talkOpen) { entry.status = 'could-not-open'; entry.reason = 'a talk was already open at launch' }
    else {
      const g = await runGeometry(page, 'main')
      Object.assign(entry, { window: 'main', viewport: g.viewport, metrics: g.metrics, violations: g.violations, viewport_ok: g.viewport.innerWidth === WIDTH && g.viewport.innerHeight === HEIGHT })
      await shoot(page, 'no-talk.png'); entry.screenshot = relative(OUT, join(SHOTS, 'no-talk.png'))
    }
    geometryStates.push(entry)
    console.log(`[geometry] base:no-talk ${entry.status} ${entry.violations?.length ?? 0} findings`)
  }
}

// Parents first: windows and menus a child needs are opened by the child's own recipe, so order does not matter much,
// but do the cheap main-window surfaces before the heavy ones.
await openTalkByTitle(page, MAIN_TALK).catch((e) => console.log('open talk failed', e.message))
await page.waitForTimeout(1500)
baseStorage = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)))

if (geomMode) {
  const BASE = [
    ['plain', 'plain-editor'], ['markdown', 'markdown-editor'], ['guide', 'guide'], ['research', 'research'], ['image-drawer', 'image-drawer'],
    ['scratchpad-collapsed', 'scratchpad-pill', { cmd: 'scratchpad-collapse', verify: (t) => t.visible('.sp-pill') }], ['scratchpad-expanded', 'scratchpad-docked'], ['scratchpad-floating', 'scratchpad-float'],
    ['tools-studio', 'studio'], ['tools-history', 'history'], ['tools-importer', 'importer'], ['tools-sessions', 'sessions'], ['tools-published', 'published'], ['tools-work-files', 'work-files'],
    ['settings', 'settings'], ['presenter', 'presenter'],
    // Added in batch 2 (round 6): the Grid with the Talks sidebar open, the widest toolbar the main window has to fit.
    ['grid-talks-open', 'grid', { run: async (t) => { const expand = t.page.locator('[data-sidebar-expand]'); if (await expand.count()) await expand.first().click(); await t.sleep(500); await t.command('view-grid'); await t.sleep(500) }, verify: (t) => t.visible('.pane--grid') }]
  ]
  const recipeFor = (surface) => TOUR_RECIPES[surface.id] ?? fallbackRecipe(surface) ?? (surface.open.command_id ? { cmd: surface.open.command_id } : null)
  const states = [...geometryStates]
  for (const [label, id, override] of BASE) {
    const surface = surfaces.find((x) => x.id === id)
    if (!surface) { states.push({ id, state: `base:${label}`, base: true, status: 'could-not-open', reason: `no surface "${id}" in surfaces.json` }); continue }
    const entry = await runSurface(surface, override ?? recipeFor(surface), 'light', { base: label })
    states.push(entry)
    console.log(`[geometry] base:${label.padEnd(20)} ${entry.status.padEnd(14)} ${entry.violations?.length ?? 0} findings${entry.viewport_ok === false ? ' VIEWPORT ' + JSON.stringify(entry.viewport) : ''}${entry.reason ? '  - ' + entry.reason.slice(0, 80) : ''}`)
  }
  let n = 0
  if (!flag('base-only')) {
        for (const surface of order) {
      n += 1
      const entry = await runSurface(surface, recipeFor(surface), 'light')
      states.push(entry)
      console.log(`[geometry] ${String(n).padStart(3)}/${order.length} ${entry.status.padEnd(20)} ${surface.id} ${entry.violations?.length ?? 0} findings`)
    }
  }
  const mismatches = states.filter((e) => e.status === 'opened' && e.viewport_ok === false).map((e) => `${e.state} ${e.viewport.innerWidth}x${e.viewport.innerHeight}`)
  const reports = new Set(states.filter((e) => e.viewport).map((e) => `${e.viewport.innerWidth}x${e.viewport.innerHeight}`))
  const geomReport = {
    generated: new Date().toISOString(), app_version: await page.evaluate(() => window.tw?.app?.version?.()).catch(() => null),
    size: `${WIDTH}x${HEIGHT}`, viewport_report: [...reports].join(', ') || 'none', viewport_mismatches: mismatches,
    base_only: flag('base-only'),
    states: states.map((e) => ({ state: e.state, base: !!e.base, status: e.status, reason: e.reason ?? null, window: e.window ?? null, screenshot: e.screenshot ?? null, viewport: e.viewport ?? null, viewport_ok: e.viewport_ok ?? null, metrics: e.metrics ?? null, violations: e.violations ?? [] })),
    page_errors: [...new Set(pageErrors)].slice(0, 20)
  }
  const score = writeGeometryReport(OUT, geomReport)
  if (spawnSync('which', ['pngquant']).status === 0) for (const f of readdirSync(SHOTS)) if (f.endsWith('.png')) spawnSync('pngquant', ['--force', '--skip-if-larger', '--ext', '.png', '--quality=60-85', join(SHOTS, f)])
  let bytes = 0
  for (const f of readdirSync(SHOTS)) bytes += statSync(join(SHOTS, f)).size
  console.log(`[geometry] size ${WIDTH}x${HEIGHT}: geometry score ${score}; viewports ${geomReport.viewport_report}; ${mismatches.length} mismatches; shots ${(bytes / 1024).toFixed(0)} KB`)
  await Promise.race([app.close().catch(() => {}), sleep(8000)])
  try { process.kill(app.process().pid) } catch { /* gone */ }
  try { rmSync(scratch, { recursive: true, force: true }) } catch { /* leave it in tmp */ }
  process.exit(0)
}

if (!flag('dark-only')) {
  let n = 0
  for (const surface of order) {
    n += 1
    const recipe = TOUR_RECIPES[surface.id] ?? fallbackRecipe(surface) ?? (surface.open.command_id ? { cmd: surface.open.command_id } : null)
    const entry = await runSurface(surface, recipe, 'light')
    results.set(surface.id, entry)
    console.log(`[tour] ${String(n).padStart(3)}/${order.length} ${entry.status.padEnd(20)} ${surface.id}${entry.reason ? '  — ' + entry.reason.slice(0, 90) : ''}`)
  }
  const byId = new Map(report.entries.map((e) => [e.id, e]))
  for (const [id, e] of results) byId.set(id, e)
  report.entries = surfaces.map((s) => byId.get(s.id)).filter(Boolean)
  report.unexpected = [...(only ? report.unexpected.filter((u) => !only.includes(u.after)) : []), ...unexpected]
}

// ---- dark pass over the seven windows ---------------------------------------------------------------------------
if (!flag('no-dark') && (!only || flag('dark-only'))) {
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark' })
  colourScheme = 'dark'
  await prepare(page)
  report.dark = []
  for (const surface of surfaces.filter((s) => s.surface_type === 'window')) {
    const recipe = TOUR_RECIPES[surface.id] ?? fallbackRecipe(surface) ?? (surface.open.command_id ? { cmd: surface.open.command_id } : null)
    const entry = await runSurface(surface, recipe, 'dark')
    report.dark.push(entry)
    console.log(`[tour] dark ${entry.status.padEnd(20)} ${surface.id}${entry.reason ? '  — ' + entry.reason.slice(0, 90) : ''}`)
  }
  await app.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'light' })
  colourScheme = 'light'
  await prepare(page)
}

report.extra_surfaces = [
  { note: 'Guide progress toast "✓ Ticked · <command name>" appears whenever a Guide-listed command is run (seen after Guide, Settings, Plan a Run); not listed as a surface of its own', shot: 'shots/guide.png' },
  { note: 'Hover flyout card on a Talks row (title, slides, dates, handout, warnings, "Click to open") appears whenever the pointer rests on a talk in any Talks view (listed only for the Ledger view)', shot: 'shots/talk-flyout.png' },
  { note: 'Inline validation toast "Choose a date." in the Plan a Run sheet when Save is pressed without a date', shot: null },
  { note: 'Gallery measuring toast "0 of 12 sizes measured" appears in the Vault Gallery while sizes are being counted', shot: 'shots/gallery-details.png' },
  { note: 'Settings shortcut recorder shows a Swap / Replace / Cancel row when a chord is already used (listed) and a separate refused notice for reserved chords (listed); both live in the same list row', shot: 'shots/settings-key-conflict.png' },
  { note: 'Refusal toast "Present failed: Gallery source helper unavailable" appeared when the native gallery helper (npm run build:gallery-native:host) had not been built; the script now builds it', shot: null }
]
report.page_errors = [...new Set(pageErrors)].slice(0, 60)
report.main_process_output_tail = mainOutput.split('\n').filter((l) => /error|warn|unhandled/i.test(l)).slice(-20)
writeFileSync(REPORT, JSON.stringify(report, null, 2))
writeSummary(OUT, surfaces, report)
writeContactSheet(OUT, surfaces, report)

// size of the shots
let bytes = 0
for (const f of readdirSync(SHOTS)) bytes += statSync(join(SHOTS, f)).size
console.log(`[tour] shots: ${readdirSync(SHOTS).length} files, ${(bytes / 1048576).toFixed(1)} MB`)
const counts = {}
for (const e of report.entries) counts[e.status] = (counts[e.status] ?? 0) + 1
console.log('[tour] statuses', JSON.stringify(counts))

await Promise.race([app.close().catch(() => {}), sleep(8000)])
try { process.kill(app.process().pid) } catch { /* gone */ }
try { rmSync(scratch, { recursive: true, force: true }) } catch { /* leave it in tmp */ }
process.exit(0)

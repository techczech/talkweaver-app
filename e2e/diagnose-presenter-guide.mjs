// Onboarding 0.38.1 ticket 10, in the real app: the Present chapter as its own column in the presenter.
// A profile with a vault of its own presents a talk in the presenter window TalkWeaver opens. Checked
// where only Electron can check it (contextIsolation, the real preload, main's window geometry):
//   - the button "Guide · Present N of M" (no key) is in the presenter's bottom bar beside Outline while the Guide button is on;
//   - → in the presenter reaches main through the bridge (the page's event crosses into the preload's
//     isolated world) and is in the record in app config; the chip's count rises (main's push);
//   - the button opens the column and again closes it (C does nothing), at presenter widths 1024, 1280 and 1512: the bounds of
//     every window are UNCHANGED by toggling (review round 1: the column never resizes or moves the
//     window), nothing overlaps the column and the stage stays visible;
//   - "All chapters" in the column brings the editor window's Guide to the chapter list (a bare request);
//   - the × beside the button turns the Settings switch off: no button, no column, in both windows.
// Windows are moved off screen and hidden; one run at a time.
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && node e2e/diagnose-presenter-guide.mjs
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { guideLearnFrom } from '../src/shared/guide-learn.ts'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const results = []
function record(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(read, ok, timeout = 8000) {
  const end = Date.now() + timeout
  for (;;) {
    const value = await read()
    if (ok(value) || Date.now() > end) return value
    await sleep(100)
  }
}

const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'tw-e2e-presenter-guide-')))
const home = join(tempRoot, 'home')
const userData = join(tempRoot, 'userData')
const personal = join(tempRoot, 'Personal')
const talkDir = join(personal, 'alpha-talk')
mkdirSync(join(home, 'Documents'), { recursive: true })
mkdirSync(talkDir, { recursive: true })
mkdirSync(userData, { recursive: true })
const outlinePath = join(talkDir, 'alpha-talk-outline.md')
const source = '---\ntitle: Alpha Talk\noutline_version: 2\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n## Section\n\n### First slide {id=a1}\n\nBody one.\n\n:::notes\nSay one thing.\n:::\n\n### Second slide {id=a2}\n\nBody two.\n'
writeFileSync(outlinePath, source)
const configPath = join(userData, 'config.json')
writeFileSync(configPath, JSON.stringify({ vaultRoot: personal }, null, 2))
const learnOnDisk = () => guideLearnFrom(JSON.parse(readFileSync(configPath, 'utf8')).guideLearn)

await ensureFreshBuild(REPO)
const app = await electron.launch({ args: ['.', '--user-data-dir=' + userData], cwd: REPO, env: { ...process.env, TW_E2E: '1', TW_E2E_HOME: home, TW_REC_TEST: '1' } })
try {
  const editor = await app.firstWindow()
  await editor.waitForLoadState('domcontentloaded')
  await editor.waitForTimeout(800)
  const presenterPromise = app.waitForEvent('window')
  const opened = editor.evaluate(({ path, text }) => window.tw.talk.present(path, text, 'presenter'), { path: outlinePath, text: source })
  const presenter = await presenterPromise
  record('the talk is presented', (await opened).success === true)
  await presenter.waitForLoadState('domcontentloaded')
  presenter.setDefaultTimeout(30_000)
  // A known size and place for the presenter, on its display (main reads the display's work area).
  const bounds = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ id: w.webContents.id, title: w.getTitle(), ...w.getBounds() })))
  await app.evaluate(({ BrowserWindow, screen }) => {
    const area = screen.getPrimaryDisplay().workArea
    for (const w of BrowserWindow.getAllWindows()) { w.setBounds({ x: area.x, y: area.y, width: 1200, height: 800 }) }
  })
  await presenter.waitForFunction(() => /scale\(([\d.]+)\)/.test(document.querySelector('#currentPreview iframe')?.style.transform || ''), null, { timeout: 30_000 }).catch(() => {})
  if (await presenter.isVisible('#twResume').catch(() => false)) await presenter.click('#twResumeNo')
  const errors = []
  presenter.on('pageerror', (error) => errors.push(error.message))

  const chip = await until(() => presenter.evaluate(() => document.getElementById('twguide-chip')?.textContent.replace(/\s+/g, ' ').trim() || ''), Boolean)
  record('the Guide button reads "Guide · Present 0 of N" with no key', /^Guide · Present ?0 of \d+$/.test(chip), chip)
  record('it is in the bottom bar, beside Outline', await presenter.evaluate(() => document.getElementById('twguide-chip')?.parentElement?.previousElementSibling?.id === 'outlineBtn' && !!document.getElementById('twguide-chip').closest('#presenterBottomBar')))
  await presenter.keyboard.press('c')
  await sleep(300)
  record('C opens the Present chapter', await until(() => presenter.evaluate(() => !!document.getElementById('twguide-col')), Boolean))
  await presenter.keyboard.press('c')
  record('C closes the Present chapter again', await until(() => presenter.evaluate(() => !document.getElementById('twguide-col')), Boolean))

  // → reaches main through the bridge: the page's event crosses into the isolated preload.
  await presenter.keyboard.press('ArrowRight')
  const ran = await until(() => learnOnDisk().ran, (r) => r.includes('presenter.next'))
  record('→ in the presenter is in the record in app config', ran.includes('presenter.next'), ran.join(', '))
  const ticked = await until(() => presenter.evaluate(() => document.querySelector('#twguide-chip b')?.textContent || ''), (t) => t.startsWith('2 of'))
  record('main pushes the count for Guide and Next to the presenter', ticked.startsWith('2 of'), ticked)
  const editorLearn = await editor.evaluate(() => window.tw.guide.getLearn())
  record('the editor reads the same record', Array.isArray(editorLearn?.ran) && editorLearn.ran.includes('presenter.next'))

  // The button: the column takes its room inside the page; no window is resized or moved, at several widths.
  const presenterId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => /Presenter/i.test(w.getTitle()))?.webContents.id ?? null)
  const area = await app.evaluate(({ screen, BrowserWindow }) => { const w = BrowserWindow.getAllWindows().find((x) => /Presenter/i.test(x.getTitle())); return screen.getDisplayMatching(w.getBounds()).workArea })
  const same = (a, b) => a.length === b.length && a.every((w) => { const o = b.find((x) => x.id === w.id); return o && o.x === w.x && o.y === w.y && o.width === w.width && o.height === w.height })
  const layout = () => presenter.evaluate(() => {
    const r = (s) => { const b = document.querySelector(s)?.getBoundingClientRect(); return b && b.width && b.height ? b : null }
    const col = r('#twguide-col')
    if (!col) return { open: false }
    const parts = ['.presenter-current-panel', '.presenter-side > .presenter-panel:first-child', '#presenterFollowing', '#presenterNotes', '#presenterTopBar', '#presenterBottomBar']
    const hit = parts.filter((s) => { const p = r(s); return p && col.left < p.right - 0.5 && p.left < col.right - 0.5 && col.top < p.bottom - 0.5 && p.top < col.bottom - 0.5 })
    const stage = r('#currentPreview')
    return { open: true, hit, stage: stage ? { w: Math.round(stage.width), h: Math.round(stage.height), right: stage.right } : null, colLeft: col.left, colWidth: Math.round(col.width), vw: innerWidth }
  })
  for (const width of [1024, 1280, 1512]) {
    const w = Math.min(width, area.width)
    await app.evaluate(({ BrowserWindow }, { id, w, area }) => {
      const win = BrowserWindow.getAllWindows().find((x) => x.webContents.id === id)
      win?.setBounds({ x: area.x, y: area.y, width: w, height: Math.min(900, area.height) })
    }, { id: presenterId, w, area })
    await sleep(500)
    const before = await bounds()
    await presenter.click('#twguide-chip')
    const opened = await until(layout, (l) => l.open, 4000)
    await sleep(400)
    const during = await bounds()
    const l = await layout()
    record(`${w}: the button opens the column`, opened.open)
    record(`${w}: no window is resized or moved by opening`, same(before, during), JSON.stringify(during.find((x) => x.id === presenterId)))
    record(`${w}: the column overlaps nothing in the real window`, l.open && l.hit.length === 0, l.hit?.join(', '))
    record(`${w}: the stage stays visible beside the column`, !!l.stage && l.stage.w >= 200 && l.stage.h >= 100 && l.stage.right <= l.colLeft + 0.5, `stage ${l.stage?.w}x${l.stage?.h}, column ${l.colWidth} of ${l.vw}`)
    await presenter.click('#twguide-chip')
    const shut = await until(layout, (x) => !x.open, 4000)
    await sleep(400)
    record(`${w}: the button again closes it and no window is resized or moved`, !shut.open && same(before, await bounds()))
  }
  const ranAfter = learnOnDisk().ran
  record('the Guide button is in the record too (presenter.guide)', ranAfter.includes('presenter.guide'))

  // "All chapters": the TalkWeaver window comes forward with the Guide open on the chapter list. Nothing but
  // a bare request leaves the presenter, and no other chapter's data goes into it.
  await presenter.click('#twguide-chip')
  await until(layout, (l) => l.open, 4000)
  await editor.evaluate(() => window.tw.settings.setGuideButtonVisible(true))
  await presenter.click('#twguide-col [data-guide-all-chapters]')
  const listed = await until(() => editor.evaluate(() => !!document.querySelector('[data-guide-chapters]') && !document.querySelector('[data-chapter-detail]')), Boolean, 6000)
  record('All chapters opens the Guide on the chapter list in the editor window', listed)
  const holdsOthers = await presenter.evaluate(() => /Write the outline|Build a slide|Manage talks|Set up TalkWeaver/.test(document.getElementById('twguide-col')?.textContent || ''))
  record('the presenter column still holds only the Present chapter', !holdsOthers)
  // From a chapter opened in the editor, All chapters brings it back to the list.
  await editor.locator('[data-chapter-row="Share"]').click().catch(() => {})
  const inChapter = await until(() => editor.evaluate(() => !!document.querySelector('[data-chapter-detail="Share"]')), Boolean, 4000)
  await presenter.click('#twguide-col [data-guide-all-chapters]')
  const backToList = await until(() => editor.evaluate(() => !document.querySelector('[data-chapter-detail]')), Boolean, 6000)
  record('with a chapter open in the editor, All chapters returns it to the list', inChapter && backToList)

  // The × beside the button turns the same Settings switch off: no button, no column.
  await presenter.click('#twguide-hide', { force: true })
  const gone = await until(() => presenter.evaluate(() => !document.getElementById('twguide-chip') && !document.getElementById('twguide-col')), Boolean, 6000)
  record('the × removes the button from the presenter', gone)
  const off = await until(() => editor.evaluate(() => window.tw.settings.getGuideButton().then((s) => s.visible === false)), Boolean, 4000)
  record('it turned off the Settings switch for the editor too', off)
  record('no page errors in the presenter', errors.length === 0, errors.join('; '))
} catch (error) {
  record('the run finished', false, String(error?.message || error).split('\n')[0])
} finally {
  await app.close().catch(() => {})
  rmSync(tempRoot, { recursive: true, force: true })
}
const failed = results.filter((r) => !r.pass).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)

// Real-Electron check of the deck windows' sandbox per present mode (present-window-prefs.ts):
//   - a plain presentation runs sandboxed, and its edit-only preload still loads there: the pencil
//     button is mounted and pressing it reaches the editor (present:edit-slide);
//   - the presenter (the recorder bridge) is the one deck window without the sandbox, and its
//     controls still mount;
//   - the audience view is sandboxed and has no preload.
// Run after `npm run build`: node e2e/diagnose-present-window-sandbox.mjs
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const FIX = ['---', 'title: Sandbox Deck Fixture', '---', '', '## Section', '', '### First slide', '{id=first1}', '', 'Hello.', '', '### Second slide', '{id=second2}', '', 'World.', ''].join('\n')
const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-present-sandbox-'))
const vault = join(tempRoot, 'vault')
const ud = join(tempRoot, 'userData')
const outlinePath = join(vault, 'sandbox-deck', 'sandbox-deck-fixture-outline.md')
mkdirSync(dirname(outlinePath), { recursive: true }); mkdirSync(ud, { recursive: true })
writeFileSync(outlinePath, FIX)
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault, editorViewMode: 'markdown' }, null, 2))

await ensureFreshBuild(REPO)
const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO, env: { ...process.env, TW_E2E: '1' } })
const main = await app.firstWindow()
await main.waitForLoadState('domcontentloaded')
await main.waitForTimeout(1200)

const prefsOf = (page) => app.evaluate(({ BrowserWindow }, url) => {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL() === url)
  const prefs = win?.webContents.getLastWebPreferences() ?? null
  // Electron does not report the preload path here, so the preload is judged by what it mounts.
  return prefs ? { sandbox: prefs.sandbox } : null
}, page.url())

async function present(mode) {
  const opened = app.waitForEvent('window')
  const result = await main.evaluate(({ p, c, m }) => window.tw.talk.present(p, c, m), { p: outlinePath, c: FIX, m: mode })
  if (!result?.success) throw new Error(`present ${mode} failed: ${JSON.stringify(result)}`)
  const deck = await opened
  await deck.waitForLoadState('domcontentloaded')
  await deck.waitForTimeout(900)
  return deck
}

try {
  await openTalkByTitle(main, 'Sandbox Deck Fixture')
  await main.waitForTimeout(1200)
  await main.evaluate(() => { window.__twEditHits = []; window.tw.present.onEditSlide((payload) => window.__twEditHits.push(payload)) })

  // Plain presentation.
  const plain = await present('window')
  const plainPrefs = await prefsOf(plain)
  record('plain presentation: sandboxed', plainPrefs?.sandbox === true, JSON.stringify(plainPrefs))
  const pencil = plain.locator('#twedit-btn')
  let mounted = false
  try { await pencil.waitFor({ state: 'attached', timeout: 5000 }); mounted = true } catch { /* not mounted */ }
  record('plain presentation: the sandboxed preload mounts the edit button', mounted)
  if (mounted) {
    await pencil.click({ force: true })
    const hit = await main.waitForFunction(() => window.__twEditHits.length > 0 ? window.__twEditHits[0] : null, null, { timeout: 5000 }).then((h) => h.jsonValue()).catch(() => null)
    record('plain presentation: the edit button reaches the editor (present:edit-slide)', !!hit, JSON.stringify(hit))
  }
  await plain.close()

  // Presenter (the recorder bridge).
  const presenter = await present('presenter')
  const presenterPrefs = await prefsOf(presenter)
  record('presenter (recorder): the one deck window without the sandbox', presenterPrefs?.sandbox === false, JSON.stringify(presenterPrefs))
  let presenterPencil = false
  try { await presenter.locator('#twedit-btn').waitFor({ state: 'attached', timeout: 5000 }); presenterPencil = true } catch { /* not mounted */ }
  record('presenter: its bridge still mounts the edit button', presenterPencil)
  await presenter.close()

  // Audience view.
  const audience = await present('audience')
  const audiencePrefs = await prefsOf(audience)
  await audience.waitForTimeout(1200)
  const audienceBridge = await audience.locator('#twedit-btn').count()
  record('audience: sandboxed, and no bridge mounted (no preload)', audiencePrefs?.sandbox === true && audienceBridge === 0, JSON.stringify({ ...audiencePrefs, editButtons: audienceBridge }))
  await audience.close()
} catch (e) {
  record('present window sandbox harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== PRESENT WINDOW SANDBOX SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close().catch(() => {})
  rmSync(tempRoot, { recursive: true, force: true })
  process.exit(failed.length === 0 ? 0 : 1)
}

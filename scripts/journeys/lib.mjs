// Shared harness for the start-to-finish journeys: the checkout's own build launched by Playwright's
// Electron launcher, as the e2e tests launch it (TW_E2E hides windows, TW_REC_TEST synthesises the voice
// track, Chromium's fake camera and microphone), on an empty user-data folder and a temporary vault.
// Evidence goes to artefacts/journey/<stage>/ (git-ignored). Run every stage with `npm run check:journey`.
//
// Clean-up and ownership: Playwright starts Electron and Chromium as leaders of their own process groups, so
// killing a stage's process group does not reach them. Every process this harness launches is therefore
// written, with its process group, start time and profile, to TW_JOURNEY_OWNED (a per-stage file the runner
// gives); the runner stops exactly those (never by name), waits for them to exit, then removes their state
// and the single-instance folder. Here: every launched app is closed in the stage's finally block; SIGTERM
// closes them gracefully within a bound; the hard limit and exit kill any that are still running.
import { _electron as electron, chromium } from 'playwright'
import { mkdirSync, writeFileSync, appendFileSync, existsSync, mkdtempSync, realpathSync, rmSync, readlinkSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'
import { claimOf } from './checks.mjs'
import { systemProcesses } from './reap.mjs'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const OUT_ROOT = join(REPO, 'artefacts', 'journey')
/** The ffmpeg that `bun install` downloaded (node_modules/ffmpeg-static), as the e2e tests use it. */
export const FFMPEG = createRequire(import.meta.url)('ffmpeg-static')
export const pause = (ms) => new Promise((r) => setTimeout(r, ms))

// The Present split button's alternate action opens the presenter, not the single slide window.
export async function openPresenter(app, page, timeout) {
  const known = new Set(app.windows())
  await page.getByRole('button', { name: 'Other ways to present', exact: true }).click()
  await page.getByRole('menuitem', { name: /^With my notes and a timer\b/ }).click()
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const presenter = app.windows().find(window => !known.has(window) && !window.isClosed() && window.url().includes('presenter=1'))
    if (presenter) return presenter
    await pause(250)
  }
  return null
}
export const commit = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim()

// ── Owned processes ─────────────────────────────────────────────────────────────────────────────────
/** pid, process group and start time of one process (null when it is gone). */
export const procInfo = (pid) => systemProcesses.procInfo(pid)
const ownedFile = process.env.TW_JOURNEY_OWNED || null
const ownedPids = new Set()
function own(entry) {
  if (entry.pid) ownedPids.add(entry.pid)
  if (ownedFile) appendFileSync(ownedFile, JSON.stringify({ ...entry, at: Date.now() }) + '\n')
  console.log(`[journey] owns ${entry.kind} ${entry.pid ?? entry.path}${entry.pgid ? ` (group ${entry.pgid})` : ''}`)
}
const childPids = () => { const r = spawnSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' }); return (r.stdout || '').split('\n').map(Number).filter(Boolean) }
function ownNewChildren(kind, before) {
  for (const pid of childPids()) if (!before.has(pid) && !ownedPids.has(pid)) { const p = procInfo(pid); if (p) own({ kind, ...p }) }
}
/** The members of a launched app's process group (its helpers), recorded while the app still leads that group,
 *  so the runner can stop any that outlive it by pid and start time (reap.mjs never signals a leaderless group). */
function ownGroupMembers(leaderPid, kind) {
  const lead = procInfo(leaderPid)
  if (!lead || lead.pgid !== leaderPid) return
  for (const pid of systemProcesses.groupMembers(leaderPid)) {
    if (ownedPids.has(pid)) continue
    const p = procInfo(pid)
    if (p && p.pgid === leaderPid && procInfo(leaderPid)?.started === lead.started) own({ kind, ...p })
  }
}

// ── Clean-up ────────────────────────────────────────────────────────────────────────────────────────
const ownedDirs = new Set()
const liveApps = new Map()
// Electron's single-instance lock puts a socket in a `scoped_dir…` folder under the system temp dir (Chromium
// ignores TMPDIR there) and links it from the profile as SingletonSocket. A clean quit removes the folder; a
// killed app leaves it, so it is removed once the app has ended (here, and by the runner).
export function singletonDir(userData) {
  try { const target = readlinkSync(join(userData, 'SingletonSocket')); return /\/scoped_dir[^/]+\/SingletonSocket$/.test(target) ? dirname(target) : null } catch { return null }
}
function removeSingleton(userData) { const d = singletonDir(userData); if (d) try { rmSync(d, { recursive: true, force: true }) } catch {} }
// `proc` is a child Node has not yet reaped (callers check exitCode and signalCode are null), so its pid cannot
// have been reused; its group is signalled only while it still leads it.
const killGroup = (proc, sig) => {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  try { const p = procInfo(proc.pid); if (p && p.pgid === proc.pid) process.kill(-proc.pid, sig); else proc.kill(sig) } catch {} }
function killApps() {
  for (const [app] of liveApps) { try { const p = app.process(); if (p && p.exitCode === null) killGroup(p, 'SIGKILL') } catch {} }
  // The single-instance folders go once the apps are gone; the runner checks and removes any left.
  liveApps.clear()
}
function removeOwned() {
  for (const dir of ownedDirs) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }) } catch {} }
  ownedDirs.clear()
}
process.on('exit', () => { killApps(); removeOwned() })
let stopping = false
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, async () => {
  if (stopping) process.exit(130)
  stopping = true
  console.error(`[journey] ${sig}: closing the apps`)
  await Promise.race([Promise.all([...liveApps.keys()].map((a) => closeApp(a))), pause(10000)])
  process.exit(130)
})

/** A fresh folder under the OS temp dir, removed when this process exits (also on failure). */
export function tempDir(prefix = 'tw-journey-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  ownedDirs.add(dir)
  return dir
}

/** A stage's folders: evidence under artefacts/journey/<name>/, the throwaway user data and vault in
 *  TW_JOURNEY_STATE when the runner gives one (kept across the recording stages), else in a temp folder. */
export function runFolders(name) {
  const out = join(OUT_ROOT, name)
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  const state = process.env.TW_JOURNEY_STATE ? resolve(process.env.TW_JOURNEY_STATE) : tempDir()
  mkdirSync(state, { recursive: true })
  return { out, state, userData: join(state, 'userData') }
}

/** The ledger: one JSON line per check in <out>/results.jsonl, each with the check's id (checks.mjs), this
 *  run's token and the evidence the decision rests on (`data`). ok: true PASS, false FAIL, null COULD-NOT
 *  (accepted only under could-not-allowed.mjs). A line is printed as each check completes. */
export function ledger(out, stage, ctx = {}) {
  const rows = []
  const file = join(out, 'results.jsonl')
  writeFileSync(file, '')
  const run = process.env.TW_JOURNEY_RUN || 'direct'
  const record = (id, ok, detail = '', evidence = '', data = null) => {
    const claim = claimOf(stage, id, ctx)
    const row = { id, stage, run, result: ok === null ? 'COULD-NOT' : ok ? 'PASS' : 'FAIL', claim: claim ?? '(unknown id)', detail: String(detail).slice(0, 1200), evidence, data }
    rows.push(row)
    appendFileSync(file, JSON.stringify(row) + '\n')
    console.log(`${row.result.padEnd(9)} ${id}  ${row.claim}${detail ? '  — ' + String(detail).slice(0, 300) : ''}${evidence ? '  (' + evidence + ')' : ''}`)
    return ok
  }
  /** The script itself broke (an exception, a missing window): always a FAIL. */
  const harness = (detail) => record(`${stage}.harness`, false, detail)
  return { rows, record, harness }
}

export function hardLimit(ms, label) {
  const t = setTimeout(() => { console.error(`[${label}] hard limit ${ms} ms reached`); process.exit(2) }, ms)
  t.unref?.()
  return t
}

export async function launch(userData, { extraEnv = {}, fakeMedia = true } = {}) {
  mkdirSync(userData, { recursive: true })
  const args = ['.', '--user-data-dir=' + userData]
  if (fakeMedia) args.push('--use-fake-device-for-media-stream')
  const before = new Set(childPids())
  const app = await electron.launch({ args, cwd: REPO, timeout: 60000, env: { ...process.env, TW_E2E: '1', TW_REC_TEST: '1', ...extraEnv } })
  const pid = app.process()?.pid
  const info = pid && procInfo(pid)
  if (info) own({ kind: 'electron', ...info, userData })
  ownNewChildren('electron-launcher', before)
  liveApps.set(app, userData)
  const main = await app.firstWindow()
  await main.waitForLoadState('domcontentloaded')
  const single = singletonDir(userData)
  if (single) own({ kind: 'singleton', path: single })
  return { app, main }
}

/** Playwright's bundled Chromium (headless shell), its process recorded as owned. */
export async function launchChromium() {
  const before = new Set(childPids())
  const browser = await chromium.launch()
  ownNewChildren('chromium', before)
  return browser
}

/** Close the app within a bound; kill its process group if it hangs; wait for it to exit. */
export async function closeApp(app) {
  if (!app) return
  const proc = app.process()
  if (proc?.pid && proc.exitCode === null && proc.signalCode === null) ownGroupMembers(proc.pid, 'electron helper')
  await Promise.race([app.close().catch(() => {}), pause(15000)])
  if (proc && proc.exitCode === null && proc.signalCode === null) killGroup(proc, 'SIGKILL')
  if (proc && proc.exitCode === null && proc.signalCode === null) await new Promise((r) => { proc.once('exit', r); setTimeout(r, 5000) })
  const userData = liveApps.get(app)
  if (userData) removeSingleton(userData)
  liveApps.delete(app)
}

export async function size(page, width = 1440, height = 900) {
  const c = await page.context().newCDPSession(page)
  await c.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
}

export function shooter(out) {
  let n = 0
  return async (page, name, opts = {}) => {
    n += 1
    const file = join(out, `${String(n).padStart(3, '0')}-${name}.png`)
    try { await page.screenshot({ path: file, timeout: 15000, ...opts }) } catch (e) { console.log('screenshot failed', name, String(e).slice(0, 200)); return '' }
    return file.replace(REPO + '/', '')
  }
}

/** A window by URL fragment, through the main process (shown, hidden, bounds, capturePage). */
export const winCall = (app, fragment, fn, arg) => app.evaluate(({ BrowserWindow }, { fragment, fn, arg }) => {
  const w = BrowserWindow.getAllWindows().find((b) => !b.isDestroyed() && b.webContents.getURL().includes(fragment))
  if (!w) return null
  return new Function('w', 'arg', fn)(w, arg)
}, { fragment, fn, arg })

/** What a window really composites (webContents.capturePage), saved as PNG. */
export async function capturePage(app, fragment, file) {
  const b64 = await winCall(app, fragment, 'return w.webContents.capturePage().then((img) => img.toPNG().toString("base64"))')
  if (!b64) return ''
  writeFileSync(file, Buffer.from(b64, 'base64'))
  return file.replace(REPO + '/', '')
}

/** "Record this slide again": on only in a development build started with TW_RECORD_AGAIN=1 (src/shared/recording-takes.ts). */
export async function recordAgainOn() {
  const { takesEnabled, RECORD_AGAIN_ENV } = await import('../../src/shared/recording-takes.ts')
  return takesEnabled({ packaged: false, flag: process.env[RECORD_AGAIN_ENV] })
}

export function writeJson(file, value) { writeFileSync(file, JSON.stringify(value, null, 2)) }
export { existsSync, join }

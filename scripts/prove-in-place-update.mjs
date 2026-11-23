// A real in-place update on this Mac, publishing nothing (ADR-0044; docs/RELEASING.md, "Proving an in-place
// update on this Mac"). Two builds of the unpublished update-test flavour from the same source, only the version
// different (npm run build:update-test -- <old> <new>), both signed with this Mac's Developer ID identity and
// not notarised. The older is installed into a scratch folder (never /Applications); the newer is served, zipped
// as the release workflow zips it, from a stand-in feed on 127.0.0.1. The real window is driven: Check for Updates…,
// the mark, Update, and Restart. Before the good update it runs the failure cases for real: the file changed after
// the feed was written; the network dropped mid-download; a copy re-signed ad hoc (an attacker who controls the
// feed AND the file: refused by TalkWeaver's own developer-identity check, ADR-0044 §7); a genuinely signed build of
// the OLD version put under the new name. Then the order of
// ADR-0044 §3 (nothing handed to Squirrel.Mac until the person commits to restarting now), with "nothing armed"
// checked each time (no ShipIt job in launchd, no install request on disk):
//  (b) Cancel during the download, then quit at once: nothing installs;
//  (a) the download completes while a blocker holds, then the app is killed with SIGKILL: on relaunch the version
//      is unchanged, nothing is armed and Update is offered again;
//  (d) a blocker raised while macOS prepares the new version (after the native request): the app does not quit,
//      says what will happen, and quitting then installs exactly what it said;
//  (c) Restart pressed with nothing holding: it restarts into the new version, and the result is checked:
//      version, code signature, the user data kept, timings.
//  (e)–(h) the restart's close when an editor cannot confirm its save (slow, failed, Stay here, a late merge);
//  (i) a Tools window open: the restart waits behind it and closes nothing (ADR-0044 §6, rule A);
//  (j) in (c), typing during the restart's slow save is refused and nothing is lost (rule B);
//  (k) in (c), a preference write held pending in main is waited for before the native call and is in the settings
//      file after the update (rule C).
// The blocker is the update-test flavour's restart hold (TW_UPDATE_TEST_HOLD_FILE, counted as a publish in flight).
//
//   node scripts/prove-in-place-update.mjs --old <X.app> --new <Y.app> --work <empty scratch folder> --out <evidence.json>
//
// Everything it makes (the installed copy, its user-data folder, caches and preferences, the feed, the ShipIt job) is
// removed at the end; the evidence file stays. It refuses to run if the test app's user-data folder already exists.
import { _electron as electron } from 'playwright'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { parseArgs } from 'node:util'
import { openTalkByTitle } from '../e2e/lib/talklist.mjs'

const { values: opt } = parseArgs({ options: { old: { type: 'string' }, new: { type: 'string' }, work: { type: 'string' }, out: { type: 'string' }, team: { type: 'string', default: 'M7H45AGG8A' } } })
if (!opt.old || !opt.new || !opt.work || !opt.out) { console.error('usage: --old <X.app> --new <Y.app> --work <folder> --out <evidence.json>'); process.exit(2) }
const NAME = 'TalkWeaver Update Test'
const plist = (app, key) => execFileSync('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).trim()
const OLD_VERSION = plist(opt.old, 'CFBundleShortVersionString')
const NEW_VERSION = plist(opt.new, 'CFBundleShortVersionString')
const BUNDLE_ID = plist(opt.old, 'CFBundleIdentifier')
if (basename(opt.old) !== `${NAME}.app` || BUNDLE_ID !== plist(opt.new, 'CFBundleIdentifier') || !BUNDLE_ID.endsWith('.update-test')) throw new Error('both apps must be the update-test flavour')
const USER_DATA = join(homedir(), 'Library', 'Application Support', NAME)
if (existsSync(USER_DATA)) throw new Error(`${USER_DATA} exists already: remove it (it belongs to an earlier proof) and run again`)
const LEFTOVERS = [
  USER_DATA,
  join(homedir(), 'Library', 'Caches', 'talkweaver-update-test-updater'),
  join(homedir(), 'Library', 'Caches', `${BUNDLE_ID}.ShipIt`),
  join(homedir(), 'Library', 'Caches', BUNDLE_ID),
  join(homedir(), 'Library', 'HTTPStorages', BUNDLE_ID),
  join(homedir(), 'Library', 'Preferences', `${BUNDLE_ID}.plist`),
  join(homedir(), 'Library', 'Saved Application State', `${BUNDLE_ID}.savedState`),
  join(homedir(), 'Library', 'Logs', NAME),
]
for (const path of LEFTOVERS.slice(1)) if (existsSync(path)) throw new Error(`${path} exists already: an earlier proof left it; remove it first`)

const evidence = { started: new Date().toISOString(), machine: {}, versions: { old: OLD_VERSION, new: NEW_VERSION }, bundleId: BUNDLE_ID, steps: [] }
// The source the proof and (when built from this checkout) the two builds come from.
try {
  const git = (...a) => execFileSync('/usr/bin/git', a, { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname }).trim()
  evidence.source = { commit: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), uncommittedChanges: git('status', '--porcelain', '--untracked-files=no') !== '' }
} catch { evidence.source = null }
try {
  evidence.machine = {
    macOS: execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
    model: execFileSync('/usr/sbin/sysctl', ['-n', 'hw.model'], { encoding: 'utf8' }).trim(),
    chip: execFileSync('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim(),
  }
} catch { /* best effort */ }
const step = (name, pass, detail = {}) => {
  evidence.steps.push({ name, pass, ...detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${Object.keys(detail).length ? '  — ' + JSON.stringify(detail) : ''}`)
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const codesign = (app) => {
  const verify = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' })
  const info = spawnSync('/usr/bin/codesign', ['-dvv', app], { encoding: 'utf8' })
  const text = info.stderr
  return {
    valid: verify.status === 0,
    authority: (text.match(/^Authority=(.*)$/m) ?? [])[1] ?? null,
    team: (text.match(/^TeamIdentifier=(.*)$/m) ?? [])[1] ?? null,
    runtime: /flags=0x[0-9a-f]+\(runtime\)/.test(text),
    identifier: (text.match(/^Identifier=(.*)$/m) ?? [])[1] ?? null,
  }
}
/** Gatekeeper's verdict: "accepted … source=Notarized Developer ID" for a notarised app, "rejected … Unnotarized Developer ID" for one signed but not notarised. */
const gatekeeper = (app) => {
  const r = spawnSync('/usr/sbin/spctl', ['--assess', '--type', 'execute', '-vv', app], { encoding: 'utf8' })
  const text = `${r.stdout}${r.stderr}`
  return { accepted: r.status === 0, source: (text.match(/source=(.*)$/m) ?? [])[1]?.trim() ?? null, text: text.trim().split('\n').slice(0, 3).join(' | ') }
}
const stapled = (app) => spawnSync('/usr/bin/xcrun', ['stapler', 'validate', app], { encoding: 'utf8' }).status === 0
const shipItJob = () => spawnSync('/bin/launchctl', ['list'], { encoding: 'utf8' }).stdout.split('\n').some((line) => line.trim().endsWith(`${BUNDLE_ID}.ShipIt`))
/** Squirrel.Mac's install request for the test app: what ShipIt installs when the app's process ends. */
const requestThere = () => existsSync(join(homedir(), 'Library', 'Caches', `${BUNDLE_ID}.ShipIt`, 'ShipItState.plist'))

// ── The scratch install, the zips and the stand-in ────────────────────────────────────────────────
const work = opt.work
mkdirSync(work, { recursive: true })
if (readdirSync(work).length) throw new Error(`${work} must be empty`)
const installDir = join(work, 'install')
const INSTALLED = join(installDir, `${NAME}.app`)
mkdirSync(installDir)
execFileSync('/usr/bin/ditto', [opt.old, INSTALLED])
const zip = (app, to) => execFileSync('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, to])
const GOOD = join(work, 'good.zip')
zip(opt.new, GOOD)
// An attacker who controls the feed and the file: the same new app, re-signed ad hoc, its hash in the feed.
const ADHOC_APP = join(work, 'adhoc', `${NAME}.app`)
mkdirSync(join(work, 'adhoc'))
execFileSync('/usr/bin/ditto', [opt.new, ADHOC_APP])
execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', ADHOC_APP], { stdio: 'ignore' })
const ADHOC = join(work, 'adhoc.zip')
zip(ADHOC_APP, ADHOC)
// A genuine build of the OLD version, put under the new version's name (with its own hash in the feed).
const OLD_ZIP = join(work, 'old.zip')
zip(opt.old, OLD_ZIP)
const files = Object.fromEntries([['good', GOOD], ['adhoc', ADHOC], ['old', OLD_ZIP]].map(([k, p]) => {
  const body = readFileSync(p)
  return [k, { body, sha512: createHash('sha512').update(body).digest('base64'), size: body.length }]
}))
evidence.zip = { size: files.good.size, sha512: files.good.sha512 }
{
  // Derived, not asserted: a valid signature, a Developer ID Application authority of the expected team, the
  // hardened runtime; and, as intended for these local builds, not notarised: Gatekeeper does not accept it as
  // notarised (spctl names it "Unnotarized Developer ID") and no ticket is stapled. (A missing stapled ticket alone
  // would prove nothing: a notarised app need not carry one.)
  const sig = codesign(INSTALLED)
  const gk = gatekeeper(INSTALLED)
  const ticket = stapled(INSTALLED)
  step('the old app is installed in a scratch folder: validly signed (Developer ID Application, the expected team, hardened runtime) and, as intended for this local build, not notarised',
    sig.valid && /^Developer ID Application: .*\(([A-Z0-9]{10})\)$/.test(sig.authority ?? '') && sig.team === opt.team && sig.authority.endsWith(`(${opt.team})`) && sig.runtime
      && !gk.accepted && /Unnotarized Developer ID/i.test(gk.text) && !ticket,
    { installed: INSTALLED, signature: sig, expectedTeam: opt.team, gatekeeper: gk, stapledTicket: ticket })
}

let serve = 'good' // good | tamper | drop | adhoc | old
let hold = null
let releaseHold = () => {}
const holdNext = () => { hold = new Promise((r) => { releaseHold = () => { hold = null; r() } }) }
const fileRequests = []
let base = ''
const ASSET = 'TalkWeaver-mac-arm64.zip'
const feed = () => {
  const f = serve === 'adhoc' ? files.adhoc : serve === 'old' ? files.old : files.good
  const release = { version: '0.44.5', released: '2026-11-14', summary: ['The release before.'], notes: 'https://talkweaver.app/whats-new#0.44.5', download: { mac: 'https://talkweaver.app/download#mac', windows: 'https://talkweaver.app/download#windows' } }
  const alpha = { ...release, version: NEW_VERSION, released: '2026-11-15', summary: ['The update proved on this Mac.'], notes: `https://talkweaver.app/whats-new#${NEW_VERSION}`,
    update: { mac: { url: `${base}/releases/download/v${NEW_VERSION}/${ASSET}`, sha512: f.sha512, size: f.size, bundleId: BUNDLE_ID } } }
  return JSON.stringify({ schema: 1, latest: release, channels: { release, alpha } })
}
const server = createServer(async (req, res) => {
  if (req.url === '/updates.json') { res.setHeader('Content-Type', 'application/json'); res.end(feed()); return }
  if (req.url === `/releases/download/v${NEW_VERSION}/${ASSET}`) {
    fileRequests.push({ at: Date.now(), serve, headers: req.headers })
    const body = Buffer.from(serve === 'adhoc' ? files.adhoc.body : serve === 'old' ? files.old.body : files.good.body)
    if (serve === 'tamper') body[body.length >> 1] ^= 0xff // changed after the feed was written
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': body.length })
    const half = body.length >> 1
    res.write(body.subarray(0, half))
    if (hold) await hold
    if (serve === 'drop') { req.socket.destroy(); return }
    res.end(body.subarray(half))
    return
  }
  res.statusCode = 404; res.end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
base = `http://127.0.0.1:${server.address().port}`

// The person's data: a vault with a talk, the setting for alphas, and a marker file.
const vault = join(work, 'vault')
mkdirSync(join(vault, 'proof-talk'), { recursive: true })
writeFileSync(join(vault, 'proof-talk', 'proof-talk-outline.md'), ['---', 'title: Update Proof', '---', '', '## Opening', '', '### One', '', '- A point that must survive the update', ''].join('\n'))
mkdirSync(USER_DATA, { recursive: true })
writeFileSync(join(USER_DATA, 'config.json'), JSON.stringify({ vaultRoot: vault, updatesAlphaVersions: true, openInView: 'markdown' }, null, 2))
const MARKER = `kept-${Date.now()}`
writeFileSync(join(USER_DATA, 'proof-marker.txt'), MARKER)

const isRunning = () => {
  const r = spawnSync('/usr/bin/pgrep', ['-f', `${INSTALLED}/Contents/MacOS/${NAME}`], { encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim().split('\n').map(Number).filter(Boolean) : []
}
let app
let page
let relaunched = []
const appLog = []
evidence.appLog = appLog
const HOLD_FILE = join(work, 'restart-hold')
// TW_MIGRATE_PROMPT=0: the proof's talk is written by hand in the older outline format, and the packaged app would
// otherwise ask in a native dialog to migrate it; the editor shows no text until that is answered.
async function launchApp() {
  app = await electron.launch({ executablePath: join(INSTALLED, 'Contents', 'MacOS', NAME), args: [], env: { ...process.env, TW_UPDATE_TEST_FEED: `${base}/updates.json`, TW_UPDATE_TEST_HOLD_FILE: HOLD_FILE, TW_UPDATE_TEST_SAVE_DELAY_FILE: SAVE_DELAY_FILE, TW_UPDATE_TEST_SETTINGS_DELAY_FILE: SETTINGS_DELAY_FILE, TW_E2E: '', TW_MIGRATE_PROMPT: '0' } })
  app.process().stdout?.on('data', (c) => appLog.push(`${new Date().toISOString()} ${String(c)}`))
  app.process().stderr?.on('data', (c) => appLog.push(`${new Date().toISOString()} [stderr] ${String(c)}`))
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.setSize(1440, 900) })
  await openTalkByTitle(page, 'Update Proof')
  return page.waitForSelector('.cm-content', { timeout: 20000 }).then(() => true, () => false)
}
const logText = () => appLog.join('')
/** The launched app's own main process (Playwright's child): alive or not. */
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const OUTLINE = join(vault, 'proof-talk', 'proof-talk-outline.md')
const outlineText = () => readFileSync(OUTLINE, 'utf8')
/** The update-test flavour's slow save: while this file exists each editor save waits the milliseconds written in it. */
const SAVE_DELAY_FILE = join(work, 'save-delay')
/** The update-test flavour's held preference write: while this file exists each preference write main makes waits. */
const SETTINGS_DELAY_FILE = join(work, 'settings-delay')
/** Every window the app has (BrowserWindow.getAllWindows: hidden ones too). */
const windowsNow = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), page: w.webContents.getURL().replace(/^.*\//, '').split(/[?#]/)[0] })))
/** The editor's text as the window shows it now, or null when the window does not answer. */
const editorText = () => page.locator('.cm-content').innerText({ timeout: 5000 }).catch(() => null)
/** A recovery copy holding `mark` (main's copy of text a save could not write). */
const recoveryHas = (mark) => {
  const dir = join(USER_DATA, 'recovery')
  const walk = (d) => { try { return readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]) } catch { return [] } }
  return walk(dir).some((f) => { try { return readFileSync(f, 'utf8').includes(mark) } catch { return false } })
}
/**
 * Types `mark-<tag>` at the end of the talk, then one character every 300 ms (the 1.5-second autosave never fires),
 * until the app logs that the restart's close began: the editor's buffer is unsaved when its close flushes it. False
 * if the restart ended or was held before any window was asked to close.
 */
async function typeUntilClose(from, tag, ms = 300000) {
  // The update popover takes the focus: close it, then put the cursor at the end of the talk, and check that the
  // typing reached the editor (otherwise nothing would be unsaved and the case would prove nothing).
  let landed = false
  for (let attempt = 0; attempt < 4 && !landed; attempt++) {
    await page.keyboard.press('Escape')
    await pause(300)
    await page.locator('.cm-content').click()
    await pause(200)
    await page.keyboard.press('Meta+ArrowDown')
    await page.keyboard.type(`\nmark-${tag}-`)
    await pause(200)
    landed = ((await editorText()) ?? '').includes(`mark-${tag}-`)
  }
  if (!landed) throw new Error(`the typing for case ${tag} did not reach the editor`)
  const until = Date.now() + ms
  while (Date.now() < until) {
    const log = logText().slice(from)
    if (/closing every window before restarting/.test(log)) return true
    if (/ended with Squirrel\.Mac possibly armed|the restart is held|attempt \d+ ended: failed/.test(log)) return false
    await page.keyboard.type('x')
    await pause(300)
  }
  return false
}
/** What the app said, in a few words. */
const said = (s) => (s.phase !== 'reopen' ? s.phase : !s.pending ? 'nothing installs; quit and reopen' : s.armed ? 'will install at the next quit' : 'may install at the next quit')
/** Whether what installed at the quit agrees with what was said: "nothing installs" must be the old version with
 *  nothing armed; "will" must be the new version; "may" agrees with either. */
const agrees = (s, after) => s.phase === 'reopen' && (!s.pending ? after === OLD_VERSION && !shipItJob() && !requestThere() : s.armed ? after === NEW_VERSION : after === OLD_VERSION || after === NEW_VERSION)
/** The next case starts from the old version. */
const backToOld = (now) => { if (now !== OLD_VERSION) { rmSync(INSTALLED, { recursive: true, force: true }); execFileSync('/usr/bin/ditto', [opt.old, INSTALLED]) } }
try {
  const talkOpen = await launchApp()
  evidence.talkOpens = talkOpen
  step('the old version is running from the scratch folder', (await app.evaluate(({ app: a }) => a.getVersion())) === OLD_VERSION, { version: await app.evaluate(({ app: a }) => a.getVersion()), talkOpens: talkOpen })
  const snap = () => page.evaluate(() => window.tw.updates.get())
  const waitFor = async (pred, ms = 120000, every = 200) => { const until = Date.now() + ms; while (Date.now() < until) { const s = await snap(); if (pred(s)) return s; await pause(every) } return snap() }
  const mark = async () => (await page.locator('[data-update-mark]').innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
  const openPop = async () => { if (!(await page.locator('[data-update-popover]').count())) await page.locator('[data-update-mark]').click(); await page.waitForSelector('[data-update-popover]', { timeout: 10000 }) }
  const pressUpdate = async () => { await openPop(); await page.locator('[data-update-popover] [data-update-update], [data-update-popover] [data-update-retry]').first().click() }

  // Check for Updates… from the palette, as a person would.
  await page.keyboard.press('Meta+Shift+P')
  await page.waitForSelector('[data-command-menu] input', { timeout: 6000 })
  await pause(250)
  await page.keyboard.type('Check for Updates')
  await page.waitForSelector('[data-command="check-for-updates"]', { timeout: 6000 })
  await page.keyboard.press('Enter')
  await page.waitForSelector('[data-update-note]', { timeout: 15000 })
  await page.locator('[data-update-note] button[aria-label="Dismiss"]').click()
  await page.waitForSelector('[data-update-mark]', { timeout: 10000 })
  step('the mark offers the new version; nothing is downloaded before the click', (await mark()).includes(`${NEW_VERSION} is available`) && fileRequests.length === 0, { mark: await mark(), fileRequests: fileRequests.length })
  await openPop()
  step('the popover offers Update (this copy can update itself here)', await page.locator('[data-update-popover] [data-update-update]').count() === 1, { text: (await page.locator('[data-update-popover]').innerText()).replace(/\s+/g, ' ').slice(0, 240) })

  // 1. The file changed after the feed was written.
  serve = 'tamper'
  await pressUpdate()
  let s = await waitFor((x) => x.install.phase === 'failed')
  step('failure: a file changed after the feed was written is refused; the app is unchanged', s.install.reason === 'mismatch' && plist(INSTALLED, 'CFBundleShortVersionString') === OLD_VERSION && isRunning().length > 0, { install: s.install, installedVersion: plist(INSTALLED, 'CFBundleShortVersionString') })

  // 2. The network dropped mid-download.
  serve = 'drop'
  holdNext()
  await pressUpdate()
  await waitFor((x) => x.install.phase === 'downloading' && x.install.received > 0)
  releaseHold()
  s = await waitFor((x) => x.install.phase === 'failed')
  step('failure: the network dropping mid-download is reported; the app is unchanged', s.install.reason === 'network' && plist(INSTALLED, 'CFBundleShortVersionString') === OLD_VERSION, { install: s.install })

  // 3. An attacker who controls the feed and the file: a copy re-signed ad hoc, its own hash in the feed. TalkWeaver's
  //    own developer-identity check (ADR-0044 §7: codesign against the compiled-in requirement) refuses it before
  //    Squirrel.Mac is asked: no request reaches electron-updater's local address.
  serve = 'adhoc'
  await page.evaluate(() => window.tw.updates.check())
  const adhocClick = Date.now()
  const adhocProxiedBefore = (logText().match(/requested by Squirrel\.Mac/g) ?? []).length
  await pressUpdate()
  s = await waitFor((x) => x.install.phase === 'failed', 300000)
  const adhocProxiedAfter = (logText().match(/requested by Squirrel\.Mac/g) ?? []).length
  step('failure: a new version not signed by the Developer ID is refused by TalkWeaver\'s own check before Squirrel.Mac sees it ("could not be verified"); the app is unchanged and still running; nothing is left staged',
    s.install.reason === 'unverified' && adhocProxiedAfter === adhocProxiedBefore && /NOT verified \(unverified\): codesign fail/.test(logText())
      && plist(INSTALLED, 'CFBundleShortVersionString') === OLD_VERSION && codesign(INSTALLED).valid && isRunning().length > 0 && !shipItJob() && !requestThere(),
    { install: s.install, squirrelRequests: adhocProxiedAfter - adhocProxiedBefore, seconds: Math.round((Date.now() - adhocClick) / 100) / 10, installed: codesign(INSTALLED), shipItJob: shipItJob(), installRequest: requestThere() })

  // 4. A genuinely signed build of the OLD version under the new version's name (its own hash in the feed).
  serve = 'old'
  await page.evaluate(() => window.tw.updates.check())
  const proxiedBefore = (logText().match(/requested by Squirrel\.Mac/g) ?? []).length
  await pressUpdate()
  s = await waitFor((x) => x.install.phase === 'failed', 120000)
  const proxiedAfter = (logText().match(/requested by Squirrel\.Mac/g) ?? []).length
  step('failure: a signed build of the old version under the new name is refused before Squirrel.Mac sees it ("not the version offered")',
    s.install.reason === 'wrong-version' && proxiedAfter === proxiedBefore && plist(INSTALLED, 'CFBundleShortVersionString') === OLD_VERSION && isRunning().length > 0,
    { install: s.install, squirrelRequests: proxiedAfter - proxiedBefore })

  // From here, the order of ADR-0044 §3: nothing is handed to Squirrel.Mac until the person has committed to
  // restarting now. "Nothing armed" is checked, not assumed: no ShipIt job for the test app in launchd and no
  // install request (ShipItState.plist) in its ShipIt folder.
  const armedNow = () => ({ shipItJob: shipItJob(), installRequest: requestThere() })
  const nothingArmed = () => !shipItJob() && !requestThere()
  const installed = () => plist(INSTALLED, 'CFBundleShortVersionString')
  const waitGone = async (pids) => { for (let i = 0; i < 120 && pids.some(alive); i++) await pause(250); for (let i = 0; i < 80 && isRunning().length; i++) await pause(250) }
  const handedOver = () => (logText().match(/handing \S+ to Squirrel\.Mac/g) ?? []).length

  // (b) Cancel during the download (D1), then quit at once: nothing installs.
  serve = 'good'
  await page.evaluate(() => window.tw.updates.check())
  const handedBeforeB = handedOver()
  holdNext()
  const requestsBeforeB = fileRequests.length
  await pressUpdate()
  // The server sends half the file, then holds the rest: the download is in flight (electron-updater reports no
  // progress while the bytes stop, so the request itself is what is waited for).
  for (let i = 0; i < 400 && fileRequests.length === requestsBeforeB; i++) await pause(25)
  await pause(1500)
  const midB = await snap()
  await openPop()
  const cancelB = page.locator('[data-update-popover] [data-update-cancel]')
  const byButtonB = (await cancelB.count()) > 0
  if (byButtonB) await cancelB.click()
  else await page.evaluate(() => window.tw.updates.cancel())
  const afterCancelB = await snap()
  releaseHold()
  const pidB = app.process().pid
  await app.close() // the person quits at once
  await waitGone([pidB])
  await pause(8000)
  step('(b) Cancel during the download, then quit at once: idle at once, Squirrel.Mac never handed anything; after the quit the copy is the old version, untouched, and nothing is armed',
    midB.install.phase === 'downloading' && afterCancelB.install.phase === 'idle' && handedOver() === handedBeforeB && isRunning().length === 0
      && installed() === OLD_VERSION && codesign(INSTALLED).valid && nothingArmed(),
    { fileRequestInFlight: fileRequests.length > requestsBeforeB, halfSentOf: files.good.size, phaseWhenCancelled: midB.install.phase, byTheButton: byButtonB, phaseRightAfter: afterCancelB.install.phase, handedOver: handedOver() - handedBeforeB, installedVersion: installed(), ...armedNow() })

  // (a) The download completes while a blocker holds (D2), then the app is killed with SIGKILL: nothing installs.
  await launchApp()
  writeFileSync(HOLD_FILE, 'hold') // the update-test flavour's restart hold, counted as a publish in flight
  await page.evaluate(() => window.tw.updates.check())
  const handedBeforeA = handedOver()
  await pressUpdate()
  const waitingA = await waitFor((x) => x.install.phase === 'waiting' || x.install.phase === 'failed', 180000, 100)
  await pause(3000)
  step('(a) the download completes while a blocker holds: "Restart to finish updating" with the reason; nothing handed to Squirrel.Mac, nothing armed',
    waitingA.install.phase === 'waiting' && waitingA.blockers.includes('publishing') && (await mark()).includes('Restart to finish updating') && handedOver() === handedBeforeA && nothingArmed(),
    { install: waitingA.install, blockers: waitingA.blockers, mark: await mark(), handedOver: handedOver() - handedBeforeA, ...armedNow() })
  const pidA = app.process().pid
  process.kill(pidA, 'SIGKILL')
  await waitGone([pidA])
  await pause(10000)
  step('(a) killed with SIGKILL while waiting: the copy is still the old version, untouched; no ShipIt job and no install request',
    !alive(pidA) && isRunning().length === 0 && installed() === OLD_VERSION && codesign(INSTALLED).valid && nothingArmed(),
    { killed: pidA, installedVersion: installed(), signatureValid: codesign(INSTALLED).valid, ...armedNow() })
  rmSync(HOLD_FILE, { force: true })
  await launchApp()
  const versionA = await app.evaluate(({ app: a }) => a.getVersion())
  const updaterCacheA = join(homedir(), 'Library', 'Caches', 'talkweaver-update-test-updater')
  const cacheA = existsSync(updaterCacheA) ? readdirSync(updaterCacheA) : []
  const relaunchedA = await page.evaluate(() => window.tw.updates.check())
  step('(a) on relaunch: the old version runs, the download was cleared, and Update is offered again (a new download); still nothing armed',
    versionA === OLD_VERSION && cacheA.length === 0 && relaunchedA.install.phase === 'idle' && (await mark()).includes(`${NEW_VERSION} is available`) && nothingArmed(),
    { version: versionA, cache: cacheA, phase: relaunchedA.install.phase, mark: await mark(), ...armedNow() })

  // (d) A blocker raised during D3's preparation (after the native request, before Squirrel.Mac answers).
  const mainD = app.process().pid
  const preparedBefore = (logText().match(/preparing \S+ \(Squirrel\.Mac checks/g) ?? []).length
  const logFromD = logText().length
  const clickD = Date.now()
  await pressUpdate()
  let askedAt = null
  for (let i = 0; i < 4800 && askedAt === null; i++) { if ((logText().match(/preparing \S+ \(Squirrel\.Mac checks/g) ?? []).length > preparedBefore) askedAt = Date.now(); else await pause(25) }
  if (askedAt !== null) writeFileSync(HOLD_FILE, 'hold')
  const restartingD = await snap()
  const endedD = await waitFor((x) => x.install.phase !== 'restarting', 300000, 100)
  const checkedD = await waitFor((x) => x.install.phase !== 'reopen' || x.install.pending === false, 15000, 100)
  await pause(30000)
  const laterD = await snap()
  const stillD = alive(mainD)
  const sayD = said(laterD.install)
  evidence.caseD = { secondsClickToNativeRequest: askedAt ? Math.round((askedAt - clickD) / 100) / 10 : null, phaseWhenHoldRaised: restartingD.install.phase, ended: endedD.install, checked: checkedD.install, later: laterD.install, says: sayD, ...armedNow() }
  step('(d) a blocker raised while macOS prepared the new version: the app does not quit; it says what will happen, and a "nothing installs" is a checked one (no ShipIt job, no install request)',
    askedAt !== null && restartingD.install.phase === 'restarting' && laterD.install.phase === 'reopen' && laterD.install.cause === 'held' && stillD && installed() === OLD_VERSION
      && (laterD.install.pending ? /NOT confirmed/.test(logText()) : nothingArmed() && /withdrawn and checked/.test(logText()))
      && /the restart is held \(publishing\) after Squirrel\.Mac prepared it/.test(logText()),
    { ...evidence.caseD, mark: await mark(), stillRunning: stillD })
  // The app's own evidence (update-installer.ts withdrawNative): each of the two is present, absent or unknown.
  const foundD = (logText().slice(logFromD).match(/withdrawing: before, ShipIt job (present|absent|unknown), install request (present|absent|unknown)/) ?? []).slice(1)
  step('(d) the check means something: before the withdrawal Squirrel.Mac had armed both (the ShipIt job and the install request were present); afterwards neither is, or the person was told it may or will install',
    foundD[0] === 'present' && foundD[1] === 'present' && (laterD.install.pending || nothingArmed()), { before: { shipItJob: foundD[0] ?? null, installRequest: foundD[1] ?? null }, after: armedNow(), said: sayD })
  const restartD = await page.evaluate(() => window.tw.updates.restart())
  const updateD = await page.evaluate((v) => window.tw.updates.update(v), NEW_VERSION)
  step('(d) in that state Restart and Update do nothing in this run', restartD.install.phase === 'reopen' && updateD.install.phase === 'reopen' && alive(mainD), { restart: restartD.install.phase, update: updateD.install.phase })
  rmSync(HOLD_FILE, { force: true })
  await app.close()
  await waitGone([mainD])
  await pause(10000)
  const afterQuitD = installed()
  step(`(d) then quitting: what was installed matches what the app said (${sayD})`,
    laterD.install.phase === 'reopen' && agrees(laterD.install, afterQuitD),
    { said: sayD, installedAfterQuit: afterQuitD, ...armedNow() })
  backToOld(afterQuitD)

  // (e)–(h): the restart's close (ADR-0044 §6). A window counts as closed only with its work positively saved; a
  // slow save, a failed save and an unresolved merge each call the restart off, withdraw and check it, and
  // leave the editor usable with the person's text. The editor's buffer is made unsaved at the moment of the close
  // by typing until the app logs that the close began (the 1.5-second autosave never fires meanwhile).
  const closeCase = async (tag, { delayMs = 0, prepare = null, onClose = null }) => {
    if (delayMs) writeFileSync(SAVE_DELAY_FILE, String(delayMs)); else rmSync(SAVE_DELAY_FILE, { force: true })
    await launchApp()
    const pid = app.process().pid
    await page.evaluate(() => window.tw.updates.check())
    await prepare?.()
    const from = logText().length
    const clicked = Date.now()
    await pressUpdate()
    const closeBegan = await typeUntilClose(from, tag)
    const closeAt = Date.now()
    await onClose?.(from)
    const ended = await waitFor((x) => x.install.phase !== 'restarting', 180000, 200)
    const checked = await waitFor((x) => x.install.phase !== 'reopen' || x.install.pending === false, 20000, 200)
    return { pid, from, closeBegan, ended: ended.install, checked: checked.install, secondsToClose: Math.round((closeAt - clicked) / 100) / 10, secondsCloseToOff: Math.round((Date.now() - closeAt) / 100) / 10 }
  }
  const quitAndCompare = async (tag, state) => {
    const pid = app.process().pid
    await app.close()
    await waitGone([pid])
    await pause(10000)
    const after = installed()
    step(`(${tag}) then quitting: what was installed matches what the app said (${said(state)})`, agrees(state, after), { said: said(state), installedAfterQuit: after, ...armedNow() })
    backToOld(after)
  }
  const usable = async (mark) => {
    const wins = await windowsNow()
    const text = await editorText()
    return { windows: wins, editorHasTheText: (text ?? '').includes(mark), editorAnswers: text !== null }
  }

  /** One case; a failure is recorded and the next case starts from the old version. */
  const safely = async (tag, run) => {
    try { await run() } catch (error) {
      step(`(${tag}) the case finished`, false, { error: String(error?.stack ?? error).slice(0, 1500) })
      try { await app.close() } catch { /* gone */ }
      for (const pid of isRunning()) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
      await pause(10000)
      try { chmodSync(OUTLINE, 0o644) } catch { /* not changed */ }
      rmSync(SAVE_DELAY_FILE, { force: true })
      backToOld(installed())
    }
  }
  // (e) A slow save (longer than the five-second fallback): the window is left open with its work.
  await safely('e', async () => {
    const c = await closeCase('E', { delayMs: 45000 })
    const log = logText().slice(c.from)
    const u = await usable('mark-E')
    step('(e) a slow save at the restart\'s close: the fallback leaves the editor open with its text, the restart is off ("held"), withdrawn and checked, and the app runs on',
      c.closeBegan && c.ended.phase === 'reopen' && c.ended.cause === 'held' && /did not answer the restart's close in time: left open/.test(log)
        && /withdrawing: before, ShipIt job (present|absent|unknown)/.test(log) && u.editorAnswers && u.editorHasTheText && alive(c.pid) && installed() === OLD_VERSION,
      { ...c, ...u, say: said(c.checked) })
    let landed = false
    for (let i = 0; i < 240 && !landed; i++) { landed = outlineText().includes('mark-E'); if (!landed) await pause(250) }
    const u2 = await usable('mark-E')
    step('(e) the slow save then completed on disk, and its late confirmation did not close the window (the editor still answers with the text)',
      landed && u2.editorAnswers && u2.editorHasTheText, { savedOnDisk: landed, ...u2 })
    rmSync(SAVE_DELAY_FILE, { force: true })
    await quitAndCompare('e', c.checked)
  })

  // (f) A failed save: the talk's file cannot be written at the moment of the close.
  await safely('f', async () => {
    const c = await closeCase('F', { prepare: async () => chmodSync(OUTLINE, 0o444) })
    const log = logText().slice(c.from)
    const u = await usable('mark-F')
    const recovery = recoveryHas('mark-F')
    step('(f) a failed save at the restart\'s close: the editor stays open with its text (and its recovery copy), the restart is off ("held"), withdrawn and checked',
      c.closeBegan && c.ended.phase === 'reopen' && c.ended.cause === 'held' && /confirmed its close but its work is not saved: left open/.test(log)
        && u.editorAnswers && u.editorHasTheText && !outlineText().includes('mark-F') && alive(c.pid) && installed() === OLD_VERSION,
      { ...c, ...u, recoveryCopyHasTheText: recovery, onDisk: outlineText().includes('mark-F') })
    chmodSync(OUTLINE, 0o644)
    await quitAndCompare('f', c.checked)
  })

  const mergeReview = () => page.getByTestId('outline-merge-sheet')
  const mergeButton = (name) => mergeReview().getByRole('button', { name, exact: true })
  const closeWithConflict = async (tag) => {
    let outside = ''
    const closed = await closeCase(tag, { delayMs: 2500, onClose: async () => {
      // Both edits append at the same point in the last slide so the app must ask what to keep.
      outside = `${outlineText()}\n- Changed elsewhere ${tag}\n`
      writeFileSync(OUTLINE, outside)
      await mergeReview().waitFor({ state: 'visible', timeout: 30000 })
    } })
    const sides = await Promise.all(['Mine 1', 'On disk 1'].map(name =>
      mergeReview().getByRole('textbox', { name, exact: true }).inputValue()))
    const reviewShowsBoth = sides[0].includes(`mark-${tag}`) && sides[1].includes(`Changed elsewhere ${tag}`)
    const keptDisk = outlineText() === outside && !outside.includes(`mark-${tag}`)
    const blockedApply = await mergeButton('Apply merge').isDisabled()
    const log = logText().slice(closed.from)
    const unarmed = nothingArmed() && !/restarting into \S+: \d+ windows open/.test(log)
    const held = closed.closeBegan && closed.ended.phase === 'reopen' && closed.ended.cause === 'held'
      && closed.checked.pending === false && /a window was kept open/.test(log)
      && /withdrawing: before, ShipIt job (present|absent|unknown)/.test(log)
      && reviewShowsBoth && keptDisk && blockedApply && unarmed && alive(closed.pid) && installed() === OLD_VERSION
    return { ...closed, held, reviewShowsBoth, keptDisk, blockedApply, unarmed, outside }
  }
  const applyMine = async () => {
    await mergeButton('Use mine').click()
    await mergeButton('Apply merge').click()
    await mergeReview().waitFor({ state: 'hidden', timeout: 30000 })
  }

  // (g) Leave the conflict unresolved with Stay here, then reopen the review to finish the ordinary quit.
  await safely('g', async () => {
    const { outside, ...c } = await closeWithConflict('G')
    await mergeButton('Stay here').click()
    await mergeReview().waitFor({ state: 'hidden', timeout: 30000 })
    const u = await usable('mark-G')
    const diskUnchanged = outlineText() === outside
    step('(g) "Stay here" in merge review: the restart is held and unarmed, and the editor and disk keep their own text',
      c.held && u.editorAnswers && u.editorHasTheText && diskUnchanged && nothingArmed() && installed() === OLD_VERSION,
      { ...c, ...u, diskUnchanged, ...armedNow() })
    rmSync(SAVE_DELAY_FILE, { force: true })
    await page.getByTestId('outline-disk-change-bar').getByRole('button', { name: 'Review merge', exact: true }).click()
    await applyMine()
    await quitAndCompare('g', c.checked)
  })

  // (h) Apply the merge in the same editor after the unresolved conflict has called the restart off.
  await safely('h', async () => {
    const { outside, ...c } = await closeWithConflict('H')
    const u = await usable('mark-H')
    step('(h) the unresolved merge holds the restart and keeps the editor text and outside file',
      c.held && u.editorAnswers && u.editorHasTheText && outlineText() === outside, { ...c, ...u })
    rmSync(SAVE_DELAY_FILE, { force: true })
    await applyMine()
    const u2 = await usable('mark-H')
    const saved = outlineText()
    const savedMine = saved.includes('mark-H') && !saved.includes('Changed elsewhere H')
    step('(h) "Use mine" and "Apply merge" save the text in the same editor without reviving the restart',
      savedMine && u2.editorAnswers && u2.editorHasTheText && u2.windows.some(w => w.visible)
        && alive(c.pid) && installed() === OLD_VERSION && nothingArmed(), { savedMine, ...u2, ...armedNow() })
    await quitAndCompare('h', c.checked)
  })

  // (i) Rule A (ADR-0044 §6, third round): a Tools window open (Notes and script, which can hold a draft). The restart
  // never closes it: the download waits with "Close the Tools window to restart.", Restart is refused, and no window
  // is closed; nothing is handed to Squirrel.Mac.
  await safely('i', async () => {
    rmSync(SAVE_DELAY_FILE, { force: true })
    await launchApp()
    const pid = app.process().pid
    await page.evaluate(() => window.tw.updates.check())
    const known = new Set(app.windows())
    await page.evaluate(() => window.tw.tools.open('talktext'))
    let tools = null
    for (let i = 0; i < 80 && !tools; i++) { tools = app.windows().find((w) => !known.has(w) && !w.isClosed()) ?? null; if (!tools) await pause(250) }
    await pause(1500)
    await page.bringToFront()
    const from = logText().length
    await pressUpdate()
    const waitingI = await waitFor((x) => x.install.phase === 'waiting' || x.install.phase === 'failed', 180000, 200)
    const visibleBefore = (await windowsNow()).filter((w) => w.visible)
    const pressedI = await page.evaluate(() => window.tw.updates.restart())
    await pause(4000)
    await openPop()
    const textI = (await page.locator('[data-update-popover]').innerText().catch(() => '')).replace(/\s+/g, ' ')
    const restartEnabled = await page.locator('[data-update-popover] [data-update-restart]').isEnabled().catch(() => null)
    const visibleAfter = (await windowsNow()).filter((w) => w.visible)
    const log = logText().slice(from)
    step('(i) a Tools window open (Notes and script): the download waits ("Close the Tools window to restart."), Restart is disabled and pressing it does nothing; no window is closed; nothing is handed to Squirrel.Mac and nothing is armed',
      !!tools && !tools.isClosed() && waitingI.install.phase === 'waiting' && waitingI.blockers.includes('tools') && pressedI.install.phase === 'waiting' && textI.includes('Close the Tools window to restart.')
        && restartEnabled === false && visibleAfter.length === visibleBefore.length && !/closing every window before restarting/.test(log) && !/preparing \S+ \(Squirrel\.Mac/.test(log) && nothingArmed() && alive(pid),
      { phase: pressedI.install.phase, blockers: waitingI.blockers, popover: textI.slice(0, 200), restartEnabled, visibleWindowsBefore: visibleBefore.length, visibleWindowsAfter: visibleAfter.length, toolsOpen: !!tools && !tools.isClosed(), ...armedNow() })
    await app.close()
    await waitGone([pid])
    await pause(5000)
    const afterI = installed()
    step('(i) then quitting with the update waiting behind the Tools window: nothing installs, nothing is armed', afterI === OLD_VERSION && nothingArmed(), { installedAfterQuit: afterI, ...armedNow() })
    backToOld(afterI)
  })

  // (c) Restart pressed with no blocker: updated, as before.
  await launchApp()
  writeFileSync(HOLD_FILE, 'hold')
  await page.evaluate(() => window.tw.updates.check())
  await pressUpdate()
  const waitingC = await waitFor((x) => x.install.phase === 'waiting' || x.install.phase === 'failed', 180000, 100)
  const restartWhileHeld = await page.evaluate(() => window.tw.updates.restart())
  await pause(3000)
  step('(c) waiting behind a blocker: pressing Restart while it holds does nothing; nothing armed',
    waitingC.install.phase === 'waiting' && restartWhileHeld.install.phase === 'waiting' && isRunning().length > 0 && /restart refused/.test(logText()) && nothingArmed(),
    { phase: restartWhileHeld.install.phase, ...armedNow() })
  rmSync(HOLD_FILE, { force: true })
  await page.evaluate(() => window.tw.updates.check()) // the hold file tells nothing when it goes; a check redraws the popover
  await page.bringToFront()
  await openPop()
  await page.waitForSelector('[data-update-popover] [data-update-restart]:not([disabled])', { timeout: 20000 })
  writeFileSync(SAVE_DELAY_FILE, '2500')
  writeFileSync(SETTINGS_DELAY_FILE, '8000')
  const before = { pids: [app.process().pid], version: installed() }
  const windowsBeforeC = await windowsNow()
  const fromC = logText().length
  const clicked = Date.now()
  await page.locator('[data-update-popover] [data-update-restart]').click()
  const cancelInRestarting = await page.locator('[data-update-popover] [data-update-cancel]').count().catch(() => -1)
  // Unsaved typing at the moment of the close: the editor must save it before its window closes.
  const typedC = await typeUntilClose(fromC, 'C').catch(() => false)
  // Rule B: the close's save is slow (the save delay was set before Restart); typing during it must be refused, and
  // the editor says so. Rule C: a preference write made now (the place chip) is held pending in main for eight
  // seconds, past the editors' close: the native call must wait for it.
  const duringSave = { banner: null, keysTried: 0, editorText: null, preferenceAsked: false }
  try {
    duringSave.preferenceAsked = await page.evaluate(() => window.tw.settings.setPlaceChipVisible(false).then(() => true, () => false))
    duringSave.banner = await page.locator('[data-close-freeze]').first().innerText({ timeout: 1500 }).catch(() => null)
    for (const key of ' SECONDEDIT') { await page.keyboard.type(key).catch(() => {}); duringSave.keysTried += 1 }
    await page.keyboard.press('Meta+v').catch(() => {})
    duringSave.editorText = await editorText()
  } catch { /* the window may already be closing */ }
  let quitAt = null
  let onDiskWhenOldAppEnded = null
  for (let i = 0; i < 1200; i++) { if (!before.pids.some(alive)) { quitAt = Date.now(); onDiskWhenOldAppEnded = outlineText(); break } await pause(250) }
  for (let i = 0; i < 1200 && quitAt; i++) { relaunched = isRunning().filter((p) => !before.pids.includes(p)); if (relaunched.length && installed() === NEW_VERSION) break; await pause(250) }
  const upAt = Date.now()
  await pause(4000) // the new version writes its launch into config.json
  const after = { version: installed(), signature: codesign(INSTALLED) }
  const config = JSON.parse(readFileSync(join(USER_DATA, 'config.json'), 'utf8'))
  const updaterCache = join(homedir(), 'Library', 'Caches', 'talkweaver-update-test-updater')
  evidence.result = {
    before: { version: before.version }, after,
    noCancelWhileRestarting: cancelInRestarting === 0,
    seconds: { restartToQuit: quitAt ? Math.round((quitAt - clicked) / 100) / 10 : null, restartToNewVersionRunning: Math.round((upAt - clicked) / 100) / 10 },
    fileRequestsInAll: fileRequests.length,
    userData: { marker: readFileSync(join(USER_DATA, 'proof-marker.txt'), 'utf8') === MARKER, vaultRoot: config.vaultRoot === vault, alphaSetting: config.updatesAlphaVersions === true, lastVersionRun: config.updateNotices?.lastVersionRun ?? null },
    talk: readFileSync(join(vault, 'proof-talk', 'proof-talk-outline.md'), 'utf8').includes('A point that must survive the update'),
    typedBeforeTheClose: typedC,
    // Read when the old app's process had ended (before the new version started), and again after the relaunch.
    typedTextOnDiskWhenOldAppEnded: (onDiskWhenOldAppEnded ?? '').includes('mark-C'),
    typedTextOnDiskAfterRelaunch: outlineText().includes('mark-C'),
    duringTheRestartsSave: {
      ...duringSave,
      editorText: undefined,
      editorHeldTheTypedMark: ((duringSave.editorText ?? '').match(/mark-C-x*/) ?? [null])[0],
      secondEditInEditor: (duringSave.editorText ?? '').includes('SECONDEDIT'),
      secondEditOnDisk: (onDiskWhenOldAppEnded ?? '').includes('SECONDEDIT') || outlineText().includes('SECONDEDIT'),
    },
    preference: {
      heldLogged: /this preference write waits 8000 ms/.test(logText().slice(fromC)),
      drainLogged: (logText().slice(fromC).match(/\[update\] write queues: [^\n]*/) ?? [null])[0],
      orderOk: (() => { const l = logText().slice(fromC); const d = l.indexOf('[update] write queues: every one drained'); const n = l.search(/restarting into \S+: 0 windows open/); return d >= 0 && n > d })(),
      storedAfterUpdate: (() => { try { return /"general\.placeChip":\s*false/.test(readFileSync(join(USER_DATA, 'settings.json'), 'utf8')) } catch { return null } })(),
    },
    windowsBeforeRestart: windowsBeforeC,
    nativeCall: (logText().slice(fromC).match(/restarting into \S+: (\d+) windows open \(hidden ones included\), no blocker/) ?? [])[0] ?? null,
    updaterCacheAfterRestart: existsSync(updaterCache) ? readdirSync(updaterCache) : 'removed',
  }
  step('(c) Restart with nothing holding (no Cancel while restarting): the app quit, was replaced and opened again as the new version, from the same place', relaunched.length > 0 && after.version === NEW_VERSION && cancelInRestarting === 0, { ...evidence.result.seconds, cancelButtonsWhileRestarting: cancelInRestarting })
  step('TalkWeaver checked the developer identity itself: the running process met the compiled-in requirement, the new version passed codesign (Gatekeeper asked; not required in this un-notarised test build), and Squirrel.Mac was served the verified private copy after a re-hash',
    /this copy meets the developer-identity requirement/.test(logText()) && new RegExp(`${NEW_VERSION.replace(/\./g, '\\.')}: verified: codesign pass`).test(logText())
      && /the verified copy still has its SHA-512: Squirrel\.Mac is served that copy/.test(logText()) && /requested by Squirrel\.Mac, pipe \S*\/verified-[^/\s]+\/update\.zip/.test(logText()),
    { log: logText().split('\n').filter((l) => /developer-identity|verified|pipe /.test(l)).slice(-6) })
  step('the result is validly signed: Developer ID, same team, hardened runtime', after.signature.valid && /^Developer ID Application:/.test(after.signature.authority ?? '') && after.signature.team === opt.team && after.signature.runtime, after.signature)
  step('the user data is intact (marker, vault, alpha setting, the talk) and the new version recorded its launch', Object.values(evidence.result.userData).slice(0, 3).every(Boolean) && evidence.result.talk && evidence.result.userData.lastVersionRun === NEW_VERSION, evidence.result.userData)
  step('(c) the editor saved the text typed up to the restart\'s close before its window closed (on disk when the old app ended); the native install was called with zero windows open, hidden ones included',
    typedC && evidence.result.typedTextOnDiskWhenOldAppEnded && new RegExp(`restarting into ${NEW_VERSION.replace(/\./g, '\\.')}: 0 windows open`).test(evidence.result.nativeCall ?? ''),
    { typed: typedC, onDiskWhenOldAppEnded: evidence.result.typedTextOnDiskWhenOldAppEnded, onDiskAfterRelaunch: evidence.result.typedTextOnDiskAfterRelaunch, nativeCall: evidence.result.nativeCall, windowsBeforeRestart: windowsBeforeC })
  const ds = evidence.result.duringTheRestartsSave
  step('(j) typing during the restart\'s save: the editor said "Saving before the update…" and accepted no keystroke (typed and pasted); everything it held is on disk',
    ds.banner === 'Saving before the update…' && ds.keysTried > 0 && ds.editorHeldTheTypedMark !== null && !ds.secondEditInEditor && !ds.secondEditOnDisk && (onDiskWhenOldAppEnded ?? '').includes(ds.editorHeldTheTypedMark),
    ds)
  const pref = evidence.result.preference
  step('(k) a preference write pending at the restart (held eight seconds in main): the native call waited for the write queues, and the preference is in the settings file after the update',
    duringSave.preferenceAsked && pref.heldLogged && pref.orderOk && pref.storedAfterUpdate === true, pref)
  step('the new version started with no update download left in its cache', evidence.result.updaterCacheAfterRestart === 'removed' || evidence.result.updaterCacheAfterRestart.length === 0, { cache: evidence.result.updaterCacheAfterRestart })
} catch (error) {
  step('the proof finished', false, { error: String(error?.stack ?? error).slice(0, 2000) })
} finally {
  try { await app?.close() } catch { /* the old process is gone: it was replaced */ }
  for (const pid of [...relaunched, ...isRunning()]) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
  for (let i = 0; i < 40 && isRunning().length; i++) await pause(250)
  server.close()
  for (const name of ['ShipIt_stderr.log', 'ShipIt_stdout.log']) {
    try { evidence[name] = readFileSync(join(homedir(), 'Library', 'Caches', `${BUNDLE_ID}.ShipIt`, name), 'utf8').split('\n').slice(-60).join('\n') } catch { /* none */ }
  }
  // The test app's own ShipIt finishes before its folder goes (another app's ShipIt, Notion's say, is not waited for).
  for (let i = 0; i < 120 && spawnSync('/usr/bin/pgrep', ['-f', `${BUNDLE_ID}.ShipIt`], { encoding: 'utf8' }).status === 0; i++) await pause(500)
  // ShipIt may have relaunched the copy after the processes above were stopped: stop it again.
  await pause(3000)
  for (const pid of isRunning()) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
  for (let i = 0; i < 40 && isRunning().length; i++) await pause(250)
  spawnSync('/bin/launchctl', ['remove', `${BUNDLE_ID}.ShipIt`], { stdio: 'ignore' }) // Squirrel.Mac's job for the test app stays loaded after it relaunched it
  evidence.shipItJobAfterCleanup = shipItJob()
  for (const path of [work, ...LEFTOVERS]) { for (let i = 0; i < 5; i++) { try { rmSync(path, { recursive: true, force: true }); break } catch { await pause(1000) } } }
  evidence.cleanedUp = [work, ...LEFTOVERS].filter((p) => existsSync(p)).length === 0 ? 'everything the proof made is removed' : [work, ...LEFTOVERS].filter((p) => existsSync(p))
  evidence.finished = new Date().toISOString()
  writeFileSync(opt.out, JSON.stringify(evidence, null, 2) + '\n')
}
const failed = evidence.steps.filter((s) => !s.pass)
console.log(`\nin-place update on this Mac: ${evidence.steps.length - failed.length}/${evidence.steps.length} passed (${OLD_VERSION} → ${NEW_VERSION})`)
process.exit(failed.length ? 1 : 0)

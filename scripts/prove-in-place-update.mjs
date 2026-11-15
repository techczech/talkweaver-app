// A real in-place update on this Mac, publishing nothing (ADR-0044; docs/RELEASING.md, "Proving an in-place
// update on this Mac"). Two builds of the unpublished update-test flavour from the same source, only the version
// different (npm run build:update-test -- <old> <new>), both signed with this Mac's Developer ID identity and
// not notarised. The older is installed into a scratch folder (never /Applications); the newer is served, zipped
// as the release workflow zips it, from a stand-in feed on 127.0.0.1. The real window is driven: Check for Updates…,
// the mark, Update, and Restart. Before the good update it runs the failure cases for real: the file changed after
// the feed was written; the network dropped mid-download; a copy re-signed ad hoc (an attacker who controls the
// feed AND the file); a genuinely signed build of the OLD version put under the new name. Then the order of
// ADR-0044 §3 (nothing handed to Squirrel.Mac until the person commits to restarting now), with "nothing armed"
// checked each time (no ShipIt job in launchd, no install request on disk):
//  (b) Cancel during the download, then quit at once: nothing installs;
//  (a) the download completes while a blocker holds, then the app is killed with SIGKILL: on relaunch the version
//      is unchanged, nothing is armed and Update is offered again;
//  (d) a blocker raised while macOS prepares the new version (after the native request): the app does not quit,
//      says what will happen, and quitting then installs exactly what it said;
//  (c) Restart pressed with nothing holding: it restarts into the new version, and the result is checked:
//      version, code signature, the user data kept, timings.
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
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync } from 'node:fs'
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
writeFileSync(join(USER_DATA, 'config.json'), JSON.stringify({ vaultRoot: vault, updatesAlphaVersions: true }, null, 2))
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
async function launchApp() {
  app = await electron.launch({ executablePath: join(INSTALLED, 'Contents', 'MacOS', NAME), args: [], env: { ...process.env, TW_UPDATE_TEST_FEED: `${base}/updates.json`, TW_UPDATE_TEST_HOLD_FILE: HOLD_FILE, TW_E2E: '' } })
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

  // 3. An attacker who controls the feed and the file: a copy re-signed ad hoc, its own hash in the feed.
  serve = 'adhoc'
  await page.evaluate(() => window.tw.updates.check())
  const adhocClick = Date.now()
  await pressUpdate()
  s = await waitFor((x) => x.install.phase === 'failed', 300000)
  step('failure: a new version not signed by the Developer ID is refused by Squirrel.Mac; the app is unchanged and still running; nothing is left staged',
    s.install.reason === 'signature' && plist(INSTALLED, 'CFBundleShortVersionString') === OLD_VERSION && codesign(INSTALLED).valid && isRunning().length > 0 && !shipItJob() && !requestThere(),
    { install: s.install, seconds: Math.round((Date.now() - adhocClick) / 100) / 10, installed: codesign(INSTALLED), shipItJob: shipItJob(), installRequest: requestThere() })

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
  const sayD = laterD.install.phase === 'reopen' ? (laterD.install.pending ? 'will install at the next quit' : 'nothing installs; quit and reopen') : laterD.install.phase
  evidence.caseD = { secondsClickToNativeRequest: askedAt ? Math.round((askedAt - clickD) / 100) / 10 : null, phaseWhenHoldRaised: restartingD.install.phase, ended: endedD.install, checked: checkedD.install, later: laterD.install, says: sayD, ...armedNow() }
  step('(d) a blocker raised while macOS prepared the new version: the app does not quit; it says what will happen, and a "nothing installs" is a checked one (no ShipIt job, no install request)',
    askedAt !== null && restartingD.install.phase === 'restarting' && laterD.install.phase === 'reopen' && laterD.install.cause === 'held' && stillD && installed() === OLD_VERSION
      && (laterD.install.pending ? !nothingArmed() || /NOT confirmed/.test(logText()) : nothingArmed() && /withdrawn and checked/.test(logText()))
      && /the restart is held \(publishing\) after Squirrel\.Mac prepared it/.test(logText()),
    { ...evidence.caseD, mark: await mark(), stillRunning: stillD })
  const foundD = (logText().slice(logFromD).match(/withdrawing: before, ShipIt job (yes|no), install request (yes|no)/) ?? []).slice(1)
  step('(d) the check means something: before the withdrawal Squirrel.Mac had armed both (the ShipIt job and the install request were there); afterwards neither is',
    foundD[0] === 'yes' && foundD[1] === 'yes' && (laterD.install.pending || nothingArmed()), { before: { shipItJob: foundD[0] ?? null, installRequest: foundD[1] ?? null }, after: armedNow() })
  const restartD = await page.evaluate(() => window.tw.updates.restart())
  const updateD = await page.evaluate(() => window.tw.updates.update())
  step('(d) in that state Restart and Update do nothing in this run', restartD.install.phase === 'reopen' && updateD.install.phase === 'reopen' && alive(mainD), { restart: restartD.install.phase, update: updateD.install.phase })
  rmSync(HOLD_FILE, { force: true })
  await app.close()
  await waitGone([mainD])
  await pause(10000)
  const afterQuitD = installed()
  step(`(d) then quitting: what was installed matches what the app said (${sayD})`,
    laterD.install.phase === 'reopen' && (laterD.install.pending ? afterQuitD === NEW_VERSION : afterQuitD === OLD_VERSION && nothingArmed()),
    { said: sayD, installedAfterQuit: afterQuitD, ...armedNow() })
  if (afterQuitD !== OLD_VERSION) { rmSync(INSTALLED, { recursive: true, force: true }); execFileSync('/usr/bin/ditto', [opt.old, INSTALLED]) } // (c) starts from the old version

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
  const before = { pids: [app.process().pid], version: installed() }
  const clicked = Date.now()
  await page.locator('[data-update-popover] [data-update-restart]').click()
  const cancelInRestarting = await page.locator('[data-update-popover] [data-update-cancel]').count().catch(() => -1)
  let quitAt = null
  for (let i = 0; i < 1200; i++) { if (!before.pids.some(alive)) { quitAt = Date.now(); break } await pause(250) }
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
    updaterCacheAfterRestart: existsSync(updaterCache) ? readdirSync(updaterCache) : 'removed',
  }
  step('(c) Restart with nothing holding (no Cancel while restarting): the app quit, was replaced and opened again as the new version, from the same place', relaunched.length > 0 && after.version === NEW_VERSION && cancelInRestarting === 0, { ...evidence.result.seconds, cancelButtonsWhileRestarting: cancelInRestarting })
  step('the result is validly signed: Developer ID, same team, hardened runtime', after.signature.valid && /^Developer ID Application:/.test(after.signature.authority ?? '') && after.signature.team === opt.team && after.signature.runtime, after.signature)
  step('the user data is intact (marker, vault, alpha setting, the talk) and the new version recorded its launch', Object.values(evidence.result.userData).slice(0, 3).every(Boolean) && evidence.result.talk && evidence.result.userData.lastVersionRun === NEW_VERSION, evidence.result.userData)
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
  for (let i = 0; i < 120 && spawnSync('/usr/bin/pgrep', ['-x', 'ShipIt'], { encoding: 'utf8' }).status === 0; i++) await pause(500) // ShipIt finishes before its folder goes
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

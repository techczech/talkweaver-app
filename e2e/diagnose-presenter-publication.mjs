// A presenter window opened before a publication finishes, in the real app: a throwaway user-data folder and
// vault, TW_REC_TEST=1 (a publish builds its pages and uploads nothing) and a stand-in live service on this
// computer's loopback address. Windows are hidden; no real account and no Chrome; one run at a time.
//   - Go live with nothing published says so, and starts no session;
//   - another talk's publish and a Run that does not exist change nothing;
//   - this talk's publish reaches the window WITHOUT a reload: the same page, slide, timer and recorder
//     state; no session is started by it; "Show talk QR code" now has the link; Go live, pressed once,
//     starts one session with the published link;
//   - a publish with the window closed and another with the session running change nothing there;
//   - a Run's presenter takes its own Run's publish and not another Run's; a reloaded page and a
//     re-present of the same Run keep that link; presented as the other Run, the window is that Run's.
// Run: cd talk-weaver && node e2e/diagnose-presenter-publication.mjs
import { _electron as electron } from 'playwright'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { liveWorkerBuild } from '../scripts/lib/local-live-stub.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const BASE = 'https://handouts.example.test'
const results = []
function record(name, pass, detail) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(read, ok, timeout = 8_000) {
  const end = Date.now() + timeout
  for (;;) {
    const value = await read()
    if (ok(value) || Date.now() > end) return value
    await sleep(100)
  }
}

const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'tw-e2e-presenter-publication-')))
const userData = join(tempRoot, 'userData')
const vault = join(tempRoot, 'Personal')
mkdirSync(userData, { recursive: true })
const talk = (slug, title, extra = '') => {
  const dir = join(vault, slug)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${slug}-outline.md`)
  const text = `---\ntitle: ${title}\noutline_version: 2\nauto_title_slide: false\nauto_thanks_slide: false\n${extra}---\n\n## Section\n\n### First slide {id=a1}\n\nBody one.\n\n:::notes\nSpeaker note for the first slide.\n:::\n\n### Second slide {id=a2}\n\nBody two.\n\n### Third slide {id=a3}\n\nBody three.\n`
  writeFileSync(path, text)
  return { slug, title, path, text }
}
const alpha = talk('alpha-talk', 'Alpha Talk')
const beta = talk('beta-talk', 'Beta Talk')
const gamma = talk('gamma-talk', 'Gamma Talk')
const OLD_LINK = `${BASE}/an-older-link/`
const delta = talk('delta-talk', 'Delta Talk', `handout_url: ${OLD_LINK}\n`)
const epsilon = talk('epsilon-talk', 'Epsilon Talk')
const zeta = talk('zeta-talk', 'Zeta Talk')
const plain = talk('plain-talk', 'Plain Talk')
const withdrawn = talk('withdrawn-talk', 'Withdrawn Talk')
const edited = talk('edited-link-talk', 'Edited Link Talk')
plain.text = plain.text.replace(/^---\n[\s\S]*?\n---\n/, '')
writeFileSync(plain.path, plain.text)
for (const [target, ids] of [[gamma, ['run-one', 'run-two']], [zeta, ['run-held', 'run-other']]]) {
  mkdirSync(join(vault, '_PRESENTATIONS', target.slug), { recursive: true })
  for (const id of ids) {
    writeFileSync(join(vault, '_PRESENTATIONS', target.slug, `${id}.json`), JSON.stringify({
      id, talkSlug: target.slug, talkTitle: target.title, kind: 'delivery', status: 'planned', eventTitle: `Event ${id}`, plannedDate: '2026-11-20',
      slideSet: { kind: 'full' }, startedAt: '2026-11-20T09:00:00.000Z',
    }))
  }
}

// The stand-in live service: what Go live asks of it, counted.
const sessions = []
const server = createServer((request, response) => {
  const reply = (status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)) }
  if (request.url === '/capabilities') return reply(200, { protocol: 2, build: liveWorkerBuild() })
  if (/^\/sessions\/[^/]+\/status$/.test(request.url)) return reply(200, { protocol: 2, status: 'live' })
  if (request.url === '/sessions' && request.method === 'POST') {
    sessions.push(request.url)
    return reply(200, { sessionId: `s${sessions.length}`, presenterToken: 'stand-in', shortId: `id${sessions.length}`, expiresAt: Date.now() + 3_600_000 })
  }
  return reply(404, {})
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const liveAddress = `http://127.0.0.1:${server.address().port}`
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, cfPagesProject: 'talkweaver-test', publishBaseUrl: BASE, liveWorkerBaseUrl: liveAddress, publishUseShortIds: false }, null, 2))

let app
let exitCode = 1
const clean = { PATH: process.env.PATH, HOME: join(tempRoot, 'home'), TMPDIR: process.env.TMPDIR, LANG: process.env.LANG }
mkdirSync(clean.HOME, { recursive: true })
try {
  await ensureFreshBuild(REPO)
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`], cwd: REPO, timeout: 60_000,
    env: { ...clean, TW_E2E: '1', TW_REC_TEST: '1', TW_LIVE_LOCAL: '1', TALKWEAVER_LIVE_ADMIN_SECRET: 'stand-in-admin-secret' },
  })
  await app.evaluate(({ shell, BrowserWindow, app: electronApp }) => {
    shell.openExternal = async () => {}
    const hide = (win) => { win.setPosition(-20000, -20000); win.hide() }
    BrowserWindow.getAllWindows().forEach(hide)
    electronApp.on('browser-window-created', (_event, win) => hide(win))
  })
  const editor = await app.firstWindow()
  await editor.waitForLoadState('domcontentloaded')
  await editor.waitForFunction(() => !!window.tw?.talk?.present, null, { timeout: 30_000 })
  const errors = []

  const openPresenter = async (target, runId) => {
    const next = app.waitForEvent('window')
    const opened = editor.evaluate(({ path, text, run }) => window.tw.talk.present(path, text, 'presenter', undefined, run), { path: target.path, text: target.text, run: runId })
    const presenter = await next
    const answer = await opened
    await presenter.waitForLoadState('domcontentloaded')
    presenter.setDefaultTimeout(30_000)
    presenter.on('pageerror', (error) => errors.push(error.message))
    await presenter.waitForSelector('#presenterGoLive, #liveGoButton', { state: 'attached' })
    await presenter.waitForFunction(() => /scale\(([\d.]+)\)/.test(document.querySelector('#currentPreview iframe')?.style.transform || ''), null, { timeout: 30_000 }).catch(() => {})
    await sleep(600)
    if (await presenter.isVisible('#twResume').catch(() => false)) await presenter.click('#twResumeNo')
    return { presenter, answer }
  }
  const publish = (target) => editor.evaluate(({ path, text }) => window.tw.talk.publishHandout(path, text), { path: target.path, text: target.text })
  const publishRun = (id, target = gamma) => editor.evaluate(({ slug, runId }) => window.tw.history.publishRunHandout(slug, runId), { slug: target.slug, runId: id })
  const unpublishRun = (id, target = gamma) => editor.evaluate(({ slug, runId }) => window.tw.history.unpublishRunHandout(slug, runId), { slug: target.slug, runId: id })
  const stamp = (page) => page.evaluate(() => document.getElementById('twTalkQr')?.getAttribute('data-url') ?? '')
  const pressGo = async (page) => {
    await page.evaluate(() => document.getElementById('presenterGoLive')?.click())
    return until(() => page.evaluate(() => document.getElementById('presenterLiveLabel')?.textContent ?? ''), (text) => /publish/i.test(text), 3_000)
  }
  const pageMark = (page) => page.evaluate(() => {
    window.__twSamePage ??= Math.random().toString(36)
    return { mark: window.__twSamePage, origin: performance.timeOrigin, hash: location.hash, rec: document.getElementById('twrec-module')?.dataset.rec ?? '', notes: document.getElementById('presenterNotesBody')?.textContent ?? '' }
  })

  // ---- A talk with nothing published, presented while the publish has not finished.
  const first = await openPresenter(alpha)
  record('the talk is presented with nothing published', first.answer.success === true && await stamp(first.presenter) === '')
  const presenter = first.presenter
  const press = (page, key) => page.evaluate((name) => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: name, code: name === 'ArrowRight' ? name : `Key${name.toUpperCase()}`, bubbles: true, cancelable: true })) }, key)
  const opening = await presenter.evaluate(() => location.hash)
  await presenter.evaluate(() => document.getElementById('presenterNext')?.click())
  const moved = await until(() => presenter.evaluate(() => location.hash), (hash) => hash && hash !== opening)
  record('the presenter moves on a slide', moved !== opening, `${opening} → ${moved}`)
  await presenter.evaluate(() => { document.querySelector('button[data-minutes]')?.click(); document.getElementById('twStartTimerBtn')?.click() })
  await sleep(1_200)
  const said = await pressGo(presenter)
  record('Go live with nothing published says so and starts no session', /publish/i.test(said) && sessions.length === 0, said)
  await sleep(4_500) // the sentence is shown for 4.2 seconds, then the slot is back
  const before = await pageMark(presenter)
  record('the slide on show has speaker notes', before.notes.includes('Speaker note'), before.notes)
  const clockBefore = await presenter.evaluate(() => `${document.getElementById('twClock')?.dataset.status} ${document.getElementById('twClock')?.textContent}`)

  const other = await publish(beta)
  await sleep(600)
  record('another talk\'s publish changes nothing here', other.success === true && await stamp(presenter) === '', other.url)
  const failed = await publishRun('no-such-run')
  await sleep(300)
  record('a failed publish changes nothing here', failed?.success === false && await stamp(presenter) === '', failed?.error)

  const published = await publish(alpha)
  record('the talk is published', published.success === true && published.url?.startsWith(BASE), published.url ?? published.error)
  const stamped = await until(() => stamp(presenter), Boolean)
  record('the open presenter has the link, without opening it again', stamped === published.url, stamped)
  const after = await pageMark(presenter)
  record('the same page: slide, recorder and notes are as they were', after.mark === before.mark && after.origin === before.origin && after.hash === before.hash && after.rec === before.rec && after.notes === before.notes, `${after.hash} rec=${after.rec || 'none'}`)
  await sleep(1_100)
  const clockAfter = await presenter.evaluate(() => `${document.getElementById('twClock')?.dataset.status} ${document.getElementById('twClock')?.textContent}`)
  record('the timer goes on', clockBefore.startsWith('running') && clockAfter.startsWith('running') && clockAfter !== clockBefore, `${clockBefore} → ${clockAfter}`)
  record('nothing went live by itself', sessions.length === 0)
  const status = await presenter.evaluate(() => document.getElementById('presenterGoLive')?.hidden === false)
  record('Go live is there to press', status === true)
  await press(presenter, 'u')
  const overlay = await until(() => presenter.evaluate(() => document.querySelector('.talk-qr .qr-fs-url, .talk-qr')?.textContent ?? ''), Boolean)
  record('Show talk QR code has the published link', overlay.includes('handouts.example.test'), overlay.trim().slice(0, 60))
  await press(presenter, 'u')

  // Pressed once: one session, with the published link.
  await pressGo(presenter)
  await until(() => sessions.length, (count) => count > 0)
  await sleep(1_000)
  record('Go live, pressed once, starts one session', sessions.length === 1, `${sessions.length}`)
  const join = await presenter.evaluate(() => document.getElementById('liveShortUrl')?.textContent ?? '')
  record('its join link is on the published site, not a file', join.startsWith('handouts.example.test/'), join)

  // A publish while the session runs changes no session.
  const again = await publish(alpha)
  await sleep(600)
  const joinAfter = await presenter.evaluate(() => document.getElementById('liveShortUrl')?.textContent ?? '')
  const liveLabel = await presenter.evaluate(() => document.getElementById('presenterGoLive')?.hidden !== false)
  record('publishing again while live starts nothing, ends nothing and keeps the join link', again.success === true && sessions.length === 1 && joinAfter === join && liveLabel, `${again.success} ${sessions.length} ${join}→${joinAfter} ${liveLabel} ${await presenter.evaluate(() => document.getElementById('presenterLiveLabel')?.textContent ?? '')}`)

  // ---- A Run's presenter.
  const runWindow = await openPresenter(gamma, 'run-one')
  const runPage = runWindow.presenter
  const notThis = await publishRun('run-two')
  await sleep(600)
  record('another Run\'s publish changes nothing here', notThis?.success === true && await stamp(runPage) === '', notThis?.url ?? notThis?.error)
  const runPublished = await publishRun('run-one')
  const runStamp = await until(() => stamp(runPage), Boolean)
  record('this Run\'s publish reaches its presenter', runPublished?.success === true && runStamp === runPublished.url, runStamp)
  await runPage.evaluate(() => { window.__twSamePage = 'before-reload' })
  await runPage.reload()
  await runPage.waitForSelector('#presenterGoLive, #liveGoButton', { state: 'attached' })
  const reread = await until(() => stamp(runPage), Boolean)
  record('a reloaded page reads the same link back', reread === runPublished.url, reread)

  const present = (run) => editor.evaluate(({ path, text, id }) => window.tw.talk.present(path, text, 'presenter', undefined, id), { path: gamma.path, text: gamma.text, id: run })
  const reloaded = (url) => until(() => stamp(runPage).catch(() => ''), (value) => value === url, 15_000)
  await present('run-one')
  record('presenting the same Run again keeps its link', await reloaded(runPublished.url) === runPublished.url)
  await present('run-two')
  record('presented as the other Run, the window has that Run\'s link', await reloaded(notThis.url) === notThis.url)
  const replaced = await publishRun('run-one')
  await sleep(600)
  record('and the first Run\'s publish no longer reaches it', replaced?.success === true && await stamp(runPage) === notThis.url)

  // ---- Removing the Run's own publication updates only its handout link, not its page/session.
  const failedRemoval = await unpublishRun('no-such-run')
  record('a failed Run unpublish leaves its presenter link alone', failedRemoval.success === false && await stamp(runPage) === notThis.url)
  const otherRemoved = await unpublishRun('run-one')
  record('another Run unpublish leaves this presenter link alone', otherRemoved.success === true && await stamp(runPage) === notThis.url)
  await runPage.evaluate(() => { document.querySelector('button[data-minutes]')?.click(); document.getElementById('twStartTimerBtn')?.click() })
  await runPage.keyboard.press('Shift+R')
  await until(() => runPage.evaluate(() => document.getElementById('twrec-module')?.dataset.rec), (value) => value === 'recording')
  const removingBefore = await pageMark(runPage)
  const removalClockBefore = await runPage.evaluate(() => document.getElementById('twClock')?.textContent)
  await press(runPage, 'u')
  await until(() => runPage.locator('.talk-qr').count(), (count) => count > 0)
  const removedOwn = await unpublishRun('run-two')
  const cleared = await until(() => stamp(runPage), (url) => url === '')
  const closedQr = await until(() => runPage.locator('.talk-qr').count(), (count) => count === 0)
  record('Run unpublish with no talk publication clears its link and open QR overlay', removedOwn.success === true && cleared === '' && closedQr === 0, cleared)
  const removingAfter = await pageMark(runPage)
  await sleep(1_100)
  const removalClockAfter = await runPage.evaluate(() => `${document.getElementById('twClock')?.dataset.status} ${document.getElementById('twClock')?.textContent}`)
  record('Run unpublish preserves recording, slide, notes, page and running timer', removingAfter.rec === 'recording' && removingAfter.hash === removingBefore.hash && removingAfter.notes === removingBefore.notes && removingAfter.mark === removingBefore.mark && removingAfter.origin === removingBefore.origin && removalClockAfter.startsWith('running') && !removalClockAfter.endsWith(removalClockBefore), removingAfter.rec)
  const sessionsBeforeClearGo = sessions.length
  const clearSaid = await pressGo(runPage)
  record('Go live cannot start on the removed Run link when there is no talk link', /publish/i.test(clearSaid) && sessions.length === sessionsBeforeClearGo, clearSaid)
  await runPage.keyboard.press('Shift+R')
  await sleep(4_500)
  const talkFallback = await publish(gamma)
  const runAgain = await publishRun('run-two')
  await until(() => stamp(runPage), (url) => url === runAgain.url)
  await pressGo(runPage)
  await until(() => sessions.length, (count) => count > sessionsBeforeClearGo)
  const liveJoinBeforeRemoval = await runPage.evaluate(() => document.getElementById('liveShortUrl')?.textContent ?? '')
  const liveSessionCount = sessions.length
  const livePageBeforeRemoval = await pageMark(runPage)
  const removedToTalk = await unpublishRun('run-two')
  const fallbackStamp = await until(() => stamp(runPage), (url) => url === talkFallback.url)
  const livePageAfterRemoval = await pageMark(runPage)
  const liveJoinAfterRemoval = await runPage.evaluate(() => document.getElementById('liveShortUrl')?.textContent ?? '')
  record('Run unpublish falls back to the current published talk in the open presenter', removedToTalk.success === true && fallbackStamp === talkFallback.url, fallbackStamp)
  record('Run unpublish keeps the active session, join link and same page', sessions.length === liveSessionCount && liveJoinAfterRemoval === liveJoinBeforeRemoval && liveJoinBeforeRemoval !== '' && livePageAfterRemoval.mark === livePageBeforeRemoval.mark && livePageAfterRemoval.origin === livePageBeforeRemoval.origin && await runPage.evaluate(() => document.getElementById('presenterGoLive')?.hidden !== false), liveJoinAfterRemoval)

  // ---- A recording in progress keeps its window, and the window keeps its Run.
  const held = await openPresenter(zeta, 'run-held')
  const heldPage = held.presenter
  await heldPage.keyboard.press('Shift+R')
  const armed = await until(() => heldPage.evaluate(() => document.getElementById('twrec-module')?.dataset.rec ?? ''), (rec) => rec === 'recording')
  record('a recording is running', armed === 'recording', armed)
  const heldBefore = await pageMark(heldPage)
  const refused = await editor.evaluate(({ path, text }) => window.tw.talk.present(path, text, 'presenter', undefined, 'run-other'), { path: zeta.path, text: zeta.text })
  await sleep(800)
  const otherRun = await publishRun('run-other', zeta)
  await sleep(800)
  record('a refused replacement leaves the window its Run: the other Run\'s publish does not reach it', refused.success === true && otherRun?.success === true && await stamp(heldPage) === '', await stamp(heldPage))
  const heldRun = await publishRun('run-held', zeta)
  const heldStamp = await until(() => stamp(heldPage), Boolean)
  record('its own Run\'s publish does, while recording', heldRun?.success === true && heldStamp === heldRun.url, heldStamp)
  const heldAfter = await pageMark(heldPage)
  record('the recording goes on, on the same page', heldAfter.rec === 'recording' && heldAfter.mark === heldBefore.mark && heldAfter.origin === heldBefore.origin && heldAfter.notes === heldBefore.notes, `rec=${heldAfter.rec}`)
  await heldPage.keyboard.press('Shift+R')

  // ---- A presenter opened with text older than the file, and one opened while a publish is under way.
  const firstUrl = await publish(delta)
  const stale = await openPresenter(delta)
  const staleStamp = await until(() => stamp(stale.presenter), (url) => url === firstUrl.url)
  record('text sent before a publish finished does not bring back the older link', firstUrl.success === true && staleStamp === firstUrl.url, staleStamp)
  await stale.presenter.close({ runBeforeUnload: false }).catch(() => {})

  // The publish is held at its build (its job is not handed to the build's process) until the window is up.
  await app.evaluate(({ utilityProcess }) => {
    const fork = utilityProcess.fork
    utilityProcess.fork = (path, args, options) => {
      const child = fork.call(utilityProcess, path, args, options)
      if (options?.serviceName === 'TalkWeaver handout pages') {
        utilityProcess.fork = fork // this one publish only
        const post = child.postMessage.bind(child)
        child.postMessage = (job) => { globalThis.__twReleasePublish = () => post(job) }
      }
      return child
    }
  })
  let inFlightDone = false
  const inFlight = publish(epsilon).then((answer) => { inFlightDone = true; return answer })
  await until(() => app.evaluate(() => typeof globalThis.__twReleasePublish === 'function'), Boolean, 20_000)
  const pending = await openPresenter(epsilon)
  const openedWhileGoing = !inFlightDone && await stamp(pending.presenter) === ''
  const pendingMark = await pageMark(pending.presenter)
  await app.evaluate(() => globalThis.__twReleasePublish())
  const finished = await inFlight
  const pendingStamp = await until(() => stamp(pending.presenter), Boolean)
  const pendingAfter = await pageMark(pending.presenter)
  record('a presenter opened during a publish takes its link when it succeeds, without a reload', openedWhileGoing && finished.success === true && pendingStamp === finished.url && pendingAfter.mark === pendingMark.mark && pendingAfter.origin === pendingMark.origin, `opened while under way: ${openedWhileGoing}`)
  await pending.presenter.close({ runBeforeUnload: false }).catch(() => {})

  // No frontmatter is added to canonical outlines just to remember a publication.
  const plainPublished = await publish(plain)
  const plainOpen = await openPresenter(plain)
  const plainStamp = await until(() => stamp(plainOpen.presenter), Boolean)
  record('a talk without frontmatter retains publication completed before its presenter opens', plainPublished.success === true && plainStamp === plainPublished.url, plainStamp)
  await editor.evaluate(({ path, text }) => window.tw.talk.present(path, text, 'presenter'), { path: plain.path, text: plain.text })
  const plainAgain = await until(() => stamp(plainOpen.presenter).catch(() => ''), (url) => url === plainPublished.url)
  record('re-presenting the talk without frontmatter retains its published link', plainAgain === plainPublished.url, plainAgain)
  await plainOpen.presenter.close({ runBeforeUnload: false }).catch(() => {})
  const plainRemoved = await editor.evaluate(async ({ outline }) => {
    const vaults = await window.tw.vault.list()
    return window.tw.published.unpublishTalk(vaults[0].id, outline)
  }, { outline: 'plain-talk/plain-talk-outline.md' })
  const removedOpen = await openPresenter(plain)
  await sleep(400)
  record('successful unpublish does not revive a cached no-frontmatter talk link on reopen', plainRemoved.success === true && await stamp(removedOpen.presenter) === '', plainRemoved.error)
  await removedOpen.presenter.close({ runBeforeUnload: false }).catch(() => {})

  const withdrawnPublished = await publish(withdrawn)
  const staleWithdrawn = { ...withdrawn, text: readFileSync(withdrawn.path, 'utf8') }
  const withdrawnOpen = await openPresenter(staleWithdrawn)
  await until(() => stamp(withdrawnOpen.presenter), (url) => url === withdrawnPublished.url)
  await press(withdrawnOpen.presenter, 'u')
  const withdrawnBefore = await pageMark(withdrawnOpen.presenter)
  const sessionsBeforeRemoval = sessions.length
  const removedTalk = await editor.evaluate(async ({ outline }) => {
    const vaults = await window.tw.vault.list()
    return window.tw.published.unpublishTalk(vaults[0].id, outline)
  }, { outline: 'withdrawn-talk/withdrawn-talk-outline.md' })
  const removedStamp = await until(() => stamp(withdrawnOpen.presenter), (url) => url === '')
  record('successful talk unpublish clears its already-open presenter link', removedTalk.success === true && removedStamp === '')
  const withdrawnOverlay = await until(() => withdrawnOpen.presenter.evaluate(() => !!document.querySelector('.talk-qr')), (open) => !open)
  record('successful talk unpublish closes the already-open handout QR', !withdrawnOverlay)
  const withdrawnAfter = await pageMark(withdrawnOpen.presenter)
  record('talk unpublish preserves the presenter page and session state', JSON.stringify(withdrawnAfter) === JSON.stringify(withdrawnBefore) && sessions.length === sessionsBeforeRemoval)
  await withdrawnOpen.presenter.close({ runBeforeUnload: false }).catch(() => {})
  const staleOpen = await openPresenter(staleWithdrawn)
  await sleep(400)
  record('old renderer content cannot restore a link removed from the canonical outline', await stamp(staleOpen.presenter) === '')
  await staleOpen.presenter.close({ runBeforeUnload: false }).catch(() => {})

  const editedPublished = await publish(edited)
  const editedStamped = readFileSync(edited.path, 'utf8')
  const editedWithoutLink = editedStamped.replace(/^handout_url:.*\r?\n/m, '')
  const editedSaved = await editor.evaluate(({ path, text }) => window.tw.talk.writeOutline(path, text), { path: edited.path, text: editedWithoutLink })
  record('normal editor save removes the canonical publication link', editedPublished.success === true && editedSaved?.ok === true && !readFileSync(edited.path, 'utf8').includes('handout_url:'))
  const editedOpen = await openPresenter({ ...edited, text: editedStamped })
  await sleep(400)
  record('canonical link removal by an editor save overrides the earlier in-session publication cache', await stamp(editedOpen.presenter) === '')
  await editedOpen.presenter.close({ runBeforeUnload: false }).catch(() => {})

  // ---- A closed window takes nothing and nothing breaks.
  await runPage.close({ runBeforeUnload: false }).catch(() => {})
  await sleep(500)
  const closed = await publishRun('run-one')
  record('a publish with the window closed still answers', closed?.success === true, closed?.error)
  record('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '))

  const failedChecks = results.filter((item) => !item.pass)
  console.log(`\n${results.length - failedChecks.length} of ${results.length} checks passed`)
  exitCode = failedChecks.length ? 1 : 0
} catch (error) {
  console.error('FAIL  the run stopped:', error)
} finally {
  // A running session holds its window open (the close offer): the process goes, not the windows.
  app?.process().kill('SIGKILL')
  await new Promise((resolve) => server.close(resolve))
  rmSync(tempRoot, { recursive: true, force: true })
}
process.exit(exitCode)

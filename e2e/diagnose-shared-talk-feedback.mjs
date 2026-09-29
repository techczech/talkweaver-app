// Feedback rail (ticket 05), end to end: the real app, the real Worker under wrangler dev
// (scripts/lib/live-worker-harness.mjs), with a TCP proxy between them so the test can cut the
// owner socket. Shares a talk the way ticket 03's e2e does, posts one item of each kind to the
// Worker as her page would, and checks: each appears in the rail with the right kind, newest first;
// the talk row, the toolbar button and the rail header count unread items; Done and Dismiss grey
// the item with a time, drop the counts and reach the Worker (a synced line in the feedback file);
// cutting the connection shows "Sharing paused · reconnecting" in the status bar and the rail while
// editing and saving carry on; an item posted meanwhile arrives once on reconnect and the chip clears.
// Ticket 06: Accept of a proposed edit changes the file exactly as the diff showed (his notes and
// comment kept); Undo restores it byte for byte; an edit to a slide he has changed since leads with
// Compare (Keep mine leaves the file alone; Use hers writes her lines, notes kept); an outside change
// to the file holds Accept; markers on the slide pane count, tick and ghost a proposed new slide; a
// marker opens the rail on its slide beside the pane; the ghost's Accept inserts the section and slide
// right after the named slide.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { createServer, connect } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { startLiveWorker } from '../scripts/lib/live-worker-harness.mjs'

const root = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'tw-shared-feedback-e2e-'))
const userData = join(scratch, 'userData')
const vault = join(scratch, 'vault')
const slug = 'feedback-probe'
const talkDir = join(vault, slug)
const outlinePath = join(talkDir, `${slug}-outline.md`)
mkdirSync(userData, { recursive: true })
mkdirSync(talkDir, { recursive: true })
writeFileSync(outlinePath, [
  '---', 'title: Feedback probe', 'outline_version: 2', 'author: Dominik', '---', '',
  '## Where it breaks', '',
  '### The rubric problem', '{id=rubric}', '', '- Rubrics reward the features a model produces most fluently', '<!-- from the Trinity panel -->', '- Markers read structure first', '',
  ':::notes', 'Pause here. Ask who marks with a rubric.', ':::', '',
  '### What we tried', '{id=tried}', '', '- Oral follow-ups on two essays', '',
  '### Close', '{id=close}', '', '- One change before Michaelmas', '',
].join('\n'))

const log = (message) => console.log(`PASS ${message}`)
// TW_E2E_SHOTS=<dir>: keep screenshots of the rail (frame 1) and the paused state (frame 3).
const shot = async (page, name) => { if (process.env.TW_E2E_SHOTS) await page.screenshot({ path: join(process.env.TW_E2E_SHOTS, `${name}.png`) }) }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, what, timeoutMs = 20_000, show = null) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try { last = await check(); if (last) return last } catch (error) { last = error }
    await wait(150)
  }
  if (show) last = await show()
  throw new Error(`Timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`)
}

/** A TCP proxy to the Worker that can drop every connection and refuse new ones. */
async function startProxy(targetPort) {
  const open = new Set()
  let refusing = false
  const server = createServer((client) => {
    if (refusing) { client.destroy(); return }
    const upstream = connect(targetPort, '127.0.0.1')
    const pair = { client, upstream }
    open.add(pair)
    const end = () => { open.delete(pair); client.destroy(); upstream.destroy() }
    client.on('error', end); upstream.on('error', end); client.on('close', end); upstream.on('close', end)
    client.pipe(upstream); upstream.pipe(client)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    cut() { refusing = true; for (const { client, upstream } of [...open]) { client.destroy(); upstream.destroy() } open.clear() },
    restore() { refusing = false },
    close: () => new Promise((resolve) => { refusing = true; for (const { client, upstream } of open) { client.destroy(); upstream.destroy() } server.close(() => resolve()) }),
  }
}

let app
let worker
let proxy
try {
  await ensureFreshBuild(root)
  worker = await startLiveWorker()
  proxy = await startProxy(Number(new URL(worker.baseUrl).port))
  writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, liveWorkerBaseUrl: proxy.baseUrl }))

  app = await electron.launch({
    args: ['.', `--user-data-dir=${userData}`], cwd: root,
    env: { ...process.env, TW_E2E: '1', TALKWEAVER_LIVE_ADMIN_SECRET: worker.adminSecret },
  })
  await app.evaluate(({ app, BrowserWindow }) => {
    const hide = (win) => { win.setPosition(-20000, -20000); win.hide() }
    BrowserWindow.getAllWindows().forEach(hide)
    app.on('browser-window-created', (_event, win) => hide(win))
  })
  const page = await app.firstWindow()
  page.setDefaultTimeout(30_000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.waitForLoadState('domcontentloaded')
  await page.getByText('Feedback probe', { exact: true }).first().click()
  await page.waitForSelector('.workspace')
  await page.waitForSelector('.cm-content')

  // ── Share (ticket 03's path); the Feedback button appears ─────────────────────────────────────
  assert.equal(await page.getByTestId('toolbar-feedback').count(), 0, 'no Feedback button before the talk is shared')
  await page.locator('button[title="Export, build, or publish this talk"]').click()
  await page.getByRole('menuitem', { name: 'Share for comments…' }).click()
  await page.waitForSelector('[data-testid="share-sheet"][data-phase="ready"]')
  const link = (await page.getByTestId('share-link').textContent()).trim()
  const shareId = link.split('/').pop()
  await until(async () => (await (await fetch(`${worker.baseUrl}/shares/${shareId}/talk.json`)).json())?.revision === 1, 'revision 1')
  await page.getByTestId('share-done').click()
  await page.getByTestId('toolbar-feedback').waitFor()
  await page.getByTestId('toolbar-feedback').click()
  await page.getByTestId('feedback-rail').waitFor()
  await page.getByText('Nothing yet.', { exact: false }).waitFor()
  assert.equal(await page.locator('.pane--inspector').count(), 0, 'the rail takes the Inspector\'s slot')
  assert.equal(await page.locator('.cm-content').isVisible(), true, 'the outline stays beside it')
  log('shared; the Feedback button opens the rail beside the outline, empty')

  // ── Her items arrive: one of each kind ─────────────────────────────────────────────────────────
  const post = async (body) => {
    const response = await fetch(`${worker.baseUrl}/shares/${shareId}/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal(response.status, 201, await response.text())
    await wait(20) // distinct createdAt, so newest-first is determinate
  }
  await post({ itemId: 'e2e-note', kind: 'note', slideId: 'rubric', text: 'Too dense for a room of markers.', name: 'Anna' })
  await post({ itemId: 'e2e-edit', kind: 'replace', slideId: 'rubric', baseRevision: 1, text: '### The rubric problem\n{id=rubric}\n\n- Rubrics reward what a model writes most fluently\n- Markers read structure first' })
  await post({ itemId: 'e2e-delete', kind: 'delete', slideId: 'tried', baseRevision: 1, reason: 'The close says the same.' })
  await post({ itemId: 'e2e-insert', kind: 'insert', afterSlideId: 'rubric', baseRevision: 1, section: 'What students told us', text: '### Students asked for the rules in writing\n- A one-page policy settled most questions' })

  const items = page.getByTestId('feedback-item')
  await until(async () => (await items.count()) === 4, 'four items in the rail')
  const kinds = await items.evaluateAll((els) => els.map((el) => [el.dataset.kind, el.querySelector('[data-testid="feedback-kind"]').textContent]))
  assert.deepEqual(kinds, [['insert', 'Proposed new slide'], ['delete', 'Proposed deletion'], ['replace', 'Proposed edit'], ['note', 'Note']], 'every kind, newest first')
  const edit = page.locator('[data-item-id="e2e-edit"]')
  await until(async () => /\d+ slides/.test(await page.locator('.workspace').innerText()), 'the talk compiled (slide numbers in the rail)')
  assert.match(await edit.getByTestId('feedback-diff').textContent(), /Rubrics reward the features a model produces most fluently.*Rubrics reward what a model writes most fluently/s, 'a two-line diff against the base revision')
  const insert = page.locator('[data-item-id="e2e-insert"]')
  assert.match(await insert.textContent(), /after slide \d+ · new section: What students told us/)
  assert.match(await insert.getByTestId('feedback-preview').textContent(), /Students asked for the rules in writing/, 'a preview of the new slide')
  assert.equal(await insert.getByTestId('feedback-accept').getAttribute('aria-disabled'), null, 'Accept is live')
  assert.match(await page.locator('[data-item-id="e2e-note"]').textContent(), /Anna.*Too dense for a room of markers/s)
  assert.match(await page.locator('[data-item-id="e2e-delete"]').textContent(), /Reason: The close says the same\./)
  const counts = async () => ({
    toolbar: (await page.getByTestId('toolbar-feedback-count').count()) ? (await page.getByTestId('toolbar-feedback-count').textContent()) : '',
    row: (await page.getByTestId('talk-row-feedback-count').count()) ? (await page.getByTestId('talk-row-feedback-count').first().textContent()) : '',
    rail: await page.getByTestId('feedback-rail-count').textContent(),
  })
  const dump = async () => ({ ...(await counts()), sharedBadges: await page.getByTestId('talk-row-shared').count(), rows: await page.locator('.tl-row').count(), shares: await page.evaluate(async () => JSON.stringify((await window.tw.sharedTalk.list()).map((s) => [s.key, s.outlinePath, s.realPath]))), sums: await page.evaluate(async () => JSON.stringify(await window.tw.sharedTalk.feedbackSummaries())) })
  await until(async () => JSON.stringify(await counts()) === JSON.stringify({ toolbar: '4', row: '4', rail: '4 new' }), 'counts of 4', 20_000, counts)
  const feedbackFile = join(talkDir, 'feedback', `${shareId}.jsonl`)
  const fileLines = () => readFileSync(feedbackFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(fileLines().filter((l) => l.type === 'item').map((l) => l.item.itemId), ['e2e-note', 'e2e-edit', 'e2e-delete', 'e2e-insert'], 'mirrored into <talk>/feedback/<share-id>.jsonl')
  await page.setViewportSize({ width: 1440, height: 1000 }).catch(() => {})
  await shot(page, 'feedback-rail-frame1')
  log('four items arrive live, each drawn as its kind, newest first; talk row, toolbar and rail count 4; mirrored to the feedback file')

  // ── Done and Dismiss: grey with a time, counts drop, the Worker has it ─────────────────────────
  await page.locator('[data-item-id="e2e-note"]').getByTestId('feedback-done').click()
  await page.waitForSelector('[data-item-id="e2e-note"][data-handled="true"]')
  assert.match(await page.locator('[data-item-id="e2e-note"]').getByTestId('feedback-stamp').textContent(), /^Done \d\d:\d\d today$/)
  await page.locator('[data-item-id="e2e-delete"]').getByTestId('feedback-dismiss').click()
  await page.waitForSelector('[data-item-id="e2e-delete"][data-handled="true"]')
  assert.match(await page.locator('[data-item-id="e2e-delete"]').getByTestId('feedback-stamp').textContent(), /^Dismissed \d\d:\d\d today$/)
  assert.equal(await page.locator('[data-item-id="e2e-delete"]').evaluate((el) => getComputedStyle(el).opacity), '0.55', 'greyed')
  await until(async () => JSON.stringify(await counts()) === JSON.stringify({ toolbar: '2', row: '2', rail: '2 new' }), 'counts of 2', 20_000, counts)
  await until(() => {
    const lines = fileLines()
    return ['e2e-note:done', 'e2e-delete:dismissed'].every((pair) => ['status', 'synced'].every((type) => lines.some((l) => l.type === type && `${l.itemId}:${l.status}` === pair)))
  }, 'status and synced lines for Done and Dismiss (the Worker answered the PATCH)')
  log('Done and Dismiss grey the item with a time, counts drop to 2, the Worker confirms both')

  // ── Main takes only the rail's statuses, and an edit only with Accept ────────────────────────────
  const goodEdit = { from: 0, removed: '', inserted: 'x', line: 1, before: '', after: '' }
  for (const [status, edit] of [['bogus', undefined], ['done', goodEdit], ['accepted', { from: -1 }]]) {
    const refused = await page.evaluate(([p, s, e]) => window.tw.sharedTalk.setFeedbackStatus(p, 'e2e-edit', s, e), [outlinePath, status, edit])
    assert.equal(refused.success, false, `main refuses ${status}${edit ? ' with that edit' : ''}`)
  }
  assert.equal(fileLines().some((l) => l.type === 'status' && l.itemId === 'e2e-edit'), false, 'nothing written for a refused status')
  log('main refuses an unknown status, an edit on anything but Accept, and a malformed edit')

  // ── The outline is replaced by a new file (an external atomic save): one re-key, the rail stays ─
  const keyBefore = (await page.evaluate(() => window.tw.sharedTalk.list()))[0].key
  await page.evaluate(() => {
    window.__railGone = 0
    window.__shareGone = 0
    new MutationObserver(() => {
      if (!document.querySelector('[data-testid="feedback-rail"]')) window.__railGone += 1
      if (!document.querySelector('[data-testid="status-shared"]')) window.__shareGone += 1
    }).observe(document.body, { childList: true, subtree: true })
    window.tw.sharedTalk.onChanged(({ state }) => { if (!state) window.__shareGone += 1 })
  })
  const replacement = join(talkDir, '.replace-probe.tmp')
  writeFileSync(replacement, readFileSync(outlinePath, 'utf8'))
  renameSync(replacement, outlinePath)
  // Anything that asks main about the talk finds it by its new identity and re-keys it.
  await page.evaluate((p) => window.tw.sharedTalk.status(p), outlinePath)
  await until(async () => (await page.evaluate(() => window.tw.sharedTalk.list()))[0].key !== keyBefore, 'the share re-keyed to the new file')
  await wait(1500)
  assert.equal(await page.evaluate(() => window.__railGone), 0, 'the rail never closed')
  assert.equal(await page.evaluate(() => window.__shareGone), 0, 'no "share gone" event, no status chip flicker')
  assert.equal(await items.count(), 4, 'the rail still lists the items')
  assert.equal((await page.evaluate(() => window.tw.sharedTalk.list())).length, 1)
  log('an external rename-replace of the outline re-keys the share in one event; the rail and chip never close')

  // ── The link drops: paused chip in the status bar and the rail; editing and saving carry on ─────
  proxy.cut()
  await page.waitForSelector('[data-testid="status-shared"][data-paused="true"]')
  assert.equal((await page.getByTestId('status-shared').textContent()).trim(), 'Sharing paused · reconnecting')
  await page.getByTestId('feedback-paused').waitFor()
  assert.match(await page.getByTestId('feedback-rail').textContent(), /Nothing is lost, only delayed\./)
  await post({ itemId: 'e2e-late', kind: 'note', slideId: 'close', text: 'Sent while you were offline.' })
  await page.locator('.cm-content .cm-line', { hasText: 'One change before Michaelmas' }).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' — typed while paused')
  await until(() => readFileSync(outlinePath, 'utf8').includes('— typed while paused'), 'the save while paused')
  assert.equal(await items.count(), 4, 'nothing arrives while the link is down')
  await shot(page, 'feedback-rail-frame3-paused')
  log('socket cut: "Sharing paused · reconnecting" in the status bar and rail header; editing and saving carry on')

  proxy.restore()
  await until(async () => (await page.getByTestId('status-shared').getAttribute('data-paused')) === null, 'the paused chip to clear', 30_000)
  assert.match(await page.getByTestId('status-shared').textContent(), /^Shared for comments · /)
  assert.equal(await page.getByTestId('feedback-paused').count(), 0)
  await until(async () => (await items.count()) === 5, 'the late item after reconnect')
  // Clicking into the editor moved the sidebar to the slide outline; the talk row is on Talks.
  await page.getByText('Talks', { exact: true }).first().click()
  await page.locator('.tl-row').first().waitFor()
  assert.equal(await items.first().getAttribute('data-item-id'), 'e2e-late')
  await until(async () => JSON.stringify(await counts()) === JSON.stringify({ toolbar: '3', row: '3', rail: '3 new' }), 'counts of 3', 20_000, dump)
  const itemLines = fileLines().filter((l) => l.type === 'item').map((l) => l.item.itemId)
  assert.deepEqual(itemLines, ['e2e-note', 'e2e-edit', 'e2e-delete', 'e2e-insert', 'e2e-late'], 'each item once in the file after the replay')
  log('reconnect: chip clears, the item sent meanwhile arrives once, counts 3')

  // ── Ticket 06 · Accept a proposed edit: the file changes exactly as the diff showed ────────────
  const readOutline = () => readFileSync(outlinePath, 'utf8')
  const RUBRIC_OLD = '- Rubrics reward the features a model produces most fluently'
  const RUBRIC_NEW = '- Rubrics reward what a model writes most fluently'
  const beforeAccept = readOutline()
  assert.ok(beforeAccept.includes(RUBRIC_OLD))
  assert.equal(await edit.getAttribute('data-flagged'), null, 'an unchanged slide is not flagged')
  await edit.getByTestId('feedback-accept').click()
  await page.waitForSelector('[data-item-id="e2e-edit"][data-handled="true"]')
  const expectedAfterAccept = beforeAccept.replace(RUBRIC_OLD, RUBRIC_NEW)
  await until(() => readOutline() === expectedAfterAccept, 'the file changed exactly as the diff showed', 20_000, () => readOutline())
  assert.ok(expectedAfterAccept.includes(`${RUBRIC_NEW}\n<!-- from the Trinity panel -->\n- Markers read structure first\n\n:::notes\nPause here. Ask who marks with a rubric.\n:::`), 'his comment and notes kept in the block')
  assert.match(await edit.getByTestId('feedback-stamp-text').textContent(), /^Accepted \d\d:\d\d today · in the outline, line \d+$/)
  assert.equal(await edit.getByTestId('feedback-undo').count(), 1, 'accepted keeps Undo')
  await until(() => fileLines().some((l) => l.type === 'status' && l.itemId === 'e2e-edit' && l.status === 'accepted' && typeof l.edit?.inserted === 'string' && Number.isInteger(l.edit.from)), 'an accepted line with the splice for Undo')
  await until(() => fileLines().some((l) => l.type === 'synced' && l.itemId === 'e2e-edit' && l.status === 'accepted'), 'the Worker confirmed "accepted"')
  log('Accept of a proposed edit: exactly the one line her diff showed changes in the file; his comment and notes stay; stamped with the line and Undo; the Worker has it')

  // ── Undo: the file back byte for byte, the item new again ─────────────────────────────────────────
  await edit.getByTestId('feedback-undo').click()
  await page.waitForSelector('[data-item-id="e2e-edit"][data-handled="false"]')
  await until(() => readOutline() === beforeAccept, 'Undo restored the file', 20_000, () => readOutline())
  await until(() => fileLines().some((l) => l.type === 'synced' && l.itemId === 'e2e-edit' && l.status === 'new'), 'the Worker confirmed the revert to new')
  log('Undo restores the outline text exactly and reverts the item to new, on the Worker too')

  // ── Compare on a slide he changed since: Keep mine leaves the file alone ───────────────────────────
  await page.locator('.cm-content .cm-line', { hasText: 'Markers read structure first' }).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' — and last')
  await until(() => readOutline().includes('- Markers read structure first — and last'), 'his edit saved')
  await until(async () => (await edit.getAttribute('data-flagged')) === 'true', 'the edit is flagged: slide changed since')
  assert.equal(await edit.getByTestId('feedback-flag').textContent(), 'Slide changed since this was written.')
  assert.deepEqual(await edit.locator('.fr-acts > button').evaluateAll((els) => els.map((el) => el.textContent)), ['Compare', 'Accept', 'Dismiss'], 'it leads with Compare')
  await edit.getByTestId('feedback-compare').click()
  await edit.getByTestId('feedback-compare-yours').waitFor()
  assert.match(await edit.locator('.fr-cmp-chg').first().textContent(), /Markers read structure first — and last/, 'his change since is highlighted in "Yours now"')
  assert.match(await edit.getByTestId('feedback-compare-hers').textContent(), /Rubrics reward what a model writes most fluently/)
  await shot(page, 'feedback-compare-frame2')
  const beforeKeep = readOutline()
  await edit.getByTestId('feedback-keep-mine').click()
  await page.waitForSelector('[data-item-id="e2e-edit"][data-handled="true"]')
  assert.match(await edit.getByTestId('feedback-stamp-text').textContent(), /^Dismissed /)
  await wait(1200)
  assert.equal(readOutline(), beforeKeep, 'Keep mine does not touch the file')
  log('his change flags the edit; Compare shows yours (his change highlighted) and hers; Keep mine dismisses it and leaves the file alone')

  // ── Use hers: her lines in, his notes and comment kept ─────────────────────────────────────────────
  await post({ itemId: 'e2e-edit2', kind: 'replace', slideId: 'rubric', baseRevision: 1, text: '### The rubric problem\n{id=rubric}\n\n- Rubrics reward what a model writes\n- Markers read structure first' })
  const edit2 = page.locator('[data-item-id="e2e-edit2"]')
  await edit2.waitFor()
  await until(async () => (await edit2.getAttribute('data-flagged')) === 'true', 'the second edit is flagged too')
  await edit2.getByTestId('feedback-compare').click()
  const beforeHers = readOutline()
  await edit2.getByTestId('feedback-use-hers').click()
  await page.waitForSelector('[data-item-id="e2e-edit2"][data-handled="true"]')
  const expectedHers = beforeHers.replace(RUBRIC_OLD, '- Rubrics reward what a model writes').replace('- Markers read structure first — and last', '- Markers read structure first')
  await until(() => readOutline() === expectedHers, 'Use hers wrote exactly her lines', 20_000, () => readOutline())
  assert.ok(expectedHers.includes('- Rubrics reward what a model writes\n<!-- from the Trinity panel -->\n- Markers read structure first\n\n:::notes'), 'comment in place, notes kept')
  log('Use hers replaces his changed lines with hers; the comment keeps its place and the notes stay')

  // ── The external-change guard holds Accept ─────────────────────────────────────────────────────────
  const outside = readOutline() + '\n<!-- changed outside TalkWeaver -->\n'
  writeFileSync(outlinePath, outside)
  await page.waitForSelector('[data-testid="outline-disk-change-bar"]', { timeout: 15_000 })
  await insert.getByTestId('feedback-accept').click()
  await until(async () => /changed on disk/.test(await page.getByTestId('feedback-rail').locator('.fr-error').textContent().catch(() => '')), 'Accept refused while the bar is up')
  await wait(800)
  assert.equal(readOutline(), outside, 'nothing written over the changed file')
  assert.equal(await insert.getAttribute('data-handled'), 'false', 'the item stays new')
  await page.locator('[data-testid="outline-disk-change-bar"]').getByRole('button', { name: 'Reload' }).click()
  await page.waitForSelector('[data-testid="outline-disk-change-bar"]', { state: 'detached' })
  await until(async () => (await page.getByTestId('feedback-rail').locator('.fr-error').count()) === 0, 'the refusal clears once the bar is answered')
  log('an outside change to the file holds Accept: refused, nothing written, the item stays new')

  // ── Markers on the slide pane ───────────────────────────────────────────────────────────────────
  await page.getByTestId('toolbar-feedback').click() // the rail closes; the slide pane is back
  await page.getByTestId('feedback-rail').waitFor({ state: 'detached' })
  // A card by its caption's exact title (the thumbnail text may quote other slides' words).
  const card = (title) => page.locator('.tw-slide-card').filter({ has: page.locator('span', { hasText: new RegExp(`^${title}$`) }) }).first()
  const badge = (title) => card(title).getByTestId('slide-feedback-badge')
  await until(async () => (await badge('What we tried').count()) === 1 && (await badge('Close').count()) === 1, 'badges on the slide pane', 20_000,
    async () => page.locator('.pane--strip').innerText().catch((e) => e.message))
  assert.deepEqual([await badge('The rubric problem').getAttribute('data-handled'), await badge('The rubric problem').textContent()], ['true', '✓'], 'all handled on the rubric slide: a tick')
  assert.equal(await badge('What we tried').getAttribute('data-handled'), 'true', 'the dismissed deletion: a tick')
  assert.deepEqual([await badge('Close').getAttribute('data-count'), await badge('Close').textContent()], ['1', '1'], 'one new note on the closing slide')
  const ghost = page.locator('[data-testid="slide-ghost"][data-item-id="e2e-insert"]')
  await ghost.waitFor()
  assert.match(await ghost.textContent(), /Students asked for the rules in writing.*Proposed new slide · after \d+.*New section: What students told us/s)
  const ghostFollowsRubric = await page.evaluate(() => {
    const g = document.querySelector('[data-testid="slide-ghost"][data-item-id="e2e-insert"]')
    const prevCard = g?.previousElementSibling?.querySelector('.tw-slide-card')
    return prevCard?.textContent ?? ''
  })
  assert.match(ghostFollowsRubric, /The rubric problem/, 'the ghost row sits right after the slide it follows')
  log('markers: a tick on handled slides, a count on the slide with a new note, a ghost row after the named slide')

  // A marker opens the rail on its slide, beside the pane.
  await badge('Close').click()
  // The rail opens on the marker's slide from its first frame (its scope is the marker's slide, not
  // the editor's active slide, which the click moves a moment later).
  await page.waitForSelector('[data-testid="feedback-rail"][data-filter="slide"]', { timeout: 2_000 })
  assert.match(await page.getByTestId('feedback-rail-count').textContent(), /^Slide \d+ · 1 new$/)
  assert.match(await page.getByTestId('feedback-rail').textContent(), /Opened from the marker on slide \d+ · 1 more new elsewhere/)
  assert.deepEqual(await items.evaluateAll((els) => els.map((el) => el.dataset.itemId)), ['e2e-late'], 'only that slide\'s items')
  // The slide pane re-mounts beside the rail and builds its cards a moment later.
  await page.waitForSelector('.pane--strip-rail .tw-slide-card', { timeout: 10_000 })
  await shot(page, 'feedback-markers-frame2')
  log('a marker opens the rail filtered to its slide, beside the slide pane')

  // The ghost opens the rail at its item; Accept inserts the section and slide right after the named slide.
  await ghost.click()
  await until(async () => (await page.getByTestId('feedback-rail').getAttribute('data-filter')) === 'all', 'the rail on every item')
  const beforeInsert = readOutline()
  await insert.getByTestId('feedback-accept').click()
  await page.waitForSelector('[data-item-id="e2e-insert"][data-handled="true"]')
  await until(() => readOutline().includes('#### Students asked for the rules in writing'), 'the new slide in the file')
  const afterInsert = readOutline()
  // Line by line: one run of lines inserted, every other line as it was.
  const bl = beforeInsert.split('\n')
  const al = afterInsert.split('\n')
  let p = 0
  while (p < bl.length && bl[p] === al[p]) p += 1
  const added = al.slice(p, p + al.length - bl.length)
  assert.deepEqual([...al.slice(0, p), ...al.slice(p + added.length)], bl, 'one insertion, nothing else changed')
  assert.match(added.join('\n'), /^### What students told us\n(\{id=[\w-]+\}\n)?\n#### Students asked for the rules in writing\n(\{id=[\w-]+\}\n)?- A one-page policy settled most questions\n$/, 'section one depth shallower, the slide its first child')
  assert.ok(afterInsert.indexOf('### What students told us') > afterInsert.indexOf(':::notes') && afterInsert.indexOf('### What students told us') < afterInsert.indexOf('### What we tried'), 'right after the named slide')
  await ghost.waitFor({ state: 'detached' })
  log('the ghost row opens its item; Accept inserts the section and slide right after the named slide, and the ghost goes')

  // ── Close the rail: the Inspector's slot goes back to the strip ────────────────────────────────
  await page.getByRole('button', { name: 'Close feedback' }).first().click()
  await page.getByTestId('feedback-rail').waitFor({ state: 'detached' })
  assert.equal(await page.locator('.pane--strip-rail').count(), 0)
  assert.ok(existsSync(feedbackFile))
  assert.deepEqual(errors, [], 'no renderer errors')
  log('rail closes; no renderer errors')
} finally {
  await app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((win) => win.destroy())).catch(() => {})
  await app?.close().catch(() => {})
  await proxy?.close().catch(() => {})
  await worker?.stop()
  rmSync(scratch, { recursive: true, force: true })
}

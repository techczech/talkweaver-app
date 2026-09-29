// Share for comments (ticket 03), end to end: the real app, the real share sheet, the real Worker
// under wrangler dev (scripts/lib/live-worker-harness.mjs). Shares a talk from the toolbar's Share
// menu, checks the sheet shows a live link, QR and Copy link, that a save pushes revision 2 (and
// that the pushed talk carries no speaker notes), that switch 1 off stops save pushes and Update
// shared copy pushes, and that Stop sharing closes the share and clears the badge and metadata.
// No production credentials, remote Worker or user vault are used.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { startLiveWorker } from '../scripts/lib/live-worker-harness.mjs'

const root = process.cwd()
const scratch = mkdtempSync(join(tmpdir(), 'tw-shared-talk-e2e-'))
const userData = join(scratch, 'userData')
const vault = join(scratch, 'vault')
const slug = 'share-probe'
const talkDir = join(vault, slug)
const outlinePath = join(talkDir, `${slug}-outline.md`)
mkdirSync(userData, { recursive: true })
mkdirSync(talkDir, { recursive: true })
writeFileSync(outlinePath, [
  '---', 'title: Share probe', 'outline_version: 2', 'author: Dominik', '---', '',
  '## Where it breaks', '',
  '### The rubric problem', '{id=rubric}', '', '- Rubrics reward fluent features', '',
  ':::notes', 'PRIVATE-SPEAKER-NOTE do not share', ':::', '',
  '### Close', '{id=close}', '', '- One change before Michaelmas', '',
].join('\n'))

const log = (message) => console.log(`PASS ${message}`)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check, what, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try { last = await check(); if (last) return last } catch (error) { last = error }
    await wait(150)
  }
  throw new Error(`Timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`)
}

let app
let worker
try {
  await ensureFreshBuild(root)
  worker = await startLiveWorker()
  writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, liveWorkerBaseUrl: worker.baseUrl }))
  const talkJson = async (shareId) => {
    const response = await fetch(`${worker.baseUrl}/shares/${shareId}/talk.json`)
    return response.ok ? response.json() : null
  }

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
  await page.getByText('Share probe', { exact: true }).first().click()
  await page.waitForSelector('.workspace')
  await page.waitForSelector('.cm-content')
  await page.evaluate(() => {
    window.__copied = ''
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => { window.__copied = text } } })
  })

  // ── Share from the toolbar's Share menu; the sheet shows the link, QR and Copy link ────────────
  await page.locator('button[title="Export, build, or publish this talk"]').click()
  await page.getByRole('menuitem', { name: 'Share for comments…' }).click()
  const sheet = page.getByTestId('share-sheet')
  await sheet.waitFor()
  await page.waitForSelector('[data-testid="share-sheet"][data-phase="ready"]')
  const link = (await page.getByTestId('share-link').textContent()).trim()
  assert.match(link, new RegExp(`^${worker.baseUrl.replace(/[.]/g, '\\.')}/shares/[a-z0-9]{8}$`), `the sheet shows the share link (${link})`)
  const shareId = link.split('/').pop()
  assert.equal(await page.getByTestId('share-qr').isVisible(), true, 'a QR code renders')
  assert.match(await page.getByTestId('share-qr').getAttribute('src'), /^data:image\/svg\+xml/)
  assert.equal(await page.getByTestId('share-switch-live').getAttribute('aria-checked'), 'true', 'switch 1 on by default')
  assert.equal(await page.getByTestId('share-switch-proposals').getAttribute('aria-checked'), 'true', 'switch 2 on by default')
  assert.match(await page.getByTestId('share-local-note').textContent(), /works only on this Mac/, 'a local worker link is labelled as this-Mac-only')
  assert.equal(await page.getByTestId('share-paste-hint').count(), 0, 'no paste hint for a link nobody else can open')
  await page.getByTestId('share-copy').click()
  await page.waitForFunction((expected) => window.__copied === expected, link)
  log(`share sheet: link ${link}, QR, Copy link copies it, both switches on, local-only note`)

  const first = await until(async () => { const t = await talkJson(shareId); return t?.revision === 1 && t }, 'revision 1 on the worker')
  const pageHtml = await (await fetch(link)).text()
  assert.equal(pageHtml.includes('PRIVATE-SPEAKER-NOTE'), false, 'the pushed handout carries no speaker notes')
  assert.equal(JSON.stringify(first.slides).includes('PRIVATE-SPEAKER-NOTE'), false, 'the pushed slide text carries no speaker notes')
  assert.match(pageHtml, /tw-shared-talk-config/, 'the worker serves the page with the comments runtime slot')
  assert.deepEqual(first.slides.find((s) => s.slideId === 'rubric')?.text, '### The rubric problem\n{id=rubric}\n\n- Rubrics reward fluent features')
  await until(() => /share_url: /.test(readFileSync(outlinePath, 'utf8')), 'share_url in the outline')
  assert.match(readFileSync(outlinePath, 'utf8'), new RegExp(`share_url: ${link.replace(/[.]/g, '\\.')}`))
  const registry = JSON.parse(readFileSync(join(userData, 'shared-talk-registry.json'), 'utf8'))
  const row = Object.values(registry.shares)[0]
  assert.equal(row.shareId, shareId, 'share id and owner token are in the app-data share registry')
  assert.ok(row.ownerToken)
  assert.equal(row.realPath.endsWith(`${slug}/${slug}-outline.md`), true, 'keyed by the outline\'s identity')
  assert.ok(existsSync(join(talkDir, 'feedback', `${shareId}-revisions`, '1.json')), 'revision 1 slide text kept under the talk\'s feedback folder')
  log('revision 1 pushed with no speaker notes; share_url written; registry and revision text kept')

  await page.getByTestId('share-done').click()
  await sheet.waitFor({ state: 'detached' })
  await page.getByTestId('status-shared').waitFor()
  assert.match(await page.getByTestId('status-shared').textContent(), /^Shared for comments · 127\.0\.0\.1:\d+\/shares\//)
  assert.equal(await page.getByTestId('talk-row-shared').first().isVisible(), true, 'the talk row shows the Shared badge')
  log('status bar says "Shared for comments · <link>"; talk row shows Shared')

  // The share_url stamp and the forced flush are saves too, but change nothing on her page.
  await wait(3000)
  assert.equal((await talkJson(shareId)).revision, 1, 'metadata-only saves push nothing')

  // ── A save pushes revision 2 ────────────────────────────────────────────────────────────────────
  await page.locator('.cm-content .cm-line', { hasText: 'One change before Michaelmas' }).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' — edited live')
  await until(() => readFileSync(outlinePath, 'utf8').includes('— edited live'), 'the save on disk')
  const second = await until(async () => { const t = await talkJson(shareId); return t?.revision === 2 && t }, 'revision 2 on the worker')
  assert.match(second.slides.find((s) => s.slideId === 'close').text, /One change before Michaelmas — edited live/)
  assert.ok(existsSync(join(talkDir, 'feedback', `${shareId}-revisions`, '2.json')))
  log('a save pushes revision 2 with the saved slide text')

  // ── Switch 1 off: saves push nothing; Update shared copy pushes ─────────────────────────────────
  await page.getByTestId('status-shared').click()
  await page.waitForSelector('[data-testid="share-sheet"][data-phase="ready"]')
  await page.getByTestId('share-switch-live').click()
  await page.waitForSelector('[data-testid="share-switch-live"][aria-checked="false"]')
  await page.getByTestId('share-update').waitFor()
  await page.getByTestId('share-done').click()
  await page.locator('.cm-content .cm-line', { hasText: 'Rubrics reward fluent features' }).first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' (quiet)')
  await until(() => readFileSync(outlinePath, 'utf8').includes('(quiet)'), 'the quiet save on disk')
  await wait(3500)
  assert.equal((await talkJson(shareId)).revision, 2, 'switch 1 off: a save does not push')
  await page.getByTestId('status-shared').click()
  await page.getByTestId('share-update').click()
  const third = await until(async () => { const t = await talkJson(shareId); return t?.revision === 3 && t }, 'revision 3 after Update shared copy')
  assert.match(third.slides.find((s) => s.slideId === 'rubric').text, /\(quiet\)/)
  log('switch 1 off: no push on save; Update shared copy pushes revision 3')

  // ── Stop sharing closes the share, keeps the feedback folder, clears badge and metadata ─────────
  await page.waitForSelector('[data-testid="share-sheet"][data-phase="ready"]')
  await page.getByTestId('share-stop').click()
  await sheet.waitFor({ state: 'detached' })
  await until(async () => (await fetch(link)).status === 410, 'the page answers 410 after Stop sharing')
  await page.getByTestId('status-shared').waitFor({ state: 'detached' })
  await until(async () => (await page.getByTestId('talk-row-shared').count()) === 0, 'the Shared badge to clear')
  await until(() => !/share_url:/.test(readFileSync(outlinePath, 'utf8')), 'share_url removed from the outline')
  assert.ok(existsSync(join(talkDir, 'feedback', `${shareId}-revisions`, '3.json')), 'the feedback folder stays')
  assert.deepEqual(JSON.parse(readFileSync(join(userData, 'shared-talk-registry.json'), 'utf8')).shares, {})
  log('Stop sharing: share closed (410), badge and status chip cleared, share_url removed, feedback kept')

  assert.deepEqual(errors, [], 'no renderer errors')
} finally {
  await app?.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach((win) => win.destroy())).catch(() => {})
  await app?.close().catch(() => {})
  await worker?.stop()
  rmSync(scratch, { recursive: true, force: true })
}

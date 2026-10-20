// Work-files ticket 08: the pre-work and post-work strips under the Metadata table, in the real app
// (hidden window, temp vault, isolated userData, no network). The strips sit under the Metadata
// table, which is the Markdown view (Plain view has its own Talk details panel), so the run starts there.
//   (a) a talk naming no file: "No pre-work" / "No post-work", at 14px, with the Attach buttons;
//   (b) Attach a pre-work file opens the picker, choosing a file writes ONLY `prework:` to the outline
//       (every other byte kept, on disk too) and the strip reads "not sent to anyone" with Plan a run;
//   (c) a talk with two published Runs: "sent to 2 runs", the Open run list names both, and choosing one
//       opens Sessions on that Run;
//   (d) the Pre-work row is a picker of file names;
//   (e) a talk with one Run, delivered, its post-work open: "sent to Saïd workshop · 0/18" and
//       "Saïd workshop · 0/18 · closes …".
// Every drawn text in every state reached here (none, not sent, sent to 1 run, sent to 2 runs, post-work
// open) and in both menus is checked at 14px, node by node (ticket 08 review S8). A work file with no id
// is offered in Attach disabled, with its reason (S9).
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPlannedRun, markRunDelivered, persistRunForTalk, readRunForTalk } from '../src/main/runs.ts'

const shotsDir = process.env.TW_SHOTS_DIR || ''
if (shotsDir) mkdirSync(shotsDir, { recursive: true })
let failures = 0
const rec = (name, ok, detail) => { if (!ok) failures += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`) }
await ensureFreshBuild(process.cwd())

const head = (id, title) => ['---', `id: ${id}`, `title: ${title}`, 'revision: 1', '---', ''].join('\n')
const RTI = head('research-teams-intake', 'Research teams intake') + ['Short steps.', '', '### Watch', '{id=watch}{video}', '![](https://youtu.be/dQw4w9WgXcQ)', '### Quick check', '{id=check}{check}{poll=single}', '- One {right}', '- Two', '### Try a prompt', '{id=try}{task}', '1. Pick', '2. Try', '### Want', '{id=want}{poll=open}', ''].join('\n')
const SFB = head('session-feedback', 'Session feedback') + ['### Useful?', '{id=useful}{poll=rating}', '### Unclear?', '{id=unclear}{poll=open}', '### More?', '{id=more}{poll=open}', ''].join('\n')
const PLAIN = ['---', 'title: Strip Plain', '# a comment that must survive', 'subtitle: A working session', 'author: Test Author', '---', '', '## Section', '', '### Slide', '', 'body', ''].join('\n')
const NOID = ['---', 'title: Loose notes', 'revision: 1', '---', '', '### Read', '{id=read}', 'x', ''].join('\n')
const OPEN = ['---', 'title: Strip Open', 'prework: research-teams-intake', 'postwork: session-feedback', '---', '', '## Section', '', '### Slide', '', 'body', ''].join('\n')
const SENT = ['---', 'title: Strip Sent', 'prework: research-teams-intake', 'postwork: session-feedback', '---', '', '## Section', '', '### Slide', '', 'body', ''].join('\n')

const root = mkdtempSync(join(tmpdir(), 'tw-work-strips-e2e-'))
const vault = join(root, 'vault'); const ud = join(root, 'userData')
mkdirSync(vault, { recursive: true }); mkdirSync(ud, { recursive: true })
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault, editorViewMode: 'markdown' }, null, 2))
mkdirSync(join(vault, 'Work files'))
writeFileSync(join(vault, 'Work files', 'research-teams-intake.md'), RTI)
writeFileSync(join(vault, 'Work files', 'session-feedback.md'), SFB)
writeFileSync(join(vault, 'Work files', 'loose-notes.md'), NOID)
for (const [slug, text] of [['strip-plain', PLAIN], ['strip-sent', SENT], ['strip-open', OPEN]]) {
  mkdirSync(join(vault, slug))
  writeFileSync(join(vault, slug, `${slug}-outline.md`), text)
}
const plainPath = join(vault, 'strip-plain', 'strip-plain-outline.md')
const work = { pre: { fileId: 'research-teams-intake', opens: '2026-10-20T09:00', closes: '2026-11-01T09:00' }, post: { fileId: 'session-feedback', opens: 'session-end', closes: '2026-11-20T17:00' } }
for (const [id, name, date] of [['said', 'Saïd workshop', '2026-11-02'], ['med', 'Medical Sciences', '2026-11-09']]) {
  createPlannedRun(vault, { talkSlug: 'strip-sent', talkTitle: 'Strip Sent', plannedDate: date, eventTitle: name, expectedPeople: 18, slideSet: { kind: 'full' }, work }, () => id)
  const run = readRunForTalk(vault, 'strip-sent', id)
  const stamp = (phase) => ({ ...run.work[phase], pinned: { fileId: work[phase].fileId, title: work[phase].fileId, revision: 1, sha256: 'a'.repeat(64), copy: `strip-sent/runs/${id}.${phase}.md`, pinnedAt: '2026-10-15T09:00:00.000Z' }, publishedAt: '2026-10-15T09:00:00.000Z' })
  persistRunForTalk(vault, 'strip-sent', id, { ...run, work: { pre: stamp('pre'), post: stamp('post') } })
}
// (e) one Run, two days ago, delivered: its post-work is open until 20 days from now.
{
  const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const openWork = { pre: { fileId: 'research-teams-intake', opens: `${day(-9)}T09:00`, closes: `${day(-2)}T09:00` }, post: { fileId: 'session-feedback', opens: 'session-end', closes: `${day(20)}T17:00` } }
  createPlannedRun(vault, { talkSlug: 'strip-open', talkTitle: 'Strip Open', plannedDate: day(-2), startTime: '14:00', eventTitle: 'Saïd workshop', expectedPeople: 18, slideSet: { kind: 'full' }, work: openWork }, () => 'said')
  markRunDelivered(vault, 'strip-open', 'said')
  const run = readRunForTalk(vault, 'strip-open', 'said')
  const at = new Date(Date.now() - 10 * 86_400_000).toISOString()
  persistRunForTalk(vault, 'strip-open', 'said', { ...run, work: { pre: { ...run.work.pre, publishedAt: at }, post: { ...run.work.post, publishedAt: at } } })
}

const env = { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' }
let app
for (let attempt = 1; attempt <= 3 && !app; attempt += 1) {
  try { app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: process.cwd(), env, timeout: 60_000 }) }
  catch (error) { if (attempt === 3) throw error; await new Promise((r) => setTimeout(r, 15_000)) }
}
const page = await app.firstWindow()
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 150)))
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(2500)
const strip = (phase) => page.locator(`[data-work-strip="${phase}"]`)
const text = async (phase) => ((await strip(phase).innerText()) ?? '').replace(/\s+/g, ' ').trim()
// The font size of every node that draws text under a root: one entry, 14px, or the check fails.
const textSizes = (selector) => page.locator(selector).first().evaluate((root) => {
  const sizes = new Set()
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3 && child.textContent.trim()) sizes.add(getComputedStyle(child.parentElement).fontSize)
      else if (child.nodeType === 1) walk(child)
    }
  }
  walk(root)
  return [...sizes].sort()
})
const all14 = async (name, selector) => { const sizes = await textSizes(selector); rec(`${name}: every drawn text is 14px`, sizes.length === 1 && sizes[0] === '14px', sizes.join(', ')) }

try {
  // (a) nothing named
  await openTalkByTitle(page, 'Strip Plain')
  await page.waitForSelector('[data-work-strip="pre"]', { timeout: 10_000 })
  rec('no file: pre-work strip says so', (await text('pre')).startsWith('No pre-work') && (await text('pre')).includes('Attach a pre-work file'), await text('pre'))
  rec('no file: post-work strip says so', (await text('post')).startsWith('No post-work') && (await text('post')).includes('Attach a post-work file'), await text('post'))
  await all14('no file, pre-work strip', '[data-work-strip="pre"]')
  await all14('no file, post-work strip', '[data-work-strip="post"]')
  rec('a Pre-work row is not in the table until attached', await page.locator('.cm-fm-row[data-fm-key="prework"]').count() === 0)
  if (shotsDir) await page.screenshot({ path: join(shotsDir, 'strips-none.png') }).catch(() => {})

  // (b) attach
  await strip('pre').locator('[data-strip-action="attach"]').click()
  await page.waitForSelector('[data-strip-menu="attach-pre"]', { timeout: 5000 })
  const items = (await page.locator('[data-strip-menu="attach-pre"] button').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim())
  rec('the picker offers the files by name', items.length === 3 && items.some((t) => t.startsWith('Research teams intake')) && items.some((t) => t.startsWith('Session feedback')), items.join(' | '))
  const noId = page.locator('[data-strip-menu="attach-pre"] button', { hasText: 'Loose notes' })
  rec('a file with no id is shown disabled, with the reason', await noId.isDisabled() && ((await noId.textContent()) ?? '').includes('needs an id'), (await noId.textContent()) ?? '')
  await all14('the Attach menu', '[data-strip-menu="attach-pre"]')
  await page.locator('[data-strip-menu="attach-pre"] button', { hasText: 'Research teams intake' }).click()
  await page.waitForFunction(() => document.querySelector('[data-work-strip="pre"]')?.textContent?.includes('not sent to anyone'), null, { timeout: 8000 }).catch(() => {})
  const attached = await text('pre')
  rec('attached, not sent: the drawn text', attached.startsWith('Pre-work · Research teams intake · 4 steps · not sent to anyone') && attached.includes('Plan a run'), attached)
  rec('the post-work strip is untouched', (await text('post')).startsWith('No post-work'))
  rec('the Pre-work row is now a picker of file names', await page.locator('.cm-fm-row[data-fm-key="prework"] select option', { hasText: 'Research teams intake' }).count() === 1)
  await all14('attached, not sent', '[data-work-strip="pre"]')
  await page.waitForTimeout(3500)
  // The app's own save may stamp slide ids below the front matter; the front matter block is what attaching touches.
  const block = (text) => text.slice(0, text.indexOf('\n---', 3) + 4)
  const expected = block(PLAIN).replace('author: Test Author\n---', 'author: Test Author\nprework: research-teams-intake\n---')
  const onDisk = block(readFileSync(plainPath, 'utf8'))
  rec('only prework: was written; every other front-matter byte is kept, on disk too', onDisk === expected && expected.includes('# a comment that must survive'), JSON.stringify(onDisk))
  if (shotsDir) await page.screenshot({ path: join(shotsDir, 'strips-not-sent.png') }).catch(() => {})

  // (c) sent to two runs
  await openTalkByTitle(page, 'Strip Sent')
  await page.waitForFunction(() => document.querySelector('[data-work-strip="pre"]')?.textContent?.includes('sent to 2 runs'), null, { timeout: 10_000 }).catch(() => {})
  const pre = await text('pre')
  rec('sent to 2 runs: the strip says so with Open run', pre.startsWith('Pre-work · Research teams intake · 4 steps · sent to 2 runs') && pre.includes('Open run'), pre)
  rec('post-work: sent to 2 runs, opens after each session', (await text('post')).startsWith('Post-work · Session feedback · 3 steps · sent to 2 runs · opens after each session'), await text('post'))
  await strip('pre').locator('[data-strip-action="open-run-menu"]').click()
  await page.waitForSelector('[data-strip-menu="runs-pre"]', { timeout: 5000 })
  const runs = await page.locator('[data-strip-menu="runs-pre"] button').evaluateAll((nodes) => nodes.map((n) => [...n.children].map((c) => c.textContent).join(' ')))
  rec('Open run lists both Runs with date and count', runs.length === 2 && runs[0] === 'Saïd workshop Mon 2 Nov · 0/18' && runs[1] === 'Medical Sciences Mon 9 Nov · 0/18', runs.join(' | '))
  await all14('sent to 2 runs, pre-work strip', '[data-work-strip="pre"]')
  await all14('sent to 2 runs, post-work strip', '[data-work-strip="post"]')
  await all14('the Open run menu', '[data-strip-menu="runs-pre"]')
  if (shotsDir) await page.screenshot({ path: join(shotsDir, 'strips-sent-2.png') }).catch(() => {})
  const pending = app.waitForEvent('window')
  await page.locator('[data-strip-menu="runs-pre"] button', { hasText: 'Medical Sciences' }).click()
  const tools = await pending
  await tools.waitForLoadState('domcontentloaded')
  await tools.waitForSelector('[data-tools-view="sessions"][data-run="strip-sent/med"]', { timeout: 8000 }).catch(() => {})
  rec('Open run opens Sessions on that Run', await tools.locator('[data-tools-view="sessions"][data-run="strip-sent/med"]').count() === 1)
  rec('choosing a Run closes the menu', await page.locator('[data-strip-menu]').count() === 0)

  // A menu left open closes when the strip data is read again (no click anywhere: MENU), and when the
  // editor moves to another talk.
  await strip('post').locator('[data-strip-action="open-run-menu"]').click()
  await page.waitForSelector('[data-strip-menu="runs-post"]', { timeout: 5000 })
  await page.evaluate(() => window.dispatchEvent(new Event('tw-runs-changed')))
  await page.waitForFunction(() => !document.querySelector('[data-strip-menu]'), null, { timeout: 5000 }).catch(() => {})
  rec('the open menu closes when the strips are read again', await page.locator('[data-strip-menu]').count() === 0)
  await strip('post').locator('[data-strip-action="open-run-menu"]').click()
  await page.waitForSelector('[data-strip-menu="runs-post"]', { timeout: 5000 })

  // (e) sent to one Run, post-work open
  await openTalkByTitle(page, 'Strip Open')
  rec('the open menu closed with the talk', await page.locator('[data-strip-menu]').count() === 0)
  await page.waitForFunction(() => document.querySelector('[data-work-strip="post"]')?.textContent?.includes('closes'), null, { timeout: 10_000 }).catch(() => {})
  const one = await text('pre')
  rec('sent to 1 run: the Run, its count and Open run', one.startsWith('Pre-work · Research teams intake · 4 steps · sent to Saïd workshop · 0/18') && one.includes('Open run'), one)
  const open = await text('post')
  rec('post-work open: the Run, its count and when it closes', /^Post-work · Session feedback · 3 steps · Saïd workshop · 0\/18 · closes \w{3} \d{1,2} \w{3}/.test(open), open)
  await all14('sent to 1 run', '[data-work-strip="pre"]')
  await all14('post-work open', '[data-work-strip="post"]')
  if (shotsDir) await page.screenshot({ path: join(shotsDir, 'strips-sent-1-post-open.png') }).catch(() => {})
} finally { await app.close().catch(() => {}) }

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED')
process.exit(failures ? 1 : 0)

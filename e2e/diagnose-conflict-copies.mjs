// Real-Electron gate harness for conflict copies (several-vaults ticket 09; architecture.md "Conflict
// copies", invariants 2 and 5; LOCKED-conflict frames 1 and 5, LOCKED-sidebar section 4).
//
//   (A) IDENTICAL — a byte-identical OneDrive copy goes to the Trash (test mode: TW_E2E_TRASH_DIR, a
//                   folder standing in for the OS Trash, which the harness cannot inspect), the outline is
//                   untouched, the talk has an Activity line in app data (never in the vault), no badge.
//   (B) DIFFERING — a differing Google Drive copy: amber "1 conflict copy · Compare…" on the talk row;
//                   nothing in the vault is written, moved or removed. Two copies read "2 conflict copies".
//   (C) GIT       — Git conflict markers inside the outline: the badge; the outline is untouched.
//   (D) OPEN TALK — with a talk open, a copy dropped into its folder is seen through the folder watch:
//                   an identical one is trashed with a live Activity line in the Inspector; a differing
//                   one raises the badge and the status bar pill. Compare… raises the window event that
//                   opens the ticket-10 compare screen (cancelled here).
//   (F) REVIEW    — a vault registered through a symlinked path: the open talk's folder events still
//                   reach the scan (S1); a Git conflict shown inside a code fence is no conflict (S2); an
//                   identical `S-EN.md` sibling is the author's file and stays (S3).
//   (E) NOT SCANNED — a closed vault and an unavailable vault (its folder moved away) are not scanned:
//                   their identical copies stay, no Activity. The unavailable vault's folder comes back:
//                   it is scanned then.
//
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && TW_E2E=1 node e2e/diagnose-conflict-copies.mjs
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { ensureTalksMode, openTalkByTitle } from './lib/talklist.mjs'
import { fileURLToPath } from 'url'
import { dirname, join, relative } from 'path'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')
const SHOTS = join(REPO, 'docs', 'design', '2026-09-29-multi-vault', 'build-shots')
mkdirSync(SHOTS, { recursive: true })

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}
const outline = (title, extra = '') => ['---', `title: ${title}`, 'outline_version: 2', '---', '', '## Section', '',
  `### ${title} slide {id=${title.toLowerCase().replace(/\W+/g, '').slice(0, 5)}}`, '', 'Body one.', '', extra].join('\n')
const slugOf = (title) => title.toLowerCase().replace(/\W+/g, '-')
const until = async (fn, timeout = 10000, step = 150) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, step)) }
  return false
}
/** Every file under root with its bytes (relative path → text): what "nothing written" compares. */
function snap(root) {
  const out = {}
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out[relative(root, p)] = readFileSync(p, 'utf8')
    }
  }
  walk(root)
  return out
}

const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'tw-e2e-conflicts-')))
const personal = join(tempRoot, 'Personal')
const closed = join(tempRoot, 'Closed')
const away = join(tempRoot, 'Away')
const awayMoved = join(tempRoot, 'Away (moved)')
const trash = join(tempRoot, 'Trash')
const userData = join(tempRoot, 'userData')

function talk(root, title, extra = '') {
  const slug = slugOf(title)
  mkdirSync(join(root, slug), { recursive: true })
  const text = outline(title, extra)
  writeFileSync(join(root, slug, `${slug}-outline.md`), text)
  return { slug, folder: join(root, slug), outlinePath: join(root, slug, `${slug}-outline.md`), text }
}
const identical = talk(personal, 'Identical talk')
writeFileSync(join(identical.folder, 'identical-talk-outline-MacBook-Air.md'), identical.text)
writeFileSync(join(identical.folder, 'identical-talk-notes.md'), 'my own notes')
const differing = talk(personal, 'Differing talk')
writeFileSync(join(differing.folder, 'differing-talk-outline (1).md'), differing.text + '\n### Added on the other Mac\n')
const several = talk(personal, 'Several talk')
writeFileSync(join(several.folder, 'several-talk-outline-MacBook-Air.md'), several.text + 'one\n')
writeFileSync(join(several.folder, "several-talk-outline (Anna's conflicted copy 2026-09-30).md"), several.text + 'two\n')
const git = talk(personal, 'Git talk', '<<<<<<< HEAD\n### Mine\n=======\n### Theirs\n>>>>>>> origin/main\n')
const clean = talk(personal, 'Clean talk')
const fenced = talk(personal, 'Fenced talk', '```text\n<<<<<<< HEAD\n### Mine\n=======\n### Theirs\n>>>>>>> origin/main\n```\n')
writeFileSync(join(identical.folder, 'identical-talk-outline-EN.md'), identical.text) // an intentional identical sibling
writeFileSync(join(identical.folder, 'identical-talk-outline-final-draft.md'), identical.text) // no machine token: the author's
writeFileSync(join(identical.folder, 'identical-talk-outline-machine.md'), identical.text) // "mac" inside a word is not a machine
const linkedReal = join(tempRoot, 'Linked real')
const linkedLink = join(tempRoot, 'Linked')
const linkedTalk = talk(linkedReal, 'Linked talk')
symlinkSync(linkedReal, linkedLink)
const closedTalk = talk(closed, 'Closed vault talk')
writeFileSync(join(closedTalk.folder, 'closed-vault-talk-outline-MacBook-Air.md'), closedTalk.text)
const awayTalk = talk(away, 'Away vault talk')
writeFileSync(join(awayTalk.folder, 'away-vault-talk-outline-MacBook-Air.md'), awayTalk.text)
renameSync(away, awayMoved) // unavailable from the start: its folder is not where the vault says
mkdirSync(userData, { recursive: true })
writeFileSync(join(userData, 'config.json'), JSON.stringify({
  vaultRoot: personal,
  vaults: [
    { id: 'vault-personal', root: personal, open: true, order: 0 },
    { id: 'vault-closed', root: closed, open: false, order: 1 },
    { id: 'vault-away', root: away, open: true, order: 2 },
    { id: 'vault-linked', root: linkedLink, open: true, order: 3 }
  ]
}, null, 2))
const personalBefore = snap(personal)
const closedBefore = snap(closed)

await ensureFreshBuild(REPO)
const app = await electron.launch({ args: ['.', '--user-data-dir=' + userData], cwd: REPO, env: { ...process.env, TW_E2E: '1', TW_E2E_TRASH_DIR: trash } })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.setSize(1440, 900) })
await page.waitForTimeout(1200)

const row = (title) => page.locator(`.tl-tree [data-talk-title="${title}"]`).first()
const chip = (title) => row(title).locator('[data-conflict-count]')
const shot = (name) => page.screenshot({ path: join(SHOTS, `09-${name}.png`) })
const trashed = () => (existsSync(trash) ? readdirSync(trash) : [])
const activityFile = (vaultId, slug) => join(userData, 'talk-activity', vaultId, `${slug}.jsonl`)
async function openInInspector(title) {
  await openTalkByTitle(page, title)
  await page.waitForTimeout(600)
  if (await page.locator('.tw-inspector').count() === 0) {
    await page.locator('.cm-content').first().click()
    await page.keyboard.press('Meta+p') // Inspector mode
  }
  await page.locator('.tw-inspector').waitFor({ state: 'visible', timeout: 8000 })
}

try {
  await ensureTalksMode(page)
  await row('Clean talk').waitFor({ state: 'attached', timeout: 10000 })

  // ── (A) identical copy ──
  const gone = await until(() => trashed().some((n) => n.endsWith('identical-talk-outline-MacBook-Air.md')))
  record('an identical copy is moved to the Trash (test trash folder)', gone, JSON.stringify(trashed()))
  record('…and is no longer in the talk folder; the author’s own sibling stays', !existsSync(join(identical.folder, 'identical-talk-outline-MacBook-Air.md')) && existsSync(join(identical.folder, 'identical-talk-notes.md')))
  record('…the file in the Trash holds the same bytes', gone && readFileSync(join(trash, trashed().find((n) => n.endsWith('identical-talk-outline-MacBook-Air.md'))), 'utf8') === identical.text)
  record('the outline itself is untouched', readFileSync(identical.outlinePath, 'utf8') === identical.text)
  const act = existsSync(activityFile('vault-personal', 'identical-talk')) ? readFileSync(activityFile('vault-personal', 'identical-talk'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
  record('one Activity line in app data: "Removed an identical copy from MacBook Air"', act.length === 1 && act[0].title === 'Removed an identical copy from MacBook Air', JSON.stringify(act))
  record('no badge on the talk', await chip('Identical talk').count() === 0)

  // ── (B) differing copies and (C) Git markers: badge, nothing written ──
  await until(async () => (await chip('Differing talk').count()) === 1)
  record('a differing copy: "1 conflict copy · Compare…" on the talk row', (await chip('Differing talk').innerText().catch(() => '')) === '1 conflict copy · Compare…')
  record('two copies are counted: "2 conflict copies · Compare…"', (await chip('Several talk').innerText().catch(() => '')) === '2 conflict copies · Compare…')
  record('Git markers inside the outline: the badge', (await chip('Git talk').innerText().catch(() => '')) === '1 conflict copy · Compare…')
  record('a talk with no copy has no badge', await chip('Clean talk').count() === 0)
  record('a Git conflict shown inside a code fence is no conflict: no badge (review S2)', await row('Fenced talk').count() === 1 && await chip('Fenced talk').count() === 0)
  record('identical S-EN.md, S-final-draft.md and S-machine.md siblings are the author’s files: they stay (review S3)',
    ['EN', 'final-draft', 'machine'].every((t) => existsSync(join(identical.folder, `identical-talk-outline-${t}.md`))) &&
    !trashed().some((n) => /-(EN|final-draft|machine)\.md$/.test(n)), JSON.stringify(trashed()))
  const expected = { ...personalBefore }
  delete expected[relative(personal, join(identical.folder, 'identical-talk-outline-MacBook-Air.md'))]
  record('nothing else in the vault was written, moved or removed', JSON.stringify(snap(personal)) === JSON.stringify(expected))
  record('no Activity line for a talk whose copies differ', !existsSync(activityFile('vault-personal', 'differing-talk')) && !existsSync(activityFile('vault-personal', 'git-talk')))
  record('nothing in the vault names the Activity list', !Object.keys(snap(personal)).some((p) => p.includes('activity')))
  await row('Differing talk').scrollIntoViewIfNeeded()
  await shot('conflict-chip')

  // Compare… raises the ticket-10 event and does nothing else.
  await page.evaluate(() => { window.__compare = null; window.addEventListener('tw:conflict-compare', (e) => { window.__compare = e.detail }, { once: true }) })
  await chip('Differing talk').locator('[data-conflict-compare]').click()
  const detail = await page.evaluate(() => window.__compare)
  record('Compare… raises tw:conflict-compare with the talk (the screen is ticket 10)', detail?.outlinePath === differing.outlinePath && detail?.vaultId === 'vault-personal', JSON.stringify(detail))
  // Ticket 10: the event opens the compare screen; Cancel closes it.
  const screen = page.locator('[data-conflict-compare-screen]')
  if (await screen.waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false)) {
    await page.locator('[data-conflict-cancel]').click()
    await screen.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  }
  record('…and writes nothing', JSON.stringify(snap(personal)) === JSON.stringify(expected))

  // ── (E) closed and unavailable vaults are not scanned ──
  record('a closed vault is not scanned: its identical copy stays, no Activity', JSON.stringify(snap(closed)) === JSON.stringify(closedBefore) && !existsSync(join(userData, 'talk-activity', 'vault-closed')))
  record('an unavailable vault is not scanned: its (moved) identical copy stays, no Activity', existsSync(join(awayMoved, 'away-vault-talk', 'away-vault-talk-outline-MacBook-Air.md')) && !existsSync(join(userData, 'talk-activity', 'vault-away')))

  // ── (A, Inspector) the Activity line where the person reads it ──
  await openInInspector('Identical talk')
  const activity = page.locator('[data-talk-activity]')
  const shown = await activity.waitFor({ state: 'attached', timeout: 8000 }).then(() => true).catch(() => false)
  if (shown) await activity.scrollIntoViewIfNeeded()
  const activityText = shown ? await activity.innerText() : ''
  record('the Inspector shows the Activity line with its reason', activityText.includes('Removed an identical copy from MacBook Air') && activityText.includes('It matched this file byte for byte, so nothing was lost.'), activityText.replace(/\n/g, ' | '))
  await shot('activity-line')

  // ── (D) folder events for the open talk's folder ──
  writeFileSync(join(identical.folder, 'identical-talk-outline (1).md'), identical.text)
  const liveGone = await until(() => trashed().some((n) => n.endsWith('identical-talk-outline (1).md')), 8000)
  record('with the talk open, an identical copy that arrives is trashed (folder watch)', liveGone && !existsSync(join(identical.folder, 'identical-talk-outline (1).md')))
  const liveLine = await until(async () => (await activity.locator('.tw-talk-activity-row').count()) === 2, 5000)
  record('…and a second Activity line appears in the Inspector without a reload', liveLine, String(await activity.locator('.tw-talk-activity-row').count()))
  record('…still no badge', await chip('Identical talk').count() === 0)

  await ensureTalksMode(page)
  await openInInspector('Clean talk')
  writeFileSync(join(clean.folder, 'clean-talk-outline-MacBook-Air.md'), clean.text + 'edited on the Air\n')
  await ensureTalksMode(page)
  const liveBadge = await until(async () => (await chip('Clean talk').count()) === 1, 8000)
  record('with the talk open, a differing copy that arrives raises the badge (folder watch)', liveBadge)
  const pill = page.locator('.tw-status-conflict')
  record('…and the status bar pill', (await pill.innerText().catch(() => '')) === '1 conflict copy · Compare…')
  record('…and the copy is left where it is', existsSync(join(clean.folder, 'clean-talk-outline-MacBook-Air.md')) && readFileSync(clean.outlinePath, 'utf8') === clean.text)
  await row('Clean talk').scrollIntoViewIfNeeded()
  await shot('status-pill')

  // ── (F) a vault registered through a symlink: live folder events still scanned (review S1) ──
  await ensureTalksMode(page)
  await openInInspector('Linked talk')
  writeFileSync(join(linkedReal, 'linked-talk', 'linked-talk-outline (1).md'), linkedTalk.text + 'other Mac\n')
  await ensureTalksMode(page)
  const linkedBadge = await until(async () => (await chip('Linked talk').count()) === 1, 8000)
  record('symlinked vault: a differing copy that arrives while the talk is open raises the badge', linkedBadge)
  record('…and the status bar pill', (await page.locator('.tw-status-conflict').innerText().catch(() => '')) === '1 conflict copy · Compare…')
  writeFileSync(join(linkedReal, 'linked-talk', 'linked-talk-outline-MacBook-Air.md'), linkedTalk.text)
  const linkedGone = await until(() => trashed().some((n) => n.endsWith('linked-talk-outline-MacBook-Air.md')), 8000)
  record('symlinked vault: an identical copy that arrives is trashed, with an Activity line', linkedGone && await until(() => existsSync(activityFile('vault-linked', 'linked-talk')), 3000))

  // ── (E) the unavailable vault comes back: now it is scanned ──
  renameSync(awayMoved, away)
  await page.evaluate(() => window.tw.vault.recheck()) // "Check again"
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  const back = await until(() => trashed().some((n) => n.endsWith('away-vault-talk-outline-MacBook-Air.md')), 10000)
  record('the vault’s folder comes back: it is scanned, its identical copy goes to the Trash', back, JSON.stringify(trashed()))
} catch (error) {
  record('harness ran to the end', false, error?.stack ?? String(error))
} finally {
  await app.close().catch(() => {})
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)

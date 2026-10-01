// Real-Electron gate harness for compare and merge (several-vaults ticket 10; architecture.md "Conflict
// copies" merge paragraph, invariants 2 and 3; LOCKED-conflict frames 2, 3, 4 and 6).
//
//   (A) KEEP MINE   — the talk is open (the merge goes through the editor's buffer and its save). Step 1,
//                     step 2, one slide ticked, Merge: one outline with the pulled slide after its
//                     counterpart, the copy in the Trash (test mode: TW_E2E_TRASH_DIR), every line of both
//                     inputs in the outline or the trashed file, an Activity line, the badge gone.
//   (B) KEEP THEIRS — the talk is closed (disk route): the outline holds the other version plus the
//                     pulled slide; the old outline text is kept in the Trash as a file.
//   (C) GIT         — Git markers inside the outline, the talk open: both sides compared; the merged
//                     outline on disk has no markers (the badge stays gone); the marked file is in the Trash.
//   (D) CANCEL      — Cancel writes nothing (the whole vault byte for byte, the Trash untouched).
//   (E) STALE       — the copy is saved again while comparing: the banner, Merge disabled, nothing
//                     written; Start again reloads both versions at step 1.
//
// Run: cd talk-weaver && npm run build >/dev/null 2>&1 && TW_E2E=1 node e2e/diagnose-conflict-merge.mjs
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { ensureTalksMode, openTalkByTitle } from './lib/talklist.mjs'
import { fileURLToPath } from 'url'
import { dirname, join, relative } from 'path'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'fs'
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
const until = async (fn, timeout = 10000, step = 150) => {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, step)) }
  return false
}
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
const slugOf = (title) => title.toLowerCase().replace(/\W+/g, '-')
const P = (t) => t.split(/\s+/).map((w) => w[0].toLowerCase()).join('')
/** A talk in the shape of LOCKED-conflict: 5 slides, ids on every heading. */
function mineText(title) {
  const p = P(title)
  // Ids on the Trigger line under the heading: the form TalkWeaver writes (it moves a heading id there
  // when it opens a talk), so both machines' files have it.
  const slide = (heading, n, ...lines) => [`## ${heading}`, `{id=${p}00${n}}`, '', ...lines, '']
  return ['---', `title: ${title}`, 'outline_version: 2', '---', '',
    ...slide('Why assessment breaks first', 1, '- Assessment was built on text being scarce'),
    ...slide('The rubric problem', 2, '- Rubrics reward fluent features', '- 14 of 20 rubrics'),
    ...slide('Marking time', 3, '- Marking time rose by about a third'),
    ...slide('Redesign, not detection', 4, '- Detectors guess'),
    ...slide('Close', 5, '- One change you could make before Michaelmas')].join('\n')
}
function airText(title) {
  return mineText(title)
    .replace('- 14 of 20 rubrics', '- 14 of 20 rubrics; none named process')
    .replace('## Redesign, not detection', '## Redesign the task, not the detector')
}

const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), 'tw-e2e-conflict-merge-')))
const vault = join(tempRoot, 'Workshop')
const trash = join(tempRoot, 'Trash')
const userData = join(tempRoot, 'userData')
function talk(title, copies = true, outline = mineText(title)) {
  const slug = slugOf(title)
  const folder = join(vault, slug)
  mkdirSync(folder, { recursive: true })
  const outlinePath = join(folder, `${slug}-outline.md`)
  writeFileSync(outlinePath, outline)
  const copyPath = join(folder, `${slug}-outline-MacBook-Air.md`)
  if (copies) writeFileSync(copyPath, airText(title))
  return { title, slug, folder, outlinePath, copyPath, mine: outline, air: copies ? airText(title) : null }
}
const A = talk('Keep mine talk')
const B = talk('Keep theirs talk')
const gitMine = mineText('Git talk')
const gitMarked = gitMine.replace('- 14 of 20 rubrics\n', '<<<<<<< HEAD\n- 14 of 20 rubrics\n=======\n- 14 of 20 rubrics; none named process\n>>>>>>> origin/main\n')
const C = talk('Git talk', false, gitMarked)
const D = talk('Cancel talk')
const E = talk('Stale talk')
mkdirSync(userData, { recursive: true })
writeFileSync(join(userData, 'config.json'), JSON.stringify({
  vaultRoot: vault,
  vaults: [{ id: 'vault-workshop', root: vault, open: true, order: 0 }]
}, null, 2))

await ensureFreshBuild(REPO)
const app = await electron.launch({ args: ['.', '--user-data-dir=' + userData], cwd: REPO, env: { ...process.env, TW_E2E: '1', TW_E2E_TRASH_DIR: trash } })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) w.setSize(1440, 900) })
await page.waitForTimeout(1200)

const row = (title) => page.locator(`.tl-tree [data-talk-title="${title}"]`).first()
const chip = (title) => row(title).locator('[data-conflict-count]')
const screen = page.locator('[data-conflict-compare-screen]')
const shot = (name) => page.screenshot({ path: join(SHOTS, `10-${name}.png`) })
const trashed = () => (existsSync(trash) ? readdirSync(trash) : [])
const trashedFor = (slug) => Object.fromEntries(trashed().filter((n) => n.includes(slug)).map((n) => [n, readFileSync(join(trash, n), 'utf8')]))
const activityFile = (slug) => join(userData, 'talk-activity', 'vault-workshop', `${slug}.jsonl`)
const activity = (slug) => existsSync(activityFile(slug)) ? readFileSync(activityFile(slug), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []
/** Every non-blank line of each input (Git marker lines aside) is in the outline or a trashed file. */
function lostLines(inputs, outline, trashedFiles) {
  const pool = new Set([outline, ...Object.values(trashedFiles)].join('\n').split('\n'))
  const lost = []
  for (const text of inputs) for (const line of text.split('\n')) if (line.trim() && !/^(<{7}|={7}|>{7})/.test(line) && !pool.has(line)) lost.push(line)
  return lost
}
async function openCompare(title) {
  await ensureTalksMode(page)
  await until(async () => (await chip(title).count()) === 1, 10000)
  await row(title).scrollIntoViewIfNeeded()
  await chip(title).locator('[data-conflict-compare]').click()
  await screen.waitFor({ state: 'visible', timeout: 8000 })
  await page.locator('[data-conflict-step="1"]').waitFor({ state: 'visible', timeout: 8000 })
}
async function tickByTitle(title) {
  const pick = page.locator('[data-conflict-pick]').filter({ hasText: title }).first()
  await pick.locator('input[type="checkbox"]').check()
}

try {
  await ensureTalksMode(page)
  await row('Cancel talk').waitFor({ state: 'attached', timeout: 10000 })

  // ── (A) keep Mine, the talk open ──
  await openTalkByTitle(page, A.title)
  await page.waitForTimeout(800)
  await openCompare(A.title)
  const step1 = await page.locator('[data-conflict-step="1"]').innerText()
  record('step 1: both versions, Mine chosen, the differing slides named', step1.includes('Which version do you keep?') && step1.includes('MacBook Air') && step1.includes('2 slides that differ') &&
    (await page.locator('[data-conflict-version="mine"][aria-pressed="true"]').count()) === 1, step1.replace(/\n/g, ' | ').slice(0, 300))
  record('step 1: the button reads "Keep Mine, then choose slides"', (await page.locator('[data-conflict-keep]').innerText()) === 'Keep Mine, then choose slides')
  await page.waitForTimeout(1500) // slide pictures
  await shot('step1-keep-one-version')
  await page.locator('[data-conflict-keep]').click()
  await page.locator('[data-conflict-step="2"]').waitFor({ state: 'visible', timeout: 5000 })
  record('step 2: only the 2 differing slides are listed', (await page.locator('[data-conflict-pick]').count()) === 2)
  record('step 2: Merge alone when nothing is ticked', (await page.locator('[data-conflict-merge]').innerText()) === 'Merge')
  await tickByTitle('The rubric problem')
  record('step 2: "Merge · add 1 slide" once one is ticked', (await page.locator('[data-conflict-merge]').innerText()) === 'Merge · add 1 slide')
  const diffText = await page.locator('[data-conflict-pick]').first().innerText()
  record('step 2: the text difference is drawn (− Mine, + MacBook Air)', diffText.includes('− - 14 of 20 rubrics') && diffText.includes('+ - 14 of 20 rubrics; none named process'), diffText.replace(/\n/g, ' | ').slice(0, 300))
  await page.waitForTimeout(800)
  await shot('step2-pull-in-slides')
  await page.locator('[data-conflict-merge]').click()
  await screen.waitFor({ state: 'detached', timeout: 10000 })
  const aDone = await until(() => !existsSync(A.copyPath) && readFileSync(A.outlinePath, 'utf8').includes('none named process'), 10000)
  const aOut = readFileSync(A.outlinePath, 'utf8')
  record('keep Mine: one outline; the copy is gone from the folder', aDone && readdirSync(A.folder).filter((n) => n.endsWith('.md')).length === 1, readdirSync(A.folder).join(', '))
  record('…the pulled slide sits straight after its counterpart', /- 14 of 20 rubrics\n\n## The rubric problem\n\{id=[a-z0-9]{5}\}\n\n- Rubrics reward fluent features\n- 14 of 20 rubrics; none named process\n\n## Marking time/.test(aOut), aOut.slice(0, 600))
  record('…Mine is otherwise kept as it was', aOut.startsWith(A.mine.slice(0, A.mine.indexOf('## Marking time') - 1)) && aOut.endsWith(A.mine.slice(A.mine.indexOf('## Marking time'))))
  const aTrash = trashedFor(A.slug)
  record('…the copy is in the Trash, byte for byte', Object.values(aTrash).includes(A.air), Object.keys(aTrash).join(', '))
  const aLost = lostLines([A.mine, A.air], aOut, aTrash)
  record('…no text lost: every line of both inputs is in the outline or the trashed file', aLost.length === 0, JSON.stringify(aLost))
  const aAct = activity(A.slug)
  record('…one Activity line: "Merged the conflict copy from MacBook Air"', aAct.length === 1 && aAct[0].title === 'Merged the conflict copy from MacBook Air' && aAct[0].detail.startsWith('Kept Mine; added slide 2 from MacBook Air after slide 2.'), JSON.stringify(aAct))
  await ensureTalksMode(page)
  record('…the badge is gone', await until(async () => (await chip(A.title).count()) === 0, 8000))
  const editorHas = await page.locator('.cm-content').first().innerText().catch(() => '')
  record('…the open editor holds the merged text', editorHas.includes('none named process'))

  // ── (B) keep Theirs, the talk closed ──
  await openCompare(B.title)
  await page.locator('[data-conflict-version="theirs"]').click()
  record('choosing the other card: "Keep MacBook Air, then choose slides"', (await page.locator('[data-conflict-keep]').innerText()) === 'Keep MacBook Air, then choose slides')
  await page.locator('[data-conflict-keep]').click()
  await page.locator('[data-conflict-step="2"]').waitFor({ state: 'visible', timeout: 5000 })
  await tickByTitle('Redesign, not detection')
  await page.locator('[data-conflict-merge]').click()
  await screen.waitFor({ state: 'detached', timeout: 10000 })
  await until(() => !existsSync(B.copyPath), 8000)
  const bOut = readFileSync(B.outlinePath, 'utf8')
  record('keep Theirs: the outline holds MacBook Air’s version…', bOut.startsWith(B.air.slice(0, B.air.indexOf('## Close'))), bOut.slice(0, 300))
  record('…plus Mine’s slide after its counterpart', /## Redesign the task, not the detector\n\{id=ktt004\}\n\n- Detectors guess\n\n## Redesign, not detection\n\{id=[a-z0-9]{5}\}\n\n- Detectors guess\n\n## Close/.test(bOut), bOut)
  const bTrash = trashedFor(B.slug)
  record('…the old outline text is kept in the Trash as a file', Object.entries(bTrash).some(([n, t]) => n.includes('(before merge') && t === B.mine), Object.keys(bTrash).join(', '))
  record('…the copy is in the Trash too; the folder holds one outline', Object.values(bTrash).includes(B.air) && readdirSync(B.folder).filter((n) => n.endsWith('.md')).length === 1, readdirSync(B.folder).join(', '))
  record('…no text lost', lostLines([B.mine, B.air], bOut, bTrash).length === 0)

  // ── (C) Git markers, the talk open (the merge goes through the editor, whose save reaches disk) ──
  await openTalkByTitle(page, C.title)
  await page.waitForTimeout(800)
  await openCompare(C.title)
  const cSub = await page.locator('.cc-top-sub').innerText()
  record('Git markers: the compare screen opens on both sides', cSub.includes('Git left conflict markers') && (await page.locator('[data-conflict-version="theirs"]').innerText()).includes('origin/main'), cSub)
  await page.locator('[data-conflict-keep]').click()
  await tickByTitle('The rubric problem')
  await page.locator('[data-conflict-merge]').click()
  await screen.waitFor({ state: 'detached', timeout: 10000 })
  await until(() => !readFileSync(C.outlinePath, 'utf8').includes('<<<<<<<'), 8000)
  const cOut = readFileSync(C.outlinePath, 'utf8')
  record('…the merged outline has no markers and both versions of the slide', !/^(<{7}|={7}|>{7})/m.test(cOut) && cOut.includes('- 14 of 20 rubrics\n') && cOut.includes('- 14 of 20 rubrics; none named process'), cOut.slice(0, 500))
  const cTrash = trashedFor(C.slug)
  record('…the file with the markers is in the Trash', Object.values(cTrash).includes(gitMarked), Object.keys(cTrash).join(', '))
  record('…no text lost', lostLines([gitMarked], cOut, cTrash).length === 0)
  record('…Activity: "Resolved the Git conflict"', activity(C.slug)[0]?.title === 'Resolved the Git conflict')
  await ensureTalksMode(page)
  await page.waitForTimeout(2000) // folder watch + rescan
  record('…the file on disk (not only the editor) holds the merge: the badge does not come back', !readFileSync(C.outlinePath, 'utf8').includes('<<<<<<<') && (await chip(C.title).count()) === 0)

  // ── (D) Cancel writes nothing ── (the talks merged above were opened afterwards and may still be
  // saving their own open-time text: D's folder and D's slide versions are what Cancel could touch)
  await page.waitForTimeout(2000)
  const mineOfD = (all) => Object.fromEntries(Object.entries(all).filter(([k]) => k.startsWith(D.slug + '/') || k.includes('--' + D.slug)))
  const vaultBefore = mineOfD(snap(vault))
  const trashBefore = trashed().slice().sort()
  await openCompare(D.title)
  await page.locator('[data-conflict-keep]').click()
  await tickByTitle('The rubric problem')
  await page.locator('[data-conflict-step-back]').click()
  await page.locator('[data-conflict-cancel]').click()
  await screen.waitFor({ state: 'detached', timeout: 5000 })
  await page.waitForTimeout(1000)
  const vaultAfter = mineOfD(snap(vault))
  const moved = [...new Set([...Object.keys(vaultBefore), ...Object.keys(vaultAfter)])].filter((k) => vaultBefore[k] !== vaultAfter[k])
  record('Cancel: nothing of the talk written, moved or removed', moved.length === 0, JSON.stringify(moved))
  record('…nothing went to the Trash; no Activity line', JSON.stringify(trashed().slice().sort()) === JSON.stringify(trashBefore) && activity(D.slug).length === 0)
  record('…the badge stays', (await chip(D.title).count()) === 1)

  // ── (E) a file changes while comparing ──
  await openCompare(E.title)
  await page.locator('[data-conflict-keep]').click()
  await tickByTitle('The rubric problem')
  const changed = airText(E.title) + '\n## Saved again on the Air\n{id=st009}\n\n- later\n'
  writeFileSync(E.copyPath, changed)
  const banner = await page.locator('[data-conflict-stale]').waitFor({ state: 'visible', timeout: 6000 }).then(() => true, () => false)
  const bannerText = banner ? await page.locator('[data-conflict-stale]').innerText() : ''
  record('a file changed while comparing: the banner says so', banner && bannerText.includes('The talk changed while you were comparing') && bannerText.includes('MacBook Air'), bannerText)
  record('…Merge is disabled; Start again is offered', await page.locator('[data-conflict-merge]').isDisabled() && (await page.locator('[data-conflict-start-again]').count()) === 1)
  await shot('changed-start-again')
  const eBefore = snap(vault)
  await page.locator('[data-conflict-merge]').click({ force: true }).catch(() => {})
  await page.waitForTimeout(800)
  record('…nothing was merged or written', JSON.stringify(snap(vault)) === JSON.stringify(eBefore) && readFileSync(E.outlinePath, 'utf8') === E.mine && activity(E.slug).length === 0)
  await page.locator('[data-conflict-start-again]').click()
  await page.locator('[data-conflict-step="1"]').waitFor({ state: 'visible', timeout: 6000 })
  const reloaded = await page.locator('[data-conflict-version="theirs"]').innerText()
  record('Start again reloads both versions at step 1 (the new slide is there)', (await page.locator('[data-conflict-stale]').count()) === 0 && reloaded.includes('6 slides'), reloaded.replace(/\n/g, ' | ').slice(0, 200))
  await page.locator('[data-conflict-cancel]').click()
  await screen.waitFor({ state: 'detached', timeout: 5000 })
  record('…and Cancel after it still writes nothing', readFileSync(E.outlinePath, 'utf8') === E.mine && readFileSync(E.copyPath, 'utf8') === changed)
} catch (error) {
  record('harness ran to the end', false, error?.stack ?? String(error))
} finally {
  await app.close().catch(() => {})
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length ? 1 : 0)

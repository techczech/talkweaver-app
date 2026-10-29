// Slide handling ticket 1a in the real built app: hidden Electron (TW_E2E, its own --user-data-dir, mock keychain),
// on a fresh /tmp copy of the scratchpad test vault. In the grid: drag a slide down onto another card, then a whole
// section up onto another section's card. Each move goes through the shared move (moveBlocks) as one CodeMirror
// undo step: ⌘Z in the grid puts the saved file back byte for byte, ⇧⌘Z puts the move back.
// Never touches /Applications, a running TalkWeaver or the real vault.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { moveBlocks } from '../src/shared/slide-handling/blocks.ts'

const repo = resolve('.')
const SOURCE_VAULT = resolve(repo, '..', '.tw-previews', 'scratchpad-test-vault')
const SLUG = 'mapping-the-landscape-of-ai-applications-and-industry-developments-draft-slides'
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tw-slide-handling-move-')))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))
const userData = join(scratch, 'userData')
const vault = join(scratch, 'vault')
mkdirSync(userData, { recursive: true })
cpSync(SOURCE_VAULT, vault, { recursive: true })
const outline = join(vault, 'Mapping the Landscape', SLUG, `${SLUG}-outline.md`)
const pristine = readFileSync(outline, 'utf8')
writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vault, editorViewMode: 'plain' }))

const headings = (text) => text.split('\n').filter((l) => /^#{1,6}\s/.test(l)).map((l) => l.replace(/\s*\{[^}]*\}/g, '').trim())
const content = (t) => t.split('\n').filter((l) => !/^\s*(\{[^}]*\}\s*)+$/.test(l)).sort()
const refFor = (text, heading) => {
  const line = text.split('\n').findIndex((l) => l.trim() === heading) + 1
  assert.ok(line > 0, `the talk has ${heading}`)
  return { line, headingText: heading }
}

const env = { ...process.env, TW_E2E: '1', TW_REC_TEST: '1' }
delete env.ELECTRON_RUN_AS_NODE
let app
let checks = 0
const pass = (m) => { checks += 1; console.log(`PASS ${m}`) }
try {
  await ensureFreshBuild(repo)
  app = await electron.launch({ args: ['.', `--user-data-dir=${userData}`, '--use-mock-keychain'], cwd: repo, env })
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => !w.isVisible())), true, 'windows stay hidden')
  const page = await app.firstWindow()
  page.setDefaultTimeout(20000)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const saved = () => readFileSync(outline, 'utf8')
  const waitFor = async (pred, what) => {
    for (let i = 0; i < 120 && !pred(saved()); i++) await page.waitForTimeout(100)
    assert.ok(pred(saved()), `${what}; the file has: ${JSON.stringify(headings(saved()))}`)
  }

  // The talk list's Recent shelf names it by title.
  await page.getByText('Mapping the Landscape — Draft Slides', { exact: true }).first().dblclick()
  await page.locator('.cm-content').waitFor()
  // Whatever opening the talk saves (it should save nothing) settles first; that text is the baseline.
  await page.waitForTimeout(2500)
  const original = saved()
  console.log(original === pristine ? 'opening the talk left the file as it was' : 'NOTE opening the talk rewrote the file (baseline taken after it)')

  await page.locator('.pane-btn[title="Grid"]').click()
  await page.locator('.grid-view .grid-cell[draggable="true"]').first().waitFor()
  const card = (title) => page.locator('.grid-view .grid-cell[draggable="true"]', { hasText: title }).first()
  // A drag as the browser sends it: dragstart on the card, dragenter/dragover/drop on the target, dragend.
  const drag = async (from, to) => {
    await from.scrollIntoViewIfNeeded()
    const src = await from.elementHandle()
    const dst = await to.elementHandle()
    await page.evaluate(([s, d]) => {
      const dt = new DataTransfer()
      const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }))
      fire(s, 'dragstart')
      fire(d, 'dragenter')
      fire(d, 'dragover')
      fire(d, 'drop')
      fire(s, 'dragend')
    }, [src, dst])
  }
  const gridKey = async (combo) => {
    await page.locator('.grid-view').focus()
    await page.keyboard.press(combo)
  }

  // ── A slide, dragged down onto a card: lands after that card's slide ──
  const slideMove = moveBlocks(original, [refFor(original, '### Three sources of progress')], { kind: 'after', line: refFor(original, '### The Evolution of Agents').line, title: 'The Evolution of Agents' })
  assert.ok(!('refused' in slideMove), 'the expected slide move is possible')
  await drag(card('Three sources of progress'), card('The Evolution of Agents'))
  await waitFor((t) => JSON.stringify(headings(t)) === JSON.stringify(headings(slideMove.text)), 'the slide moved after "The Evolution of Agents"')
  // The save's own tidy-up (ids stamped, `{…}` token lines normalised) may rewrite token-only lines; every other
  // line is kept exactly.
  assert.deepEqual(content(saved()), content(original), 'no line lost or duplicated')
  pass('grid: a slide dragged down onto a card moves after it, every line kept')

  // The first ⌘Z: the talk is back as it was. The one exception is the app's id contract, not the move: every save
  // gives a heading without an `{id=…}` one (ADR-0032, src/main talk:write-outline) and the file keeps it after an
  // undo (extensions/savedTextAdoption.ts, head 3). This talk has one such slide, so only its token line differs.
  await gridKey('Meta+z')
  await waitFor((t) => JSON.stringify(headings(t)) === JSON.stringify(headings(original)), 'one ⌘Z in the grid puts the order back')
  await page.waitForTimeout(2500)
  assert.deepEqual(content(saved()), content(original), 'after ⌘Z every line but token-only lines is as it was')
  const stampedOnly = saved().split('\n').filter((l, i) => l !== original.split('\n')[i])
  assert.ok(stampedOnly.every((l) => /\{id=[A-Za-z0-9_-]+\}/.test(l) && /^\s*(\{[^}]*\}\s*)+$/.test(l)), `the only lines that differ got an id: ${JSON.stringify(stampedOnly)}`)
  const baseline = saved()
  pass(`grid: ⌘Z undoes the slide move (${stampedOnly.length} token line kept the id its save stamped)`)

  // From here every heading has its id: ⌘Z must give the file back byte for byte.
  await gridKey('Meta+Shift+z')
  await waitFor((t) => JSON.stringify(headings(t)) === JSON.stringify(headings(slideMove.text)), '⇧⌘Z puts the move back')
  pass('grid: ⇧⌘Z redoes the slide move')
  await gridKey('Meta+z')
  await waitFor((t) => t === baseline, 'and ⌘Z takes it back, the file byte-identical')
  await page.waitForTimeout(2500)
  assert.equal(saved(), baseline, 'and it stays so')
  pass('grid: ⌘Z after the redo leaves the file byte-identical to before the move')

  // ── A whole section, dragged up onto another section's card: lands before it with all its slides ──
  const sectionCard = page.locator('.grid-view .grid-cell[draggable="true"]', { hasText: 'Agents and practical examples' })
  const sectionCards = await sectionCard.count()
  assert.ok(sectionCards > 0, 'the grid shows a draggable card for the section "Agents and practical examples"')
  const sectionMove = moveBlocks(baseline, [refFor(baseline, '## Agents and practical examples')], { kind: 'before', line: refFor(baseline, '## Models, applications and industry developments').line, title: 'Models, applications and industry developments' })
  assert.ok(!('refused' in sectionMove), 'the expected section move is possible')
  await drag(sectionCard.first(), page.locator('.grid-view .grid-cell[draggable="true"]', { hasText: 'Models, applications and industry developments' }).first())
  await waitFor((t) => JSON.stringify(headings(t)) === JSON.stringify(headings(sectionMove.text)), 'the section moved before "Models, applications and industry developments" with its slides')
  pass('grid: a section card dragged up onto another section moves the whole section before it')
  await gridKey('Meta+z')
  await waitFor((t) => t === baseline, 'one ⌘Z puts the file back byte for byte')
  await page.waitForTimeout(2500)
  assert.equal(saved(), baseline, 'and it stays so')
  pass('grid: ⌘Z undoes the section move; the file is byte-identical to before')
  await gridKey('Meta+Shift+z')
  await waitFor((t) => JSON.stringify(headings(t)) === JSON.stringify(headings(sectionMove.text)), '⇧⌘Z puts the section move back')
  pass('grid: ⇧⌘Z redoes the section move')

  // ── ⌘↓ on the selected card: past the next slide of its level, one undo step ──
  await gridKey('Meta+z')
  await waitFor((t) => t === baseline, 'back to the baseline')
  const stepMove = moveBlocks(baseline, [refFor(baseline, '### What makes AI work: MO')], { kind: 'after', line: refFor(baseline, '### What do you need to use AI').line, title: 'What do you need to use AI' })
  assert.ok(!('refused' in stepMove))
  await card('What makes AI work: MO').click()
  await page.keyboard.press('Meta+ArrowDown')
  await waitFor((t) => JSON.stringify(headings(t)) === JSON.stringify(headings(stepMove.text)), '⌘↓ moved the slide past the next one')
  await gridKey('Meta+z')
  await waitFor((t) => t === baseline, '⌘Z takes the ⌘↓ move back, byte for byte')
  pass('grid: ⌘↓ moves the selected slide past the next slide; ⌘Z takes it back')

  // ── Ticket 1b: three slides from two sections selected with their tick boxes, Move to… the end of another section ──
  const plain = (l) => l.replace(/\s*\{[^}]*\}/g, '').replace(/^#+\s*/, '').trim()
  const lines0 = baseline.split('\n')
  const sections = []
  lines0.forEach((l, i) => {
    if (/^## /.test(l)) sections.push({ title: plain(l), line: i + 1, heading: l.trim(), slides: [] })
    else if (/^### /.test(l) && sections.length) sections[sections.length - 1].slides.push({ title: plain(l), heading: l.trim() })
  })
  const withSlides = sections.filter((x) => x.slides.length >= 2)
  assert.ok(withSlides.length >= 2, 'the talk has two sections with slides to pick from')
  const [secA, secB] = withSlides
  const dest = secB // the end of the second section: the third slide is already in it and lands last
  const picked = [secA.slides[0], secA.slides[1], secB.slides[0]]
  const exact = (title) => page.locator('.grid-view .grid-cell[draggable="true"]').filter({ has: page.locator('span', { hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) }).first()
  for (const sl of picked) {
    await exact(sl.title).scrollIntoViewIfNeeded()
    await exact(sl.title).locator('[data-grid-tick]').click()
  }
  assert.equal(await page.locator('[data-batch-count]').textContent(), '3 selected', 'the batch bar shows three selected')
  const batchMove = moveBlocks(baseline, picked.map((x) => refFor(baseline, x.heading)), { kind: 'endOfSection', line: dest.line, title: dest.title })
  assert.ok(!('refused' in batchMove), 'the expected batch move is possible')
  await page.locator('[data-batch-action="move"]').click()
  await page.locator('[data-batch-move-option]', { hasText: `End of “${dest.title}”` }).first().click()
  await waitFor((t) => JSON.stringify(headings(t)) === JSON.stringify(headings(batchMove.text)), `the three slides moved to the end of "${dest.title}"`)
  assert.deepEqual(content(saved()), content(baseline), 'no line lost or duplicated')
  assert.equal(await page.locator('[data-batch-count]').textContent(), '3 selected', 'the same three slides stay selected')
  pass('grid: three slides from two sections selected with ticks move to the end of another section through Move to…')
  await gridKey('Meta+z')
  await waitFor((t) => t === baseline, 'one ⌘Z puts all three back, the file byte-identical')
  await page.waitForTimeout(2500)
  assert.equal(saved(), baseline, 'and it stays so')
  pass('grid: one ⌘Z undoes the three-slide move; the file is byte-identical')
  await gridKey('Meta+Shift+z')
  await waitFor((t) => JSON.stringify(headings(t)) === JSON.stringify(headings(batchMove.text)), '⇧⌘Z moves the three again')
  pass('grid: ⇧⌘Z moves the three slides again')
  await gridKey('Meta+z')
  await waitFor((t) => t === baseline, 'back to the baseline')

  assert.deepEqual(errors, [], 'no page errors')
  console.log(`slide-handling move e2e: ${checks} checks passed`)
} finally {
  await app?.close()
}

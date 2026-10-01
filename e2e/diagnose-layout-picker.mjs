// Real-Electron journey for the docked layout picker (ADR-0032, 0.37 ticket 03):
//   ⌘L opens the picker in the Inspector column (the preview stays above it)
//   type "car", ↵     → the outline's trigger line gains {cards}; the column is the Inspector again
//   Esc               → closes and changes nothing
//   ↓ onto Suggested  → the first picture is tried; → tries the next one along the row (←→ stay within the row, ↓ leaves it, per the mockup keyboard map)
//   ↓ onto a layout   → the pinned preview tries it (amber ring, "Trying …" tag), the outline is byte-identical; Esc puts it back
//   Suggested / browse rows draw the author's own slide (<img data-layout-thumb>), loading shimmer first
//   the pictures are the author's OWN slide (not registry samples) on a slide with an {id=} and on one without
//   clicking a line in the outline moves the Inspector preview to that slide, and a try/keep acts on it
//   a greyed layout   → cannot be kept; no results → says so; a second ⌘L closes the picker
// Runs against the BUILT app (out/) — run after `npm run build`.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')

const results = []
function record(name, pass, detail) {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
}

const FIX = ['---', 'title: Picker Fixture', 'author: T', '---', '', '## Section', '', '### A slide', '', '- Catalogue the data', '- Manage the notes', '- Build the tools', '- Run the tests', ''].join('\n')
const tempRoot = mkdtempSync(join(tmpdir(), 'tw-e2e-lp-' + String(Date.now()) + '-'))
const vault = join(tempRoot, 'vault')
const ud = join(tempRoot, 'userData')
const td = join(vault, 'picker')
const other = join(vault, 'other')
mkdirSync(td, { recursive: true }); mkdirSync(other, { recursive: true }); mkdirSync(ud, { recursive: true })
const STAMPED = ['---', 'title: Stamped Fixture', 'author: T', '---', '', '## Section', '', '### Stamped slide', '{id=stamped-one}', '', '- Catalogue the data', '- Manage the notes', '- Build the tools', '- Run the tests', ''].join('\n')
const CLICKS = ['---', 'title: Click Fixture', 'author: T', '---', '', '## Section', '', '### First slide', '', '- Alpha one', '- Alpha two', '- Alpha three', '', '### Second slide', '', '- Bravo one', '- Bravo two', '- Bravo three', '', '### Third slide', '', '- Charlie one', '- Charlie two', '- Charlie three', ''].join('\n')
mkdirSync(join(vault, 'stamped'), { recursive: true }); mkdirSync(join(vault, 'clicks'), { recursive: true })
writeFileSync(join(vault, 'stamped', 'stamped-fixture-outline.md'), STAMPED)
writeFileSync(join(vault, 'clicks', 'click-fixture-outline.md'), CLICKS)
writeFileSync(join(other, 'other-outline.md'), '---\ntitle: Other\n---\n\n### Y\n\nz\n')
const fxPath = join(td, 'picker-fixture-outline.md')
writeFileSync(fxPath, FIX)
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))

await ensureFreshBuild(REPO)
const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: REPO, env: { ...process.env, TW_E2E: '1' } })
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(1200)

async function readDoc() {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.cm-content .cm-line')).map((l) => l.textContent).join('\n')
  )
}
async function selectTalk(name) {
  await openTalkByTitle(page, name)
  await page.waitForTimeout(350)
}
async function reset() {
  await page.waitForTimeout(1700) // let any pending autosave flush before we overwrite
  await selectTalk('Other')
  writeFileSync(fxPath, FIX)
  await selectTalk('Picker Fixture')
}
async function openPalette() {
  // Put the caret on a line of the slide first: ⌘L acts on the slide the caret is in.
  await page.locator('.cm-content .cm-line', { hasText: 'Manage the notes' }).first().click().catch(async () => {
    await page.locator('.cm-content').click()
  })
  await page.keyboard.press('Meta+l')
  await page.waitForTimeout(700) // open + the Inspector column
}
const has = (doc, sub) => doc.includes(sub)

try {
  await selectTalk('Picker Fixture')
  const picker = page.locator('[data-layout-picker]')
  const triggerLines = (doc) => doc.split('\n').filter((l) => /^\s*\{[^}]*\}\s*$/.test(l)).length

  // 1. ⌘L opens the picker in the column; the slide preview stays pinned above it
  await reset()
  const coldStart = Date.now()
  await openPalette()
  record('⌘L opens the picker in the Inspector column', (await picker.count()) === 1 && (await page.locator('.tw-inspector .lp').count()) === 1)
  record('the preview stays above the picker', await page.locator('.tw-inspector-stage').isVisible())
  record('the palette is gone: no floating layout list', (await page.locator('.command-palette, [placeholder="Search layouts..."]').count()) === 0)
  const groups = await page.locator('.lp-group-head').allTextContents()
  record('empty box shows Suggested and All layouts', groups.some((g) => /Suggested/.test(g)) && groups.some((g) => /All layouts/.test(g)), groups.join(' | '))

  // 1b. ↓ tries a layout: ring + tag on the preview, footer hints change, outline byte-identical; Esc restores
  const docBefore = await readDoc()
  const cursorName = () => page.evaluate(() => {
    const el = document.querySelector('.lp-item.is-cursor')
    return el ? { name: el.getAttribute('data-layout-name'), suggested: !!el.closest('.lp-group--suggested') } : null
  })
  await page.keyboard.press('ArrowDown') // Suggested is one row of pictures: the first ↓ lands on its first picture
  await page.waitForTimeout(150)
  const first = await cursorName()
  record('↓ lands on the first Suggested picture', Boolean(first?.suggested), JSON.stringify(first))
  await page.keyboard.press('ArrowRight') // ←→ move along the row: this is the second try
  await page.waitForTimeout(900)
  const second = await cursorName()
  record('→ moves along the Suggested row to a second picture', Boolean(second?.suggested) && second?.name !== first?.name, `${first?.name} → ${second?.name}`)
  const tryingTag = await page.locator('.tw-inspector-trying').textContent().catch(() => '')
  record('↓ onto a layout: the preview is ringed and tagged "Trying"', (await page.locator('.tw-inspector-stage.is-trying').count()) === 1 && /Trying/.test(tryingTag || ''), `tag="${tryingTag}"`)
  const footer = (await page.locator('.lp-foot').textContent().catch(() => '')) || ''
  record('footer says ↵ Keep and Esc Put back', /Keep/.test(footer) && /Put back/.test(footer), footer)
  record('a try leaves the outline byte-identical', (await readDoc()) === docBefore)
  // Pictures are rendered by the app (the samples once per run, the author's slide once it has an id): allow a cold render.
  let ownPictures = 0
  let stillDrawing = 0
  for (let i = 0; i < 40; i += 1) {
    ownPictures = await page.locator('.lp-group--suggested img[data-layout-thumb]').count()
    stillDrawing = await page.locator('.lp-group--suggested .lp-picture.is-pending').count()
    if (ownPictures > 0 && stillDrawing === 0) break
    await page.waitForTimeout(500)
  }
  console.log(`INFO cold-start: own-slide Suggested pictures drawn ${Date.now() - coldStart} ms after ⌘L (unstamped slide, fresh app run)`)
  record('Suggested shows pictures once drawn (none left loading)', ownPictures > 0 && stillDrawing === 0, `pictures=${ownPictures} loading=${stillDrawing}`)
  const suggestedSrcs = () => page.locator('.lp-group--suggested img[data-layout-thumb]').evaluateAll((list) => list.map((img) => img.getAttribute('src') ?? ''))
  const srcsA = await suggestedSrcs()
  record('UNSTAMPED slide: every Suggested picture is the author\'s own slide (not a __layout-preview__ sample)', srcsA.length > 0 && srcsA.every((src) => src.startsWith('twthumb:') && !src.includes('__layout-preview__')), srcsA.join(' '))
  await page.keyboard.press('ArrowDown') // ↓ leaves the row (the next row down, or the next group)
  await page.waitForTimeout(150)
  const below = await cursorName()
  record('↓ leaves the Suggested row', below == null || !below.suggested, JSON.stringify(below))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  record('Esc puts the preview back and closes', (await page.locator('.tw-inspector-stage.is-trying').count()) === 0 && (await picker.count()) === 0 && (await readDoc()) === docBefore)
  await openPalette()

  // 2. type "car": Cards is the top match; the outline is untouched until ↵
  await page.keyboard.type('car')
  await page.waitForTimeout(700)
  const top = await page.locator('.lp-item.is-cursor').first().textContent().catch(() => '')
  record('typing "car" highlights Cards', /Cards/.test(top || ''), `top="${top}"`)
  let doc = await readDoc()
  record('a try changes only the preview, not the outline', !has(doc, '{cards}'))

  // 3. ↵ keeps it: the trigger line gains {cards} and the column is the Inspector again
  await page.keyboard.press('Enter')
  await page.waitForTimeout(700)
  doc = await readDoc()
  record('↵ writes {cards} on the trigger line', has(doc, '{cards}') && triggerLines(doc) === 1, `triggerLines=${triggerLines(doc)}`)
  record('the column becomes the Inspector at that layout', (await picker.count()) === 0 && (await page.locator('.tw-inspector-pane').count()) === 1)

  // 4. Esc closes without change
  await reset()
  await openPalette()
  await page.keyboard.type('statement')
  await page.waitForTimeout(600)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  doc = await readDoc()
  record('Esc closes the picker and leaves the outline as it was', (await picker.count()) === 0 && !has(doc, '{statement}') && triggerLines(doc) === 0)

  // 5. a layout the slide cannot take is greyed with its reason and cannot be kept
  await openPalette()
  await page.keyboard.type('grid zoom')
  await page.waitForTimeout(500)
  const greyed = await page.locator('.lp-item.is-unusable', { hasText: 'Grid zoom' }).count()
  const reason = await page.locator('.lp-reason').first().textContent().catch(() => '')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  doc = await readDoc()
  record('a layout the slide cannot take is greyed with its reason', greyed > 0 && /section heading/.test(reason || ''), `reason="${reason}"`)
  record('↵ on a greyed layout does nothing', (await picker.count()) === 1 && triggerLines(doc) === 0)

  // 6. no results
  await page.keyboard.press('Control+a')
  await page.keyboard.type('xyz')
  await page.waitForTimeout(300)
  record('no results says so and offers Browse all', (await page.locator('.lp-empty').count()) === 1 && /No layout matches/.test((await page.locator('.lp-empty').textContent()) || ''))

  // 7. ⌘L again closes; ⌘L on a slide with a trigger changes it in place
  await page.keyboard.press('Meta+l')
  await page.waitForTimeout(300)
  record('⌘L again closes the picker', (await picker.count()) === 0)
  await reset()
  await openPalette()
  await page.keyboard.type('car')
  await page.waitForTimeout(500)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(600)
  await page.locator('.cm-content .cm-line', { hasText: '{cards}' }).first().click()
  await page.keyboard.press('Meta+l')
  await page.waitForTimeout(600)
  await page.keyboard.type('statement')
  await page.waitForTimeout(500)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(600)
  doc = await readDoc()
  record('a second pick replaces the trigger (no stacked {...})', has(doc, '{statement}') && !has(doc, '{cards}') && triggerLines(doc) === 1, `triggerLines=${triggerLines(doc)}`)

  // 8. Keep, then ⌘L again straight away: the picker opens and STAYS open while the save stamps ids (which
  // inserts lines above an unstamped slide and used to leave the picker pointing at a line that named nothing).
  await reset()
  await openPalette()
  await page.keyboard.type('car')
  await page.waitForTimeout(400)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(700)
  await page.keyboard.press('Meta+l')
  await page.waitForTimeout(1500) // past the id-stamping save
  record('⌘L right after a keep opens the picker and it stays open through the id stamp', (await picker.count()) === 1)
  await page.keyboard.type('statement')
  await page.waitForTimeout(400)
  record('typing goes into the picker search, not the outline', !has(await readDoc(), 'statement'))
  await page.keyboard.press('Enter')
  await page.waitForTimeout(600)
  doc = await readDoc()
  record('keeping from that picker changes the slide it was opened on', has(doc, '{statement}') && !has(doc, '{cards}') && triggerLines(doc) >= 1, `triggerLines=${triggerLines(doc)}`)
  // 9. A slide WITH an {id=}: Suggested is the author's own slide too.
  await page.waitForTimeout(1700)
  await selectTalk('Stamped Fixture')
  await page.locator('.cm-content .cm-line', { hasText: 'Manage the notes' }).first().click()
  await page.keyboard.press('Meta+l')
  const stampedStart = Date.now()
  let stampedSrcs = []
  for (let i = 0; i < 60; i += 1) {
    stampedSrcs = await page.locator('.lp-group--suggested img[data-layout-thumb]').evaluateAll((list) => list.map((img) => img.getAttribute('src') ?? ''))
    if (stampedSrcs.length > 0 && (await page.locator('.lp-group--suggested .lp-picture.is-pending').count()) === 0) break
    await page.waitForTimeout(250)
  }
  console.log(`INFO own-slide Suggested pictures drawn ${Date.now() - stampedStart} ms after ⌘L (id-stamped slide)`)
  record('STAMPED slide: every Suggested picture is the author\'s own slide (not a __layout-preview__ sample)', stampedSrcs.length > 0 && stampedSrcs.every((src) => src.startsWith('twthumb:') && !src.includes('__layout-preview__')), stampedSrcs.join(' '))
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)

  // 10. A click in the outline moves the Inspector preview to that slide BEFORE the picker acts on it, right after the talk opens
  // (the compile may still be running: the caret's slide is found again when it lands).
  await page.waitForTimeout(1700)
  await selectTalk('Other')
  await selectTalk('Click Fixture')
  const inspectorTitle = async () => ((await page.locator('.tw-inspector-title').textContent().catch(() => '')) ?? '').trim()
  const inspectorPos = async () => ((await page.locator('.tw-inspector-pos').textContent().catch(() => '')) ?? '').trim()
  const waitForInspector = async (title) => {
    for (let i = 0; i < 12; i += 1) { if ((await inspectorTitle()) === title) return true; await page.waitForTimeout(250) }
    return false
  }
  await page.locator('.cm-content .cm-line', { hasText: 'Bravo two' }).first().click()
  await page.keyboard.press('Meta+l')
  const shownAtOpen = await waitForInspector('Second slide')
  record('picker opened after a click in slide 2: the preview shows that slide (title and counter) before any try', shownAtOpen, `${await inspectorPos()} "${await inspectorTitle()}"`)
  const secondPos = await inspectorPos()
  // A click in another slide while the picker is open: the picker closes (it belongs to the slide it opened on); the preview follows the click.
  await page.locator('.cm-content .cm-line', { hasText: 'Charlie two' }).first().click()
  const followed = await waitForInspector('Third slide')
  record('clicking a line in slide 3 moves the preview to it (title and counter changed)', followed && (await inspectorPos()) !== secondPos, `${secondPos} -> ${await inspectorPos()} "${await inspectorTitle()}"`)
  record('...and closes the picker that was open on slide 2', (await picker.count()) === 0)
  await page.locator('.cm-content .cm-line', { hasText: 'Alpha two' }).first().click()
  record('clicking a line in slide 1 moves the preview back to it', await waitForInspector('First slide'), `${await inspectorPos()} "${await inspectorTitle()}"`)
  // Now act: from a click in slide 2, try then keep a layout; the write lands under slide 2's heading.
  await page.locator('.cm-content .cm-line', { hasText: 'Bravo three' }).first().click()
  await page.keyboard.press('Meta+l')
  await page.waitForTimeout(500)
  await page.keyboard.type('statement')
  await page.waitForTimeout(700)
  record('a try rings the slide the caret is in (the preview still shows slide 2)', (await page.locator('.tw-inspector-stage.is-trying').count()) === 1 && (await inspectorTitle()) === 'Second slide', `"${await inspectorTitle()}"`)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(700)
  const lines = (await readDoc()).split('\n')
  const at = lines.findIndex((l) => l.trim() === '### Second slide')
  record('keep writes {statement} under slide 2\'s heading, not another slide\'s', at >= 0 && /\{statement\}/.test(lines[at + 1] ?? '') && lines.filter((l) => /\{statement\}/.test(l)).length === 1, lines.slice(at, at + 3).join(' | '))
} catch (e) {
  record('layout-picker harness completed without throwing', false, String(e && e.stack ? e.stack : e))
} finally {
  const failed = results.filter((r) => !r.pass)
  console.log(`\n=== LAYOUT-PICKER SUMMARY: ${results.length - failed.length}/${results.length} passed ===`)
  await app.close()
  process.exit(failed.length === 0 ? 0 : 1)
}

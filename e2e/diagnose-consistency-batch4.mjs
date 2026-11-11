// Consistency batch 4 (house rules R7, R8, R11, R16) in the real app, hidden and off-screen, on a throwaway copy of demo-vault/:
//   R11  the old commands (deck-design, metadata), the Plain card's link and the Markdown table's action open the Talk tab, and
//        no dialog opens; a title edited in the Talk tab lands in the outline front matter byte for byte as the old Talk design
//        dialog wrote it (editFrontmatterText, the one writer both used);
//   R7   one number per slide: the Slide outline's, the strip's, the grid's and the presenter's agree for every demo talk, and
//        the presenter's total is the editor's count; sections read §n and carry the layout mark the strip shows;
//   R16  Vault Gallery, Slide focus, Pathways and the Slide Browser each show one "Back to <talk>" control, and it and Esc return to the talk.
// Run: node e2e/diagnose-consistency-batch4.mjs   (one Electron run at a time)
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchWorld } from './lib/consistency-world.mjs'
import { editFrontmatterText } from '../src/shared/frontmatter-editor.ts'
import { METADATA_REGISTRY } from '../src/shared/metadata-registry.ts'

const world = await launchWorld({ width: 1280, height: 800, viewMode: 'markdown' })
const { page, app, vault, sleep, command } = world
let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS  ${name}`) } catch (error) { failures += 1; console.log(`FAIL  ${name}\n      ${String(error?.message ?? error).split('\n')[0]}`) }
}
const talkTab = page.locator('[data-talk-tab]')
const TITLE = 'TalkWeaver Layout Showcase'
await world.openTalk(TITLE)

// ---- R11 ----------------------------------------------------------------------------------------------------------
for (const id of ['deck-design', 'metadata']) {
  await check(`the ${id} command opens the Talk tab and no dialog`, async () => {
    await world.rcTab('inspector').click(); await sleep(400)
    assert.equal(await talkTab.count(), 0, 'the Talk tab was up before')
    await command(id); await sleep(1200)
    assert.equal(await talkTab.filter({ visible: true }).count(), 1, 'the Talk tab is not showing')
    assert.equal(await page.locator('[role=dialog][aria-modal=true]:visible').count(), 0, 'a dialog opened')
    assert.equal(await page.locator('[data-rc-tab="talk"]').count(), 1)
  })
}
await check('the Talk tab groups its fields as Details, Design and Advanced', async () => {
  await command('deck-design'); await sleep(800)
  assert.ok(await page.locator('[data-talk-section="details"] #deck-title').count(), 'Title is not under Details')
  assert.ok(await page.locator('[data-talk-section="design"]').count(), 'no Design section')
  assert.ok(await page.locator('[data-talk-section="advanced"]').count(), 'no Advanced disclosure')
  assert.equal(await page.locator('[data-talk-section="design"] #deck-title').count(), 0, 'Title is in two places')
  // Advanced opens under Design, not over it (the tab's children keep their height; the tab scrolls).
  await page.locator('[data-talk-section="advanced"] > summary').click(); await sleep(1500)
  assert.ok(await page.locator('[data-metadata-embedded]').isVisible(), 'Advanced did not open')
  const boxes = await page.evaluate(() => {
    const top = (sel) => document.querySelector(sel).getBoundingClientRect()
    return { design: top('[data-talk-design-embedded]'), advanced: top('[data-talk-section="advanced"]'), body: top('[data-metadata-embedded]') }
  })
  assert.ok(boxes.advanced.top >= boxes.design.bottom - 1, `Advanced (${boxes.advanced.top}) overlaps Design (${boxes.design.bottom})`)
  assert.ok(boxes.design.height > 300, `Design is squeezed to ${boxes.design.height}px`)
  assert.ok(boxes.body.height > 60, 'Advanced has no height')
  await page.locator('[data-talk-section="advanced"] > summary').click(); await sleep(300)
})
await check('a title edited in the Talk tab lands in the front matter as the old dialog wrote it', async () => {
  const file = join(vault, 'layout-showcase', 'layout-showcase-outline.md')
  const before = readFileSync(file, 'utf8')
  const entry = METADATA_REGISTRY.find((m) => m.key === 'title')
  const next = 'Renamed in the Talk tab'
  const expected = editFrontmatterText(before, [{ key: 'title', aliases: entry.aliases ?? [], value: next, raw: false }])
  await command('deck-design'); await sleep(600)
  await page.locator('#deck-title').fill(next)
  await page.locator('[data-deck-design-save]').click()
  await sleep(3500)
  const after = readFileSync(file, 'utf8')
  assert.equal(after, expected, 'the outline differs from what the dialog\'s writer produces')
  assert.notEqual(after, before)
})
await check('unsaved Talk tab edits survive the Advanced disclosure and a sidebar tab change, and never leave their talk', async () => {
  await command('deck-design'); await sleep(700)
  const draftTalkFile = join(vault, 'layout-showcase', 'layout-showcase-outline.md')
  const otherTalkFile = join(vault, 'testing-live-polls', 'testing-live-polls-outline.md')
  const draftTalkBefore = readFileSync(draftTalkFile)
  const otherTalkBefore = readFileSync(otherTalkFile)
  const saved = await page.locator('#deck-title').inputValue()
  await page.locator('#deck-title').fill('Unsaved title')
  const advanced = page.locator('[data-talk-section="advanced"] > summary')
  await advanced.click(); await sleep(1500)
  await page.locator('[data-metadata-embedded] input[type=text]').first().fill('unsaved-new.pdf')
  await advanced.click(); await sleep(300); await advanced.click(); await sleep(1500)
  assert.equal(await page.locator('[data-metadata-embedded] input[type=text]').first().inputValue(), 'unsaved-new.pdf', 'the Advanced field reverted after collapse and reopen')
  await world.rcTab('inspector').click(); await sleep(500)
  await world.rcTab('talk').click(); await sleep(1200)
  assert.equal(await page.locator('#deck-title').inputValue(), 'Unsaved title', 'the title was lost after the tab change')
  // another talk gets none of it, and coming back finds it gone (drafts belong to the open talk only)
  await world.sideTab(/^Talks$/).click().catch(() => {})
  await world.openTalk('Testing Live Polls'); await sleep(800)
  await command('deck-design'); await sleep(900)
  assert.notEqual(await page.locator('#deck-title').inputValue(), 'Unsaved title', 'the draft leaked into another talk')
  await world.rcTab('inspector').click(); await sleep(300)
  await world.openTalk(TITLE); await sleep(800)
  await command('deck-design'); await sleep(900)
  assert.equal(await page.locator('#deck-title').inputValue(), saved, 'the draft came back after the talk was left')
  assert.deepEqual(readFileSync(draftTalkFile), draftTalkBefore, 'unsaved transition changed the original saved outline bytes')
  assert.deepEqual(readFileSync(otherTalkFile), otherTalkBefore, 'unsaved transition changed the other saved outline bytes')
  await world.rcTab('inspector').click(); await sleep(300)
})
await check('a draft is never restored over a newer saved value: that field is dropped with a notice that stays; other drafts stay', async () => {
  await command('deck-design'); await sleep(700)
  await page.locator('#deck-title').fill('Draft title B')
  await page.locator('#deck-event').fill('Draft event')
  await world.rcTab('inspector').click(); await sleep(400)
  // the saved title changes in the editor (the Markdown view's Metadata table) while the Talk tab is away
  const title = page.locator('.cm-frontmatter-table input[type=text]').first()
  await title.fill('Title changed in the editor'); await title.press('Enter'); await sleep(900)
  await world.rcTab('talk').click(); await sleep(1200)
  assert.equal(await page.locator('#deck-title').inputValue(), 'Title changed in the editor', 'the old draft masked the newer value')
  assert.equal(await page.locator('#deck-event').inputValue(), 'Draft event', 'the other draft was lost')
  const notice = page.locator('[data-talk-design-embedded] [data-draft-notice]')
  assert.match(await notice.innerText(), /Your unsaved change to Title was discarded because the talk changed\./)
  assert.ok(await page.locator('[data-deck-design-save]').isEnabled(), 'Event is no longer dirty')
  // the notice survives a save of the other panel (Advanced)
  await page.locator('[data-talk-section="advanced"] > summary').click(); await sleep(1500)
  await page.locator('[data-metadata-embedded] input[type=text]').first().fill('saved-by-advanced.pdf')
  await page.locator('[data-metadata-embedded]').getByRole('button', { name: 'Save', exact: true }).click(); await sleep(1500)
  assert.ok(await notice.isVisible(), 'the notice went with the other panel\'s save')
  // and it outlives the panel: an Inspector round-trip leaves it; Dismiss removes it for good
  await world.rcTab('inspector').click(); await sleep(500)
  await world.rcTab('talk').click(); await sleep(1200)
  assert.ok(await notice.isVisible(), 'the notice was lost on an Inspector round-trip')
  await notice.getByRole('button', { name: 'Dismiss' }).click(); await sleep(300)
  assert.equal(await notice.count(), 0, 'Dismiss did not remove the notice')
  await world.rcTab('inspector').click(); await sleep(500)
  await world.rcTab('talk').click(); await sleep(1200)
  assert.equal(await notice.count(), 0, 'a dismissed notice came back')
  await page.locator('[data-talk-section="advanced"] > summary').click(); await sleep(300)
  await world.rcTab('inspector').click(); await sleep(300)
  // put the title back (the Talks list names the talk by it)
  const back = page.locator('.cm-frontmatter-table input[type=text]').first()
  await back.fill(TITLE); await back.press('Enter'); await sleep(3500)
  await command('refresh'); await sleep(2000)
})
await check('the Plain view\'s Talk details line is one line and a link to the Talk tab', async () => {
  await world.rcTab('inspector').click(); await sleep(300)
  await command('view-plain'); await sleep(1500)
  const link = page.locator('[data-talk-details-link]')
  assert.equal(await link.count(), 1)
  assert.equal(await page.locator('.cm-talk-details input, .cm-talk-details select').count(), 0, 'the card still holds fields')
  await link.click(); await sleep(900)
  assert.equal(await talkTab.filter({ visible: true }).count(), 1)
  await command('view-markdown'); await sleep(900)
})
await check('the Markdown view\'s Metadata table has an Edit action that opens the Talk tab', async () => {
  await world.rcTab('inspector').click(); await sleep(300)
  await page.locator('[data-fm-edit-in-tab]').first().click(); await sleep(900)
  assert.equal(await talkTab.filter({ visible: true }).count(), 1)
  await world.rcTab('inspector').click(); await sleep(300)
})

// (the unsaved Advanced field above is left unsaved on purpose; the next test saves the title only)
// ---- R7 -----------------------------------------------------------------------------------------------------------
// The editor's count: the status bar's "43 slides" (the compiled slides: the cover, every section title, every slide, the closing slide).
const statusCount = async () => Number((await page.locator('body').innerText().catch(() => '')).match(/(\d+) slides/)?.[1] ?? NaN)
const outlineRows = async () => {
  await world.sideTab(/Slide outline/).click(); await sleep(700)
  return page.locator('.slides-organizer [data-line]').evaluateAll((els) => els.map((e) => ({
    section: e.classList.contains('so-section'),
    title: (e.querySelector('.so-slide-title, .so-section-label')?.textContent ?? '').trim(),
    no: Number((e.querySelector('.so-slide-no')?.textContent ?? '').trim()),
    sectionNo: e.querySelector('[data-so-section-no]')?.textContent ?? null,
    layout: e.querySelector('[data-so-layout]')?.textContent ?? null
  })))
}
const cardNumbers = (sel) => page.locator(sel).evaluateAll((els) => els.map((e, i) => ({ i, no: Number((e.innerText.split('\n').map((l) => l.trim()).find((l) => /^\d\d$/.test(l)) ?? '').trim()) })))
await check('the outline numbers every slide once, as the strip and the grid do, and sections read §n with a layout mark', async () => {
  const rows = await outlineRows()
  const total = await statusCount()
  assert.ok(rows.length > 10, 'no outline rows')
  // A heading that folds into the slide above it (a carousel's items) is no slide and carries no number; every other row has one,
  // each used once, in order, none past the editor's count.
  const numbered = rows.filter((r) => r.no > 0)
  numbered.forEach((r, k) => { if (k > 0) assert.ok(r.no > numbered[k - 1].no, `"${r.title}" is numbered ${r.no} after ${numbered[k - 1].no}`) })
  assert.ok(numbered.at(-1).no <= total, `the outline reaches ${numbered.at(-1).no}, the status bar counts ${total}`)
  assert.ok(total - numbered.length <= 3 + rows.length - numbered.length, 'slides are missing from the outline')
  assert.equal(numbered[0].no, 1, 'the title is not slide 1')
  assert.equal(rows[0].sectionNo, null, 'the talk title is no section')
  assert.equal(rows[0].layout, 'Title', 'the title row carries the cover\'s layout mark, as the layout picker names it (batch 5, R6)')
  const sections = rows.slice(1).filter((r) => r.section)
  assert.ok(sections.length >= 3, 'no sections')
  const top = sections.filter((r) => r.sectionNo && !r.sectionNo.includes('.'))
  top.forEach((r, k) => assert.equal(r.sectionNo, `§${k + 1}`, `section ${k + 1} reads ${r.sectionNo}`))
  assert.ok(sections.every((r) => r.sectionNo), 'a section has no §n')
  assert.ok(sections.every((r) => r.layout), 'a section has no layout mark')
  assert.ok(rows.filter((r) => !r.section).some((r) => r.layout), 'no slide has a layout mark')
  assert.ok(rows.every((r) => !r.layout || !/^[a-z]+(-[a-z]+)+$/.test(r.layout)), 'a layout mark shows a layout id (section-title, stmt-list, …) instead of its name')
  // the strip and the grid number the same slides the same way
  await command('view-grid'); await sleep(1200)
  const grid = await cardNumbers('[data-slide-index]')
  assert.ok(grid.length > 5, 'no grid cards')
  grid.forEach((g) => assert.equal(g.no, g.i + 1, `grid card ${g.i + 1} reads ${g.no}`))
  await command('view-slides'); await sleep(800)
  await world.rcTab('slides').click(); await sleep(1200)
  const strip = await cardNumbers('.tw-slide-card')
  assert.ok(strip.length > 5, 'no strip cards')
  strip.forEach((g) => assert.equal(g.no, g.i + 1, `strip card ${g.i + 1} reads ${g.no}`))
  // the same layout name on the strip's chip as on the outline's mark
  const chips = await page.locator('.tw-slide-card').evaluateAll((els) => els.map((e) => [...e.querySelectorAll('span')].at(-1)?.textContent ?? ''))
  chips.slice(0, 6).forEach((chip, i) => { if (rows[i].layout && chip) assert.equal(chip, rows[i].layout, `slide ${i + 1}: strip ${chip}, outline ${rows[i].layout}`) })
  await world.rcTab('inspector').click(); await sleep(300)
})
const talkTitles = await page.evaluate(() => 0).then(async () => { await world.sideTab(/^Talks$/).click(); await sleep(500); return page.locator('aside.talk-list [data-talk-title]').evaluateAll((els) => els.map((e) => e.getAttribute('data-talk-title'))) })
// The demo talks (the first six of the list, with the Layout Showcase among them): enough to meet grid returns and carousels.
// (the Talks list names a talk by its front matter title, which the draft tests above changed in the editor; the same talk either way)
const showcase = talkTitles.find((t) => /Layout Showcase|Title changed in the editor/.test(t)) ?? TITLE
for (const title of [...new Set([showcase, ...talkTitles.slice(0, 6)])]) {
  await check(`the presenter counts the editor's slides for "${title}"`, async () => {
    await world.openTalk(title); await sleep(800)
    const total = await statusCount()
    assert.ok(total > 0, 'no count in the status bar')
    await command('present-presenter')
    const pres = await world.presenter()
    assert.ok(pres, 'no presenter window')
    const read = async () => {
      const text = await pres.locator('#presenterCount').innerText().catch(() => '')
      const m = text.match(/^(\d+) \/ (\d+)$/)
      assert.ok(m, `the counter reads "${text}"`)
      return [Number(m[1]), Number(m[2])]
    }
    const seen = [await read()]
    for (let i = 0; i < 12; i += 1) { await pres.keyboard.press('ArrowRight'); await pres.waitForTimeout(100); seen.push(await read()) }
    await pres.keyboard.press('End'); await pres.waitForTimeout(300); seen.push(await read())
    assert.ok(seen.every(([, t]) => t === total), `a total other than the editor's ${total}: ${[...new Set(seen.map((s) => s[1]))]}`)
    assert.ok(seen.every(([n]) => n >= 1 && n <= total), 'a number past the total')
    assert.deepEqual(seen.at(-1), [total, total], 'the last slide is not N / N')
    await world.closeExtraWindows(); await sleep(500)
    await world.sideTab(/^Talks$/).click().catch(() => {})
  })
}
await world.openTalk(showcase)

// ---- R16 ----------------------------------------------------------------------------------------------------------
const editorUp = () => page.locator('.cm-content').first().isVisible().catch(() => false)
const modes = [
  { name: 'Vault Gallery', open: () => command('vault-gallery'), root: '.vault-gallery' },
  { name: 'Slide focus', open: async () => { await world.sideTab(/Slide outline/).click(); await sleep(600); await page.locator('button.so-slide').nth(3).click(); await sleep(1000); await command('focus-slide'); await sleep(800); if (!(await page.locator('.lt-focus').count())) { await page.locator('button.so-slide').nth(4).click(); await sleep(800); await command('focus-slide') } }, root: '.lt-focus' },
  { name: 'Pathways', open: () => command('pathways'), root: '[data-pathway-dock]' },
  { name: 'Slide Browser', open: () => command('search'), root: '.lt-browser-root' }
]
for (const mode of modes) {
  for (const how of ['back control', 'Esc']) {
    await check(`${mode.name}: one "Back to <talk>" control, and the ${how} returns to the talk`, async () => {
      await world.sideTab(/^Talks$/).click().catch(() => {}); await sleep(300)
      await mode.open(); await sleep(1500)
      const root = page.locator(mode.root).first()
      assert.ok(await root.isVisible(), `${mode.name} did not open`)
      const back = page.locator('[data-mode-back]:visible')
      assert.equal(await back.count(), 1, 'not exactly one back control')
      assert.match((await back.first().innerText()).trim(), /^Back to .+/)
      if (how === 'Esc') await page.keyboard.press('Escape'); else await back.first().click()
      await sleep(900)
      assert.equal(await page.locator(mode.root).filter({ visible: true }).count(), 0, `${mode.name} stayed open`)
      assert.ok(await editorUp() || await page.locator('.pane--grid, .tw-slide-card').first().isVisible().catch(() => false), 'the talk is not showing')
      assert.equal(await page.locator('[data-mode-back]:visible').count(), 0)
    })
  }
}

await check('Pathways: Esc leaves even with the pathway selector focused', async () => {
  await world.sideTab(/^Talks$/).click().catch(() => {}); await sleep(300)
  await command('pathways'); await sleep(1500)
  await page.locator('[data-pathway-dock] select').focus()
  await page.keyboard.press('Escape'); await sleep(900)
  assert.equal(await page.locator('[data-pathway-dock]').filter({ visible: true }).count(), 0, 'Pathways stayed open')
})

await world.close()
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)

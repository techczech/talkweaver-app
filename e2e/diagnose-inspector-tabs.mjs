// Real-Electron host gate for the Inspector's section tabs and pinned preview.
// HOST-RUN ONLY, one Electron run at a time: node e2e/diagnose-inspector-tabs.mjs
//
// Dominik's preview.11 check (29 Sep, the statement slide from layout-showcase):
//   1. "make work like true tabs, when I click on an option, the heading of that section should be
//      at the top no matter whether there is scroll space — preserve scrolling". Clicking a section
//      chip puts that section's heading at the top of the options pane, the last section included;
//      the chip for the section at the top is lit as the user scrolls; changing an option keeps
//      the pane where it was; each slide keeps its own scroll position.
//   2. "needs to stay visible as options below change": the slide preview and its Explain button
//      stay in view however far the options below are scrolled.
// "The top of the options pane" is where the options become visible: the top of their scroll
// area, or, when the chip row scrolls inside that area (the old sticky row), the chip row's bottom.
// TW_SHOTS_DIR=<dir> saves a screenshot of the Inspector per state.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { join } from 'path'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const FIXTURE = `---
title: TalkWeaver Layout Showcase
outline_version: 2
---

# TalkWeaver Layout Showcase

## Statements
{id=n2gv5}{accent=cobalt}

### This is an important statement slide
{id=3b2vn}{statement}{font-body=xl}{bg=vermilion}{statement=centred}


### A plain list, with icons
{list}{id=5s8u7}

- Plan the talk before opening the editor
- Draft in markdown, let layouts do the design
- Rehearse with the presenter view
`
const STATEMENT = 'This is an important statement slide'
const LIST = 'A plain list, with icons'
const shotsDir = process.env.TW_SHOTS_DIR || ''
if (shotsDir) mkdirSync(shotsDir, { recursive: true })

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-inspector-tabs-e2e-'))
const vault = join(tempRoot, 'vault')
const ud = join(tempRoot, 'userData')
mkdirSync(ud, { recursive: true })
const dir = join(vault, 'layout-showcase')
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'layout-showcase-outline.md'), FIXTURE)
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))
await ensureFreshBuild(process.cwd())
const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: process.cwd(), env: { ...process.env, TW_E2E: '1' } })
const page = await app.firstWindow()
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 150)))
await page.waitForLoadState('domcontentloaded')
await page.waitForTimeout(2500)
let failures = 0
const rec = (name, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
const setWindow = async (width, height) => {
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setSize(w, h), [width, height])
  await page.waitForTimeout(1200)
}
const shoot = async (name) => {
  if (!shotsDir) return
  await page.locator('.tw-inspector').screenshot({ path: join(shotsDir, `${name}.png`) }).catch(() => {})
}

await setWindow(1512, 945)
await page.locator('.tl-row').first().dblclick()
await page.waitForTimeout(3000)
await page.keyboard.press('Meta+p')
await page.waitForTimeout(1500)

const inspectorTitle = async () => (await page.locator('.tw-inspector-title').textContent() ?? '').trim()
const goTo = async (title) => {
  for (const direction of ['Previous slide', 'Next slide']) {
    for (let step = 0; step < 40 && await inspectorTitle() !== title; step += 1) {
      const button = page.locator(`.tw-inspector-nav button[aria-label="${direction}"]`)
      if (await button.isDisabled()) break
      await button.click()
      await page.waitForTimeout(300)
    }
  }
  await page.waitForTimeout(1800)
  return await inspectorTitle() === title
}

// Everything measured in one pass in the page. `heading` names a section by its chip text.
const geometry = (heading) => page.evaluate((wanted) => {
  const sections = [...document.querySelectorAll('.tw-inspector-section')]
  const headingOf = (section) => section.querySelector('.tw-inspector-section-heading')
  if (!sections.length) return { error: 'no sections' }
  let scroller = sections[0].parentElement
  while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
  if (!scroller) return { error: 'no scroll area' }
  const paneRect = scroller.getBoundingClientRect()
  const jump = document.querySelector('.tw-inspector-jumplist')
  const paneTop = jump && scroller.contains(jump) ? Math.max(paneRect.top, jump.getBoundingClientRect().bottom) : paneRect.top
  const inspector = document.querySelector('.tw-inspector').getBoundingClientRect()
  const hits = (element) => {
    if (!element) return false
    const rect = element.getBoundingClientRect()
    if (rect.top < inspector.top - 0.5 || rect.bottom > paneTop + 0.5 || rect.height === 0) return false
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    const hit = document.elementFromPoint(x, y)
    return !!hit && (hit === element || element.contains(hit) || hit.closest('.tw-inspector-stage') === element)
  }
  const section = wanted ? sections.find((candidate) => headingOf(candidate)?.textContent?.trim() === wanted) : null
  // The section a reader sees at the top: the last whose heading has reached the pane's top.
  let atTop = headingOf(sections[0])?.textContent?.trim() ?? ''
  for (const candidate of sections) {
    if (headingOf(candidate).getBoundingClientRect().top <= paneTop + 2) atTop = headingOf(candidate).textContent.trim()
  }
  return {
    headingOffset: section ? headingOf(section).getBoundingClientRect().top - paneTop : null,
    scrollTop: scroller.scrollTop,
    maxScroll: scroller.scrollHeight - scroller.clientHeight,
    paneTop,
    atTop,
    // How much of the options pane shows inside the Inspector below the pinned head.
    paneShown: Math.min(paneRect.bottom, inspector.bottom) - paneTop,
    lit: document.querySelector('.tw-inspector-jumplist [aria-current="true"]')?.textContent?.trim() ?? '',
    previewInView: hits(document.querySelector('.tw-inspector-stage')),
    explainInView: hits(document.querySelector('.tw-inspector-explain')),
    chips: [...document.querySelectorAll('.tw-inspector-jumplist button')].map((button) => button.textContent.trim())
  }
}, heading ?? null)
const exactly = (text) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
const chip = (label) => page.locator('.tw-inspector-jumplist button').filter({ hasText: new RegExp(`^${label}$`) }).first()
const clickChip = async (label) => {
  await chip(label).click()
  // An old smooth scroll needs time to land; a tab jump is already there.
  await page.waitForTimeout(900)
}
const wheelOptions = async (deltaY) => {
  const { paneTop } = await geometry()
  const box = await page.locator('.tw-inspector').boundingBox()
  await page.mouse.move(box.x + box.width / 2, Math.max(paneTop + 80, box.y + box.height - 60))
  await page.mouse.wheel(0, deltaY)
  await page.waitForTimeout(700)
}

// ── 1. The preview is pinned ──────────────────────────────────────────────────────────────────
rec('Inspector reaches the statement slide', await goTo(STATEMENT), await inspectorTitle())
const start = await geometry()
rec('the statement slide offers several section chips', (start.chips?.length ?? 0) >= 3, JSON.stringify(start.chips))
rec('at rest the preview and Explain are in view', start.previewInView && start.explainInView, JSON.stringify(start))
await shoot('01-statement-at-rest')
await wheelOptions(4000)
{
  const bottom = await geometry()
  rec('scrolled to the bottom of the options, the preview is still in view', bottom.previewInView, `scrollTop ${bottom.scrollTop}`)
  rec('scrolled to the bottom of the options, Explain is still in view', bottom.explainInView, `scrollTop ${bottom.scrollTop}`)
  rec('scrolled to the bottom, the chip for the section at the top is lit', bottom.lit === bottom.atTop, `lit ${bottom.lit}, at top ${bottom.atTop}`)
  await shoot('02-statement-scrolled-to-bottom')
}

// ── 2. Each chip puts its heading at the top of the pane (down the list, then back up) ─────────
const chips = start.chips ?? []
for (const [pass, order] of [['down', chips], ['up', [...chips].reverse()]]) {
  for (const label of order) {
    await clickChip(label)
    const shot = await geometry(label)
    rec(`${pass}: ${label} chip puts the ${label} heading at the top of the pane`,
      shot.headingOffset != null && Math.abs(shot.headingOffset) <= 1, `heading ${shot.headingOffset?.toFixed(1)}px from the top`)
    rec(`${pass}: ${label} chip is lit`, shot.lit === label, shot.lit)
    rec(`${pass}: after ${label}, the preview and Explain are in view`, shot.previewInView && shot.explainInView,
      `preview ${shot.previewInView} explain ${shot.explainInView}`)
    if (pass === 'down') await shoot(`03-chip-${label.toLowerCase().replace(/\W+/g, '-')}`)
  }
}

// ── 3. The lit chip follows the user's own scrolling ──────────────────────────────────────────
if (chips.length >= 2) {
  await clickChip(chips[0])
  const second = await geometry(chips[1])
  await wheelOptions(Math.round(second.headingOffset) + 30)
  const after = await geometry(chips[1])
  rec(`scrolling past the ${chips[1]} heading lights ${chips[1]}`, after.atTop === chips[1] && after.lit === chips[1], `at top ${after.atTop}, lit ${after.lit}`)
  await wheelOptions(-(Math.round(second.headingOffset) + 30))
  const back = await geometry(chips[0])
  rec(`scrolling back up lights ${chips[0]}`, back.lit === chips[0], `lit ${back.lit}`)
}

// ── 4. Changing an option keeps the scroll position ───────────────────────────────────────────
// For each section: its chip, a nudge down into it, then an unpressed option visible in the pane.
for (const label of chips) {
  await clickChip(label)
  await wheelOptions(40)
  const target = await page.evaluate((wanted) => {
    const section = [...document.querySelectorAll('.tw-inspector-section')]
      .find((candidate) => candidate.querySelector('.tw-inspector-section-heading')?.textContent?.trim() === wanted)
    let scroller = section?.parentElement
    while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
    if (!section || !scroller) return null
    const pane = scroller.getBoundingClientRect()
    const jump = document.querySelector('.tw-inspector-jumplist')
    const top = scroller.contains(jump) ? Math.max(pane.top, jump.getBoundingClientRect().bottom) : pane.top
    for (const group of section.querySelectorAll('.tw-inspector-group')) {
      for (const button of group.querySelectorAll('[role="group"] button[aria-pressed="false"]')) {
        const rect = button.getBoundingClientRect()
        if (rect.top > top + 4 && rect.bottom < pane.bottom - 4) {
          const pressed = group.querySelector('[role="group"] button[aria-pressed="true"]')
          return { group: group.dataset.group, text: button.textContent.trim(), top: rect.top, restore: pressed?.textContent?.trim() ?? '' }
        }
      }
    }
    return null
  }, label)
  if (!target) { rec(`${label}: an option is visible to change`, false, 'none in view'); continue }
  const before = await geometry(label)
  const button = page.locator(`.tw-inspector-group[data-group="${target.group}"] [role="group"] button`).filter({ hasText: exactly(target.text) }).first()
  await button.click()
  await page.waitForTimeout(2800)
  const after = await geometry(label)
  const buttonTop = await button.evaluate((element) => element.getBoundingClientRect().top).catch(() => null)
  rec(`${label}: choosing ${target.group}=${target.text} keeps the ${label} heading where it was`,
    before.headingOffset != null && after.headingOffset != null && Math.abs(after.headingOffset - before.headingOffset) <= 2,
    `${before.headingOffset?.toFixed(1)} → ${after.headingOffset?.toFixed(1)}; scrollTop ${before.scrollTop} → ${after.scrollTop}`)
  rec(`${label}: the chosen option stays under the pointer`, buttonTop != null && Math.abs(buttonTop - target.top) <= 2, `${target.top} → ${buttonTop}`)
  rec(`${label}: after the change the preview and Explain are in view`, after.previewInView && after.explainInView)
  rec(`${label}: after the change ${label} stays lit`, after.lit === label, after.lit)
  await shoot(`04-option-change-${label.toLowerCase().replace(/\W+/g, '-')}`)
  // Put the option back so the next section starts from the authored slide.
  if (target.restore) {
    await page.locator(`.tw-inspector-group[data-group="${target.group}"] [role="group"] button`).filter({ hasText: exactly(target.restore) }).first().click()
    await page.waitForTimeout(2200)
  }
}

// ── 5. Each slide keeps its own scroll position ───────────────────────────────────────────────
{
  const remembered = chips.at(-1)
  await goTo(STATEMENT)
  await clickChip(remembered)
  const here = await geometry(remembered)
  rec(`Inspector reaches the list slide`, await goTo(LIST), await inspectorTitle())
  const list = await geometry()
  await clickChip(list.chips[0])
  await shoot('05-list-slide')
  rec('Inspector returns to the statement slide', await goTo(STATEMENT), await inspectorTitle())
  const back = await geometry(remembered)
  rec(`back on the statement slide, ${remembered} is at the top where it was left`,
    back.headingOffset != null && Math.abs(back.headingOffset - here.headingOffset) <= 2 && back.lit === remembered,
    `${here.headingOffset?.toFixed(1)} → ${back.headingOffset?.toFixed(1)}, lit ${back.lit}`)
}

// ── 6. A smaller window: the last chip still reaches the top, the preview stays ───────────────
await setWindow(1280, 800)
await goTo(STATEMENT)
for (const label of [chips.at(-1), chips[0]]) {
  await clickChip(label)
  const shot = await geometry(label)
  rec(`1280x800: ${label} heading at the top`, shot.headingOffset != null && Math.abs(shot.headingOffset) <= 1, `${shot.headingOffset?.toFixed(1)}px`)
  rec(`1280x800: after ${label}, the preview and Explain are in view`, shot.previewInView && shot.explainInView)
}
await shoot('06-small-window-first-chip')

// ── 7. Slides-only view (⌘3): the Inspector runs the full window width ───────────────────────
await setWindow(1512, 945)
await page.keyboard.press('Meta+3')
await page.waitForTimeout(1500)
await goTo(STATEMENT)
for (const label of chips) {
  await clickChip(label)
  const shot = await geometry(label)
  rec(`slides-only: ${label} heading at the top`, shot.headingOffset != null && Math.abs(shot.headingOffset) <= 1, `${shot.headingOffset?.toFixed(1)}px`)
  rec(`slides-only: after ${label}, the preview and Explain are in view`, shot.previewInView && shot.explainInView)
  rec(`slides-only: after ${label}, the options pane shows at least 240px`, shot.paneShown >= 240, `${Math.round(shot.paneShown)}px`)
}
await shoot('07-slides-only-last-chip')

await app.close()
if (failures) {
  console.log(`\n=== inspector tabs: ${failures} FAILED ===`)
  process.exit(1)
}
console.log('\n=== inspector tabs: all checks passed ===')

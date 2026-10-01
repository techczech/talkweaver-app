// Real-Electron gate for layout-picker ticket 05: the Inspector's layout options as pictures of the
// author's own slide (ADR-0032 §1/§7, journey 3). HOST-RUN ONLY, hidden (TW_E2E=1), one Electron run at a time:
//   node e2e/diagnose-inspector-option-pictures.mjs      (TW_SHOTS_DIR=<dir> saves the Inspector)
//
// On a throwaway vault, in the built app, on a Cards slide:
//   1. the Cards section shows Form as pictures (Adaptive, Grid, Rows, Stepped), Adaptive lit, and
//      each picture is an image of the slide (a twthumb: URL) once rendered;
//   2. clicking Rows writes {cards=rows} to the slide's Trigger line on disk, the caret stays in the
//      editor (the click does not move focus into a form control that steals typing), and Rows is lit;
//   3. "Change ⌘L" in the layout section opens the layout picker;
//   4. a slide with another layout (a statement) keeps its buttons: no pictures.
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './lib/ensure-fresh-build.mjs'
import { join } from 'path'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

const outline = `---
title: Option pictures in the Inspector
outline_version: 2
auto_title_slide: false
auto_thanks_slide: false
---

### Five things you can do with Codex
{id=codex} {cards}

- Catalogue and organise data
- Manage projects and keep notes
- Create tools, websites, and dissemination outputs
- Run experiments and keep records and notes
- Set up and control your computer

### One thing to remember
{id=quote} {statement}

Keep the pictures honest.
`
const CARDS = 'Five things you can do with Codex'
const STATEMENT = 'One thing to remember'
const shotsDir = process.env.TW_SHOTS_DIR || ''
if (shotsDir) mkdirSync(shotsDir, { recursive: true })

const tempRoot = mkdtempSync(join(tmpdir(), 'tw-inspector-pictures-e2e-'))
const vault = join(tempRoot, 'vault')
const ud = join(tempRoot, 'userData')
mkdirSync(ud, { recursive: true })
const dir = join(vault, 'pictures')
mkdirSync(dir, { recursive: true })
const outlinePath = join(dir, 'pictures-outline.md')
writeFileSync(outlinePath, outline)
writeFileSync(join(ud, 'config.json'), JSON.stringify({ vaultRoot: vault }, null, 2))
await ensureFreshBuild(process.cwd())
const app = await electron.launch({ args: ['.', '--user-data-dir=' + ud], cwd: process.cwd(), env: { ...process.env, TW_E2E: '1' } })
let failures = 0
const rec = (name, ok, detail) => {
  if (!ok) failures += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}
try {
  const page = await app.firstWindow()
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 150)))
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2500)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900))
  await page.waitForTimeout(1000)
  await page.locator('.tl-row').first().dblclick()
  await page.waitForTimeout(3000)
  await page.keyboard.press('Meta+p')
  await page.waitForTimeout(1500)

  const inspectorTitle = async () => (await page.locator('.tw-inspector-title').textContent() ?? '').trim()
  const goTo = async (title) => {
    for (const direction of ['Previous slide', 'Next slide']) {
      for (let step = 0; step < 20 && await inspectorTitle() !== title; step += 1) {
        const button = page.locator(`.tw-inspector-nav button[aria-label="${direction}"]`)
        if (await button.isDisabled()) break
        await button.click()
        await page.waitForTimeout(300)
      }
    }
    await page.waitForTimeout(1200)
    return await inspectorTitle() === title
  }
  const formGroup = page.locator('.tw-inspector-group[data-group="form"]')
  const triggerOnDisk = () => readFileSync(outlinePath, 'utf8').split('\n').find((line) => line.includes('{id=codex}')) ?? ''
  const waitForTrigger = async (re) => {
    for (let i = 0; i < 40; i += 1) { if (re.test(triggerOnDisk())) return true; await page.waitForTimeout(250) }
    return false
  }
  const shoot = async (name) => { if (shotsDir) await page.screenshot({ path: join(shotsDir, `${name}.png`) }).catch(() => {}) }

  rec('the Inspector reaches the Cards slide', await goTo(CARDS), await inspectorTitle())
  const labels = await formGroup.locator('.opt-pic > span:last-child').allTextContents()
  rec('Form is four pictures: Adaptive, Grid, Rows, Stepped', labels.join() === 'Adaptive,Grid,Rows,Stepped', labels.join())
  rec('Adaptive is the lit picture', (await formGroup.locator('.opt-pic.is-selected').textContent())?.trim() === 'Adaptive')
  // Pictures arrive from the renderer; allow a cold render.
  let images = 0
  for (let i = 0; i < 60 && images < 4; i += 1) { images = await formGroup.locator('.opt-pic img').count(); if (images < 4) await page.waitForTimeout(500) }
  const srcs = await formGroup.locator('.opt-pic img').evaluateAll((list) => list.map((img) => img.getAttribute('src') ?? ''))
  rec('each option is a picture of the slide (twthumb: image)', images === 4 && srcs.every((src) => src.startsWith('twthumb:')), srcs.join(' '))
  // Every Form picture shows the WHOLE slide at the same framing, so the slide's title is drawn in the same place in
  // each: the title band (top of the frame, left 60%) is reduced to a dark-pixel grid and compared with Adaptive's.
  // A picture cropped to the middle of the slide, or scaled differently, has a different title band.
  const bands = await formGroup.locator('.opt-pic img').evaluateAll(async (list) => Promise.all(list.map(async (img) => {
    await img.decode().catch(() => {})
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight
    const context = canvas.getContext('2d')
    context.drawImage(img, 0, 0)
    const cols = 48; const rowsN = 8
    const x0 = 0; const y0 = Math.round(canvas.height * 0.06)
    const w = Math.round(canvas.width * 0.6); const h = Math.round(canvas.height * 0.16)
    const data = context.getImageData(x0, y0, w, h).data
    const grid = []
    for (let gy = 0; gy < rowsN; gy += 1) for (let gx = 0; gx < cols; gx += 1) {
      let dark = 0; let total = 0
      for (let y = Math.floor(gy * h / rowsN); y < Math.floor((gy + 1) * h / rowsN); y += 2) for (let x = Math.floor(gx * w / cols); x < Math.floor((gx + 1) * w / cols); x += 2) {
        const at = (y * w + x) * 4
        total += 1
        if (data[at] < 110 && data[at + 1] < 110 && data[at + 2] < 140) dark += 1
      }
      grid.push(total && dark / total > 0.15 ? 1 : 0)
    }
    return { name: img.closest('.opt-pic')?.textContent?.trim(), grid, size: `${img.naturalWidth}x${img.naturalHeight}` }
  })))
  const overlap = (a, b) => { let both = 0; let either = 0; a.forEach((v, i) => { if (v || b[i]) either += 1; if (v && b[i]) both += 1 }); return either ? both / either : 0 }
  const scores = bands.map((band) => ({ name: band.name, ink: band.grid.filter(Boolean).length, same: Number(overlap(band.grid, bands[0].grid).toFixed(2)), size: band.size }))
  rec('each Form picture shows the slide title where Adaptive does (same framing, whole slide)', bands.length === 4 && scores.every((score) => score.ink >= 8 && score.same >= 0.7) && new Set(scores.map((score) => score.size)).size === 1, JSON.stringify(scores))
  rec('Icons, Title placement and Body size are pictures too', await page.locator('[data-option-pictures="cards-icons"], [data-option-pictures="title-placement"], [data-option-pictures="font-body"]').count() === 3)
  await shoot('option-pictures-cards-1440x900')

  // Click Rows: the trigger line gains {cards=rows}; the editor keeps the caret.
  // Put the caret in the editor first (a body line of this slide), so "stays" means something.
  await page.locator('.cm-content .cm-line', { hasText: 'Manage projects and keep notes' }).first().click()
  await page.waitForTimeout(600)
  rec('the caret starts in the editor, on the Cards slide', await page.evaluate(() => !!document.activeElement?.closest('.cm-editor')) && await inspectorTitle() === CARDS)
  const caretText = () => page.evaluate(() => {
    const node = window.getSelection()?.anchorNode
    const line = (node instanceof Element ? node : node?.parentElement)?.closest('.cm-line')
    return line ? `${line.textContent}@${window.getSelection().anchorOffset}` : ''
  })
  const caretBefore = await caretText()
  await formGroup.locator('.opt-pic').filter({ hasText: 'Rows' }).click()
  rec('clicking Rows writes {cards=rows} to the Trigger line', await waitForTrigger(/\{cards=rows\}/), triggerOnDisk())
  await page.waitForTimeout(1200)
  rec('Rows is lit', (await formGroup.locator('.opt-pic.is-selected').textContent())?.trim() === 'Rows')
  const focusInEditor = await page.evaluate(() => !!document.activeElement?.closest('.cm-editor'))
  rec('the cursor stays in the editor', focusInEditor, await page.evaluate(() => `${document.activeElement?.tagName}.${document.activeElement?.className ?? ''}`))
  rec('the caret is at the same place in the same line', caretBefore !== '' && await caretText() === caretBefore, `${caretBefore} -> ${await caretText()}`)
  // Typing after the click lands in the editor, not in the Inspector.
  await page.keyboard.type('Z')
  await page.waitForTimeout(300)
  rec('typing after the click goes into the outline', (await page.locator('.cm-content').textContent() ?? '').includes('Z'))
  await page.keyboard.press('Backspace')
  await page.waitForTimeout(300)
  // Keyboard activation of a picture keeps focus in the Inspector (←→ and Tab carry on from it).
  await formGroup.locator('.opt-pic').filter({ hasText: 'Adaptive' }).focus()
  await page.keyboard.press('Space')
  rec('Space on Adaptive takes {cards=rows} off again', await waitForTrigger(/^\{id=codex\} ?\{cards\}$/), triggerOnDisk())
  rec('Space keeps focus on the pictures (keyboard use stays in the Inspector)', await page.evaluate(() => !!document.activeElement?.closest('.opt-pics')))

  // Change ⌘L opens the picker.
  await page.locator('button.tw-inspector-change[data-open-picker]').first().click()
  await page.waitForTimeout(800)
  rec('Change ⌘L opens the layout picker', await page.locator('[role="listbox"]').count() > 0)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)

  // Another layout keeps its buttons.
  rec('the statement slide is reachable', await goTo(STATEMENT))
  rec('a statement keeps its buttons: no option pictures', await page.locator('.opt-pics').count() === 0)
} finally {
  await app.close().catch(() => {})
  rmSync(tempRoot, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`${failures} failure(s)`)
  process.exit(1)
}
console.log('inspector option pictures e2e: Cards options are pictures of the slide; a click writes one token; Change opens the picker; other layouts keep buttons')

// =============================================================================
// test:icon-row-process-connectors — 0.41 ticket 06 (ADR-0039: connectors start and end on the borders of
// the boxes they join; arrowheads are whole)
//
// What must hold, measured in Chromium on the 1280 x 720 stage at two window sizes (rects are divided by the
// stage scale, so a pixel is a canvas pixel):
//   1. Icon row: every chain link runs from the outer bottom border of its box to the outer top border of the
//      next box in the same column (both ends within 1 px), inside the box's width.
//   2. Icon row: boxes share rows across columns, so a box that wraps keeps its neighbour level (equal tops
//      and equal bottoms in each row).
//   3. Process: every arrow's left end lies on the right border of the box before it and its right end on the
//      left border of the box after it (within 1 px), its centre line is inside both boxes, and the arrowhead
//      is whole (the svg lies inside the arrow's box and is not clipped).
//   4. Steps (stairs): the same for each arrow between two stairs.
//   5. Process with screenshots: the pictures stay, and both pictures and boxes sit inside the stage.
// =============================================================================

import { strict as assert } from 'node:assert'
import { copyFileSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(tmpdir(), 'tw-connectors-'))
copyFileSync(join(repo, 'scripts/fixtures/layout/sample-image.png'), join(dir, 'step.png'))

const SOURCE = [
  '---', 'title: Connectors', '---', '# Deck', '## Section', '',
  '### Two columns', '{iconrow}', '',
  '- Harness {icon=lucide:folder-code}',
  '  - sends prompts to model',
  '  - receives messages from model',
  '  - parses commands and sends them on to the computer, then waits for what comes back',
  '  - sends command results to model',
  '- Model {icon=lucide:brain-circuit}',
  '  - interprets intent',
  '  - makes plans and considers options',
  '  - writes command for harness to run',
  '  - interprets command results', '',
  '### Three uneven columns', '{iconrow}', '',
  '- Language model {icon=lucide:brain}', '  - outputs tokens', '  - rich knowledge and judgement', '  - limited precision',
  '- Orchestration {icon=lucide:computer}', '  - parses tokens and runs them', '  - absolute logic',
  '- Memory', '  - short', '  - long', '  - episodic', '',
  '### Four steps', '{process}', '',
  '- Folder with files', '- Rename the files', '- Make a webpage', '- Upload it to the website', '',
  '### Five steps with detail', '{process}', '',
  '- Capture · 10 min', '- Outline', '  - detail one', '- Design', '- Rehearse', '- Deliver', '',
  '### Steps with pictures', '{process}', '',
  '- Folder with files', '- Rename the files', '- Make a webpage', '',
  '![first](step.png)', '![second](step.png)', '![third](step.png)', '',
  '### One picture', '{process}', '',
  '- Folder with files', '- Rename the files', '- Make a webpage', '',
  '![only](step.png)', '',
  '### Stairs', '{steps}', '',
  '- Follow recipes', '- Adapt recipes', '- Write recipes', '- Forget recipes', ''
].join('\n')

const path = join(dir, 'connectors.md')
writeFileSync(path, SOURCE, 'utf8')
const model = await prepareSource(path, SOURCE, 'connectors', statSync(path), undefined, { allowedAssetRoots: [dir] })
const deckPath = join(dir, 'connectors.html')
writeFileSync(deckPath, model.fullHtml, 'utf8')

const TOL = 1
let checks = 0
function check(condition, label) {
  checks += 1
  assert.ok(condition, label)
}
const near = (a, b) => Math.abs(a - b) <= TOL

const browser = await chromium.launch({ headless: true })
try {
  for (const viewport of [{ width: 1600, height: 900 }, { width: 1280, height: 720 }]) {
    const page = await browser.newPage({ viewport })
    await page.goto(`file://${deckPath}`, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    const slides = await page.evaluate(() => [...document.querySelectorAll('.stage > .slide')].map((node) => node.dataset.navTitle))
    const measure = async (title) => {
      await page.evaluate((name) => {
        document.querySelectorAll('.stage > .slide').forEach((node) => node.classList.toggle('active', node.dataset.navTitle === name))
      }, title)
      await page.waitForTimeout(250)
      return page.evaluate((name) => {
        const stageEl = document.querySelector('.stage')
        const sr = stageEl.getBoundingClientRect()
        const k = sr.width / stageEl.offsetWidth
        const C = (el) => {
          const r = el.getBoundingClientRect()
          return { left: (r.left - sr.left) / k, right: (r.right - sr.left) / k, top: (r.top - sr.top) / k, bottom: (r.bottom - sr.top) / k }
        }
        const slide = [...document.querySelectorAll('.stage > .slide')].find((node) => node.dataset.navTitle === name)
        const out = { stage: { width: stageEl.offsetWidth, height: stageEl.offsetHeight } }
        out.columns = [...slide.querySelectorAll('.icon-row > .ir-item')].map((item) => ({
          boxes: [...item.querySelectorAll('.ir-desc > li')].map((li) => ({
            rect: C(li),
            link: li.querySelector(':scope > .ir-link') ? C(li.querySelector(':scope > .ir-link')) : null
          }))
        }))
        const seq = (container, boxSel, arrowSel) => {
          if (!container) return null
          return [...container.children].filter((el) => el.matches(`${boxSel}, ${arrowSel}`)).map((el) => ({
            kind: el.matches(arrowSel) ? 'arrow' : 'box',
            rect: C(el),
            svg: el.matches(arrowSel) ? C(el.querySelector('svg')) : null,
            svgOverflow: el.matches(arrowSel) ? getComputedStyle(el.querySelector('svg')).overflow : null,
            clipped: el.matches(arrowSel) ? getComputedStyle(el).overflow : null
          }))
        }
        out.process = seq(slide.querySelector('.process-strip'), '.proc-step', '.proc-arrow')
        out.steps = seq(slide.querySelector('.steps-diagram'), '.step-col', '.step-arrow')
        out.images = [...slide.querySelectorAll('img')].map((img) => ({ ...C(img), shown: img.getBoundingClientRect().width > 4 }))
        return out
      }, title)
    }

    // 1 and 2: icon rows
    for (const title of ['Two columns', 'Three uneven columns']) {
      const m = await measure(title)
      assert.ok(m.columns.length >= 2, `${title}: columns render`)
      for (const [c, col] of m.columns.entries()) {
        for (let b = 0; b < col.boxes.length; b++) {
          const box = col.boxes[b]
          if (b < col.boxes.length - 1) {
            const next = col.boxes[b + 1]
            check(box.link, `${title} @${viewport.width}: column ${c} box ${b} carries a link`)
            check(near(box.link.top, box.rect.bottom), `${title} @${viewport.width}: link ${c}.${b} starts on the box's bottom border (${box.link.top.toFixed(2)} vs ${box.rect.bottom.toFixed(2)})`)
            check(near(box.link.bottom, next.rect.top), `${title} @${viewport.width}: link ${c}.${b} ends on the next box's top border (${box.link.bottom.toFixed(2)} vs ${next.rect.top.toFixed(2)})`)
            check(box.link.left >= box.rect.left && box.link.right <= box.rect.right, `${title} @${viewport.width}: link ${c}.${b} sits inside the box width`)
          } else {
            check(!box.link, `${title} @${viewport.width}: the last box of column ${c} has no link`)
          }
        }
      }
      const rows = Math.max(...m.columns.map((col) => col.boxes.length))
      for (let r = 0; r < rows; r++) {
        const level = m.columns.map((col) => col.boxes[r]).filter(Boolean)
        for (const box of level) {
          check(near(box.rect.top, level[0].rect.top) && near(box.rect.bottom, level[0].rect.bottom), `${title} @${viewport.width}: row ${r} is level across columns`)
        }
      }
    }

    // 3 and 4: process and steps
    const arrowsOf = (seq, label) => {
      assert.ok(seq && seq.length >= 3, `${label}: boxes and arrows render`)
      let arrows = 0
      seq.forEach((item, i) => {
        if (item.kind !== 'arrow') return
        arrows += 1
        const before = seq[i - 1]
        const after = seq[i + 1]
        check(before?.kind === 'box' && after?.kind === 'box', `${label}: arrow ${arrows} sits between two boxes`)
        check(near(item.rect.left, before.rect.right), `${label}: arrow ${arrows} starts on the box before it (${item.rect.left.toFixed(2)} vs ${before.rect.right.toFixed(2)})`)
        check(near(item.rect.right, after.rect.left), `${label}: arrow ${arrows} ends on the box after it (${item.rect.right.toFixed(2)} vs ${after.rect.left.toFixed(2)})`)
        const mid = (item.rect.top + item.rect.bottom) / 2
        check(mid >= before.rect.top - TOL && mid <= before.rect.bottom + TOL && mid >= after.rect.top - TOL && mid <= after.rect.bottom + TOL, `${label}: arrow ${arrows} centre line lies inside both boxes`)
        check(item.svg.left >= item.rect.left - TOL && item.svg.right <= item.rect.right + TOL, `${label}: arrow ${arrows} head is whole (svg inside its box)`)
        check(near(item.svg.right, item.rect.right), `${label}: arrow ${arrows} head tip is on the box border`)
        check(item.svgOverflow === 'visible', `${label}: arrow ${arrows} svg is not clipped`)
      })
      assert.equal(arrows, seq.filter((item) => item.kind === 'box').length - 1, `${label}: one arrow between each pair of boxes`)
    }
    for (const title of ['Four steps', 'Five steps with detail', 'Steps with pictures', 'One picture']) {
      arrowsOf((await measure(title)).process, `${title} @${viewport.width}`)
    }
    arrowsOf((await measure('Stairs')).steps, `Stairs @${viewport.width}`)

    // 5: screenshots stay and everything fits the stage
    for (const [title, count] of [['Steps with pictures', 3], ['One picture', 1]]) {
      const m = await measure(title)
      const pictures = m.images.filter((img) => img.shown)
      assert.equal(pictures.length, count, `${title} @${viewport.width}: ${count} screenshot(s) shown`)
      for (const picture of pictures) check(picture.top >= -TOL && picture.bottom <= m.stage.height + TOL, `${title} @${viewport.width}: screenshot inside the stage`)
      const last = m.process.filter((item) => item.kind === 'box').at(-1)
      check(last.rect.bottom <= m.stage.height + TOL, `${title} @${viewport.width}: the steps sit inside the stage (bottom ${last.rect.bottom.toFixed(1)} of ${m.stage.height})`)
      check(pictures.every((picture) => picture.bottom <= m.process.find((item) => item.kind === 'box').rect.top + TOL), `${title} @${viewport.width}: the pictures sit above the steps`)
    }
    await page.close()
  }
} finally {
  await browser.close()
}
console.log(`PASS icon-row-process-connectors: ${checks} measurements, every connector end on a box border (within ${TOL}px)`)

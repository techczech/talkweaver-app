// =============================================================================
// test:visfix-look — four visual defects the 0.37 integration survey found (slide round 2, ADR-0033).
//
//   1. A rail timeline of five stops at body size overflows the band and its last stops fall off the
//      slide. It must fit by stepping its type down toward the readable floor (ADR-0033 §1, never
//      below 1.9375cqw = 37.2px at 1920) through the shared list-fit ladder. If it cannot fit at
//      the floor the slide is marked too-long instead of clipping silently.
//   2. A cycle diagram in a sidebar slide: every node stays inside the content column and slide,
//      and no node squeezes its words into a one-word-per-line stack.
//   3. Three icon columns beside a rail are narrower than 22cqw: they reshape (ADR-0033 §5) so no
//      label is cut at the right edge.
//   4. A wrapped rail title keeps the rail's inner padding: its text never reaches into the right
//      padding of the rail head.
//
// Reads rects in Chromium at 1920x1080 after the runtime fit pass (window.__autofitForTest).
// =============================================================================

import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const dir = mkdtempSync(join(tmpdir(), 'tw-visfix-look-'))
const source = [
  '---', 'title: Visfix probe', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '## Specimens', '',
  '### The ChatGPT timeline — rail', '{id=vf-rail}{timeline=rail}', '',
  '- 30 Nov 2022', '  - ChatGPT is released as a research preview',
  '- 7 Dec 2022', '  - 1 million people have used it — faster than any consumer product before',
  '- 2023–2024', '  - Hundreds of millions use it to code, write, translate, learn and cheat',
  '- Sept 2025', '  - 1 billion people use ChatGPT every week',
  '- 2026', '  - AI agents happen', '',
  '### What makes something an agent?', '{id=vf-cycle}{cycle} {sidebar}', '',
  '- Task spec by you', '- Plan by LLM', '- Tool use by LLM', '- Revision based on output from computer', '',
  '### Three ways of considering the nature of AI', '{id=vf-iconrow}{iconrow} {sidebar}', '',
  '- **Physical**  {icon=lucide:computer}', '  - how it operates',
  '- **Phenomenal**  {icon=lucide:brain-circuit}', '  - what it does in the world',
  '- **Epiphenomenal**  {icon=lucide:shield-question-mark}', '  - what we think its existence means', '',
  '### Statement default variant — panel in the section colour', '{id=vf-statement}{statement=default}', '',
  'The default statement sits on a panel in the section\'s sidebar colour.', ''
].join('\n')
const path = join(dir, 'visfix.md')
writeFileSync(path, source, 'utf8')
const model = await prepareSource(path, source, 'Visfix probe', statSync(path))
const htmlPath = join(dir, 'visfix.html')
writeFileSync(htmlPath, model.fullHtml, 'utf8')

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  await page.goto(`file://${htmlPath}`, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts?.ready)
  const probe = (id) => page.evaluate((slideId) => {
    const slides = [...document.querySelectorAll('.stage > .slide')]
    const slide = slides.find((node) => node.dataset.id === slideId)
    slides.forEach((node) => node.classList.toggle('active', node === slide))
    window.__autofitForTest?.()
    const sr = slide.getBoundingClientRect()
    const rel = (el) => { const r = el.getBoundingClientRect(); return { left: r.left - sr.left, right: r.right - sr.left, top: r.top - sr.top, bottom: r.bottom - sr.top, width: r.width, height: r.height } }
    const content = slide.querySelector(':scope > .slide-content')
    const stageScale = slide.parentElement.getBoundingClientRect().width / slide.parentElement.offsetWidth
    const out = { slide: { width: sr.width, height: sr.height }, textFit: content.dataset.textFit || '', zoom: Number(content.style.zoom || 1) }
    const tl = slide.querySelector('.timeline-rail')
    if (tl) {
      out.timeline = { rect: rel(tl), entries: [...tl.querySelectorAll('.tl-entries > li')].map((li) => ({ rect: rel(li), size: parseFloat(getComputedStyle(li).fontSize) * stageScale })) }
    }
    const nodes = [...slide.querySelectorAll('.cycle-node')]
    if (nodes.length) {
      out.cycle = { content: rel(content), nodes: nodes.map((n) => {
        const range = document.createRange(); range.selectNodeContents(n.querySelector('.cycle-stage'))
        const lines = new Set([...range.getClientRects()].filter((r) => r.width > 1).map((r) => Math.round(r.top / 6))).size
        return { text: n.textContent.trim(), rect: rel(n), lines }
      }) }
    }
    const items = [...slide.querySelectorAll('.icon-row .ir-item')]
    if (items.length) {
      out.iconrow = items.map((item) => {
        const label = item.querySelector('.ir-label')
        const lr = rel(label)
        const range = document.createRange(); range.selectNodeContents(label)
        const textRight = Math.max(...[...range.getClientRects()].map((r) => r.right - sr.left))
        return { text: label.textContent.trim(), labelRight: lr.right, textRight, itemRight: rel(item).right, box: rel(item) }
      })
      out.iconrowClass = slide.querySelector('.icon-row').className
    }
    const head = slide.querySelector(':scope > .slide-content > .slide-head')
    const h1 = head && head.querySelector('h1:not(.sr-only)')
    if (h1 && slide.dataset.titleLayout === 'left') {
      const range = document.createRange(); range.selectNodeContents(h1)
      const textRight = Math.max(...[...range.getClientRects()].filter((r) => r.width > 1).map((r) => r.right - sr.left))
      const hs = getComputedStyle(head)
      out.rail = { textRight, headRight: rel(head).right, padRight: parseFloat(hs.paddingRight) * stageScale, padLeft: parseFloat(hs.paddingLeft) * stageScale, textLeft: Math.min(...[...range.getClientRects()].filter((r) => r.width > 1).map((r) => r.left - sr.left)) }
    }
    return out
  }, id)

  const FLOOR = 1920 * 0.019375
  const failures = []
  const section = async (name, fn) => { try { await fn(); console.log(`PASS ${name}`) } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`) } }
  // 1. Rail timeline fits at 1920 without falling off, type stepped no lower than the floor.
  await section('rail timeline fits at body size stepped down toward the floor', async () => {
  const rail = await probe('vf-rail')
  const bottom = rail.timeline.entries[rail.timeline.entries.length - 1].rect.bottom
  assert(bottom <= rail.slide.height - 60, `rail timeline: the last stop ends inside the slide band (bottom ${bottom.toFixed(0)} of ${rail.slide.height})`)
  assert(rail.zoom === 1 && rail.textFit === '', `rail timeline: fits without whole-slide zoom (zoom ${rail.zoom}, fit "${rail.textFit}")`)
  for (const entry of rail.timeline.entries) assert(entry.size >= FLOOR - 0.2, `rail timeline: entries stay at or above the ${FLOOR.toFixed(1)}px floor (got ${entry.size.toFixed(1)})`)
  })

  // 2. Cycle in a sidebar slide.
  await section('cycle nodes stay on the slide', async () => {
  const cycle = await probe('vf-cycle')
  for (const node of cycle.cycle.nodes) {
    assert(node.rect.right <= cycle.slide.width - 20, `cycle: "${node.text}" stays inside the slide (right ${node.rect.right.toFixed(0)} of ${cycle.slide.width})`)
    assert(node.rect.left >= cycle.cycle.content.left, `cycle: "${node.text}" stays right of the rail`)
    assert(node.lines <= 2, `cycle: "${node.text}" is not stacked word per line (${node.lines} lines)`)
  }
  })

  // 3. Three icon columns beside a rail reshape and no label is cut.
  await section('icon row beside a rail reshapes', async () => {
  const row = await probe('vf-iconrow')
  assert(/ir-rows/.test(row.iconrowClass), `icon row: three columns beside a rail reshape (class "${row.iconrowClass}")`)
  for (const item of row.iconrow) {
    assert(item.textRight <= item.itemRight + 1, `icon row: "${item.text}" is not cut at its column edge`)
    assert(item.textRight <= row.slide.width - 40, `icon row: "${item.text}" is not cut at the slide edge (${item.textRight.toFixed(0)})`)
  }
  })

  // 4. Rail title keeps the rail's inner padding.
  await section('rail title keeps the rail padding', async () => {
  const st = await probe('vf-statement')
  assert(st.rail.textRight <= st.rail.headRight - st.rail.padRight + 1, `rail title: text right ${st.rail.textRight.toFixed(0)} stays inside the rail's inner padding (${(st.rail.headRight - st.rail.padRight).toFixed(0)})`)
  })
  assert.equal(failures.length, 0, `visfix look failed: ${failures.join('; ')}`)
} finally {
  await browser.close()
}
console.log('visfix look: all checks passed')

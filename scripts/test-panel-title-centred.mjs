// =============================================================================
// test:panel-title-centred — the title in the left panel is vertically centred on the slide, always
// (slide redesign ticket 1, 13 Oct 2026). Read from a real compiled deck in the real deck runtime at
// 1920x1080. Two causes had put it off centre: the panel head spanned only the first body item (a
// second body child lands on a later grid row), and the statement layout's bottom margin on the
// panel title counted as part of the title. On every slide with a painted left panel the title block
// (kicker + h1) must sit within 2px of the slide's vertical centre; a single-item body must not move
// when the head leaves the grid, and a head-only slide keeps its single column.
// =============================================================================
import assert from 'node:assert/strict'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const SLIDES = {
  'one-para': ['Agent definition', '{statement}', ['An agent is a model that decides what to do next.']],
  'two-para': ['Common Ground', '{statement}', ['First sentence of the statement.', 'A second, quieter paragraph that follows it.']],
  'three-para': ['Working with these exercises', '{statement}', ['One.', 'Two.', 'Three.']],
  'para-then-list': ['Discuss or try one useful workflow', '{list}', ['A paragraph before the list that is long enough to wrap on a narrow column of text.', '- first item', '- second item', '- third item']],
  'plain-list': ['A list', '{list}', ['- first item', '- second item', '- third item']],
  'long-title': ['An application built on existing knowledge and a very long title', '{statement}', ['Short body.']]
}
const lines = ['---', 'title: Panel title centring', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '', '## S', '']
for (const [id, [title, token, body]] of Object.entries(SLIDES)) {
  lines.push(`### ${title}`, `{id=${id}}${token}`, '')
  body.forEach((text) => lines.push(text, ''))
}
lines.push('### Next', '{id=after}', '', '- one', '- two', '')
const dir = mkdtempSync(join(tmpdir(), 'tw-panel-title-centred-'))
const path = join(dir, 'panel-outline.md')
const source = lines.join('\n')
writeFileSync(path, source, 'utf8')
const model = await prepareSource(path, source, 'panel-title-centred', statSync(path))
const htmlPath = join(dir, 'panel.html')
writeFileSync(htmlPath, model.fullHtml, 'utf8')

const browser = await chromium.launch({ headless: true })
const failures = []
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  await page.goto(`file://${htmlPath}?audience=1`, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts?.ready)
  const measured = {}
  for (const id of Object.keys(SLIDES)) {
    await page.evaluate(() => { location.hash = 'after' })
    await page.waitForFunction(() => document.querySelector('.stage > .slide.active')?.dataset.id === 'after')
    await page.evaluate((target) => { location.hash = target }, id)
    await page.waitForFunction((target) => document.querySelector('.stage > .slide.active')?.dataset.id === target, id)
    await page.waitForTimeout(500)
    measured[id] = await page.evaluate(() => {
      const slide = document.querySelector('.stage > .slide.active')
      const sr = slide.getBoundingClientRect()
      const content = slide.querySelector(':scope > .slide-content')
      const head = content.querySelector(':scope > .slide-head:not(.slide-head-quiet)')
      let top = Infinity
      let bottom = -Infinity
      for (const el of head.children) { const r = el.getBoundingClientRect(); if (r.height > 0) { top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom) } }
      const h1 = head.querySelector('h1')
      const kids = [...content.children].filter((el) => !el.matches('.slide-head, aside.notes') && el.getBoundingClientRect().height > 0)
      return {
        panel: slide.dataset.titleLayout === 'left', zoom: content.style.zoom || '1',
        offCentre: Math.round((top + bottom) / 2 - (sr.top + sr.height / 2)),
        headPosition: getComputedStyle(head).position, titleLeft: Math.round(h1.getBoundingClientRect().left - sr.left),
        body: kids.map((el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left - sr.left), Math.round(r.top - sr.top), Math.round(r.width), Math.round(r.height)] })
      }
    })
  }
  for (const [id, m] of Object.entries(measured)) {
    if (!m.panel) { failures.push(`${id}: expected a left panel`); continue }
    if (Math.abs(m.offCentre) > 2) failures.push(`${id}: the panel title is ${m.offCentre}px off the slide's centre`)
    if (m.headPosition !== 'absolute') failures.push(`${id}: the panel head leaves the grid (position ${m.headPosition})`)
  }
  assert.deepEqual(failures, [], failures.join('\n'))
  // Later paragraphs sit one gap below the first, not below the head's span: the two-paragraph body
  // is centred as a block (its middle within 2px of the slide's), where it used to hang below the first row.
  const two = measured['two-para'].body
  const blockMiddle = (Math.min(...two.map((b) => b[1])) + Math.max(...two.map((b) => b[1] + b[3]))) / 2
  assert(Math.abs(blockMiddle - 540) <= 6, `the two-paragraph statement is centred as a block (middle ${blockMiddle}px)`)
  assert.equal(measured['para-then-list'].zoom, '1', 'a paragraph then a list no longer overflows into a zoom-out')
} finally {
  await browser.close()
}
console.log('panel title centred: every painted panel title within 2px of the slide centre; body blocks centred; no zoom-out')

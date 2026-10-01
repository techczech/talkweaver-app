// =============================================================================
// test:dense-layouts-look — slide design round 2 (0.37), ADR-0033 §1: dense slides use the space
// before text gets smaller.
//
// What must hold (specimens: the five slides from the round-2 review of the "Exploring the nature
// and utility of AI" talk, compiled here from their outline text):
//   1. A table slide is as wide as a card slide: .slide-content spans the slide minus the slide's own
//      padding once, not twice. Table cells pad .9cqw at the sides; the first column is 12-13% of the
//      table and the last 15-16%; the table's text is >= 42px at 1920 with no whole-slide zoom.
//   2. A short-line icon list of five items or fewer under a top title runs in two columns at
//      >= 44px at 1920, no zoom. A long-line list of the same shape stays one column.
//   3. Four smartart cards are 2x2 (never 3+1); two cards fill the width (no 1000px cap); card text
//      follows the deck card type: >= 46px (four) / >= 52px (two) at 1920, heading 1.15x the text.
//   4. An annotated list beside a rail: the rail is the base 26cqw, the annotation has no 40ch cap, the
//      column padding is 3cqh, and the label and the annotation's first line share a baseline.
//
// Reads computed styles and rects in Chromium at 1920x1080 after the runtime fit pass. ADR-0030: the
// stage is one 1280x720 canvas scaled 1.5x; values are read in canvas px and compared as px at 1920.
// =============================================================================

import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const dir = mkdtempSync(join(tmpdir(), 'tw-dense-layouts-'))
const source = [
  '---', 'title: Dense layouts probe', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '## Specimens', '',
  '### What is that in ChatGPT', '{id=ex25}{list}{titletop}{iconlist}', '',
  '- Powered by a Large Language Model (LLM) {icon=lucide:brain-circuit}', '  - Generates text or code in many languages',
  '- Users chat with the model via chatbot', '  - Similar to a conversation with a person',
  '- Different types of models  {icon=lucide:lightbulb}', '  - Smaller - Bigger', '  - Instant - Thinking', '  - Media - Image generation, Voice',
  '- Models can use tools', '  - Run computer code', '  - Search the web', '',
  '### A list with long lines', '{id=ex25-long}{list}{titletop}{iconlist}', '',
  '- Powered by a Large Language Model that reads a great deal of text before it answers {icon=lucide:brain-circuit}', '  - Generates text or code in many languages and many styles for many different audiences',
  '- Users chat with the model via a chatbot that keeps the whole conversation in view', '  - Similar to a conversation with a person who has read most of the internet', '',
  '### Where does the model intelligence come from?', '{id=ex43}{table}', '',
  '| Training phase | What it’s for | Types of Data | Amount of Data |', '| :--- | :--- | :--- | :--- |',
  '| **Pre-training** | • General knowledge (facts, ideas) • General skills (language generation, understanding) | • Curated Web Crawl • Book collections • News sources • Academic papers • Wikipedia | **Trillions** of words (20 or more) |',
  '| **Post-training** (fine tuning) | • Hold a conversation • Follow instructions • Use tools • Write in specific formats • Exhibit "personality" | • Selected examples of formats • Expert-made instructions • Human feedback | **Millions** of words |', '',
  '### Key limitations of LLMs', '{id=ex68} {smartart} {sidebar}', '',
  '- No self-knowledge', '  - Don\'t ask "how you did this"', '- No access to training data', '  - Don\'t ask for quotes',
  '- No continuous learning', '  - Model does not change as you use it', '- Bad at arithmetic', '  - Do not ask model to multiply large numbers...', '',
  '### Five roles AI can play in practice', '{id=ex82}{sidebar}{iconlist=list}{font-body=xl}{list}{annotated}', '',
  '- Intern / Research Assistant  {icon=lucide:hand-helping}', '  - Help with routine tasks – from literature searches to organising your schedule.',
  '- Translator  {icon=lucide:languages}', '  - Translate between languages, formats and modalities.',
  '- Peer Reviewer / Consultant  {icon=lucide:message-square-diff}', '  - Give you feedback on your ideas and work.',
  '- Tutor  {icon=lucide:presentation}', '  - Walk you through concepts and processes step by step.',
  '- Tool maker  {icon=lucide:anvil}', '  - Create useful tools for yourself and others to use in your work, research and study.', '',
  '### AI as Intern', '{id=ex84} {smartart}', '',
  '- Strengths', '  - Can perform many tasks', '  - Has helpful skills', '- Dangers', '  - Needs constant supervision', '  - Not always reliable', '  - Skills not clear', ''
].join('\n')
const path = join(dir, 'dense-layouts.md')
writeFileSync(path, source, 'utf8')
const model = await prepareSource(path, source, 'Dense layouts probe', statSync(path))
const htmlPath = join(dir, 'dense-layouts.html')
writeFileSync(htmlPath, model.fullHtml, 'utf8')

const K = 1.5 // canvas px -> px at 1920
const close = (a, b, tolerance) => Math.abs(a - b) <= tolerance
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
    const content = slide.querySelector(':scope > .slide-content')
    const stage = slide.parentElement
    const sr = stage.getBoundingClientRect(), k = sr.width / stage.offsetWidth
    const R = (el) => { const r = el.getBoundingClientRect(); return { left: (r.left - sr.left) / k, right: (r.right - sr.left) / k, top: (r.top - sr.top) / k, bottom: (r.bottom - sr.top) / k, width: r.width / k, height: r.height / k } }
    const cs = (el) => getComputedStyle(el)
    // Smallest rendered text (canvas px) over visible text nodes outside the title.
    let min = Infinity
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (!node.nodeValue.trim()) continue
      const el = node.parentElement
      if (el.closest('.sr-only, h1, script, style')) continue
      const r = el.getBoundingClientRect()
      if (!r.width || !r.height) continue
      min = Math.min(min, parseFloat(cs(el).fontSize))
    }
    const slideCs = cs(slide)
    const out = {
      minText: min, zoom: Number(content.style.zoom || 1), stageWidth: stage.clientWidth,
      slideInner: slide.clientWidth - parseFloat(slideCs.paddingLeft) - parseFloat(slideCs.paddingRight),
      content: R(content), rail: slideCs.getPropertyValue('--rail-w').trim()
    }
    const table = content.querySelector(':scope > .slide-table')
    if (table) {
      const t = R(table)
      const firstRow = [...table.querySelectorAll('tbody tr:first-child > *')]
      out.table = { width: t.width, first: R(firstRow[0]).width / t.width, last: R(firstRow[firstRow.length - 1]).width / t.width, padX: parseFloat(cs(firstRow[1]).paddingLeft) }
    }
    const list = content.querySelector(':scope > .feature-list')
    if (list) out.listColumns = cs(list).columnCount
    const grid = content.querySelector('.smartart-grid')
    if (grid) {
      const nodes = [...grid.querySelectorAll(':scope > .smartart-node')].map(R)
      const text = grid.querySelector('.smartart-node .smartart-text')
      out.cards = {
        count: nodes.length, columns: new Set(nodes.map((n) => Math.round(n.left))).size, rows: new Set(nodes.map((n) => Math.round(n.top))).size,
        gridWidth: R(grid).width, text: parseFloat(cs(text).fontSize), heading: parseFloat(cs(grid.querySelector('.smartart-node h2')).fontSize)
      }
    }
    const annotated = content.querySelector(':scope > .feature-list.fl-annotated')
    if (annotated) {
      const lead = annotated.querySelector('li > .fl-lead .fl-text'), ann = annotated.querySelector('li > .fl-ann')
      const firstLineBottom = (el) => { const range = document.createRange(); range.selectNodeContents(el); const r = [...range.getClientRects()].find((x) => x.width > 0); return (r.bottom - sr.top) / k }
      out.annotated = { annMaxWidth: cs(ann).maxWidth, padTop: parseFloat(cs(content).paddingTop), padBottom: parseFloat(cs(content).paddingBottom), leadBottom: firstLineBottom(lead), annBottom: firstLineBottom(ann), stageHeight: stage.clientHeight, leadSize: parseFloat(cs(lead).fontSize), annSize: parseFloat(cs(ann).fontSize) }
    }
    return out
  }, id)

  // 1. Table.
  const table = await probe('ex43')
  assert.ok(close(table.content.width, table.slideInner, 1), `table slide content spans the slide minus its padding once (${table.content.width} vs ${table.slideInner})`)
  assert.ok(close(table.table.width, table.content.width, 1), 'the table takes the content width')
  assert.ok(table.table.first >= 0.115 && table.table.first <= 0.135, `first column 12-13% (${table.table.first})`)
  assert.ok(table.table.last >= 0.145 && table.table.last <= 0.165, `last column 15-16% (${table.table.last})`)
  assert.ok(close(table.table.padX, table.stageWidth * 0.009, 0.3), `cell side padding is .9cqw (${table.table.padX})`)
  assert.equal(table.zoom, 1, 'the table slide is not zoomed')
  assert.ok(table.minText * K >= 42 - 0.1, `table text >= 42px at 1920 (${table.minText * K})`)

  // 2. Short-line icon list.
  const short = await probe('ex25')
  assert.equal(short.listColumns, '2', 'a short-line icon list of four items runs in two columns')
  assert.equal(short.zoom, 1, 'the icon list is not zoomed')
  assert.ok(short.minText * K >= 44 - 0.1, `icon list text >= 44px at 1920 (${short.minText * K})`)
  const long = await probe('ex25-long')
  assert.notEqual(long.listColumns, '2', 'a list with long lines stays one column')

  // 3. Smartart cards.
  const four = await probe('ex68')
  assert.equal(four.cards.count, 4)
  assert.deepEqual([four.cards.columns, four.cards.rows], [2, 2], 'four cards are 2x2, not 3+1')
  assert.equal(four.zoom, 1, 'four cards are not zoomed')
  assert.ok(four.cards.text * K >= 46 - 0.1, `four-card text >= 46px at 1920 (${four.cards.text * K})`)
  assert.ok(close(four.cards.heading / four.cards.text, 1.15, 0.01), `card heading is 1.15x the text (${four.cards.heading / four.cards.text})`)
  const two = await probe('ex84')
  assert.equal(two.cards.count, 2)
  assert.ok(close(two.cards.gridWidth, two.content.width, 1), `two cards take the full content width (${two.cards.gridWidth})`)
  assert.ok(two.cards.gridWidth > 1000, 'two cards are wider than the old 1000px cap (canvas px)')
  assert.equal(two.zoom, 1, 'two cards are not zoomed')
  assert.ok(two.cards.text * K >= 52 - 0.1, `two-card text >= 52px at 1920 (${two.cards.text * K})`)
  assert.ok(close(two.cards.heading / two.cards.text, 1.15, 0.01), 'two-card heading is 1.15x the text')

  // 4. Annotated list beside the rail.
  const roles = await probe('ex82')
  assert.ok(close(parseFloat(roles.rail), roles.stageWidth * 0.26, 0.6) || roles.rail === 'max(260px, 26cqw)', `rail is the base 26cqw (${roles.rail})`)
  assert.equal(roles.annotated.annMaxWidth, 'none', 'annotations carry no 40ch cap')
  assert.ok(roles.annotated.padTop <= roles.annotated.stageHeight * 0.03 + 40 + 0.5, `column top padding is 3cqh, not 6cqh (${roles.annotated.padTop})`)
  assert.ok(close(roles.annotated.leadSize, roles.annotated.annSize, 0.01), 'label and annotation share a size')
  assert.ok(close(roles.annotated.leadBottom, roles.annotated.annBottom, 1), `label and annotation baselines meet (${roles.annotated.leadBottom} vs ${roles.annotated.annBottom})`)
  assert.equal(roles.zoom, 1, 'the annotated list is not zoomed')
  console.log('test:dense-layouts-look passed')
} finally {
  await browser.close()
}

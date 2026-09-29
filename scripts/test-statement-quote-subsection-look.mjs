// =============================================================================
// test:statement-quote-subsection-look — ADR-0028 decisions 1, 2 and 7 (slide design, 2026-09-25)
//
// What must hold:
//   1. Statement slides: line-height 1.5 × the font size; font size as before (5.4cqw on the
//      stage). ADR-0028 §10 replaced decision 1's 14em measure: without a title the text column is
//      at most 68cqw and sits centred on a panel in the section tint; beside the rail the measure
//      stays 14em, centred in the content column. (test:statement-options-look covers §10 fully,
//      with the runtime's fit pass; this test reads the stylesheet alone.)
//   2. A quote beside the rail: no tint, no left rule, no panel padding; the quotation mark hangs
//      outside the text block, in the gutter (not over the rail); type as before. With an authored
//      {bg=…} the slide background still paints.
//   3. A quote-only slide: panel, rule, mark and width have exactly the computed styles they had
//      before ADR-0028 (ADR-0023 §5/§9). The snapshot below was read from the compiler at 5d63eea.
//   4. Subsection divider: the parent-section label's left edge equals the title's left edge, and
//      the head stays centred on the stage.
//
// Compiles a real deck (prepareSource → model.fullHtml) and reads computed styles in Chromium at
// 1600×900 and 1280×720. ADR-0030: both windows show the one 1280×720 canvas (scaled 1.25 at
// 1600×900), so every rect is read in canvas px and the stage width is the canvas width.
// =============================================================================

import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const LONG_STATEMENT = 'This means 2026 is the year of agents in every office, on every desk and in every inbox'
const QUOTE = 'I need to wrap up my work on the York workshops. Pull up any emails about expenses and all the forms they sent.'

const dir = mkdtempSync(join(tmpdir(), 'tw-statement-quote-subsection-'))
const source = [
  '---', 'title: Statement quote subsection probe', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '## The State of AI in September 2026', '',
  // A heading-only slide: the statement with a nav-only (quiet) head, as in the specimen talk.
  `### ${LONG_STATEMENT}`, '{id=stmt-quiet}', '',
  // A statement paragraph beside a visible rail title.
  '### Statement beside the rail', '{statement} {id=stmt-rail}', '', 'Agents are how software will be used from now on.', '',
  // Quotes beside the rail, without and with an authored slide background.
  '### What you can do with this', '{id=rail-quote}{sidebar}', '', `> ${QUOTE}`, '', '- Prompt', '',
  '### What you can do with this too', '{id=rail-quote-bg}{sidebar} {bg=emerald}', '', `> ${QUOTE}`, '', '- Prompt', '',
  // A quote-only slide keeps the ADR-0023 panel.
  '### Prompt before travel', '{quote} {id=quote-only}', '',
  '> Hey, look at my emails, and schedule all these things on my calendar, including blocks for walks.', '',
  // A `###` with children: a subsection divider whose kicker is the parent section's title.
  '### Example from a recent trip', '{id=sub-div}', '#### Child', '', 'Body.'
].join('\n')
const path = join(dir, 'statement-quote-subsection.md')
writeFileSync(path, source, 'utf8')
const model = await prepareSource(path, source, 'Statement quote subsection probe', statSync(path))
const htmlPath = join(dir, 'statement-quote-subsection.html')
writeFileSync(htmlPath, model.fullHtml, 'utf8')

// Computed styles of the quote-only panel that ADR-0028 must not move.
const PANEL_PROPS = [
  'background-color', 'background-image', 'border-left-width', 'border-left-style', 'border-left-color',
  'border-radius', 'box-shadow', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin-left', 'width', 'max-width', 'font-family', 'font-size', 'font-weight', 'line-height',
  'letter-spacing', 'position', 'justify-self'
]
const MARK_PROPS = ['content', 'position', 'left', 'top', 'font-size', 'line-height', 'font-family', 'font-weight', 'color', 'opacity']
const QUOTE_ONLY_BEFORE = {
  '1280x720': {
    panel: {
      "background-color": "rgb(232, 238, 252)",
      "background-image": "none",
      "border-left-width": "9px",
      "border-left-style": "solid",
      "border-left-color": "rgb(15, 75, 216)",
      "border-radius": "0px",
      "box-shadow": "none",
      "padding-top": "60.928px",
      "padding-right": "69.632px",
      "padding-bottom": "52.224px",
      "padding-left": "104.448px",
      "margin-left": "0px",
      width: "1075.19px",
      "max-width": "100%",
      "font-family": "\"Trebuchet MS\", system-ui, -apple-system, \"Segoe UI\", sans-serif",
      "font-size": "43.52px",
      "font-weight": "400",
      "line-height": "61.7984px",
      "letter-spacing": "-0.4352px",
      position: "relative",
      "justify-self": "auto"
    },
    mark: {
      content: "\"“\"",
      position: "absolute",
      left: "31.6826px",
      top: "20.3674px",
      "font-size": "113.152px",
      "line-height": "113.152px",
      "font-family": "Georgia, serif",
      "font-weight": "700",
      color: "rgb(15, 75, 216)",
      opacity: "1"
    },
    width: 1075.19
  }
}
// ADR-0030: a 1600×900 window shows the same 1280×720 canvas scaled by 1.25, so its computed styles
// are the canvas's. (Before ADR-0030 the stage was the window: width 1180px, the retired px cap.)
QUOTE_ONLY_BEFORE['1600x900'] = QUOTE_ONLY_BEFORE['1280x720']

const px = (value) => parseFloat(value)
const close = (a, b, tolerance = 0.5) => Math.abs(a - b) <= tolerance

const browser = await chromium.launch({ headless: true })
try {
  for (const viewport of [{ width: 1600, height: 900 }, { width: 1280, height: 720 }]) {
    const key = `${viewport.width}x${viewport.height}`
    const page = await browser.newPage({ viewport })
    await page.goto(`file://${htmlPath}`, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    const probe = (id) => page.evaluate(({ slideId, panelProps, markProps }) => {
      const slides = [...document.querySelectorAll('.stage > .slide')]
      const slide = slides.find((node) => node.dataset.id === slideId)
      if (!slide) return null
      slides.forEach((node) => node.classList.toggle('active', node === slide))
      const pick = (el, pseudo, props) => {
        const style = getComputedStyle(el, pseudo)
        return Object.fromEntries(props.map((prop) => [prop, style.getPropertyValue(prop)]))
      }
      // Canvas px: painted rects relative to the stage, divided by its scale (ADR-0030).
      const stageEl = slide.parentElement
      const sr = stageEl.getBoundingClientRect()
      const k = sr.width / stageEl.offsetWidth
      const x = (v) => (v - sr.left) / k
      const rect = (el) => { const r = el.getBoundingClientRect(); return { left: x(r.left), right: x(r.right), width: r.width / k } }
      const content = slide.querySelector(':scope > .slide-content')
      const stage = { left: 0, width: stageEl.offsetWidth }
      const out = {
        layoutClass: content.className,
        stage: { left: stage.left, width: stage.width },
        slideBg: pick(slide, null, ['background-color', 'background-image']),
        content: { ...pick(content, null, ['column-gap', 'grid-template-columns']), ...rect(content) }
      }
      const p = content.querySelector(':scope > p')
      if (p) out.p = { ...pick(p, null, ['font-size', 'line-height', 'max-width', 'padding-left', 'padding-right', 'background-color']), ...rect(p) }
      const quote = content.querySelector(':scope > blockquote')
      if (quote) {
        const mark = pick(quote, '::before', markProps)
        const canvas = document.createElement('canvas').getContext('2d')
        canvas.font = `${mark['font-weight']} ${mark['font-size']} ${mark['font-family']}`
        out.quote = {
          style: pick(quote, null, panelProps),
          mark,
          markWidth: canvas.measureText('“').width,
          ...rect(quote),
          textLeft: x(quote.querySelector('p').getBoundingClientRect().left)
        }
      }
      const kicker = content.querySelector('.slide-head > .kicker')
      const h1 = content.querySelector('.slide-head > h1')
      if (kicker && h1) {
        const range = document.createRange()
        range.selectNodeContents(kicker)
        out.divider = { kicker: rect(kicker), kickerText: x(range.getBoundingClientRect().left), h1: rect(h1), head: rect(kicker.parentElement) }
      }
      return out
    }, { slideId: id, panelProps: PANEL_PROPS, markProps: MARK_PROPS })

    // 1. Statement: line spacing 1.5, type unchanged; §10 measure and panel.
    const quiet = await probe('stmt-quiet')
    assert.match(quiet.layoutClass, /\blayout-statement\b/, 'a heading-only slide compiles to a statement')
    const quietSize = px(quiet.p['font-size'])
    assert(close(quietSize, Math.max(34, 0.054 * quiet.stage.width), 0.05), `${key}: statement type unchanged at 5.4cqw (got ${quietSize}px)`)
    assert(close(px(quiet.p['line-height']), 1.5 * quietSize, 0.05), `${key}: statement line-height is 1.5× (got ${quiet.p['line-height']} for ${quietSize}px)`)
    const quietText = quiet.p.width - px(quiet.p['padding-left']) - px(quiet.p['padding-right'])
    assert(quietText <= 0.68 * quiet.stage.width + 0.5, `${key}: the statement text column stays inside 68cqw (got ${quietText}px)`)
    assert(quietText > 0.64 * quiet.stage.width, `${key}: a long statement uses the measure (text column ${quietText}px)`)
    assert(close(quiet.p.left - quiet.stage.left, quiet.stage.width - (quiet.p.left - quiet.stage.left) - quiet.p.width, 1), `${key}: the statement panel is centred on the stage`)
    assert.notEqual(quiet.p['background-color'], 'rgba(0, 0, 0, 0)', `${key}: the default statement sits on a panel`)
    const railStatement = await probe('stmt-rail')
    const railSize = px(railStatement.p['font-size'])
    assert(close(railSize, 0.032 * railStatement.stage.width, 0.05), `${key}: a rail statement keeps its body type (got ${railSize}px)`)
    assert(close(px(railStatement.p['line-height']), 1.5 * railSize, 0.05), `${key}: a rail statement also takes line-height 1.5 (got ${railStatement.p['line-height']})`)
    const railText = railStatement.p.width - px(railStatement.p['padding-left']) - px(railStatement.p['padding-right'])
    assert(railText <= 14 * railSize + 0.5, `${key}: beside the rail the statement measure stays 14em (got ${railText}px)`)
    console.log(`PASS ${key}: statement line-height 1.5×, type unchanged, §10 measure (68cqw without a title, 14em beside the rail) on a panel`)

    // 2. Quote beside the rail: no panel, hanging mark in the gutter, type unchanged.
    for (const id of ['rail-quote', 'rail-quote-bg']) {
      const rail = await probe(id)
      assert.match(rail.layoutClass, /\blayout-quote\b/, `${id} compiles to the quote layout`)
      const q = rail.quote
      assert.equal(q.style['background-color'], 'rgba(0, 0, 0, 0)', `${key} ${id}: no tinted panel (got ${q.style['background-color']})`)
      assert.equal(q.style['background-image'], 'none', `${key} ${id}: no panel image`)
      assert.equal(q.style['border-left-width'], '0px', `${key} ${id}: no accent rule (got ${q.style['border-left-width']})`)
      assert.equal(q.style['padding-left'], '0px', `${key} ${id}: no panel padding`)
      const quoteSize = px(q.style['font-size'])
      assert(close(quoteSize, Math.max(31, 0.034 * rail.stage.width), 0.05), `${key} ${id}: quote type unchanged (got ${quoteSize}px)`)
      assert(close(px(q.style['line-height']), 1.42 * quoteSize, 0.05), `${key} ${id}: quote line-height unchanged`)
      assert(q.width <= 24 * quoteSize + 0.5, `${key} ${id}: the quote measure caps at 24em`)
      const markLeft = q.left + px(q.mark.left)
      const markRight = markLeft + q.markWidth
      assert(markRight <= q.left + 0.5, `${key} ${id}: the mark hangs outside the text block (mark right ${markRight}, block left ${q.left})`)
      assert(markRight <= q.textLeft + 0.5, `${key} ${id}: the mark sits left of the first line`)
      const railRight = rail.content.left + px(rail.content['grid-template-columns'].split(' ')[0])
      assert(markLeft >= railRight - 0.5, `${key} ${id}: the mark sits in the gutter, not over the rail (mark left ${markLeft}, rail right ${railRight})`)
      assert(close(px(rail.content['column-gap']), Math.min(128, Math.max(56, 0.07 * rail.stage.width)), 0.05), `${key} ${id}: the rail gap widens to clamp(56px, 7cqw, 128px) (got ${rail.content['column-gap']})`)
      if (id === 'rail-quote-bg') {
        assert.equal(rail.slideBg['background-color'], 'rgb(228, 243, 238)', `${key}: an authored {bg=emerald} still paints the slide (got ${rail.slideBg['background-color']})`)
        assert.equal(rail.slideBg['background-image'], 'none', `${key}: the authored background replaces the rail gradient as before`)
      } else {
        assert.match(rail.slideBg['background-image'], /^linear-gradient/, `${key}: the default rail is still painted on the slide`)
      }
    }
    console.log(`PASS ${key}: quote beside the rail has no panel or rule, a hanging mark in the gutter, type unchanged; {bg=…} still paints`)

    // 3. Quote-only slide: the ADR-0023 panel is untouched.
    const only = await probe('quote-only')
    const snapshot = { panel: only.quote.style, mark: only.quote.mark, width: Math.round(only.quote.width * 100) / 100 }
    assert.deepEqual(snapshot, QUOTE_ONLY_BEFORE[key], `${key}: the quote-only panel keeps its pre-ADR-0028 computed styles`)
    console.log(`PASS ${key}: quote-only panel, rule, mark and width unchanged`)

    // 4. Subsection divider: parent label and title share one left edge; the head stays centred.
    const sub = await probe('sub-div')
    assert.match(sub.layoutClass, /\blayout-section-title\b/, 'a ### with children compiles to a divider')
    assert(sub.divider, 'the subsection divider carries the parent-section label and a title')
    assert(close(sub.divider.kicker.left, sub.divider.h1.left), `${key}: parent label left ${sub.divider.kicker.left} equals title left ${sub.divider.h1.left}`)
    assert(close(sub.divider.kickerText, sub.divider.h1.left), `${key}: the label's text starts at the title's left edge`)
    const headCentre = (sub.divider.head.left + sub.divider.head.right) / 2
    const contentCentre = sub.content.left + sub.content.width / 2
    assert(close(headCentre, contentCentre, 1), `${key}: the divider head stays centred (head ${headCentre}, content ${contentCentre})`)
    console.log(`PASS ${key}: subsection parent label left-aligned with the title`)
    await page.close()
  }
} finally {
  await browser.close()
}
console.log('statement, rail quote and subsection look (ADR-0028 §1, §2, §7): all checks passed')

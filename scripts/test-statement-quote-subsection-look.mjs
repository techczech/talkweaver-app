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
//   3. A quote-only slide: the open drawing of 0.41 ticket 04 (ADR-0039): no panel, rule or padding,
//      a pale mark in the flow, words at 4.1667cqw in line height 1.24, one width of 71.875cqw.
//   4. Section/subsection divider: a label above its title (now only an authored {kicker=…}, ADR-0039)
//      has its left edge at the title's left edge, and the head block (accent bar, label, title) sits
//      at 8.3333cqw from the left edge, with the bar as its own left edge (ticket 04).
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
  // A `###` with children: a subsection divider with an authored label above its title (ADR-0039: the
  // parent section's name is no longer put there by the compiler).
  '### Example from a recent trip', '{id=sub-div} {layout=section-title kicker="The State of AI in September 2026"}', '#### Child', '', 'Body.'
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
      if (p) out.p = { ...pick(p, null, ['font-size', 'line-height', 'max-width', 'padding-left', 'padding-right', 'border-left-width', 'background-color']), ...rect(p) }
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
        out.divider = { kicker: rect(kicker), kickerText: x(range.getBoundingClientRect().left), h1: rect(h1), head: rect(kicker.parentElement), bar: { width: parseFloat(getComputedStyle(kicker.parentElement, '::before').width) } }
      }
      return out
    }, { slideId: id, panelProps: PANEL_PROPS, markProps: MARK_PROPS })

    // 1. Statement: line spacing 1.5, type unchanged; §10 measure and panel.
    const quiet = await probe('stmt-quiet')
    assert.match(quiet.layoutClass, /\blayout-statement\b/, 'a heading-only slide compiles to a statement')
    const quietSize = px(quiet.p['font-size'])
    assert(close(quietSize, Math.max(34, 0.054 * quiet.stage.width), 0.05), `${key}: statement type unchanged at 5.4cqw (got ${quietSize}px)`)
    assert(close(px(quiet.p['line-height']), 1.5 * quietSize, 0.05), `${key}: statement line-height is 1.5× (got ${quiet.p['line-height']} for ${quietSize}px)`)
    const quietText = quiet.p.width - px(quiet.p['padding-left']) - px(quiet.p['padding-right']) - px(quiet.p['border-left-width'])
    assert(quietText <= 0.68 * quiet.stage.width + 0.5, `${key}: the statement text column stays inside 68cqw (got ${quietText}px)`)
    assert(quietText > 0.64 * quiet.stage.width, `${key}: a long statement uses the measure (text column ${quietText}px)`)
    assert(close(quiet.p.left - quiet.stage.left, 0.2 * quiet.stage.width, 1), `${key}: the statement starts 20% of the stage width from the left edge (slide redesign, 13 Oct 2026)`)
    assert.equal(quiet.p['background-color'], 'rgba(0, 0, 0, 0)', `${key}: the statement has no box round it`)
    const railStatement = await probe('stmt-rail')
    const railSize = px(railStatement.p['font-size'])
    assert(close(railSize, 0.032 * railStatement.stage.width, 0.05), `${key}: a rail statement keeps its body type (got ${railSize}px)`)
    assert(close(px(railStatement.p['line-height']), 1.5 * railSize, 0.05), `${key}: a rail statement also takes line-height 1.5 (got ${railStatement.p['line-height']})`)
    const railText = railStatement.p.width - px(railStatement.p['padding-left']) - px(railStatement.p['padding-right']) - px(railStatement.p['border-left-width'])
    assert(railText <= 14 * railSize + 0.5, `${key}: beside the rail the statement measure stays 14em (got ${railText}px)`)
    console.log(`PASS ${key}: statement line-height 1.5×, type unchanged, §10 measure (68cqw without a title, 14em beside the rail), no box`)

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

    // 3. Quote-only slide: 0.41 ticket 04 (ADR-0039) replaces the ADR-0023 panel with the open drawing:
    //    no tint, no rule, no padding, a pale mark in the flow over the words, words at 4.1667cqw
    //    (80px at 1920) in line height 1.24, one width of 71.875cqw. The geometry is mirrored in
    //    quote-layout.mjs (test:quote-sizing guards the split against it).
    const only = await probe('quote-only')
    const oq = only.quote
    const W = only.stage.width
    assert.equal(oq.style['background-color'], 'rgba(0, 0, 0, 0)', `${key}: the quote-only slide has no tinted panel (got ${oq.style['background-color']})`)
    assert.equal(oq.style['border-left-width'], '0px', `${key}: no accent rule on the quote`)
    assert.equal(oq.style['padding-left'], '0px', `${key}: no panel padding`)
    assert(close(px(oq.style['font-size']), Math.max(31, 0.041667 * W), 0.05), `${key}: quote type is 4.1667cqw (got ${oq.style['font-size']})`)
    assert(close(px(oq.style['line-height']), 1.24 * px(oq.style['font-size']), 0.05), `${key}: quote line-height is 1.24 (got ${oq.style['line-height']})`)
    assert(close(oq.width, 0.71875 * W, 1), `${key}: the quote has the one width, 71.875cqw (got ${oq.width})`)
    assert.equal(oq.mark.position, 'static', `${key}: the mark sits in the flow over the words`)
    assert.equal(oq.mark['font-weight'], '700', `${key}: the mark glyph keeps its weight`)
    assert.match(oq.mark.color, /^color\(srgb /, `${key}: the mark is the accent mixed pale (got ${oq.mark.color})`)
    console.log(`PASS ${key}: quote-only slide is the open drawing (no box, pale mark, 4.1667cqw words, one width)`)

    // 4. Subsection divider: the authored label and the title share one left edge; the head stays centred.
    const sub = await probe('sub-div')
    assert.match(sub.layoutClass, /\blayout-section-title\b/, 'a ### with children compiles to a divider')
    assert(sub.divider, 'the subsection divider carries its authored label and a title')
    assert(close(sub.divider.kicker.left, sub.divider.h1.left), `${key}: label left ${sub.divider.kicker.left} equals title left ${sub.divider.h1.left}`)
    assert(close(sub.divider.kickerText, sub.divider.h1.left), `${key}: the label's text starts at the title's left edge`)
    assert(close(sub.divider.head.left, 0.083333 * sub.stage.width, 1), `${key}: the divider head starts 8.3333cqw from the left edge (got ${sub.divider.head.left})`)
    assert(close(sub.divider.bar.width, 0.00625 * sub.stage.width, 0.1), `${key}: the head carries the accent bar, .625cqw wide (got ${sub.divider.bar.width})`)
    assert(close(sub.divider.h1.left - sub.divider.head.left, 0.033333 * sub.stage.width, 1), `${key}: the title starts 3.3333cqw right of the bar's edge`)
    console.log(`PASS ${key}: divider head at the left with its accent bar; label left-aligned with the title`)
    await page.close()
  }
} finally {
  await browser.close()
}
console.log('statement, rail quote and subsection look (ADR-0028 §1, §2, §7): all checks passed')

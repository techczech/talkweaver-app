// =============================================================================
// Review fixes on the slide redesign, read from a compiled deck at 1280x720 in the real runtime:
//   1. A top-title statement with Lower third: the compiler stamps the hook, the band is the bottom
//      38% and the text (title and statement) stays above it. Screenshot: lower-third-top-title.png.
//   2. An [Action: …] row on a statement starts at the statement text's left edge: 20% from the slide
//      edge with no panel, 9% right of the panel with one, centred buttons for a centred statement.
//      Screenshot: statement-with-action-row.png.
//   3. (13 Oct, preview 9 check) Lower third without a title: the text block is centred on the middle of
//      the slide at 1920x1080; a block too tall for that stops 3% of the slide's height above the band.
//      Pictures: fix-lower-third-short.png, fix-lower-third-long.png.
//   4. (13 Oct, preview 9 check) No divider line between a statement's panel (titled, or the empty
//      rail) and its text, for Tinted, Rule and Strong colour. Pictures: fix-panel-no-divider-*.png.
// Screenshots are written when SHOTS_DIR is set.
// =============================================================================
import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const W = 1280
const H = 720
const STATEMENT = 'Agents need a place to keep their work.'
const ACTION = '[Action: Get the handout → https://example.com/handout]'
const lines = ['---', 'title: Review fixes', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '', '## Statements', '{accent=cobalt}', '']
lines.push('### Where to start', '{id=lt-top}{statement}{titletop}{statement-bg=lower-third}', '', STATEMENT, '')
lines.push('### Where to start', '{id=lt-nosidebar}{statement}{statement-sidebar=off}{statement-bg=lower-third}', '', STATEMENT, '')
lines.push('### Where to start', '{id=lt-left}{statement}{statement-bg=lower-third}', '', STATEMENT, '')
lines.push('### The handout', '{id=act-nopanel}{statement}{notitle}', '', STATEMENT, '', ACTION, '')
lines.push('### The handout', '{id=act-panel}{statement}', '', STATEMENT, '', ACTION, '')
lines.push('### The handout', '{id=act-centred}{statement}{notitle}{statement-align=centred}', '', STATEMENT, '', ACTION, '')
lines.push('### Next slide', '{id=after}', '', '- one', '- two', '')

const dir = mkdtempSync(join(tmpdir(), 'tw-statement-review-'))
const outlinePath = join(dir, 'statement-review-outline.md')
const source = lines.join('\n')
writeFileSync(outlinePath, source, 'utf8')
const model = await prepareSource(outlinePath, source, 'statement-review', statSync(outlinePath))
const htmlPath = join(dir, 'statement-review.html')
writeFileSync(htmlPath, model.fullHtml, 'utf8')
const ids = ['lt-top', 'lt-nosidebar', 'lt-left', 'act-nopanel', 'act-panel', 'act-centred']
const shotsDir = process.env.SHOTS_DIR
if (shotsDir) mkdirSync(shotsDir, { recursive: true })

const browser = await chromium.launch({ headless: true })
const shots = {}
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } })
  await page.goto(`file://${htmlPath}?audience=1`, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts?.ready)
  for (const id of ids) {
    await page.evaluate(() => { location.hash = 'after' })
    await page.waitForFunction(() => document.querySelector('.stage > .slide.active')?.dataset.id === 'after')
    await page.evaluate((target) => { location.hash = target }, id)
    await page.waitForFunction((target) => {
      const slide = document.querySelector('.stage > .slide.active')
      return slide?.dataset.id === target && slide.querySelector(':scope > .slide-content')?.dataset.statementFit
    }, id, { timeout: 10000 }).catch(() => {})
    await page.waitForTimeout(150)
    shots[id] = await page.evaluate(() => {
      const slide = document.querySelector('.stage > .slide.active')
      const stage = slide.parentElement
      const k = stage.getBoundingClientRect().width / stage.offsetWidth
      const sr = slide.getBoundingClientRect()
      const rel = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { left: (r.left - sr.left) / k, right: (r.right - sr.left) / k, top: (r.top - sr.top) / k, bottom: (r.bottom - sr.top) / k } }
      const content = slide.querySelector(':scope > .slide-content')
      const p = content.querySelector(':scope > p:not(.kicker):not(.slide-source)')
      const range = document.createRange()
      range.selectNodeContents(p)
      const r = range.getBoundingClientRect()
      const text = { left: (r.left - sr.left) / k, right: (r.right - sr.left) / k, top: (r.top - sr.top) / k, bottom: (r.bottom - sr.top) / k }
      const actions = content.querySelector(':scope > .slide-actions')
      const button = actions?.querySelector('a, button')
      const head = content.querySelector(':scope > .slide-head:not(.slide-head-quiet)')
      return {
        className: content.className, titleLayout: slide.dataset.titleLayout, text, actions: rel(actions), button: rel(button), head: rel(head),
        bandImage: getComputedStyle(slide).backgroundImage, paddingBottom: parseFloat(getComputedStyle(slide).paddingBottom) || 0
      }
    })
    if (shotsDir && (id === 'lt-top' || id === 'act-nopanel')) {
      await page.screenshot({ path: join(shotsDir, id === 'lt-top' ? 'lower-third-top-title.png' : 'statement-with-action-row.png') })
    }
  }
} finally {
  await browser.close()
}

if (process.env.DEBUG_SHOTS) console.log(JSON.stringify(shots, null, 1))
const near = (a, b, tolerance = 1.5) => Math.abs(a - b) <= tolerance
const band = 0.38 * H
for (const id of ['lt-top', 'lt-nosidebar']) {
  const s = shots[id]
  assert.match(s.className, /\bstatement-bg-lower-third\b/, `${id}: the compiler stamps statement-bg-lower-third (${s.className})`)
  assert.equal(s.titleLayout, 'top', `${id}: the title is at the top`)
  assert.ok(s.bandImage.includes('rgb(232, 238, 252)'), `${id}: the band is painted (${s.bandImage.slice(0, 80)})`)
  assert.ok(s.text.bottom <= H - band + 1, `${id}: the statement ends above the band (${s.text.bottom.toFixed(0)} vs ${(H - band).toFixed(0)})`)
  assert.ok(s.head && s.head.bottom <= H - band + 1, `${id}: the title sits above the band`)
  assert.ok(s.head.top >= 20, `${id}: the title keeps clear of the slide's top edge (${s.head.top.toFixed(0)}px)`)
  assert.ok(s.head.bottom <= s.text.top + 1, `${id}: the title does not run into the statement`)
}
const noPanel = (20 / 100) * W
const panel = shots['act-panel']
const nop = shots['act-nopanel']
assert.ok(nop.actions, 'act-nopanel: the action row is a direct child of the statement content')
// 0.41 ticket 04 (ADR-0039): the accent bar (.625cqw) and its gap (3.0208cqw) sit between the 20% line and the words.
assert.ok(near(nop.text.left, noPanel + (0.00625 + 0.030208) * W), `act-nopanel: the statement's bar starts 20% in, its words the bar and gap further (${nop.text.left.toFixed(1)})`)
assert.ok(near(nop.button.left, nop.text.left), `act-nopanel: the action row starts at the statement's left edge (${nop.button.left.toFixed(1)} vs ${nop.text.left.toFixed(1)})`)
assert.ok(panel.actions && near(panel.button.left, panel.text.left), `act-panel: the action row starts at the statement's left edge beside the panel (${panel.button?.left.toFixed(1)} vs ${panel.text.left.toFixed(1)})`)
assert.ok(panel.text.left > panel.head.right, 'act-panel: the text sits right of the panel')
const cen = shots['act-centred']
assert.ok(cen.actions && near((cen.button.left + cen.button.right) / 2, W / 2, 3), `act-centred: the buttons are centred (${((cen.button.left + cen.button.right) / 2).toFixed(1)})`)
console.log('PASS statement review fixes: top-title Lower third clears the band; the Action row shares the statement left edge (no panel, panel, centred)')

// 3 and 4. Read at 1920x1080 from their own deck.
const W2 = 1920
const H2 = 1080
const LONG = 'Agents need a place to keep their work, and the people who rely on that work need to see where it went, what it changed and who decided it. '.repeat(2).trim()
const l2 = ['---', 'title: Review fixes 1080', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '', '## Statements', '{accent=cobalt}', '']
l2.push('### x', '{id=low-short}{statement}{notitle}{statement-sidebar=off}{statement-bg=lower-third}', '', STATEMENT, '')
l2.push('### x', '{id=low-two}{statement}{notitle}{statement-sidebar=off}{statement-bg=lower-third}', '', 'Agents need a place to keep their work.', '', 'A quieter second paragraph.', '')
l2.push('### x', '{id=low-long}{statement}{notitle}{statement-sidebar=off}{statement-bg=lower-third}', '', LONG, '')
l2.push('### x', '{id=low-action}{statement}{notitle}{statement-sidebar=off}{statement-bg=lower-third}', '', 'Agents need a place to keep their work.', '', ACTION, '')
for (const bg of ['tinted', 'rule', 'strong']) {
  l2.push('### Where to start', `{id=panel-${bg}}{statement}{statement-bg=${bg}}`, '', STATEMENT, '')
  l2.push('### x', `{id=rail-${bg}}{statement}{notitle}{statement-sidebar=on}{statement-bg=${bg}}`, '', STATEMENT, '')
}
l2.push('### Next slide', '{id=after}', '', '- one', '- two', '')
const dir2 = mkdtempSync(join(tmpdir(), 'tw-statement-review-1080-'))
const outline2 = join(dir2, 'statement-review-1080-outline.md')
const source2 = l2.join('\n')
writeFileSync(outline2, source2, 'utf8')
const model2 = await prepareSource(outline2, source2, 'statement-review-1080', statSync(outline2))
const html2 = join(dir2, 'statement-review-1080.html')
writeFileSync(html2, model2.fullHtml, 'utf8')
const ids2 = ['low-short', 'low-two', 'low-long', 'low-action', ...['tinted', 'rule', 'strong'].flatMap((bg) => [`panel-${bg}`, `rail-${bg}`])]
const PICTURES = { 'low-short': 'fix-lower-third-short.png', 'low-long': 'fix-lower-third-long.png', 'panel-tinted': 'fix-panel-no-divider-tinted.png', 'panel-rule': 'fix-panel-no-divider-rule.png' }
const m2 = {}
const browser2 = await chromium.launch({ headless: true })
try {
  const page = await browser2.newPage({ viewport: { width: W2, height: H2 } })
  await page.goto(`file://${html2}?audience=1`, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts?.ready)
  for (const id of ids2) {
    await page.evaluate(() => { location.hash = 'after' })
    await page.waitForFunction(() => document.querySelector('.stage > .slide.active')?.dataset.id === 'after')
    await page.evaluate((target) => { location.hash = target }, id)
    await page.waitForFunction((target) => {
      const slide = document.querySelector('.stage > .slide.active')
      return slide?.dataset.id === target && slide.querySelector(':scope > .slide-content')?.dataset.statementFit
    }, id, { timeout: 10000 }).catch(() => {})
    await page.waitForTimeout(150)
    m2[id] = await page.evaluate(() => {
      const slide = document.querySelector('.stage > .slide.active')
      const sr = slide.getBoundingClientRect()
      const content = slide.querySelector(':scope > .slide-content')
      // The text block: every statement paragraph, kicker, source line and action row, by their text.
      let top = Infinity
      let bottom = -Infinity
      for (const el of content.querySelectorAll(':scope > p, :scope > .slide-source, :scope > .slide-actions')) {
        const range = document.createRange()
        range.selectNodeContents(el)
        const r = el.matches('.slide-actions') ? el.getBoundingClientRect() : range.getBoundingClientRect()
        if (r.height > 0) { top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom) }
      }
      const head = content.querySelector(':scope > .slide-head:not(.slide-head-quiet)')
      const probe = document.createElement('div')
      probe.style.cssText = 'position:absolute;visibility:hidden;height:0;width:var(--rail-w)'
      slide.appendChild(probe)
      const rail = probe.getBoundingClientRect().width / (sr.width / slide.offsetWidth)
      probe.remove()
      const lineOf = (el, pseudo) => {
        if (!el) return null
        const cs = getComputedStyle(el, pseudo)
        const sides = ['Top', 'Right', 'Bottom', 'Left']
        return {
          border: sides.some((side) => parseFloat(cs[`border${side}Width`]) > 0 && cs[`border${side}Style`] !== 'none'),
          outline: parseFloat(cs.outlineWidth) > 0 && cs.outlineStyle !== 'none',
          shadow: cs.boxShadow !== 'none',
          pseudo: pseudo ? cs.content !== 'none' && cs.content !== 'normal' : false
        }
      }
      return {
        scale: sr.width / slide.offsetWidth, slideTop: sr.top, slideH: sr.height, textTop: top - sr.top, textBottom: bottom - sr.top, fit: content.dataset.statementFit,
        railPx: rail * sr.width / slide.offsetWidth, hasHead: Boolean(head), accent: getComputedStyle(slide).getPropertyValue('--accent').trim(),
        lines: [slide, content, head].flatMap((el) => [lineOf(el), lineOf(el, '::before'), lineOf(el, '::after')]).filter(Boolean),
        backgroundImage: getComputedStyle(slide).backgroundImage
      }
    })
    if (shotsDir && PICTURES[id]) await page.screenshot({ path: join(shotsDir, PICTURES[id]) })
    if (id.startsWith('panel-') || id.startsWith('rail-')) {
      // Pixels in a row below the text, 24px each side of the panel's edge: a divider line would be a third colour.
      const png = await page.screenshot({ clip: { x: m2[id].railPx - 24, y: H2 - 40, width: 48, height: 1 } })
      const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true })
      const colours = new Set()
      for (let x = 0; x < info.width; x++) colours.add([...data.subarray(x * info.channels, x * info.channels + 3)].join(','))
      m2[id].edgeColours = colours.size
    }
  }
} finally {
  await browser2.close()
}
if (process.env.DEBUG_SHOTS) console.log(JSON.stringify(m2, null, 1))
const GAP = 0.03 * H2
const bandTop = H2 - 0.38 * H2
for (const id of ['low-short']) {
  const m = m2[id]
  const middle = (m.textTop + m.textBottom) / 2
  assert.ok(Math.abs(middle - H2 / 2) <= 1.5, `${id}: the text block is centred on the slide's middle (middle ${middle.toFixed(1)} of ${H2 / 2})`)
  assert.ok(m.textBottom <= bandTop - GAP + 1, `${id}: the block keeps clear of the band`)
}
// A block taller than twice the room between the slide's middle and the band (here 194px) is clamped.
for (const id of ['low-two', 'low-action']) assert.ok(m2[id].textBottom <= bandTop - GAP + 1, `${id}: a two-paragraph or action-row block keeps clear of the band (${m2[id].textBottom.toFixed(1)})`)
{
  const m = m2['low-long']
  assert.ok(m.textBottom <= bandTop - GAP + 1, `low-long: the block stops at or above the band less the gap (${m.textBottom.toFixed(1)} vs ${(bandTop - GAP).toFixed(1)})`)
  assert.ok(m.textBottom >= bandTop - GAP - 12, `low-long: and is lifted no further than the clamp needs (${m.textBottom.toFixed(1)})`)
  assert.ok((m.textTop + m.textBottom) / 2 < H2 / 2 - 5, `low-long: the block is too tall for slide-centring, so its middle is above the slide's (${((m.textTop + m.textBottom) / 2).toFixed(1)})`)
  assert.ok(m.textTop >= 0, 'low-long: the block stays on the slide')
}
for (const id of ids2.filter((x) => x.startsWith('panel-') || x.startsWith('rail-'))) {
  const m = m2[id]
  assert.ok(m.railPx > 200, `${id}: a panel is drawn (${m.railPx.toFixed(0)}px)`)
  assert.ok(m.lines.every((l) => !l.border && !l.outline && !l.pseudo), `${id}: no border, outline or pseudo-element line on the slide, panel or text (${JSON.stringify(m.lines.filter((l) => l.border || l.outline || l.pseudo))})`)
  assert.ok(!/gradient\([^)]*,[^)]*,[^)]*,[^)]*,/.test(m.backgroundImage) || id.includes('rule') || id.includes('strong'), `${id}: no hard-stop line gradient (${m.backgroundImage.slice(0, 120)})`)
  assert.ok(m.edgeColours <= (id.endsWith('tinted') ? 1 : 2), `${id}: the panel's edge is a step of at most two colours, no third line colour (${m.edgeColours})`)
}
console.log('PASS statement review fixes (1080): Lower third text centred on the slide and clamped above the band; no divider line beside the panel or rail')

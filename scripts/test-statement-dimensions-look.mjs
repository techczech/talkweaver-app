// =============================================================================
// test:statement-options-look, part 2 — the statement options are separate choices (ticket 02,
// 29 Sep), reworked by the 13 October 2026 slide redesign: no box, four Backgrounds. Read from a
// real compiled deck in the real deck runtime at 1280×720 (the fixed canvas, ADR-0030), after the
// runtime's own fit pass:
//   1. Each choice changes only its own dimension: Sidebar (rail and title placement), Background
//      (Tinted / Rule / Strong colour / Tinted lower third), Alignment (left / centred, with or
//      without a title), Sidebar colour ({accent=…}). Type size, measure and line breaks stay the
//      Default's.
//   2. The text has no box and sits 20% of the slide width from the left edge without a title
//      panel, 9% right of the panel's edge with one; centred sits centred in its area.
//   3. Tinted: the whole slide in the colour, no line at the panel edge (preview 9 check). Rule: one rule
//      above the first paragraph, the page unchanged. Strong colour: the slide in the accent colour
//      with white text (beside a panel only the body area). Lower third: the bottom 38% tinted, the
//      text centred on the slide's middle, clamped 3% above the band, fitted to the white area; beside a panel it renders as Tinted.
//   4. The older options and the retired Background and Bar values render as the choices they map
//      to ({statement=tint|full} and Halo are Tinted; {statement=bar}, {claim=bar} and None are Rule;
//      a Bar value changes nothing).
//   5. Two or more paragraphs: ink then muted, both regular weight (ticket 04), same size, .9em apart as padding.
// =============================================================================

import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'

const W = 1280
const H = 720
const SPECIMEN = 'This is an important statement slide'
const BODY = 'Agents need a place to keep their work.'
const MEDIUM = 'A chatbot answers the question you asked; an agent goes and finds out what you actually needed to know first.'
const LONG = 'Most of what we call prompting is really just explaining the task properly: who it is for, what good looks like, what to leave out, and where to find the material. It is the same briefing you would give a colleague.'
const COBALT = { tint: 'rgb(232, 238, 252)', accent: 'rgb(15, 75, 216)' }
const VERMILION = { tint: 'rgb(252, 236, 227)', accent: 'rgb(194, 65, 12)' }
const EMERALD_TINT = 'rgb(228, 243, 238)'
const CLEAR = 'rgba(0, 0, 0, 0)'

// Every slide: `u-…` has no title (the heading is the statement), `t-…` sits beside a title.
const SLIDES = {
  base: '{statement}',
  'sidebar-on': '{statement}{statement-sidebar=on}',
  'sidebar-off': '{statement}{statement-sidebar=off}',
  'bg-tinted': '{statement}{statement-bg=tinted}',
  'bg-rule': '{statement}{statement-bg=rule}',
  'bg-strong': '{statement}{statement-bg=strong}',
  'bg-lower-third': '{statement}{statement-bg=lower-third}',
  'align-centred': '{statement}{statement-align=centred}',
  'colour-vermilion': '{statement}{accent=vermilion}',
  // Combinations that matter.
  'strong-centred': '{statement}{statement-bg=strong}{statement-align=centred}',
  'rule-centred': '{statement}{statement-bg=rule}{statement-align=centred}',
  'centred-sidebar': '{statement}{statement-align=centred}{statement-sidebar=on}',
  'strong-vermilion': '{statement}{statement-bg=strong}{accent=vermilion}',
  'tinted-emerald': '{statement}{bg=emerald}',
  'rule-emerald': '{statement}{statement-bg=rule}{bg=emerald}',
  'lower-third-emerald': '{statement}{statement-bg=lower-third}{bg=emerald}',
  // The retired Background and Bar values change nothing but the mapping: Halo, panel, full → Tinted; none → Rule.
  'bg-halo': '{statement}{statement-bg=halo}', 'bg-full': '{statement}{statement-bg=full}', 'bg-none': '{statement}{statement-bg=none}',
  'bar-left': '{statement}{statement-bar=left}', 'bar-top': '{statement}{statement-bar=top}', 'bar-bottom': '{statement}{statement-bar=bottom}',
  // The older options and their per-dimension spellings (must render identically).
  'p-tint': '{statement=tint}', 'd-tint': '{statement}',
  'p-bar': '{statement=bar}', 'd-bar': '{statement}{statement-bg=rule}',
  'p-full': '{statement=full}', 'd-full': '{statement}{statement-bg=tinted}',
  'p-claimbar': '{statement}{claim=bar}', 'd-claimbar': '{statement}{statement-bg=rule}',
  // A per-dimension token overrides only its own dimension of an older option.
  'tint-strong': '{statement=tint}{statement-bg=strong}', 'd-tint-strong': '{statement}{statement-bg=strong}'
}
const lines = ['---', 'title: Statement choices', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '', '## Statements', '{accent=cobalt}', '']
for (const [name, tokens] of Object.entries(SLIDES)) {
  lines.push(`### ${SPECIMEN}`, `{id=u-${name}}${tokens}`, '')
  lines.push('### Where to start', `{id=t-${name}}${tokens}`, '', BODY, '')
}
// The older Centred: without a title only (preview.11), and its spelling.
lines.push(`### ${SPECIMEN}`, '{id=u-p-centred}{statement=centred}', '', `### ${SPECIMEN}`, '{id=u-d-centred}{statement}{statement-align=centred}', '')
// Every Background at every length, with and without a title.
for (const [length, text] of Object.entries({ short: BODY, medium: MEDIUM, long: LONG })) {
  for (const bg of ['tinted', 'rule', 'strong', 'lower-third']) {
    lines.push(`### ${text}`, `{id=len-u-${length}-${bg}}{statement}{statement-bg=${bg}}`, '')
    lines.push('### Where to start', `{id=len-t-${length}-${bg}}{statement}{statement-bg=${bg}}`, '', text, '')
  }
}
for (const bg of ['tinted', 'rule', 'strong']) {
  lines.push('### Where to start', `{id=two-${bg}}{statement}{statement-bg=${bg}}{notitle}`, '', BODY, '', 'The second part of the statement.', '')
}
lines.push('### Next slide', '{id=after}', '', '- one', '- two', '')

const dir = mkdtempSync(join(tmpdir(), 'tw-statement-dimensions-'))
const outlinePath = join(dir, 'statement-dimensions-outline.md')
const source = lines.join('\n')
writeFileSync(outlinePath, source, 'utf8')
const model = await prepareSource(outlinePath, source, 'statement-dimensions', statSync(outlinePath))
assert.deepEqual(model.warnings.filter((warning) => /^(statement-unknown|accent-unknown|section-only-trigger-level)/.test(String(warning))), [],
  'every choice, the retired values and {accent=…} on a statement slide included, parses without a warning')
const htmlPath = join(dir, 'statement-dimensions.html')
writeFileSync(htmlPath, model.fullHtml, 'utf8')
const ids = [...String(model.fullHtml).matchAll(/<section class="slide[^"]*" data-id="([^"]+)"/g)].map((match) => match[1]).filter((id) => id !== 'after')

let failures = 0
const check = (condition, message) => {
  if (condition) return
  failures += 1
  console.error(`FAIL ${message}`)
}
const near = (a, b, tolerance = 0.5) => Math.abs(a - b) <= tolerance
// 0.41 ticket 04 (ADR-0039): the accent bar (.625cqw) and its gap to the words (3.0208cqw), canvas px; none under Rule.
const BAR = 0.00625 * W
const BAR_GAP = 0.030208 * W
const barOf = (shot) => (/\bstatement-bg-rule\b/.test(shot.className) ? 0 : BAR + BAR_GAP)

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
    await page.waitForTimeout(120)
    shots[id] = await page.evaluate(() => {
      const slide = document.querySelector('.stage > .slide.active')
      const stage = slide.parentElement
      const k = stage.getBoundingClientRect().width / stage.offsetWidth
      const sr = slide.getBoundingClientRect()
      const box = (el) => { const r = el.getBoundingClientRect(); return { left: (r.left - sr.left) / k, right: (r.right - sr.left) / k, top: (r.top - sr.top) / k, bottom: (r.bottom - sr.top) / k } }
      const content = slide.querySelector(':scope > .slide-content')
      const head = content.querySelector(':scope > .slide-head:not(.slide-head-quiet)')
      const ss = getComputedStyle(slide)
      const paras = [...content.querySelectorAll(':scope > p:not(.kicker):not(.slide-source)')].map((p) => {
        const cs = getComputedStyle(p)
        const before = getComputedStyle(p, '::before')
        const range = document.createRange()
        range.selectNodeContents(p)
        const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5)
        const text = { top: (Math.min(...rects.map((r) => r.top)) - sr.top) / k, bottom: (Math.max(...rects.map((r) => r.bottom)) - sr.top) / k,
          left: (Math.min(...rects.map((r) => r.left)) - sr.left) / k, right: (Math.max(...rects.map((r) => r.right)) - sr.left) / k }
        const kept = p.getAttribute('style')
        p.style.setProperty('width', '100000px', 'important')
        const measure = parseFloat(getComputedStyle(p).width)
        if (kept == null) p.removeAttribute('style'); else p.setAttribute('style', kept)
        return {
          box: box(p), text, measure, lines: new Set(rects.map((r) => Math.round(r.top))).size,
          fontSize: parseFloat(cs.fontSize), lineHeight: cs.lineHeight, background: cs.backgroundColor, color: cs.color, weight: cs.fontWeight,
          textAlign: cs.textAlign, textWrap: cs.textWrapStyle || cs.textWrap, marginTop: parseFloat(cs.marginTop) || 0,
          border: (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0),
          paddingTop: parseFloat(cs.paddingTop) || 0, borderLeft: parseFloat(cs.borderLeftWidth) || 0, paddingLeft: parseFloat(cs.paddingLeft) || 0,
          padding: (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0) + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0),
          rule: before.content === 'none' ? null : { w: parseFloat(before.width) || 0, h: parseFloat(before.height) || 0, colour: before.backgroundColor, gap: parseFloat(before.marginBottom) || 0 }
        }
      })
      return {
        className: content.className, titleLayout: slide.dataset.titleLayout, zoom: content.style.zoom || '1', fit: content.dataset.statementFit || '',
        slideBg: ss.backgroundColor, slideBgImage: ss.backgroundImage, paddingBottom: parseFloat(ss.paddingBottom) || 0, paddingTop: parseFloat(ss.paddingTop) || 0,
        content: box(content),
        head: head ? box(head) : null, headText: head?.textContent.replace(/ /g, ' ').trim() ?? '',
        column: (() => {
          if (slide.dataset.titleLayout !== 'left') return null
          const cs = getComputedStyle(content)
          const cr = box(content)
          const gap = parseFloat(cs.columnGap)
          return { left: cr.left + parseFloat(cs.gridTemplateColumns.split(' ')[0]) + gap, right: cr.right - parseFloat(cs.paddingRight), gap, panelEdge: cr.left + parseFloat(cs.gridTemplateColumns.split(' ')[0]) }
        })(),
        paras
      }
    })
  }
  await page.close()
} finally {
  await browser.close()
}

const p0 = (id) => shots[id].paras[0]
const sameText = (a, b, id) => {
  check(near(a.fontSize, b.fontSize, 0.05), `${id}: type ${a.fontSize}px equals the Default's ${b.fontSize}px`)
  check(a.lineHeight === b.lineHeight, `${id}: line height ${a.lineHeight} equals the Default's ${b.lineHeight}`)
  check(near(a.measure, b.measure, 1), `${id}: measure ${a.measure}px equals the Default's ${b.measure}px`)
  check(a.lines === b.lines, `${id}: ${a.lines} line(s), the Default has ${b.lines}`)
}
const WHITE = 'rgb(255, 255, 255)'
const hasPanel = (shot) => shot.titleLayout === 'left'
// The text's left edge: 20% of the slide from its left edge without a panel, 9% right of the panel's edge with one.
const leftEdgeOk = (shot, id) => {
  const want = hasPanel(shot) ? shot.column.panelEdge + 0.09 * W : 0.2 * W
  check(near(shot.paras[0].text.left, want + barOf(shot), 1.5), `${id}: the text starts the bar and its gap right of the line: ${hasPanel(shot) ? '9% right of the panel edge' : '20% from the left edge'} (${shot.paras[0].text.left.toFixed(1)} vs ${want.toFixed(1)})`)
}
const accentLine = (shot) => shot.slideBgImage.includes(COBALT.accent)

for (const ctx of ['u', 't']) {
  const titled = ctx === 't'
  const base = shots[`${ctx}-base`]
  const baseP = base.paras[0]
  // The base: Tinted in the section colour, aligned; the sidebar follows the title.
  check(base.titleLayout === (titled ? 'left' : 'hidden'), `${ctx}-base: title layout ${base.titleLayout}`)
  check(base.slideBg === COBALT.tint, `${ctx}-base: Tinted — the whole slide in the section colour (${base.slideBg})`)
  check(baseP.background === CLEAR && near(baseP.border, BAR, 0.1) && near(baseP.padding, BAR_GAP, 0.1), `${ctx}-base: no box round the text, only the accent bar and its gap`)
  check(base.className === 'slide-content layout-statement', `${ctx}-base: the defaults stamp nothing (${base.className})`)
  check(!accentLine(base), `${ctx}-base: no accent line at the panel edge (${base.slideBgImage.slice(0, 70)})`)
  check(baseP.textAlign === 'left' && baseP.color === 'rgb(16, 20, 24)', `${ctx}-base: aligned left, in ink (${baseP.color})`)
  leftEdgeOk(base, `${ctx}-base`)

  // 1. Each choice changes only its own dimension.
  const on = shots[`${ctx}-sidebar-on`]
  check(on.titleLayout === 'left', `${ctx}-sidebar-on: the rail (title layout ${on.titleLayout})`)
  check(titled ? on.headText === 'Where to start' : on.headText === '', `${ctx}-sidebar-on: ${titled ? 'the title is in the rail' : 'the rail is empty'} ("${on.headText}")`)
  check(on.slideBg === COBALT.tint && !accentLine(on), `${ctx}-sidebar-on: Tinted with no line at the panel edge (${on.slideBg})`)
  check(!/statement-(bg|bar|centred)/.test(on.className), `${ctx}-sidebar-on: stamps no other choice (${on.className})`)
  leftEdgeOk(on, `${ctx}-sidebar-on`)
  if (titled) sameText(on.paras[0], baseP, `${ctx}-sidebar-on`)
  else {
    check(near(on.paras[0].fontSize, p0('t-base').fontSize, 0.05), `u-sidebar-on: the statement beside the empty rail takes the size beside a title (${on.paras[0].fontSize} vs ${p0('t-base').fontSize}px)`)
    check(on.paras[0].box.right <= W, 'u-sidebar-on: the statement stays on the slide')
  }
  const off = shots[`${ctx}-sidebar-off`]
  check(off.titleLayout === (titled ? 'top' : 'hidden'), `${ctx}-sidebar-off: ${titled ? 'the title goes to the top' : 'no title, no rail'} (${off.titleLayout})`)
  check(off.slideBg === COBALT.tint && !accentLine(off), `${ctx}-sidebar-off: Tinted, no panel line (${off.slideBgImage.slice(0, 40)})`)
  if (titled) {
    check(off.head && off.head.bottom <= off.paras[0].box.top, 't-sidebar-off: the title sits above the statement')
    check(near(off.paras[0].fontSize, p0('u-base').fontSize, 0.05), `t-sidebar-off: the full-width statement takes the statement size (${off.paras[0].fontSize}px)`)
  } else sameText(off.paras[0], baseP, 'u-sidebar-off')
  leftEdgeOk(off, `${ctx}-sidebar-off`)

  // Background.
  for (const name of ['bg-tinted', 'bg-halo', 'bg-full']) {
    const shot = shots[`${ctx}-${name}`]
    check(JSON.stringify(shot) === JSON.stringify(base), `${ctx}-${name}: renders exactly as the Default (Tinted)`)
  }
  const rule = shots[`${ctx}-bg-rule`]
  const rp = rule.paras[0]
  check(/\bstatement-bg-rule\b/.test(rule.className), `${ctx}-bg-rule: stamps statement-bg-rule (${rule.className})`)
  check(rule.slideBg !== COBALT.tint && rule.titleLayout === base.titleLayout, `${ctx}-bg-rule: the normal page, the sidebar unchanged (${rule.slideBg})`)
  if (titled) check(rule.slideBgImage.includes(COBALT.tint) && !accentLine(rule), `t-bg-rule: the panel keeps its tint (${rule.slideBgImage.slice(0, 60)})`)
  check(rp.rule && near(rp.rule.w, 0.06 * W, 0.6) && near(rp.rule.h, 0.004 * H, 0.6) && rp.rule.colour === COBALT.accent && near(rp.rule.gap, 0.026 * H, 0.6),
    `${ctx}-bg-rule: one accent rule, 6cqw × .4cqh, 2.6cqh above the text (${JSON.stringify(rp.rule)})`)
  check(baseP.rule === null, `${ctx}-base: no rule`)
  check(rp.background === CLEAR && rp.border === 0 && rp.padding === 0, `${ctx}-bg-rule: no box`)
  sameText(rp, baseP, `${ctx}-bg-rule`)
  leftEdgeOk(rule, `${ctx}-bg-rule`)
  const strong = shots[`${ctx}-bg-strong`]
  check(/\bstatement-bg-strong\b/.test(strong.className), `${ctx}-bg-strong: stamps statement-bg-strong (${strong.className})`)
  check(strong.paras[0].color === WHITE && strong.paras[0].background === CLEAR, `${ctx}-bg-strong: white text, no box (${strong.paras[0].color})`)
  if (titled) check(strong.slideBgImage.includes(COBALT.tint) && strong.slideBgImage.includes(COBALT.accent), `t-bg-strong: the panel stays the tint, the body is the accent (${strong.slideBgImage.slice(0, 80)})`)
  else check(strong.slideBg === COBALT.accent, `u-bg-strong: the whole slide in the accent colour (${strong.slideBg})`)
  sameText(strong.paras[0], baseP, `${ctx}-bg-strong`)
  leftEdgeOk(strong, `${ctx}-bg-strong`)
  const low = shots[`${ctx}-bg-lower-third`]
  check(/\bstatement-bg-lower-third\b/.test(low.className), `${ctx}-bg-lower-third: stamps statement-bg-lower-third (${low.className})`)
  if (titled) {
    // Not offered beside a panel: renders as Tinted.
    check(low.slideBg === COBALT.tint && !accentLine(low) && low.paddingBottom === base.paddingBottom, `t-bg-lower-third: beside a title panel it renders as Tinted (${low.slideBg}, padding ${low.paddingBottom})`)
    sameText(low.paras[0], baseP, 't-bg-lower-third')
  } else {
    check(low.slideBg !== COBALT.tint && low.slideBgImage.includes(COBALT.tint), `u-bg-lower-third: the normal page with a tinted band (${low.slideBg}, ${low.slideBgImage.slice(0, 60)})`)
    check(near(low.paddingBottom, 0.41 * H, 0.6) && low.paddingTop === 0, `u-bg-lower-third: the band (bottom 38%) plus the 3% gap is the padding (padding ${low.paddingBottom} / ${low.paddingTop})`)
    check(low.content.bottom <= H - 0.38 * H + 1, `u-bg-lower-third: the content box follows the white area (bottom ${low.content.bottom.toFixed(0)})`)
    const lp = low.paras[0]
    // Centred on the slide's middle, unless the block is too tall for that: then its bottom stops 3% above the band.
    const limit = H - 0.38 * H - 0.03 * H
    const textH = lp.box.bottom - lp.box.top
    const want = Math.min(H / 2, limit - textH / 2)
    check(near((lp.box.top + lp.box.bottom) / 2, want, 6) && lp.box.bottom <= limit + 6, `u-bg-lower-third: the text is centred on the slide, clamped above the band (centre ${((lp.box.top + lp.box.bottom) / 2).toFixed(0)} vs ${want.toFixed(0)})`)
    sameText(lp, baseP, 'u-bg-lower-third')
    leftEdgeOk(low, 'u-bg-lower-third')
  }

  // Alignment: centred and balanced, with or without a title; no left margin.
  const centred = shots[`${ctx}-align-centred`]
  const cp = centred.paras[0]
  check(cp.textAlign === 'center' && cp.textWrap === 'balance', `${ctx}-align-centred: centred, balanced (${cp.textAlign}, ${cp.textWrap})`)
  check(/\bstatement-centred\b/.test(centred.className), `${ctx}-align-centred: stamps statement-centred`)
  check(centred.titleLayout === base.titleLayout && centred.slideBg === COBALT.tint && cp.background === CLEAR, `${ctx}-align-centred: sidebar and Tinted unchanged`)
  check(near(cp.fontSize, baseP.fontSize, 0.05) && near(cp.measure, baseP.measure, 1), `${ctx}-align-centred: type and measure unchanged`)
  const area = centred.column ? { left: centred.column.left, right: centred.column.right } : { left: 0, right: W }
  check(near((cp.box.left + cp.box.right) / 2, (area.left + area.right) / 2, 3), `${ctx}-align-centred: the block centres in its area (${((cp.box.left + cp.box.right) / 2).toFixed(0)} vs ${((area.left + area.right) / 2).toFixed(0)})`)
  check(near((cp.text.left + cp.text.right) / 2, (area.left + area.right) / 2 + barOf(centred) / 2, 3), `${ctx}-align-centred: the lines centre in the same area, the bar and its gap to their left`)
  const centredSidebar = shots[`${ctx}-centred-sidebar`]
  check(centredSidebar.titleLayout === 'left' && centredSidebar.paras[0].textAlign === 'center', `${ctx}-centred-sidebar: centred beside the rail`)
  const csp = centredSidebar.paras[0]
  const colCentre = (centredSidebar.column.left + centredSidebar.column.right) / 2
  check(near((csp.box.left + csp.box.right) / 2, colCentre, 3), `${ctx}-centred-sidebar: the text centres in the content column (${((csp.box.left + csp.box.right) / 2).toFixed(0)} vs ${colCentre.toFixed(0)})`)
  const ruleCentred = shots[`${ctx}-rule-centred`]
  check(ruleCentred.paras[0].textAlign === 'center' && ruleCentred.paras[0].rule && ruleCentred.paras[0].rule.w > 0, `${ctx}-rule-centred: centred with its rule`)
  const strongCentred = shots[`${ctx}-strong-centred`]
  check(strongCentred.paras[0].textAlign === 'center' && strongCentred.paras[0].color === WHITE, `${ctx}-strong-centred: centred, white`)

  // Sidebar colour: panel line, tint, strong colour and rule together; the section's colour by default.
  const colour = shots[`${ctx}-colour-vermilion`]
  check(colour.slideBg === VERMILION.tint, `${ctx}-colour-vermilion: Tinted takes the colour (${colour.slideBg})`)
  if (titled) check(!colour.slideBgImage.includes(VERMILION.accent), `t-colour-vermilion: no panel line (${colour.slideBgImage.slice(0, 80)})`)
  sameText(colour.paras[0], baseP, `${ctx}-colour-vermilion`)
  const strongV = shots[`${ctx}-strong-vermilion`]
  check(titled ? strongV.slideBgImage.includes(VERMILION.accent) : strongV.slideBg === VERMILION.accent, `${ctx}-strong-vermilion: Strong follows the sidebar colour (${strongV.slideBg})`)

  // {bg=…}: the colour Tinted and the lower third use in place of the section tint; the Rule keeps the page it paints.
  check(shots[`${ctx}-tinted-emerald`].slideBg === EMERALD_TINT, `${ctx}-tinted-emerald: the authored colour paints the whole slide (${shots[`${ctx}-tinted-emerald`].slideBg})`)
  check(shots[`${ctx}-rule-emerald`].slideBg === EMERALD_TINT, `${ctx}-rule-emerald: Rule is the normal page; an authored colour paints it as on any slide (${shots[`${ctx}-rule-emerald`].slideBg})`)
  const lowEmerald = shots[`${ctx}-lower-third-emerald`]
  check(titled ? lowEmerald.slideBg === EMERALD_TINT : lowEmerald.slideBgImage.includes(EMERALD_TINT), `${ctx}-lower-third-emerald: the authored colour is the band (${lowEmerald.slideBg}, ${lowEmerald.slideBgImage.slice(0, 70)})`)

  // 4. The older options render exactly as their per-dimension spellings; a Bar value changes nothing.
  for (const name of ['tint', 'bar', 'full', 'claimbar']) {
    const a = shots[`${ctx}-p-${name}`]
    const b = shots[`${ctx}-d-${name}`]
    check(JSON.stringify(a) === JSON.stringify(b), `${ctx}: {${name}} renders exactly as its separate choices (${a.className} vs ${b.className})`)
  }
  check(JSON.stringify(shots[`${ctx}-bg-none`]) === JSON.stringify(rule), `${ctx}-bg-none: the retired None renders as Rule`)
  for (const side of ['left', 'top', 'bottom']) {
    check(JSON.stringify(shots[`${ctx}-bar-${side}`]) === JSON.stringify(base), `${ctx}-bar-${side}: a retired Bar value changes nothing`)
  }
  check(JSON.stringify(shots[`${ctx}-tint-strong`]) === JSON.stringify(shots[`${ctx}-d-tint-strong`]), `${ctx}: {statement=tint}{statement-bg=strong} is Strong — the choice overrides only the background`)
}
check(JSON.stringify(shots['u-p-centred']) === JSON.stringify(shots['u-d-centred']), 'the older Centred without a title renders as Alignment Centred')

// Every Background at every length: nothing zooms, the text stays on the slide, and the lower third's
// text stays out of the band (the fit pass reads the white area).
for (const id of ids.filter((candidate) => candidate.startsWith('len-'))) {
  const [, ctx, length, ...bgParts] = id.split('-')
  const bg = bgParts.join('-')
  const shot = shots[id]
  const p = shot.paras[0]
  check(shot.zoom === '1', `${id}: nothing zooms`)
  check(p.box.top >= 0 && p.box.bottom <= H, `${id}: the text stays on the slide (${p.box.top.toFixed(0)}–${p.box.bottom.toFixed(0)})`)
  check(p.fontSize >= Math.max(31, 0.034 * W) - 0.05 || ctx === 't', `${id}: type ${p.fontSize}px stays at or above the quote size`)
  if (bg === 'lower-third' && ctx === 'u') check(p.text.bottom <= H - 0.38 * H + 1, `${id}: the text ends above the band (${p.text.bottom.toFixed(0)} vs ${(H - 0.38 * H).toFixed(0)})`)
  if (bg === 'strong') check(p.color === WHITE, `${id}: white on the accent colour`)
}

// 5. Two or more paragraphs.
for (const bg of ['tinted', 'rule', 'strong']) {
  const shot = shots[`two-${bg}`]
  check(shot.paras.length === 2, `two-${bg}: a two-part statement`)
  const [first, second] = shot.paras
  check(first.weight === '400' && second.weight === '400', `two-${bg}: both parts regular weight, the lead told by ink (${first.weight}, ${second.weight})`)
  check(first.color === (bg === 'strong' ? WHITE : 'rgb(16, 20, 24)') && second.color === (bg === 'strong' ? 'rgba(255, 255, 255, 0.8)' : 'rgb(92, 101, 112)'),
    `two-${bg}: the lead is ink (white on Strong), the rest muted (80% white on Strong) (${first.color} / ${second.color})`)
  check(near(second.paddingTop, 0.9 * second.fontSize, 0.6) && second.marginTop === 0, `two-${bg}: .9em between the parts, as padding so the bar runs unbroken (${second.paddingTop}px at ${second.fontSize}px)`)
  check(first.background === CLEAR && second.background === CLEAR && near(first.padding + second.padding - second.paddingTop, bg === 'rule' ? 0 : 2 * BAR_GAP, 0.2), `two-${bg}: one text block, no box (the bar's gap and the part gap only)`)
  check(bg !== 'rule' || (first.rule !== null && second.rule === null), `two-${bg}: the rule sits above the first part only`)
}

if (failures) {
  console.error(`${failures} statement choice check(s) failed`)
  process.exit(1)
}
console.log(`PASS statement choices at 1280x720: ${ids.length} slides — each choice changes only its own dimension (sidebar, Tinted / Rule / Strong colour / lower third, alignment, sidebar colour), 20% and 9% left edges, no box, the older and retired values render as the choices they map to, two-part statements`)

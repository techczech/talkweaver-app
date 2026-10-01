// =============================================================================
// test:statement-options-look, part 2 — ticket 02 (Dominik, 29 Sep): the statement options are
// separate choices. Read from a real compiled deck in the real deck runtime at 1280×720 (the fixed
// canvas, ADR-0030), after the runtime's own fit pass:
//   1. Each choice changes only its own dimension: Sidebar (rail and title placement), Background
//      (Halo panel / Full slide / None), Alignment (left / centred, with or without a title), Bar
//      (none / left / top / bottom), Sidebar colour ({accent=…}: rail, halo, full and bar together;
//      the section's colour by default). Type size, measure and line breaks stay the Default's.
//   2. The older one-word options are presets: each renders exactly as its per-dimension spelling.
//   3. Top and bottom bars sit clear of the text at every length (the padding between), on the
//      first / last part of a multi-part statement; bar + Full background is legible.
//   4. The combinations that matter: Halo + Top bar, Full + Bottom bar, Centred + sidebar (with a
//      title and with an empty rail), a sidebar colour.
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
  'bg-full': '{statement}{statement-bg=full}',
  'bg-none': '{statement}{statement-bg=none}',
  'bg-halo': '{statement}{statement-bg=halo}',
  'align-centred': '{statement}{statement-align=centred}',
  'bar-left': '{statement}{statement-bar=left}',
  'bar-top': '{statement}{statement-bar=top}',
  'bar-bottom': '{statement}{statement-bar=bottom}',
  'colour-vermilion': '{statement}{accent=vermilion}',
  // Combinations that matter.
  'halo-top': '{statement}{statement-bar=top}',
  'full-bottom': '{statement}{statement-bg=full}{statement-bar=bottom}',
  'centred-sidebar': '{statement}{statement-align=centred}{statement-sidebar=on}',
  'full-colour-left': '{statement}{statement-bg=full}{accent=vermilion}{statement-bar=left}',
  'none-top-emerald': '{statement}{statement-bg=none}{statement-bar=top}{bg=emerald}',
  'halo-bottom-emerald': '{statement}{statement-bar=bottom}{bg=emerald}',
  // The older options and their per-dimension spellings (must render identically).
  'p-tint': '{statement=tint}', 'd-tint': '{statement}{statement-bar=left}',
  'p-bar': '{statement=bar}', 'd-bar': '{statement}{statement-bg=none}{statement-bar=left}',
  'p-full': '{statement=full}', 'd-full': '{statement}{statement-bg=full}',
  'p-claimbar': '{statement}{claim=bar}', 'd-claimbar': '{statement}{statement-bg=none}{statement-bar=left}',
  // A per-dimension token overrides only its own dimension of an older option.
  'tint-top': '{statement=tint}{statement-bar=top}', 'd-tint-top': '{statement}{statement-bar=top}'
}
const lines = ['---', 'title: Statement choices', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '', '## Statements', '{accent=cobalt}', '']
for (const [name, tokens] of Object.entries(SLIDES)) {
  lines.push(`### ${SPECIMEN}`, `{id=u-${name}}${tokens}`, '')
  lines.push('### Where to start', `{id=t-${name}}${tokens}`, '', BODY, '')
}
// The older Centred: without a title only (preview.11), and its spelling.
lines.push(`### ${SPECIMEN}`, '{id=u-p-centred}{statement=centred}', '', `### ${SPECIMEN}`, '{id=u-d-centred}{statement}{statement-align=centred}', '')
// Bars at every length, with and without a title, on each background; a two-part statement.
for (const [length, text] of Object.entries({ short: BODY, medium: MEDIUM, long: LONG })) {
  for (const bar of ['top', 'bottom']) {
    for (const bg of ['halo', 'full', 'none']) {
      const tokens = `{statement}{statement-bar=${bar}}${bg === 'halo' ? '' : `{statement-bg=${bg}}`}`
      lines.push(`### ${text}`, `{id=len-u-${length}-${bar}-${bg}}${tokens}`, '')
      lines.push('### Where to start', `{id=len-t-${length}-${bar}-${bg}}${tokens}`, '', text, '')
    }
  }
}
for (const bar of ['top', 'bottom', 'left']) {
  lines.push('### Where to start', `{id=two-${bar}}{statement}{statement-bar=${bar}}{notitle}`, '', BODY, '', 'The second part of the statement.', '')
}
lines.push('### Next slide', '{id=after}', '', '- one', '- two', '')

const dir = mkdtempSync(join(tmpdir(), 'tw-statement-dimensions-'))
const outlinePath = join(dir, 'statement-dimensions-outline.md')
const source = lines.join('\n')
writeFileSync(outlinePath, source, 'utf8')
const model = await prepareSource(outlinePath, source, 'statement-dimensions', statSync(outlinePath))
assert.deepEqual(model.warnings.filter((warning) => /^(statement-unknown|accent-unknown|section-only-trigger-level)/.test(String(warning))), [],
  'every choice, {accent=…} on a statement slide included, parses without a warning')
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
          fontSize: parseFloat(cs.fontSize), lineHeight: cs.lineHeight, background: cs.backgroundColor, color: cs.color,
          textAlign: cs.textAlign, textWrap: cs.textWrapStyle || cs.textWrap,
          border: { left: parseFloat(cs.borderLeftWidth) || 0, top: parseFloat(cs.borderTopWidth) || 0, bottom: parseFloat(cs.borderBottomWidth) || 0 },
          borderColor: { left: cs.borderLeftColor, top: cs.borderTopColor, bottom: cs.borderBottomColor },
          padding: { left: parseFloat(cs.paddingLeft), top: parseFloat(cs.paddingTop), bottom: parseFloat(cs.paddingBottom) }
        }
      })
      return {
        className: content.className, titleLayout: slide.dataset.titleLayout, zoom: content.style.zoom || '1',
        slideBg: ss.backgroundColor, slideBgImage: ss.backgroundImage, tint: ss.getPropertyValue('--tint').trim(),
        head: head ? box(head) : null, headText: head?.textContent.replace(/\u00a0/g, ' ').trim() ?? '',
        column: (() => {
          if (slide.dataset.titleLayout !== 'left') return null
          const cs = getComputedStyle(content)
          const cr = box(content)
          return { left: cr.left + parseFloat(cs.gridTemplateColumns.split(' ')[0]) + parseFloat(cs.columnGap), right: cr.right - parseFloat(cs.paddingRight) }
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
const railOf = (shot) => shot.slideBgImage.match(/rgba?\([^)]*\)/)?.[0] ?? ''
const sameText = (a, b, id) => {
  check(near(a.fontSize, b.fontSize, 0.05), `${id}: type ${a.fontSize}px equals the Default's ${b.fontSize}px`)
  check(a.lineHeight === b.lineHeight, `${id}: line height ${a.lineHeight} equals the Default's ${b.lineHeight}`)
  check(near(a.measure, b.measure, 1), `${id}: measure ${a.measure}px equals the Default's ${b.measure}px`)
  check(a.lines === b.lines, `${id}: ${a.lines} line(s), the Default has ${b.lines}`)
}

for (const ctx of ['u', 't']) {
  const titled = ctx === 't'
  const base = shots[`${ctx}-base`]
  const baseP = base.paras[0]
  // The base: Halo in the section colour, aligned, no bar; the sidebar follows the title.
  check(base.titleLayout === (titled ? 'left' : 'hidden'), `${ctx}-base: title layout ${base.titleLayout}`)
  check(baseP.background === COBALT.tint && baseP.border.left + baseP.border.top + baseP.border.bottom === 0, `${ctx}-base: the halo, no bar`)

  // 1. Each choice changes only its own dimension.
  // Sidebar: With sidebar paints the rail in the section colour (with the title in it, or empty);
  // No sidebar runs full width (a painted title goes to the top).
  const on = shots[`${ctx}-sidebar-on`]
  check(on.titleLayout === 'left', `${ctx}-sidebar-on: the rail (title layout ${on.titleLayout})`)
  check(railOf(on) === COBALT.tint, `${ctx}-sidebar-on: the rail is painted in the section colour (got ${on.slideBgImage.slice(0, 60)})`)
  check(on.paras[0].box.left >= 0.26 * W, `${ctx}-sidebar-on: the statement sits in the content column (left ${on.paras[0].box.left.toFixed(0)})`)
  check(titled ? on.headText === 'Where to start' : on.headText === '', `${ctx}-sidebar-on: ${titled ? 'the title is in the rail' : 'the rail is empty'} ("${on.headText}")`)
  check(!/statement-(bg|bar|centred)/.test(on.className), `${ctx}-sidebar-on: stamps no other choice (${on.className})`)
  check(on.paras[0].background === COBALT.tint && on.paras[0].textAlign === 'left' && on.paras[0].border.left === 0, `${ctx}-sidebar-on: halo, aligned, no bar unchanged`)
  if (titled) sameText(on.paras[0], baseP, `${ctx}-sidebar-on`)
  else {
    // The empty rail sets the statement as beside a title (the column's size), and fits.
    check(near(on.paras[0].fontSize, p0('t-base').fontSize, 0.05), `u-sidebar-on: the statement beside the empty rail takes the size beside a title (${on.paras[0].fontSize} vs ${p0('t-base').fontSize}px)`)
    check(on.paras[0].box.right <= W, 'u-sidebar-on: the statement stays on the slide')
  }
  const off = shots[`${ctx}-sidebar-off`]
  check(off.titleLayout === (titled ? 'top' : 'hidden'), `${ctx}-sidebar-off: ${titled ? 'the title goes to the top' : 'no title, no rail'} (${off.titleLayout})`)
  check(off.slideBgImage === 'none', `${ctx}-sidebar-off: no rail painted (${off.slideBgImage.slice(0, 40)})`)
  check(off.paras[0].background === COBALT.tint && off.paras[0].border.left === 0, `${ctx}-sidebar-off: halo, no bar unchanged`)
  if (titled) {
    check(off.head && off.head.bottom <= off.paras[0].box.top, `t-sidebar-off: the title sits above the statement`)
    check(near(off.paras[0].box.left, W - off.paras[0].box.right, 2), `t-sidebar-off: the statement is centred across the full width (${off.paras[0].box.left.toFixed(0)} / ${(W - off.paras[0].box.right).toFixed(0)})`)
    check(near(off.paras[0].fontSize, p0('u-base').fontSize, 0.05), `t-sidebar-off: the full-width statement takes the statement size (${off.paras[0].fontSize}px)`)
  } else sameText(off.paras[0], baseP, 'u-sidebar-off')

  // Background.
  const full = shots[`${ctx}-bg-full`]
  check(full.slideBg === COBALT.tint && full.paras[0].background === CLEAR, `${ctx}-bg-full: the whole slide in the section colour, no panel (${full.slideBg}, ${full.paras[0].background})`)
  check(full.titleLayout === base.titleLayout, `${ctx}-bg-full: the sidebar is unchanged`)
  const none = shots[`${ctx}-bg-none`]
  check(none.paras[0].background === CLEAR && none.slideBg === base.slideBg, `${ctx}-bg-none: no colour behind the text, the slide unchanged`)
  check(shots[`${ctx}-bg-halo`].paras[0].background === COBALT.tint, `${ctx}-bg-halo: the explicit Halo is the Default`)
  for (const name of ['bg-full', 'bg-none', 'bg-halo']) {
    const shot = shots[`${ctx}-${name}`]
    sameText(shot.paras[0], baseP, `${ctx}-${name}`)
    check(near(shot.paras[0].box.left, baseP.box.left, 1) && near(shot.paras[0].box.top, baseP.box.top, 1), `${ctx}-${name}: the text sits where the Default's does`)
    check(shot.paras[0].border.left + shot.paras[0].border.top + shot.paras[0].border.bottom === 0, `${ctx}-${name}: no bar`)
  }

  // Alignment: centred and balanced, with or without a title.
  const centred = shots[`${ctx}-align-centred`]
  check(centred.paras[0].textAlign === 'center' && centred.paras[0].textWrap === 'balance', `${ctx}-align-centred: centred, balanced (${centred.paras[0].textAlign}, ${centred.paras[0].textWrap})`)
  check(/\bstatement-centred\b/.test(centred.className), `${ctx}-align-centred: stamps statement-centred`)
  check(centred.titleLayout === base.titleLayout && centred.paras[0].background === COBALT.tint, `${ctx}-align-centred: sidebar and halo unchanged`)
  check(near(centred.paras[0].fontSize, baseP.fontSize, 0.05) && near(centred.paras[0].measure, baseP.measure, 1), `${ctx}-align-centred: type and measure unchanged`)
  check(baseP.textAlign === 'left', `${ctx}-base: aligned left`)

  // Bar: .22em in the accent, on its own side only.
  for (const side of ['left', 'top', 'bottom']) {
    const shot = shots[`${ctx}-bar-${side}`]
    const p = shot.paras[0]
    const want = 0.22 * p.fontSize
    check(p.border[side] === Math.floor(want) || near(p.border[side], want, 0.6), `${ctx}-bar-${side}: the bar is .22em (got ${p.border[side]}px at ${p.fontSize}px)`)
    check(p.borderColor[side] === COBALT.accent, `${ctx}-bar-${side}: the bar is the section accent (${p.borderColor[side]})`)
    for (const other of ['left', 'top', 'bottom'].filter((candidate) => candidate !== side)) check(p.border[other] === 0, `${ctx}-bar-${side}: no ${other} bar`)
    check(p.background === COBALT.tint && shot.titleLayout === base.titleLayout, `${ctx}-bar-${side}: halo and sidebar unchanged`)
    sameText(p, baseP, `${ctx}-bar-${side}`)
  }

  // Sidebar colour: rail, halo, full colour and bar together; the section's colour by default.
  const colour = shots[`${ctx}-colour-vermilion`]
  check(colour.paras[0].background === VERMILION.tint, `${ctx}-colour-vermilion: the halo takes the colour (${colour.paras[0].background})`)
  if (titled) check(railOf(colour) === VERMILION.tint, `t-colour-vermilion: the rail takes the colour (${colour.slideBgImage.slice(0, 60)})`)
  check(railOf(base) === (titled ? COBALT.tint : ''), `${ctx}-base: the rail is the section colour by default`)
  sameText(colour.paras[0], baseP, `${ctx}-colour-vermilion`)
  const fullColour = shots[`${ctx}-full-colour-left`]
  check(fullColour.slideBg === VERMILION.tint && fullColour.paras[0].borderColor.left === VERMILION.accent,
    `${ctx}-full-colour-left: the full colour and the bar follow the sidebar colour (${fullColour.slideBg}, ${fullColour.paras[0].borderColor.left})`)

  // 4. Combinations.
  const haloTop = shots[`${ctx}-halo-top`].paras[0]
  check(haloTop.background === COBALT.tint && haloTop.border.top > 0 && haloTop.border.left === 0, `${ctx}-halo-top: the halo with the bar above`)
  const fullBottom = shots[`${ctx}-full-bottom`]
  check(fullBottom.slideBg === COBALT.tint && fullBottom.paras[0].background === CLEAR && fullBottom.paras[0].border.bottom > 0,
    `${ctx}-full-bottom: the whole slide in the colour with the bar below`)
  const centredSidebar = shots[`${ctx}-centred-sidebar`]
  check(centredSidebar.titleLayout === 'left' && centredSidebar.paras[0].textAlign === 'center', `${ctx}-centred-sidebar: centred beside the rail`)
  const cp = centredSidebar.paras[0]
  if (!centredSidebar.column) check(false, `${ctx}-centred-sidebar: no content column beside a rail`)
  else {
    const colCentre = (centredSidebar.column.left + centredSidebar.column.right) / 2
    check(near((cp.box.left + cp.box.right) / 2, colCentre, 3), `${ctx}-centred-sidebar: the text centres in the content column (${((cp.box.left + cp.box.right) / 2).toFixed(0)} vs ${colCentre.toFixed(0)})`)
    check(near((cp.text.left + cp.text.right) / 2, colCentre, 3), `${ctx}-centred-sidebar: the lines centre in the content column`)
  }
  const noneTop = shots[`${ctx}-none-top-emerald`]
  check(noneTop.paras[0].background === CLEAR && noneTop.slideBg === EMERALD_TINT && noneTop.paras[0].border.top > 0,
    `${ctx}-none-top-emerald: no panel, the authored colour paints the slide, the bar above (${noneTop.slideBg})`)
  const haloBottom = shots[`${ctx}-halo-bottom-emerald`]
  check(haloBottom.paras[0].background === EMERALD_TINT && haloBottom.slideBg !== EMERALD_TINT && haloBottom.paras[0].border.bottom > 0,
    `${ctx}-halo-bottom-emerald: the authored colour on the halo, the slide white, the bar below`)

  // 2. The older options render exactly as their per-dimension spellings.
  for (const name of ['tint', 'bar', 'full', 'claimbar']) {
    const a = shots[`${ctx}-p-${name}`]
    const b = shots[`${ctx}-d-${name}`]
    check(JSON.stringify({ ...a, className: '' }) === JSON.stringify({ ...b, className: '' }) && a.className === b.className,
      `${ctx}: {${name}} renders exactly as its separate choices (${a.className} vs ${b.className})`)
  }
  const tintTop = shots[`${ctx}-tint-top`]
  const dTintTop = shots[`${ctx}-d-tint-top`]
  check(JSON.stringify(tintTop) === JSON.stringify(dTintTop), `${ctx}: {statement=tint}{statement-bar=top} is Halo + Top — the choice overrides only the bar`)
}
check(JSON.stringify(shots['u-p-centred']) === JSON.stringify(shots['u-d-centred']), 'the older Centred without a title renders as Alignment Centred')

// 3. Bars clear the text at every length, with and without a title, on every background.
for (const id of ids.filter((candidate) => candidate.startsWith('len-'))) {
  const [, ctx, , bar, bg] = id.split('-')
  const shot = shots[id]
  const p = shot.paras[0]
  check(shot.zoom === '1', `${id}: nothing zooms`)
  if (bar === 'top') {
    check(p.border.top > 0, `${id}: the bar is drawn above`)
    check(p.text.top - (p.box.top + p.border.top) >= 0.7 * p.fontSize - 1, `${id}: the text clears the top bar by the padding (${(p.text.top - p.box.top - p.border.top).toFixed(1)}px at ${p.fontSize}px)`)
  } else {
    check(p.border.bottom > 0, `${id}: the bar is drawn below`)
    check((p.box.bottom - p.border.bottom) - p.text.bottom >= 0.7 * p.fontSize - 1, `${id}: the text clears the bottom bar by the padding (${(p.box.bottom - p.border.bottom - p.text.bottom).toFixed(1)}px at ${p.fontSize}px)`)
  }
  check(p.box.top >= 0 && p.box.bottom <= H, `${id}: the box and its bar stay on the slide (${p.box.top.toFixed(0)}–${p.box.bottom.toFixed(0)})`)
  if (bg === 'full') {
    // Legible: the ink and the bar both stand off the full colour.
    const lum = (rgb) => {
      const [r, g, b] = rgb.match(/\d+/g).slice(0, 3).map((v) => { const c = Number(v) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 })
      return 0.2126 * r + 0.7152 * g + 0.0722 * b
    }
    const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) }
    check(contrast(p.color, shot.slideBg) >= 7, `${id}: text on the full colour is legible (contrast ${contrast(p.color, shot.slideBg).toFixed(1)})`)
    check(contrast(p.borderColor[bar], shot.slideBg) >= 3, `${id}: the bar stands off the full colour (contrast ${contrast(p.borderColor[bar], shot.slideBg).toFixed(1)})`)
  }
}
for (const bar of ['top', 'bottom', 'left']) {
  const shot = shots[`two-${bar}`]
  check(shot.paras.length === 2, `two-${bar}: a two-part statement`)
  const [first, second] = shot.paras
  if (bar === 'top') check(first.border.top > 0 && second.border.top === 0, `two-top: the top bar sits over the first part only`)
  if (bar === 'bottom') check(first.border.bottom === 0 && second.border.bottom > 0, `two-bottom: the bottom bar sits under the last part only`)
  if (bar === 'left') check(first.border.left > 0 && second.border.left > 0, `two-left: the left bar runs beside both parts`)
}

if (failures) {
  console.error(`${failures} statement choice check(s) failed`)
  process.exit(1)
}
console.log(`PASS ticket 02 at 1280x720: ${ids.length} slides — each choice changes only its own dimension (sidebar, background, alignment, bar, sidebar colour), the older options render as their separate choices, top/bottom bars clear the text at every length, Full + bar legible`)

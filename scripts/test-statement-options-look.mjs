// =============================================================================
// test:statement-options-look — ADR-0028 decision 10 (statement slides revised, locked 2026-09-28)
//
// What must hold, read from a real compiled deck in the real deck runtime at 1280×720 (the fixed
// canvas, ADR-0030), after the runtime's own fit pass has run on the slide:
//   1. Margins. A Default statement without a title keeps 15–20% of the slide width free on each
//      side of its text, and the two sides are equal (the panel is shrink-wrapped to its lines).
//   2. Panel. Default (and Centred, and a former Poster) sits on a panel whose colour is the
//      section's sidebar (rail) colour; no accent bar; the slide itself stays white.
//   3. No lone last word on any of the drawing's specimens (short, medium, long), in every option,
//      with and without a title — the seven-line centred case included.
//   4. Each option's look. Centred: centred, balanced lines, only without a title (with a title it
//      renders as the Default). Tint: tinted panel, accent bar, its own padding without a title too
//      (the defect in ref-tint-today-without-title.png). Bar: the bar and padding, no tint.
//   5. Poster is retired: {statement=poster} renders exactly as the Default.
//   6. Long statements step type down (never below the quote size) before anything zooms.
// Also: the compile-time half of the no-lone-word rule (no-lone-word.mjs) at its seam.
// =============================================================================

import { strict as assert } from 'node:assert'
import { copyFileSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'
import { buildVenuePageHtml } from '../compiler/scripts/lib/venue-page.mjs'
import { keepLastTwoWordsTogether, keepStatementLastWordsTogether } from '../compiler/scripts/lib/no-lone-word.mjs'

// ── The compile-time guard ────────────────────────────────────────────────────
const NB = '&nbsp;'
assert.equal(keepLastTwoWordsTogether('Agents need a place to keep their work.'), `Agents need a place to keep their${NB}work.`,
  'the last two words are joined')
assert.equal(keepLastTwoWordsTogether('you would give a colleague.'), `you would give a${NB}colleague.`, 'a short word joins a long one')
assert.equal(keepLastTwoWordsTogether('about the internationalisation considerations'), 'about the internationalisation considerations',
  'two words longer than 20 characters together are never glued')
assert.equal(keepLastTwoWordsTogether('then run <code>npm test</code>'), 'then run <code>npm test</code>', 'never inside code')
assert.equal(keepLastTwoWordsTogether('then read <a href="https://x.test">the docs</a>'), 'then read <a href="https://x.test">the docs</a>', 'never inside a link')
assert.equal(keepLastTwoWordsTogether('then see {icon=lucide:zap} here'), 'then see {icon=lucide:zap} here', 'never across an authoring token')
assert.equal(keepLastTwoWordsTogether('Carry one <strong>boxed phrase</strong>'), `Carry one <strong>boxed${NB}phrase</strong>`, 'inline emphasis is transparent')
assert.equal(keepLastTwoWordsTogether('<strong>their</strong> work.'), `<strong>their</strong>${NB}work.`, 'the space between two emphasis runs is joined')
assert.equal(keepLastTwoWordsTogether('first line<br>second'), 'first line<br>second', 'a line break is not two words on one line')
assert.equal(keepLastTwoWordsTogether(`this is already${NB}joined`), `this is already${NB}joined`, 'an existing no-break space is left alone')
assert.equal(keepLastTwoWordsTogether('Cats, Tom &amp; Jerry'), `Cats, Tom &amp;${NB}Jerry`, 'an entity counts as one character')
assert.equal(keepLastTwoWordsTogether('Single'), 'Single', 'one word has nothing to join')
assert.equal(keepLastTwoWordsTogether('Annotated — multi-point, stepped'), 'Annotated — multi-point, stepped',
  'a hyphen inside the pair is a break of its own: joining would strand "multi-" on the line above')
assert.equal(keepLastTwoWordsTogether('read and/or write'), 'read and/or write', 'a slash inside the pair is left alone')
assert.equal(keepLastTwoWordsTogether('About this showcase'), 'About this showcase',
  'three words are left alone: joining would only strand the first word on a line of its own')
assert.equal(keepLastTwoWordsTogether('Agent expectation'), `Agent${NB}expectation`, 'two words are kept on one line')
assert.equal(
  keepStatementLastWordsTogether('<p class="content-p">One two three four.</p>\n<p class="slide-source">Source: a long report</p>'),
  `<p class="content-p">One two three${NB}four.</p>\n<p class="slide-source">Source: a long report</p>`,
  'every top-level statement paragraph, never the source line'
)
assert.equal(keepStatementLastWordsTogether('<div class="poll-frame"><p>Nested para here</p></div>'),
  '<div class="poll-frame"><p>Nested para here</p></div>', 'a paragraph nested in another element is left alone')
console.log('PASS compile-time guard: last two words joined only when safe')

// ── The rendered slides ───────────────────────────────────────────────────────
const TEXT = {
  short: 'Agents need a place to keep their work.',
  medium: 'A chatbot answers the question you asked; an agent goes and finds out what you actually needed to know first.',
  long: 'Most of what we call prompting is really just explaining the task properly: who it is for, what good looks like, what to leave out, and where to find the material. It is the same briefing you would give a colleague.'
}
const TITLE = { short: 'Where to start', medium: 'Chat or agent', long: 'Prompting is briefing' }
const OPTIONS = ['default', 'centred', 'tint', 'bar', 'poster']
// Ticket 02: the older options are presets over the separate choices; each choice stamps its own hook.
const OPTION_HOOK = { tint: 'statement-bar-left', bar: 'statement-bg-none statement-bar-left', full: 'statement-bg-full' }
const token = (option) => option === 'default' ? '{statement}' : `{statement=${option}}`
const lines = ['---', 'title: Statement options probe', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '', '## Statements', '']
for (const option of OPTIONS) {
  for (const length of Object.keys(TEXT)) {
    // With a title: the title in the rail, the statement as the body.
    lines.push(`### ${TITLE[length]}`, `{id=side-${length}-${option}} ${token(option)}`, '', TEXT[length], '')
    // Without a title: the heading IS the statement (the heading-only promotion).
    lines.push(`### ${TEXT[length]}`, `{id=bare-${length}-${option}} ${token(option)}`, '')
  }
}
lines.push('### Next slide', '{id=after}', '', '- one', '- two', '')
const dir = mkdtempSync(join(tmpdir(), 'tw-statement-options-'))
const outlinePath = join(dir, 'statement-options-outline.md')
const source = lines.join('\n')
writeFileSync(outlinePath, source, 'utf8')
const model = await prepareSource(outlinePath, source, 'statement-options', statSync(outlinePath))
assert.equal(model.warnings.some((warning) => String(warning).startsWith('statement-unknown')), false,
  'every statement value, Poster included, parses without a warning')
const htmlPath = join(dir, 'statement-options.html')
writeFileSync(htmlPath, model.fullHtml, 'utf8')

const W = 1280
const H = 720
const px = (value) => parseFloat(value)
const near = (a, b, tolerance = 0.5) => Math.abs(a - b) <= tolerance
const rgbOf = (hex) => {
  const value = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(value.slice(at, at + 2), 16))
  return `rgb(${r}, ${g}, ${b})`
}

const browser = await chromium.launch({ headless: true })
let failures = 0
try {
  const page = await browser.newPage({ viewport: { width: W, height: H } })
  await page.goto(`file://${htmlPath}?audience=1`, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts?.ready)
  const show = async (id) => {
    // Park elsewhere, then arrive: arriving on a slide runs the runtime's own fit pass on it.
    await page.evaluate(() => { location.hash = 'after' })
    await page.waitForFunction(() => document.querySelector('.stage > .slide.active')?.dataset.id === 'after')
    await page.evaluate((target) => { location.hash = target }, id)
    await page.waitForFunction((target) => {
      const slide = document.querySelector('.stage > .slide.active')
      return slide?.dataset.id === target && slide.querySelector(':scope > .slide-content')?.dataset.statementFit
    }, id, { timeout: 10000 }).catch(() => {})
    await page.waitForTimeout(150)
    return page.evaluate((target) => {
      const slide = document.querySelector('.stage > .slide.active')
      if (slide?.dataset.id !== target) return { error: `slide ${target} did not become active` }
      const stage = slide.parentElement
      const k = stage.getBoundingClientRect().width / stage.offsetWidth
      const sr = slide.getBoundingClientRect()
      const x = (v) => (v - sr.left) / k
      const content = slide.querySelector(':scope > .slide-content')
      const p = content.querySelector(':scope > p')
      const cs = getComputedStyle(p)
      const words = []
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
      for (let node; (node = walker.nextNode());) {
        const re = /[^\s ]+/g
        let m
        while ((m = re.exec(node.data))) {
          const range = document.createRange()
          range.setStart(node, m.index)
          range.setEnd(node, m.index + m[0].length)
          const rect = range.getClientRects()[0]
          if (rect) words.push({ word: m[0], top: Math.round(rect.top / k), left: x(rect.left), right: x(rect.right) })
        }
      }
      const tops = [...new Set(words.map((w) => w.top))].sort((a, b) => a - b)
      const last = words.filter((w) => w.top === tops[tops.length - 1])
      const pr = p.getBoundingClientRect()
      const head = content.querySelector(':scope > .slide-head:not(.slide-head-quiet)')
      const slideStyle = getComputedStyle(slide)
      return {
        className: content.className,
        titleLayout: slide.dataset.titleLayout,
        zoom: content.style.zoom || '1',
        fit: content.dataset.statementFit || '',
        slideBg: slideStyle.backgroundColor,
        slideBgImage: slideStyle.backgroundImage,
        column: head ? { left: x(content.getBoundingClientRect().left) + px(getComputedStyle(content).gridTemplateColumns.split(' ')[0]) + px(getComputedStyle(content).columnGap), right: x(content.getBoundingClientRect().right) - px(getComputedStyle(content).paddingRight) } : null,
        p: {
          left: x(pr.left), right: x(pr.right), top: (pr.top - sr.top) / k, bottom: (pr.bottom - sr.top) / k,
          fontSize: px(cs.fontSize), background: cs.backgroundColor, borderLeft: px(cs.borderLeftWidth), borderColor: cs.borderLeftColor,
          paddingLeft: px(cs.paddingLeft), paddingRight: px(cs.paddingRight), paddingTop: px(cs.paddingTop),
          textAlign: cs.textAlign, textWrap: cs.textWrapStyle || cs.textWrap, boxSizing: cs.boxSizing, maxWidth: cs.maxWidth
        },
        accent: slideStyle.getPropertyValue('--accent').trim(),
        lines: tops.length,
        lastLine: last.map((w) => w.word),
        textWidth: (pr.width - (px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth)) * k) / k,
        // The measure in canvas px: the content width the box takes when asked for far more than
        // its max-width allows (the runtime's shrink-wrap width set aside, then restored).
        measure: (() => {
          const kept = p.getAttribute('style')
          p.style.setProperty('width', '100000px', 'important')
          const value = parseFloat(getComputedStyle(p).width)
          if (kept == null) p.removeAttribute('style'); else p.setAttribute('style', kept)
          return value
        })(),
        textLeft: Math.min(...words.map((w) => w.left)),
        textRight: stage.offsetWidth - Math.max(...words.map((w) => w.right)),
        html: p.innerHTML
      }
      function px(v) { return parseFloat(v) || 0 }
    }, id)
  }
  const check = (condition, message) => {
    if (condition) return
    failures += 1
    console.error(`FAIL ${message}`)
  }

  const shots = {}
  for (const option of OPTIONS) {
    for (const length of Object.keys(TEXT)) {
      for (const context of ['side', 'bare']) {
        const id = `${context}-${length}-${option}`
        shots[id] = await show(id)
        assert(!shots[id].error, shots[id].error)
      }
    }
  }

  // The section's sidebar colour: the rail every titled slide in the section paints.
  const railColour = shots['side-short-default'].slideBgImage.match(/rgba?\([^)]*\)/)?.[0]
  assert(railColour, `the titled statement paints the rail (got ${shots['side-short-default'].slideBgImage})`)
  const paper = shots['bare-short-default'].slideBg

  for (const [id, shot] of Object.entries(shots)) {
    const [context, length, option] = id.split('-')
    const titled = context === 'side'
    // 3. No lone last word.
    check(shot.lastLine.length >= 2, `${id}: the last line has ${shot.lastLine.length} word(s): "${shot.lastLine.join(' ')}"`)
    check(titled ? shot.titleLayout === 'left' : shot.titleLayout === 'hidden', `${id}: title regime ${shot.titleLayout}`)
    // 6. Nothing zooms.
    check(shot.zoom === '1', `${id}: the slide is not zoomed (zoom ${shot.zoom})`)

    const panelled = option === 'default' || option === 'poster' || option === 'centred'
    if (panelled) {
      // 2. The panel in the rail colour, no bar, padding outside the measure; the slide stays white.
      check(shot.p.background === railColour, `${id}: the panel is the sidebar colour ${railColour} (got ${shot.p.background})`)
      check(shot.p.borderLeft === 0, `${id}: the panel has no accent bar (got ${shot.p.borderLeft}px)`)
      check(shot.p.boxSizing === 'content-box', `${id}: the panel padding sits outside the measure`)
      check(near(shot.p.paddingLeft, shot.p.fontSize) && near(shot.p.paddingRight, shot.p.fontSize), `${id}: panel padding is 1em each side (got ${shot.p.paddingLeft}/${shot.p.paddingRight} at ${shot.p.fontSize}px)`)
      check(near(shot.p.paddingTop, 0.7 * shot.p.fontSize), `${id}: panel padding is .7em above and below (got ${shot.p.paddingTop})`)
      if (!titled) check(shot.slideBg === paper && shot.slideBgImage === 'none', `${id}: the slide itself stays white (got ${shot.slideBg} ${shot.slideBgImage})`)
      // Centred only without a title; with a title (and for Default/Poster) the lines are left-aligned.
      const centred = option === 'centred' && !titled
      check(/\bstatement-centred\b/.test(shot.className) === centred, `${id}: statement-centred stamped only on a statement without a title (${shot.className})`)
      check(shot.p.textAlign === (centred ? 'center' : 'left'), `${id}: text-align ${shot.p.textAlign}`)
      check(shot.p.textWrap === (centred ? 'balance' : 'pretty'), `${id}: text-wrap ${shot.p.textWrap}`)
      check(!/statement-poster/.test(shot.className), `${id}: Poster stamps no class`)
      // 1. Margins and balance.
      if (!titled) {
        check(near(shot.textLeft, shot.textRight, 2), `${id}: the text sits balanced (left ${shot.textLeft.toFixed(1)}, right ${shot.textRight.toFixed(1)})`)
        check(near(shot.p.left, W - shot.p.right, 1), `${id}: the panel is centred on the slide`)
        check(shot.textLeft >= 0.15 * W - 0.5, `${id}: the side margin is at least 15% (got ${(shot.textLeft / W * 100).toFixed(1)}%)`)
        if (option !== 'centred') {
          check(shot.textLeft <= 0.20 * W + 0.5 && shot.textRight <= 0.20 * W + 0.5,
            `${id}: the side margins are at most 20% (got ${(shot.textLeft / W * 100).toFixed(1)}% / ${(shot.textRight / W * 100).toFixed(1)}%)`)
        }
        // 6. The type steps down for a long statement, never below the quote size, and leaves air.
        check(shot.p.fontSize >= Math.max(31, 0.034 * W) - 0.05, `${id}: type ${shot.p.fontSize}px stays at or above the quote size`)
        check(shot.p.bottom - shot.p.top <= 0.72 * H + 1, `${id}: the panel is at most 72% of the slide height (got ${(shot.p.bottom - shot.p.top).toFixed(0)}px)`)
        if (length === 'long') check(shot.p.fontSize < 0.054 * W - 1, `${id}: a long statement steps its type down (got ${shot.p.fontSize}px)`)
        if (length === 'short') check(near(shot.p.fontSize, 0.054 * W, 0.05), `${id}: a short statement keeps the statement size (got ${shot.p.fontSize}px)`)
      } else {
        // Beside the rail: body size, measure 14em, the panel centred in the content column.
        check(near(shot.p.fontSize, 0.032 * W, 0.05), `${id}: beside the rail the statement keeps the body size (got ${shot.p.fontSize}px)`)
        check(shot.p.right - shot.p.left - 2 * shot.p.paddingLeft <= 14 * shot.p.fontSize + 0.5, `${id}: the text measure stays within 14em`)
        const columnCentre = (shot.column.left + shot.column.right) / 2
        check(near((shot.p.left + shot.p.right) / 2, columnCentre, 2), `${id}: the panel is centred in the content column (${((shot.p.left + shot.p.right) / 2).toFixed(1)} vs ${columnCentre.toFixed(1)})`)
      }
    } else {
      // 4. Tint and Bar: the Default's panel box with the accent bar (Tint) or the bar alone (Bar),
      //    with or without a title. Type and measure are checked against the Default below.
      // Chromium paints a border at whole pixels, rounding down (.22em of 67.1px paints 14px).
      check(shot.p.borderLeft === Math.floor(0.22 * shot.p.fontSize) || near(shot.p.borderLeft, 0.22 * shot.p.fontSize, 0.6),
        `${id}: the accent bar is .22em (got ${shot.p.borderLeft}px at ${shot.p.fontSize}px)`)
      check(shot.p.borderColor === rgbOf(shot.accent), `${id}: the bar is the section accent ${shot.accent} (got ${shot.p.borderColor})`)
      check(shot.p.boxSizing === 'content-box', `${id}: the padding sits outside the measure`)
      check(near(shot.p.paddingLeft, shot.p.fontSize) && near(shot.p.paddingRight, shot.p.fontSize), `${id}: ${option} keeps the panel's 1em padding${titled ? '' : ' without a title'} (got ${shot.p.paddingLeft}/${shot.p.paddingRight}px)`)
      check(shot.textLeft - shot.p.left >= shot.p.borderLeft + shot.p.fontSize - 1, `${id}: the text clears the bar by the padding`)
      check(option === 'tint' ? shot.p.background === railColour : shot.p.background === 'rgba(0, 0, 0, 0)',
        `${id}: ${option === 'tint' ? 'the tint panel is the section tint' : 'Bar has no tint'} (got ${shot.p.background})`)
      check(new RegExp(`\\b${OPTION_HOOK[option]}\\b`).test(shot.className), `${id}: stamps ${OPTION_HOOK[option]} (${shot.className})`)
      if (!titled) check(shot.slideBg === paper && shot.slideBgImage === 'none', `${id}: ${option} keeps a white slide`)
    }
  }

  // 4b. ONE type size and ONE measure for all four options (preview.9 follow-up): each option sets
  //     the same text at the Default's rendered size, the same computed measure and the same line
  //     breaks — without a title, beside a title, and for the title-as-statement. Only the box
  //     differs; Centred differs only in alignment and balance.
  for (const context of ['side', 'bare']) {
    for (const length of Object.keys(TEXT)) {
      const standard = shots[`${context}-${length}-default`]
      for (const option of ['centred', 'tint', 'bar']) {
        const id = `${context}-${length}-${option}`
        const shot = shots[id]
        check(near(shot.p.fontSize, standard.p.fontSize, 0.05), `${id}: type ${shot.p.fontSize}px equals the Default's ${standard.p.fontSize}px`)
        check(near(shot.measure, standard.measure, 1), `${id}: measure ${shot.measure.toFixed(1)}px equals the Default's ${standard.measure.toFixed(1)}px`)
        // Centred balances its lines, so its longest line (and the box hugging it) may be shorter.
        if (option !== 'centred') check(near(shot.textWidth, standard.textWidth, 2), `${id}: text column ${shot.textWidth.toFixed(1)}px equals the Default's ${standard.textWidth.toFixed(1)}px`)
        check(shot.lines === standard.lines, `${id}: ${shot.lines} line(s), the Default has ${standard.lines}`)
      }
    }
  }

  // 5. A former Poster slide renders exactly as the Default.
  for (const context of ['side', 'bare']) {
    for (const length of Object.keys(TEXT)) {
      const poster = shots[`${context}-${length}-poster`]
      const standard = shots[`${context}-${length}-default`]
      check(poster.className === standard.className && poster.lines === standard.lines
        && near(poster.p.left, standard.p.left) && near(poster.p.right, standard.p.right) && poster.p.fontSize === standard.p.fontSize,
      `${context}-${length}: a Poster slide renders as the Default`)
    }
  }
  // 3, the drawing's seven-line centred case. Chromium balances at most six lines, so at the
  // drawing's geometry (49.1px in a 64cqw column: bare-long-4-centred.png) the long centred
  // statement runs to seven lines and CSS alone left "colleague." alone. The compiler's no-break
  // space must carry it: force that geometry on the compiled slide and read the last line.
  await show('bare-long-centred')
  const seven = await page.evaluate(() => {
    const p = document.querySelector('.stage > .slide.active > .slide-content > p')
    p.style.setProperty('font-size', '49.1px', 'important')
    p.style.setProperty('width', 'auto', 'important')
    p.style.setProperty('max-width', '64cqw', 'important')
    const read = () => {
      const words = []
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
      for (let node; (node = walker.nextNode());) {
        for (const m of node.data.matchAll(/[^\s\u00a0]+/g)) {
          const range = document.createRange()
          range.setStart(node, m.index)
          range.setEnd(node, m.index + m[0].length)
          const rect = range.getClientRects()[0]
          if (rect) words.push({ word: m[0], top: Math.round(rect.top) })
        }
      }
      const tops = [...new Set(words.map((w) => w.top))].sort((a, b) => a - b)
      return { lines: tops.length, last: words.filter((w) => w.top === tops[tops.length - 1]).map((w) => w.word) }
    }
    const withGuard = read()
    const html = p.innerHTML
    p.innerHTML = html.replace(/&nbsp;|\u00a0/g, ' ')
    const cssAlone = read()
    p.innerHTML = html
    return { withGuard, cssAlone }
  })
  check(seven.withGuard.lines >= 7, `the drawing's long centred geometry runs to seven lines (got ${seven.withGuard.lines})`)
  check(seven.withGuard.last.length >= 2, `the seven-line centred statement ends on two words (got "${seven.withGuard.last.join(' ')}")`)
  console.log(`INFO seven-line centred case: last line "${seven.withGuard.last.join(' ')}" with the no-break space; "${seven.cssAlone.last.join(' ')}" with CSS alone`)

  if (failures) throw new Error(`${failures} statement look check(s) failed`)
  await page.close()
  console.log('PASS 1280x720: margins 15–20% and balanced, panel in the sidebar colour, no lone last word, Default / Centred / Tint / Bar looks, Poster → Default, long statements step type before any zoom')

  // ── Titles and statements from Dominik's talks (ADR-0028 amendment 2026-09-28) ──────────────
  // Slides on which Chromium's `text-wrap: pretty` alone still ends on a lone word, copied
  // verbatim from layout-showcase and agents-and-ai-2026 (the library is not in this repo; images
  // swapped for a fixture picture). The compiler's join must fix them at both window sizes (every
  // view scales one 1280×720 canvas, ADR-0030). Two are left as authored, by rule, and must stay
  // so: a three-word title (ww85o: joining would strand "About" on its own line instead) and a pair
  // with a hyphen inside (hn6ti: joining would strand "multi-" above "point, stepped").
  const talkDir = mkdtempSync(join(tmpdir(), 'tw-lone-word-talks-'))
  copyFileSync(new URL('./fixtures/layout/sample-image.png', import.meta.url), join(talkDir, 'picture.png'))
  const talkSource = [
    '---', 'title: Lone word fixtures', 'defaults: { icons: on }', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
    '## Frame & titles', '{id=frame}', '',
    '### About this showcase', '{title=side}{id=ww85o}{list}', '',
    '- Every TalkWeaver layout in one deck', '- The new Wave-1 frame features are called out per slide', '- Open in TalkWeaver and step through to see reveals', '',
    '### This is an important statement slide', '{id=3b2vn} {statement}', '',
    '### Annotated — multi-point, stepped', '{annotated}{id=hn6ti}', '',
    '- Discovery', '    - map the current model', '    - find the extension points', '    - write down the constraints',
    '- Build', '    - one task at a time', '    - test, review, commit', '    - fix findings before moving on',
    '- Ship', '    - whole-branch review', '    - merge and install', '',
    '## Cards, quotes & comparison', '{id=k0a03}', '',
    '### Agent expectation', '{id=zci4w}', '', '- Chatbot answering questions based on documents', '- (e.g. Customer service agent)', '',
    '## Agentic Examples Before Codex', '{id=examples-before-codex}', '',
    '### Catalogue and organise your data', '{id=jrs5j}', '', ':::notes', 'Start of use case 1.', ':::', '',
    '### Example: organising a downloads folder', '{id=2h226}', '',
    '- Ask what is in the folder', '- Check names, dates, sizes, and duplicates', '- Ask for suggested organising schemes', '- Rename or move files after review', '',
    '![Downloads visualisation report](picture.png)', '',
    '### Build and maintain a note system', '{id=379cn}', '',
    '### What to put in README.md', '{id=cvuj6}', '',
    '| Include | Why it helps |', '| --- | --- |', '| What the folder is for | Keeps the project purpose visible |', '| Naming conventions | Makes new files consistent |',
    '| Expected outputs | Tells Codex what to create |', '| Things to avoid | Reduces accidental changes |', '| Privacy or sharing notes | Makes handling expectations explicit |', '',
    '### It is widely recognized that agents as productivity tools are the main source of innovation and productivity growth.', '{layout=media}{id=mglz1}', '',
    '![Agents as productivity tools drive innovation and productivity growth](picture.png)', '',
    // The runtime's check on the join (slide-fit.js settleJoin): in the ~14ch rail, keeping
    // "agent (numbered)" together would push "an" onto a line of its own, so the join is released.
    '### How to work with an agent (numbered)', '{id=released}{numbered}', '',
    '- Describe the outcome, not the steps', '- Give it the context a new colleague would need', '- Let it work, then verify the result end to end', '',
    '### Next slide', '{id=after}', '', '- one', '- two', ''
  ].join('\n')
  const talkPath = join(talkDir, 'lone-word-outline.md')
  writeFileSync(talkPath, talkSource, 'utf8')
  const talkModel = await prepareSource(talkPath, talkSource, 'lone-word', statSync(talkPath))
  const talkHtml = join(talkDir, 'lone-word.html')
  writeFileSync(talkHtml, talkModel.fullHtml, 'utf8')
  const FIXED = ['3b2vn', 'k0a03', 'zci4w', 'examples-before-codex', 'jrs5j', '2h226', '379cn', 'cvuj6', 'mglz1']
  const AS_AUTHORED = ['ww85o', 'hn6ti']
  const RELEASED = ['released']
  for (const viewport of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
    const talkPage = await browser.newPage({ viewport })
    await talkPage.goto(`file://${talkHtml}?audience=1`, { waitUntil: 'load' })
    await talkPage.evaluate(() => document.fonts?.ready)
    for (const id of [...FIXED, ...AS_AUTHORED, ...RELEASED]) {
      await talkPage.evaluate(() => { location.hash = 'after' })
      await talkPage.waitForFunction(() => document.querySelector('.stage > .slide.active')?.dataset.id === 'after')
      await talkPage.evaluate((target) => { location.hash = target }, id)
      await talkPage.waitForFunction((target) => document.querySelector('.stage > .slide.active')?.dataset.id === target, id)
      await talkPage.waitForTimeout(300)
      const text = await talkPage.evaluate(() => {
        const slide = document.querySelector('.stage > .slide.active')
        // The statement text when the heading became the statement; otherwise the painted title.
        const el = slide.dataset.layout === 'statement' && slide.querySelector('.slide-content > .slide-head-quiet')
          ? slide.querySelector('.slide-content > p')
          : slide.querySelector('.slide-content h1:not(.sr-only)')
        const chars = []
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        for (let node; (node = walker.nextNode());) {
          for (let i = 0; i < node.data.length; i++) {
            const range = document.createRange()
            range.setStart(node, i)
            range.setEnd(node, i + 1)
            const rect = range.getClientRects()[0]
            if (rect && rect.height) chars.push({ c: node.data[i], mid: rect.top + rect.height / 2 })
          }
        }
        const rows = []
        for (const ch of chars) {
          const row = rows.find((candidate) => Math.abs(candidate.mid - ch.mid) < 6)
          if (row) row.text += ch.c
          else rows.push({ mid: ch.mid, text: ch.c })
        }
        return { lines: rows.sort((a, b) => a.mid - b.mid).map((row) => row.text.replace(/\u00a0/g, ' ').trim()).filter(Boolean), html: el.innerHTML, join: el.dataset.nbJoin || '' }
      })
      const key = `${viewport.width}x${viewport.height} ${id}`
      const oneWord = text.lines.map((line) => text.lines.length > 1 && !/\s/.test(line))
      if (FIXED.includes(id)) {
        check(!oneWord[oneWord.length - 1], `${key}: ends on at least two words (${JSON.stringify(text.lines)})`)
        check(!oneWord.some(Boolean), `${key}: no line holds a single word (${JSON.stringify(text.lines)})`)
      } else if (RELEASED.includes(id)) {
        check(text.join === 'released', `${key}: the runtime releases a join that would strand a word (${JSON.stringify(text.lines)})`)
        check(!oneWord.slice(0, -1).some(Boolean), `${key}: no line inside the title holds a single word (${JSON.stringify(text.lines)})`)
      } else {
        check(!text.html.includes('&nbsp;'), `${key}: left as authored (${text.html})`)
      }
    }
    await talkPage.close()
  }
  if (failures) throw new Error(`${failures} lone-word check(s) on the talk fixtures failed`)
  console.log(`PASS talk fixtures at 1280x720 and 1920x1080: ${FIXED.length} titles/statements end on two words; ${AS_AUTHORED.join(', ')} left as authored by rule; a join that would strand a word is released`)

  // ── preview.9 fixes (Dominik's check, 28 Sep, slide 3b2vn of layout-showcase) ─────────────────
  // 1. ONE set of statement options: the older claim tokens map onto them on a statement slide
  //    ({claim=bar} → Bar, {claim=plain} → Default; deck claim_style the same), silently; an
  //    explicit {statement=…} wins. {stmt-list}'s statement column is the slide's claim: Plain has
  //    no bar, Bar keeps it.
  // 2. An authored {bg=…}: on a statement with a panel (Default, Centred, Tint) the panel takes the
  //    authored colour and the slide stays white; Bar never shows a panel (the colour paints the
  //    slide there, as on any slide). Beside a title the rail stays painted.
  // 3. "This is an important statement / slide" never ends on "slide" alone — in every option,
  //    with and without the background, in the deck, the handout, the venue page and the presenter.
  const fixDir = mkdtempSync(join(tmpdir(), 'tw-statement-preview9-'))
  const SPECIMEN = 'This is an important statement slide'
  const VARIANTS = {
    default: '{statement}', claimbar: '{statement}{claim=bar}', claimplain: '{statement}{claim=plain}',
    centred: '{statement=centred}', tint: '{statement=tint}', bar: '{statement=bar}', explicitdefault: '{statement=default}{claim=bar}'
  }
  const fixLines = ['---', 'title: Statement preview.9 fixes', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '', '## Statements', '']
  for (const [name, tokens] of Object.entries(VARIANTS)) {
    for (const bg of ['', 'emerald']) fixLines.push(`### ${SPECIMEN}`, `{id=fx-${name}-${bg || 'none'}}${tokens}${bg ? `{bg=${bg}}` : ''}`, '')
  }
  fixLines.push('### Where to start', '{id=fx-titled-emerald}{statement}{bg=emerald}', '', 'Agents need a place to keep their work.', '')
  // Titled statements in every option, with and without the background, for the one-type rule.
  for (const option of ['default', 'centred', 'tint', 'bar']) {
    for (const bg of ['', 'emerald']) {
      fixLines.push('### Where to start', `{id=fx-side${option}-${bg || 'none'}}${option === 'default' ? '{statement}' : `{statement=${option}}`}${bg ? `{bg=${bg}}` : ''}`, '',
        'Agents need a place to keep their work.', '')
    }
  }
  for (const claim of ['', 'plain', 'bar']) {
    fixLines.push('### Statement beside a list', `{stmt-list}{id=fx-stmt-${claim || 'none'}}${claim ? `{claim=${claim}}` : ''}`, '',
      'Is the time you save worth the time you spend reviewing?', '', '- Yes for repetitive, well-specified work', '- Break-even on one-off scripts', '')
  }
  fixLines.push('### Next slide', '{id=after}', '', '- one', '- two', '')
  const fixSource = fixLines.join('\n')
  const fixPath = join(fixDir, 'preview9-outline.md')
  writeFileSync(fixPath, fixSource, 'utf8')
  const fixModel = await prepareSource(fixPath, fixSource, 'preview9', statSync(fixPath))
  check(!fixModel.warnings.some((warning) => /^(statement|claim-style|claim)-unknown/.test(String(warning))),
    `the claim tokens on statement slides parse without warnings (${fixModel.warnings.join(', ')})`)
  const fixFull = String(fixModel.fullHtml)
  const fixFiles = {
    deck: fixFull,
    handout: buildShareHtml({ title: 'Preview 9', slides: extractSlides(fixFull), styles: extractStyles(fixFull), includeNotes: false, slug: 'preview9', license: null }),
    venue: buildVenuePageHtml({ title: 'Preview 9', slides: extractSlides(fixFull), styles: extractStyles(fixFull), slug: 'preview9', license: null,
      workerBaseUrl: 'https://live.invalid', liveTalkSlug: 'preview9', qr: '', handoutUrl: 'https://handouts.invalid/preview9' })
  }
  for (const [name, html] of Object.entries(fixFiles)) writeFileSync(join(fixDir, `${name}.html`), html, 'utf8')
  const EMERALD = 'rgb(228, 243, 238)'
  const CLEAR = 'rgba(0, 0, 0, 0)'
  // Reads one slide of whichever document `root` is: the active slide's statement text lines and
  // its colours. Runs in the page (the deck, the handout, the venue page or a presenter preview).
  const readStatement = (id) => {
    const slide = [...document.querySelectorAll('.slide')].find((candidate) => candidate.dataset.id === id)
    if (!slide) return { error: `no slide ${id}` }
    const content = slide.querySelector(':scope > .slide-content')
    const p = content.querySelector(':scope > p:not(.kicker):not(.slide-source), .stmt > p')
    const rows = []
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT)
    for (let node; (node = walker.nextNode());) {
      for (let i = 0; i < node.data.length; i++) {
        const range = document.createRange()
        range.setStart(node, i)
        range.setEnd(node, i + 1)
        const rect = range.getClientRects()[0]
        if (!rect || !rect.height) continue
        const mid = rect.top + rect.height / 2
        const row = rows.find((candidate) => Math.abs(candidate.mid - mid) < rect.height / 3)
        if (row) row.text += node.data[i]
        else rows.push({ mid, text: node.data[i] })
      }
    }
    const cs = getComputedStyle(p)
    const ss = getComputedStyle(slide)
    const kept = p.getAttribute('style')
    p.style.setProperty('width', '100000px', 'important')
    const measure = parseFloat(getComputedStyle(p).width)
    if (kept == null) p.removeAttribute('style'); else p.setAttribute('style', kept)
    return {
      fontSize: parseFloat(cs.fontSize), lineHeight: cs.lineHeight, measure,
      active: slide.classList.contains('active'),
      className: content.className,
      lines: rows.sort((a, b) => a.mid - b.mid).map((row) => row.text.replace(/ /g, ' ').trim()).filter(Boolean),
      panel: cs.backgroundColor, bar: parseFloat(cs.borderLeftWidth) || 0,
      slideBg: ss.backgroundColor, slideBgImage: ss.backgroundImage
    }
  }
  const lastLineWords = (shot) => (shot.lines.at(-1) ?? '').split(/\s+/).filter(Boolean).length
  const fixIds = [...fixFull.matchAll(/<section class="slide[^"]*" data-id="(fx-[^"]+)"/g)].map((match) => match[1])
  const deckShots = {}
  {
    const fixPage = await browser.newPage({ viewport: { width: W, height: H } })
    await fixPage.goto(`file://${join(fixDir, 'deck.html')}?audience=1`, { waitUntil: 'load' })
    await fixPage.evaluate(() => document.fonts?.ready)
    for (const id of fixIds) {
      await fixPage.evaluate(() => { location.hash = 'after' })
      await fixPage.waitForFunction(() => document.querySelector('.stage > .slide.active')?.dataset.id === 'after')
      await fixPage.evaluate((target) => { location.hash = target }, id)
      await fixPage.waitForFunction((target) => document.querySelector('.stage > .slide.active')?.dataset.id === target, id)
      await fixPage.waitForTimeout(200)
      deckShots[id] = await fixPage.evaluate(readStatement, id)
    }
    await fixPage.close()
  }
  const paperNoBg = deckShots['fx-default-none'].slideBg
  for (const [id, shot] of Object.entries(deckShots)) {
    assert(!shot.error, shot.error)
    const [, name, bg] = id.split('-')
    if (name === 'stmt' || name === 'titled' || name.startsWith('side')) continue
    const barred = name === 'bar' || name === 'claimbar'
    const panelled = !barred && name !== 'tint'
    check(/\bstatement-bg-none statement-bar-left\b/.test(shot.className) === barred, `${id}: ${barred ? 'renders as Bar' : 'does not render as Bar'} (${shot.className})`)
    check(lastLineWords(shot) >= 2, `${id}: the last line has ${lastLineWords(shot)} word(s) (${JSON.stringify(shot.lines)})`)
    if (barred) {
      check(shot.panel === CLEAR, `${id}: Bar never shows a panel (got ${shot.panel})`)
      check(shot.bar > 0, `${id}: Bar draws the accent bar`)
      check(shot.slideBg === (bg === 'emerald' ? EMERALD : paperNoBg), `${id}: Bar leaves the authored colour on the slide (got ${shot.slideBg})`)
    } else {
      if (panelled) check(shot.bar === 0, `${id}: the Default panel has no bar (got ${shot.bar}px)`)
      check(shot.panel === (bg === 'emerald' ? EMERALD : deckShots[`fx-${name}-none`].panel),
        `${id}: ${bg === 'emerald' ? 'the panel takes the authored background' : 'the panel is the section colour'} (got ${shot.panel})`)
      check(shot.slideBg === paperNoBg, `${id}: the slide stays white around the panel (got ${shot.slideBg})`)
    }
  }
  // One type size and one measure (preview.9 follow-up): every option equals the Default for the
  // same text, on the title-as-statement slide (3b2vn's case) and beside a title, with and
  // without an authored background.
  for (const [id, shot] of Object.entries(deckShots)) {
    const [, name, bg] = id.split('-')
    if (name === 'stmt' || name === 'titled') continue
    const standard = deckShots[name.startsWith('side') ? `fx-sidedefault-${bg}` : `fx-default-${bg}`]
    if (shot === standard) continue
    check(Math.abs(shot.fontSize - standard.fontSize) <= 0.05, `${id}: type ${shot.fontSize}px equals the Default's ${standard.fontSize}px`)
    check(shot.lineHeight === standard.lineHeight, `${id}: line height ${shot.lineHeight} equals the Default's ${standard.lineHeight}`)
    check(Math.abs(shot.measure - standard.measure) <= 1, `${id}: measure ${shot.measure}px equals the Default's ${standard.measure}px`)
    check(JSON.stringify(shot.lines) === JSON.stringify(standard.lines), `${id}: breaks ${JSON.stringify(shot.lines)} as the Default ${JSON.stringify(standard.lines)}`)
  }
  check(deckShots['fx-claimplain-none'].panel === deckShots['fx-default-none'].panel && deckShots['fx-explicitdefault-none'].panel === deckShots['fx-default-none'].panel,
    '{claim=plain} and an explicit {statement=default} render as the Default')
  const titledBg = deckShots['fx-titled-emerald']
  check(titledBg.panel === EMERALD, `beside a title the panel takes the authored background (got ${titledBg.panel})`)
  check(titledBg.slideBgImage !== 'none', `beside a title the rail stays painted under an authored background (got ${titledBg.slideBgImage})`)
  check(deckShots['fx-stmt-none'].bar === 0 && deckShots['fx-stmt-plain'].bar === 0, `stmt-list: Plain (and no token) has no bar (got ${deckShots['fx-stmt-none'].bar} / ${deckShots['fx-stmt-plain'].bar})`)
  check(deckShots['fx-stmt-bar'].bar > 0, 'stmt-list: {claim=bar} draws the accent bar')

  // The deck-wide claim_style maps too; a slide token and an explicit {statement=…} win over it.
  const deckBarSource = ['---', 'title: Claim style bar', 'claim_style: bar', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '', '## S', '',
    `### ${SPECIMEN}`, '{id=d-untokened}{statement}', '', `### ${SPECIMEN}`, '{id=d-plain}{statement}{claim=plain}', '',
    `### ${SPECIMEN}`, '{id=d-explicit}{statement=default}', ''].join('\n')
  const deckBarPath = join(fixDir, 'deck-bar-outline.md')
  writeFileSync(deckBarPath, deckBarSource, 'utf8')
  const deckBarHtml = String((await prepareSource(deckBarPath, deckBarSource, 'deck-bar', statSync(deckBarPath))).fullHtml)
  const contentClass = (id) => deckBarHtml.match(new RegExp(`data-id="${id}"[\\s\\S]*?<div class="slide-content ([^"]*)"`))?.[1] ?? ''
  check(/\bstatement-bg-none statement-bar-left\b/.test(contentClass('d-untokened')), `deck claim_style: bar makes an untokened statement a Bar (${contentClass('d-untokened')})`)
  check(!/\bstatement-bg-none statement-bar-left\b/.test(contentClass('d-plain')), 'a slide {claim=plain} wins over the deck claim_style')
  check(!/\bstatement-bg-none statement-bar-left\b/.test(contentClass('d-explicit')), 'an explicit {statement=default} wins over the deck claim_style')

  // The same slides in the handout and on the venue page (the share page runtime), at the window
  // sizes they open in, and in the presenter's current and next previews.
  const SPECIMEN_IDS = fixIds.filter((id) => !/^fx-(stmt|titled)-/.test(id))
  const readCount = { handout: 0, venue: 0, presenter: 0 }
  for (const view of ['handout', 'venue']) {
    for (const viewport of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const viewPage = await browser.newPage({ viewport })
      await viewPage.goto(`file://${join(fixDir, `${view}.html`)}`, { waitUntil: 'load' })
      await viewPage.evaluate(() => document.fonts?.ready)
      for (const id of SPECIMEN_IDS) {
        // The phone handout lays the slides out as a scrolled list; bring this one into view.
        await viewPage.evaluate((target) => {
          location.hash = target
          ;[...document.querySelectorAll('.slide')].find((slide) => slide.dataset.id === target)?.scrollIntoView({ block: 'center' })
        }, id)
        await viewPage.waitForTimeout(350)
        const shot = await viewPage.evaluate(readStatement, id)
        if (!shot.active && !shot.lines.length) continue // the venue page shows only the live slide
        readCount[view] += 1
        check(lastLineWords(shot) >= 2, `${view} ${viewport.width}x${viewport.height} ${id}: last line has ${lastLineWords(shot)} word(s) (${JSON.stringify(shot.lines)})`)
      }
      await viewPage.close()
    }
  }
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1728, height: 1117 }]) {
    const presenter = await browser.newPage({ viewport })
    for (const id of ['fx-default-emerald', 'fx-claimbar-emerald', 'fx-tint-emerald', 'fx-centred-none']) {
      await presenter.goto(`file://${join(fixDir, 'deck.html')}?presenter=1#${id}`, { waitUntil: 'load' })
      await presenter.waitForTimeout(1800)
      for (const pane of ['#currentPreview', '#nextPreview']) {
        const handle = await presenter.$(`${pane} iframe`)
        const frame = handle ? await handle.contentFrame() : null
        if (!frame) { check(false, `presenter ${pane}: no preview frame for ${id}`); continue }
        const shown = await frame.evaluate(() => (document.querySelector('.slide.active') ?? document.querySelector('.slide'))?.dataset.id ?? '')
        if (!shown.startsWith('fx-') || /^fx-(stmt|titled)-/.test(shown)) continue
        const shot = await frame.evaluate(readStatement, shown)
        readCount.presenter += 1
        check(lastLineWords(shot) >= 2, `presenter ${viewport.width}x${viewport.height} ${pane} ${shown}: last line has ${lastLineWords(shot)} word(s) (${JSON.stringify(shot.lines)})`)
      }
    }
    await presenter.close()
  }
  for (const [view, count] of Object.entries(readCount)) check(count > 0, `${view}: the specimen was read at least once (${count})`)
  console.log(`INFO specimen statements read: ${JSON.stringify(readCount)}`)
  if (failures) throw new Error(`${failures} preview.9 statement check(s) failed`)
  console.log('PASS preview.9: claim tokens and claim_style map onto Default / Bar; {bg=…} colours the panel (Bar: the slide); stmt-list Plain has no bar; 3b2vn keeps two words together in the deck, handout, venue page and presenter')

  // ── preview.10 (Dominik's check, 28 Sep, slide 3b2vn with {font-body=xl}{bg=vermilion}) ──────────
  // 1. A fifth option, Full colour ({statement=full}): the whole slide in the colour — the authored
  //    {bg=…}, else the section's sidebar colour — with no panel, border or bar, beside a title as
  //    well (the rail merges into the slide); text measure and type as the others.
  // 2. Statement type follows the slide's text-size step ({font-body=…} on the slide, or the deck's
  //    `triggers:` default) in every option, the title-as-statement included: 1.6875 × --fs-body
  //    (5.4cqw at M), and a long statement's step-down floor scales by the same ratio.
  const p10Dir = mkdtempSync(join(tmpdir(), 'tw-statement-preview10-'))
  const P10_OPTIONS = ['default', 'centred', 'tint', 'bar', 'full']
  const optionToken = (option) => option === 'default' ? '{statement}' : `{statement}{statement=${option}}`
  const p10Lines = ['---', 'title: Statement preview.10', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '', '## Statements', '{accent=cobalt}', '']
  for (const option of P10_OPTIONS) {
    for (const size of ['m', 'xl', 'xs']) {
      for (const bg of ['none', 'vermilion']) {
        const tokens = `${optionToken(option)}${size === 'm' ? '' : `{font-body=${size}}`}${bg === 'none' ? '' : `{bg=${bg}}`}`
        p10Lines.push(`### ${SPECIMEN}`, `{id=p10-${option}-${size}-${bg}}${tokens}`, '')
        p10Lines.push(`### Where to start`, `{id=p10side-${option}-${size}-${bg}}${tokens}`, '', 'Agents need a place to keep their work.', '')
      }
    }
    for (const size of ['m', 'xl']) {
      p10Lines.push(`### ${TEXT.long}`, `{id=p10long-${option}-${size}}${optionToken(option)}${size === 'm' ? '' : `{font-body=${size}}`}`, '')
    }
  }
  p10Lines.push('### Next slide', '{id=after}', '', '- one', '- two', '')
  const p10Source = p10Lines.join('\n')
  const p10Path = join(p10Dir, 'preview10-outline.md')
  writeFileSync(p10Path, p10Source, 'utf8')
  const p10Model = await prepareSource(p10Path, p10Source, 'preview10', statSync(p10Path))
  check(!p10Model.warnings.some((warning) => /^statement-unknown/.test(String(warning))), `{statement=full} parses without a warning (${p10Model.warnings.join(', ')})`)
  // The deck-level text size: frontmatter `triggers: {font-body=xl}` reaches the statement too.
  const deckXlSource = p10Source.replace('auto_thanks_slide: false', "auto_thanks_slide: false\ntriggers: '{font-body=xl}'")
  const deckXlPath = join(p10Dir, 'preview10-deck-xl-outline.md')
  writeFileSync(deckXlPath, deckXlSource, 'utf8')
  const deckXlModel = await prepareSource(deckXlPath, deckXlSource, 'preview10-deck-xl', statSync(deckXlPath))
  writeFileSync(join(p10Dir, 'deck.html'), String(p10Model.fullHtml), 'utf8')
  writeFileSync(join(p10Dir, 'deck-xl.html'), String(deckXlModel.fullHtml), 'utf8')
  const p10Ids = [...String(p10Model.fullHtml).matchAll(/<section class="slide[^"]*" data-id="(p10[^"]+)"/g)].map((match) => match[1])
  const readAll = async (file, ids) => {
    const out = {}
    const p10Page = await browser.newPage({ viewport: { width: W, height: H } })
    await p10Page.goto(`file://${join(p10Dir, file)}?audience=1`, { waitUntil: 'load' })
    await p10Page.evaluate(() => document.fonts?.ready)
    for (const id of ids) {
      await p10Page.evaluate(() => { location.hash = 'after' })
      await p10Page.waitForFunction(() => document.querySelector('.stage > .slide.active')?.dataset.id === 'after')
      await p10Page.evaluate((target) => { location.hash = target }, id)
      await p10Page.waitForFunction((target) => document.querySelector('.stage > .slide.active')?.dataset.id === target, id)
      await p10Page.waitForTimeout(200)
      out[id] = await p10Page.evaluate(readStatement, id)
    }
    await p10Page.close()
    return out
  }
  const p10 = await readAll('deck.html', p10Ids)
  const deckXl = await readAll('deck-xl.html', p10Ids.filter((id) => /^p10-[a-z]+-m-none$/.test(id)))
  const VERMILION = 'rgb(252, 236, 227)'
  const COBALT_TINT = 'rgb(232, 238, 252)'
  const ratio = { xl: 3.9 / 3.2, xs: 2.0 / 3.2 }
  for (const [id, shot] of Object.entries(p10)) {
    assert(!shot.error, shot.error)
    const [kind, option, size, bg] = id.split('-')
    if (kind === 'p10long') continue
    const colour = bg === 'vermilion' ? VERMILION : COBALT_TINT
    if (option === 'full') {
      check(/\bstatement-bg-full\b/.test(shot.className), `${id}: stamps statement-bg-full (${shot.className})`)
      check(shot.slideBg === colour, `${id}: Full colour paints the whole slide ${colour} (got ${shot.slideBg})`)
      check(shot.slideBgImage === 'none', `${id}: Full colour leaves no rail or other layer over the colour (got ${shot.slideBgImage})`)
      check(shot.panel === CLEAR && shot.bar === 0, `${id}: Full colour has no panel and no bar (got ${shot.panel}, ${shot.bar}px)`)
    }
    // One type, one measure: every option equals the Default of the same size and background.
    const standard = p10[`${kind}-default-${size}-${bg}`]
    if (option !== 'default') {
      check(Math.abs(shot.fontSize - standard.fontSize) <= 0.05, `${id}: type ${shot.fontSize}px equals the Default's ${standard.fontSize}px`)
      check(Math.abs(shot.measure - standard.measure) <= 1, `${id}: measure ${shot.measure}px equals the Default's ${standard.measure}px`)
    }
    // The text-size step: xl and xs scale the statement by the ladder's own ratio to M.
    if (size !== 'm') {
      const m = p10[`${kind}-${option}-m-${bg}`]
      check(Math.abs(shot.fontSize - m.fontSize * ratio[size]) <= 0.6,
        `${id}: font-body=${size} sets the statement at ${ratio[size].toFixed(3)} × M (${(m.fontSize * ratio[size]).toFixed(1)}px; got ${shot.fontSize}px)`)
    }
    check(lastLineWords(shot) >= 2, `${id}: the last line has ${lastLineWords(shot)} word(s) (${JSON.stringify(shot.lines)})`)
  }
  for (const option of P10_OPTIONS) {
    check(Math.abs(p10[`p10-${option}-m-none`].fontSize - 0.054 * W) <= 0.05, `p10-${option}-m-none: M keeps the statement size 5.4cqw (got ${p10[`p10-${option}-m-none`].fontSize}px)`)
    // A long statement at xl steps down, never below the quote size scaled by the step.
    const long = p10[`p10long-${option}-xl`]
    const scaledFloor = Math.max(31, 0.034 * W) * ratio.xl
    check(long.fontSize >= scaledFloor - 0.05, `p10long-${option}-xl: steps down no lower than ${scaledFloor.toFixed(1)}px (got ${long.fontSize}px)`)
    check(long.fontSize > p10[`p10long-${option}-m`].fontSize, `p10long-${option}-xl: the long statement is larger at xl than at M (${long.fontSize} vs ${p10[`p10long-${option}-m`].fontSize}px)`)
    const deckShot = deckXl[`p10-${option}-m-none`]
    check(Math.abs(deckShot.fontSize - p10[`p10-${option}-m-none`].fontSize * ratio.xl) <= 0.6,
      `${option}: the deck's triggers: {font-body=xl} sets the statement at ${ratio.xl.toFixed(3)} × M (got ${deckShot.fontSize}px, M ${p10[`p10-${option}-m-none`].fontSize}px)`)
    check(Math.abs(deckShot.fontSize - p10[`p10-${option}-xl-none`].fontSize) <= 0.05,
      `${option}: the deck's triggers: {font-body=xl} sets the statement as the slide's own xl does (${deckShot.fontSize} vs ${p10[`p10-${option}-xl-none`].fontSize}px)`)
  }
  if (failures) throw new Error(`${failures} preview.10 statement check(s) failed`)
  console.log('PASS preview.10: Full colour paints the whole slide (authored bg or section colour), no panel or bar; statement type follows font-body (slide and deck) in all five options, titled and title-as-statement, floor scaled')
} finally {
  await browser.close()
}
console.log('statement options look (ADR-0028 §10): all checks passed')

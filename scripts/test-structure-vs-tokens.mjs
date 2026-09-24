import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'

// Ticket "Author wins": structure (a heading with child headings and an empty body) supplies the
// section-divider DEFAULT. It never overrules the author. Any token the author put on the heading
// — bar the system/provenance and section-container keys — means the author decided the slide, so
// the normal layout inference and role derivation run with those tokens winning.

const OUTLINE = [
  '---',
  'title: Structure vs tokens',
  '---',
  '',
  '## Section one',
  '',
  '### Opening filler',
  '',
  '- Absorbs the opening-slide heuristic',
  '',
  '### AI intern can help you draft your schedules and manage your calendar {reveal}',
  '',
  '### Clear thinking matters {titletop}',
  '',
  '### Bare parent',
  '',
  '#### Bare child',
  '',
  '- Child body',
  '',
  '### Bare carousel {carousel}',
  '',
  '#### A carousel heading states itself',
  '',
  '### Token childless {poll=open}{titletop}',
  '',
  '### Token parent {poll=open}{titletop}',
  '',
  '#### Token child',
  '',
  '- Child body',
  '',
  '### Role parent {role=content}',
  '',
  '#### Role child',
  '',
  '- Child body',
  '',
  '### System parent {id=system-parent}',
  '',
  '#### System child',
  '',
  '- Child body',
  '',
  '### Sub parent {sub}',
  '',
  '#### Sub child',
  '',
  '- Child body',
  '',
  '### Named divider parent {role=subsection-title}',
  '',
  '#### Named divider child',
  '',
  '- Child body',
  '',
  // The fold runs before slide ids are stamped, so contrast-groups-count can only name a heading
  // that carries an explicit id — hence {id=…} here.
  '### Contrast refused {id=contrast-refused}{contrast}',
  '',
  ...[1, 2, 3, 4].flatMap((n) => [`#### Contrast approach ${n}`, '', `Explanation ${n}.`, '']),
  '### Columns refused {columns}',
  '',
  '#### Lone column',
  '',
  '- Child body',
  ''
].join('\n')

const dir = mkdtempSync(join(tmpdir(), 'tw-structure-vs-tokens-'))
const path = join(dir, 'structure-vs-tokens.md')
writeFileSync(path, OUTLINE, 'utf8')
const model = await prepareSource(path, OUTLINE, 'Structure vs tokens', statSync(path))
const compiledHtml = await buildDeckHtmlFromModel(model)
const document = new JSDOM(compiledHtml).window.document

const byId = new Map(model.slides.map((slide) => [slide.id, slide]))
const slide = (id) => {
  const found = byId.get(id)
  assert(found, `fixture slide ${id} is missing (ids: ${[...byId.keys()].join(', ')})`)
  return found
}
const warnings = model.warnings ?? []
const hasWarning = (id, slideId) =>
  warnings.some((raw) => String(raw).startsWith(`${id}:${slideId}:`) || String(raw) === `${id}:${slideId}`)

const slideWithTitle = (title) => {
  const found = model.slides.find((candidate) => candidate.navTitle === title)
  assert(found, `fixture slide titled "${title}" is missing`)
  return found
}

const renderedSlideWithTitle = (title) => {
  const found = [...document.querySelectorAll('section.slide')]
    .find((candidate) => candidate.getAttribute('data-nav-title') === title)
  assert(found, `rendered fixture slide titled "${title}" is missing`)
  return found
}

// A placement-only token does not stop a bodyless leaf heading from stating itself. `{titletop}`
// still applies after inference: the heading is drawn at the top and the promoted statement body
// remains present, matching a statement slide that has an authored body.
const titleTopText = 'Clear thinking matters'
const titleTopBare = slideWithTitle(titleTopText)
assert.equal(titleTopBare.layout, 'statement', '{titletop}: a bare leaf infers the statement layout')
assert.equal(titleTopBare.role, 'content', '{titletop}: a bare leaf keeps the content role')
assert.equal(titleTopBare.titleTop, true, '{titletop}: the inferred statement retains its placement token')
const renderedTitleTop = renderedSlideWithTitle(titleTopText)
assert.equal(renderedTitleTop.getAttribute('data-layout'), 'statement', '{titletop}: emitted markup records statement')
assert.equal(renderedTitleTop.getAttribute('data-title-layout'), 'top', '{titletop}: the statement title is drawn at the top')
assert.equal(renderedTitleTop.querySelector('.layout-statement > .slide-head:not(.slide-head-quiet) h1')?.textContent, titleTopText, '{titletop}: the visible top title retains the heading text')
assert.equal(renderedTitleTop.querySelector('.layout-statement > p')?.textContent, titleTopText, '{titletop}: the heading text also becomes the statement body')

// A stepping-only token likewise leaves layout inference alone. With no title-placement override,
// the promoted statement keeps the established quiet-heading treatment and reveal mode survives.
const revealText = 'AI intern can help you draft your schedules and manage your calendar'
const revealBare = slideWithTitle(revealText)
assert.equal(revealBare.layout, 'statement', '{reveal}: a bare leaf infers the statement layout')
assert.equal(revealBare.role, 'content', '{reveal}: a bare leaf keeps the content role')
assert.equal(revealBare.mode, 'reveal', '{reveal}: the inferred statement retains its stepping mode')
const renderedReveal = renderedSlideWithTitle(revealText)
assert.equal(renderedReveal.getAttribute('data-layout'), 'statement', '{reveal}: emitted markup records statement')
assert.equal(renderedReveal.getAttribute('data-title-layout'), 'hidden', '{reveal}: the promoted statement keeps its quiet heading')
assert.equal(renderedReveal.querySelector('.slide-head-quiet .sr-only')?.textContent, revealText, '{reveal}: navigation text remains in the quiet heading')
assert.equal(renderedReveal.querySelector('.layout-statement > p')?.textContent, revealText, '{reveal}: the heading text becomes the statement body')

// The already-lexed inference mirror serves carousel children. A heading-only child follows the
// same statement-of-itself rule rather than becoming an empty list sub-slide.
const bareCarousel = slide('bare-carousel')
assert.equal(bareCarousel.layout, 'carousel', 'the bare carousel fixture keeps its authored parent layout')
assert.equal(bareCarousel.carousel?.[0]?.layout, 'statement', 'a bodyless carousel child infers statement in the block-list mirror')

// ADR-0005 geometry proof at both required stage sizes. Range rectangles expose the actual word
// distribution after browser line breaking; the slide rectangle supplies the effective scale when
// the fixed 1600×900 stage is fitted into the smaller viewport.
const geometryTitle = 'AI intern can help you draft your schedules and manage your calendar'
const geometry = []
const browser = await chromium.launch({ headless: true })
try {
  for (const viewport of [{ width: 1600, height: 900 }, { width: 1280, height: 720 }]) {
    const page = await browser.newPage({ viewport })
    await page.setContent(compiledHtml, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    const measured = await page.evaluate((title) => {
      const slides = [...document.querySelectorAll('section.slide')]
      const target = slides.find((candidate) => candidate.getAttribute('data-nav-title') === title)
      if (!target) throw new Error(`geometry slide "${title}" is missing`)
      slides.forEach((candidate) => candidate.classList.toggle('active', candidate === target))
      const content = target.querySelector('.slide-content')
      const statement = target.querySelector('.layout-statement > p')
      if (!content || !statement || !statement.firstChild) throw new Error('statement geometry nodes are missing')

      const slideRect = target.getBoundingClientRect()
      const contentRect = content.getBoundingClientRect()
      const statementRect = statement.getBoundingClientRect()
      const cssSlideWidth = Number.parseFloat(getComputedStyle(target).width)
      const scale = slideRect.width / cssSlideWidth
      const words = [...statement.textContent.matchAll(/\S+/g)].map((match) => {
        const range = document.createRange()
        range.setStart(statement.firstChild, match.index)
        range.setEnd(statement.firstChild, match.index + match[0].length)
        const rect = range.getBoundingClientRect()
        return { word: match[0], top: Math.round(rect.top * 2) / 2 }
      })
      const lines = []
      for (const word of words) {
        const line = lines.find((candidate) => Math.abs(candidate.top - word.top) <= 1)
        if (line) line.words.push(word.word)
        else lines.push({ top: word.top, words: [word.word] })
      }
      return {
        fontPx: Number((Number.parseFloat(getComputedStyle(statement).fontSize) * scale).toFixed(2)),
        panelWidthPx: Number(statementRect.width.toFixed(2)),
        coverage: Number((statementRect.width / slideRect.width).toFixed(4)),
        lines: lines.map((line) => line.words),
        horizontalGapDeltaPx: Number(Math.abs(
          (statementRect.left - contentRect.left) - (contentRect.right - statementRect.right)
        ).toFixed(2)),
        verticalGapDeltaPx: Number(Math.abs(
          (statementRect.top - contentRect.top) - (contentRect.bottom - statementRect.bottom)
        ).toFixed(2))
      }
    }, geometryTitle)
    geometry.push({ viewport: `${viewport.width}x${viewport.height}`, ...measured })
    assert(measured.fontPx >= 31, `${viewport.width}x${viewport.height}: statement type stays at or above the 31px floor; got ${measured.fontPx}px`)
    assert(measured.lines.length <= 3, `${viewport.width}x${viewport.height}: the 12-word statement uses at most three lines; got ${measured.lines.length}`)
    assert(measured.lines.every((line) => line.length > 1), `${viewport.width}x${viewport.height}: no line contains one word (${JSON.stringify(measured.lines)})`)
    assert(measured.coverage >= 0.5, `${viewport.width}x${viewport.height}: the statement covers at least half the stage width; got ${measured.coverage}`)
    assert(measured.horizontalGapDeltaPx <= 2, `${viewport.width}x${viewport.height}: horizontal whitespace is balanced; gap delta ${measured.horizontalGapDeltaPx}px`)
    assert(measured.verticalGapDeltaPx <= 2, `${viewport.width}x${viewport.height}: vertical whitespace is balanced; gap delta ${measured.verticalGapDeltaPx}px`)
    await page.close()
  }
} finally {
  await browser.close()
}

// (a) A BARE parent heading — children, empty body, no author tokens — is still the divider.
const bare = slide('bare-parent')
assert.equal(bare.layout, 'section-title', '(a) a bare parent heading keeps the section-divider layout')
assert.equal(bare.role, 'subsection-title', '(a) a bare parent heading keeps the derived divider role')
assert.equal(
  hasWarning('divider-default-suppressed-by-tokens', 'bare-parent'), false,
  '(a) a bare parent heading warns about nothing'
)

// (b) Author tokens win over the structural divider default. Once that default is suppressed,
// ordinary inference still sees the structural difference: the childless bare heading is its own
// statement, while the parent has child slides and therefore retains the empty list fallback.
const childless = slide('token-childless')
const parent = slide('token-parent')
assert.equal(
  parent.role, childless.role,
  `(b) a tokened parent heading takes the same role as its childless sibling (${parent.role} vs ${childless.role})`
)
assert.equal(
  parent.titleTop, childless.titleTop,
  '(b) {titletop} survives on a tokened parent heading (data-title-layout="top")'
)
assert.equal(childless.layout, 'statement', '(b) non-layout tokens do not stop a childless bare heading from stating itself')
assert.equal(parent.layout, 'list', '(b) the tokened parent heading infers its layout from content, not structure')
assert.equal(parent.role, 'content', '(b) the tokened parent heading is a content slide, not a divider')
assert.equal(parent.titleTop, true, '(b) {titletop} is honoured on the tokened parent heading')
assert.equal(
  hasWarning('divider-default-suppressed-by-tokens', 'token-parent'), true,
  `(b) the suppressed divider default is reported (warnings: ${warnings.join(', ')})`
)
assert.equal(
  warnings.filter((raw) => String(raw).startsWith('divider-default-suppressed-by-tokens:token-parent')).length, 1,
  '(b) the suppressed-divider hint is emitted once per slide'
)

// (c) An explicit role beats the derived divider role.
const roleParent = slide('role-parent')
assert.equal(roleParent.role, 'content', '(c) an explicit {role=content} beats the derived divider role')
assert.equal(
  hasWarning('role-token-overrides-structure', 'role-parent'), true,
  `(c) the overridden divider role is reported (warnings: ${warnings.join(', ')})`
)

// (d) System/provenance tokens are not author decisions.
const systemParent = slide('system-parent')
assert.equal(systemParent.layout, 'section-title', '(d) an {id=…} alone leaves the divider default in place')
assert.equal(systemParent.role, 'subsection-title', '(d) an {id=…} alone leaves the derived divider role in place')
assert.equal(
  hasWarning('divider-default-suppressed-by-tokens', 'system-parent'), false,
  '(d) a system-token-only heading raises no suppressed-divider hint'
)

// (e) A token that ASKS for the divider cannot suppress it: {sub} is the registered
// subsection-divider trigger and {role=subsection-title} names the divider outright.
for (const id of ['sub-parent', 'named-divider-parent']) {
  assert.equal(slide(id).layout, 'section-title', `(e) ${id} keeps the divider it asked for`)
  assert.equal(slide(id).role, 'subsection-title', `(e) ${id} keeps the derived divider role`)
  assert.equal(
    hasWarning('divider-default-suppressed-by-tokens', id), false,
    `(e) ${id} raises no suppressed-divider hint`
  )
  assert.equal(
    hasWarning('role-token-overrides-structure', id), false,
    `(e) ${id} raises no role-override hint`
  )
}

// (g) "Author wins" stops at an empty slide. An absorbing family (contrast/compare/columns/…)
// draws its #### children INSIDE the parent. When the fold is refused — contrast wants 2–3
// children, columns wants 2+ — the children stay as their own slides and the parent has nothing
// left to draw, so the divider default stands rather than rendering a blank. The refusal is
// reported on its own terms, never as a suppressed divider.
const contrastRefused = slide('contrast-refused')
assert.equal(contrastRefused.layout, 'section-title', '(g) a refused contrast fold keeps the section-divider layout')
assert.equal(contrastRefused.role, 'subsection-title', '(g) a refused contrast fold keeps the derived divider role')
assert.equal(
  (contrastRefused.blocks ?? []).length, 0,
  '(g) the refused contrast parent holds no blocks — which is why it must not take the contrast layout'
)
assert.equal(
  warnings.some((raw) => String(raw).startsWith('contrast-groups-count:contrast-refused')), true,
  `(g) the refused fold is still reported as a group-count problem (warnings: ${warnings.join(', ')})`
)
assert.equal(
  hasWarning('divider-default-suppressed-by-tokens', 'contrast-refused'), false,
  '(g) a refused fold raises no suppressed-divider hint — the divider was never suppressed'
)

const columnsRefused = slide('columns-refused')
assert.equal(columnsRefused.layout, 'section-title', '(g) a refused columns fold keeps the section-divider layout')
assert.equal(columnsRefused.role, 'subsection-title', '(g) a refused columns fold keeps the derived divider role')
assert.equal(
  hasWarning('divider-default-suppressed-by-tokens', 'columns-refused'), false,
  '(g) a silently refused columns fold raises no suppressed-divider hint'
)

// Nav bookkeeping is untouched: every parent heading still opens its subsection.
for (const id of ['bare-parent', 'token-parent', 'role-parent', 'system-parent', 'sub-parent', 'named-divider-parent', 'contrast-refused', 'columns-refused']) {
  assert.equal(slide(id).isSection, true, `${id} remains a section node for navigation`)
  assert.equal(
    (model.subsections ?? []).some((sub) => sub.id === id), true,
    `${id} still registers its subsection for navigation`
  )
}

console.log(`structure vs tokens geometry: ${JSON.stringify(geometry)}`)
console.log('structure vs tokens: PASS (bare statements, mirrored carousel inference, divider and author-token precedence)')

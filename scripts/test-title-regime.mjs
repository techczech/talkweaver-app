// =============================================================================
// Title regime (ADR-0023 §2, Dominik's pick A3)
//
// The contract this guards:
//   1. every registry layout declares a titleRegime — the registry is the authority;
//   2. the compiler resolves that regime into data-title-layout, one class at a time;
//   3. every author override in the title-placement / title-display option groups beats the class;
//   4. the title is NEVER demoted to a kicker — no emitted .kicker text ever equals its slide title;
//   5. the auto deck-title / auto closing and an authored {title}/{closing} share one head emitter.
//
// It compiles real decks (prepareSource → buildDeckHtmlFromModel), never a stubbed renderer, so a
// regression in the generator, the resolver or the registry all land here.
// =============================================================================
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { JSDOM } from 'jsdom'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'
import { TITLE_REGIME_BY_LAYOUT } from '../compiler/scripts/lib/trigger-dictionary.generated.mjs'
import { buildLayoutSampler } from './build-layout-sampler.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(tmpdir(), 'tw-title-regime-'))
let probe = 0

async function loadRegistry() {
  const source = readFileSync(join(repo, 'src/shared/layout-registry/entries.ts'), 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
  }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
}

// One probe slide under a real section, authored exactly as the sampler authors a slide (trigger
// line beneath the heading), with no auto title/closing slides — so the LAST slide is the probe.
async function compileSlide(title, trigger, body = ['- One', '- Two']) {
  const source = [
    '---', `title: ${title}`, 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
    '## Fixtures', '', `### ${title}`, ...(trigger ? [trigger] : []), '', ...body
  ].join('\n')
  const path = join(dir, `${++probe}.md`)
  writeFileSync(path, source, 'utf8')
  const model = await prepareSource(path, source, title, statSync(path))
  return { model, html: await buildDeckHtmlFromModel(model) }
}

function firstSlide(html) {
  const sections = [...new JSDOM(html).window.document.querySelectorAll('section.slide')]
  const section = sections.at(-1)
  assert(section, 'compiled deck has a slide')
  return section
}

const placementOf = (section) => section.getAttribute('data-title-layout') ?? ''
const headClassesOf = (section) => {
  const head = section.querySelector(':scope > .slide-content > header.slide-head')
  return head ? [...head.classList].sort().join(' ') : '(no head)'
}

// -----------------------------------------------------------------------------
// 1. Every registry layout declares a regime, and the generated map carries it.
// -----------------------------------------------------------------------------
const { LAYOUTS } = await loadRegistry()
const REGIMES = new Set(['sidebar', 'top', 'hidden', 'own'])
const undeclared = LAYOUTS.filter((entry) => entry.kind === 'layout' && !entry.titleRegime).map((entry) => entry.name)
assert.deepEqual(undeclared, [], `every kind:"layout" registry entry declares a titleRegime: missing ${undeclared.join(', ')}`)
const badValue = LAYOUTS.filter((entry) => entry.titleRegime && !REGIMES.has(entry.titleRegime)).map((entry) => entry.name)
assert.deepEqual(badValue, [], 'titleRegime values come from the declared union')
// 'own' belongs to the structural slides only — every other layout takes a stage regime.
const ownEntries = LAYOUTS.filter((entry) => entry.titleRegime === 'own').map((entry) => entry.name).sort()
assert.deepEqual(ownEntries, ['closing', 'section', 'subsection', 'title'], 'only the structural slides own their stage')
// The generated compiler map is the registry, keyed by the compiled layout slug.
for (const entry of LAYOUTS) {
  if (!entry.titleRegime) continue
  const slug = entry.resolvesTo?.key === 'layout' ? String(entry.resolvesTo.value) : entry.name
  assert.equal(
    TITLE_REGIME_BY_LAYOUT[slug], entry.titleRegime,
    `generated TITLE_REGIME_BY_LAYOUT carries ${entry.name} (slug ${slug}) as ${entry.titleRegime}`
  )
}
// The divider slug the compiler actually stamps is covered too.
assert.equal(TITLE_REGIME_BY_LAYOUT['section-title'], 'own', 'the section-divider slug resolves to the own regime')

// -----------------------------------------------------------------------------
// 2. The compiler resolves each class — one minimal fixture per regime.
// -----------------------------------------------------------------------------
const CLASS_FIXTURES = [
  { trigger: '{list}', regime: 'sidebar', expect: 'left' },
  { trigger: '{statement}', regime: 'sidebar', expect: 'left', body: ['Judgement is not a capability.'] },
  { trigger: '{contrast}', regime: 'sidebar', expect: 'left', body: ['- Old / New'] },
  { trigger: '{stmt-list}', regime: 'top', expect: 'top', body: ['A claim worth dwelling on.', '', '- One', '- Two'] },
  { trigger: '{links}', regime: 'sidebar', expect: 'left', body: ['- [Deliberate practice](https://example.com)'] },
  { trigger: '{cards}', regime: 'top', expect: 'top', body: ['- One', '  - First card', '- Two', '  - Second card', '- Three', '  - Third card'] },
  { trigger: '{copy-visual}', regime: 'top', expect: 'top', body: ['Some copy.', '', '![Figure](figure.png)'] },
  { trigger: '{timeline}', regime: 'top', expect: 'top', body: ['**Timeline:**', '', '- 2022 — One', '- 2023 — Two'] },
  { trigger: '{table}', regime: 'top', expect: 'top', body: ['| A | B |', '| --- | --- |', '| 1 | 2 |'] },
  { trigger: '{flow}', regime: 'top', expect: 'top', body: ['- One', '- Two', '- Three'] },
  { trigger: '{columns}', regime: 'top', expect: 'top', body: ['One.', '', 'Two.'] },
  { trigger: '{quote}', regime: 'hidden', expect: 'hidden', body: ['> Capability is not judgement.', '', '- Source'] },
  { trigger: '{compare}', regime: 'hidden', expect: 'hidden', body: ['#### Can', '', 'Draft.', '', '#### Cannot', '', 'Decide.'] },
  { trigger: '{title}', regime: 'own', expect: '', body: ['A subtitle line.'] },
  { trigger: '{closing}', regime: 'own', expect: '', body: ['Thank you.'] }
]
for (const fixture of CLASS_FIXTURES) {
  const { html } = await compileSlide('Regime probe', fixture.trigger, fixture.body)
  const section = firstSlide(html)
  const layout = section.getAttribute('data-layout')
  assert.equal(
    TITLE_REGIME_BY_LAYOUT[layout], fixture.regime,
    `${fixture.trigger} compiles to layout "${layout}", whose registry regime is ${fixture.regime}`
  )
  assert.equal(placementOf(section), fixture.expect, `${fixture.trigger} → data-title-layout="${fixture.expect}"`)
}

// -----------------------------------------------------------------------------
// 3. Every author override beats the class (both directions).
// -----------------------------------------------------------------------------
const OVERRIDES = [
  // token,        on a sidebar-class layout, on a top-class layout
  { token: '{titletop}', onSidebar: 'top', onTop: 'top' },
  { token: '{notitle}', onSidebar: 'hidden', onTop: 'hidden' },
  { token: '{sidebar}', onSidebar: 'left', onTop: 'left' },
  { token: '{title=side}', onSidebar: 'left', onTop: 'left' },
  { token: '{title=top}', onSidebar: 'top', onTop: 'top' },
  { token: '{split=30}', onSidebar: 'left', onTop: 'left', split: '30' },
  { token: '{split=40}', onSidebar: 'left', onTop: 'left', split: '40' },
  { token: '{split=50}', onSidebar: 'left', onTop: 'left', split: '50' },
  { token: '{sidebar-40}', onSidebar: 'left', onTop: 'left', split: '40' }
]
for (const override of OVERRIDES) {
  for (const [base, key, body] of [
    ['{list}', 'onSidebar', ['- One', '- Two']],
    ['{table}', 'onTop', ['| A | B |', '| --- | --- |', '| 1 | 2 |']]
  ]) {
    const trigger = `${base.slice(0, -1)} ${override.token.slice(1)}`
    const { html } = await compileSlide('Override probe', trigger, body)
    const section = firstSlide(html)
    assert.equal(placementOf(section), override[key], `${trigger} → data-title-layout="${override[key]}"`)
    if (override.split) assert.equal(section.getAttribute('data-split'), override.split, `${trigger} → data-split="${override.split}"`)
  }
}
// {title=show} restores the heading a hidden-regime layout suppresses, in the rail.
{
  const { html } = await compileSlide('Quote with a title', '{quote title=show}', ['> Capability is not judgement.'])
  const section = firstSlide(html)
  assert.equal(placementOf(section), 'left', '{quote title=show} → the rail, not the hidden regime')
  assert.equal(headClassesOf(section), 'slide-head', '{quote title=show} paints a normal head')
}

// -----------------------------------------------------------------------------
// 4. The title is never demoted to a kicker — anywhere in the sampler.
// -----------------------------------------------------------------------------
const { html: samplerHtml } = await buildLayoutSampler()
const samplerDoc = new JSDOM(samplerHtml).window.document
const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
const duplicated = []
const compactHeads = []
for (const section of samplerDoc.querySelectorAll('section.slide')) {
  const title = norm(section.getAttribute('data-nav-title'))
  for (const head of section.querySelectorAll('header.slide-head')) {
    if (head.classList.contains('slide-head-compact')) compactHeads.push(section.getAttribute('data-id'))
    for (const kicker of head.querySelectorAll('.kicker')) {
      if (title && norm(kicker.textContent) === title) duplicated.push(`${section.getAttribute('data-id')}: "${kicker.textContent}"`)
    }
  }
}
assert.deepEqual(compactHeads, [], `the compact kicker-title head is abolished (ADR-0023 §2); still emitted on: ${compactHeads.join(', ')}`)
assert.deepEqual(duplicated, [], `no .kicker may repeat its slide title (ADR-0005 no duplicated information): ${duplicated.join(' | ')}`)
assert.equal(samplerHtml.includes('kicker-title'), false, 'the kicker-title span is gone from the compiled deck')
assert.equal(samplerHtml.includes('kicker-compact'), false, 'the kicker-compact class is gone from the compiled deck')

// -----------------------------------------------------------------------------
// 5. One head emitter: auto deck-title ≡ authored {title}, auto closing ≡ authored {closing}.
// -----------------------------------------------------------------------------
{
  const source = [
    '---', 'title: One emitter', 'subtitle: Auto and authored agree', 'author: Dominik Lukeš', '---', '',
    '# One emitter', '', '## Structural', '', '### Authored title slide', '{title}', '', 'A subtitle line.', '',
    '### Authored closing', '{closing}', '', 'Thank you.'
  ].join('\n')
  const path = join(dir, 'emitter.md')
  writeFileSync(path, source, 'utf8')
  const model = await prepareSource(path, source, 'One emitter', statSync(path))
  const doc = new JSDOM(await buildDeckHtmlFromModel(model)).window.document
  const byId = (id) => {
    const section = doc.querySelector(`section.slide[data-id="${id}"]`)
    assert(section, `deck carries the ${id} slide`)
    return section
  }
  const byLayout = (layout, role) => {
    const section = [...doc.querySelectorAll(`section.slide[data-layout="${layout}"]`)]
      .find((candidate) => candidate.getAttribute('data-role') === role)
    assert(section, `deck carries an authored ${layout} slide`)
    return section
  }
  const autoTitle = byId('deck-title')
  const authoredTitle = byLayout('title', 'content')
  const autoClosing = byId('deck-thanks')
  const authoredClosing = byLayout('closing', 'content')
  assert.equal(headClassesOf(authoredTitle), headClassesOf(autoTitle), 'authored {title} and the auto deck-title share one head form')
  assert.equal(placementOf(authoredTitle), placementOf(autoTitle), 'authored {title} and the auto deck-title share one title regime')
  assert.equal(headClassesOf(authoredClosing), headClassesOf(autoClosing), 'authored {closing} and the auto closing share one head form')
  assert.equal(placementOf(authoredClosing), placementOf(autoClosing), 'authored {closing} and the auto closing share one title regime')
}


// -----------------------------------------------------------------------------
// 6. Compact top title (ADR-0033 §2, round-b notes §3): computed size, paddings and rule gap on the
//    top regime, no 18-character cap, the rescaled ladder, left-rail untouched, fitTitle intact.
//    Read in headless Chromium; the stage is a 1280×720 canvas, so 3.9cqw = 49.92px (75px at 1920).
// -----------------------------------------------------------------------------
{
  const { chromium } = await import('playwright')
  const LONG = 'York expenses: from email to completed forms'
  const source = [
    '---', 'title: Compact title probe', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
    '## Fixtures', '',
    `### ${LONG}`, '{titletop} {id=t-top}', '', '- One', '- Two', '',
    '### Rail title stays', '{sidebar} {id=t-rail}', '', '- One', '- Two', '',
    ...['xs', 's', 'l', 'xl'].flatMap((size) => [`### Ladder ${size}`, `{titletop} {font-title=${size}} {id=t-${size}}`, '', '- One', '- Two', '']),
    '### Unbreakablesupercalifragilisticexpialidociousxxxxxxxxxxxxx', '{titletop} {id=t-fit}', '', '- One', '- Two'
  ].join('\n')
  const path = join(dir, 'compact.md')
  writeFileSync(path, source, 'utf8')
  const model = await prepareSource(path, source, 'Compact title probe', statSync(path))
  const htmlPath = join(dir, 'compact.html')
  writeFileSync(htmlPath, model.fullHtml, 'utf8')
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
    await page.goto(`file://${htmlPath}`, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    const probe = (id) => page.evaluate((slideId) => {
      const slides = [...document.querySelectorAll('.stage > .slide')]
      const slide = slides.find((node) => node.dataset.id === slideId)
      if (!slide) return null
      slides.forEach((node) => node.classList.toggle('active', node === slide))
      window.__autofitForTest?.()
      const stage = slide.parentElement, k = stage.getBoundingClientRect().width / stage.offsetWidth
      const content = slide.querySelector(':scope > .slide-content')
      const head = content.querySelector(':scope > .slide-head')
      const h1 = head.querySelector('h1')
      const cs = getComputedStyle(content), hs = getComputedStyle(head), hh = getComputedStyle(h1)
      const range = document.createRange(); range.selectNodeContents(h1)
      const bottoms = [...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.bottom))
      return {
        titleLayout: slide.dataset.titleLayout,
        stageWidth: stage.offsetWidth,
        fontSize: parseFloat(hh.fontSize), maxWidth: hh.maxWidth, lineHeight: parseFloat(hh.lineHeight),
        padTop: parseFloat(cs.paddingTop), headPadBottom: parseFloat(hs.paddingBottom), headMarginBottom: parseFloat(hs.marginBottom),
        lines: new Set(bottoms).size, h1Width: h1.getBoundingClientRect().width / k, headWidth: head.getBoundingClientRect().width / k,
        overflow: h1.scrollWidth - h1.clientWidth
      }
    }, id)
    const near = (a, b, label, tol = 0.6) => assert(Math.abs(a - b) <= tol, `${label}: expected ${b}, got ${a}`)
    const top = await probe('t-top')
    assert.equal(top.titleLayout, 'top', 'probe slide sits on the top regime')
    assert.equal(top.stageWidth, 1280, 'stage is the 1280 canvas')
    near(top.fontSize, 0.039 * 1280, 'top title size (3.9cqw = 75px at 1920)')
    near(top.padTop, 0.04 * 720, 'space above the title (4cqh)')
    near(top.headPadBottom, 0.011 * 720, 'title to rule (1.1cqh)')
    near(top.headMarginBottom, 0.022 * 720, 'under the rule (2.2cqh)')
    near(top.lineHeight, 1.12 * top.fontSize, 'title line height 1.12')
    assert.equal(top.maxWidth, 'none', 'top title has no 18ch cap')
    assert.equal(top.lines, 1, `"${LONG}" fits on one line`)
    // Left rail: unchanged (its own size and cap; the ladder does not reach it as a top size).
    const rail = await probe('t-rail')
    assert.equal(rail.titleLayout, 'left', 'rail probe is a left-rail title')
    assert.notEqual(rail.maxWidth, 'none', 'left-rail title keeps its width cap')
    near(rail.fontSize, 0.038 * 1280 < 38 ? 38 : 0.038 * 1280, 'left-rail title size unchanged (--fs-rail max(38px, 3.8cqw))')
    // Ladder xs 3.0 / s 3.4 / l 4.6 / xl 5.2 cqw (with px floors 26 / 30 / 40 / 44).
    for (const [size, cqw, floor] of [['xs', 3.0, 26], ['s', 3.4, 30], ['l', 4.6, 40], ['xl', 5.2, 44]]) {
      const got = await probe(`t-${size}`)
      near(got.fontSize, Math.max(floor, cqw / 100 * 1280), `title ladder ${size}`)
    }
    // fitTitle still shrinks an over-long unbreakable top title until it fits (never below 60%).
    const fit = await probe('t-fit')
    assert(fit.fontSize < 0.039 * 1280 - 1, `over-long top title is shrunk by fitTitle (got ${fit.fontSize})`)
    assert(fit.overflow <= 1, 'fitted title no longer overflows')
  } finally {
    await browser.close()
  }
}

console.log(`title regime: PASS (${LAYOUTS.filter((e) => e.kind === 'layout').length} layouts declared, ${CLASS_FIXTURES.length} class fixtures, ${OVERRIDES.length * 2 + 1} override checks, sampler clean)`)

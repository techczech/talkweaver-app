// =============================================================================
// Title looks (0.37 ticket 04): Kicker, Label and Tab on the top title regime.
//   1. compiled markup: data-title-look (+ -at) stamped on top-title slides only;
//   2. precedence: slide > section (`sections:`) > talk default (`title_look:` / `defaults:`);
//   3. `title_style` (the opening poster variant) is unaffected and never reused;
//   4. computed styles in headless Chromium: Kicker is never uppercase, Tab is flush, Label has its edge.
// Compiles real decks (prepareSource -> buildDeckHtmlFromModel); no stubbed renderer.
// =============================================================================
import { strict as assert } from 'node:assert'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSDOM } from 'jsdom'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'
import { GLOBAL_OPTION_GROUPS, LAYOUTS } from '../src/shared/layout-registry/entries.ts'
import { METADATA_REGISTRY } from '../src/shared/metadata-registry.ts'
import { VALUE_TRIGGER_DICTIONARY } from '../compiler/scripts/lib/trigger-dictionary.generated.mjs'
import { optionGroupsForSlide, sectionedOptionGroups } from '../src/shared/layout-registry/options.ts'
import { resolveTitleLook } from '../compiler/scripts/lib/title-look.mjs'

const dir = mkdtempSync(join(tmpdir(), 'tw-title-look-'))
let n = 0
async function compile(frontmatter, slides) {
  const source = [
    '---', 'title: Title look probe', 'auto_title_slide: false', 'auto_thanks_slide: false', ...frontmatter, '---', '',
    ...slides.flatMap(([section, heading, trigger]) => [...(section ? [`## ${section}`, ''] : []), `### ${heading}`, trigger, '', '- One', '- Two', ''])
  ].join('\n')
  const path = join(dir, `${++n}.md`)
  writeFileSync(path, source, 'utf8')
  const model = await prepareSource(path, source, 'Title look probe', statSync(path))
  const html = await buildDeckHtmlFromModel(model)
  const doc = new JSDOM(html).window.document
  const slide = (id) => doc.querySelector(`section.slide[data-id="${id}"]`)
  return { model, html, doc, slide, warnings: model.warnings ?? [] }
}
const look = (slide) => slide?.getAttribute('data-title-look') ?? ''
const at = (slide) => slide?.getAttribute('data-title-look-at') ?? ''

// 0. Registry: the Inspector's Title section and the `{` palette read these groups; the deck key is
//    registered beside (never in place of) the opening slide's title_style.
{
  const lookGroup = GLOBAL_OPTION_GROUPS.find((g) => g.key === 'title-look')
  assert.deepEqual(lookGroup.values.map((v) => v.token), ['', 'titlelook=kicker', 'titlelook=label', 'titlelook=tab'])
  assert.equal(lookGroup.section, 'title')
  assert.deepEqual(VALUE_TRIGGER_DICTIONARY.titlelook, ['default', 'kicker', 'label', 'tab'], 'trigger dictionary carries titlelook')
  assert.deepEqual(VALUE_TRIGGER_DICTIONARY['titlelook-at'], ['normal', 'edge'])
  const keys = METADATA_REGISTRY.map((entry) => entry.key)
  assert(keys.includes('title_look') && keys.includes('title_look_at') && keys.includes('title_style'), 'deck keys registered, title_style kept')
  const topLayout = LAYOUTS.find((e) => e.kind === 'layout' && e.titleRegime === 'top')
  const bindings = optionGroupsForSlide({ layoutName: topLayout.name, headingLevel: 3, hasChildren: false })
  const title = sectionedOptionGroups(bindings).find((s) => s.id === 'title')
  const inTitle = title.bindings.map((b) => `${b.group.key}${b.nestedUnder ? '<' + b.nestedUnder : ''}`)
  assert(inTitle.includes('title-look'), `Inspector Title section offers Look on ${topLayout.name}`)
  assert(inTitle.includes('title-look-at<title-look'), 'Kicker placement nests under Look')
  const railLayout = LAYOUTS.find((e) => e.kind === 'layout' && e.titleRegime === 'sidebar')
  const railGroups = optionGroupsForSlide({ layoutName: railLayout.name, headingLevel: 3, hasChildren: false })
  assert(!railGroups.some((b) => b.group.key === 'title-look'), 'a left-rail layout is not offered a look')
}

// 1. Resolver: precedence, aliases, kicker-only placement, unknown values fall through.
assert.deepEqual(resolveTitleLook({}, {}, {}, {}), { look: '', place: '' })
assert.deepEqual(resolveTitleLook({ titlelook: 'label' }, { titlelook: 'tab' }, { titlelook: 'kicker' }, { title_look: 'tab' }), { look: 'label', place: '' }, 'slide beats section, defaults and talk key')
assert.deepEqual(resolveTitleLook({}, { titlelook: 'tab' }, { titlelook: 'kicker' }, {}), { look: 'tab', place: '' }, 'section beats deck defaults')
assert.deepEqual(resolveTitleLook({}, {}, { titlelook: 'label' }, { title_look: 'tab' }), { look: 'label', place: '' }, 'defaults: beats the title_look key')
assert.deepEqual(resolveTitleLook({}, {}, {}, { title_look: 'tab' }), { look: 'tab', place: '' }, 'the talk key applies')
assert.deepEqual(resolveTitleLook({ titlelook: 'default' }, { titlelook: 'tab' }, {}, {}), { look: '', place: '' }, 'a slide can pin itself to the default')
assert.deepEqual(resolveTitleLook({ titlelook: 'kicker', 'titlelook-at': 'edge' }), { look: 'kicker', place: 'edge' })
assert.deepEqual(resolveTitleLook({ titlelook: 'tab', 'titlelook-at': 'edge' }), { look: 'tab', place: '' }, 'only a kicker has a placement')
assert.deepEqual(resolveTitleLook({ titlelook: 'sparkle' }, {}, {}, { title_look: 'label' }), { look: 'label', place: '' }, 'an unknown value falls through')

// 2. Compiled stamping and precedence.
const deck = await compile(
  ['title_look: label', 'title_style: banner', 'sections:', '  Tabbed: { titlelook: tab }'],
  [
    ['Plain', 'Talk default', '{titletop} {id=s-talk}'],
    [null, 'Slide kicker', '{titletop} {titlelook=kicker} {id=s-kicker}'],
    [null, 'Slide kicker at the edge', '{titletop} {titlelook=kicker} {titlelook-at=edge} {id=s-edge}'],
    [null, 'Slide pinned', '{titletop} {titlelook=default} {id=s-pinned}'],
    [null, 'Rail slide', '{sidebar} {titlelook=kicker} {id=s-rail}'],
    ['Tabbed', 'Section tab', '{titletop} {id=s-section}'],
    [null, 'Section slide wins', '{titletop} {titlelook=label} {id=s-section-slide}']
  ]
)
assert.equal(look(deck.slide('s-talk')), 'label', 'talk-wide title_look reaches an untokened slide')
assert.equal(look(deck.slide('s-kicker')), 'kicker')
assert.equal(at(deck.slide('s-kicker')), '', 'kicker placement defaults to normal (nothing stamped)')
assert.equal(at(deck.slide('s-edge')), 'edge')
assert.equal(look(deck.slide('s-pinned')), '', 'titlelook=default pins one slide against the talk default')
assert.equal(look(deck.slide('s-rail')), '', 'a left-rail title takes no look')
assert.equal(look(deck.slide('s-section')), 'tab', 'a section overrides the talk default')
assert.equal(look(deck.slide('s-section-slide')), 'label', 'a slide overrides its section')
assert.equal(deck.slide('s-talk').hasAttribute('data-title-style'), false, 'the retired data-title-style stamp is not reused')
assert.equal(deck.warnings.some((w) => /title-look/.test(String(w))), false, 'known values raise no warning')

// 3. Unknown deck value warns and falls back; the opening slide's title_style is untouched.
const bad = await compile(['title_look: sparkle', 'title_look_at: high'], [['Plain', 'Probe', '{titletop} {id=b-1}']])
assert(bad.warnings.some((w) => String(w).startsWith('title-look-unknown:sparkle')), 'unknown title_look warns')
assert(bad.warnings.some((w) => String(w).startsWith('title-look-at-unknown:high')), 'unknown title_look_at warns')
assert.equal(look(bad.slide('b-1')), '', 'unknown value falls back to default')
const opening = await compile(['title_style: banner', 'title_look: kicker'], [['Plain', 'Probe', '{titletop} {id=o-1}']])
assert(!opening.warnings.some((w) => /title-style-unknown/.test(String(w))), 'title_style: banner is still read as the opening variant')
assert.equal(look(opening.slide('o-1')), 'kicker')

// 4. Computed styles at 1920x1080 (the stage is the 1280 canvas: 1cqw = 12.8px).
const { chromium } = await import('playwright')
const styled = await compile(['title_look: kicker'], [
  ['Plain', 'A sentence case title for the kicker', '{titletop} {id=c-kicker}'],
  [null, 'Kicker at the edge', '{titletop} {titlelook-at=edge} {id=c-edge}'],
  [null, 'A label title', '{titletop} {titlelook=label} {id=c-label}'],
  [null, 'A tab title', '{titletop} {titlelook=tab} {id=c-tab}'],
  [null, 'A default title', '{titletop} {titlelook=default} {id=c-default}']
])
const htmlPath = join(dir, 'styled.html')
writeFileSync(htmlPath, styled.html, 'utf8')
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
    const stage = slide.parentElement, k = stage.getBoundingClientRect().width / stage.offsetWidth
    const content = slide.querySelector(':scope > .slide-content')
    const head = content.querySelector(':scope > .slide-head'), h1 = head.querySelector('h1')
    const hs = getComputedStyle(head), hh = getComputedStyle(h1), cs = getComputedStyle(content)
    const before = getComputedStyle(h1, '::before')
    const sr = slide.getBoundingClientRect(), hr = h1.getBoundingClientRect()
    return {
      fontSize: parseFloat(hh.fontSize), transform: hh.textTransform, family: hh.fontFamily, weight: hh.fontWeight,
      display: hh.display, background: hh.backgroundColor, color: hh.color, borderLeft: parseFloat(hh.borderLeftWidth),
      headBorder: parseFloat(hs.borderBottomWidth), headMarginBottom: parseFloat(hs.marginBottom), padTop: parseFloat(cs.paddingTop),
      ruleWidth: before.content === 'none' ? 0 : parseFloat(before.width), ruleContent: before.content,
      flushLeft: (hr.left - sr.left) / k, textTop: (hr.top - sr.top) / k, sizeCqw: parseFloat(hh.fontSize) / stage.offsetWidth * 100
    }
  }, id)
  const near = (a, b, label, tol = 0.6) => assert(Math.abs(a - b) <= tol, `${label}: expected ${b}, got ${a}`)

  const kicker = await probe('c-kicker')
  assert.equal(kicker.transform, 'none', 'Kicker is never uppercase')
  assert.equal(kicker.weight, '600', 'Kicker is weight 600')
  assert(/mono|menlo|consolas|courier/i.test(kicker.family), `Kicker is set in the mono face (${kicker.family})`)
  near(kicker.sizeCqw, 2.1, 'Kicker size is 2.1cqw', 0.05)
  assert(kicker.ruleWidth > 0, 'Kicker is led by an accent rule')
  assert.equal(kicker.headBorder, 0, 'the hairline under a corner title is gone')
  const normalTop = kicker.textTop

  const edge = await probe('c-edge')
  assert.equal(edge.padTop, 0, 'edge placement drops the top padding')
  assert.equal(edge.transform, 'none')
  assert(edge.textTop < normalTop - 20, `edge kicker sits nearer the top edge (${edge.textTop} vs ${normalTop})`)

  const label = await probe('c-label')
  assert.equal(label.display, 'inline-block')
  near(label.borderLeft, 0.3 * label.fontSize, 'Label left edge is .3em')
  assert.notEqual(label.background, 'rgba(0, 0, 0, 0)', 'Label is tinted')
  near(label.sizeCqw, 2.35, 'Label size is 2.35cqw', 0.05)

  const tab = await probe('c-tab')
  assert.equal(tab.display, 'inline-block')
  near(tab.flushLeft, 0, 'Tab is flush with the slide edge', 1)
  assert.equal(tab.color, 'rgb(255, 255, 255)', 'Tab title is white on the accent')
  near(tab.sizeCqw, 2.35, 'Tab size is 2.35cqw', 0.05)

  const plain = await probe('c-default')
  assert(plain.fontSize > 40, `the default title keeps the compact 3.9cqw size (${plain.fontSize})`)
  assert.equal(plain.headBorder, 2, 'the default title keeps its hairline')
} finally {
  await browser.close()
}

console.log('title look: PASS (resolver, stamping, precedence, opening untouched, computed styles)')

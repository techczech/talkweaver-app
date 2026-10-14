// =============================================================================
// Title looks (0.37 ticket 04): Kicker, Label and Tab on the top title regime.
//   1. compiled markup: data-title-look (+ -tone=soft on a soft Tab) stamped on top-title slides only;
//   2. precedence: slide > section (`sections:`) > talk default (`title_look:` / `defaults:`);
//   3. `title_style` (the opening poster variant) is unaffected and never reused;
//   4. computed styles in headless Chromium at 1920x1080: Kicker is never uppercase, Tab is flush with equal space either side
//      of the title, Label has its edge, none of them shrinks the body type.
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
async function compile(frontmatter, slides, body = '- One\n- Two') {
  const source = [
    '---', 'title: Title look probe', 'auto_title_slide: false', 'auto_thanks_slide: false', ...frontmatter, '---', '',
    ...slides.flatMap(([section, heading, trigger]) => [...(section ? [`## ${section}`, ''] : []), `### ${heading}`, trigger, '', body, ''])
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
const tone = (slide) => slide?.getAttribute('data-title-look-tone') ?? ''

// 0. Registry: the Inspector's Title section and the `{` palette read these groups; the deck key is
//    registered beside (never in place of) the opening slide's title_style.
{
  const lookGroup = GLOBAL_OPTION_GROUPS.find((g) => g.key === 'title-look')
  assert.deepEqual(lookGroup.values.map((v) => v.token), ['', 'titlelook=kicker', 'titlelook=label', 'titlelook=tab'])
  assert.equal(lookGroup.section, 'title')
  assert.deepEqual(VALUE_TRIGGER_DICTIONARY.titlelook, ['default', 'kicker', 'label', 'tab'], 'trigger dictionary carries titlelook')
  assert.deepEqual(VALUE_TRIGGER_DICTIONARY['titlelook-tone'], ['strong', 'soft'], 'trigger dictionary carries titlelook-tone')
  assert(VALUE_TRIGGER_DICTIONARY['titlelook-at'].includes('edge'), 'titlelook-at stays accepted vocabulary (ignored)')
  const toneGroup = GLOBAL_OPTION_GROUPS.find((g) => g.key === 'title-look-tone')
  assert.deepEqual(toneGroup.values.map((v) => v.token), ['', 'titlelook-tone=soft'], 'tone: strong stores nothing, soft is the one token')
  assert(!GLOBAL_OPTION_GROUPS.some((g) => g.key === 'title-look-at'), 'no Kicker placement control any more')
  const keys = METADATA_REGISTRY.map((entry) => entry.key)
  assert(keys.includes('title_look') && keys.includes('title_look_tone') && !keys.includes('title_look_at') && keys.includes('title_style'), 'deck keys registered, title_style kept')
  const topLayout = LAYOUTS.find((e) => e.kind === 'layout' && e.titleRegime === 'top')
  const bindings = optionGroupsForSlide({ layoutName: topLayout.name, headingLevel: 3, hasChildren: false })
  const title = sectionedOptionGroups(bindings).find((s) => s.id === 'title')
  const inTitle = title.bindings.map((b) => `${b.group.key}${b.nestedUnder ? '<' + b.nestedUnder : ''}`)
  assert(inTitle.includes('title-look'), `Inspector Title section offers Look on ${topLayout.name}`)
  assert(inTitle.includes('title-look-tone<title-look'), 'Tab tone nests under Look')
  const railLayout = LAYOUTS.find((e) => e.kind === 'layout' && e.titleRegime === 'sidebar')
  const railGroups = optionGroupsForSlide({ layoutName: railLayout.name, headingLevel: 3, hasChildren: false })
  assert(!railGroups.some((b) => b.group.key === 'title-look'), 'a left-rail layout is not offered a look')
}

// 1. Resolver: precedence, aliases, kicker-only placement, unknown values fall through.
assert.deepEqual(resolveTitleLook({}, {}, {}, {}), { look: '', tone: '' })
// Tab tone: strong is the default and stamps nothing; soft only counts for a Tab; same precedence as the look.
assert.deepEqual(resolveTitleLook({ titlelook: 'tab' }), { look: 'tab', tone: '' }, 'tone defaults to strong')
assert.deepEqual(resolveTitleLook({ titlelook: 'tab', 'titlelook-tone': 'soft' }), { look: 'tab', tone: 'soft' })
assert.deepEqual(resolveTitleLook({ titlelook: 'tab', 'titlelook-tone': 'strong' }, {}, { 'titlelook-tone': 'soft' }), { look: 'tab', tone: '' }, 'a slide pins strong against a soft default')
assert.deepEqual(resolveTitleLook({ titlelook: 'kicker', 'titlelook-tone': 'soft' }), { look: 'kicker', tone: '' }, 'only a Tab has a tone')
assert.deepEqual(resolveTitleLook({ titlelook: 'tab' }, { 'titlelook-tone': 'soft' }, { 'titlelook-tone': 'strong' }, { title_look_tone: 'strong' }), { look: 'tab', tone: 'soft' }, 'section beats deck defaults')
assert.deepEqual(resolveTitleLook({}, {}, { titlelook: 'tab', 'titlelook-tone': 'strong' }, { title_look_tone: 'soft' }), { look: 'tab', tone: '' }, 'defaults: beats the title_look_tone key')
assert.deepEqual(resolveTitleLook({ titlelook: 'tab' }, {}, {}, { title_look_tone: 'soft' }), { look: 'tab', tone: 'soft' }, 'the talk key applies')
assert.deepEqual(resolveTitleLook({ titlelook: 'tab', 'titlelook-tone': 'sparkle' }, {}, {}, { title_look_tone: 'soft' }), { look: 'tab', tone: 'soft' }, 'an unknown tone falls through')
assert.deepEqual(resolveTitleLook({ titlelook: 'label' }, { titlelook: 'tab' }, { titlelook: 'kicker' }, { title_look: 'tab' }), { look: 'label', tone: '' }, 'slide beats section, defaults and talk key')
assert.deepEqual(resolveTitleLook({}, { titlelook: 'tab' }, { titlelook: 'kicker' }, {}), { look: 'tab', tone: '' }, 'section beats deck defaults')
assert.deepEqual(resolveTitleLook({}, {}, { titlelook: 'label' }, { title_look: 'tab' }), { look: 'label', tone: '' }, 'defaults: beats the title_look key')
assert.deepEqual(resolveTitleLook({}, {}, {}, { title_look: 'tab' }), { look: 'tab', tone: '' }, 'the talk key applies')
assert.deepEqual(resolveTitleLook({ titlelook: 'default' }, { titlelook: 'tab' }, {}, {}), { look: '', tone: '' }, 'a slide can pin itself to the default')
assert.deepEqual(resolveTitleLook({ titlelook: 'kicker', 'titlelook-at': 'edge' }), { look: 'kicker', tone: '' }, 'titlelook-at is ignored')
assert.deepEqual(resolveTitleLook({ titlelook: 'sparkle' }, {}, {}, { title_look: 'label' }), { look: 'label', tone: '' }, 'an unknown value falls through')

// 2. Compiled stamping and precedence.
const deck = await compile(
  ['title_look: label', 'title_style: banner', 'sections:', '  Tabbed: { titlelook: tab }'],
  [
    ['Plain', 'Talk default', '{titletop} {id=s-talk}'],
    [null, 'Slide kicker', '{titletop} {titlelook=kicker} {id=s-kicker}'],
    [null, 'Slide kicker at the edge', '{titletop} {titlelook=kicker} {titlelook-at=edge} {id=s-edge}'],
    [null, 'Soft tab', '{titletop} {titlelook=tab} {titlelook-tone=soft} {id=s-soft}'],
    [null, 'Strong tab', '{titletop} {titlelook=tab} {id=s-strong}'],
    [null, 'Soft on a kicker', '{titletop} {titlelook=kicker} {titlelook-tone=soft} {id=s-kicker-soft}'],
    [null, 'Slide pinned', '{titletop} {titlelook=default} {id=s-pinned}'],
    [null, 'Rail slide', '{sidebar} {titlelook=kicker} {id=s-rail}'],
    ['Tabbed', 'Section tab', '{titletop} {id=s-section}'],
    [null, 'Section slide wins', '{titletop} {titlelook=label} {id=s-section-slide}']
  ]
)
assert.equal(look(deck.slide('s-talk')), 'label', 'talk-wide title_look reaches an untokened slide')
assert.equal(look(deck.slide('s-kicker')), 'kicker')
assert.equal(deck.slide('s-edge').hasAttribute('data-title-look-at'), false, 'titlelook-at is accepted and no longer stamped')
assert.equal(look(deck.slide('s-edge')), 'kicker')
assert.equal(tone(deck.slide('s-soft')), 'soft', 'a soft Tab is stamped')
assert.equal(tone(deck.slide('s-strong')), '', 'strong (the default) stamps nothing')
assert.equal(tone(deck.slide('s-kicker-soft')), '', 'only a Tab carries a tone')
assert.equal(look(deck.slide('s-pinned')), '', 'titlelook=default pins one slide against the talk default')
assert.equal(look(deck.slide('s-rail')), '', 'a left-rail title takes no look')
assert.equal(look(deck.slide('s-section')), 'tab', 'a section overrides the talk default')
assert.equal(look(deck.slide('s-section-slide')), 'label', 'a slide overrides its section')
assert.equal(deck.slide('s-talk').hasAttribute('data-title-style'), false, 'the retired data-title-style stamp is not reused')
assert.equal(deck.warnings.some((w) => /title-look/.test(String(w))), false, 'known values raise no warning')

// 3. Unknown deck value warns and falls back; the opening slide's title_style is untouched.
const bad = await compile(['title_look: sparkle', 'title_look_tone: loud'], [['Plain', 'Probe', '{titletop} {id=b-1}']])
assert(bad.warnings.some((w) => String(w).startsWith('title-look-unknown:sparkle')), 'unknown title_look warns')
assert(bad.warnings.some((w) => String(w).startsWith('title-look-tone-unknown:loud')), 'unknown title_look_tone warns')
assert.equal(look(bad.slide('b-1')), '', 'unknown value falls back to default')
const opening = await compile(['title_style: banner', 'title_look: kicker'], [['Plain', 'Probe', '{titletop} {id=o-1}']])
assert(!opening.warnings.some((w) => /title-style-unknown/.test(String(w))), 'title_style: banner is still read as the opening variant')
assert.equal(look(opening.slide('o-1')), 'kicker')

// 4. Computed styles at 1920x1080 (the stage is the 1280 canvas: 1cqw = 12.8px). The title look is
//    the h1 lifted out of the flow; the head stays a zero-height box so the fit pass never counts it.
const { chromium } = await import('playwright')
const LIST = '- First point of the list\n- Second point of the list\n- Third point of the list'
const styled = await compile(['title_look: kicker'], [
  ['Plain', 'A sentence case title for the kicker', '{titletop} {id=c-kicker}'],
  [null, 'Kicker at the edge', '{titletop} {titlelook-at=edge} {id=c-edge}'],
  [null, 'A label title', '{titletop} {titlelook=label} {id=c-label}'],
  [null, 'A tab title', '{titletop} {titlelook=tab} {id=c-tab}'],
  [null, 'A soft tab title', '{titletop} {titlelook=tab} {titlelook-tone=soft} {id=c-soft}'],
  [null, 'Plan', '{titletop} {titlelook=tab} {id=c-short}'],
  [null, 'How an agent plans, acts and checks its own work and then reports back to the whole team in considerable detail every single time', '{titletop} {titlelook=tab} {id=c-long}'],
  [null, 'A default title', '{titletop} {titlelook=default} {id=c-default}']
], LIST)
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
    const sr = slide.getBoundingClientRect(), hr = h1.getBoundingClientRect()
    const range = document.createRange(); range.selectNodeContents(h1)
    let textLeft = Infinity, textRight = -Infinity
    for (const q of range.getClientRects()) if (q.width) { textLeft = Math.min(textLeft, q.left); textRight = Math.max(textRight, q.right) }
    const li = content.querySelector('li'), zoom = parseFloat(content.style.zoom || '1')
    return {
      fontSize: parseFloat(hh.fontSize), transform: hh.textTransform, family: hh.fontFamily, weight: hh.fontWeight,
      color: hh.color, borderLeft: parseFloat(hh.borderLeftWidth), headHeight: head.getBoundingClientRect().height,
      headBorder: parseFloat(hs.borderBottomWidth), padTop: parseFloat(cs.paddingTop), slidePadTop: parseFloat(getComputedStyle(slide).paddingTop),
      flushLeft: (hr.left - sr.left) / k, top: (hr.top - sr.top) / k, height: hr.height / k, right: (hr.right - sr.left) / k,
      spaceLeft: (textLeft - hr.left) / k, spaceRight: (hr.right - textRight) / k, fillet: hr.height / k * 0.22,
      clipped: h1.scrollWidth > h1.clientWidth, ellipsis: hh.textOverflow, afterBg: getComputedStyle(h1, '::after').backgroundColor,
      sizeCqw: parseFloat(hh.fontSize) / stage.offsetWidth * 100, slideWidth: sr.width / k,
      bodyPx: li ? parseFloat(getComputedStyle(li).fontSize) * zoom * k : 0
    }
  }, id)
  const near = (a, b, label, tol = 0.6) => assert(Math.abs(a - b) <= tol, `${label}: expected ${b}, got ${a}`)

  const kicker = await probe('c-kicker')
  assert.equal(kicker.transform, 'none', 'Kicker is never uppercase')
  assert.equal(kicker.weight, '600', 'Kicker is weight 600')
  assert(/mono|menlo|consolas|courier/i.test(kicker.family), `Kicker is set in the mono face (${kicker.family})`)
  near(kicker.sizeCqw, 1.9, 'Kicker size is 1.9cqw', 0.05)
  near(kicker.flushLeft, 0, 'Kicker box starts at the slide edge', 1)
  near(kicker.top * 1.5, 24, 'Kicker is 24px below the top edge at 1920', 1)
  near(kicker.spaceLeft * 1.5, 230, 'Kicker title starts 230px in at 1920', 1)
  assert.equal(kicker.headBorder, 0, 'the hairline under a corner title is gone')
  assert.equal(kicker.headHeight, 0, 'the head is a zero-height box, the fit pass does not count it')
  near(kicker.slidePadTop * 1.5, 156, 'Kicker slide top padding is 156px at 1920', 1.5)

  const edge = await probe('c-edge')
  assert.equal(edge.top, kicker.top, 'titlelook-at is ignored: the Kicker always sits at the edge')

  const label = await probe('c-label')
  near(label.flushLeft, 0, 'Label is flush with the slide edge', 1)
  near(label.borderLeft, 0.35 * label.fontSize, 'Label left line is .35em')
  near(label.top * 1.5, 12, 'Label is 12px below the top edge at 1920', 1)
  near(label.height * 1.5, 66, 'Label is 66px high at 1920', 1)
  near(label.sizeCqw, 1.9, 'Label size is 1.9cqw', 0.05)
  assert.equal(label.headHeight, 0)

  const tab = await probe('c-tab')
  near(tab.flushLeft, 0, 'Tab is flush with the slide edge', 1)
  near(tab.top, 0, 'Tab hangs from the top edge', 0.5)
  near(tab.height * 1.5, 73, 'Tab is 73px high at 1920', 1)
  assert.equal(tab.color, 'rgb(255, 255, 255)', 'strong Tab title is white')
  assert.notEqual(tab.afterBg, 'rgba(0, 0, 0, 0)', 'the Tab fill sits on the masked layer')
  near(tab.sizeCqw, 1.9, 'Tab size is 1.9cqw', 0.05)
  near(tab.spaceLeft * 1.5, 108, 'space left of the Tab title is 108px at 1920', 1)
  near(tab.spaceRight - tab.fillet, tab.spaceLeft, 'space right of the title, to the upright side, equals the space left', 1)
  assert.equal(tab.headHeight, 0)

  const soft = await probe('c-soft')
  assert.equal(soft.color, 'rgb(16, 20, 24)', 'a soft Tab has ink text')
  assert.notEqual(soft.afterBg, tab.afterBg, 'soft and strong fill differ')
  near(soft.spaceRight - soft.fillet, soft.spaceLeft, 'soft Tab: equal space either side', 1)

  const short = await probe('c-short')
  near(short.spaceRight - short.fillet, short.spaceLeft, 'a short title keeps equal space either side', 1)
  const long = await probe('c-long')
  assert(long.clipped && long.ellipsis === 'ellipsis', 'a title too long for the slide is cut with an ellipsis')
  near(long.right, long.slideWidth - 5.6 * 1280 / 100, 'the cut title ends one body margin from the right edge', 1.5)

  // The title look never changes the body type: the same list under the look is not smaller than under the default title.
  const plain = await probe('c-default')
  assert(plain.fontSize > 40, `the default title keeps the compact 3.9cqw size (${plain.fontSize})`)
  assert.equal(plain.headBorder, 2, 'the default title keeps its hairline')
  assert(plain.bodyPx > 0 && tab.bodyPx >= plain.bodyPx - 0.5, `Tab does not shrink the body type (${tab.bodyPx} vs ${plain.bodyPx})`)
  assert(kicker.bodyPx >= plain.bodyPx - 0.5 && label.bodyPx >= plain.bodyPx - 0.5, 'Kicker and Label do not shrink the body type')
} finally {
  await browser.close()
}

console.log('title look: PASS (resolver, tone, stamping, precedence, opening untouched, computed styles)')

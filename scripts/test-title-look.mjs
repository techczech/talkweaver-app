// =============================================================================
// Title looks (0.37 ticket 04): Kicker, Label and Tab on the top title regime. 0.41 ticket 02: the index
// tab is the default, `full` is the plain title, intro-then-none hides the title after a section card.
// 0.41 ticket 03: tab-strip, a row of pills naming the section's slides, the current one filled (5).
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
import { commitOptionSelection, groupHasSelection, selectionForGroup } from '../src/shared/trigger-line.ts'
import { talkNamesTitleLook, withoutLaterSlideStamps } from './lib/slide-markup-identity.mjs'

const dir = mkdtempSync(join(tmpdir(), 'tw-title-look-'))
let n = 0
async function compile(frontmatter, slides, body = '- One\n- Two') {
  const source = [
    '---', 'title: Title look probe', 'auto_title_slide: false', 'auto_thanks_slide: false', ...frontmatter, '---', '',
    ...slides.flatMap(([section, heading, trigger, ownBody]) => [...(section ? [`## ${section}`, ''] : []), `### ${heading}`, trigger, '', ownBody ?? body, ''])
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
  assert.deepEqual(lookGroup.values.map((v) => v.token), ['', 'titlelook=kicker', 'titlelook=label', 'titlelook=tab', 'titlelook=tab-strip', 'titlelook=intro-then-none'])
  assert.deepEqual(lookGroup.values.map((v) => v.label), ['Full', 'Kicker', 'Label', 'Index tab', 'Tab strip', 'Intro then none'])
  assert.equal(lookGroup.section, 'title')
  assert.deepEqual(VALUE_TRIGGER_DICTIONARY.titlelook, ['default', 'full', 'plain', 'none', 'off', 'kicker', 'label', 'tab', 'tab-strip', 'intro-then-none'], 'trigger dictionary carries titlelook')
  assert.deepEqual(VALUE_TRIGGER_DICTIONARY['titlelook-tone'], ['strong', 'soft'], 'trigger dictionary carries titlelook-tone')
  assert(VALUE_TRIGGER_DICTIONARY['titlelook-at'].includes('edge'), 'titlelook-at stays accepted vocabulary (ignored)')
  const toneGroup = GLOBAL_OPTION_GROUPS.find((g) => g.key === 'title-look-tone')
  assert.deepEqual(toneGroup.values.map((v) => v.token), ['', 'titlelook-tone=soft'], 'tone: strong stores nothing, soft is the one token')
  assert(!GLOBAL_OPTION_GROUPS.some((g) => g.key === 'title-look-at'), 'no Kicker placement control any more')
  const deckLook = METADATA_REGISTRY.find((entry) => entry.key === 'title_look')
  const stripOption = deckLook.vocabulary.options.find((o) => o.value === 'tab-strip')
  assert(stripOption && stripOption.label === 'Tab strip' && /pills/.test(stripOption.explanation), 'deck settings list the tab strip with its explanation')
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
// 0.41 (ADR-0039): nothing named → the index tab; every plain spelling → the plain title.
assert.deepEqual(resolveTitleLook({}, {}, {}, {}), { look: 'tab', tone: '' }, 'the index tab is the default')
assert.deepEqual(resolveTitleLook({}, {}, {}, { title_look_tone: 'soft' }), { look: 'tab', tone: 'soft' }, 'the default Tab takes the talk tone')
for (const plain of ['default', 'full', 'plain', 'none', 'off', 'FULL']) {
  assert.deepEqual(resolveTitleLook({}, {}, {}, { title_look: plain }), { look: '', tone: '' }, `title_look: ${plain} is the plain title`)
}
assert.deepEqual(resolveTitleLook({}, {}, {}, { title_look: 'intro-then-none' }), { look: 'intro-then-none', tone: '' })
assert.deepEqual(resolveTitleLook({}, { titlelook: 'intro-then-none' }, {}, { title_look: 'kicker' }), { look: 'intro-then-none', tone: '' }, 'a section can take intro-then-none')
assert.deepEqual(resolveTitleLook({ titlelook: 'label' }, { titlelook: 'intro-then-none' }), { look: 'label', tone: '' }, 'a slide overrides intro-then-none')
assert.deepEqual(resolveTitleLook({ titlelook: 'full' }, {}, {}, { title_look: 'intro-then-none' }), { look: '', tone: '' }, 'a slide pins the plain title against intro-then-none')
assert.deepEqual(resolveTitleLook({ titlelook: 'sparkle' }), { look: 'tab', tone: '' }, 'an unknown value falls through to the index tab')
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
assert.equal(look(bad.slide('b-1')), 'tab', 'unknown value falls back to the index tab')
const opening = await compile(['title_style: banner', 'title_look: kicker'], [['Plain', 'Probe', '{titletop} {id=o-1}']])
assert(!opening.warnings.some((w) => /title-style-unknown/.test(String(w))), 'title_style: banner is still read as the opening variant')
assert.equal(look(opening.slide('o-1')), 'kicker')

// 3b. 0.41 (ADR-0039): the index tab is the default; intro-then-none hides the title after a section card.
const painted = (slide) => Boolean(slide?.querySelector(':scope > .slide-content > .slide-head:not(.slide-head-quiet) > h1'))
const quiet = (slide) => Boolean(slide?.querySelector(':scope > .slide-content > .slide-head.slide-head-quiet > h1.sr-only'))
{
  const untitled = await compile([], [['Plain', 'No look named', '{titletop} {id=d-1}'], [null, 'Pinned plain', '{titletop} {titlelook=full} {id=d-2}']])
  assert.equal(look(untitled.slide('d-1')), 'tab', 'a talk with no title_look draws the index tab')
  assert.equal(look(untitled.slide('d-2')), '', '{titlelook=full} pins the plain title')
  for (const plain of ['default', 'full', 'none', 'off', 'plain']) {
    const pinned = await compile([`title_look: ${plain}`], [['Plain', 'Probe', '{titletop} {id=p-1}']])
    assert.equal(look(pinned.slide('p-1')), '', `title_look: ${plain} draws the plain title`)
    assert(painted(pinned.slide('p-1')), `title_look: ${plain} still paints the title`)
    assert.equal(pinned.warnings.some((w) => /title-look/.test(String(w))), false, `title_look: ${plain} raises no warning`)
  }
}
const intro = await compile(['title_look: intro-then-none', 'sections:', '  Tabbed: { titlelook: tab }'], [
  ['Agents', 'What an agent does', '{titletop} {id=i-1}'],
  [null, 'Second slide', '{titletop} {id=i-2}'],
  [null, 'Rail slide', '{sidebar} {id=i-rail}'],
  [null, 'Slide pins a tab', '{titletop} {titlelook=tab} {id=i-tab}'],
  [null, 'Slide pins the plain title', '{titletop} {titlelook=full} {id=i-full}'],
  ['Tabbed', 'Section look wins', '{titletop} {id=i-section}']
])
{
  const card = intro.doc.querySelector('section.slide[data-role="section-title"][data-section="agents"]') ?? intro.doc.querySelector('section.slide[data-role="section-title"]')
  assert(card, 'the section card is compiled')
  assert(/Agents/.test(card.querySelector('h1, h2')?.textContent ?? ''), 'the section card shows its title')
  for (const id of ['i-1', 'i-2']) {
    const slide = intro.slide(id)
    assert.equal(slide.getAttribute('data-title-layout'), 'top', `${id}: stays in the top regime`)
    assert.equal(slide.hasAttribute('data-title-look'), false, `${id}: no look is stamped`)
    assert(quiet(slide) && !painted(slide), `${id}: the title is nav-only after the section card`)
  }
  assert.equal(intro.slide('i-rail').getAttribute('data-title-layout'), 'left')
  assert(painted(intro.slide('i-rail')), 'a left-rail title is not a title look: it stays')
  assert.equal(intro.slide('i-1').querySelector('h1.sr-only').textContent, 'What an agent does', 'the nav title is kept')
  assert.equal(look(intro.slide('i-tab')), 'tab', 'a slide {titlelook=tab} still wins')
  assert(painted(intro.slide('i-tab')), 'the slide override paints its title')
  assert(painted(intro.slide('i-full')) && look(intro.slide('i-full')) === '', 'a slide {titlelook=full} paints the plain title')
  assert.equal(look(intro.slide('i-section')), 'tab', 'a section look wins over the talk intro-then-none')
  assert.equal(intro.warnings.some((w) => /title-look/.test(String(w))), false, 'intro-then-none raises no warning')
  // A section can take intro-then-none in a talk that draws tabs; a slide before any card keeps its title.
  const sectional = await compile(['sections:', '  Quiet: { titlelook: intro-then-none }'], [
    ['Loud', 'Tabbed slide', '{titletop} {id=q-tab}'],
    ['Quiet', 'Hidden title', '{titletop} {id=q-hidden}']
  ])
  assert.equal(look(sectional.slide('q-tab')), 'tab')
  assert(quiet(sectional.slide('q-hidden')), 'a section set to intro-then-none hides its slides\' titles')
  const { followsSectionCard } = await import('../compiler/scripts/lib/title-look.mjs')
  const order = [{ section: 'a', role: 'content' }, { section: 'a', role: 'section-title', title: 'A' }, { section: 'a', role: 'content' }, { section: 'b', role: 'content' }]
  assert.deepEqual(order.map((_, i) => followsSectionCard(order, i)), [false, false, true, false], 'only slides after their own section\'s card')
}

// 3c. Review round on ticket 02: carousels, hidden cards, subsection ownership, plain aliases, the
//     identity normaliser.
async function compileRaw(frontmatter, outline) {
  const source = ['---', 'title: Title look probe', 'auto_title_slide: false', 'auto_thanks_slide: false', ...frontmatter, '---', '', outline].join('\n')
  const path = join(dir, `${++n}.md`)
  writeFileSync(path, source, 'utf8')
  const model = await prepareSource(path, source, 'Title look probe', statSync(path))
  const doc = new JSDOM(await buildDeckHtmlFromModel(model)).window.document
  return { model, doc, slide: (id) => doc.querySelector(`section.slide[data-id="${id}"]`) }
}
{
  // A carousel's top title follows the resolved look and intro-then-none like any top-title slide.
  const CAROUSEL = '## Pre\n\n### Opening\n\n- a\n\n## Cards\n\n### Stepped {carousel} {titletop} {id=c-car}\n\n#### One\n\n- a\n\n#### Two\n\n- b\n'
  const tabbed = await compileRaw([], CAROUSEL)
  assert.equal(tabbed.slide('c-car').getAttribute('data-title-layout'), 'top')
  assert.equal(look(tabbed.slide('c-car')), 'tab', 'a carousel top title takes the default index tab')
  const kicker = await compileRaw(['title_look: kicker'], CAROUSEL)
  assert.equal(look(kicker.slide('c-car')), 'kicker', 'a carousel top title takes the talk look')
  const introCar = await compileRaw(['title_look: intro-then-none'], CAROUSEL)
  assert.equal(introCar.slide('c-car').hasAttribute('data-title-look'), false, 'carousel after its card: no look stamped')
  assert(quiet(introCar.slide('c-car')) && !painted(introCar.slide('c-car')), 'carousel after its card: the title is nav-only')

  // Only a card that paints its title introduces the topic.
  const hiddenCard = await compileRaw(['title_look: intro-then-none', 'sections:', '  Topic: { title: off }'],
    '## Pre\n\n### Opening\n\n- a\n\n## Topic\n\n### Child {titletop} {title=show} {id=h-child}\n\n- a\n')
  const topicCard = hiddenCard.doc.querySelector('section.slide[data-role="section-title"][data-section="topic"]')
  assert.equal(topicCard?.getAttribute('data-title-layout'), 'hidden', 'the section card hides its title')
  assert(painted(hiddenCard.slide('h-child')), 'a hidden section heading introduces nothing: the next slide keeps its title')
  const hiddenByTrigger = await compileRaw(['title_look: intro-then-none', 'triggers: "{notitle}"'],
    '## Pre\n\n### Opening {title=show}\n\n- a\n\n## Topic\n\n### Child {titletop} {title=show} {id=t-child}\n\n- a\n')
  assert(painted(hiddenByTrigger.slide('t-child')), 'a card hidden by a talk-wide {notitle} introduces nothing')
  const { cardShowsTitle, followsSectionCard } = await import('../compiler/scripts/lib/title-look.mjs')
  assert.equal(cardShowsTitle({ title: 'T', noTitle: true }), false)
  assert.equal(cardShowsTitle({ title: 'T', noTitle: true, titleMode: 'show' }), true)
  assert.equal(cardShowsTitle({ title: 'T', frame: { title: 'off' } }), false)
  assert.equal(cardShowsTitle({ title: 'T', noTitle: true, frame: { title: 'side' } }), true)
  assert.equal(cardShowsTitle({ title: '' }), false)
  const hiddenOrder = [{ section: 'a', role: 'section-title', title: 'A', noTitle: true }, { section: 'a', role: 'content' }]
  assert.equal(followsSectionCard(hiddenOrder, 1), false, 'a hidden section card introduces nothing')

  // A subsection card introduces only the slides inside its subsection.
  const subs = await compileRaw(['title_look: intro-then-none'], [
    '## Pre\n\n### Opening\n\n- a\n',
    '## Topic {role=content}\n\n- lead\n',
    '### Sub\n\n#### Leaf {titletop} {id=s-leaf}\n\n- x\n',
    '### Sibling {titletop} {id=s-sibling}\n\n- y\n'
  ].join('\n'))
  assert.equal(subs.doc.querySelector('section.slide[data-role="subsection-title"]')?.getAttribute('data-subsection'), 'sub', 'the subsection card is compiled')
  assert(quiet(subs.slide('s-leaf')), 'a slide inside the subsection follows its card')
  assert(painted(subs.slide('s-sibling')), 'a sibling heading after the subsection keeps its title')
  const subOrder = [
    { section: 'a', subsection: 'x', role: 'subsection-title', title: 'X' },
    { section: 'a', subsection: 'x', role: 'content' },
    { section: 'a', subsection: '', role: 'content' }
  ]
  assert.deepEqual(subOrder.map((_, i) => followsSectionCard(subOrder, i)), [false, true, false], 'subsection ownership')

  // Every plain spelling the compiler accepts reads as Full in the editor and is replaced by a new look.
  const lookGroup = GLOBAL_OPTION_GROUPS.find((g) => g.key === 'title-look')
  for (const alias of ['default', 'full', 'plain', 'none', 'off']) {
    const line = `{list} {titlelook=${alias}}`
    assert.equal(groupHasSelection(line, lookGroup), true, `{titlelook=${alias}} is an authored Title look`)
    assert.equal(selectionForGroup(line, lookGroup), '', `{titlelook=${alias}} lights Full`)
    const tabbedLine = commitOptionSelection(line, lookGroup, 'titlelook=tab')
    assert(!tabbedLine.includes(`titlelook=${alias}`) && tabbedLine.includes('{titlelook=tab}'), `choosing Index tab replaces {titlelook=${alias}} (${tabbedLine})`)
    assert.equal(resolveTitleLook({ titlelook: alias }).look, '', `the compiler reads ${alias} as the plain title`)
  }
  assert.deepEqual(VALUE_TRIGGER_DICTIONARY.titlelook.filter((v) => ['default', 'full', 'plain', 'none', 'off'].includes(v)), ['default', 'full', 'plain', 'none', 'off'], 'the aliases are legal trigger vocabulary')
  // The deck value `full` is a listed choice, not a custom value.
  const deckLook = METADATA_REGISTRY.find((entry) => entry.key === 'title_look')
  const fullOption = deckLook.vocabulary.options.find((option) => option.value === 'full')
  assert.equal(fullOption?.label, 'Full', 'title_look: full is listed as Full')

  // The identity normaliser drops the tab stamp only for a talk that names no title look.
  const stamped = '<section class="slide" data-title-layout="top" data-title-look="tab">'
  assert.equal(withoutLaterSlideStamps(stamped, { talkNamesTitleLook: false }), '<section class="slide" data-title-layout="top">')
  assert.equal(withoutLaterSlideStamps(stamped, { talkNamesTitleLook: true }), stamped, 'an authored tab is still compared')
  assert.throws(() => withoutLaterSlideStamps(stamped), /talkNamesTitleLook/, 'callers must say which talk it is')
  assert.equal(talkNamesTitleLook('---\ntitle_look: tab\n---'), true)
  assert.equal(talkNamesTitleLook('### A {titlelook=tab}'), true)
  assert.equal(talkNamesTitleLook('sections:\n  A: { titlelook: tab }'), true)
  assert.equal(talkNamesTitleLook('### A {titlelook-tone=soft}\n- title look'), false)
}

// 3d. 0.41 ticket 03: tab-strip. A row of pills naming the section's slides, the current one filled.
const pills = (slide) => [...(slide?.querySelectorAll(':scope > .slide-content > .slide-head > .title-strip > .title-strip-pill') ?? [])]
const STRIP_FOUR = [
  ['Agents', 'Chatbot or agent?', '{titletop} {id=t-1}'],
  [null, 'ChatGPT v Codex key differences', '{titletop} {id=t-2}'],
  [null, 'Uses of AI in research', '{titletop} {id=t-3}'],
  [null, 'What to try next', '{titletop} {id=t-4}'],
  ['Elsewhere', 'Another section', '{titletop} {id=t-other}']
]
const STRIP_MANY = [['Long', 'Opening slide of a long section', '{titletop} {id=m-1}'],
  ...Array.from({ length: 11 }, (_, i) => [null, `A considerably longer slide title number ${i + 2} in the section`, `{titletop} {id=m-${i + 2}}`])]
{
  assert.deepEqual(resolveTitleLook({}, {}, {}, { title_look: 'tab-strip' }), { look: 'tab-strip', tone: '' }, 'the talk can take the tab strip')
  assert.deepEqual(resolveTitleLook({}, { titlelook: 'tab-strip' }, {}, { title_look: 'kicker' }), { look: 'tab-strip', tone: '' }, 'a section can take the tab strip')
  assert.deepEqual(resolveTitleLook({ titlelook: 'tab-strip', 'titlelook-tone': 'soft' }), { look: 'tab-strip', tone: '' }, 'a slide can take it; it has no tone')
  const { sectionStrip, TAB_STRIP_MAX_PILLS } = await import('../compiler/scripts/lib/title-look.mjs')
  const order = [
    { section: 'a', role: 'section-title', title: 'A' }, { section: 'a', role: 'content', title: 'One' },
    { section: 'a', role: 'content', title: 'Two' }, { section: 'a', role: 'content', title: 'Two' },
    { section: 'a', role: 'subsection-title', title: 'Sub' }, { section: 'a', role: 'content', title: 'Three' },
    { section: 'b', role: 'content', title: 'Other' }, { section: '', role: 'content', title: 'Links' }
  ]
  assert.deepEqual(sectionStrip(order, 1), { titles: ['One', 'Two', 'Two', 'Three'], current: 0, cutBefore: false, cutAfter: false }, 'cards are left out; two same-title slides keep two pills (no title-equality merge)')
  assert.equal(sectionStrip(order, 2).current, 1, 'the first same-titled slide lights its own pill')
  assert.equal(sectionStrip(order, 3).current, 2, 'the second same-titled slide lights its own pill, not the first')
  assert.deepEqual(sectionStrip(order, 6).titles, ['Other'], 'only the slide\'s own section')
  assert.deepEqual(sectionStrip(order, 7), { titles: ['Links'], current: 0, cutBefore: false, cutAfter: false }, 'no section: its own pill alone')
  const long = Array.from({ length: 12 }, (_, i) => ({ section: 'l', role: 'content', title: `S${i}` }))
  assert.equal(TAB_STRIP_MAX_PILLS, 5)
  assert.deepEqual(sectionStrip(long, 0), { titles: ['S0', 'S1', 'S2', 'S3', 'S4'], current: 0, cutBefore: false, cutAfter: true }, 'start of a long section')
  assert.deepEqual(sectionStrip(long, 6), { titles: ['S4', 'S5', 'S6', 'S7', 'S8'], current: 2, cutBefore: true, cutAfter: true }, 'middle: the pills around the current one')
  assert.deepEqual(sectionStrip(long, 11), { titles: ['S7', 'S8', 'S9', 'S10', 'S11'], current: 4, cutBefore: true, cutAfter: false }, 'end of a long section')

  const four = await compile(['title_look: tab-strip'], STRIP_FOUR)
  STRIP_FOUR.slice(0, 4).forEach(([, heading], i) => {
    const slide = four.slide(`t-${i + 1}`)
    assert.equal(look(slide), 'tab-strip', `t-${i + 1}: the look is stamped`)
    const row = pills(slide)
    assert.deepEqual(row.map((p) => p.textContent), STRIP_FOUR.slice(0, 4).map(([, h]) => h), `t-${i + 1}: four pills name the section's slides in order, no card`)
    assert.deepEqual(row.map((p) => p.classList.contains('is-current')), [0, 1, 2, 3].map((j) => j === i), `t-${i + 1}: the current pill is filled`)
    assert.equal(slide.querySelector(':scope > .slide-content > .slide-head > h1').textContent.replace(/\u00a0/g, ' '), heading, 'the h1 stays the slide title')
    assert.equal(slide.querySelector('.title-strip').getAttribute('aria-hidden'), 'true', 'the strip is decoration for screen readers')
  })
  assert.deepEqual(pills(four.slide('t-other')).map((p) => p.textContent), ['Another section'], 'the next section has its own strip')
  assert.equal(four.warnings.some((w) => /title-look/.test(String(w))), false, 'tab-strip raises no warning')
  const many = await compile(['sections:', '  Long: { titlelook: tab-strip }'], STRIP_MANY)
  assert.equal(pills(many.slide('m-7')).length, 5, 'a long section is cut to five pills')
  assert(pills(many.slide('m-7'))[2].classList.contains('is-current'), 'the current pill sits in the middle of the cut')
  const mixed = await compile([], [['Agents', 'Strip slide', '{titletop} {titlelook=tab-strip} {id=x-1}'], [null, 'Tab slide', '{titletop} {id=x-2}'], [null, 'Rail slide', '{sidebar} {titlelook=tab-strip} {id=x-3}']])
  assert.deepEqual(pills(mixed.slide('x-1')).map((p) => p.textContent), ['Strip slide', 'Tab slide', 'Rail slide'], 'a slide-level tab strip names every slide of its section')
  assert.equal(pills(mixed.slide('x-2')).length, 0, 'a slide with another look draws no strip')
  assert.equal(pills(mixed.slide('x-3')).length, 0, 'a left-rail title draws no strip')
  // Two independently authored slides with the same title are two pills; the highlight moves between them.
  const twins = await compile(['title_look: tab-strip'], [['Data', 'Results', '{titletop} {id=r-1}'], [null, 'Results', '{titletop} {id=r-2}']])
  assert.deepEqual(pills(twins.slide('r-1')).map((p) => p.textContent), ['Results', 'Results'], 'two same-title slides, two pills')
  assert.deepEqual(pills(twins.slide('r-1')).map((p) => p.classList.contains('is-current')), [true, false], 'the first slide fills the first pill')
  assert.deepEqual(pills(twins.slide('r-2')).map((p) => p.classList.contains('is-current')), [false, true], 'the highlight moves to the second pill')
  // A carousel (a heading with #### sub-slides) is one pill and draws the same strip as its section's other slides.
  const stripCar = await compile(['title_look: tab-strip'], [['Cards', 'Plain one', '{titletop} {id=sc-1}'], [null, 'Stepped', '{carousel} {titletop} {id=sc-car}', '#### Child\n\n- b']])
  assert.equal(look(stripCar.slide('sc-car')), 'tab-strip', 'carousel: the tab-strip look is stamped')
  assert.deepEqual(pills(stripCar.slide('sc-car')).map((p) => p.textContent), ['Plain one', 'Stepped'], 'carousel: the strip names the section slides; the #### child gets no pill')
  assert.deepEqual(pills(stripCar.slide('sc-car')).map((p) => p.classList.contains('is-current')), [false, true], 'carousel: its own pill is current')
  assert.deepEqual(pills(stripCar.slide('sc-1')).map((p) => p.textContent), ['Plain one', 'Stepped'], 'carousel: the other slide lists the carousel as one pill')
  assert.equal(stripCar.slide('sc-car').querySelectorAll('.carousel-subslide .title-strip').length, 0, 'carousel: sub-slides draw no strip')
  // A linked title: the pill keeps the label as plain text, with no anchor inside the aria-hidden strip.
  const linked = await compile(['title_look: tab-strip'], [['Docs', '[Documentation](https://example.org)', '{titletop} {id=l-1}'], [null, 'Plain', '{titletop} {id=l-2}']])
  assert.deepEqual(pills(linked.slide('l-1')).map((p) => p.textContent), ['Documentation', 'Plain'], 'a linked title shows its label in the pill')
  assert.equal(linked.slide('l-1').querySelector('.title-strip').querySelector('a, [href], [tabindex], button'), null, 'the strip holds no focusable element or anchor')
}

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

  // intro-then-none: no title painted, the content block centres on the slide (ticket 01 band).
  const introPath = join(dir, 'intro.html')
  writeFileSync(introPath, (await compile(['title_look: intro-then-none'], [['Agents', 'Chatbot or agent', '{titletop} {id=n-1}']], LIST)).html, 'utf8')
  await page.goto(`file://${introPath}`, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts?.ready)
  const centred = await page.evaluate(() => {
    const slides = [...document.querySelectorAll('.stage > .slide')]
    const slide = slides.find((node) => node.dataset.id === 'n-1')
    slides.forEach((node) => node.classList.toggle('active', node === slide))
    window.__autofitForTest?.()
    const list = slide.querySelector(':scope > .slide-content ul, :scope > .slide-content ol')
    const sr = slide.getBoundingClientRect(), lr = list.getBoundingClientRect()
    const head = slide.querySelector(':scope > .slide-content > .slide-head')
    return { slideMid: sr.top + sr.height / 2, listMid: lr.top + lr.height / 2, height: sr.height, headHeight: head?.getBoundingClientRect().height ?? 0 }
  })
  assert(centred.headHeight <= 1, `intro-then-none: the nav-only head takes no space (${centred.headHeight})`)
  assert(Math.abs(centred.listMid - centred.slideMid) <= centred.height * 0.06, `intro-then-none: the content centres on the slide (${centred.listMid} vs ${centred.slideMid})`)

  // tab-strip (0.41 ticket 03): the drawing's values at 1920x1080 (stage 1280: 1cqw = 12.8px, so a
  // drawing px at 1920 is the stage px x 1.5); one line however long the section.
  const stripProbe = async (file, id) => {
    await page.goto(`file://${file}`, { waitUntil: 'load' })
    await page.evaluate(() => document.fonts?.ready)
    return page.evaluate((slideId) => {
      const slides = [...document.querySelectorAll('.stage > .slide')]
      const slide = slides.find((node) => node.dataset.id === slideId)
      slides.forEach((node) => node.classList.toggle('active', node === slide))
      window.__autofitForTest?.()
      const stage = slide.parentElement, k = stage.getBoundingClientRect().width / stage.offsetWidth
      const sr = slide.getBoundingClientRect(), strip = slide.querySelector('.title-strip'), str = strip.getBoundingClientRect()
      const h1 = slide.querySelector(':scope > .slide-content > .slide-head > h1')
      const row = [...strip.querySelectorAll('.title-strip-pill')].map((p) => {
        const r = p.getBoundingClientRect(), cs = getComputedStyle(p)
        return { top: (r.top - sr.top) / k, left: r.left, right: r.right, height: r.height / k, current: p.classList.contains('is-current'),
          bg: cs.backgroundColor, color: cs.color, border: cs.borderTopColor, size: parseFloat(cs.fontSize), transform: cs.textTransform, family: cs.fontFamily,
          cut: p.scrollWidth > p.clientWidth + 1 }
      })
      return { row, stripTop: (str.top - sr.top) / k, stripLeft: (str.left - sr.left) / k, stripLeftPx: str.left, stripRight: str.right, stripHeight: str.height / k,
        h1Width: h1.getBoundingClientRect().width / k, stageWidth: stage.offsetWidth, accent: getComputedStyle(slide).getPropertyValue('--accent').trim() }
    }, id)
  }
  const fourPath = join(dir, 'strip-four.html')
  writeFileSync(fourPath, (await compile(['title_look: tab-strip'], STRIP_FOUR, LIST)).html, 'utf8')
  for (const i of [0, 3]) {
    const s4 = await stripProbe(fourPath, `t-${i + 1}`)
    assert.equal(s4.row.length, 4, 'four pills')
    assert(s4.row.every((p) => Math.abs(p.top - s4.row[0].top) < 0.5), 'the four pills sit on one line')
    assert.deepEqual(s4.row.map((p) => p.current), [0, 1, 2, 3].map((j) => j === i))
    const on = s4.row[i], off = s4.row[(i + 1) % 4]
    assert.equal(on.color, 'rgb(255, 255, 255)', 'the current pill has white text')
    assert.notEqual(on.bg, 'rgba(0, 0, 0, 0)', 'the current pill is filled')
    assert.equal(on.bg, on.border, 'the current pill\'s outline is its fill')
    assert.equal(off.bg, 'rgba(0, 0, 0, 0)', 'the other pills are outlined, not filled')
    assert.equal(off.color, 'rgb(92, 101, 112)', 'the other pills are in the muted ink')
    assert.equal(on.transform, 'uppercase')
    assert(/mono|menlo|consolas|courier/i.test(on.family), `pills are set in the mono face (${on.family})`)
    near(on.size / s4.stageWidth * 100, 1.25, 'pill size is 1.25cqw (24px at 1920)', 0.05)
    near(on.height * 1.5, 52.8, 'pill height is 53px at 1920', 1.5)
    near(s4.stripTop * 1.5, 44, 'the strip sits 44px below the top edge at 1080', 1.5)
    near(s4.stripLeft, 5.6 * 1280 / 100, 'the strip starts at the body margin', 1)
    assert(s4.h1Width <= 1.5, 'the h1 is kept for navigation but not painted')
  }
  const manyPath = join(dir, 'strip-many.html')
  writeFileSync(manyPath, (await compile(['title_look: tab-strip'], STRIP_MANY, LIST)).html, 'utf8')
  for (const id of ['m-1', 'm-7', 'm-12']) {
    const sm = await stripProbe(manyPath, id)
    assert(sm.row.every((p) => Math.abs(p.top - sm.row[0].top) < 0.5), `${id}: a long section keeps the strip on one line`)
    assert(sm.stripHeight * 1.5 <= 56, `${id}: the strip is one pill high (${sm.stripHeight * 1.5}px at 1920)`)
    const on = sm.row.find((p) => p.current)
    assert(on && on.left >= sm.stripLeftPx - 0.5 && on.right <= sm.stripRight + 0.5, `${id}: the current pill is inside the strip`)
    // its title is cut only when it is longer than the pill's cap (60% of the strip), as the index tab cuts a too-long title
    assert(!on.cut || on.right - on.left >= 0.6 * (sm.stripRight - sm.stripLeftPx) - 1, `${id}: the current pill keeps its title whole up to its cap`)
  }
} finally {
  await browser.close()
}

console.log('title look: PASS (resolver, index tab default, intro-then-none, tab strip, carousels, hidden cards, subsections, plain aliases, identity normaliser, tone, stamping, precedence, opening untouched, computed styles)')

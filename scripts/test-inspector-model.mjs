import { strict as assert } from 'node:assert'
import { LAYOUTS } from '../src/shared/layout-registry/entries.ts'
import { optionGroupsForSlide } from '../src/shared/layout-registry/options.ts'
import * as layoutDoctor from '../src/shared/layout-doctor.ts'
import * as inspectorModule from '../src/renderer/src/components/inspectorModel.ts'
import {
  inspectorModel,
  extractInspectorSlideBlock,
  inspectorCommitToken,
  migrateInspectorMode,
  migratePaneState,
  navigateInspectorSlide,
  resolveInspectedSlide,
  sectionIdAtScrollTop,
  headingLineForSlideId,
  stepModelForSlide
} from '../src/renderer/src/components/inspectorModel.ts'
import { deckListStyleForSlide } from '../src/shared/deck-frame.ts'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildDeckHtmlFromModel } from '../compiler/scripts/lib/07-assembly.mjs'

const previewModule = await import('../src/shared/slide-preview.ts').catch(() => null)
assert.ok(previewModule, 'single-slide preview helpers are available to the main process')
const {
  createSlidePreviewStore, markSlidePreviewHtml,
  slidePreviewIdFromUrl, slidePreviewUrl, thumbnailDocumentCacheKey
} = previewModule

assert.equal(
  extractInspectorSlideBlock('### Carousel\n{carousel}\n\n#### One\nA\n\n#### Two\nB\n\n### Next\nC', 1),
  '### Carousel\n{carousel}',
  'Inspector stops at the next heading of any level'
)

const sectionOutline = '## Section A\n\n### Content slide\n{contrast}\n\nBody\n\n## Section B\n'
assert.equal(
  extractInspectorSlideBlock(sectionOutline, 1),
  '## Section A',
  'Inspector section-divider block contains the divider only'
)

const multiSlideOutline = `---
title: Demo
---

### Contrast slide
{contrast}

- Old / New
- Slow / Fast

### Reveal slide
{reveal}

- One
- Two
- Three
`
assert.equal(
  extractInspectorSlideBlock(multiSlideOutline, 5),
  '### Contrast slide\n{contrast}\n\n- Old / New\n- Slow / Fast',
  'Inspector extracts only the first addressed content-slide block'
)
assert.equal(
  extractInspectorSlideBlock(multiSlideOutline, 11),
  '### Reveal slide\n{reveal}\n\n- One\n- Two\n- Three',
  'Inspector extracts only the second addressed content-slide block'
)
assert.equal(
  extractInspectorSlideBlock(multiSlideOutline, null),
  null,
  'Synthesized slide indices have no authored block'
)

const previewHtml = markSlidePreviewHtml('<!doctype html><html><head></head><body><footer class="share-footer">Deck chrome</footer></body></html>')
assert.match(previewHtml, /<body[^>]*data-tw-preview/, 'preview HTML carries the shared preview styling hook')
assert.match(previewHtml, /\.share-footer[^}]*display:\s*none\s*!important/, 'preview HTML hides deck footer chrome')
assert.match(previewHtml, /footer\.footer[^}]*display:\s*none\s*!important/, 'preview HTML hides the current deck footer')
assert.match(previewHtml, /\.progress[^}]*display:\s*none\s*!important/, 'preview HTML hides deck progress chrome')
assert.match(previewHtml, /\.drawer[^}]*display:\s*none\s*!important/, 'preview HTML hides fixed deck navigation drawers')
assert.match(previewHtml, /\.focus-banner[^}]*display:\s*none\s*!important/, 'preview HTML hides fixed deck overlays')
assert.equal((previewHtml.match(/type==='tw-step'/g) ?? []).length, 1, 'preview HTML carries one main-side step bridge')
assert.doesNotMatch(previewHtml, /__twErrs/, 'preview HTML drops the diagnostic error trap')

assert.equal(typeof createSlidePreviewStore, 'function', 'preview store factory is available to the main process')
const previewStore = createSlidePreviewStore(2)
previewStore.set('first', '<html>first</html>')
previewStore.set('second', '<html>second</html>')
assert.equal(previewStore.get('first'), '<html>first</html>', 'preview store returns a retained preview')
previewStore.set('third', '<html>third</html>')
assert.equal(previewStore.get('first'), undefined, 'preview store evicts the oldest preview at its cap')
assert.equal(previewStore.get('second'), '<html>second</html>', 'preview store keeps newer previews after FIFO eviction')
assert.equal(typeof slidePreviewUrl, 'function', 'preview URL builder is available to the main process')
assert.equal(typeof slidePreviewIdFromUrl, 'function', 'preview route parser is available to the main process')
assert.equal(slidePreviewUrl('abc123'), 'twpresent://preview/abc123.html', 'preview URL uses the dedicated scheme host')
assert.equal(slidePreviewUrl('abc123', 'slide one'), 'twpresent://preview/abc123.html#slide%20one', 'preview URL deep-links to the inspected slide without changing the stored document')
assert.equal(slidePreviewIdFromUrl('twpresent://preview/abc123.html'), 'abc123', 'preview route extracts a stored preview id')
assert.equal(slidePreviewIdFromUrl('twpresent://talk/abc123.html'), null, 'talk replay URLs never enter the preview store')
assert.equal(slidePreviewIdFromUrl('twpresent://preview/nested/abc123.html'), null, 'preview route rejects nested paths')
assert.notEqual(thumbnailDocumentCacheKey('deck-a', 'slide-key'), thumbnailDocumentCacheKey('deck-b', 'slide-key'), 'legacy raw-HTML cache fallback includes the full document; compiled slides use picture fingerprints')

assert.equal(typeof inspectorModule.applyInspectorOptionToOutline, 'function', 'Inspector exposes a pure unmounted-editor fallback')
const fontBodyGroup = optionGroupsForSlide({ layoutName: 'contrast', headingLevel: 3 })
  .find(({ group }) => group.key === 'font-body')?.group
assert.ok(fontBodyGroup, 'font body option group is available for the fallback regression')
const fallbackResult = inspectorModule.applyInspectorOptionToOutline(
  multiSlideOutline,
  5,
  fontBodyGroup,
  'font-body=l'
)
assert.equal(
  fallbackResult,
  multiSlideOutline.replace('{contrast}', '{contrast}{font-body=l}'),
  'unmounted-editor fallback commits on the addressed trigger line and keeps every other byte unchanged'
)

const dividerWithTrigger = '## Section A\n{font-body=s}\n\n### Content slide\n{contrast}\n'
assert.equal(
  inspectorModule.applyInspectorOptionToOutline(dividerWithTrigger, 1, fontBodyGroup, 'font-body=l'),
  '## Section A\n{font-body=l}\n\n### Content slide\n{contrast}\n',
  'commit on a section divider edits the divider trigger line'
)

const triggerlessFollowedByHeading = '### Trigger-less\n### Next slide\n{id=next}{contrast}\n\nNext body\n'
assert.equal(
  inspectorModule.applyInspectorOptionToOutline(triggerlessFollowedByHeading, 1, fontBodyGroup, 'font-body=l'),
  '### Trigger-less\n{font-body=l}\n### Next slide\n{id=next}{contrast}\n\nNext body\n',
  'trigger-less slide inserts its own trigger line and leaves the next slide byte-identical'
)

const duplicateTriggerLines = '### Not all Agents are Agents\n{sidebar} {id=hnwcx}\n{layout=media} {id=3plcu}\n\nBody\n'
assert.equal(
  inspectorModule.applyInspectorOptionToOutline(duplicateTriggerLines, 1, fontBodyGroup, 'font-body=l'),
  '### Not all Agents are Agents\n{sidebar}{layout=media}{font-body=l}{id=3plcu}\n\nBody\n',
  'editor-less Inspector commit merges consecutive Trigger lines and keeps the lower original id'
)

const bareModifierThenId = '### Final question - How much are you willing to invest in AI-assisted research?\n{iconlist}\n{id=uyee5} {split=50}\n\nBody\n'
const titlePlacementGroup = optionGroupsForSlide({ layoutName: 'iconlist', headingLevel: 3 })
  .find(({ group }) => group.key === 'title-placement')?.group
assert.ok(titlePlacementGroup, 'title placement option group is available for the exact split regression')
assert.equal(
  inspectorModule.applyInspectorOptionToOutline(bareModifierThenId, 1, titlePlacementGroup, 'split=50'),
  '### Final question - How much are you willing to invest in AI-assisted research?\n{iconlist}{id=uyee5}{split=50}\n\nBody\n',
  'editor-less Inspector commit consolidates a bare modifier followed by id and split'
)

assert.equal(migratePaneState('inspector'), 'strip', 'persisted Inspector pane migrates to the strip pane')
assert.equal(migrateInspectorMode('inspector', null), true, 'persisted Inspector pane enables Inspector mode')
assert.equal(migrateInspectorMode('both', 'true'), true, 'persisted Inspector mode survives reload')
assert.equal(migrateInspectorMode('both', 'false'), false)
assert.equal(migratePaneState('strip'), 'strip')
assert.equal(migratePaneState('editor'), 'editor')
assert.equal(migratePaneState('nonsense'), 'both')

assert.equal(navigateInspectorSlide(0, -1, 4), 0, 'previous navigation stops at the first slide')
assert.equal(navigateInspectorSlide(3, 1, 4), 3, 'next navigation stops at the final slide')
assert.equal(navigateInspectorSlide(1, 1, 4), 2)

const identityRows = [
  { slide_id: 'section-a' },
  { slide_id: 'image-grid' },
  { slide_id: 'section-b' }
]
assert.deepEqual(
  resolveInspectedSlide([identityRows[2], identityRows[0], identityRows[1]], 'image-grid', 1),
  { id: 'image-grid', index: 2 },
  'Inspector re-derives its index from the stable slide id after a recompile reorders rows'
)
assert.deepEqual(
  resolveInspectedSlide(identityRows.slice(0, 2), 'section-b', 9),
  { id: 'image-grid', index: 1 },
  'Inspector falls back to the clamped previous index only when its slide id vanished'
)
assert.equal(
  headingLineForSlideId('## Section B\n{id=section-b}\n\n### Image grid\n{id=image-grid}{image-grid}\n', 'image-grid'),
  4,
  'Inspector option commits derive the heading line from the inspected id, not the caret-owned active index'
)
assert.equal(headingLineForSlideId('### Image grid\n{id=image-grid}\n', 'missing'), null)

assert.equal(
  inspectorModule.inspectedSlideIdAfterCursorChange(identityRows, 2, 'section-a', false),
  'section-b',
  'Inspector follows a cursor-driven active-slide change'
)
assert.equal(
  inspectorModule.inspectedSlideIdAfterCursorChange(identityRows, 2, 'section-a', true),
  'section-a',
  'Inspector keeps its stable id while an option commit dispatches'
)

const rows = [{
  layout: 'contrast', nav_title: 'Changed', title: 'Changed', source_markdown: '### Changed\n{contrast}{reveal}\n\n- one\n- two\n- three',
  bullet_count: 3, triggers: { layout: 'contrast', mode: 'reveal' }
}]
const model = inspectorModel(rows, 0, 3, '{contrast}{reveal}', LAYOUTS)
assert.equal(model.title, 'Changed')
assert.equal(model.groups[0].group.key, 'variant', 'entry variant group comes first')
assert.equal(model.groups.some(({ group }) => group.key === 'rail-width'), false)
assert.deepEqual(
  model.groups.find(({ group }) => group.key === 'title-placement')?.group.values.map(({ token }) => token),
  ['', 'titletop', 'notitle', 'sidebar', 'split=30', 'split=35', 'split=40', 'split=50'],
  'Inspector consumes the merged title-placement group'
)

const findingOutline = [
  '### First',
  '{statement}',
  '',
  '### Broken',
  '{nonsense}',
  '',
  '### Last',
  '{quote}'
].join('\n')
const findingRows = [
  { ...rows[0], source_line: 1, nav_title: 'First', warnings: [] },
  { ...rows[0], source_line: 4, nav_title: 'Broken', warnings: [] },
  { ...rows[0], source_line: 7, nav_title: 'Last', warnings: [] }
]
const triggerFindings = layoutDoctor.scanOutlineTriggers(findingOutline)
assert.equal(typeof layoutDoctor.triggerWarningPayloadsForSlide, 'function',
  'Layout Doctor exposes the slide-row warning join used by the strip and Grid')
assert.deepEqual(
  findingRows.map((row) => layoutDoctor.triggerWarningPayloadsForSlide(row, triggerFindings)),
  [[], ['unknown-trigger:nonsense'], []],
  'the unresolved trigger reaches its source-line row and neither neighbour'
)
const neighbourBefore = inspectorModel(
  findingRows, 0, 3, '{statement}', LAYOUTS, undefined, false, triggerFindings
)
const unresolvedModel = inspectorModel(
  findingRows, 1, 3, '{nonsense}', LAYOUTS, undefined, false, triggerFindings
)
const neighbourAfter = inspectorModel(
  findingRows, 2, 3, '{quote}', LAYOUTS, undefined, false, triggerFindings
)
assert.equal(neighbourBefore.unresolved, false, 'Inspector keeps the preceding slide resolved')
assert.equal(unresolvedModel.unresolved, true, 'Inspector recognises the finding on the addressed slide')
assert.deepEqual(unresolvedModel.groups, [], 'Inspector with an unresolved trigger exposes no option groups')
assert.equal(neighbourAfter.unresolved, false, 'Inspector keeps the following slide resolved')

const carouselOutline = [
  '### Neighbour before',
  '{statement}',
  '',
  '### Carousel parent',
  '{carousel}',
  '',
  '#### Folded child',
  '{nonsense}',
  '',
  '- Child body',
  '',
  '### Neighbour after',
  '{quote}'
].join('\n')
const carouselRows = [
  {
    ...rows[0],
    source_line: 1,
    nav_title: 'Neighbour before',
    source_markdown: '### Neighbour before\n{statement}',
    warnings: []
  },
  {
    ...rows[0],
    source_line: 4,
    nav_title: 'Carousel parent',
    layout: 'carousel',
    triggers: { layout: 'carousel' },
    source_markdown: '### Carousel parent\n{carousel}',
    warnings: []
  },
  {
    ...rows[0],
    source_line: 12,
    nav_title: 'Neighbour after',
    source_markdown: '### Neighbour after\n{quote}',
    warnings: []
  }
]
assert.equal(typeof layoutDoctor.attributeOrphanedTriggerFindings, 'function',
  'Layout Doctor exposes the projection fallback for folded child findings')
const attributedCarouselFindings = layoutDoctor.attributeOrphanedTriggerFindings(
  carouselOutline,
  carouselRows,
  layoutDoctor.scanOutlineTriggers(carouselOutline)
)
assert.deepEqual(
  carouselRows.map((row) => layoutDoctor.triggerWarningPayloadsForSlide(row, attributedCarouselFindings)),
  [[], ['unknown-trigger:nonsense (folded child “Folded child”, line 7)'], []],
  'a folded carousel-child finding reaches the visible parent row and both neighbours stay clean'
)
const carouselParentModel = inspectorModel(
  carouselRows, 1, 3, '{carousel}', LAYOUTS, carouselRows[1].source_markdown, true, attributedCarouselFindings
)
assert.equal(carouselParentModel.unresolved, true,
  'Inspector marks the visible carousel parent unresolved when its folded child owns the finding')
assert.equal(carouselParentModel.unresolvedFindings[0]?.headingLine, 7,
  'Inspector preserves the folded child heading line on the attributed finding')

const repeatedTitleOutline = [
  '## First section',
  '',
  '### Repeated title',
  '{statement}',
  '',
  '## Second section',
  '',
  '### Repeated title',
  '{nonsense}',
  '',
  '### Repeated title',
  '{quote}'
].join('\n')
const repeatedTitleRows = [
  { ...rows[0], source_line: null, nav_title: 'Repeated title', source_markdown: '', warnings: [] },
  { ...rows[0], source_line: 3, nav_title: 'Repeated title', source_markdown: '### Repeated title\n{statement}', warnings: [] },
  { ...rows[0], source_line: 8, nav_title: 'Repeated title', source_markdown: '### Repeated title\n{nonsense}', warnings: [] },
  { ...rows[0], source_line: 11, nav_title: 'Repeated title', source_markdown: '### Repeated title\n{quote}', warnings: [] }
]
const repeatedTitleFindings = layoutDoctor.attributeOrphanedTriggerFindings(
  repeatedTitleOutline,
  repeatedTitleRows,
  layoutDoctor.scanOutlineTriggers(repeatedTitleOutline)
)
assert.deepEqual(
  repeatedTitleRows.map((row) => layoutDoctor.triggerWarningPayloadsForSlide(row, repeatedTitleFindings)),
  [[], [], ['unknown-trigger:nonsense'], []],
  'normal slides still join only by exact source line across title collisions, sections and synthetic rows'
)

const nestedModel = inspectorModel(rows, 0, 3, '{statement}', LAYOUTS,
  '### Parent\n{statement}\n\n#### Child\n\nBody', true)
assert.ok(nestedModel.groups.some(({ group }) => group.key === 'container-mode'),
  'Inspector shows Container mode for a ### slide with #### children')

const fixedPreviewModule = await import('../src/renderer/src/components/fixedDeckPreviewModel.ts').catch(() => null)
assert.ok(fixedPreviewModule, 'fixed deck preview sizing model is available to both stages')
assert.equal(fixedPreviewModule.FIXED_DECK_WIDTH, 1280)
assert.equal(fixedPreviewModule.FIXED_DECK_HEIGHT, 720)
assert.equal(fixedPreviewModule.fixedDeckScale(640), 0.5,
  'fixed deck preview scales from the stage width against the 1280px logical deck')

assert.deepEqual(stepModelForSlide(rows[0]), { count: 3, mode: 'reveal' })
assert.deepEqual(stepModelForSlide({
  layout: 'carousel', source_markdown: '### Parent\n{carousel}\n\n#### One\nA\n\n#### Two\nB',
  triggers: { layout: 'carousel' }
}), { count: 2, mode: 'carousel' })
assert.deepEqual(stepModelForSlide({ layout: 'statement', source_markdown: '### Plain\n{statement}', triggers: {} }), { count: 0, mode: '' })

// =============================================================================
// T32 — Decision 1A: the lit List style button is always the style the compiled slide renders.
// Dominik's showcase deck sets `defaults: { icons: on }`. Every case drives the real chain: the
// deck's choice read from the outline (deck-frame.ts, the compiler's own frame code), the model's
// lit/deck-marked tokens, the click's write through applyInspectorOptionToOutline, and the
// compiler's render of the written file.
// =============================================================================
const listStyleGroup = LAYOUTS.find((entry) => entry.name === 'list').options.find((group) => group.key === 'list-style')
const showcaseOutline = (defaults, trigger) => [
  '---',
  'title: Showcase',
  'auto_title_slide: false',
  'auto_thanks_slide: false',
  ...defaults,
  '---',
  '',
  '## Fixtures',
  '',
  '### About this showcase',
  trigger,
  '',
  '- Speed {icon=lucide:zap}',
  '- Judgement {icon=lucide:brain}',
  '- Craft {icon=lucide:wrench}',
  ''
].join('\n')
const ICONS_ON = ['defaults:', '  icons: on']
const headingLineOf = (outline) => outline.split('\n').indexOf('### About this showcase') + 1
const triggerLineOf = (outline) => outline.split('\n')[headingLineOf(outline)]

/** The Inspector's state for the showcase slide, exactly as Inspector.tsx assembles it. */
function inspect(outline) {
  const headingLine = headingLineOf(outline)
  const triggerLine = triggerLineOf(outline)
  const rows = [{
    layout: 'list', nav_title: 'About this showcase', title: 'About this showcase',
    triggers: { layout: 'list' }, source_markdown: `### About this showcase\n${triggerLine}`,
    source_line: headingLine, bullet_count: 3, warnings: []
  }]
  const model = inspectorModel(
    rows, 0, 3, triggerLine, LAYOUTS, rows[0].source_markdown, false, [], deckListStyleForSlide(outline, headingLine)
  )
  const binding = model.sections.flatMap((section) => section.bindings).find((candidate) => candidate.group.key === 'list-style')
  return { model, binding, headingLine }
}

/** Click one List style button: the token the Inspector writes, committed to the outline. */
function click(outline, buttonToken) {
  const { binding, headingLine } = inspect(outline)
  return inspectorModule.applyInspectorOptionToOutline(outline, headingLine, listStyleGroup, inspectorCommitToken(binding, buttonToken))
}

let compileProbe = 0
/** The compiled list's rendered style: plain | icons | numbers. */
async function renderedListStyle(outline) {
  const model = await prepareSource(`/tmp/t32-${++compileProbe}.md`, outline, 'Showcase')
  const slide = model.slides.find((candidate) => candidate.navTitle === 'About this showcase' || candidate.title === 'About this showcase')
  const html = await buildDeckHtmlFromModel({ ...model, slides: [slide] })
  const list = html.match(/<(ul|ol) class="feature-list[^"\n]*">[\s\S]*?<\/\1>/)?.[0] ?? ''
  assert.ok(list, 'the showcase slide compiles to a feature list')
  if (/^<(?:ul|ol) class="[^"]*fl-plain/.test(list)) return 'plain'
  if (/^<(?:ul|ol) class="[^"]*fl-iconlist-list/.test(list)) return 'icon rows'
  if (/class="fl-icon fl-num"/.test(list)) return 'numbers'
  assert.match(list, /class="fl-icon[^"]*"[^>]*>\s*<svg/, 'an icon list renders an icon glyph per item')
  return 'icons'
}

// 1. No token under icons: on → Icons is lit AND deck-marked; the compiled slide shows icons.
const iconsDeck = showcaseOutline(ICONS_ON, '{list}')
const noToken = inspect(iconsDeck)
assert.equal(noToken.model.deckListStyle, 'iconlist', 'under icons: on the deck’s List style choice is Icons')
assert.equal(noToken.binding.selectedToken, 'iconlist', 'no token under icons: on → Icons is lit')
assert.equal(noToken.binding.deckToken, 'iconlist', 'no token under icons: on → Icons carries the deck mark')
assert.equal(await renderedListStyle(iconsDeck), 'icons', 'the lit button matches the render: the deck forces icons')

// 2. Click Plain → the line gains {plainlist}, Plain is lit, Icons keeps the mark, the slide is plain.
const plainOverride = click(iconsDeck, '')
assert.equal(plainOverride, iconsDeck.replace('{list}', '{list}{plainlist}'), 'Plain against an Icons deck writes {plainlist}')
const afterPlain = inspect(plainOverride)
assert.equal(afterPlain.binding.selectedToken, '', 'the {plainlist} override lights Plain')
assert.equal(afterPlain.binding.deckToken, 'iconlist', 'Icons stays deck-marked while Plain is lit')
assert.equal(await renderedListStyle(plainOverride), 'plain', 'the compiler renders {plainlist} as a plain list against the deck')
assert.equal(click(plainOverride, ''), plainOverride, 're-clicking the lit Plain override keeps the line byte-identical')

// 3. Click Icons (the deck-marked button) from there → the token is gone and the slide is icons.
const backToDeck = click(plainOverride, 'iconlist')
assert.equal(backToDeck, iconsDeck, 'the deck-marked Icons click removes {plainlist}; it never writes a copy of the deck setting')
assert.equal(await renderedListStyle(backToDeck), 'icons', 'without the override the compiled list renders icons again')

// 4. No deck default → Plain is lit and deck-marked, and clicking it writes nothing.
const plainDeck = showcaseOutline([], '{list}')
const plainDeckState = inspect(plainDeck)
assert.equal(plainDeckState.binding.selectedToken, '', 'no deck default → Plain is lit')
assert.equal(plainDeckState.binding.deckToken, '', 'no deck default → Plain carries the deck mark')
assert.equal(click(plainDeck, ''), plainDeck, 'clicking the deck-marked Plain writes nothing')
assert.equal(await renderedListStyle(plainDeck), 'plain', 'the lit Plain matches the render without a deck default')
assert.equal(click(plainDeck, 'iconlist'), plainDeck.replace('{list}', '{list}{iconlist}'), 'Icons on a plain deck writes {iconlist} as before')

// 5. {numbered} under icons: on → Numbered is lit, Icons is still deck-marked.
const numberedDeck = showcaseOutline(ICONS_ON, '{list}{numbered}')
const numbered = inspect(numberedDeck)
assert.equal(numbered.binding.selectedToken, 'numbered', '{numbered} under icons: on → Numbered is lit')
assert.equal(numbered.binding.deckToken, 'iconlist', '{numbered} under icons: on → Icons is still deck-marked')
assert.equal(await renderedListStyle(numberedDeck), 'numbers', 'the lit Numbered matches the render')
assert.equal(click(numberedDeck, 'numbered'), numberedDeck, 're-clicking the authored Numbered keeps its bytes')
assert.equal(click(numberedDeck, 'iconlist'), iconsDeck, 'the deck-marked Icons click removes the authored {numbered}')
assert.equal(click(numberedDeck, ''), iconsDeck.replace('{list}', '{list}{plainlist}'), 'Plain from Numbered against an Icons deck writes {plainlist}')

// The deck's choice reads every frame layer the compiler reads.
const sectionOff = showcaseOutline([...ICONS_ON, 'sections:', '  Fixtures: { icons: off }'], '{list}')
assert.equal(inspect(sectionOff).binding.deckToken, '', 'a sections: override for the owning ## beats the deck default')
assert.equal(await renderedListStyle(sectionOff), 'plain', 'and the compiler agrees: the section turns icons off')
const slideOff = showcaseOutline(ICONS_ON, '{list}{icons=off}')
assert.equal(inspect(slideOff).binding.deckToken, '', 'the slide’s own {icons=off} beats the deck default')
const inlineDefaults = showcaseOutline(['defaults: { icons: all }'], '{list}')
assert.equal(inspect(inlineDefaults).binding.deckToken, 'iconlist', 'an inline defaults map is read by the compiler’s parser')

// ── T32 follow-up: the treatment applies exactly when the compiled slide is an icon list ──
// Dominik's real case: `defaults: { icons: on }`, no list-style token. Applicability and the
// commit sweep both read the DECIDED style (authored token, else the deck's choice).
const iconTreatmentGroup = LAYOUTS.find((entry) => entry.name === 'iconlist').options.find((group) => group.key === 'iconlist-variant')
const { GLOBAL_OPTION_GROUPS } = await import('../src/shared/layout-registry/entries.ts')
const bodySizeGroup = GLOBAL_OPTION_GROUPS.find((group) => group.key === 'font-body')
const listSectionOf = (outline) => inspect(outline).model.sections[0].bindings
  .map((binding) => [binding.group.key, binding.nestedUnder ?? null])
const commitOn = (outline, group, token) => inspectorModule.applyInspectorOptionToOutline(outline, headingLineOf(outline), group, token)

// 1. The treatment is offered, nested under the lit (deck-marked) Icons.
assert.deepEqual(listSectionOf(iconsDeck), [['list-style', null], ['iconlist-variant', 'list-style'], ['icon-level', null]],
  'deck icons, no token → Icon treatment is offered under List style')
assert.deepEqual(listSectionOf(plainDeck), [['list-style', null], ['icon-level', null]],
  'no deck default, no token → the list is plain and no treatment is offered')

// 2. Choosing treatment List writes {iconlist=list}; Icons stays lit and deck-marked.
const treatedList = commitOn(iconsDeck, iconTreatmentGroup, 'iconlist=list')
assert.equal(treatedList, iconsDeck.replace('{list}', '{list}{iconlist=list}'), 'treatment List writes exactly {iconlist=list}')
assert.deepEqual([inspect(treatedList).binding.selectedToken, inspect(treatedList).binding.deckToken], ['iconlist', 'iconlist'],
  'the list-style row still lights the deck’s Icons')

// 3. The token survives the sweep of a later, unrelated commit.
const afterFontCommit = commitOn(treatedList, bodySizeGroup, 'font-body=l')
assert.ok(afterFontCommit.includes('{iconlist=list}'), 'an unrelated commit keeps the treatment token: the deck makes it relevant')

// 4. The compiled slide takes the list treatment.
assert.equal(await renderedListStyle(iconsDeck), 'icons', 'three items on the deck default render as boxes')
assert.equal(await renderedListStyle(treatedList), 'icon rows', 'the compiled deck-icons slide takes the {iconlist=list} rows')

// 5. Clicking Plain writes {plainlist} and sweeps the treatment token; the slide is plain.
const plainAfterTreatment = click(treatedList, '')
assert.equal(plainAfterTreatment, iconsDeck.replace('{list}', '{list}{plainlist}'), 'Plain writes {plainlist} and sweeps {iconlist=list}')
assert.equal(await renderedListStyle(plainAfterTreatment), 'plain', 'and the compiled slide is plain')

// The decided style is re-read on the line being produced: turning icons off sweeps it too.
const iconLevelGroup = LAYOUTS.find((entry) => entry.name === 'list').options.find((group) => group.key === 'icon-level')
assert.equal(commitOn(treatedList, iconLevelGroup, 'icons=off'), iconsDeck.replace('{list}', '{list}{icons=off}'),
  '{icons=off} makes the list plain, so the treatment token goes with it')

// ── T32: every option surface sweeps against the deck — the ⌘L picker and inline palette ──
// Callers of commitOptionSelection that write a slide's Trigger line (all route through
// deckCommitContext): applyInspectorOptionToOutline (strip-mode Inspector); Editor applyOption →
// commitSlideOption (⌘L picker option commits and the mounted-editor Inspector); Editor
// applyLayout → commitLayoutSelection (⌘L layout toggles); triggerComplete → commitSlideOption
// (inline palette option step) and commitLayoutSelection (inline layout pick).
const { commitSlideOption } = await import('../src/renderer/src/components/layoutPickerModel.ts')
const { planEditorTriggerCommit, commitInlineTriggerSelection } = await import('../src/renderer/src/extensions/inlineTriggerCommitModel.ts')
const applyChanges = (doc, changes) => [...changes].sort((a, b) => b.from - a.from)
  .reduce((text, change) => text.slice(0, change.from) + change.insert + text.slice(change.to), doc)
const placementGroup = GLOBAL_OPTION_GROUPS.find((group) => group.key === 'title-placement')
/** The ⌘L picker's option commit, exactly as Editor.tsx composes it (entry undefined for a global group). */
const commitViaPicker = (doc, group, token, entry) => {
  const plan = planEditorTriggerCommit(doc, headingLineOf(doc), (line, headingLine) =>
    commitSlideOption(doc, headingLine, line, entry, group, token))
  return applyChanges(doc, plan.changes)
}
const pickerTitle = commitViaPicker(treatedList, placementGroup, 'sidebar')
assert.equal(pickerTitle, iconsDeck.replace('{list}', '{list}{sidebar}{iconlist=list}'),
  '⌘L: changing Title placement on the deck-icons slide keeps {iconlist=list}')
assert.equal(await renderedListStyle(pickerTitle), 'icon rows', 'and the compiled slide still takes the list treatment')
assert.equal(commitViaPicker(pickerTitle, listStyleGroup, 'numbered', LAYOUTS.find((entry) => entry.name === 'list')),
  iconsDeck.replace('{list}', '{list}{numbered}{sidebar}'),
  '⌘L: choosing Numbered makes the list not an icon list, so the treatment is swept there too')
/** The inline palette's option step: the provisional `{…` typed on the Trigger line is replaced. */
const typedDoc = treatedList.replace('{list}{iconlist=list}', '{list}{iconlist=list}{sid')
const typedAt = typedDoc.indexOf('{sid')
const inlinePlan = commitInlineTriggerSelection(typedDoc, typedAt, typedAt + 4, (line, headingLine) =>
  commitSlideOption(typedDoc, headingLine, line, undefined, placementGroup, 'sidebar'))
assert.equal(applyChanges(typedDoc, inlinePlan.changes), pickerTitle,
  'inline palette: the same Title placement commit keeps {iconlist=list} on the deck-icons slide')

// ── T32 — Decision 2A: the Inspector's sections, as the model hands them to the component ──
const sectionsOf = (outline) => inspect(outline).model.sections
const plainSections = sectionsOf(plainDeck)
assert.deepEqual(plainSections.map((section) => section.heading), ['List', 'Title', 'Slide', 'Steps', 'Poll'],
  'the layout section is headed by the layout’s own label, then the fixed run')
assert.deepEqual(plainSections.at(-1).bindings.map((binding) => binding.group.key), ['poll-type'],
  'a slide that is not yet a poll offers only Poll type, as drawn')
assert.deepEqual(plainSections[0].bindings.map((binding) => binding.group.key), ['list-style', 'icon-level'],
  'the layout section holds the entry’s own groups')
const iconSections = sectionsOf(showcaseOutline([], '{list}{iconlist}'))
assert.deepEqual(
  iconSections[0].bindings.map((binding) => [binding.group.key, binding.nestedUnder ?? null]),
  [['list-style', null], ['iconlist-variant', 'list-style'], ['icon-level', null]],
  'Icon treatment sits first in the List section, directly under List style'
)
const pollSections = sectionsOf(showcaseOutline([], '{list}{poll=single}'))
assert.deepEqual(
  pollSections.at(-1).bindings.map((binding) => [binding.group.key, binding.nestedUnder ?? null]),
  [['poll-type', null], ['poll-results', 'poll-type']],
  'Poll results appears only once the slide is a poll, nested under Poll type'
)

// The unresolved panel replaces the options entirely — sections included.
assert.deepEqual(unresolvedModel.sections, [], 'the unresolved trigger panel replaces the sectioned options too')

// The jump row's lit pill: the last section whose top has reached the reading line.
const jumpTops = [{ id: 'layout', top: 0 }, { id: 'title', top: 200 }, { id: 'slide', top: 400 }]
assert.equal(sectionIdAtScrollTop(jumpTops, 31), 'layout', 'the first section is lit at the top')
assert.equal(sectionIdAtScrollTop(jumpTops, 199), 'layout', 'a section stays lit until the next one reaches the reading line')
assert.equal(sectionIdAtScrollTop(jumpTops, 200), 'title', 'the section at the reading line is lit')
assert.equal(sectionIdAtScrollTop(jumpTops, 900), 'slide', 'the last section is lit past its top')
assert.equal(sectionIdAtScrollTop([], 0), null, 'no sections, no lit pill')

console.log('inspector model: pane migration, navigation, applicable groups and step derivation pass')

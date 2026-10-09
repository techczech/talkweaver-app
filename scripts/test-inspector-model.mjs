import { readFileSync } from 'node:fs'
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
import { deckListStyleForSlide, deckStatementTokenForOutline } from '../src/shared/deck-frame.ts'
import { commitOptionSelection } from '../src/shared/trigger-line.ts'
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
  // A card grid reshaped into rows by narrow columns (fl-narrow-cols) is still the icons style.
  if (/^<(?:ul|ol) class="[^"]*fl-iconlist-list(?![^"]*fl-narrow-cols)/.test(list)) return 'icon rows'
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
assert.deepEqual(plainSections.map((section) => section.heading), ['Layout', 'Title', 'Slide', 'Steps', 'Poll', 'Audience'],
  'the layout section is headed by the layout’s own label, then the fixed run, Audience last (ticket 04)')
assert.deepEqual(plainSections.find((section) => section.id === 'poll').bindings.map((binding) => binding.group.key), ['poll-type'],
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
  pollSections.find((section) => section.id === 'poll').bindings.map((binding) => [binding.group.key, binding.nestedUnder ?? null]),
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

// ADR-0028 §10, ticket 02 (Dominik, 29 Sep): a statement's options are separate choices — Sidebar,
// Background, Alignment, Bar and Sidebar colour. Each lights what the compiled slide renders: its own
// token, the older one-word option it is part of, the deck's claim_style, and (Sidebar) the
// compiler's own title placement on the row.
{
  const { buildPerSlideProjections } = await import('../compiler/scripts/lib/10-projections.mjs')
  const { applyInspectorOptionToOutline } = inspectorModule
  const statementOutline = [
    '---', 'title: Statement options', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
    '## Statements', '',
    '### Agents need a place to keep their work.', '{id=untitled}{statement}', '',
    '### Where to start', '{id=titled}{statement=poster}', '', 'Agents need a place to keep their work.', ''
  ].join('\n')
  const statementModel = await prepareSource('/tmp/statement-options-outline.md', statementOutline, 'statement-options')
  const statementRows = buildPerSlideProjections(statementModel, 'statement-options')
  const at = (id) => statementRows.findIndex((row) => row.slide_id === id)
  assert.equal(statementRows[at('untitled')].title_layout, 'hidden', 'a heading-only statement compiles without a title')
  assert.equal(statementRows[at('titled')].title_layout, 'left', 'a statement with a body sits beside the rail')
  const KEYS = ['statement-sidebar', 'statement-bg', 'statement-align', 'statement-bar', 'statement-colour']
  const bindingsOf = (index, line, rowsIn = statementRows, deckStatement = '') =>
    inspectorModel(rowsIn, index, 3, line, LAYOUTS, undefined, false, [], '', deckStatement).sections.flatMap((section) => section.bindings)
  const lit = (id, line, deckStatement = '', rowsIn = statementRows) => Object.fromEntries(bindingsOf(at(id), line, rowsIn, deckStatement)
    .filter((binding) => KEYS.includes(binding.group.key))
    .map((binding) => [binding.group.key.replace('statement-', ''), binding.values.find((value) => value.token === binding.selectedToken)?.label ?? '—']))
  const layoutSection = inspectorModel(statementRows, at('untitled'), 3, '{id=untitled}{statement}', LAYOUTS).sections[0]
  assert.equal(layoutSection.heading, 'Layout', 'the layout section comes first, headed Layout')
  assert.deepEqual(layoutSection.bindings.map((binding) => binding.group.key), KEYS, 'the Statement section holds the five choices, in order')
  assert.deepEqual(layoutSection.bindings.map((binding) => binding.group.sectionLabel ?? binding.group.label),
    ['Sidebar', 'Background', 'Alignment', 'Bar', 'Sidebar colour'], 'each choice carries its short label')
  assert.deepEqual(layoutSection.bindings.map((binding) => binding.values.map(({ label }) => label)), [
    ['With sidebar', 'No sidebar'], ['Halo', 'Full', 'None'], ['Aligned', 'Centred'], ['None', 'Left', 'Top', 'Bottom'],
    ['Section', 'Cobalt', 'Emerald', 'Vermilion', 'Forest']
  ], 'the Inspector offers the ticket\'s values (Sidebar without its Auto)')
  const titledValues = bindingsOf(at('titled'), '{id=titled}{statement=poster}').filter((binding) => KEYS.includes(binding.group.key))
  assert.deepEqual(titledValues.find((binding) => binding.group.key === 'statement-align').values.map(({ label }) => label), ['Aligned', 'Centred'],
    'Centred is offered beside a title too')
  assert.equal(bindingsOf(at('untitled'), '{id=untitled}{statement}').some((binding) => binding.group.key === 'claim-style'), false,
    'a statement slide does not offer the older Claim style row')

  const DEFAULTS = { sidebar: 'No sidebar', bg: 'Halo', align: 'Aligned', bar: 'None', colour: 'Section' }
  assert.deepEqual(lit('untitled', '{id=untitled}{statement}'), DEFAULTS, 'an untokened statement without a title: no sidebar, Halo, Aligned, no bar, section colour')
  assert.deepEqual(lit('titled', '{id=titled}{statement=poster}'), { ...DEFAULTS, sidebar: 'With sidebar' }, 'beside a title the sidebar is lit; a former Poster is the Default')
  // The five older options light their mapped values (untitled slide).
  const PRESETS = {
    '{statement}{statement=default}': DEFAULTS,
    '{statement=centred}': { ...DEFAULTS, align: 'Centred' },
    '{statement=tint}': { ...DEFAULTS, bar: 'Left' },
    '{statement=bar}': { ...DEFAULTS, bg: 'None', bar: 'Left' },
    '{statement=full}': { ...DEFAULTS, bg: 'Full' },
    '{statement}{claim=bar}{bg=emerald}': { ...DEFAULTS, bg: 'None', bar: 'Left' },
    '{statement}{claim=plain}{bg=emerald}': DEFAULTS,
    '{statement}{statement=bar}{claim=plain}': { ...DEFAULTS, bg: 'None', bar: 'Left' },
    '{statement}{statement=tint}{claim=bar}': { ...DEFAULTS, bar: 'Left' },
    '{statement=tint}{statement-bar=top}': { ...DEFAULTS, bar: 'Top' },
    '{statement}{statement-bg=full}{statement-bar=bottom}{statement-align=centred}{accent=vermilion}': { ...DEFAULTS, bg: 'Full', bar: 'Bottom', align: 'Centred', colour: 'Vermilion' },
    '{statement}{statement-sidebar=on}': { ...DEFAULTS, sidebar: 'With sidebar' }
  }
  for (const [tokens, want] of Object.entries(PRESETS)) {
    assert.deepEqual(lit('untitled', `{id=untitled}${tokens}`), want, `${tokens} lights ${JSON.stringify(want)}`)
  }
  // The older Centred rendered as the Default beside a title (preview.11), and lights so.
  assert.equal(lit('titled', '{id=titled}{statement=centred}').align, 'Aligned', 'the older {statement=centred} beside a title lights Aligned')
  assert.equal(lit('titled', '{id=titled}{statement}{statement-align=centred}').align, 'Centred', 'the Alignment choice centres beside a title')
  // The deck's claim_style: bar decides an untokened statement (no colour, left bar); a slide token wins.
  assert.deepEqual(lit('untitled', '{id=untitled}{statement}', 'statement=bar'), { ...DEFAULTS, bg: 'None', bar: 'Left' }, 'a Bar deck lights None + Left')
  assert.deepEqual(lit('untitled', '{id=untitled}{statement}{claim=plain}', 'statement=bar'), DEFAULTS, 'a slide {claim=plain} wins over the deck')
  assert.deepEqual(lit('untitled', '{id=untitled}{statement}{statement-bar=top}', 'statement=bar'), { ...DEFAULTS, bar: 'Top' }, 'a choice of its own ends following the deck')
  const statementBindings = bindingsOf(at('untitled'), '{id=untitled}{statement}', statementRows, 'statement=bar').filter((binding) => KEYS.includes(binding.group.key))
  assert.equal(statementBindings.some((binding) => binding.deckToken !== undefined), false, 'the statement choices carry no deck mark')
  for (const binding of statementBindings) assert.equal(inspectorCommitToken(binding, ''), '', `${binding.group.key}: a click writes its own token`)
  // A row without the compiled title regime (an old cache) lights no Sidebar button rather than guess.
  const oldRows = statementRows.map(({ title_layout: _dropped, ...row }) => row)
  assert.equal(lit('untitled', '{id=untitled}{statement}', '', oldRows).sidebar, '—', 'an old cache row lights no Sidebar choice')
  for (const line of ['{id=titled}{statement=poster}', '{id=titled}{statement}{statement-bg=none}{statement-bar=bottom}{accent=forest}{statement-sidebar=off}']) {
    assert.equal(inspectorModel(statementRows, at('titled'), 3, line, LAYOUTS).unresolved, false, `${line}: registry vocabulary, no unresolved-trigger panel`)
  }

  // The write, end to end through the Inspector's own outline writer (deckCommitContext reads the
  // deck's claim_style and whether the slide paints its title from the outline).
  const bindingFor = (key) => layoutSection.bindings.find((binding) => binding.group.key === key).group
  const lineAfter = (outline, id, key, token) => {
    const heading = outline.split('\n').findIndex((line) => line.includes(`{id=${id}}`))
    const next = applyInspectorOptionToOutline(outline, heading, bindingFor(key), token)
    return next.split('\n')[heading]
  }
  const legacy = statementOutline.replace('{id=untitled}{statement}', '{id=untitled}{statement=centred}').replace('{id=titled}{statement=poster}', '{id=titled}{statement=centred}')
  assert.equal(lineAfter(legacy, 'untitled', 'statement-bar', 'statement-bar=top'), '{id=untitled}{statement}{statement-bar=top}{statement-align=centred}',
    'Bar Top on the older Centred without a title: the lines stay centred')
  assert.equal(lineAfter(legacy, 'titled', 'statement-bar', 'statement-bar=top'), '{id=titled}{statement}{statement-bar=top}',
    'Bar Top on the older Centred beside a title (rendered Aligned): stays aligned')
  const barDeck = statementOutline.replace('auto_thanks_slide: false', 'auto_thanks_slide: false\nclaim_style: bar')
  assert.equal(lineAfter(barDeck, 'untitled', 'statement-bg', ''), '{id=untitled}{statement}{statement-bar=left}',
    'Halo on a Bar deck keeps the deck\'s left bar as a token of its own')
  assert.equal(lineAfter(barDeck, 'untitled', 'statement-colour', 'accent=emerald'), '{id=untitled}{statement}{accent=emerald}{statement-bg=none}{statement-bar=left}',
    'the colour on a Bar deck: the deck\'s look is written out so it stays')
  assert.equal(deckStatementTokenForOutline(barDeck), 'statement=bar', 'a deck claim_style: bar decides Bar')
  assert.equal(deckStatementTokenForOutline(statementOutline), '', 'no claim_style decides nothing')
  const groupKeys = (index, line, rowsIn) => bindingsOf(index, line, rowsIn).map((binding) => binding.group.key)
  console.log('PASS statement choices: five rows, lit from the compiled look (older options, claim tokens, deck claim_style, title placement); writes change one dimension')

  // {stmt-list}: its statement column is the slide's claim, not an ADR-0028 §10 statement slide —
  // the statement options are not offered there; Claim style (Plain / Bar) is, and applies.
  const stmtListOutline = ['---', 'title: Stmt list', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
    '### Statement beside a list', '{stmt-list}{claim=plain}{id=stmtl}', '', 'Is the time worth it?', '', '- One', '- Two', ''].join('\n')
  const stmtListModel = await prepareSource('/tmp/stmt-list-outline.md', stmtListOutline, 'stmt-list')
  const stmtListRows = buildPerSlideProjections(stmtListModel, 'stmt-list')
  const stmtKeys = groupKeys(stmtListRows.findIndex((row) => row.slide_id === 'stmtl'), '{stmt-list}{claim=plain}{id=stmtl}', stmtListRows)
  assert.equal(stmtKeys.some((key) => key.startsWith('statement-')), false, 'stmt-list does not offer the statement options')
  assert.equal(stmtKeys.includes('claim-style'), true, 'stmt-list offers Claim style for its statement column')
  console.log('PASS one set of statement options: claim tokens and claim_style map onto them; stmt-list keeps Claim style')
}

// ── Ticket 04: a slide chooses its reactions from the Trigger line or the Inspector ─────────────
// An unregistered token blanks the Inspector (the unresolved panel replaces every group), so each
// {reactions=…} form must resolve through the Layout Doctor and keep the Inspector's groups, with
// the Audience › Reactions group lit for it. Each Inspector action writes exactly its one token
// (Standard writes none) and the compiled slide then carries what the phone bar will offer.
{
  const { buildPerSlideProjections } = await import('../compiler/scripts/lib/10-projections.mjs')
  const { reactionsControlView, reactionsModeToken, reactionsChipToken, reactionsLabelsToken } =
    await import('../src/renderer/src/components/reactionsControlModel.ts')
  const reactionsGroup = optionGroupsForSlide({ layoutName: 'list', headingLevel: 3, hasChildren: false })
    .find(({ group }) => group.key === 'reactions')?.group
  assert.ok(reactionsGroup, 'the Reactions group is offered on an ordinary slide')
  const outlineWith = (line) => ['---', 'title: Reactions', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
    '### How was the pace?', line, '', '- One', '- Two', ''].join('\n')
  const headingLine = 7
  const compiled = async (outline) => {
    const model = await prepareSource(`/tmp/reactions-${++compileProbe}.md`, outline, 'Reactions')
    const rows = buildPerSlideProjections(model, 'reactions')
    const slide = model.slides.find((candidate) => candidate.title === 'How was the pace?')
    const html = await buildDeckHtmlFromModel({ ...model, slides: [slide] })
    const attr = html.match(/<section class="slide"[^>]*?data-reactions="([^"]*)"/)?.[1]
    return { rows, reactions: attr === undefined ? null : JSON.parse(attr.replaceAll('&quot;', '"').replaceAll('&amp;', '&')), warnings: model.warnings }
  }
  const forms = [
    ['{id=pace}', 'standard', null],
    ['{id=pace} {reactions=off}', 'off', []],
    ['{id=pace} {reactions=agree,disagree}', 'choose', ['agree', 'disagree']],
    ['{id=pace} {reactions=agree,disagree,bookmark}', 'choose', ['agree', 'disagree', 'bookmark']],
    ['{id=pace} {reactions="Too fast","Just right","Too slow"}', 'custom', ['custom:Too fast', 'custom:Just right', 'custom:Too slow']]
  ]
  for (const [line, mode, offered] of forms) {
    const outline = outlineWith(line)
    const findings = layoutDoctor.scanOutlineTriggers(outline)
    const { rows, reactions } = await compiled(outline)
    const index = rows.findIndex((row) => row.slide_id === 'pace')
    const model = inspectorModel(rows, index, 3, line, LAYOUTS, undefined, false, findings)
    assert.equal(model.unresolved, false, `${line}: the Inspector stays resolved (no unregistered-key finding)`)
    assert.ok(model.groups.length > 1, `${line}: the Inspector keeps its groups (${model.groups.length})`)
    const audience = model.sections.find((section) => section.id === 'audience')
    assert.deepEqual(audience?.bindings.map((binding) => binding.group.key), ['reactions'], `${line}: Audience › Reactions is offered`)
    assert.equal(reactionsControlView(audience.bindings[0].selectedToken).mode, mode, `${line}: the Reactions row lights ${mode}`)
    assert.deepEqual(reactions, offered, `${line}: the compiled slide carries what the bar offers`)
  }

  // The writes: each action commits one token through the ordinary option path, byte-preserving.
  const write = (outline, token) => inspectorModule.applyInspectorOptionToOutline(outline, headingLine, reactionsGroup, token)
  const lineOf = (outline) => outline.split('\n')[headingLine]
  const standard = outlineWith('{id=pace}')
  const off = write(standard, reactionsModeToken('off'))
  assert.equal(lineOf(off), '{id=pace} {reactions=off}', 'Off writes {reactions=off}')
  assert.equal(reactionsModeToken('choose'), null, 'Choose opens its chips without writing')
  assert.equal(reactionsModeToken('custom'), null, 'Custom opens its field without writing')
  const agree = write(off, reactionsChipToken(reactionsControlView('reactions=off', 'choose').chosen, 'agree'))
  assert.equal(lineOf(agree), '{id=pace} {reactions=agree}', 'the first chip replaces off with a set of one')
  const agreeDisagree = write(agree, reactionsChipToken(reactionsControlView('reactions=agree').chosen, 'disagree'))
  assert.equal(lineOf(agreeDisagree), '{id=pace} {reactions=agree,disagree}', 'I2: Agree then Disagree writes {reactions=agree,disagree}')
  assert.deepEqual(reactionsControlView('reactions=agree,disagree').chosen, ['agree', 'disagree'], 'the chips read back in their order')
  assert.equal(reactionsChipToken(['agree', 'disagree', 'yes', 'no'], 'more'), null, 'a fifth chip is refused')
  assert.equal(reactionsChipToken(['agree'], 'agree'), '', 'taking out the last chip is Standard')
  const labels = reactionsLabelsToken('Too fast, Just right, Too slow')
  assert.equal(labels.token, 'reactions="Too fast","Just right","Too slow"', 'I3: the labels field writes quoted labels')
  const custom = write(agreeDisagree, labels.token)
  assert.equal(lineOf(custom), '{id=pace} {reactions="Too fast","Just right","Too slow"}', 'I3: the custom token replaces the chosen set')
  assert.equal(reactionsControlView('reactions=Too fast,Just right,Too slow').labelsText, 'Too fast, Just right, Too slow', 'the field reads the labels back')
  assert.equal(reactionsControlView('reactions=Too fast,Just right,Too slow').token, 'reactions="Too fast","Just right","Too slow"', 'the Trigger line row shows the quoted token')
  assert.ok(reactionsLabelsToken('A, B, C, D, E').problem, 'five labels are refused before they reach the line')
  assert.ok(reactionsLabelsToken('Say "hi"').problem, 'a quote cannot be written inside a quoted label')
  assert.ok(reactionsLabelsToken('yes, maybe').problem, 'a label spelled as a registered reaction is refused (it would read back as that reaction)')
  assert.equal(reactionsLabelsToken('Agree, Maybe').problem, '“Agree” is the named reaction agree; choose it under Choose.', 'the refusal ignores case')
  const back = write(custom, reactionsModeToken('standard'))
  assert.equal(back, standard, 'Standard removes the token and leaves the outline byte for byte as it was')
  for (const [outline, offered] of [[off, []], [agreeDisagree, ['agree', 'disagree']], [custom, ['custom:Too fast', 'custom:Just right', 'custom:Too slow']], [back, null]]) {
    assert.deepEqual((await compiled(outline)).reactions, offered, `the Inspector's write compiles: ${lineOf(outline)}`)
  }
  // A token the author typed among other tokens is replaced; every other token stays.
  const typed = outlineWith('{id=pace} {reactions=off} {numbered}')
  assert.equal(lineOf(write(typed, 'reactions=yes,no')), '{id=pace}{numbered} {reactions=yes,no}', 'a rewrite keeps every other token')

  // A fifth reaction compiles to the first four with a warning the Inspector shows.
  const five = await compiled(outlineWith('{id=pace} {reactions=agree,disagree,yes,no,more}'))
  assert.deepEqual(five.reactions, ['agree', 'disagree', 'yes', 'no'], 'a fifth reaction is left out of the bar')
  assert.ok(five.warnings.includes('reactions-too-many:pace:5'), 'a fifth reaction is a compiler warning')
  const fiveRow = five.rows.find((row) => row.slide_id === 'pace')
  assert.ok(fiveRow.warnings.includes('reactions-too-many:pace:5'), 'the warning reaches the slide’s row (strip badge and Inspector)')
  console.log('PASS reactions: every {reactions=…} form keeps the Inspector’s groups and lights its mode; each action writes one token; a fifth warns')
}

// ── Ticket 01 (ADR-0032): a board slide keeps the Inspector, and its Board section round-trips ─────
// The unknown board tokens blanked the Inspector while the boards were drawn (round-3 finding 4).
// Every setting and column form must resolve, light its setting, and read back in the Board
// section exactly as the compiler reads it; defaults write no token; the Board section's edits go
// into the slide body and compile to the definition they show.
{
  const { buildPerSlideProjections } = await import('../compiler/scripts/lib/10-projections.mjs')
  const { applyBoardEditToOutline, boardSource } = await import('../compiler/scripts/lib/board-slide.mjs')
  const outlineWith = (line, body = ['Add what you would keep, change or try.', '', '- Keep', '  - What worked for you?', '- Change', '- Try']) =>
    ['---', 'title: Boards', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
      '### What should we keep, change, try?', line, '', ...body, ''].join('\n')
  const headingLine = 7
  const inspect = async (outline) => {
    const model = await prepareSource(`/tmp/board-inspector-${++compileProbe}.md`, outline, 'Boards')
    const rows = buildPerSlideProjections(model, 'boards')
    const index = rows.findIndex((row) => row.slide_id === 'kctbd')
    const block = extractInspectorSlideBlock(outline, headingLine)
    const triggerLine = block.split('\n')[1]
    const findings = layoutDoctor.scanOutlineTriggers(outline)
    return { poll: model.slides.find((slide) => slide.poll)?.poll, warnings: model.warnings,
      inspector: inspectorModel(rows, index, 3, triggerLine, LAYOUTS, block, false, findings) }
  }
  const forms = [
    ['{poll=board} {id=kctbd}', {}],
    ['{poll=board} {limit=12} {id=kctbd}', { 'board-limit': 'limit=12' }],
    ['{poll=board} {limit=36} {length=100} {id=kctbd}', { 'board-limit': 'limit=36', 'board-length': 'length=100' }],
    ['{poll=board} {limit=all} {length=60} {cards=1} {names} {closes=1d} {id=kctbd}',
      { 'board-limit': 'limit=all', 'board-length': 'length=60', 'board-cards': 'cards=1', 'board-names': 'names', 'board-closes': 'closes=1d' }],
    ['{poll=board} {length=200} {cards=10} {closes=30d} {id=kctbd}', { 'board-length': 'length=200', 'board-cards': 'cards=10', 'board-closes': 'closes=30d' }],
    ['{poll=board} {cards=3} {names=optional} {id=kctbd}', { 'board-cards': 'cards=3', 'board-names': 'names' }],
    ['{poll=board} {limit=24} {length=140} {cards=5} {closes=7d} {id=kctbd}', {}]
  ]
  for (const [line, lit] of forms) {
    const { inspector, poll } = await inspect(outlineWith(line))
    assert.equal(inspector.unresolved, false, `${line}: the Inspector never blanks on a board slide`)
    const board = inspector.sections.find((section) => section.id === 'poll')
    assert.equal(board?.heading, 'Board', `${line}: the Poll section is headed Board (the Board chip)`)
    assert.ok(inspector.board, `${line}: the Board section's model is built`)
    const keys = board.bindings.map((binding) => binding.group.key)
    assert.deepEqual(keys.filter((key) => key.startsWith('board-')), ['board-limit', 'board-length', 'board-cards', 'board-names', 'board-closes'],
      `${line}: every setting is offered`)
    assert.equal(keys.includes('poll-results'), false, `${line}: result visibility is not a board setting`)
    for (const binding of board.bindings.filter((b) => b.group.key.startsWith('board-'))) {
      assert.equal(binding.selectedToken, lit[binding.group.key] ?? '', `${line}: ${binding.group.key} lights ${lit[binding.group.key] ?? 'its default'}`)
    }
    const { limit, cardChars, cardsPerPhone, names, closesAfterDays } = poll.board
    assert.deepEqual(inspector.board.settings, { limit, cardChars, cardsPerPhone, names, closesAfterDays }, `${line}: the Inspector reads the settings the compiler emits`)
    assert.deepEqual(inspector.board.columns.map((column) => column.label), poll.options.map((option) => option.label), `${line}: the Inspector reads the compiler's columns`)
  }

  // Settings: every value written through the ordinary option path compiles to that value; the
  // default writes nothing (A4); the line keeps the drawn order (A6).
  const groupFor = (key) => optionGroupsForSlide({ layoutName: 'list', headingLevel: 3, hasChildren: false }).find(({ group }) => group.key === key).group
  let outline = outlineWith('{poll=board} {id=kctbd}')
  outline = inspectorModule.applyInspectorOptionToOutline(outline, headingLine, groupFor('board-limit'), 'limit=36')
  outline = inspectorModule.applyInspectorOptionToOutline(outline, headingLine, groupFor('board-length'), 'length=100')
  assert.equal(outline.split('\n')[headingLine], '{poll=board}{limit=36}{length=100}{id=kctbd}', 'A6: the Inspector writes the settings after {poll=board}, in its logical (adjacent) form')
  const reset = inspectorModule.applyInspectorOptionToOutline(
    inspectorModule.applyInspectorOptionToOutline(outline, headingLine, groupFor('board-limit'), ''), headingLine, groupFor('board-length'), '')
  assert.equal(reset, outlineWith('{poll=board}{id=kctbd}'), 'choosing each default removes its token: nothing of the settings is left')
  for (const [key, token, field, value] of [
    ['board-limit', 'limit=12', 'limit', 12], ['board-limit', 'limit=all', 'limit', null],
    ['board-length', 'length=60', 'cardChars', 60], ['board-cards', 'cards=10', 'cardsPerPhone', 10],
    ['board-names', 'names', 'names', true], ['board-closes', 'closes=1d', 'closesAfterDays', 1]
  ]) {
    const written = inspectorModule.applyInspectorOptionToOutline(outlineWith('{poll=board} {id=kctbd}'), headingLine, groupFor(key), token)
    const { poll, inspector } = await inspect(written)
    assert.equal(poll.board[field], value, `${token} compiles to ${field} ${value}`)
    assert.equal(inspector.board.settings[field], value, `${token} reads back in the Board section`)
  }

  // The body: rename, add, reorder, remove, hints, instructions, example (A2, A3), through the
  // board edit path, compile to what the Board section then shows.
  let body = outlineWith('{poll=board} {id=kctbd}')
  const edit = (next) => { body = applyBoardEditToOutline(body, headingLine, next) }
  const columnsNow = () => boardSource(extractInspectorSlideBlock(body, headingLine).split('\n').slice(1)).columns
  edit({ kind: 'columns', columns: columnsNow().map((column, index) => index === 2 ? { ...column, label: 'Try next', hint: 'What could we do next time?' } : column) })
  edit({ kind: 'columns', columns: [...columnsNow(), { label: 'Stop', hint: 'What should we drop?' }] })
  edit({ kind: 'columns', columns: [columnsNow()[3], ...columnsNow().slice(0, 3)] })
  edit({ kind: 'columns', columns: columnsNow().filter((column) => column.label !== 'Change') })
  edit({ kind: 'instructions', text: 'One idea per card; no names are shown.' })
  edit({ kind: 'example', text: 'More time to try things ourselves' })
  edit({ kind: 'question', text: 'What should we keep, stop, try?' })
  const { poll, inspector } = await (async () => {
    const model = await prepareSource(`/tmp/board-inspector-${++compileProbe}.md`, body, 'Boards')
    const rows = buildPerSlideProjections(model, 'boards')
    const block = extractInspectorSlideBlock(body, headingLine)
    return { poll: model.slides.find((slide) => slide.poll).poll,
      inspector: inspectorModel(rows, rows.findIndex((row) => row.slide_id === 'kctbd'), 3, block.split('\n')[1], LAYOUTS, block, false, layoutDoctor.scanOutlineTriggers(body)) }
  })()
  assert.deepEqual(poll.options.map((option) => option.label), ['Stop', 'Keep', 'Try next'], 'add, reorder and remove reach the compiled columns')
  assert.deepEqual(poll.board.hints, { 'poll-kctbd-option-1': 'What should we drop?', 'poll-kctbd-option-2': 'What worked for you?', 'poll-kctbd-option-3': 'What could we do next time?' }, 'hints travel with their columns')
  assert.equal(poll.question, 'What should we keep, stop, try?')
  assert.equal(poll.board.instructions, 'One idea per card; no names are shown.')
  assert.equal(poll.board.example, 'More time to try things ourselves')
  assert.deepEqual(
    { question: inspector.board.question, instructions: inspector.board.instructions, example: inspector.board.example, columns: inspector.board.columns.map(({ label, hint }) => [label, hint]) },
    { question: poll.question, instructions: poll.board.instructions, example: poll.board.example, columns: poll.options.map((option) => [option.label, poll.board.hints[option.optionId] ?? '']) },
    'the Board section shows exactly what compiled'
  )
  assert.equal(inspector.board.triggerText, '{poll=board}', 'the Trigger line row shows the board tokens (never the id)')
  assert.equal(inspector.board.canAddColumn, true)
  assert.equal(inspector.board.canRemoveColumn, true)
  console.log('PASS board: every setting and column form resolves and round-trips; defaults write no token; body edits compile to what the Board section shows')
}

// ── ADR-0032 §1/§7, ticket 05: which options become pictures of the author's slide ──────────
{
  const { optionPictureRequest } = inspectorModule
  const { previewLayout, setLayoutOption } = await import('../src/shared/layout-verbs.ts')
  const picturedKeys = (m) => m.sections.flatMap((section) => section.bindings).filter((b) => b.pictures).map((b) => b.group.key)
  const outline = '### Codex things\n{icons}{id=a1} {cards}\n\n- A\n- B\n- C\n\n### Quote\n{id=q1} {statement}\n\nOne sentence.\n\n### List\n{id=l1} {iconlist}\n\n- A\n- B\n\n## Section {id=s1}\n\n### kid\n\nx\n'
  const build = (headingLine, line, level = 3, hasChildren = false, layout = 'x') =>
    inspectorModel([{ layout, slide_id: 'x' }], 0, level, line, LAYOUTS, '', hasChildren)

  const cards = build(1, '{icons}{id=a1} {cards}')
  assert.deepEqual(picturedKeys(cards).sort(), ['cards-icons', 'font-body', 'form', 'title-placement'],
    'Cards: form, icons, title placement and body size are pictures')
  const form = cards.sections.flatMap((s) => s.bindings).find((b) => b.group.key === 'form')
  assert.deepEqual(form.pictures.pictured.map((v) => v.token), ['', 'cards=grid', 'cards=rows', 'cards=stepped'])
  assert.equal(form.pictures.layout, 'cards')
  const placement = cards.sections.flatMap((s) => s.bindings).find((b) => b.group.key === 'title-placement')
  assert.ok(placement.pictures.rest.every((v) => v.token.startsWith('split=')), 'split widths stay buttons')
  assert.equal(cards.sections.flatMap((s) => s.bindings).find((b) => b.group.key === 'font-title')?.pictures, undefined,
    'title size stays a button row')

  assert.deepEqual(picturedKeys(build(1, '{id=q1} {statement}')), [], 'other layouts keep their buttons')
  assert.deepEqual(picturedKeys(build(1, '{id=l1} {iconlist}', 3, false, 'list')).sort(), ['iconlist-variant', 'list-style'], 'list styles are pictures')
  assert.deepEqual(picturedKeys(build(1, '{id=s1}', 2, true, 'section')), ['container-mode'], 'a section heading pictures its container modes')

  // The request a picture makes is the slide with that ONE option, and it agrees with what a click writes.
  const request = optionPictureRequest(form.pictures, 'form', 'cards=rows')
  assert.deepEqual(request, { layout: 'cards', options: [{ group: 'form', token: 'cards=rows' }] })
  const shown = previewLayout(outline, 'a1', request.layout, request.options)
  const written = setLayoutOption(outline, 'a1', 'form', 'cards=rows').outline
  assert.equal(shown, written, 'the picture shows exactly the slide the click writes')
  assert.match(written, /\{cards=rows\}/, 'clicking Rows puts {cards=rows} on the trigger line')
  const list = build(1, '{id=l1} {iconlist}', 3, false, 'list').sections.flatMap((s) => s.bindings).find((b) => b.group.key === 'list-style')
  const numbered = optionPictureRequest(list.pictures, 'list-style', 'numbered')
  assert.equal(previewLayout(outline, 'l1', numbered.layout, numbered.options).includes('{numbered}'), true)
  const container = build(1, '{id=s1}', 2, true, 'section').sections.flatMap((s) => s.bindings).find((b) => b.group.key === 'container-mode')
  for (const value of container.pictures.pictured) {
    const r = optionPictureRequest(container.pictures, 'container-mode', value.token)
    const text = previewLayout(outline, 's1', r.layout, r.options)
    assert.ok(value.token === '' ? !/\{(carousel|contents|grid-)/.test(text.split('### kid')[0]) : text.includes(`{${value.token}}`),
      `container picture for "${value.token}" shows that mode`)
  }
  console.log('PASS option pictures: Cards, list styles and container modes are pictures; other layouts keep buttons; a picture equals the slide its click writes')
}

// Second review of the option pictures (2026-09-30): stale grey marks, and the Inspector within the budget.
{
  const { markSettled, marksForNewText, createVariantPictureQueue, createVariantPictureSlots, VARIANT_PICTURE_POLICY } =
    await import('../src/shared/variant-picture-queue.ts')
  // 6. A "cannot take" mark is about the text it was drawn from: new text clears it at once; pictures
  //    stay until their replacements arrive; a new verdict replaces the old one.
  let marks = {}
  marks = markSettled(marks, 'cards=rows', 'twthumb://t/rows')
  marks = markSettled(marks, 'cards=grid', { reason: 'Needs an image' })
  assert.deepEqual(marksForNewText(marks), { 'cards=rows': 'twthumb://t/rows' }, 'new text drops the old verdict, keeps the picture')
  // Fix round 4 (D): only the grey verdict goes; a fallback (null: the sample, the named tile) stays, so
  // a keystroke never flickers sample → pending → sample.
  assert.deepEqual(marksForNewText({ ...marks, 'cards=plain': null }), { 'cards=rows': 'twthumb://t/rows', 'cards=plain': null }, 'a fallback mark survives new text')
  const onlyFallbacks = { 'cards=plain': null, 'cards=rows': 'twthumb://t/rows' }
  assert.equal(marksForNewText(onlyFallbacks), onlyFallbacks, 'nothing grey, nothing changes (no re-render)')
  assert.deepEqual(markSettled(marks, 'cards=grid', 'twthumb://t/grid')['cards=grid'], 'twthumb://t/grid', 'a picture replaces a grey mark')
  assert.deepEqual(markSettled(marks, 'cards=rows', { reason: 'Too long' })['cards=rows'], { reason: 'Too long' }, 'a verdict replaces a picture')
  const same = markSettled(marks, 'cards=grid', { reason: 'Needs an image' })
  assert.equal(same, marks, 'the same verdict again changes nothing (no re-render)')
  const component = readFileSync(new URL('../src/renderer/src/components/InspectorOptionPictures.tsx', import.meta.url), 'utf8')
  assert(component.includes('setMarks(marksForNewText)'), 'the Inspector clears stale grey marks on new text')
  // 2. The Inspector asks through the shared policy and window budget only, and only for a group on screen:
  //    no retry constants or timers of its own.
  assert(component.includes('createVariantPictureQueue') && component.includes('onScreen ? set.pictured.map'))
  assert(!/ASK_AGAIN|RETRY_DELAY|MAX_ATTEMPTS/.test(component), 'no second retry policy in the Inspector')
  // Cards: fifteen pictures across four groups, all on screen at once, never more than the budget out.
  const slots = createVariantPictureSlots()
  const held = []
  let asked = 0
  const groups = [4, 3, 4, 4].map((count, index) => {
    const queue = createVariantPictureQueue(() => { asked += 1; return new Promise((resolve) => held.push(resolve)) }, () => {}, { slots })
    queue.reset(`g${index}`, {})
    queue.want(Array.from({ length: count }, (_, n) => `v${n}`))
    return queue
  })
  assert.equal(asked, VARIANT_PICTURE_POLICY.maxInFlight, 'fifteen pictures wanted, only the budget asked')
  for (let i = 0; i < 40 && held.length; i += 1) {
    held.shift()({ status: 'ok', slideId: 's', url: `u${i}`, cached: false })
    await new Promise((resolve) => setTimeout(resolve))
    assert(slots.inUse() <= VARIANT_PICTURE_POLICY.maxInFlight)
  }
  assert.equal(asked, 15, 'each picture asked once')
  groups.forEach((queue) => queue.dispose())
  console.log('PASS option pictures: stale grey marks clear; the Inspector asks within the window budget, visible groups only')
}

// Fix round 4 (2026-09-30): leaving a slide frees the window's picture slots at once (E), and a fetch that
// throws before it returns a promise still gives its slot back (F).
{
  const { createVariantPictureQueue, createVariantPictureSlots, VARIANT_PICTURE_POLICY } = await import('../src/shared/variant-picture-queue.ts')
  const tick = () => new Promise((resolve) => setTimeout(resolve))
  // E. Three full-deck compiles out for slide A; the author moves to slide B: B's first picture is asked
  //    at once, not after A's three answers.
  const slots = createVariantPictureSlots()
  const asked = []
  const held = []
  const queue = createVariantPictureQueue((key, request) => { asked.push(`${request.slide}:${key}`); return new Promise((resolve) => held.push(resolve)) }, () => {}, { slots })
  queue.reset('A\0text', { slide: 'A' }, 'A')
  queue.want(['cards', 'bullets', 'timeline', 'quote'])
  assert.equal(slots.inUse(), VARIANT_PICTURE_POLICY.maxInFlight, 'slide A fills the window budget')
  queue.reset('B\0text', { slide: 'B' }, 'B')
  queue.want(['cards', 'bullets'])
  assert.deepEqual(asked.slice(-2), ['B:cards', 'B:bullets'], 'slide B is asked for at once, not behind slide A')
  assert.equal(slots.inUse(), 2, 'slide A\'s requests no longer hold slots')
  for (const resolve of held.splice(0, 3)) resolve({ status: 'ok', slideId: 'A', url: 'u', cached: false })
  await tick()
  assert.equal(slots.inUse(), 2, 'A\'s late answers release nothing twice')
  // New text of the SAME slide keeps its requests (main drops the stale ones itself).
  queue.reset('B\0new text', { slide: 'B' }, 'B')
  assert.equal(slots.inUse(), 2, 'typing on the same slide does not abandon requests')
  queue.dispose()
  assert.equal(slots.inUse(), 0, 'a disposed queue gives its slots back')
  // F. fetchPicture throws synchronously: the slot comes back and the key is tried again later.
  const lone = createVariantPictureSlots(1)
  const retries = []
  const throwing = createVariantPictureQueue(() => { throw new Error('bridge gone') }, () => {}, { slots: lone, schedule: (run, ms) => retries.push(ms) })
  throwing.reset('k', {}, 's')
  assert.doesNotThrow(() => throwing.want(['cards']), 'a throwing fetch never escapes the queue')
  await tick()
  assert.equal(lone.inUse(), 0, 'the slot is released')
  assert.deepEqual(retries, [VARIANT_PICTURE_POLICY.retryDelayMs], 'the failure is retried by the policy')
  throwing.dispose()
  console.log('PASS picture queue: leaving a slide frees its slots; a throwing fetch releases its slot')
}

// ── Ticket 08 (ADR-0032 amendment point 5): the pre-work tokens keep the Inspector, and its
// "Before the session" section shows each step (round-2 E1–E4, round-3 P5) ──────────────────────
// An unregistered {prework} blanked the Inspector and was a Layout Doctor error (ticket 07 review).
{
  const { buildPerSlideProjections } = await import('../compiler/scripts/lib/10-projections.mjs')
  const { inspectorPreworkModel, preworkRunLine, resultsGroup } = await import('../src/renderer/src/components/inspectorPreworkModel.ts')
  const { preworkFromOutline } = await import('../compiler/scripts/lib/prework.mjs')
  const outline = [
    '---', 'title: Pre-work', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
    '## Before the session', '{id=pwform}{prework}', '', 'Four short steps.', '',
    '### Welcome: three things before Monday', '{id=pwwelcome}', '', '- Read two short slides', '',
    '### Quick check: what makes something an agent?', '{poll=single}{id=pwquiz}{check}', '', '- It answers', '- It uses tools {right}', '- Not sure', '',
    '### What AI tools do you already use?', '{poll=multiple}{id=pwtools}{noask}', '', '- ChatGPT', '- Copilot', '',
    '### Task 1: draft one real email with Copilot', '{id=pwtask1}{task}{minutes=20}', '', '- Pick an email', '',
    '## Your turn', '{id=turn}', '',
    '### What AI tools do you already use?', '{id=r1tools}{results=pwtools}', '', '- The room adds to them', '',
    '### A plain talk slide', '{id=plain}', '', '- Nothing to do with pre-work', ''
  ].join('\n')
  const model = await prepareSource(`/tmp/prework-inspector-${++compileProbe}.md`, outline, 'Pre-work')
  const rows = buildPerSlideProjections(model, 'prework')
  const findings = layoutDoctor.scanOutlineTriggers(outline)
  assert.deepEqual(findings, [], 'the Layout Doctor finds nothing wrong with any pre-work token')
  const definition = preworkFromOutline(outline)
  const inspect = (slideId) => {
    const index = rows.findIndex((row) => row.slide_id === slideId)
    const headingLine = headingLineForSlideId(outline, slideId)
    const block = extractInspectorSlideBlock(outline, headingLine)
    const triggerLine = block.split('\n')[1]
    const level = block.match(/^(#+)/)[1].length
    const prework = inspectorPreworkModel(outline, headingLine, triggerLine, definition)
    return { prework, inspector: inspectorModel(rows, index, level, triggerLine, LAYOUTS, block, level === 2, findings, '', '', prework) }
  }
  const sectionOf = (inspector) => inspector.sections.find((section) => section.id === 'prework')
  const keysOf = (section) => section.bindings.map((binding) => binding.group.key)

  // E1: a slide with instructions — this step, questions on or off, the form.
  let { inspector, prework } = inspect('pwwelcome')
  assert.equal(inspector.unresolved, false, 'a pre-work step never blanks the Inspector')
  assert.equal(prework.mode, 'step')
  assert.equal(prework.thisSlide, 'Step 1 of 4: a slide with instructions. Participants read it on the pre-work page. It is not presented in the talk.')
  let section = sectionOf(inspector)
  assert.deepEqual([section.chip, section.heading], ['Pre-work', 'Before the session'], 'E1/P5: the chip says Pre-work, the section Before the session')
  assert.equal(inspector.sections.at(-1).id, 'prework', 'round 3 P5: the section comes last')
  assert.deepEqual(keysOf(section), ['prework-ask'], 'a slide step offers Questions about it')
  assert.equal(section.bindings[0].selectedToken, '', 'questions are on by default')
  assert.deepEqual(inspector.prework.definition.steps.map((step) => step.kind), ['slide', 'check', 'question', 'task'], 'the form’s steps')

  // E2: the quick check — right answer only Dominik sees.
  ;({ inspector, prework } = inspect('pwquiz'))
  section = sectionOf(inspector)
  assert.deepEqual([section.chip, section.heading], ['Check', 'Quick check'])
  assert.deepEqual(prework.step.options, ['It answers', 'It uses tools', 'Not sure'])
  assert.deepEqual(prework.step.right, { index: 1, label: 'It uses tools' })
  assert.ok(inspector.sections.some((candidate) => candidate.id === 'poll'), 'the check is still a poll (Poll section kept)')

  // A question with questions off.
  ;({ inspector } = inspect('pwtools'))
  section = sectionOf(inspector)
  assert.deepEqual(keysOf(section), ['prework-ask'])
  assert.equal(section.bindings[0].selectedToken, 'noask', '{noask} lights Off')

  // E3: a pre-task — Mark as done or read only, time it takes, questions.
  ;({ inspector, prework } = inspect('pwtask1'))
  section = sectionOf(inspector)
  assert.deepEqual([section.chip, section.heading], ['Pre-task', 'Pre-task'])
  assert.deepEqual(keysOf(section), ['prework-participants', 'prework-minutes', 'prework-ask'], 'E3’s rows, in its order')
  assert.deepEqual(section.bindings.map((binding) => binding.selectedToken), ['', 'minutes=20', ''], 'E3: a bare {task} lights Mark as done')
  // Writing them goes through the ordinary option path; defaults write nothing.
  const groupOf = (key) => section.bindings.find((binding) => binding.group.key === key).group
  const taskLine = '{id=pwtask1}{task}'
  assert.equal(commitOptionSelection(taskLine, groupOf('prework-participants'), 'readonly'), '{id=pwtask1}{task}{readonly}', 'Read only goes after {task}')
  assert.equal(commitOptionSelection('{id=pwtask1}{task}{readonly}', groupOf('prework-participants'), ''), '{id=pwtask1}{task}', 'Mark as done writes no token')
  assert.equal(commitOptionSelection('{id=pwtask1}{task}{readonly}', groupOf('prework-minutes'), 'minutes=30'), '{id=pwtask1}{task}{readonly}{minutes=30}')
  assert.equal(commitOptionSelection('{id=pwtask1}{task}{minutes=30}', groupOf('prework-minutes'), ''), '{id=pwtask1}{task}', '10 minutes is the default')
  assert.equal(commitOptionSelection(taskLine, groupOf('prework-ask'), 'noask'), '{id=pwtask1}{task}{noask}')

  // The section itself: its introduction and the form, no step rows.
  ;({ inspector, prework } = inspect('pwform'))
  assert.equal(prework.mode, 'section')
  section = sectionOf(inspector)
  assert.deepEqual(keysOf(section), [], 'the section slide has no step rows')
  assert.equal(section.heading, 'Before the session')

  // E4: a talk slide showing a step's answers.
  ;({ inspector, prework } = inspect('r1tools'))
  assert.equal(inspector.unresolved, false, 'a {results=…} slide never blanks the Inspector')
  section = sectionOf(inspector)
  assert.deepEqual([section.chip, section.heading], ['Results', 'Answers from pre-work'])
  assert.deepEqual(keysOf(section), [], 'a talk slide gets no step rows')
  assert.equal(prework.results.step.id, 'pwtools')
  assert.deepEqual(prework.results.group.values.map((value) => [value.token, value.label]), [
    ['results=pwquiz', 'Before the session › 2 · Quick check: what makes something an agent?'],
    ['results=pwtools', 'Before the session › 3 · What AI tools do you already use?'],
    ['results=pwtask1', 'Before the session › 4 · Task 1: draft one real email with Copilot']
  ], 'Shows offers every step whose answers a slide can show')
  assert.equal(commitOptionSelection('{id=r1tools}{results=pwtools}', prework.results.group, 'results=pwquiz'), '{id=r1tools} {results=pwquiz}', 'choosing another step replaces the token')
  const unknown = resultsGroup(definition, 'gone')
  assert.equal(commitOptionSelection('{id=x}{results=gone}', unknown, 'results=pwtask1'), '{id=x} {results=pwtask1}', 'a token naming no step is replaced too')

  // Any other slide: no section, no pre-work rows.
  ;({ inspector, prework } = inspect('plain'))
  assert.equal(prework, null)
  assert.equal(sectionOf(inspector), undefined, 'a plain talk slide has no Before the session section')
  assert.equal(optionGroupsForSlide({ layoutName: 'list', headingLevel: 3, hasChildren: false }).some(({ group }) => group.key.startsWith('prework-')), false,
    'a surface that did not read the pre-work section is offered no pre-work row')

  // The form's Run (E1, P5): the next Run's window, a Run without one, or the nudge.
  assert.deepEqual(preworkRunLine(null), { kind: 'no-run' }, 'P5: no planned Run')
  assert.deepEqual(preworkRunLine({ id: 'r1', talkSlug: 't', eventTitle: 'ITSS Briefing', plannedDate: '2026-10-06', startTime: '10:00', preworkOpens: '2026-09-29T09:00' }),
    { kind: 'window', runId: 'r1', opens: 'Tue 29 Sep, 09:00', closes: 'Tue 6 Oct, 10:00', run: 'ITSS Briefing, 6 Oct', closesAtStart: true })
  assert.deepEqual(preworkRunLine({ id: 'r2', talkSlug: 't', eventTitle: 'Later', plannedDate: '2026-11-01' }), { kind: 'no-window', runId: 'r2', run: 'Later, 1 Nov' })
  console.log('PASS prework: every pre-work token resolves; the Before the session section shows each step kind, the section and a results slide')
}

// ── Ticket 13: the Page width group is offered only beside an embedded page with body text ──
{
  const pageGroupOf = (source, trigger) => inspectorModel([{ layout: 'list', source_markdown: source }], 0, 3, trigger, LAYOUTS, source)
    .sections.flatMap((section) => section.bindings).find((binding) => binding.group.key === 'page-width')
  const withText = '### Page\n\n- Words beside the page\n\n[Embed: page.html]\n'
  const binding = pageGroupOf(withText, '')
  assert.ok(binding, 'a slide with an embedded page and body text offers Page width')
  assert.deepEqual(binding.values.map((value) => value.label), ['60%', '70%', '80%'])
  assert.equal(binding.selectedToken, '', 'nothing stored lights 70%')
  assert.equal(pageGroupOf(withText, '{page-80}').selectedToken, 'page-80', 'a stored page-80 lights 80%')
  assert.equal(pageGroupOf(withText, '{page-70}').selectedToken, '', 'page-70 is the default and lights 70%')
  assert.equal(pageGroupOf('### Page\n\n[Simulation: page.html]\n', ''), undefined, 'a page with no body text: not offered')
  assert.equal(pageGroupOf('### Words\n\n- Only words\n', ''), undefined, 'body text with no page: not offered')
  // The group is offered exactly when the compiler makes a local-page-beside-text composition.
  assert.ok(pageGroupOf('### Page\n\n- Words\n\n[Simulation: sim.html]\n', ''), 'local simulation + text: offered')
  assert.equal(pageGroupOf('### Page\n\n- Words\n\n[Embed: https://example.com/a]\n', ''), undefined, 'remote embed + text: not offered (the width CSS is for local pages)')
  assert.equal(pageGroupOf('### Page\n\n[Embed: page.html]\n\n![A picture](pic.png)\n', ''), undefined, 'local page + picture, no body text: not offered')
  assert.equal(pageGroupOf('### Page\n\n- Words\n\n![A picture](pic.png)\n', ''), undefined, 'picture + text: not offered')
  assert.equal(pageGroupOf('### Page\n{id=a}{page-80}\n\n[Embed: page.html]\n', ''), undefined, 'title + page + adjacent trigger groups on one line: not offered')
  assert.equal(pageGroupOf('### Page\n{id=a}\n\n[Embed: page.html]\n', ''), undefined, 'title + page + one trigger group: not offered')
  assert.ok(pageGroupOf('### Page\n{id=a}{page-80}\n\n- Words\n\n[Embed: page.html]\n', ''), 'adjacent groups plus body text and a local page: offered')
  console.log('PASS page width: offered on embed + body text only; 60/70/80 with 70 the unwritten default')
}

console.log('inspector model: pane migration, navigation, applicable groups and step derivation pass')

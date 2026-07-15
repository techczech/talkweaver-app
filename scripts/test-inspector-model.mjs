import { strict as assert } from 'node:assert'
import { LAYOUTS } from '../src/shared/layout-registry/entries.ts'
import { optionGroupsForSlide } from '../src/shared/layout-registry/options.ts'
import * as inspectorModule from '../src/renderer/src/components/inspectorModel.ts'
import {
  inspectorModel,
  extractInspectorSlideBlock,
  migrateInspectorMode,
  migratePaneState,
  navigateInspectorSlide,
  resolveInspectedSlide,
  headingLineForSlideId,
  stepModelForSlide
} from '../src/renderer/src/components/inspectorModel.ts'

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
assert.notEqual(thumbnailDocumentCacheKey('deck-a', 'slide-key'), thumbnailDocumentCacheKey('deck-b', 'slide-key'), 'thumbnail cache identity includes the full compiled document')

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

console.log('inspector model: pane migration, navigation, applicable groups and step derivation pass')

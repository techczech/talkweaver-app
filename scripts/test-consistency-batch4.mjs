// test:consistency-batch4 — house rules R7, R8, R11 and R16 (consistency review batch 4), the parts that need no window:
//   - the Talk tab is next to Slide in the right sidebar, and Talk design… / Metadata… keep their command ids (aliases that open it);
//   - the Slide outline's section numbers (§n) and layout marks come from the margin's labels and the compiled rows, the strip's own text;
//   - the Markdown gutter numbers the title slide on the `# ` heading when the file opens with front matter;
//   - the presenter's counters are slide numbers out of the slides, not beat positions (the 43-vs-45 defect);
//   - Recent starts collapsed; every workspace mode draws the one shared back control and none keeps its old route.
// The real app is checked by e2e/diagnose-consistency-batch4.mjs.
import { readPresenterTemplate } from '../compiler/scripts/lib/presenter-template.mjs'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { rightColumnTabs } from '../src/shared/guide.ts'
import { COMMAND_REGISTRY } from '../src/shared/command-registry.ts'
import { outlineMarksToPublish, outlineNumbers } from '../src/renderer/src/lib/stripNumbers.ts'
import { titleHeadingLine } from '../src/shared/slide-lines.ts'
import { marginWord } from '../src/shared/plain-view-margin.ts'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

// R11: the tab and the aliases.
assert.deepEqual(rightColumnTabs({ guideUp: false, hasTalk: true }), ['inspector', 'talk', 'guide', 'research'], 'Talk is beside Slide')
for (const id of ['deck-design', 'metadata']) {
  const command = COMMAND_REGISTRY.find((c) => c.id === id)
  assert.ok(command, `${id} is still a command`)
  assert.equal(command.handlerId, id)
}
const layout = read('src/renderer/src/components/WorkspaceLayout.tsx')
assert.match(layout, /'deck-design': \(\) => openTalkTab\('design'\)/, 'deck-design opens the Talk tab on Design')
assert.match(layout, /metadata: \(\) => openTalkTab\(\)/, 'metadata opens the Talk tab')
assert.ok(!/setDeckDesignOpen|deckDesignOpen/.test(layout), 'the Talk design dialog is gone')
assert.ok(!/MetadataPanel/.test(read('src/renderer/src/App.tsx')), 'the Metadata dialog is gone')
for (const file of ['DeckDesignPanel', 'MetadataPanel']) assert.ok(!/role="dialog"|backdrop: \{/.test(read(`src/renderer/src/components/${file}.tsx`).replace(/^\s*backdrop:.*$/m, '')), `${file} draws no dialog`)

// R7: section numbers and layout marks.
const labels = [{ line: 1, kind: 'talk' }, { line: 5, kind: 'section', sectionNumber: '1' }, { line: 7, kind: 'slide' }, { line: 12, kind: 'section', sectionNumber: '2' }, { line: 14, kind: 'section', sectionNumber: '2.1' }]
const marks = outlineMarksToPublish(labels, [1, 5, 7, 12, 14], ['title', 'section-title', 'list', 'section-title', 'default'])
assert.deepEqual(marks.get(5), { sectionNumber: '1', layout: 'section-title' }, 'a section carries its number and its layout')
assert.deepEqual(marks.get(7), { layout: 'list' }, 'a slide carries its layout')
assert.deepEqual(marks.get(12), { sectionNumber: '2', layout: 'section-title' })
assert.deepEqual(marks.get(14), { sectionNumber: '2.1' }, 'the default layout is not marked, as on the strip')
assert.deepEqual(marks.get(1), { layout: 'title' }, 'the cover (file line 1) carries the title layout')
// The outline's numbers are the strip's: the title and every section count.
assert.deepEqual([...outlineNumbers([{ line: 3, level: 1 }, { line: 5, level: 2 }, { line: 7, level: 3 }], new Map([[1, 1], [5, 2], [7, 3]])).values()], [1, 2, 3])

// The Markdown gutter: the cover's number belongs on the title heading.
const docOf = (text) => { const lines = text.split('\n'); return { lines: lines.length, line: (n) => ({ text: lines[n - 1] }) } }
assert.equal(titleHeadingLine(docOf('---\ntitle: T\n---\n# T\n\n## S\n')), 4)
assert.equal(titleHeadingLine(docOf('# T\n\n## S\n')), 1)
assert.equal(titleHeadingLine(docOf('---\ntitle: T\n# comment in the front matter\n---\n## S\n')), null, 'a heading that is not the title is not the title')

// The presenter: the counters are slide numbers.
const presenter = readPresenterTemplate()
assert.ok(!/presenterCount\.textContent = `[^`]*beats\.length/.test(presenter), 'the presenter counter does not count beats')
assert.ok(!/slideCount\.textContent = `[^`]*beats\.length/.test(presenter), 'the audience counter does not count beats')
assert.match(presenter, /presenterCount\.textContent = `\$\{slideNumberOfBeat\(state\.beat\)\} \/ \$\{slides\.length\}`/)
assert.match(presenter, /function slideNumberOfBeat\(beatIndex\) \{\s*return slideIndexForBeat\(beatIndex\) \+ 1;/)

// R7: the margin says §n, as the outline does.
assert.equal(marginWord({ kind: 'section', sectionNumber: '2.1' }), '§2.1')

// R8: Recent starts collapsed.
assert.match(read('src/renderer/src/components/talklist/TalkList.tsx'), /localStorage\.getItem\('tw-recent-shown'\) === '1'/, 'Recent starts collapsed')

// R16: one shared back control in every mode, and the old routes are gone.
const gallery = read('src/renderer/src/components/vault-gallery/VaultGallery.tsx')
assert.match(gallery, /<ModeBack /); assert.ok(!/Return to talk/.test(gallery + read('src/renderer/src/components/vault-gallery/galleryItems.ts')))
const focus = read('src/renderer/src/components/SlideFocus.tsx')
assert.match(focus, /<ModeBack talkTitle=\{talk\.title\}/); assert.ok(!/Back to where you came from/.test(focus), 'Slide focus keeps no second back route')
assert.match(read('src/renderer/src/components/PathwaysView.tsx'), /<ModeBack talkTitle=\{talk\.title\}/)
assert.match(read('src/renderer/src/components/slide-browser/TopBar.tsx'), /<ModeBack /)

console.log('consistency batch 4 (R7, R8, R11, R16): ok')

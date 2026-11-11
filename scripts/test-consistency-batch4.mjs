// test:consistency-batch4 — house rules R7, R8, R11 and R16 (consistency review batch 4), the parts that need no window:
//   - the Talk tab is the third tab of the right sidebar, and Talk design… / Metadata… keep their command ids (aliases that open it);
//   - the Slide outline's section numbers (§n) and layout marks come from the margin's labels and the compiled rows, the strip's own text;
//   - the Markdown gutter numbers the title slide on the `# ` heading when the file opens with front matter;
//   - the presenter's counters are slide numbers out of the slides, not beat positions (the 43-vs-45 defect);
//   - Recent starts collapsed; every workspace mode draws the one shared back control and none keeps its old route.
// The real app is checked by e2e/diagnose-consistency-batch4.mjs.
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { rightColumnTabs } from '../src/shared/guide.ts'
import { COMMAND_REGISTRY } from '../src/shared/command-registry.ts'
import { outlineMarksToPublish, outlineNumbers } from '../src/renderer/src/lib/stripNumbers.ts'
import { titleHeadingLine } from '../src/shared/slide-lines.ts'
import { clearDrafts, discardedNotice, keepDraft, restoreDraft, setStoredNotice, storedNotice } from '../src/renderer/src/lib/talkDrafts.ts'
import { marginWord } from '../src/shared/plain-view-margin.ts'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

// R11: the tab and the aliases.
assert.deepEqual(rightColumnTabs({ guideUp: false, hasTalk: true }), ['inspector', 'slides', 'talk', 'research', 'images'], 'Talk is beside Inspector and Strip')
for (const id of ['deck-design', 'metadata']) {
  const command = COMMAND_REGISTRY.find((c) => c.id === id)
  assert.ok(command, `${id} is still a command`)
  assert.equal(command.handlerId, id)
}
const layout = read('src/renderer/src/components/WorkspaceLayout.tsx')
assert.match(layout, /'deck-design': \(\) => openTalkTab\(\)/, 'deck-design opens the Talk tab')
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
const presenter = read('compiler/assets/templates/presenter-popup-single-html.html')
assert.ok(!/presenterCount\.textContent = `[^`]*beats\.length/.test(presenter), 'the presenter counter does not count beats')
assert.ok(!/slideCount\.textContent = `[^`]*beats\.length/.test(presenter), 'the audience counter does not count beats')
assert.match(presenter, /presenterCount\.textContent = `\$\{slideNumberOfBeat\(state\.beat\)\} \/ \$\{slides\.length\}`/)
assert.match(presenter, /function slideNumberOfBeat\(beatIndex\) \{\s*return slideIndexForBeat\(beatIndex\) \+ 1;/)

// R11: unsaved Talk tab edits survive the tab or disclosure going away, per talk, and only the edited fields.
const here = { title: true, event: true }
clearDrafts('/a.md') // the workspace names the open talk
keepDraft('design', '/a.md', { title: 'New', event: 'E' }, { title: 'Old', event: 'E' }, here)
assert.deepEqual(restoreDraft('design', '/a.md', { title: 'Old', event: 'E2' }, here), { draft: { title: 'New', event: 'E2' }, discarded: [] }, 'the edited field is restored; a field left alone follows the text')
assert.deepEqual(restoreDraft('advanced', '/a.md', { title: 'Old' }, here).draft, { title: 'Old' }, 'the Advanced part keeps its own')
// never restored over a changed baseline, and only the changed field is dropped
keepDraft('design', '/a.md', { title: 'B', event: 'Ev' }, { title: 'Old', event: '' }, here)
assert.deepEqual(restoreDraft('design', '/a.md', { title: 'C', event: '' }, here), { draft: { title: 'C', event: 'Ev' }, discarded: ['title'] }, 'Title dropped and reported, Event stays')
// absent is not the same as written empty
keepDraft('design', '/a.md', { title: 'B' }, { title: '' }, { title: false })
assert.deepEqual(restoreDraft('design', '/a.md', { title: '' }, { title: true }), { draft: { title: '' }, discarded: ['title'] }, 'title: "" added while away discards the draft')
assert.deepEqual(restoreDraft('design', '/a.md', { title: '' }, { title: false }).draft, { title: 'B' }, 'still absent: the draft is kept')
assert.equal(discardedNotice(['Title']), 'Your unsaved change to Title was discarded because the talk changed.')
assert.equal(discardedNotice(['Title', 'Event']), 'Your unsaved changes to Title and Event were discarded because the talk changed.')
keepDraft('design', '/a.md', { title: 'Old' }, { title: 'Old' }, here)
assert.deepEqual(restoreDraft('design', '/a.md', { title: 'Old' }, here).draft, { title: 'Old' }, 'a saved or reverted field is forgotten')
// one talk only: another path never sees it, and clearing (open talk changed, renamed, moved, deleted) empties it
keepDraft('design', '/a.md', { title: 'New' }, { title: 'Old' }, here)
assert.deepEqual(restoreDraft('design', '/b.md', { title: 'Old' }, here).draft, { title: 'Old' }, 'another talk gets none of it')
clearDrafts('/b.md') // the workspace does this when another talk opens
keepDraft('design', '/b.md', { title: 'Old' }, { title: 'Old' }, here)
assert.deepEqual(restoreDraft('design', '/a.md', { title: 'Old' }, here).draft, { title: 'Old' }, 'opening another talk dropped the first talk\'s draft')
clearDrafts('/a.md')
// the notice is kept beside the drafts, per panel, until cleared or the talk changes
setStoredNotice('design', '/a.md', 'N')
keepDraft('design', '/a.md', { title: 'Old' }, { title: 'Old' }, here)
assert.equal(storedNotice('design', '/a.md'), 'N', 'the notice outlives the drafts being emptied')
assert.equal(storedNotice('advanced', '/a.md'), '', 'each panel has its own')
setStoredNotice('design', '/a.md', '')
assert.equal(storedNotice('design', '/a.md'), '', 'dismissed')
setStoredNotice('design', '/a.md', 'N')
assert.equal(storedNotice('design', '/b.md'), '', 'not in another talk')
clearDrafts('/b.md') // the open talk's path changed (b is now open)
assert.equal(storedNotice('design', '/a.md'), '', 'a path change drops it')
// a stale caller (talk A's save resolving after talk B was opened and edited) never touches B's entry
keepDraft('advanced', '/b.md', { event: 'Bev' }, { event: '' }, here)
setStoredNotice('design', '/b.md', 'B notice')
setStoredNotice('advanced', '/a.md', '')
keepDraft('advanced', '/a.md', {}, {}, {})
keepDraft('design', '/a.md', { title: 'A late' }, { title: 'A' }, here)
assert.deepEqual(restoreDraft('advanced', '/b.md', { event: '' }, here).draft, { event: 'Bev' }, 'B keeps its draft')
assert.equal(storedNotice('design', '/b.md'), 'B notice', 'B keeps its notice')
assert.deepEqual(restoreDraft('design', '/a.md', { title: 'A' }, here).draft, { title: 'A' }, 'the stale call kept nothing for A')
// a stale caller cannot claim a freshly reset store: B opened, then A's late save arrives before B's text has loaded
clearDrafts('/b.md')
setStoredNotice('advanced', '/a.md', '')
keepDraft('advanced', '/a.md', {}, {}, {})
keepDraft('design', '/b.md', { title: 'Bnew' }, { title: 'B' }, here)
assert.deepEqual(restoreDraft('design', '/b.md', { title: 'B' }, here).draft, { title: 'Bnew' }, 'B still keeps its edit after the stale call')
clearDrafts('/a.md')
keepDraft('design', '/a.md', { title: 'New' }, { title: 'Old' }, here)
setStoredNotice('design', '/a.md', 'N')
clearDrafts(null)
assert.deepEqual(restoreDraft('design', '/a.md', { title: 'Old' }, here).draft, { title: 'Old' }, 'clearing forgets it')
assert.equal(storedNotice('design', '/a.md'), '', 'clearing forgets the notice')
assert.match(read('src/renderer/src/components/WorkspaceLayout.tsx'), /useEffect\(\(\) => \{ clearDrafts\(activeTalk\?\.outlinePath \?\? null\) \}, \[activeTalk\?\.outlinePath\]\)/, 'the workspace clears drafts when the open talk or its path changes')
assert.ok(!/talkDrafts/.test(read('src/renderer/src/components/talklist/actions.ts')), 'no per-operation draft plumbing')
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

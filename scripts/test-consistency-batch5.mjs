// test:consistency-batch5 — house rules R5, R6, R16 (consistency review batch 5), the parts that need no window:
//   - a layout mark shows the name the layout picker shows ("Statement + list", "Section divider"), never the id;
//   - a Run has one title and one date in Studio's recorded Runs and in the Runs view;
//   - no Run text calls a Run a "session" (Run checklist, planned-Run checks, work strips, Published pages);
//   - the Slide Scratchpad has one name; the Talk tab has no "Setting names" button and no id / managed-key wording.
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { layoutDisplayName } from '../src/shared/layout-registry/options.ts'
import { runTitleAndWhen } from '../src/shared/sessions-list.ts'
import { METADATA_REGISTRY } from '../src/shared/metadata-registry.ts'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

// R6: the layout's human name.
assert.equal(layoutDisplayName('stmt-list'), 'Statement + list')
assert.equal(layoutDisplayName('section-title'), 'Section divider', 'the compiled role slug reads as the divider')
assert.equal(layoutDisplayName('copy-visual'), 'Copy + visual')
assert.equal(layoutDisplayName('smartart'), 'SmartArt')
assert.equal(layoutDisplayName('list-visual'), 'List + media')
assert.equal(layoutDisplayName('made-up-layout'), 'made-up-layout', 'an unknown name is shown as written')
assert.equal(layoutDisplayName(''), '')
for (const file of ['SlidesOrganizer', 'SlideStrip', 'slide-browser/SlideCard', 'browser-rail/FilterGroups', 'SearchPalette']) {
  assert.match(read(`src/renderer/src/components/${file}.tsx`), /layoutDisplayName/, `${file} shows the layout's name`)
}

// R5: one Run, one title and one date, wherever it is listed.
const run = { talkTitle: 'TalkWeaver **Pre-work Workshop**', eventTitle: 'Digital Education Day', startedAt: '2026-11-06T14:00:00.000Z', timeZone: 'UTC' }
assert.deepEqual(runTitleAndWhen(run), { name: 'Digital Education Day', when: 'Fri 6 Nov · 14:00' })
assert.equal(runTitleAndWhen({ ...run, eventTitle: undefined }).name, 'TalkWeaver Pre-work Workshop', 'no event title: the talk title, as plain text')
assert.equal(runTitleAndWhen({ ...run, plannedDate: '2026-11-15' }).when, 'Sun 15 Nov')
const studio = read('src/renderer/src/components/Studio.tsx')
assert.match(studio, /runTitleAndWhen\(s\)\.name/)
assert.match(studio, /Sort Runs/)
assert.ok(!/Sort talks/.test(studio))

// R5: no "session" for a Run in what a person reads.
for (const key of ['prework', 'postwork']) {
  const entry = METADATA_REGISTRY.find((e) => e.key === key)
  assert.ok(!/session|by its id|strip under/i.test(entry.explanation), `${key}: ${entry.explanation}`)
}
for (const file of ['src/shared/run-checklist.ts', 'src/shared/plan-run.ts', 'src/shared/work-strips.ts', 'src/shared/published-pages.ts', 'src/renderer/src/components/PlanRunSheet.tsx', 'src/renderer/src/components/RunAnswers.tsx']) {
  const text = read(file).split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n')
  assert.ok(!/\b(the|each) session\b/i.test(text), `${file} still calls a Run a session`)
}

// R6: the Talk tab.
const design = read('src/renderer/src/components/DeckDesignPanel.tsx')
assert.ok(!/Setting names/.test(design), 'the unexplained Setting names button is gone')
const meta = read('src/renderer/src/components/MetadataPanel.tsx')
assert.ok(!/managed key/.test(meta), 'Advanced counts are behind Details, in plain words')
assert.match(meta, /\(dirty \|\| saving \|\| savedFlash\) && footerEl/, 'Advanced shows its own Save only while it has something to save')

// The one name of the Slide Scratchpad (CONTEXT.md).
for (const file of ['src/renderer/src/components/SlideRowMenus.tsx', 'src/renderer/src/components/slide-handling/BatchBar.tsx', 'src/shared/command-registry.ts', 'src/shared/shortcut-registry.ts', 'src/renderer/src/components/scratchpad/ScratchpadPanel.tsx']) {
  const text = read(file).split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line) && !/^\s*import /.test(line)).join('\n')
  assert.ok(!/(?<!Slide )(?<![A-Za-z])Scratchpad(?![A-Za-z])/.test(text), `${file} says "Scratchpad" without "Slide"`)
}

// Manage notes: the back control says where it goes (Studio), Esc does the same, and the subtitle names the Run as Runs does.
const notes = read('src/renderer/src/components/TalkText.tsx')
assert.match(notes, /<ModeBack className="tt-back" talkTitle="Studio" onBack=\{\(\) => onBackToStudio\(active\?\.id\)\}/)
assert.match(notes, /else onBackToStudio\(active\?\.id\)\n\s+return/, 'Esc goes back to Studio')
assert.match(read('src/main/talkTextIpc.ts'), /runTitleAndWhen\(run\)\.name/)

console.log('consistency batch 5: layout names, one Run title and date, no "session" for a Run, one Slide Scratchpad name, a plain Talk tab')

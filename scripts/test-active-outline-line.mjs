// Which row of the Slide outline is marked as holding the editor's caret, and where the outline's
// own marks (selection, keyboard highlight) go after the text changed: the pure rules of
// src/renderer/src/lib/activeOutlineLine.ts (imported directly), and that WorkspaceLayout and
// SlidesOrganizer use them. Fix round after 0.38.3-preview.10: after "Move slide to…" two rows of the
// outline looked selected. The outline mounted with an editor is scripts/test-slide-move-to-dom.mjs.
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  activeHeadingLine, createActiveLineReporter, lineOfOffset, rowAfterEdit, slideIndexAtLine
} from '../src/renderer/src/lib/activeOutlineLine.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0
const pass = (name) => { passed += 1; console.log(`PASS ${name}`) }

// ── The slide holding a line ──
{
  const lines = [3, 10, null, 20, 31]
  assert.equal(slideIndexAtLine(lines, 1), -1, 'above the first slide')
  assert.equal(slideIndexAtLine(lines, 3), 0)
  assert.equal(slideIndexAtLine(lines, 19), 1, 'a slide with no known line is skipped')
  assert.equal(slideIndexAtLine(lines, 20), 3)
  assert.equal(slideIndexAtLine(lines, 999), 4)
  assert.equal(activeHeadingLine(lines, 25), 20)
  assert.equal(activeHeadingLine(lines, 2), null)
  assert.equal(activeHeadingLine(lines, null), null)
  assert.equal(lineOfOffset('a\nbb\nccc', 0), 1)
  assert.equal(lineOfOffset('a\nbb\nccc', 2), 2)
  assert.equal(lineOfOffset('a\nbb\nccc', 5), 3)
  assert.equal(lineOfOffset('a\nbb\nccc', 999), 3)
  pass('the slide holding a line is the one whose title line is the last at or before it')
}

// ── The outline is told by LINE, and again when the slides are known anew ──
{
  const told = []
  const reporter = createActiveLineReporter(() => (line) => told.push(line))
  reporter.report(10)
  reporter.report(10)
  assert.deepEqual(told, [10], 'the same line is told once (typing inside a slide tells nothing)')
  // A move: before it the slides' title lines were [3, 10, 20, 31] and the caret was in the slide at
  // index 1. The slide at index 1 moves to the end. The caret goes with it (line 24 of the new text).
  const before = [3, 10, 20, 31]
  const after = [3, 13, 24, 31] // what was 20 is 13, what was 31 is 24, the moved slide's title is on 31
  // The jump lands while the slides are still the old ones: the caret (line 31) maps to the old row.
  reporter.report(activeHeadingLine(before, 31))
  assert.equal(told.at(-1), 31)
  // Same line, as it happens. Now a move where the old answer is wrong: caret on line 24.
  reporter.report(activeHeadingLine(before, 24))
  assert.equal(told.at(-1), 20, 'against the old slides, line 24 is in the slide titled on line 20: a line that is no title now')
  // The slides arrive. The caret has not moved and the slide INDEX under it (2) is the same as before
  // the slides arrived, which is why the rule "tell when the index changes" told nothing here.
  assert.equal(slideIndexAtLine(before, 24), slideIndexAtLine(after, 24), 'the index did not change')
  reporter.report(activeHeadingLine(after, 24))
  assert.equal(told.at(-1), 24, 'told again, by line, when the slides are known')
  // A listener attached later is told even if the line is the one last told.
  reporter.forget()
  reporter.report(24)
  assert.deepEqual(told.slice(-2), [24, 24])
  // No listener: nothing is remembered as told.
  let listener
  const late = createActiveLineReporter(() => listener)
  late.report(5)
  const heard = []
  listener = (line) => heard.push(line)
  late.report(5)
  assert.deepEqual(heard, [5])
  pass('the caret marker is told by line, once per line, and again when the slides change under an unmoved caret')
}

// ── A mark of the outline after an edit ──
{
  const rows = (pairs) => pairs.map(([line, text]) => ({ line, text }))
  const was = rows([[3, 'A'], [10, 'B'], [17, 'C'], [24, 'D']])
  assert.equal(rowAfterEdit(was, 10, 'B', true), 10, 'still there')
  // B moved to the end; C is on B's old line. The mark goes with B.
  const moved = rows([[3, 'A'], [10, 'C'], [17, 'D'], [24, 'B']])
  assert.equal(rowAfterEdit(moved, 10, 'B', true), 24, 'the mark follows the slide, not the line number')
  // Lines typed above: every row is lower.
  assert.equal(rowAfterEdit(rows([[5, 'A'], [12, 'B'], [19, 'C'], [26, 'D']]), 10, 'B', true), 12)
  // Retitled where it stands (the same number of rows): the mark stays.
  assert.equal(rowAfterEdit(rows([[3, 'A'], [10, 'B2'], [17, 'C'], [24, 'D']]), 10, 'B', true), 10)
  // Cut: C is on its line now, and there is one row fewer. No mark.
  assert.equal(rowAfterEdit(rows([[3, 'A'], [10, 'C'], [17, 'D']]), 10, 'B', false), null, 'a cut slide leaves no mark on its neighbour')
  assert.equal(rowAfterEdit(was, null, 'B', true), null)
  assert.equal(rowAfterEdit(was, 10, null, true), 10)
  assert.equal(rowAfterEdit(was, 11, null, true), null)
  pass('a selected or highlighted row is followed by its title after an edit, kept when retitled, dropped when cut')
}

// ── The app uses the rules ──
{
  const layout = readFileSync(join(root, 'src/renderer/src/components/WorkspaceLayout.tsx'), 'utf8')
  assert.ok(!/Only notify the outline sidebar when the active SLIDE changes/.test(layout), 'the index-change gate is gone')
  assert.ok(!/onActiveLineChange\?\.\(/.test(layout), 'the outline is told through the reporter only')
  const effect = layout.match(/useEffect\(\(\) => \{\n\s+if \(!onActiveLineChange\) return\n[\s\S]{0,400}?\}, \[slideLines\]\)/)
  assert.ok(effect, 'WorkspaceLayout works the caret row out again when the slides change')
  assert.ok(effect[0].includes('activeLineReporter.report(activeHeadingLine(slideLines, line))'))
  const organizer = readFileSync(join(root, 'src/renderer/src/components/SlidesOrganizer.tsx'), 'utf8')
  assert.equal((organizer.match(/rowAfterEdit\(rows, /g) ?? []).length, 2, 'the selection and the keyboard highlight both follow their row')
  assert.ok(!/\}, \[selectedLine, rows\]\)/.test(organizer), 'the selected title is not re-read from the line number when the rows change')
  pass('WorkspaceLayout and the Slide outline use these rules')
}

console.log(`active outline line: ${passed} checks passed`)

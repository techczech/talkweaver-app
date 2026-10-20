// Work-files ticket 23: the sentence the talk's Publish dialog shows about work files (src/shared/publish-work-notice.ts).
//   pre only, post only, both (the ticket's exact sentence), neither (none); a file named by its file name; a name no file
//   answers to is said plainly; the 0.39 `true` switch names nothing; unreadable work files still give the notice.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-publish-work-notice.mjs
import assert from 'node:assert/strict'
import { publishWorkNotice } from '../src/shared/publish-work-notice.ts'
import { readTalkWorkNames } from '../src/shared/work-files-view.ts'

const files = [
  { id: 'research-teams-intake', fileName: 'research-teams-intake.md', title: 'Research teams intake' },
  { id: 'session-feedback', fileName: 'session-feedback.md', title: 'Session feedback' },
  { id: '', fileName: 'loose-notes.md', title: 'Loose notes' },
]

assert.equal(
  publishWorkNotice({ prework: 'research-teams-intake', postwork: 'session-feedback' }, files),
  'Pre-work and post-work are not included. The talk’s pre-work file, Research teams intake, and post-work file, Session feedback, go out with a run.'
)
assert.equal(publishWorkNotice({ prework: 'research-teams-intake' }, files), 'Pre-work is not included. The talk’s pre-work file, Research teams intake, goes out with a run.')
assert.equal(publishWorkNotice({ postwork: 'session-feedback' }, files), 'Post-work is not included. The talk’s post-work file, Session feedback, goes out with a run.')
assert.equal(publishWorkNotice({}, files), null)
assert.equal(publishWorkNotice({ prework: 'true' }, []), null, 'the 0.39 switch names no file')
assert.equal(publishWorkNotice({ prework: 'loose-notes.md' }, files), 'Pre-work is not included. The talk’s pre-work file, Loose notes, goes out with a run.')
assert.match(publishWorkNotice({ prework: 'gone' }, files), /pre-work file, gone \(no work file with this name was found\), goes out/)
assert.match(publishWorkNotice({ prework: 'gone' }, null), /gone \(no work file/)
// Read from the talk's front matter as the strips read it.
const outline = ['---', 'title: T', 'prework: "research-teams-intake" # intake', 'postwork: session-feedback.md', '---', '', '## A', ''].join('\n')
assert.match(publishWorkNotice(readTalkWorkNames(outline), files), /Research teams intake, and post-work file, Session feedback/)
assert.equal(publishWorkNotice(readTalkWorkNames('---\ntitle: T\n---\n\n## A\n'), files), null)

console.log('publish work notice: pre only, post only, both, neither; by title; unknown names said plainly passed')

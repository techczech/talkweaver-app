// test:object-removal — deleting an object takes exactly its own text (PR 395 review, 15 Nov 2026).
//
// planObjectRemoval (objectBlocks/remove.ts) for every kind of object, in every place: in the middle of
// a slide, first on a slide, last on a slide, last in the talk (with and without a line break at the
// end), next to another object. An object read from a trigger list takes its trigger token with it: the
// token's whole line when it stood alone, only the token when the line holds other tokens (the slide's
// id, other layout words). Each case is the talk before (the object to delete marked by `▶`, put in
// front of its first line), and the exact talk after. Undo is the editor's (one change: DOM test).
import { strict as assert } from 'node:assert'
import { detectObjectBlocks } from '../src/renderer/src/extensions/objectBlocks/detect.ts'
import { lineWithoutTriggerToken, planObjectRemoval } from '../src/renderer/src/extensions/objectBlocks/remove.ts'

const CHAT = '```chat\nUser: Hi\nAssistant: Hello\n```'
const PIPES = '| A | B |\n|---|---|\n| 1 | 2 |'
const LIST = '- A: 1\n- B: 2'

const cases = [
  // Fenced and line objects: their lines, and one blank line when one stood on each side.
  ['chat, middle of a slide', `## One\n\nIntro\n\n▶${CHAT}\n\nMore\n`, '## One\n\nIntro\n\nMore\n'],
  ['chat, first on the slide', `## One\n{id=s1}\n\n▶${CHAT}\n\nMore\n`, '## One\n{id=s1}\n\nMore\n'],
  ['chat, first on the slide, directly under the title', `## One\n▶${CHAT}\n\nMore\n`, '## One\n\nMore\n'],
  ['chat, last on the slide', `## One\n\nIntro\n\n▶${CHAT}\n\n## Two\n`, '## One\n\nIntro\n\n## Two\n'],
  ['chat, last on the slide, title directly after', `## One\n\nIntro\n\n▶${CHAT}\n## Two\n`, '## One\n\nIntro\n\n## Two\n'],
  ['chat, last in the talk, no line break', `## One\n\nIntro\n\n▶${CHAT}`, '## One\n\nIntro\n'],
  ['chat, last in the talk, a line break', `## One\n\nIntro\n\n▶${CHAT}\n`, '## One\n\nIntro\n'],
  ['chat, then a table directly after: the table stays', `## One\n\n▶${CHAT}\n${PIPES}\n\nMore\n`, `## One\n\n${PIPES}\n\nMore\n`],
  ['table, after a chat directly above: the chat stays', `## One\n\n${CHAT}\n▶${PIPES}\n\nMore\n`, `## One\n\n${CHAT}\n\nMore\n`],
  ['pipe table, middle', `## One\n\nIntro\n\n▶${PIPES}\n\nMore\n`, '## One\n\nIntro\n\nMore\n'],
  ['speaker notes, last on the slide', '## One\n\nIntro\n\n▶:::notes\nSay hello.\n:::\n\n## Two\n', '## One\n\nIntro\n\n## Two\n'],
  ['comment, middle', '## One\n\nIntro\n\n▶<!-- a private remark -->\n\nMore\n', '## One\n\nIntro\n\nMore\n'],
  ['web page, last in the talk', '## One\n\nIntro\n\n▶[Embed: https://example.com]\n', '## One\n\nIntro\n'],
  ['mermaid diagram, middle', '## One\n\nIntro\n\n▶```mermaid\ngraph LR\n  A --> B\n```\n\nMore\n', '## One\n\nIntro\n\nMore\n'],

  // Trigger lists: the token goes too.
  ['table list, its {table} on a line of its own, a blank line before the list',
    `## One\n\nIntro\n\n{table}\n\n▶${LIST}\n\nMore\n`, '## One\n\nIntro\n\nMore\n'],
  ['table list, its {table} directly above the list',
    `## One\n\nIntro\n\n{table}\n▶${LIST}\n\nMore\n`, '## One\n\nIntro\n\nMore\n'],
  ['table list, its {table} the slide\'s layout line under the title',
    `## One\n{table}\n\n▶${LIST}\n\n## Two\n`, '## One\n\n## Two\n'],
  ['table list, {table} shares the line with the slide\'s id: only the token goes',
    `## One\n{table id=s1}\n\n▶${LIST}\n\n## Two\n`, '## One\n{id=s1}\n\n## Two\n'],
  ['table list, the id first in the group',
    `## One\n{id=s1 table}\n\n▶${LIST}\n\n## Two\n`, '## One\n{id=s1}\n\n## Two\n'],
  ['table list, {table} a group of its own beside the id group',
    `## One\n{id=s1} {table}\n\n▶${LIST}\n\n## Two\n`, '## One\n{id=s1}\n\n## Two\n'],
  ['table list, {table} first of two groups',
    `## One\n{table} {id=s1}\n\n▶${LIST}\n\n## Two\n`, '## One\n{id=s1}\n\n## Two\n'],
  ['table list, last in the talk, no line break',
    `## One\n\nIntro\n\n{table}\n▶${LIST}`, '## One\n\nIntro\n'],
  ['table list, last in the talk, a line break',
    `## One\n\nIntro\n\n{table}\n▶${LIST}\n`, '## One\n\nIntro\n'],
  ['table list, last on the slide, title directly after',
    `## One\n\nIntro\n\n{table}\n▶${LIST}\n## Two\n`, '## One\n\nIntro\n\n## Two\n'],
  ['table list, then a chat directly after: the chat stays',
    `## One\n\n{table}\n▶${LIST}\n${CHAT}\n\nMore\n`, `## One\n\n${CHAT}\n\nMore\n`],
  ['table list after a chat: the chat stays',
    `## One\n\n${CHAT}\n\n{table}\n▶${LIST}\n\nMore\n`, `## One\n\n${CHAT}\n\nMore\n`],
  ['chart list, its {chart=bar} alone',
    `## One\n\nIntro\n\n{chart=bar}\n▶${LIST}\n\nMore\n`, '## One\n\nIntro\n\nMore\n'],
  ['mind map list, {mindmap} on the layout line with the id',
    '## One\n{mindmap id=s1}\n\n▶- Root\n  - Leaf\n\n## Two\n', '## One\n{id=s1}\n\n## Two\n'],
  ['a second table list on the slide: only its own {table} goes',
    `## One\n{table}\n\n${LIST}\n\n{table}\n▶- C: 3\n\nMore\n`, `## One\n{table}\n\n${LIST}\n\nMore\n`]
]

let failures = 0
for (const [name, marked, expected] of cases) {
  try {
    const at = marked.indexOf('▶')
    const text = marked.replace('▶', '')
    const block = detectObjectBlocks(text).find((candidate) => candidate.from === at)
    assert.ok(block, `an object starts at the mark: ${JSON.stringify(detectObjectBlocks(text).map((b) => [b.kind, b.from]))}`)
    const plan = planObjectRemoval(text, { from: block.from, to: block.to, source: block.source })
    assert.ok(plan.ok, plan.reason)
    let result = text
    for (const change of [...plan.changes].sort((a, b) => b.from - a.from)) {
      result = result.slice(0, change.from) + change.insert + result.slice(change.to)
    }
    assert.equal(result, expected)
    assert.ok(plan.caret >= 0 && plan.caret <= result.length, 'the caret is inside the text')
  } catch (error) {
    failures += 1
    console.error(`✗ ${name}\n  ${String(error.message).split('\n').join('\n  ')}`)
  }
}

// The token line on its own.
assert.equal(lineWithoutTriggerToken('{table}', 'table'), '')
assert.equal(lineWithoutTriggerToken('{table id=s1}', 'table'), '{id=s1}')
assert.equal(lineWithoutTriggerToken('{id=s1 table}', 'table'), '{id=s1}')
assert.equal(lineWithoutTriggerToken('{id=s1, table}', 'table'), '{id=s1}')
assert.equal(lineWithoutTriggerToken('{id=s1} {table}', 'table'), '{id=s1}')
assert.equal(lineWithoutTriggerToken('{table} {id=s1}', 'table'), '{id=s1}')
assert.equal(lineWithoutTriggerToken('{id=s1}', 'table'), null)

if (failures) {
  console.error(`test:object-removal — ${failures} of ${cases.length} cases failed`)
  process.exit(1)
}
console.log(`test:object-removal — ${cases.length} deletions exact, every kind and place`)

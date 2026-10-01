// Ticket 01 (ADR-0032 §2; round-3 rules 1–5, A1–A6): a board slide's text is the truth. This gate
// covers the one reader/writer both the compiler and the Inspector use (board-slide.mjs), the
// compiler's board definition for each slide form (the shape the live worker parses,
// worker/board-protocol.ts), the warnings, and the at-rest frame the big screen shows.
import { strict as assert } from 'node:assert'
import {
  BOARD_DEFAULTS, applyBoardEdit, applyBoardEditToOutline, boardFindings, boardQuestionOf, boardSource,
  boardStarterInsertion, boardStarterLines, mintBoardSlideId, readBoardBody, readBoardSettings, slideBlockEnd, BOARD_SETTINGS
} from '../compiler/scripts/lib/board-slide.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { rebasePollDefinition } from '../compiler/scripts/lib/poll-authoring.mjs'
import { renderPollFrame, POLL_JOIN_PLACEHOLDER } from '../compiler/scripts/lib/poll-frame.mjs'
import { warningDefinition } from '../compiler/scripts/lib/warning-registry.mjs'

// The parts as the Inspector shows them (a column's `raw` bytes are the writer's business).
const shown = (source) => ({ ...source, columns: source.columns.map(({ label, hint, extra }) => ({ label, hint, extra })) })
let probe = 0
const stat = { isDirectory: () => false, mtimeMs: 0 }
const compile = async (slide) => {
  const outline = ['---', 'title: Boards', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '', slide, ''].join('\n')
  const model = await prepareSource(`/tmp/board-${++probe}.md`, outline, 'Boards', stat)
  return { model, slide: model.slides.find((candidate) => candidate.poll), html: model.fullHtml }
}

// ── The starter (A1) ────────────────────────────────────────────────────────────────────────
assert.deepEqual(boardStarterLines(), [
  '### What should we keep, change, try?',
  '{poll=board}',
  '',
  'Add what you would keep, change or try. One idea per card; no names are shown.',
  '',
  '- Keep',
  '  - What worked for you?',
  '- Change',
  '  - What should be different?',
  '- Try',
  '  - What could we do next time?'
], 'Insert › Board slide writes the question, only {poll=board}, the instructions and three columns with hints')
{
  const text = '## Your turn\n{id=sec}\n\n### How confident are you?\n{poll=rating}\n\n- Writing\n\n### Next slide\nBody\n'
  const caret = text.indexOf('How confident')
  const plan = boardStarterInsertion(text, caret)
  const next = text.slice(0, plan.at) + plan.insert + text.slice(plan.at)
  assert.equal(next.slice(plan.questionFrom, plan.questionTo), 'What should we keep, change, try?', 'the question is the selection')
  assert.ok(next.includes('- Writing\n\n### What should we keep, change, try?\n{poll=board}\n'), 'inserted after the current slide, one blank line before it')
  assert.ok(next.includes('  - What could we do next time?\n\n### Next slide'), 'one blank line before the next slide')
  const fromSection = boardStarterInsertion(text, 3)
  const sectionNext = text.slice(0, fromSection.at) + fromSection.insert + text.slice(fromSection.at)
  assert.ok(sectionNext.startsWith('## Your turn\n{id=sec}\n\n### What should we keep, change, try?\n'), 'from a ## section the board is its first slide, at ###')
  const atEnd = boardStarterInsertion('### Only\nBody', 12)
  assert.equal(atEnd.insert.startsWith('\n\n### What should'), true, 'at the end of the file the starter follows a blank line')
}

// ── Reading every slide form ─────────────────────────────────────────────────────────────────
const full = [
  '{poll=board} {limit=36} {length=100} {id=kctbd}',
  '',
  'Add what you would keep, change or try. One idea per card; no names are shown.',
  '',
  '> Example: More time to try things ourselves',
  '',
  '- Keep',
  '  - What worked for you?',
  '- Change',
  '  - What should be different?',
  '- Try next',
  '  - What could we do next time?'
]
assert.deepEqual(shown(boardSource(full)), {
  instructions: 'Add what you would keep, change or try. One idea per card; no names are shown.',
  example: 'More time to try things ourselves',
  columns: [
    { label: 'Keep', hint: 'What worked for you?', extra: [] },
    { label: 'Change', hint: 'What should be different?', extra: [] },
    { label: 'Try next', hint: 'What could we do next time?', extra: [] }
  ]
}, 'heading/paragraph/">"/list/nested bullet read as question/instructions/example/columns/hints')
assert.deepEqual(shown(boardSource(['{poll=board}', '', '- A', '- B'])), { instructions: '', example: null, columns: [{ label: 'A', hint: '', extra: [] }, { label: 'B', hint: '', extra: [] }] },
  'columns alone: no instructions, no example, no hints')
assert.equal(boardSource(['> More time']).example, 'More time', 'the "Example:" prefix is optional')
assert.equal(boardSource(['{poll=board}', 'Line one', 'line two.', '', '* A', '* B']).instructions, 'Line one line two.', 'a wrapped paragraph reads as one line; * bullets are columns')
assert.deepEqual(shown(boardSource(['- A', '  - hint', '  - more', '- B'])).columns[0], { label: 'A', hint: 'hint', extra: ['  - more'] }, 'a second nested bullet is kept, not a hint')
assert.equal(boardSource(['```', '- not a column', '```', '- A']).columns.length, 1, 'fenced lines are not columns')
assert.equal(boardQuestionOf('### What should we keep? {poll=board}'), 'What should we keep?', 'the question drops a heading trailer')

// ── Settings: defaults, every value, bad values ─────────────────────────────────────────────
assert.deepEqual(readBoardSettings({}), { settings: { ...BOARD_DEFAULTS }, issues: [] }, 'no tokens: every default')
assert.deepEqual(BOARD_DEFAULTS, { limit: 24, cardChars: 140, cardsPerPhone: 5, names: false, closesAfterDays: 7 }, 'defaults as the worker reads them')
assert.deepEqual(readBoardSettings({ limit: '12', length: '60', cards: '1', names: true, closes: '1d' }).settings,
  { limit: 12, cardChars: 60, cardsPerPhone: 1, names: true, closesAfterDays: 1 }, 'bare {names} is optional names')
assert.equal(readBoardSettings({ limit: 'all' }).settings.limit, null, 'All is null')
assert.equal(readBoardSettings({ names: 'optional' }).settings.names, true, 'names=optional stays legal')
assert.equal(readBoardSettings({ names: 'off' }).settings.names, false, 'names=off stays legal')
assert.deepEqual(readBoardSettings({ limit: '13', cards: 'x' }), { settings: { ...BOARD_DEFAULTS }, issues: ['limit=13', 'cards=x'] }, 'an unreadable value takes the default and is reported')

// ── Findings: column count and lengths ──────────────────────────────────────────────────────
assert.deepEqual(boardFindings({ columns: [{ label: 'Only', hint: '' }] }).map((f) => f.code), ['board-columns-few'], 'one column is too few')
assert.deepEqual(boardFindings({ columns: 'ABCDE'.split('').map((label) => ({ label, hint: '' })) }).map((f) => f.code), ['board-columns-many'], 'five columns are too many')
assert.deepEqual(boardFindings({
  instructions: 'x'.repeat(161), example: 'y'.repeat(141),
  columns: [{ label: 'A name longer than 16', hint: 'h'.repeat(61) }, { label: 'B', hint: '' }]
}).map((f) => f.code), ['board-column-name-long', 'board-column-hint-long', 'board-instructions-long', 'board-example-long'], 'each over-long part is a finding')
assert.deepEqual(boardFindings({ instructions: 'x'.repeat(160), example: 'y'.repeat(140), columns: [{ label: 'x'.repeat(16), hint: 'h'.repeat(60) }, { label: 'B', hint: '' }] }), [], 'the limits themselves are fine')

// ── Writing: each edit touches only its part (A2, A3, A6) ────────────────────────────────────
const slide = ['### What should we keep, change, try?', ...full]
const rewrite = (edit, lines = slide) => applyBoardEdit(lines, edit)
assert.deepEqual(rewrite({ kind: 'columns', columns: [{ label: 'Keep', hint: 'What worked for you?' }, { label: 'Change', hint: 'What should be different?' }, { label: 'Try', hint: 'What could we do next time?' }] }).slice(-2),
  ['- Try', '  - What could we do next time?'], 'rename in place rewrites that one line')
{
  const renamed = rewrite({ kind: 'columns', columns: boardSource(full).columns.map((c, i) => i === 2 ? { ...c, label: 'Try' } : c) })
  assert.deepEqual(renamed.slice(0, -2), slide.slice(0, -2), 'every other line keeps its bytes')
  const reordered = rewrite({ kind: 'columns', columns: [boardSource(full).columns[2], ...boardSource(full).columns.slice(0, 2)] })
  assert.deepEqual(boardSource(reordered.slice(1)).columns.map((c) => c.label), ['Try next', 'Keep', 'Change'], 'reorder moves a column with its hint')
  assert.equal(reordered[reordered.indexOf('- Try next') + 1], '  - What could we do next time?', 'a moved column takes its hint')
  const added = rewrite({ kind: 'columns', columns: [...boardSource(full).columns, { label: 'Stop', hint: '' }] })
  assert.equal(added.at(-1), '- Stop', 'add appends a column with no hint line')
  const removed = rewrite({ kind: 'columns', columns: boardSource(full).columns.slice(1) })
  assert.equal(removed.includes('- Keep'), false, 'remove takes the column and its hint')
  assert.equal(removed.includes('  - What worked for you?'), false)
  const unnamed = rewrite({ kind: 'columns', columns: [...boardSource(full).columns, { label: '  ', hint: 'hint only' }] })
  assert.deepEqual(unnamed, slide, 'a column is not written until it has a name')
}
assert.deepEqual(rewrite({ kind: 'question', text: 'What next?' })[0], '### What next?', 'the question rewrites the heading')
assert.deepEqual(applyBoardEdit(['### Q {poll=board}', '- A', '- B'], { kind: 'question', text: 'New Q' })[0], '### New Q {poll=board}', 'a heading trailer is kept')
assert.deepEqual(rewrite({ kind: 'question', text: '  ' }), slide, 'an empty question is never written')
{
  const changed = rewrite({ kind: 'instructions', text: 'One idea per card.' })
  assert.equal(changed[3], 'One idea per card.', 'instructions replace the paragraph')
  assert.equal(changed.length, slide.length)
  const gone = rewrite({ kind: 'instructions', text: '' })
  assert.deepEqual(gone.slice(0, 4), ['### What should we keep, change, try?', '{poll=board} {limit=36} {length=100} {id=kctbd}', '', '> Example: More time to try things ourselves'], 'clearing instructions leaves one blank line')
  const back = applyBoardEdit(gone, { kind: 'instructions', text: 'Back again.' })
  assert.deepEqual(back.slice(0, 6), ['### What should we keep, change, try?', '{poll=board} {limit=36} {length=100} {id=kctbd}', '', 'Back again.', '', '> Example: More time to try things ourselves'], 'instructions come back under the trigger line')
}
{
  const off = rewrite({ kind: 'example', text: null })
  assert.equal(off.some((line) => line.startsWith('>')), false, 'Example Off removes the ">" line')
  assert.equal(off.join('\n').includes('\n\n\n'), false, 'no doubled blank line is left')
  const on = applyBoardEdit(off, { kind: 'example', text: 'More time' })
  assert.deepEqual(on.slice(3, 8), ['Add what you would keep, change or try. One idea per card; no names are shown.', '', '> Example: More time', '', '- Keep'], 'Example On writes the ">" line between the instructions and the columns')
  const bare = applyBoardEdit(['### Q', '{poll=board}', '', '- A', '- B'], { kind: 'example', text: 'Ex' })
  assert.deepEqual(bare, ['### Q', '{poll=board}', '', '> Example: Ex', '', '- A', '- B'], 'with no instructions the example goes before the columns')
}
{
  const noList = applyBoardEdit(['### Q', '{poll=board}', '', 'Instructions.'], { kind: 'columns', columns: [{ label: 'A', hint: 'a' }, { label: 'B', hint: '' }] })
  assert.deepEqual(noList, ['### Q', '{poll=board}', '', 'Instructions.', '', '- A', '  - a', '- B'], 'the first columns are written after the instructions')
  const star = applyBoardEdit(['### Q', '* A', '    * hint', '* B'], { kind: 'columns', columns: [{ label: 'B', hint: '' }, { label: 'A', hint: 'hint' }] })
  assert.deepEqual(star, ['### Q', '* B', '* A', '    * hint'], 'the author’s bullet and hint indent are kept')
}
{
  const outline = '# T\r\n\r\n### Board\r\n{poll=board} {id=b1}\r\n\r\n- A\r\n- B\r\n\r\n### Next\r\nBody\r\n'
  const written = applyBoardEditToOutline(outline, 3, { kind: 'columns', columns: [{ label: 'A', hint: '' }, { label: 'B', hint: '' }, { label: 'C', hint: '' }] })
  assert.equal(written, '# T\r\n\r\n### Board\r\n{poll=board} {id=b1}\r\n\r\n- A\r\n- B\r\n- C\r\n\r\n### Next\r\nBody\r\n', 'CRLF outlines keep CRLF; the next slide is untouched')
  assert.equal(applyBoardEditToOutline(outline, 2, { kind: 'instructions', text: 'x' }), outline, 'not a heading: nothing written')
}

// ── The compiler's board definition, for each slide form ─────────────────────────────────────
{
  const { slide: compiled, model, html } = await compile(['### What should we keep, change, try?', ...full].join('\n'))
  assert.deepEqual(compiled.poll, {
    pollId: 'poll-kctbd', type: 'board', question: 'What should we keep, change, try?',
    options: [
      { optionId: 'poll-kctbd-option-1', label: 'Keep' },
      { optionId: 'poll-kctbd-option-2', label: 'Change' },
      { optionId: 'poll-kctbd-option-3', label: 'Try next' }
    ],
    visibility: 'live',
    board: {
      instructions: 'Add what you would keep, change or try. One idea per card; no names are shown.',
      example: 'More time to try things ourselves',
      hints: {
        'poll-kctbd-option-1': 'What worked for you?',
        'poll-kctbd-option-2': 'What should be different?',
        'poll-kctbd-option-3': 'What could we do next time?'
      },
      limit: 36, cardChars: 100, cardsPerPhone: 5, names: false, closesAfterDays: 7
    }
  }, 'the full form: columns are the options, the rest rides on board with defaults filled in')
  assert.equal(compiled.layout, 'list', 'a board infers its layout from the body like any poll slide')
  assert.deepEqual(model.warnings.filter((w) => w.startsWith('board-')), [], 'a well-formed board has no warnings')
  const frame = html.match(/<section class="poll-frame[\s\S]*?<\/section>/)?.[0] ?? ''
  assert.ok(frame.includes('data-poll-type="board"'), 'the slide carries the board frame')
  assert.ok(frame.includes(POLL_JOIN_PLACEHOLDER), 'before a session is live the frame says the join link is coming')
  assert.equal((frame.match(/class="poll-frame-board-column"/g) ?? []).length, 3, 'the frame shows the three columns')
  assert.ok(frame.includes('<p class="poll-frame-board-hint">What worked for you?</p>'), 'an empty column shows its hint')
  assert.ok(frame.includes('poll-frame-board-card is-example'), 'the example card is on the empty board')
  assert.ok(frame.includes('<p class="poll-frame-board-instructions">Add what you would keep'), 'the instructions sit under the question')
}
{
  const { slide: compiled } = await compile('### Columns only\n{poll=board} {id=b2}\n\n- A\n- B')
  assert.deepEqual(compiled.poll.board, { ...BOARD_DEFAULTS }, 'columns only: no text parts, every default')
  assert.deepEqual(compiled.poll.options.map((option) => option.label), ['A', 'B'])
}
{
  const { slide: compiled } = await compile('### Every setting\n{poll=board} {limit=all} {length=200} {cards=10} {names} {closes=30d} {id=b3}\n\n- A\n- B')
  assert.deepEqual(compiled.poll.board, { limit: null, cardChars: 200, cardsPerPhone: 10, names: true, closesAfterDays: 30 }, 'every setting token reaches the definition')
  assert.equal(compiled.layout, 'list', '{cards=10} is a board setting, never the cards layout')
}
{
  const { slide: compiled, model } = await compile('### One column\n{poll=board} {id=b4}\n\n- Only')
  assert.equal(compiled.poll.options.length, 1, 'a one-column board still compiles')
  assert.ok(model.warnings.includes('board-columns-few:b4:1'), 'with a warning for too few columns')
  assert.ok(warningDefinition('board-columns-few'), 'the warning is registered')
}
{
  const { slide: compiled, model } = await compile('### Five\n{poll=board} {id=b5}\n\n- A\n- B\n- C\n- D\n- E')
  assert.deepEqual(compiled.poll.options.map((option) => option.label), ['A', 'B', 'C', 'D'], 'a board takes its first four columns')
  assert.ok(model.warnings.includes('board-columns-many:b5:5'), 'with a warning for too many')
}
{
  const { model } = await compile(`### Long\n{poll=board} {limit=13} {id=b6}\n\n${'i'.repeat(170)}\n\n> ${'e'.repeat(150)}\n\n- A column name too long\n  - ${'h'.repeat(70)}\n- B`)
  for (const expected of ['board-column-name-long:b6:A column name too long', 'board-column-hint-long:b6:A column name too long',
    'board-instructions-long:b6:170', 'board-example-long:b6:150', 'board-setting-invalid:b6:limit=13']) {
    assert.ok(model.warnings.includes(expected), `warns ${expected}`)
    assert.ok(warningDefinition(expected.split(':')[0]), `${expected.split(':')[0]} is registered`)
  }
}
{
  const { model } = await compile('### No columns\n{poll=board} {id=b7}\n\nJust instructions.')
  const html = model.fullHtml.match(/<section class="poll-frame[\s\S]*?<\/section>/)?.[0] ?? ''
  assert.ok(html.includes('This board has no columns yet'), 'a board with no columns says so on the slide')
  assert.ok(model.warnings.includes('board-columns-few:b7:0'))
}
{
  const { model } = await compile('### Board with a scale\n{poll=board} {id=b8}\n\n[scale: 1, 2]\n\n- A\n- B')
  assert.ok(model.warnings.some((w) => w.startsWith('poll-authoring-invalid:b8:')), 'a scale directive conflicts with a board')
}

// ── Rebase keeps the hints on their columns; the frame escapes text ─────────────────────────
{
  const poll = { pollId: 'poll-x', type: 'board', question: 'Q', options: [{ optionId: 'poll-x-option-1', label: 'A' }, { optionId: 'poll-x-option-2', label: 'B' }], visibility: 'live', board: { hints: { 'poll-x-option-2': 'b hint' }, ...BOARD_DEFAULTS } }
  const rebased = rebasePollDefinition(poll, 'x-2')
  assert.deepEqual(rebased.options.map((o) => o.optionId), ['poll-x-2-option-1', 'poll-x-2-option-2'])
  assert.deepEqual(rebased.board.hints, { 'poll-x-2-option-2': 'b hint' }, 'a duplicate-id rebase moves the hint keys with the options')
  const frame = renderPollFrame({ ...poll, question: '<b>Q</b>', options: [{ optionId: 'o1', label: '<i>A</i>' }, { optionId: 'o2', label: 'B' }], board: { ...BOARD_DEFAULTS, example: '<script>', hints: { o1: '"x"' } } })
  assert.equal(frame.includes('<i>') || frame.includes('<script>') || frame.includes('<b>'), false, 'author text is text only')
  assert.ok(frame.includes('Add up to 5 cards, 140 characters each.'), 'the footer says what a phone may add')
}
assert.deepEqual(readBoardBody([]), { instructions: null, example: null, list: null })

// ── Review fix round (Fable, boards 01) ─────────────────────────────────────────────────────
const labels = (lines) => boardSource(lines.slice(1)).columns.map((column) => column.label)
// S1: any instructions text round-trips as instructions — never a column, the example, a heading,
// a fence or a trigger line.
for (const text of ['1. Add a card', '2) Or this', '- one idea', '* star', '+ plus', '> keep it short', '# Big', '### Bigger',
  '```code', '~~~ tilde', '{poll=single}', '[scale: 1, 2]', '![img](x.png)', 'https://example.com', ':::notes', '| a | b |',
  '<b>html</b>', '\\already escaped', '\\- literal', 'Plain text']) {
  const written = applyBoardEdit(slide, { kind: 'instructions', text })
  const read = boardSource(written.slice(1))
  assert.equal(read.instructions, text, `S1: "${text}" reads back as the instructions`)
  assert.deepEqual(labels(written), ['Keep', 'Change', 'Try next'], `S1: "${text}" leaves the columns`)
  assert.equal(read.example, 'More time to try things ourselves', `S1: "${text}" leaves the example`)
  const outline = ['# T', '', ...written, '', '### Next', 'Body'].join('\n')
  assert.equal(slideBlockEnd(outline.split('\n'), 2), outline.split('\n').indexOf('### Next'), `S1: "${text}" never starts a slide`)
}
assert.equal(applyBoardEdit(slide, { kind: 'instructions', text: '# Big' })[3], '\\# Big', 'S1: a leading block marker is written escaped')
assert.equal(applyBoardEdit(slide, { kind: 'instructions', text: 'Plain text' })[3], 'Plain text', 'S1: ordinary text is written as typed')
{
  const { slide: compiled } = await compile('### Escaped\n{poll=board} {id=s1}\n\n\\1. Add a card, then another.\n\n- A\n- B')
  assert.equal(compiled.poll.board.instructions, '1. Add a card, then another.', 'S1: the compiler reads escaped instructions without the backslash')
  assert.deepEqual(compiled.poll.options.map((o) => o.label), ['A', 'B'])
}

// S2: a :::notes block is never board content, and no edit writes inside it.
{
  const withNotes = ['### Q', '{poll=board} {id=n1}', '', 'Instructions.', '', '- A', '- B', '', ':::notes', '> A quote for me', '- a note bullet', 'Say this.', ':::']
  const read = boardSource(withNotes.slice(1))
  assert.equal(read.example, null, 'S2: a ">" line in the notes is not the example')
  assert.deepEqual(read.columns.map((c) => c.label), ['A', 'B'], 'S2: a bullet in the notes is not a column')
  const on = applyBoardEdit(withNotes, { kind: 'example', text: 'Ex' })
  assert.deepEqual(on.slice(-5), [':::notes', '> A quote for me', '- a note bullet', 'Say this.', ':::'], 'S2: Example On leaves the notes as they were')
  assert.equal(on.indexOf('> Example: Ex') < on.indexOf(':::notes'), true, 'S2: the example goes above the notes')
  const off = applyBoardEdit(withNotes, { kind: 'example', text: null })
  assert.deepEqual(off, withNotes, 'S2: Example Off with no board example deletes nothing from the notes')
  const cols = applyBoardEdit(withNotes, { kind: 'columns', columns: [...read.columns, { label: 'C', hint: '' }] })
  assert.deepEqual(cols.slice(-5), withNotes.slice(-5), 'S2: a columns edit leaves the notes')
  const notesFirst = ['### Q', '{poll=board}', '', ':::notes', '- note', ':::', '', 'Instructions.']
  const firstCols = applyBoardEdit(notesFirst, { kind: 'columns', columns: [{ label: 'A', hint: '' }, { label: 'B', hint: '' }] })
  assert.deepEqual(firstCols.slice(3, 6), [':::notes', '- note', ':::'], 'S2: notes above the board stay whole')
  assert.deepEqual(boardSource(firstCols.slice(1)).columns.map((c) => c.label), ['A', 'B'])
  const unclosed = ['### Q', '{poll=board}', '', 'Instructions.', '', ':::notes', 'Open notes to the end']
  const unclosedCols = applyBoardEdit(unclosed, { kind: 'columns', columns: [{ label: 'A', hint: '' }, { label: 'B', hint: '' }] })
  assert.equal(unclosedCols.indexOf('- A') < unclosedCols.indexOf(':::notes'), true, 'S2: new columns never land inside notes that run to the end')
}

// S3: the slide ends at the next heading outside a fence; the starter's heading scan skips fences
// and the front matter.
{
  const outline = ['# T', '', '### Board', '{poll=board} {id=f1}', '', '```', '# not a heading', '```', '', '- A', '- B', '', '### Next', 'Body'].join('\n')
  assert.equal(slideBlockEnd(outline.split('\n'), 2), 12, 'S3: a "#" line in a fence does not end the slide')
  const written = applyBoardEditToOutline(outline, 3, { kind: 'columns', columns: [{ label: 'A', hint: '' }, { label: 'B', hint: '' }, { label: 'C', hint: '' }] })
  assert.equal(written, outline.replace('- A\n- B\n', '- A\n- B\n- C\n'), 'S3: the columns edit rewrites the real list, not inside the fence')
  const text = '---\ntitle: T\n# a yaml comment\n---\n\n### One\n\n```md\n### Not a slide\n```\n\n### Two\nBody\n'
  const plan = boardStarterInsertion(text, text.indexOf('### One') + 2)
  assert.equal(plan.at, text.indexOf('### Two'), 'S3: the starter goes after the slide, past a fenced heading')
  const fromTop = boardStarterInsertion(text, 5)
  assert.equal(fromTop.at, text.length, 'S3: a "#" line in the front matter is not a heading')
}

// S4: media and directive lines above the paragraph are not the instructions.
{
  for (const media of ['![A photo](photo.png)', '[Embed: https://example.com]', 'https://example.com/video', '<!-- a comment -->']) {
    const lines = ['{poll=board}', '', media, '', 'The real instructions.', '', '- A', '- B']
    assert.equal(boardSource(lines).instructions, 'The real instructions.', `S4: ${media} is not the instructions`)
    const written = applyBoardEdit(['### Q', ...lines], { kind: 'instructions', text: 'New.' })
    assert.equal(written.includes(media), true, `S4: editing the instructions keeps ${media}`)
    assert.equal(boardSource(written.slice(1)).instructions, 'New.')
  }
}

// S5: a cleared hint stays cleared; other nested lines keep their bytes and never become the hint.
{
  const lines = ['### Q', '- A', '  - the hint', '  - a second note', '- B']
  const cleared = applyBoardEdit(lines, { kind: 'columns', columns: boardSource(lines.slice(1)).columns.map((c, i) => i === 0 ? { ...c, hint: '' } : c) })
  assert.deepEqual(cleared, ['### Q', '- A', '  -', '  - a second note', '- B'], 'S5: an empty bullet holds the cleared hint’s place')
  assert.equal(boardSource(cleared.slice(1)).columns[0].hint, '', 'S5: the cleared hint reads back empty')
  assert.deepEqual(boardSource(cleared.slice(1)).columns[0].extra, ['  - a second note'], 'S5: the other nested line is kept as it was')
  assert.deepEqual(applyBoardEdit(cleared, { kind: 'columns', columns: boardSource(cleared.slice(1)).columns }), cleared, 'S5: rewriting keeps it stable')
  const refilled = applyBoardEdit(cleared, { kind: 'columns', columns: boardSource(cleared.slice(1)).columns.map((c, i) => i === 0 ? { ...c, hint: 'New hint' } : c) })
  assert.deepEqual(refilled.slice(1, 4), ['- A', '  - New hint', '  - a second note'], 'S5: a hint typed again takes the place')
  const alone = ['### Q', '- A', '  - only hint', '- B']
  assert.deepEqual(applyBoardEdit(alone, { kind: 'columns', columns: boardSource(alone.slice(1)).columns.map((c, i) => i === 0 ? { ...c, hint: '' } : c) }), ['### Q', '- A', '- B'], 'S5: with nothing after it the hint line goes')
}

// S6: an ordered list keeps each unchanged item's marker bytes; new and edited items get one.
{
  const lines = ['### Q', '1. One', '   - hint one', '2. Two', '3. Three']
  const source = boardSource(lines.slice(1)).columns
  const reordered = applyBoardEdit(lines, { kind: 'columns', columns: [source[2], source[0], source[1]] })
  assert.deepEqual(reordered, ['### Q', '3. Three', '1. One', '   - hint one', '2. Two'], 'S6: moved items keep their markers')
  const edited = applyBoardEdit(lines, { kind: 'columns', columns: [source[0], { ...source[1], label: 'Deux' }, source[2], { label: 'Four', hint: 'h' }] })
  assert.deepEqual(edited, ['### Q', '1. One', '   - hint one', '2. Deux', '3. Three', '4. Four', '   - h'], 'S6: an edited or new item is numbered by its place')
  const paren = ['### Q', '1) One', '2) Two']
  assert.deepEqual(applyBoardEdit(paren, { kind: 'columns', columns: [...boardSource(paren.slice(1)).columns, { label: 'Three', hint: '' }] }).at(-1), '3) Three', 'S6: the list’s own delimiter')
}

// S7: Insert › Board slide stamps an id at insertion, so the Board section can edit it at once.
{
  assert.equal(boardStarterLines(3, 'abcde')[1], '{poll=board} {id=abcde}', 'S7: the starter carries its id')
  const plan = boardStarterInsertion('### One\nBody', 3, 'zz9zz')
  assert.ok(plan.insert.includes('{poll=board} {id=zz9zz}'), 'S7: the inserted text carries the id')
  const values = [0.123456789, 0.987654321]
  const taken = (0.123456789).toString(36).slice(2, 7)
  assert.notEqual(mintBoardSlideId(`### A\n{id=${taken}}`, () => values.shift()), taken, 'S7: a minted id is never one the outline already uses')
  assert.match(mintBoardSlideId(''), /^[a-z0-9]{5}$/, 'S7: five base-36 characters, the editor’s recipe')
}

// The live worker's limits: above them the compiler reports an error naming the field.
{
  const { model } = await compile(`### Live\n{poll=board} {id=lv}\n\n${'i'.repeat(1001)}\n\n> ${'e'.repeat(501)}\n\n- A\n  - ${'h'.repeat(301)}\n- B`)
  for (const expected of ['board-live-limit:lv:instructions:1001:1000', 'board-live-limit:lv:example:501:500', 'board-live-limit:lv:hint for A:301:300']) {
    assert.ok(model.warnings.includes(expected), `live limit: ${expected}`)
  }
  assert.equal(warningDefinition('board-live-limit').severity, 'error', 'live limit: an error, not only a warning')
  const { model: under } = await compile(`### Under\n{poll=board} {id=lu}\n\n${'i'.repeat(1000)}\n\n- A\n- B`)
  assert.equal(under.warnings.some((w) => w.startsWith('board-live-limit')), false, 'live limit: at the limit is fine')
}

// Standards: the settings reader is driven by BOARD_SETTINGS.
for (const setting of BOARD_SETTINGS) {
  for (const value of setting.values) {
    const attrs = { [setting.key]: value }
    assert.deepEqual(readBoardSettings(attrs).issues, [], `${setting.key}=${value} is accepted`)
    assert.equal(readBoardSettings(attrs).settings[setting.field], setting.read(value), `${setting.key}=${value} reads into ${setting.field}`)
  }
  assert.deepEqual(readBoardSettings({ [setting.key]: 'nonsense' }).issues, [`${setting.key}=nonsense`], `${setting.key}: other values are reported`)
}

console.log('board slide: starter, every slide form, settings, findings, body edits, compiler definition and frame pass')

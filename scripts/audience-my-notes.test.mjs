// My Notes' read model without a browser: what one device holds for a talk, listed by slide (ADR-0033).
// Every kind, slide order, kinds ordered within a slide, reactions taken back absent, live runs merged, a
// slide with nothing absent, chips, removal, the question log and the poll-answer record. The drawer on
// the real page is audience-my-notes-dom.test.mjs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  audienceMyNotesRuntimeSource, createQuestionLog, gatherMyNotes, myNotesChips, myNotesIcons, myNotesPollAnswerKey, noteQuestionText, pollAnswerRecord,
  removeMyNotesMark, viewMyNotes, myNotesSlideMarks, myNotesMarkdown, myNotesPrintHtml,
} from '../compiler/assets/runtime/audience-my-notes.js'
import { createReactionMarks, reactionTap } from '../compiler/assets/runtime/audience-reactions.js'

const memory = () => { const map = new Map(); return { getItem: (k) => map.has(k) ? map.get(k) : null, setItem: (k, v) => { map.set(k, String(v)) }, removeItem: (k) => { map.delete(k) }, key: (i) => [...map.keys()][i] ?? null, get length() { return map.size }, map } }
const KEYS = { notes: 'notes', reactions: 'reactions', questions: 'questions' }
const SLIDES = [{ id: 'a', title: 'Alpha' }, { id: 'b', title: 'Beta' }, { id: 'c', title: 'Gamma' }, { id: 'd', title: 'Delta' }]
const gather = (storage, extra = {}) => gatherMyNotes({ storage, keys: KEYS, slides: SLIDES, ...extra })
const kindsBySlide = (model) => model.groups.map((g) => [g.number, g.items.map((i) => i.kind)])

// ── The icons are lucide's own ───────────────────────────────────────────────────────────────
const lucide = JSON.parse(readFileSync(new URL('../compiler/assets/icons/lucide.json', import.meta.url), 'utf8'))
for (const [name, body] of Object.entries(myNotesIcons())) assert.equal(body, lucide[name]?.body, `icon ${name} matches the vendored lucide set`)

// ── Nothing held: no groups, and the empty state ─────────────────────────────────────────────
{
  const model = gather(memory())
  assert.deepEqual(model, { groups: [] })
  assert.equal(viewMyNotes(model, 'all').empty, true)
  assert.deepEqual(gather(null), { groups: [] }, 'no storage at all is an empty My Notes, not an error')
  const blocked = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') }, get length() { throw new Error('blocked') }, key() { throw new Error('blocked') } }
  assert.deepEqual(gather(blocked), { groups: [] }, 'blocked storage is an empty My Notes')
}

// ── One device holding every kind, listed by slide in slide order ───────────────────────────
const full = memory()
{
  const marks = createReactionMarks({ storage: full, key: KEYS.reactions })
  marks.set('c', 'run1', { r: 'helped' })
  marks.set('b', 'run1', { b: true })
  marks.set('a', 'run1', { r: 'puzzled', b: true })
  // A reaction tapped and taken back is not stored: it appears nowhere (slide d).
  const tapped = reactionTap({ r: null, b: false }, 'puzzled')
  marks.set('d', 'run1', { r: tapped.next.r })
  const undone = reactionTap(tapped.next, 'puzzled')
  marks.set('d', 'run1', { r: undone.next.r })
  full.setItem(KEYS.notes, JSON.stringify([
    { id: 'note-1', slideIndex: 1, slideId: 'b', slideTitle: 'Beta', type: 'text', quote: 'first quote', note: 'first words', createdAt: '2026-09-29T10:00:00.000Z' },
    { id: 'note-2', slideIndex: 1, slideId: 'b', slideTitle: 'Beta', type: 'image', alt: 'a chart', note: '', createdAt: '2026-09-29T10:05:00.000Z' },
    { id: 'note-3', slideIndex: 0, slideId: 'a', slideTitle: 'Alpha', type: 'text', quote: 'quote on a', note: '', createdAt: '2026-09-29T10:06:00.000Z' },
  ]))
  full.setItem(KEYS.questions, JSON.stringify({ v: 1, items: [
    { submissionId: 'q1', slideId: 'b', text: 'Why beta?', name: 'Sam', at: '2026-09-29T10:10:00.000Z' },
    { submissionId: 'q2', slideId: 'a', text: 'Why alpha?', name: '', at: '2026-09-29T10:11:00.000Z' },
  ] }))
  full.setItem(myNotesPollAnswerKey('run1', 'poll-1'), JSON.stringify({ slideId: 'c', question: 'What now?', answer: 'Writing and editing', at: '2026-09-29T10:20:00.000Z' }))
}
{
  const model = gather(full)
  assert.deepEqual(kindsBySlide(model), [
    [1, ['bookmark', 'puzzled', 'note', 'question']],
    [2, ['bookmark', 'note', 'note', 'question']],
    [3, ['helped', 'poll']],
  ], 'slides in slide order, each kind under its slide, marks then poll then notes then questions; slide 4 (taken back) is absent')
  const beta = model.groups[1]
  assert.deepEqual(beta.items.filter((i) => i.kind === 'note').map((i) => i.id), ['note-2', 'note-1'], 'notes newest first, as before')
  assert.equal(beta.items.find((i) => i.id === 'note-2').quote, '[Image: a chart]', 'an image note reads as its alt text')
  assert.equal(beta.title, 'Beta')
  assert.deepEqual(model.groups[2].items.find((i) => i.kind === 'poll'), { kind: 'poll', id: myNotesPollAnswerKey('run1', 'poll-1'), question: 'What now?', answer: 'Writing and editing', at: '2026-09-29T10:20:00.000Z' })
  const kinds = model.groups.flatMap((g) => g.items.map((i) => i.kind))
  assert.equal(kinds.filter((k) => k === 'puzzled').length, 1, 'each item once')
  assert.equal(model.groups.some((g) => g.slideId === 'd'), false, 'an undone reaction appears nowhere')
  assert.equal(viewMyNotes(model, 'all').empty, false)
}

// ── A poll answer only if answered; a slide the talk no longer has is left out ──────────────
{
  const storage = memory()
  assert.deepEqual(gather(storage).groups, [], 'no poll record, no poll answer')
  storage.setItem(myNotesPollAnswerKey('run1', 'p'), JSON.stringify({ slideId: 'gone', question: 'q', answer: 'x', at: '2026-09-29T10:00:00.000Z' }))
  storage.setItem(myNotesPollAnswerKey('run1', 'q'), '{not json')
  storage.setItem('talkweaver:poll-vote:run1:p', JSON.stringify('opt-1'))
  assert.deepEqual(gather(storage).groups, [], 'a vote with no slide, an unreadable record and a bare vote are not listed')
}

// ── Runs merged: the same kind marked in two live runs is listed once ───────────────────────
{
  const storage = memory()
  const marks = createReactionMarks({ storage, key: KEYS.reactions })
  marks.set('a', 'run1', { r: 'puzzled', b: true })
  marks.set('a', 'run2', { r: 'puzzled' })
  marks.set('b', 'run2', { r: 'helped' })
  assert.deepEqual(kindsBySlide(gather(storage)), [[1, ['bookmark', 'puzzled']], [2, ['helped']]])
  assert.deepEqual(kindsBySlide(gather(storage, { notes: [] })), [[1, ['bookmark', 'puzzled']], [2, ['helped']]])
  marks.set('a', 'run3', { r: 'not-in-the-standard-set' })
  assert.deepEqual(kindsBySlide(gather(storage)), [[1, ['bookmark', 'puzzled']], [2, ['helped']]], 'a reaction outside the standard set is not listed here')
}

// ── The page's own notes list wins over the notes key; slide ids place a note, indexes are the fallback ──
{
  const storage = memory()
  storage.setItem(KEYS.notes, JSON.stringify([{ id: 'stored', slideIndex: 0, slideId: 'a', type: 'text', quote: 'q', note: '' }]))
  const model = gather(storage, { notes: [
    { id: 'moved', slideIndex: 0, slideId: 'c', slideTitle: 'Old title', type: 'text', quote: 'q', note: 'w' },
    { id: 'old', slideIndex: 3, slideId: '', slideTitle: 'Old', type: 'text', quote: 'q', note: '' },
    { id: 'lost', slideIndex: 40, slideId: 'nope', type: 'text', quote: 'q', note: '' },
  ] })
  assert.deepEqual(model.groups.map((g) => [g.number, g.items.map((i) => i.id)]), [[3, ['moved']], [4, ['old']]], 'a note follows its slide id; a note with no id keeps its index; an impossible one is left out')
  assert.equal(model.groups[0].title, 'Gamma', 'the slide title is the talk’s current one')
}

// ── Chips: each lists only its kind ─────────────────────────────────────────────────────────
{
  const model = gather(full)
  assert.deepEqual(myNotesChips().map(([id]) => id), ['all', 'note', 'bookmark', 'puzzled', 'helped', 'question', 'poll'])
  const only = (chip) => viewMyNotes(model, chip).groups.map((g) => [g.number, g.items.map((i) => i.kind)])
  assert.deepEqual(only('note'), [[1, ['note']], [2, ['note', 'note']]])
  assert.deepEqual(only('bookmark'), [[1, ['bookmark']], [2, ['bookmark']]])
  assert.deepEqual(only('puzzled'), [[1, ['puzzled']]])
  assert.deepEqual(only('helped'), [[3, ['helped']]])
  assert.deepEqual(only('question'), [[1, ['question']], [2, ['question']]])
  assert.deepEqual(only('poll'), [[3, ['poll']]])
  const puzzled = viewMyNotes(model, 'puzzled')
  assert.equal(puzzled.groups[0].also, 'Also here: a bookmark, 1 note, 1 question', 'the marks views say what else is on the slide')
  assert.equal(viewMyNotes(model, 'helped').groups[0].also, 'Also here: a poll answer')
  assert.equal(viewMyNotes(model, 'note').groups[0].also, undefined, 'the other views carry no such line')
  const bare = memory()
  createReactionMarks({ storage: bare, key: KEYS.reactions }).set('a', 'run1', { r: 'puzzled' })
  assert.equal(viewMyNotes(gather(bare), 'puzzled').groups[0].also, 'Nothing else written here.')
  const empty = viewMyNotes(gather(bare), 'note')
  assert.deepEqual([empty.empty, empty.groups.length, empty.nothing], [false, 0, 'No notes yet.'], 'a chip with nothing in it says so; My Notes is not empty')
}

// ── Removal: a bookmark or a reaction leaves every run and My Notes; nothing else changes ──
{
  const storage = memory()
  const marks = createReactionMarks({ storage, key: KEYS.reactions })
  marks.set('a', 'run1', { r: 'puzzled', b: true })
  marks.set('a', 'run2', { r: 'puzzled', b: true })
  marks.set('b', 'run2', { r: 'helped' })
  assert.equal(removeMyNotesMark({ storage, key: KEYS.reactions }, 'a', 'puzzled'), 2, 'the reaction is cleared in both runs')
  assert.deepEqual(kindsBySlide(gather(storage)), [[1, ['bookmark']], [2, ['helped']]], 'it leaves My Notes; the bookmark on the same slide stays')
  assert.deepEqual(marks.get('a', 'run2'), { r: null, b: true }, 'the bar reads the same storage: the mark is gone there too')
  assert.equal(removeMyNotesMark({ storage, key: KEYS.reactions }, 'a', 'bookmark'), 2)
  assert.equal(removeMyNotesMark({ storage, key: KEYS.reactions }, 'a', 'bookmark'), 0, 'nothing left to remove')
  assert.deepEqual(kindsBySlide(gather(storage)), [[2, ['helped']]], 'a slide with nothing left is absent')
  assert.equal(removeMyNotesMark({ storage, key: KEYS.reactions }, 'b', 'puzzled'), 0, 'removing a kind the slide does not hold changes nothing')
  assert.deepEqual(marks.get('b', 'run2'), { r: 'helped', b: false })
}

// ── The question log: what Ask writes when the worker confirms ─────────────────────────────
{
  const storage = memory()
  const log = createQuestionLog({ storage, key: KEYS.questions })
  assert.deepEqual(log.all(), [])
  assert.equal(log.add({ submissionId: 's1', slideId: 'a', text: 'What is <b>this</b>?', name: 'Ann <i>', at: '2026-09-29T10:00:00.000Z' }), true)
  assert.equal(log.add({ submissionId: 's1', slideId: 'a', text: 'What is <b>this</b>?', name: 'Ann <i>', at: '2026-09-29T10:00:05.000Z' }), false, 'a confirmation seen twice is kept once')
  assert.equal(log.add({ submissionId: 's2', slideId: 'a', text: '   ' }), false, 'no words, no record')
  assert.equal(log.add({ submissionId: 's3', text: 'no slide' }), false)
  const other = createQuestionLog({ storage, key: KEYS.questions })
  other.add({ submissionId: 's4', slideId: 'b', text: 'From another tab' })
  assert.deepEqual(log.all().map((q) => q.submissionId), ['s1', 's4'], 'two tabs never overwrite each other')
  const model = gather(storage)
  assert.deepEqual(model.groups[0].items[0], { kind: 'question', id: 's1', text: 'What is <b>this</b>?', name: 'Ann <i>', at: '2026-09-29T10:00:00.000Z' }, 'text is carried as typed; the drawer writes it as text')
  const blocked = createQuestionLog({ storage: { getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') } }, key: KEYS.questions })
  blocked.add({ submissionId: 'x', slideId: 'a', text: 'kept for this page' })
  assert.equal(blocked.all().length, 1, 'blocked storage keeps the record for the page')
}

// ── The poll-answer record ─────────────────────────────────────────────────────────────────
{
  const single = { pollId: 'p', slideId: 'b', pollType: 'single', question: 'Use?', options: [{ optionId: 'o1', label: 'Writing' }, { optionId: 'o2', label: 'Code' }] }
  const at = Date.parse('2026-09-29T10:00:00.000Z')
  assert.deepEqual(pollAnswerRecord(single, 'o2', at), { slideId: 'b', question: 'Use?', answer: 'Code', at: '2026-09-29T10:00:00.000Z' })
  assert.equal(pollAnswerRecord({ ...single, pollType: 'multiple' }, ['o1', 'o2'], at).answer, 'Writing, Code')
  assert.equal(pollAnswerRecord({ ...single, pollType: 'ranking' }, ['o2', 'o1'], at).answer, 'Code > Writing')
  assert.equal(pollAnswerRecord({ ...single, pollType: 'rating' }, { o1: 4, o2: 2 }, at).answer, 'Writing: 4, Code: 2')
  assert.equal(pollAnswerRecord({ ...single, pollType: 'categorisation', labels: [{ optionId: 'k1', label: 'Often' }] }, { o1: 'k1' }, at).answer, 'Writing: Often')
  assert.equal(pollAnswerRecord({ ...single, pollType: 'open' }, 'my own words', at).answer, 'my own words')
  assert.equal(pollAnswerRecord({ ...single, slideId: '' }, 'o1', at), null, 'a poll not tied to a slide cannot be listed by slide')
  assert.equal(pollAnswerRecord(null, 'o1', at), null)
  assert.equal(pollAnswerRecord(single, null, at), null)
}

// ── A note sent as a question (ticket 02): the text it sends, and where it is listed ─────────
{
  assert.equal(noteQuestionText('find the form', 'Does it need my login?'), '\u201cfind the form\u201d\n\nDoes it need my login?')
  assert.equal(noteQuestionText('', 'Only words'), 'Only words')
  assert.equal(noteQuestionText('a\n  b\tc', 'w'), '\u201ca b c\u201d\n\nw', 'a quote across lines is flattened')
  const long = noteQuestionText('q'.repeat(400), 'w'.repeat(340))
  assert.ok(long.length <= 500, `quote cut so the whole fits a question (${long.length})`)
  assert.ok(long.includes('\u2026') && long.endsWith('w'.repeat(340)), 'the words are never cut, the quote is')
  const storage = memory()
  const notes = [
    { id: 'n1', slideId: 'a', type: 'text', quote: 'q1', note: 'kept', createdAt: '2026-09-22T10:00:00' },
    { id: 'n2', slideId: 'a', type: 'text', quote: 'q2', note: 'asked', createdAt: '2026-09-22T10:01:00', sentAt: '2026-09-22T10:42:00' },
  ]
  const model = gather(storage, { notes })
  const items = model.groups[0].items
  assert.deepEqual(items.map((i) => [i.id, i.sentAt]), [['n2', '2026-09-22T10:42:00'], ['n1', '']], 'the model carries when a note was sent')
  assert.deepEqual(viewMyNotes(model, 'question').groups[0].items.map((i) => i.id), ['n2'], 'a sent note is in Questions')
  assert.deepEqual(viewMyNotes(model, 'note').groups[0].items.map((i) => i.id), ['n2', 'n1'], 'and still in Notes')
  assert.equal(viewMyNotes(model, 'all').groups[0].items.filter((i) => i.id === 'n2').length, 1, 'and once in All')
}

// ── A phone's slide note: no quote, and what the page knows of a send that has not landed ────
{
  const notes = [
    { id: 'p1', slideId: 'b', type: 'slide', note: 'Only for me', createdAt: '2026-09-29T10:00:00' },
    { id: 'p2', slideId: 'b', type: 'slide', note: 'Sent, then lost', createdAt: '2026-09-29T10:01:00', sendId: 'sub-0001' },
    { id: 'p3', slideId: 'b', type: 'slide', note: 'On its way', createdAt: '2026-09-29T10:02:00', sendId: 'sub-0002' },
    { id: 'p4', slideId: 'b', type: 'slide', note: 'Landed', createdAt: '2026-09-29T10:03:00', sentAt: '2026-09-29T10:04:00' },
  ]
  const sendStates = { p2: { state: 'failed', retry: true, reason: 'It did not reach the speaker.' }, p3: { state: 'sending' }, p4: { state: 'failed', retry: true } }
  const items = gather(memory(), { notes, sendStates }).groups[0].items
  const by = Object.fromEntries(items.map((i) => [i.id, i]))
  assert.deepEqual(items.map((i) => i.type), ['slide', 'slide', 'slide', 'slide'], 'a slide note is its own type')
  assert.ok(items.every((i) => i.quote === ''), 'a slide note has no quote')
  assert.deepEqual([by.p1.sendState, by.p2.sendState, by.p3.sendState], ['', 'failed', 'sending'], 'the send state comes from the page')
  assert.deepEqual([by.p2.sendRetry, by.p2.sendReason], [true, 'It did not reach the speaker.'])
  assert.equal(by.p4.sendState, '', 'a note already sent is never shown as unsent, whatever the page says')
  assert.deepEqual(gather(memory(), { notes: [notes[0]] }).groups[0].items[0].sendState, '', 'no states given: none shown')
  assert.deepEqual(viewMyNotes(gather(memory(), { notes, sendStates }), 'question').groups[0].items.map((i) => i.id), ['p4'], 'only the note that landed is in Questions')
}

// ── The marks in the slide list: one per kind present, in the legend's order ─────────────────
{
  const marks = myNotesSlideMarks(gather(full))
  assert.deepEqual(marks, { 0: ['note', 'bookmark', 'puzzled', 'question'], 1: ['note', 'bookmark', 'question'], 2: ['helped', 'poll'] }, 'exactly the kinds each slide holds; slide d (a reaction taken back) has none')
  assert.deepEqual(myNotesSlideMarks({ groups: [] }), {}, 'nothing held, no marks')
  const sent = { groups: [{ index: 3, items: [{ kind: 'note', sentAt: '2026-09-29T10:00:00' }, { kind: 'note', sentAt: '' }, { kind: 'bookmark' }, { kind: 'bookmark' }] }] }
  assert.deepEqual(myNotesSlideMarks(sent), { 3: ['note', 'bookmark', 'question'], }, 'a note sent as a question is also a Question; each kind once however many items')
  assert.deepEqual(myNotesSlideMarks({ groups: [{ index: 0, items: [{ kind: 'note', sentAt: '' }] }] }), { 0: ['note'] }, 'a note whose send has not landed is a Note only')
}

// ── Markdown: every kind, slide order ────────────────────────────────────────────────────────
{
  const at = (iso) => { const d = new Date(iso); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') }
  const withSent = memory()
  withSent.setItem(KEYS.reactions, full.getItem(KEYS.reactions))
  withSent.setItem(KEYS.questions, full.getItem(KEYS.questions))
  withSent.setItem(myNotesPollAnswerKey('run1', 'poll-1'), full.getItem(myNotesPollAnswerKey('run1', 'poll-1')))
  const notes = [
    { id: 'n1', slideIndex: 1, slideId: 'b', slideTitle: 'Beta', type: 'text', quote: 'first\nquote  spans', note: 'first words\nsecond line', createdAt: '2026-09-29T10:00:00', sentAt: '2026-09-29T10:02:00' },
    { id: 'n2', slideIndex: 1, slideId: 'b', slideTitle: 'Beta', type: 'image', alt: 'a chart', note: '', createdAt: '2026-09-29T10:05:00' },
    { id: 'n3', slideIndex: 0, slideId: 'a', slideTitle: 'Alpha', type: 'slide', note: 'A slide note', createdAt: '2026-09-29T10:06:00' },
  ]
  const md = myNotesMarkdown(gather(withSent, { notes }), { title: 'The talk', date: '2026-09-29' })
  const lines = md.split('\n')
  assert.equal(lines[0], '# Notes: The talk')
  const headings = lines.filter((l) => l.startsWith('## '))
  assert.deepEqual(headings, ['## Slide 1: Alpha', '## Slide 2: Beta', '## Slide 3: Gamma'], 'one heading per slide that holds anything, in slide order (slide 4 is absent)')
  const at1 = md.indexOf('## Slide 1'), at2 = md.indexOf('## Slide 2'), at3 = md.indexOf('## Slide 3')
  const slide1 = md.slice(at1, at2), slide2 = md.slice(at2, at3), slide3 = md.slice(at3)
  assert.match(slide1, /- Bookmarked\n- Puzzled by this\n- Note on the slide: A slide note\n- Question sent to the speaker \(\d\d:\d\d\): Why alpha\?/, 'marks, then the note, then the question, one line each')
  assert.match(slide2, /- Bookmarked\n(?:- \[Image: a chart\]\n)?- > first quote spans\n  first words\n  second line\n  Sent to the speaker as a question \(/, 'a highlight is "- > quote" with its words under it, then that it was sent; a quote is one line')
  assert.ok(slide2.includes('- [Image: a chart]'), 'an image note is its alt text')
  assert.ok(slide2.includes('- Question sent to the speaker (' + at('2026-09-29T10:10:00.000Z') + '): Why beta?'), 'a question carries its time')
  assert.match(slide3, /- Helped me understand\n- Poll answer: What now\?\n  You chose: Writing and editing/, 'a poll answer with its question and the words chosen')
  assert.ok(md.endsWith('\n') && !md.endsWith('\n\n'), 'one trailing newline')
  assert.equal(myNotesMarkdown({ groups: [] }, { title: 'T' }), '# Notes: T\n\nNothing has been kept yet.\n', 'an empty My Notes says so in one line')
  assert.ok(!md.includes('undefined') && !md.includes('[object'), 'no stray values')
}

// ── The printable notes page: notes with slide titles, never the slides, text only ───────────
{
  const hostile = '<img src=x onerror=alert(1)> & "q"'
  const model = { groups: [
    { index: 0, number: 1, slideId: 'a', title: 'Alpha ' + hostile, items: [{ kind: 'puzzled' }, { kind: 'note', type: 'text', quote: hostile, words: hostile, sentAt: '2026-09-29T10:02:00', at: '' }, { kind: 'poll', question: hostile, answer: hostile, at: '' }, { kind: 'question', text: hostile, name: hostile, at: '2026-09-29T10:03:00' }] },
    { index: 4, number: 5, slideId: 'e', title: 'Epsilon', items: [{ kind: 'bookmark' }, { kind: 'helped' }] },
  ] }
  const html = myNotesPrintHtml(model, { title: 'Talk ' + hostile })
  assert.doesNotMatch(html, /<img/i, 'user text is escaped, never markup')
  assert.doesNotMatch(html, /<script/i, 'the page carries no script')
  assert.ok(html.includes('&lt;img src=x'), 'the text is there, as text')
  assert.deepEqual([...html.matchAll(/<h2>/g)].length, 2, 'one section per slide that holds anything')
  assert.ok(html.indexOf('Alpha') < html.indexOf('Epsilon'), 'slide order')
  for (const words of ['Puzzled by this', 'Bookmarked', 'Helped me understand', 'Poll answer', 'You chose:', 'Question sent to the speaker', 'Sent to the speaker as a question']) assert.ok(html.includes(words), `${words} is in words on the page`)
  assert.ok(html.includes('2 slides · 6 things kept'), 'the closing count')
  assert.doesNotMatch(html, /class="slide|data-slide|<canvas|<iframe/, 'no slide is on the page')
  assert.match(html, /@media print\{\.bar\{display:none\}/, 'the on-screen bar is not printed')
  assert.match(html, /id="printNow"/, 'the screen bar has the print button')
  assert.doesNotMatch(myNotesPrintHtml(model, { title: 'T', screenBar: false }), /printNow/, 'the bar can be left out')
  const empty = myNotesPrintHtml({ groups: [] }, { title: 'T' })
  assert.ok(empty.includes('There is nothing to print yet. No notes have been made on this device.'), 'an empty My Notes prints one line')
  assert.equal([...empty.matchAll(/<section/g)].length, 0)
}

// ── Embedding: every function is self-contained, so the page can carry it by toString() ──────
{
  const source = audienceMyNotesRuntimeSource()
  for (const name of ['myNotesChips', 'gatherMyNotes', 'viewMyNotes', 'removeMyNotesMark', 'myNotesSlideMarks', 'createSlideMarks', 'myNotesMarkdown', 'myNotesPrintHtml', 'createQuestionLog', 'noteQuestionText', 'pollAnswerRecord', 'myNotesPollAnswerKey', 'createMyNotesDrawer']) {
    assert.match(source, new RegExp(`function ${name}\\(`), `${name} is in the page runtime`)
  }
  assert.doesNotMatch(source, /\bimport\b|\bexport\b/, 'no module syntax leaks into the page')
  // The writer's key and the reader's prefix agree.
  assert.ok(myNotesPollAnswerKey('s', 'p').startsWith('talkweaver:poll-answer:'))
  assert.match(source, /talkweaver:poll-answer:/)
}

console.log('audience-my-notes: ok')

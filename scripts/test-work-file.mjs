// Work-files ticket 02: the work-file reader (src/shared/work-file.ts) and its revision hash.
//   1. the ADR example reads into 4 steps with kinds video, check, task, question and the front matter;
//   2. layouts: the six allowed, and a layout outside them is a finding naming step and layout;
//   3. poll types read as written (incl. rating); no questions are added; step tokens are prework's;
//   4. findings: missing/invalid id and title, revision, duplicate and missing step ids, empty file;
//   5. the hash: same bytes same hash, equals node:crypto sha256, differs on CRLF (bytes differ).
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-work-file.mjs
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readWorkFile, workFileHash } from '../src/shared/work-file.ts'

const EXAMPLE = [
  '---',
  'id: research-teams-intake        # stable; what talks and Runs name',
  'title: Research teams intake',
  'revision: 3                      # integer, bumped by the app when steps change',
  '---',
  'Four short steps before we meet.',
  '',
  '### Watch: what agents do',
  '{id=watch}{video}',
  '### What makes something an agent?',
  '{id=check}{check}{poll=single}',
  '- It uses tools to carry out steps on its own {right}',
  '- It only answers questions',
  '### Try one prompt on a paper of your own',
  '{id=try-a-prompt}{task}{minutes=20}',
  '### What do you most want from the session?',
  '{id=what-you-want}{poll=open}',
  '',
].join('\n')

const file = (steps, head = ['id: f1', 'title: F', 'revision: 1']) => ['---', ...head, '---', '', ...steps, ''].join('\n')
const codes = (reading) => reading.findings.map((f) => f.code)

// 1. the example
{
  const r = readWorkFile(EXAMPLE)
  assert.deepEqual(r.findings.filter((f) => f.severity === 'blocking'), [])
  assert.equal(r.ok, true)
  assert.equal(r.definition.id, 'research-teams-intake')
  assert.equal(r.definition.title, 'Research teams intake')
  assert.equal(r.definition.revision, 3)
  assert.equal(r.revision, 3)
  assert.equal(r.definition.intro, 'Four short steps before we meet.') // exact: item 10
  assert.deepEqual(r.definition.steps.map((s) => [s.id, s.kind]), [
    ['watch', 'video'], ['check', 'check'], ['try-a-prompt', 'task'], ['what-you-want', 'question'],
  ])
  const [watch, check, task, question] = r.definition.steps
  assert.equal(watch.layout, 'video')
  assert.equal(check.pollType, 'single')
  assert.deepEqual(check.options, ['It uses tools to carry out steps on its own', 'It only answers questions'])
  assert.deepEqual(check.right, { index: 0, label: 'It uses tools to carry out steps on its own' })
  assert.equal(task.minutes, 20)
  assert.equal(task.done, true)
  assert.equal(question.pollType, 'open')
  assert.equal(watch.sourceLine, 8)
  assert.equal(question.sourceLine, 16)
  assert.equal(r.definition.steps.every((s) => s.questions), true)
}

// 2. layouts
{
  const r = readWorkFile(file([
    '### Plain', 'Some words.',
    '### Pic', '![a](a.png)', '- beside text',
    '### Cols {2col}', '- a', '- b',
    '### Ordered', '1. one', '2. two',
    '### Stairs {steps}', '- a',
    '### Full', '![a](a.png)',
    '### Clip', '![](https://youtu.be/dQw4w9WgXcQ)',
  ]))
  assert.deepEqual(r.definition.steps.map((s) => s.layout), ['title', 'title-image', 'columns', 'steps', 'steps', 'full-image', 'video'])
  assert.deepEqual(r.findings.filter((f) => f.code === 'work-file-layout-unsupported'), [])
  assert.equal(r.definition.steps[6].kind, 'video')
}
{
  const r = readWorkFile(file(['### Fancy {id=fancy}{timeline}', '- a', '### Table {id=tab}', '| a | b |', '|--|--|', '| 1 | 2 |', '### Okay {id=okay}', 'Words.']))
  const bad = r.findings.filter((f) => f.code === 'work-file-layout-unsupported')
  assert.deepEqual(bad.map((f) => [f.stepId, f.detail, f.severity]), [['fancy', 'timeline', 'blocking'], ['tab', 'table', 'blocking']])
  assert.equal(r.definition.steps[2].layout, 'title')
  assert.equal(r.ok, false)
  // never a crash: the steps are still read
  assert.equal(r.definition.steps.length, 3)
}

// 3. poll types as written; no default questions
{
  const types = ['single', 'multiple', 'open', 'ranking', 'rating', 'categorisation', 'board']
  const r = readWorkFile(file(types.map((t) => `### Q ${t} {id=q-${t}}{poll=${t}}`)))
  assert.deepEqual(r.definition.steps.map((s) => [s.kind, s.pollType]), types.map((t) => ['question', t]))
  const mixedCase = readWorkFile(file(['### Q {id=q}{poll=Single}']))
  assert.deepEqual([mixedCase.definition.steps[0].pollType, codes(mixedCase)], ['single', []])
  const none = readWorkFile(file(['### Just words {id=words}', 'Hello.']))
  assert.deepEqual(none.definition.steps.map((s) => [s.id, s.kind]), [['words', 'slide']])
  const readonly = readWorkFile(file(['### T {id=t}{task}{readonly}{noask}', '- do']))
  assert.equal(readonly.definition.steps[0].done, false)
  assert.equal(readonly.definition.steps[0].questions, false)
  const check = readWorkFile(file(['### C {id=c}{check}{poll=multiple}', '- a', '- b']))
  assert.ok(codes(check).includes('prework-check-not-single'))
  assert.ok(codes(check).includes('prework-check-right-missing'))
}

// 4. findings
{
  const r = readWorkFile(file(['### A {id=a}', 'x'], ['title: ', 'revision: two']))
  assert.deepEqual(codes(r).filter((c) => c.startsWith('work-file')), ['work-file-id-missing', 'work-file-title-missing', 'work-file-revision-invalid'])
  assert.equal(r.definition.id, '')
  assert.equal(r.definition.revision, null)
  assert.equal(r.ok, false)
  assert.ok(codes(readWorkFile(file(['### A {id=a}', 'x'], ['id: Not A Slug', 'title: T', 'revision: 1']))).includes('work-file-id-invalid'))
  assert.ok(codes(readWorkFile(file(['### A {id=a}', 'x'], ['id: ' + 'a'.repeat(81), 'title: T', 'revision: 1']))).includes('work-file-id-invalid'))
  const norev = readWorkFile(file(['### A {id=a}', 'x'], ['id: ok', 'title: T']))
  assert.deepEqual(norev.findings.map((f) => [f.code, f.severity]), [['work-file-revision-missing', 'warning']])
  assert.equal(norev.ok, true)
  assert.deepEqual(readWorkFile('').findings.map((f) => f.code).sort(), ['work-file-id-missing', 'work-file-no-steps', 'work-file-revision-missing', 'work-file-title-missing'])
}
{
  const dup = readWorkFile(file(['### One {id=same}', 'a', '### Two {id=same}', 'b']))
  assert.deepEqual(dup.findings.filter((f) => f.code === 'work-file-step-id-duplicate').map((f) => [f.stepId, f.line]), [['same', 7], ['same', 9]])
  const missing = readWorkFile(file(['### No id here', 'a', '### Other {id=Bad_Id}', 'b']))
  assert.deepEqual(missing.findings.map((f) => f.code), ['work-file-step-id-missing', 'work-file-step-id-invalid'])
  assert.equal(missing.findings[0].stepId, 'no-id-here')
  assert.equal(missing.ok, false)
  const level = readWorkFile(file(['## Wrong level {id=w}', 'a', '### Fine {id=f}', 'b']))
  assert.ok(level.findings.some((f) => f.code === 'work-file-step-level' && f.stepId === 'w'))
}

// 5. the hash
{
  assert.equal(workFileHash(''), createHash('sha256').update('').digest('hex'))
  assert.equal(workFileHash('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  for (const sample of [EXAMPLE, 'é—日本語 🙂\n', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(1000)]) {
    assert.equal(workFileHash(sample), createHash('sha256').update(sample, 'utf8').digest('hex'))
  }
  const a = readWorkFile(EXAMPLE)
  assert.equal(a.hash, readWorkFile(EXAMPLE).hash)
  assert.match(a.hash, /^[0-9a-f]{64}$/)
  // Decision: bytes as written. CRLF is a different file; a changed step is a different file.
  assert.notEqual(readWorkFile(EXAMPLE.replace(/\n/g, '\r\n')).hash, a.hash)
  assert.notEqual(readWorkFile(EXAMPLE.replace('Four', 'Five')).hash, a.hash)
  // CRLF still reads into the same steps.
  const crlf = readWorkFile(EXAMPLE.replace(/\n/g, '\r\n'))
  assert.deepEqual(crlf.definition.steps.map((s) => [s.id, s.kind]), a.definition.steps.map((s) => [s.id, s.kind]))
  assert.equal(crlf.definition.id, 'research-teams-intake')
  assert.equal(crlf.definition.revision, 3)
}

// Fix round. Item 1: a `#` heading is a blocking finding with its line, never folded or dropped.
{
  const r = readWorkFile(file(['Intro words.', '', '# A title {id=top}', '### S {id=s}', 'x', '```', '# not a heading', '```', '<!--', '# nor this', '-->']))
  assert.deepEqual(r.findings.filter((f) => f.code === 'work-file-h1-unsupported').map((f) => [f.line, f.severity]), [[9, 'blocking']])
  assert.equal(r.ok, false)
  assert.equal(r.definition.intro, 'Intro words.')
  assert.equal(r.definition.steps.length, 1)
}
// Item 2: unknown poll type: blocking finding, pollType null; each real type reads as itself (section 3).
{
  const r = readWorkFile(file(['### Q {id=q}{poll=multi}']))
  assert.deepEqual(r.findings.map((f) => [f.code, f.severity, f.stepId, f.detail]), [['work-file-poll-unknown', 'blocking', 'q', 'multi']])
  assert.equal(r.definition.steps[0].pollType, null)
}
// Item 3: an invalid step id is null in the definition, the finding stays.
{
  const r = readWorkFile(file(['### A {id=Bad_Id}', 'x', '### B {id=ok-id}', 'y']))
  assert.deepEqual(r.definition.steps.map((s) => s.id), [null, 'ok-id'])
  const f = r.findings.find((x) => x.code === 'work-file-step-id-invalid')
  assert.deepEqual([f.stepId, f.detail, f.line], [null, 'Bad_Id', 7])
  const odd = readWorkFile(file(['### A {id=../../etc}', 'x']))
  assert.equal(odd.definition.steps[0].id, null)
  assert.ok(codes(odd).includes('work-file-step-id-invalid'))
}
// Item 4: {video} with no playable source is a warning; with a source it is not.
{
  const none = readWorkFile(file(['### V {id=v}{video}']))
  assert.deepEqual(none.findings.map((f) => [f.code, f.severity]), [['work-file-video-missing', 'warning']])
  assert.equal(none.ok, true)
  assert.equal(none.definition.steps[0].kind, 'video')
  assert.deepEqual(readWorkFile(file(['### V {id=v}{video}', 'https://youtu.be/dQw4w9WgXcQ'])).findings, [])
  assert.deepEqual(readWorkFile(file(['### V {id=v}{video}', '![](clip.mp4)'])).findings, [])
}
// Item 5: a 100k-space front matter line reads in under 100 ms.
{
  for (const head of [['id: f1', 'title: T' + ' '.repeat(100000) + '# note', 'revision: 1'], ['id: f1', 'title: T', 'revision: 1', ' '.repeat(100000)]]) {
    const started = performance.now()
    const r = readWorkFile(file(['### A {id=a}', 'x'], head))
    assert.ok(performance.now() - started < 100, 'slow front matter')
    assert.equal(r.definition.title, 'T')
  }
  assert.equal(readWorkFile(file(['### A {id=a}', 'x'], ['id: f1', 'title: "Has # inside"  # note', 'revision: 1'])).definition.title, 'Has # inside')
  assert.equal(readWorkFile(file(['### A {id=a}', 'x'], ['id: f1', 'title: C# basics', 'revision: 1'])).definition.title, 'C# basics')
}
// Item 6: only own front matter keys count; __proto__ is ignored.
{
  const r = readWorkFile(file(['### A {id=a}', 'x'], ['__proto__: {id: evil, title: Evil, revision: 9}', 'revision: 2']))
  assert.deepEqual([r.definition.id, r.definition.title, r.definition.revision], ['', '', 2])
  assert.deepEqual(codes(r).filter((c) => c.startsWith('work-file')), ['work-file-id-missing', 'work-file-title-missing'])
  assert.equal({}.id, undefined)
}
// Item 7: the hash covers the UTF-8 encoding of the text as passed in, BOM included.
{
  assert.equal(readWorkFile('\uFEFF' + EXAMPLE).hash, createHash('sha256').update('\uFEFF' + EXAMPLE, 'utf8').digest('hex'))
  assert.equal(readWorkFile('\uFEFF' + EXAMPLE).definition.id, 'research-teams-intake')
}
// Item 8: each finding's line is its own step's, duplicates included, token findings too.
{
  const r = readWorkFile(file(['### One {id=same}{task}{minutes=7}', 'a', '### Two {id=same}{task}{minutes=7}', 'b']))
  assert.deepEqual(r.findings.filter((f) => f.code === 'work-file-step-id-duplicate').map((f) => f.line), [7, 9])
  assert.deepEqual(r.findings.filter((f) => f.code === 'prework-minutes-invalid').map((f) => f.line), [7, 9])
}
// Item 9: a heading without an id takes prework.mjs's fallback id (no copy in the reader).
{
  const r = readWorkFile(file(['### Hello & World!', 'x']))
  assert.equal(r.definition.steps[0].id, 'hello-and-world')
  assert.deepEqual(codes(r), ['work-file-step-id-missing'])
}
console.log('work-file: ok')

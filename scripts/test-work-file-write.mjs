// Work-files ticket 07: the step-writing helpers (src/shared/work-file-write.ts) and the writer
// that puts a new work file into the vault (src/main/work-file-write.ts).
//   1. each Add kind (Slide, Video, Quick check, Task, Question with every poll type) writes text the
//      ticket 02 reader reads back as that kind, with a unique id, and no blocking finding the add itself caused;
//   2. a new file has id, title and revision 1, and NO steps unless a preset or an Add was chosen;
//   3. the "Survey what was learnt" preset fills two open questions only when chosen;
//   4. appending a step raises revision by one and keeps the rest of the text;
//   5. titles: slug, collision (file name and id), no letters, and a title that would escape the folder;
//   6. the writer stays inside Work files/ (a linked folder is refused, no overwrite).
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-work-file-write.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWorkFile } from '../src/shared/work-file.ts'
import {
  WORK_FILE_ADD_KINDS, WORK_FILE_POLL_TYPES, WORK_FILE_PRESETS, appendStep, bumpRevision, checkNewTitle, newWorkFileText, setStepLocal, slugForTitle, stepText,
} from '../src/shared/work-file-write.ts'
import { addWorkFileStep, createWorkFile, setWorkFileStepLocal } from '../src/main/work-file-write.ts'
import { POLL_TYPES } from '../compiler/scripts/lib/poll-authoring.mjs'

let n = 0
const t = (name, fn) => { fn(); n += 1; console.log(`PASS  ${name}`) }

// Every poll type the compiler knows is offered.
t('Question offers every existing poll type', () => {
  assert.deepEqual([...WORK_FILE_POLL_TYPES].sort(), [...POLL_TYPES].sort())
  assert.deepEqual([...WORK_FILE_ADD_KINDS].sort(), ['check', 'question', 'slide', 'task', 'video'])
})

const expectedKind = { slide: 'slide', video: 'video', check: 'check', task: 'task', question: 'question' }
const everyAdd = [
  { kind: 'slide' }, { kind: 'video' }, { kind: 'check' }, { kind: 'task' },
  ...WORK_FILE_POLL_TYPES.map((pollType) => ({ kind: 'question', pollType })),
]
const base = newWorkFileText({ id: 'demo', title: 'Demo' })

for (const add of everyAdd) {
  t(`Add ${add.kind}${add.pollType ? ' / ' + add.pollType : ''} reads back as that kind`, () => {
    const { text, id } = appendStep(base, add)
    const reading = readWorkFile(text)
    assert.equal(reading.definition.steps.length, 1)
    const step = reading.definition.steps[0]
    assert.equal(step.kind, expectedKind[add.kind])
    assert.equal(step.id, id)
    if (add.kind === 'question') assert.equal(step.pollType, add.pollType)
    // The only finding the step may bring is the honest "no video source yet" warning.
    const own = reading.findings.filter((f) => f.stepId !== null)
    assert.deepEqual(own.map((f) => f.code).filter((c) => !(add.kind === 'video' && c === 'work-file-video-missing')), [])
    assert.ok(own.every((f) => f.severity === 'warning'))
  })
}

t('ids stay unique when the same kind is added again and again', () => {
  let text = base
  for (let i = 0; i < 5; i += 1) text = appendStep(text, { kind: 'task' }).text
  for (const pollType of WORK_FILE_POLL_TYPES) text = appendStep(appendStep(text, { kind: 'question', pollType }).text, { kind: 'question', pollType }).text
  const ids = readWorkFile(text).definition.steps.map((s) => s.id)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(ids.length, 5 + WORK_FILE_POLL_TYPES.length * 2)
  assert.ok(!readWorkFile(text).findings.some((f) => f.code === 'work-file-step-id-duplicate'))
})

t('an added id avoids ids the author wrote', () => {
  const authored = newWorkFileText({ id: 'x', title: 'X' }) + '\n### Mine\n{id=task}{task}\n1. a\n'
  assert.equal(stepText({ kind: 'task' }, ['task', 'task-2']).id, 'task-3')
  assert.equal(appendStep(authored, { kind: 'task' }).id, 'task-2')
})

t('a new file has id, title, revision 1 and no steps or questions', () => {
  const text = newWorkFileText({ id: 'journal-club', title: 'Journal club' })
  const r = readWorkFile(text)
  assert.equal(r.definition.id, 'journal-club')
  assert.equal(r.definition.title, 'Journal club')
  assert.equal(r.revision, 1)
  assert.equal(r.definition.steps.length, 0)
  assert.ok(!/poll|###/.test(text))
})

t('the survey preset fills two open questions only when chosen', () => {
  const preset = WORK_FILE_PRESETS.find((p) => p.label === 'Survey what was learnt')
  assert.ok(preset)
  const chosen = readWorkFile(newWorkFileText({ id: 's', title: 'S', presetId: preset.id }))
  assert.deepEqual(chosen.definition.steps.map((s) => [s.kind, s.pollType]), [['question', 'open'], ['question', 'open']])
  assert.match(chosen.definition.steps[0].title, /learn/i)
  assert.match(chosen.definition.steps[1].title, /try/i)
  assert.equal(chosen.ok, true)
  for (const none of [undefined, null, '', 'blank']) assert.equal(readWorkFile(newWorkFileText({ id: 's', title: 'S', presetId: none })).definition.steps.length, 0)
  // No preset has a rating or any default feedback question.
  for (const p of WORK_FILE_PRESETS) assert.ok(p.steps.every((s) => s.poll === 'open'))
})

t('presets and Adds combine in order with unique ids', () => {
  const r = readWorkFile(newWorkFileText({ id: 's', title: 'S', presetId: 'survey-learnt', adds: [{ kind: 'question', pollType: 'open' }, { kind: 'task' }] }))
  assert.deepEqual(r.definition.steps.map((s) => s.kind), ['question', 'question', 'question', 'task'])
  assert.equal(new Set(r.definition.steps.map((s) => s.id)).size, 4)
})

t('appending raises revision by one and keeps the rest', () => {
  const start = '---\nid: a\ntitle: A\nrevision: 3\n---\n\nIntro stays.\n\n### One\n{id=one}\nHi\n'
  const { text } = appendStep(start, { kind: 'task' })
  assert.equal(readWorkFile(text).revision, 4)
  assert.ok(text.includes('Intro stays.') && text.includes('### One\n{id=one}\nHi\n'))
  assert.equal(readWorkFile(text).definition.steps.length, 2)
  assert.equal(readWorkFile(appendStep(text, { kind: 'slide' }).text).revision, 5)
})

t('revision bump: missing line added, non-integer left, CRLF and BOM kept', () => {
  assert.equal(readWorkFile(bumpRevision('---\nid: a\ntitle: A\n---\n')).revision, 1)
  assert.equal(bumpRevision('---\nid: a\nrevision: soon\n---\n'), '---\nid: a\nrevision: soon\n---\n')
  const crlf = '﻿---\r\nid: a\r\ntitle: A\r\nrevision: 1\r\n---\r\n\r\n### One\r\n{id=one}\r\n'
  const out = appendStep(crlf, { kind: 'check' }).text
  assert.ok(out.startsWith('﻿---\r\n') && !/[^\r]\n/.test(out.replace(/^﻿/, '')))
  assert.equal(readWorkFile(out).revision, 2)
  assert.equal(readWorkFile(out).definition.steps.length, 2)
})

t('titles: slug, quoting round-trips through the reader', () => {
  assert.equal(slugForTitle('Café: Post-work, 2026!'), 'cafe-post-work-2026')
  for (const title of ['Plain title', 'Why: a "question" # now', "Don't panic", '2026', 'Both "double" and \'single\'']) {
    const r = readWorkFile(newWorkFileText({ id: 'x', title }))
    assert.equal(r.definition.title.replace(/”/g, '"'), title, title)
  }
})

t('title checks name the reason', () => {
  assert.equal(checkNewTitle('  Session notes ', [], []).fileName, 'session-notes.md')
  assert.match(checkNewTitle('', []).error, /title/i)
  assert.match(checkNewTitle('!!! ???', []).error, /no letters or numbers/)
  assert.match(checkNewTitle('Session Notes', ['session-notes.md']).error, /already exists/)
  assert.match(checkNewTitle('SESSION notes', ['Session-Notes.MD']).error, /already exists/)
  assert.match(checkNewTitle('Session notes', [], ['session-notes']).error, /already has the id/)
  for (const evil of ['../../etc/passwd', '..', '/abs/path', 'a/../../b', '..\\..\\x']) {
    const c = checkNewTitle(evil, [])
    if (c.ok) assert.ok(/^[a-z0-9][a-z0-9-]*\.md$/.test(c.fileName), `${evil} -> ${c.fileName}`)
    else assert.ok(c.error.length > 0)
  }
})

const tmp = () => mkdtempSync(join(tmpdir(), 'tw-wf-write-'))

t('createWorkFile writes Work files/<slug>.md, makes the folder, never overwrites', () => {
  const vault = tmp()
  const made = createWorkFile(vault, { title: 'Research intake' })
  assert.deepEqual(made, { ok: true, fileName: 'research-intake.md', relPath: 'Work files/research-intake.md', id: 'research-intake' })
  const text = readFileSync(join(vault, 'Work files', 'research-intake.md'), 'utf8')
  assert.equal(readWorkFile(text).definition.steps.length, 0)
  assert.equal(readWorkFile(text).revision, 1)
  const again = createWorkFile(vault, { title: 'Research Intake' })
  assert.equal(again.ok, false)
  assert.match(again.error, /already exists/)
  assert.deepEqual(readdirSync(join(vault, 'Work files')), ['research-intake.md'])
})

t('createWorkFile refuses a repeated id and unknown presets or adds', () => {
  const vault = tmp()
  mkdirSync(join(vault, 'Work files'))
  writeFileSync(join(vault, 'Work files', 'old-name.md'), '---\nid: fresh-id\ntitle: Old\nrevision: 1\n---\n')
  assert.match(createWorkFile(vault, { title: 'Fresh id' }).error, /already has the id/)
  assert.equal(createWorkFile(vault, { title: 'Ok', presetId: 'default-feedback' }).ok, false)
  assert.equal(createWorkFile(vault, { title: 'Ok', adds: [{ kind: 'rating-1-5' }] }).ok, false)
  assert.equal(createWorkFile(vault, { title: 'Ok', adds: [{ kind: 'question', pollType: 'nonsense' }] }).ok, false)
  assert.deepEqual(readdirSync(join(vault, 'Work files')), ['old-name.md'])
})

t('createWorkFile with a preset and adds writes exactly those steps', () => {
  const vault = tmp()
  const made = createWorkFile(vault, { title: 'After the talk', presetId: 'survey-learnt', adds: [{ kind: 'question', pollType: 'ranking' }] })
  assert.equal(made.ok, true)
  const r = readWorkFile(readFileSync(join(vault, 'Work files', 'after-the-talk.md'), 'utf8'))
  assert.deepEqual(r.definition.steps.map((s) => s.pollType), ['open', 'open', 'ranking'])
})

t('createWorkFile refuses when Work files is a link out of the vault', () => {
  const vault = tmp(); const outside = tmp()
  symlinkSync(outside, join(vault, 'Work files'))
  const r = createWorkFile(vault, { title: 'Escape' })
  assert.equal(r.ok, false)
  assert.deepEqual(readdirSync(outside), [])
})

t('title that is a path never writes outside the folder', () => {
  const vault = tmp()
  const r = createWorkFile(vault, { title: '../../escape' })
  if (r.ok) assert.equal(r.relPath, 'Work files/escape.md')
  assert.ok(!existsSync(join(vault, '..', 'escape.md')) && !existsSync(join(vault, 'escape.md')))
})

t('addWorkFileStep appends, bumps revision and refuses names outside Work files', () => {
  const vault = tmp()
  createWorkFile(vault, { title: 'Grow' })
  const ok = addWorkFileStep(vault, 'grow.md', { kind: 'question', pollType: 'open' })
  assert.equal(ok.ok, true)
  const r = readWorkFile(readFileSync(join(vault, 'Work files', 'grow.md'), 'utf8'))
  assert.equal(r.revision, 2)
  assert.deepEqual(r.definition.steps.map((s) => s.kind), ['question'])
  for (const bad of ['../x.md', 'sub/x.md', '.hidden.md', 'grow.txt', '', null]) assert.equal(addWorkFileStep(vault, bad, { kind: 'task' }).ok, false, String(bad))
  assert.equal(addWorkFileStep(vault, 'missing.md', { kind: 'task' }).ok, false)
  assert.equal(addWorkFileStep(vault, 'grow.md', { kind: 'rating' }).ok, false)
  assert.equal(readWorkFile(readFileSync(join(vault, 'Work files', 'grow.md'), 'utf8')).revision, 2)
})

t('addWorkFileStep leaves no temp file behind after a successful write', () => {
  const vault = tmp()
  createWorkFile(vault, { title: 'Clean' })
  assert.equal(addWorkFileStep(vault, 'clean.md', { kind: 'task' }).ok, true)
  assert.deepEqual(readdirSync(join(vault, 'Work files')).filter((f) => f.includes('.tmp-')), [])
  assert.deepEqual(readdirSync(join(vault, 'Work files')), ['clean.md'])
})
// Where a step's answer goes (2026-10-19 prework-responses design): {local} written and taken out.
const ROUTES = ['---', 'id: routes', 'title: Routes', 'revision: 3', '---', '',
  '### Watch {id=watch}{video}', '![](https://youtu.be/dQw4w9WgXcQ)', '',
  '### Try a prompt', '{id=try}{task}{minutes=20}', '', '1. Pick a paper', '',
  '### Hopes {id=hopes}{poll=open}', '',
  '### Split', '{id=split}', '{poll=single}{check}', '', '- A {right}', '- B', ''].join('\n')
const localOf = (text) => Object.fromEntries(readWorkFile(text).definition.steps.map((step) => [step.id, step.local === true]))

t('setStepLocal writes {local} on the token line (or the heading) and takes it out again, raising the revision', () => {
  const on = setStepLocal(ROUTES, 'try', true)
  assert.equal(on.ok && on.changed, true)
  assert.match(on.text, /^\{id=try\}\{task\}\{minutes=20\}\{local\}$/m, 'at the end of the step\'s token line')
  assert.deepEqual(localOf(on.text), { watch: false, try: true, hopes: false, split: false })
  assert.equal(readWorkFile(on.text).revision, 4)
  const heading = setStepLocal(on.text, 'hopes', true)
  assert.match(heading.text, /^### Hopes \{id=hopes\}\{poll=open\}\{local\}$/m, 'a step with its tokens on the heading gets it there')
  const split = setStepLocal(heading.text, 'split', true)
  assert.match(split.text, /^\{poll=single\}\{check\}\{local\}$/m, 'the last of several token lines')
  const off = setStepLocal(split.text, 'try', false)
  assert.match(off.text, /^\{id=try\}\{task\}\{minutes=20\}$/m)
  assert.deepEqual(localOf(off.text), { watch: false, try: false, hopes: true, split: true })
  // Only the token moved: the rest of the text is as it was.
  const back = setStepLocal(setStepLocal(off.text, 'hopes', false).text, 'split', false)
  assert.equal(back.text.replace(/revision: \d+/, ''), ROUTES.replace(/revision: \d+/, ''))
})

t('setStepLocal: a token line that held only {local} goes; a step already so is unchanged; a slide or an unknown step is refused', () => {
  const alone = ROUTES.replace('{id=try}{task}{minutes=20}', '{id=try}{task}{minutes=20}\n{local}')
  assert.equal(localOf(alone).try, true)
  const off = setStepLocal(alone, 'try', false)
  assert.ok(!/local/i.test(off.text.split('### Hopes')[0].split('### Try a prompt')[1]), 'the line is removed')
  assert.deepEqual(setStepLocal(ROUTES, 'hopes', false), { ok: true, text: ROUTES, changed: false })
  assert.equal(setStepLocal(ROUTES, 'watch', true).ok, false, 'a video carries no answer')
  assert.equal(setStepLocal(ROUTES, 'gone', true).ok, false)
})

t('setWorkFileStepLocal writes inside Work files/ only, checks its input, and leaves an unchanged file untouched', () => {
  const vault = tmp()
  mkdirSync(join(vault, 'Work files'), { recursive: true })
  writeFileSync(join(vault, 'Work files', 'routes.md'), ROUTES)
  assert.equal(setWorkFileStepLocal(vault, 'routes.md', 'try', true).ok, true)
  assert.equal(localOf(readFileSync(join(vault, 'Work files', 'routes.md'), 'utf8')).try, true)
  for (const bad of [[ '../x.md', 'try', true ], ['routes.md', '', true], ['routes.md', 'try', 'yes'], ['routes.md', 'watch', true]]) {
    assert.equal(setWorkFileStepLocal(vault, ...bad).ok, false, JSON.stringify(bad))
  }
  const before = readFileSync(join(vault, 'Work files', 'routes.md'), 'utf8')
  assert.equal(setWorkFileStepLocal(vault, 'routes.md', 'try', true).ok, true)
  assert.equal(readFileSync(join(vault, 'Work files', 'routes.md'), 'utf8'), before, 'asked for what it already says: not rewritten')
  assert.deepEqual(readdirSync(join(vault, 'Work files')), ['routes.md'])
})

// Not covered: a forced failure after the temp write (e.g. a read-only folder). Making the folder read-only
// stops the temp write before it exists, so it proves nothing about cleanup; left out rather than faked.

console.log(`\n${n} passed`)

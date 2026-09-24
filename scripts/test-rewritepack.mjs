import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildTalkTextModel } from '../src/main/talkText.ts'
import {
  approvePart,
  approvedPartsInOrder,
  emptyNotesStore,
  listParts,
  readNotesStore,
  renderPromptTemplate,
  renderStructureJson,
  renderTranscriptMarkdown,
  resolveInstructionsDir,
  slugify,
  unapprovePart,
  writeNotesStore,
  writeRewritePack
} from '../src/main/rewritePack.ts'

const root = mkdtempSync(join(tmpdir(), 'talkweaver-rewritepack-'))
const instructionsDir = join(root, 'source-instructions')
mkdirSync(instructionsDir, { recursive: true })
writeFileSync(join(instructionsDir, 'AGENT-INSTRUCTIONS.md'), '# Agent instructions\n')
writeFileSync(join(instructionsDir, 'narrative-format.md'), '# Narrative format\n')

const model = buildTalkTextModel({
  rows: [
    { slideId: 's1', title: 'Opening', headingPath: ['Part One: Why?'] },
    {
      slideId: 's2',
      title: 'The method',
      headingPath: ['Part One: Why?', 'Method'],
      markdown: '## The method\n\n![Process diagram](images/process.png)',
      images: [{ src: 'images/process.png', alt: 'Process diagram', ocrText: 'Collect · connect · present' }]
    },
    { slideId: 's3', title: 'Silent close', headingPath: ['Closing'] }
  ],
  slideTimeIndex: [
    { event: 'enter', slideId: 's1', tMs: 0 },
    { event: 'enter', slideId: 's2', tMs: 5000 },
    { event: 'enter', slideId: 's3', tMs: 10000 }
  ],
  segments: [
    { start: 100, end: 800, text: 'Welcome to the talk.' },
    { start: 5200, end: 6100, text: 'This is the method.' }
  ],
  meta: {
    talkSlug: 'weaving-talks',
    talkTitle: 'Weaving Talks',
    speaker: 'Dominik Lukeš',
    event: 'Oxford AI Forum',
    date: '2026-07-16',
    recordedMs: 15000
  }
})

assert.equal(slugify('  Part One: Why?  '), 'part-one-why')
assert.equal(slugify('***'), 'section')
assert.equal(resolveInstructionsDir({ resourcesPath: '/Applications/TalkWeaver.app/Contents/Resources' }), '/Applications/TalkWeaver.app/Contents/Resources/agent-rewrite/instructions')
assert.equal(resolveInstructionsDir({ devRoot: '/repo/talk-weaver' }), '/repo/talk-weaver/resources/agent-rewrite/instructions')

const renderedPrompt = renderPromptTemplate(
  '{{TALK_TITLE}} / {{TALK_TITLE}} / {{SPEAKER_NAME}} / {{EVENT}} / {{DATE}} / {{FIRST_SECTION_SLUG}}',
  { talkTitle: 'Weaving Talks', firstSectionSlug: 'part-one-why' }
)
assert.equal(renderedPrompt, 'Weaving Talks / Weaving Talks /  /  /  / part-one-why')

const transcript = renderTranscriptMarkdown(model)
assert.match(transcript, /^# Transcript — Weaving Talks$/m)
assert.match(transcript, /^Dominik Lukeš · Oxford AI Forum · 2026-07-16$/m)
assert.match(transcript, /^# Transcript — Weaving Talks\nDominik Lukeš · Oxford AI Forum · 2026-07-16\n\n## Slide 1 —/)
assert.match(transcript, /^## Slide 1 — Opening  ·  00:00–00:05$/m)
assert.match(transcript, /Welcome to the talk\./)
assert.match(transcript, /^## Slide 3 — Silent close  ·  00:10–00:15\n\n\(no transcript for this slide\)$/m)
assert.deepEqual(JSON.parse(renderStructureJson(model)), model)

const promptTemplate = [
  '# {{TALK_TITLE}}',
  'Pack: {{PACK_PATH}}',
  'Speaker: {{SPEAKER_NAME}}',
  'Event: {{EVENT}}',
  'Date: {{DATE}}',
  'Start: parts/01-{{FIRST_SECTION_SLUG}}.md'
].join('\n')
const packDir = join(root, 'agent-rewrite', 'run-123')
const result = writeRewritePack({ packDir, model, promptTemplate, instructionsDir })
assert.equal(result.packDir, packDir)
assert.equal(result.partsDir, join(packDir, 'parts'))
assert.deepEqual(result.files, [
  join(packDir, 'PROMPT.md'),
  join(packDir, 'transcript.md'),
  join(packDir, 'structure.json')
])

const prompt = readFileSync(join(packDir, 'PROMPT.md'), 'utf8')
assert.match(prompt, /Weaving Talks/)
assert.match(prompt, /agent-rewrite\/run-123/)
assert.doesNotMatch(prompt, /{{TALK_TITLE}}|{{PACK_PATH}}|{{SPEAKER_NAME}}|{{FIRST_SECTION_SLUG}}/)
assert.match(readFileSync(join(packDir, 'transcript.md'), 'utf8'), /## Slide 1 —/)
assert.equal(JSON.parse(readFileSync(join(packDir, 'structure.json'), 'utf8')).slides.length, model.slides.length)
assert.equal(readFileSync(join(packDir, 'instructions', 'AGENT-INSTRUCTIONS.md'), 'utf8'), '# Agent instructions\n')
assert.match(readFileSync(join(packDir, 'AGENTS.md'), 'utf8'), /This folder is one Run's rewrite pack/)
assert.match(readFileSync(join(packDir, 'AGENTS.md'), 'utf8'), /cleaned\.json.*notes\.json.*never create, edit, or delete/s)
assert.equal(readFileSync(join(packDir, 'CLAUDE.md'), 'utf8'), '@./AGENTS.md')
assert.ok(existsSync(join(packDir, 'parts')))

const missingInstructionsPack = join(root, 'missing-instructions-pack')
assert.doesNotThrow(() => writeRewritePack({
  packDir: missingInstructionsPack,
  model,
  promptTemplate,
  instructionsDir: join(root, 'does-not-exist')
}))
assert.ok(existsSync(join(missingInstructionsPack, 'instructions', 'NOTE.md')))

for (const leaf of ['PROMPT.md', 'transcript.md', 'structure.json', 'AGENTS.md', 'CLAUDE.md']) {
  const outsidePath = join(root, `outside-${leaf}`)
  const symlinkPack = join(root, `symlink-${leaf}`)
  mkdirSync(symlinkPack)
  writeFileSync(outsidePath, 'outside must stay unchanged')
  symlinkSync(outsidePath, join(symlinkPack, leaf))
  assert.throws(
    () => writeRewritePack({ packDir: symlinkPack, model, promptTemplate, instructionsDir }),
    /pack-file-symlink-refused/
  )
  assert.equal(readFileSync(outsidePath, 'utf8'), 'outside must stay unchanged')
}

writeFileSync(join(result.partsDir, '02-body.md'), 'Body markdown\n')
writeFileSync(join(result.partsDir, '01-intro.md'), 'Intro markdown\n')
writeFileSync(join(result.partsDir, 'ignore.txt'), 'Ignore this\n')
assert.deepEqual(listParts(result.partsDir), [
  { slug: 'intro', order: 1, fileName: '01-intro.md', markdown: 'Intro markdown\n' },
  { slug: 'body', order: 2, fileName: '02-body.md', markdown: 'Body markdown\n' }
])
assert.deepEqual(listParts(join(root, 'missing-parts')), [])

const empty = emptyNotesStore()
const intro = { slug: 'intro', order: 20, markdown: 'Intro approved', approvedAt: '2026-07-16T09:00:00Z' }
const body = { slug: 'body', order: 10, markdown: 'Body approved', approvedAt: '2026-07-16T09:01:00Z' }
const withIntro = approvePart(empty, intro)
assert.deepEqual(empty, { approved: {} })
assert.notEqual(withIntro, empty)
assert.deepEqual(withIntro.approved.intro, intro)

const withBoth = approvePart(withIntro, body)
assert.deepEqual(approvedPartsInOrder(withBoth), [body, intro])
const withTiedOrder = approvePart(withBoth, {
  slug: 'appendix',
  order: 20,
  markdown: 'Appendix approved',
  approvedAt: '2026-07-16T09:02:00Z'
})
assert.deepEqual(approvedPartsInOrder(withTiedOrder).map((part) => part.slug), ['body', 'appendix', 'intro'])
const withoutIntro = unapprovePart(withBoth, 'intro')
assert.deepEqual(Object.keys(withBoth.approved).sort(), ['body', 'intro'])
assert.deepEqual(withoutIntro, { approved: { body } })
assert.notEqual(withoutIntro, withBoth)

const notesPath = join(root, 'notes', 'session.notes.json')
assert.deepEqual(readNotesStore(notesPath), emptyNotesStore())
writeFileSync(join(root, 'invalid-notes.json'), '{not-json')
assert.throws(() => readNotesStore(join(root, 'invalid-notes.json')), /Unexpected token|JSON/)
writeFileSync(join(root, 'invalid-notes-shape.json'), '{}')
assert.throws(() => readNotesStore(join(root, 'invalid-notes-shape.json')), /approval-store-schema-invalid/)
writeNotesStore(notesPath, withBoth)
assert.deepEqual(readNotesStore(notesPath), withBoth)

console.log('rewritepack: pack files, instructions fallback, parts listing and notes store passed')

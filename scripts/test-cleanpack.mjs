import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTalkTextModel } from '../src/main/talkText.ts'
import {
  approveCleaned,
  approvedCleanedInOrder,
  emptyCleanedStore,
  listCleanedDrafts,
  readCleanedStore,
  renderCleanPrompt,
  resolveCleanTemplate,
  unapproveCleaned,
  writeCleanedStore,
  writeCleanPack
} from '../src/main/rewritePack.ts'

const root = mkdtempSync(join(tmpdir(), 'talkweaver-cleanpack-'))
const instructionsDir = join(root, 'source-instructions')
mkdirSync(instructionsDir, { recursive: true })
writeFileSync(join(instructionsDir, 'clean-format.md'), '# Clean faithfully\n')

const model = buildTalkTextModel({
  rows: [
    { slideId: 's1', title: 'Opening', headingPath: ['Part One'] },
    { slideId: 's2', title: 'Method', headingPath: ['Part One', 'Method'] }
  ],
  slideTimeIndex: [
    { event: 'enter', slideId: 's1', tMs: 0 },
    { event: 'enter', slideId: 's2', tMs: 5000 }
  ],
  segments: [
    { start: 100, end: 800, text: 'um welcome.' },
    { start: 5200, end: 6100, text: 'the method.' }
  ],
  meta: { talkSlug: 'weaving-talks', talkTitle: 'Weaving Talks', recordedMs: 10000 }
})

assert.equal(
  resolveCleanTemplate({ resourcesPath: '/Applications/TalkWeaver.app/Contents/Resources' }),
  '/Applications/TalkWeaver.app/Contents/Resources/agent-rewrite/CLEAN.template.md'
)
assert.equal(
  resolveCleanTemplate({ devRoot: '/repo/talk-weaver' }),
  '/repo/talk-weaver/resources/agent-rewrite/CLEAN.template.md'
)

const template = '# Clean {{TALK_TITLE}}\n\nPack: {{PACK_PATH}}\n\n{{MODE_INSTRUCTIONS}}\n'
for (const modeInstructions of [
  'Work section by section.',
  'Work in one pass.',
  'Clean ONLY these slides: 2, 5.'
]) {
  const rendered = renderCleanPrompt(template, {
    talkTitle: 'Weaving Talks',
    packPath: 'agent-rewrite/run-123',
    modeInstructions
  })
  assert.equal(rendered, `# Clean Weaving Talks\n\nPack: agent-rewrite/run-123\n\n${modeInstructions}\n`)
  assert.doesNotMatch(rendered, /{{[A-Z_]+}}/)
}
assert.throws(
  () => renderCleanPrompt(`${template}\n{{UNKNOWN}}`, {
    talkTitle: 'Talk',
    packPath: 'agent-rewrite/run-123',
    modeInstructions: 'One pass'
  }),
  /clean-prompt-placeholder-unresolved:UNKNOWN/
)

const packDir = join(root, 'agent-rewrite', 'run-123')
const result = writeCleanPack({
  packDir,
  model,
  cleanTemplate: template,
  instructionsDir,
  modeInstructions: 'Work in one pass.'
})
assert.equal(result.packDir, packDir)
assert.equal(result.cleanedDir, join(packDir, 'cleaned'))
assert.deepEqual(result.files, [
  join(packDir, 'CLEAN.md'),
  join(packDir, 'transcript.md'),
  join(packDir, 'structure.json')
])
assert.equal(readFileSync(join(packDir, 'CLEAN.md'), 'utf8'), `# Clean Weaving Talks\n\nPack: ${packDir}\n\nWork in one pass.\n`)
assert.match(readFileSync(join(packDir, 'transcript.md'), 'utf8'), /## Slide 1 — Opening/)
assert.equal(JSON.parse(readFileSync(join(packDir, 'structure.json'), 'utf8')).slides.length, 2)
assert.equal(readFileSync(join(packDir, 'instructions', 'clean-format.md'), 'utf8'), '# Clean faithfully\n')
assert.match(readFileSync(join(packDir, 'AGENTS.md'), 'utf8'), /This folder is one Run's rewrite pack/)
assert.match(readFileSync(join(packDir, 'AGENTS.md'), 'utf8'), /follow `instructions\/clean-format\.md`/i)
assert.equal(readFileSync(join(packDir, 'CLAUDE.md'), 'utf8'), '@./AGENTS.md')
assert.ok(existsSync(result.cleanedDir))

writeFileSync(join(packDir, 'transcript.md'), 'keep existing transcript')
writeCleanPack({ packDir, model, cleanTemplate: template, instructionsDir, modeInstructions: 'A new mode.' })
assert.equal(readFileSync(join(packDir, 'transcript.md'), 'utf8'), 'keep existing transcript')
assert.match(readFileSync(join(packDir, 'CLEAN.md'), 'utf8'), /A new mode\./)

for (const leaf of ['CLEAN.md', 'AGENTS.md', 'CLAUDE.md']) {
  const outsideCleanPath = join(root, `outside-${leaf}`)
  const symlinkCleanPack = join(root, `symlink-clean-pack-${leaf}`)
  mkdirSync(symlinkCleanPack)
  writeFileSync(outsideCleanPath, 'outside must stay unchanged')
  symlinkSync(outsideCleanPath, join(symlinkCleanPack, leaf))
  assert.throws(
    () => writeCleanPack({ packDir: symlinkCleanPack, model, cleanTemplate: template, instructionsDir, modeInstructions: 'One pass.' }),
    /pack-file-symlink-refused/
  )
  assert.equal(readFileSync(outsideCleanPath, 'utf8'), 'outside must stay unchanged')
}

writeFileSync(join(result.cleanedDir, 'slide-10.md'), 'Tenth slide\n')
writeFileSync(join(result.cleanedDir, 'slide-2.md'), 'Second slide\n')
writeFileSync(join(result.cleanedDir, 'slide-x.md'), 'Ignore\n')
writeFileSync(join(result.cleanedDir, 'notes.txt'), 'Ignore\n')
assert.deepEqual(listCleanedDrafts(result.cleanedDir), [
  { slideNumber: 2, fileName: 'slide-2.md', markdown: 'Second slide\n' },
  { slideNumber: 10, fileName: 'slide-10.md', markdown: 'Tenth slide\n' }
])
assert.deepEqual(listCleanedDrafts(join(root, 'missing-cleaned')), [])

const empty = emptyCleanedStore()
const tenth = { slideNumber: 10, markdown: 'Approved tenth', approvedAt: '2026-07-16T10:00:00Z' }
const second = { slideNumber: 2, markdown: 'Approved second', approvedAt: '2026-07-16T10:01:00Z' }
const withTenth = approveCleaned(empty, tenth)
assert.deepEqual(empty, { approved: {} })
assert.deepEqual(withTenth.approved['10'], tenth)
const withBoth = approveCleaned(withTenth, second)
assert.deepEqual(approvedCleanedInOrder(withBoth), [second, tenth])
assert.deepEqual(unapproveCleaned(withBoth, 10), { approved: { '2': second } })

const storePath = join(root, 'stores', 'session.cleaned.json')
assert.deepEqual(readCleanedStore(storePath), emptyCleanedStore())
writeCleanedStore(storePath, withBoth)
assert.deepEqual(readCleanedStore(storePath), withBoth)
writeFileSync(join(root, 'invalid-store.json'), '{not json')
assert.throws(() => readCleanedStore(join(root, 'invalid-store.json')), /Unexpected token|JSON/)

console.log('cleanpack: prompt modes, pack files, cleaned drafts and approval store passed')

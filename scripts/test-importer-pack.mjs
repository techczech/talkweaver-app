import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunStorage, loadRun } from '../src/main/importer/storage.ts'
import { applyImportSuggestion, readImportSuggestions, writeImportCleanupPack } from '../src/main/importer/pack.ts'

const root = mkdtempSync(join(tmpdir(), 'talkweaver-importer-pack-'))
const talkDir = join(root, 'talk')
const runDir = join(talkDir, 'import-runs', 'run-1')
const outlinePath = join(talkDir, 'talk-outline.md')
const now = '2026-07-18T12:00:00.000Z'
const sourceHash = 'abcdef123456abcdef123456abcdef123456'

const sourceFor = (slideNumber, title) => ({
  slideNumber, hidden: false, title, paragraphs: [title], notes: '', warnings: [],
  shapes: [{ kind: 'text', id: '1', name: 'Title', placeholder: 'title', paragraphs: [title], geometry: null, zIndex: 1, hyperlinks: [] }]
})
const recordFor = (slideNumber, title, status = 'converted') => {
  const sourceId = `pptx-${sourceHash.slice(0, 12)}-${String(slideNumber).padStart(3, '0')}`
  const candidateMarkdown = `### ${title}\n{id=${sourceId}} {statement}`
  return {
    slideNumber, title, hidden: false, status, warnings: status === 'review' ? ['composition-ambiguous'] : [],
    source: sourceFor(slideNumber, title),
    decision: {
      sourceId, slideNumber, ruleset: 'talkweaver-import/1', status, layout: 'statement', title,
      basis: ['fixture'], warnings: status === 'review' ? ['composition-ambiguous'] : [], candidateMarkdown,
      fallbackMarkdown: `### ${title}\n{id=${sourceId}} {media}\n\n![Original](assets/original-${String(slideNumber).padStart(3, '0')}.png)`,
      representation: 'candidate'
    },
    originalPath: join(runDir, 'slides', String(slideNumber).padStart(3, '0'), 'original.png')
  }
}
const records = [recordFor(1, 'Opening'), recordFor(2, 'Difficult slide', 'review')]
const sourceMediaDir = join(root, 'source-media')
mkdirSync(sourceMediaDir, { recursive: true })
const sourceVideo = join(sourceMediaDir, 'clip.mp4')
const sourcePoster = join(sourceMediaDir, 'clip.png')
writeFileSync(sourceVideo, 'fixture video')
writeFileSync(sourcePoster, 'fixture poster')
records[0].source.shapes.push({
  kind: 'video', id: '2', name: 'Clip', placeholder: null,
  mediaPath: sourceVideo, mediaName: 'clip.mp4', posterPath: sourcePoster, posterName: 'clip.png',
  geometry: null, zIndex: 2, hyperlinks: []
})
const manifest = {
  schemaVersion: 1, rulesetVersion: 'talkweaver-import/1', id: 'run-1', createdAt: now, updatedAt: now, status: 'review',
  source: { path: '/source/talk.pptx', fileName: 'talk.pptx', hash: sourceHash, bytes: 10, slideCount: 2, width: 100, height: 50 },
  options: { title: 'Talk', slug: 'talk', slideRange: '', includeHidden: true, preserveNotes: true, extractMedia: true, fallbackPolicy: 'uncertain', renderer: 'automatic' },
  talk: { title: 'Talk', slug: 'talk', path: talkDir, outlinePath },
  progress: { completedOperation: 'outline', completedSlide: 2, completed: 2, total: 2, note: 'Ready' },
  renderer: { name: 'libreoffice', status: 'ready', officePath: '/soffice', rasterPath: '/pdftoppm', officeVersion: 'fixture', rasterVersion: 'fixture' },
  slides: records.map((record) => ({ slideNumber: record.slideNumber, title: record.title, hidden: false, status: record.status, warnings: record.warnings }))
}
createRunStorage(runDir, manifest, records)
for (const number of [1, 2]) {
  const path = join(runDir, 'slides', String(number).padStart(3, '0'), 'original.png')
  writeFileSync(path, `render ${number}`)
}

const resourcesDir = join(root, 'resources')
mkdirSync(join(resourcesDir, 'instructions'), { recursive: true })
writeFileSync(join(resourcesDir, 'PROMPT.template.md'), '# Clean {{TALK_TITLE}}\n\nPack: {{PACK_PATH}}\n\nPasses: {{PASSES}}\n')
writeFileSync(join(resourcesDir, 'instructions', 'cleanup-rubric.md'), '# Cleanup rubric\n')
writeFileSync(join(resourcesDir, 'instructions', 'data-formats.md'), '# Data formats\n')

const packDir = writeImportCleanupPack({
  runDir, packId: 'pack-1', slideNumbers: [1, 2], passes: ['structural-parity', 'layout-repair'], resourcesDir, createdAt: now
})
assert.equal(packDir, join(runDir, 'agent-cleanup', 'pack-1'))
assert.equal(readFileSync(join(packDir, 'CLAUDE.md'), 'utf8'), '@./AGENTS.md')
assert.match(readFileSync(join(packDir, 'AGENTS.md'), 'utf8'), /Write only inside `suggestions\/`/)
assert.match(readFileSync(join(packDir, 'PROMPT.md'), 'utf8'), /Clean Talk/)
assert.ok(existsSync(join(packDir, 'slides', '001', 'source.json')))
assert.ok(existsSync(join(packDir, 'slides', '001', 'decision.json')))
assert.ok(existsSync(join(packDir, 'slides', '001', 'current.md')))
assert.ok(existsSync(join(packDir, 'slides', '001', 'original.png')))
assert.ok(existsSync(join(packDir, 'slides', '001', 'assets', 'clip.mp4')))
assert.ok(existsSync(join(packDir, 'slides', '001', 'assets', 'clip.png')))
assert.ok(existsSync(join(packDir, 'instructions', 'cleanup-rubric.md')))
assert.deepEqual(readImportSuggestions(packDir), { suggestions: [], errors: [] })

writeFileSync(join(packDir, 'suggestions', 'slide-001.json'), JSON.stringify({
  slideNumber: 1, category: 'layout', evidence: ['original.png', 'decision.json'], rationale: 'The source is a claim.',
  markdown: '### Opening improved\n{id=pptx-abcdef123456-001} {statement}', sourcePreserving: true
}))
writeFileSync(join(packDir, 'suggestions', 'slide-999.json'), JSON.stringify({
  slideNumber: 999, category: 'layout', evidence: ['source.json'], rationale: 'Unknown slide', markdown: '### Wrong', sourcePreserving: true
}))
writeFileSync(join(packDir, 'suggestions', 'slide-002.json'), JSON.stringify({
  slideNumber: 2, category: 'layout', evidence: [], rationale: 'Missing evidence', markdown: '### Difficult', sourcePreserving: true
}))
writeFileSync(join(packDir, 'suggestions', 'evil.json'), JSON.stringify({
  slideNumber: 1, category: 'layout', evidence: ['source.json'], rationale: 'Wrong filename', markdown: '### Evil', sourcePreserving: true
}))
writeFileSync(join(packDir, 'suggestions', 'slide-003.json'), JSON.stringify({
  slideNumber: 3, category: 'layout', evidence: ['source.json'], rationale: 'Bad markdown type', markdown: 42, sourcePreserving: true
}))

const returned = readImportSuggestions(packDir)
assert.equal(returned.suggestions.length, 1)
assert.equal(returned.suggestions[0].slideNumber, 1)
assert.equal(returned.errors.length, 4)
applyImportSuggestion(runDir, packDir, 1, now)
assert.match(loadRun(runDir).outlineContent, /Opening improved/)

const outside = join(root, 'outside-agents.md')
writeFileSync(outside, 'outside unchanged')
const unsafePack = join(runDir, 'agent-cleanup', 'unsafe-pack')
mkdirSync(unsafePack, { recursive: true })
symlinkSync(outside, join(unsafePack, 'AGENTS.md'))
assert.throws(() => writeImportCleanupPack({
  runDir, packId: 'unsafe-pack', slideNumbers: [1], passes: ['structural-parity'], resourcesDir, createdAt: now
}), /importer-file-symlink-refused/)
assert.equal(readFileSync(outside, 'utf8'), 'outside unchanged')

console.log('importer pack: exact agent files, evidence, suggestions and symlink safety passed')

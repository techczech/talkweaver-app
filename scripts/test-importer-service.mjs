import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getImportRun, listImportRuns, originalSlideDataUrl, resumeImport, startImport } from '../src/main/importer/service.ts'

const root = mkdtempSync(join(tmpdir(), 'talkweaver-importer-service-'))
const vaultRoot = join(root, 'vault')
const sourcePath = join(root, 'source.pptx')
mkdirSync(vaultRoot, { recursive: true })
writeFileSync(sourcePath, 'fixture pptx')
const progress = []

const fakeExtract = async (_sourcePath, outputDir) => {
  const media = join(outputDir, 'package', 'ppt', 'media', 'image1.png')
  const video = join(outputDir, 'package', 'ppt', 'media', 'media1.mp4')
  const poster = join(outputDir, 'package', 'ppt', 'media', 'poster1.png')
  mkdirSync(join(outputDir, 'package', 'ppt', 'media'), { recursive: true })
  writeFileSync(media, 'image')
  writeFileSync(video, 'fixture video')
  writeFileSync(poster, 'fixture poster')
  const title = (slideNumber, value) => ({ kind: 'text', id: '1', name: 'Title', placeholder: 'title', paragraphs: [value], geometry: null, zIndex: 1, hyperlinks: [] })
  return {
    source: { path: sourcePath, fileName: 'source.pptx', hash: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef', bytes: 12, slideCount: 2, width: 100, height: 50 },
    packageDir: join(outputDir, 'package'),
    slides: [
      { slideNumber: 1, hidden: false, title: 'Opening', paragraphs: ['Opening'], notes: 'Opening note', shapes: [title(1, 'Opening')], warnings: [] },
      { slideNumber: 2, hidden: false, title: 'Workbench', paragraphs: ['Workbench', 'Collect evidence'], notes: '', shapes: [
        title(2, 'Workbench'),
        { kind: 'text', id: '2', name: 'Body', placeholder: 'body', paragraphs: ['Collect evidence'], geometry: null, zIndex: 2, hyperlinks: [] },
        { kind: 'picture', id: '3', name: 'Diagram', placeholder: null, mediaPath: media, mediaName: 'image1.png', geometry: null, zIndex: 3, hyperlinks: [] },
        { kind: 'video', id: '4', name: 'Demonstration', placeholder: null, mediaPath: video, mediaName: 'media1.mp4', posterPath: poster, posterName: 'poster1.png', geometry: null, zIndex: 4, hyperlinks: [] }
      ], warnings: [] }
    ]
  }
}

const fakeRender = async (_sourcePath, runDir, slideCount) => {
  const files = []
  for (let number = 1; number <= slideCount; number += 1) {
    const slideDir = join(runDir, 'slides', String(number).padStart(3, '0'))
    mkdirSync(slideDir, { recursive: true })
    const file = join(slideDir, 'original.png')
    writeFileSync(file, `render ${number}`)
    files.push(file)
  }
  return {
    renderer: { name: 'libreoffice', status: 'ready', officePath: '/soffice', rasterPath: '/pdftoppm', officeVersion: 'fixture', rasterVersion: 'fixture' },
    files
  }
}

const result = await startImport({
  vaultRoot,
  request: {
    sourcePath,
    options: { title: 'Research Talk', slug: 'research-talk', topicFolder: 'York', slideRange: '', includeHidden: true, preserveNotes: true, extractMedia: true, fallbackPolicy: 'uncertain', renderer: 'automatic' }
  },
  onProgress: (event) => progress.push(event),
  dependencies: {
    extractPptx: fakeExtract,
    renderOriginalSlides: fakeRender,
    createId: () => 'run-fixture',
    now: () => '2026-07-18T12:00:00.000Z'
  }
})

assert.equal(result.manifest.id, 'run-fixture')
assert.equal(result.manifest.status, 'review')
assert.equal(result.slides.length, 2)
assert.ok(existsSync(result.manifest.talk.outlinePath))
assert.match(result.outlineContent, /Opening note/)
assert.match(result.outlineContent, /assets\/img-/)
const videoReference = result.outlineContent.match(/assets\/(vid-[a-f0-9]{16})\.mp4/)
assert.ok(videoReference, 'Outline must reference the copied video, not only its poster')
assert.ok(existsSync(join(result.manifest.talk.path, 'assets', `${videoReference[1]}.mp4`)))
assert.ok(existsSync(join(result.manifest.talk.path, 'assets', `${videoReference[1]}.png`)))
assert.deepEqual([...new Set(progress.map((event) => event.status))], ['extracting', 'rendering', 'review'])

const listed = listImportRuns(vaultRoot)
assert.equal(listed.length, 1)
assert.equal(listed[0].id, 'run-fixture')
assert.equal(getImportRun(vaultRoot, 'run-fixture').manifest.talk.title, 'Research Talk')
assert.match(originalSlideDataUrl(vaultRoot, 'run-fixture', 1), /^data:image\/png;base64,/)
assert.match(readFileSync(result.manifest.talk.outlinePath, 'utf8'), /pptx-1234567890ab-001/)

const failureVault = join(root, 'failure-vault')
mkdirSync(failureVault, { recursive: true })
await assert.rejects(() => startImport({
  vaultRoot: failureVault,
  request: {
    sourcePath,
    options: { title: 'Recoverable Talk', slug: 'recoverable-talk', slideRange: '', includeHidden: true, preserveNotes: true, extractMedia: true, fallbackPolicy: 'uncertain', renderer: 'automatic' }
  },
  dependencies: {
    extractPptx: async () => { throw new Error('fixture extraction stopped') },
    renderOriginalSlides: fakeRender,
    createId: () => 'failed-run',
    now: () => '2026-07-18T12:00:00.000Z'
  }
}), /fixture extraction stopped/)
const failed = listImportRuns(failureVault)
assert.equal(failed.length, 1)
assert.equal(failed[0].id, 'failed-run')
assert.equal(failed[0].status, 'failed')
assert.match(failed[0].error, /fixture extraction stopped/)

const resumed = await resumeImport({
  vaultRoot: failureVault,
  runId: 'failed-run',
  dependencies: {
    extractPptx: fakeExtract,
    renderOriginalSlides: fakeRender,
    createId: () => 'unused',
    now: () => '2026-07-18T12:05:00.000Z'
  }
})
assert.equal(resumed.manifest.id, 'failed-run')
assert.equal(resumed.manifest.status, 'review')

console.log('importer service: orchestration, progress, assets, discovery and original data passed')

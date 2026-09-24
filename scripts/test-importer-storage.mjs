import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applySlidePatch, createRunStorage, loadRun, resetSlideDecision } from '../src/main/importer/storage.ts'
import { classifySlide } from '../src/main/importer/mapping.ts'
import { IMPORT_LAYOUT_CHOICES, importLayoutTrigger } from '../src/shared/importer-layouts.ts'
import { LAYOUTS } from '../src/shared/layout-registry/entries.ts'

const registeredLayouts = LAYOUTS.filter((entry) => entry.kind === 'layout')
assert.deepEqual(
  IMPORT_LAYOUT_CHOICES.filter((choice) => choice.value !== 'auto').map((choice) => choice.value),
  registeredLayouts.map((entry) => entry.name)
)
assert.equal(importLayoutTrigger('section'), '{role=section-title}')
assert.equal(importLayoutTrigger('contrast-cards'), '{contrast=cards}')
assert.equal(importLayoutTrigger('timeline=compact'), '{timeline=compact}')

const root = mkdtempSync(join(tmpdir(), 'talkweaver-importer-storage-'))
const talkDir = join(root, 'research-talk')
const runDir = join(talkDir, 'import-runs', 'run-123')
const outlinePath = join(talkDir, 'research-talk-outline.md')
mkdirSync(join(talkDir, 'assets'), { recursive: true })
writeFileSync(join(talkDir, 'assets', 'source-image.png'), 'image')
writeFileSync(join(talkDir, 'assets', 'original-001.png'), 'render')

const geometry = { x: 0, y: 0, width: 1000, height: 500 }
const text = (id, placeholder, paragraphs) => ({
  kind: 'text', id, name: id, placeholder, paragraphs, markdownParagraphs: paragraphs, geometry, zIndex: Number(id), hyperlinks: []
})

const titleOnly = {
  slideNumber: 1, hidden: false, title: 'Opening claim', paragraphs: ['Opening claim'], notes: '',
  shapes: [text('1', 'title', ['Opening claim'])], warnings: []
}
const listSlide = {
  slideNumber: 2, hidden: false, title: 'Research process', paragraphs: ['Research process', 'First point', 'Second point'], notes: 'Keep this note.',
  shapes: [text('1', 'title', ['Research process']), text('2', 'body', ['First point', 'Second point'])], warnings: []
}
const imageSlide = {
  slideNumber: 3, hidden: false, title: 'Research workbench', paragraphs: ['Research workbench', 'Collect evidence'], notes: '',
  shapes: [
    text('1', 'title', ['Research workbench']), text('2', 'body', ['Collect evidence']),
    { kind: 'picture', id: '3', name: 'Diagram', placeholder: null, mediaPath: '/source/image.png', mediaName: 'image.png', geometry, zIndex: 3, hyperlinks: [] }
  ], warnings: []
}
const chartSlide = {
  slideNumber: 4, hidden: false, title: 'Results', paragraphs: ['Results'], notes: '',
  shapes: [text('1', 'title', ['Results']), { kind: 'unsupported', id: '2', name: 'Chart', objectType: 'chart', geometry, zIndex: 2 }],
  warnings: ['chart-unsupported']
}
const punctuationSlide = {
  slideNumber: 5, hidden: false,
  title: "I haven't used ChatGPT regularly in months and not at all last week. But I have been using Codex every day!",
  paragraphs: ["author@example.com"], notes: '',
  shapes: [text('1', 'title', ["I haven't used ChatGPT regularly in months and not at all last week. But I have been using Codex every day!"])], warnings: []
}
const emailSlide = {
  slideNumber: 6, hidden: false, title: 'Contact', paragraphs: ['Contact', 'author@example.com'], notes: '',
  shapes: [
    text('1', 'title', ['Contact']),
    text('2', 'body', ['author@example.com'])
  ], warnings: []
}
const bracketSlide = {
  slideNumber: 7, hidden: false, title: 'Course decision',
  paragraphs: ['Course decision', '[In 2010] we nearly removed [MIT AI course] neural nets.'], notes: '',
  shapes: [
    text('1', 'title', ['Course decision']),
    text('2', 'body', ['[In 2010] we nearly removed [MIT AI course] neural nets.'])
  ], warnings: []
}
const richTextSlide = {
  slideNumber: 8, hidden: false, title: 'Patrick Winston',
  paragraphs: ['Patrick Winston', "many of us felt that the neural models of the day weren't useful."], notes: '',
  shapes: [
    text('1', 'title', ['Patrick Winston']),
    { ...text('2', 'body', ["many of us felt that the neural models of the day weren't useful."]), markdownParagraphs: ["many of us felt that the **neural models of the day** weren't useful."] }
  ], warnings: []
}
const layeredImagesSlide = {
  slideNumber: 9, hidden: false, title: 'Launch evidence', paragraphs: ['Launch evidence'], notes: '',
  shapes: [
    text('1', 'title', ['Launch evidence']),
    { kind: 'picture', id: '2', name: 'Slack post', placeholder: null, mediaPath: '/source/slack.png', mediaName: 'slack.png', geometry, zIndex: 2, hyperlinks: [] },
    { kind: 'picture', id: '3', name: 'Tweet', placeholder: null, mediaPath: '/source/tweet.png', mediaName: 'tweet.png', geometry, zIndex: 3, hyperlinks: [] }
  ], warnings: []
}
const timelineSlide = {
  slideNumber: 10, hidden: false, title: 'AI Winter Cycle', paragraphs: ['AI Winter Cycle'], notes: '', layoutName: 'Text only with title',
  shapes: [
    text('1', 'title', ['AI Winter Cycle']),
    { kind: 'smartart', id: '2', name: 'Timeline', layoutName: 'Horizontal Process', categories: ['process', 'timeline'], geometry, zIndex: 2, nodes: [
      { id: '1950', text: '1950s', children: [{ id: 'vision', text: 'Setting out AI vision', children: [] }] },
      { id: '1960', text: '1960s', children: [{ id: 'success', text: 'Early successes', children: [] }] }
    ] }
  ], warnings: []
}
const sidebarMediaSlide = {
  slideNumber: 11, hidden: false, title: 'July 2020, OpenAI release API', paragraphs: ['July 2020, OpenAI release API'], notes: '', layoutName: 'Side bar title without text',
  shapes: [
    text('1', 'title', ['July 2020, OpenAI release API']),
    { kind: 'picture', id: '2', name: 'OpenAI API', placeholder: null, mediaPath: '/source/api.png', mediaName: 'api.png', geometry, zIndex: 2, hyperlinks: [] }
  ], warnings: []
}

const context = {
  sourceHash: '1234567890abcdef1234567890abcdef',
  originalAsset: (number) => `assets/original-${String(number).padStart(3, '0')}.png`,
  mediaAssets: {
    '/source/image.png': 'assets/source-image.png',
    '/source/slack.png': 'assets/slack.png',
    '/source/tweet.png': 'assets/tweet.png',
    '/source/api.png': 'assets/api.png'
  }
}
const decisions = [titleOnly, listSlide, imageSlide, chartSlide].map((slide) => classifySlide(slide, context))
assert.equal(decisions[0].layout, 'statement')
assert.equal(decisions[0].status, 'converted')
assert.equal(decisions[1].layout, 'list')
assert.match(decisions[1].candidateMarkdown, /First point/)
assert.match(decisions[1].candidateMarkdown, /Second point/)
assert.equal(decisions[2].layout, 'copy-visual')
assert.match(decisions[2].candidateMarkdown, /assets\/source-image\.png/)
assert.equal(decisions[3].status, 'fallback')
assert.equal(decisions[3].representation, 'fallback')
assert.match(decisions[3].fallbackMarkdown, /assets\/original-004\.png/)
const punctuationDecision = classifySlide(punctuationSlide, context)
assert.match(punctuationDecision.candidateMarkdown, /last week\. But I have been using Codex every day!/)
assert.doesNotMatch(punctuationDecision.candidateMarkdown, /last week\\\.|day\\!/)
const emailDecision = classifySlide(emailSlide, context)
assert.match(emailDecision.candidateMarkdown, /author@example\.com/)
assert.doesNotMatch(emailDecision.candidateMarkdown, /author@example\\\.com/)
const bracketDecision = classifySlide(bracketSlide, context)
assert.match(bracketDecision.candidateMarkdown, /\[In 2010\] we nearly removed \[MIT AI course\]/)
assert.doesNotMatch(bracketDecision.candidateMarkdown, /\\\[In 2010\\\]|\\\[MIT AI course\\\]/)
const richTextDecision = classifySlide(richTextSlide, context)
assert.match(richTextDecision.candidateMarkdown, /\*\*neural models of the day\*\*/)
const layeredImagesDecision = classifySlide(layeredImagesSlide, context)
assert.match(layeredImagesDecision.candidateMarkdown, /assets\/slack\.png/)
assert.match(layeredImagesDecision.candidateMarkdown, /assets\/tweet\.png/)
const timelineDecision = classifySlide(timelineSlide, context)
assert.equal(timelineDecision.layout, 'timeline=compact')
assert.equal(timelineDecision.status, 'converted')
assert.match(timelineDecision.candidateMarkdown, /\{timeline=compact\}/)
assert.match(timelineDecision.candidateMarkdown, /- 1950s\n  - Setting out AI vision/)
const sidebarMediaDecision = classifySlide(sidebarMediaSlide, context)
assert.equal(sidebarMediaDecision.layout, 'media')
assert.match(sidebarMediaDecision.candidateMarkdown, /\{media\} \{sidebar\}/)

const now = '2026-07-18T12:00:00.000Z'
const manifest = {
  schemaVersion: 1,
  rulesetVersion: 'talkweaver-import/1',
  id: 'run-123',
  createdAt: now,
  updatedAt: now,
  status: 'review',
  source: { path: '/source/research.pptx', fileName: 'research.pptx', hash: context.sourceHash, bytes: 100, slideCount: 4, width: 12192000, height: 6858000 },
  options: { title: 'Research Talk', slug: 'research-talk', slideRange: '', includeHidden: true, preserveNotes: true, extractMedia: true, fallbackPolicy: 'uncertain', renderer: 'automatic' },
  talk: { title: 'Research Talk', slug: 'research-talk', path: talkDir, outlinePath },
  progress: { completedOperation: 'outline', completedSlide: 4, completed: 4, total: 4, note: 'Ready for review' },
  renderer: { name: 'libreoffice', status: 'ready', officePath: '/soffice', rasterPath: '/pdftoppm', officeVersion: 'fixture', rasterVersion: 'fixture' },
  slides: decisions.map((decision, index) => ({ slideNumber: index + 1, title: decision.title, hidden: false, status: decision.status, warnings: decision.warnings }))
}
const records = [titleOnly, listSlide, imageSlide, chartSlide].map((source, index) => ({
  slideNumber: source.slideNumber,
  title: source.title,
  hidden: source.hidden,
  status: decisions[index].status,
  warnings: decisions[index].warnings,
  source,
  decision: decisions[index],
  originalPath: join(runDir, 'slides', String(index + 1).padStart(3, '0'), 'original.png')
}))

createRunStorage(runDir, manifest, records)
const loaded = loadRun(runDir)
assert.equal(loaded.manifest.status, 'review')
assert.equal(loaded.slides.length, 4)
assert.match(loaded.outlineContent, /import_status: review/)
assert.match(loaded.outlineContent, /Opening claim/)
assert.match(loaded.outlineContent, /First point/)
assert.match(loaded.outlineContent, /Keep this note\./)
assert.equal((loaded.outlineContent.match(/^### /gm) ?? []).length, 4)

applySlidePatch(runDir, 2, { layout: 'statement', title: 'A better title', markdown: '### A better title\n{id=pptx-1234567890ab-002} {statement}\n\nFirst point and Second point.' }, now)
const patched = loadRun(runDir)
assert.equal(patched.slides[1].decision.manualOverride.layout, 'statement')
assert.match(patched.outlineContent, /A better title/)
assert.match(readFileSync(join(runDir, 'slides', '002', 'current.md'), 'utf8'), /A better title/)

resetSlideDecision(runDir, 2)
const reset = loadRun(runDir)
assert.equal(reset.slides[1].decision.manualOverride, undefined)
assert.match(reset.outlineContent, /Research process/)
assert.doesNotMatch(reset.outlineContent, /A better title/)

applySlidePatch(runDir, 2, { layout: 'section' }, now)
assert.match(loadRun(runDir).outlineContent, /\{role=section-title\}/)

console.log('importer storage: structural mapping, source preservation, overrides and reset passed')

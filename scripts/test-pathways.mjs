import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  createPathwayInManifest,
  deletePathwayInManifest,
  injectPathwayRuntime,
  renamePathwayInManifest,
  resolvePathways,
  setPathwaySlideIdsInManifest
} from '../src/main/pathways.ts'
import * as pathwayModule from '../src/main/pathways.ts'

const pathwayViewModule = await import('../src/renderer/src/components/pathwayViewModel.ts').catch(() => null)
assert.ok(pathwayViewModule, 'pathway view preference model exists')
const {
  PATHWAY_PREVIEWS_STORAGE_KEY,
  PATHWAY_VIEW_STORAGE_KEY,
  readPathwayPreviewsPreference,
  readPathwayViewPreference
} = pathwayViewModule

const preferenceStorage = (values = {}) => ({
  getItem: (key) => Object.prototype.hasOwnProperty.call(values, key) ? values[key] : null
})
assert.equal(readPathwayViewPreference(preferenceStorage()), 'grid', 'Pathway view defaults to Grid')
for (const mode of ['grid', 'list', 'matrix']) {
  assert.equal(
    readPathwayViewPreference(preferenceStorage({ [PATHWAY_VIEW_STORAGE_KEY]: mode })),
    mode,
    `Pathway view restores ${mode}`
  )
}
assert.equal(
  readPathwayViewPreference(preferenceStorage({ [PATHWAY_VIEW_STORAGE_KEY]: 'tiles' })),
  'grid',
  'unknown Pathway view values fail closed to Grid'
)
assert.equal(readPathwayPreviewsPreference(preferenceStorage()), true, 'Pathway previews default on')
assert.equal(
  readPathwayPreviewsPreference(preferenceStorage({ [PATHWAY_PREVIEWS_STORAGE_KEY]: 'false' })),
  false,
  'Pathway previews restore the explicit off preference'
)
assert.equal(
  readPathwayPreviewsPreference(preferenceStorage({ [PATHWAY_PREVIEWS_STORAGE_KEY]: 'unexpected' })),
  true,
  'unknown Pathway preview values fail closed to on'
)

assert.equal(typeof pathwayModule.createPathwaySummaryReader, 'function', 'pathway summary reader is exported')
const summaryRoot = mkdtempSync(join(tmpdir(), 'tw-pathway-summary-'))
const summaryManifest = join(summaryRoot, '_PRESENTATIONS', 'with-pathways', 'manifest.json')
let summaryReads = 0
const summaryReader = pathwayModule.createPathwaySummaryReader((vaultRoot, talkSlug) => {
  summaryReads += 1
  return pathwayModule.readPathwayManifest(vaultRoot, talkSlug)
})
assert.deepEqual(
  summaryReader.read(summaryRoot, 'without-pathways'),
  { count: 0, names: [] },
  'a talk without a manifest has an empty pathway summary'
)
assert.equal(summaryReads, 0, 'the no-manifest fast path does not attempt a manifest read')

mkdirSync(dirname(summaryManifest), { recursive: true })
writeFileSync(summaryManifest, JSON.stringify({
  pathways: [
    { id: 'short', name: 'Short — 20 min', slideIds: [] },
    { id: 'leaders', name: 'IT leaders', slideIds: [] }
  ]
}), 'utf8')
assert.deepEqual(
  summaryReader.read(summaryRoot, 'with-pathways'),
  { count: 2, names: ['Short — 20 min', 'IT leaders'] },
  'pathway count and names follow manifest order'
)
assert.equal(summaryReads, 1, 'the first summary reads the manifest once')
assert.deepEqual(
  summaryReader.read(summaryRoot, 'with-pathways'),
  { count: 2, names: ['Short — 20 min', 'IT leaders'] },
  'an unchanged manifest returns the cached summary'
)
assert.equal(summaryReads, 1, 'an unchanged mtime avoids another manifest read')

const firstMtime = statSync(summaryManifest).mtimeMs
writeFileSync(summaryManifest, JSON.stringify({
  pathways: [{ id: 'full', name: 'Full', slideIds: [] }]
}), 'utf8')
utimesSync(summaryManifest, new Date(firstMtime + 2000), new Date(firstMtime + 2000))
assert.deepEqual(
  summaryReader.read(summaryRoot, 'with-pathways'),
  { count: 1, names: ['Full'] },
  'a changed manifest mtime refreshes the cached summary'
)
assert.equal(summaryReads, 2, 'a changed mtime reads the manifest once more')

const original = JSON.stringify({
  title: 'Keep me',
  futureField: { nested: ['untouched'] },
  pathways: [{ id: 'short', name: 'Short', note: 'Twenty minutes', slideIds: ['s3', 's1'] }]
}, null, 4) + '\n'

const created = createPathwayInManifest(original, {
  id: 'leaders',
  name: 'IT leaders',
  slideIds: []
})
assert.equal(created.endsWith('\n'), true, 'manifest keeps its trailing newline')
assert.equal(created.split('\n')[1].startsWith('    '), true, 'manifest keeps its indentation style')
let parsed = JSON.parse(created)
assert.deepEqual(parsed.futureField, { nested: ['untouched'] }, 'create preserves unknown manifest fields')
assert.deepEqual(parsed.pathways.map((pathway) => pathway.id), ['short', 'leaders'], 'create appends one pathway')

const renamed = renamePathwayInManifest(created, 'leaders', 'Leaders & policy')
parsed = JSON.parse(renamed)
assert.equal(parsed.pathways[1].name, 'Leaders & policy', 'rename changes only the selected name')
assert.deepEqual(parsed.pathways[0], JSON.parse(original).pathways[0], 'rename preserves the other pathway byte-for-field')

const ordered = setPathwaySlideIdsInManifest(renamed, 'leaders', ['s9', 's2', 's7'])
parsed = JSON.parse(ordered)
assert.deepEqual(parsed.pathways[1].slideIds, ['s9', 's2', 's7'], 'the whole-array setter preserves pathway order')

const deleted = deletePathwayInManifest(ordered, 'short')
parsed = JSON.parse(deleted)
assert.deepEqual(parsed.pathways.map((pathway) => pathway.id), ['leaders'], 'delete removes only the selected pathway')
assert.equal(parsed.title, 'Keep me', 'delete preserves known non-pathway fields')
assert.deepEqual(parsed.futureField, { nested: ['untouched'] }, 'delete preserves unknown fields')

assert.throws(
  () => createPathwayInManifest(created, { id: 'leaders', name: 'Duplicate', slideIds: [] }),
  /already exists/,
  'duplicate pathway ids are rejected'
)
assert.throws(
  () => setPathwaySlideIdsInManifest(created, 'leaders', ['s1', 's1']),
  /duplicate slide id/,
  'duplicate slide ids are rejected rather than silently changing order'
)

const rows = [
  { slide_id: 's1', title: 'One' },
  { slide_id: 's2', title: 'Two' },
  { slide_id: 's3', title: 'Three' }
]
const [resolved] = resolvePathways(
  [{ id: 'mixed', name: 'Mixed', slideIds: ['s3', 'gone', 's1'] }],
  rows
)
assert.deepEqual(resolved.present.map((row) => row.slide_id), ['s3', 's1'], 'present slides follow pathway order, not outline order')
assert.deepEqual(resolved.missing, ['gone'], 'missing ids remain data on read')

const stateModule = await import('../src/shared/pathway-state.ts').catch(() => null)
assert.ok(stateModule, 'pathway membership state reducer exists')
const { optimisticallySetPathwaySlides, reconcilePathwaySnapshot } = stateModule
const stateSlides = [
  { slide_id: 's1', title: 'One' },
  { slide_id: 's4', title: 'Four' }
]
const stateBefore = {
  slides: stateSlides,
  pathways: [{ id: 'route', name: 'Route', slideIds: ['s1'], present: [stateSlides[0]], missing: [] }]
}
const optimistic = optimisticallySetPathwaySlides(stateBefore, 'route', ['s1', 's4'])
assert.deepEqual(
  optimistic.pathways[0].slideIds,
  ['s1', 's4'],
  'Matrix membership edit updates the shared window state synchronously'
)
const staleDisk = reconcilePathwaySnapshot(optimistic, stateBefore, { route: ['s1', 's4'] })
assert.deepEqual(
  staleDisk.snapshot.pathways[0].slideIds,
  ['s1', 's4'],
  'a stale manifest read does not clobber an in-flight optimistic membership edit'
)
assert.deepEqual(staleDisk.pending, { route: ['s1', 's4'] }, 'stale manifest content leaves the edit pending')
const acknowledgedDisk = {
  slides: stateSlides,
  pathways: [{ id: 'route', name: 'Route', slideIds: ['s1', 's4'], present: stateSlides, missing: [] }]
}
const acknowledged = reconcilePathwaySnapshot(optimistic, acknowledgedDisk, staleDisk.pending)
assert.deepEqual(acknowledged.snapshot, acknowledgedDisk, 'matching manifest content becomes canonical state')
assert.deepEqual(acknowledged.pending, {}, 'matching manifest content acknowledges the optimistic edit')

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const compilerDir = join(root, 'compiler', 'scripts')
const { prepareSource } = await import(
  pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href
)
const fixtureDir = mkdtempSync(join(tmpdir(), 'tw-pathway-test-'))
const outlinePath = join(fixtureDir, 'pathway-outline.md')
const outline = [
  '---',
  'title: Pathway injection fixture',
  'outline_version: 2',
  '---',
  '',
  '## Opening',
  '',
  '### One',
  '{id=s1}',
  '',
  'First.',
  '',
  '### Two',
  '{id=s2}',
  '',
  'Second.',
  '',
  '## Cases',
  '',
  '### Three',
  '{id=s3}',
  '',
  'Third.',
  ''
].join('\n')
writeFileSync(outlinePath, outline, 'utf8')
const compiled = (await prepareSource(
  outlinePath,
  outline,
  'pathway-injection-fixture',
  statSync(outlinePath)
)).fullHtml

function embeddedPreviewTemplate(html) {
  const start = html.indexOf('iframe.srcdoc = `')
  const end = html.indexOf('`;', start)
  assert.notEqual(start, -1, 'compiler fixture contains the embedded presenter preview template')
  assert.notEqual(end, -1, 'embedded presenter preview template has a closing delimiter')
  return html.slice(start, end + 2)
}

function outerSlideIds(html) {
  const stageStart = html.indexOf('id="stage"')
  const beatsStart = html.indexOf('<script>window.__deckBeats=', stageStart)
  assert.notEqual(stageStart, -1, 'compiler fixture contains the outer stage')
  assert.notEqual(beatsStart, -1, 'compiler fixture contains the outer beat payload')
  return [...html.slice(stageStart, beatsStart).matchAll(/<section class="[^"]*\bslide\b[^"]*"[^>]*data-id="([^"]+)"/g)]
    .map((match) => match[1])
}

function outerBeatIds(html) {
  const marker = '<script>window.__deckBeats='
  const start = html.indexOf(marker) + marker.length
  const end = html.indexOf(';</script>', start)
  assert.ok(start >= marker.length, 'compiler fixture contains the outer beat payload')
  assert.notEqual(end, -1, 'outer beat payload has a closing delimiter')
  return JSON.parse(html.slice(start, end)).map((beat) => beat.slideId)
}

const filtered = injectPathwayRuntime(compiled, ['s3', 's1'], 'leaders')
assert.equal(
  filtered.split('__talkWeaverPathway').length - 1,
  1,
  'present HTML records the active pathway lens exactly once'
)
assert.deepEqual(outerSlideIds(filtered), ['s3', 's1'], 'only pathway slides survive in pathway order')
assert.deepEqual(outerBeatIds(filtered), ['s3', 's1'], 'only pathway beats survive in pathway order')
assert.equal(
  embeddedPreviewTemplate(filtered),
  embeddedPreviewTemplate(compiled),
  'pathway injection leaves the embedded presenter preview template byte-identical'
)
assert.equal(
  (filtered.match(/<body(?:\s[^>]*)?>/g) ?? []).length,
  (filtered.match(/<\/body>/g) ?? []).length,
  'pathway output keeps balanced body tags'
)
assert.match(filtered, /<\/body>\s*<\/html>\s*$/, 'pathway output keeps the real document body tail')

console.log('pathways: manifest, resolution, and compiled injection checks passed')

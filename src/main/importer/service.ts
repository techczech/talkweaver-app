import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import type {
  ImportProgress,
  ImportRunDetail,
  ImportRunManifest,
  ImportSlideRecord,
  ImportSlideSource,
  ImportStartRequest
} from '../../shared/importer.ts'
import { classifySlide, IMPORT_RULESET_VERSION } from './mapping.ts'
import { extractPptx, renderOriginalSlides } from './pptx.ts'
import { createRunStorage, loadRun } from './storage.ts'
import { writeJsonAtomic, writeTextAtomic } from './atomic.ts'
import { importDestinationFolder, newTalkFolder, talkPlace, IMPORT_DESTINATION_REFUSED } from '../vault-paths.ts'

/** What the person reads when an import stops or will not resume because its talk is no longer where the run began. */
export const IMPORT_RUN_PLACE_REFUSED =
  'This import cannot continue because its talk folder has moved or changed since it began. Nothing more was written. Import the PowerPoint again to make a new talk.'

export interface StartImportDependencies {
  extractPptx: typeof extractPptx
  renderOriginalSlides: typeof renderOriginalSlides
  createId: () => string
  now: () => string
}

export interface StartImportInput {
  vaultRoot: string
  request: ImportStartRequest
  onProgress?: (progress: ImportProgress) => void
  dependencies?: Partial<StartImportDependencies>
}

export interface ResumeImportInput {
  vaultRoot: string
  runId: string
  onProgress?: (progress: ImportProgress) => void
  dependencies?: Partial<StartImportDependencies>
}

const DEFAULT_DEPENDENCIES: StartImportDependencies = {
  extractPptx,
  renderOriginalSlides,
  createId: randomUUID,
  now: () => new Date().toISOString()
}

function inside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith(sep))
}

function safeTopicFolder(value: string | undefined): string {
  if (!value?.trim()) return ''
  const normalised = value.trim().replaceAll('\\', '/')
  if (normalised.startsWith('/') || normalised.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('importer-topic-folder-invalid')
  }
  return normalised
}

function safeSlug(value: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) throw new Error('importer-slug-invalid')
  return value
}

function availableTalk(vaultRoot: string, topicFolder: string, requestedSlug: string): { slug: string; talkDir: string } {
  if (!inside(vaultRoot, resolve(vaultRoot, topicFolder))) throw new Error('importer-destination-outside-vault')
  const parent = importDestinationFolder(vaultRoot, topicFolder)
  if (!parent.ok) throw new Error(IMPORT_DESTINATION_REFUSED)
  mkdirSync(parent.path, { recursive: true })
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const slug = suffix === 1 ? requestedSlug : `${requestedSlug}-import-${suffix}`
    // A protected name, or a link standing at this one, is passed over like a taken name.
    const candidate = newTalkFolder(vaultRoot, slug, topicFolder)
    if (!candidate.ok) continue
    const talkDir = candidate.path
    if (!existsSync(talkDir)) return { slug, talkDir }
    const outline = join(talkDir, `${slug}-outline.md`)
    if (!existsSync(outline) && readdirSync(talkDir).length === 0) return { slug, talkDir }
  }
  throw new Error('importer-talk-name-exhausted')
}

function selectedSlideNumbers(rangeText: string, total: number): Set<number> {
  const trimmed = rangeText.trim()
  if (!trimmed) return new Set(Array.from({ length: total }, (_value, index) => index + 1))
  const selected = new Set<number>()
  for (const part of trimmed.split(',')) {
    const range = part.trim().match(/^(\d+)\s*-\s*(\d+)$/)
    if (range) {
      const start = Number(range[1])
      const end = Number(range[2])
      if (start < 1 || end < start || end > total) throw new Error(`importer-slide-range-invalid:${part.trim()}`)
      for (let number = start; number <= end; number += 1) selected.add(number)
      continue
    }
    const number = Number(part.trim())
    if (!Number.isInteger(number) || number < 1 || number > total) throw new Error(`importer-slide-range-invalid:${part.trim()}`)
    selected.add(number)
  }
  if (!selected.size) throw new Error('importer-slide-range-empty')
  return selected
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function copyMediaAssets(talkDir: string, slides: ImportSlideSource[]): Record<string, string> {
  const assetsDir = join(talkDir, 'assets')
  mkdirSync(assetsDir, { recursive: true })
  const mapped: Record<string, string> = {}
  for (const slide of slides) {
    for (const shape of slide.shapes) {
      if ((shape.kind !== 'picture' && shape.kind !== 'video') || !shape.mediaPath || !existsSync(shape.mediaPath)) continue
      if (mapped[shape.mediaPath]) continue
      const bytes = readFileSync(shape.mediaPath)
      const extension = extname(shape.mediaName || shape.mediaPath).toLowerCase() || '.bin'
      const stem = `${shape.kind === 'video' ? 'vid' : 'img'}-${sha256(bytes).slice(0, 16)}`
      const fileName = `${stem}${extension}`
      const destination = join(assetsDir, fileName)
      if (!existsSync(destination)) writeTextAtomic(destination, bytes)
      mapped[shape.mediaPath] = `assets/${fileName}`
      if (shape.kind === 'video' && shape.posterPath && existsSync(shape.posterPath)) {
        const posterExtension = extname(shape.posterName || shape.posterPath).toLowerCase() || '.png'
        const posterName = `${stem}${posterExtension}`
        const posterDestination = join(assetsDir, posterName)
        if (!existsSync(posterDestination)) writeTextAtomic(posterDestination, readFileSync(shape.posterPath))
        mapped[shape.posterPath] = `assets/${posterName}`
      }
    }
  }
  return mapped
}

function copyOriginalAssets(talkDir: string, sourceHash: string, runDir: string, slideNumbers: number[]): Record<number, string> {
  const assetsDir = join(talkDir, 'assets')
  mkdirSync(assetsDir, { recursive: true })
  const mapped: Record<number, string> = {}
  for (const slideNumber of slideNumbers) {
    const label = String(slideNumber).padStart(3, '0')
    const source = join(runDir, 'slides', label, 'original.png')
    if (!existsSync(source)) continue
    const fileName = `import-${sourceHash.slice(0, 12)}-slide-${label}.png`
    const destination = join(assetsDir, fileName)
    if (!existsSync(destination)) writeTextAtomic(destination, readFileSync(source))
    mapped[slideNumber] = `assets/${fileName}`
  }
  return mapped
}

function placeholderOutline(title: string, runId: string, sourceName: string): string {
  return [
    '---',
    `title: ${JSON.stringify(title)}`,
    'outline_version: 2',
    'import_status: extracting',
    `import_run: ${runId}`,
    `import_source: ${JSON.stringify(sourceName)}`,
    '---',
    '',
    '## Import',
    '',
    '### Import in progress',
    '',
    'TalkWeaver is extracting this PowerPoint.'
  ].join('\n')
}

function emit(
  onProgress: StartImportInput['onProgress'],
  runId: string,
  status: ImportProgress['status'],
  completed: number,
  total: number,
  note: string
): void {
  onProgress?.({ runId, status, completed, total, note })
}

/**
 * Who stands at the place a run writes through, or null when it may not write there. A run writes at the paths its
 * manifest stored, so they must be the folder that holds the run: spelled plainly (no `hop/..` for the OS to follow,
 * no link on the way), then the same folder by the disk's own name, because a category can be typed in another case
 * or Unicode form than the one it is stored in. A talk moved since, or a destination refused today, is refused. The
 * answer names the folders by identity, because a path can stay valid while what it names has been swapped.
 */
function runPlace(vaultRoot: string, runDir: string, manifest: ImportRunManifest): string | null {
  const root = resolve(vaultRoot)
  const talkDir = dirname(dirname(runDir))
  const plain = (path: unknown): path is string => typeof path === 'string' && resolve(path) === path
  try {
    const { path, outlinePath } = manifest.talk
    if (!plain(path) || !plain(outlinePath)) return null
    const stored = realpathSync.native(talkDir)
    for (const folder of [path, dirname(outlinePath)]) {
      if (!newTalkFolder(root, basename(folder), relative(root, dirname(folder))).ok || realpathSync.native(folder) !== stored) return null
    }
    const inside = [dirname(runDir), runDir].map((folder) => { const entry = lstatSync(folder); return `${entry.dev}:${entry.ino}` })
    return [talkPlace(talkDir), ...inside].join('/')
  } catch { return null }
}

async function executeImport(
  vaultRoot: string,
  runDir: string,
  manifest: ImportRunManifest,
  onProgress: StartImportInput['onProgress'],
  dependencies: StartImportDependencies
): Promise<ImportRunDetail> {
  const runId = manifest.id
  const sourcePath = manifest.source.path
  const place = runPlace(vaultRoot, runDir, manifest)
  if (!place) throw new Error(IMPORT_RUN_PLACE_REFUSED)
  // Extraction and rendering run for seconds to minutes: what follows each is judged again before it writes.
  const placeHolds = () => runPlace(vaultRoot, runDir, manifest) === place
  const talkDir = manifest.talk.path
  try {
    manifest.status = 'extracting'
    manifest.updatedAt = dependencies.now()
    manifest.progress = { completedOperation: 'extracting', completedSlide: 0, completed: 0, total: 1, note: 'Validating and extracting PowerPoint' }
    delete manifest.error
    writeJsonAtomic(join(runDir, 'manifest.json'), manifest)
    emit(onProgress, runId, 'extracting', 0, 1, manifest.progress.note)
    const extracted = await dependencies.extractPptx(sourcePath, join(runDir, 'extracted'))
    if (!placeHolds()) throw new Error(IMPORT_RUN_PLACE_REFUSED)
    const selectedNumbers = selectedSlideNumbers(manifest.options.slideRange, extracted.slides.length)
  const selectedSlides = extracted.slides
    .filter((slide) => selectedNumbers.has(slide.slideNumber))
    .filter((slide) => manifest.options.includeHidden || !slide.hidden)
    .map((slide) => ({
      ...slide,
      notes: manifest.options.preserveNotes ? slide.notes : '',
      shapes: manifest.options.extractMedia
        ? slide.shapes
        : slide.shapes.map((shape) => {
            if (shape.kind === 'picture') return { ...shape, mediaPath: null, mediaName: null }
            if (shape.kind === 'video') return { ...shape, mediaPath: null, mediaName: null, posterPath: null, posterName: null }
            return shape
          })
    }))
  if (!selectedSlides.length) throw new Error('importer-no-selected-slides')

    manifest.status = 'rendering'
    manifest.source = extracted.source
    manifest.updatedAt = dependencies.now()
    manifest.progress = { completedOperation: 'rendering', completedSlide: 0, completed: 0, total: selectedSlides.length, note: 'Rendering original slides' }
    writeJsonAtomic(join(runDir, 'manifest.json'), manifest)
    emit(onProgress, runId, 'rendering', 0, selectedSlides.length, manifest.progress.note)
    const rendered = await dependencies.renderOriginalSlides(sourcePath, runDir, extracted.slides.length)
    if (!placeHolds()) throw new Error(IMPORT_RUN_PLACE_REFUSED)
  const mediaAssets = copyMediaAssets(talkDir, selectedSlides)
  const originalAssets = copyOriginalAssets(talkDir, extracted.source.hash, runDir, selectedSlides.map((slide) => slide.slideNumber))
  const records: ImportSlideRecord[] = selectedSlides.map((source) => {
    const decision = classifySlide(source, {
      sourceHash: extracted.source.hash,
      originalAsset: (slideNumber) => originalAssets[slideNumber] ?? `assets/import-${extracted.source.hash.slice(0, 12)}-slide-${String(slideNumber).padStart(3, '0')}.png`,
      mediaAssets
    })
    if (!originalAssets[source.slideNumber] && decision.representation === 'fallback') {
      decision.status = 'failed'
      decision.warnings = [...new Set([...decision.warnings, 'original-render-missing'])]
    }
    return {
      slideNumber: source.slideNumber,
      title: source.title,
      hidden: source.hidden,
      status: decision.status,
      warnings: decision.warnings,
      source,
      decision,
      originalPath: existsSync(join(runDir, 'slides', String(source.slideNumber).padStart(3, '0'), 'original.png'))
        ? join(runDir, 'slides', String(source.slideNumber).padStart(3, '0'), 'original.png')
        : null
    }
  })
  const timestamp = dependencies.now()
    const completedManifest: ImportRunManifest = {
    schemaVersion: 1,
    rulesetVersion: IMPORT_RULESET_VERSION,
    id: runId,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: 'review',
    source: extracted.source,
    options: manifest.options,
    talk: manifest.talk,
    progress: {
      completedOperation: 'outline',
      completedSlide: records.at(-1)?.slideNumber ?? 0,
      completed: records.length,
      total: records.length,
      note: 'Ready for import review'
    },
    renderer: rendered.renderer,
    slides: records.map((record) => ({
      slideNumber: record.slideNumber,
      title: record.title,
      hidden: record.hidden,
      status: record.status,
      warnings: record.warnings
    }))
  }
    const detail = createRunStorage(runDir, completedManifest, records)
    writeJsonAtomic(join(runDir, 'manifest.json'), completedManifest)
    emit(onProgress, runId, 'review', records.length, records.length, 'Ready for import review')
    return detail
  } catch (error) {
    // Nothing more goes through a place that is no longer the run's, not even this failure note.
    if (!placeHolds()) {
      emit(onProgress, runId, 'failed', manifest.progress.completed, manifest.progress.total, IMPORT_RUN_PLACE_REFUSED)
      throw new Error(IMPORT_RUN_PLACE_REFUSED)
    }
    const message = error instanceof Error ? error.message : String(error)
    manifest.status = 'failed'
    manifest.updatedAt = dependencies.now()
    manifest.error = message
    manifest.progress = { ...manifest.progress, note: message }
    writeJsonAtomic(join(runDir, 'manifest.json'), manifest)
    emit(onProgress, runId, 'failed', manifest.progress.completed, manifest.progress.total, message)
    throw error
  }
}

export async function startImport(input: StartImportInput): Promise<ImportRunDetail> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...input.dependencies }
  const vaultRoot = resolve(input.vaultRoot)
  const slug = safeSlug(input.request.options.slug)
  const topicFolder = safeTopicFolder(input.request.options.topicFolder)
  // All before the destination is judged: a deck can take seconds to read and hash, and that judgement must stand beside the first write.
  const sourcePath = resolve(input.request.sourcePath)
  const sourceBytes = readFileSync(sourcePath)
  const sourceHash = sha256(sourceBytes)
  const sourceSize = statSync(sourcePath).size
  const talk = availableTalk(vaultRoot, topicFolder, slug)
  const runId = dependencies.createId()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) throw new Error('importer-run-id-invalid')
  const talkDir = talk.talkDir
  const outlinePath = join(talkDir, `${talk.slug}-outline.md`)
  const runDir = join(talkDir, 'import-runs', runId)
  const timestamp = dependencies.now()
  const manifest: ImportRunManifest = {
    schemaVersion: 1,
    rulesetVersion: IMPORT_RULESET_VERSION,
    id: runId,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: 'queued',
    source: {
      path: sourcePath,
      fileName: basename(sourcePath),
      hash: sourceHash,
      bytes: sourceSize,
      slideCount: 0,
      width: 0,
      height: 0
    },
    options: { ...input.request.options, slug: talk.slug },
    talk: { title: input.request.options.title, slug: talk.slug, path: talkDir, outlinePath },
    progress: { completedOperation: 'queued', completedSlide: 0, completed: 0, total: 0, note: 'Import queued' },
    renderer: { name: 'none', status: 'blocked', officePath: null, rasterPath: null, officeVersion: null, rasterVersion: null, error: 'Rendering has not started.' },
    slides: []
  }
  mkdirSync(runDir, { recursive: true })
  writeTextAtomic(outlinePath, placeholderOutline(input.request.options.title, runId, basename(sourcePath)))
  writeJsonAtomic(join(runDir, 'source.json'), manifest.source)
  writeJsonAtomic(join(runDir, 'manifest.json'), manifest)
  return executeImport(vaultRoot, runDir, manifest, input.onProgress, dependencies)
}

export async function resumeImport(input: ResumeImportInput): Promise<ImportRunDetail> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...input.dependencies }
  const runDir = importRunDir(input.vaultRoot, input.runId)
  const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')) as ImportRunManifest
  if (!['queued', 'extracting', 'rendering', 'failed'].includes(manifest.status)) {
    throw new Error(`importer-run-not-resumable:${manifest.status}`)
  }
  if (!existsSync(manifest.source.path)) throw new Error('importer-source-no-longer-available')
  return executeImport(input.vaultRoot, runDir, manifest, input.onProgress, dependencies)
}

function walkRunManifests(root: string, results: string[]): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const path = join(root, entry.name)
    if (!entry.isDirectory()) continue
    if (entry.name === 'import-runs') {
      for (const run of readdirSync(path, { withFileTypes: true })) {
        if (run.isDirectory() && !run.isSymbolicLink() && existsSync(join(path, run.name, 'manifest.json'))) results.push(join(path, run.name))
      }
      continue
    }
    walkRunManifests(path, results)
  }
}

export function importRunDir(vaultRoot: string, runId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) throw new Error('importer-run-id-invalid')
  const dirs: string[] = []
  if (existsSync(vaultRoot)) walkRunManifests(resolve(vaultRoot), dirs)
  const matches = dirs.filter((dir) => basename(dir) === runId)
  if (matches.length !== 1) throw new Error(matches.length ? `importer-run-id-ambiguous:${runId}` : `importer-run-not-found:${runId}`)
  if (!inside(vaultRoot, matches[0]) || lstatSync(matches[0]).isSymbolicLink()) throw new Error('importer-run-outside-vault')
  return matches[0]
}

export function listImportRuns(vaultRoot: string): ImportRunManifest[] {
  const dirs: string[] = []
  if (!existsSync(vaultRoot)) return []
  walkRunManifests(resolve(vaultRoot), dirs)
  return dirs
    .flatMap((dir) => {
      try { return [JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as ImportRunManifest] } catch { return [] }
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export function getImportRun(vaultRoot: string, runId: string): ImportRunDetail {
  return loadRun(importRunDir(vaultRoot, runId))
}

export function originalSlideDataUrl(vaultRoot: string, runId: string, slideNumber: number): string {
  if (!Number.isInteger(slideNumber) || slideNumber < 1) throw new Error('importer-slide-number-invalid')
  const run = getImportRun(vaultRoot, runId)
  const slide = run.slides.find((item) => item.slideNumber === slideNumber)
  if (!slide?.originalPath || !existsSync(slide.originalPath)) throw new Error(`importer-original-not-found:${slideNumber}`)
  return `data:image/png;base64,${readFileSync(slide.originalPath).toString('base64')}`
}

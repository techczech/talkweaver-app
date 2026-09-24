import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
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
  const parent = resolve(vaultRoot, topicFolder)
  if (!inside(vaultRoot, parent)) throw new Error('importer-destination-outside-vault')
  mkdirSync(parent, { recursive: true })
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const slug = suffix === 1 ? requestedSlug : `${requestedSlug}-import-${suffix}`
    const talkDir = join(parent, slug)
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

async function executeImport(
  runDir: string,
  manifest: ImportRunManifest,
  onProgress: StartImportInput['onProgress'],
  dependencies: StartImportDependencies
): Promise<ImportRunDetail> {
  const runId = manifest.id
  const sourcePath = manifest.source.path
  const talkDir = manifest.talk.path
  try {
    manifest.status = 'extracting'
    manifest.updatedAt = dependencies.now()
    manifest.progress = { completedOperation: 'extracting', completedSlide: 0, completed: 0, total: 1, note: 'Validating and extracting PowerPoint' }
    delete manifest.error
    writeJsonAtomic(join(runDir, 'manifest.json'), manifest)
    emit(onProgress, runId, 'extracting', 0, 1, manifest.progress.note)
    const extracted = await dependencies.extractPptx(sourcePath, join(runDir, 'extracted'))
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
  const talk = availableTalk(vaultRoot, topicFolder, slug)
  const runId = dependencies.createId()
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId)) throw new Error('importer-run-id-invalid')
  const talkDir = talk.talkDir
  const outlinePath = join(talkDir, `${talk.slug}-outline.md`)
  const runDir = join(talkDir, 'import-runs', runId)
  const sourcePath = resolve(input.request.sourcePath)
  const sourceBytes = readFileSync(sourcePath)
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
      hash: sha256(sourceBytes),
      bytes: statSync(sourcePath).size,
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
  return executeImport(runDir, manifest, input.onProgress, dependencies)
}

export async function resumeImport(input: ResumeImportInput): Promise<ImportRunDetail> {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...input.dependencies }
  const runDir = importRunDir(input.vaultRoot, input.runId)
  const manifest = JSON.parse(readFileSync(join(runDir, 'manifest.json'), 'utf8')) as ImportRunManifest
  if (!['queued', 'extracting', 'rendering', 'failed'].includes(manifest.status)) {
    throw new Error(`importer-run-not-resumable:${manifest.status}`)
  }
  if (!existsSync(manifest.source.path)) throw new Error('importer-source-no-longer-available')
  return executeImport(runDir, manifest, input.onProgress, dependencies)
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

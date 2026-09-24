import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  ImportRunDetail,
  ImportRunManifest,
  ImportSlideDecision,
  ImportSlidePatch,
  ImportSlideRecord
} from '../../shared/importer.ts'
import { buildImportOutline, effectiveSlideMarkdown } from './mapping.ts'
import { writeJsonAtomic, writeTextAtomic } from './atomic.ts'

function slideDir(runDir: string, slideNumber: number): string {
  return join(runDir, 'slides', String(slideNumber).padStart(3, '0'))
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf8')) as T
}

function writeSlide(runDir: string, record: ImportSlideRecord): void {
  const dir = slideDir(runDir, record.slideNumber)
  writeJsonAtomic(join(dir, 'source.json'), record.source)
  writeJsonAtomic(join(dir, 'decision.json'), record.decision)
  writeTextAtomic(join(dir, 'current.md'), `${effectiveSlideMarkdown(record.decision)}\n`)
}

function writeOutline(manifest: ImportRunManifest, records: ImportSlideRecord[]): string {
  const content = buildImportOutline(manifest, records)
  writeTextAtomic(manifest.talk.outlinePath, content)
  return content
}

export function createRunStorage(
  runDir: string,
  manifest: ImportRunManifest,
  records: ImportSlideRecord[]
): ImportRunDetail {
  writeJsonAtomic(join(runDir, 'source.json'), manifest.source)
  for (const record of records) writeSlide(runDir, record)
  writeJsonAtomic(join(runDir, 'manifest.json'), manifest)
  return { manifest, slides: records, outlineContent: writeOutline(manifest, records) }
}

export function loadRun(runDir: string): ImportRunDetail {
  const manifest = readJson<ImportRunManifest>(join(runDir, 'manifest.json'))
  const slides = manifest.slides.map((summary) => {
    const dir = slideDir(runDir, summary.slideNumber)
    const source = readJson<ImportSlideRecord['source']>(join(dir, 'source.json'))
    const decision = readJson<ImportSlideDecision>(join(dir, 'decision.json'))
    const originalPath = join(dir, 'original.png')
    return {
      slideNumber: summary.slideNumber,
      title: decision.manualOverride?.title ?? decision.title,
      hidden: summary.hidden,
      status: summary.status,
      warnings: summary.warnings,
      source,
      decision,
      originalPath: existsSync(originalPath) ? originalPath : null
    } satisfies ImportSlideRecord
  })
  return {
    manifest,
    slides,
    outlineContent: existsSync(manifest.talk.outlinePath) ? readFileSync(manifest.talk.outlinePath, 'utf8') : ''
  }
}

function updateRun(
  runDir: string,
  slideNumber: number,
  change: (decision: ImportSlideDecision) => ImportSlideDecision,
  changedAt: string
): ImportRunDetail {
  const loaded = loadRun(runDir)
  const index = loaded.slides.findIndex((slide) => slide.slideNumber === slideNumber)
  if (index < 0) throw new Error(`importer-slide-not-found:${slideNumber}`)
  const record = loaded.slides[index]
  record.decision = change(record.decision)
  record.title = record.decision.manualOverride?.title ?? record.decision.title
  writeSlide(runDir, record)
  loaded.manifest.updatedAt = changedAt
  writeJsonAtomic(join(runDir, 'manifest.json'), loaded.manifest)
  loaded.outlineContent = writeOutline(loaded.manifest, loaded.slides)
  return loaded
}

export function applySlidePatch(
  runDir: string,
  slideNumber: number,
  patch: ImportSlidePatch,
  changedAt = new Date().toISOString()
): ImportRunDetail {
  if (!Object.keys(patch).length) throw new Error('importer-slide-patch-empty')
  return updateRun(runDir, slideNumber, (decision) => ({
    ...decision,
    manualOverride: {
      ...decision.manualOverride,
      ...patch,
      changedAt
    }
  }), changedAt)
}

export function resetSlideDecision(
  runDir: string,
  slideNumber: number,
  changedAt = new Date().toISOString()
): ImportRunDetail {
  return updateRun(runDir, slideNumber, (decision) => {
    const reset = { ...decision }
    delete reset.manualOverride
    return reset
  }, changedAt)
}

export function updateRunManifest(runDir: string, manifest: ImportRunManifest): void {
  writeJsonAtomic(join(runDir, 'manifest.json'), manifest)
}

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ImportCleanupPass, ImportSuggestion } from '../../shared/importer.ts'
import { writeJsonAtomic, writeTextAtomic } from './atomic.ts'
import { applySlidePatch, loadRun } from './storage.ts'

export interface WriteImportCleanupPackInput {
  runDir: string
  packId: string
  slideNumbers: number[]
  passes: ImportCleanupPass[]
  resourcesDir: string
  createdAt?: string
}

export interface ImportSuggestionReadResult {
  suggestions: ImportSuggestion[]
  errors: string[]
}

const PACK_AGENTS = `# TalkWeaver Importer cleanup pack

This folder contains evidence for one PowerPoint import cleanup job.

- Read \`PROMPT.md\` first. It defines the selected slides and cleanup passes.
- Inspect each slide's \`source.json\`, \`original.png\`, \`decision.json\` and \`current.md\` before suggesting a change.
- Preserve source meaning and wording unless the prompt explicitly enables editorial rewriting.
- Keep the original fallback when the evidence does not support a faithful native conversion.
- Write only inside \`suggestions/\`.
- Write one JSON file per suggestion named \`slide-NNN.json\`.
- Never create, edit or delete the canonical Talk, run manifest, source evidence or decision files.
- Follow \`instructions/cleanup-rubric.md\` and \`instructions/data-formats.md\`.
`

function assertPackId(packId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(packId)) throw new Error(`importer-pack-id-invalid:${packId}`)
}

function renderPrompt(template: string, values: Record<string, string>): string {
  let rendered = template
  for (const [key, value] of Object.entries(values)) rendered = rendered.replaceAll(`{{${key}}}`, value)
  const unresolved = rendered.match(/{{([A-Z_]+)}}/)
  if (unresolved) throw new Error(`importer-pack-placeholder-unresolved:${unresolved[1]}`)
  return rendered
}

function copyFileAtomic(source: string, destination: string): void {
  writeTextAtomic(destination, readFileSync(source))
}

function copyInstructions(resourcesDir: string, packDir: string): void {
  const sourceDir = join(resourcesDir, 'instructions')
  if (!existsSync(sourceDir)) {
    writeTextAtomic(join(packDir, 'instructions', 'NOTE.md'), 'Importer cleanup instructions were not found.\n')
    return
  }
  for (const file of readdirSync(sourceDir).sort()) {
    if (!file.endsWith('.md')) continue
    copyFileAtomic(join(sourceDir, file), join(packDir, 'instructions', file))
  }
}

function evidenceForSlide(runDir: string, packDir: string, slideNumber: number): void {
  const label = String(slideNumber).padStart(3, '0')
  const sourceDir = join(runDir, 'slides', label)
  const destinationDir = join(packDir, 'slides', label)
  for (const file of ['source.json', 'decision.json', 'current.md', 'original.png']) {
    const source = join(sourceDir, file)
    if (existsSync(source)) copyFileAtomic(source, join(destinationDir, file))
  }
  const source = JSON.parse(readFileSync(join(sourceDir, 'source.json'), 'utf8')) as {
    shapes?: Array<{
      kind?: string
      mediaPath?: string | null
      mediaName?: string | null
      posterPath?: string | null
      posterName?: string | null
    }>
  }
  const copied = new Set<string>()
  for (const shape of source.shapes ?? []) {
    if (shape.kind !== 'picture' && shape.kind !== 'video') continue
    const assets = [
      { path: shape.mediaPath, name: shape.mediaName },
      ...(shape.kind === 'video' ? [{ path: shape.posterPath, name: shape.posterName }] : [])
    ]
    for (const asset of assets) {
      if (!asset.path || !existsSync(asset.path)) continue
      const fileName = basename(asset.name || asset.path)
      if (copied.has(fileName)) continue
      copyFileAtomic(asset.path, join(destinationDir, 'assets', fileName))
      copied.add(fileName)
    }
  }
}

export function writeImportCleanupPack(input: WriteImportCleanupPackInput): string {
  assertPackId(input.packId)
  const loaded = loadRun(input.runDir)
  const selected = [...new Set(input.slideNumbers)].sort((a, b) => a - b)
  if (!selected.length) throw new Error('importer-pack-no-slides')
  const available = new Set(loaded.slides.map((slide) => slide.slideNumber))
  const missing = selected.find((slideNumber) => !available.has(slideNumber))
  if (missing) throw new Error(`importer-pack-slide-not-found:${missing}`)
  const packDir = join(input.runDir, 'agent-cleanup', input.packId)
  const createdAt = input.createdAt ?? new Date().toISOString()
  const promptTemplatePath = join(input.resourcesDir, 'PROMPT.template.md')
  const promptTemplate = existsSync(promptTemplatePath)
    ? readFileSync(promptTemplatePath, 'utf8')
    : '# Clean {{TALK_TITLE}}\n\nPack: {{PACK_PATH}}\n\nPasses: {{PASSES}}\n'

  writeTextAtomic(join(packDir, 'AGENTS.md'), PACK_AGENTS)
  writeTextAtomic(join(packDir, 'CLAUDE.md'), '@./AGENTS.md')
  writeTextAtomic(join(packDir, 'PROMPT.md'), renderPrompt(promptTemplate, {
    TALK_TITLE: loaded.manifest.talk.title,
    PACK_PATH: packDir,
    PASSES: input.passes.join(', '),
    SLIDES: selected.join(', ')
  }))
  writeJsonAtomic(join(packDir, 'manifest.json'), {
    schemaVersion: 1,
    packId: input.packId,
    runId: loaded.manifest.id,
    createdAt,
    talk: loaded.manifest.talk,
    source: loaded.manifest.source,
    passes: input.passes,
    slideNumbers: selected
  })
  const priority = new Map([['failed', 0], ['fallback', 1], ['review', 2], ['converted', 3], ['extracted', 4]])
  writeJsonAtomic(join(packDir, 'priority-queue.json'), loaded.slides
    .filter((slide) => selected.includes(slide.slideNumber))
    .sort((a, b) => (priority.get(a.status) ?? 9) - (priority.get(b.status) ?? 9) || a.slideNumber - b.slideNumber)
    .map((slide) => ({ slideNumber: slide.slideNumber, status: slide.status, warnings: slide.warnings })))
  copyInstructions(input.resourcesDir, packDir)
  for (const slideNumber of selected) evidenceForSlide(input.runDir, packDir, slideNumber)
  writeJsonAtomic(join(packDir, 'suggestions', '.keep.json'), { note: 'Agents write slide-NNN.json files in this folder.' })
  return packDir
}

function validateSuggestion(value: unknown, fileName: string, allowed: Set<number>): ImportSuggestion {
  const match = fileName.match(/^slide-(\d{3})\.json$/)
  if (!match) throw new Error('filename must be slide-NNN.json')
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('suggestion must be an object')
  const suggestion = value as Partial<ImportSuggestion>
  const fileSlide = Number(match[1])
  if (!Number.isInteger(suggestion.slideNumber) || suggestion.slideNumber !== fileSlide) throw new Error('slideNumber must match filename')
  if (!allowed.has(fileSlide)) throw new Error('slide is not in this cleanup pack')
  if (!['structure', 'layout', 'accessibility', 'editorial'].includes(String(suggestion.category))) throw new Error('category is invalid')
  if (!Array.isArray(suggestion.evidence) || !suggestion.evidence.length || suggestion.evidence.some((item) => typeof item !== 'string' || !item.trim())) throw new Error('evidence must contain file references')
  if (typeof suggestion.rationale !== 'string' || !suggestion.rationale.trim()) throw new Error('rationale is required')
  if (typeof suggestion.markdown !== 'string' || !suggestion.markdown.trim()) throw new Error('markdown is required')
  if (typeof suggestion.sourcePreserving !== 'boolean') throw new Error('sourcePreserving must be boolean')
  return suggestion as ImportSuggestion
}

export function readImportSuggestions(packDir: string): ImportSuggestionReadResult {
  const manifest = JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8')) as { slideNumbers?: number[] }
  const allowed = new Set(manifest.slideNumbers ?? [])
  const suggestionsDir = join(packDir, 'suggestions')
  if (!existsSync(suggestionsDir)) return { suggestions: [], errors: [] }
  const suggestions: ImportSuggestion[] = []
  const errors: string[] = []
  for (const file of readdirSync(suggestionsDir).filter((name) => name !== '.keep.json').sort()) {
    try {
      const parsed = JSON.parse(readFileSync(join(suggestionsDir, file), 'utf8')) as unknown
      suggestions.push(validateSuggestion(parsed, file, allowed))
    } catch (error) {
      errors.push(`${file}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  suggestions.sort((a, b) => a.slideNumber - b.slideNumber)
  return { suggestions, errors }
}

export function applyImportSuggestion(
  runDir: string,
  packDir: string,
  slideNumber: number,
  changedAt = new Date().toISOString()
): void {
  const returned = readImportSuggestions(packDir)
  const suggestion = returned.suggestions.find((item) => item.slideNumber === slideNumber)
  if (!suggestion) throw new Error(`importer-suggestion-not-found:${slideNumber}`)
  applySlidePatch(runDir, slideNumber, { markdown: suggestion.markdown, representation: 'candidate' }, changedAt)
}

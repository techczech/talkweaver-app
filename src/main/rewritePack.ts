import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { basename, dirname, join } from 'path'
import { isDeepStrictEqual } from 'util'
import { formatTimecode, type TalkTextModel } from './talkText.ts'

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section'
}

export function resolveInstructionsDir(opts: { resourcesPath?: string; devRoot?: string }): string {
  return opts.resourcesPath
    ? join(opts.resourcesPath, 'agent-rewrite', 'instructions')
    : join(opts.devRoot ?? process.cwd(), 'resources', 'agent-rewrite', 'instructions')
}

export function resolveCleanTemplate(opts: { resourcesPath?: string; devRoot?: string }): string {
  return opts.resourcesPath
    ? join(opts.resourcesPath, 'agent-rewrite', 'CLEAN.template.md')
    : join(opts.devRoot ?? process.cwd(), 'resources', 'agent-rewrite', 'CLEAN.template.md')
}

export function renderCleanPrompt(
  template: string,
  vars: { talkTitle: string; packPath: string; modeInstructions: string }
): string {
  const rendered = template
    .replaceAll('{{TALK_TITLE}}', vars.talkTitle)
    .replaceAll('{{PACK_PATH}}', vars.packPath)
    .replaceAll('{{MODE_INSTRUCTIONS}}', vars.modeInstructions)
  const remaining = rendered.match(/{{([A-Z_]+)}}/)
  if (remaining) throw new Error(`clean-prompt-placeholder-unresolved:${remaining[1]}`)
  return rendered
}

export function renderPromptTemplate(
  template: string,
  vars: {
    talkTitle: string
    speaker?: string
    event?: string
    date?: string
    packPath?: string
    firstSectionSlug: string
  }
): string {
  const values: Record<string, string> = {
    TALK_TITLE: vars.talkTitle,
    SPEAKER_NAME: vars.speaker ?? '',
    EVENT: vars.event ?? '',
    DATE: vars.date ?? '',
    PACK_PATH: vars.packPath ?? '',
    FIRST_SECTION_SLUG: vars.firstSectionSlug
  }
  let rendered = template
  for (const [key, value] of Object.entries(values)) {
    rendered = rendered.replaceAll(`{{${key}}}`, value)
  }
  const remaining = Object.keys(values).find((key) => rendered.includes(`{{${key}}}`))
  if (remaining) throw new Error(`rewrite-prompt-placeholder-unresolved:${remaining}`)
  return rendered
}

export function renderTranscriptMarkdown(model: TalkTextModel): string {
  const meta = [model.meta.speaker, model.meta.event, model.meta.date].filter(Boolean).join(' · ')
  const slides = model.slides.map((slide) => {
    const heading = `## Slide ${slide.slideNumber} — ${slide.title}  ·  ${formatTimecode(slide.startMs)}–${formatTimecode(slide.endMs)}`
    const transcript = slide.segments.map((segment) => segment.text).join('\n') || '(no transcript for this slide)'
    return `${heading}\n\n${transcript}`
  })
  return [[`# Transcript — ${model.meta.talkTitle}`, meta].join('\n'), ...slides].join('\n\n')
}

export function renderStructureJson(model: TalkTextModel): string {
  return JSON.stringify(model, null, 2)
}

export interface RewritePackInput {
  packDir: string
  model: TalkTextModel
  promptTemplate: string
  instructionsDir: string
}

const PACK_AGENTS_BRIEF = `# Run rewrite pack

This folder is one Run's rewrite pack. Work only on this Run.

- Job prompts: \`CLEAN.md\` (clean the Script — states your working mode) and \`PROMPT.md\` (write Notes). Read the one for your job first; it governs.
- Inputs: \`transcript.md\` and \`structure.json\`.
- Outputs only: \`cleaned/slide-N.md\` and files under \`parts/\`.
- \`cleaned.json\` and \`notes.json\` are app-owned approval stores: never create, edit, or delete them.
- Follow \`instructions/clean-format.md\` when cleaning transcript text.
- Ignore anything directly under the parent \`agent-rewrite/\` folder.
`

function writePackAgentFiles(packDir: string): void {
  writeFileAtomic(join(packDir, 'AGENTS.md'), PACK_AGENTS_BRIEF)
  writeFileAtomic(join(packDir, 'CLAUDE.md'), '@./AGENTS.md')
}

export function writeRewritePack(input: RewritePackInput): { packDir: string; partsDir: string; files: string[] } {
  mkdirSync(input.packDir, { recursive: true })
  const firstSectionSlug = slugify(input.model.outline[0]?.title ?? '')
  const promptPath = join(input.packDir, 'PROMPT.md')
  const transcriptPath = join(input.packDir, 'transcript.md')
  const structurePath = join(input.packDir, 'structure.json')
  writeFileAtomic(promptPath, renderPromptTemplate(input.promptTemplate, {
    talkTitle: input.model.meta.talkTitle,
    speaker: input.model.meta.speaker,
    event: input.model.meta.event,
    date: input.model.meta.date,
    packPath: input.packDir,
    firstSectionSlug
  }))
  writeFileAtomic(transcriptPath, renderTranscriptMarkdown(input.model))
  writeFileAtomic(structurePath, renderStructureJson(input.model))
  writePackAgentFiles(input.packDir)

  const destinationInstructionsDir = join(input.packDir, 'instructions')
  if (existsSync(input.instructionsDir)) {
    cpSync(input.instructionsDir, destinationInstructionsDir, { recursive: true })
  } else {
    mkdirSync(destinationInstructionsDir, { recursive: true })
    writeFileAtomic(join(destinationInstructionsDir, 'NOTE.md'), 'Rewrite instructions were not found.\n')
  }

  const partsDir = join(input.packDir, 'parts')
  mkdirSync(partsDir, { recursive: true })
  return { packDir: input.packDir, partsDir, files: [promptPath, transcriptPath, structurePath] }
}

export interface CleanPackInput {
  packDir: string
  model: TalkTextModel
  cleanTemplate: string
  instructionsDir: string
  modeInstructions: string
}

export function writeCleanPack(input: CleanPackInput): { packDir: string; cleanedDir: string; files: string[] } {
  mkdirSync(input.packDir, { recursive: true })
  const cleanPath = join(input.packDir, 'CLEAN.md')
  const transcriptPath = join(input.packDir, 'transcript.md')
  const structurePath = join(input.packDir, 'structure.json')
  writeFileAtomic(cleanPath, renderCleanPrompt(input.cleanTemplate, {
    talkTitle: input.model.meta.talkTitle,
    packPath: input.packDir,
    modeInstructions: input.modeInstructions
  }))
  if (!existsSync(transcriptPath)) writeFileAtomic(transcriptPath, renderTranscriptMarkdown(input.model))
  if (!existsSync(structurePath)) writeFileAtomic(structurePath, renderStructureJson(input.model))
  writePackAgentFiles(input.packDir)

  const destinationInstructionsDir = join(input.packDir, 'instructions')
  if (existsSync(input.instructionsDir)) {
    cpSync(input.instructionsDir, destinationInstructionsDir, { recursive: true })
  } else {
    mkdirSync(destinationInstructionsDir, { recursive: true })
    const notePath = join(destinationInstructionsDir, 'NOTE.md')
    if (!existsSync(notePath)) writeFileAtomic(notePath, 'Rewrite instructions were not found.\n')
  }

  const cleanedDir = join(input.packDir, 'cleaned')
  mkdirSync(cleanedDir, { recursive: true })
  return { packDir: input.packDir, cleanedDir, files: [cleanPath, transcriptPath, structurePath] }
}

export interface NotesPart {
  slug: string
  order: number
  markdown: string
  approvedAt: string
}

export interface NotesStore {
  approved: Record<string, NotesPart>
}

export function emptyNotesStore(): NotesStore {
  return { approved: {} }
}

function isNotesPart(value: unknown): value is NotesPart {
  if (!value || typeof value !== 'object') return false
  const part = value as Partial<NotesPart>
  return typeof part.slug === 'string' &&
    typeof part.order === 'number' &&
    Number.isFinite(part.order) &&
    typeof part.markdown === 'string' &&
    typeof part.approvedAt === 'string'
}

function isNotesStore(value: unknown): value is NotesStore {
  if (!value || typeof value !== 'object') return false
  const approved = (value as Partial<NotesStore>).approved
  return Boolean(approved) && typeof approved === 'object' && !Array.isArray(approved) &&
    Object.values(approved).every(isNotesPart)
}

type AtomicWriteOptions = { beforeCommit?: () => void }

function isMissingFile(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT'
}

function readOptionalFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8')
  } catch (cause) {
    if (isMissingFile(cause)) return null
    throw cause
  }
}

function refuseSymlinkLeaf(filePath: string): void {
  try {
    if (lstatSync(filePath).isSymbolicLink()) throw new Error('pack-file-symlink-refused')
  } catch (cause) {
    if (isMissingFile(cause)) return
    throw cause
  }
}

function writeFileAtomic(filePath: string, contents: string, options: AtomicWriteOptions = {}): void {
  mkdirSync(dirname(filePath), { recursive: true })
  refuseSymlinkLeaf(filePath)
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(tempPath, contents, { encoding: 'utf8', flag: 'wx' })
    options.beforeCommit?.()
    refuseSymlinkLeaf(filePath)
    renameSync(tempPath, filePath)
  } finally {
    try {
      unlinkSync(tempPath)
    } catch (cause) {
      if (!isMissingFile(cause)) throw cause
    }
  }
}

function writeApprovalStore(filePath: string, contents: string, options: AtomicWriteOptions): void {
  const prior = readOptionalFile(filePath)
  if (prior !== null) writeFileAtomic(`${filePath}.bak`, prior)
  writeFileAtomic(filePath, contents, options)
}

export function readNotesStore(filePath: string): NotesStore {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    if (!isNotesStore(parsed)) throw new Error('approval-store-schema-invalid')
    return parsed
  } catch (cause) {
    if (isMissingFile(cause)) return emptyNotesStore()
    throw cause
  }
}

export function writeNotesStore(filePath: string, store: NotesStore, options: AtomicWriteOptions = {}): void {
  if (!isNotesStore(store)) throw new Error('approval-store-schema-invalid')
  writeApprovalStore(filePath, JSON.stringify(store, null, 2), options)
}

export function approvePart(store: NotesStore, part: NotesPart): NotesStore {
  return { approved: { ...store.approved, [part.slug]: { ...part } } }
}

export function unapprovePart(store: NotesStore, slug: string): NotesStore {
  const approved = { ...store.approved }
  delete approved[slug]
  return { approved }
}

export function approvedPartsInOrder(store: NotesStore): NotesPart[] {
  return Object.values(store.approved).sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug))
}

export interface DraftPart {
  slug: string
  order: number
  fileName: string
  markdown: string
}

export function listParts(partsDir: string): DraftPart[] {
  try {
    return readdirSync(partsDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .flatMap((entry): DraftPart[] => {
        const match = entry.name.match(/^(\d+)-(.+)\.md$/)
        return match
          ? [{
              slug: match[2],
              order: Number(match[1]),
              fileName: entry.name,
              markdown: readFileSync(join(partsDir, entry.name), 'utf8')
            }]
          : []
      })
      .sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug))
  } catch {
    return []
  }
}

export interface CleanedSlide {
  slideNumber: number
  markdown: string
  approvedAt: string
}

export interface CleanedStore {
  approved: Record<string, CleanedSlide>
}

export function emptyCleanedStore(): CleanedStore {
  return { approved: {} }
}

function isCleanedSlide(value: unknown): value is CleanedSlide {
  if (!value || typeof value !== 'object') return false
  const slide = value as Partial<CleanedSlide>
  return typeof slide.slideNumber === 'number' &&
    Number.isInteger(slide.slideNumber) &&
    slide.slideNumber > 0 &&
    typeof slide.markdown === 'string' &&
    typeof slide.approvedAt === 'string'
}

function isCleanedStore(value: unknown): value is CleanedStore {
  if (!value || typeof value !== 'object') return false
  const approved = (value as Partial<CleanedStore>).approved
  return Boolean(approved) && typeof approved === 'object' && !Array.isArray(approved) &&
    Object.values(approved).every(isCleanedSlide)
}

export function readCleanedStore(filePath: string): CleanedStore {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    if (!isCleanedStore(parsed)) throw new Error('approval-store-schema-invalid')
    return parsed
  } catch (cause) {
    if (isMissingFile(cause)) return emptyCleanedStore()
    throw cause
  }
}

export function writeCleanedStore(filePath: string, store: CleanedStore, options: AtomicWriteOptions = {}): void {
  if (!isCleanedStore(store)) throw new Error('approval-store-schema-invalid')
  writeApprovalStore(filePath, JSON.stringify(store, null, 2), options)
}

export function approveCleaned(store: CleanedStore, slide: CleanedSlide): CleanedStore {
  return { approved: { ...store.approved, [String(slide.slideNumber)]: { ...slide } } }
}

export function unapproveCleaned(store: CleanedStore, slideNumber: number): CleanedStore {
  const approved = { ...store.approved }
  delete approved[String(slideNumber)]
  return { approved }
}

export function approvedCleanedInOrder(store: CleanedStore): CleanedSlide[] {
  return Object.values(store.approved).sort((a, b) => a.slideNumber - b.slideNumber)
}

export interface CleanedDraft {
  slideNumber: number
  fileName: string
  markdown: string
}

// Write (or overwrite) a single slide's cleaned draft from in-app editing. The app owns
// `cleaned/slide-<N>.md` the same way an external agent does, so nothing about the pack
// contract changes — the human is just another author of the same file.
export function writeCleanedDraft(
  cleanedDir: string,
  slideNumber: number,
  markdown: string,
  options: { allowEmpty?: boolean } = {}
): void {
  const draftPath = join(cleanedDir, `slide-${slideNumber}.md`)
  const existingMarkdown = readOptionalFile(draftPath)
  if (!markdown.trim() && existingMarkdown?.trim() && !options.allowEmpty) {
    throw new Error('empty-cleaned-slide-requires-confirmation')
  }
  writeFileAtomic(draftPath, cleanedDraftContents(markdown))
}

function cleanedDraftContents(markdown: string): string {
  return `${markdown.trim()}\n`
}

export function discardPartDraft(draftPath: string, notesStorePath: string, slug: string): void {
  const store = readNotesStore(notesStorePath)
  writeNotesStore(notesStorePath, unapprovePart(store, slug))
  unlinkSync(draftPath)
}

export function discardCleanedDraft(
  draftPath: string | null,
  cleanStorePath: string,
  slideNumber: number
): boolean {
  const store = readCleanedStore(cleanStorePath)
  const approved = Boolean(store.approved[String(slideNumber)])
  writeCleanedStore(cleanStorePath, unapproveCleaned(store, slideNumber))
  if (draftPath) unlinkSync(draftPath)
  return Boolean(draftPath) || approved
}

export interface CleanedMoveSnapshot {
  source: {
    slideNumber: number
    draft: string | null
    approval: CleanedSlide | null
    postMoveDraft: string | null
    postMoveApproval: CleanedSlide | null
  }
  destination: {
    slideNumber: number
    draft: string | null
    approval: CleanedSlide | null
    postMoveDraft: string | null
    postMoveApproval: CleanedSlide | null
  }
}

function restoreOptionalFile(filePath: string, before: string | null): void {
  if (before === null) {
    try {
      unlinkSync(filePath)
    } catch (cause) {
      if (!isMissingFile(cause)) throw cause
    }
  } else {
    writeFileAtomic(filePath, before)
  }
}

function storeWithSnapshotEntries(store: CleanedStore, snapshot: CleanedMoveSnapshot): CleanedStore {
  const approved = { ...store.approved }
  for (const item of [snapshot.source, snapshot.destination]) {
    if (item.approval) approved[String(item.slideNumber)] = { ...item.approval }
    else delete approved[String(item.slideNumber)]
  }
  return { approved }
}

export function moveCleanedDrafts(input: {
  cleanedDir: string
  cleanStorePath: string
  source: { slideNumber: number; markdown: string }
  destination: { slideNumber: number; markdown: string }
  afterDraftWrite?: (step: 'destination' | 'source') => void
}): CleanedMoveSnapshot {
  const { source, destination } = input
  if (!Number.isInteger(source.slideNumber) || source.slideNumber <= 0 ||
      !Number.isInteger(destination.slideNumber) || destination.slideNumber <= 0 ||
      source.slideNumber === destination.slideNumber) {
    throw new Error('bad-slide-move')
  }

  const sourcePath = join(input.cleanedDir, `slide-${source.slideNumber}.md`)
  const destinationPath = join(input.cleanedDir, `slide-${destination.slideNumber}.md`)
  const sourceBefore = readOptionalFile(sourcePath)
  const destinationBefore = readOptionalFile(destinationPath)
  const store = readCleanedStore(input.cleanStorePath)
  const postMoveStore = unapproveCleaned(unapproveCleaned(store, source.slideNumber), destination.slideNumber)
  const snapshot: CleanedMoveSnapshot = {
    source: {
      slideNumber: source.slideNumber,
      draft: sourceBefore,
      approval: store.approved[String(source.slideNumber)] ?? null,
      postMoveDraft: cleanedDraftContents(source.markdown),
      postMoveApproval: postMoveStore.approved[String(source.slideNumber)] ?? null
    },
    destination: {
      slideNumber: destination.slideNumber,
      draft: destinationBefore,
      approval: store.approved[String(destination.slideNumber)] ?? null,
      postMoveDraft: cleanedDraftContents(destination.markdown),
      postMoveApproval: postMoveStore.approved[String(destination.slideNumber)] ?? null
    }
  }

  try {
    writeCleanedDraft(input.cleanedDir, destination.slideNumber, destination.markdown, { allowEmpty: true })
    input.afterDraftWrite?.('destination')
    writeCleanedDraft(input.cleanedDir, source.slideNumber, source.markdown, { allowEmpty: true })
    input.afterDraftWrite?.('source')
    writeCleanedStore(input.cleanStorePath, postMoveStore)
    return snapshot
  } catch (cause) {
    const rollbackErrors: unknown[] = []
    for (const [filePath, before] of [[sourcePath, sourceBefore], [destinationPath, destinationBefore]] as const) {
      try {
        restoreOptionalFile(filePath, before)
      } catch (rollbackCause) {
        rollbackErrors.push(rollbackCause)
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([cause, ...rollbackErrors], 'cleaned-draft-move-rollback-failed')
    }
    throw cause
  }
}

export function undoCleanedDraftMove(input: {
  cleanedDir: string
  cleanStorePath: string
  snapshot: CleanedMoveSnapshot
}): void {
  const sourcePath = join(input.cleanedDir, `slide-${input.snapshot.source.slideNumber}.md`)
  const destinationPath = join(input.cleanedDir, `slide-${input.snapshot.destination.slideNumber}.md`)
  let currentSource: string | null
  let currentDestination: string | null
  let currentStore: CleanedStore
  try {
    currentSource = readOptionalFile(sourcePath)
    currentDestination = readOptionalFile(destinationPath)
    currentStore = readCleanedStore(input.cleanStorePath)
  } catch {
    throw new Error('undo-stale')
  }
  if (currentSource !== input.snapshot.source.postMoveDraft ||
      currentDestination !== input.snapshot.destination.postMoveDraft ||
      !isDeepStrictEqual(
        currentStore.approved[String(input.snapshot.source.slideNumber)] ?? null,
        input.snapshot.source.postMoveApproval
      ) ||
      !isDeepStrictEqual(
        currentStore.approved[String(input.snapshot.destination.slideNumber)] ?? null,
        input.snapshot.destination.postMoveApproval
      )) {
    throw new Error('undo-stale')
  }
  const restoredStore = storeWithSnapshotEntries(currentStore, input.snapshot)

  try {
    const restoreErrors: unknown[] = []
    for (const [filePath, before] of [
      [sourcePath, input.snapshot.source.draft],
      [destinationPath, input.snapshot.destination.draft]
    ] as const) {
      try {
        restoreOptionalFile(filePath, before)
      } catch (cause) {
        restoreErrors.push(cause)
      }
    }
    if (restoreErrors.length > 0) {
      throw new AggregateError(restoreErrors, 'cleaned-draft-move-undo-restore-failed')
    }
    writeCleanedStore(input.cleanStorePath, restoredStore)
  } catch (cause) {
    const rollbackErrors: unknown[] = []
    for (const [filePath, before] of [
      [sourcePath, currentSource],
      [destinationPath, currentDestination]
    ] as const) {
      try {
        restoreOptionalFile(filePath, before)
      } catch (rollbackCause) {
        rollbackErrors.push(rollbackCause)
      }
    }
    try {
      writeCleanedStore(input.cleanStorePath, currentStore)
    } catch (rollbackCause) {
      rollbackErrors.push(rollbackCause)
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([cause, ...rollbackErrors], 'cleaned-draft-move-undo-rollback-failed')
    }
    throw cause
  }
}

export interface CleanedMoveUndoStore {
  remember: (key: string, snapshot: CleanedMoveSnapshot) => void
  invalidate: (key: string, slideNumber: number) => void
  releaseAllExcept: (key: string) => void
  releaseAll: () => void
  undo: (key: string, cleanedDir: string, cleanStorePath: string) => void
}

export function createCleanedMoveUndoStore(): CleanedMoveUndoStore {
  let slot: { key: string; snapshot: CleanedMoveSnapshot | null } | null = null
  return {
    remember: (key, snapshot) => { slot = { key, snapshot } },
    invalidate: (key, slideNumber) => {
      if (slot?.key === key && slot.snapshot &&
          (slot.snapshot.source.slideNumber === slideNumber || slot.snapshot.destination.slideNumber === slideNumber)) {
        slot = null
      }
    },
    releaseAllExcept: (key) => {
      if (slot && slot.key !== key) slot = { key, snapshot: null }
    },
    releaseAll: () => { slot = null },
    undo: (key, cleanedDir, cleanStorePath) => {
      // A mismatched caller is refused but must not destroy the rightful owner's slot.
      if (slot && slot.key !== key) throw new Error('undo-stale')
      const snapshot = slot?.snapshot
      if (!snapshot) throw new Error('cleaned-draft-move-undo-unavailable')
      slot = null
      undoCleanedDraftMove({ cleanedDir, cleanStorePath, snapshot })
    }
  }
}

export function listCleanedDrafts(cleanedDir: string): CleanedDraft[] {
  try {
    return readdirSync(cleanedDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .flatMap((entry): CleanedDraft[] => {
        const match = entry.name.match(/^slide-(\d+)\.md$/)
        if (!match) return []
        const slideNumber = Number(match[1])
        return Number.isInteger(slideNumber) && slideNumber > 0
          ? [{ slideNumber, fileName: entry.name, markdown: readFileSync(join(cleanedDir, entry.name), 'utf8') }]
          : []
      })
      .sort((a, b) => a.slideNumber - b.slideNumber)
  } catch (cause) {
    if (isMissingFile(cause)) return []
    throw cause
  }
}

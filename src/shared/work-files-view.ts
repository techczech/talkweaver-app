// The Work files view's one model (work-files ticket 06; ADR-0040 decisions 1 and 6; mockup #s9-*).
// Pure: no Node APIs, no Electron, no file access. The main process reads the `Work files/` folder,
// the talks' front matter and the Runs, and hands them here; this module reads each file with the
// work-file reader (work-file.ts, never a second parser) and derives what the list and the open file
// show: the steps, the findings, the talks that name the file, and the Runs that carry it.
//
// "Used by" has two sources. A talk's metadata names a file for one phase (`prework:` / `postwork:`,
// a work-file id; the file's own name is accepted too). A Run carries an attachment per phase
// (`work.pre` / `work.post`, by file id only); the Run is "sent" once a revision is pinned, and keeps the version it went out with whatever happens to the file after.
import { talkTitleText } from './talk-title-text.ts'
import { LEGACY_SECTION_FILE_ID } from './run-work.ts'
import { parseFrontmatterPairs } from './frontmatter-editor.ts'
import { namedWorkFile, talkWorkFile } from './work-file-name.ts'
import { readWorkFile, type WorkFileFinding, type WorkFileStep, type WorkFileStepKind } from './work-file.ts'
import { canBeLocal, stepSourceLines } from './work-file-write.ts'

export const WORK_FILES_FOLDER = 'Work files'

export type WorkPhase = 'pre' | 'post'

/** The listing the Work files view shows: what `work-files:list` answers (null: no vault). */
export interface WorkFilesListing {
  /** Absolute path of the `Work files/` folder (it may not exist yet). With several vaults: the first one's. */
  folder: string
  items: Array<WorkFileItem & { absPath: string; vaultId?: string }>
  /** The open vaults this listing covers, in order (the all-vaults listing only). The view names a file's vault when there are several. */
  vaults?: Array<{ id: string; name: string }>
  /** The vault a New work file goes into: the open talk's vault, else the current vault (the all-vaults listing only). */
  newFileVaultId?: string
}

/** One file across vaults: two vaults may each hold a `session-feedback.md`. */
export function workFileKey(vaultId: string | undefined, fileName: string): string {
  return `${vaultId ?? ''}|${fileName}`
}

/** What main hands over for each file in the folder: the name (with `.md`) and the text as read. */
export interface WorkFileSource { fileName: string; text: string }
/** A talk, with the file ids its front matter names (as written; '' / undefined when it names none). */
export interface WorkFileTalkSource { slug: string; title: string; outlinePath: string; prework?: string; postwork?: string }
/** The part of a Run this view reads. */
export interface WorkFileRunSource {
  id: string
  talkSlug: string
  talkTitle?: string
  eventTitle?: string
  work?: { pre?: WorkFileAttachmentSource; post?: WorkFileAttachmentSource }
}
export interface WorkFileAttachmentSource { fileId: string; pinned?: { pinnedAt: string } }

export type WorkFileThumb = 'video' | 'slide' | 'icon'
export type WorkFileStepIcon = 'video' | 'presentation' | 'list-checks' | 'gauge' | 'pencil-line' | 'message-circle-question'

export interface WorkFileStepRow {
  /** 1-based position. */
  n: number
  id: string | null
  title: string
  kind: WorkFileStepKind
  /** "Video · 6 min", "Task · slide, numbered steps", "Quick check · 3 options", "Open question". */
  kindLabel: string
  thumb: WorkFileThumb
  icon: WorkFileStepIcon
  /** The duration written on the step, shown on a video thumbnail. */
  minutes: number | null
  /**
   * Where the step's answer goes (2026-10-19 prework-responses design): `sent` (the default), `local`
   * (`{local}`: it stays on the participant's phone) or `counts` (a slide or video: only a read mark).
   */
  route: WorkFileStepRoute
  /** The step's own source for the Edit panel's preview: heading, token lines, first body line. */
  source: string[]
}

export type WorkFileStepRoute = 'sent' | 'local' | 'counts'
/** The labels the steps list and the Edit panel use; participants see "Sent to the speaker" and "On this phone". */
export const ROUTE_LABELS: Record<WorkFileStepRoute, string> = { sent: 'Sent to you', local: 'Local only', counts: 'Counts only' }

export interface WorkFileFindingRow {
  /** The reader's finding code, or this view's own (`work-file-id-shared`). */
  code: string
  message: string
  severity: 'blocking' | 'warning'
  stepId: string | null
  line: number | null
}

export interface WorkFileUsedTalk { slug: string; title: string; outlinePath: string; role: WorkPhase }
export interface WorkFileUsedRun {
  talkSlug: string
  runId: string
  name: string
  phase: WorkPhase
  /** When it went out (ISO), or null while it has not been sent. */
  sentAt: string | null
}

export interface WorkFileItem {
  /** `research-teams-intake.md`. */
  fileName: string
  /** `Work files/research-teams-intake.md`, vault-relative. */
  relPath: string
  /** The id the front matter gives ('' when it gives none a talk or Run could name). */
  id: string
  title: string
  steps: WorkFileStepRow[]
  findings: WorkFileFindingRow[]
  blocking: number
  usedTalks: WorkFileUsedTalk[]
  runs: WorkFileUsedRun[]
  preTalks: number
  postTalks: number
  runCount: number
}

const LAYOUT_LABEL: Record<string, string> = {
  title: 'title', 'title-image': 'title + image', columns: 'two columns', steps: 'numbered steps', 'full-image': 'full image', video: 'video',
}
const POLL_LABEL: Record<string, string> = {
  single: 'Single choice', multiple: 'Multiple choice', ranking: 'Ranking', categorisation: 'Categorisation', board: 'Board',
}

function plural(n: number, one: string, many = `${one}s`): string { return `${n} ${n === 1 ? one : many}` }

function layoutText(step: WorkFileStep): string {
  return step.layout ? LAYOUT_LABEL[step.layout] : `layout not supported${step.layoutName ? ` (${step.layoutName})` : ''}`
}

function kindLabel(step: WorkFileStep): string {
  switch (step.kind) {
    case 'video': return step.minutes ? `Video · ${step.minutes} min` : 'Video'
    case 'slide': return `Slide · ${layoutText(step)}`
    case 'task': return `Task · slide, ${layoutText(step)}`
    case 'check': return step.options?.length ? `Quick check · ${plural(step.options.length, 'option')}` : 'Quick check'
    case 'question':
      if (step.pollType === 'open') return 'Open question'
      if (step.pollType === 'rating') return 'Rating · 1 to 5'
      return step.pollType && POLL_LABEL[step.pollType] ? POLL_LABEL[step.pollType] : 'Question'
  }
}

function stepRow(step: WorkFileStep, index: number, text: string): WorkFileStepRow {
  const thumb: WorkFileThumb = step.kind === 'video' ? 'video' : step.kind === 'slide' || step.kind === 'task' ? 'slide' : 'icon'
  const icon: WorkFileStepIcon = step.kind === 'video' ? 'video'
    : step.kind === 'slide' ? 'presentation'
    : step.kind === 'check' ? 'list-checks'
    : step.kind === 'task' ? 'pencil-line'
    : step.pollType === 'rating' ? 'gauge' : 'message-circle-question'
  return {
    n: index + 1, id: step.id, title: step.title, kind: step.kind, kindLabel: kindLabel(step), thumb, icon,
    minutes: step.kind === 'video' && step.minutes ? step.minutes : null,
    route: !canBeLocal(step.kind) ? 'counts' : step.local ? 'local' : 'sent',
    source: stepSourceLines(text, step.sourceLine),
  }
}

/** One plain sentence per finding; the detail the reader gives (a layout name, a duplicated id) is added. */
const FINDING_TEXT: Record<string, string> = {
  'work-file-id-missing': 'This file has no id. Talks can still name it by its file name; Runs cannot use it until it has one.',
  'work-file-id-invalid': 'The id is not a slug (lower-case letters, digits and hyphens).',
  'work-file-title-missing': 'The front matter has no title.',
  'work-file-revision-missing': 'The front matter has no revision number.',
  'work-file-revision-invalid': 'The revision is not a whole number.',
  'work-file-no-steps': 'The file has no steps. Each step is a ### heading.',
  'work-file-step-level': 'A step must be a ### heading with nothing nested under it.',
  'work-file-step-id-missing': 'A step has no id.',
  'work-file-step-id-invalid': 'A step id is not a slug.',
  'work-file-step-id-duplicate': 'Two steps share an id.',
  'work-file-layout-unsupported': 'A step uses a layout a work file cannot hold.',
  'work-file-h1-unsupported': 'A # heading is not allowed in a work file.',
  'work-file-poll-unknown': 'A question has a poll type TalkWeaver does not know.',
  'work-file-video-missing': 'A video step has no video to play.',
  'prework-kind-conflict': 'A step has tokens that make it two kinds of step.',
  'prework-readonly-without-task': 'A step is marked {readonly} but is not a task.',
  'prework-minutes-invalid': 'A step has minutes that are not a whole number of minutes, or is not a task.',
  'prework-check-not-single': 'A quick check must be a single-choice question.',
  'prework-check-right-missing': 'A quick check has no option marked {right}.',
  'prework-check-right-many': 'A quick check has more than one option marked {right}.',
  'prework-right-misplaced': 'A {right} marker is not on an option of a quick check.',
  'prework-local-on-slide': 'A slide or video is marked {local}, but it has no answer to keep on the phone; its read mark is still counted.',
}

function findingRow(finding: WorkFileFinding, stepTitles: Map<string, string>): WorkFileFindingRow {
  // The compiler reuses one code for minutes on a step that is not a task; the detail tells them apart.
  const minutesOnNonTask = finding.code === 'prework-readonly-without-task' && finding.detail === 'minutes'
  const text = minutesOnNonTask ? 'Only a task can have minutes' : FINDING_TEXT[finding.code]
  const base = (text ?? finding.code.replace(/^prework-/, '').replace(/-/g, ' ')).replace(/\.$/, '')
  const detail = finding.detail && !minutesOnNonTask ? ` (${finding.detail})` : ''
  const where = finding.stepId ? `, step ${stepTitles.get(finding.stepId) ?? finding.stepId}` : ''
  return { code: finding.code, message: `${base[0].toUpperCase()}${base.slice(1)}${detail}${where}.`, severity: finding.severity, stepId: finding.stepId, line: finding.line }
}

function baseName(fileName: string): string { return fileName.replace(/\.md$/i, '') }


function sentAt(attachment: WorkFileAttachmentSource): string | null {
  return attachment.pinned ? attachment.pinned.pinnedAt : null
}

/**
 * Every work file with what it holds and who uses it. Files are ordered by how many Runs carry them
 * (most first), then by title. A file is named by its front-matter id. A talk may also name a file by its
 * file name, but only when the file has no id and no other file has that id; Runs match by id only.
 */
export function buildWorkFileItems(files: readonly WorkFileSource[], talks: readonly WorkFileTalkSource[], runs: readonly WorkFileRunSource[]): WorkFileItem[] {
  const idOwners = new Map<string, string[]>()
  for (const file of files) {
    const id = readWorkFile(file.text).definition.id
    if (id) idOwners.set(id, [...(idOwners.get(id) ?? []), file.fileName])
  }
  // What a talk's value names is the shared reading (work-file-name.ts), the one the editor's strips use.
  const nameable = files.map((file) => ({ id: readWorkFile(file.text).definition.id ?? '', fileName: file.fileName }))
  const talkNames = talks.map((talk) => ({
    pre: talkWorkFile(talk.prework, nameable).file?.fileName ?? null,
    post: talkWorkFile(talk.postwork, nameable).file?.fileName ?? null
  }))
  const items = files.map((file): WorkFileItem => {
    const reading = readWorkFile(file.text)
    const def = reading.definition
    const stem = baseName(file.fileName)
    // Who may name this file. Runs: by id only, and never by an id another file shares or the reserved
    // legacy one. Talks: as talkWorkFile reads them (by id; by file name only when the file has no id
    // and no other file's id is that name).
    const sharing = def.id ?(idOwners.get(def.id) ?? []).filter((n) => n !== file.fileName) : []
    const ownId = def.id && sharing.length === 0 ? def.id : ''
    const runId = ownId && ownId !== LEGACY_SECTION_FILE_ID ? ownId : ''
    const stepTitles = new Map<string, string>(def.steps.filter((s) => s.id).map((s) => [s.id as string, s.title]))

    const usedTalks: WorkFileUsedTalk[] = []
    talks.forEach((talk, index) => {
      for (const role of ['pre', 'post'] as const) {
        if (talkNames[index][role] === file.fileName) usedTalks.push({ slug: talk.slug, title: talkTitleText(talk.title), outlinePath: talk.outlinePath, role })
      }
    })
    const usedRuns: WorkFileUsedRun[] = []
    for (const run of runs) {
      for (const phase of ['pre', 'post'] as const) {
        const attachment = run.work?.[phase]
        if (!attachment || !runId || attachment.fileId !== runId) continue
        usedRuns.push({ talkSlug: run.talkSlug, runId: run.id, name: run.eventTitle || run.talkTitle || run.talkSlug, phase, sentAt: sentAt(attachment) })
      }
    }
    const findings = reading.findings.map((f) => findingRow(f, stepTitles))
    if (sharing.length) {
      findings.push({
        code: 'work-file-id-shared', severity: 'blocking', stepId: null, line: null,
        message: `Another work file has the same id (${sharing.join(', ')}). Give each file its own id.`,
      })
    }
    return {
      fileName: file.fileName,
      relPath: `${WORK_FILES_FOLDER}/${file.fileName}`,
      id: def.id,
      title: def.title || stem,
      steps: def.steps.map((step, index) => stepRow(step, index, file.text)),
      findings,
      blocking: findings.filter((f) => f.severity === 'blocking').length,
      usedTalks,
      runs: usedRuns,
      preTalks: usedTalks.filter((t) => t.role === 'pre').length,
      postTalks: usedTalks.filter((t) => t.role === 'post').length,
      runCount: usedRuns.length,
    }
  })
  return items.sort((a, b) => b.runCount - a.runCount || a.title.localeCompare(b.title, 'en-GB'))
}

/** "Used as pre-work in 2 talks · as post-work in 0" (the drawn wording). */
export function usedLine(item: Pick<WorkFileItem, 'preTalks' | 'postTalks'>): string {
  return `Used as pre-work in ${plural(item.preTalks, 'talk')} · as post-work in ${item.postTalks}`
}

/** "4 runs" / "1 run". */
export function runCountText(item: Pick<WorkFileItem, 'runCount'>): string { return plural(item.runCount, 'run') }

/** "2 talks · 4 runs": the heading of the Used by section. */
export function usedByCounts(item: Pick<WorkFileItem, 'usedTalks' | 'runCount'>): string {
  const talks = new Set(item.usedTalks.map((t) => t.slug)).size
  return `${plural(talks, 'talk')} · ${plural(item.runCount, 'run')}`
}

/**
 * The front-matter value a talk uses to name a file for a phase, read from the talk's outline text with
 * the shared front-matter reader and read as a name (namedWorkFile). `true` / `false` are returned as
 * written: they name a file only when one has that id (talkWorkFile decides).
 */
export function readTalkWorkNames(outlineText: string): { prework?: string; postwork?: string } {
  const pairs = parseFrontmatterPairs(outlineText)
  const out: { prework?: string; postwork?: string } = {}
  for (const key of ['prework', 'postwork'] as const) {
    const pair = pairs.find((candidate) => candidate.key === key)
    const value = pair && !pair.value.startsWith('\n') ? namedWorkFile(pair.value) : ''
    if (value) out[key] = value
  }
  return out
}

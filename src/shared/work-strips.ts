// The editor's pre-work and post-work strips as one pure model (work-files-and-sessions ticket 08;
// ADR-0040 decision 7; locked mockup shots 1-no-pre-work, 1-not-sent, 1-sent-1-run, 1-sent-2-runs,
// 1-post-work-open). The talk's metadata (`prework:` / `postwork:`), the work files, the Runs and the
// time now go in; for each phase the strip's text and its one action come out. The editor draws what
// this returns and decides nothing itself. No Electron, no fs, no clock: `now` is passed.
//
// "Sent" is per phase: that phase's attachment on the Run carries the file AND has its own publish
// stamp (`publishedAt`, set by Publish for the phases it sent; runs.ts stampRunWork) with no later
// `unpublishedAt`. The Run as a whole being published is not enough: post-work attached after a
// pre-work-only publish, a file swapped on a published Run (re-planning drops the stamps) and an old
// Run with only a handout link have sent nothing for that phase. Where a sent Run stands (post-work
// open, closed) comes from the Run checklist (run-checklist.ts), never re-derived here.
//
// What the talk's value names is the shared reading (work-file-name.ts), the Work files view's too.
// When the Runs could not be read (`runs: null`) the strip says so instead of "not sent to anyone".
//
// An attachment can be marked `problem: 'zone-mismatch'` (ticket 03 review: its zone differs from the
// Run's, or the Run's zone is unknown on this machine). The mark is shown on the strip and on that
// Run's row in the Open run list. Planning over it is refused where the Run is written (runs.ts).
import { runChecklist, dayLabel, type ChecklistRun, type RunPhase } from './run-checklist.ts'
import { SESSION_END, type Phase, type RunWork } from './run-work.ts'
import { talkWorkFile } from './work-file-name.ts'
export { namedWorkFile, workFileValue } from './work-file-name.ts'

/** What the model needs of a work file (the Work files listing carries all of it). */
export interface StripFile { id: string; fileName: string; title: string; steps: number }

/** What the model needs of a Run (a Sessions-list source carries all of it). */
export interface StripRun extends ChecklistRun {
  /** The vault the Run lives in (a Sessions-list source carries it). */
  vaultId?: string
  talkSlug: string
  runId: string
  talkTitle: string
  eventTitle?: string
  answers?: { pre?: number; post?: number }
}

export interface StripRunRef { talkSlug: string; runId: string; vaultId?: string }
export type StripMark = 'zone-mismatch'
export const STRIP_MARK_TEXT: Record<StripMark, string> = { 'zone-mismatch': 'time zone does not match the Run' }

export interface StripMenuRow { ref: StripRunRef; name: string; /** "Wed 21 Oct · 7/18" */ detail: string; mark?: StripMark }

export type StripAction =
  | { kind: 'attach'; label: string }
  | { kind: 'plan-run'; label: string }
  | { kind: 'open-run'; label: string; ref: StripRunRef }
  | { kind: 'open-run-menu'; label: string; rows: StripMenuRow[] }

/**
 * none = no file named; missing = a file is named that is not in the vault (or two files share its id);
 * runs-unknown = the file is there but the Runs could not be read; not-sent / sent as drawn.
 */
export type StripState = 'none' | 'missing' | 'runs-unknown' | 'not-sent' | 'sent'

export interface WorkStrip {
  phase: Phase
  state: StripState
  /** The strip's look: grey (nothing attached), amber (not sent) or blue (sent). */
  tone: 'none' | 'not-sent' | 'sent'
  /** The bold lead: "Pre-work", or "No pre-work" when nothing is attached. */
  lead: string
  /** The file's name as the strip shows it (its title; the id when the file is missing); '' with no file. */
  fileName: string
  /** "4 steps"; '' when there is no file to count. */
  steps: string
  /** What follows the steps: "not sent to anyone", "sent to Saïd workshop · 7/18", …; '' with no file. */
  status: string
  mark?: StripMark
  /** The whole strip as one line, parts joined with " · ". */
  text: string
  action: StripAction
}

export interface WorkStrips { pre: WorkStrip; post: WorkStrip }

export interface WorkStripsInput {
  /** The talk's folder name: only Runs of this talk count. */
  talkSlug: string
  /** The open talk's vault: when given, only Runs of this vault count. */
  vaultId?: string
  /** The front-matter values as written (`prework:` / `postwork:`); undefined or '' when the key is absent. */
  metadata: { prework?: string; postwork?: string }
  files: readonly StripFile[]
  /** The Runs; null when they could not be read. */
  runs: readonly StripRun[] | null
  now: Date
}

const LABEL: Record<Phase, string> = { pre: 'Pre-work', post: 'Post-work' }
const LOWER: Record<Phase, string> = { pre: 'pre-work', post: 'post-work' }

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** The file a talk's value names (the shared reading, work-file-name.ts). */
export function resolveWorkFile(value: string | undefined, files: readonly StripFile[]): StripFile | null {
  return talkWorkFile(value, files).file
}

/** Whether this phase's attachment on the Run carries the file and was published, not unpublished since. */
function phaseSent(run: StripRun, phase: Phase, fileId: string): boolean {
  const work: RunWork | undefined = run.work?.[phase]
  if (!work || work.fileId !== fileId) return false
  const published = Date.parse(work.publishedAt ?? '')
  if (!Number.isFinite(published)) return false
  const unpublished = Date.parse(work.unpublishedAt ?? '')
  return !(Number.isFinite(unpublished) && unpublished >= published)
}

function startKey(run: StripRun): string {
  return `${run.plannedDate ?? '9999-99-99'}T${run.startTime || '00:00'}`
}

function count(run: StripRun, phase: Phase): string {
  return `${run.answers?.[phase] ?? 0}${run.expectedPeople ? `/${run.expectedPeople}` : ''}`
}

const nameOf = (run: StripRun): string => run.eventTitle || run.talkTitle || run.talkSlug

function menuRow(run: StripRun, phase: Phase): StripMenuRow {
  const when = run.plannedDate ? `${dayLabel(run.plannedDate)} · ` : ''
  const mark = run.work?.[phase]?.problem
  const ref: StripRunRef = { talkSlug: run.talkSlug, runId: run.runId, ...(run.vaultId ? { vaultId: run.vaultId } : {}) }
  return { ref, name: nameOf(run), detail: `${when}${count(run, phase)}`, ...(mark ? { mark } : {}) }
}

function sentText(phase: Phase, sent: Array<{ run: StripRun; phase: RunPhase }>): string {
  if (phase === 'pre') {
    return sent.length === 1 ? `sent to ${nameOf(sent[0].run)} · ${count(sent[0].run, 'pre')}` : `sent to ${plural(sent.length, 'run')}`
  }
  const open = sent.filter((item) => item.phase === 'post-open')
  if (sent.length === 1) {
    const { run, phase: runPhase } = sent[0]
    const work = run.work?.post
    if (runPhase === 'post-open' && work) return `${nameOf(run)} · ${count(run, 'post')} · closes ${dayLabel(work.closes.slice(0, 10))}`
    if (runPhase === 'post-closed') return `sent to ${nameOf(run)} · closed ${count(run, 'post')}`
    const opens = work?.opens && work.opens !== SESSION_END ? `opens ${dayLabel(work.opens.slice(0, 10))}` : 'opens after the session'
    return `sent to ${nameOf(run)} · ${opens}`
  }
  const head = `sent to ${plural(sent.length, 'run')}`
  if (open.length > 0) return `${head} · ${open.length} open`
  return sent.every((item) => item.run.work?.post?.opens === SESSION_END) ? `${head} · opens after each session` : head
}

function stripFor(phase: Phase, input: WorkStripsInput): WorkStrip {
  const named = talkWorkFile(input.metadata[phase === 'pre' ? 'prework' : 'postwork'], input.files)
  const written = named.name
  const attach = (label: string): StripAction => ({ kind: 'attach', label })
  if (!written) {
    const lead = `No ${LOWER[phase]}`
    return { phase, state: 'none', tone: 'none', lead, fileName: '', steps: '', status: '', text: lead, action: attach(`Attach a ${LOWER[phase]} file`) }
  }
  const file = named.file
  if (!file) {
    const status = named.sharedId ? 'more than one work file has this id' : 'file not found'
    return {
      phase, state: 'missing', tone: 'not-sent', lead: LABEL[phase], fileName: written, steps: '', status,
      text: [LABEL[phase], written, status].join(' · '), action: attach('Choose a file')
    }
  }
  const steps = plural(file.steps, 'step')
  if (input.runs === null) {
    const status = 'could not read Runs'
    return {
      phase, state: 'runs-unknown', tone: 'not-sent', lead: LABEL[phase], fileName: file.title, steps, status,
      text: [LABEL[phase], file.title, steps, status].join(' · '), action: { kind: 'plan-run', label: 'Plan a run' }
    }
  }
  const carriers = input.runs
    .filter((run) => run.talkSlug === input.talkSlug && (!input.vaultId || run.vaultId === input.vaultId))
    .filter((run) => file.id !== '' && run.work?.[phase]?.fileId === file.id)
    .sort((a, b) => startKey(a).localeCompare(startKey(b)) || a.runId.localeCompare(b.runId))
  const sent = carriers
    .filter((run) => phaseSent(run, phase, file.id))
    .map((run) => ({ run, phase: runChecklist(run, input.now, { answers: run.answers }).phase }))
  // The mark shows on the strip for any Run that carries the file, sent or not: it is about the attachment.
  const marked = carriers.some((run) => run.work?.[phase]?.problem === 'zone-mismatch')
  const mark: StripMark | undefined = marked ? 'zone-mismatch' : undefined
  const base = { phase, lead: LABEL[phase], fileName: file.title, steps, ...(mark ? { mark } : {}) }
  const compose = (status: string) => [LABEL[phase], file.title, steps, status, ...(mark ? [STRIP_MARK_TEXT[mark]] : [])].join(' · ')
  if (sent.length === 0) {
    const status = 'not sent to anyone'
    return { ...base, state: 'not-sent', tone: 'not-sent', status, text: compose(status), action: { kind: 'plan-run', label: 'Plan a run' } }
  }
  const status = sentText(phase, sent)
  const rows = sent.map((item) => menuRow(item.run, phase))
  const action: StripAction = rows.length === 1
    ? { kind: 'open-run', label: 'Open run', ref: rows[0].ref }
    : { kind: 'open-run-menu', label: 'Open run', rows }
  return { ...base, state: 'sent', tone: 'sent', status, text: compose(status), action }
}

export function workStrips(input: WorkStripsInput): WorkStrips {
  return { pre: stripFor('pre', input), post: stripFor('post', input) }
}

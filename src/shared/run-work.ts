// A Run's work-file attachments (ADR-0040 decisions 1, 3 and 5; work-files-and-sessions ticket 03).
// Pure: no Electron, no fs. A Run may carry one attachment per phase: which work file, when it opens
// and closes (local `YYYY-MM-DDTHH:MM` in the attachment's own zone), and, once sent, the pinned
// revision (filled in by ticket 14). The Run file is JSON anyone can edit, so every value is read
// here; a hostile attachment is dropped and the rest of the Run is kept.

export type Phase = 'pre' | 'post'

export interface PinnedRevision {
  fileId: string
  title: string
  revision: number
  sha256: string
  /** Vault-relative path of the copy beside the Run. */
  copy: string
  pinnedAt: string
}

export interface RunWork {
  fileId: string
  /** Post-work only may be `session-end`: it opens when the session ends or the Run is marked delivered. */
  opens: string | 'session-end'
  closes: string
  timeZone: string
  pinned?: PinnedRevision
  publishedAt?: string
  unpublishedAt?: string
  /**
   * Post-work that opens when the session ends: when the app pushed its opening to the work service
   * (ISO instant; ticket 19). Absent until then, and on every other attachment.
   */
  openedAt?: string
  /**
   * In memory only, never written: the attachment's zone is not the Run's (a hand-edited file, or a Run
   * zone this machine cannot read). It is kept and written back as found, and planning cannot touch it
   * until the zones agree.
   */
  problem?: 'zone-mismatch'
}

export interface RunWorkSet { pre?: RunWork; post?: RunWork }

/** The file id a pre-work window migrated from a `{prework}` section of the talk carries. */
export const LEGACY_SECTION_FILE_ID = 'legacy-section'
export const SESSION_END = 'session-end'
/** Work-file ids are slugs. */
export const WORK_FILE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/
const MAX_TEXT = 500

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function normaliseLocalDateTime(value: unknown): string {
  const t = text(value)
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(t)
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59) return ''
  // Impossible dates (2026-02-31) parse in some engines by rolling over; the components must round-trip.
  const parsed = new Date(`${match[1]}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === match[1] ? t : ''
}

/**
 * A zone string of the right shape, known to this machine or not. Read paths keep such a string and
 * write it back unchanged: another machine may know a zone this one does not.
 */
export function zoneText(value: unknown): string {
  const t = text(value)
  return t && t.length <= 64 && /^[A-Za-z0-9_+\-/]+$/.test(t) ? t : ''
}

/** An IANA time zone name the platform knows, or ''. */
export function normaliseTimeZone(value: unknown): string {
  const t = zoneText(value)
  if (!t) return ''
  try { return new Intl.DateTimeFormat('en-GB', { timeZone: t }).resolvedOptions().timeZone ? t : '' } catch { return '' }
}

function isoInstant(value: unknown): string {
  const t = text(value)
  return t.length <= 40 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(t) && Number.isFinite(Date.parse(t)) ? t : ''
}

/**
 * A vault-relative POSIX path made of plain segments. This is a syntax check only: that the copy sits
 * inside the Run's own folder (`_PRESENTATIONS/<talk>/<run id>/…`) is checked where it is written and
 * read (src/main/run-work-pin.ts). A segment may hold whatever a talk slug may hold (runs.ts
 * isSafeTalkSlug: spaces, letters beyond ASCII, `:` and a leading `~`, since the talk folder is in the
 * path), but never a separator, a control character or a leading dot (so no `.`, `..` or hidden name).
 * Only the FIRST segment, where a drive (`C:`) or a home prefix (`~`) would take effect, may hold
 * neither `:` nor a leading `~`.
 */
export function safeCopyPath(copy: string): boolean {
  if (!copy || copy.length > 400) return false
  const segments = copy.split('/')
  if (/^~|:/.test(segments[0] ?? '')) return false
  return segments.every((segment) => /^(?!\.)[^/\\\u0000-\u001f\u007f]+$/u.test(segment) && segment.trim() === segment)
}

function normalisePinned(value: unknown): PinnedRevision | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const fileId = text(raw.fileId)
  const title = text(raw.title)
  const copy = text(raw.copy)
  const sha256 = text(raw.sha256)
  const pinnedAt = isoInstant(raw.pinnedAt)
  const revision = raw.revision
  if (!WORK_FILE_ID.test(fileId) || !title || title.length > MAX_TEXT || !copy || copy.length > MAX_TEXT) return undefined
  if (!safeCopyPath(copy)) return undefined
  if (!/^[0-9a-f]{64}$/i.test(sha256) || !pinnedAt) return undefined
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return undefined
  return { fileId, title, revision, sha256, copy, pinnedAt }
}

/** One attachment, or null when it is unreadable. A pinned revision that fails is dropped alone. */
export function normaliseRunWork(value: unknown, phase: Phase, allowReserved = false): RunWork | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const fileId = text(raw.fileId)
  if (!WORK_FILE_ID.test(fileId) || (fileId === LEGACY_SECTION_FILE_ID && !allowReserved)) return null
  const opens = phase === 'post' && text(raw.opens) === SESSION_END ? SESSION_END : normaliseLocalDateTime(raw.opens)
  const closes = normaliseLocalDateTime(raw.closes)
  if (!opens || !closes) return null
  const timeZone = zoneText(raw.timeZone)
  if (!timeZone) return null
  const pinned = normalisePinned(raw.pinned)
  const publishedAt = isoInstant(raw.publishedAt)
  const unpublishedAt = isoInstant(raw.unpublishedAt)
  const openedAt = opens === SESSION_END ? isoInstant(raw.openedAt) : ''
  return {
    fileId, opens, closes, timeZone,
    ...(pinned ? { pinned } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(unpublishedAt ? { unpublishedAt } : {}),
    ...(openedAt ? { openedAt } : {})
  }
}

/** Both phases; an unknown phase key is dropped. Undefined when neither attachment is readable. */
export function normaliseRunWorkSet(value: unknown): RunWorkSet | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const pre = normaliseRunWork(raw.pre, 'pre')
  const post = normaliseRunWork(raw.post, 'post')
  return pre || post ? { ...(pre ? { pre } : {}), ...(post ? { post } : {}) } : undefined
}

/**
 * Pre-work migrated from the 0.39 fields: a `pre` attachment whose file is unknown. Null when the
 * Run has no opening, or no closing can be worked out (no planned date and none set).
 */
export function legacyPreWork(run: { plannedDate?: string; startTime?: string; preworkOpens?: string; preworkCloses?: string; timeZone?: string }, fallbackZone: string): RunWork | null {
  if (!run.preworkOpens) return null
  const closes = run.preworkCloses || (run.plannedDate ? `${run.plannedDate}T${run.startTime || '00:00'}` : '')
  return normaliseRunWork({ fileId: LEGACY_SECTION_FILE_ID, opens: run.preworkOpens, closes, timeZone: normaliseTimeZone(run.timeZone) || fallbackZone }, 'pre', true)
}

/** A `legacy-section` attachment is derived on every read from the 0.39 fields and never written. */
export function withoutLegacyWork(work: RunWorkSet | undefined): RunWorkSet | undefined {
  if (!work) return undefined
  const { pre, post } = work
  const real: RunWorkSet = { ...(pre && pre.fileId !== LEGACY_SECTION_FILE_ID ? { pre } : {}), ...(post ? { post } : {}) }
  return real.pre || real.post ? real : undefined
}

export type WorkClosingError = 'work-post-opens-before-start' | 'work-pre-closes-after-start' | 'work-post-closes-before-start' | 'work-closes-before-opens'

/**
 * The reason a closing time is wrong for the session, or null. Pre-work must close by the session's
 * start (exactly at it is allowed, as the 0.39 default); post-work must close after it and, when it
 * opens at a time, not open before it. `start` is the session's `YYYY-MM-DDTHH:MM`, in the Run's zone.
 * `delivered`: Change time on a Run already given (ticket 19) reopens work after the session, so the two
 * closing-against-start rules do not apply; the rest still do.
 */
export function workClosingError(phase: Phase, work: Pick<RunWork, 'opens' | 'closes'>, start: string, options: { delivered?: boolean } = {}): WorkClosingError | null {
  if (work.opens !== SESSION_END && work.closes <= work.opens) return 'work-closes-before-opens'
  if (phase === 'post' && work.opens !== SESSION_END && work.opens < start) return 'work-post-opens-before-start'
  if (options.delivered) return null
  if (phase === 'pre') return work.closes > start ? 'work-pre-closes-after-start' : null
  return work.closes <= start ? 'work-post-closes-before-start' : null
}

export interface SentRun { runId: string; talkSlug: string; phase: Phase; revision: number; sha256: string; pinnedAt: string }

/**
 * "Runs already sent" for a work file (Work files view): every Run phase whose pin names the file,
 * newest pin first. A Run counts as sent from its first publish of the phase, unpublished or not:
 * the pin stays with it (ticket 14).
 */
export function sentRunsForWorkFile(runs: ReadonlyArray<{ id: string; talkSlug: string; work?: RunWorkSet }>, fileId: string): SentRun[] {
  const out: SentRun[] = []
  for (const run of runs) {
    for (const phase of ['pre', 'post'] as const) {
      const pinned = run.work?.[phase]?.pinned
      if (pinned && pinned.fileId === fileId) out.push({ runId: run.id, talkSlug: run.talkSlug, phase, revision: pinned.revision, sha256: pinned.sha256, pinnedAt: pinned.pinnedAt })
    }
  }
  return out.sort((a, b) => b.pinnedAt.localeCompare(a.pinnedAt))
}

/**
 * Unpublish refused (ticket 17): the phase went out, but this computer holds no usable owner key for it
 * (its row has no key in secure storage, or there is no row here at all), so it cannot be withdrawn and
 * nothing is said to have been.
 */
export function workKeyMissing(phase: Phase): string {
  const work = phase === 'post' ? 'post-work' : 'pre-work'
  return `The key for this Run's ${work} is not on this computer, so it cannot be withdrawn from here. Unpublish it from the computer that published it. Nothing was withdrawn, changed or uploaded.`
}

/**
 * Said of a phase published before TalkWeaver 0.41 whose object records no vault (issue 256): this computer cannot
 * tell which vault published it, so no vault pulls, reuses or withdraws it. `unpublish`: the Unpublish refusal.
 */
export function workOwnerUnknown(phase: Phase, unpublish = false): string {
  const work = phase === 'post' ? 'post-work' : 'pre-work'
  const lead = `This Run's ${work} was published before TalkWeaver 0.41, and this computer cannot tell which vault published it`
  return unpublish
    ? `${lead}, so it cannot be withdrawn from here. Publish this Run again to give it ${work} of its own, then unpublish it. Nothing was withdrawn, changed or uploaded.`
    : `${lead}. Its answers are not pulled into this Run, and Unpublish does not withdraw it. Publish this Run again to give it ${work} of its own.`
}

/** A Run's work page is a folder inside its handout's folder on the site: `…/<run>/pre-work`, `…/<run>/post-work`. */
export const WORK_PAGE_FOLDER: Readonly<Record<Phase, 'pre-work' | 'post-work'>> = Object.freeze({ pre: 'pre-work', post: 'post-work' })

/**
 * The address of a Run's pre-work or post-work page from its handout's link: the link without its
 * trailing slashes, then `/pre-work` or `/post-work` (a short link redirects these too, publishing-logic.ts
 * buildRedirects). '' when the Run has no handout link.
 */
export function workPageUrl(handoutUrl: string | undefined | null, phase: Phase): string {
  const base = typeof handoutUrl === 'string' ? handoutUrl.trim().replace(/\/+$/, '') : ''
  return base ? `${base}/${WORK_PAGE_FOLDER[phase]}` : ''
}

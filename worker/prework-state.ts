// Pre-work for a planned Run: the object's rules (feedback-boards ticket 09). Pure — the RunPrework
// Durable Object (prework.ts) keeps the metadata in memory and gives these functions a narrow view of
// its tables; the tests give them an in-memory one.
//
//   - The form opens and closes on the Run's dates; the owner can close it early (never reopen).
//     Before it opens and after it closes, nothing is accepted.
//   - Submissions are idempotent by submission id: the same one again returns what was stored and
//     costs nothing; a different submission under a known id is a conflict.
//   - A read, an answer and a done mark are one entry per participant and step (the latest wins); each
//     question is its own entry. Every change takes the next sequence number, which the owner pulls after.
//   - Caps: people per form, submissions and questions per person, bytes per form; a rate bucket for
//     the form and one per person.
//   - With no push and no submission for 60 days the object is purged (its alarm).
import {
  PREWORK_IDLE_PURGE_MS, PREWORK_LIMITS, validPreworkAnswer,
  type PreworkEntry, type PreworkForm, type PreworkFormPush, type PreworkPhase, type PreworkStatus, type PreworkSubmission,
} from './prework-protocol.ts'

export class PreworkError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly details: Record<string, unknown> = {}) {
    super(message)
  }
}

export interface Bucket { tokens: number; at: number }

export interface StoredPrework {
  preworkId: string
  createdAt: number
  /** The last push or accepted submission; the idle purge counts from here. */
  lastActivityAt: number
  form: PreworkForm | null
  opensAt: number | null
  closesAt: number | null
  /** Closed early by the owner ("Close pre-work now"). */
  closedAt: number | null
  seq: number
  participants: number
  entryBytes: number
  bucket: Bucket
}

/** One network source (a hashed IP): its rate bucket and the new participant ids it brought this hour. */
export interface SourceRow {
  key: string
  bucket: Bucket
  /** Fixed hour window: when it started and how many new participant ids arrived in it. */
  windowStart: number
  newParticipants: number
  /** New participant ids it brought over the form's life. */
  participantsTotal?: number
}

export interface ParticipantRow {
  /** The hash the Worker keeps, never the device's id. */
  key: string
  firstAt: number
  submissions: number
  questions: number
  bucket: Bucket
}

/** The object's tables as the rules see them. */
export interface PreworkStore {
  submission(submissionId: string): { fingerprint: string; entryId: string } | null
  putSubmission(submissionId: string, fingerprint: string, entryId: string): void
  entry(entryId: string): PreworkEntry | null
  putEntry(entry: PreworkEntry): void
  participant(key: string): ParticipantRow | null
  putParticipant(row: ParticipantRow): void
  /** Entries with `seq > after`, ascending, at most `limit`. */
  entriesAfter(after: number, limit: number): PreworkEntry[]
  /** Every entry of one participant. */
  participantEntries(key: string): PreworkEntry[]
  source(key: string): SourceRow | null
  putSource(row: SourceRow): void
}

export function createPrework(preworkId: string, now: number): StoredPrework {
  return {
    preworkId, createdAt: now, lastActivityAt: now, form: null, opensAt: null, closesAt: null, closedAt: null,
    seq: 0, participants: 0, entryBytes: 0, bucket: { tokens: PREWORK_LIMITS.burst, at: now },
  }
}

/** When it stops taking answers: its closing time, or earlier if the owner closed it. */
export function effectiveCloseAt(prework: StoredPrework): number | null {
  if (prework.closesAt === null) return prework.closedAt
  return prework.closedAt === null ? prework.closesAt : Math.min(prework.closesAt, prework.closedAt)
}

/** Where the form stands at `now`; null before the owner has pushed one. */
export function preworkPhase(prework: StoredPrework, now: number): PreworkPhase | null {
  if (!prework.form || prework.opensAt === null || prework.closesAt === null) return null
  const closes = effectiveCloseAt(prework)!
  if (now >= closes) return 'closed'
  return now < prework.opensAt ? 'not_yet' : 'open'
}

/** The public status, or null when there is nothing to show (answered like an unknown id). */
export function preworkStatus(prework: StoredPrework, now: number): PreworkStatus | null {
  const state = preworkPhase(prework, now)
  if (!state) return null
  return { state, opensAt: prework.opensAt!, closesAt: effectiveCloseAt(prework)!, ...(state === 'closed' ? { people: prework.participants } : {}) }
}

/** The owner's push: the form and its window. A form closed early stays closed. */
export function pushForm(prework: StoredPrework, push: PreworkFormPush, now: number): void {
  prework.form = push.form
  prework.opensAt = push.opensAt
  prework.closesAt = push.closesAt
  prework.lastActivityAt = now
}

/** "Close pre-work now": no more answers from `now`. Idempotent; the earliest close wins. */
export function closePrework(prework: StoredPrework, now: number): number {
  prework.closedAt = prework.closedAt === null ? now : Math.min(prework.closedAt, now)
  return prework.closedAt
}

/**
 * 60 idle days after the last push or submission — but never before 60 days after it closes, so a
 * form published months before it opens is not purged before anyone could answer it.
 */
export function purgeDueAt(prework: StoredPrework, idleMs = PREWORK_IDLE_PURGE_MS): number {
  return Math.max(prework.lastActivityAt, effectiveCloseAt(prework) ?? 0) + idleMs
}

export function shouldPurge(prework: StoredPrework, now: number, idleMs = PREWORK_IDLE_PURGE_MS): boolean {
  return now >= purgeDueAt(prework, idleMs)
}

function refill(bucket: Bucket, perMinute: number, burst: number, now: number): void {
  const elapsed = Math.max(0, now - bucket.at)
  bucket.tokens = Math.min(burst, bucket.tokens + elapsed * perMinute / 60_000)
  bucket.at = now
}

function take(bucket: Bucket, perMinute: number, burst: number, now: number): void {
  refill(bucket, perMinute, burst, now)
  if (bucket.tokens < 1) {
    const retryAfterMs = Math.ceil((1 - bucket.tokens) * 60_000 / perMinute)
    throw new PreworkError('rate_limited', 'Too many answers at once. Try again shortly.', 429, { retryAfterMs })
  }
}

function utf8(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

function entryIdFor(participant: string, submission: PreworkSubmission): string {
  return submission.kind === 'question'
    ? `${participant}:q:${submission.submissionId}`
    : `${participant}:${submission.kind}:${submission.stepId}`
}

function fingerprint(participant: string, submission: PreworkSubmission): string {
  const { participantId: _device, submissionId: _id, ...rest } = submission
  return JSON.stringify({ participant, ...rest })
}

function sameValue(a: PreworkEntry, b: Omit<PreworkEntry, 'id' | 'seq' | 'at' | 'participant'>): boolean {
  return JSON.stringify([a.choice ?? null, a.text ?? null, a.done ?? null, a.name ?? null])
    === JSON.stringify([b.choice ?? null, b.text ?? null, b.done ?? null, b.name ?? null])
}

/** What the submission means for the step, or a refusal: the step must exist and take this kind. */
function entryValue(prework: StoredPrework, submission: PreworkSubmission): Omit<PreworkEntry, 'id' | 'seq' | 'at' | 'participant'> {
  const step = prework.form!.steps.find((candidate) => candidate.id === submission.stepId)
  if (!step) throw new PreworkError('unknown_step', 'That step is not part of the pre-work.', 400)
  const base = { stepId: step.id, kind: submission.kind }
  switch (submission.kind) {
    case 'read':
      return base
    case 'done':
      if (step.kind !== 'task' || !step.done) throw new PreworkError('not_a_task', 'Only a pre-task can be marked as done.', 400)
      return { ...base, done: submission.done === true }
    case 'question':
      if (!step.questions) throw new PreworkError('questions_off', 'Questions are off for this step.', 400)
      return { ...base, text: submission.text, ...(submission.name ? { name: submission.name } : {}) }
    case 'answer': {
      if (!step.poll) throw new PreworkError('not_a_question', 'This step takes no answer.', 400)
      const answer = validPreworkAnswer(step.poll, submission)
      if (!answer) throw new PreworkError('invalid_answer', 'The answer does not fit this step.', 400)
      return { ...base, ...answer }
    }
  }
}

/**
 * Accept a participant's submission. `participant` is the hash of the device's id (the object makes
 * it). Returns the entry as stored and whether anything changed; throws a PreworkError otherwise.
 */
export function submitPrework(prework: StoredPrework, store: PreworkStore, participant: string, submission: PreworkSubmission, now: number, sourceKey = 'unknown'):
  { entry: PreworkEntry; changed: boolean } {
  const phase = preworkPhase(prework, now)
  if (phase === null) throw new PreworkError('not_found', 'Pre-work not found.', 404)
  if (phase === 'not_yet') throw new PreworkError('prework_not_open', 'Pre-work has not opened yet.', 409, { opensAt: prework.opensAt })
  if (phase === 'closed') throw new PreworkError('prework_closed', 'Pre-work has closed.', 410)

  const print = fingerprint(participant, submission)
  const known = store.submission(submission.submissionId)
  if (known) {
    if (known.fingerprint !== print) throw new PreworkError('submission_conflict', 'A different submission already uses this id.', 409)
    const stored = store.entry(known.entryId)
    if (stored) return { entry: stored, changed: false }
  }

  const value = entryValue(prework, submission)
  const entryId = entryIdFor(participant, submission)
  const existing = store.entry(entryId)
  let row = store.participant(participant)
  if (!row && prework.participants >= PREWORK_LIMITS.participants) throw new PreworkError('prework_full', 'This pre-work has no room for more people.', 429)
  // One network source: new participant ids per hour (fixed window).
  const storedSource = store.source(sourceKey)
  const source: SourceRow = storedSource && now - storedSource.windowStart < 3_600_000
    ? { ...storedSource, bucket: { ...storedSource.bucket } }
    : { key: sourceKey, bucket: storedSource ? { ...storedSource.bucket } : { tokens: PREWORK_LIMITS.sourceBurst, at: now }, windowStart: now, newParticipants: 0,
      participantsTotal: storedSource?.participantsTotal ?? 0 }
  if (!row && (source.participantsTotal ?? 0) >= PREWORK_LIMITS.sourceParticipantsTotal) {
    throw new PreworkError('source_limit', 'Too many people from this network for this pre-work.', 429, { retryAfterMs: 3_600_000 })
  }
  if (!row && source.newParticipants >= PREWORK_LIMITS.sourceNewParticipantsPerHour) {
    throw new PreworkError('source_limit', 'Too many people from this network at once. Try again later.', 429, { retryAfterMs: source.windowStart + 3_600_000 - now })
  }
  const fresh = !existing || !sameValue(existing, value)
  if (fresh && row && row.submissions >= PREWORK_LIMITS.participantSubmissions) {
    throw new PreworkError('participant_limit', 'This device has sent as many answers as it can.', 429)
  }
  if (submission.kind === 'question' && row && row.questions >= PREWORK_LIMITS.participantQuestions) {
    throw new PreworkError('question_limit', 'This device has asked as many questions as it can.', 429)
  }
  const nextEntry: PreworkEntry = { id: entryId, seq: prework.seq + 1, participant, ...value, at: now }
  const bytesDelta = fresh ? utf8(nextEntry) - (existing ? utf8(existing) : 0) : 0
  if (bytesDelta > 0 && prework.entryBytes + bytesDelta > PREWORK_LIMITS.entryBytes) throw new PreworkError('prework_full', 'This pre-work has no room for more answers.', 429)

  // Rate: every submission that is not a replay costs a token from the form's bucket and the person's.
  const candidate = row ?? { key: participant, firstAt: now, submissions: 0, questions: 0, bucket: { tokens: PREWORK_LIMITS.participantBurst, at: now } }
  const formBucket = { ...prework.bucket }
  const personBucket = { ...candidate.bucket }
  take(formBucket, PREWORK_LIMITS.perMinute, PREWORK_LIMITS.burst, now)
  take(personBucket, PREWORK_LIMITS.participantPerMinute, PREWORK_LIMITS.participantBurst, now)
  take(source.bucket, PREWORK_LIMITS.sourcePerMinute, PREWORK_LIMITS.sourceBurst, now)
  formBucket.tokens -= 1
  personBucket.tokens -= 1
  source.bucket.tokens -= 1
  prework.bucket = formBucket
  row = { ...candidate, bucket: personBucket }
  if (!store.participant(participant)) {
    // Counted only now, with its first accepted entry: an id that was refused costs nothing.
    prework.participants += 1
    source.newParticipants += 1
    source.participantsTotal = (source.participantsTotal ?? 0) + 1
  }
  store.putSource(source)

  let entry = existing ?? nextEntry
  if (fresh) {
    prework.seq += 1
    prework.entryBytes += Math.max(0, bytesDelta)
    prework.lastActivityAt = now
    row.submissions += 1
    if (submission.kind === 'question') row.questions += 1
    entry = nextEntry
    store.putEntry(entry)
  }
  store.putParticipant(row)
  store.putSubmission(submission.submissionId, print, entryId)
  return { entry, changed: fresh }
}

/** An entry as its own device sees it: no participant hash, no sequence; `ref` names it (`answer:<step>`, `q:<submissionId>`). */
export type OwnPreworkEntry = Omit<PreworkEntry, 'participant' | 'seq' | 'id'> & { ref: string }

export function ownEntry(entry: PreworkEntry): OwnPreworkEntry {
  const { participant, seq: _s, id, ...rest } = entry
  return { ref: id.slice(participant.length + 1), ...rest }
}

/** A participant's own entries ("coming back later"): their reads, answers, done marks and questions. */
export function participantState(store: PreworkStore, participant: string): OwnPreworkEntry[] {
  return store.participantEntries(participant).sort((a, b) => a.seq - b.seq).map(ownEntry)
}

/** The owner's page of entries after `after`, with where the form stands. */
export function resultsPage(prework: StoredPrework, store: PreworkStore, after: number, now: number) {
  const entries = store.entriesAfter(after, PREWORK_LIMITS.resultsPage)
  return {
    seq: prework.seq,
    phase: preworkPhase(prework, now),
    opensAt: prework.opensAt,
    closesAt: prework.closesAt,
    closedAt: prework.closedAt,
    people: prework.participants,
    lastActivityAt: prework.lastActivityAt,
    entries,
    more: entries.length === PREWORK_LIMITS.resultsPage && entries[entries.length - 1].seq < prework.seq,
  }
}

/** `?after=` as a non-negative integer; anything else means "from the start". */
export function parseAfter(value: string | null): number {
  return value !== null && /^\d{1,15}$/.test(value) ? Number(value) : 0
}

/** In-memory store for tests and tools; the object uses SQLite. */
export function createMemoryPreworkStore(): PreworkStore & { entries: Map<string, PreworkEntry> } {
  const submissions = new Map<string, { fingerprint: string; entryId: string }>()
  const entries = new Map<string, PreworkEntry>()
  const participants = new Map<string, ParticipantRow>()
  const sources = new Map<string, SourceRow>()
  const clone = <T>(value: T): T => structuredClone(value)
  return {
    entries,
    submission: (id) => submissions.has(id) ? clone(submissions.get(id)!) : null,
    putSubmission: (id, print, entryId) => { submissions.set(id, { fingerprint: print, entryId }) },
    entry: (id) => entries.has(id) ? clone(entries.get(id)!) : null,
    putEntry: (entry) => { entries.set(entry.id, clone(entry)) },
    participant: (key) => participants.has(key) ? clone(participants.get(key)!) : null,
    putParticipant: (row) => { participants.set(row.key, clone(row)) },
    entriesAfter: (after, limit) => [...entries.values()].filter((entry) => entry.seq > after).sort((a, b) => a.seq - b.seq).slice(0, limit).map(clone),
    participantEntries: (key) => [...entries.values()].filter((entry) => entry.participant === key).map(clone),
    source: (key) => sources.has(key) ? clone(sources.get(key)!) : null,
    putSource: (row) => { sources.set(row.key, clone(row)) },
  }
}

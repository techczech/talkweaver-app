// Pre-work questions in the presenter's questions tray (feedback-boards ticket 11; round-3 rule 14, R5).
//
// "Put in the talk's questions" marks a pre-work question `inTalk` on the Run. While the talk is presented
// with that Run bound, main hands those questions to the presenter window beside the phones' questions,
// flagged "From pre-work" and placed on the slide the step feeds (or, with no slide, on whichever slide the
// presenter is on: `slideId` ''). They come from the Run and go nowhere else: not to the Worker, and so not
// to any audience socket. Mark answered on one writes back to the Run, never to the Worker.
// Text and names are the participants' (untrusted): the tray renders them as text only, and a name is here
// only where the participant typed one.
import { markRunPreworkQuestion, persistRunForTalk, readRunForTalk, type RunRecord } from './runs.ts'

export const PREWORK_QUESTION_PREFIX = 'pw:'

/** One pre-work question as the tray takes it: the tray's own shape plus the flag. */
export interface PreworkTrayQuestion {
  questionId: string
  text: string
  name?: string
  /** The compiled slide it comes up on; '' = the slide the presenter is on. */
  slideId: string
  tMs: number
  acceptedAt: number
  answered: boolean
  fromPrework: true
}

export const isPreworkQuestionId = (value: unknown): value is string =>
  typeof value === 'string' && value.startsWith(PREWORK_QUESTION_PREFIX) && value.length > PREWORK_QUESTION_PREFIX.length

/** The Run's pre-work questions that were put in the talk's questions, oldest first. */
export function preworkTrayQuestions(run: RunRecord | null | undefined): PreworkTrayQuestion[] {
  return (run?.prework?.entries ?? []).filter((entry) => entry.kind === 'question' && entry.inTalk !== undefined && typeof entry.text === 'string')
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    .map((entry) => ({
      questionId: `${PREWORK_QUESTION_PREFIX}${entry.id}`, text: entry.text as string, ...(entry.name ? { name: entry.name } : {}),
      slideId: entry.inTalk?.slideId ?? '', tMs: 0, acceptedAt: entry.at, answered: entry.answered === true, fromPrework: true as const,
    }))
}

/** The tray's list for a live session bound to a Run (empty when it is bound to none or the Run cannot be read). */
export function preworkTrayForSession(vaultRoot: string | null, bound: { talkSlug: string; runId?: string } | null): PreworkTrayQuestion[] {
  if (!vaultRoot || !bound?.runId) return []
  try { return preworkTrayQuestions(readRunForTalk(vaultRoot, bound.talkSlug, bound.runId)) } catch { return [] }
}

export type PreworkTrayAnswer = { success: true; questions: PreworkTrayQuestion[] } | { success: false; error: string }

/** Mark answered (or not) on a pre-work tray question: written to the Run, from a fresh read. */
export function answerPreworkTrayQuestion(vaultRoot: string | null, bound: { talkSlug: string; runId?: string } | null, questionId: string, answered: boolean): PreworkTrayAnswer {
  if (!vaultRoot || !bound?.runId || !isPreworkQuestionId(questionId)) return { success: false, error: 'That question is not on this talk’s Run.' }
  try {
    const run = readRunForTalk(vaultRoot, bound.talkSlug, bound.runId)
    if (!run) return { success: false, error: 'This Run is no longer in the vault.' }
    const entryId = questionId.slice(PREWORK_QUESTION_PREFIX.length)
    if (!run.prework?.entries.some((entry) => entry.id === entryId && entry.kind === 'question' && entry.inTalk !== undefined)) return { success: false, error: 'That question is not in the talk’s questions.' }
    const saved = persistRunForTalk(vaultRoot, bound.talkSlug, bound.runId, markRunPreworkQuestion(run, entryId, { answered }))
    return { success: true, questions: preworkTrayQuestions(saved) }
  } catch { return { success: false, error: 'Could not mark the question answered. Try again.' } }
}

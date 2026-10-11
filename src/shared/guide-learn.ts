// What the person has tried in the Guide (onboarding 0.38.1 ticket 08). Pure data in, pure data out.
//
// The record lives in app config under `guideLearn`, beside the vault registry and outside every
// vault, so it survives restarts and the removal and restore of the example vault (ticket 12). It has
// its own `version`. Anything unreadable is an empty record: progress is convenience state, and a
// corrupt record must never stop the app or a command.
//
// Events in: a command ran, a chapter was opened, a topic was read (ticket 11). Every event returns
// the same object when it changes nothing, so a caller can tell whether to save and broadcast.
// Chapter rows and counts are derived elsewhere (guide-chapters.ts); this record holds only ids.
import { TASK_GROUPS, type TaskGroup } from './task-groups.ts'
import type { Chapter, ChapterRow } from './guide-chapters.ts'

/** The config.json key holding the record. */
export const GUIDE_LEARN_KEY = 'guideLearn'
export const GUIDE_LEARN_VERSION = 1

export interface GuideLearn {
  version: typeof GUIDE_LEARN_VERSION
  /** Canonical command ids that have run at least once, in the order they first ran. */
  ran: string[]
  /** Chapters (task group names) opened at least once. */
  opened: TaskGroup[]
  /** Chapter name to the time (epoch ms) its last command was first run. */
  finished: Partial<Record<TaskGroup, number>>
  /** Topic ids opened at least once: the How it works and Features lists' Read (ticket 11 owns the ids). */
  read: string[]
}

const MAX_ID = 100
const MAX_RAN = 1000
const MAX_READ = 200

export const emptyGuideLearn = (): GuideLearn => ({ version: GUIDE_LEARN_VERSION, ran: [], opened: [], finished: {}, read: [] })

const isChapter = (value: unknown): value is TaskGroup => typeof value === 'string' && (TASK_GROUPS as readonly string[]).includes(value)
const isId = (value: unknown): value is string => typeof value === 'string' && value !== '' && value.length <= MAX_ID

/** Read what config holds. A missing, foreign or unreadable record is the empty one. */
export function guideLearnFrom(stored: unknown): GuideLearn {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return emptyGuideLearn()
  const { version, ran, opened, finished, read } = stored as Record<string, unknown>
  if (version !== GUIDE_LEARN_VERSION) return emptyGuideLearn()
  const out = emptyGuideLearn()
  if (Array.isArray(ran)) out.ran = [...new Set(ran.filter(isId))].slice(0, MAX_RAN)
  if (Array.isArray(opened)) out.opened = [...new Set(opened.filter(isChapter))]
  if (Array.isArray(read)) out.read = [...new Set(read.filter(isId))].slice(0, MAX_READ)
  if (finished && typeof finished === 'object' && !Array.isArray(finished)) {
    for (const [chapter, at] of Object.entries(finished)) {
      if (isChapter(chapter) && typeof at === 'number' && Number.isFinite(at)) out.finished[chapter] = at
    }
  }
  return out
}

/** Event: a command (by canonical id) ran. The caller has resolved the id and applied decision 12. */
export function withCommandRan(learn: GuideLearn, id: unknown): GuideLearn {
  if (!isId(id) || learn.ran.includes(id) || learn.ran.length >= MAX_RAN) return learn
  return { ...learn, ran: [...learn.ran, id] }
}

/** Event: a chapter was opened in the Guide. */
export function withChapterOpened(learn: GuideLearn, chapter: unknown): GuideLearn {
  if (!isChapter(chapter) || learn.opened.includes(chapter)) return learn
  return { ...learn, opened: [...learn.opened, chapter] }
}

/** Event: a topic was opened, so it reads "Read". */
export function withTopicRead(learn: GuideLearn, topic: unknown): GuideLearn {
  if (!isId(topic) || learn.read.includes(topic) || learn.read.length >= MAX_READ) return learn
  return { ...learn, read: [...learn.read, topic] }
}

/** Event: every counted row of the chapter has been tried. The first date stays. */
export function withChapterFinished(learn: GuideLearn, chapter: unknown, at: number): GuideLearn {
  if (!isChapter(chapter) || learn.finished[chapter] !== undefined || !Number.isFinite(at)) return learn
  return { ...learn, finished: { ...learn.finished, [chapter]: at } }
}

/** Has any command of the row run? A merged row is ticked when any of its commands has. */
export const rowTried = (row: ChapterRow, learn: GuideLearn): boolean => row.ids.some((id) => learn.ran.includes(id))

export const triedCount = (chapter: Chapter, learn: GuideLearn): number => chapter.rows.filter((row) => rowTried(row, learn)).length

/** Is every counted row of the chapter ticked? A chapter with no rows is never finished. */
export const chapterComplete = (chapter: Chapter, learn: GuideLearn): boolean => chapter.rows.length > 0 && triedCount(chapter, learn) === chapter.rows.length

/** What a chapter row says about itself (the drawing's four histories). */
export type ChapterHistory =
  | { kind: 'not-opened' }
  | { kind: 'opened' }
  | { kind: 'tried'; tried: number; total: number }
  | { kind: 'finished'; at: number }

/**
 * The history of one chapter. `tried` and `total` count rows (a merged row counts once). Finished is
 * kept once earned, even if the build later adds a command. Opened with nothing tried reads
 * "Opened"; anything tried reads "N of M tried"; nothing at all reads "Not opened".
 */
export function chapterHistory(learn: GuideLearn, chapter: Chapter): ChapterHistory {
  const at = learn.finished[chapter.task]
  if (at !== undefined) return { kind: 'finished', at }
  const tried = triedCount(chapter, learn)
  if (tried > 0) return { kind: 'tried', tried, total: chapter.rows.length }
  return learn.opened.includes(chapter.task) ? { kind: 'opened' } : { kind: 'not-opened' }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "6 Oct": the day and the short month, as drawn. */
export function guideDate(at: number): string {
  const date = new Date(at)
  return `${date.getDate()} ${MONTHS[date.getMonth()]}`
}

/** The drawn strings of a chapter's history (TEXT.status in the drawing's text module). */
export function chapterHistoryText(history: ChapterHistory): string {
  switch (history.kind) {
    case 'not-opened': return 'Not opened'
    case 'opened': return 'Opened'
    case 'tried': return `${history.tried} of ${history.total} tried`
    case 'finished': return `Finished ${guideDate(history.at)}`
  }
}

/** "1 of 10 finished": the count on the Chapters bar. */
export const finishedCountText = (chapters: readonly Chapter[], learn: GuideLearn): string =>
  `${chapters.filter((chapter) => learn.finished[chapter.task] !== undefined).length} of ${chapters.length} finished`

/** Nothing opened, tried or finished yet: the first chapter reads "Start here". */
export const hasNoProgress = (learn: GuideLearn): boolean => learn.ran.length === 0 && learn.opened.length === 0 && Object.keys(learn.finished).length === 0

/** The chapter after this one in the ten-group order, or null after the last. */
export function nextChapter(chapters: readonly Chapter[], task: TaskGroup): Chapter | null {
  const at = chapters.findIndex((chapter) => chapter.task === task)
  return at >= 0 && at + 1 < chapters.length ? chapters[at + 1] : null
}

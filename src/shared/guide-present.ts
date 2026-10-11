// The Guide in the presenter (onboarding 0.38.1 ticket 10; locked drawing state 07): the Present
// chapter as its own column beside Next and Notes. Pure data in, pure data out.
//
// What the presenter window receives is this module's `PresentGuideView` and nothing else: the
// Present chapter's rows (label, tried, keys), its sub-group and chapter counts, the practice talk
// line and the number of live commands listed apart. Never the learn record, other chapters, paths
// or settings: the deck window renders author content, so it is told only what the column draws.
//
// What the presenter may send back: the id of a presenter command that ran, one of the registries'
// presenter ids (`isPresenterCommandId`).
import { CHAPTER_TALK, rowChords, shortChord, subgroupLabel, type Chapter } from './guide-chapters.ts'
import { chapterHistory, chapterHistoryText, rowTried, triedCount, type GuideLearn } from './guide-learn.ts'
import { PRESENTER_PALETTE } from './presenter-palette.ts'
import { SHORTCUT_REGISTRY } from './shortcut-registry.ts'

/** The column's widest (state 07's 400 px). It takes this room inside the page; the window never resizes. */
export const GUIDE_COLUMN_WIDTH = 400
/** The narrowest the column gets on a narrow window. */
export const GUIDE_COLUMN_MIN_WIDTH = 320
/** The presenter grid's gap (presenter-root `gap: 14px`): the column sits one gap from the panels. */
export const GUIDE_COLUMN_GAP = 14
/** The column's width in the page: `clamp(320px, 24vw, 400px)`. */
export const GUIDE_COLUMN_CSS_WIDTH = `clamp(${GUIDE_COLUMN_MIN_WIDTH}px, 24vw, ${GUIDE_COLUMN_WIDTH}px)`

/** The DOM event the presenter runtime dispatches when one of its commands ran (ticket 08's bridge entry). */
export const GUIDE_COMMAND_RAN_EVENT = 'tw-guide-command-ran'

/**
 * Every command id the presenter may report, and nothing else: the shortcut registry's `presenter.*`
 * ids and the presenter palette's entries as `presenter-palette.<id>`. A finite list from the
 * registries, so a deck page cannot make up ids (review round 1).
 */
export const PRESENTER_COMMAND_IDS: ReadonlySet<string> = new Set([
  ...SHORTCUT_REGISTRY.filter((row) => row.id.startsWith('presenter.')).map((row) => row.id),
  ...PRESENTER_PALETTE.flatMap(([, entries]) => entries.map((entry) => `presenter-palette.${entry.id}`))
])

/** A command id the presenter may report: one of PRESENTER_COMMAND_IDS. Anything else from a deck window is dropped. */
export function isPresenterCommandId(id: unknown): id is string {
  return typeof id === 'string' && PRESENTER_COMMAND_IDS.has(id)
}

export interface PresentGuideRow {
  /** The row's key (its first command id): used to flash a row that has just ticked. */
  id: string
  label: string
  tried: boolean
  /** The keys the row shows, each already shortened as drawn ("→ Space +3"); none for a variants row. */
  keys: string[]
  /** A row with no key and no variants shows "no key". */
  noKey: boolean
}
export interface PresentGuideSubgroup { name: string; tried: number; total: number; rows: PresentGuideRow[] }
export interface PresentGuideView {
  tried: number
  total: number
  /** "13 of 47 tried", or "Finished 6 Oct" once earned. */
  status: string
  practice: { talk: string; section: string; openNow: boolean }
  subgroups: PresentGuideSubgroup[]
  /** The live commands, listed apart and not counted. */
  live: number
}

/**
 * The Present chapter as the presenter's column shows it. `chordOf` gives a shortcut id's key text
 * (the registry's). `openNow` says whether the presenter shows the chapter's practice talk.
 */
export function presentGuideView(chapter: Chapter, learn: GuideLearn, chordOf: (shortcutId: string) => string, openNow: boolean): PresentGuideView {
  const [talk, section] = CHAPTER_TALK[chapter.task]
  const tried = triedCount(chapter, learn)
  const history = chapterHistory(learn, chapter)
  return {
    tried,
    total: chapter.rows.length,
    status: history.kind === 'finished' ? chapterHistoryText(history) : chapterHistoryText({ kind: 'tried', tried, total: chapter.rows.length }),
    practice: { talk, section, openNow },
    subgroups: chapter.subgroups.map((group) => {
      const rows = group.rows.map((row) => {
        const keys = rowChords(row, chordOf).map(shortChord)
        return { id: row.id, label: row.label, tried: rowTried(row, learn), keys, noKey: keys.length === 0 && row.merged !== 'variants' }
      })
      return { name: subgroupLabel(group.name), tried: rows.filter((row) => row.tried).length, total: rows.length, rows }
    }),
    live: chapter.live.length
  }
}

/** The chip's text after "Guide · ": "Present 13 of 47". */
export const guideChipCount = (view: Pick<PresentGuideView, 'tried' | 'total'>): string => `${view.tried} of ${view.total}`

/**
 * A view as it arrives in the presenter: anything that is not the shape above is no view (the chip
 * and the column stay away). The preload checks before it draws; strings are only ever set as text.
 */
export function isPresentGuideView(value: unknown): value is PresentGuideView {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  const isNum = (n: unknown): boolean => typeof n === 'number' && Number.isFinite(n) && n >= 0
  const practice = v.practice as Record<string, unknown> | undefined
  if (!isNum(v.tried) || !isNum(v.total) || !isNum(v.live) || typeof v.status !== 'string') return false
  if (!practice || typeof practice.talk !== 'string' || typeof practice.section !== 'string' || typeof practice.openNow !== 'boolean') return false
  if (!Array.isArray(v.subgroups)) return false
  return v.subgroups.every((group: unknown) => {
    const g = group as Record<string, unknown>
    return !!g && typeof g.name === 'string' && isNum(g.tried) && isNum(g.total) && Array.isArray(g.rows) && g.rows.every((row: unknown) => {
      const r = row as Record<string, unknown>
      return !!r && typeof r.id === 'string' && typeof r.label === 'string' && typeof r.tried === 'boolean' && typeof r.noKey === 'boolean' && Array.isArray(r.keys) && r.keys.every((k) => typeof k === 'string')
    })
  })
}

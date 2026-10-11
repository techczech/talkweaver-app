// Where the Guide's chapter progress is kept (onboarding 0.38.1 ticket 08): ONE key in app config
// (`guideLearn`, src/shared/guide-learn.ts), beside the vault registry and never inside a vault, so
// it survives restarts and the removal and restore of the example vault.
//
// Every window reports to main, and main is the one writer: each event reads the record, applies the
// pure change, and saves and announces only when something changed. The save is the config file's own
// write path (atomic: temp file and rename, config-file.ts). A corrupt record reads as empty.
//
// A report can never fail a command: every method here swallows its own errors.
import { deriveChapters, chapterOfCommand, isLiveCommand, resolveCommandId, DELETING_COMMANDS, type Chapter, type ChapterCommand } from '../shared/guide-chapters.ts'
import {
  GUIDE_LEARN_KEY, chapterComplete, guideLearnFrom, withChapterFinished, withChapterOpened, withCommandRan, withTopicRead,
  type GuideLearn
} from '../shared/guide-learn.ts'

export interface GuideLearnStoreDeps {
  /** The raw value of `guideLearn` in app config. */
  read: () => unknown
  /** Save the record under `guideLearn` (the config file's atomic write). */
  write: (record: GuideLearn) => void
  /** Epoch ms; the date a chapter finished. */
  now?: () => number
  /** The commands the chapters come from (this build's registries by default). */
  commands?: readonly ChapterCommand[]
}

/** What a report said about where it happened. Only main decides what "inside the example" means. */
export interface RunContext { inExample: boolean }

export interface RunOutcome {
  /** The command's canonical id, or null when the id belongs to no chapter. */
  id: string | null
  /** True when this run ticked a row for the first time. */
  ticked: boolean
}

export class GuideLearnStore {
  /** Set by main: pushes the new record to every window. */
  onChange: (record: GuideLearn) => void = () => {}
  readonly #deps: GuideLearnStoreDeps
  #chapters: Chapter[] | null = null

  constructor(deps: GuideLearnStoreDeps) {
    this.#deps = deps
  }

  chapters(): Chapter[] {
    if (!this.#chapters) this.#chapters = deriveChapters(this.#deps.commands)
    return this.#chapters
  }

  read(): GuideLearn {
    try { return guideLearnFrom(this.#deps.read()) } catch { return guideLearnFrom(null) }
  }

  #apply(change: (learn: GuideLearn) => GuideLearn): boolean {
    try {
      const before = this.read()
      const after = change(before)
      if (after === before) return false
      this.#deps.write(after)
      try { this.onChange(after) } catch { /* a window closing */ }
      return true
    } catch {
      return false
    }
  }

  /**
   * A command ran, by any route in any window. The id may be a command id, the shortcut id it carries
   * or its handler id. Commands that delete tick only inside the example vault (lock decision 12).
   */
  commandRan(raw: unknown, context: RunContext): RunOutcome {
    let id: string | null = null
    try {
      id = resolveCommandId(raw, this.#deps.commands)
      if (id === null) return { id: null, ticked: false }
      if (DELETING_COMMANDS.has(id) && !context.inExample) return { id, ticked: false }
      const canonical = id
      const ticked = this.#apply((learn) => {
        const next = withCommandRan(learn, canonical)
        if (next === learn) return learn
        const chapter = chapterOfCommand(this.chapters(), canonical)
        // The date a chapter finishes is the moment its last row was first ticked.
        return chapter && chapterComplete(chapter, next) ? withChapterFinished(next, chapter.task, (this.#deps.now ?? Date.now)()) : next
      })
      // A live command is recorded but is not a row of any count, so it does not announce a tick.
      return { id, ticked: ticked && !isLiveCommand(this.chapters(), canonical) }
    } catch {
      return { id, ticked: false }
    }
  }

  chapterOpened(task: unknown): boolean { return this.#apply((learn) => withChapterOpened(learn, task)) }
  topicRead(topic: unknown): boolean { return this.#apply((learn) => withTopicRead(learn, topic)) }
}

export { GUIDE_LEARN_KEY }

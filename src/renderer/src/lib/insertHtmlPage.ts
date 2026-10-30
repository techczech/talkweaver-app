import type { HtmlPageChoice, HtmlPageImport } from '../../../shared/html-page-import'

/**
 * Insert › HTML page… in the renderer: the picker and the copy are main's (src/main/html-page-import.ts);
 * this step only decides whether the answer may still go into the editor. The talk is named when the
 * command runs and checked again after each wait: if another talk is open by then, nothing is
 * inserted (and, when the picker was still open, nothing is copied either). The line is written by
 * `insert` — the editor's own caret insert, one transaction, one Undo step — so the talk's unsaved
 * text and history are kept.
 */
export type HtmlPageInsertDeps = {
  /** The outline path of the talk open in the editor now, or null. */
  currentTalk: () => string | null
  choose: (outlinePath: string) => Promise<HtmlPageChoice | null>
  importPage: (token: string, outlinePath: string) => Promise<HtmlPageImport>
  /** Writes `text` at the caret of the open editor; false when there is no editor. */
  insert: (text: string) => boolean
  notify: (message: string, kind: 'info' | 'success' | 'warning' | 'error') => void
}

export type HtmlPageInsertOutcome = 'inserted' | 'cancelled' | 'refused' | 'no-talk' | 'talk-changed' | 'busy'

export const HTML_PAGE_INSERT_TEXT = {
  noTalk: 'Open a talk first, then insert the HTML page.',
  talkChangedBeforeCopy: 'Another talk was opened while the file picker was open, so nothing was added. Choose the page again.',
  talkChangedAfterCopy: (embedPath: string): string =>
    `The page was copied into the first talk’s folder as ${embedPath}, but another talk is open now, so no line was inserted.`,
  inserted: (embedPath: string, how: 'copied' | 'reused' | 'in-talk'): string =>
    how === 'copied' ? `HTML page copied into the talk as ${embedPath} and inserted.`
      : how === 'reused' ? `HTML page inserted: ${embedPath} was already in the talk, so nothing was copied.`
        : `HTML page inserted from the talk’s folder: ${embedPath}.`,
  /** Said after every insert: the page's companion files are never copied, and the scan cannot find them all. */
  onlyThisFile: 'Only this HTML file is used: pictures, styles or scripts it loads from files beside it are not copied and will not show on the slide. Put them inside the HTML file to keep them.',
  namedFiles: (names: string[]): string => `It names ${names.join(', ')}.`
} as const

export const htmlPageEmbedLine = (embedPath: string): string => `[Embed: ${embedPath}]`

export function createHtmlPageInserter(deps: HtmlPageInsertDeps): () => Promise<HtmlPageInsertOutcome> {
  let running = false
  return async () => {
    if (running) return 'busy'
    const talk = deps.currentTalk()
    if (!talk) { deps.notify(HTML_PAGE_INSERT_TEXT.noTalk, 'info'); return 'no-talk' }
    running = true
    try {
      const choice = await deps.choose(talk)
      if (choice === null) return 'cancelled'
      if (!choice.ok) { deps.notify(choice.message, 'error'); return 'refused' }
      if (deps.currentTalk() !== talk) { deps.notify(HTML_PAGE_INSERT_TEXT.talkChangedBeforeCopy, 'warning'); return 'talk-changed' }
      const result = await deps.importPage(choice.token, talk)
      if (!result.ok) { deps.notify(result.message, 'error'); return 'refused' }
      if (deps.currentTalk() !== talk || !deps.insert(htmlPageEmbedLine(result.embedPath))) {
        deps.notify(HTML_PAGE_INSERT_TEXT.talkChangedAfterCopy(result.embedPath), 'warning')
        return 'talk-changed'
      }
      // Always the portability note (review 2026-10-27, F3): an empty list of names does not mean the
      // page needs nothing beside it, so no insert is reported as complete without it.
      const named = result.localReferences.length ? ` ${HTML_PAGE_INSERT_TEXT.namedFiles(result.localReferences)}` : ''
      deps.notify(`${HTML_PAGE_INSERT_TEXT.inserted(result.embedPath, result.how)} ${HTML_PAGE_INSERT_TEXT.onlyThisFile}${named}`, result.localReferences.length ? 'warning' : 'success')
      return 'inserted'
    } catch {
      deps.notify('The HTML page could not be inserted.', 'error')
      return 'refused'
    } finally {
      running = false
    }
  }
}

// A publication reaching a presenter window that is already open (no Electron import: tests run it as
// is). A presenter window keeps the link it goes live with in main (`LivePresenterContext`), read once
// when it opens, so a window opened while an upload was under way had no link when the upload finished.
// This hands it the link when the publication has really succeeded. It changes that link and says so
// (`announce`): the page, the slide and the session stay as they are, and starting a session stays the person's.
import type { LivePresenterContext } from './live-session-manager'

export type PresenterWindow = { outlinePath: string; mode: string; runId?: string }

export type PresenterPublication =
  | { kind: 'talk'; outlinePath: string; url: string; retainUrl?: boolean }
  | { kind: 'run'; outlinePath: string; runId: string; url: string; folder?: string }

/** The link a presenter window opens with: the planned Run's own, the talk's, or a handout file on this computer. */
export function presenterLink(from: {
  run: { handoutUrl?: string; handoutFolder?: string; unpublishedAt?: string } | null | undefined
  outlineUrl: string | null
  localUrl: string | null
}): { shortUrl: string | null; runLink?: { folder?: string } } {
  const { run } = from
  if (run?.handoutUrl && !run.unpublishedAt) return { shortUrl: run.handoutUrl, runLink: run.handoutFolder ? { folder: run.handoutFolder } : {} }
  return { shortUrl: from.outlineUrl ?? from.localUrl }
}

/** The site's folder a window's link leads to; null for a Run's link whose folder was never recorded. */
export function liveLinkFolder(context: Pick<LivePresenterContext, 'talkSlug' | 'runLink'>): string | null {
  if (!context.runLink) return context.talkSlug
  return context.runLink.folder ?? null
}

export function createPresenterPublications(deps: {
  /** Read when a result arrives: a window opened after the publication began is one of them. */
  windows(): Iterable<[number, PresenterWindow]>
  contexts: Map<number, LivePresenterContext>
  isOpen(wcId: number): boolean
  /** The window's link changed; `first` when it had no web address before. */
  announce(wcId: number, change: { url: string | null; first: boolean }): void
}) {
  let tickets = 0
  /** The newest publication applied to each Talk and Run: a late result of an earlier one is ignored. */
  const newest = new Map<string, number>()
  // Some valid outlines have no frontmatter to stamp. Keep their successful link for a presenter
  // whose compile finishes after publication, or which is opened again in this app session.
  const talkUrls = new Map<string, string>()
  const key = (publication: PresenterPublication): string => (publication.kind === 'run' ? `run\0${publication.outlinePath}\0${publication.runId}` : `talk\0${publication.outlinePath}`)
  const matches = (publication: PresenterPublication, window: PresenterWindow, context: LivePresenterContext): boolean => {
    if (window.mode !== 'presenter' || window.outlinePath !== publication.outlinePath) return false
    // A talk's publication is a Run's link too, as it is when that Run's presenter opens, until the Run has its own.
    return publication.kind === 'run' ? window.runId === publication.runId : !context.runLink
  }
  return {
    /** Taken when a publish is asked for, before it joins the site's queue. */
    ticket(): number { tickets += 1; return tickets },
    talkUrl(outlinePath: string): string | null { return talkUrls.get(outlinePath) ?? null },
    /** Successful removal only; its ticket also rejects a delayed pre-removal publication result. */
    forgetTalk(ticket: number, outlinePath: string): void {
      const talkKey = key({ kind: 'talk', outlinePath, url: '' })
      if (ticket < (newest.get(talkKey) ?? 0)) return
      newest.set(talkKey, ticket)
      talkUrls.delete(outlinePath)
      for (const [wcId, window] of deps.windows()) {
        const context = deps.contexts.get(wcId)
        if (!context || context.runLink || !/^https?:\/\//i.test(context.shortUrl ?? '')
          || !deps.isOpen(wcId) || window.mode !== 'presenter' || window.outlinePath !== outlinePath) continue
        deps.contexts.set(wcId, { ...context, shortUrl: null })
        deps.announce(wcId, { url: null, first: false })
      }
    },
    /** Successful removal of this Run's own page: return its presenters to the talk link, if any. */
    unpublishedRun(ticket: number, run: { outlinePath: string; runId: string }, fallbackUrl: string | null): number[] {
      const runKey = key({ kind: 'run', ...run, url: '' })
      if (ticket < (newest.get(runKey) ?? 0)) return []
      newest.set(runKey, ticket)
      const talkUrl = fallbackUrl && /^https?:\/\/\S+$/i.test(fallbackUrl) ? fallbackUrl : null
      const reached: number[] = []
      for (const [wcId, window] of deps.windows()) {
        const context = deps.contexts.get(wcId)
        if (!context?.runLink || !deps.isOpen(wcId) || window.mode !== 'presenter'
          || window.outlinePath !== run.outlinePath || window.runId !== run.runId) continue
        const { runLink: _removed, ...talkContext } = context
        deps.contexts.set(wcId, { ...talkContext, shortUrl: talkUrl })
        deps.announce(wcId, { url: talkUrl, first: false })
        reached.push(wcId)
      }
      return reached
    },
    /** A publication that succeeded: gives its link to the windows it belongs to, and answers which took it. */
    published(ticket: number, publication: PresenterPublication): number[] {
      const url = String(publication.url ?? '')
      if (!/^https?:\/\/\S+$/i.test(url) || ticket < (newest.get(key(publication)) ?? 0)) return []
      newest.set(key(publication), ticket)
      if (publication.kind === 'talk') {
        if (publication.retainUrl) talkUrls.set(publication.outlinePath, url)
        else talkUrls.delete(publication.outlinePath)
      }
      const reached: number[] = []
      for (const [wcId, window] of deps.windows()) {
        const context = deps.contexts.get(wcId)
        if (!context || !deps.isOpen(wcId) || !matches(publication, window, context) || context.shortUrl === url) continue
        const first = !/^https?:\/\//i.test(context.shortUrl ?? '')
        deps.contexts.set(wcId, { ...context, shortUrl: url, ...(publication.kind === 'run' ? { runLink: publication.folder ? { folder: publication.folder } : {} } : {}) })
        deps.announce(wcId, { url, first })
        reached.push(wcId)
      }
      return reached
    },
  }
}

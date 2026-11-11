import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, CalendarPlus, Inbox, Mic, Radio, RefreshCw, Search, Settings, SlidersHorizontal, X } from 'lucide-react'
import type { RecordingSession } from '../../../preload/index'
import {
  DEFAULT_RUN_KINDS, RUN_KINDS, RUN_KIND_LABELS, SESSION_FILTERS, SESSION_FILTER_LABELS, SESSION_GROUPS, SESSION_GROUP_LABELS, SESSION_SORTS, SESSION_SORT_LABELS,
  responsesBadge, selectSessionRow, sessionList, sessionLiveKey, sessionRunKey,
  type RunKind, type SessionFilter, type SessionGroupBy, type SessionRow, type SessionSort, type SessionSource
} from '../../../shared/sessions-list'
import { runActionEffect, runPageChecklist, unpublishConfirmText, type RunPageEffect } from '../../../shared/run-page'
import { runInvitationText } from '../../../shared/run-invitation'
import type { WorkFileState } from '../../../shared/run-checklist'
import type { ToolsRunRef } from '../../../shared/tools-views'
import { recordingRunKey } from '../../../shared/recording-run-home'
import { plainTalkTitle } from '../../../shared/plain-title'
import { shortDate } from '../../../shared/plan-run'
import type { RecordingRecovery } from '../../../shared/recording-recovery'
import { presentRun } from '../lib/present-run'
import { goLiveFromSessions, openResultsFromSessions } from '../lib/session-run-actions'
import { useToolsActions } from '../lib/toolsActions'
import { openSettingsAt } from '../lib/open-settings'
import { notify } from '../lib/notify'
import { RESPONSES_SEEN_EVENT } from './RunAnswers'
import PlanRunSheet, { type PlanRunTalk } from './PlanRunSheet'
import { RunPage } from './RunPage'
import { RunLedger } from './RunLedger'
import { StateBadge, badgeStateOfPill } from './StateBadge'
import { UnpublishRunConfirm } from './UnpublishRunConfirm'
import { ConfirmCard, BIN_CONSEQUENCE } from './cards'
import KeyboardHelp from './KeyboardHelp'
import '../ui-kit.css'
import '../tools-rail.css'
import '../sessions-view.css'

/** A Run kept in this computer's app data (no vault could hold it) as a list entry; it has its ledger and no Run page. */
function keptSource(run: RecordingSession): SessionSource {
  return {
    vaultId: 'app-data', talkSlug: run.talkSlug, runId: run.id, talkTitle: run.talkTitle, kind: run.kind, status: 'delivered', startedAt: run.startedAt || undefined,
    ...(run.eventTitle ? { eventTitle: run.eventTitle } : {}), ...(run.audience ? { audience: run.audience } : {}), ...(run.context ? { context: run.context } : {}),
    ...(run.audio ? { recorded: true } : {}), ...(run.endedAt ? { endedAt: run.endedAt } : {}), kept: 'app-data',
    lengthMs: run.audio ? run.recordingMs : run.wallClockMs
  }
}

const rowState = (row: SessionRow): 'planned' | 'published' | 'delivered' | 'live' | 'notset' => (row.phase === 'publishing' ? 'planned' : badgeStateOfPill(row.pill.kind))

function fmtLength(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000))
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`
}

function RowBadge({ row }: { row: SessionRow }): JSX.Element {
  return <StateBadge state={rowState(row)} small data-pill-kind={row.pill.kind}>{row.pill.label}</StateBadge>
}

/**
 * The Runs view (house rule R5, consistency batch 3): every Run of every open vault in one list, with History's
 * filters, sort and grouping in the one toolbar row, and a detail pane that is the Run's page for any Run and, for a
 * Run that has been given, its ledger (the recording, the handout, the polls, the board, the questions). It replaces
 * the Sessions view and History. Order, grouping and row text come from src/shared/sessions-list.ts; the status
 * badge from the Run checklist. Selecting a row selects the Run (`run`, `onSelect`).
 *
 * Nothing here changes what is written or where: the Run page's actions are the Sessions view's, the ledger's are
 * History's, and the same calls are made.
 */
export function RunsView({ run, onSelect, planPending, onPlanHandled, resultsRequest, onOpenStudio, onOpenNotes, onShowWorkFile }: {
  run: ToolsRunRef | null
  onSelect: (run: ToolsRunRef) => void
  /** A Plan a Run command asked for the sheet (the Present menu, the menu bar, the palette, the shortcut) and no Runs view has opened it yet. */
  planPending: boolean
  onPlanHandled: () => void
  /** Changes when Open results asks for the Run's ledger: the pane scrolls to it. */
  resultsRequest: number
  onOpenStudio: (sessionId: string) => void
  onOpenNotes: (sessionId: string) => void
  onShowWorkFile: (fileName: string, vaultId: string) => void
}): JSX.Element {
  const [sources, setSources] = useState<SessionSource[] | null>(null)
  const [live, setLive] = useState<ReadonlySet<string>>(new Set())
  const [recovery, setRecovery] = useState<RecordingRecovery[]>([])
  const [now, setNow] = useState(() => new Date())
  const [version, setVersion] = useState(0)
  const [filters, setFilters] = useState<SessionFilter[]>([])
  const [kinds, setKinds] = useState<RunKind[]>([...DEFAULT_RUN_KINDS])
  const [sort, setSort] = useState<SessionSort>('date')
  const [group, setGroup] = useState<SessionGroupBy>('status')
  const [query, setQuery] = useState('')
  const [online, setOnline] = useState(false)
  const [reachable, setReachable] = useState<Record<string, boolean>>({})
  const [viewMenu, setViewMenu] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try {
      const [result, all, interrupted] = await Promise.all([
        window.tw.sessions.list({ allKinds: true }),
        window.tw.history.listRuns().catch(() => [] as RecordingSession[]),
        window.tw.recording.listRecovery().catch(() => [] as RecordingRecovery[])
      ])
      setSources([...result.runs, ...all.filter((candidate) => candidate.kept === 'app-data').map(keptSource)])
      setLive(new Set(result.live))
      setRecovery(interrupted)
    } catch { setSources((current) => current ?? []) }
    setNow(new Date())
    setVersion((n) => n + 1)
  }, [])
  useEffect(() => {
    void load()
    const again = (): void => { void load() }
    window.addEventListener('focus', again)
    // Leaving a Run or Mark all read changed its new count; the timer's count of what waits arrives with talk facts.
    window.addEventListener(RESPONSES_SEEN_EVENT, again)
    const off = window.tw.vault.onTalkMetaUpdated(again)
    const timer = window.setInterval(again, 60_000)
    return () => { window.removeEventListener('focus', again); window.removeEventListener(RESPONSES_SEEN_EVENT, again); off(); window.clearInterval(timer) }
  }, [load])

  // "Still online": a published Run's handout page answers (the same check the ledger shows), checked only while asked for.
  useEffect(() => {
    if (!online || !sources) return
    let cancelled = false
    const urls = [...new Set(sources.map((source) => source.handoutUrl).filter((url): url is string => !!url))]
    for (const url of urls) {
      if (reachable[url] !== undefined) continue
      void window.tw.history.checkLive(url, false).then((res) => { if (!cancelled) setReachable((current) => ({ ...current, [url]: res.status === 'live' })) })
        .catch(() => { if (!cancelled) setReachable((current) => ({ ...current, [url]: false })) })
    }
    return () => { cancelled = true }
  }, [online, sources, reachable])

  // The selected Run's page: how its work files read, a notice for an action that did not go through, and the plan sheet.
  const [files, setFiles] = useState<{ key: string; pre?: WorkFileState; post?: WorkFileState } | null>(null)
  const [notice, setNotice] = useState<{ key: string; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [publishing, setPublishing] = useState<ReadonlySet<string>>(new Set())
  const [qr, setQr] = useState<{ url: string; svg: string } | null>(null)
  const [sheet, setSheet] = useState<{ run: RecordingSession | null; copy?: boolean; talk: PlanRunTalk; talks?: PlanRunTalk[] } | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<{ run: RecordingSession; planned: boolean; vaultId: string } | null>(null)

  const reachableKeys = useMemo(() => {
    if (!online || !sources) return null
    return new Set(sources.filter((source) => source.handoutUrl && reachable[source.handoutUrl] === true).map((source) => `${source.vaultId}|${sessionRunKey(source)}`))
  }, [online, sources, reachable])
  const list = useMemo(
    () => sessionList(sources ?? [], now, { filters, kinds, sort, group, query, live, reachable: reachableKeys }),
    [sources, now, filters, kinds, sort, group, query, live, reachableKeys]
  )
  // The Run by vault, talk and Run id; a reference without a vault only when one vault holds that Run.
  const selected = selectSessionRow(list.rows, run)
  const empty = sources !== null && sources.length === 0
  const source = selected ? sources?.find((candidate) => candidate.vaultId === selected.vaultId && sessionRunKey(candidate) === sessionRunKey(selected.ref)) ?? null : null
  const runKey = source ? `${source.vaultId}|${sessionRunKey(source)}` : null
  const ref = source && source.kept !== 'app-data' ? { vaultId: source.vaultId, talkSlug: source.talkSlug, runId: source.runId } : null

  // The Run this view chose itself (a click, the first row, a filter that moved the selection) as opposed to one named
  // from outside (a link from a published page, the editor's status chip, Open results).
  const own = useRef('')
  const refKey = (target: ToolsRunRef): string => `${target.vaultId ?? ''}|${sessionRunKey(target)}`
  const choose = useCallback((target: ToolsRunRef): void => { own.current = refKey(target); onSelect(target) }, [onSelect])
  useEffect(() => {
    if (!run) { if (list.rows[0]) choose(list.rows[0].ref); return }
    if (selected || !sources) return
    if (refKey(run) === own.current || !run.vaultId && own.current.endsWith(`|${sessionRunKey(run)}`)) {
      // The filters the person chose hide the Run on show: the list opens on its first Run instead.
      if (list.rows[0]) choose(list.rows[0].ref)
    } else if (sources.some((candidate) => sessionRunKey(candidate) === sessionRunKey(run) && (!run.vaultId || candidate.vaultId === run.vaultId))) {
      // A Run named from outside that the filters hide: they step aside so it shows.
      setFilters([]); setQuery(''); setOnline(false)
      const hiddenKind = sources.find((candidate) => sessionRunKey(candidate) === sessionRunKey(run))?.kind
      if (hiddenKind && !kinds.includes(hiddenKind)) setKinds((current) => [...current, hiddenKind])
    }
  }, [run, list.rows, sources, selected, kinds, choose])

  // Re-check live (History's header button and R): boards left open are pulled in, and every published handout is asked again.
  const recheckAll = useCallback(async (): Promise<void> => {
    const boards = await window.tw.history.recheckBoards().catch(() => ({ runs: [] as RecordingSession[], late: 0 }))
    if ('warning' in boards && boards.warning) { notify(boards.warning, 'info'); return }
    const urls = [...new Set((sources ?? []).map((candidate) => candidate.handoutUrl).filter((url): url is string => !!url))]
    if (!urls.length) { notify(boards.runs.length ? `Boards re-checked · ${boards.late} late card${boards.late === 1 ? '' : 's'}` : 'No published handouts to check', 'info'); setVersion((n) => n + 1); return }
    const results: Array<{ status: string }> = []
    for (let start = 0; start < urls.length; start += 6) results.push(...await Promise.all(urls.slice(start, start + 6).map((url) => window.tw.history.checkLive(url, true))))
    setReachable((current) => ({ ...current, ...Object.fromEntries(urls.map((url, index) => [url, results[index]?.status === 'live'])) }))
    setVersion((n) => n + 1)
    notify(`${urls.length} handout${urls.length === 1 ? '' : 's'} re-checked · ${results.filter((r) => r.status === 'live').length} still live`, 'info')
  }, [sources])

  const loadFiles = useCallback(async (key: string, target: { vaultId: string; talkSlug: string; runId: string }) => {
    try {
      const result = await window.tw.sessions.runFiles(target)
      setFiles(result.ok ? { key, ...result.files } : { key })
    } catch { setFiles({ key }) }
  }, [])
  // The files are read for the Run on show, and again when the window is back in front (a file may have been edited).
  useEffect(() => {
    if (!runKey || !ref) return
    void loadFiles(runKey, ref)
    const again = (): void => { void loadFiles(runKey, ref) }
    window.addEventListener('focus', again)
    return () => window.removeEventListener('focus', again)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runKey, loadFiles])
  const say = (text: string): void => { if (runKey) setNotice({ key: runKey, text }) }

  const openPlanner = useCallback(async (): Promise<void> => {
    let handouts
    try { handouts = await window.tw.history.talkHandouts() } catch { handouts = {} }
    const talks = Object.entries(handouts).map(([slug, talk]) => ({ slug, title: talk.title, outlinePath: talk.outlinePath })).filter((talk) => talk.outlinePath)
    if (talks.length) setSheet({ run: null, talk: talks[0], talks })
    else notify('No talk to plan a Run for yet', 'info')
  }, [])
  useEffect(() => {
    if (!planPending) return
    onPlanHandled()
    void openPlanner()
  }, [planPending, onPlanHandled, openPlanner])

  // Open results: the Run is selected (by the window); bring its ledger into view once it has drawn.
  const handledResults = useRef(resultsRequest)
  useEffect(() => {
    if (resultsRequest === handledResults.current) return
    handledResults.current = resultsRequest
    const timer = window.setTimeout(() => document.querySelector('[data-run-ledger]')?.scrollIntoView({ block: 'start' }), 350)
    return () => window.clearTimeout(timer)
  }, [resultsRequest])

  const perform = async (effect: RunPageEffect): Promise<void> => {
    if (!source || !ref || !runKey) return
    setNotice(null)
    setBusy(true)
    try {
      if (effect.kind === 'plan-sheet' || effect.kind === 'plan-like-this') {
        const isCopy = effect.kind === 'plan-like-this'
        // The Run and its talk from the Run's own vault (a Run of another open vault is edited and copied there).
        const [runs, talks] = await Promise.all([window.tw.history.listRuns(source.talkSlug, source.vaultId), window.tw.history.talkHandouts(source.vaultId)])
        const found = runs.find((candidate) => candidate.id === source.runId)
        const talk = talks[source.talkSlug]
        if (!found || !talk?.outlinePath) say(isCopy ? 'This Run cannot be copied from here.' : 'This Run cannot be edited from here.')
        else setSheet({ run: found, copy: isCopy, talk: { slug: source.talkSlug, title: talk.title, outlinePath: talk.outlinePath, vaultId: source.vaultId } })
      } else if (effect.kind === 'open-work-file') {
        const result = await window.tw.sessions.openWorkFile(ref, effect.phase)
        if (result.ok) onShowWorkFile(result.fileName, result.vaultId)
        else say(result.error)
      } else if (effect.kind === 'go-live') {
        // The Run and its talk from the Run's own vault: another open vault may hold the same talk and Run id.
        const result = await goLiveFromSessions(ref, {
          listRuns: (talkSlug, vaultId) => window.tw.history.listRuns(talkSlug, vaultId),
          talkHandouts: (vaultId) => window.tw.history.talkHandouts(vaultId),
          present: presentRun
        })
        if (!result.ok) say(result.error)
      } else if (effect.kind === 'open-live-view') {
        const result = await window.tw.sessions.openLiveView(ref)
        if (!result.ok) say(result.error)
      } else if (effect.kind === 'open-results') {
        // The ledger of a Run that has been given is on this page: Open results brings the Run to the front and shows it.
        const result = await openResultsFromSessions(ref, (view, sessionId, target) => window.tw.tools.open(view, sessionId, target))
        if (!result.success) say(result.error ?? 'Results could not be opened.')
      } else if (effect.kind === 'mark-delivered') {
        const result = await window.tw.sessions.markDelivered(ref)
        if (!result.ok) say(result.error)
        await load()
      } else if (effect.kind === 'preview-page') {
        const result = await window.tw.sessions.previewPage(ref)
        if (!result.ok) say(result.error)
      } else if (effect.kind === 'publish') {
        // The checklist shows "Publishing…" with its progress row until the publish answers.
        const key = runKey
        setPublishing((current) => new Set(current).add(key))
        try {
          // The selected Run's own vault: main publishes that vault's Run, never another vault's with the same names.
          const result = await window.tw.history.publishRunHandout(source.talkSlug, source.runId, source.vaultId)
          if (!result.success) say(result.error === 'run-not-found' ? 'That Run is no longer there.' : result.error ?? 'Publishing did not finish.')
          else if (result.warning) say(result.warning)
          else if (result.liveNotice) say(result.liveNotice)
        } finally {
          setPublishing((current) => { const next = new Set(current); next.delete(key); return next })
          await load()
        }
      }
    } catch { say('That did not go through. Try again.') }
    finally { setBusy(false) }
  }
  const copy = (url: string): void => { void navigator.clipboard?.writeText(url).catch(() => say('The link could not be copied.')) }
  const copyInvitation = (): void => {
    if (!source?.handoutUrl) return
    const work = source.work
    const text = runInvitationText({
      eventTitle: source.eventTitle, talkTitle: source.talkTitle, plannedDate: source.plannedDate, startTime: source.startTime, handoutUrl: source.handoutUrl,
      work: {
        ...(work?.pre ? { pre: { closes: work.pre.closes } } : {}),
        ...(work?.post ? { post: { opens: work.post.opens, closes: work.post.closes } } : {}),
      },
    })
    void navigator.clipboard?.writeText(text).catch(() => say('The invitation could not be copied.'))
  }
  const unpublish = async (): Promise<void> => {
    if (!source) return
    setNotice(null)
    setBusy(true)
    try {
      // The selected Run's own vault: main unpublishes that vault's Run, never another vault's with the same names.
      const result = await window.tw.history.unpublishRunHandout(source.talkSlug, source.runId, source.vaultId)
      if (!result.success) say(result.error === 'run-not-found' ? 'That Run is no longer there.' : result.error ?? 'Unpublishing did not finish.')
    } catch { say('That did not go through. Try again.') }
    finally { setBusy(false); setConfirming(null); await load() }
  }

  // Delete a Run: a planned one is removed from its vault; one that has been given goes to the Bin with its recording.
  // The same two calls History made, behind the one confirm card (R10).
  const askDelete = useCallback((target: RecordingSession, planned: boolean, vaultId: string): void => { setDeleting({ run: target, planned, vaultId }) }, [])
  const deleteRun = async (): Promise<void> => {
    if (!deleting) return
    const { run: target, planned, vaultId } = deleting
    setDeleting(null)
    if (planned) {
      const result = await window.tw.history.deletePlannedRun(target.talkSlug, target.id, vaultId)
      if (!result.ok) { notify(`Could not delete Run: ${result.error ?? 'unknown error'}`, 'error'); return }
      notify('Planned Run deleted', 'info')
    } else {
      const result = await window.tw.recording.deleteSession(target.talkSlug, target.id, target.kept === 'app-data' ? null : target.home)
      if (!result.ok) { notify('Delete failed — the Run is still here', 'error'); return }
      notify('Run moved to the Bin', 'info')
    }
    await load()
  }

  const confirmText = source && runKey && confirming === runKey ? unpublishConfirmText(source) : null
  const checklist = source && runKey && source.kept !== 'app-data'
    ? runPageChecklist(source, now, { live: live.has(sessionLiveKey(source.vaultId, source)), publishing: publishing.has(runKey), files: files?.key === runKey ? { pre: files.pre, post: files.post } : undefined })
    : null
  // The QR code of the link the Published step names (pre-work while it is open, post-work while it is open, else the handout).
  const qrUrl = checklist?.steps.find((step) => step.id === 'published')?.links?.find((link) => link.kind === checklist.steps.find((step) => step.id === 'published')?.qr)?.url ?? ''
  // The Tools commands that act on the Run on show (work-files ticket 30). Each is the Run page's own button:
  // it is offered only while the button is, with the button's own disabled state, and it calls the button's handler.
  const checklistAction = (...ids: string[]): { enabled: boolean; run: () => void } => {
    const action = checklist?.steps.flatMap((step) => step.actions).find((candidate) => ids.includes(candidate.id))
    const effect = action ? runActionEffect(action.id) : null
    return { enabled: !!action && action.disabled !== true && effect !== null && !busy, run: () => { if (effect) void perform(effect) } }
  }
  const publishedBlock = !!checklist?.steps.find((step) => step.id === 'published' && step.links && step.qr)
  const idle = !busy && !(runKey && publishing.has(runKey))
  useToolsActions(source && runKey && checklist ? {
    'tools-edit-plan': checklistAction('edit-plan'),
    'tools-plan-like-this': { enabled: idle, run: () => { void perform({ kind: 'plan-like-this' }) } },
    'tools-publish': checklistAction('publish', 'publish-again'),
    'tools-go-live': checklistAction('go-live'),
    'tools-unpublish': { enabled: publishedBlock && idle, run: () => { if (runKey) setConfirming(runKey) } },
    'tools-copy-invitation': { enabled: publishedBlock && idle, run: copyInvitation },
    'tools-copy-link': { enabled: !!qrUrl, run: () => copy(qrUrl) }
  } : {})
  useEffect(() => {
    if (!qrUrl || qr?.url === qrUrl) return
    let gone = false
    void window.tw.sessions.runQr(qrUrl).then((result) => { if (!gone && result.ok) setQr({ url: qrUrl, svg: result.svg }) }).catch(() => {})
    return () => { gone = true }
  }, [qrUrl, qr?.url])

  // Keys: ⌘F finds, ↑ ↓ move through the list, ? opens the cheat sheet. (Typing in a field leaves them alone.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null
      const typing = !!target && target.matches('input, textarea, select, [contenteditable="true"]')
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); searchRef.current?.focus(); searchRef.current?.select(); return }
      if (typing) { if (e.key === 'Escape') (target as HTMLElement).blur(); return }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === '?') { e.preventDefault(); setHelpOpen((open) => !open); return }
      if (document.querySelector('[data-share-dialog], [data-board-markdown], [data-testid="confirm-card"], [data-testid="plan-run-sheet"], [data-unpublish-action]')) return
      // Esc steps back out: the cheat sheet, the View popover, then the window (as History and Studio close theirs).
      if (e.key === 'Escape') { if (helpOpen) setHelpOpen(false); else if (viewMenu) setViewMenu(false); else window.close(); return }
      if (e.key.toLowerCase() === 'r') { e.preventDefault(); void recheckAll(); return }
      if (e.key.toLowerCase() === 'f') { e.preventDefault(); toggleFilter('recorded'); return }
      if (e.key.toLowerCase() === 'g') { e.preventDefault(); setGroup((current) => SESSION_GROUPS[(SESSION_GROUPS.indexOf(current) + 1) % SESSION_GROUPS.length]); return }
      // The ledger's own keys: each presses the control of the Run on show, which says what it does and does it.
      const LEDGER_KEYS: Record<string, string> = { c: '[data-run-copy-handout]', o: '[data-run-open-handout]', l: '[data-run-recheck]', e: '[data-run-edit-context]', u: '[data-run-upload]' }
      if (LEDGER_KEYS[e.key.toLowerCase()]) {
        const control = document.querySelector<HTMLButtonElement>(LEDGER_KEYS[e.key.toLowerCase()])
        if (control && !control.disabled) { e.preventDefault(); control.click() }
        return
      }
      if (e.key === 'Enter' && selected?.recorded && (!target || target === document.body || target.classList.contains('tw-sess-row'))) {
        const open = document.querySelector<HTMLElement>('[data-run-open-studio]')
        if (open) { e.preventDefault(); open.click() }
        return
      }
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !target?.closest('[role="dialog"]')) {
        if (!list.rows.length) return
        const current = list.rows.findIndex((row) => row.key === selected?.key)
        const next = e.key === 'ArrowDown' ? Math.min(list.rows.length - 1, current + 1) : Math.max(0, current < 0 ? 0 : current - 1)
        e.preventDefault()
        choose(list.rows[next].ref)
        requestAnimationFrame(() => document.querySelector(`[data-sessions-row="${CSS.escape(sessionRunKey(list.rows[next].ref))}"]`)?.scrollIntoView({ block: 'nearest' }))
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [helpOpen, list.rows, choose, selected, viewMenu, recheckAll])

  // Upcoming, Live now and Past answer one question (when), so choosing one replaces the others; Recorded, Published and
  // Responses waiting each narrow further and stack.
  const toggleFilter = (id: SessionFilter): void => setFilters((current) => {
    if (current.includes(id)) return current.filter((candidate) => candidate !== id)
    return id === 'upcoming' || id === 'live' || id === 'past' ? [...current.filter((candidate) => candidate !== 'upcoming' && candidate !== 'live' && candidate !== 'past'), id] : [...current, id]
  })
  const toggleKind = (kind: RunKind): void => setKinds((current) => current.includes(kind) ? (current.length === 1 ? current : current.filter((candidate) => candidate !== kind)) : [...current, kind])
  const kindsChanged = !(kinds.length === DEFAULT_RUN_KINDS.length && kinds.every((kind) => DEFAULT_RUN_KINDS.includes(kind)))
  const viewChanges = (kindsChanged ? 1 : 0) + (online ? 1 : 0) + (sort !== 'date' ? 1 : 0) + (group !== 'status' ? 1 : 0)
  const anyFilter = filters.length > 0 || query.trim() !== '' || kindsChanged || online
  const clearFilters = (): void => { setFilters([]); setQuery(''); setKinds([...DEFAULT_RUN_KINDS]); setOnline(false) }

  const detail = (() => {
    if (!source || !runKey) return <div className="tw-tools-none"><CalendarDays aria-hidden /><span>No Run selected</span></div>
    const given = source.status === 'delivered'
    const ledger = given ? (
      <RunLedger key={runKey} source={source} version={version} onOpenStudio={(target) => onOpenStudio(recordingRunKey(target))} onOpenNotes={(target) => onOpenNotes(target.id)}
        onChanged={() => { void load() }} flash={(message) => notify(message, 'info')}
        onAskDelete={(target) => askDelete(target, false, source.vaultId)} />
    ) : null
    if (source.kept === 'app-data' || !checklist) {
      return (
        <div className="tw-sess-detail" data-sessions-detail={`${source.talkSlug}/${source.runId}`}>
          <div className="tw-sess-dhead"><div className="tw-sess-dtitle"><h1>{plainTalkTitle(source.eventTitle || source.talkTitle)}</h1><div className="sub"><span>{plainTalkTitle(source.talkTitle)}</span><StateBadge state="notset">Kept on this Mac</StateBadge></div></div></div>
          <div className="tw-run-cols"><div className="tw-run-main">{ledger}</div></div>
        </div>
      )
    }
    return (
      <RunPage source={source} busy={busy || publishing.has(runKey)} notice={notice?.key === runKey ? notice.text : null} onCopy={copy}
        onPlanLikeThis={() => { void perform({ kind: 'plan-like-this' }) }} onExtrasSaved={() => { void load() }} onAnswersPulled={() => { void load() }} onEffect={(effect) => { void perform(effect) }}
        checklist={checklist}
        ledger={given ? ledger : null}
        footer={given ? null : (
          <div className="tw-run-ledger-foot">
            <button type="button" className="tw-btn tw-btn--quiet tw-btn--sm" data-run-delete disabled={busy}
              onClick={() => { void (async () => {
                const [runs] = await Promise.all([window.tw.history.listRuns(source.talkSlug, source.vaultId)])
                const found = runs.find((candidate) => candidate.id === source.runId)
                if (found) askDelete(found, true, source.vaultId)
                else notify('That Run is no longer there.', 'info')
              })() }}>Delete this Run…</button>
          </div>
        )}
        block={{ qrSvg: qr && qr.url === qrUrl ? qr.svg : null, onInvitation: copyInvitation, onUnpublish: () => { if (runKey) setConfirming(runKey) } }} />
    )
  })()

  const planSaved = (saved: RecordingSession): void => {
    const editing = sheet?.run && !sheet.copy
    setSheet(null)
    void load()
    if (runKey && ref) void loadFiles(runKey, ref)
    if (!editing && saved.plannedDate) notify(`Run planned for ${shortDate(saved.plannedDate)}`, 'success')
  }

  return (
    <div className="tw-tools-view tw-runs" data-tools-view="runs" data-run={run ? sessionRunKey(run) : undefined}>
      <header className="tw-tools-bar">
        <h2>Runs</h2>
        <span className="tw-runs-count" data-runs-count>{anyFilter && sources ? `${list.rows.length} of ${list.total}` : list.total}</span>
        <span className="tw-sess-sp" />
        <button type="button" className="tw-btn tw-btn--primary" data-sessions-plan onClick={() => { void openPlanner() }}><CalendarPlus aria-hidden />Plan a Run</button>
        <button type="button" className="tw-btn tw-btn--quiet" data-runs-recheck title="Re-check every published handout against its live URL (R)" onClick={() => { void recheckAll() }}><RefreshCw aria-hidden />Re-check live</button>
        <button type="button" className="tw-btn tw-btn--quiet tw-btn--icon" aria-label="Open settings for Runs" title="Open settings for Runs" onClick={() => openSettingsAt('recording')}><Settings aria-hidden /></button>
        <button type="button" className="tw-btn tw-btn--quiet tw-btn--icon" aria-label="Keyboard cheat-sheet" title="Keyboard cheat-sheet (?)" onClick={() => setHelpOpen(true)}>?</button>
      </header>
      {!empty && (
        <div className="tw-tools-toolbar" role="toolbar" aria-label="Filter Runs">
          <label className="tw-runs-search">
            <Search aria-hidden />
            <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Runs" aria-label="Search Runs" />
          </label>
          <div className="tw-runs-chips" role="group" aria-label="Filter Runs">
            {SESSION_FILTERS.map((id) => (
              <button key={id} type="button" className="tw-btn tw-btn--chip" data-sessions-filter={id} aria-pressed={filters.includes(id)} onClick={() => toggleFilter(id)}>
                {id === 'live' && <Radio aria-hidden />}{id === 'responses' && <Inbox aria-hidden />}{id === 'recorded' && <Mic aria-hidden />}{id === 'responses' ? <>Responses<span className="tw-chip-more"> waiting</span></> : SESSION_FILTER_LABELS[id]}{id === 'responses' && list.waiting > 0 && <span data-sessions-waiting> · {list.waiting}</span>}
              </button>
            ))}
          </div>
          <span className="tw-sess-sp" />
          {anyFilter && <button type="button" className="tw-btn tw-btn--quiet tw-btn--sm" data-runs-clear aria-label="Clear filters" title="Clear filters" onClick={clearFilters}><X aria-hidden /><span className="tw-chip-more">Clear</span></button>}
          <div className="tw-runs-viewwrap">
            <button type="button" className="tw-btn" data-runs-view aria-haspopup="true" aria-expanded={viewMenu} onClick={() => setViewMenu((open) => !open)}><SlidersHorizontal aria-hidden />View{viewChanges > 0 ? ` · ${viewChanges}` : ''}</button>
            {viewMenu && (
              <>
                <div className="toolbar-menu-backdrop" onClick={() => setViewMenu(false)} />
                <div className="toolbar-menu tw-runs-viewmenu" role="dialog" aria-label="Kinds, sort and group">
                  <div className="tw-runs-vgroup"><span>Show</span>
                    {RUN_KINDS.map((kind) => <button key={kind} type="button" className="tw-btn tw-btn--chip" data-runs-kind={kind} aria-pressed={kinds.includes(kind)} onClick={() => toggleKind(kind)}>{RUN_KIND_LABELS[kind]}</button>)}
                    <button type="button" className="tw-btn tw-btn--chip" data-runs-online aria-pressed={online} onClick={() => setOnline((value) => !value)}>Handout still live</button>
                  </div>
                  <div className="tw-runs-vgroup"><span>Sort</span>
                    {SESSION_SORTS.map((id) => <button key={id} type="button" className="tw-btn tw-btn--chip" data-runs-sort={id} aria-pressed={sort === id} onClick={() => setSort(id)}>{SESSION_SORT_LABELS[id]}</button>)}
                  </div>
                  <div className="tw-runs-vgroup"><span>Group</span>
                    {SESSION_GROUPS.map((id) => <button key={id} type="button" className="tw-btn tw-btn--chip" data-runs-group={id} aria-pressed={group === id} onClick={() => setGroup(id)}>{SESSION_GROUP_LABELS[id]}</button>)}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      <div className="tw-runs-body">
        <section className="tw-tools-list" aria-label="Runs">
          {recovery.length > 0 && (
            <div className="tw-run-note-list" aria-label="Recording recovery">
              {recovery.map((item) => <div className="tw-run-note" key={item.sessionId} data-recording-recovery={item.sessionId}>{item.talkTitle}: {item.message}</div>)}
            </div>
          )}
          {empty ? (
            <div className="tw-tools-empty">
              <CalendarDays aria-hidden />
              <b>No Runs yet</b>
              <p>Plan a Run, or record one with ⇧R in the presenter. Every Run, planned or given, is listed here.</p>
              <button type="button" className="tw-btn tw-btn--primary" data-sessions-plan onClick={() => { void openPlanner() }}><CalendarPlus aria-hidden />Plan a Run</button>
            </div>
          ) : (
            <div className="tw-sess-body" data-sessions-list>
              {sources !== null && list.groups.length === 0 && (
                <div className="tw-sess-none">
                  <p>No Runs match.</p>
                  {anyFilter && <button type="button" className="tw-btn tw-btn--sm" onClick={clearFilters}><X aria-hidden />Clear filters</button>}
                </div>
              )}
              {list.groups.map((g) => (
                <div key={g.id} role="group" aria-label={g.label}>
                  <div className="tw-sess-group" data-sessions-group={g.id}>{g.label}<span className="n">{g.rows.length}</span></div>
                  {g.rows.map((row) => {
                    const on = selected?.key === row.key
                    return (
                      <button key={row.key} type="button" className={`tw-sess-row${on ? ' on' : ''}`} data-sessions-row={sessionRunKey(row.ref)} data-run-kind={row.kind} aria-current={on ? 'true' : undefined}
                        onClick={() => choose(row.ref)}>
                        <span className="l1"><span className="nm">{row.name}</span><RowBadge row={row} />{row.responses > 0 && <span className="tw-sess-new" data-sessions-new>{responsesBadge(row)}</span>}</span>
                        <span className="l2"><span>{row.when}</span>{row.progress ? <span className="rt">{row.progress}</span> : row.lengthMs > 0 ? <span className="rt">{fmtLength(row.lengthMs)}</span> : null}</span>
                        <span className="l3"><span className="tk">{row.talk}</span>{row.boardBadge && <StateBadge state="notset" small data-board-badge>{row.boardBadge}</StateBadge>}{row.kind !== 'delivery' && <span className="kd">{RUN_KIND_LABELS[row.kind]}</span>}{row.recorded && <Mic className="rec" aria-label="Recorded" />}</span>
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="tw-tools-detail" aria-label="Run detail">
          {detail}
        </section>
      </div>
      {confirmText && (
        <UnpublishRunConfirm title={confirmText.title} body={confirmText.body} busy={busy}
          onCancel={() => setConfirming(null)} onConfirm={() => { void unpublish() }} />
      )}
      {deleting && (
        <ConfirmCard
          title={deleting.planned ? 'Delete this planned Run?' : 'Delete this Run?'}
          itemName={`${plainTalkTitle(deleting.run.eventTitle || deleting.run.talkTitle)}${deleting.run.plannedDate ? ` · ${shortDate(deleting.run.plannedDate)}` : deleting.run.startedAt ? ` · ${new Date(deleting.run.startedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}`}
          consequence={deleting.planned ? 'The plan is removed from the vault.' : BIN_CONSEQUENCE}
          recovery={deleting.planned ? 'It cannot be recovered. Pages already published for it stay online until you unpublish them.' : 'You can recover its recording from the Bin until you empty it. Its slide timings are removed from Runs.'}
          cta="Delete"
          onCancel={() => setDeleting(null)}
          onConfirm={() => { void deleteRun() }}
        />
      )}
      {sheet && (
        <PlanRunSheet key={`${sheet.copy ? 'copy:' : ''}${sheet.run?.id ?? 'new'}`} talk={sheet.talk} talks={sheet.talks} run={sheet.copy ? null : sheet.run} copyFrom={sheet.copy ? sheet.run : null}
          onClose={() => setSheet(null)} onSaved={planSaved} />
      )}
      <KeyboardHelp isOpen={helpOpen} onClose={() => setHelpOpen(false)} view="runs" />
    </div>
  )
}

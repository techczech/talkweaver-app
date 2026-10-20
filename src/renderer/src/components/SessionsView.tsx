import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarDays, CalendarPlus, Inbox, Radio } from 'lucide-react'
import type { RecordingSession } from '../../../preload/index'
import { SESSION_FILTERS, SESSION_FILTER_LABELS, responsesBadge, selectSessionRow, sessionList, sessionLiveKey, sessionRunKey, type SessionFilter, type SessionRow, type SessionSource } from '../../../shared/sessions-list'
import { runActionEffect, runPageChecklist, unpublishConfirmText, type RunPageEffect } from '../../../shared/run-page'
import { runInvitationText } from '../../../shared/run-invitation'
import type { WorkFileState } from '../../../shared/run-checklist'
import type { ToolsRunRef } from '../../../shared/tools-views'
import { presentRun } from '../lib/present-run'
import { goLiveFromSessions, openResultsFromSessions } from '../lib/session-run-actions'
import { useToolsActions } from '../lib/toolsActions'
import { RESPONSES_SEEN_EVENT } from './RunAnswers'
import PlanRunSheet from './PlanRunSheet'
import { RunPage } from './RunPage'
import { UnpublishRunConfirm } from './UnpublishRunConfirm'
import '../tools-rail.css'
import '../sessions-view.css'

function Pill({ row }: { row: SessionRow }): JSX.Element {
  return <span className={`tw-sess-pill ${row.pill.kind}`}>{row.live && <span className="tw-sess-dot" aria-hidden />}{row.pill.label}</span>
}

/**
 * The Sessions view: every planned and delivered Run of every open vault in one list, upcoming first,
 * with the four filters. Order, grouping and row text come from src/shared/sessions-list.ts; the status
 * pill from the Run checklist. Selecting a row selects the Run (`run`, `onSelect`) and fills the detail
 * pane with that Run's page (RunPage): the checklist, and what each of its actions does.
 */
export function SessionsView({ run, onSelect, onPlan, onShowWorkFile }: { run: ToolsRunRef | null; onSelect: (run: ToolsRunRef) => void; onPlan: () => void; onShowWorkFile: (fileName: string, vaultId: string) => void }): JSX.Element {
  const [sources, setSources] = useState<SessionSource[] | null>(null)
  const [live, setLive] = useState<ReadonlySet<string>>(new Set())
  const [now, setNow] = useState(() => new Date())
  const [filter, setFilter] = useState<SessionFilter | null>(null)

  const load = useCallback(async () => {
    try {
      const result = await window.tw.sessions.list()
      setSources(result.runs)
      setLive(new Set(result.live))
    } catch { setSources((current) => current ?? []) }
    setNow(new Date())
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

  // The selected Run's page: how its work files read, a notice for an action that did not go through, and the plan sheet.
  const [files, setFiles] = useState<{ key: string; pre?: WorkFileState; post?: WorkFileState } | null>(null)
  const [notice, setNotice] = useState<{ key: string; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  // Publish for this run: which Runs are being published now (transient: the checklist's "Publishing…").
  const [publishing, setPublishing] = useState<ReadonlySet<string>>(new Set())
  const [qr, setQr] = useState<{ url: string; svg: string } | null>(null)
  const [sheet, setSheet] = useState<{ run: RecordingSession; copy?: boolean; talk: { slug: string; title: string; outlinePath: string; vaultId?: string } } | null>(null)
  // Unpublish asks first (ticket 17): the Run whose confirmation is open, by its key.
  const [confirming, setConfirming] = useState<string | null>(null)

  const list = useMemo(() => sessionList(sources ?? [], now, { filter, live }), [sources, now, filter, live])
  // The Run by vault, talk and Run id; a reference without a vault only when one vault holds that Run.
  const selected = selectSessionRow(list.rows, run)
  const empty = sources !== null && list.total === 0
  const source = selected ? sources?.find((candidate) => candidate.vaultId === selected.vaultId && sessionRunKey(candidate) === sessionRunKey(selected.ref)) ?? null : null
  const runKey = source ? `${source.vaultId}|${sessionRunKey(source)}` : null
  const ref = source ? { vaultId: source.vaultId, talkSlug: source.talkSlug, runId: source.runId } : null

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

  const perform = async (effect: RunPageEffect): Promise<void> => {
    if (!source || !ref || !runKey) return
    setNotice(null)
    setBusy(true)
    try {
      if (effect.kind === 'plan-sheet' || effect.kind === 'plan-like-this') {
        const isCopy = effect.kind === 'plan-like-this'
        // The Run and its talk from the Run's own vault (a Run of another open vault is edited and copied there).
        const [runs, talks] = await Promise.all([window.tw.history.listRuns(source.talkSlug, source.vaultId), window.tw.history.talkHandouts(source.vaultId)])
        const run = runs.find((candidate) => candidate.id === source.runId)
        const talk = talks[source.talkSlug]
        if (!run || !talk?.outlinePath) say(isCopy ? 'This Run cannot be copied from here.' : 'This Run cannot be edited from here.')
        else setSheet({ run, copy: isCopy, talk: { slug: source.talkSlug, title: talk.title, outlinePath: talk.outlinePath, vaultId: source.vaultId } })
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
        // Names the Run's vault: History opens the results only of a Run in the vault it lists.
        const result = await openResultsFromSessions(ref, (view, sessionId, run) => window.tw.tools.open(view, sessionId, run))
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
  const confirmText = source && runKey && confirming === runKey ? unpublishConfirmText(source) : null
  const checklist = source && runKey
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

  return (
    <div className="tw-tools-view" data-tools-view="sessions" data-run={run ? sessionRunKey(run) : undefined}>
      <section className="tw-tools-list" aria-label="Sessions">
        <header>
          <h2>Sessions</h2>
          <span className="tw-sess-sp" />
          <button type="button" className="tw-sess-btn pri sm" data-sessions-plan onClick={onPlan}><CalendarPlus aria-hidden />Plan a run</button>
        </header>
        {empty ? (
          <div className="tw-tools-empty">
            <CalendarDays aria-hidden />
            <b>No runs yet</b>
            <button type="button" className="tw-sess-btn" data-sessions-plan onClick={onPlan}><CalendarPlus aria-hidden />Plan a run</button>
          </div>
        ) : (
          <>
            <div className="tw-sess-filters" role="group" aria-label="Filter runs">
              {SESSION_FILTERS.map((id) => (
                <button key={id} type="button" className={`tw-sess-chip${filter === id ? ' on' : ''}`} data-sessions-filter={id} aria-pressed={filter === id}
                  onClick={() => setFilter(filter === id ? null : id)}>
                  {id === 'live' && <Radio aria-hidden />}{id === 'responses' && <Inbox aria-hidden />}{SESSION_FILTER_LABELS[id]}{id === 'responses' && list.waiting > 0 && <span data-sessions-waiting> · {list.waiting}</span>}
                </button>
              ))}
            </div>
            <div className="tw-sess-body" data-sessions-list>
              {sources !== null && list.groups.length === 0 && <p className="tw-sess-none">No runs match.</p>}
              {list.groups.map((group) => (
                <div key={group.id} role="group" aria-label={group.label}>
                  <div className="tw-sess-group" data-sessions-group={group.id}>{group.label}</div>
                  {group.rows.map((row) => {
                    const on = selected?.key === row.key
                    return (
                      <button key={row.key} type="button" className={`tw-sess-row${on ? ' on' : ''}`} data-sessions-row={sessionRunKey(row.ref)} aria-current={on ? 'true' : undefined}
                        onClick={() => onSelect(row.ref)}>
                        <span className="l1"><span className="nm">{row.name}</span><Pill row={row} />{row.responses > 0 && <span className="tw-sess-new" data-sessions-new>{responsesBadge(row)}</span>}</span>
                        <span className="l2"><span>{row.when}</span>{row.progress && <span className="rt">{row.progress}</span>}</span>
                        <span className="l3">{row.talk}</span>
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          </>
        )}
      </section>
      <section className="tw-tools-detail" aria-label="Sessions detail">
        {source && runKey && checklist ? (
          <RunPage source={source} busy={busy || publishing.has(runKey)} notice={notice?.key === runKey ? notice.text : null} onCopy={copy} onPlanLikeThis={() => { void perform({ kind: 'plan-like-this' }) }} onExtrasSaved={() => { void load() }} onAnswersPulled={() => { void load() }} onEffect={(effect) => { void perform(effect) }}
            checklist={checklist}
            block={{ qrSvg: qr && qr.url === qrUrl ? qr.svg : null, onInvitation: copyInvitation, onUnpublish: () => { if (runKey) setConfirming(runKey) } }} />
        ) : (
          <div className="tw-tools-none"><CalendarDays aria-hidden /><span>No run selected</span></div>
        )}
      </section>
      {confirmText && (
        <UnpublishRunConfirm title={confirmText.title} body={confirmText.body} busy={busy}
          onCancel={() => setConfirming(null)} onConfirm={() => { void unpublish() }} />
      )}
      {sheet && (
        <PlanRunSheet key={`${sheet.copy ? 'copy:' : ''}${sheet.run.id}`} talk={sheet.talk} run={sheet.copy ? null : sheet.run} copyFrom={sheet.copy ? sheet.run : null} onClose={() => setSheet(null)}
          onSaved={() => { setSheet(null); void load(); if (runKey && ref) void loadFiles(runKey, ref) }} />
      )}
    </div>
  )
}

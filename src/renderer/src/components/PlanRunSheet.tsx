import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarClock, CircleAlert, Clock, Gauge, Layers, ListChecks, MessageCircleQuestion, MessageSquareHeart, PencilLine, Presentation, Video, type LucideIcon } from 'lucide-react'
import type { Pathway, RecordingSession } from '../../../preload/index'
import {
  applyFix, blankDraft, copyDraftFromRun, draftFromRun, longDate, markedPhases, moveDraftToDate, planFromDraft, planIssues, sheetTimeZone, workDefaults, zoneToSend,
  type PhaseDraft, type PlanDraft, type PlanIssue
} from '../../../shared/plan-run'
import { LEGACY_SECTION_FILE_ID, SESSION_END, type Phase } from '../../../shared/run-work'
import { readTalkWorkNames, type WorkFileItem, type WorkFileStepIcon } from '../../../shared/work-files-view'
import { talkWorkFile } from '../../../shared/work-file-name'
import '../plan-run.css'

// The plan sheet (ADR-0032 point 5, work-files ticket 11): one sheet for planning a Run: the slides,
// and for each of pre-work and post-work a work file with its window. Opened from Present › Plan a
// run…, the editor's strips, the status bar, History and the Run page. Text is rendered as text only;
// nothing here writes a Run except through window.tw.history. A new plan saved opens its Run page.

export interface PlanRunTalk { slug: string; title: string; outlinePath: string; vaultId?: string }

const ERROR_TEXT: Record<string, string> = {
  'event-title-required': 'Give the event a name.',
  'planned-date-invalid': 'Choose a date.',
  'start-time-invalid': 'Choose a start time.',
  'expected-people-invalid': 'Expected people is a whole number, or leave it empty.',
  'prework-opens-invalid': 'Choose when pre-work opens.',
  'prework-closes-invalid': 'Choose when pre-work closes.',
  'prework-closes-before-opens': 'Pre-work must close after it opens',
  'work-pre-closes-after-start': 'Pre-work must close before the session starts',
  'work-post-closes-before-start': 'Post-work must close after the session ends',
  'work-post-opens-before-start': 'Post-work must open after the session starts',
  'work-closes-before-opens': 'A work file must close after it opens',
  'work-post-closes-required': 'Choose when post-work closes.',
  'work-pre-opens-required': 'Choose when pre-work opens.',
  'work-zone-mismatch': 'A work file on this Run was set in another time zone. Planning leaves it as it is.',
  'prework-section-retired': 'A talk’s old pre-work section can no longer be added to a Run. Choose a pre-work file instead.',
  'run-delivered-times-only': 'This run has been given: only the pre-work and post-work times can change, not the file.'
}

const STEP_ICONS: Record<WorkFileStepIcon, LucideIcon> = {
  video: Video, presentation: Presentation, 'list-checks': ListChecks, gauge: Gauge, 'pencil-line': PencilLine, 'message-circle-question': MessageCircleQuestion
}

type Item = WorkFileItem & { absPath?: string }
const NEW_PATHWAY = '__new-pathway'
const PHASES: Array<{ phase: Phase; label: string; icon: LucideIcon }> = [
  { phase: 'pre', label: 'Pre-work', icon: ListChecks },
  { phase: 'post', label: 'Post-work', icon: MessageSquareHeart }
]
const steps = (n: number): string => `${n} ${n === 1 ? 'step' : 'steps'}`
const slides = (n: number): string => `${n} ${n === 1 ? 'slide' : 'slides'}`

export default function PlanRunSheet({ talk, talks, run, copyFrom, onClose, onSaved }: {
  /** The talk the Run is for. */
  talk: PlanRunTalk
  /** When given the sheet lets the person pick the talk (History without a scoped talk). */
  talks?: PlanRunTalk[]
  /** Editing this planned Run; absent = planning a new one. */
  run?: RecordingSession | null
  /** Planning the next Run like this one (ticket 26): a new plan prefilled from it, with the date left to fill in. */
  copyFrom?: RecordingSession | null
  onClose: () => void
  onSaved: (run: RecordingSession) => void
}): JSX.Element {
  const [talkSlug, setTalkSlug] = useState(talk.slug)
  const activeTalk = talks?.find((candidate) => candidate.slug === talkSlug) ?? talk
  /** The vault's work files; null while unread, or when there are none to show (no vault). */
  const [files, setFiles] = useState<Item[] | null>(null)
  const [outline, setOutline] = useState<string | null>(null)
  const [pathways, setPathways] = useState<Array<Pathway & { count: number }>>([])
  const [fullCount, setFullCount] = useState<number | null>(null)
  const [draft, setDraft] = useState<PlanDraft>(() => run ? draftFromRun(run, new Date()) : copyFrom ? copyDraftFromRun(copyFrom) : blankDraft())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** The pathway ids there were when the person went to the Pathway view to make one; set while we wait for them to come back. */
  const awaitingPathway = useRef<Set<string> | null>(null)
  /** The date the copied windows currently sit around; they move when the date is chosen or changed. */
  const windowsAnchor = useRef<string>(copyFrom?.plannedDate ?? '')
  const eventRef = useRef<HTMLInputElement>(null)
  const touched = useRef({ pre: Boolean(run || copyFrom), post: Boolean(run || copyFrom) })
  const marked = useMemo(() => markedPhases(run), [run])
  // A Run already given (ticket 19): only the times of the work it was sent with can change. Change time
  // after a phase has closed reopens it.
  const given = run?.status === 'delivered'

  useEffect(() => { eventRef.current?.focus() }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const source = await window.tw.talk.readOutline(activeTalk.outlinePath)
      if (cancelled || source === null) return
      setOutline(source)
      // The main process answers null while pre-work is switched off (or no vault is open): no work blocks then.
      const listing = await window.tw.workFiles.list(activeTalk.vaultId)
      if (cancelled) return
      const items = listing ? (listing.items as Item[]) : null
      setFiles(items)
      // A new plan starts from the files the talk's metadata names; a person's own choice is not overwritten.
      if (items && !run && !copyFrom) {
        const names = workDefaults(readTalkWorkNames(source), items)
        setDraft((current) => ({
          ...current,
          pre: touched.current.pre ? current.pre : { ...current.pre, fileId: names.pre },
          post: touched.current.post ? current.post : { ...current.post, fileId: names.post }
        }))
      }
      const snapshot = await window.tw.pathways.read(activeTalk.outlinePath, source)
      if (cancelled) return
      if ('error' in snapshot) { setPathways([]); setFullCount(null) } else {
        setPathways(snapshot.pathways.map((pathway) => ({ id: pathway.id, name: pathway.name, note: pathway.note, slideIds: pathway.slideIds, count: pathway.present.length })))
        setFullCount(snapshot.slides.length)
        // A copied pathway that has since gone is not carried over; the copy starts from the full talk.
        if (copyFrom && !run) setDraft((current) => current.slideSet === 'full' || snapshot.pathways.some((pathway) => pathway.id === current.slideSet) ? current : { ...current, slideSet: 'full' })
      }
    })()
    return () => { cancelled = true }
  }, [activeTalk.outlinePath, activeTalk.vaultId])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // The times are read in the Run's own zone (this machine's for a new plan), which the person can
  // change: a Run planned from Oxford for Prague says Prague (ticket 09).
  const [timeZone, setTimeZone] = useState(() => sheetTimeZone(run ?? copyFrom, Intl.DateTimeFormat().resolvedOptions().timeZone))
  const zones = useMemo(() => {
    const listed = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
    return listed.includes(timeZone) ? listed : [timeZone, ...listed]
  }, [timeZone])
  const set = <K extends keyof PlanDraft>(key: K, value: PlanDraft[K]): void => { setError(null); setDraft((current) => ({ ...current, [key]: value })) }
  const setDate = (date: string): void => {
    setError(null)
    setDraft((current) => {
      if (!windowsAnchor.current || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ...current, date }
      const moved = moveDraftToDate(current, windowsAnchor.current, date)
      windowsAnchor.current = date
      return moved
    })
  }
  const setPhase = (phase: Phase, patch: Partial<PhaseDraft>): void => {
    touched.current[phase] = true
    setError(null)
    setDraft((current) => ({ ...current, [phase]: { ...current[phase], ...patch } }))
  }

  const showWork = files !== null
  const context = { phases: showWork, editing: Boolean(run), marked, delivered: given }
  const plan = planFromDraft(draft, context)
  const issues = showWork ? planIssues(draft, marked, { delivered: given }) : []
  const hasPathway = draft.slideSet === 'full' || pathways.some((pathway) => pathway.id === draft.slideSet)
  const talkNames = useMemo(() => (outline === null ? {} : readTalkWorkNames(outline)), [outline])
  const talkFileIds = useMemo(() => ({
    pre: files ? talkWorkFile(talkNames.prework, files).file?.id ?? null : null,
    post: files ? talkWorkFile(talkNames.postwork, files).file?.id ?? null : null
  }), [files, talkNames])

  const readPathways = async (): Promise<Array<Pathway & { count: number }> | null> => {
    const source = await window.tw.talk.readOutline(activeTalk.outlinePath)
    if (source === null) return null
    setOutline(source)
    const snapshot = await window.tw.pathways.read(activeTalk.outlinePath, source)
    if ('error' in snapshot) return null
    setFullCount(snapshot.slides.length)
    const list = snapshot.pathways.map((pathway) => ({ id: pathway.id, name: pathway.name, note: pathway.note, slideIds: pathway.slideIds, count: pathway.present.length }))
    setPathways(list)
    return list
  }

  // New pathway… opens the talk's Pathway view (its own window); the sheet and its draft stay as they are.
  // When the person comes back, the pathway they made is read and chosen.
  async function newPathway(): Promise<void> {
    awaitingPathway.current = new Set(pathways.map((pathway) => pathway.id))
    const opened = await window.tw.tools.openPathways({ outlinePath: activeTalk.outlinePath, talkSlug: activeTalk.slug, talkTitle: activeTalk.title })
    if (!opened.success) { awaitingPathway.current = null; setError(`Could not open the Pathway view: ${opened.error ?? 'unknown error'}`) }
  }
  const comeBack = async (): Promise<void> => {
    const before = awaitingPathway.current
    if (!before) return
    const list = await readPathways()
    const made = list?.find((pathway) => !before.has(pathway.id))
    if (made) { awaitingPathway.current = null; set('slideSet', made.id) }
  }
  const comeBackRef = useRef(comeBack)
  comeBackRef.current = comeBack
  useEffect(() => {
    const again = (): void => { void comeBackRef.current() }
    window.addEventListener('focus', again)
    const off = window.tw.pathways.onChanged?.((event) => { if (event.outlinePath === activeTalk.outlinePath) again() })
    return () => { window.removeEventListener('focus', again); off?.() }
  }, [activeTalk.outlinePath])

  async function save(): Promise<void> {
    if (!plan.ok) { setError(plan.error); return }
    setBusy(true)
    setError(null)
    // A marked attachment keeps the Run's zone as it is: changing it could make the two agree by accident.
    const zone = marked.pre || marked.post ? undefined : zoneToSend(run, timeZone, plan.attached)
    const fields = { ...plan.fields, ...(zone ? { timeZone: zone } : {}) }
    const givenWork = Object.fromEntries(Object.entries(fields.work ?? {}).filter(([, input]) => input && input.fileId !== LEGACY_SECTION_FILE_ID))
    const result = run
      // The Run lives in its talk's vault: the sheet's talk names it (none from History: the current vault).
      ? await window.tw.history.updatePlannedRun(run.talkSlug, run.id, given ? { work: givenWork } : fields, activeTalk.vaultId)
      : await window.tw.history.createPlannedRun({
        talkSlug: activeTalk.slug,
        talkTitle: activeTalk.title,
        plannedDate: fields.plannedDate,
        eventTitle: fields.eventTitle,
        audience: fields.audience,
        slideSet: fields.slideSet,
        startTime: fields.startTime,
        ...(fields.expectedPeople !== null ? { expectedPeople: fields.expectedPeople } : {}),
        ...(fields.preworkOpens ? { preworkOpens: fields.preworkOpens } : {}),
        ...(fields.preworkCloses ? { preworkCloses: fields.preworkCloses } : {}),
        ...(fields.work ? { work: fields.work } : {}),
        ...(zone ? { timeZone: zone } : {}),
        ...(activeTalk.vaultId ? { vaultId: activeTalk.vaultId } : {})
      })
    setBusy(false)
    if (!result.ok || !result.run) { setError(ERROR_TEXT[result.error ?? ''] ?? `Could not plan the run: ${result.error ?? 'unknown error'}`); return }
    window.dispatchEvent(new Event('tw-runs-changed'))
    // A new plan opens its page in Sessions, the same way the Work files view opens a Run.
    if (!run) void window.tw.tools.openRun(result.run.talkSlug, result.run.id, activeTalk.vaultId)
    onSaved(result.run)
  }

  const fileOptions = (phase: Phase): JSX.Element[] => {
    const current = draft[phase].fileId
    const out = (files ?? []).filter((file) => file.id).map((file) => (
      <option key={file.id} value={file.id} disabled={file.blocking > 0 && file.id !== current}>
        {file.title || file.fileName}{talkFileIds[phase] === file.id ? ' (from the talk)' : ''} · {steps(file.steps.length)}{file.blocking > 0 ? ' · needs fixing' : ''}
      </option>
    ))
    // A talk's own `{prework}` section is no longer offered (work-files ticket 29): only a Run being edited
    // that was planned with it before work files shows it, so editing its times leaves it unchanged. A copy
    // ("Plan the next run like this") and a new Run never offer it.
    if (phase === 'pre' && current === LEGACY_SECTION_FILE_ID && run && run.work?.pre?.fileId === LEGACY_SECTION_FILE_ID) {
      out.push(<option key={LEGACY_SECTION_FILE_ID} value={LEGACY_SECTION_FILE_ID}>The talk’s old pre-work section</option>)
    }
    if (current && current !== LEGACY_SECTION_FILE_ID && !(files ?? []).some((file) => file.id === current)) out.unshift(<option key={current} value={current}>{current} · file not found</option>)
    return out
  }

  const issueBox = (phase: Phase): JSX.Element | null => {
    const issue: PlanIssue | undefined = issues.find((candidate) => candidate.phase === phase)
    if (!issue) return null
    return (
      <div className="pr-issue" role="alert" data-issue={phase} data-code={issue.code}>
        <div className="pr-issue-line"><CircleAlert aria-hidden /><span>{issue.message}</span></div>
        {issue.fix && (
          <button type="button" className="pr-fix" data-fix={phase} onClick={() => { setDraft((current) => applyFix(current, issue.fix!)); setError(null) }}>
            <Clock aria-hidden />{issue.fix.label}
          </button>
        )}
      </div>
    )
  }

  const phaseBlock = ({ phase, label, icon: Icon }: (typeof PHASES)[number]): JSX.Element => {
    const w = draft[phase]
    const file = (files ?? []).find((candidate) => candidate.id === w.fileId)
    const isMarked = marked[phase]
    const badClosing = issues.some((issue) => issue.phase === phase && issue.code.includes('closes'))
    const setOpensMode = w.opens === SESSION_END ? 'end' : 'set'
    return (
      <section className="pr-block" data-phase={phase} data-testid={`plan-run-${phase}work`}>
        <header className="pr-block-head">
          <Icon aria-hidden /><b>{label}</b>
          <select data-field={`${phase}-file`} value={w.fileId} disabled={isMarked || given} aria-label={`${label} file`}
            onChange={(event) => setPhase(phase, { fileId: event.target.value })}>
            {fileOptions(phase)}
            <option value="">None</option>
          </select>
        </header>
        <div className="pr-block-body">
          {isMarked ? (
            <p className="pr-mark" data-testid={`plan-run-${phase}-mark`} role="alert">
              <CircleAlert aria-hidden />This Run’s {label.toLowerCase()} was set in a different time zone from the Run’s own, so it cannot be changed here. Saving leaves it as it is.
            </p>
          ) : !w.fileId ? (
            <p className="pr-none" data-field={`${phase}-none`}>No {label.toLowerCase()} on this Run.</p>
          ) : (
            <>
              {file && (
                <ol className="pr-steps" data-field={`${phase}-steps`}>
                  {file.steps.map((step) => {
                    const StepIcon = STEP_ICONS[step.icon]
                    return <li key={`${step.n}-${step.id}`}><StepIcon aria-hidden /><span className="pr-step-kind">{step.n} · {step.kindLabel.split(' · ')[0]}</span><span className="pr-step-title">{step.title}</span></li>
                  })}
                </ol>
              )}
              {w.fileId === LEGACY_SECTION_FILE_ID && <p className="pr-none">The talk’s own pre-work section, planned before work files.</p>}
              <div className="pr-row pr-row-2">
                <label className="pr-field"><span className="pr-label">Opens</span>
                  {phase === 'post' ? (
                    <>
                      <select data-field="post-opens-mode" value={setOpensMode} onChange={(event) => setPhase('post', { opens: event.target.value === 'end' ? SESSION_END : '' })}>
                        <option value="end">When the session ends</option>
                        <option value="set">At a set time…</option>
                      </select>
                      {setOpensMode === 'set' && <input type="datetime-local" data-field="post-opens" value={w.opens === SESSION_END ? '' : w.opens} onChange={(event) => setPhase('post', { opens: event.target.value })} />}
                    </>
                  ) : (
                    <input type="datetime-local" data-field="pre-opens" value={w.opens} placeholder="Day and time" onChange={(event) => setPhase('pre', { opens: event.target.value })} />
                  )}
                </label>
                <label className="pr-field"><span className="pr-label">Closes{phase === 'post' ? <em> · required</em> : null}</span>
                  <input type="datetime-local" data-field={`${phase}-closes`} value={w.closes} aria-invalid={badClosing || undefined} className={badClosing ? 'is-error' : undefined}
                    onChange={(event) => setPhase(phase, { closes: event.target.value })} />
                  {phase === 'pre' && !w.closes && <small className="pr-hint" data-field="pre-closes-at">When the session starts</small>}
                </label>
              </div>
              {issueBox(phase)}
            </>
          )}
        </div>
      </section>
    )
  }

  return (
    <div className="plan-run-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="plan-run" role="dialog" aria-modal="true" aria-labelledby="plan-run-title" data-testid="plan-run-sheet"
        onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save() } }}>
        <div className="pr-head">
          <CalendarClock aria-hidden />
          <h2 id="plan-run-title">{given ? 'Change time' : run ? 'Edit plan' : copyFrom ? 'Plan the next run' : 'Plan a run'}</h2>
        </div>
        <div className="pr-body">
          <div className="pr-row pr-row-2">
            <label className="pr-field"><span className="pr-label">Talk</span>
              <select value={talkSlug} data-field="talk" disabled={Boolean(run) || !talks || talks.length < 2} onChange={(event) => { setTalkSlug(event.target.value); set('slideSet', 'full'); touched.current = { pre: false, post: false } }}>
                {(talks ?? [talk]).map((candidate) => <option key={candidate.slug} value={candidate.slug}>{candidate.title}</option>)}
              </select>
            </label>
            <label className="pr-field"><span className="pr-label">Event</span>
              <input ref={eventRef} data-field="event" value={draft.event} maxLength={120} placeholder="Event name" disabled={given}
                onChange={(event) => set('event', event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); void save() } }} />
            </label>
          </div>
          <div className="pr-row pr-row-4">
            <label className="pr-field"><span className="pr-label">Date</span>
              <input type="date" data-field="date" value={draft.date} disabled={given} onChange={(event) => setDate(event.target.value)} /></label>
            <label className="pr-field"><span className="pr-label">Time</span>
              <input type="time" data-field="start" value={draft.startTime} disabled={given} placeholder="hh:mm" onChange={(event) => set('startTime', event.target.value)} /></label>
            <label className="pr-field"><span className="pr-label">Time zone</span>
              <select data-field="time-zone" value={timeZone} disabled={marked.pre || marked.post || given} onChange={(event) => setTimeZone(event.target.value)}>
                {zones.map((zone) => <option key={zone} value={zone}>{zone.replace(/_/g, ' ')}</option>)}
              </select></label>
            <label className="pr-field"><span className="pr-label">Expected people</span>
              <input type="number" min={1} step={1} data-field="expected" value={draft.expected} disabled={given} placeholder="Number" onChange={(event) => set('expected', event.target.value)} /></label>
          </div>
          <label className="pr-field"><span className="pr-label">Audience <em>· optional</em></span>
            <input data-field="audience" value={draft.audience} disabled={given} maxLength={120} placeholder="e.g. IT Services staff" onChange={(event) => set('audience', event.target.value)} /></label>
          <section className="pr-block pr-slides" data-testid="plan-run-slides">
            <header className="pr-block-head"><Layers aria-hidden /><b>Slides</b></header>
            <div className="pr-block-body">
              <select data-field="slide-set" aria-label="Slides" disabled={given} value={hasPathway ? draft.slideSet : 'full'}
                onChange={(event) => { if (event.target.value === NEW_PATHWAY) void newPathway(); else { awaitingPathway.current = null; set('slideSet', event.target.value) } }}>
                <option value="full">Full talk{fullCount !== null ? ` · ${slides(fullCount)}` : ''}</option>
                {pathways.map((pathway) => <option key={pathway.id} value={pathway.id}>{pathway.name} · {slides(pathway.count)}</option>)}
                <option value={NEW_PATHWAY}>New pathway…</option>
              </select>
            </div>
          </section>
          {showWork && <div className="pr-work">{PHASES.map(phaseBlock)}</div>}
        </div>
        <div className="pr-foot">
          <span className={`pr-foot-note ${error ? 'is-error' : ''}`} role={error ? 'alert' : undefined} data-testid="plan-run-message">
            {error ?? (given ? 'This run has been given: only the pre-work and post-work times can change.' : draft.date ? `${longDate(draft.date)}. You can change any of this from Sessions.` : '')}
          </span>
          <button type="button" className="pr-btn pr-btn-plain" onClick={onClose} data-testid="plan-run-cancel">Cancel</button>
          <button type="button" className={`pr-btn ${plan.ok ? '' : 'is-pending'}`} disabled={busy} onClick={() => { void save() }} data-testid="plan-run-save">{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import type { Pathway, RecordingSession } from '../../../preload/index'
import { blankDraft, dayAndTime, draftFromRun, longDate, planFromDraft, sheetTimeZone, zoneToSend, type PlanDraft } from '../../../shared/plan-run'
import { preworkFromOutline } from '../../../../compiler/scripts/lib/prework.mjs'
import { preworkEnabled } from '../../../shared/prework-flag'
import '../plan-run.css'

// The plan sheet (ADR-0032 point 5, round-3 P2): one sheet for planning a Run, opened from Present ›
// Plan a run…, from the status bar and from History. Text is rendered as text only; nothing here
// writes a Run except through window.tw.history.

export interface PlanRunTalk { slug: string; title: string; outlinePath: string }

const ERROR_TEXT: Record<string, string> = {
  'event-title-required': 'Give the event a name.',
  'planned-date-invalid': 'Choose a date.',
  'start-time-invalid': 'Choose a start time.',
  'expected-people-invalid': 'Expected people is a whole number, or leave it empty.',
  'prework-opens-invalid': 'Choose when pre-work opens.',
  'prework-closes-invalid': 'Choose when pre-work closes.',
  'prework-closes-before-opens': 'Pre-work must close after it opens.'
}

export default function PlanRunSheet({ talk, talks, run, onClose, onSaved }: {
  /** The talk the Run is for. */
  talk: PlanRunTalk
  /** When given the sheet lets the person pick the talk (History without a scoped talk). */
  talks?: PlanRunTalk[]
  /** Editing this planned Run; absent = planning a new one. */
  run?: RecordingSession | null
  onClose: () => void
  onSaved: (run: RecordingSession) => void
}): JSX.Element {
  const [talkSlug, setTalkSlug] = useState(talk.slug)
  const activeTalk = talks?.find((candidate) => candidate.slug === talkSlug) ?? talk
  const [prework, setPrework] = useState({ present: false, steps: 0 })
  const [pathways, setPathways] = useState<Pathway[]>([])
  const [draft, setDraft] = useState<PlanDraft>(() => run ? draftFromRun(run, new Date()) : blankDraft(new Date(), false))
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const eventRef = useRef<HTMLInputElement>(null)
  const touchedPrework = useRef(Boolean(run))

  useEffect(() => { eventRef.current?.focus() }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const source = await window.tw.talk.readOutline(activeTalk.outlinePath)
      if (cancelled || source === null) return
      // Pre-work hidden (0.37): no fields, and none sent, so a Run's stored pre-work times are left as they are.
      const definition = preworkEnabled() ? preworkFromOutline(source) : null
      const info = { present: definition !== null, steps: definition?.steps.length ?? 0 }
      setPrework(info)
      // A new plan for a talk with pre-work starts with pre-work on (the toggle can still switch it off).
      if (!touchedPrework.current) setDraft((current) => ({ ...current, preworkOn: info.present }))
      const snapshot = await window.tw.pathways.read(activeTalk.outlinePath, source)
      if (!cancelled) setPathways('error' in snapshot ? [] : snapshot.pathways)
    })()
    return () => { cancelled = true }
  }, [activeTalk.outlinePath])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  // The pre-work times are read in the Run's own zone (this machine's for a new plan), which the
  // person can change: a Run planned from Oxford for Prague says Prague (ticket 09).
  const [timeZone, setTimeZone] = useState(() => sheetTimeZone(run, Intl.DateTimeFormat().resolvedOptions().timeZone))
  const zones = useMemo(() => {
    const listed = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
    return listed.includes(timeZone) ? listed : [timeZone, ...listed]
  }, [timeZone])
  const set = <K extends keyof PlanDraft>(key: K, value: PlanDraft[K]): void => setDraft((current) => ({ ...current, [key]: value }))
  const startsAt = `${draft.date}T${draft.startTime}`
  const hasPathway = draft.slideSet === 'full' || pathways.some((pathway) => pathway.id === draft.slideSet)
  const slideSetOptions = useMemo(() => pathways, [pathways])

  async function save(): Promise<void> {
    const plan = planFromDraft(draft, prework.present)
    if (!plan.ok) { setError(plan.error); return }
    setBusy(true)
    setError(null)
    const zone = zoneToSend(run, timeZone, Boolean(plan.fields.preworkOpens))
    const fields = { ...plan.fields, ...(zone ? { timeZone: zone } : {}) }
    const result = run
      ? await window.tw.history.updatePlannedRun(run.talkSlug, run.id, fields)
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
        ...(zone ? { timeZone: zone } : {})
      })
    setBusy(false)
    if (!result.ok || !result.run) { setError(ERROR_TEXT[result.error ?? ''] ?? `Could not plan the run: ${result.error ?? 'unknown error'}`); return }
    window.dispatchEvent(new Event('tw-runs-changed'))
    onSaved(result.run)
  }

  return (
    <div className="plan-run-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="plan-run" role="dialog" aria-modal="true" aria-labelledby="plan-run-title" data-testid="plan-run-sheet"
        onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save() } }}>
        <div className="pr-head">
          <div className="pr-eyebrow">{run ? 'Edit plan' : 'Plan a run'}</div>
          <h2 id="plan-run-title">{activeTalk.title}</h2>
          <p>{preworkEnabled()
            ? 'A Run is one delivery of this talk. Planning it ahead is what opens pre-work and keeps everything the room and the participants give you in one place.'
            : 'A Run is one delivery of this talk. Planning it ahead keeps everything the room and the participants give you in one place.'}</p>
        </div>
        <div className="pr-body">
          {talks && !run && talks.length > 1 && (
            <label className="pr-field"><span className="pr-label">Talk</span>
              <select value={talkSlug} data-field="talk" onChange={(event) => { setTalkSlug(event.target.value); set('slideSet', 'full') }}>
                {talks.map((candidate) => <option key={candidate.slug} value={candidate.slug}>{candidate.title}</option>)}
              </select>
            </label>
          )}
          <label className="pr-field"><span className="pr-label">Event</span>
            <input ref={eventRef} data-field="event" value={draft.event} maxLength={120} placeholder="e.g. ITSS Briefing, October"
              onChange={(event) => set('event', event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); void save() } }} />
          </label>
          <div className="pr-row pr-row-3">
            <label className="pr-field"><span className="pr-label">Date</span>
              <input type="date" data-field="date" value={draft.date} onChange={(event) => set('date', event.target.value)} /></label>
            <label className="pr-field"><span className="pr-label">Starts</span>
              <input type="time" data-field="start" value={draft.startTime} onChange={(event) => set('startTime', event.target.value)} /></label>
            <label className="pr-field"><span className="pr-label">Expected <em>· optional</em></span>
              <input type="number" min={1} step={1} data-field="expected" value={draft.expected} placeholder="people" onChange={(event) => set('expected', event.target.value)} /></label>
          </div>
          <div className="pr-row pr-row-2">
            <label className="pr-field"><span className="pr-label">Audience</span>
              <input data-field="audience" value={draft.audience} maxLength={120} placeholder="e.g. IT Services staff" onChange={(event) => set('audience', event.target.value)} /></label>
            <label className="pr-field"><span className="pr-label">Slide set</span>
              <select data-field="slide-set" value={hasPathway ? draft.slideSet : 'full'} onChange={(event) => set('slideSet', event.target.value)}>
                <option value="full">Full talk</option>
                {slideSetOptions.map((pathway) => <option key={pathway.id} value={pathway.id}>{pathway.name}</option>)}
              </select></label>
          </div>
          {prework.present && (
            <div className="pr-prework" data-testid="plan-run-prework">
              <div className="pr-prework-head">
                <div><b>Pre-work</b> · Before the session {prework.steps > 0 && <small>{prework.steps} {prework.steps === 1 ? 'step' : 'steps'}</small>}</div>
                <button type="button" role="switch" aria-checked={draft.preworkOn} aria-label="Pre-work" data-field="prework-toggle"
                  className={`pr-switch ${draft.preworkOn ? 'on' : ''}`}
                  onClick={() => { touchedPrework.current = true; set('preworkOn', !draft.preworkOn) }}><i /></button>
              </div>
              {draft.preworkOn && (
                <>
                  <div className="pr-row pr-row-2">
                    <label className="pr-field"><span className="pr-label">Opens</span>
                      <input type="datetime-local" data-field="opens" value={draft.opens} onChange={(event) => set('opens', event.target.value)} /></label>
                    <label className="pr-field"><span className="pr-label">Closes</span>
                      <select data-field="closes-mode" value={draft.closes === null ? 'start' : 'set'}
                        onChange={(event) => set('closes', event.target.value === 'start' ? null : startsAt)}>
                        <option value="start">When the talk starts</option>
                        <option value="set">At a set time…</option>
                      </select>
                      {draft.closes === null && <small className="pr-hint" data-field="closes-at">{dayAndTime(startsAt)}</small>}</label>
                  </div>
                  {draft.closes !== null && (
                    <label className="pr-field"><span className="pr-label">Closes at</span>
                      <input type="datetime-local" data-field="closes" value={draft.closes} onChange={(event) => set('closes', event.target.value)} /></label>
                  )}
                  <label className="pr-field pr-zone"><span className="pr-label">Times are in</span>
                    <select data-field="time-zone" value={timeZone} onChange={(event) => setTimeZone(event.target.value)}>
                      {zones.map((zone) => <option key={zone} value={zone}>{zone.replace(/_/g, ' ')}</option>)}
                    </select></label>
                  {run?.handoutUrl && (
                    <div className="pr-field"><span className="pr-label">Link participants use</span><div className="pr-link" data-field="link">{run.handoutUrl}</div></div>
                  )}
                  <p className="pr-note">The talk’s handout link. From the opening time it shows the pre-work form; once it closes it shows the slides. Nothing goes out until you send the link yourself.</p>
                </>
              )}
            </div>
          )}
        </div>
        <div className="pr-foot">
          <span className={`pr-foot-note ${error ? 'is-error' : ''}`} role={error ? 'alert' : undefined} data-testid="plan-run-message">
            {error ?? `${longDate(draft.date)}. You can change any of this from the status bar or from History.`}
          </span>
          <button type="button" className="pr-btn pr-btn-plain" onClick={onClose} data-testid="plan-run-cancel">Cancel</button>
          <button type="button" className="pr-btn" disabled={busy} onClick={() => { void save() }} data-testid="plan-run-save">{busy ? 'Saving…' : run ? 'Save plan' : 'Plan run'}</button>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import type { RecordingSession } from '../../../preload/index'
import { dayAndTime, localToday, longDate, nextPlannedRun, preworkWindow, runChips } from '../../../shared/plan-run'
import { preworkFromOutline } from '../../../../compiler/scripts/lib/prework.mjs'
import { preworkOverview } from '../../../shared/run-prework-results'
import { usePlannedRuns } from './usePlannedRuns'
import { preworkEnabled } from '../../../shared/prework-flag'

// The talk shows its next planned Run (round-3 P3, P5): "Next run: <event>, <date>" opens what is
// known about the Run; "Pre-work opens <date>" sits beside it when the Run has pre-work; and a talk
// with pre-work but no planned Run says "No run planned · Plan a run…". Every string here is text.

export default function RunStatusChips({ talk, outlineContent, onPlan }: {
  talk: { slug: string; outlinePath: string }
  outlineContent: string
  /** Open the plan sheet: for a new Run (null) or to edit the given one. */
  onPlan: (run: RecordingSession | null) => void
}): JSX.Element | null {
  const runs = usePlannedRuns(talk.slug)
  const [open, setOpen] = useState(false)
  const [pathwayNames, setPathwayNames] = useState<Record<string, string>>({})
  const anchor = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState<{ right: number; bottom: number } | null>(null)

  useEffect(() => { setOpen(false) }, [talk.slug])

  const definition = useMemo(() => (preworkEnabled() ? preworkFromOutline(outlineContent) : null), [outlineContent])
  const hasPrework = definition !== null
  const now = new Date()
  const next = nextPlannedRun(runs, talk.slug, localToday(now))
  // The count comes from the answers the Run has mirrored (the Worker is not asked here).
  const progress = useMemo(() => {
    if (!next || !definition) return null
    const overview = preworkOverview(definition, next.prework ?? null, next.expectedPeople)
    return { started: overview.started, finished: overview.finished }
  }, [next, definition])
  const allChips = runChips(next, hasPrework, now, progress)
  const chips = preworkEnabled() ? allChips : { ...allChips, prework: null } // a Run's stored pre-work times show no chip while pre-work is hidden

  useEffect(() => {
    if (!open || !next || next.slideSet?.kind !== 'pathway') return
    let cancelled = false
    void (async () => {
      const source = await window.tw.talk.readOutline(talk.outlinePath)
      if (source === null) return
      const snapshot = await window.tw.pathways.read(talk.outlinePath, source)
      if (cancelled || 'error' in snapshot) return
      setPathwayNames(Object.fromEntries(snapshot.pathways.map((pathway) => [pathway.id, pathway.name])))
    })()
    return () => { cancelled = true }
  }, [open, next, talk.outlinePath])

  useEffect(() => {
    if (!open) return
    const close = (event: Event): void => {
      if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Escape') return
      if (event.type === 'mousedown' && (event.target as Element | null)?.closest?.('.run-chip-popover, [data-testid="status-run"], [data-testid="status-prework"]')) return
      setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close) }
  }, [open])

  if (!chips.run && !chips.nudge) return null

  const toggle = (element: HTMLButtonElement): void => {
    const rect = element.getBoundingClientRect()
    setPos({ right: Math.max(12, window.innerWidth - rect.right), bottom: window.innerHeight - rect.top + 8 })
    setOpen((current) => !current)
  }

  const window_ = next && preworkEnabled() ? preworkWindow(next) : null
  const setName = next?.slideSet?.kind === 'pathway' ? (pathwayNames[next.slideSet.pathwayId] ?? 'A pathway') : 'Full talk'
  const details = next ? [next.startTime ? `${longDate(next.plannedDate ?? '')}, ${next.startTime}` : longDate(next.plannedDate ?? ''), next.audience, next.expectedPeople ? `${next.expectedPeople} expected` : ''].filter(Boolean) : []

  return (
    <>
      <span style={{ margin: '0 8px', color: 'var(--line)' }}>|</span>
      {chips.nudge && (
        <button type="button" style={chipStyle} data-testid="status-run-nudge" title="Pre-work needs a planned Run" onClick={() => onPlan(null)}>{chips.nudge.text}</button>
      )}
      {chips.run && (
        <button ref={anchor} type="button" style={{ ...chipStyle, ...chipStrong }} data-testid="status-run" aria-expanded={open}
          onClick={(event) => toggle(event.currentTarget)}>{chips.run.text}</button>
      )}
      {chips.prework && (
        <button type="button" style={chipStyle} data-testid="status-prework" onClick={(event) => toggle(event.currentTarget)}>{chips.prework.text}</button>
      )}
      {open && next && pos && (
        <div className="run-chip-popover" role="dialog" aria-label="Next run" data-testid="run-popover" style={{ right: pos.right, bottom: pos.bottom }}>
          <h3>{next.eventTitle}</h3>
          <div className="rp-sub">{details.join(' · ')}</div>
          <dl>
            {window_ && progress && <><dt>Progress</dt><dd data-testid="run-popover-progress">{progress.started} started · {progress.finished} finished</dd></>}
            {window_ && <><dt>Pre-work</dt><dd>Opens {dayAndTime(window_.opens)}</dd><dt>Closes</dt><dd>{dayAndTime(window_.closes)}{next.preworkCloses ? '' : ' (when the talk starts)'}</dd></>}
            {next.handoutUrl && <><dt>Link</dt><dd>{next.handoutUrl}</dd></>}
            <dt>Slides</dt><dd>{setName}</dd>
          </dl>
          <div className="rp-actions">
            {window_ && <button type="button" data-testid="run-popover-review" onClick={() => { setOpen(false); void window.tw.tools.open('history', `prework:${next.talkSlug}/${next.id}`) }}>Review pre-work</button>}
            <button type="button" data-testid="run-popover-edit" onClick={() => { setOpen(false); onPlan(next) }}>Edit plan…</button>
            <button type="button" data-testid="run-popover-another" onClick={() => { setOpen(false); onPlan(null) }}>Plan another run…</button>
          </div>
        </div>
      )}
    </>
  )
}

const chipStyle: React.CSSProperties = {
  fontSize: '11px', padding: '1px 8px', borderRadius: '4px', whiteSpace: 'nowrap', lineHeight: '1.5', cursor: 'pointer',
  fontFamily: 'inherit', color: 'var(--oxford)', background: 'transparent', border: '1px solid var(--line)', marginRight: '6px', flexShrink: 0
}
const chipStrong: React.CSSProperties = { background: 'color-mix(in srgb, var(--oxford) 8%, transparent)' }

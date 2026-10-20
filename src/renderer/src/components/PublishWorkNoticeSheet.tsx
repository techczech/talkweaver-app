import { useEffect, useRef } from 'react'
import { CalendarPlus, Globe, Info, Presentation, X } from 'lucide-react'

// The talk's Publish dialog when the talk names a pre-work and/or post-work file (work-files ticket 23,
// hifi shots 10-has-pre-work): the notice that work files go out with a Run, with Plan a run, then
// Cancel / Publish. The sentence is built by src/shared/publish-work-notice.ts. A talk naming neither
// file publishes straight away, as in 0.39, and never sees this sheet.

interface Props {
  talkTitle: string
  notice: string
  onCancel: () => void
  onPublish: () => void
  /** Closes this sheet and opens the plan sheet for this talk. */
  onPlanRun: () => void
}

export default function PublishWorkNoticeSheet({ talkTitle, notice, onCancel, onPublish, onPlanRun }: Props): JSX.Element {
  const publishRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onCancel])
  useEffect(() => { publishRef.current?.focus() }, [])

  return (
    <div className="share-sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel() }}>
      <div className="share-sheet" role="dialog" aria-modal="true" aria-labelledby="publish-work-notice-title" data-testid="publish-work-notice-sheet">
        <div className="sh-head">
          <h2 id="publish-work-notice-title" className="sh-title-icon"><Globe size={17} aria-hidden="true" />Publish handout</h2>
        </div>
        <div className="sh-body">
          <div className="sh-label">Talk</div>
          <div className="sh-field"><Presentation aria-hidden="true" /><span className="sh-field-text">{talkTitle}</span></div>
          <div className="sh-work-notice" role="note" data-testid="publish-work-notice">
            <Info size={16} aria-hidden="true" />
            <span className="sh-work-notice-text" data-testid="publish-work-notice-text">{notice}</span>
            <button className="sh-btn sh-btn--plain sh-btn--sm" data-testid="publish-work-notice-plan" onClick={onPlanRun}><CalendarPlus size={14} aria-hidden="true" />Plan a run</button>
          </div>
        </div>
        <div className="sh-foot">
          <div className="sh-foot-right">
            <button className="sh-btn sh-btn--plain" data-testid="publish-work-notice-cancel" onClick={onCancel}><X size={14} aria-hidden="true" /> Cancel</button>
            <button ref={publishRef} className="sh-btn" data-testid="publish-work-notice-publish" onClick={onPublish}><Globe size={14} aria-hidden="true" /> Publish</button>
          </div>
        </div>
      </div>
    </div>
  )
}

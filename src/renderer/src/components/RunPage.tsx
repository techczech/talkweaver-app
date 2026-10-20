import { useEffect, useRef } from 'react'
import { Check, CircleCheck, CircleDot, ClipboardCopy, Clock, Copy, CopyPlus, Eye, EyeOff, FolderOpen, Globe, LayoutGrid, ListChecks, LoaderCircle, Pencil, Presentation, Radio } from 'lucide-react'
import type { ActionId, ChecklistAction, ChecklistStep, RunChecklist } from '../../../shared/run-checklist'
import { runActionEffect, type RunPageEffect } from '../../../shared/run-page'
import type { SessionSource } from '../../../shared/sessions-list'
import { RunAnswers } from './RunAnswers'
import { RunExtrasSection } from './RunExtras'

const ACTION_ICONS: Partial<Record<ActionId, typeof Check>> = {
  'edit-plan': Pencil, 'open-pre-file': FolderOpen, 'open-post-file': FolderOpen, publish: Globe, 'publish-again': Globe,
  'preview-page': Eye, 'change-pre-time': Clock, 'change-post-time': Clock, 'go-live': Radio, 'open-live-view': Radio,
  'mark-delivered': CircleCheck, 'open-results': LayoutGrid
}

function nodeIcon(step: ChecklistStep, publishing: boolean): JSX.Element | null {
  if (step.id === 'published' && publishing) return <LoaderCircle aria-hidden className="tw-spin" />
  if (step.state === 'done') return <Check aria-hidden />
  if (step.state === 'live') return <Radio aria-hidden />
  if (step.state === 'warn') return <EyeOff aria-hidden />
  if (step.state === 'todo') return null
  if (step.id === 'pre-closes' || step.id === 'post-closes') return <Clock aria-hidden />
  if (step.id === 'delivered') return <Radio aria-hidden />
  return <CircleDot aria-hidden />
}

/**
 * A link as its path segments, which may break only between them (Amendment 2: the locked shots broke
 * "said-21-oc / t"): `handouts.fyi` `/dl` `/said-21-oct` `/pre-work`, each kept whole.
 */
function LinkText({ url }: { url: string }): JSX.Element {
  const bare = url.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  const [head, ...rest] = bare.split('/')
  return <><span>{head}</span>{rest.map((segment, index) => <span key={index}><wbr /><span>/{segment}</span></span>)}</>
}

const QR_FOR: Record<NonNullable<ChecklistStep['qr']>, string> = { handout: 'handout', 'pre-work': 'pre-work', 'post-work': 'post-work' }

function ActionButton({ action, onEffect, busy }: { action: ChecklistAction; onEffect: (effect: RunPageEffect, action: ChecklistAction) => void; busy: boolean }): JSX.Element {
  const effect = runActionEffect(action.id)
  const Icon = action.disabled && (action.id === 'publish' || action.id === 'publish-again') ? LoaderCircle : ACTION_ICONS[action.id]
  // An action no feature wires yet is shown disabled, not dead.
  const disabled = action.disabled === true || effect === null || busy
  const secondary = action.id === 'mark-delivered'
  return (
    <button type="button" className={`tw-sess-btn sm${action.primary ? ' pri' : ''}${secondary ? ' quiet' : ''}`} data-run-action={action.id}
      disabled={disabled} title={action.reason ?? (effect === null ? 'Not available yet' : undefined)}
      onClick={() => { if (effect) onEffect(effect, action) }}>
      {Icon && <Icon aria-hidden className={Icon === LoaderCircle ? 'tw-spin' : undefined} />}{action.label}
    </button>
  )
}

export interface PublishedBlockHandlers {
  /** The QR code of the link `step.qr` names, as SVG; null while it is being made. */
  qrSvg?: string | null
  onInvitation?: () => void
  onUnpublish?: () => void
}

function StepRow({ step, onEffect, onCopy, busy, publishing, block }: { step: ChecklistStep; onEffect: (effect: RunPageEffect, action: ChecklistAction) => void; onCopy: (url: string) => void; busy: boolean; publishing: boolean; block: PublishedBlockHandlers }): JSX.Element {
  const showPublishing = step.id === 'published' && publishing
  return (
    <div className={`tw-run-step ${step.state === 'current' || showPublishing ? 'cur' : step.state}`} data-run-step={step.id} data-state={step.state}>
      <div><span className="node">{nodeIcon(step, publishing)}</span></div>
      <div className="body">
        <div className="st">{step.title}</div>
        {step.detail && <div className="ss">{step.detail}</div>}
        {showPublishing && (
          <div className="progrow" data-run-progress role="status"><span className="bar" aria-hidden><i /></span>Uploading page</div>
        )}
        {step.links?.map((link) => (
          <div key={link.kind} className="linkrow" data-run-link={link.kind}>
            <div className="lt"><span className="lk">{link.label}</span><span className="url"><LinkText url={link.url} /></span></div>
            <button type="button" className="cp" aria-label={`Copy ${link.kind === 'handout' ? 'handout' : link.kind} link`} title={`Copy ${link.kind === 'handout' ? 'handout' : link.kind} link`} onClick={() => onCopy(link.url)}><Copy aria-hidden /></button>
          </div>
        ))}
        {step.links && step.qr && (
          <div className="pubgrid" data-run-published-block>
            <div className="qrwrap">
              <span className="qr" data-run-qr={step.qr}>{block.qrSvg ? <img alt={`QR code for the ${QR_FOR[step.qr]} link`} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(block.qrSvg)}`} /> : null}</span>
              <span className="qcap">QR · {QR_FOR[step.qr]}</span>
            </div>
            <div className="col">
              <button type="button" className="tw-sess-btn sm" data-run-action="copy-invitation" disabled={busy} onClick={() => block.onInvitation?.()}><ClipboardCopy aria-hidden />Copy invitation text</button>
              <button type="button" className="tw-sess-btn sm dng" data-run-action="unpublish" disabled={busy} onClick={() => block.onUnpublish?.()}><EyeOff aria-hidden />Unpublish</button>
            </div>
          </div>
        )}
        {step.actions.length > 0 && (
          <div className="act">{step.actions.map((action) => <ActionButton key={action.id} action={action} onEffect={onEffect} busy={busy} />)}</div>
        )}
      </div>
    </div>
  )
}

/**
 * One Run's page (locked mockup S3): the Run header, the left column with its section places (Answers and
 * Extras are filled by their own features), and the Run checklist rendered from the checklist model.
 * Presentational: the checklist, the effect handler and the notice come from SessionsView.
 */
export function RunPage({ source, checklist, onEffect, onCopy, onPlanLikeThis, onExtrasSaved, onAnswersPulled, busy = false, notice, block = {} }: {
  source: SessionSource
  checklist: RunChecklist
  /** `action` is the checklist action pressed; none for an effect asked from the answers section. */
  onEffect: (effect: RunPageEffect, action?: ChecklistAction) => void
  onCopy: (url: string) => void
  /** "Plan the next run like this": opens the plan sheet prefilled from this Run. */
  onPlanLikeThis?: () => void
  /** Extras for this run were kept on the Run: the list is read again. */
  onExtrasSaved?: () => void
  /** Answers were pulled from the live service onto the Run: the list is read again. */
  onAnswersPulled?: () => void
  busy?: boolean
  notice?: string | null
  /** The Published step's block: its QR code, Copy invitation text and Unpublish. */
  block?: PublishedBlockHandlers
}): JSX.Element {
  const side = useRef<HTMLDivElement>(null)
  const phase = checklist.phase
  // A long checklist opens at its current step (the mockup scrolls it to 200px below the top).
  useEffect(() => {
    const column = side.current
    const current = column?.querySelector<HTMLElement>('.tw-run-step.cur, .tw-run-step.live')
    if (!column || !current) return
    const frame = requestAnimationFrame(() => {
      column.scrollTop = Math.max(0, current.getBoundingClientRect().top - column.getBoundingClientRect().top - 200)
    })
    return () => cancelAnimationFrame(frame)
  }, [source.talkSlug, source.runId, phase, checklist.counter])

  return (
    <div className="tw-sess-detail" data-sessions-detail={`${source.talkSlug}/${source.runId}`} data-run-phase={phase}>
      <div className="tw-sess-dhead">
        <div className="tw-sess-dtitle">
          <h1>{source.eventTitle || source.talkTitle}</h1>
          <div className="sub"><Presentation aria-hidden /><span>{source.talkTitle}</span><span className={`tw-sess-pill ${checklist.pill.kind}`} data-run-pill>{checklist.pill.label}</span></div>
        </div>
        {onPlanLikeThis && <button type="button" className="tw-sess-btn" data-run-plan-like-this disabled={busy} onClick={onPlanLikeThis}><CopyPlus aria-hidden />Plan the next run like this</button>}
      </div>
      <div className="tw-run-cols">
        <div className="tw-run-main">
          <RunAnswers source={source} runPhase={phase} onPulled={onAnswersPulled} onOpenWorkFile={(workPhase) => onEffect({ kind: 'open-work-file', phase: workPhase })} />
          <RunExtrasSection source={source} busy={busy} onSaved={() => onExtrasSaved?.()} />
        </div>
        <div className="tw-run-side" ref={side}>
          <section className="tw-run-sec tw-run-check" data-run-checklist>
            <header><ListChecks aria-hidden /><span>Run checklist</span><span className="meta" data-run-counter>{checklist.counter}</span></header>
            {notice && <div className="tw-run-notice" role="status" data-run-notice>{notice}</div>}
            {checklist.steps.map((step) => <StepRow key={step.id} step={step} onEffect={onEffect} onCopy={onCopy} busy={busy} publishing={checklist.publication === 'publishing'} block={block} />)}
          </section>
        </div>
      </div>
    </div>
  )
}

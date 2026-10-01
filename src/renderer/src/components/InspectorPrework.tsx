// The Inspector's "Before the session" section (ADR-0032 amendment point 5; round-2 E1–E4,
// round-3 P5; ticket 08). For a pre-work step: what the slide is to participants, the step's own
// settings (a quick check's right answer, a pre-task's Mark as done and time, questions on or off),
// the form's steps, and the planned Run that opens and closes it — or, with no Run planned, the
// nudge to plan one. For a talk slide with `{results=…}`: which step's answers it shows. Every
// author and participant string here is rendered as text.
import { AlertTriangle, BarChart3, CalendarDays, EyeOff, ListChecks, MessageCircleQuestion, Presentation, SquareCheckBig } from 'lucide-react'
import type { PreworkKind } from '../../../../compiler/scripts/lib/prework.mjs'
import type { PlanRunLike } from '../../../shared/plan-run'
import {
  PREWORK_KIND_LABELS, preworkRunLine, stepChoiceLabel, type InspectorPreworkModel
} from './inspectorPreworkModel'

interface Props {
  model: InspectorPreworkModel
  /** The step's registry rows (prework-participants, prework-minutes, prework-ask), rendered by the Inspector. */
  settings: React.ReactNode
  /** The talk's next planned Run, or null. */
  nextRun: PlanRunLike | null
  /** Open the plan sheet: a new Run (null) or the given one. */
  onPlanRun: (runId: string | null) => void
  /** Write the quick check's right answer (0-based option; -1 clears). */
  onRightAnswer: (optionIndex: number) => void
  /** Write the `{results=…}` token a talk slide carries. */
  onResults: (token: string) => void
  /** Inspect another step of the form. */
  onInspectStep: (stepId: string) => void
}

const KIND_ICON: Record<PreworkKind, typeof Presentation> = {
  slide: Presentation, check: ListChecks, question: BarChart3, task: SquareCheckBig
}

export default function InspectorPrework({ model, settings, nextRun, onPlanRun, onRightAnswer, onResults, onInspectStep }: Props): JSX.Element {
  const { definition, step } = model
  const runLine = preworkRunLine(nextRun)

  if (model.mode === 'results' && model.results) {
    const results = model.results
    return (
      <div className="tw-prework" data-testid="inspector-prework" data-mode="results">
        <label className="tw-prework-field">
          <span className="tw-prework-label">Shows</span>
          <select
            className="tw-prework-select"
            data-testid="prework-results"
            value={`results=${results.stepId}`}
            onChange={(event) => onResults(event.target.value)}
          >
            {results.group.values.map((value) => <option key={value.token} value={value.token}>{value.label}</option>)}
          </select>
        </label>
        <p className="tw-prework-note">{model.thisSlide}</p>
        <div className="tw-prework-kv">
          <span>Eyebrow</span><span>{definition.title}</span>
          <span>Kept in</span><span>The Run, with the pre-work answers</span>
        </div>
      </div>
    )
  }

  return (
    <div className="tw-prework" data-testid="inspector-prework" data-mode={model.mode}>
      <div className="tw-prework-field">
        <span className="tw-prework-label">This slide</span>
        <p className="tw-prework-note" data-testid="prework-this-slide"><Presentation aria-hidden="true" />{model.thisSlide}</p>
      </div>

      {runLine.kind === 'no-run' && (
        <div className="tw-prework-nudge" role="note" data-testid="prework-nudge">
          <AlertTriangle aria-hidden="true" />
          <div>
            <b>Pre-work needs a planned Run.</b>
            <p>The form opens and closes on the Run’s dates and is served from its handout link, so nobody can reach it yet. Plan the next time you give this talk.</p>
            <button type="button" className="tw-prework-plan" data-testid="prework-plan-run" onClick={() => onPlanRun(null)}>
              <CalendarDays aria-hidden="true" />Plan a run…
            </button>
          </div>
        </div>
      )}

      {step?.kind === 'check' && (
        <>
          <label className="tw-prework-field">
            <span className="tw-prework-label">Right answer · only you see it</span>
            <select
              className="tw-prework-select"
              data-testid="prework-right-answer"
              value={String(step.right?.index ?? -1)}
              onChange={(event) => onRightAnswer(Number(event.target.value))}
            >
              {!step.right && <option value="-1">Choose the right answer…</option>}
              {(step.options ?? []).map((option, index) => <option key={index} value={String(index)}>{option}</option>)}
            </select>
          </label>
          <div className="tw-prework-field">
            <span className="tw-prework-label">Participants see</span>
            <p className="tw-prework-note"><EyeOff aria-hidden="true" />No marks: they see “Saved”; the room sees the results on a slide in the session.</p>
          </div>
        </>
      )}

      {settings}

      {step && (
        <p className="tw-prework-note tw-prework-note--quiet">
          <MessageCircleQuestion aria-hidden="true" />
          {step.questions
            ? 'Participants can ask about this step; you read the questions on the planned Run in History.'
            : 'Participants cannot ask about this step.'}
        </p>
      )}

      {step && step.kind !== 'slide' && (
        <div className="tw-prework-field">
          <span className="tw-prework-label">In the talk</span>
          <p className="tw-prework-note">
            <BarChart3 aria-hidden="true" />
            <span>A talk slide can show {step.kind === 'task' ? 'how many did it' : 'the answers'}: <code>{`{results=${step.id}}`}</code></span>
          </p>
        </div>
      )}

      <div className="tw-prework-form" data-testid="prework-form">
        <div className="tw-prework-form-head">
          <b><ListChecks aria-hidden="true" />Pre-work: {definition.title}</b>
          <small>{definition.steps.length} {definition.steps.length === 1 ? 'step' : 'steps'}</small>
        </div>
        <ol className="tw-prework-steps">
          {definition.steps.map((candidate) => {
            const Icon = KIND_ICON[candidate.kind]
            const current = candidate.id === step?.id
            return (
              <li key={`${candidate.n}:${candidate.id}`}>
                <button
                  type="button"
                  className={current ? 'is-current' : undefined}
                  aria-current={current ? 'step' : undefined}
                  title={stepChoiceLabel(definition, candidate)}
                  onClick={() => onInspectStep(candidate.id)}
                >
                  <span className="tw-prework-step-n">{candidate.n}</span>
                  <Icon aria-hidden="true" />
                  <span className="tw-prework-step-title">{candidate.title}</span>
                  <small>· {PREWORK_KIND_LABELS[candidate.kind]}</small>
                </button>
              </li>
            )
          })}
        </ol>
        {runLine.kind === 'window' && (
          <div className="tw-prework-kv" data-testid="prework-window">
            <span>Opens</span><span>{runLine.opens}</span>
            <span>Closes</span><span>{runLine.closes}{runLine.closesAtStart ? ' (when the talk starts)' : ''}</span>
            <span>Run</span><span><button type="button" className="tw-prework-link" onClick={() => onPlanRun(runLine.runId)}>{runLine.run}</button></span>
          </div>
        )}
        {runLine.kind === 'no-window' && (
          <div className="tw-prework-kv" data-testid="prework-window">
            <span>Run</span>
            <span>{runLine.run} has no pre-work dates. <button type="button" className="tw-prework-link" onClick={() => onPlanRun(runLine.runId)}>Edit plan…</button></span>
          </div>
        )}
      </div>
    </div>
  )
}

// The Inspector's Results section (work-files ticket 27): for a talk slide with `{results=…}`, which
// step's answers it shows. The 0.37 "Before the session" section for a talk's own `{prework}` steps
// (right answer, Mark as done, the form's steps, the plan-a-run nudge) is gone (work-files ticket 29):
// pre-work is written in a work file. Every author string here is rendered as text.
import type { InspectorPreworkModel } from './inspectorPreworkModel'

interface Props {
  model: InspectorPreworkModel
  /** Write the `{results=…}` token a talk slide carries. */
  onResults: (token: string) => void
}

export default function InspectorPrework({ model, onResults }: Props): JSX.Element {
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
        <span>Kept in</span><span>{results.workFile ? 'The Run it is presented for, with its answers' : 'The Run, with the pre-work answers'}</span>
      </div>
    </div>
  )
}

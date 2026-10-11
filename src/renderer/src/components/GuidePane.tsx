import { GUIDE_SEGMENTS, firstStepsCount, type FirstStep, type FirstStepId, type GuideSegment } from '../../../shared/guide'
import { IcCheck, IcTrash2 } from './talklist/icons'
import { EXAMPLE_REMOVAL_TEXT } from '../../../shared/example-vault-removal'
import GuideChapters, { type GuideChaptersProps } from './GuideChapters'
import GuideHowItWorks, { type GuideHowProps } from './GuideHowItWorks'
import GuideFeatures, { type GuideFeaturesProps } from './GuideFeatures'

// The Guide (onboarding ticket 07; locked drawing states 02 and 03): three segments, and on the
// first one the First steps card. Pure presentation: App owns the state and the actions.
//
// SLOTS:
// The Chapters card (ticket 08) fills data-guide-slot="chapters" under First steps. The example vault's
// "Remove the example vault…" button (ticket 12) follows it on the chapter list.
// How it works and Features to delight you (ticket 11) fill data-guide-slot="how-it-works" and "features".

export interface GuidePaneProps {
  segment: GuideSegment
  onSegment: (segment: GuideSegment) => void
  steps: FirstStep[]
  onStep: (id: FirstStepId) => void
  /** Learn the commands: the ten chapters and the open chapter (ticket 08). */
  chapters: GuideChaptersProps
  /** "Remove the example vault…" under the chapters (ticket 12; states 15, 17): only while the
   *  example vault is in the list. Opens the same confirmation as the vault's ⋯ menu. */
  onRemoveExample?: () => void
  /** How it works: the nine topics and the open topic (ticket 11). */
  how: GuideHowProps
  /** Features to delight you, with What it connects to (ticket 11). */
  features: GuideFeaturesProps
}

export default function GuidePane({ segment, onSegment, steps, onStep, chapters, onRemoveExample, how, features }: GuidePaneProps) {
  return (
    <section className="guide" aria-label="Guide" data-guide>
      <div className="guide-segments" role="tablist" aria-label="Guide sections">
        {GUIDE_SEGMENTS.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={segment === s.id}
            className={`guide-segment${segment === s.id ? ' guide-segment--on' : ''}`}
            data-guide-segment={s.id}
            onClick={() => onSegment(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="guide-body">
        {segment === 'commands' && (
          <>
            {!chapters.selected && <FirstSteps steps={steps} onStep={onStep} />}
            <div data-guide-slot="chapters"><GuideChapters {...chapters} /></div>
            {onRemoveExample && !chapters.selected && (
              <div className="guide-remove-wrap">
                <button type="button" className="guide-remove" data-guide-remove-example onClick={onRemoveExample}>
                  <IcTrash2 size={12} />{EXAMPLE_REMOVAL_TEXT.guideRemove}
                </button>
              </div>
            )}
          </>
        )}
        {segment === 'how' && <div data-guide-slot="how-it-works"><GuideHowItWorks {...how} /></div>}
        {segment === 'features' && <div data-guide-slot="features"><GuideFeatures {...features} /></div>}
      </div>
    </section>
  )
}

function FirstSteps({ steps, onStep }: { steps: FirstStep[]; onStep: (id: FirstStepId) => void }) {
  return (
    <div className="guide-card" data-guide-steps>
      <div className="guide-card-bar">
        <b>First steps</b>
        <span data-guide-steps-count>{firstStepsCount(steps)}</span>
      </div>
      <ul className="guide-steps">
        {steps.map((step) => (
          <li key={step.id} className={`guide-step${step.done ? ' guide-step--done' : ''}`} data-guide-step={step.id} data-done={step.done ? 'true' : 'false'}>
            <span className="guide-tick" aria-hidden>{step.done ? <IcCheck size={10} /> : null}</span>
            <span className="guide-step-label">{step.label}</span>
            {step.done
              ? <span className="guide-step-result" data-guide-step-result>{step.result}</span>
              : <button type="button" className="guide-step-action" data-guide-step-action onClick={() => onStep(step.id)}>{step.action}</button>}
          </li>
        ))}
      </ul>
    </div>
  )
}

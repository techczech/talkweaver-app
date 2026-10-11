// Stepping through the slides during a live talk (handout home page, fix round 2026-10-09). The page
// follows the speaker by default; the person can step back to catch up and, unless the talk turns
// looking ahead off (frontmatter `live_look_ahead: false`), forward to see what is coming. Stepping
// away leaves "following the speaker"; one control returns to the speaker's slide. Polls and boards
// stay tied to the speaker's slide whatever the person is looking at (live-follow.js).
//
// The decisions are pure and live here; handout-home.js draws them. Each function is embedded in the
// page by `.toString()` (liveStepRuntimeSource), so it is self-contained: no module-level constants.

/**
 * What the live page shows.
 * @param {{ speaker: number | null, viewer: number, following: boolean, slideCount: number, lookAhead: boolean }} input
 *   speaker: the speaker's slide index (null until the live service has sent one); viewer: the slide the
 *   page has on screen; following: whether the page moves with the speaker.
 * @returns {{ shown: number, following: boolean, speaker: number | null, canBack: boolean, canForward: boolean,
 *   ahead: boolean, behind: boolean }}
 *   shown: the slide the page must have on screen. following is true whenever shown is the speaker's
 *   slide: a person who steps back onto it, or whom the speaker reaches, is following again. With
 *   looking ahead off a person is never past the speaker: a speaker who goes back takes them along.
 */
export function liveStepView(input) {
  const count = Math.max(1, Math.floor(Number(input && input.slideCount) || 0))
  const clamp = (value) => Math.max(0, Math.min(count - 1, Math.floor(Number(value) || 0)))
  const lookAhead = !(input && input.lookAhead === false)
  const rawSpeaker = input ? input.speaker : null
  const speaker = rawSpeaker === null || rawSpeaker === undefined || !Number.isFinite(Number(rawSpeaker)) || Number(rawSpeaker) < 0
    ? null : clamp(rawSpeaker)
  if (speaker === null) {
    // Nothing to follow yet: the page stays where it is and offers no stepping.
    return { shown: clamp(input && input.viewer), following: true, speaker: null, canBack: false, canForward: false, ahead: false, behind: false }
  }
  let shown = input && input.following ? speaker : clamp(input && input.viewer)
  if (!lookAhead && shown > speaker) shown = speaker
  const following = shown === speaker
  return {
    shown,
    following,
    speaker,
    canBack: shown > 0,
    canForward: shown < count - 1 && (lookAhead || shown < speaker),
    ahead: shown > speaker,
    behind: shown < speaker,
  }
}

/**
 * One step from what is shown. `delta` is -1 (back) or +1 (forward).
 * @param {{ shown: number, speaker: number | null, canBack: boolean, canForward: boolean }} view (from liveStepView)
 * @param {number} delta
 * @returns {{ to: number, follow: boolean } | null} null when the step is not allowed; follow is true
 *   when the step lands on the speaker's slide (the page then follows the speaker again).
 */
export function liveStepTarget(view, delta) {
  if (!view || view.speaker === null || view.speaker === undefined) return null
  const step = delta < 0 ? -1 : 1
  if (step < 0 && !view.canBack) return null
  if (step > 0 && !view.canForward) return null
  const to = view.shown + step
  return { to, follow: to === view.speaker }
}

/** What the caption under the live slide says. */
export function liveStepCaption(view, slideCount) {
  const count = Math.max(1, Math.floor(Number(slideCount) || 0))
  const at = view.shown + 1
  if (view.speaker === null || view.following) return 'Slide ' + at + ' of ' + count + ' · moves with the speaker'
  return 'Slide ' + at + ' of ' + count + ' · the speaker is on slide ' + (view.speaker + 1)
}

export function liveStepRuntimeSource() {
  return [liveStepView, liveStepTarget, liveStepCaption].map((fn) => fn.toString()).join('\n')
}

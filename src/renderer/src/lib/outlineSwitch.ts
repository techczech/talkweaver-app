// T29b (2026-09-19): one-shot "open → engage → Slide outline" sidebar rule.
//
// Opening a talk from the Talks panel deliberately leaves the sidebar on Talks (the user scrolls
// the editor to see if it is the right file); the FIRST engagement with the editor — a pointerdown
// inside it, or the first document-changing keydown — then switches the sidebar to the Slide
// outline, so once work starts the outline is the default view. The rule is once per opened talk:
// going back to Talks and clicking in the same talk does not switch again; re-opening from the
// panel re-arms.
//
// The armed value is keyed by the opened talk's outlinePath (not a bare boolean): engagement only
// counts while that talk is still the active one. A non-panel route (launch restore, deep link,
// History/Studio, ⌘N windows, new-talk creation) never arms, and if one changes the active talk
// while an arm is pending, the stale arm is dropped rather than fired later.

/** The armed state held by App: the outlinePath of the Talks-panel open awaiting engagement, or null (disarmed). */
export type OutlineSwitchArmed = string | null

/** A Talks-panel open: arm for this talk (null = deselection — cannot arm anything). */
export function armOutlineSwitch(outlinePath: string | null): OutlineSwitchArmed {
  return outlinePath
}

/**
 * The editor engaged (first pointerdown / first user document change). Fires the sidebar switch
 * only when an arm is pending AND the armed talk is still the active one. Any engagement consumes
 * the pending state — a stale arm (active talk moved on via a non-panel route) dies here instead
 * of firing against the wrong talk later.
 */
export function consumeEditorEngagement(
  armed: OutlineSwitchArmed,
  activeOutlinePath: string | null
): { armed: OutlineSwitchArmed; switchToOutline: boolean } {
  if (armed !== null && armed !== '' && armed === activeOutlinePath) {
    return { armed: null, switchToOutline: true }
  }
  return { armed: null, switchToOutline: false }
}

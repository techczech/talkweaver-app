// T29b: pure test of the Talks-panel "open → engage → Slide outline" arming rule.
// The model lives in src/renderer/src/lib/outlineSwitch.ts (no React, no DOM) — the same seam
// App.tsx consumes: arm on a Talks-panel open; consume on editor engagement (first pointerdown /
// first user document change); switch the sidebar to the Slide outline exactly once per opened talk.
//
// Covers: arm → engaged → switch once; engaged again → no switch; a new panel open re-arms
// (same talk included); an unarmed route never switches; a stale arm (armed talk no longer active)
// neither switches nor survives.
import { armOutlineSwitch, consumeEditorEngagement } from '../src/renderer/src/lib/outlineSwitch.ts'

let fail = 0
const check = (condition, message) => {
  if (!condition) {
    console.error('FAIL:', message)
    fail += 1
  }
}
const equal = (actual, expected, message) =>
  check(JSON.stringify(actual) === JSON.stringify(expected), `${message} — got ${JSON.stringify(actual)}`)

const TALK_A = '/vault/folder-a/talk-a/talk-a-outline.md'
const TALK_B = '/vault/folder-b/talk-b/talk-b-outline.md'
const TALK_C = '/vault/folder-c/talk-c/talk-c-outline.md'

// Panel open arms for that talk…
let armed = armOutlineSwitch(TALK_A)
equal(armed, TALK_A, 'a Talks-panel open arms the rule for the opened talk')

// …and the first editor engagement switches the sidebar to the Slide outline, consuming the arm.
let engagement = consumeEditorEngagement(armed, TALK_A)
equal(engagement, { armed: null, switchToOutline: true }, 'arm + engagement in the same talk switches once')

// Clicking/typing further in the same talk (after going back to the Talks tab) never switches again.
engagement = consumeEditorEngagement(engagement.armed, TALK_A)
equal(engagement, { armed: null, switchToOutline: false }, 'engagement without a pending arm does not switch')

// Re-opening from the Talks panel re-arms — a different talk, and the SAME talk again.
engagement = consumeEditorEngagement(armOutlineSwitch(TALK_B), TALK_B)
equal(engagement.switchToOutline, true, 'a new panel open re-arms the rule')
engagement = consumeEditorEngagement(armOutlineSwitch(TALK_A), TALK_A)
equal(engagement.switchToOutline, true, 're-opening the same talk from the panel re-arms too')

// Routes that never arm (launch restore, deep links, History/Studio, ⌘N windows): engagement is inert.
check(armOutlineSwitch(null) === null, 'a non-open selection (null talk) cannot arm the rule')
engagement = consumeEditorEngagement(armOutlineSwitch(null), TALK_C)
equal(engagement, { armed: null, switchToOutline: false }, 'unarmed route: engagement never switches')

// The arm is keyed by the opened talk: if a non-panel route moved the active talk elsewhere before
// engagement, the stale arm must not fire against the wrong talk — and it is dropped, not saved.
armed = armOutlineSwitch(TALK_A)
engagement = consumeEditorEngagement(armed, TALK_C)
equal(engagement, { armed: null, switchToOutline: false }, 'stale arm does not fire for a different active talk')
engagement = consumeEditorEngagement(engagement.armed, TALK_A)
equal(engagement.switchToOutline, false, 'dropped arm cannot fire later even when that talk is active again')

if (fail) process.exit(1)
console.log('PASS: Talks-panel open → editor engagement → one-shot Slide outline switch')

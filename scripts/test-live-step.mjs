// Stepping through the slides during a live talk (compiler/assets/runtime/live-step.js): from the
// speaker's slide, the slide the page has on screen, whether it follows the speaker and whether the talk
// lets people look ahead, what the page shows, whether it is following, and which steps are allowed.
import assert from 'node:assert/strict'
import { liveStepCaption, liveStepRuntimeSource, liveStepTarget, liveStepView } from '../compiler/assets/runtime/live-step.js'

const view = (speaker, viewer, following, lookAhead = true, slideCount = 10) => liveStepView({ speaker, viewer, following, slideCount, lookAhead })
const pick = (v) => [v.shown, v.following, v.canBack, v.canForward]

// Following: the page shows the speaker's slide, whatever it had on screen.
assert.deepEqual(pick(view(4, 2, true)), [4, true, true, true], 'following shows the speaker\'s slide')
assert.deepEqual(pick(view(0, 0, true)), [0, true, false, true], 'on the first slide there is no step back')
assert.deepEqual(pick(view(9, 9, true)), [9, true, true, false], 'on the last slide there is no step forward')

// Stepped back: not following, both ways open, the speaker is ahead.
const back = view(4, 2, false)
assert.deepEqual(pick(back), [2, false, true, true])
assert.equal(back.behind, true)
assert.equal(back.ahead, false)
// Stepped onto the speaker's slide: following again.
assert.deepEqual(pick(view(4, 4, false)), [4, true, true, true], 'the speaker\'s own slide is following')

// Looking ahead (the default): past the speaker is allowed.
const ahead = view(4, 6, false)
assert.deepEqual(pick(ahead), [6, false, true, true])
assert.equal(ahead.ahead, true)
assert.deepEqual(pick(liveStepView({ speaker: 4, viewer: 6, following: false, slideCount: 10 })), [6, false, true, true], 'look-ahead is on when not given')

// Looking ahead off: never past the speaker. Back is open; forward stops at the speaker's slide.
assert.deepEqual(pick(view(4, 2, false, false)), [2, false, true, true], 'behind the speaker: forward is open, up to the speaker')
assert.deepEqual(pick(view(4, 3, false, false)), [3, false, true, true])
assert.deepEqual(pick(view(4, 4, true, false)), [4, true, true, false], 'on the speaker\'s slide: no step forward')
// The speaker went back past a person who was level with them: the page goes back too, and follows.
assert.deepEqual(pick(view(2, 4, false, false)), [2, true, true, false], 'a speaker who goes back takes the person along')
// The same with looking ahead on leaves the person where they are, ahead of the speaker.
assert.deepEqual(pick(view(2, 4, false, true)), [4, false, true, true])

// No speaker slide yet (the live service has not sent one): stay put, no stepping.
assert.deepEqual(pick(view(null, 3, true)), [3, true, false, false])
assert.equal(view(null, 3, true).speaker, null)
assert.deepEqual(pick(view(-1, 0, false)), [0, true, false, false], 'a negative speaker index is no speaker')

// Out-of-range input is clamped to the deck.
assert.deepEqual(pick(view(12, 0, true)), [9, true, true, false], 'a speaker index past the end is the last slide')
assert.deepEqual(pick(view(4, -3, false)), [0, false, false, true])
assert.deepEqual(pick(liveStepView({ speaker: 0, viewer: 0, following: true, slideCount: 1, lookAhead: true })), [0, true, false, false], 'a one-slide talk has no steps')
assert.deepEqual(pick(liveStepView({ speaker: 0, viewer: 0, following: true, slideCount: 0, lookAhead: true })), [0, true, false, false], 'no slides reads as one')

// One step: to the slide before or after; landing on the speaker's slide is following again.
assert.deepEqual(liveStepTarget(view(4, 2, false), 1), { to: 3, follow: false })
assert.deepEqual(liveStepTarget(view(4, 3, false), 1), { to: 4, follow: true }, 'stepping onto the speaker\'s slide follows again')
assert.deepEqual(liveStepTarget(view(4, 4, true), -1), { to: 3, follow: false }, 'a follower steps back from the speaker\'s slide')
assert.deepEqual(liveStepTarget(view(4, 6, false), -1), { to: 5, follow: false })
assert.deepEqual(liveStepTarget(view(4, 5, false), -1), { to: 4, follow: true }, 'coming back from ahead onto the speaker\'s slide follows again')
assert.equal(liveStepTarget(view(0, 0, true), -1), null, 'no step back from the first slide')
assert.equal(liveStepTarget(view(9, 9, true), 1), null, 'no step forward from the last slide')
assert.equal(liveStepTarget(view(4, 4, true, false), 1), null, 'looking ahead off: no step past the speaker')
assert.equal(liveStepTarget(view(null, 3, true), 1), null, 'no speaker slide: no step')
assert.equal(liveStepTarget(null, 1), null)

// The caption under the slide.
assert.equal(liveStepCaption(view(4, 4, true), 10), 'Slide 5 of 10 · moves with the speaker')
assert.equal(liveStepCaption(view(4, 2, false), 10), 'Slide 3 of 10 · the speaker is on slide 5')
assert.equal(liveStepCaption(view(null, 0, true), 10), 'Slide 1 of 10 · moves with the speaker')

// Embedded by .toString(): the source carries all three functions and runs on its own.
const embedded = Function(`${liveStepRuntimeSource()}\nreturn { liveStepView, liveStepTarget, liveStepCaption }`)()
assert.deepEqual(pick(embedded.liveStepView({ speaker: 2, viewer: 4, following: false, slideCount: 10, lookAhead: false })), [2, true, true, false])
assert.deepEqual(embedded.liveStepTarget(embedded.liveStepView({ speaker: 4, viewer: 3, following: false, slideCount: 10, lookAhead: false }), 1), { to: 4, follow: true })

console.log('PASS live step: following, stepping back and ahead, looking ahead off, no speaker slide yet, clamping, one step, caption, embedded source')

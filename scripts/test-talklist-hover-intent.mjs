import {
  cardStep, initialCardState,
  HOVER_OPEN_MS, HOVER_SWITCH_MS
} from '../src/renderer/src/components/talklist/hoverIntent.ts'

// T29: the preview card's hover-intent model, driven with explicit timestamps (fake timers).
let fail = 0
const check = (condition, message) => {
  if (!condition) {
    console.error('FAIL:', message)
    fail += 1
  }
}
const equal = (actual, expected, message) =>
  check(JSON.stringify(actual) === JSON.stringify(expected), `${message} — got ${JSON.stringify(actual)}`)

const T0 = 10_000
let s = initialCardState()

// ── 1. enter → nothing before the pause → hover target after exactly 450ms ──
s = cardStep(s, { type: 'enter', rowKey: 't:a', at: T0 })
check(s.pendingAt === T0 + HOVER_OPEN_MS, 'enter arms the pause at +450ms')
equal(s.target, null, 'nothing shows during the pause')
s = cardStep(s, { type: 'resolve', at: T0 + HOVER_OPEN_MS - 1 })
equal(s.target, null, 'an early resolve shows nothing')
s = cardStep(s, { type: 'resolve', at: T0 + HOVER_OPEN_MS })
equal(s.target, { key: 't:a', source: 'hover' }, 'after the pause the card targets the hovered row (source hover)')

// ── 2. leave before the pause → nothing ever shows ──
s = initialCardState()
s = cardStep(s, { type: 'enter', rowKey: 't:a', at: T0 })
s = cardStep(s, { type: 'leave', rowKey: 't:a', at: T0 + 100 })
equal(s.target, null, 'leave before the pause: no target')
s = cardStep(s, { type: 'resolve', at: T0 + 1_000 })
equal(s.target, null, 'a late resolve after leave shows nothing')
equal(s.pendingAt, null, 'leave cancels the pending pause')

// ── 3. click during the pause → nothing shows; the row stays hidden until leave + re-enter ──
s = initialCardState()
s = cardStep(s, { type: 'enter', rowKey: 't:a', at: T0 })
s = cardStep(s, { type: 'click', rowKey: 't:a', at: T0 + 100 })
equal(s.target, null, 'click during the pause shows nothing')
s = cardStep(s, { type: 'resolve', at: T0 + HOVER_OPEN_MS })
equal(s.target, null, 'the paused hover never resolves after the click')
s = cardStep(s, { type: 'enter', rowKey: 't:a', at: T0 + 200 })
equal(s.pendingAt, null, 're-entering without leaving stays suppressed (no re-arm)')
s = cardStep(s, { type: 'resolve', at: T0 + 1_000 })
equal(s.target, null, 'still nothing for the clicked row while the pointer stayed')
s = cardStep(s, { type: 'leave', rowKey: 't:a', at: T0 + 300 })
s = cardStep(s, { type: 'enter', rowKey: 't:a', at: T0 + 400 })
check(s.pendingAt === T0 + 400 + HOVER_OPEN_MS, 'after leave + re-enter the pause re-arms')
s = cardStep(s, { type: 'resolve', at: T0 + 400 + HOVER_OPEN_MS })
equal(s.target, { key: 't:a', source: 'hover' }, 'the clicked row shows again after leave + re-enter')

// ── 4. keyboard move → target at once with source keys ──
s = initialCardState()
s = cardStep(s, { type: 'keymove', rowKey: 't:a', at: T0 })
equal(s.target, { key: 't:a', source: 'keys' }, 'arrow move shows the card at once (source keys)')
s = cardStep(s, { type: 'keymove', rowKey: 't:b', at: T0 + 50 })
equal(s.target, { key: 't:b', source: 'keys' }, 'the card follows focus row to row')

// ── 5. Enter/⌘O and Escape hide it ──
s = cardStep(s, { type: 'open', at: T0 + 60 })
equal(s.target, null, 'Enter/⌘O (open) hides the card')
s = cardStep(s, { type: 'keymove', rowKey: 't:a', at: T0 + 70 })
s = cardStep(s, { type: 'escape', at: T0 + 80 })
equal(s.target, null, 'Escape hides the card')

// ── 6. enter another row while showing → switches after the short 150ms pause ──
s = initialCardState()
s = cardStep(s, { type: 'enter', rowKey: 't:a', at: T0 })
s = cardStep(s, { type: 'resolve', at: T0 + HOVER_OPEN_MS })
s = cardStep(s, { type: 'enter', rowKey: 't:b', at: T0 + HOVER_OPEN_MS + 10 })
check(s.pendingAt === T0 + HOVER_OPEN_MS + 10 + HOVER_SWITCH_MS, 'a showing card re-arms at +150ms')
s = cardStep(s, { type: 'resolve', at: T0 + HOVER_OPEN_MS + 10 + HOVER_SWITCH_MS - 1 })
equal(s.target, { key: 't:a', source: 'hover' }, 'the old row keeps showing until the switch lands')
s = cardStep(s, { type: 'resolve', at: T0 + HOVER_OPEN_MS + 10 + HOVER_SWITCH_MS })
equal(s.target, { key: 't:b', source: 'hover' }, 'the next row replaces it after 150ms')

// 6b. gliding (leave fires between rows) keeps the short pause too.
s = initialCardState()
s = cardStep(s, { type: 'enter', rowKey: 't:a', at: T0 })
s = cardStep(s, { type: 'resolve', at: T0 + HOVER_OPEN_MS })
s = cardStep(s, { type: 'leave', rowKey: 't:a', at: T0 + HOVER_OPEN_MS + 5 })
equal(s.target, null, 'leaving the row hides the card at once (no delay)')
s = cardStep(s, { type: 'enter', rowKey: 't:b', at: T0 + HOVER_OPEN_MS + 30 })
check(s.pendingAt === T0 + HOVER_OPEN_MS + 30 + HOVER_SWITCH_MS, 'a row-to-row glide keeps the short pause')
s = cardStep(s, { type: 'resolve', at: T0 + HOVER_OPEN_MS + 30 + HOVER_SWITCH_MS })
equal(s.target, { key: 't:b', source: 'hover' }, 'the glided-to row shows after 150ms')

// ── 7. scroll and panel blur dismiss ──
s = cardStep(s, { type: 'scroll', at: T0 + 200 })
equal(s.target, null, 'scrolling the tree dismisses the card')
s = cardStep(s, { type: 'keymove', rowKey: 't:c', at: T0 + 210 })
s = cardStep(s, { type: 'panelblur', at: T0 + 220 })
equal(s.target, null, 'panel blur dismisses the card')

// ── 8. click dismissal of a showing card; keyboard browsing of other rows still works ──
s = initialCardState()
s = cardStep(s, { type: 'keymove', rowKey: 't:a', at: T0 })
s = cardStep(s, { type: 'click', rowKey: 't:b', at: T0 + 10 })
equal(s.target, null, 'a click dismisses the showing card')
s = cardStep(s, { type: 'keymove', rowKey: 't:c', at: T0 + 20 })
equal(s.target, { key: 't:c', source: 'keys' }, 'keyboard browsing another row still shows its card')
s = cardStep(s, { type: 'click', rowKey: 't:c', at: T0 + 30 })
equal(s.target, null, 'clicking the keyboard row dismisses its card')
s = cardStep(s, { type: 'keymove', rowKey: 't:c', at: T0 + 40 })
equal(s.target, null, 'the clicked row stays suppressed for keyboard browsing too')
s = cardStep(s, { type: 'keymove', rowKey: 't:d', at: T0 + 50 })
equal(s.target, { key: 't:d', source: 'keys' }, 'rows untouched by the click keep their keyboard preview')

// 8b. a click that leaves the keyboard preview hidden must not resurrect via a later leave.
s = initialCardState()
s = cardStep(s, { type: 'keymove', rowKey: 't:a', at: T0 })
s = cardStep(s, { type: 'enter', rowKey: 't:a', at: T0 + 10 })
s = cardStep(s, { type: 'resolve', at: T0 + 10 + HOVER_OPEN_MS })
s = cardStep(s, { type: 'click', rowKey: 't:a', at: T0 + 1_000 })
s = cardStep(s, { type: 'leave', rowKey: 't:a', at: T0 + 1_100 })
equal(s.target, null, 'after clicking the row away, its leave does not re-show it')
s = cardStep(s, { type: 'resolve', at: T0 + 2_000 })
equal(s.target, null, 'and no stray resolve brings it back')

// ── 9. stale leave (different row) is ignored ──
s = initialCardState()
s = cardStep(s, { type: 'enter', rowKey: 't:a', at: T0 })
s = cardStep(s, { type: 'leave', rowKey: 't:b', at: T0 + 10 })
check(s.pendingAt === T0 + HOVER_OPEN_MS, 'a leave for another row does not cancel the pause')

if (fail) process.exit(1)
console.log('PASS: talk preview card hover-intent model')

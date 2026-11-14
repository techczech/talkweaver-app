// The before/after comparison of the talks audit (scripts/lib/audit-compare.mjs) on neutral records: a fault that
// grows on a state that already had it, a new or added reveal step, a changed step count, a card Next never shows.
import { strict as assert } from 'node:assert'
import { compareTalk, gateOf, matchStates, CONTRAST_TOLERANCE } from './lib/audit-compare.mjs'
import { knownClipProblems } from './lib/ocean-clip-walk.mjs'

const st = (id, step, extra = {}) => ({ at: `${id}#${step}`, id, step, layout: 'content', clips: [], contrast: [], unresolved: [], floor: [], emptyBand: 0, overlaps: [], autoIcons: 0, visual: `v${step}`, ...extra })
const run = (key, text, more) => ({ key, text, ...more })
const side = (states, neverShown = []) => ({ states, coverage: { complete: true, issues: [], neverShown } })

// 1. one element clipped before, five after: worsened, not hidden behind "already failing"
{
  const before = side([st('s', 0, { clips: ['li|Neutral one'] })])
  const after = side([st('s', 0, { clips: ['li|Neutral one', 'li|Neutral two', 'li|Neutral three', 'li|Neutral four', 'li|Neutral five'] })])
  const r = compareTalk(before, after)
  assert.equal(r.counts.clipping.worsened, 1, 'more clipped elements on an already clipped state is worsened')
  assert.equal(r.counts.clipping.newly, 0)
  assert.equal(gateOf(r), 1, 'and counts toward the gate')
  assert.match(r.cases[0].why.join(' '), /new clip li\|Neutral two/)
}
// 2. contrast from 4.3:1 to 1.2:1 on the same run: worsened; within the tolerance: unchanged
{
  const before = side([st('s', 0, { contrast: [run('P|0|0|Neutral words', 'Neutral words', { ratio: 4.3 })] })])
  const worse = compareTalk(before, side([st('s', 0, { contrast: [run('P|0|0|Neutral words', 'Neutral words', { ratio: 1.2 })] })]))
  assert.equal(worse.counts.contrast.worsened, 1, '4.3:1 to 1.2:1 is worsened')
  const same = compareTalk(before, side([st('s', 0, { contrast: [run('P|0|0|Neutral words', 'Neutral words', { ratio: 4.3 - CONTRAST_TOLERANCE / 2 })] })]))
  assert.equal(same.counts.contrast.unchanged, 1, 'a change inside the tolerance is unchanged')
  // the run's index moved (markup changed) but its tag and text did not: the same run
  const moved = compareTalk(before, side([st('s', 0, { contrast: [run('P|3|0|Neutral words', 'Neutral words', { ratio: 4.3 })] })]))
  assert.equal(moved.counts.contrast.unchanged, 1, 'a run is recognised by tag and text when its index moved')
}
// 3. type from 29px to 14px: worsened; a new run under the floor: worsened
{
  const before = side([st('s', 0, { floor: [run('LI|0|0|Neutral point', 'Neutral point', { px: 29 })] })])
  const smaller = compareTalk(before, side([st('s', 0, { floor: [run('LI|0|0|Neutral point', 'Neutral point', { px: 14 })] })]))
  assert.equal(smaller.counts.floor.worsened, 1, '29px to 14px is worsened')
  const added = compareTalk(before, side([st('s', 0, { floor: [run('LI|0|0|Neutral point', 'Neutral point', { px: 29 }), run('LI|1|0|Neutral other', 'Neutral other', { px: 28 })] })]))
  assert.equal(added.counts.floor.worsened, 1, 'a second run under the floor is worsened')
}
// 4. newly failing and improved
{
  const r = compareTalk(side([st('s', 0), st('t', 0, { unresolved: [run('P|0|0|x', 'x')] })]), side([st('s', 0, { unresolved: [run('P|0|0|y', 'y')] }), st('t', 0)]))
  assert.equal(r.counts.unresolved.newly, 1)
  assert.equal(r.counts.unresolved.improved, 1)
  assert.equal(gateOf(r), 1, 'improved states do not count toward the gate')
}
// 5. a new slide and an added reveal step: unmatched, counted toward the gate when they fail
{
  const before = side([st('s', 0), st('s', 1)])
  const after = side([st('s', 0), st('s', 1), st('s', 2, { clips: ['p|Neutral'] }), st('new', 0, { floor: [run('P|0|0|n', 'n', { px: 10 })] }), st('new', 1)])
  const r = compareTalk(before, after)
  assert.equal(r.counts.clipping.unmatched, 1, 'an added step that clips is unmatched')
  assert.equal(r.counts.floor.unmatched, 1, 'a new slide under the floor is unmatched')
  assert.equal(r.unmatchedStates, 3, 'every after state without a before is listed')
  assert.equal(r.cleanUnmatched, 1)
  assert.equal(gateOf(r), 2)
  assert.deepEqual(r.stepCountChanged, ['s'], 'a slide whose step count changed is flagged')
}
// 6. a step count change: later steps are compared with the state that looks the same, not the same number
{
  const before = side([st('s', 0, { visual: 'a' }), st('s', 1, { visual: 'b' }), st('s', 2, { visual: 'c', clips: ['p|Neutral'] })])
  const after = side([st('s', 0, { visual: 'a' }), st('s', 1, { visual: 'c', clips: ['p|Neutral'] })])
  const { pairs, gone } = matchStates(before.states, after.states)
  assert.equal(pairs[1].before.at, 's#2', 'after s#1 is paired with before s#2, which shows the same')
  assert.equal(gone.length, 1)
  assert.equal(compareTalk(before, after).counts.clipping.unchanged, 1, 'so the old clip is not reported as new')
}
// 7. a card Next never shows: its own class, compared before and after; a card shown directly is measured
{
  const card = { id: 'c', card: 2, cards: 3 }
  const direct = st('c', 0, { at: 'c@card2#0', direct: true, visual: 'card2', clips: ['p|Neutral card'] })
  const newly = compareTalk(side([st('c', 0), st('c', 1, { visual: 'card1' }), st('c', 2, { visual: 'card2', clips: ['p|Neutral card'] })]), side([st('c', 0), st('c', 1, { visual: 'card1' }), direct], [card]))
  assert.equal(newly.skippedCards.newly, 1, 'a card skipped now and shown before is newly failing')
  assert.equal(newly.directCounts.clipping.unchanged, 1, 'the directly shown card is compared with the before state showing it, as a diagnostic')
  assert.equal(gateOf(newly), 1, 'gated once, as a newly unreachable card')
  const same = compareTalk(side([st('c', 0), direct], [card]), side([st('c', 0), direct], [card]))
  assert.equal(same.skippedCards.unchanged, 1)
  assert.equal(gateOf(same), 0)
  const fixed = compareTalk(side([st('c', 0)], [card]), side([st('c', 0)]))
  assert.equal(fixed.skippedCards.improved, 1)
}
// 7b. a slide the before side's Next skipped (shown directly there) and the after side reaches: compared, not unmatched
{
  const before = side([st('a', 0), st('s', 0, { at: 's@slide#0', direct: true, visual: 'v0', clips: ['p|Neutral'] })], [{ id: 's', card: null, cards: 0 }])
  const after = side([st('a', 0), st('s', 0, { visual: 'v0', clips: ['p|Neutral'] })])
  const r = compareTalk(before, after)
  assert.equal(r.counts.clipping.unchanged, 1, 'the after state is compared with the directly measured before state')
  assert.equal(r.unmatchedStates, 0)
  assert.equal(r.skippedCards.improved, 1, 'and the slide Next skipped before counts as improved')
}
// 7c. a diagram's generated id changes between builds: the same clipped element, not a new one
{
  const r = compareTalk(side([st('m', 0, { clips: ['div|Neutral #mmd-abc123{font-family:neutral sa'] })]), side([st('m', 0, { clips: ['div|Neutral #mmd-x9y8z7q{font-family:neutral s'] })]))
  assert.equal(r.counts.clipping.unchanged, 1)
}
// 9. P1: container-return states that look alike apart from the container: a new faulty state is not hidden by pairing
{
  const ct = (step, container, extra = {}) => st('k', step, { visual: 'same', ident: { units: [], emphasis: [], media: [], cards: [], image: null, container }, ...extra })
  const before = side([ct(0, ['grid', 'div|A=now'], { clips: ['p|Neutral'] }), ct(1, ['grid', 'div|B=now'])])
  const after = side([ct(0, ['grid', 'div|X=now'], { clips: ['p|Neutral'] }), ct(1, ['grid', 'div|A=now']), ct(2, ['grid', 'div|B=now'])])
  const r = compareTalk(before, after)
  assert.equal(r.counts.clipping.unmatched, 1, 'the inserted container state is unmatched')
  assert.equal(r.counts.clipping.improved, 1, 'A is paired with A')
  assert.equal(gateOf(r), 1, 'the new faulty state is gated')
  // the same states with no container identity at all: ambiguous, so unmatched and gated, never paired with A
  const plain = (step, extra = {}) => st('k', step, { visual: 'same', ...extra })
  const blind = compareTalk(side([plain(0, { clips: ['p|Neutral'] }), plain(1)]), side([plain(0, { clips: ['p|Neutral'] }), plain(1), plain(2)]))
  assert.equal(gateOf(blind), 1, 'an ambiguous identity stays unmatched instead of inheriting a failing baseline')
}
// 10. P1: existing text made a separate reveal unit: the other states keep their identity, the final clip is unchanged
{
  const rv = (step, units, extra = {}) => st('r', step, { visual: JSON.stringify(units), ident: { units, emphasis: [], media: [], cards: [], image: null, container: null }, ...extra })
  const before = side([
    rv(0, [['li|Neutral A', 'hidden'], ['li|Neutral B', 'hidden']]),
    rv(1, [['li|Neutral A', 'current'], ['li|Neutral B', 'hidden']]),
    rv(2, [['li|Neutral A', 'full'], ['li|Neutral B', 'full']], { clips: ['ul|Neutral'] }),
  ])
  const after = side([
    rv(0, [['p|Neutral lead', 'hidden'], ['li|Neutral A', 'hidden'], ['li|Neutral B', 'hidden']]),
    rv(1, [['p|Neutral lead', 'current'], ['li|Neutral A', 'hidden'], ['li|Neutral B', 'hidden']]),
    rv(2, [['p|Neutral lead', 'full'], ['li|Neutral A', 'current'], ['li|Neutral B', 'hidden']]),
    rv(3, [['p|Neutral lead', 'full'], ['li|Neutral A', 'full'], ['li|Neutral B', 'full']], { clips: ['ul|Neutral'] }),
  ])
  const r = compareTalk(before, after)
  assert.equal(r.counts.clipping.unchanged, 1, 'the final state is paired with the final state')
  assert.equal(r.counts.clipping.unmatched, 0)
  assert.equal(gateOf(r), 0)
  assert.equal(r.unmatchedStates, 2, 'the two states that both look like "nothing shown yet" are ambiguous and unmatched')
}
// 11. P3: a card unreachable on both sides is gated only as a card; its direct measurement is a diagnostic
{
  const card = { id: 'c', card: 1, cards: 2 }
  const direct = (ratio) => st('c', 0, { at: 'c@card1#0', direct: true, visual: 'card1', contrast: [run('P|0|0|Neutral', 'Neutral', { ratio })] })
  const r = compareTalk(side([st('c', 0), direct(2.6)], [card]), side([st('c', 0), direct(1.2)], [card]))
  assert.equal(gateOf(r), 0, 'a contrast change on a card Next cannot reach does not enter the ordinary gate')
  assert.equal(r.directCounts.contrast.worsened, 1, 'it stays in the diagnostics')
  // the carousel fix: the card becomes reachable; the before side's direct measurement is its baseline
  const reachable = (extra) => side([st('c', 0), st('c', 1, { visual: 'card1', ...extra })])
  const fixed = compareTalk(side([st('c', 0), direct(2.6)], [card]), reachable({ contrast: [run('P|0|0|Neutral', 'Neutral', { ratio: 2.6 })] }))
  assert.equal(gateOf(fixed), 0, 'a card made reachable with the same fault does not gate')
  assert.equal(fixed.skippedCards.improved, 1)
  const broke = compareTalk(side([st('c', 0), st('c', 0, { at: 'c@card1#0', direct: true, visual: 'card1' })], [card]), reachable({ clips: ['p|Neutral'] }))
  assert.equal(broke.counts.clipping.newly, 1, 'a card made reachable with a new fault is newly failing')
  assert.equal(gateOf(broke), 1)
}
// 8. empty band growth and unnamed icons
{
  const r = compareTalk(side([st('s', 0, { emptyBand: 0.4, autoIcons: 1 })]), side([st('s', 0, { emptyBand: 0.6, autoIcons: 3 })]))
  assert.equal(r.counts.empty.worsened, 1)
  assert.equal(r.counts.autoIcons.worsened, 1)
}
// 12. P2: known clipping failures are a multiset: one listed occurrence waives one clipped element, no more
{
  const known = [{ outline: 'o', look: 'ocean', state: 'c#1', key: 'div|Neutral card', count: 1, reason: 'neutral' }]
  assert.deepEqual(knownClipProblems({ 'c#1': ['div|Neutral card'] }, { 'c#1': [] }, known, 'o', 'ocean'), [], 'the listed occurrence is waived')
  const twice = knownClipProblems({ 'c#1': ['div|Neutral card', 'div|Neutral card'] }, { 'c#1': [] }, known, 'o', 'ocean')
  assert.ok(twice.some((line) => line.includes('clips 2 times, 1 listed')), 'a second element with the same key fails')
  assert.ok(twice.some((line) => line.startsWith('newly clipped')), 'and is not waived')
  assert.ok(knownClipProblems({ 'c#1': [] }, { 'c#1': [] }, known, 'o', 'ocean').some((line) => line.includes('clips 0 of 1')), 'a listed case that stops clipping fails')
  assert.deepEqual(knownClipProblems({ 'c#1': ['div|Neutral card', 'div|Neutral card'] }, { 'c#1': [] }, [{ ...known[0], count: 2 }], 'o', 'ocean'), [], 'an explicit count of two permits two')
  assert.ok(knownClipProblems({ 'c#1': ['div|Other'] }, { 'c#1': [] }, known, 'o', 'ocean').some((line) => line.includes('div|Other')), 'an unlisted clip fails')
}
console.log('PASS audit comparison: worsened runs and elements, unmatched states, identity pairing (ambiguous stays unmatched), direct states outside the gate, known clips as a multiset')

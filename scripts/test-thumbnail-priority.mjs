// Thumbnail capture order and supersede (src/main/thumbnail-plan.ts, src/main/thumbnail-queue.ts):
// on-screen slides first, then deck order; a newer request for the same talk and window replaces the
// rest of the older run without throwing away the capture under way; other talks are untouched.
import assert from 'node:assert/strict'
import { cleanThumbnailFocus, createCapturePlan } from '../src/main/thumbnail-plan.ts'
import { createThumbnailQueue } from '../src/main/thumbnail-queue.ts'
import { createFocusReporter, thumbnailFocusOrder } from '../src/renderer/src/lib/thumbnailFocus.ts'

const items = (...indices) => indices.map(index => ({ index, key: `k${index}` }))
const drain = plan => { const out = []; for (let i = plan.next(); i; i = plan.next()) out.push(i.index); return out }

{
  assert.deepEqual(drain(createCapturePlan(items(0, 1, 2, 3, 4))), [0, 1, 2, 3, 4], 'no focus: deck order')
  assert.deepEqual(drain(createCapturePlan(items(3, 1, 4, 0, 2))), [0, 1, 2, 3, 4], 'deck order whatever the input order')
  assert.deepEqual(drain(createCapturePlan(items(0, 1, 2, 3, 4, 5, 6), () => [5, 3, 4])), [5, 3, 4, 0, 1, 2, 6],
    'active slide, then the visible range, then the rest in deck order')
  assert.deepEqual(drain(createCapturePlan(items(0, 2, 4), () => [9, 2, 3])), [2, 0, 4], 'focus on cached or absent slides is skipped')
  assert.deepEqual(drain(createCapturePlan(items(0, 1, 2), () => { throw Error('x') })), [0, 1, 2], 'a failing focus falls back to deck order')
  console.log('PASS thumbnail plan: visible first, then deck order')
}
{
  // The author scrolls mid-run: only what is not yet captured is reordered; nothing is offered twice.
  let focus = [2]
  const plan = createCapturePlan(items(0, 1, 2, 3, 4, 5, 6, 7), () => focus)
  const taken = [plan.next().index, plan.next().index]
  assert.deepEqual(taken, [2, 0])
  focus = [6, 2, 0, 7]
  for (let i = plan.next(); i; i = plan.next()) taken.push(i.index)
  assert.deepEqual(taken, [2, 0, 6, 7, 1, 3, 4, 5], 'a focus change reorders only uncaptured slides')
  assert.equal(plan.remaining(), 0)
  assert.equal(new Set(taken).size, taken.length, 'every slide captured once')
  console.log('PASS thumbnail plan: visibility change mid-run reorders only uncaptured slides')
}
{
  assert.deepEqual(cleanThumbnailFocus([3, 3, -1, 2.5, '4', 7, null]), [3, 7], 'only whole, non-negative indices, once each')
  assert.deepEqual(cleanThumbnailFocus('nope'), [])
  assert.equal(cleanThumbnailFocus(Array.from({ length: 1000 }, (_, i) => i)).length, 200, 'bounded')
  assert.deepEqual(cleanThumbnailFocus(Array.from({ length: 1001 }, () => 0)), [], 'an oversized message is refused outright')
  assert.deepEqual(cleanThumbnailFocus([...Array.from({ length: 200 }, () => 0), 5]), [0], 'only the first 200 entries are inspected, however padded')
  assert.deepEqual(thumbnailFocusOrder(4, [2, 3, 4, 5, 9], 6), [4, 2, 3, 5], 'active first, no repeat, inside the deck')
  assert.deepEqual(thumbnailFocusOrder(-1, [0, 1], 6), [0, 1])
  console.log('PASS thumbnail focus: cleaned and ordered')
}

// A queue whose render captures like thumbnails.ts does: the plan picks each slide; supersede and
// cancel are checked BETWEEN slides; a capture, once started, is only lost to a hard cancel.
function harness() {
  const cache = new Map() // talk -> Set of captured slide indices
  const gates = []        // one per capture in progress
  const log = []
  const queue = createThumbnailQueue(async ({ talk, run, slides }, signal, superseded) => {
    const done = cache.get(talk) ?? new Set()
    cache.set(talk, done)
    const result = {}
    const plan = createCapturePlan(slides.filter(index => !done.has(index)).map(index => ({ index })))
    for (let item = plan.next(); item; item = plan.next()) {
      if (signal.aborted || superseded.aborted) break
      log.push(`${run}:start:${item.index}`)
      await new Promise(resolve => gates.push(resolve))
      if (signal.aborted) break // a hard cancel drops the capture, as thumbnails.ts does
      done.add(item.index)
      result[item.index] = run
      log.push(`${run}:cached:${item.index}`)
    }
    return result
  })
  const step = async () => { await new Promise(resolve => setImmediate(resolve)); gates.shift()?.(); await new Promise(resolve => setImmediate(resolve)) }
  return { queue, cache, log, step, gates }
}

{
  const { queue, cache, log, step } = harness()
  const old = queue({ talk: 'x', run: 'old', slides: [0, 1, 2, 3] }, 'editor:1@x')
  const other = queue({ talk: 'y', run: 'other', slides: [0, 1] }, 'editor:1@y')
  await new Promise(resolve => setImmediate(resolve))
  await step() // old captures 0, starts 1
  assert.deepEqual(log, ['old:start:0', 'old:cached:0', 'old:start:1'])
  queue.supersede('editor:1@x')
  const newer = queue({ talk: 'x', run: 'new', slides: [0, 1, 2, 3] }, 'editor:1@x')
  await step() // old's capture of 1 completes, then old stops
  assert.ok(log.includes('old:cached:1'), 'the capture in progress is not cancelled: it completes and is cached')
  assert.ok(!log.includes('old:start:2'), 'the superseded remainder is dropped')
  assert.deepEqual(await old, {}, 'the superseded caller settles with nothing')
  for (let i = 0; i < 6; i++) await step()
  assert.deepEqual(await newer, { 2: 'new', 3: 'new' }, 'the newer request captures only what is not cached yet')
  assert.deepEqual(await other, { 0: 'other', 1: 'other' }, 'another talk in the same window is untouched')
  assert.deepEqual([...cache.get('x')].sort(), [0, 1, 2, 3])
  console.log('PASS thumbnail supersede: in-flight capture kept, remainder dropped, other talks untouched')
}
{
  // Same-key enqueue alone supersedes (no explicit call), and cancel still stops at once.
  const { queue, log, step } = harness()
  const first = queue({ talk: 'x', run: 'a', slides: [0, 1, 2] }, 'editor:2@x')
  await new Promise(resolve => setImmediate(resolve))
  const second = queue({ talk: 'x', run: 'b', slides: [0, 1, 2] }, 'editor:2@x')
  await step()
  assert.deepEqual(await first, {})
  assert.ok(log.includes('a:cached:0') && !log.includes('a:start:1'), 'enqueue under the same key supersedes softly')
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(log.includes('b:start:1'))
  queue.cancelPrefix('editor:2@')
  await step()
  assert.deepEqual(await second, {}, 'a closed window cancels its talks')
  assert.ok(!log.includes('b:cached:1'), 'a hard cancel does not cache the capture it interrupted')
  const third = queue({ talk: 'z', run: 'c', slides: [0] }, 'editor:22@z')
  await new Promise(resolve => setImmediate(resolve))
  queue.cancelPrefix('editor:2@')
  await step()
  assert.deepEqual(await third, { 0: 'c' }, 'a cancel prefix matches no other window (2@ vs 22@)')
  console.log('PASS thumbnail supersede: same-key requests supersede, cancel stays immediate and window-scoped')
}
{
  const sent = []
  const reporter = createFocusReporter((path, focus) => sent.push(`${path}:${focus.join(',')}`), 40)
  reporter.report('t', [1, 2])
  reporter.report('t', [1, 2, 3])
  reporter.report('t', [4, 5])
  assert.deepEqual(sent, ['t:1,2'], 'leading edge at once, then throttled')
  await new Promise(resolve => setTimeout(resolve, 70))
  assert.deepEqual(sent, ['t:1,2', 't:4,5'], 'the last change is always sent')
  await new Promise(resolve => setTimeout(resolve, 50))
  reporter.report('t', [4, 5])
  assert.equal(sent.length, 2, 'an unchanged focus is not re-sent')
  reporter.dispose()
  console.log('PASS thumbnail focus reporter: throttled, trailing edge, no repeats')
}

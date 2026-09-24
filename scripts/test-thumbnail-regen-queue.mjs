#!/usr/bin/env node
/**
 * "An empty result is 'not now', never 'never'."
 *
 * 0.31.0-preview.8 passed the crash check and then showed the schematic fallback for EVERY card
 * of a talk — text slides included — while 87 PNGs sat on disk under matching keys. The main
 * process had started returning an empty map whenever the heap was high (the editor lane was
 * holding the heaviest deck inlined, a 3.2GB spike), and the Browser counted each empty map as
 * one of a talk's TWO attempts. A whole vault burned both attempts in seconds and nothing looked
 * again until the app was relaunched.
 *
 * These pin the rule that replaces it: a deferral costs no attempt and has no cap; only a talk
 * whose outline cannot be READ is given up on; a fresh opening of the Browser forgets everything.
 */
import { strict as assert } from 'node:assert'
import {
  createThumbRegenQueue,
  THUMB_DEFER_DELAY_MS,
  THUMB_READ_ATTEMPTS_MAX
} from '../src/renderer/src/lib/thumbnailRegenQueue.ts'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}\n     ${error?.message ?? error}`) }
}
const path = (slug) => `/vault/${slug}/${slug}-outline.md`

check('the documented constants', () => {
  assert.equal(THUMB_DEFER_DELAY_MS, 30_000, 'a deferred talk comes back after 30 seconds')
  assert.equal(THUMB_READ_ATTEMPTS_MAX, 2, 'the two-attempt cap survives, for read faults only')
})

check('a rendered talk is done and remounts its cards', () => {
  const q = createThumbRegenQueue()
  assert.equal(q.note('a', path('a')), true)
  assert.deepEqual(q.next(0), { kind: 'run', slug: 'a', outlinePath: path('a') })
  const settled = q.settle('a', { rendered: 42 }, 0)
  assert.deepEqual(settled, { bumpNonce: true, deferredMs: null, abandoned: false })
  assert.deepEqual(q.next(0), { kind: 'idle' }, 'a finished talk leaves the queue')
  assert.equal(q.note('a', path('a')), false, 'and is not asked for again this opening')
})

check('an empty result defers the talk: no attempt consumed, no cap, no remount', () => {
  const q = createThumbRegenQueue()
  q.note('a', path('a'))
  // Twenty deferrals in a row — well past any attempt cap that could ever have applied.
  let now = 0
  for (let pass = 1; pass <= 20; pass++) {
    const step = q.next(now)
    assert.deepEqual(step, { kind: 'run', slug: 'a', outlinePath: path('a') }, `pass ${pass} must run`)
    const settled = q.settle('a', { rendered: 0 }, now)
    assert.deepEqual(
      settled,
      { bumpNonce: false, deferredMs: THUMB_DEFER_DELAY_MS, abandoned: false },
      `pass ${pass}: a deferral never remounts and never gives up`
    )
    // It is NOT ready yet …
    assert.deepEqual(q.next(now + 1), { kind: 'wait', ms: THUMB_DEFER_DELAY_MS - 1 }, 'still deferred')
    assert.deepEqual(
      q.next(now + THUMB_DEFER_DELAY_MS - 1),
      { kind: 'wait', ms: 1 },
      'and one millisecond before its time it is still deferred'
    )
    now += THUMB_DEFER_DELAY_MS
  }
  assert.equal(q.stats().abandoned, 0, 'twenty deferrals abandon nothing')
  // … and when it finally renders, it settles like any other.
  q.next(now)
  assert.equal(q.settle('a', { rendered: 7 }, now).bumpNonce, true)
})

check('a read fault is capped at two attempts', () => {
  const q = createThumbRegenQueue()
  q.note('a', path('a'))
  q.next(0)
  const firstFault = q.settle('a', { rendered: null }, 0)
  assert.deepEqual(firstFault, { bumpNonce: false, deferredMs: null, abandoned: false })
  assert.deepEqual(q.next(0), { kind: 'idle' }, 'a fault does not re-queue itself')
  assert.equal(q.note('a', path('a')), true, 'the next 404 from its card offers it once more')
  q.next(0)
  const secondFault = q.settle('a', { rendered: null }, 0)
  assert.equal(secondFault.abandoned, true, 'the second read fault gives up on the talk')
  assert.equal(q.note('a', path('a')), false, 'and it is never offered again this opening')
  assert.equal(q.stats().abandoned, 1)
})

check('a deferral does not spend the fault budget', () => {
  const q = createThumbRegenQueue()
  q.note('a', path('a'))
  let now = 0
  // Fault, then a deferral, then a fault: the deferral in the middle must not push it over.
  q.next(now); q.settle('a', { rendered: null }, now)
  q.note('a', path('a'))
  q.next(now); q.settle('a', { rendered: 0 }, now)
  now += THUMB_DEFER_DELAY_MS
  q.next(now)
  assert.equal(q.settle('a', { rendered: null }, now).abandoned, true, 'two faults is two faults')
  // A rendered pass clears the fault history: the talk proved it can be read.
  const fresh = createThumbRegenQueue()
  fresh.note('b', path('b'))
  fresh.next(0); fresh.settle('b', { rendered: null }, 0)
  fresh.note('b', path('b'))
  fresh.next(0); fresh.settle('b', { rendered: 3 }, 0)
  fresh.reset()
  fresh.note('b', path('b'))
  fresh.next(0)
  assert.equal(fresh.settle('b', { rendered: null }, 0).abandoned, false, 'the fault count was cleared')
})

check('one talk at a time, and one entry per talk', () => {
  const q = createThumbRegenQueue()
  q.note('a', path('a'))
  q.note('b', path('b'))
  assert.equal(q.note('a', path('a')), false, 'a card that 404s twice queues its talk once')
  const running = q.next(0)
  assert.equal(running.slug, 'a', 'insertion order: the first card to 404 is rendered first')
  assert.equal(q.note('a', path('a')), false, 'the running talk cannot be queued beside itself')
  assert.deepEqual(q.next(0), { kind: 'wait', ms: 0 }, 'nothing else starts while one is running')
  q.settle('a', { rendered: 1 }, 0)
  assert.equal(q.next(0).slug, 'b', 'then the next talk runs')
})

check('a deferred talk does not block a ready one', () => {
  const q = createThumbRegenQueue()
  q.note('a', path('a'))
  q.next(0)
  q.settle('a', { rendered: 0 }, 0)
  q.note('b', path('b'))
  assert.equal(q.next(1).slug, 'b', 'the queue skips past the deferred talk to a ready one')
  q.settle('b', { rendered: 5 }, 1)
  assert.deepEqual(q.next(2), { kind: 'wait', ms: THUMB_DEFER_DELAY_MS - 2 }, 'and then waits for the deferred one')
  assert.equal(q.next(THUMB_DEFER_DELAY_MS).slug, 'a', 'which runs when its time comes')
})

check('reopening the Browser looks at every talk again', () => {
  const q = createThumbRegenQueue()
  q.note('rendered', path('rendered'))
  q.next(0); q.settle('rendered', { rendered: 9 }, 0)
  q.note('broken', path('broken'))
  q.next(0); q.settle('broken', { rendered: null }, 0)
  q.note('broken', path('broken'))
  q.next(0); q.settle('broken', { rendered: null }, 0)
  q.note('deferred', path('deferred'))
  q.next(0); q.settle('deferred', { rendered: 0 }, 0)
  assert.deepEqual(q.stats(), { queued: 1, running: null, done: 1, abandoned: 1 })
  q.reset()
  assert.deepEqual(q.stats(), { queued: 0, running: null, done: 0, abandoned: 0 }, 'a fresh opening forgets everything')
  // Including the talk the editor lane may have rendered in the meantime.
  for (const slug of ['rendered', 'broken', 'deferred']) {
    assert.equal(q.note(slug, path(slug)), true, `${slug} is offered again after a reset`)
  }
  assert.equal(q.next(0).slug, 'rendered', 'and runs immediately — no deferral survives the reset')
})

check('a talk with no outline path is never queued', () => {
  const q = createThumbRegenQueue()
  assert.equal(q.note('a', ''), false)
  assert.equal(q.note('', path('a')), false)
  assert.deepEqual(q.next(0), { kind: 'idle' })
})

if (failures) {
  console.error(`\n${failures} thumbnail-regen-queue check(s) failed`)
  process.exit(1)
}
console.log('\nthumbnail regen queue: all checks passed')

#!/usr/bin/env node
/**
 * "One full-deck preparation in flight at a time in the main process."
 *
 * The thumbnail render QUEUE serialises renders, not preparation: on 2026-09-15 the Slide
 * Browser's background sweep could be inlining one deck's media while the editor lane inlined
 * another, putting two multi-hundred-megabyte HTML strings in the main-process heap at once.
 * This gate is T11's "one deck in memory" law applied to prepareTalk's compiler call.
 *
 * What it must guarantee: strict ordering (no overlap), every caller gets its OWN value, and a
 * task that throws releases the gate rather than wedging every deck behind it.
 */
import { strict as assert } from 'node:assert'
import { createSingleFlight } from '../src/main/single-flight.ts'

const log = []
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── 1. Two overlapping loads run strictly one after the other ────────────────────────────────
{
  const gate = createSingleFlight()
  const task = (name, ms, value) => gate(async () => {
    log.push(`start ${name}`)
    await wait(ms)
    log.push(`end ${name}`)
    return value
  })
  // Deliberately started together, and the FIRST one is the slow one: without a gate the second
  // would start immediately and its "start" would land between the first pair.
  const first = task('heavy', 20, 'heavy-model')
  const second = task('light', 1, 'light-model')
  assert.deepEqual(await Promise.all([first, second]), ['heavy-model', 'light-model'],
    'each caller gets its own value back, not the other one\'s')
  assert.deepEqual(log, ['start heavy', 'end heavy', 'start light', 'end light'],
    `the second preparation must not start before the first has ended, got ${log.join(' | ')}`)
}

// ── 2. Nothing is dropped, however many queue up, and order is preserved ──────────────────────
{
  const gate = createSingleFlight()
  let live = 0
  let peak = 0
  const order = []
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => gate(async () => {
      live += 1
      peak = Math.max(peak, live)
      await wait(i % 2 ? 1 : 3)
      order.push(i)
      live -= 1
      return i * 2
    }))
  )
  assert.equal(peak, 1, `at most one deck may be prepared at a time, peaked at ${peak}`)
  assert.deepEqual(results, [0, 2, 4, 6, 8, 10, 12, 14], 'every queued request resolves with its own value')
  assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7], 'and they run in the order they were queued')
}

// ── 3. A failing task releases the gate ──────────────────────────────────────────────────────
{
  const gate = createSingleFlight()
  const ran = []
  const bad = gate(async () => { ran.push('bad'); await wait(2); throw new Error('compiler exploded') })
  const good = gate(async () => { ran.push('good'); return 'still works' })
  await assert.rejects(bad, /compiler exploded/, 'the caller keeps the real error')
  assert.equal(await good, 'still works', 'one bad deck must not wedge every deck behind it')
  assert.deepEqual(ran, ['bad', 'good'], 'the next task still waited its turn')
  // A synchronous throw inside the task is the same case.
  await assert.rejects(gate(() => { throw new Error('sync boom') }), /sync boom/)
  assert.equal(await gate(async () => 'after sync throw'), 'after sync throw')
}

// ── 4. The gate is per instance, and reports what is waiting ─────────────────────────────────
{
  const a = createSingleFlight()
  const b = createSingleFlight()
  let releaseA
  const blocked = a(() => new Promise((resolve) => { releaseA = resolve }))
  const queued = a(async () => 'queued behind')
  assert.equal(a.waiting(), 2, 'both the running and the queued task are reported')
  assert.equal(b.waiting(), 0, 'a separate gate is unaffected')
  assert.equal(await b(async () => 'independent'), 'independent', 'and is not blocked by the other gate')
  releaseA('released')
  assert.equal(await blocked, 'released')
  assert.equal(await queued, 'queued behind')
  assert.equal(a.waiting(), 0, 'the count returns to zero once everything has settled')
}

console.log('PASS single flight: strict ordering, own values, failure releases the gate')

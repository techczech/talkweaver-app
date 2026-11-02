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

// ── 5. Background tasks (the share-for-comments build) never start ahead of a waiting ordinary
//       task (the editor strip), still run one at a time, and keep their own order ─────────────
{
  const gate = createSingleFlight()
  const order = []
  let live = 0
  let peak = 0
  const job = (name, ms = 3) => async () => { live += 1; peak = Math.max(peak, live); order.push(name); await wait(ms); live -= 1; return name }
  const first = gate(job('strip-1', 10))
  const bgA = gate.background(job('share-a'))
  const bgB = gate.background(job('share-b'))
  const second = gate(job('strip-2'))
  const third = gate(job('strip-3'))
  assert.deepEqual(await Promise.all([first, bgA, bgB, second, third]), ['strip-1', 'share-a', 'share-b', 'strip-2', 'strip-3'])
  assert.deepEqual(order, ['strip-1', 'strip-2', 'strip-3', 'share-a', 'share-b'], 'ordinary tasks queued later still run before background ones')
  assert.equal(peak, 1, 'background tasks share the one-deck-in-memory gate')
  await assert.rejects(gate.background(async () => { throw new Error('share build failed') }), /share build failed/)
  assert.equal(await gate(async () => 'after'), 'after', 'a failing background task releases the gate')
  assert.equal(gate.waiting(), 0)
}

// ── 6. With a hook installed, the start is deferred; an ordinary request arriving in that gap still
//       goes ahead of a waiting background job (share build vs editor compile) ─────────────────────
{
  const gate = createSingleFlight({ beforeRequest: () => {} })
  const order = []
  const job = (name) => async () => { order.push(name); await wait(2); return name }
  const first = gate(job('first'))
  const share = gate.background(job('share build'))
  // Let 'first' finish: its settle reserves the gate for the next job; the editor asks in that gap.
  let editor
  const ask = (async () => { await first; for (let i = 0; i < 10; i += 1) await Promise.resolve(); editor = gate(job('editor compile')) })()
  await Promise.all([ask, share])
  await editor
  assert.deepEqual(order, ['first', 'editor compile', 'share build'], 'a foreground request during the deferred start is not overtaken by a background job')
}

// Reproduce the review finding without relying on the prewarm-specific API.
{
  let released = false
  const gate = createSingleFlight({ beforeRequest: () => { released = true } })
  const background = gate.background(async () => {
    assert.equal(released, true, 'release precedes background compilation')
  })
  assert.equal(released, true, 'background release is synchronous, before queueing')
  await background
}

// Every preparation except the prewarm's own idle work releases its retained deck synchronously,
// before the request enters either queue (even when another compile already owns the gate).
{
  let gate
  const seenWaiting = []
  gate = createSingleFlight({ beforeRequest: () => seenWaiting.push(gate.waiting()) })
  let finish
  const held = gate.prewarm(() => new Promise((resolve) => { finish = resolve }))
  assert.deepEqual(seenWaiting, [], 'prewarm does not announce itself')
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  const background = gate.background(async () => {
    assert.deepEqual(seenWaiting, [1], 'release already happened before the task runs')
    return 'variant'
  })
  assert.deepEqual(seenWaiting, [1], 'release is synchronous and precedes background queueing')
  assert.equal(gate.waiting(), 2)
  finish('prewarm')
  assert.deepEqual(await Promise.all([held, background]), ['prewarm', 'variant'])
  await gate.prewarm(async () => {
    assert.deepEqual(seenWaiting, [1], 'prewarm never releases its own preparation')
  })
  const throwing = createSingleFlight({ beforeRequest: () => { throw Error('release failed') } })
  assert.equal(await throwing.background(async () => 'still runs'), 'still runs', 'a failing hook does not wedge background work')
}

console.log('PASS single flight: strict ordering, own values, failure releases the gate, background lane yields')

// Ungated compiles release synchronously, are counted independently, and never join either queue.
{
  const events = []
  let gate
  gate = createSingleFlight({ beforeRequest: () => events.push('release') })
  let endA, endB
  const a = gate.withPrewarmYield(() => {
    events.push('compile-a')
    assert.equal(gate.foregroundBusy(), true, 'counter is visible inside fn')
    return new Promise((resolve) => { endA = resolve })
  })
  assert.deepEqual(events, ['release', 'compile-a'], 'release and fn run synchronously, in that order')
  assert.equal(gate.waiting(), 0, 'the export does not enter the gate queue')
  const b = gate.withPrewarmYield(() => new Promise((resolve) => { endB = resolve }))
  assert.equal(typeof endB, 'function', 'overlapping exports keep their existing concurrency')
  assert.equal(await gate(async () => 'live'), 'live', 'ordinary gate jobs do not wait behind exports')
  endA('a')
  assert.equal(await a, 'a')
  assert.equal(gate.foregroundBusy(), true, 'one finished compile cannot hide another')
  endB('b')
  assert.equal(await b, 'b')
  assert.equal(gate.foregroundBusy(), false, 'the last scope clears the counter')
  await assert.rejects(gate.withPrewarmYield(() => { throw Error('sync compile') }), /sync compile/)
  assert.equal(gate.foregroundBusy(), false, 'a synchronous throw clears the counter')
  await assert.rejects(gate.withPrewarmYield(async () => { throw Error('async compile') }), /async compile/)
  assert.equal(gate.foregroundBusy(), false, 'a rejected compile clears the counter')
  const brokenHook = createSingleFlight({ beforeRequest: () => { throw Error('hook') } })
  assert.equal(await brokenHook.withPrewarmYield(async () => 'ok'), 'ok')
  assert.equal(brokenHook.foregroundBusy(), false)
}

// Even a prewarm already queued (or reserved for a deferred start) cannot begin during an export.
{
  const gate = createSingleFlight({ beforeRequest: () => {} })
  let started = false, finish
  const prewarm = gate.prewarm(async () => { started = true; return 'warm' })
  await Promise.resolve() // pump has reserved a deferred start
  const foreground = gate.withPrewarmYield(() => new Promise((resolve) => { finish = resolve }))
  await wait(10)
  assert.equal(started, false, 'queued prewarm checks the counter again when it would actually start')
  assert.equal(await gate.background(async () => 'share'), 'share', 'other background jobs do not wait behind a blocked prewarm')
  assert.equal(started, false, 'background completion cannot start a blocked prewarm')
  finish('export')
  assert.equal(await foreground, 'export')
  assert.equal(await prewarm, 'warm', 'prewarm resumes when the foreground counter clears')
  assert.equal(gate.foregroundBusy(), false)
}
console.log('PASS ungated compiles: synchronous release, counted busy scope, throw cleanup, prewarm start guard')

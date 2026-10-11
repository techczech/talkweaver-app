#!/usr/bin/env node
/**
 * "Jobs belong to the worker that runs them" (prepare-talk-off-thread.ts).
 *
 * The idle end of the compile worker is terminate(), which completes a moment later. A compile that
 * arrives in that moment starts a NEW worker; the OLD worker's late exit must not fail it. An
 * unexpected exit fails only that worker's own jobs.
 */
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { createPrepareTalkOffThread } from '../src/main/prepare-talk-off-thread.ts'

const made = []
class FakeWorker extends EventEmitter {
  constructor() { super(); this.posted = []; this.terminated = false; made.push(this) }
  postMessage(job) { this.posted.push(job) }
  terminate() { this.terminated = true; return Promise.resolve(0) } // the exit event is fired by the test, late
  answer(job, value) { this.emit('message', { id: job.id, ok: true, model: { value }, rows: null }) }
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const request = { path: 'x' }
const outcome = (promise) => promise.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }))

// 1. Worker A retired by the idle end; B starts; A's exit fires late; B's job still resolves.
{
  made.length = 0
  const compile = createPrepareTalkOffThread('w.js', 5, FakeWorker)
  const first = compile(request)
  const [a] = made
  a.answer(a.posted[0], 'one')
  assert.equal((await first).model.value, 'one')
  await wait(30) // idle end fires
  assert.ok(a.terminated, 'the idle worker was terminated')
  const second = compile(request)
  assert.equal(made.length, 2, 'a new worker started')
  const b = made[1]
  a.emit('exit', 1) // A's exit lands late
  b.answer(b.posted[0], 'two')
  assert.equal((await second).model.value, 'two', "A's late exit must not fail B's job")
}

// 2. An unexpected exit of B rejects only B's jobs (A's stay).
{
  made.length = 0
  const compile = createPrepareTalkOffThread('w.js', 60_000, FakeWorker)
  const job = compile(request)
  const [a] = made
  const settled = outcome(job)
  a.emit('exit', 7)
  const result = await settled
  assert.equal(result.ok, false)
  assert.match(result.e.message, /code 7/)
  // The next compile gets a fresh worker and works.
  const next = compile(request)
  assert.equal(made.length, 2)
  made[1].answer(made[1].posted[0], 'again')
  assert.equal((await next).model.value, 'again')
}

// 3. Two live workers' jobs are separate: B dies unexpectedly while A (retired, silent) is irrelevant.
{
  made.length = 0
  const compile = createPrepareTalkOffThread('w.js', 5, FakeWorker)
  const p1 = compile(request)
  made[0].answer(made[0].posted[0], 'x'); await p1
  await wait(30)
  const p2 = outcome(compile(request))
  made[0].emit('exit', 1)       // late exit of A: nothing happens
  made[1].emit('error', new Error('boom'))
  const r = await p2
  assert.equal(r.ok, false)
  assert.equal(r.e.message, 'boom')
}
console.log('prepare-talk-off-thread: jobs stay with their own worker — ok')

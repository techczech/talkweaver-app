#!/usr/bin/env node
/**
 * "Jobs belong to the child that runs them" (prepare-talk-off-thread.ts).
 *
 * The idle end of the compile's child process is kill(), whose exit arrives a moment later. A compile
 * that arrives in that moment starts a NEW child; the OLD child's late exit must not fail it. An
 * unexpected exit (out of memory, a crash) or a fatal-error report fails only that child's own jobs,
 * and the next compile starts a fresh child. A job that cannot be copied to the child fails that
 * compile only. The real process boundary (a heap of its own) is proven under Electron by
 * e2e/diagnose-compile-own-heap.mjs.
 */
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { createPrepareTalkOffThread } from '../src/main/prepare-talk-off-thread.ts'

const made = []
// The shape of Electron's UtilityProcess that the module uses.
class FakeChild extends EventEmitter {
  constructor(path) { super(); this.path = path; this.posted = []; this.killed = false; made.push(this) }
  postMessage(job) {
    if (typeof job.options?.bad === 'function') throw new Error('An object could not be cloned.')
    this.posted.push(job)
  }
  kill() { this.killed = true; return true } // the exit event is fired by the test, late
  answer(job, value) { this.emit('message', { id: job.id, ok: true, model: { value }, rows: null }) }
}
const spawn = (path) => new FakeChild(path)
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const request = { path: 'x' }
const outcome = (promise) => promise.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }))

// 1. Child A retired by the idle end; B starts; A's exit fires late; B's job still resolves.
{
  made.length = 0
  const compile = createPrepareTalkOffThread('w.js', spawn, 5)
  const first = compile(request)
  const [a] = made
  assert.equal(a.path, 'w.js', 'the child runs the script it was given')
  a.answer(a.posted[0], 'one')
  assert.equal((await first).model.value, 'one')
  await wait(30) // idle end fires
  assert.ok(a.killed, 'the idle child was ended')
  const second = compile(request)
  assert.equal(made.length, 2, 'a new child started')
  const b = made[1]
  a.emit('exit', 1) // A's exit lands late
  b.answer(b.posted[0], 'two')
  assert.equal((await second).model.value, 'two', "A's late exit must not fail B's job")
}

// 2. An unexpected exit of a child (out of memory: Electron reports code 5) rejects its jobs.
{
  made.length = 0
  const compile = createPrepareTalkOffThread('w.js', spawn, 60_000)
  const job = compile(request)
  const [a] = made
  const settled = outcome(job)
  a.emit('exit', 7)
  const result = await settled
  assert.equal(result.ok, false)
  assert.match(result.e.message, /The talk could not be compiled .*code 7/)
  // The next compile gets a fresh child and works.
  const next = compile(request)
  assert.equal(made.length, 2)
  made[1].answer(made[1].posted[0], 'again')
  assert.equal((await next).model.value, 'again')
}

// 3. Two live children's jobs are separate: B reports a fatal error while A (retired, silent) is irrelevant.
{
  made.length = 0
  const compile = createPrepareTalkOffThread('w.js', spawn, 5)
  const p1 = compile(request)
  made[0].answer(made[0].posted[0], 'x'); await p1
  await wait(30)
  const p2 = outcome(compile(request))
  made[0].emit('exit', 1)       // late exit of A: nothing happens
  made[1].emit('error', 'FatalError', 'boom')
  const r = await p2
  assert.equal(r.ok, false)
  assert.match(r.e.message, /The talk could not be compiled .*FatalError at boom/)
  made[1].emit('exit', 5)       // B's own exit after its report fails nothing more
  const p3 = compile(request)
  assert.equal(made.length, 3, 'a child that reported a fatal error is not given another job')
  made[2].answer(made[2].posted[0], 'fresh')
  assert.equal((await p3).model.value, 'fresh')
}

// 4. A job that cannot be copied to the child fails that compile only; the child stays.
{
  made.length = 0
  const compile = createPrepareTalkOffThread('w.js', spawn, 60_000)
  const bad = await outcome(compile({ ...request, options: { bad: () => 1 } }))
  assert.equal(bad.ok, false)
  assert.match(bad.e.message, /could not be cloned/)
  const good = compile(request)
  assert.equal(made.length, 1, 'the same child takes the next job')
  made[0].answer(made[0].posted[0], 'ok')
  assert.equal((await good).model.value, 'ok')
}

// 5. A child that cannot be started fails that compile; the next compile tries again.
{
  made.length = 0
  let refuse = true
  const compile = createPrepareTalkOffThread('w.js', (path) => { if (refuse) throw new Error('no child'); return new FakeChild(path) }, 60_000)
  const failed = await outcome(compile(request))
  assert.equal(failed.ok, false)
  assert.equal(failed.e.message, 'no child')
  refuse = false
  const next = compile(request)
  made[0].answer(made[0].posted[0], 'started')
  assert.equal((await next).model.value, 'started')
}
// 6. A silent child: the job rejects at the deadline, the child is killed, late events change nothing,
//    and the next job goes to a fresh child.
{
  made.length = 0
  const compile = createPrepareTalkOffThread('w.js', spawn, 60_000, 20)
  const silent = outcome(compile(request))
  const second = outcome(compile(request)) // held by the same child
  const [a] = made
  const r = await silent
  assert.equal(r.ok, false)
  assert.match(r.e.message, /The talk could not be compiled \(the compile took longer than/)
  assert.equal((await second).ok, false, 'every job the child held fails')
  assert.ok(a.killed, 'the silent child was killed')
  a.answer(a.posted[0], 'late'); a.emit('exit', 9); a.emit('error', 'Fatal', 'x') // nothing happens
  const next = compile(request)
  assert.equal(made.length, 2, 'the next job starts a fresh child')
  made[1].answer(made[1].posted[0], 'fresh')
  assert.equal((await next).model.value, 'fresh')
  a.emit('exit', 9)
  await wait(50)
  assert.equal(made[1].killed, false, 'the answered job left no deadline behind')
}

// 7. A job answered in time leaves no timer: the child is not killed by a deadline, only by the idle end.
{
  made.length = 0
  const compile = createPrepareTalkOffThread('w.js', spawn, 80, 30)
  const p = compile(request)
  made[0].answer(made[0].posted[0], 'quick')
  await p
  await wait(50) // past the deadline, before the idle end
  assert.equal(made[0].killed, false)
  await wait(100)
  assert.ok(made[0].killed, 'the idle end still retires the child')
}
console.log('prepare-talk-off-thread: jobs stay with their own child process — ok')

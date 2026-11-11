#!/usr/bin/env node
// The editor's live-preview compile (src/renderer/src/lib/liveCompile.ts): at most one in flight per
// talk, edits made meanwhile compiled once as their newest text, replies in order, nothing lost.
import { strict as assert } from 'node:assert'
import { createLiveCompile } from '../src/renderer/src/lib/liveCompile.ts'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
function fakeMain() {
  const sent = []
  const send = (key, source) => new Promise((resolve, reject) => sent.push({ key, source, resolve, reject }))
  return { sent, send }
}

{
  const main = fakeMain()
  const live = createLiveCompile(main.send)
  const r1 = live.request('talk', 'v1')
  const r2 = live.request('talk', 'v2')
  const r3 = live.request('talk', 'v3')
  const other = live.request('other', 'o1')
  assert.deepEqual(main.sent.map((s) => s.source), ['v1', 'o1'], 'one compile in flight per talk; other talks are independent')
  assert.deepEqual(await r2, { status: 'superseded' }, 'a remembered edit replaced by a newer one settles as superseded')
  main.sent[0].resolve(['rows v1'])
  assert.deepEqual(await r1, { status: 'compiled', result: ['rows v1'] })
  await tick()
  assert.deepEqual(main.sent.map((s) => s.source), ['v1', 'o1', 'v3'], 'exactly one follow-up, for the newest text')
  main.sent[2].resolve(['rows v3'])
  assert.deepEqual(await r3, { status: 'compiled', result: ['rows v3'] })
  main.sent[1].resolve(['rows o1'])
  assert.deepEqual(await other, { status: 'compiled', result: ['rows o1'] })
  await tick()
  assert.equal(live.inFlight(), 0)
  assert.equal(main.sent.length, 3)
}

{
  // Same text as in flight: join it rather than compile again (also after an edit-then-undo).
  const main = fakeMain()
  const live = createLiveCompile(main.send)
  const a = live.request('t', 'x')
  const edited = live.request('t', 'y')
  const undone = live.request('t', 'x')
  assert.deepEqual(await edited, { status: 'superseded' })
  main.sent[0].resolve('rows x')
  assert.deepEqual(await Promise.all([a, undone]), [{ status: 'compiled', result: 'rows x' }, { status: 'compiled', result: 'rows x' }])
  await tick()
  assert.equal(main.sent.length, 1, 'nothing further is sent when the latest text is what was compiled')
}

{
  // A failed compile still sends the newest edit; main's superseded reply is passed on as superseded.
  const main = fakeMain()
  const live = createLiveCompile(main.send)
  const failing = live.request('t', 'a')
  const next = live.request('t', 'b')
  main.sent[0].reject(Error('ipc gone'))
  await assert.rejects(failing, /ipc gone/)
  await tick()
  assert.equal(main.sent[1]?.source, 'b', 'the latest edit is compiled after a failure')
  main.sent[1].resolve({ superseded: true })
  assert.deepEqual(await next, { status: 'superseded' })
  await tick()
  assert.equal(live.inFlight(), 0)
  // A send that throws synchronously still frees the talk.
  const throwing = createLiveCompile(() => { throw Error('sync') })
  await assert.rejects(throwing.request('t', 'a'), /sync/)
  await tick()
  assert.equal(throwing.inFlight(), 0)
}
{
  // Reply boundary: a request for the just-compiled text made in a waiter's continuation (the next
  // microtask) must start or join a live compile and settle, never join the finished one and hang.
  for (const outcome of ['resolve', 'reject']) {
    const main = fakeMain()
    const live = createLiveCompile(main.send)
    let late
    const first = live.request('t', 'A').then(
      (value) => { late = live.request('t', 'A'); return value },
      (error) => { late = live.request('t', 'A'); return error })
    assert.equal(live.busy('t'), true, 'busy while a compile is in flight')
    main.sent[0][outcome](outcome === 'resolve' ? 'rows A' : Error('failed'))
    await first
    assert.equal(main.sent.length, 2, `after a ${outcome}, the late request is sent as a new compile`)
    main.sent[1].resolve('rows A again')
    const settled = await Promise.race([late, new Promise((r) => setTimeout(() => r('hung'), 50))])
    assert.deepEqual(settled, { status: 'compiled', result: 'rows A again' }, `late joiner settles after a ${outcome}`)
    await tick()
    assert.equal(live.busy('t'), false)
  }
  // The next compile is already in flight by the time the previous one's waiters run.
  const main = fakeMain()
  const live = createLiveCompile(main.send)
  let sentWhenSettled
  const a = live.request('t', 'A').then(() => { sentWhenSettled = main.sent.length })
  live.request('t', 'B')
  main.sent[0].resolve('rows A')
  await a
  assert.equal(sentWhenSettled, 2, 'the follow-up for B is sent before A\'s waiters run')
}
console.log('PASS live compile: one in flight per talk, newest edit compiled once, failures and superseded replies handled')

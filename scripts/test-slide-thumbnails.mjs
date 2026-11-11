// The renderer's one thumbnail route: buffer identity, source coalescing, queue lifetime and vault isolation.
import assert from 'node:assert/strict'
import { createLatestThumbnailRequestHandler } from '../src/main/thumbnail-queue.ts'
import { requestSlideThumbnails, sourceThumbnailClient } from '../src/renderer/src/lib/slideThumbnails.ts'
let checks = 0
const check = async (name, fn) => { await fn(); checks++; console.log(`PASS ${name}`) }
const settle = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const clients = []
const client = (...args) => { const c = sourceThumbnailClient(...args); clients.push(c); return c }
try {
  await check('identical live buffers share one in-flight request; a changed buffer remains distinct', async () => {
    const hold = deferred(); const calls = []
    globalThis.window = { tw: { talk: { thumbnails: (...args) => { calls.push(args); return hold.promise } } } }
    const first = requestSlideThumbnails('/a', 'one')
    assert.equal(requestSlideThumbnails('/a', 'one'), first)
    const changed = requestSlideThumbnails('/a', 'two')
    assert.notEqual(first, changed)
    await settle(); assert.equal(calls.length, 2)
    hold.resolve({ h: 'image' }); await Promise.all([first, changed]); await settle()
    await requestSlideThumbnails('/a', 'one'); assert.equal(calls.length, 3, 'completed buffers can refresh')
  })
  await check('A to B to undo A reissues the latest buffer rather than sharing superseded A', async () => {
    const hold = deferred(); const calls = []
    const latest = createLatestThumbnailRequestHandler(async input => { await hold.promise; return input }, async input => ({ [input.content]: 'image' }), {})
    window.tw.talk.thumbnails = (path, content, opts) => { calls.push(content); return latest(opts?.lane ?? '', { path, content }) }
    const a = requestSlideThumbnails('/edit', 'A')
    const b = requestSlideThumbnails('/edit', 'B')
    const again = requestSlideThumbnails('/edit', 'A')
    assert.notEqual(again, a)
    await settle(); hold.resolve(); const maps = await Promise.all([a, b, again])
    assert.deepEqual(calls, ['A', 'B', 'A']); assert.deepEqual(maps, [{}, {}, { A: 'image' }])
  })
  await check('switching documents invalidates old requests in that main-process lane; explicit editor lane is distinct', async () => {
    const hold = deferred(); const calls = []
    window.tw.talk.thumbnails = (path, content, opts) => { calls.push([path, opts?.lane ?? '']); return hold.promise }
    const first = requestSlideThumbnails('/first', 'same')
    requestSlideThumbnails('/second', 'same')
    const back = requestSlideThumbnails('/first', 'same')
    assert.notEqual(back, first)
    const explicit = requestSlideThumbnails('/first', 'same', { lane: 'editor' })
    assert.notEqual(explicit, back)
    await settle(); assert.equal(calls.length, 4); hold.resolve({ h: 'image' }); await Promise.all([first, back, explicit]); await settle()
  })
  await check('Browser and Scratchpad consumers share one source render; close drops only that consumer', async () => {
    const hold = deferred(); let reads = 0; let renders = 0; const seen = []
    window.tw.talk = { readOutline: async () => { reads++; return 'source' }, thumbnails: async () => { renders++; return hold.promise } }
    const a = client(path => seen.push('a:' + path)); const b = client(path => seen.push('b:' + path))
    a.note('/vault/source'); b.note('/vault/source'); a.note('/vault/source')
    await settle(); assert.equal(reads, 1); assert.equal(renders, 1)
    a.dispose(); hold.resolve({ h: 'image' }); await settle(); await settle()
    assert.deepEqual(seen, ['b:/vault/source']); b.dispose()
  })
  await check('source renders serialize across vault paths with the same slug', async () => {
    const hold = deferred(); const paths = []; const seen = []
    window.tw.talk = { readOutline: async path => path, thumbnails: async path => { paths.push(path); return paths.length === 1 ? hold.promise : { h: path } } }
    const c = client(path => seen.push(path))
    c.note('/vault-one/talk'); c.note('/vault-two/talk')
    await settle(); assert.deepEqual(paths, ['/vault-one/talk'])
    hold.resolve({ h: 'one' }); await settle(); await settle()
    assert.deepEqual(paths, ['/vault-one/talk', '/vault-two/talk']); assert.deepEqual(seen, paths); c.dispose()
  })
  await check('an empty source result defers and disposing the last consumer cancels its timer', async () => {
    let renders = 0
    window.tw.talk = { readOutline: async () => 'source', thumbnails: async () => { renders++; return {} } }
    const c = client(() => assert.fail('an empty map is not a picture'))
    c.note('/deferred'); await settle(); await settle(); c.dispose()
    assert.equal(renders, 1)
  })
  await check('portable source resolution failures defer through the shared queue and recover', async () => {
    const realSetTimeout = globalThis.setTimeout
    const timers = []
    globalThis.setTimeout = (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer }
    let resolves = 0; const seen = []; let clock = Date.now(); const realNow = Date.now
    Date.now = () => clock
    window.tw.talk = { thumbnails: async () => ({ h: 'image' }) }
    const c = client((key, _map, path) => seen.push([key, path]))
    try {
      c.note('/portable', async () => ++resolves === 1 ? null : { path: '/actual/source', content: 'source' })
      await settle(); await settle()
      assert.equal(timers.length, 1, 'failed resolution schedules a shared retry')
      clock += timers[0].delay
      timers[0].fn(); await settle(); await settle()
      assert.deepEqual(seen, [['/portable', '/actual/source']])
      assert.equal(resolves, 2)
    } finally { c.dispose(); globalThis.setTimeout = realSetTimeout; Date.now = realNow }
  })
  await check('a portable source retries a transient main-process render failure', async () => {
    const realSetTimeout = globalThis.setTimeout, realNow = Date.now
    const timers = []; let clock = realNow(), renders = 0; const seen = []
    globalThis.setTimeout = (fn, delay) => { const timer = { fn, delay }; timers.push(timer); return timer }
    Date.now = () => clock
    window.tw.talk = { thumbnails: async () => ++renders === 1 ? null : { h: 'image' } }
    const c = client(key => seen.push(key))
    try {
      c.note('scratchpad:transient', async () => ({ path: '/source', content: 'source' }))
      await settle(); await settle()
      assert.equal(timers.length, 1, 'transient render failure schedules a source retry')
      clock += timers[0].delay; timers[0].fn(); await settle(); await settle()
      assert.deepEqual(seen, ['scratchpad:transient']); assert.equal(renders, 2)
    } finally { c.dispose(); globalThis.setTimeout = realSetTimeout; Date.now = realNow }
  })
  await check('a portable fallback source cannot complete a different Browser outline', async () => {
    const seen = []; const calls = []
    window.tw.talk = { readOutline: async path => path, thumbnails: async path => { calls.push(path); return { h: path } } }
    const scratch = client((key, map, path) => seen.push(['scratch', key, map.h, path]))
    const browser = client((key, map, path) => seen.push(['browser', key, map.h, path]))
    scratch.note('scratchpad:portable', async () => ({ path: '/vault-B/shared', content: 'B' }))
    browser.note('/vault-A/shared')
    await settle(); await settle()
    assert.deepEqual(calls, ['/vault-B/shared', '/vault-A/shared'])
    assert.deepEqual(seen, [['scratch', 'scratchpad:portable', '/vault-B/shared', '/vault-B/shared'], ['browser', '/vault-A/shared', '/vault-A/shared', '/vault-A/shared']])
    scratch.dispose(); browser.dispose()
  })
  await check('source read faults cap retries, and a fresh opening may retry', async () => {
    let reads = 0; const seen = []
    window.tw.talk = { readOutline: async () => { reads++; return null } }
    const c = client(() => assert.fail('unreadable source'))
    c.note('/fault'); await settle(); await settle()
    c.note('/fault'); await settle(); await settle()
    c.note('/fault'); await settle(); await settle()
    assert.equal(reads, 2); c.dispose()
    window.tw.talk = { readOutline: async () => 'now readable', thumbnails: async () => ({ h: 'image' }) }
    const d = client(path => seen.push(path)); d.note('/fault'); await settle(); await settle()
    assert.deepEqual(seen, ['/fault']); d.dispose()
  })
  const regressions = []
  for (const outcome of ['unresolved', 'null', 'empty', 'throw', 'success', 'failure-then-success']) {
    try {
      await check(`portable source ${outcome} uses at most two attempts, 15 seconds apart after failure`, async () => {
        const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout, realNow = Date.now
        const timers = new Set(); let clock = realNow(), attempts = 0, renders = 0
        globalThis.setTimeout = (fn, delay) => { const t = { fn, delay }; timers.add(t); return t }
        globalThis.clearTimeout = t => timers.delete(t)
        Date.now = () => clock
        const advance = async ms => { clock += ms; const pending = [...timers]; timers.clear(); for (const t of pending) t.fn(); await settle(); await settle() }
        window.tw.talk = { thumbnails: async () => {
          renders++
          if (outcome === 'throw') throw new Error('temporary failure')
          if (outcome === 'null' || (outcome === 'failure-then-success' && renders === 1)) return null
          return outcome === 'empty' ? {} : { h: 'image' }
        } }
        const c = client(() => {})
        const resolve = async () => { attempts++; return outcome === 'unresolved' ? null : { path: '/actual/' + outcome, content: 'source' } }
        try {
          c.note('scratchpad:' + outcome, resolve); c.note('scratchpad:' + outcome, resolve)
          await settle(); await settle()
          assert.equal(attempts, 1, 'concurrent notes coalesce')
          if (outcome === 'success') {
            c.note('scratchpad:' + outcome, resolve); c.note('scratchpad:' + outcome, resolve)
            await settle(); await settle()
            assert.equal(attempts, 2, 'a later missing picture may use the second attempt after success')
          } else {
            assert.equal(timers.size, 1)
            assert.equal([...timers][0].delay, 15_000, 'Scratchpad retries after 15 seconds')
            await advance(15_000)
            assert.equal(attempts, 2)
          }
          c.note('scratchpad:' + outcome, resolve); await settle(); await settle()
          assert.equal(attempts, 2, 'successes and failures both consume the source budget')
          assert.equal(timers.size, 0, 'an exhausted source stops scheduling retries')
          await advance(60_000)
          assert.equal(attempts, 2)
        } finally { c.dispose(); globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; Date.now = realNow }
      })
    } catch (error) { regressions.push(error) }
  }
  assert.deepEqual(regressions, [], 'bounded portable source regressions')
  console.log(`${checks} thumbnail route checks passed`)
} finally { for (const c of clients) c.dispose() }

import assert from 'node:assert/strict'
const queueModule = await import('../src/main/thumbnail-queue.ts').catch(() => null)
assert.ok(queueModule, 'thumbnail queue supports cancellation and latest-request replacement')
const { createThumbnailQueue } = queueModule
const starts = [], releases = []
const queue = createThumbnailQueue(async (value, signal) => {
  starts.push(value)
  await new Promise(resolve => releases.push(resolve))
  return signal.aborted ? {} : { [value]: value }
})
const first = queue('old', 'editor')
await Promise.resolve()
const middle = queue('middle', 'editor')
const newest = queue('newest', 'editor')
assert.deepEqual(await middle, {}, 'replaced pending caller settles without rendering')
assert.deepEqual(starts, ['old'], 'only one render is active')
releases.shift()()
assert.deepEqual(await first, {}, 'active stale render observes cancellation')
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(starts, ['old', 'newest'], 'only latest pending document renders')
releases.shift()()
assert.deepEqual(await newest, {newest:'newest'})
const other = queue('other', 'browser')
const edit = queue('edit', 'editor')
await Promise.resolve()
releases.shift()()
assert.deepEqual(await other, {other:'other'}, 'unrelated owner is preserved')
await new Promise(resolve => setImmediate(resolve))
releases.shift()()
assert.deepEqual(await edit, {edit:'edit'})
const failures = createThumbnailQueue(async value => { if (value==='fail') throw Error('test'); return {value} })
await assert.rejects(failures('fail'), /test/)
assert.deepEqual(await failures('ok'), {value:'ok'}, 'failure does not poison queue')
console.log('PASS thumbnail queue: cancellation, bounded pending edits, independent owners, recovery')
{
  // A background job (the picker's own-slide pictures) never goes ahead of a normal one.
  const order = [], gates = []
  const q = createThumbnailQueue(async (value) => { order.push(value); await new Promise(resolve => gates.push(resolve)); return { [value]: value } })
  const busy = q('busy', 'editor')
  await Promise.resolve()
  const variant = q('variant', 'picker', true)
  const strip = q('strip', 'editor')
  const browser = q('browser', 'browser')
  gates.shift()(); await busy
  await new Promise(resolve => setImmediate(resolve))
  gates.shift()(); await strip
  await new Promise(resolve => setImmediate(resolve))
  gates.shift()(); await browser
  await new Promise(resolve => setImmediate(resolve))
  gates.shift()(); await variant
  assert.deepEqual(order, ['busy', 'strip', 'browser', 'variant'], 'normal lanes are served before a queued background job')
  console.log('PASS thumbnail queue: background jobs wait behind normal lanes')
}
{
  // The prewarm's idle jobs: last in line, and interrupted by anything anyone is waiting for.
  let clock = 100
  const order = [], gates = [], signals = {}
  const q = createThumbnailQueue(async (value, signal) => {
    order.push(value); signals[value] = signal
    await new Promise(resolve => gates.push(resolve))
    return { [value]: value }
  }, () => clock)
  assert.equal(q.lastForegroundAt(), 0)
  const warm = q('warm-1', 'prewarm', 'idle')
  await Promise.resolve()
  assert.equal(q.foregroundBusy(), false, 'an idle job alone is not foreground work')
  clock = 200
  const variant = q('variant', 'picker', true)
  assert.equal(signals['warm-1'].aborted, true, 'a running idle job is interrupted by a newcomer')
  assert.equal(q.foregroundBusy(), true)
  assert.equal(q.lastForegroundAt(), 200, 'the newcomer is stamped with the queue clock')
  const warm2 = q('warm-2', 'prewarm-b', 'idle')
  const strip = q('strip', 'editor')
  gates.shift()()
  assert.deepEqual(await warm, {}, 'the interrupted idle job settles with nothing')
  for (const job of [strip, variant, warm2]) {
    await new Promise(resolve => setImmediate(resolve))
    gates.shift()(); await job
  }
  assert.deepEqual(order, ['warm-1', 'strip', 'variant', 'warm-2'], 'normal, then background, then idle')
  assert.equal(q.foregroundBusy(), false)
  // cancel: a waiting job settles at once, a running one is aborted.
  const busy = q('busy', 'editor')
  const waiting = q('w', 'prewarm', 'idle')
  q.cancel('prewarm')
  assert.deepEqual(await waiting, {}, 'a cancelled waiting job settles with nothing')
  await Promise.resolve()
  q.cancel('editor')
  assert.equal(signals.busy.aborted, true, 'a cancelled running job is aborted')
  gates.shift()(); assert.deepEqual(await busy, {})
  console.log('PASS thumbnail queue: idle jobs go last, are interrupted by any other render, and can be cancelled')
}
const {createLatestThumbnailRequestHandler}=await import('../src/main/thumbnail-queue.ts')
assert.equal(typeof createLatestThumbnailRequestHandler,'function','request ordering begins before preparation')
let releaseOld
const rendered=[]
const ordered=createLatestThumbnailRequestHandler(async input=>{
 if(input==='old') await new Promise(resolve=>releaseOld=resolve)
 return input
},async(input,prepared)=>{rendered.push(prepared);return {[input]:input}}, {})
const slow=ordered('editor','old')
await Promise.resolve()
const latest=await ordered('editor','newest')
releaseOld()
assert.deepEqual(await slow,{},'old preparation finishing last cannot enqueue')
assert.deepEqual(latest,{newest:'newest'})
assert.deepEqual(rendered,['newest'],'only newest revision reaches the renderer')
console.log('PASS reversed preparation completion never cancels latest thumbnails')

// Progressive publication must use the same recency boundary as the final result.
{
  let unblock
  const held = new Promise(resolve => { unblock = resolve })
  const published=[]
  const stream=createLatestThumbnailRequestHandler(async input=>input, async (input, prepared, owner, isCurrent)=>{
    if(input==='old')await held
    assert.equal(typeof isCurrent,'function','render receives the current-request guard for partial publication')
    if(isCurrent())published.push(input)
    return {input}
  },{})
  const old=stream('editor','old')
  await Promise.resolve(); await Promise.resolve()
  const latest=await stream('editor','latest')
  unblock();await old
  assert.deepEqual(published,['latest'],'an obsolete render cannot publish partial thumbnails')
  assert.deepEqual(latest,{input:'latest'})
  console.log('PASS progressive publication refuses obsolete render callbacks')
}

import assert from 'node:assert/strict'
const module=await import('../src/main/prepared-talk-cache.ts').catch(()=>null)
assert.ok(module,'prepared cache coalesces concurrent requests and bounds retained revisions')
const {createPreparedTalkCache}=module
const cache=createPreparedTalkCache({maxEntries:2,maxBytes:20,sizeOf:value=>value.length*2})
let calls=0,release
const load=async()=>{calls++;await new Promise(resolve=>{release=resolve});return 'first'}
const first=cache.get('a1','a',load),same=cache.get('a1','a',load)
await Promise.resolve();assert.equal(calls,1,'same in-flight source is prepared once')
release();assert.equal(await first,'first');assert.equal(await same,'first')
assert.equal(await cache.get('a1','a',()=>{throw Error('cached')}),'first')
await cache.get('a2','a',async()=> 'second')
assert.deepEqual(cache.stats(),{entries:1,bytes:12,pending:0},'new revision releases old document')
await cache.get('b1','b',async()=> 'other')
assert.deepEqual(cache.stats(),{entries:1,bytes:10,pending:0},'byte budget evicts oldest different deck')
await cache.get('big','big',async()=> 'a'.repeat(30))
assert.deepEqual(cache.stats(),{entries:1,bytes:60,pending:0},'oversized current document is retained alone for follow-up requests')
await cache.get('small','small',async()=> 'ok')
assert.deepEqual(cache.stats(),{entries:1,bytes:4,pending:0},'next small document releases oversized one')
let oldRelease
const old=cache.get('old','racing',async()=>{await new Promise(r=>oldRelease=r);return 'old'})
await Promise.resolve()
await cache.get('new','racing',async()=> 'new')
oldRelease();await old
assert.equal(await cache.get('new','racing',()=>{throw Error('new result evicted by old completion')}),'new')
await assert.rejects(cache.get('fail','failure',async()=>{throw Error('test')}),/test/)
assert.equal(await cache.get('fail','failure',async()=> 'retry'),'retry','failure can retry')
assert.equal(cache.stats().pending,0)
console.log('PASS preparation cache: single flight, one revision, byte/count budgets, stale completion, retry')
const {createSlidePreviewStore}=await import('../src/shared/slide-preview.ts')
const previews=createSlidePreviewStore(8,20)
previews.set('first','123456')
previews.set('second','abcdef')
assert.equal(previews.get('first'),undefined,'preview HTML store has a byte budget as well as an entry count')
assert.equal(previews.get('second'),'abcdef')
previews.set('second','abcdefghij')
previews.set('third','ok')
assert.equal(previews.get('second'),undefined,'replacing an ID updates byte accounting')
previews.set('large','x'.repeat(30))
assert.equal(previews.get('third'),undefined,'large preview is kept alone')
assert.equal(previews.get('large').length,30,'current oversized preview remains loadable')
console.log('PASS preview HTML retention budget')

// A layout variant's compile (ADR-0032 §6) takes the other route: uncached, on the gate's background
// lane. Behaviour, not source text: the real cache and the real gate, with stand-in compiles.
{
  const { createPreparationRoute, createPreparedTalkCache: makeCache } = module
  const { createSingleFlight } = await import('../src/main/single-flight.ts')
  const cache = makeCache({ maxEntries: 4, maxBytes: 1000, sizeOf: (value) => value.length })
  const gate = createSingleFlight()
  const route = createPreparationRoute(cache, gate)
  const order = []
  const held = []
  const compile = (name) => (gated) => gated(async () => { order.push(`start ${name}`); await new Promise((resolve) => held.push(resolve)); order.push(`end ${name}`); return name })
  const tick = () => new Promise((resolve) => setTimeout(resolve))
  const releaseAll = async () => { for (let i = 0; i < 20; i += 1) { held.splice(0).forEach((resolve) => resolve()); await tick() } }
  // A live compile is running; two variants queue, then the live deck's next compile (a typing pause).
  const liveA = route('live', 'rev1', 'talk', compile('live-1'))
  await tick()
  const variants = [route('variant', 'v1', 'talk', compile('variant-1')), route('variant', 'v2', 'talk', compile('variant-2'))]
  await tick()
  const liveB = route('live', 'rev2', 'talk', compile('live-2'))
  await releaseAll()
  assert.deepEqual(await Promise.all([liveA, liveB, ...variants]), ['live-1', 'live-2', 'variant-1', 'variant-2'])
  assert.deepEqual(order.filter((step) => step.startsWith('start')), ['start live-1', 'start live-2', 'start variant-1', 'start variant-2'],
    'the live deck\'s compile never waits behind a queued variant compile')
  assert(order.every((step, index) => index % 2 === 0 ? step.startsWith('start') : step.startsWith('end')), 'still one compile at a time')
  // The cache holds the live deck only: a variant neither enters it nor evicts the live revision.
  assert.equal(await route('live', 'rev2', 'talk', () => { throw Error('live revision was evicted') }), 'live-2')
  const before = cache.stats().entries
  assert.equal(await Promise.all([route('variant', 'v1', 'talk', compile('variant-1b')), releaseAll()]).then(([value]) => value), 'variant-1b', 'a variant is compiled afresh each time')
  assert.equal(cache.stats().entries, before, 'a variant is never retained')
  assert.equal(await route('live', 'rev2', 'talk', () => { throw Error('variant displaced the live model') }), 'live-2')
  // The share builder already on the background lane keeps its place: variants queue after it, in order.
  const late = []
  const blocker = gate(() => new Promise((resolve) => held.push(resolve)))
  await tick()
  const share = gate.background(async () => { late.push('share') })
  const after = route('variant', 'v3', 'talk', (gated) => gated(async () => { late.push('variant-3'); return 'variant-3' }))
  await releaseAll()
  await Promise.all([blocker, share, after])
  assert.deepEqual(late, ['share', 'variant-3'])
  console.log('PASS preparation route: a variant is uncached and on the background lane; the live compile goes first')
}

// The variant lane's media contract: kept once found, loaded again after a failure or an empty answer.
{
  const { memoiseUntilFailure } = module
  const answers = [Promise.reject(new Error('transient')), Promise.resolve(undefined), Promise.resolve({ video: false })]
  answers[0].catch(() => {})
  let loads = 0
  const media = memoiseUntilFailure(() => { loads += 1; return answers.shift() })
  await assert.rejects(media(), /transient/)
  assert.equal(await media(), undefined, 'a rejected load is not kept')
  assert.deepEqual(await media(), { video: false }, 'an empty answer is not kept either')
  assert.deepEqual(await media(), { video: false })
  assert.equal(loads, 3, 'a found answer is loaded once')
  let shared = 0
  const once = memoiseUntilFailure(async () => { shared += 1; return 'x' })
  await Promise.all([once(), once(), once()])
  assert.equal(shared, 1, 'callers during a load share it')
  console.log('PASS memoiseUntilFailure: a transient failure is retried, a found value kept')
}

// The prewarm is uncached and must use its own gate entry point, never the variant's release hook.
{
  let announces = 0, prewarms = 0, backgrounds = 0, compiles = 0
  const { createSingleFlight } = await import('../src/main/single-flight.ts')
  const gate = createSingleFlight({ beforeRequest: () => { announces += 1 } })
  const originalPrewarm = gate.prewarm, originalBackground = gate.background
  gate.prewarm = (fn) => { prewarms += 1; return originalPrewarm(fn) }
  gate.background = (fn) => { backgrounds += 1; return originalBackground(fn) }
  const cache = createPreparedTalkCache({ maxEntries: 2, maxBytes: 100, sizeOf: () => 1 })
  const route = module.createPreparationRoute(cache, gate)
  const compile = (gated) => gated(async () => ++compiles)
  assert.equal(await route('prewarm', 'same', 'deck', compile), 1)
  assert.equal(await route('prewarm', 'same', 'deck', compile), 2, 'the same prewarm is compiled afresh')
  assert.equal(prewarms, 2, 'prewarm calls gate.prewarm')
  assert.equal(backgrounds, 0, 'prewarm never calls gate.background')
  assert.equal(announces, 0, 'prewarm does not release itself')
  assert.deepEqual(cache.stats(), { entries: 0, bytes: 0, pending: 0 }, 'prewarm never enters the cache')
  console.log('PASS preparation route: prewarm is uncached and uses only gate.prewarm')
}

// Eviction separates in-flight generations even when the outline/cache key stays identical.
{
  const c=createPreparedTalkCache({maxEntries:4,maxBytes:100,sizeOf:()=>1})
  const group=module.preparedTalkGroup('/capture/outline.md')
  let finishOld, finishNew, loads=0
  const old=c.get('same',group,async()=>{loads++;return await new Promise(r=>finishOld=r)})
  await Promise.resolve()
  c.evictOutline('/capture/outline.md')
  const fresh=c.get('same',group,async()=>{loads++;return await new Promise(r=>finishNew=r)})
  await Promise.resolve()
  assert.equal(loads,2,'post-eviction request must not join stale in-flight preparation')
  finishOld('old');assert.equal(await old,'old','existing caller still gets its result')
  assert.equal(c.stats().pending,1,'old finally must not remove replacement pending work')
  finishNew('fresh');assert.equal(await fresh,'fresh')
  assert.equal(await c.get('same',group,()=>{throw Error('fresh value missing')}),'fresh')
  console.log('PASS outline eviction: pending generations invalidated, old completion cannot remove or retain over fresh work')
}
{
  // Supersede through the cache: a live preview's load may only be dropped while that preview alone waits on it.
  const {createPreparedTalkCache,createPreparationRoute}=await import('../src/main/prepared-talk-cache.ts')
  const {createSingleFlight,isSuperseded}=await import('../src/main/single-flight.ts')
  const gate=createSingleFlight()
  const route=createPreparationRoute(createPreparedTalkCache({maxEntries:6,maxBytes:1e6,sizeOf:v=>v.length}),gate)
  let finish
  const running=route('live','r0','g',gated=>gated(()=>new Promise(r=>{finish=r})),'w1')
  await new Promise(r=>setTimeout(r,1))
  const solo=route('live','r1','g',gated=>gated(async()=>'r1'),'w1').then(()=>false,isSuperseded)
  const shared=route('live','r2','g',gated=>gated(async()=>'r2'),'w1')
  const joiner=route('live','r2','g',gated=>gated(async()=>'never loaded twice'))
  const otherWindow=route('live','r3','g',gated=>gated(async()=>'r3'),'w2')
  await new Promise(r=>setTimeout(r,1))
  const newest=route('live','r4','g',gated=>gated(async()=>'r4'),'w1')
  finish('r0')
  assert.equal(await running,'r0','a running preparation is never dropped')
  assert.ok(await solo,'a queued preparation only its own preview waits on is dropped')
  assert.equal(await shared,'r2','a queued preparation another caller joined is kept')
  assert.equal(await joiner,'r2','and that caller gets its value')
  assert.equal(await otherWindow,'r3','another window\'s preview is never dropped')
  assert.equal(await newest,'r4')
  console.log('PASS preparation cache supersede: own-only queued load dropped, shared and other-owner loads kept')
}
{
  // A dropped preparation is not joinable even before its rejection propagates: a caller asking for the
  // same revision in that window starts a fresh load and gets a real value, not SupersededError.
  const {createPreparedTalkCache,createPreparationRoute}=await import('../src/main/prepared-talk-cache.ts')
  const {createSingleFlight,isSuperseded}=await import('../src/main/single-flight.ts')
  const gate=createSingleFlight()
  const route=createPreparationRoute(createPreparedTalkCache({maxEntries:6,maxBytes:1e6,sizeOf:v=>v.length}),gate)
  let finish,loads=0
  const running=route('live','x0','g',gated=>gated(()=>new Promise(r=>{finish=r})),'w1')
  await new Promise(r=>setTimeout(r,1))
  const doomed=route('live','a','g',gated=>gated(async()=>{loads++;return 'a'}),'w1').then(()=>'ran',e=>isSuperseded(e)?'superseded':e)
  await new Promise(r=>setTimeout(r,1)) // 'a' is queued on the gate
  let late
  // The newer keyed request drops 'a' inside its own load; the very next microtask an ordinary caller asks for 'a'.
  const newer=route('live','b','g',gated=>{const p=gated(async()=>'b');late=route('live','a','g',gated2=>gated2(async()=>{loads++;return 'a fresh'}));return p},'w1')
  await new Promise(r=>setTimeout(r,1))
  finish('x0')
  assert.equal(await running,'x0')
  assert.equal(await doomed,'superseded','the dropped caller is told so')
  assert.equal(await late,'a fresh','a caller arriving after the drop gets its own load, not the doomed promise')
  assert.equal(await newer,'b')
  assert.equal(loads,1,'the dropped load never ran; the late caller\'s did')
  console.log('PASS preparation cache supersede: a dropped load is unjoinable at once')
}

// The background thumbnail prewarm (src/main/thumbnail-prewarm.ts), with every dependency faked: a
// set of file names stands for the cache, a counter for the clock. Covers the order talks are warmed
// in, the cheap skip of complete talks, giving way to renders somebody is waiting for, pausing under
// memory pressure and while presenting (letting go of the held talk), the render-window recycle,
// carrying on after a restart without redoing work, and stopping on quit.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createSingleFlight } from '../src/main/single-flight.ts'
import { createPreparationRoute, createPreparedTalkCache } from '../src/main/prepared-talk-cache.ts'
import { buildInGate } from '../src/main/shared-talk-build.ts'

const { createThumbnailPrewarm, prewarmOrder, memoryPressure, DEFAULT_PREWARM_LIMITS } = await import('../src/main/thumbnail-prewarm.ts')

const MB = 1024 * 1024
const calm = () => ({ mainHeapBytes: 200 * MB, mainRssBytes: 500 * MB, rendererBytes: 100 * MB, appBytes: 900 * MB, loadPerCpu: 0.1 })

function talk(slug, slides, extra = {}) {
  return { outlinePath: `/v/${slug}/${slug}-outline.md`, slug, editedMs: 0, open: false, keys: Array.from({ length: slides }, (_, i) => `${slug}-${i}`), ...extra }
}

/** A world of fakes. `disk` survives across prewarm instances (a restart). */
function world({ talks, disk = new Set(), limits = {}, bad = new Set() } = {}) {
  const w = {
    clock: 1_000_000,
    disk,
    talks,
    log: [],
    prepared: [],
    released: [],
    renders: [],
    recycles: 0,
    cancels: 0,
    memory: calm,
    presenting: () => false,
    foregroundBusy: () => false,
    lastForegroundAt: () => 0,
    onRender: null,
    holding: 0,
    maxHolding: 0,
    alive: () => true,
    afterSlide: null,
    sleptHolding: []
  }
  w.deps = {
    listTalks: () => w.talks,
    missing: (t, keys) => { w.looks = (w.looks ?? 0) + 1; return keys.filter((key) => !w.disk.has(key)) },
    prepare: async (t) => {
      w.prepared.push(t.slug)
      w.holding += 1
      w.maxHolding = Math.max(w.maxHolding, w.holding)
      const slides = t.keys.map((key, index) => ({ key, cacheKey: `doc-${key}`, index }))
      let released = false
      return { slides, release: () => { if (!released) { released = true; w.holding -= 1; w.released.push(t.slug) } } }
    },
    render: async (t, deck, slides, paceMs, shouldYield) => {
      w.renders.push({ slug: t.slug, keys: slides.map((s) => s.key), paceMs })
      const hook = w.onRender ? await w.onRender(t, slides) : null
      if (hook?.interrupted) {
        // Cut in after the first slide: that one is written, the rest are not.
        if (!hook.before && slides[0] && !bad.has(slides[0].key)) w.disk.add(slides[0].key)
        return { interrupted: true }
      }
      for (const s of slides) {
        if (shouldYield()) return { interrupted: true }
        if (!bad.has(s.key)) w.disk.add(s.key)
        w.afterSlide?.(s)
      }
      return { interrupted: false }
    },
    talkAlive: (t) => w.alive(t),
    recycleRenderer: () => { w.recycles += 1; return true },
    cancelRender: () => { w.cancels += 1 },
    memory: () => w.memory(),
    presenting: () => w.presenting(),
    foregroundBusy: () => w.foregroundBusy(),
    lastForegroundAt: () => w.lastForegroundAt(),
    now: () => w.clock,
    sleep: async (ms, signal) => { w.sleptHolding.push(w.holding); if (!signal.aborted) w.clock += ms; await new Promise((r) => setImmediate(r)) },
    log: (m) => w.log.push(m),
    limits: { startDelayMs: 10, slidePaceMs: 7, talkGapMs: 1, pollMs: 100, quietMs: 1000, rescanMs: 60_000, ...limits }
  }
  return w
}

async function until(check, label, turns = 20_000) {
  for (let i = 0; i < turns; i += 1) {
    if (check()) return
    await new Promise((r) => setImmediate(r))
  }
  assert.fail(`timed out waiting: ${label}`)
}
const idle = (p) => until(() => p.status().state === 'idle', 'prewarm idle')

// ── pure helpers ──
{
  const ordered = prewarmOrder([
    talk('old', 1, { editedMs: 1 }),
    talk('new', 1, { editedMs: 9 }),
    talk('open-old', 1, { editedMs: 0, open: true }),
    talk('mid', 1, { editedMs: 5 })
  ]).map((t) => t.slug)
  assert.deepEqual(ordered, ['open-old', 'new', 'mid', 'old'], 'open in an editor first, then most recently edited')
  const L = DEFAULT_PREWARM_LIMITS
  assert.equal(memoryPressure(calm(), L), null)
  assert.equal(memoryPressure({ ...calm(), mainHeapBytes: L.mainHeapPauseBytes }, L), 'memory:main-heap')
  assert.equal(memoryPressure({ ...calm(), mainRssBytes: L.mainRssPauseBytes }, L), 'memory:main-process')
  assert.equal(memoryPressure({ ...calm(), appBytes: L.appPauseBytes }, L), 'memory:app')
  assert.equal(memoryPressure({ ...calm(), loadPerCpu: L.loadPerCpuPause }, L), 'load')
  const GB = 1024 * MB
  // Hard ceilings always apply, held talk or not (reviewer's numbers: 20 GiB resident, 24 GiB app).
  const reviewed = { ...calm(), mainRssBytes: 20 * GB, appBytes: 24 * GB }
  const heldAt = { ...calm(), mainRssBytes: 20 * GB, appBytes: 24 * GB }
  assert.equal(memoryPressure(reviewed, L, heldAt), 'memory:main-process', 'a baseline taken at 20 GiB does not lift the resident ceiling')
  assert.equal(memoryPressure({ ...calm(), appBytes: 24 * GB }, L, { ...calm(), appBytes: 24 * GB }), 'memory:app', 'nor the app ceiling')
  assert.equal(memoryPressure({ ...calm(), mainRssBytes: L.hardRssBytes }, L, calm()), 'memory:main-process')
  assert.ok(L.hardHeapBytes === 2048 * MB && L.hardRssBytes === 4096 * MB && L.hardAppBytes === 10240 * MB)
  assert.ok(637 * MB < L.hardHeapBytes && 3.8 * GB < L.hardRssBytes && 4.4 * GB < L.hardAppBytes, 'ceilings sit above the 1,500-slide diagnostic peaks')
  const held = { ...calm(), mainRssBytes: 3300 * MB, mainHeapBytes: 1600 * MB }
  assert.equal(memoryPressure(held, L), 'memory:main-heap', 'without a held talk the pause levels apply')
  assert.equal(memoryPressure(held, L, held), null, 'a held talk\'s own weight is allowed for')
  assert.equal(memoryPressure({ ...held, mainRssBytes: held.mainRssBytes + L.holdGrowthBytes }, L, held), 'memory:main-process', 'growth beyond it is not')
  assert.equal(memoryPressure({ ...held, mainHeapBytes: L.hardHeapBytes }, L, held), 'memory:main-heap', 'the heap ceiling holds whatever the talk weighed')
  assert.ok(L.mainHeapPauseBytes < 2048 * MB, 'the prewarm backs off before the browser lane\'s 2048 MB guard')
  console.log('PASS prewarm: order and pressure rules')
}

// ── order of a whole pass, skip of complete talks, one talk held at a time ──
{
  const complete = talk('complete', 4, { editedMs: 50 })
  const w = world({
    talks: [talk('a', 3, { editedMs: 10 }), complete, talk('b', 2, { editedMs: 30 }), talk('c', 2, { editedMs: 1, open: true })],
    disk: new Set(complete.keys)
  })
  const p = createThumbnailPrewarm(w.deps)
  p.start()
  await idle(p)
  assert.deepEqual(w.prepared, ['c', 'b', 'a'], 'warmed open talk first, then newest edit; the complete talk was never compiled')
  assert.deepEqual(w.released, ['c', 'b', 'a'], 'every prepared talk was released')
  assert.equal(w.maxHolding, 1, 'never more than one prepared talk held at a time')
  assert.ok(w.renders.every((r) => r.paceMs === 7), 'renders carry the slide pace')
  assert.equal(p.status().talksWarmed, 3)
  assert.equal(p.status().slidesRendered, 7)
  assert.ok(w.recycles >= 1, 'the render window is let go once the pass has nothing left')
  // A second look (nudge) finds everything on disk: nothing compiled again.
  p.nudge()
  await until(() => p.status().passes >= 3, 'second pass')
  await idle(p)
  assert.deepEqual(w.prepared, ['c', 'b', 'a'], 'a complete vault compiles nothing on the next pass')
  await p.stop()
  console.log('PASS prewarm: order, cheap skip of complete talks, one talk at a time')
}

// ── yields to renders somebody is waiting for ──
{
  const w = world({ talks: [talk('t', 6)], limits: { chunkSlides: 3 } })
  let busy = true
  w.foregroundBusy = () => busy
  const p = createThumbnailPrewarm(w.deps)
  p.start()
  await until(() => p.status().state === 'waiting', 'waiting on foreground')
  assert.equal(p.status().reason, 'foreground')
  assert.deepEqual(w.prepared, [], 'nothing compiled while a foreground render is queued')
  busy = false
  // A render was asked for a moment ago: still a quiet spell to wait out.
  const askedAt = w.clock
  w.lastForegroundAt = () => askedAt
  await until(() => w.prepared.length === 1, 'prepared after the quiet spell')
  assert.ok(w.clock - askedAt >= 1000, 'waited out the quiet spell after the last foreground request')
  await idle(p)
  await p.stop()

  // Interrupted runs: the slide in hand is kept, the rest is asked again, the talk is not given up.
  const w2 = world({ talks: [talk('u', 6)], limits: { chunkSlides: 3 } })
  let cuts = 2
  w2.onRender = async () => (cuts-- > 0 ? { interrupted: true } : null)
  const p2 = createThumbnailPrewarm(w2.deps)
  p2.start()
  await idle(p2)
  assert.equal(w2.disk.size, 6, 'every picture rendered despite two interruptions')
  // Cut in before the first slide was written: no progress, but the talk is not given up.
  const w3 = world({ talks: [talk('z', 2)] })
  let early = 3
  w3.onRender = async () => (early-- > 0 ? { interrupted: true, before: true } : null)
  const p3 = createThumbnailPrewarm(w3.deps)
  p3.start()
  await idle(p3)
  assert.equal(w3.disk.size, 2, 'an interruption that wrote nothing is not taken for a slide that will not render')
  await p3.stop()
  assert.deepEqual(w2.renders[1].keys, ['u-1', 'u-2', 'u-3'], 'after an interruption only the missing slides are asked for')
  assert.deepEqual(w2.prepared, ['u'], 'an interruption does not cost a new compile')
  await p2.stop()
  console.log('PASS prewarm: waits for foreground renders and a quiet spell; interrupted runs carry on')
}

// ── pause and resume on memory pressure, and while presenting ──
{
  const w = world({ talks: [talk('m', 10)], limits: { chunkSlides: 2 } })
  let high = true
  w.memory = () => (high ? { ...calm(), mainHeapBytes: 1800 * MB } : calm())
  const p = createThumbnailPrewarm(w.deps)
  p.start()
  await until(() => p.status().state === 'waiting', 'waiting on memory')
  assert.equal(p.status().reason, 'memory:main-heap')
  assert.deepEqual(w.prepared, [], 'nothing compiled while the main heap is high')
  assert.ok(w.log.some((l) => /waiting — memory:main-heap/.test(l)), 'the wait is logged')
  high = false
  // Pressure comes back once the talk is held: it is let go, and taken up again afterwards.
  let renders = 0
  w.onRender = async () => { renders += 1; if (renders === 2) high = true; return null }
  await until(() => w.released.length === 1 && p.status().state === 'waiting', 'let go under pressure')
  assert.equal(w.holding, 0, 'nothing held while waiting for memory')
  assert.ok(w.log.some((l) => /let go of m — memory:main-heap/.test(l)))
  high = false
  await idle(p)
  assert.equal(w.disk.size, 10, 'finished after the pressure passed')
  assert.deepEqual(w.prepared, ['m', 'm'], 'compiled again only once, after letting go')
  await p.stop()

  // Presenting: nothing starts, a held talk is let go, and presenting never uses up the talk's tries.
  const w2 = world({ talks: [talk('p', 12)], limits: { chunkSlides: 2, maxPreparesPerTalk: 2 } })
  let presenting = false
  w2.presenting = () => presenting
  let n = 0
  w2.onRender = async () => { n += 1; if (n % 2 === 1 && n <= 5) presenting = true; return null }
  const p2 = createThumbnailPrewarm(w2.deps)
  p2.start()
  for (let i = 0; i < 3; i += 1) {
    await until(() => p2.status().reason === 'presenting' && w2.prepared.length === i + 1, `paused for presentation ${i + 1}`)
    assert.equal(w2.holding, 0, 'nothing held while presenting')
    const clockAt = w2.clock
    await until(() => w2.clock > clockAt + 500, 'still waiting while presenting')
    assert.equal(w2.prepared.length, i + 1, 'nothing compiled while presenting')
    presenting = false
  }
  await idle(p2)
  assert.equal(w2.disk.size, 12, 'finished after three presentations, though only two tries are allowed')
  assert.equal(w2.prepared.length, 4, 'compiled again after each presentation')
  await p2.stop()

  // A heavy talk's own weight is allowed for while it is held: it is not let go and prepared again.
  const w4 = world({ talks: [talk('heavy', 6)], limits: { chunkSlides: 2 } })
  w4.memory = () => (w4.holding > 0 ? { ...calm(), mainRssBytes: 3300 * MB, mainHeapBytes: 1600 * MB } : calm())
  const p4 = createThumbnailPrewarm(w4.deps)
  p4.start()
  await idle(p4)
  assert.deepEqual(w4.prepared, ['heavy'], 'a talk over the pause levels by its own weight renders in one preparation')
  assert.equal(w4.disk.size, 6)
  await p4.stop()
  // ... but growth beyond that weight while it is held is pressure.
  const w5 = world({ talks: [talk('grows', 6)], limits: { chunkSlides: 2 } })
  let grown = false
  w5.memory = () => (w5.holding > 0 ? { ...calm(), mainRssBytes: (grown && w5.prepared.length === 1 ? 4400 : 3300) * MB } : calm())
  w5.onRender = async () => { grown = !grown && w5.disk.size === 0; return null }
  const p5 = createThumbnailPrewarm(w5.deps)
  p5.start()
  await idle(p5)
  assert.ok(w5.log.some((l) => /let go of grows — memory:main-process/.test(l)), 'a held talk grown by more than the allowance is let go')
  assert.equal(w5.disk.size, 6)
  await p5.stop()

  // A deck that alone takes the heap past the ceiling is left after its tries, not compiled forever.
  const w3 = world({ talks: [talk('huge', 4), talk('small', 2, { editedMs: -1 })], limits: { chunkSlides: 1, maxPreparesPerTalk: 2 } })
  w3.memory = () => (w3.holding > 0 && w3.prepared.at(-1) === 'huge' ? { ...calm(), mainHeapBytes: 2100 * MB } : calm())
  const p3 = createThumbnailPrewarm(w3.deps)
  p3.start()
  await idle(p3)
  assert.deepEqual(w3.prepared, ['huge', 'small'], 'the huge talk was skipped after one preparation, then the pass went on')
  assert.ok(w3.log.some((l) => /huge left for this session/.test(l)))
  assert.equal(w3.holding, 0)
  await p3.stop()
  console.log('PASS prewarm: pauses and resumes on memory pressure and presenting, letting go of the held talk')
}

// ── review round 1: foreground, presenting inside a batch, hard ceilings, closed vault ──
{
  // 1. Foreground work arrives while a talk is held: the talk is released before any wait.
  const w = world({ talks: [talk('f', 8)], limits: { chunkSlides: 2 } })
  let busy = false
  w.foregroundBusy = () => busy
  let asked = false
  w.onRender = async () => { if (w.disk.size === 2 && !asked) { asked = true; busy = true }; return null }
  const p = createThumbnailPrewarm(w.deps)
  p.start()
  await until(() => w.released.length === 1 && p.status().state === 'waiting', 'released for foreground')
  assert.equal(w.holding, 0, 'nothing held while foreground work runs')
  const clockAt = w.clock
  await until(() => w.clock > clockAt + 500, 'still waiting on foreground')
  assert.equal(w.prepared.length, 1, 'no second talk or re-preparation beside the foreground work')
  assert.ok(w.sleptHolding.slice(-5).every((n) => n === 0), 'every wait began with the talk released')
  busy = false
  await idle(p)
  assert.equal(w.disk.size, 8)
  assert.deepEqual(w.prepared, ['f', 'f'], 're-prepared after the foreground work, at no cost to its tries')
  await p.stop()

  // ... and a hard ceiling crossed meanwhile is the reason given, not 'foreground'.
  const w1 = world({ talks: [talk('g', 6)], limits: { chunkSlides: 2 } })
  let busy1 = false
  let heap = 200 * MB
  w1.foregroundBusy = () => busy1
  w1.memory = () => ({ ...calm(), mainHeapBytes: heap })
  let asked1 = false
  w1.onRender = async () => { if (w1.disk.size === 2 && !asked1) { asked1 = true; busy1 = true; heap = 3072 * MB }; return null }
  const p1 = createThumbnailPrewarm(w1.deps)
  p1.start()
  await until(() => w1.released.length === 1, 'released')
  assert.ok(w1.log.some((l) => /let go of g — memory:main-heap/.test(l)), 'memory ceiling is checked while foreground is busy')
  heap = 200 * MB; busy1 = false
  await idle(p1)
  await p1.stop()

  // 2. Presenting starts after slide 2 of 20: at most one more slide.
  const w2 = world({ talks: [talk('pr', 20)] })
  let presenting = false
  w2.presenting = () => presenting
  w2.afterSlide = () => { if (w2.disk.size === 2) presenting = true }
  const p2 = createThumbnailPrewarm(w2.deps)
  p2.start()
  await until(() => p2.status().reason === 'presenting', 'paused')
  assert.ok(w2.disk.size <= 3, `presenting stopped the batch inside it (${w2.disk.size} slides)`)
  assert.equal(w2.holding, 0)
  presenting = false
  await idle(p2)
  assert.equal(w2.disk.size, 20)
  await p2.stop()

  // 2b. Memory crossing a gate inside a batch stops it too.
  const w2b = world({ talks: [talk('mb', 20)] })
  let high = false
  w2b.memory = () => ({ ...calm(), mainHeapBytes: high ? 3 * 1024 * MB : 200 * MB })
  w2b.afterSlide = () => { if (w2b.disk.size === 4) high = true }
  const p2b = createThumbnailPrewarm(w2b.deps)
  p2b.start()
  await until(() => p2b.status().reason === 'memory:main-heap', 'paused on memory')
  assert.ok(w2b.disk.size <= 5, `memory gate stopped the batch inside it (${w2b.disk.size})`)
  high = false
  await idle(p2b)
  await p2b.stop()

  // 3. Absolute ceilings with a baseline taken after preparing (reviewer's numbers).
  const w3 = world({ talks: [talk('big', 6)], limits: { chunkSlides: 2 } })
  const GB = 1024 * MB
  w3.memory = () => (w3.holding > 0 ? { ...calm(), mainRssBytes: 20 * GB, appBytes: 24 * GB } : calm())
  const p3 = createThumbnailPrewarm(w3.deps)
  p3.start()
  await idle(p3)
  assert.equal(w3.disk.size, 0, 'a talk whose preparation alone is past the ceilings renders nothing')
  assert.deepEqual(w3.prepared, ['big'], 'and is skipped, not prepared again')
  assert.equal(w3.holding, 0)
  await p3.stop()
  // Growth to a ceiling after a normal baseline is let go at once.
  const w3b = world({ talks: [talk('gr', 6)], limits: { chunkSlides: 2 } })
  let rss = 3300 * MB
  w3b.memory = () => (w3b.holding > 0 ? { ...calm(), mainRssBytes: rss } : calm())
  w3b.onRender = async () => { if (w3b.prepared.length === 1) rss = 4200 * MB; return null }
  const p3b = createThumbnailPrewarm(w3b.deps)
  p3b.start()
  await until(() => w3b.released.length >= 1, 'released at the ceiling')
  assert.ok(w3b.log.some((l) => /let go of gr — memory:main-process/.test(l)))
  rss = 3300 * MB
  await idle(p3b)
  await p3b.stop()

  // 4. The vault is closed mid-talk: stop between slides, release, write nothing further.
  const w4 = world({ talks: [talk('v', 20)] })
  let open = true
  w4.alive = () => open
  w4.afterSlide = () => { if (w4.disk.size === 2) open = false }
  const p4 = createThumbnailPrewarm(w4.deps)
  p4.start()
  await idle(p4)
  assert.ok(w4.disk.size <= 3, `closing the vault stopped the talk (${w4.disk.size} slides)`)
  assert.equal(w4.holding, 0, 'released at once')
  assert.deepEqual(w4.prepared, ['v'], 'not prepared again')
  const sizeAt = w4.disk.size
  p4.nudge()
  await until(() => p4.status().passes >= 3, 'next pass')
  await idle(p4)
  assert.equal(w4.disk.size, sizeAt, 'nothing further written')
  await p4.stop()
  console.log('PASS prewarm: foreground releases the talk, batches yield, hard ceilings apply, a closed vault stops the talk')
}

// Every non-prewarm background caller releases before queueing or compiling. Exercise both a
// held render and a request during our compile: the latter must drop the incoming result first.
for (const caller of ['background', 'variant', 'share']) for (const duringPrepare of [false, true]) {
  const w = world({ talks: [talk('background-release', 4)] })
  let p
  let announcements = 0
  const gate = createSingleFlight({ beforeRequest: () => { announcements += 1; p.releaseNow() } })
  const cache = createPreparedTalkCache({ maxEntries: 1, maxBytes: 1000, sizeOf: () => 1 })
  const route = createPreparationRoute(cache, gate)
  let request
  let requested = false
  let compiled = false
  const ask = () => {
    if (requested) return
    requested = true
    const compile = async () => {
      assert.equal(w.holding, 0, `${caller}: no prewarm deck held when compiling`)
      compiled = true
      return caller
    }
    request = caller === 'variant'
      ? route('variant', 'variant', 'talk', (gated) => gated(compile))
      : caller === 'share' ? buildInGate(gate, undefined, compile) : gate.background(compile)
    assert.equal(announcements, 1, `${caller}: release runs before the request returns`)
    assert.equal(w.holding, 0, `${caller}: held deck released synchronously`)
  }
  const realPrepare = w.deps.prepare
  w.deps.prepare = (t) => route('prewarm', t.slug, 'talk', (gated) => gated(async () => {
    if (duringPrepare) ask()
    return realPrepare(t)
  }))
  if (!duringPrepare) w.afterSlide = ask
  p = createThumbnailPrewarm(w.deps)
  p.start()
  await until(() => compiled, `${caller}: background compile started`)
  assert.equal(await request, caller)
  await idle(p)
  assert.equal(announcements, 1, `${caller}: prewarm's own preparations never announce themselves`)
  assert.equal(w.disk.size, 4, `${caller}: prewarm resumes and finishes`)
  assert.equal(w.holding, 0)
  assert.equal(w.prepared.length, 2, `${caller}: interrupted deck prepared again`)
  await p.stop()
}
console.log('PASS prewarm: background, variant and share requests release held or incoming decks; own preparations do not')

// ── review round 2: the preparation gate releases the held talk first; app-wide pressure is not the talk's ──
{
  const GB = 1024 * MB
  // 1. A foreground preparation through the REAL gate while a talk is held mid-render.
  const w = world({ talks: [talk('h', 8)], limits: { chunkSlides: 4 } })
  let p
  const gate = createSingleFlight({ beforeRequest: () => p.releaseNow() })
  const realPrepare = w.deps.prepare
  w.deps.prepare = (t) => gate.prewarm(() => realPrepare(t))
  let fgHolding = null
  let fgDisk = 0
  let fg = null
  w.afterSlide = () => {
    if (fg || w.disk.size !== 2) return
    fg = gate(async () => { fgHolding = w.holding; fgDisk = w.disk.size; return 'compiled' })
  }
  p = createThumbnailPrewarm(w.deps)
  p.start()
  await until(() => fgHolding !== null, 'foreground compile started')
  assert.equal(fgHolding, 0, 'when the foreground compile starts the prewarm holds no deck')
  assert.equal(await fg, 'compiled')
  assert.ok(w.cancels >= 1, 'the prewarm\'s render was cancelled')
  assert.ok(fgDisk <= 3, 'no further slides rendered once the gate was asked')
  await idle(p)
  assert.equal(w.disk.size, 8, 'the talk finished afterwards, prepared again')
  assert.equal(w.prepared.length, 2)
  await p.stop()

  // 1b. A foreground request that arrives while the prewarm's own compile runs: the result is dropped.
  const wb = world({ talks: [talk('k', 4)] })
  let pb
  const gateB = createSingleFlight({ beforeRequest: () => pb.releaseNow() })
  let fgB = null
  let fgHoldingB = null
  let asked = false
  wb.deps.prepare = async (t) => {
    wb.prepared.push(t.slug)
    await gateB.prewarm(async () => {
      if (!asked) { asked = true; fgB = gateB(async () => { fgHoldingB = wb.holding }) }
      await new Promise((r) => setImmediate(r))
    })
    wb.holding += 1
    let released = false
    return { slides: t.keys.map((key, index) => ({ key, cacheKey: `doc-${key}`, index })), release: () => { if (!released) { released = true; wb.holding -= 1; wb.released.push(t.slug) } } }
  }
  pb = createThumbnailPrewarm(wb.deps)
  pb.start()
  await until(() => fgHoldingB !== null, 'foreground ran')
  assert.equal(fgHoldingB, 0, 'nothing held when it ran')
  await idle(pb)
  assert.equal(wb.disk.size, 4)
  assert.equal(wb.holding, 0)
  await pb.stop()

  // 2. Temporary app-wide pressure (not the talk's own) defers the talk; it renders once it clears.
  const w2 = world({ talks: [talk('t', 4)], limits: { chunkSlides: 2 } })
  let pressure = false
  let spiked = false
  w2.memory = () => (pressure ? { ...calm(), appBytes: 11 * GB } : calm())
  w2.deps.prepare = ((orig) => async (t) => { const d = await orig(t); if (!spiked) { spiked = true; pressure = true }; return d })(w2.deps.prepare)
  const p2 = createThumbnailPrewarm(w2.deps)
  p2.start()
  await until(() => w2.released.length >= 1 && p2.status().state === 'waiting', 'released under pressure')
  assert.equal(w2.disk.size, 0)
  assert.ok(!w2.log.some((l) => /left for this session/.test(l)), 'not excluded for the session')
  pressure = false
  await idle(p2)
  assert.equal(w2.disk.size, 4, 'rendered after the pressure cleared')
  await p2.stop()

  // 2b. The talk's own growth of the main process past the ceiling still leaves it.
  const w3 = world({ talks: [talk('own', 4)] })
  w3.memory = () => (w3.holding > 0 ? { ...calm(), mainRssBytes: 4.5 * GB, appBytes: 5 * GB } : calm())
  const p3 = createThumbnailPrewarm(w3.deps)
  p3.start()
  await idle(p3)
  assert.ok(w3.log.some((l) => /own left for this session/.test(l)))
  assert.deepEqual(w3.prepared, ['own'])
  await p3.stop()
  console.log('PASS prewarm: gate releases the held talk first; shared pressure defers instead of excluding')
}

// ── render window recycle ──
{
  const w = world({ talks: [talk('r', 50)], limits: { chunkSlides: 5, recycleEverySlides: 20 } })
  const recycledAt = []
  w.deps.recycleRenderer = () => { recycledAt.push(w.disk.size); return true }
  const p = createThumbnailPrewarm(w.deps)
  p.start()
  await idle(p)
  // During the talk: at 20 and 40 slides; then once more when the pass ends.
  assert.deepEqual(recycledAt, [20, 40, 50], 'the window is closed every 20 slides and when the pass ends')
  assert.equal(p.status().recycles, 2)
  await p.stop()

  const w2 = world({ talks: [talk('s', 6)], limits: { chunkSlides: 2, recycleEverySlides: 1000, recycleRendererBytes: 1000 * MB } })
  let big = false
  w2.memory = () => ({ ...calm(), rendererBytes: big ? 1200 * MB : 100 * MB })
  w2.onRender = async () => { big = true; return null }
  const at = []
  w2.deps.recycleRenderer = () => { at.push(w2.disk.size); big = false; return true }
  const p2 = createThumbnailPrewarm(w2.deps)
  p2.start()
  await idle(p2)
  assert.deepEqual(at.slice(0, 2), [2, 4], 'a renderer grown past the limit is closed before the next run')
  await p2.stop()
  console.log('PASS prewarm: render window recycled by slide count and by renderer size')
}

// ── restart: the files are the record ──
{
  const disk = new Set()
  const talks = [talk('x', 10), talk('y', 4, { editedMs: -1 })]
  const w = world({ talks, disk, limits: { chunkSlides: 2 } })
  let stopAfter = 3
  let first
  w.onRender = async () => { if (--stopAfter === 0) void first.stop(); return null }
  first = createThumbnailPrewarm(w.deps)
  first.start()
  await until(() => first.status().state === 'stopped', 'first session stopped')
  const before = new Set(disk)
  assert.ok(before.size > 0 && before.size < 14, `first session left partial work (${before.size})`)
  const w2 = world({ talks, disk, limits: { chunkSlides: 2 } })
  const second = createThumbnailPrewarm(w2.deps)
  second.start()
  await idle(second)
  assert.equal(disk.size, 14, 'everything rendered after the restart')
  const asked = w2.renders.flatMap((r) => r.keys)
  assert.ok(asked.every((k) => !before.has(k)), 'nothing already on disk was rendered again')
  assert.equal(asked.length, 14 - before.size)
  await second.stop()
  console.log('PASS prewarm: resumes after a restart without redoing work')
}

// ── stop on quit ──
{
  const w = world({ talks: [talk('q', 20), talk('later', 3, { editedMs: -5 })], limits: { chunkSlides: 4 } })
  let release
  let p
  w.onRender = () => new Promise((r) => { release = r })
  p = createThumbnailPrewarm(w.deps)
  p.start()
  await until(() => typeof release === 'function', 'render in flight')
  const stopping = p.stop()
  assert.equal(w.cancels, 1, 'the render in flight is cancelled')
  release({ interrupted: true })
  await stopping
  assert.equal(p.status().state, 'stopped')
  assert.equal(w.holding, 0, 'the held talk is released on stop')
  assert.deepEqual(w.prepared, ['q'], 'nothing further is compiled after stop')
  p.start()
  await new Promise((r) => setImmediate(r))
  assert.deepEqual(w.prepared, ['q'], 'a stopped prewarm does not start again')
  console.log('PASS prewarm: stops cleanly on quit')
}

// ── a slide that never renders is left, not retried forever; a failing compile never stops the pass ──
{
  const w = world({ talks: [talk('stuck', 3), talk('broken', 2, { editedMs: -1 }), talk('fine', 2, { editedMs: -2 })], bad: new Set(['stuck-1']) })
  const prepare = w.deps.prepare
  w.deps.prepare = async (t) => { if (t.slug === 'broken') throw new Error('bad outline'); return prepare(t) }
  const p = createThumbnailPrewarm(w.deps)
  p.start()
  await idle(p)
  assert.ok(w.disk.has('stuck-0') && w.disk.has('stuck-2') && !w.disk.has('stuck-1'))
  assert.ok(w.disk.has('fine-0') && w.disk.has('fine-1'), 'the pass went on past the broken talk')
  p.nudge()
  await until(() => p.status().passes >= 3, 'next pass')
  await idle(p)
  assert.equal(w.prepared.filter((s) => s === 'stuck').length, 1, 'the stuck talk is not compiled again this session')
  assert.equal(w.prepared.filter((s) => s === 'broken').length, 0, 'the broken talk is not tried again this session')
  // An edit (new editedMs) makes it worth one more try.
  w.talks = w.talks.map((t) => (t.slug === 'stuck' ? { ...t, editedMs: 99 } : t))
  p.nudge()
  await until(() => w.prepared.filter((s) => s === 'stuck').length === 2, 'retried after an edit')
  await idle(p)
  await p.stop()
  console.log('PASS prewarm: unrenderable slides and failing compiles are left for the session')
}

// Guard the main-process wiring: the prewarm must not release itself through the variant lane.
{
  const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const wiring = main.slice(main.indexOf('const thumbnailPrewarm = createThumbnailPrewarm('), main.indexOf('// Test runs leave the prewarm off'))
  assert.match(wiring, /prepareTalk\(talk\.outlinePath, content, undefined, mediaOptions, 'prewarm'\)/, 'main prewarm uses the prewarm preparation lane')
  assert.match(wiring, /foregroundBusy:.*preparePass\.foregroundBusy\(\)/, 'main prewarm observes the counted compile scope')
}

// Direct exports block the loop without entering the gate; held decks release before fn starts.
{
  const w = world({ talks: [talk('scope', 3)] })
  let p
  const gate = createSingleFlight({ beforeRequest: () => p.releaseNow() })
  w.foregroundBusy = () => gate.foregroundBusy()
  p = createThumbnailPrewarm(w.deps)
  let finish
  const foreground = gate.withPrewarmYield(() => new Promise((resolve) => { finish = resolve }))
  p.start()
  await until(() => p.status().reason === 'foreground', 'direct compile blocks prewarm')
  assert.deepEqual(w.prepared, [], 'prewarm starts no compile while a direct compile is busy')
  let duringRender
  w.onRender = () => {
    w.onRender = null
    duringRender = gate.withPrewarmYield(async () => {
      assert.equal(w.holding, 0, 'held prewarm deck released before direct compile fn')
      assert.equal(gate.foregroundBusy(), true)
      await new Promise((resolve) => { finish = resolve })
      throw Error('direct compile failed')
    })
    duringRender.catch(() => {})
    return { interrupted: true, before: true }
  }
  finish()
  await foreground
  await until(() => duringRender && p.status().reason === 'foreground', 'interrupted prewarm waits on compile')
  const prepared = w.prepared.length
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(w.prepared.length, prepared, 'prewarm cannot resume while the counter is positive')
  finish()
  await assert.rejects(duringRender, /direct compile failed/)
  assert.equal(gate.foregroundBusy(), false)
  await idle(p)
  await p.stop()
  assert.equal(w.disk.size, 3, 'prewarm finishes after the failed compile clears its scope')
  console.log('PASS prewarm: direct compile scopes block start/resume and release held decks synchronously')
}

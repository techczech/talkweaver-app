#!/usr/bin/env node
/**
 * "A thumbnail render never inlines video, and never keeps a deck it no longer needs."
 *
 * The installed 0.31.0-preview.7 died twice on 2026-09-15 (07:04 after four hours, 07:23 after
 * nineteen minutes) with the main process at 3.8-3.9GB against a MEASURED 4096MB V8 ceiling. The
 * Slide Browser's background sweep was walking all 84 vault talks, preparing each one with the
 * standing media defaults: every video under 20MB base64-inlined, images unbounded. The heaviest
 * deck carries 44MB of images and 102MB in 25 videos, so its fullHtml was a 200+MB string, copied
 * for the preview mark, hashed, written, and then RETAINED by the prepared-talk cache as its "one
 * oversized current document" — while the editor lane could be inlining a second deck beside it.
 *
 * These are the decisions that fix it, each pinned where it can actually fail.
 */
import { strict as assert } from 'node:assert'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const adapters = await import(
  pathToFileURL(join(process.cwd(), 'compiler/scripts/lib/08-source-adapters.mjs')).href
)
const { THUMBNAIL_MEDIA_OPTIONS, BACKUP_EXPORT_MEDIA_OPTIONS, createMediaInlineBudget } = adapters
const {
  BROWSER_THUMBNAIL_LANE,
  THUMBNAIL_HEAP_GUARD_BYTES,
  THUMBNAIL_HEAP_WAIT_INTERVAL_MS,
  THUMBNAIL_HEAP_WAIT_MAX_MS,
  heapGuardDecision,
  thumbnailMediaOptions,
  waitForHeap
} = await import('../src/main/thumbnail-media-policy.ts')
const { createPreparedTalkCache, preparedTalkGroup } = await import('../src/main/prepared-talk-cache.ts')

const MB = 1024 * 1024
let failures = 0
const settled = []
const pass = (name) => console.log(`ok   ${name}`)
const fail = (name, error) => { failures++; console.error(`FAIL ${name}\n     ${error?.message ?? error}`) }
function check(name, fn) {
  try {
    const result = fn()
    if (result && typeof result.then === 'function') {
      settled.push(result.then(() => pass(name), (error) => fail(name, error)))
    } else pass(name)
  } catch (error) { fail(name, error) }
}

// ── 1. The contract itself ──────────────────────────────────────────────────────────────────
check('the thumbnail media contract never inlines video and never bounds images', () => {
  assert.equal(THUMBNAIL_MEDIA_OPTIONS.videoInlineLimitBytes, 0, 'a thumbnail shows a poster, never a clip')
  assert.equal(THUMBNAIL_MEDIA_OPTIONS.largeMediaMode, 'poster', 'a refused video falls back to its poster')
  assert.equal(
    THUMBNAIL_MEDIA_OPTIONS.mediaInlineBudgetBytes,
    undefined,
    'images stay unbounded — a thumbnail whose pictures are missing is not a thumbnail'
  )
  assert.throws(() => { THUMBNAIL_MEDIA_OPTIONS.videoInlineLimitBytes = 20 * MB }, 'the contract is frozen')
  assert.notEqual(
    THUMBNAIL_MEDIA_OPTIONS.mediaInlineBudgetBytes,
    BACKUP_EXPORT_MEDIA_OPTIONS.mediaInlineBudgetBytes,
    'the thumbnail and backup contracts are separate: a backup caps images, a thumbnail must not'
  )
})

// ── 2. The budget the compiler builds from it ───────────────────────────────────────────────
check('the thumbnail budget refuses every video and allows every image', () => {
  const budget = createMediaInlineBudget(THUMBNAIL_MEDIA_OPTIONS)
  assert.equal(budget.allowsVideo(1), false, 'not one byte of video may be inlined into a thumbnail render')
  assert.equal(budget.allowsVideo(0), false, 'a zero-byte video is refused too — the mode is "never"')
  assert.equal(budget.allowsVideo(102 * MB), false, 'the 102MB of clips in the heaviest deck stay out')
  assert.equal(budget.allowsImage(1), true, 'images are inlined')
  assert.equal(budget.allowsImage(44 * MB), true, 'including the 44MB of images in the heaviest deck')
  assert.equal(budget.bounded, false, 'no per-deck ceiling, so no extra stat() per image')
  assert.equal(budget.largeMediaMode, 'poster', 'a refused video renders its poster frame')
})

check('the standing defaults are untouched — Present and preview still inline video', () => {
  const budget = createMediaInlineBudget({})
  assert.equal(budget.allowsVideo(12 * MB), true, 'the present/preview/publish path keeps the 20MB default')
  assert.equal(budget.bounded, false, 'and no deck budget')
})

// ── 3. Which lane compiles under which contract ─────────────────────────────────────────────
check('the browser lane resolves to the thumbnail contract, the editor lane to the defaults', () => {
  assert.equal(BROWSER_THUMBNAIL_LANE, 'browser', "SlideBrowser.tsx sends { lane: 'browser' }")
  assert.equal(
    thumbnailMediaOptions(BROWSER_THUMBNAIL_LANE, THUMBNAIL_MEDIA_OPTIONS),
    THUMBNAIL_MEDIA_OPTIONS,
    'the background sweep gets the video-free contract'
  )
  // The editor lane sends no lane at all. It must keep the standing model so talk:compile and the
  // thumbnail request that follows it share ONE preparation — a second contract here would mean a
  // second full-deck inline per edit pause, which is the opposite of the fix.
  assert.equal(thumbnailMediaOptions('', THUMBNAIL_MEDIA_OPTIONS), undefined, 'the editor lane keeps the defaults')
  assert.equal(thumbnailMediaOptions(undefined, THUMBNAIL_MEDIA_OPTIONS), undefined, 'so does an absent lane')
  assert.equal(thumbnailMediaOptions('editor', THUMBNAIL_MEDIA_OPTIONS), undefined, 'and any other lane')
})

// ── 4. The heap guard's decision ────────────────────────────────────────────────────────────
check('the heap guard skips at or above the threshold and proceeds below it', () => {
  assert.equal(THUMBNAIL_HEAP_GUARD_BYTES, 2048 * MB, 'half the measured 4096MB main-process ceiling')
  assert.equal(heapGuardDecision(THUMBNAIL_HEAP_GUARD_BYTES).skip, true, 'exactly at the threshold is a skip')
  assert.equal(heapGuardDecision(THUMBNAIL_HEAP_GUARD_BYTES + 1).skip, true, 'above it is a skip')
  assert.equal(heapGuardDecision(THUMBNAIL_HEAP_GUARD_BYTES - 1).skip, false, 'below it proceeds')
  assert.equal(heapGuardDecision(300 * MB).skip, false, 'a healthy heap proceeds')
  // 3.8GB is where the process actually died. It must never reach a prepare.
  assert.equal(heapGuardDecision(3800 * MB).skip, true, 'the heap seen in both crash reports is a skip')
  assert.equal(heapGuardDecision(1536 * MB, 1024 * MB).skip, true, 'the threshold is injectable')
  assert.equal(heapGuardDecision(1536 * MB, 4096 * MB).skip, false, 'in both directions')
  assert.equal(heapGuardDecision(1536 * MB).heapMb, 1536, 'the log line reports whole MB')
  assert.equal(heapGuardDecision(0).skip, false, 'a zero reading is not a skip')
})

// ── 4b. The guard DEFERS rather than giving up ──────────────────────────────────────────────
// preview.8: the guard returned an empty map the instant the heap was high, the Browser spent an
// attempt on it, and every card of every talk stayed schematic until relaunch. The heap comes
// down on its own — the background sweep waits for it. Clock and reader are injected, so the
// whole three minutes runs in microseconds here.
function fakeClock() {
  let t = 0
  return {
    now: () => t,
    sleep: async (ms) => { t += ms },
    advance: (ms) => { t += ms },
    at: () => t
  }
}

check('a healthy heap proceeds immediately, with no wait at all', async () => {
  const clock = fakeClock()
  const slept = []
  const result = await waitForHeap(() => 300 * MB, THUMBNAIL_HEAP_GUARD_BYTES, {
    now: clock.now,
    sleep: async (ms) => { slept.push(ms); await clock.sleep(ms) }
  })
  assert.deepEqual(slept, [], 'a heap under the threshold never sleeps')
  assert.equal(result.proceeded, true)
  assert.equal(result.waitedMs, 0)
  assert.equal(result.reads, 1, 'and reads the heap exactly once')
})

check('a high heap is waited out, then the pass proceeds', async () => {
  const clock = fakeClock()
  // 3.8GB — the reading in both crash reports — for 20 seconds, then the editor lane releases.
  const readHeapUsed = () => (clock.at() < 20_000 ? 3800 * MB : 400 * MB)
  const result = await waitForHeap(readHeapUsed, THUMBNAIL_HEAP_GUARD_BYTES, {
    now: clock.now,
    sleep: clock.sleep
  })
  assert.equal(result.proceeded, true, 'the talk is rendered, not skipped')
  assert.equal(result.waitedMs, 20_000, 'it waited exactly as long as the heap stayed high')
  assert.equal(result.reads, 5, 'polling every 5s: four high reads, then the one that cleared')
  assert.equal(result.heapMb, 400, 'the log line carries the reading that let it through')
})

check('polling is every 5 seconds and gives up after 3 minutes', async () => {
  assert.equal(THUMBNAIL_HEAP_WAIT_INTERVAL_MS, 5_000)
  assert.equal(THUMBNAIL_HEAP_WAIT_MAX_MS, 180_000)
  const clock = fakeClock()
  const slept = []
  const result = await waitForHeap(() => 3800 * MB, THUMBNAIL_HEAP_GUARD_BYTES, {
    now: clock.now,
    sleep: async (ms) => { slept.push(ms); await clock.sleep(ms) }
  })
  assert.equal(result.proceeded, false, 'a heap that never comes down ends the pass')
  assert.equal(result.waitedMs, THUMBNAIL_HEAP_WAIT_MAX_MS, 'after exactly three minutes')
  assert.equal(slept.length, THUMBNAIL_HEAP_WAIT_MAX_MS / THUMBNAIL_HEAP_WAIT_INTERVAL_MS, '36 sleeps')
  assert.deepEqual(new Set(slept), new Set([5_000]), 'each one five seconds long')
  assert.equal(result.reads, 37, 'one read per poll plus the first')
})

check('the wait window and interval are injectable, and never overshoot the window', async () => {
  const clock = fakeClock()
  const slept = []
  const result = await waitForHeap(() => 3800 * MB, THUMBNAIL_HEAP_GUARD_BYTES, {
    intervalMs: 400,
    maxMs: 1000,
    now: clock.now,
    sleep: async (ms) => { slept.push(ms); await clock.sleep(ms) }
  })
  assert.equal(result.proceeded, false)
  assert.deepEqual(slept, [400, 400, 200], 'the last sleep is clipped to the end of the window')
  assert.equal(result.waitedMs, 1000, 'so the wait is never longer than it promised')
})

check('a heap that clears on the very last poll still proceeds', async () => {
  const clock = fakeClock()
  const readHeapUsed = () => (clock.at() < 180_000 ? 3800 * MB : 100 * MB)
  const result = await waitForHeap(readHeapUsed, THUMBNAIL_HEAP_GUARD_BYTES, {
    now: clock.now,
    sleep: clock.sleep
  })
  assert.equal(result.proceeded, true, 'the threshold is checked before the window is judged expired')
  assert.equal(result.waitedMs, 180_000)
})

// ── 5. The options are part of the prepared-cache identity ──────────────────────────────────
check('the same content prepared under different media options is a different cache entry', () => {
  const path = '/vault/heavy/heavy-outline.md'
  const full = preparedTalkGroup(path, undefined, undefined)
  const thumb = preparedTalkGroup(path, undefined, THUMBNAIL_MEDIA_OPTIONS)
  assert.notEqual(full, thumb, 'a video-free model must never be served to compile, Present or the Inspector')
  assert.equal(preparedTalkGroup(path, undefined, THUMBNAIL_MEDIA_OPTIONS), thumb, 'and the key is stable')
  assert.notEqual(
    preparedTalkGroup(path, { timerMinutes: 20 }, THUMBNAIL_MEDIA_OPTIONS),
    thumb,
    'defaults still separate groups as well'
  )
  assert.notEqual(preparedTalkGroup('/vault/other/other-outline.md', undefined, undefined), full, 'so does the path')
})

check('two lanes on one talk prepare separately and neither is served the other model', async () => {
  const cache = createPreparedTalkCache({ maxEntries: 4, maxBytes: 1024, sizeOf: (v) => v.length * 2 })
  const path = '/vault/heavy/heavy-outline.md'
  const editorGroup = preparedTalkGroup(path, undefined, undefined)
  const browserGroup = preparedTalkGroup(path, undefined, THUMBNAIL_MEDIA_OPTIONS)
  const editor = await cache.get(editorGroup + '\0h', editorGroup, async () => 'with-video')
  const browser = await cache.get(browserGroup + '\0h', browserGroup, async () => 'no-video')
  assert.equal(editor, 'with-video')
  assert.equal(browser, 'no-video')
  assert.equal(
    await cache.get(editorGroup + '\0h', editorGroup, async () => 'recompiled'),
    'with-video',
    'the editor entry survives the browser lane beside it'
  )
})

// ── 6. The browser lane pins nothing after it returns ───────────────────────────────────────
check('evicting a group releases its retained deck and its bytes', async () => {
  const cache = createPreparedTalkCache({ maxEntries: 4, maxBytes: 1024, sizeOf: (v) => v.length * 2 })
  const path = '/vault/heavy/heavy-outline.md'
  const browserGroup = preparedTalkGroup(path, undefined, THUMBNAIL_MEDIA_OPTIONS)
  await cache.get(browserGroup + '\0h', browserGroup, async () => 'x'.repeat(100))
  assert.equal(cache.stats().entries, 1, 'the prepared deck is retained while the render runs')
  assert.equal(cache.stats().bytes, 200)
  cache.evict(browserGroup)
  assert.deepEqual(cache.stats(), { entries: 0, bytes: 0, pending: 0 }, 'and nothing is kept afterwards')
  // Evicted, not poisoned: a later pass over the same talk still prepares it.
  let prepared = 0
  await cache.get(browserGroup + '\0h', browserGroup, async () => { prepared++; return 'again' })
  assert.equal(prepared, 1, 'the next pass prepares the talk again rather than failing')
  cache.evict(browserGroup)
  cache.evict(browserGroup)
  assert.equal(cache.stats().entries, 0, 'evicting twice, or an unknown group, is harmless')
  cache.evict('never-seen')
})

check('an evicted group does not take the other lane down with it', async () => {
  const cache = createPreparedTalkCache({ maxEntries: 4, maxBytes: 1024 * 1024, sizeOf: (v) => v.length * 2 })
  const path = '/vault/heavy/heavy-outline.md'
  const editorGroup = preparedTalkGroup(path, undefined, undefined)
  const browserGroup = preparedTalkGroup(path, undefined, THUMBNAIL_MEDIA_OPTIONS)
  await cache.get(editorGroup + '\0h', editorGroup, async () => 'editor-model')
  await cache.get(browserGroup + '\0h', browserGroup, async () => 'browser-model')
  cache.evict(browserGroup)
  assert.equal(cache.stats().entries, 1, 'only the browser lane entry goes')
  assert.equal(
    await cache.get(editorGroup + '\0h', editorGroup, () => { throw new Error('the editor model was evicted') }),
    'editor-model'
  )
})

await Promise.all(settled)

if (failures) {
  console.error(`\n${failures} thumbnail-media-policy check(s) failed`)
  process.exit(1)
}
console.log('\nthumbnail media policy: all checks passed')

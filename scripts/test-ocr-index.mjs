// The image-text index scheduler (src/main/ocr-index.ts) with the native helper, disk and clock stubbed:
// on by default is the caller's setting (isEnabled), background work obeys it, the manual run ignores it,
// a failing chunk is split, a bad picture is recorded at its mtime and left alone until the file changes,
// svg is read without the helper, one helper at a time; a picture is read only from a real path inside
// the vault it was queued with; a short batch retries its pictures; the pass yields to the event loop.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync, statSync, utimesSync, renameSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOcrIndex, readSvgFile, SVG_MAX_BYTES, TOO_LARGE, CHANGED } from '../src/main/ocr-index.ts'

let passed = 0
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok  ${name}`) }

function rig({ enabled = true, bad = new Set(), crashOnBad = true, svg = {} } = {}) {
  const mtimes = new Map()
  const calls = []
  let active = 0, maxActive = 0
  let saved = null
  const timers = []
  const state = { enabled, helper: true }
  const ocr = createOcrIndex({
    loadCache: () => null,
    saveCache: (c) => { saved = c },
    mtimeOf: (p) => (mtimes.has(p) ? mtimes.get(p) : null),
    runHelper: async (paths) => {
      calls.push(paths)
      active += 1; maxActive = Math.max(maxActive, active)
      await new Promise((r) => setImmediate(r))
      active -= 1
      const hasBad = paths.some((p) => bad.has(p))
      const good = paths.filter((p) => !bad.has(p))
      // A bad picture takes the helper down: whatever it had printed before is all there is.
      const upto = hasBad && crashOnBad ? good.slice(0, paths.indexOf(paths.find((p) => bad.has(p)))) : good
      return { stdout: upto.map((p) => JSON.stringify({ p, t: 'text of ' + p })).join('\n'), ok: !(hasBad && crashOnBad) }
    },
    readText: async (p) => (p in svg ? svg[p] : null),
    containedPath: (_root, p) => p, identityOf: () => 'same',
    helperAvailable: () => state.helper,
    isEnabled: () => state.enabled,
    chunkSize: 4,
    debounceMs: 10,
    persistMs: 10,
    setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t },
    clearTimer: (t) => { if (t) t.live = false }
  })
  const fire = () => { for (const t of timers.splice(0)) if (t.live) t.fn() }
  return { ocr, mtimes, calls, state, fire, saved: () => saved, maxActive: () => maxActive }
}
const files = (r, n, prefix = '/v/a') => { const out = []; for (let i = 0; i < n; i++) { const p = `${prefix}${i}.png`; r.mtimes.set(p, 100 + i); out.push(p) } return out }
// Pictures as the index takes them: each with the vault root it belongs to.
const pics = (paths, root = '/v') => paths.map((path) => ({ path, root }))

await test('background queue reads new pictures after the debounce, in chunks, never two helpers at once', async () => {
  const r = rig(); const p = files(r, 9)
  r.ocr.queue(pics(p))
  assert.equal(r.calls.length, 0, 'nothing runs before the debounce fires (never inline)')
  r.fire(); await r.ocr.idle()
  assert.deepEqual(r.calls.map((c) => c.length), [4, 4, 1])
  assert.equal(r.ocr.textLower(p[0]), 'text of /v/a0.png')
  assert.equal(r.maxActive(), 1)
  assert.equal(r.ocr.entry(p[2]).mtimeMs, 102)
})

await test('background work obeys the setting; the manual run does not', async () => {
  const r = rig({ enabled: false }); const p = files(r, 3)
  r.ocr.queue(pics(p)); r.fire(); await r.ocr.idle()
  assert.equal(r.calls.length, 0, 'setting off: nothing queued')
  const counts = await r.ocr.runNow(pics(p))
  assert.deepEqual(counts, { total: 3, read: 3, known: 0, failed: 0, skipped: 0 })
  const again = await r.ocr.runNow(pics(p))
  assert.deepEqual(again, { total: 3, read: 0, known: 3, failed: 0, skipped: 0 }, 'real numbers: already known')
  r.state.enabled = true; r.ocr.queue(pics(p)); assert.equal(r.calls.length, 1, 'known pictures are not queued again')
})

await test('turning the setting off mid-queue drops the pending work', async () => {
  const r = rig(); const p = files(r, 3)
  r.ocr.queue(pics(p)); r.state.enabled = false; r.fire(); await r.ocr.idle()
  assert.equal(r.calls.length, 0)
})

await test('a changed mtime re-queues the picture; an unchanged one does not', async () => {
  const r = rig(); const p = files(r, 2)
  await r.ocr.runNow(pics(p))
  assert.equal(r.ocr.needs(p[0]), false)
  r.mtimes.set(p[0], 999)
  assert.equal(r.ocr.needs(p[0]), true)
  assert.equal(r.ocr.needs('/v/gone.png'), false, 'a file that is gone needs nothing')
  const g = r.ocr.generation()
  const counts = await r.ocr.runNow(pics(p))
  assert.deepEqual(counts, { total: 2, read: 1, known: 1, failed: 0, skipped: 0 })
  assert.ok(r.ocr.generation() > g, 'a changed entry raises the generation')
})

await test('a failing chunk is split: one bad picture does not drop the good ones, and it is recorded at its mtime', async () => {
  const badPath = '/v/a2.png'
  const r3 = rig({ bad: new Set([badPath]) }); const q = files(r3, 4)
  const counts = await r3.ocr.runNow(pics(q))
  assert.equal(counts.read, 3, 'the three good pictures are read')
  assert.equal(counts.failed, 1)
  assert.ok(r3.calls.length > 1, 'the chunk was retried in pieces')
  for (const g of q.filter((x) => x !== badPath)) assert.equal(r3.ocr.textLower(g), 'text of ' + g)
  const e = r3.ocr.entry(badPath)
  assert.equal(e.failed, true); assert.equal(e.mtimeMs, r3.mtimes.get(badPath), 'failure recorded with the mtime')
  assert.equal(r3.ocr.textLower(badPath), '')
  const callsBefore = r3.calls.length
  assert.equal(r3.ocr.needs(badPath), false)
  const again = await r3.ocr.runNow(pics(q))
  assert.deepEqual(again, { total: 4, read: 0, known: 4, failed: 0, skipped: 0 })
  assert.equal(r3.calls.length, callsBefore, 'not retried until the file changes')
  r3.mtimes.set(badPath, 5000)
  assert.equal(r3.ocr.needs(badPath), true, 'a changed file is tried again')
})

await test('a large chunk with one bad picture costs few helper runs and reads all the others', async () => {
  const b = rig({ bad: new Set(['/v/a37.png']) })
  const r = createOcrIndexFor(b, 80)
  const p = files(b, 80)
  const counts = await r.runNow(pics(p))
  assert.equal(counts.read, 79); assert.equal(counts.failed, 1)
  assert.ok(b.calls.length <= 2 + 2 * Math.ceil(Math.log2(80)) + 2, 'splitting halves the chunk: logarithmic, not 80 single runs: ' + b.calls.length)
})
function createOcrIndexFor(b, chunkSize) {
  return createOcrIndex({
    loadCache: () => null, saveCache: () => {}, mtimeOf: (p) => (b.mtimes.has(p) ? b.mtimes.get(p) : null),
    runHelper: async (paths) => { b.calls.push(paths); const bad = paths.includes('/v/a37.png'); const good = paths.filter((x) => x !== '/v/a37.png'); return { stdout: (bad ? good.slice(0, paths.indexOf('/v/a37.png')) : good).map((p) => JSON.stringify({ p, t: 't' })).join('\n'), ok: !bad } },
    readText: async () => null, containedPath: (_r, p) => p, identityOf: () => 'same', helperAvailable: () => true, isEnabled: () => true, chunkSize
  })
}

await test('a clean exit that skips a picture records that picture as failed', async () => {
  const r = rig({ bad: new Set(['/v/a1.png']), crashOnBad: false }); const p = files(r, 3)
  const counts = await r.ocr.runNow(pics(p))
  assert.deepEqual(counts, { total: 3, read: 2, failed: 1, known: 0, skipped: 0 })
})

await test('svg text is read directly, no helper, and cached like any other', async () => {
  const r = rig({ svg: { '/v/d.svg': '<svg><text>Quarterly <tspan>Revenue</tspan></text></svg>' } })
  r.mtimes.set('/v/d.svg', 7); r.mtimes.set('/v/e.svg', 8)
  const counts = await r.ocr.runNow(pics(['/v/d.svg', '/v/e.svg']))
  assert.equal(r.calls.length, 0, 'the helper never sees an svg')
  assert.equal(r.ocr.textLower('/v/d.svg'), 'quarterly revenue')
  assert.deepEqual(counts, { total: 2, read: 1, known: 0, failed: 1, skipped: 0 }, 'an unreadable svg is a recorded failure')
})

await test('no helper on this machine: pictures are reported failed, nothing is recorded as read', async () => {
  const r = rig(); r.state.helper = false; const p = files(r, 2)
  const counts = await r.ocr.runNow(pics(p))
  assert.deepEqual(counts, { total: 2, read: 0, known: 0, failed: 2, skipped: 0 })
  assert.equal(r.ocr.entry(p[0]), undefined, 'not cached as failed, so a build with the helper tries them')
})

await test('the cache is persisted, and a saved cache is read back', async () => {
  const r = rig(); const p = files(r, 2)
  await r.ocr.runNow(pics(p)); r.fire()
  assert.deepEqual(Object.keys(r.saved()).sort(), p)
  const again = createOcrIndex({ loadCache: () => r.saved(), saveCache: () => {}, mtimeOf: (x) => r.mtimes.get(x) ?? null, runHelper: async () => ({ stdout: '', ok: true }), readText: async () => null, containedPath: (_r, p) => p, identityOf: () => 'same', helperAvailable: () => true, isEnabled: () => true })
  assert.equal(again.textLower(p[1]), 'text of ' + p[1])
  assert.equal(again.needs(p[1]), false)
})

// A helper that gives results for only the first `limit` pictures of a batch (a timeout mid-batch, or
// a clean exit that skipped the tail), but reads any picture fine when it runs alone.
function shortBatchIndex({ limit, ok }) {
  const mtimes = new Map(); const calls = []
  const ocr = createOcrIndex({
    loadCache: () => null, saveCache: () => {}, mtimeOf: (p) => (mtimes.has(p) ? mtimes.get(p) : null),
    runHelper: async (paths) => { calls.push(paths); const done = paths.length > 1 ? paths.slice(0, limit) : paths; return { stdout: done.map((p) => JSON.stringify({ p, t: 'text of ' + p })).join('\n'), ok: paths.length > 1 ? ok : true } },
    containedPath: (_r, p) => p, identityOf: () => 'same', helperAvailable: () => true, isEnabled: () => true, chunkSize: 4
  })
  return { ocr, mtimes, calls }
}

await test('a batch that times out before its last picture: that picture is retried alone and read, not marked failed', async () => {
  const b = shortBatchIndex({ limit: 3, ok: false })
  const p = ['/v/a.png', '/v/b.png', '/v/c.png', '/v/d.png']; p.forEach((x, i) => b.mtimes.set(x, i + 1))
  const counts = await b.ocr.runNow(pics(p))
  assert.deepEqual(counts, { total: 4, read: 4, known: 0, failed: 0, skipped: 0 })
  assert.equal(b.ocr.entry('/v/d.png').failed, undefined)
  assert.equal(b.ocr.textLower('/v/d.png'), 'text of /v/d.png')
  assert.deepEqual(b.calls.at(-1), ['/v/d.png'], 'the healthy picture ran on its own')
})

await test('a clean exit that leaves out healthy pictures retries them; nothing that reads alone is recorded failed', async () => {
  const b = shortBatchIndex({ limit: 1, ok: true })
  const p = ['/v/a.png', '/v/b.png', '/v/c.png']; p.forEach((x, i) => b.mtimes.set(x, i + 1))
  const counts = await b.ocr.runNow(pics(p))
  assert.deepEqual(counts, { total: 3, read: 3, known: 0, failed: 0, skipped: 0 })
})

await test('the pass yields to the event loop every few pictures (search and its cancellation keep running)', async () => {
  let yields = 0
  const mtimes = new Map(); const svg = {}
  for (let i = 0; i < 40; i++) { const p = `/v/s${i}.svg`; mtimes.set(p, 1); svg[p] = `<svg><text>pic ${i}</text></svg>` }
  const reads = []
  let otherWorkRan = false
  const ocr = createOcrIndex({
    loadCache: () => null, saveCache: () => {}, mtimeOf: (p) => (mtimes.has(p) ? mtimes.get(p) : null),
    runHelper: async () => ({ stdout: '', ok: true }),
    // Resolves as a microtask: only a real yield lets a queued macrotask in.
    readText: (p) => { reads.push(otherWorkRan); return Promise.resolve(svg[p]) },
    containedPath: (_r, p) => p, identityOf: () => 'same', helperAvailable: () => true, isEnabled: () => true,
    yieldToLoop: () => { yields += 1; return new Promise((r) => setImmediate(r)) }
  })
  setImmediate(() => { otherWorkRan = true })
  const counts = await ocr.runNow(pics([...mtimes.keys()]))
  assert.equal(counts.read, 40)
  assert.ok(yields >= 4, 'at least one yield every 8 pictures: ' + yields)
  assert.equal(reads.indexOf(true) > 0 && reads.indexOf(true) <= 8, true, 'a task queued before the pass ran within the first few pictures: ' + reads.indexOf(true))
})

const root = mkdtempSync(join(tmpdir(), 'tw-ocr-index-'))
try {
  const vault = join(root, 'vault'); const outside = join(root, 'outside')
  mkdirSync(join(vault, 'talk', 'assets'), { recursive: true }); mkdirSync(outside, { recursive: true })
  const secretSvg = join(outside, 'secret.svg'); writeFileSync(secretSvg, '<svg><text>OUTSIDE SECRET</text></svg>')
  const secretPng = join(outside, 'secret.png'); writeFileSync(secretPng, 'png')
  // The real disk, the real containment check and the real svg reader (index.ts passes no overrides).
  const realIndex = (calls = [], extra = {}) => createOcrIndex({
    loadCache: () => null, saveCache: () => {},
    mtimeOf: (p) => { try { return statSync(p).mtimeMs } catch { return null } },
    runHelper: async (paths) => { calls.push(paths); return { stdout: paths.map((p) => JSON.stringify({ p, t: 'vision ' + p })).join('\n'), ok: true } },
    helperAvailable: () => true, isEnabled: () => true, debounceMs: 0, ...extra
  })
  // Swap a directory inside the vault for a link to a directory outside it (keeping the original aside).
  const swapDirForLink = (dir, target) => { renameSync(dir, dir + '-aside'); symlinkSync(target, dir) }

  await test('vault authority: an svg swapped for a link out of the vault after it was queued is not read', async () => {
    const pic = join(vault, 'talk', 'assets', 'chart.svg')
    writeFileSync(pic, '<svg><text>inside chart</text></svg>')
    const ocr = realIndex()
    ocr.queue([{ path: pic, root: vault }])
    rmSync(pic); symlinkSync(secretSvg, pic) // swapped before the drain
    await ocr.idle()
    assert.equal(ocr.textLower(pic).includes('secret'), false, 'the outside file\'s text is not stored')
    assert.equal(ocr.entry(pic), undefined, 'not recorded: checked again next time')
    const counts = await ocr.runNow([{ path: pic, root: vault }])
    assert.equal(counts.skipped, 1); assert.equal(counts.read, 0)
    rmSync(pic); writeFileSync(pic, '<svg><text>inside again</text></svg>')
    await ocr.runNow([{ path: pic, root: vault }])
    assert.equal(ocr.textLower(pic), 'inside again', 'a picture inside its vault is read')
  })

  await test('vault authority: the Vision helper gets the checked real path, never a link out of the vault', async () => {
    const good = join(vault, 'talk', 'assets', 'photo.png'); writeFileSync(good, 'png')
    const swapped = join(vault, 'talk', 'assets', 'later.png'); writeFileSync(swapped, 'png')
    const calls = []
    const ocr = realIndex(calls)
    ocr.queue([{ path: good, root: vault }, { path: swapped, root: vault }])
    rmSync(swapped); symlinkSync(secretPng, swapped)
    await ocr.idle()
    const handed = calls.flat()
    assert.deepEqual(handed, [realpathSync(good)], 'only the inside picture, by its real path')
    assert.equal(ocr.textLower(good), ('vision ' + realpathSync(good)).toLowerCase(), 'its text is stored under the path the slide names')
    assert.equal(ocr.entry(swapped), undefined)
    assert.equal(ocr.textLower(swapped), '')
    // Queued under another vault's authority: not read either.
    const other = join(root, 'other-vault'); mkdirSync(other, { recursive: true })
    const calls2 = []
    const counts = await realIndex(calls2).runNow([{ path: good, root: other }])
    assert.equal(counts.skipped, 1); assert.deepEqual(calls2, [])
  })

  await test('vault authority: a parent directory swapped for an outside link between the check and the open of an svg is not read', async () => {
    const dir = join(vault, 'talk', 'racy'); mkdirSync(dir, { recursive: true })
    const pic = join(dir, 'chart.svg'); writeFileSync(pic, '<svg><text>inside chart</text></svg>')
    const elsewhere = join(root, 'elsewhere'); mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, 'chart.svg'), '<svg><text>OUTSIDE SECRET</text></svg>')
    let swaps = 0
    // The reader seam's hook runs after the containment check, right before the open: swap there.
    const ocr = realIndex([], { beforeSvgOpen: () => { if (swaps++ === 0) swapDirForLink(dir, elsewhere) } })
    const counts = await ocr.runNow([{ path: pic, root: vault }])
    assert.equal(swaps, 1, 'the swap ran between check and open')
    assert.equal(ocr.textLower(pic).includes('secret'), false, 'the outside file\'s text is never stored')
    assert.equal(ocr.entry(pic), undefined, 'not recorded: checked again next pass')
    assert.equal(counts.skipped, 1); assert.equal(counts.read, 0)
    // Put back: read normally.
    rmSync(dir); renameSync(dir + '-aside', dir)
    await ocr.runNow([{ path: pic, root: vault }])
    assert.equal(ocr.textLower(pic), 'inside chart')
  })

  await test('svg read: a file that grows after the stat is too large, not truncated; a size change is not recorded', async () => {
    const f = join(vault, 'talk', 'grows.svg'); writeFileSync(f, '<svg')
    const big = '<svg>' + 'x'.repeat(40) + '</svg>'
    const r1 = await readSvgFile(f, 16, { path: f, root: vault, containedPath: (r, p) => { writeFileSync(f, big); return p } })
    assert.equal(r1, TOO_LARGE)
    writeFileSync(f, '<svg')
    const r2 = await readSvgFile(f, 1000, { path: f, root: vault, containedPath: (r, p) => { writeFileSync(f, '<svg><text>a</text></svg>'); return p } })
    assert.equal(r2, CHANGED)
    // Through the index: skipped, not recorded.
    writeFileSync(f, '<svg')
    let n = 0
    const ocr = realIndex([], { containedPath: (r, p) => { if (++n === 2) writeFileSync(f, '<svg><text>a</text></svg>'); return p } })
    const counts = await ocr.runNow([{ path: f, root: vault }])
    assert.equal(counts.skipped, 1); assert.equal(ocr.entry(f), undefined)
  })

  await test('vault authority: a raster whose directory is swapped out of the vault while the helper runs has its result discarded', async () => {
    const dir = join(vault, 'talk', 'racy-png'); mkdirSync(dir, { recursive: true })
    const pic = join(dir, 'photo.png'); writeFileSync(pic, 'inside pixels')
    const keep = join(dir, 'other.png'); writeFileSync(keep, 'kept pixels')
    const elsewhere = join(root, 'elsewhere-png'); mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, 'photo.png'), 'OUTSIDE SECRET'); writeFileSync(join(elsewhere, 'other.png'), 'OUTSIDE SECRET')
    const stable = join(vault, 'talk', 'assets', 'steady.png'); writeFileSync(stable, 'steady pixels')
    let swaps = 0
    const calls = []
    // The stub helper opens by path, as the real one does, and the swap happens while it runs.
    const runHelper = async (paths) => {
      calls.push(paths)
      if (swaps++ === 0) swapDirForLink(dir, elsewhere)
      return { stdout: paths.map((p) => JSON.stringify({ p, t: readFileSync(p, 'utf8') })).join('\n'), ok: true }
    }
    const ocr = realIndex(calls, { runHelper })
    const counts = await ocr.runNow([{ path: pic, root: vault }, { path: keep, root: vault }, { path: stable, root: vault }])
    assert.equal(ocr.entry(pic), undefined, 'discarded, not recorded: read again next pass')
    assert.equal(ocr.entry(keep), undefined)
    assert.equal(ocr.textLower(pic).includes('secret'), false)
    assert.equal(ocr.textLower(stable), 'steady pixels', 'an unchanged picture in the same batch is kept')
    assert.deepEqual(counts, { total: 3, read: 1, known: 0, failed: 0, skipped: 2 })
    assert.equal(calls.length, 1, 'a discarded picture is not retried in this pass')
    rmSync(dir); renameSync(dir + '-aside', dir)
    await ocr.runNow([{ path: pic, root: vault }])
    assert.equal(ocr.textLower(pic), 'inside pixels', 'read on the next pass once it is back inside')
    // Swapped for an outside link and put back before the helper returns: containment looks fine
    // afterwards, but the file's identity (its ctime) changed, so the result is discarded too.
    const back = join(vault, 'talk', 'assets', 'back.png'); writeFileSync(back, 'back pixels')
    const secretFile = join(elsewhere, 'photo.png')
    const swapAndRestore = async (paths) => {
      renameSync(back, back + '-aside'); symlinkSync(secretFile, back)
      const out = paths.map((p) => JSON.stringify({ p, t: readFileSync(p, 'utf8') })).join('\n')
      rmSync(back); renameSync(back + '-aside', back)
      return { stdout: out, ok: true }
    }
    const ocr2 = realIndex([], { runHelper: swapAndRestore })
    const c2 = await ocr2.runNow([{ path: back, root: vault }])
    assert.equal(ocr2.entry(back), undefined, 'swapped and restored during the run: discarded')
    assert.equal(c2.skipped, 1)
  })

  await test('an svg over 2 MiB is recorded as skipped at its mtime, and read again once it changes', async () => {
    const big = join(vault, 'talk', 'assets', 'huge.svg')
    writeFileSync(big, '<svg><text>big</text>' + ' '.repeat(SVG_MAX_BYTES) + '</svg>')
    const ocr = realIndex()
    const counts = await ocr.runNow([{ path: big, root: vault }])
    assert.deepEqual(counts, { total: 1, read: 0, known: 0, failed: 0, skipped: 1 })
    assert.equal(ocr.entry(big).skipped, true); assert.equal(ocr.entry(big).failed, undefined)
    assert.equal(ocr.needs(big), false, 'not re-read while unchanged')
    writeFileSync(big, '<svg><text>small now</text></svg>'); utimesSync(big, new Date(), new Date(Date.now() + 5000))
    assert.equal(ocr.needs(big), true)
    await ocr.runNow([{ path: big, root: vault }])
    assert.equal(ocr.textLower(big), 'small now')
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}

console.log(`PASS ocr index: ${passed} checks`)

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sweepOrphanedThumbCaches } from '../src/main/thumbnail-cache-gc.ts'

// The sweep removes superseded thumb-cache namespaces and nothing else: never the live one,
// never one with recent activity, never a directory that is not a cache namespace.

const ud = mkdtempSync(join(tmpdir(), 'tw-thumb-gc-'))
const DAY = 24 * 60 * 60 * 1000
const now = Date.now()
const png = Buffer.alloc(1000, 1)

function namespace(name, talks, ageMs) {
  const dir = join(ud, name)
  for (const talk of talks) {
    const talkDir = join(dir, talk)
    mkdirSync(talkDir, { recursive: true })
    for (let i = 0; i < 3; i++) writeFileSync(join(talkDir, `${talk}-${i}.png`), png)
    const t = new Date(now - ageMs)
    for (let i = 0; i < 3; i++) utimesSync(join(talkDir, `${talk}-${i}.png`), t, t)
    utimesSync(talkDir, t, t)
  }
  utimesSync(dir, new Date(now - ageMs), new Date(now - ageMs))
  return dir
}

const live = namespace('thumb-cache-v8-live0000', ['talk-a', 'talk-b'], 30 * DAY) // old but LIVE
const oldOrphan = namespace('thumb-cache-v8-0ld00000', ['talk-a', 'talk-c'], 30 * DAY)
const oldOrphanBase = namespace('thumb-cache-v8-base', ['talk-a'], 30 * DAY)
const recentOrphan = namespace('thumb-cache-v8-recent00', ['talk-a'], 2 * DAY)
// An old namespace whose dir mtime is old but ONE talk dir was written yesterday → recent.
const mixed = namespace('thumb-cache-v8-mixed000', ['talk-a', 'talk-b'], 30 * DAY)
utimesSync(join(mixed, 'talk-b'), new Date(now - DAY), new Date(now - DAY))
// Not cache namespaces: must never be read or touched.
mkdirSync(join(ud, 'thumb-cache-notes'), { recursive: true }); writeFileSync(join(ud, 'thumb-cache-notes', 'x.png'), png)
mkdirSync(join(ud, 'recordings'), { recursive: true }); writeFileSync(join(ud, 'recordings', 'a.webm'), png)
writeFileSync(join(ud, 'search-index.json'), '{}')

const logs = []
const report = await sweepOrphanedThumbCaches(ud, 'thumb-cache-v8-live0000', { now, log: (m) => logs.push(m) })

assert.ok(existsSync(live) && readdirSync(join(live, 'talk-a')).length === 3, 'live namespace untouched even though it is old')
assert.ok(!existsSync(oldOrphan), 'old orphan removed')
assert.ok(!existsSync(oldOrphanBase), 'old `base` orphan removed')
assert.ok(existsSync(recentOrphan), 'recent orphan kept (grace window)')
assert.ok(existsSync(mixed) && existsSync(join(mixed, 'talk-a')), 'namespace with one recently written talk dir kept whole')
assert.ok(existsSync(join(ud, 'thumb-cache-notes', 'x.png')), 'non-namespace dir untouched')
assert.ok(existsSync(join(ud, 'recordings', 'a.webm')) && existsSync(join(ud, 'search-index.json')), 'other profile files untouched')

assert.deepEqual(report.removed.map((r) => r.name).sort(), ['thumb-cache-v8-0ld00000', 'thumb-cache-v8-base'])
const removedOld = report.removed.find((r) => r.name === 'thumb-cache-v8-0ld00000')
assert.equal(removedOld.files, 6, 'file count reported per removed namespace')
assert.equal(removedOld.bytes, 6000, 'byte total reported per removed namespace')
assert.deepEqual(
  report.kept.map((k) => `${k.name}:${k.reason}`).sort(),
  ['thumb-cache-v8-live0000:live', 'thumb-cache-v8-mixed000:recent', 'thumb-cache-v8-recent00:recent']
)
assert.ok(logs.some((l) => /removed 2 namespaces/.test(l)), 'summary line logged')

// A missing userData dir is a no-op, not a throw.
const empty = await sweepOrphanedThumbCaches(join(ud, 'does-not-exist'), 'thumb-cache-v8-live0000', { now })
assert.deepEqual(empty, { removed: [], kept: [] })

// A second sweep finds nothing further to remove.
const again = await sweepOrphanedThumbCaches(ud, 'thumb-cache-v8-live0000', { now })
assert.equal(again.removed.length, 0, 'sweep is idempotent')

console.log('PASS thumbnail cache gc: live + recent kept, old orphans removed with sizes, nothing else touched')

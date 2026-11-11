import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync, symlinkSync, lstatSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneThumbnailArtwork, thumbnailArtworkNamespace } from '../src/main/thumbnail-artwork-prune.ts'
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

// Same-user boundary canaries: never prune through a linked talk or namespace directory.
const canaries=mkdtempSync(join(tmpdir(),'tw-thumb-links-'))
const failures=[]
try {
  const userData=join(canaries,'userData');mkdirSync(userData)
  const outside=join(canaries,'outside');mkdirSync(outside)
  const root=join(userData,'thumb-cache-v10-test');mkdirSync(root)
  const outsidePicture=join(outside,'0000000000000000-model.png')
  writeFileSync(outsidePicture,'outside picture')
  const linkedTalk=join(root,'linked-talk');symlinkSync(outside,linkedTalk,'junction')
  try {
    const warnings=[]
    await pruneThumbnailArtwork(linkedTalk,thumbnailArtworkNamespace(linkedTalk,userData),'1111111111111111-',new Set(['model']),m=>warnings.push(m))
    assert.equal(readFileSync(outsidePicture,'utf8'),'outside picture','a linked talk cache cannot delete its outside canary')
    assert.ok(warnings.some(m=>m.includes('skipped artwork pruning')))
    console.log('PASS canary: linked talk cache preserves outside PNG')
  } catch(error) {failures.push(error);console.error('FAIL canary: linked talk cache',error.message)}
  const outsideNamespace=join(canaries,'outside-namespace');mkdirSync(outsideNamespace)
  const author=join(outsideNamespace,'author.txt');writeFileSync(author,'outside author data')
  const old=new Date(now-30*DAY);utimesSync(author,old,old);utimesSync(outsideNamespace,old,old)
  const linkedNamespace=join(userData,'thumb-cache-v9-linked');symlinkSync(outsideNamespace,linkedNamespace,'junction')
  try {
    const swept=await sweepOrphanedThumbCaches(userData,'thumb-cache-v10-test',{now})
    assert.equal(readFileSync(author,'utf8'),'outside author data','a linked old namespace cannot delete its outside canary')
    assert.equal(lstatSync(linkedNamespace).isSymbolicLink(),true,'namespace link is skipped')
    assert.ok(!swept.removed.some(item=>item.name==='thumb-cache-v9-linked'))
    console.log('PASS canary: linked namespace preserves outside author file')
  } catch(error) {failures.push(error);console.error('FAIL canary: linked namespace',error.message)}
  // A normal old namespace still removes its own link, without descending into the target.
  const oldTree=join(userData,'thumb-cache-v9-tree');mkdirSync(oldTree)
  symlinkSync(outsideNamespace,join(oldTree,'linked-child'),'junction')
  utimesSync(oldTree,old,old)
  await sweepOrphanedThumbCaches(userData,'thumb-cache-v10-test',{now})
  assert.equal(existsSync(oldTree),false,'a nested link does not prevent removal of the owned tree')
  assert.equal(readFileSync(author,'utf8'),'outside author data','nested directory links are not descended into')
  const safeTalk=join(root,'safe-talk');mkdirSync(safeTalk)
  const obsolete=join(safeTalk,'0000000000000000-model.png');writeFileSync(obsolete,'generated old picture')
  const current=join(safeTalk,'1111111111111111-model.png');writeFileSync(current,'verified current picture')
  await pruneThumbnailArtwork(safeTalk,root,'1111111111111111-',new Set(['model']))
  assert.equal(existsSync(obsolete),false,'regular generated obsolete pictures are still pruned')
  assert.equal(readFileSync(current,'utf8'),'verified current picture')
  console.log('PASS cache hardening: nested links never traversed; regular current/obsolete artwork preserved/pruned correctly')

} finally {rmSync(canaries,{recursive:true,force:true})}
assert.equal(failures.length,0,'both outside-cache canaries must survive')

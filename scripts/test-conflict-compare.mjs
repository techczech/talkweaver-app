// The compare screen's main-process service (several-vaults ticket 10; src/main/conflict-compare.ts
// header). Seam: createConflictCompare(deps) over a temp talk folder, with the writer, lock and Trash
// injected (a trash folder stands in for the OS Trash). Checks invariant 3: after a merge every line of
// both versions is in the outline or in a file in the Trash; a stale or cancelled compare writes nothing.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative } from 'node:path'

import { createConflictCompare } from '../src/main/conflict-compare.ts'
import { listSlideBlocks } from '../compiler/scripts/lib/12-outline-edit.mjs'
import { mintId } from '../compiler/scripts/lib/13-slide-ledger.mjs'
import { lineDiff } from '../compiler/scripts/lib/14-slide-propagation.mjs'

let passed = 0
const test = async (name, fn) => { await fn(); passed += 1; console.log(`ok  ${name}`) }

const base = realpathSync(mkdtempSync(join(tmpdir(), 'tw-conflict-compare-')))
const MINE = '---\ntitle: Workshop\n---\n\n## One {id=aaaaa}\n- same\n\n## Rubric {id=bbbbb}\n- 14 of 20\n\n## Close {id=ccccc}\n- bye\n'
const AIR = '---\ntitle: Workshop\n---\n\n## One {id=aaaaa}\n- same\n\n## Rubric {id=bbbbb}\n- 14 of 20; none named process\n\n## Close {id=ccccc}\n- bye\n\n## New on the Air {id=ddddd}\n- new\n'

function setup(name, { copies = { 'ws-outline-MacBook-Air.md': AIR }, outline = MINE, available = true, beforeWrite = null, writeError = null, trashFails = () => false, lockFails = false } = {}) {
  const root = join(base, name)
  const folder = join(root, 'ws')
  const trash = join(base, name + '-trash')
  mkdirSync(folder, { recursive: true })
  mkdirSync(trash, { recursive: true })
  const outlinePath = join(folder, 'ws-outline.md')
  writeFileSync(outlinePath, outline)
  for (const [n, text] of Object.entries(copies)) writeFileSync(join(folder, n), text)
  const log = { writes: 0, ledger: [], activity: [], rescans: 0 }
  const state = { available }
  const svc = createConflictCompare({
    outlineLib: async () => ({ listSlideBlocks, mintId, lineDiff }),
    readTalk: async (p) => readFileSync(p, 'utf8'),
    writeTalk: async (p, next) => {
      beforeWrite?.(p)
      if (writeError) return { ok: false, error: writeError }
      const current = readFileSync(p, 'utf8')
      let text
      try { text = next(current) } catch (error) { return { ok: false, error: error.message } }
      if (text === current) return { ok: true, via: 'disk', changed: false, text }
      writeFileSync(p, text); log.writes += 1
      return { ok: true, via: 'disk', changed: true, text }
    },
    withLock: async (_p, work) => { if (lockFails) throw new Error('lock failed'); return work() },
    trashItem: async (p) => { if (trashFails(p)) throw new Error('the Trash refused'); renameSync(p, join(trash, basename(p))) },
    writableRoot: () => (state.available ? root : undefined),
    staysInside: (r, c) => (relative(r, c).startsWith('..') ? null : c),
    vaultIdOf: () => 'vault-1',
    knownMachines: () => [],
    activity: { append: async (_v, _s, e) => { log.activity.push(e) } },
    ledgerSave: async (_p, text, lineage) => { log.ledger.push({ text, lineage: [...lineage] }) },
    rescan: async () => { log.rescans += 1 },
    now: () => new Date('2026-09-30T09:20:00')
  })
  const files = () => Object.fromEntries(readdirSync(folder).map((n) => [n, readFileSync(join(folder, n), 'utf8')]))
  const trashed = () => Object.fromEntries(readdirSync(trash).map((n) => [n, readFileSync(join(trash, n), 'utf8')]))
  return { svc, folder, outlinePath, trash, log, state, files, trashed }
}
/** Every non-blank line of each input is in the outline or in some file in the Trash. */
function noLineLost(inputs, outline, trashed) {
  const pool = [outline, ...Object.values(trashed)].join('\n').split('\n')
  for (const text of inputs) for (const line of text.split('\n')) if (line.trim()) assert.ok(pool.includes(line), `line kept: ${line}`)
}

try {
  await test('load: both versions as slides, the differing ones marked; nothing written', async () => {
    const t = setup('load')
    const before = t.files()
    const c = await t.svc.load(t.outlinePath)
    assert.equal(c.ok, true)
    assert.equal(c.kind, 'copy')
    assert.equal(c.theirs.label, 'MacBook Air')
    assert.equal(c.title, 'Workshop')
    assert.deepEqual(c.mine.slides.map((s) => s.differs), [false, true, false])
    assert.deepEqual(c.theirs.slides.map((s) => [s.match, s.differs]), [[0, false], [1, true], [2, false], [-1, true]])
    // the pair's line difference, read as − Mine, + the other version
    assert.deepEqual(c.theirs.slides[1].diff.filter((l) => l.kind !== 'same'), [{ kind: 'del', text: '- 14 of 20' }, { kind: 'add', text: '- 14 of 20; none named process' }])
    assert.deepEqual(c.mine.slides[1].diff, c.theirs.slides[1].diff)
    assert.equal(c.theirs.slides[0].diff, undefined)
    assert.deepEqual(t.files(), before)
    assert.deepEqual(await t.svc.check(c.token), { stale: false })
  })

  await test('merge keeping Mine with one slide pulled: one outline, the copy in the Trash, no line lost', async () => {
    const t = setup('keep-mine')
    const c = await t.svc.load(t.outlinePath)
    const r = await t.svc.merge(c.token, { keep: 'mine', pull: [1] })
    assert.equal(r.ok, true, r.error)
    const outline = readFileSync(t.outlinePath, 'utf8')
    assert.ok(outline.startsWith(MINE.slice(0, MINE.indexOf('## Close'))))
    assert.match(outline, /- 14 of 20\n\n## Rubric \{id=[a-z0-9]{5}\}\n- 14 of 20; none named process\n\n## Close \{id=ccccc\}/)
    assert.deepEqual(Object.keys(t.files()), ['ws-outline.md'])
    assert.deepEqual(Object.keys(t.trashed()), ['ws-outline-MacBook-Air.md'])
    noLineLost([MINE, AIR], outline, t.trashed())
    assert.equal(t.log.writes, 1)
    assert.equal(t.log.ledger.at(-1).text, outline)
    assert.equal(t.log.ledger.at(-1).lineage[0][1], 'bbbbb')
    assert.equal(t.log.activity.length, 1)
    assert.equal(t.log.activity[0].title, 'Merged the conflict copy from MacBook Air')
    assert.equal(t.log.activity[0].detail, 'Kept Mine; added slide 2 from MacBook Air after slide 2. The copy was moved to the Trash.')
    assert.equal(r.summary, 'Merged. 1 slide added after slide 2. The conflict copy was removed.')
    assert.equal(t.log.rescans, 1)
  })

  await test('merge keeping Mine with nothing ticked: the outline is not rewritten, the copy goes to the Trash', async () => {
    const t = setup('keep-mine-plain')
    const c = await t.svc.load(t.outlinePath)
    const r = await t.svc.merge(c.token, { keep: 'mine', pull: [] })
    assert.equal(r.ok, true)
    assert.equal(readFileSync(t.outlinePath, 'utf8'), MINE)
    assert.equal(t.log.writes, 0)
    assert.deepEqual(Object.keys(t.trashed()), ['ws-outline-MacBook-Air.md'])
  })

  await test('merge keeping Theirs: the talk holds theirs plus the pulled slide; the old text is kept in the Trash', async () => {
    const t = setup('keep-theirs')
    const c = await t.svc.load(t.outlinePath)
    const r = await t.svc.merge(c.token, { keep: 'theirs', pull: [1] })
    assert.equal(r.ok, true, r.error)
    const outline = readFileSync(t.outlinePath, 'utf8')
    assert.ok(outline.startsWith(AIR.slice(0, AIR.indexOf('## Close'))))
    assert.match(outline, /none named process\n\n## Rubric \{id=[a-z0-9]{5}\}\n- 14 of 20\n\n## Close/)
    const trashed = t.trashed()
    assert.deepEqual(Object.keys(trashed).sort(), ['ws-outline (before merge 2026-09-30 0920).md', 'ws-outline-MacBook-Air.md'])
    assert.equal(trashed['ws-outline (before merge 2026-09-30 0920).md'], MINE)
    assert.deepEqual(Object.keys(t.files()), ['ws-outline.md'])
    noLineLost([MINE, AIR], outline, trashed)
    assert.match(t.log.activity[0].detail, /^Kept MacBook Air; added slide 2 from Mine after slide 2\. The copy was moved to the Trash\. Your version before the merge was moved to the Trash\.$/)
  })

  await test('Git markers in the outline: both sides compared; the merge leaves no markers and the marked file in the Trash', async () => {
    const marked = '---\ntitle: G\n---\n\n## One {id=aaaaa}\n- same\n\n<<<<<<< HEAD\n## Two {id=bbbbb}\n- mine\n=======\n## Two {id=bbbbb}\n- theirs\n>>>>>>> origin/main\n'
    const t = setup('git', { copies: {}, outline: marked })
    const c = await t.svc.load(t.outlinePath)
    assert.equal(c.ok, true)
    assert.equal(c.kind, 'git')
    assert.equal(c.theirs.label, 'origin/main')
    assert.deepEqual(c.theirs.slides.map((s) => s.differs), [false, true])
    const r = await t.svc.merge(c.token, { keep: 'mine', pull: [1] })
    assert.equal(r.ok, true, r.error)
    const outline = readFileSync(t.outlinePath, 'utf8')
    assert.ok(!outline.includes('<<<<<<<') && !outline.includes('>>>>>>>'))
    assert.match(outline, /## Two \{id=bbbbb\}\n- mine\n\n## Two \{id=[a-z0-9]{5}\}\n- theirs\n$/)
    const trashed = t.trashed()
    assert.deepEqual(Object.values(trashed), [marked])
    noLineLost([marked.replace(/^(<{7}|={7}|>{7}).*$/gm, '')], outline, trashed)
    assert.equal(t.log.activity[0].title, 'Resolved the Git conflict')
  })

  await test('a file changed while comparing: check says so; Merge refuses with Start again and writes nothing', async () => {
    const t = setup('stale')
    const c = await t.svc.load(t.outlinePath)
    writeFileSync(join(t.folder, 'ws-outline-MacBook-Air.md'), AIR + '\n## Later\n')
    const chk = await t.svc.check(c.token)
    assert.equal(chk.stale, true)
    assert.equal(chk.which, 'theirs')
    const before = t.files()
    const r = await t.svc.merge(c.token, { keep: 'theirs', pull: [] })
    assert.equal(r.ok, false)
    assert.equal(r.stale, true)
    assert.match(r.error, /Start again/)
    assert.deepEqual(t.files(), before)
    assert.deepEqual(t.trashed(), {})
    assert.equal(t.log.activity.length, 0)
  })

  await test('the talk changed between the pre-check and the write: refused; the set-aside file is LEFT beside the talk and named, never removed', async () => {
    const t = setup('stale-in-write', { beforeWrite: (p) => writeFileSync(p, MINE + '- typed just now\n') })
    const c = await t.svc.load(t.outlinePath)
    const r = await t.svc.merge(c.token, { keep: 'theirs', pull: [] })
    assert.equal(r.ok, false)
    assert.equal(r.stale, true)
    assert.equal(r.setAsideLeft, 'ws-outline (before merge 2026-09-30 0920).md')
    assert.match(r.error, /set aside beside the talk as “ws-outline \(before merge 2026-09-30 0920\)\.md”/)
    assert.equal(readFileSync(t.outlinePath, 'utf8'), MINE + '- typed just now\n')
    assert.equal(t.files()['ws-outline (before merge 2026-09-30 0920).md'], MINE)
    assert.deepEqual(t.trashed(), {})
  })

  await test('the outline write fails while the outline still holds the set-aside text: the set-aside file goes to the Trash (a duplicate), never unlinked', async () => {
    const t = setup('write-fails', { writeError: 'disk full' })
    const c = await t.svc.load(t.outlinePath)
    const r = await t.svc.merge(c.token, { keep: 'theirs', pull: [] })
    assert.equal(r.ok, false)
    assert.equal(r.setAsideLeft, undefined)
    assert.match(r.error, /disk full/)
    assert.equal(readFileSync(t.outlinePath, 'utf8'), MINE)
    assert.deepEqual(Object.keys(t.files()).sort(), ['ws-outline-MacBook-Air.md', 'ws-outline.md'])
    assert.deepEqual(t.trashed(), { 'ws-outline (before merge 2026-09-30 0920).md': MINE })
  })

  await test('the outline write fails and the Trash refuses the set-aside file: it is left beside the talk and named', async () => {
    const t = setup('write-and-trash-fail', { writeError: 'disk full', trashFails: (p) => p.includes('(before merge') })
    const c = await t.svc.load(t.outlinePath)
    const r = await t.svc.merge(c.token, { keep: 'theirs', pull: [] })
    assert.equal(r.ok, false)
    assert.equal(r.setAsideLeft, 'ws-outline (before merge 2026-09-30 0920).md')
    assert.equal(t.files()['ws-outline (before merge 2026-09-30 0920).md'], MINE)
  })

  await test('merged, but the Trash refuses the set-aside file: the result and the Activity line say it was kept beside the talk, not trashed', async () => {
    const t = setup('trash-refuses', { trashFails: (p) => p.includes('(before merge') })
    const c = await t.svc.load(t.outlinePath)
    const r = await t.svc.merge(c.token, { keep: 'theirs', pull: [] })
    assert.equal(r.ok, true)
    assert.equal(r.setAsideLeft, 'ws-outline (before merge 2026-09-30 0920).md')
    assert.equal(readFileSync(t.outlinePath, 'utf8'), AIR)
    assert.equal(t.files()['ws-outline (before merge 2026-09-30 0920).md'], MINE)
    assert.deepEqual(Object.keys(t.trashed()), ['ws-outline-MacBook-Air.md'])
    assert.equal(t.log.activity[0].detail, 'Kept MacBook Air; added nothing. The copy was moved to the Trash. Your version before the merge was kept beside the talk as “ws-outline (before merge 2026-09-30 0920).md”.')
    assert.match(r.summary, /kept beside the talk as “ws-outline \(before merge/)
    noLineLost([MINE, AIR], readFileSync(t.outlinePath, 'utf8'), { ...t.trashed(), ...t.files() })
  })

  await test('merged, but the lock for the Trash step fails: an honest "Merged." result naming what was left', async () => {
    const t = setup('lock-fails', { lockFails: true })
    const c = await t.svc.load(t.outlinePath)
    const r = await t.svc.merge(c.token, { keep: 'mine', pull: [1] })
    assert.equal(r.ok, true)
    assert.equal(r.copyLeft, true)
    assert.match(r.summary, /^Merged\. 1 slide added after slide 2\. The conflict copy was left in the folder\.$/)
    assert.ok(readFileSync(t.outlinePath, 'utf8').includes('none named process'))
    assert.ok(t.files()['ws-outline-MacBook-Air.md'])
    assert.match(t.log.activity[0].detail, /The copy could not be moved or changed meanwhile, so it was left in the folder\.$/)
    assert.equal(t.log.rescans, 1)
  })

  await test('cancel writes nothing; the token is gone', async () => {
    const t = setup('cancel')
    const before = t.files()
    const c = await t.svc.load(t.outlinePath)
    t.svc.cancel(c.token)
    assert.deepEqual(t.files(), before)
    assert.deepEqual(t.trashed(), {})
    const r = await t.svc.merge(c.token, { keep: 'mine', pull: [] })
    assert.equal(r.ok, false)
    assert.deepEqual(t.files(), before)
  })

  await test('an unavailable vault: nothing loaded, nothing merged', async () => {
    const t = setup('away')
    const c = await t.svc.load(t.outlinePath)
    t.state.available = false
    const before = t.files()
    const r = await t.svc.merge(c.token, { keep: 'mine', pull: [1] })
    assert.equal(r.ok, false)
    assert.deepEqual(t.files(), before)
    assert.equal((await t.svc.load(t.outlinePath)).ok, false)
  })

  await test('only differing slides can be pulled', async () => {
    const t = setup('pull-same')
    const c = await t.svc.load(t.outlinePath)
    const r = await t.svc.merge(c.token, { keep: 'mine', pull: [0] })
    assert.equal(r.ok, false)
    assert.equal(readFileSync(t.outlinePath, 'utf8'), MINE)
  })

  await test('several copies: the oldest is compared first; the count says how many are left', async () => {
    const t = setup('several', { copies: { 'ws-outline-MacBook-Air.md': AIR, 'ws-outline (1).md': MINE + '\n## Drive\n' } })
    const old = new Date('2026-09-29T10:00:00Z')
    utimesSync(join(t.folder, 'ws-outline (1).md'), old, old)
    const c = await t.svc.load(t.outlinePath)
    assert.equal(c.copyName, 'ws-outline (1).md')
    assert.equal(c.remaining, 2)
    assert.equal(c.theirs.label, 'The other copy')
  })
} finally {
  rmSync(base, { recursive: true, force: true })
}
console.log(`\n${passed} passed`)

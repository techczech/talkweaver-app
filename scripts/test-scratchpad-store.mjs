// Slide Scratchpad store (src/main/scratchpad-store.ts, scratchpad-watch.ts) over a temp talk folder:
// scan and merge of the folder against the state, sidecars, atomic state writes, a broken state file,
// "File missing" items, status and group changes, slide picks, and that no agent file is ever touched.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createScratchpadStore } from '../src/main/scratchpad-store.ts'
import { watchScratchFolder } from '../src/main/scratchpad-watch.ts'

// Directory events are a native-runtime contract. On macOS exercise the exact runtime we ship:
// host Node can return a watcher without delivering events at all (preserved release traces).
// Electron runs only as Node here: no app window, preload, profile or real vault is opened.
if (process.platform === 'darwin' && !process.versions.electron) {
  const executable = createRequire(import.meta.url)('electron')
  const run = spawnSync(executable, ['--experimental-strip-types', fileURLToPath(import.meta.url)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit'
  })
  if (run.error) throw run.error
  process.exit(run.status ?? 1)
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tw-scratchpad-')))
let seq = 0
let clock = Date.parse('2026-10-27T22:40:00.000Z')
const newTalk = () => { const dir = join(root, `talk-${++seq}`); mkdirSync(dir); return dir }
const options = () => {
  let n = 0
  return { now: () => new Date(clock += 1000), newItemId: () => `sp-${++n}`, newGroupId: () => `g-${++n}`, fileUrlFor: (p) => `file-url:${p.split('/').pop()}` }
}
const scratch = (talk) => join(talk, 'scratchpad')
const put = (talk, name, text = 'x') => { mkdirSync(scratch(talk), { recursive: true }); writeFileSync(join(scratch(talk), name), text) }
const stateOf = (talk) => JSON.parse(readFileSync(join(scratch(talk), 'scratchpad-state.json'), 'utf8'))
const listing = (talk) => readdirSync(scratch(talk)).sort()
const slideInput = (id, over = {}) => ({ talkPath: 'bucket/t.md', talkTitle: 'T', slideId: id, title: `Slide ${id}`, markdown: `### Slide ${id}\n`, thumbKey: `k${id}`, talkSlug: 't', ...over })

let checks = 0
const test = async (name, fn) => { try { await fn(); checks++ } catch (error) { console.error(`FAIL ${name}`); throw error } }

try {
  await test('a scratch folder linked during state mutation cannot redirect writes', async () => {
    for (const existed of [false, true]) {
      const talk = newTalk(); const victim = newTalk()
      const victimState = join(victim, 'scratchpad-state.json')
      writeFileSync(victimState, 'unrelated state bytes')
      if (existed) mkdirSync(scratch(talk))
      const opts = options()
      const store = createScratchpadStore(talk, { ...opts, newGroupId: () => {
        if (existed) fs.renameSync(scratch(talk), join(talk, 'held-scratchpad'))
        symlinkSync(victim, scratch(talk), 'dir')
        return 'g-race'
      } })
      await assert.rejects(store.createGroup('Race'))
      assert.equal(readFileSync(victimState, 'utf8'), 'unrelated state bytes')
      assert.deepEqual(readdirSync(victim), ['scratchpad-state.json'])
    }
  })

  await test('a file returned for preview or import remains the checked bytes after source replacement', async () => {
    const talk = newTalk(); put(talk, 'page.html', '<p>checked page</p>')
    const victim = join(root, 'private-page.html'); writeFileSync(victim, '<p>unrelated private page</p>')
    const store = createScratchpadStore(talk, options())
    const item = (await store.load()).items[0]
    const file = await store.fileFor(item.id)
    assert.ok(file)
    rmSync(join(scratch(talk), 'page.html')); symlinkSync(victim, join(scratch(talk), 'page.html'))
    assert.equal(readFileSync(file.path, 'utf8'), '<p>checked page</p>')
    assert.equal(await store.fileFor(item.id), null, 'the linked replacement is refused')
  })

  await test('a talk with no scratch folder answers empty and writes nothing', async () => {
    const talk = newTalk()
    const snap = await createScratchpadStore(talk, options()).load()
    assert.deepEqual(snap, { groups: [], items: [], notices: [] })
    assert.equal(existsSync(scratch(talk)), false)
  })

  await test('scan adds each supported file once as an ungrouped active agent item; other files are ignored', async () => {
    const talk = newTalk()
    for (const f of ['a.svg', 'b.HTML', 'c.htm', 'd.png', 'e.jpg', 'f.jpeg', 'g.webp', 'h.gif', 'notes.txt', '.hidden.svg', 'x.svg.bak']) put(talk, f)
    mkdirSync(join(scratch(talk), 'sub.svg'))
    const store = createScratchpadStore(talk, options())
    const snap = await store.load()
    assert.deepEqual(snap.items.map((i) => [i.file, i.fileKind]), [
      ['a.svg', 'svg'], ['b.HTML', 'html'], ['c.htm', 'html'], ['d.png', 'pic'], ['e.jpg', 'pic'], ['f.jpeg', 'pic'], ['g.webp', 'pic'], ['h.gif', 'pic']
    ])
    for (const item of snap.items) {
      assert.equal(item.status, 'active'); assert.equal(item.group, null); assert.equal(item.kind, 'file'); assert.equal(item.batch.source, 'agent'); assert.equal(item.missing, false)
    }
    assert.equal(new Set(snap.items.map((i) => i.batch.at)).size, 1, 'one scan is one arrival batch')
    assert.equal(snap.items[0].fileUrl, 'file-url:a.svg'); assert.equal(snap.items[1].fileUrl, undefined, 'HTML gets no image address')
    assert.equal(stateOf(talk).version, 1)
    const again = await store.load()
    assert.deepEqual(again.items.map((i) => i.id), snap.items.map((i) => i.id), 'a second scan keeps the same items')
  })

  await test('text inside SVG and HTML files is searchable, read as data, not shown, and not taken from scripts or styles', async () => {
    const { matchesQuery, parseQuery } = await import('../src/shared/scratchpad.ts')
    const talk = newTalk()
    put(talk, 'chart.svg', '<svg xmlns="http://www.w3.org/2000/svg"><title>Benchmark &amp; scores</title><text x="1">GPQA <tspan>Diamond</tspan></text><desc>Frontier labs</desc><script>var secret = "zzzscript"</script></svg>')
    put(talk, 'page.html', '<html><head><style>.zzzstyle{}</style><script>var x="zzzscript"</script></head><body><h1>Research&nbsp;loop</h1><!-- zzzcomment --><p>Four &lt;steps&gt; &#65;gents</p></body></html>')
    put(talk, 'pic.png', 'zzzbinary')
    const items = (await createScratchpadStore(talk, options()).load()).items
    const by = (name) => items.find((i) => i.file === name)
    const hit = (name, q) => matchesQuery(by(name), parseQuery(q))
    assert.equal(hit('chart.svg', 'diamond'), true); assert.equal(hit('chart.svg', 'frontier labs'), true); assert.equal(hit('chart.svg', 'benchmark & scores'), true)
    assert.equal(hit('chart.svg', 'zzzscript'), false)
    assert.equal(hit('page.html', 'research loop'), true); assert.equal(hit('page.html', 'four <steps> agents'), true)
    for (const q of ['zzzscript', 'zzzstyle', 'zzzcomment']) assert.equal(hit('page.html', q), false, q)
    assert.equal(hit('pic.png', 'zzzbinary'), false)
    assert.match(by('chart.svg').contentText, /Diamond/)
  })

  await test('words the page rendered (captured in the hidden window) are searchable once they exist; static text stays the fallback', async () => {
    const { matchesQuery, parseQuery } = await import('../src/shared/scratchpad.ts')
    const talk = newTalk()
    put(talk, 'loops.html', '<html><body><h1>Research loop explorer</h1><div id="app"></div><script>const D=["coscientist"];app.textContent=D[0]</script></body></html>')
    let rendered = ''
    const store = createScratchpadStore(talk, { ...options(), renderedTextFor: () => rendered })
    const hit = async (q) => matchesQuery((await store.load()).items.find((i) => i.file === 'loops.html'), parseQuery(q))
    assert.equal(await hit('coscientist'), false, 'script data is not static text')
    assert.equal(await hit('research loop'), true, 'static extraction is the fallback before the capture')
    rendered = 'Research loop explorer AI coscientist pipeline'
    assert.equal(await hit('coscientist'), true, 'rendered words reach contentText on the next snapshot')
    assert.equal(await hit('research loop'), true, 'static text is kept')
  })

  await test('addedAt is the file mtime; a file arriving later is a new batch; sidecar and plain title', async () => {
    const talk = newTalk()
    put(talk, 'first.svg')
    const old = new Date('2026-10-20T10:00:00.000Z'); utimesSync(join(scratch(talk), 'first.svg'), old, old)
    const store = createScratchpadStore(talk, options())
    const one = await store.load()
    assert.equal(one.items[0].addedAt, '2026-10-20T10:00:00.000Z'); assert.equal(one.items[0].title, 'First')
    put(talk, 'second.html'); put(talk, 'second.html.json', JSON.stringify({ title: 'Research loop', description: 'Four steps', sources: [{ label: 'Paper', url: 'https://example.org/p' }, { label: 'Bad', url: 'javascript:alert(1)' }] }))
    const two = await store.load()
    const second = two.items.find((i) => i.file === 'second.html')
    assert.equal(second.title, 'Research loop'); assert.equal(second.description, 'Four steps')
    assert.deepEqual(second.sources, [{ label: 'Paper', url: 'https://example.org/p' }], 'only web links are kept')
    assert.notEqual(second.batch.at, two.items.find((i) => i.file === 'first.svg').batch.at)
    put(talk, 'broken.svg'); put(talk, 'broken.svg.json', '{nope')
    assert.equal((await store.load()).items.find((i) => i.file === 'broken.svg').title, 'Broken', 'a bad sidecar falls back to the file name')
  })

  await test('state changes survive a reload: status, group, created group; the folder is never changed', async () => {
    const talk = newTalk()
    put(talk, 'a.svg', 'AAA'); put(talk, 'b.png', 'BBB')
    const before = Object.fromEntries(['a.svg', 'b.png'].map((f) => [f, [readFileSync(join(scratch(talk), f), 'utf8'), statSync(join(scratch(talk), f)).mtimeMs]]))
    const store = createScratchpadStore(talk, options())
    const [a, b] = (await store.load()).items
    const { group } = await store.createGroup('  Research   loop ')
    assert.equal(group.name, 'Research loop')
    assert.equal((await store.createGroup('research LOOP')).group.id, group.id, 'same name, same group')
    await store.setGroup([a.id, b.id], group.id)
    await store.setStatus([b.id], 'kept')
    const fresh = await createScratchpadStore(talk, options()).load()
    assert.deepEqual(fresh.groups, [group])
    assert.deepEqual(fresh.items.map((i) => [i.file, i.group, i.status]), [['a.svg', group.id, 'active'], ['b.png', group.id, 'kept']])
    await store.setStatus([b.id], 'active'); await store.setGroup([a.id], null)
    assert.deepEqual((await store.load()).items.map((i) => [i.group, i.status]), [[null, 'active'], [group.id, 'active']])
    await assert.rejects(store.setGroup([a.id], 'g-nope'), /not in the Slide Scratchpad/)
    await assert.rejects(store.createGroup('   '), /needs a name/)
    for (const f of ['a.svg', 'b.png']) assert.deepEqual([readFileSync(join(scratch(talk), f), 'utf8'), statSync(join(scratch(talk), f)).mtimeMs], before[f], `${f} untouched`)
    assert.deepEqual(listing(talk), ['a.svg', 'b.png', 'scratchpad-state.json'], 'no stray temp file')
  })

  await test('slide picks keep a markdown snapshot, arrive ungrouped as one batch, and a repeat pick is skipped', async () => {
    const talk = newTalk()
    const store = createScratchpadStore(talk, options())
    const first = await store.addSlides([slideInput('a'), slideInput('b'), { nonsense: true }])
    assert.deepEqual([first.added, first.skipped], [2, 1])
    assert.deepEqual(first.snapshot.items.map((i) => [i.kind, i.status, i.group, i.batch.source, i.title]), [['slide', 'active', null, 'slide-browser', 'Slide a'], ['slide', 'active', null, 'slide-browser', 'Slide b']])
    assert.equal(first.snapshot.items[0].batch.at, first.snapshot.items[1].batch.at)
    assert.equal(stateOf(talk).items[0].slide.markdown, '### Slide a\n')
    const second = await store.addSlides([slideInput('a'), slideInput('a', { markdown: '### Slide a changed\n' })])
    assert.deepEqual([second.added, second.skipped], [1, 1], 'the same slide with the same text is not added twice; changed text is a new candidate')
    await store.setStatus([first.snapshot.items[0].id], 'rejected')
    assert.equal((await store.addSlides([slideInput('a')])).added, 1, 'a rejected slide can be picked again')
  })

  await test('a file that disappears shows as missing, keeps its choices, and can be removed from the state only', async () => {
    const talk = newTalk()
    put(talk, 'gone.svg'); put(talk, 'stay.svg')
    const store = createScratchpadStore(talk, options())
    const [gone, stay] = (await store.load()).items
    await store.setStatus([gone.id], 'kept')
    rmSync(join(scratch(talk), 'gone.svg'))
    const snap = await store.load()
    const missing = snap.items.find((i) => i.id === gone.id)
    assert.equal(missing.missing, true); assert.equal(missing.status, 'kept'); assert.equal(missing.fileUrl, undefined)
    const same = await store.removeMissing([stay.id])
    assert.equal(same.items.length, 2, 'an item whose file is there is not removed')
    const after = await store.removeMissing([gone.id, stay.id])
    assert.deepEqual(after.items.map((i) => i.file), ['stay.svg'])
    assert.ok(existsSync(join(scratch(talk), 'stay.svg')))
    put(talk, 'gone.svg')
    assert.equal((await store.load()).items.length, 2, 'a file that comes back is a new item')
  })

  await test('text extraction is linear: 5 MB of unclosed openers finishes well under a second, and ordinary text still comes out', async () => {
    const { htmlText, svgText } = await import('../src/main/scratchpad-text.ts')
    const MB5 = 5 * 1024 * 1024
    const fill = (unit) => unit.repeat(Math.ceil(MB5 / unit.length))
    const inputs = [fill('<svg '), fill('<!--'), fill('<script '), fill('<text>'), fill('<text><'), fill('<title>a<b'), fill('<'), fill('<![CDATA['), fill('</svg x')]
    for (const input of inputs) {
      for (const [name, fn] of [['html', htmlText], ['svg', svgText]]) {
        const started = performance.now()
        fn(input)
        const ms = performance.now() - started
        assert.ok(ms < 800, `${name} over ${JSON.stringify(input.slice(0, 10))}… took ${Math.round(ms)} ms`)
      }
    }
    assert.equal(htmlText('<p>A &amp; B</p><!-- c --><SCRIPT>x</script ><Style>y</STYLE><svg><text>z</text></svg><p>end</p>'), 'A & B end')
    assert.equal(htmlText('<p>kept</p><script>never closed <p>hidden</p>'), 'kept')
    assert.equal(htmlText('a < b and c'), 'a < b and c')
    assert.equal(svgText('<svg><title>T</title><text>A <tspan>B</tspan></text><!-- <text>no</text> --><desc><![CDATA[C & D]]></desc><textPath>not</textPath></svg>'), 'T A B C & D')
    assert.equal(svgText('<svg><text>open<text>x</text><title>never closed</svg>'), 'open x')
  })

  await test('a broken state file is kept aside, said so, and the folder shows as ungrouped active items', async () => {
    const talk = newTalk()
    put(talk, 'a.svg')
    writeFileSync(join(scratch(talk), 'scratchpad-state.json'), '{ "version": 1, "groups": [')
    const store = createScratchpadStore(talk, options())
    const snap = await store.load()
    assert.equal(snap.notices.length, 1)
    assert.match(snap.notices[0], /not valid JSON/); assert.match(snap.notices[0], /scratchpad-state\.broken-.*\.json/); assert.match(snap.notices[0], /not recovered/)
    assert.deepEqual(snap.items.map((i) => [i.file, i.group, i.status]), [['a.svg', null, 'active']])
    const broken = listing(talk).filter((f) => f.startsWith('scratchpad-state.broken-'))
    assert.equal(broken.length, 1); assert.equal(readFileSync(join(scratch(talk), broken[0]), 'utf8'), '{ "version": 1, "groups": [')
    assert.equal(stateOf(talk).version, 1, 'a fresh state replaces it')
    assert.deepEqual((await store.load()).notices, [], 'said once')
    assert.deepEqual(listing(talk).filter((f) => f.endsWith('.svg')), ['a.svg'], 'the broken copy is not an item')
  })

  await test('a state with some unreadable parts keeps the rest and says what it dropped', async () => {
    const talk = newTalk()
    put(talk, 'a.svg')
    const good = { id: 'sp-9', kind: 'file', file: 'a.svg', addedAt: '2026-10-27T10:00:00.000Z', batch: { source: 'agent', at: '2026-10-27T10:00:00.000Z' }, group: 'g-1', status: 'kept' }
    writeFileSync(join(scratch(talk), 'scratchpad-state.json'), JSON.stringify({
      version: 1, groups: [{ id: 'g-1', name: 'Opening' }, { nope: 1 }],
      items: [good, { id: 'bad' }, { ...good, id: 'sp-10', file: '../escape.svg' }, { ...good, id: 'sp-11', file: 'a.svg' }]
    }))
    const snap = await createScratchpadStore(talk, options()).load()
    assert.deepEqual(snap.groups, [{ id: 'g-1', name: 'Opening' }])
    assert.deepEqual(snap.items.map((i) => [i.id, i.status, i.group]), [['sp-9', 'kept', 'g-1']])
    assert.match(snap.notices[0], /unreadable/); assert.match(snap.notices[0], /What could be read was kept/)
    assert.equal(listing(talk).filter((f) => f.startsWith('scratchpad-state.broken-')).length, 1)
  })

  await test('a state file that exists but cannot be read is never overwritten; the files show read-only and changes are refused', async () => {
    if (process.getuid?.() === 0) return
    const { chmodSync } = await import('node:fs')
    const talk = newTalk()
    put(talk, 'a.html', '<p>hi</p>')
    const statePath = join(scratch(talk), 'scratchpad-state.json')
    writeFileSync(statePath, '{"version":1,"groups":[{"id":"g-1","name":"Kept by him"}],"items":[]}')
    chmodSync(statePath, 0o000)
    try {
      const store = createScratchpadStore(talk, options())
      const snap = await store.load()
      assert.match(snap.notices[0], /could not be read/); assert.match(snap.notices[0], /not saved/)
      assert.deepEqual(snap.items.map((i) => [i.file, i.group, i.status]), [['a.html', null, 'active']])
      assert.deepEqual((await store.load()).items.map((i) => i.id), snap.items.map((i) => i.id), 'read-only ids are stable')
      assert.equal((await store.fileFor(snap.items[0].id))?.name, 'a.html', 'a read-only item still names its file')
      await assert.rejects(store.setStatus([snap.items[0].id], 'kept'), /Nothing was changed/)
      await assert.rejects(store.createGroup('New'), /Nothing was changed/)
    } finally { chmodSync(statePath, 0o644) }
    assert.equal(readFileSync(statePath, 'utf8'), '{"version":1,"groups":[{"id":"g-1","name":"Kept by him"}],"items":[]}', 'the state file was not replaced')
    assert.deepEqual(listing(talk), ['a.html', 'scratchpad-state.json'], 'no broken copy and no temp file')
  })

  await test('a broken state that cannot be copied aside is left as it is and not overwritten', async () => {
    const talk = newTalk()
    put(talk, 'a.svg')
    const statePath = join(scratch(talk), 'scratchpad-state.json')
    writeFileSync(statePath, '{ "version": 1, "groups": [')
    // The store's clock gives the broken copy's name; a file already there makes the exclusive copy fail.
    const stamp = new Date(clock + 1000).toISOString().replace(/[:.]/g, '-')
    writeFileSync(join(scratch(talk), `scratchpad-state.broken-${stamp}.json`), 'squatter')
    const store = createScratchpadStore(talk, options())
    const snap = await store.load()
    assert.match(snap.notices[0], /could not be copied aside/)
    assert.deepEqual(snap.items.map((i) => i.file), ['a.svg'])
    assert.equal(readFileSync(statePath, 'utf8'), '{ "version": 1, "groups": [', 'the only copy of the state was not replaced')
    assert.equal(readFileSync(join(scratch(talk), `scratchpad-state.broken-${stamp}.json`), 'utf8'), 'squatter')
  })

  await test('a state file that is a link is never followed, read, copied or overwritten', async () => {
    const talk = newTalk()
    put(talk, 'a.svg')
    const target = join(root, `elsewhere-${seq}.json`)
    const good = JSON.stringify({ version: 1, groups: [{ id: 'g-1', name: 'From outside' }], items: [] })
    writeFileSync(target, good)
    symlinkSync(target, join(scratch(talk), 'scratchpad-state.json'))
    const store = createScratchpadStore(talk, options())
    const snap = await store.load()
    assert.match(snap.notices[0], /is a link/)
    assert.deepEqual(snap.groups, [], 'the linked file was not read')
    assert.deepEqual(snap.items.map((i) => i.file), ['a.svg'])
    await assert.rejects(store.setStatus([snap.items[0].id], 'kept'), /Nothing was changed/)
    assert.equal(readFileSync(target, 'utf8'), good, 'the link target is untouched')
    const { lstatSync } = await import('node:fs')
    assert.ok(lstatSync(join(scratch(talk), 'scratchpad-state.json')).isSymbolicLink(), 'the link itself was not replaced')
    assert.deepEqual(listing(talk), ['a.svg', 'scratchpad-state.json'], 'nothing was copied aside')
  })

  await test('a scratch folder that is a link makes the Slide Scratchpad unavailable: no list, no write, a notice', async () => {
    const talk = newTalk()
    const outside = join(root, `outside-folder-${seq}`)
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.svg'), '<svg><text>secret</text></svg>')
    symlinkSync(outside, scratch(talk))
    const store = createScratchpadStore(talk, options())
    const snap = await store.load()
    assert.deepEqual(snap.items, []); assert.deepEqual(snap.groups, [])
    assert.match(snap.notices[0], /is a link/); assert.match(snap.notices[0], /not available/)
    await assert.rejects(store.addSlides([slideInput('a')]), /is a link/)
    await assert.rejects(store.createGroup('G'), /is a link/)
    assert.equal(await store.itemFor('sp-1'), null)
    assert.deepEqual(readdirSync(outside), ['secret.svg'], 'nothing was written through the link')
  })

  await test('a state from another version is not read as if it were this one', async () => {
    const talk = newTalk()
    put(talk, 'a.svg')
    writeFileSync(join(scratch(talk), 'scratchpad-state.json'), JSON.stringify({ version: 2, groups: [], items: [] }))
    const snap = await createScratchpadStore(talk, options()).load()
    assert.match(snap.notices[0], /version is 2/); assert.equal(snap.items.length, 1)
  })

  await test('writes are atomic: the state file is whole after every operation, and a failed write leaves it as it was', async () => {
    const talk = newTalk()
    put(talk, 'a.svg')
    const store = createScratchpadStore(talk, options())
    await store.load()
    const text = readFileSync(join(scratch(talk), 'scratchpad-state.json'), 'utf8')
    JSON.parse(text)
    // a directory squatting on the temp-file route cannot be made: simulate a write that fails
    // by making the folder read-only for the state write
    const { chmodSync } = await import('node:fs')
    chmodSync(scratch(talk), 0o555)
    try {
      if (process.getuid?.() !== 0) await assert.rejects(store.setStatus([(await store.load()).items[0].id], 'kept'))
    } finally { chmodSync(scratch(talk), 0o755) }
    assert.equal(readFileSync(join(scratch(talk), 'scratchpad-state.json'), 'utf8'), text, 'the old state is intact')
    assert.deepEqual(listing(talk), ['a.svg', 'scratchpad-state.json'])
  })

  await test('operations queue: simultaneous changes all land', async () => {
    const talk = newTalk()
    put(talk, 'a.svg'); put(talk, 'b.svg'); put(talk, 'c.svg')
    const store = createScratchpadStore(talk, options())
    const items = (await store.load()).items
    await Promise.all([store.setStatus([items[0].id], 'kept'), store.setStatus([items[1].id], 'rejected'), store.createGroup('G'), store.addSlides([slideInput('z')])])
    const snap = await store.load()
    assert.deepEqual(snap.items.map((i) => i.status), ['kept', 'rejected', 'active', 'active'])
    assert.equal(snap.groups.length, 1)
  })

  await test('fileFor answers only a plain file the folder holds; a link is never followed', async () => {
    const talk = newTalk()
    put(talk, 'a.html', '<p>hi</p>')
    const outside = join(root, 'outside.svg'); writeFileSync(outside, '<svg/>')
    symlinkSync(outside, join(scratch(talk), 'link.svg'))
    const store = createScratchpadStore(talk, options())
    const snap = await store.load()
    assert.deepEqual(snap.items.map((i) => i.file), ['a.html'], 'a link in the folder is ignored')
    const a = snap.items[0]
    const copy = await store.fileFor(a.id)
    assert.deepEqual({ name: copy?.name, kind: copy?.kind }, { name: 'a.html', kind: 'html' })
    assert.notEqual(copy.path, join(scratch(talk), 'a.html'), 'consumers get a private snapshot')
    assert.equal(readFileSync(copy.path, 'utf8'), '<p>hi</p>')
    assert.equal(await store.fileFor('sp-nope'), null)
    rmSync(join(scratch(talk), 'a.html'))
    assert.equal(await store.fileFor(a.id), null)
  })

  await test('manual order persists, filters preserve hidden slots and arrivals append', async () => {
    const talk = newTalk(); put(talk, 'a.svg', '<svg/>'); put(talk, 'b.svg', '<svg/>'); put(talk, 'c.svg', '<svg/>')
    const opts = options(); const store = createScratchpadStore(talk, opts)
    const snap = await store.load()
    await store.setSort('manual')
    const base = (await store.load()).order
    const moved = await store.reorder([base[0], base[2]], [base[2], base[0]])
    assert.deepEqual(moved.order, [base[2], base[1], base[0]], 'the hidden middle slot never moves')
    await assert.rejects(store.reorder([base[0], base[2]], [base[2], base[0]]), /changed/)
    await assert.rejects(store.reorder([base[2]], ['not-an-item']), /selection/)
    await store.setSort('newest')
    const reopened = createScratchpadStore(talk, opts)
    await reopened.setSort('manual')
    assert.deepEqual((await reopened.load()).order, moved.order)
    put(talk, 'new.svg', '<svg>new</svg>')
    const arrived = await reopened.load()
    assert.deepEqual(arrived.order.slice(0, 3), moved.order)
    assert.equal(arrived.order[3], arrived.items.find(item => item.file === 'new.svg').id)
    assert.equal(arrived.sort, 'manual')
  })

  await test('markInserted records when and into which slide, keeps everything else, and survives a reload (version stays 1)', async () => {
    const talk = newTalk()
    put(talk, 'chart.png', 'PNGBYTES')
    const store = createScratchpadStore(talk, options())
    const [item] = (await store.load()).items
    const before = stateOf(talk).items[0]
    const snap = await store.markInserted(item.id, '  Where   AI helps ')
    const after = stateOf(talk)
    assert.equal(after.version, 1)
    assert.equal(after.items[0].insertedInto, 'Where AI helps')
    assert.ok(!Number.isNaN(Date.parse(after.items[0].insertedAt)))
    const { insertedAt, insertedInto, ...rest } = after.items[0]
    assert.deepEqual(rest, before, 'nothing else about the item changed')
    assert.equal(snap.items[0].insertedInto, 'Where AI helps', 'the panel gets it')
    assert.equal(snap.items[0].status, 'active', 'it stays in the Slide Scratchpad')
    // Inserted again: the newer time and slide replace the older ones.
    await store.markInserted(item.id, 'Another slide')
    assert.equal(stateOf(talk).items[0].insertedInto, 'Another slide')
    const reread = await createScratchpadStore(talk, options()).load()
    assert.equal(reread.items[0].insertedInto, 'Another slide', 'a new store reads it back')
    assert.deepEqual(reread.notices, [])
    assert.equal(readFileSync(join(scratch(talk), 'chart.png'), 'utf8'), 'PNGBYTES', 'the agent file is untouched')
    await assert.rejects(store.markInserted('sp-gone', 'X'), /not in the Slide Scratchpad/)
    // An unreadable insertedAt is dropped, never the item.
    const state = stateOf(talk); state.items[0].insertedAt = 'yesterday'
    writeFileSync(join(scratch(talk), 'scratchpad-state.json'), JSON.stringify(state))
    const lenient = await createScratchpadStore(talk, options()).load()
    assert.equal(lenient.items.length, 1); assert.equal(lenient.items[0].insertedAt, undefined)
  })

  await test('a folder created during watcher registration is discovered even if its first event is not delivered', async () => {
    const talk = newTalk()
    const original = fs.watch
    const attached = []
    let fired = 0
    // Model an OS watcher whose event stream has not started delivering yet. No production
    // dependency seam is needed: this isolated process restores the builtin before the next case.
    fs.watch = (path) => { attached.push(String(path)); return { on() { return this }, close() {} } }
    syncBuiltinESMExports()
    let watcher
    try {
      watcher = watchScratchFolder(talk, () => { fired++ }, 10)
      mkdirSync(scratch(talk))
      const end = Date.now() + 1000
      while (!fired && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(fired, 1, 'startup reconciliation notices the new folder without an OS event')
      assert.deepEqual(attached, [talk, scratch(talk)], 'the new folder gets its own watcher')
      const closedTalk = newTalk()
      let afterClose = 0
      const closedWatcher = watchScratchFolder(closedTalk, () => { afterClose++ }, 10)
      closedWatcher.close()
      mkdirSync(scratch(closedTalk))
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(afterClose, 0, 'closing before reconciliation suppresses its notification')
      const existingTalk = newTalk()
      mkdirSync(scratch(existingTalk))
      let initial = 0
      const existingWatcher = watchScratchFolder(existingTalk, () => { initial++ }, 10)
      await new Promise((resolve) => setTimeout(resolve, 30))
      existingWatcher.close()
      assert.equal(initial, 0, 'an unchanged existing folder does not generate an initial notification')
    } finally {
      watcher?.close()
      fs.watch = original
      syncBuiltinESMExports()
    }
  })

  await test('the watcher fires once, debounced, for a new file and for a folder that appears later; not for the state file', async () => {
    const talk = newTalk()
    let fired = 0
    const watch = watchScratchFolder(talk, () => { fired++ }, 80)
    const settle = (ms) => new Promise((r) => setTimeout(r, ms))
    const until = async (cond, ms = 5000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await settle(25); return cond() }
    try {
      mkdirSync(scratch(talk))
      assert.ok(await until(() => fired >= 1), 'the folder appearing is noticed')
      await settle(400); fired = 0
      writeFileSync(join(scratch(talk), 'a.svg'), 'x'); writeFileSync(join(scratch(talk), 'b.svg'), 'x')
      assert.ok(await until(() => fired >= 1), 'a new file is noticed')
      await settle(600)
      assert.equal(fired, 1, 'two files close together are one notification')
      fired = 0
      writeFileSync(join(scratch(talk), 'scratchpad-state.json'), '{}'); writeFileSync(join(scratch(talk), '.scratchpad-state.json.1.abcd.tmp'), '{}')
      await settle(800)
      assert.equal(fired, 0, 'the app\'s own state writes do not wake it')
    } finally { watch.close() }
    fired = 0
    writeFileSync(join(scratch(talk), 'c.svg'), 'x'); await settle(500)
    assert.equal(fired, 0, 'a closed watcher is silent')
  })
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log(`${checks} checks passed`)

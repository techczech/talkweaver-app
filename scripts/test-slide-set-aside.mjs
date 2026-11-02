import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as core from '../src/renderer/src/lib/slideSetAside.ts'
import { createScratchpadStore } from '../src/main/scratchpad-store.ts'
import { registerScratchpadIpc } from '../src/main/scratchpad-ipc.ts'
import { createOutlineMutator } from '../src/renderer/src/lib/outlineMutation.ts'
import { cutBlocks } from '../src/shared/slide-handling/blocks.ts'
import { outlineWritesSettled, queueOutlineWrite } from '../src/renderer/src/lib/saveQueue.ts'
const original = '# Talk\n\n## Section {id=sect1}\n\n### A {id=aaaaa}\n\n![x](assets/x.svg)\n\n## End {id=end01}\n\n### B {id=bbbbb}\n\nBody B\n'
const refs = [{ line: 3, headingText: '## Section {id=sect1}' }, { line: 5, headingText: '### A {id=aaaaa}' }, { line: 11, headingText: '### B {id=bbbbb}' }]
const metadata = { talkPath: 'talk/talk-outline.md', talkTitle: 'Talk', thumbKey: '' }
let checks = 0
assert.equal(typeof core.runSetAside, 'function', 'set aside has a tested ordering operation')
for (const scenario of ['success', 'scratch-false', 'scratch-throw', 'outline-false', 'outline-throw', 'stale-heading', 'changed-body', 'other-talk', 'double-click']) {
  let text = original, path = '/v/talk/talk-outline.md', copies = [], calls = [], release
  const host = {
    get outlinePath() { return path },
    settled: async () => {},
    read: () => ({ path, text }),
    copy: async (inputs) => {
      calls.push('copy'); assert.equal(text, original)
      if (scenario === 'scratch-false') return { ok: false, error: 'disk full' }
      if (scenario === 'scratch-throw') throw Error('disk full')
      copies = inputs
      if (scenario === 'stale-heading') text = text.replace('## Section', '## Changed')
      if (scenario === 'changed-body') text = text.replace('Body B', 'New body B')
      if (scenario === 'other-talk') path = '/v/else.md'
      if (scenario === 'double-click') await new Promise(r => { release = r })
      return { ok: true }
    },
    apply: async (p, mutate, options) => {
      calls.push('outline'); assert.equal(copies.length, 2); assert.equal(options.ownUndoStep, true)
      if (scenario === 'outline-throw') throw Error('outline failed')
      if (scenario === 'outline-false') return { ok: false, applied: false, error: 'outline failed' }
      if (options.base !== text) return { ok: false, applied: false, error: 'changed' }
      text = mutate(text); return { ok: true }
    }, notify: (message) => calls.push(message)
  }
  const first = core.runSetAside(host, refs, metadata)
  if (scenario === 'double-click') { assert.equal(await core.runSetAside(host, refs, metadata), false); await Promise.resolve(); release() }
  const ok = await first
  assert.equal(ok, scenario === 'success' || scenario === 'double-click', scenario)
  assert.equal(calls[0], 'copy')
  if (scenario.startsWith('scratch-')) { assert.equal(text, original); assert(!calls.includes('outline')); assert.equal(copies.length, 0) }
  else {
    assert.equal(copies[0].slideId, 'sect1'); assert.equal(copies[1].slideId, 'bbbbb')
    assert.equal(copies[0].markdown, original.split('\n').slice(2, 8).join('\n') + '\n')
    assert.match(copies[0].markdown, /assets\/x.svg/)
    if (ok) assert.equal(text, cutBlocks(original, refs).text)
    else assert(calls.some(c => /Scratchpad/.test(c)), 'failure says where the saved copies are')
    if (scenario.startsWith('outline-') || scenario === 'other-talk') assert.equal(text, original)
  }
  checks++
}
// The real one-writer seam keeps a failed disk save undoable in the editor; copies remain confirmed.
{
  let text = original, copied = false, message = '', disk = original
  const mutator = createOutlineMutator({
    bufferFor: () => ({ read: () => text, apply: (_path, next) => { text = next; return text }, adopt: () => {} }),
    settled: async () => {}, write: async () => ({ ok: false })
  })
  const host = { outlinePath: '/v/t.md', settled: async () => {}, read: () => ({ path: '/v/t.md', text }), copy: async () => { copied = true; return { ok: true } }, apply: mutator.apply, notify: value => { message = value } }
  assert.equal(await core.runSetAside(host, refs, metadata), false)
  assert(copied); assert.equal(text, cutBlocks(original, refs).text); assert.equal(disk, original)
  assert.match(message, /Scratchpad copies have been kept/); assert.match(message, /Undo restores/)
  assert.match(message, /out of the talk in the editor/)
  assert.match(message, /talk file could not be saved yet/)
  assert.doesNotMatch(message, /could not be removed/)
  checks++
}
// Refusal before the first write, including a changed heading at the same line.
for (const bad of [[{ line: 3, headingText: '## Another section' }], [{ line: 1, headingText: '# Talk' }], []]) {
  let writes = 0
  assert.equal(await core.runSetAside({ outlinePath: '/v/t.md', settled: async () => {}, read: () => ({ path: '/v/t.md', text: original }), copy: async () => { writes++; return { ok: true } }, apply: async () => { writes++; return { ok: true } }, notify: () => {} }, bad, metadata), false)
  assert.equal(writes, 0); checks++
}
// A queued save can adopt stamped ids into the buffer: read and copy only after it has finished.
{
  const path = '/v/save-in-flight.md'
  let text = original, reads = 0, copies = [], release
  const gate = new Promise(resolve => { release = resolve })
  const adopted = original.replace('Body B', 'Body B saved')
  const pendingSave = queueOutlineWrite(path, async () => { await gate; text = adopted })
  const host = {
    outlinePath: path,
    settled: () => outlineWritesSettled(path),
    read: () => { reads++; return { path, text } },
    copy: async inputs => { copies = inputs; return { ok: true } },
    apply: async (_path, mutate) => { text = mutate(text); return { ok: true } },
    notify: () => {}
  }
  const operation = core.runSetAside(host, refs, metadata)
  await Promise.resolve()
  assert.equal(reads, 0, 'the buffer is not read while a previous save is in flight')
  assert.equal(copies.length, 0, 'no stale snapshot is copied')
  release(); await pendingSave
  assert.equal(await operation, true)
  assert.match(copies[1].markdown, /Body B saved/)
  assert.equal(text, cutBlocks(adopted, refs).text)
  checks++
}
// Switching to a talk with the same headings during the wait must not redirect the copy or removal.
{
  let path = '/v/original-talk.md', copies = 0, applied = 0, release
  const gate = new Promise(resolve => { release = resolve })
  const host = {
    get outlinePath() { return path }, settled: () => gate,
    read: () => ({ path, text: original }),
    copy: async () => { copies++; return { ok: true } },
    apply: async () => { applied++; return { ok: true } }, notify: () => {}
  }
  const operation = core.runSetAside(host, refs, metadata)
  path = '/v/other-talk.md'; release()
  assert.equal(await operation, false, 'a changed talk refuses the operation after settling')
  assert.equal(copies, 0, 'no snapshot goes into the newly opened talk')
  assert.equal(applied, 0, 'neither talk is changed')
  checks++
}
const root = mkdtempSync(join(tmpdir(), 'tw-set-aside-'))
try {
  const store = createScratchpadStore(root, { now: () => new Date('2026-10-28T10:00:00Z') })
  const inputs = [{ ...metadata, slideId: 'aaaaa', title: 'A', markdown: '### A {id=aaaaa}\n\n![x](assets/x.svg)\n' }]
  const reply = await store.setAside(inputs)
  const disk = JSON.parse(readFileSync(join(root, 'scratchpad/scratchpad-state.json'), 'utf8'))
  assert.equal(disk.groups[0].name, 'Set aside · 2026-10-28'); assert.equal(disk.items[0].slide.markdown, inputs[0].markdown)
  assert.equal(reply.items[0].id, disk.items[0].id)
  // Picking an already copied slide still deduplicates; destructive Set aside is tested separately below.
  await store.addSlides(inputs); assert.equal((await store.load()).items.length, 1, 'retry reuses an identical snapshot')
  await assert.rejects(store.setAside([...inputs, { ...inputs[0], markdown: 'x'.repeat(400001) }]))
  assert.equal((await store.load()).items.length, 1, 'invalid input refuses the whole batch')
  checks++
  const handlers = new Map()
  let open = join(root, 'talk-outline.md')
  const ipc = registerScratchpadIpc({ ipc: { handle: (channel, handler) => handlers.set(channel, handler) }, outlinePathFor: () => open, htmlPreview: async () => ({ error: 'unused' }), revealFolder: () => {} })
  try {
    const invoke = handlers.get('scratchpad:set-aside')
    const expected = open; open = join(root, 'other', 'talk-outline.md')
    assert.equal((await invoke({}, inputs, expected)).ok, false, 'a queued request cannot copy into a different open talk')
    open = expected
    assert.equal((await invoke({}, inputs, expected)).ok, true)
    assert.equal((await invoke({}, [{ ...inputs[0], markdown: 'bad' }], expected)).ok, false)
    checks++
  } finally { ipc.closeAll() }
  const linked = join(root, 'linked'); mkdirSync(linked); symlinkSync(join(root, 'scratchpad'), join(linked, 'scratchpad'))
  await assert.rejects(createScratchpadStore(linked).setAside(inputs)); checks++
  for (const scenario of ['identical blocks in one batch', 'same id-less block at different times']) {
    const dir = join(root, scenario); mkdirSync(dir)
    let at = new Date('2026-10-28T10:00:00Z')
    const store = createScratchpadStore(dir, { now: () => at })
    const block = '## Break\n\n'
    let text = scenario === 'identical blocks in one batch' ? '# Talk\n\n' + block + block : '# Talk\n\n' + block
    const host = {
      outlinePath: join(dir, 'talk-outline.md'),
      settled: async () => {}, read: () => ({ path: join(dir, 'talk-outline.md'), text }),
      copy: async inputs => { await store.setAside(inputs); return { ok: true } },
      apply: async (_path, mutate) => { text = mutate(text); return { ok: true } }, notify: () => {}
    }
    const selected = [{ line: 3, headingText: '## Break' }]
    if (scenario === 'identical blocks in one batch') selected.push({ line: 5, headingText: '## Break' })
    assert.equal(await core.runSetAside(host, selected, metadata), true, scenario)
    if (scenario === 'same id-less block at different times') {
      text = '# Talk\n\n' + block; at = new Date('2026-10-28T11:00:00Z')
      assert.equal(await core.runSetAside(host, selected, metadata), true, scenario)
    }
    assert.equal(text.includes('## Break'), false, scenario + ': every block was removed')
    const disk = JSON.parse(readFileSync(join(dir, 'scratchpad/scratchpad-state.json'), 'utf8'))
    assert.equal(disk.items.length, 2, scenario + ': every removed block has its own stored item')
    assert.equal(new Set(disk.items.map(item => item.id)).size, 2, scenario + ': distinct identities')
    assert.deepEqual(disk.items.map(item => item.slide.markdown), [block, block], scenario + ': verbatim copies')
    assert.equal((await store.load()).items.length, 2, scenario + ': both copies survive reload')
    checks++
  }
} finally { rmSync(root, { recursive: true, force: true }) }
console.log(`${checks} set-aside checks passed`)

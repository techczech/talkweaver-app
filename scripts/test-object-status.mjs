// Object cards' file status (src/main/object-status.ts, renderer status.ts): main answers only the
// window's own talk; every reference is checked for containment in the talk's media folders before
// anything on disk is looked at; links that leave the folders, `..` and absolute escapes answer
// "outside"; web addresses are never fetched; a request is capped and time-bounded. The editor holds
// the answers in a state field and a card shows "File not found" / "Outside this talk's vault".
// Real temp folders; CodeMirror state only; nothing on screen.
import { strict as assert } from 'node:assert'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  MAX_STATUS_REFS, answerObjectStatus, objectRefStatus, registerObjectStatusIpc
} from '../src/main/object-status.ts'
import { installTestDom } from './test-dom.mjs'
import { gateFsOps, settle } from './fs-op-gate.mjs'

installTestDom()
const { objectBlocksExtension, objectBlocksIn, setExpandedObjectBlock } = await import('../src/renderer/src/extensions/objectBlocks/field.ts')
const { setObjectStatuses, objectStatusField, cardFileNote, cardStatusRefs } = await import('../src/renderer/src/extensions/objectBlocks/status.ts')
const { changedStatuses, documentStatusRefs } = await import('../src/renderer/src/extensions/objectBlocks/commands.ts')
const { CardWidget, cardMediaFacet } = await import('../src/renderer/src/extensions/objectBlocks/cardWidgets.ts')

const base = realpathSync(mkdtempSync(join(tmpdir(), 'tw-object-status-')))
process.on('exit', () => rmSync(base, { recursive: true, force: true }))
let passed = 0
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`) }

// A vault holding one talk, a pooled picture, a link inside and a link out; a folder outside the vault.
const vault = join(base, 'vault')
const talkDir = join(vault, 'talks', 'one')
const outside = join(base, 'elsewhere')
mkdirSync(join(talkDir, 'media'), { recursive: true })
mkdirSync(join(vault, '_assets'), { recursive: true })
mkdirSync(outside, { recursive: true })
writeFileSync(join(talkDir, 'media', 'page.html'), '<p>hi</p>')
writeFileSync(join(talkDir, 'media', 'my view.png'), 'x')
writeFileSync(join(vault, '_assets', 'img-abcdef1.png'), 'x')
writeFileSync(join(outside, 'secret.html'), 'secret')
symlinkSync(join(outside, 'secret.html'), join(talkDir, 'media', 'escape.html'))
symlinkSync(join(talkDir, 'media', 'page.html'), join(talkDir, 'media', 'alias.html'))
const outline = join(talkDir, 'talk.md')
const ctx = { talkDir, roots: [vault], vaultRoot: vault }
const looked = []
const spyFs = { isFile: async (p) => { looked.push(p); try { return lstatSync(p).isFile() } catch { return null } } }

console.log('Main: one reference')
await test('a file in the talk folder is present, with its path; a percent-encoded name is decoded', async () => {
  assert.equal((await objectRefStatus('media/page.html', ctx)).state, 'present')
  assert.equal((await objectRefStatus('media/page.html', ctx)).path, join(talkDir, 'media', 'page.html'))
  assert.equal((await objectRefStatus('media/my%20view.png', ctx)).state, 'present')
  assert.equal((await objectRefStatus('media/page.html?x=1#y', ctx)).state, 'present')
})
await test('a missing file inside the vault is missing; a folder is not a file', async () => {
  assert.equal((await objectRefStatus('media/gone.html', ctx)).state, 'missing')
  assert.equal((await objectRefStatus('media', ctx)).state, 'invalid')
})
await test('`..` and absolute paths out of the vault are outside, and nothing on disk is looked at', async () => {
  looked.length = 0
  assert.equal((await objectRefStatus('../../../elsewhere/secret.html', ctx, spyFs)).state, 'outside')
  assert.equal((await objectRefStatus(join(outside, 'secret.html'), ctx, spyFs)).state, 'outside')
  assert.equal((await objectRefStatus('/etc/passwd', ctx, spyFs)).state, 'outside')
  assert.deepEqual(looked, [], 'no stat for a path outside the folders')
})
await test('a link that leaves the vault is outside; a link that stays inside is followed', async () => {
  assert.equal((await objectRefStatus('media/escape.html', ctx)).state, 'outside')
  assert.equal((await objectRefStatus('media/alias.html', ctx)).state, 'present')
})
await test('web addresses are remote (never fetched); other schemes, NUL and over-long refs are invalid', async () => {
  assert.equal((await objectRefStatus('https://example.org/a', ctx)).state, 'remote')
  assert.equal((await objectRefStatus('file:///etc/passwd', ctx)).state, 'invalid')
  assert.equal((await objectRefStatus('javascript:alert(1)', ctx)).state, 'invalid')
  assert.equal((await objectRefStatus('media/page.html\0', ctx)).state, 'invalid')
  assert.equal((await objectRefStatus('a'.repeat(5000), ctx)).state, 'invalid')
  assert.equal((await objectRefStatus(42, ctx)).state, 'invalid')
})
await test('pooled ids resolve in the vault pool only', async () => {
  assert.equal((await objectRefStatus('img-abcdef1', ctx)).state, 'present')
  assert.equal((await objectRefStatus('img-0000000', ctx)).state, 'missing')
  assert.equal((await objectRefStatus('img-abcdef1', { ...ctx, vaultRoot: undefined })).state, 'missing')
})

console.log('Main: the request')
const deps = { currentTalkOf: (id) => (id === 7 ? outline : null), contextFor: () => ctx }
await test('only the window that has the talk open is answered, and only for that talk', async () => {
  assert.deepEqual(await answerObjectStatus(8, outline, ['media/page.html'], deps), { ok: false, reason: 'not-current-talk' })
  assert.deepEqual(await answerObjectStatus(7, join(vault, 'talks', 'two', 'talk.md'), ['x'], deps), { ok: false, reason: 'not-current-talk' })
  assert.deepEqual(await answerObjectStatus(7, outline, 'media/page.html', deps), { ok: false, reason: 'invalid-input' })
  const ok = await answerObjectStatus(7, outline, ['media/page.html', 'media/page.html', 3], deps)
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.statuses.map((s) => s.ref), ['media/page.html'], 'duplicates and non-strings dropped')
})
await test('a request is capped in count', async () => {
  const refs = Array.from({ length: MAX_STATUS_REFS + 50 }, (_, i) => `media/n${i}.png`)
  assert.equal((await answerObjectStatus(7, outline, refs, deps)).statuses.length, MAX_STATUS_REFS)
})
await test('past the time budget the rest answer unchecked, without a look on disk; main is never held', async () => {
  looked.length = 0
  // Each look takes 200 ms of a 250 ms budget; a timer set at the start must still run in between.
  const slowFs = { isFile: (p) => { looked.push(p); return new Promise((done) => setTimeout(() => done(true), 200)) } }
  let ticks = 0
  const ticker = setInterval(() => { ticks += 1 }, 10)
  const t0 = performance.now()
  const answer = await answerObjectStatus(7, outline, ['media/page.html', 'media/my%20view.png', 'media/gone.html'], { ...deps, fs: slowFs })
  const ms = performance.now() - t0
  clearInterval(ticker)
  assert.deepEqual(answer.statuses.map((s) => s.state), ['present', 'unchecked', 'unchecked'])
  assert.equal(looked.length, 2, 'the look in flight at the deadline is abandoned; none is started after it')
  assert.ok(ms < 330, `answered at the deadline, not after the slow look (${ms} ms)`)
  assert.ok(ticks >= 10, `main kept running while the disk was slow (${ticks} ticks)`)
})
await test('a look the disk refuses answers unchecked, never outside or missing', async () => {
  const deniedFs = { isFile: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) } }
  const answer = await answerObjectStatus(7, outline, ['media/page.html'], { ...deps, fs: deniedFs })
  assert.deepEqual(answer.statuses, [{ ref: 'media/page.html', state: 'unchecked' }])
})
await test('the real check: a folder the disk will not open answers unchecked; the containment rule matches the blocking one', async () => {
  const { pathStaysInside, pathStaysInsideAsync } = await import('../src/main/path-containment.ts')
  for (const candidate of ['media/page.html', 'media/alias.html', 'media/escape.html', '../../../elsewhere/secret.html', 'media/new/none.html', '/etc/passwd']) {
    const full = join(talkDir, candidate)
    assert.equal(await pathStaysInsideAsync(vault, full), pathStaysInside(vault, full), candidate)
  }
  const locked = join(talkDir, 'locked')
  mkdirSync(locked)
  writeFileSync(join(locked, 'a.html'), 'x')
  chmodSync(locked, 0o000)
  try {
    if (process.getuid?.() !== 0) {
      const answer = await answerObjectStatus(7, outline, ['locked/a.html'], deps)
      assert.deepEqual(answer.statuses, [{ ref: 'locked/a.html', state: 'unchecked' }])
    }
  } finally { chmodSync(locked, 0o755) }
})
await test('every disk operation, held past the deadline: the rest answer unchecked and NO operation starts after the answer', async () => {
  // Review of 03756f0f: the reviewer held the containment look of the first reference; here every one is held in turn.
  const refs = ['media/page.html', 'media/alias.html', 'img-abcdef1', 'media/gone.html']
  const gate = gateFsOps()
  try {
    gate.holdAt(-1)
    assert.deepEqual((await answerObjectStatus(7, outline, refs, deps)).statuses.map((s) => s.state), ['present', 'present', 'present', 'missing'])
    const sequence = gate.ops.map((op) => op.name)
    for (let k = 0; k < sequence.length; k += 1) {
      gate.holdAt(k)
      const answer = await answerObjectStatus(7, outline, refs, { ...deps, budgetMs: k === 0 ? undefined : 20 })
      const answeredAt = performance.now()
      assert.ok(answer.statuses.some((s) => s.state === 'unchecked'), `held ${sequence[k]}`)
      gate.release()
      await settle()
      assert.deepEqual(gate.startedAfter(answeredAt), [], `held ${sequence[k]} (operation ${k} of ${sequence.length}): nothing new after the answer`)
    }
  } finally { gate.restore() }
})
await test('a window that changed talk while the disk was looked at is not answered', async () => {
  let talk = outline
  const switching = { ...deps, currentTalkOf: () => talk, fs: { isFile: async () => { talk = join(vault, 'talks', 'two', 'talk.md'); return true } } }
  assert.deepEqual(await answerObjectStatus(7, outline, ['media/page.html'], switching), { ok: false, reason: 'not-current-talk' })
})
await test('the IPC handler answers by the sender id main knows, not by anything the renderer says', async () => {
  const handlers = new Map()
  registerObjectStatusIpc({ ...deps, ipcMain: { handle: (channel, fn) => { handlers.set(channel, fn) } } })
  assert.deepEqual([...handlers.keys()], ['object:status', 'object:earlier-views'])
  const handler = handlers.get('object:status')
  assert.equal((await handlers.get('object:earlier-views')({ sender: { id: 8 } }, outline, 'https://example.org/')).ok, false)
  assert.equal((await handler({ sender: { id: 8 } }, outline, ['media/page.html'])).ok, false)
  assert.equal((await handler({ sender: { id: 7 } }, outline, ['media/page.html'])).statuses[0].state, 'present')
})

console.log('Editor: statuses on cards')
const TALK = '# T\n\n## Page\n\n[Embed: media/page.html]\n\n## Web\n\n[Embed: https://example.org/page]\n<!-- saved views {capture} -->\n![View one](assets/live-page-captures/0123456789abcdef.jpg){capture}\n'
await test('a card names its local file and its saved-view pictures; a web page itself is not asked about', async () => {
  const blocks = detectBlocks(TALK)
  assert.deepEqual(blocks.map(cardStatusRefs), [['media/page.html'], ['assets/live-page-captures/0123456789abcdef.jpg']])
  assert.deepEqual(documentStatusRefs(blocks), ['media/page.html', 'assets/live-page-captures/0123456789abcdef.jpg'])
})
await test('only changed statuses are dispatched', async () => {
  const held = new Map([['a', { state: 'present', path: '/v/a' }]])
  assert.equal(changedStatuses(held, new Map([['a', { state: 'present', path: '/v/a' }]])), null)
  assert.deepEqual([...changedStatuses(held, new Map([['a', { state: 'missing' }], ['b', { state: 'outside' }]])).keys()], ['a', 'b'])
})
await test('a missing page and an outside picture show on the card; the picture thumbnail is not loaded', async () => {
  let resolved = 0
  let state = EditorState.create({ doc: TALK, extensions: [objectBlocksExtension({}), cardMediaFacet.of({ resolveImage: () => { resolved += 1; return 'blob:x' } })] })
  const web = objectBlocksIn(state).find((b) => b.embed?.captures.length)
  state = state.update({ effects: [
    setObjectStatuses.of(new Map([['media/page.html', { state: 'missing' }], ['assets/live-page-captures/0123456789abcdef.jpg', { state: 'outside' }]])),
    setExpandedObjectBlock.of({ from: web.from, expanded: true })
  ] }).state
  assert.equal(state.field(objectStatusField).get('media/page.html').state, 'missing')
  const view = { state, dispatch() {}, focus() {} }
  const texts = cardWidgets(state).map((w) => allText(w.toDOM(view)))
  assert.ok(texts[0].includes('File not found'), texts[0])
  assert.ok(texts[1].includes('Outside this talk’s vault'), texts[1])
  assert.equal(resolved, 0, 'no thumbnail for a picture outside the vault')
  const present = state.update({ effects: setObjectStatuses.of(new Map([['assets/live-page-captures/0123456789abcdef.jpg', { state: 'present' }]])) }).state
  cardWidgets(present).map((w) => w.toDOM({ state: present, dispatch() {}, focus() {} }))
  assert.equal(resolved, 1, 'a present picture is shown')
  assert.equal(cardFileNote({ state: 'present' }), null)
  assert.equal(cardFileNote({ state: 'unchecked' }), null)
})
await test('a status change redraws only the card it belongs to', async () => {
  let state = EditorState.create({ doc: TALK, extensions: [objectBlocksExtension({})] })
  const before = cardWidgets(state)
  state = state.update({ effects: setObjectStatuses.of(new Map([['assets/live-page-captures/0123456789abcdef.jpg', { state: 'missing' }]])) }).state
  const after = cardWidgets(state)
  assert.equal(after[0].eq(before[0]), true)
  assert.equal(after[1].eq(before[1]), false)
})

function allText(node) { return [node.textContent ?? '', ...(node.children ?? []).map(allText)].join(' ') }

function cardWidgets(state) {
  const found = []
  for (const source of state.facet(EditorView.decorations)) {
    if (typeof source === 'function') continue
    source.between(0, state.doc.length, (_f, _t, value) => { if (value.spec.widget instanceof CardWidget) found.push(value.spec.widget) })
  }
  return found
}
function detectBlocks(text) {
  return objectBlocksIn(EditorState.create({ doc: text, extensions: [objectBlocksExtension({})] }))
}

console.log(`\n${passed} object status checks passed`)

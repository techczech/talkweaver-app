// ADR-0044 §6, rules B and D: the editor's close for every close (lib/closeFreeze.ts) and main's record of saves by
// revision (src/main/editor-revisions.ts). Plain Node. The windows end to end are in scripts/test-update-install.mjs
// and scripts/test-update-engine.mjs (stand-ins with these real modules); the real editor in e2e/diagnose-close-freeze.mjs.
import { readMainSource } from './lib/read-source.mjs'
import assert from 'node:assert/strict'
import { createEditorRevisions } from '../src/main/editor-revisions.ts'
import { CLOSE_CONFIRM_ATTEMPTS, closeFrozen } from '../src/renderer/src/lib/closeFreeze.ts'

import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import * as drafts from '../src/renderer/src/lib/talkDrafts.ts'
import { mountShell, textareaEditor } from '../src/renderer/src/objects/shell.ts'
import { installTestDom } from './test-dom.mjs'

let passed = 0
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS  ${name}`) } catch (error) { console.error(`FAIL  ${name}`); throw error }
}

// Execute Editor's real write callback with an undo buffer whose missing id main stamps again.
await test('save acknowledgement after undo is clean without adopting ids; a newer buffer stays dirty', async () => {
  const source = readFileSync(new URL('../src/renderer/src/components/Editor.tsx', import.meta.url), 'utf8')
  const start = source.indexOf('const writeQueued = useCallback(')
  const end = source.indexOf('\n  const scheduleAutosave', start)
  const js = stripTypeScriptTypes(source.slice(start, end), { mode: 'strip' })
  const authored = '### New slide\n\nBody\n'
  const stamped = '### New slide\n{id=new}\n\nBody\n'
  for (const newer of [false, true]) {
    const baseline = { text: null, dirty: true }
    let current = authored
    const state = { doc: { toString: () => current }, toText: s => ({ toString: () => s }) }
    const wiring = {
      useCallback: fn => fn, saveTimerRef: { current: null }, cleanDocumentRef: { current: baseline },
      editorRevision: { current: () => 2 }, outlineDiskChanges: { isDiscarded: () => false },
      queueOutlineWrite: async (_path, work) => work(),
      window: { tw: { talk: { writeOutline: async () => { if (newer) current += 'NEWER'; return { ok: true, content: stamped } } } } },
      onSaved: undefined, loadedPathRef: { current: '/talk' }, viewRef: { current: { state } },
      // Real adoption intentionally does nothing after undo, preserving redo history.
      adoptStampedContent: () => {}, onDirtyRef: { current: () => {} },
    }
    const write = new Function(...Object.keys(wiring), js + '; return writeQueued')(...Object.values(wiring))
    assert.equal(await write('/talk', authored, authored, 2), true)
    assert.equal(baseline.dirty, newer, 'only authored text changed since the acknowledged save is unsaved')
    assert.equal(current, authored + (newer ? 'NEWER' : ''), 'the undo buffer and history need no adoption')
  }
})

await test('a stalled close save is bounded, reports failure, unfreezes, and never confirms after a late save', async () => {
  const { mock } = await import('node:test')
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const s = script()
    let finish
    s.deps.settle = async (signal) => { s.signal = signal; await new Promise(r => { finish = r }) }
    s.deps.failed = () => s.log.push('failed')
    let result
    const closing = closeFrozen(s.deps).then(value => { result = value })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    mock.timers.tick(10_001)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    assert.equal(result, 'kept', 'a stuck save must finish the close attempt after ten seconds')
    await closing
    assert.equal(s.frozen, 0)
    assert.ok(s.log.includes('failed'))
    assert.equal(s.signal.aborted, true)
    finish()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    assert.equal(s.log.some(x => x.startsWith('confirm')), false, 'late save completion cannot close an editable window')
  } finally { mock.timers.reset() }
})

await test('editor revisions: the restart closes only on the successful save of exactly the revision confirmed, with nothing still writing', () => {
  const r = createEditorRevisions()
  r.loaded(1, 4)
  assert.equal(r.verdict(1, 4, 'restart'), 'saved', 'loaded and untouched')
  assert.equal(r.verdict(1, 5, 'restart'), 'resave', 'typed since the load: not on disk')
  const done = r.writeStarted(1, 5)
  assert.equal(r.verdict(1, 5, 'restart'), 'resave', 'still writing')
  assert.equal(r.verdict(1, 5, 'close'), 'resave', 'still writing, ordinary close too')
  done(true)
  assert.equal(r.verdict(1, 5, 'restart'), 'saved')
  assert.equal(r.verdict(1, 6, 'restart'), 'resave', 'SECOND_EDIT after the save: its revision was never written')
  const failed = r.writeStarted(1, 6)
  failed(false)
  assert.equal(r.verdict(1, 6, 'restart'), 'resave', 'a failed save is not a saved revision')
  assert.equal(r.verdict(1, 6, 'close'), 'saved', 'the ordinary close: tried, so its failure keeps its old handling')
})

await test('editor revisions: a save without a revision (a workspace write) leaves the record unknown; a later save with one settles it; nonsense revisions never pass', () => {
  const r = createEditorRevisions()
  r.loaded(2, 1)
  r.writeStarted(2, undefined)(true)
  assert.equal(r.verdict(2, 1, 'restart'), 'resave')
  assert.equal(r.verdict(2, 1, 'close'), 'resave')
  r.writeStarted(2, 1)(true)
  assert.equal(r.verdict(2, 1, 'restart'), 'saved')
  for (const bad of [undefined, null, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 2]) assert.equal(r.verdict(2, bad, 'close'), 'resave', String(bad))
})

await test('editor revisions: a window with no record (no talk loaded through the guard) and a discarded talk', () => {
  const r = createEditorRevisions()
  assert.equal(r.verdict(3, 0, 'close'), 'saved', 'nothing of the person\'s was ever written or loaded here')
  assert.equal(r.verdict(3, 0, 'restart'), 'resave', 'the restart wants a positive record')
  r.loaded(3, 0)
  r.discarded(3)
  assert.equal(r.verdict(3, 9, 'close'), 'saved', 'discarded by the person: nothing to save')
  assert.equal(r.verdict(3, 9, 'restart'), 'resave', 'never counted as saved for an update')
  r.forget(3)
  assert.equal(r.verdict(3, 0, 'close'), 'saved')
})

/** A scripted close: the answers main gives, and what the editor did. */
function script({ leave = true, answers = [true], settleThrows = false, confirmThrows = false } = {}) {
  const s = { log: [], frozen: 0, revision: 7 }
  s.deps = {
    freeze: () => { s.frozen += 1; s.log.push('freeze') },
    unfreeze: () => { s.frozen -= 1; s.log.push('unfreeze') },
    leave: async () => { s.log.push('leave'); return leave },
    settle: async () => { s.log.push('settle'); if (settleThrows) throw new Error('not saved') },
    forceSave: async () => { s.log.push('save'); s.revision += 0 },
    revision: () => s.revision,
    confirm: async (rev) => { s.log.push(`confirm ${rev}`); if (confirmThrows) throw new Error('gone'); return answers.shift() ?? 'resave' },
    kept: async () => { s.log.push('kept') },
  }
  return s
}

await test('close: frozen first; the leave guard; saved until clean; the current revision confirmed; it stays frozen as the window closes', async () => {
  const s = script()
  assert.equal(await closeFrozen(s.deps), 'closed')
  assert.deepEqual(s.log, ['freeze', 'leave', 'settle', 'confirm 7'])
  assert.equal(s.frozen, 1)
})

await test('close: "Stay here" unfreezes and reports the window kept', async () => {
  const s = script({ leave: false })
  assert.equal(await closeFrozen(s.deps), 'kept')
  assert.deepEqual(s.log, ['freeze', 'leave', 'unfreeze', 'kept'])
  assert.equal(s.frozen, 0)
})

await test('close: main answers "resave": one more save, then the revision is confirmed again', async () => {
  const s = script({ answers: ['resave', true] })
  assert.equal(await closeFrozen(s.deps), 'closed')
  assert.deepEqual(s.log, ['freeze', 'leave', 'settle', 'confirm 7', 'save', 'settle', 'confirm 7'])
})

await test(`close: main never records the revision: after ${CLOSE_CONFIRM_ATTEMPTS} confirmations the window stays, unfrozen, and main is told`, async () => {
  const s = script({ answers: [] })
  assert.equal(await closeFrozen(s.deps), 'kept')
  assert.equal(s.log.filter((l) => l.startsWith('confirm')).length, CLOSE_CONFIRM_ATTEMPTS)
  assert.deepEqual(s.log.slice(-2), ['unfreeze', 'kept'])
  assert.equal(s.frozen, 0)
})

await test('close: main keeps the window (a failed save at a restart, a called-off restart): unfrozen, nothing more asked', async () => {
  const s = script({ answers: [false] })
  assert.equal(await closeFrozen(s.deps), 'kept')
  assert.deepEqual(s.log, ['freeze', 'leave', 'settle', 'confirm 7', 'unfreeze'])
})

await test('close: a save that fails does not stop the confirmation (main decides from its own record); a confirmation that throws keeps the window', async () => {
  const s = script({ settleThrows: true })
  assert.equal(await closeFrozen(s.deps), 'closed')
  const t = script({ confirmThrows: true })
  assert.equal(await closeFrozen(t.deps), 'kept')
  assert.equal(t.frozen, 0)
})

await test('update restart: retained Details and design, Advanced and live object drafts keep the editor; ordinary close is unchanged', async () => {
  assert.equal(typeof drafts.updateRestartDraft, 'function', 'the close must query drafts outside the outline')
  const dom = installTestDom()
  try {
    const root = document.createElement('div')
    drafts.clearDrafts('/talk')
    assert.equal(drafts.updateRestartDraft(root), null)
    for (const [part, label] of [['design', 'Details and design'], ['advanced', 'Advanced metadata']]) {
      drafts.keepDraft(part, '/talk', { title: 'draft' }, { title: 'saved' }, { title: true })
      assert.equal(drafts.updateRestartDraft(root), `Save or discard your changes in ${label} to restart.`)
      drafts.keepDraft(part, '/talk', { title: 'saved' }, { title: 'saved' }, { title: true })
    }
    let writes = 0
    const editor = textareaEditor('original')
    const shell = mountShell({ kind: 'Test', editor, foot: '', api: { preflight: () => ({ ok: true }), commit: () => { writes++; return { ok: true } } } })
    root.append(shell)
    assert.equal(drafts.updateRestartDraft(root), null, 'an untouched object has no draft')
    editor.element.value = 'unsaved object'
    assert.equal(drafts.updateRestartDraft(root), 'Save or discard your changes in the object editor to restart.')
    assert.equal(writes, 0, 'checking must not commit or discard')

    // Run the renderer close callback cut from the actual hook, before its freeze can blur an object editor.
    const hook = readFileSync(new URL('../src/renderer/src/components/useOutlineDiskChange.ts', import.meta.url), 'utf8')
    const start = hook.indexOf('({ quit, update }) => {', hook.indexOf('onCloseRequested'))
    const callback = hook.slice(start, hook.indexOf('), [leave])', start))
    const calls = []
    const tw = { talk: { confirmClose: async (opts) => { calls.push(opts); return false }, closeKept: async () => true } }
    const deps = { window: { tw }, document: root, updateRestartDraft: drafts.updateRestartDraft,
      notify: (message) => calls.push(message), editorRevision: { current: () => 1 },
      freezeFor: () => ({ freeze: () => { throw new Error('must not blur and commit a draft') }, unfreeze: () => {} }),
      unfreezeAllRef: { current: new Set() }, wiringRef: { current: { activeOutlinePath: null } },
      closeFrozen: async () => { calls.push('ordinary close'); return 'closed' }, leave: async () => true }
    const run = new Function(...Object.keys(deps), `return (${stripTypeScriptTypes(callback)})`)(...Object.values(deps))
    run({ quit: false, update: true })
    await new Promise((resolve) => setImmediate(resolve))
    assert.ok(calls.some((c) => c?.hasDraft === true), 'the editor answers main with its draft status')
    assert.ok(calls.includes('Save or discard your changes in the object editor to restart.'))
    assert.equal(writes, 0)
    calls.length = 0
    run({ quit: false, update: false })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(calls, ['ordinary close'])

    // Main's real handler must keep a restart window even if the outline revision itself is saved.
    const index = readMainSource()
    const handler = index.slice(index.indexOf("ipcMain.handle('window:confirm-close'"), index.indexOf('// Insert section (talk search 07'))
    let confirm
    const main = { ipcMain: { handle: (_name, fn) => { confirm = fn } },
      editorWindows: new Map([[1, { win: { isDestroyed: () => false, close: () => calls.push('closed') } }]]),
      restartWindows: { waiting: () => true, confirm: (_id, saved) => { calls.push(saved); return saved ? 'close' : 'keep' } },
      editorRevisions: { verdict: () => 'saved' }, editorWorkSaved: () => true,
      cancelQuitAttempt: () => {}, editorQuitAttempts: new Map(), quitAttempt: null,
      closeHolds: new Map(), closeConfirmed: new Set(), clearTimeout, app: { quit: () => {} } }
    new Function(...Object.keys(main), stripTypeScriptTypes(handler))(...Object.values(main))
    calls.length = 0
    assert.equal(confirm({ sender: { id: 1 } }, { revision: 1, hasDraft: true }), false)
    assert.deepEqual(calls, [false], 'main records kept, never closes')
    shell.__twCommit()
    assert.equal(drafts.updateRestartDraft(root), null, 'Done releases the object draft')
  } finally { drafts.clearDrafts(null); dom.restore() }
})

console.log(`close freeze: ${passed} checks passed`)

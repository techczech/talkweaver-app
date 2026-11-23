// Guarded reconciliation over real temporary files, the disk guard, recovery, writer and save queue.
// Execute the actual preservation IPC callback and workspace queued-write function. The editor's
// text is a fake seam here; real CodeMirror undo, typing and modal policies are tested in the DOM suite.
import { readMainSource } from './lib/read-source.mjs'
import assert from 'node:assert/strict'
import ts from 'typescript'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { configureTalkWriter, withTalkFileLock, writeTalkFileInPlace, writeTalkOutline } from '../src/main/talk-writer.ts'
import { canonicalOutlinePath } from '../src/main/outline-identity.ts'
import { createOutlineDiskGuard, hashOutlineText } from '../src/main/outline-disk-guard.ts'
import { createOutlineRecovery } from '../src/main/outline-recovery.ts'
import { outlineWritesSettled, queueOutlineWrite, setOutlinePathResolver } from '../src/renderer/src/lib/saveQueue.ts'
import {
  changedAtLabel, createOutlineDiskChangeStore, describeDiskChange, guardLeave, keepMine, lookForRecovery,
  noteOutlineSaveReply, reloadFromDisk, resolveChoice, saveAfterDiskCleared,
} from '../src/renderer/src/lib/outlineDiskChange.ts'

const root = realpathSync(mkdtempSync(join(tmpdir(), 'tw-disk-change-')))
const OUTLINE = '---\ntitle: Bar Talk\n---\n\n## One {id=aa11}\n\n- x\n'
let seq = 0
const talk = (text = OUTLINE) => {
  const dir = join(root, `talk-${++seq}`)
  mkdirSync(dir)
  const path = join(dir, `talk-${seq}-outline.md`)
  writeFileSync(path, text)
  return path
}
setOutlinePathResolver(async (p) => p)

const store = createOutlineDiskChangeStore()
const recovery = createOutlineRecovery(join(root, 'userData-recovery'))
const guard = createOutlineDiskGuard({
  canonical: canonicalOutlinePath,
  async readText(realPath) { try { return await readFile(realPath, 'utf8') } catch (e) { if (e?.code === 'ENOENT') return null; throw e } },
  async mtime(realPath) { try { return statSync(realPath).mtimeMs } catch { return null } },
  withLock: (outlinePath, work) => withTalkFileLock(outlinePath, () => work()),
  watch() {}, unwatch() {},
  // The push (outline:changed-on-disk) as useOutlineDiskChange handles it.
  notify: (_owner, outlinePath, change) => { if (change) store.report(change); else if (store.get(outlinePath)?.kind !== 'recovery') store.clear(outlinePath) },
})
let afterTruncate = null
configureTalkWriter({ editorBufferFor: () => null, diskGuard: guard, afterTruncate: () => afterTruncate ? afterTruncate() : Promise.resolve() })

// talk:write-outline as index.ts answers the editor's save: a refusal, or any failure of a guarded talk,
// keeps the text in the recovery copy; a failure while a choice is pending comes back as that pending
// difference with the failure (the bar says why); success drops the copy.
async function ipcWrite(outlinePath, text, expectedDiskHash) {
  const written = await writeTalkOutline(outlinePath, text, 'editor', {expectedDiskHash, authorize: () => {
    assert.equal(guard.owns('win', outlinePath), true, 'the saving editor still owns this talk')
  }})
  if (!written.ok && written.changedOnDisk) {
    await recovery.save(canonicalOutlinePath(outlinePath), text)
    return { ok: false, refused: 'changed-on-disk', change: { ...written.changedOnDisk, outlinePath } }
  }
  if (!written.ok) {
    if (guard.tracks(canonicalOutlinePath(outlinePath))) {
      await recovery.save(canonicalOutlinePath(outlinePath), text)
      const pending = guard.pending(outlinePath)
      if (pending) return { ok: false, refused: 'changed-on-disk', change: { ...pending, outlinePath, saveError: written.error } }
    }
    return false
  }
  await recovery.clear(canonicalOutlinePath(outlinePath))
  return { ok: true, collisions: [] }
}

// A fake editor holding one talk: its buffer, an undo stack, the editor's save path (which, like
// Editor.writeQueued, never saves a discarded talk) and the resolver deps useOutlineDiskChange builds.
function editorFor(outlinePath, text, owner = 'win') {
  guard.track(owner, outlinePath, text) // talk:read-outline with forEditor
  store.loaded(outlinePath)
  const ed = { text, undo: [], asked: [], answers: [] }
  ed.save = async () => {
    if (store.isDiscarded(outlinePath)) return false
    const reply = await queueOutlineWrite(outlinePath, () => ipcWrite(outlinePath, ed.text, ed.diskHash))
    noteOutlineSaveReply(reply, store)
    // Editor.writeQueued drops the adopted hash after a successful save receipt.
    if (reply?.ok) delete ed.diskHash
    return !!reply && reply.ok === true
  }
  ed.deps = {
    store,
    settled: (p) => outlineWritesSettled(p),
    queue: (p, work) => queueOutlineWrite(p, work),
    diskVersion: (p) => guard.diskVersion(p),
    accept: (p, hash, opts) => guard.owns(owner, p) ? guard.accept(owner, p, hash, opts) : Promise.resolve({ ok: false, change: null, error: 'not yours' }),
    readBuffer: (p) => p === outlinePath ? ed.text : null,
    replaceBuffer: (p, next, opts) => { if (p !== outlinePath) return false; ed.undo.push(ed.text); ed.text = next; ed.base = opts?.diskBase ?? ed.base; ed.diskHash = opts?.diskHash; return true },
    saveBuffer: () => ed.save(),
    recovery: (p) => recovery.read(canonicalOutlinePath(p)),
    discardRecovery: async (p) => { await recovery.clear(canonicalOutlinePath(p)); return true },
    discardRemoved: async (p) => { await recovery.clear(canonicalOutlinePath(p)); return true },
    // The leave guard's extra deps: the flush saves pending typing; the sheet answers from a script.
    flush: () => ed.save().then(() => undefined),
    ask: async (change) => { ed.asked.push(change.kind); return ed.answers.shift() ?? 'stay' },
  }
  return ed
}

// Execute the actual main-process preservation handler, including ownership and payload checks.
const mainSource = readMainSource()
const ast = ts.createSourceFile('index.ts', mainSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
let preserveCallback, diskCallback
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'ipcMain.handle' &&
      ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'talk:outline-preserve-merge') preserveCallback = node.arguments[1]
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'ipcMain.handle' &&
      ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === 'talk:outline-disk-version') diskCallback = node.arguments[1]
  ts.forEachChild(node, visit)
}
visit(ast)
assert.ok(preserveCallback)
const handlerCode = ts.transpileModule(`const handler = ${preserveCallback.getText(ast)}`, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
const preserveIPC = Function('outlineDiskGuard', 'outlineRecovery', 'canonicalOutlinePath', handlerCode + ';return handler')(guard, recovery, canonicalOutlinePath)
const diskHandlerCode = ts.transpileModule(`const handler = ${diskCallback.getText(ast)}`, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
const changingMessage = 'The outline is still changing on disk. Nothing was merged; retry after the other editor finishes saving.'
const diskIPC = Function('outlineDiskGuard', diskHandlerCode+';return handler')({owns:()=>true,diskVersion:async()=>{throw Error(changingMessage)}})

const mergeModule = await import('../src/renderer/src/lib/outlineReconcile.ts').catch(() => ({}))
if (typeof mergeModule.prepareOutlineMerge !== 'function') { guard.dispose(); rmSync(root, {recursive:true,force:true}); assert.fail('guarded merge reconciliation must exist') }
const { prepareOutlineMerge, applyOutlineMerge } = mergeModule
const BASE = '# Talk\n\n## One\n{id=a}\n- alpha\n\n## Two\n{id=b}\n- beta\n'
function mergingEditor() {
  const path = talk(BASE), ed = editorFor(path, BASE)
  ed.base = BASE
  ed.archives = []
  Object.assign(ed.deps, {
    readBase: () => ed.base,
    preserve: async (_p, snapshot) => { const file = await preserveIPC({sender:{id:'win'}}, path, snapshot); ed.archives.push(file); return file },
  })
  return { path, ed }
}
try {
  const diskError = await diskIPC({sender:{id:'win'}},'/fixture')
  assert.equal(diskError.error,changingMessage,'N5a: disk errors cross IPC as data, without Electron decorating the message')
  const preloadSource = readFileSync(new URL('../src/preload/index.ts',import.meta.url),'utf8')
  const preloadAst = ts.createSourceFile('preload.ts',preloadSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
  let diskBridge
  const findBridge = node => { if(ts.isPropertyAssignment(node)&&node.name.getText(preloadAst)==='outlineDiskVersion')diskBridge=node.initializer;ts.forEachChild(node,findBridge) }
  findBridge(preloadAst)
  const bridgeCode=ts.transpileModule(`const bridge = ${diskBridge.getText(preloadAst)}`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
  const bridge=Function('ipcRenderer',bridgeCode+';return bridge')({invoke:async()=>diskError})
  await assert.rejects(()=>bridge('/fixture'),e=>e.message===changingMessage,'the renderer gets only the actionable message')
  const { path, ed } = mergingEditor()
  assert.equal(await preserveIPC({sender:{id:'other'}}, path, {base:BASE,mine:BASE,disk:BASE}), null)
  assert.equal(await preserveIPC({sender:{id:'win'}}, path, {base:42,mine:BASE,disk:BASE}), null)
  ed.text = BASE.replace('alpha', 'local')
  writeFileSync(path, BASE.replace('beta', 'external'))
  await guard.check(path)
  const plan = await prepareOutlineMerge(path, ed.deps)
  assert.equal(plan.kind, 'ready')
  assert.equal((await applyOutlineMerge(path, plan.review, {}, ed.deps)).kind, 'saved')
  assert.match(readFileSync(path, 'utf8'), /local/)
  assert.match(readFileSync(path, 'utf8'), /external/)
  const archive = JSON.parse(readFileSync(plan.review.recoveryPath, 'utf8'))
  assert.equal(archive.base, BASE)
  assert.match(archive.mine, /local/)
  assert.match(archive.disk, /external/)
  // Immutable bundles survive successful saves and clearing the latest recovery copy.
  await recovery.clear(path)
  assert.equal(JSON.parse(readFileSync(plan.review.recoveryPath, 'utf8')).mine, archive.mine)
  for (const failure of ['adoption', 'queued-edit']) {
    const refused = mergingEditor()
    refused.ed.text=BASE.replace('alpha','local before refusal')
    writeFileSync(refused.path,BASE.replace('beta','disk before refusal'))
    await guard.check(refused.path)
    const pendingBefore=guard.pending(refused.path)
    const prepared=await prepareOutlineMerge(refused.path,refused.ed.deps)
    let accepts=0
    refused.ed.deps.accept=async()=>{accepts++;throw Error('must not accept')}
    if(failure==='adoption') refused.ed.deps.replaceBuffer=()=>false
    else {
      const queue=refused.ed.deps.queue
      refused.ed.deps.queue=(p,work)=>queue(p,()=>{refused.ed.text+='\n- typed while queued';return work()})
    }
    const result=await applyOutlineMerge(refused.path,prepared.review,{},refused.ed.deps)
    assert.equal(result.kind,failure==='adoption'?'error':'retry')
    assert.equal(accepts,0,`${failure}: acceptance must follow successful adoption`)
    assert.equal(guard.pending(refused.path).hash,pendingBefore.hash,'failed adoption cannot advance/clear main’s pending version')
    assert.match(refused.ed.text,/local before refusal/)
  }
  const autoRemoval=mergingEditor()
  autoRemoval.ed.text=BASE.replace('alpha','typing after removal')
  unlinkSync(autoRemoval.path)
  assert.equal(await autoRemoval.ed.save(),false,'autosave alone must refuse removal')
  assert.equal(existsSync(autoRemoval.path),false,'autosave cannot resurrect a removed talk')
  await assert.rejects(()=>writeTalkFileInPlace(autoRemoval.path,BASE,{authorize:()=>{}}),/owned talk was removed/,'the low-level autosave guard stays in place')
  const unwatchedRemoval=mergingEditor()
  unwatchedRemoval.ed.diskHash=hashOutlineText(BASE)
  unwatchedRemoval.ed.text=BASE.replace('alpha','local after clean adoption')
  writeFileSync(unwatchedRemoval.path,BASE.replace('beta','unseen then removed'))
  await guard.check(unwatchedRemoval.path)
  unlinkSync(unwatchedRemoval.path)
  const removal={outlinePath:unwatchedRemoval.path,kind:'removed',hash:'removed',changedAt:Date.now()}
  store.report(removal) // reconcile discovered null; main's watcher still holds its old changed report
  const recreated=await keepMine(unwatchedRemoval.path,removal,unwatchedRemoval.ed.deps)
  assert.equal(recreated.ok,true,'Save it again must honour explicit removal permission even with an adopted disk hash and a stale main report')
  assert.equal(readFileSync(unwatchedRemoval.path,'utf8'),unwatchedRemoval.ed.text,'recreation writes exactly the editor text')
  assert.equal(guard.owns('win',unwatchedRemoval.path),true,'ownership survives recreation')
  assert.equal(guard.canRecreate(canonicalOutlinePath(unwatchedRemoval.path)),false,'the receipt consumes recreation permission')
  unwatchedRemoval.ed.text+='\n- next keystroke'
  assert.equal(await unwatchedRemoval.ed.save(),true,'later typing autosaves normally')
  assert.equal(readFileSync(unwatchedRemoval.path,'utf8'),unwatchedRemoval.ed.text)
  assert.equal(await guard.check(unwatchedRemoval.path),null,'own saves are acknowledged')
  writeFileSync(unwatchedRemoval.path,BASE.replace('beta','external after recreation'))
  assert.equal((await guard.check(unwatchedRemoval.path)).kind,'changed','watcher checks still detect external edits')

  // A path occupied during staging must never be overwritten by explicit recreation.
  for(const occupant of ['file','directory','symlink']) {
    const target=talk()
    unlinkSync(target)
    await assert.rejects(()=>writeTalkFileInPlace(target,BASE,{
      recreateRemoved:true,authorize:()=>{},
      beforeCopy:async()=>{
        if(occupant==='file')writeFileSync(target,'someone else wrote this')
        else if(occupant==='directory')mkdirSync(target)
        else symlinkSync(join(root,'missing-link-target'),target)
        return true
      },
    }),/already exists.*nothing was saved/i,`${occupant}: exclusive creation must refuse the new occupant`)
    if(occupant==='file')assert.equal(readFileSync(target,'utf8'),'someone else wrote this')
  }
  const revokedCreation=talk()
  unlinkSync(revokedCreation)
  let allowed=true
  await assert.rejects(()=>writeTalkFileInPlace(revokedCreation,BASE,{
    recreateRemoved:true,
    authorize:()=>{if(!allowed)throw Error('Talk ownership changed; nothing was saved')},
    beforeCopy:async()=>{allowed=false;return true},
  }),/ownership changed/)
  assert.equal(existsSync(revokedCreation),false,'revoked ownership must not even create an empty file')
  const missingParent=mergingEditor()
  unlinkSync(missingParent.path)
  await guard.check(missingParent.path)
  await guard.accept('win',missingParent.path,'removed',{keepPending:true})
  rmSync(dirname(missingParent.path),{recursive:true})
  const parentRefusal=await writeTalkOutline(missingParent.path,BASE,'editor',{authorize:()=>{}})
  assert.equal(parentRefusal.ok,false)
  assert.match(parentRefusal.error,/parent folder.*gone.*nothing was saved/i)
  assert.equal(existsSync(dirname(missingParent.path)),false,'recreation never creates parent folders')

  const appended = mergingEditor()
  appended.ed.text=BASE+'\n## Three (typing)\n- my last point'
  writeFileSync(appended.path,BASE+'\n## Four\n{id=d}\n- agent added\n')
  const appendPlan=await prepareOutlineMerge(appended.path,appended.ed.deps)
  assert.equal(appendPlan.kind,'ready')
  assert.equal((await applyOutlineMerge(appended.path,appendPlan.review,{},appended.ed.deps)).kind,'saved')
  assert.match(readFileSync(appended.path,'utf8'),/- my last point\n\n## Four/,'N1/N5b: the guarded writer saves separate appended slides')
  const truncated=mergingEditor()
  truncated.ed.text=BASE.replace('alpha','local edit')
  const prefix=BASE.slice(0,BASE.indexOf('## Two'))
  writeFileSync(truncated.path,prefix)
  const truncatedPlan=await prepareOutlineMerge(truncated.path,truncated.ed.deps)
  assert.equal(truncatedPlan.kind,'conflict','N4: paused trailing deletion must not auto-save over disk')
  assert.equal(readFileSync(truncated.path,'utf8'),prefix)

  const second = mergingEditor()
  second.ed.text = BASE.replace('alpha', 'mine')
  writeFileSync(second.path, BASE.replace('alpha', 'disk one'))
  await guard.check(second.path)
  const firstReview = await prepareOutlineMerge(second.path, second.ed.deps)
  assert.equal(firstReview.kind, 'conflict')
  writeFileSync(second.path, BASE.replace('alpha', 'disk two'))
  await guard.check(second.path)
  const choices = { [firstReview.review.merge.conflicts[0].id]: '## Choice\n{id=a}\n- chosen\n\n' }
  assert.equal((await applyOutlineMerge(second.path, firstReview.review, choices, second.ed.deps)).kind, 'retry')
  assert.match(readFileSync(second.path, 'utf8'), /disk two/)
  assert.equal(second.ed.text, BASE.replace('alpha', 'mine'))
  const newer = await prepareOutlineMerge(second.path, second.ed.deps)
  assert.match(newer.review.disk, /disk two/)

  writeFileSync(second.path, BASE)
  assert.equal((await guard.accept('win',second.path, firstReview.review.hash)).ok, false, 'never accept a different observed hash after a revert')
  unlinkSync(second.path)
  await guard.check(second.path)
  assert.equal((await prepareOutlineMerge(second.path, second.ed.deps)).kind, 'removed')
  assert.equal(existsSync(second.path), false)

  const typing = mergingEditor()
  writeFileSync(typing.path, BASE.replace('beta', 'external'))
  const diskVersion = typing.ed.deps.diskVersion
  typing.ed.deps.diskVersion = async p => { const version = await diskVersion(p); typing.ed.text = BASE.replace('alpha', 'typed during read'); return version }
  assert.equal((await prepareOutlineMerge(typing.path, typing.ed.deps)).kind, 'retry')
  assert.match(typing.ed.text, /typed during read/)

  const failed = mergingEditor()
  failed.ed.text = BASE.replace('alpha', 'mine')
  writeFileSync(failed.path, BASE.replace('beta', 'external'))
  failed.ed.deps.preserve = async () => { throw Error('disk full') }
  assert.equal((await prepareOutlineMerge(failed.path, failed.ed.deps)).kind, 'error')
  assert.match(readFileSync(failed.path, 'utf8'), /external/)
  assert.match(failed.ed.text, /mine/)

  const clean = mergingEditor()
  writeFileSync(clean.path, BASE.replace('alpha', 'disk'))
  await guard.check(clean.path)
  const cleanPlan = await prepareOutlineMerge(clean.path, clean.ed.deps)
  assert.equal(cleanPlan.review.recoveryPath, undefined, 'a clean reload must not create an archive')
  assert.equal((await applyOutlineMerge(clean.path, cleanPlan.review, {}, clean.ed.deps)).kind, 'reloaded')
  assert.match(clean.ed.text, /disk/)
  assert.equal(guard.pending(clean.path), null, 'clean reload clears main pending state without a write')
  const raced = mergingEditor()
  raced.ed.text = BASE.replace('alpha', 'local race')
  writeFileSync(raced.path, BASE.replace('beta', 'external race'))
  await guard.check(raced.path)
  const racePlan = await prepareOutlineMerge(raced.path, raced.ed.deps)
  const accept = raced.ed.deps.accept
  raced.ed.deps.accept = async (...args) => {
    const result = await accept(...args)
    writeFileSync(raced.path, BASE.replace('beta', 'newer after accept'))
    return result
  }
  assert.equal((await applyOutlineMerge(raced.path, racePlan.review, {}, raced.ed.deps)).kind, 'error')
  assert.match(readFileSync(raced.path, 'utf8'), /newer after accept/)
  assert.match(raced.ed.text, /local race/)
  assert.match((await recovery.read(raced.path)).text, /external race/)

  const partial = mergingEditor()
  partial.ed.text = BASE.replace('alpha', 'local partial')
  writeFileSync(partial.path, BASE.replace('beta', 'external partial'))
  await guard.check(partial.path)
  const partialPlan = await prepareOutlineMerge(partial.path, partial.ed.deps)
  afterTruncate = async () => { throw Error('injected partial write') }
  assert.equal((await applyOutlineMerge(partial.path, partialPlan.review, {}, partial.ed.deps)).kind, 'error')
  afterTruncate = null
  assert.equal(store.get(partial.path).kind, 'partial')
  assert.match(readFileSync(store.get(partial.path).tempPath, 'utf8'), /local partial/)
  assert.match(readFileSync(store.get(partial.path).tempPath, 'utf8'), /external partial/)
  assert.equal(JSON.parse(readFileSync(partialPlan.review.recoveryPath, 'utf8')).base, BASE)

  const earlier = mergingEditor()
  await recovery.save(earlier.path, BASE.replace('alpha', 'prior session unsaved'))
  writeFileSync(earlier.path, BASE.replace('beta', 'external now'))
  await guard.check(earlier.path)
  const earlierPlan = await prepareOutlineMerge(earlier.path, earlier.ed.deps)
  assert.equal((await applyOutlineMerge(earlier.path, earlierPlan.review, {}, earlier.ed.deps)).kind, 'reloaded')
  assert.match((await recovery.read(earlier.path)).text, /prior session unsaved/,'a clean reload leaves an earlier unsaved recovery copy available')
  assert.equal(earlier.ed.archives.length,0)
  const duringAck = mergingEditor()
  duringAck.ed.text = BASE.replace('alpha','local before partial')
  writeFileSync(duringAck.path, BASE.replace('beta','external before partial'))
  await guard.check(duringAck.path)
  const duringPlan = await prepareOutlineMerge(duringAck.path,duringAck.ed.deps)
  const realAccept = duringAck.ed.deps.accept
  duringAck.ed.deps.accept = async () => {
    const temp = duringAck.path+'.full-recovery'
    writeFileSync(temp,duringAck.ed.text)
    writeFileSync(duringAck.path,'# Partial')
    return {ok:false,change:guard.failedHalfway(duringAck.path,temp)}
  }
  assert.equal((await applyOutlineMerge(duringAck.path,duringPlan.review,{},duringAck.ed.deps)).kind,'error','a partial write must not be automatically retried as a new merge input')
  assert.match(duringAck.ed.text,/local before partial/)
  assert.match(duringAck.ed.text,/external before partial/)
  duringAck.ed.deps.accept=realAccept
  assert.equal((await keepMine(duringAck.path,store.get(duringAck.path),duringAck.ed.deps)).ok,true,'Save again accepts the partial recovery without a stale observed-hash trap')
  assert.match(readFileSync(duringAck.path,'utf8'),/local before partial/)
  // L1: save receipts mutate the same acknowledged-document object; only adoption replaces it.
  const workspace = readFileSync(new URL('../src/renderer/src/components/WorkspaceLayout.tsx', import.meta.url),'utf8')
  const begin = workspace.indexOf('  function writeOutline(outlinePath:')
  const end = workspace.indexOf('\n  }',begin)+4
  const js = ts.transpileModule(workspace.slice(begin,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
  let epoch = {}, doc = {path:'/fixture',base:'old',epoch}, queued, calls=0, sentHashes=[]
  const writeWorkspace = Function('editorReadRef','queueOutlineWrite','window', js+';return writeOutline')(
    {current:()=>doc}, (_p,work)=>new Promise(resolve=>queued=()=>Promise.resolve(work()).then(resolve)),
    {tw:{talk:{writeOutline:async(_p,_t,opts)=>{calls++;sentHashes.push(opts?.expectedDiskHash);return {ok:true}}}}})
  let waiting = writeWorkspace('/fixture','payload')
  doc = {...doc,base:'save receipt changed the text',epoch}
  await queued(); assert.equal((await waiting).ok,true); assert.equal(calls,1)
  waiting = writeWorkspace('/fixture','stale payload')
  doc = {...doc,epoch:{}}
  await queued(); assert.equal(await waiting,false); assert.equal(calls,1)
  doc={...doc,diskHash:'other-talk-version'}
  waiting=writeWorkspace('/closed-fixture','closed payload')
  await queued(); assert.equal((await waiting).ok,true)
  assert.equal(sentHashes.at(-1),undefined,'an observed version may only accompany writes to its own talk')
  console.log('outline merge integration: guarded reconciliation, recovery, races, partial writes and document epochs passed')
} finally {
  guard.dispose()
  configureTalkWriter({ editorBufferFor: () => null })
  rmSync(root, { recursive: true, force: true })
}

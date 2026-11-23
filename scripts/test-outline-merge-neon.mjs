// Neon review: execute actual main callbacks and real recovery/merge seams, without Electron UI.
import { readMainSource } from './lib/read-source.mjs'
import assert from 'node:assert/strict'
import ts from 'typescript'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decideShellPath } from '../src/main/shell-path-policy.ts'
import { pathStaysInside } from '../src/main/path-containment.ts'
import { createOutlineDiskGuard, hashOutlineText } from '../src/main/outline-disk-guard.ts'
import { createEditorRevisions } from '../src/main/editor-revisions.ts'
import { createOutlineRecovery } from '../src/main/outline-recovery.ts'
import { prepareOutlineMerge, applyOutlineMerge } from '../src/renderer/src/lib/outlineReconcile.ts'
import { createOutlineDiskChangeStore } from '../src/renderer/src/lib/outlineDiskChange.ts'
const source=readMainSource(), ast=ts.createSourceFile('main-source.ts',source,ts.ScriptTarget.Latest,true)
function callback(channel,env) {
  let found
  const walk=n=>{if(ts.isCallExpression(n)&&n.expression.getText(ast)==='ipcMain.handle'&&n.arguments[0]?.text===channel)found=n.arguments[1];ts.forEachChild(n,walk)}
  walk(ast);assert.ok(found,channel)
  const code=ts.transpileModule(`const handler=${found.getText(ast)}`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
  return Function(...Object.keys(env),code+';return handler')(...Object.values(env))
}
const root=mkdtempSync(join(tmpdir(),'tw-neon-')), failures=[]
async function test(name,fn) {try{await fn();console.log('PASS '+name)}catch(e){failures.push(name);console.error('FAIL '+name+' '+e.stack)}}
try {
 await test('N-b: a stable version read supersedes a stale watcher report without advancing the disk baseline',async()=>{
  const store=createOutlineDiskChangeStore(),path='/fixture/outline.md'
  store.report({outlinePath:path,kind:'changed',hash:'H1',changedAt:1})
  const base='# Talk\n\n## One\n{id=a}\n- alpha\n',mine=base.replace('alpha','mine'),disk=base.replace('alpha','disk')
  const plan=await prepareOutlineMerge(path,{store,settled:async()=>{},readBase:()=>base,readBuffer:()=>mine,diskVersion:async()=>({text:disk,hash:'H2'}),preserve:async()=>'/recovery'})
  assert.equal(plan.kind,'conflict');assert.equal(store.get(path).hash,'H2')
 })
 await test('N-b: a notification arriving during the read must not be downgraded',async()=>{
  const store=createOutlineDiskChangeStore(),path='/fixture/raced.md',base='# Talk\n\n## One\n{id=a}\n- base\n'
  store.report({outlinePath:path,kind:'changed',hash:'H1',changedAt:1})
  const result=await prepareOutlineMerge(path,{store,settled:async()=>{},readBase:()=>base,readBuffer:()=>base+'mine',diskVersion:async()=>{store.report({outlinePath:path,kind:'changed',hash:'H3',changedAt:3});return {text:base+'disk',hash:'H2'}},preserve:async()=>'/recovery'})
  assert.equal(result.kind,'retry');assert.equal(store.get(path).hash,'H3')
 })
 await test('N-d: the renderer captures adoption revision before awaiting acknowledgement',async()=>{
  const store=createOutlineDiskChangeStore(),path='/fixture/revision.md',base='# Talk\n\n## One\n{id=a}\n- base\n'
  let buffer=base.replace('base','mine'),revision=7,captured
  const disk=base.replace('base','disk')
  store.report({outlinePath:path,kind:'changed',hash:'disk',changedAt:1})
  const deps={store,settled:async()=>{},queue:async(_p,work)=>work(),readBase:()=>base,readBuffer:()=>buffer,diskVersion:async()=>({text:disk,hash:'disk'}),preserve:async()=>'/recovery',replaceBuffer:(_p,text)=>{buffer=text;return true},revision:()=>revision,accept:async(_p,_h,opts)=>{captured=opts.revision;revision++;buffer+='\n- typed during acknowledgement';return {ok:true}},discardRecovery:async()=>true}
  const plan=await prepareOutlineMerge(path,deps)
  assert.equal(plan.kind,'conflict')
  const choices=Object.fromEntries(plan.review.merge.conflicts.map(item=>[item.id,item.disk]))
  assert.equal((await applyOutlineMerge(path,plan.review,choices,deps)).kind,'saved')
  assert.equal(captured,7);assert.equal(revision,8);assert.match(buffer,/typed during acknowledgement/)
 })
 await test('N-c: reveal app merge archives, while refusing other userData and escaping symlinks',async()=>{
  const userData=join(root,'userData'),merges=join(userData,'recovery','merges'),vault=join(root,'vault'),outside=join(root,'outside')
  for(const dir of [merges,vault,outside])mkdirSync(dir,{recursive:true})
  const file=join(merges,'copy.json');writeFileSync(file,'{}')
  const revealed=[]
  const handler=callback('shell:show-item-in-folder',{app:{getPath:()=>userData},join,pathStaysInside,decideShellPath,openVaultRoots:()=>[vault],shell:{showItemInFolder:p=>revealed.push(p)}})
  assert.equal(await handler({},file),true);assert.deepEqual(revealed,[file])
  assert.equal(await handler({},join(userData,'config.json')),false)
  if(process.platform!=='win32'){
  symlinkSync(outside,join(merges,'escape'),'dir')
  assert.equal(await handler({},join(merges,'escape','secret.json')),false)
  assert.equal(decideShellPath('open',file,[vault]).ok,false,'opening remains vault-only')
  rmSync(join(merges,'escape'));rmSync(merges,{recursive:true});symlinkSync(outside,merges,'dir')
  assert.equal(await handler({},join(merges,'copy.json')),false,'an escaped recovery root is not allowed')
  }
 })
 await test('N-d: no-write disk adoption acknowledges the captured revision and clears failed-save state',async()=>{
  const editorRevisions=createEditorRevisions(),lastSaveFailed=new Set([71]),lastUnsavedText=new Map([['/outline','old mine']])
  editorRevisions.loaded(71,0);editorRevisions.writeStarted(71,1)(false)
  const workNode=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='editorWorkSaved')
  const workCode=ts.transpileModule(workNode.getText(ast),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
  const workSaved=Function('lastSaveFailed','outlineDiskGuard','editorWindows','lastUnsavedText','canonicalOutlinePath',workCode+';return editorWorkSaved')(lastSaveFailed,{pendingFor:()=>null},new Map([[71,{outlinePath:'/outline'}]]),lastUnsavedText,p=>p)
  assert.equal(workSaved(71),false)
  let accepted=true
  const loadSession={}
  const handler=callback('talk:outline-accept-disk',{outlineDiskGuard:{owns:()=>true,session:()=>loadSession,accept:async()=>({ok:accepted,change:null})},editorRevisions,lastSaveFailed,lastUnsavedText,canonicalOutlinePath:p=>p})
  const event={sender:{id:71}}
  assert.equal((await handler(event,'/outline','hash',{keepPending:false,revision:1})).ok,true)
  assert.equal(lastSaveFailed.has(71),false);assert.equal(lastUnsavedText.has('/outline'),false);assert.equal(workSaved(71),true)
  assert.equal(editorRevisions.verdict(71,1,'restart'),'saved');assert.equal(editorRevisions.verdict(71,1,'close'),'saved')
  assert.equal(editorRevisions.verdict(71,2,'restart'),'resave','typing after adoption is not acknowledged by an older revision')
  for(const opts of [{keepPending:true,revision:2},{keepPending:false,revision:-1}]){
   lastSaveFailed.add(71);lastUnsavedText.set('/outline','keep me')
   await handler(event,'/outline','hash',opts)
   assert.equal(lastSaveFailed.has(71),true);assert.equal(lastUnsavedText.has('/outline'),true)
  }
  accepted=false;await handler(event,'/outline','stale',{keepPending:false,revision:2});assert.equal(lastSaveFailed.has(71),true)
 })
 await test('Neon re-check 1: lost ownership during accept cannot acknowledge another talk',async()=>{
  for(const change of ['forget','release','switch']) {
   let unlock,entered
   const waiting=new Promise(resolve=>entered=resolve),lock=new Promise(resolve=>unlock=resolve)
   const guard=createOutlineDiskGuard({canonical:p=>p,readText:async()=> 'disk',mtime:async()=>1,withLock:async(_p,work)=>{entered();await lock;return work()},watch(){},unwatch(){},notify(){}})
   const revisions=createEditorRevisions(),failed=new Set([71]),unsaved=new Map([['/old','old mine'],['/new','new mine']])
   revisions.loaded(71,9);revisions.writeStarted(71,10)(false)
   const handler=callback('talk:outline-accept-disk',{outlineDiskGuard:guard,editorRevisions:revisions,lastSaveFailed:failed,lastUnsavedText:unsaved,canonicalOutlinePath:p=>p})
   try {
    guard.track('71','/old','base')
    const result=handler({sender:{id:71}},'/old',hashOutlineText('disk'),{revision:11})
    await waiting
    if(change==='forget')guard.forget('/old')
    else if(change==='release')guard.release('71')
    else guard.track('71','/new','other talk')
    unlock()
    assert.equal((await result).ok,false,change+': stale acknowledgement must refuse')
    assert.equal(failed.has(71),true,change+': failure state belongs to the current talk')
    assert.deepEqual([...unsaved],[['/old','old mine'],['/new','new mine']])
    assert.equal(revisions.verdict(71,11,'restart'),'resave',change+': stale revision was not loaded')
   } finally {unlock();guard.dispose()}
  }
 })
 await test('Neon residual: an old owner cannot accept a replacement owner entry',async()=>{
  for(const kind of ['changed','removed','partial']) {
   let unlock,entered
   const waiting=new Promise(resolve=>entered=resolve),lock=new Promise(resolve=>unlock=resolve)
   const text=kind==='removed'?null:'disk'
   const guard=createOutlineDiskGuard({canonical:p=>p,readText:async()=>text,mtime:async()=>1,withLock:async(_p,work)=>{entered();await lock;return work()},watch(){},unwatch(){},notify(){}})
   const failed=new Set([71]),unsaved=new Map([['/talk','A mine']]),revisions=createEditorRevisions()
   const handler=callback('talk:outline-accept-disk',{outlineDiskGuard:guard,editorRevisions:revisions,lastSaveFailed:failed,lastUnsavedText:unsaved,canonicalOutlinePath:p=>p})
   try {
    guard.track('71','/talk','A base')
    const hash=kind==='partial'?'partial:/kept':kind==='removed'?'removed':hashOutlineText(text)
    const pending=handler({sender:{id:71}},'/talk',hash,{keepPending:kind==='removed',revision:5})
    await waiting
    guard.release('71');guard.track('72','/talk','B base')
    if(kind==='partial')guard.failedHalfway('/talk','/kept')
    else await guard.conflict('/talk',text,'B mine')
    const before=guard.pending('/talk')
    unlock()
    assert.equal((await pending).ok,false)
    assert.deepEqual(guard.pending('/talk'),before,kind+': B report must survive')
    assert.equal(guard.canRecreate('/talk'),false,kind+': A cannot grant B recreation permission')
    if(kind==='changed')assert.ok(await guard.conflict('/talk',text,'B mine'),'B baseline was not advanced')
    if(kind==='partial')assert.equal((await guard.conflict('/talk',text,'B mine')).kind,'partial','B partial marker was not cleared')
   } finally {unlock();guard.dispose()}
  }
 })
 await test('Neon residual: a reload during an awaited read cannot mutate the reloaded entry',async()=>{
  for(const stage of ['read','mtime']) {
   let unlock,entered
   const waiting=new Promise(resolve=>entered=resolve),lock=new Promise(resolve=>unlock=resolve)
   const guard=createOutlineDiskGuard({canonical:p=>p,readText:async()=>{if(stage==='read'){entered();await lock}return 'disk'},mtime:async()=>{if(stage==='mtime'){entered();await lock}return 1},withLock:async(_p,work)=>work(),watch(){},unwatch(){},notify(){}})
   try {
    guard.track('71','/talk','original base')
    const pending=guard.accept('71','/talk',stage==='read'?hashOutlineText('disk'):'unseen')
    await waiting
    guard.track('71','/talk','reloaded base')
    unlock()
    assert.equal((await pending).ok,false,stage+': reload invalidates the in-flight accept')
    assert.equal(guard.pending('/talk'),null,stage+': stale work cannot report into the new load')
    assert.ok(await guard.conflict('/talk','disk','mine'),stage+': reloaded baseline is unchanged')
   } finally {unlock();guard.dispose()}
  }
 })
 await test('Neon residual: reopening the same talk cannot acknowledge an old revision',async()=>{
  for(const stage of ['lock','reply']) {
   let unlock,entered
   const waiting=new Promise(resolve=>entered=resolve),lock=new Promise(resolve=>unlock=resolve)
   const guard=createOutlineDiskGuard({canonical:p=>p,readText:async()=> 'disk',mtime:async()=>1,withLock:async(_p,work)=>{entered();if(stage==='lock')await lock;return work()},watch(){},unwatch(){},notify(){}})
   const revisions=createEditorRevisions(),failed=new Set([71]),unsaved=new Map([['/talk','old session mine']])
   const reopen=()=>{guard.release('71');guard.track('71','/talk','reopened base');revisions.loaded(71,20);revisions.writeStarted(71,21)(false);failed.add(71);unsaved.set('/talk','new session mine')}
   const facade={...guard,accept:async(...args)=>{const result=await guard.accept(...args);if(stage==='reply')reopen();return result}}
   const handler=callback('talk:outline-accept-disk',{outlineDiskGuard:facade,editorRevisions:revisions,lastSaveFailed:failed,lastUnsavedText:unsaved,canonicalOutlinePath:p=>p})
   try {
    guard.track('71','/talk','original base')
    const pending=handler({sender:{id:71}},'/talk',hashOutlineText('disk'),{revision:5})
    await waiting
    if(stage==='lock')reopen()
    unlock()
    assert.equal((await pending).ok,false,stage+': an old open must refuse even when owns() is true again')
    assert.equal(failed.has(71),true,stage+': new-session failure flag stays')
    assert.equal(unsaved.get('/talk'),'new session mine')
    assert.equal(revisions.verdict(71,5,'restart'),'resave',stage+': old revision never becomes loaded')
    assert.equal(revisions.verdict(71,21,'close'),'saved',stage+': newer attempted revision is unchanged')
   } finally {unlock();guard.dispose()}
  }
 })
 await test('N-d: choosing disk cancels an earlier accepted-save permission',async()=>{
  let text='base'
  const guard=createOutlineDiskGuard({canonical:p=>p,readText:async()=>text,mtime:async()=>1,withLock:async(_p,work)=>work(),watch(){},unwatch(){},notify(){}})
  try {
   guard.track('71','/outline',text);text='disk';await guard.check('/outline')
   const hash=hashOutlineText(text)
   assert.equal((await guard.accept('71','/outline',hash,{keepPending:true})).ok,true)
   assert.ok(guard.pendingFor('71'))
   assert.equal((await guard.accept('71','/outline',hash,{keepPending:false})).ok,true)
   assert.equal(guard.pendingFor('71'),null,'a no-write adoption must not leave the previous save permission pending')
  } finally {guard.dispose()}
 })
 await test('N-i: unsupported directory sync cannot reject a successfully synced archive',async()=>{
  for(const code of ['EINVAL','EBADF']){
   let calls=0
   const recovery=createOutlineRecovery(join(root,code),Date.now,{syncDirectory:async()=>{calls++;throw Object.assign(Error('unsupported'),{code})}})
   const file=await recovery.preserveMerge('/talk',{base:'base',mine:'mine',disk:'disk'})
   assert.equal(calls,process.platform==='win32'?0:1);assert.equal(JSON.parse(readFileSync(file,'utf8')).mine,'mine')
  }
 })
} finally {rmSync(root,{recursive:true,force:true})}
assert.deepEqual(failures,[],'Neon regressions must all pass')

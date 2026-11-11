import {execFileSync} from 'node:child_process'
const pinned=p=>fs.readFileSync(p,'utf8')
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import {transformSync} from 'esbuild'
import {EditorState} from '@codemirror/state'
import {createOutlineRecovery} from '../../../../src/main/outline-recovery.ts'
const root='scripts/vault-gallery/integration/recovery-boundary/fixture'
const source=pinned('src/renderer/src/components/WorkspaceLayout.tsx')
const start=source.indexOf('  useEffect(() => {\n    const recover = (event:Event)')
assert.ok(start>=0)
const effect=source.slice(start,source.indexOf('  const diskGuard =',start))
const editor=pinned('src/renderer/src/components/Editor.tsx')
const filterLine=editor.split('\n').find(l=>l.includes('EditorState.transactionFilter.of')).trim().replace(/,$/,'')
class CustomEvent extends Event {constructor(type,{detail}){super(type);this.detail=detail}}
const tick=()=>new Promise(r=>setImmediate(r))
function setup(onRetire=()=>{}){
 fs.rmSync(root,{recursive:true,force:true})
 const store=createOutlineRecovery(root)
 const window=new EventTarget();let frozen=false,discard=0,closed=0,cleanup
 window.addEventListener('tw-freeze-moved-editor',e=>frozen=e.detail)
 const loadFrozenRef={current:false}
 const filter=vm.runInNewContext(filterLine,{EditorState,loadFrozenRef,moveFrozenRef:{get current(){return frozen}}})
 let state=EditorState.create({doc:'latest actual text',extensions:[filter]})
 loadFrozenRef.current=true
 assert.equal(state.update({changes:{from:state.doc.length,insert:' BLOCKED WHILE LOADING'}}).state.doc.toString(),state.doc.toString(),'loading blocks normal mutations even when move freeze is false')
 loadFrozenRef.current=false
 assert.equal(state.update({changes:{from:state.doc.length,insert:' READY'}}).state.doc.toString(),'latest actual text READY','ready fixture permits normal mutations')
 const activeTalkRef={current:{outlinePath:'old'}};const recoveryPathRef={current:{generation:0}}
 const pending=[];let copies=0
 window.tw={windows:Object.fromEntries(['preserve','retire'].map(mode=>[mode+'MovedTalk',async(from,text)=>{
  copies++;let completed;const done=new Promise(r=>completed=r);try {await new Promise((resolve,reject)=>pending.push({resolve,reject,mode,done}));await store.save('destination',text);return {ok:true}} finally {completed()}
 }]))}
 const context={window,CustomEvent,useEffect:fn=>{cleanup=fn()},activeTalkRef,recoveryPathRef,recoveryDiscardRef:{current:()=>{closed++;onRetire()}},onDiscardTalk:()=>closed++,outlineWritesSettled:async()=>{},editorReadRef:{current:()=>({path:activeTalkRef.current?.outlinePath,text:state.doc.toString()})},outlineDiskChanges:{discard:()=>discard++},notify(){},console}
 vm.runInNewContext(transformSync(effect,{loader:'ts'}).code,context)
 const request=(retire=false,adopt)=>{let count=0;let answer;const promise=new Promise(resolve=>window.dispatchEvent(new CustomEvent(retire?'tw-retire-moved-editor':'tw-preserve-moved-editor',{detail:{from:'old',retire,adopt,done:ok=>{count++;answer=ok;resolve(ok)}}})));return {promise,get count(){return count},get answer(){return answer}}}
 return {window,request,pending,store,activeTalkRef,recoveryPathRef,cleanup:()=>cleanup(),get copies(){return copies},get frozen(){return frozen},get discard(){return discard},get closed(){return closed},get text(){return state.doc.toString()},type:()=>{state=state.update({changes:{from:state.doc.length,insert:' NEW TEXT'}}).state}}
}
async function finish(h){const p=h.pending.shift();p.resolve();await p.done;await tick()}
try {
 for(const modes of [[true,true],[false,false],[false,true],[true,false]]){
  const h=setup(),a=h.request(modes[0]);await tick();const b=h.request(modes[1]);await tick()
  assert.equal(h.copies,1,'one exclusive copy for overlapping callers');h.type();assert.equal(h.text,'latest actual text');assert.equal(h.frozen,true)
  await finish(h)
  if(!modes[0]&&modes[1]){assert.equal(h.copies,2,'retirement settles main receipt after in-flight preservation');assert.equal(a.count,0);h.type();await finish(h)}
  await Promise.all([a.promise,b.promise]);assert.equal(a.count,1);assert.equal(b.count,1)
  assert.equal(a.answer,modes.some(Boolean)?modes[0]:true);assert.equal(b.answer,modes.some(Boolean)?modes[1]:true)
  assert.equal((await h.store.read('destination')).text,h.text);assert.equal(h.discard,1);assert.equal(h.closed,modes.some(Boolean)?1:0);assert.equal(h.frozen,true);h.cleanup()
 }
 console.log('PASS double retirement, double preservation, mixed operations and selection+close: every caller once; filter frozen; actual store read-back')
 {
  const h=setup(),a=h.request(true),b=h.request(true);await tick();h.pending.shift().reject(Error('copy failure'));assert.equal(await a.promise,false);assert.equal(await b.promise,false)
  h.type();assert.equal(h.frozen,true);assert.equal(h.closed,0);assert.equal(h.discard,0)
  const retry=h.request(true);await tick();await finish(h);assert.equal(await retry.promise,true);assert.equal((await h.store.read('destination')).text,h.text);h.cleanup()
 }
 console.log('PASS failed copy retains live buffer and exclusion; typing blocked; explicit retry recaptures and preserves actual text')
 for(const transition of ['new','null','revived','unmount']){
  const h=setup(),a=h.request(true);await tick()
  if(transition==='unmount')h.cleanup();else {h.activeTalkRef.current=transition==='null'?null:{outlinePath:transition==='revived'?'old':'new'};h.recoveryPathRef.current.generation++}
  await finish(h);assert.equal(await a.promise,false);await tick();assert.equal(a.count,1);assert.equal(h.closed,0);assert.equal(h.discard,0);assert.equal(h.frozen,true);h.cleanup()
 }
 console.log('PASS new path, null, revived path, unmount: obsolete owner cannot discard, unlock or answer twice')
 {
  const h=setup();let calls=0
  h.window.tw.windows.retireMovedTalk=async(from,text)=>{await h.store.save('destination',text);if(++calls===1)throw Error('lost acknowledgement');return {ok:true}}
  assert.equal(await h.request(true).promise,false);h.type();assert.equal(h.frozen,true)
  assert.equal(await h.request(true).promise,true);assert.equal((await h.store.read('destination')).text,h.text);assert.equal(h.closed,1);h.cleanup()
 }
 console.log('PASS lost acknowledgement retry preserves same protected live snapshot without stale overwrite')
 {
  const h=setup();let closeRequest,confirmed=0,left=0
  h.window.tw.talk={onCloseRequested:fn=>{closeRequest=fn},ackCloseRequest:async()=>{},confirmClose:async()=>confirmed++}
  h.window.tw.windows.recoverMovedTalk=async()=>({kind:'revoked'})
  const hook=pinned('src/renderer/src/components/useOutlineDiskChange.ts')
  const start=hook.indexOf('  useEffect(() => window.tw.talk.onCloseRequested')
  vm.runInNewContext(transformSync(hook.slice(start,hook.indexOf('  return { change',start)),{loader:'ts'}).code,{window:h.window,CustomEvent,useEffect:fn=>fn(),wiringRef:{current:{activeOutlinePath:'old'}},leave:async()=>{left++;return true}})
  const selection=h.request(false);await tick();closeRequest({quit:false});await tick()
  await finish(h);await finish(h);assert.equal(await selection.promise,false);await tick();assert.equal(confirmed,1);assert.equal(left,0);assert.equal((await h.store.read('destination')).text,h.text);h.cleanup()
 }
 console.log('PASS actual close hook coalesces with selection, confirms once after retirement, and never flushes stale path')
 {
  const {adoptMovedTalk}=await import('../../../../src/renderer/src/lib/talkSelection.ts')
  let current={outlinePath:'old'},finishConfirm,adopted=0
  const pending=adoptMovedTalk({outlinePath:'moved'},'old',{current:()=>current,confirm:()=>new Promise(r=>finishConfirm=r),adopt:()=>adopted++})
  current={outlinePath:'new'};finishConfirm({ok:true});assert.equal(await pending,false);assert.equal(adopted,0)
 }
 console.log('PASS actual adoption seam rechecks editor identity after delayed acknowledgement')

 // Reviewer extension: text changes through an adapter despite freeze must refuse discard.
 {
  const h=setup(),a=h.request(true);await tick();
  h.window.dispatchEvent(new CustomEvent('tw-freeze-moved-editor',{detail:false}));h.type();
  await finish(h);assert.equal(await a.promise,false);assert.equal(h.closed,0);assert.equal(h.discard,0);
  assert.notEqual((await h.store.read('destination')).text,h.text);
  const retry=h.request(true);await tick();await finish(h);assert.equal(await retry.promise,true);
  assert.equal((await h.store.read('destination')).text,h.text);h.cleanup();
 }
 console.log('PASS independent freshness negative: changed live text prevents discard; retry reads and stores new actual text');
 // Reviewer extension: two close callbacks retain their own answers and retirement-induced null is allowed.
 {
  const wiringRef={current:{activeOutlinePath:'old'}};
  const h=setup(()=>{wiringRef.current.activeOutlinePath=null});let closeRequest,confirmed=0;
  h.window.tw.talk={onCloseRequested:fn=>{closeRequest=fn},ackCloseRequest:async()=>{},confirmClose:async()=>confirmed++};
  h.window.tw.windows.recoverMovedTalk=async()=>({kind:'revoked'});
  const hook=pinned('src/renderer/src/components/useOutlineDiskChange.ts');
  const start=hook.indexOf('  useEffect(() => window.tw.talk.onCloseRequested');
  vm.runInNewContext(transformSync(hook.slice(start,hook.indexOf('  return { change',start)),{loader:'ts'}).code,{window:h.window,CustomEvent,useEffect:fn=>fn(),wiringRef,leave:async()=>{throw Error('stale leave')}});
  closeRequest({quit:false});closeRequest({quit:true});await tick();assert.equal(h.copies,1);
  await finish(h);await tick();assert.equal(confirmed,2);h.cleanup();
 }
 console.log('PASS independent double close: one actual store copy, both callbacks answered; null path after retirement permitted');

 for(const outcome of ['success','failure','close','double-close','new','null','revived']) {
  const h=setup();let ack,entered;const ready=new Promise(r=>entered=r);
  const a=h.request(false,async valid=>{entered();await new Promise(r=>ack=r);if(!valid() || outcome==='failure')return false;h.activeTalkRef.current={outlinePath:'destination'};h.recoveryPathRef.current.generation++;return true});
  await tick();await finish(h);await ready;
  let b,c;
  if(outcome==='close'||outcome==='double-close'){b=h.request(true);if(outcome==='double-close')c=h.request(true)}
  if(['new','null','revived'].includes(outcome)){h.activeTalkRef.current=outcome==='null'?null:{outlinePath:outcome==='new'?'new':'old'};h.recoveryPathRef.current.generation++}
  ack();await tick();
  if(b){await finish(h);assert.equal(await b.promise,true);if(c)assert.equal(await c.promise,true)}
  assert.equal(await a.promise,outcome==='success');assert.equal(a.count,1);h.cleanup();
 }
 console.log('PASS adoption first, failed adoption, close/double close during ack, new/null/revived editor during ack');
 // Independent boundary probe: preserve owner ends before delayed adoption settles.
 {
  const h=setup();const handlers=new Map();const receipt={from:'old',to:'destination',settled:false};
  const entry={outlinePath:'destination',win:{isDestroyed:()=>false}};
  let releaseRetire;const gate=new Promise(r=>releaseRetire=r);let retiring=false;
  const env={ipcMain:{handle:(k,v)=>handlers.set(k,v)},movedEditorReceipts:new Map([[1,receipt]]),editorWindows:new Map([[1,entry]]),retiredMovePaths:new Map(),outlineRecovery:{save:async(p,t)=>{if(retiring)await gate;await h.store.save(p,t)}}};
  env.validMoveReceipt=()=>receipt.retired?null:receipt;
  vm.createContext(env);const main=pinned('src/main/index.ts');
  {const start=main.indexOf("ipcMain.handle('window:adopt-moved-talk'");vm.runInContext(transformSync(main.slice(start,main.indexOf('\n})',start)+3),{loader:'ts'}).code,env)}
  for(const name of ['preserve','retire']){const start=main.indexOf("ipcMain.handle('window:"+name+"-moved-talk'");vm.runInContext(transformSync(main.slice(start,main.indexOf('\n})',start)+3),{loader:'ts'}).code,env);h.window.tw.windows[name+'MovedTalk']=(from,text)=>handlers.get('window:'+name+'-moved-talk')({sender:{id:1}},from,text)}
  const {adoptMovedTalk}=await import('../../../../src/renderer/src/lib/talkSelection.ts');let acknowledge,entered;const confirming=new Promise(r=>entered=r);
  const selection=h.request(false,isCurrent=>adoptMovedTalk({outlinePath:'destination'},'old',{current:()=>h.activeTalkRef.current,isCurrent,confirm:(from,to)=>{const result=handlers.get('window:adopt-moved-talk')({sender:{id:1}},from,to);entered();return new Promise(r=>acknowledge=()=>r(result))},adopt:t=>{h.activeTalkRef.current=t;h.recoveryPathRef.current.generation++;h.window.dispatchEvent(new CustomEvent('tw-freeze-moved-editor',{detail:false}))}}));
  await confirming;assert.equal(typeof acknowledge,'function');
  retiring=true;const close=h.request(true);await tick();
  acknowledge();await tick();h.type();assert.equal(h.text,'latest actual text');
  releaseRetire();assert.equal(await selection.promise,false);assert.equal(await close.promise,true);
  assert.equal(entry.outlinePath,null);assert.equal(h.closed,1);
  assert.equal((await h.store.read('destination')).text,h.text);
  console.log('PASS delayed adoption plus close: close supersedes handoff, filter stays frozen, current text on disk, every caller answered');h.cleanup();
 }
} finally {fs.rmSync(root,{recursive:true,force:true})}

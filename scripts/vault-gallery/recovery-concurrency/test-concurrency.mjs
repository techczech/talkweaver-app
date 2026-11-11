import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import {transformSync} from 'esbuild'
import {EditorState} from '@codemirror/state'
import {createOutlineRecovery} from '../../../src/main/outline-recovery.ts'
const root='scripts/vault-gallery/recovery-concurrency/fixture'
const source=fs.readFileSync(process.env.TW_RECOVERY_SOURCE || 'src/renderer/src/components/WorkspaceLayout.tsx','utf8')
const start=source.indexOf('  useEffect(() => {\n    const recover = (event:Event)')
assert.ok(start>=0)
const effect=source.slice(start,source.indexOf('  const diskGuard =',start))
const editor=fs.readFileSync('src/renderer/src/components/Editor.tsx','utf8')
const filterLine=editor.split('\n').find(l=>l.includes('EditorState.transactionFilter.of')).trim().replace(/,$/,'')
class CustomEvent extends Event {constructor(type,{detail}){super(type);this.detail=detail}}
const tick=()=>new Promise(r=>setImmediate(r))
function setup(){
 fs.rmSync(root,{recursive:true,force:true})
 const store=createOutlineRecovery(root)
 const window=new EventTarget();let frozen=false,discard=0,closed=0,cleanup
 window.addEventListener('tw-freeze-moved-editor',e=>frozen=e.detail)
 const filter=vm.runInNewContext(filterLine,{EditorState,moveFrozenRef:{get current(){return frozen}}})
 let state=EditorState.create({doc:'latest actual text',extensions:[filter]})
 const activeTalkRef={current:{outlinePath:'old'}};const recoveryPathRef={current:{generation:0}}
 const pending=[];let copies=0
 window.tw={windows:Object.fromEntries(['preserve','retire'].map(mode=>[mode+'MovedTalk',async(from,text)=>{
  copies++;let completed;const done=new Promise(r=>completed=r);try {await new Promise((resolve,reject)=>pending.push({resolve,reject,mode,done}));await store.save('destination',text);return {ok:true}} finally {completed()}
 }]))}
 const context={window,CustomEvent,useEffect:fn=>{cleanup=fn()},activeTalkRef,recoveryPathRef,recoveryDiscardRef:{current:()=>closed++},onDiscardTalk:()=>closed++,outlineWritesSettled:async()=>{},editorReadRef:{current:()=>({path:activeTalkRef.current?.outlinePath,text:state.doc.toString()})},outlineDiskChanges:{discard:()=>discard++},notify(){},console}
 vm.runInNewContext(transformSync(effect,{loader:'ts'}).code,context)
 const request=(retire=false)=>{let count=0;let answer;const promise=new Promise(resolve=>window.dispatchEvent(new CustomEvent(retire?'tw-retire-moved-editor':'tw-preserve-moved-editor',{detail:{from:'old',retire,done:ok=>{count++;answer=ok;resolve(ok)}}})));return {promise,get count(){return count},get answer(){return answer}}}
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
  const hook=fs.readFileSync('src/renderer/src/components/useOutlineDiskChange.ts','utf8')
  const start=hook.indexOf('  useEffect(() => window.tw.talk.onCloseRequested')
  vm.runInNewContext(transformSync(hook.slice(start,hook.indexOf('  return { change',start)),{loader:'ts'}).code,{window:h.window,CustomEvent,useEffect:fn=>fn(),wiringRef:{current:{activeOutlinePath:'old'}},leave:async()=>{left++;return true}})
  const selection=h.request(false);await tick();closeRequest({quit:false});await tick()
  await finish(h);await finish(h);assert.equal(await selection.promise,false);await tick();assert.equal(confirmed,1);assert.equal(left,0);assert.equal((await h.store.read('destination')).text,h.text);h.cleanup()
 }
 console.log('PASS actual close hook coalesces with selection, confirms once after retirement, and never flushes stale path')
 {
  const {adoptMovedTalk}=await import('../../../src/renderer/src/lib/talkSelection.ts')
  let current={outlinePath:'old'},finishConfirm,adopted=0
  const pending=adoptMovedTalk({outlinePath:'moved'},'old',{current:()=>current,confirm:()=>new Promise(r=>finishConfirm=r),adopt:()=>adopted++})
  current={outlinePath:'new'};finishConfirm({ok:true});assert.equal(await pending,false);assert.equal(adopted,0)
 }
 console.log('PASS actual adoption seam rechecks editor identity after delayed acknowledgement')
} finally {fs.rmSync(root,{recursive:true,force:true})}

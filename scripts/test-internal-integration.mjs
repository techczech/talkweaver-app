import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, basename, relative } from 'node:path'
import ts from 'typescript'
const compile = source => ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
const main = readFileSync('src/main/index.ts','utf8')
const start = main.indexOf('async function verifiedRunSource(')
const source = main.slice(start,main.indexOf('async function qualifiedRunTalk(',start))
let nativeReads=0, outlineReads=0, unavailable=false, refused=false, rootChanged=false, missing=false
const env={writableRootFor:()=>'/vault',vaultRegistry:{list:()=>[{id:'v',root:'/vault',open:true}],get:()=>({root:'/vault',open:true})},vaultAvailability:{isUnavailable:()=>unavailable},statSync:()=>({dev:1,ino:rootChanged?3:2,isFile:()=>!missing}),app:{isPackaged:false,getAppPath:()=>'/app'},join,basename,relative,process:{platform:'win32',resourcesPath:'/resources'},readGallerySource:async()=>{nativeReads++;throw Error('macOS only')},outlineRefused:()=>refused?'refused':null,readTalkOutline:async()=>{outlineReads++;if(rootChanged===null)rootChanged=true;return '# Talk'}}
const verified = Function(...Object.keys(env),compile(source)+'; return verifiedRunSource')(...Object.values(env))
assert.equal(await verified('/vault/talk/talk-outline.md','talk'),'talk/talk-outline.md')
assert.equal(nativeReads,0);assert.equal(outlineReads,1)
refused=true;await assert.rejects(verified('/vault/talk/talk-outline.md','talk'),/unavailable/);assert.equal(outlineReads,1);refused=false
rootChanged=null;await assert.rejects(verified('/vault/talk/talk-outline.md','talk'),/unavailable/);rootChanged=false
missing=true;await assert.rejects(verified('/vault/talk/talk-outline.md','talk'),/unavailable/);missing=false
unavailable=true;assert.equal(await verified('/vault/talk/talk-outline.md','talk'),undefined);unavailable=false
await assert.rejects(verified('/vault/talk/wrong-outline.md','talk'),/mismatch/)
console.log('PASS Windows presenter provenance uses contained outline reads and refuses changed roots, unavailable vaults, wrong slugs and refused sources')
const vaults={resolve:()=>({vault:{root:'/vault'}})}
// Use the lookup shape already accepted by the presenter context contract.
const presenterSource=readFileSync('src/main/live-session-manager.ts','utf8')
const presenterStart=presenterSource.indexOf('export function livePresenterContext(')
const presenterFunction=presenterSource.slice(presenterStart,presenterSource.indexOf('const instantKey',presenterStart)).replace('export ','')
const livePresenterContext=Function('talkVaultRoot',compile(presenterFunction)+';return livePresenterContext')(()=>'/vault')
const context=livePresenterContext(vaults,'/vault/talk/talk-outline.md','talk','https://example.test/run',{folder:'run'},'talk/talk-outline.md')
assert.equal(context.sourceOutline,'talk/talk-outline.md');assert.deepEqual(context.runLink,{folder:'run'})
console.log('PASS merged presenter identity carries both Run publication linkage and source provenance')
const actions=readFileSync('src/renderer/src/components/talklist/actions.ts','utf8')
const cloneStart=actions.indexOf('  async function doClone(')
const cloneSource=actions.slice(cloneStart,actions.indexOf('  function startDelete(',cloneStart))
for(const active of [false,true]){
 let settled=0,cloned=0
 const deps={activeTalk:{outlinePath:active?'target':'other'},settleActive:async()=>{settled++;return false},window:{tw:{vault:{cloneTalk:async()=>{cloned++;return null}}}},notify:()=>{},onRefresh:async()=>{},inVaultOf:()=>{},onOperationResult:()=>{},commandRan:()=>{},onSelectTalk:()=>{}}
 await Function(...Object.keys(deps),compile(cloneSource)+'; return doClone')(...Object.values(deps))({outlinePath:'target',title:'Target'},'Copy')
 assert.equal(settled,active?1:0);assert.equal(cloned,active?0:1)
}
console.log('PASS inactive-talk duplication ignores unrelated editor conflict; active-talk duplication still settles')
const hook=readFileSync('src/renderer/src/components/useOutlineDiskChange.ts','utf8')
const closeStart=hook.indexOf('  useEffect(() => window.tw.talk.onCloseRequested')
const closeHook=hook.slice(closeStart,hook.indexOf('  return { change,',closeStart))
for(const allow of [false,true]){
 let close,acks=0,confirmed=0,release
 const pending=new Promise(resolve=>release=resolve)
 const deps={useEffect:cb=>cb(),window:{tw:{talk:{onCloseRequested:cb=>{close=cb},ackCloseRequest:async()=>{acks++},confirmClose:async()=>{confirmed++}},windows:{recoverMovedTalk:async()=>({kind:'no-receipt'})}}},wiringRef:{current:{activeOutlinePath:'A'}},leave:()=>pending}
 Function(...Object.keys(deps),compile(closeHook))(...Object.values(deps));close({quit:false})
 await new Promise(resolve=>setImmediate(resolve));assert.equal(acks,0,'stalled flush leaves main timeout active');assert.equal(confirmed,0)
 release(allow);await new Promise(resolve=>setImmediate(resolve));assert.equal(acks,1);assert.equal(confirmed,allow?1:0)
}
console.log('PASS acknowledged close timeout remains live during a stalled flush and cancels after a settled refusal or confirmation')

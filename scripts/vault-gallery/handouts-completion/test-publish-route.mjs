import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import {join,basename,relative} from 'node:path'
const source=readFileSync('src/main/index.ts','utf8')
const helpers=source.slice(source.indexOf('async function verifiedRunSource('),source.indexOf("ipcMain.handle('run:build-handout'"))
const handler=source.slice(source.indexOf("ipcMain.handle('run:publish-handout'"),source.indexOf("ipcMain.handle('run:publish-handout'" )+source.slice(source.indexOf("ipcMain.handle('run:publish-handout'")).indexOf('\n//',100))
// Capture the complete handler up to its next registration instead of testing a parallel resolver.
const start=source.indexOf("ipcMain.handle('run:publish-handout'")
const end=source.indexOf('\nipcMain.handle(',start+1)
let fn,chosen,reads=0,qualified=true,available=true
const root='/fixture/vault', exact=join(root,'b/same-outline.md')
const talk={slug:'same',outlinePath:exact}
const context={join,basename,relative,realpathSync:p=>p,lstatSync:()=>({dev:1,ino:2,isFile:()=>true}),statSync:()=>({dev:1,ino:2}),process,app:{isPackaged:false,getAppPath:()=>'/fixture'},vaultAvailability:{isUnavailable:()=>!available},vaultRegistry:{list:()=>[{id:'a',root,open:true}],get:()=>({id:'a',root,open:true})},writableRootFor:()=>root,readGallerySource:async(r,p,current)=>{reads++;assert.equal(p,exact);assert.ok(current())},findTalks:()=>[{slug:'same',outlinePath:join(root,'a/same-outline.md')},talk],talkInVault:()=>{throw Error('first-slug fallback')},talkBySlug:()=>{throw Error('first-slug fallback')},runVaultFor:()=>({root}),writableVaultRoot:()=>root,readRunForTalk:()=>({id:'r',talkSlug:'same',sourceOutline:qualified?'b/same-outline.md':undefined}),ipcMain:{handle:(name,callback)=>{fn=callback}},flushTalkForPublish:async p=>{chosen=p;return {ok:false,error:'fixture-stop-before-write'}},presenterPublications:{ticket:()=>1,published:()=>[]},handoutPublishing:()=>({publish:async job=>{const reply=await job.begin();return {ok:false,error:reply.fail.error}}})}
vm.runInNewContext(ts.transpile(helpers+source.slice(start,end),{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}),context)
const reply=await fn({}, {vaultId:'a',talkSlug:'same',runId:'r'})
assert.equal(chosen,exact);assert.equal(reads,2);assert.equal(reply.success,false)
available=false;chosen=null;await fn({}, {vaultId:'a',talkSlug:'same',runId:'r'});assert.equal(chosen,null)
console.log('actual publish handler resolves exact source before flush/build; unavailable source refuses without fallback')
const buildStart=source.indexOf("ipcMain.handle('run:build-handout'")
const buildEnd=source.indexOf('\nipcMain.handle(',buildStart+1)
available=true;chosen=null
context.flushTalkForPublish=async path=>({ok:true,text:'# Fixture'})
context.unresolvedOutboundFailure=()=>null
context.localHandoutWorkerBaseUrl=()=>''
context.buildRunHandoutArtifact=async talk=>{chosen=talk.outlinePath;return {path:'/fixture/output',slideIds:[],missing:[]}}
vm.runInNewContext(ts.transpile(helpers+source.slice(buildStart,buildEnd),{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}),context)
assert.equal((await fn({}, {talkSlug:'same',runId:'r'})).success,true)
assert.equal(chosen,exact)
available=false;chosen=null
assert.equal((await fn({}, {talkSlug:'same',runId:'r'})).success,false);assert.equal(chosen,null)
console.log('actual existing build handler supplies exact outline to artifact builder and refuses unavailable source')

import assert from 'node:assert/strict'
import fs from 'node:fs'
import {join,basename,relative,dirname} from 'node:path'
import {build} from 'esbuild'
import {createRequire} from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
const base=fs.mkdtempSync(join(import.meta.dirname,'fixture-'))
try {
 const bundled=await build({entryPoints:['src/main/runs.ts'],bundle:true,write:false,format:'cjs',platform:'node',packages:'external'}), m={exports:{}}
 new Function('require','module','exports',bundled.outputFiles[0].text)(createRequire(import.meta.url),m,m.exports)
 const runs=m.exports, source=fs.readFileSync('src/main/index.ts','utf8')
 const helpers=source.slice(source.indexOf('async function verifiedRunSource('),source.indexOf("ipcMain.handle('run:build-handout'"))
 const start=source.indexOf("ipcMain.handle('run:publish-handout'"),end=source.indexOf('\nipcMain.handle(',start+1)
 for(const mode of ['unchanged','close','unavailable','root','move','source','delete','replace','changed-id','changed-slug','conflict','wrong-id','wrong-slug']) {
 const root=join(base,mode);fs.mkdirSync(join(root,'a'),{recursive:true});const exact=join(root,'a/same-outline.md');fs.writeFileSync(exact,'# Source')
 const run={id:'r',talkSlug:'same',sourceOutline:'a/same-outline.md'};runs.persistRun(root,run)
 const file=join(root,'_PRESENTATIONS/same/r.json');let open=true,unavailable=false,job,fn
 const ctx={...fs,join,basename,dirname,relative,process,app:{isPackaged:false,getAppPath:()=>process.cwd()},vaultRegistry:{list:()=>[{id:mode,root,open}],get:()=>({id:mode,root,open})},vaultAvailability:{isUnavailable:()=>unavailable},writableRootFor:()=>open?root:undefined,readGallerySource:async()=>{},findTalks:()=>[{slug:'same',outlinePath:exact}],runVaultFor:()=>({root}),readRun:runs.readRun,readRunForTalk:runs.readRunForTalk,ipcMain:{handle:(n,f)=>fn=f},presenterPublications:{ticket:()=>1,published:()=>[]},handoutPublishing:()=>({publish:async j=>{job=j;return {ok:false,error:'captured'}}}),stampRunWork:r=>r,setRunHandoutUrl:(r,url,folder)=>({...r,handoutUrl:url,handoutFolder:folder}),persistRun:runs.persistRun}
 vm.runInNewContext(ts.transpile(helpers+source.slice(start,end),{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}),ctx)
 if(mode.startsWith('wrong-'))fs.writeFileSync(file,JSON.stringify({...run,...(mode==='wrong-id'?{id:'other'}:{talkSlug:'other'})}))
 await fn({}, {vaultId:mode,talkSlug:'same',runId:'r'})
 if(mode.startsWith('wrong-')){assert.equal(job,undefined,mode);continue}
 assert.ok(job,mode)
 if(mode==='close')open=false
 if(mode==='unavailable')unavailable=true
 if(mode==='root'){fs.renameSync(root,root+'-old');fs.cpSync(root+'-old',root,{recursive:true})}
 if(mode==='move')fs.renameSync(exact,exact+'.moved')
 if(mode==='source'){fs.renameSync(exact,exact+'.old');fs.writeFileSync(exact,'# Replacement')}
 if(mode==='changed-id')fs.writeFileSync(file,JSON.stringify({...run,id:'other'}))
 if(mode==='changed-slug')fs.writeFileSync(file,JSON.stringify({...run,talkSlug:'other'}))
 if(mode==='conflict')fs.writeFileSync(file,JSON.stringify({...run,sourceOutline:'b/same-outline.md'}))
 if(mode==='delete')fs.unlinkSync(file)
 if(mode==='replace'){fs.renameSync(file,file+'.old');fs.copyFileSync(file+'.old',file)}
 const before=fs.existsSync(file)?fs.readFileSync(file):null
 if(mode!=='unchanged') {
   await assert.rejects(job.begin(),undefined,mode+' begin')
   await assert.rejects(job.prepare({}),undefined,mode+' prepare')
 }

 if(mode==='unchanged'){job.record({url:'https://example.test/page',folder:'page',phases:[]});assert.equal(runs.readRun(root,'same','r').handoutUrl,'https://example.test/page')}
 else {assert.throws(()=>job.record({url:'https://example.test/page',folder:'page',phases:[]}),undefined,mode);assert.deepEqual(fs.existsSync(file)?fs.readFileSync(file):null,before,mode)}
 console.log('PASS actual writer:',mode)
 if(mode==='unchanged') {
   const buildStart=source.indexOf("ipcMain.handle('run:build-handout'")
   const buildEnd=source.indexOf('\nipcMain.handle(',buildStart+1)
   ctx.writableVaultRoot=()=>root
   ctx.unresolvedOutboundFailure=()=>null
   ctx.localHandoutWorkerBaseUrl=()=>''
   let built=false
   ctx.buildRunHandoutArtifact=async()=>{built=true;return {path:'fixture',slideIds:[],missing:[]}}
   vm.runInNewContext(ts.transpile(helpers+source.slice(buildStart,buildEnd),{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}),ctx)
   for(const mutation of ['none','delete','wrong-id','wrong-slug','replace']) {
     fs.writeFileSync(file,JSON.stringify(run));built=false
     ctx.flushTalkForPublish=async()=>{
       if(mutation==='delete')fs.unlinkSync(file)
       if(mutation==='wrong-id')fs.writeFileSync(file,JSON.stringify({...run,id:'other'}))
       if(mutation==='wrong-slug')fs.writeFileSync(file,JSON.stringify({...run,talkSlug:'other'}))
       if(mutation==='replace'){fs.renameSync(file,file+'.saved');fs.copyFileSync(file+'.saved',file)}
       return {ok:true,text:'# Fixture'}
     }
     const reply=await fn({}, {talkSlug:'same',runId:'r'})
     assert.equal(reply.success,mutation==='none',JSON.stringify(reply))
     assert.equal(built,mutation==='none')
   }
   console.log('PASS actual build rereads: unchanged, deleted, wrong ID, wrong slug, replaced')
 }

 }
} finally {fs.rmSync(base,{recursive:true,force:true})}

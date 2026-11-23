import { readMainSource } from '../../lib/read-source.mjs'
import {hasGitConflictMarkers} from '../../../src/main/conflict-copies.mjs'
import {publicationMediaReview,publicationBuildWarnings} from '../../../src/shared/publication-files.ts'
import {runCompileOption} from '../../../src/main/handout-pages.ts'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import {build} from 'esbuild'
const rev='current working tree', git=p=>fs.readFileSync(p,'utf8')
const src=readMainSource()
async function moduleAt(p){const r=await build({stdin:{contents:git(p),sourcefile:p,resolveDir:path.resolve(path.dirname(p)),loader:'ts'},bundle:true,write:false,platform:'node',format:'cjs',plugins:[{name:'immutable',setup(b){b.onLoad({filter:/\/src\/.+\.(ts|mjs)$/},a=>({contents:git(path.relative(process.cwd(),a.path)),loader:a.path.endsWith('.ts')?'ts':'js'}))}}]});const m={exports:{}};new Function('require','module','exports',r.outputFiles[0].text)(createRequire(import.meta.url),m,m.exports);return m.exports}
const runs=await moduleAt('src/main/runs.ts')
const base=fs.mkdtempSync(path.join(import.meta.dirname,'fixture-'))
let serial=0, checks=0
function fixture(legacy=false){const root=path.join(base,`${serial++}`);fs.mkdirSync(path.join(root,'a'),{recursive:true});const outline=path.join(root,'a/same-outline.md');fs.writeFileSync(outline,'# Original');const run={id:'r',talkSlug:'same',...(legacy?{}:{sourceOutline:'a/same-outline.md'})};runs.persistRun(root,run);const file=path.join(root,'_PRESENTATIONS/same/r.json');let open=true,offline=false,writable=true,registered=true,job,handler,flush=()=>{},native=()=>{},qrHook=()=>{},built=0;
const ctx={hasGitConflictMarkers,publicationMediaReview,publicationBuildWarnings,runCompileOption,...fs,...path,process,app:{isPackaged:false,getAppPath:()=>process.cwd()},vaultRegistry:{list:()=>registered?[{id:'v',root,open}]:[],get:()=>registered?{id:'v',root,open}:undefined},vaultAvailability:{isUnavailable:()=>offline},writableRootFor:()=>writable?root:undefined,writableVaultRoot:()=>root,runVaultFor:()=>({root}),readGallerySource:async()=>native(),findTalks:()=>[{slug:'same',outlinePath:outline}],talkBySlug:()=>({slug:'same',outlinePath:outline}),talkInVault:()=>({slug:'same',outlinePath:outline}),readRun:runs.readRun,readRunForTalk:runs.readRunForTalk,requireRunForTalk:runs.requireRunForTalk,runFileProblem:runs.runFileProblem,persistRun:runs.persistRun,ipcMain:{handle:(n,f)=>handler=f},presenterPublications:{ticket:()=>1,published:()=>[]},handoutPublishing:()=>({publish:async j=>{job=j;return {ok:false,error:'captured'}}}),stampRunWork:r=>r,setRunHandoutUrl:runs.setRunHandoutUrl,flushTalkForPublish:async()=>{await flush();return {ok:true,text:'# Original'}},unresolvedOutboundFailure:()=>null,planRunWork:()=>({ok:true,phases:[]}),runPrework:()=>({}),localHandoutWorkerBaseUrl:()=>'',buildRunHandoutArtifact:async()=>{built++;return {path:'x',slideIds:[],missing:[]}}};
Object.assign(ctx,{getConfig:()=>undefined,resolveBase:()=> 'https://example.test',publishedFolders:()=>[],readHandoutRegistry:()=>({}),runSiteFolder:()=>({}),legacyRunUnproven:()=>false,RUN_FOLDER_UNPROVEN:'unproven',listRuns:()=>[],runPublishFolder:()=>({kind:'same',name:'page'}),writableSiteFolder:()=>path.join(root,'site/page'),getCompilerPath:()=>root,runForHandout:()=>({}),publishUrl:()=> 'https://example.test/page',qrImport:async()=>{await qrHook();return {makeQrSvg:()=>''}},runHandoutDistPath:()=>path.join(root,'dist'),resolvePooledRefs:t=>t,timerSettings:()=>({}),assetRootsFor:()=>[],handoutHomeDetails:()=>({}),handoutHomePrework:()=>'',handoutHomePostwork:()=>'',WORK_PAGE_FOLDER:{pre:'pre',post:'post'},buildHandoutPagesOffThread:async job=>{if(job.kind==='preflight')return {warnings:[],publicationFiles:{checked:0,findings:[]}};built++;return {warnings:[]}},writeRunWorkPages:async()=>{},runLineFor:()=>''});
const helpers=src.slice(src.indexOf('async function verifiedRunSource('),src.indexOf("ipcMain.handle('run:build-handout'"));
function load(kind){const start=src.indexOf(`ipcMain.handle('run:${kind}-handout'`),end=src.indexOf('\nipcMain.handle(',start+1);vm.runInNewContext(ts.transpile(helpers+src.slice(start,end).replace("import(pathToFileURL(join(compilerDir, 'lib/01-cli-utils.mjs')).href)",'qrImport()'),{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.None}),ctx)}
function mutate(mode){if(mode==='close')open=false;if(mode==='unavailable')offline=true;if(mode==='unregister')registered=false;if(mode==='readonly')writable=false;if(mode==='root'){fs.renameSync(root,root+'-old');fs.cpSync(root+'-old',root,{recursive:true})}if(mode==='source-move')fs.renameSync(outline,outline+'.old');if(mode==='source-inode'){fs.renameSync(outline,outline+'.old');fs.writeFileSync(outline,'# Replacement')}if(mode==='run-inode'){fs.renameSync(file,file+'.old');fs.copyFileSync(file+'.old',file);assert.notEqual(fs.statSync(file).ino,fs.statSync(file+'.old').ino)}if(mode==='deleted')fs.unlinkSync(file);if(['id','slug','conflict'].includes(mode))fs.writeFileSync(file,JSON.stringify({...run,...(mode==='id'?{id:'redirect'}:mode==='slug'?{talkSlug:'other'}:{sourceOutline:'b/same-outline.md'})}))}
return {root,file,run,ctx,load,mutate,get job(){return job},get built(){return built},call:mediaChoice=>handler({}, {vaultId:'v',talkSlug:'same',runId:'r',root:'/ignored-caller-root',mediaChoice}),flush:f=>flush=f,native:f=>native=f,qr:f=>qrHook=f}}
const bytes=f=>fs.existsSync(f)?fs.readFileSync(f):null
try{
for(const mode of ['none','close','unavailable','unregister','readonly','root','source-move','source-inode','run-inode','deleted','id','slug','conflict']){
for(const point of ['record','begin','postflush','prepare']){const f=fixture();f.load('publish');await f.call();assert.ok(f.job);let afterMutation;if(point==='postflush')f.flush(()=>{f.mutate(mode);afterMutation=bytes(f.file)});else f.mutate(mode);const before=bytes(f.file);let rejected=false;try{if(point==='record')f.job.record({url:'https://example.test/page',folder:'page',phases:[]});else if(point==='prepare')await f.job.prepare({dir:path.join(f.root,'site'),project:'fixture',live:'',link:x=>x,redirects:x=>x,makeFolder:p=>{fs.mkdirSync(p,{recursive:true});return true},writeSiteFile:(p,t)=>{fs.writeFileSync(p,t);return true},claimFile:()=>true});else await f.job.begin()}catch{rejected=true}if(mode==='none')assert.equal(rejected,false,`${mode}/${point}`);if(mode!=='none')assert.equal(rejected,true,`${mode}/${point}`);if(point==='postflush'&&mode!=='none'){assert.deepEqual(bytes(f.file),afterMutation)}else if(mode!=='none')assert.deepEqual(bytes(f.file),before);if(mode==='none'&&point==='record')assert.equal(runs.readRunForTalk(f.root,'same','r').handoutUrl,'https://example.test/page');checks++}
console.log('PASS authority/identity callbacks',mode)}
for(const mode of ['none','close','unavailable','root','source-move','source-inode','run-inode','deleted','id','slug','conflict']){const f=fixture();f.load('build');f.flush(()=>f.mutate(mode));const reply=await f.call();assert.equal(reply.success,mode==='none',JSON.stringify({mode,reply}));assert.equal(f.built,mode==='none'?1:0);checks++;console.log('PASS build after flush',mode)}
for(const mode of ['none','close','unavailable','root','source-move','source-inode','run-inode','deleted','id','slug','conflict']){const f=fixture();f.load('publish');await f.call();await f.job.begin();f.qr(()=>f.mutate(mode));let refused=false;try{await f.job.prepare({dir:path.join(f.root,'site'),project:'fixture',live:'',link:x=>x,redirects:x=>x,makeFolder:p=>{fs.mkdirSync(p,{recursive:true});return true},writeSiteFile:(p,t)=>{fs.writeFileSync(p,t);return true},claimFile:()=>true})}catch{refused=true}assert.equal(refused,mode!=='none',mode);assert.equal(f.built,mode==='none'?1:0);checks++;console.log('PASS prepare after QR await',mode)}
for(const kind of ['build','publish'])for(const legacy of [false,true])for(const mode of ['id','slug','deleted']){const f=fixture(legacy);f.mutate(mode);f.load(kind);assert.equal((await f.call()).success,false);assert.equal(f.job,undefined);assert.equal(f.built,0);checks++}console.log('PASS strict admission including legacy')
const left=fixture(),right=fixture();left.load('publish');right.load('publish');await left.call();await right.call();left.job.record({url:'https://example.test/left',folder:'left',phases:[]});assert.equal(runs.readRunForTalk(right.root,'same','r').handoutUrl,undefined);right.job.record({url:'https://example.test/right',folder:'right',phases:[]});assert.equal(runs.readRunForTalk(left.root,'same','r').handoutUrl,'https://example.test/left');checks++;console.log('PASS same Run ID distinct vault isolation')
const legacy=fixture(true);legacy.load('publish');await legacy.call();legacy.job.record({url:'https://example.test/legacy',folder:'legacy',phases:[]});assert.equal(runs.readRunForTalk(legacy.root,'same','r').sourceOutline,undefined);checks++;console.log('PASS legacy recording gains no provenance')
for(const mode of ['none','run-inode','deleted','id','slug']) {
 for(const point of ['record','begin','prepare','postflush','qr','build']) {
  const f=fixture(true);f.load(point==='build'?'build':'publish');let changed;
  const mutate=()=>{f.mutate(mode);changed=bytes(f.file)};
  if(point==='build') {f.flush(mutate);const reply=await f.call();assert.equal(reply.success,mode==='none');}
  else {
   await f.call();assert.ok(f.job);
   if(point==='postflush')f.flush(mutate);
   else if(point==='qr'){await f.job.begin();f.qr(mutate)}
   else mutate();
   let refused=false;
   try {
    if(point==='record')f.job.record({url:'https://example.test/legacy',folder:'legacy',phases:[]});
    else if(['prepare','qr'].includes(point))await f.job.prepare({dir:path.join(f.root,'site'),project:'fixture',live:'',link:x=>x,redirects:x=>x,makeFolder:p=>{fs.mkdirSync(p,{recursive:true});return true},writeSiteFile:(p,t)=>{fs.writeFileSync(p,t);return true},claimFile:()=>true});
    else await f.job.begin();
   }catch{refused=true}
   assert.equal(refused,mode!=='none',`${mode}/${point}`);
  }
  assert.equal(f.built,mode==='none'&&['build','prepare','qr'].includes(point)?1:0);
  if(mode!=='none')assert.deepEqual(bytes(f.file),changed,`${mode}/${point} replacement untouched`);
  else assert.equal(runs.readRunForTalk(f.root,'same','r').sourceOutline,undefined);
  checks++;console.log('PASS legacy continuity',mode,point);
 }
}
const legacyLeft=fixture(true),legacyRight=fixture(true);legacyLeft.load('publish');legacyRight.load('publish');await legacyLeft.call();await legacyRight.call();legacyLeft.mutate('run-inode');const replacement=bytes(legacyLeft.file);assert.throws(()=>legacyLeft.job.record({url:'https://example.test/left',folder:'left',phases:[]}));assert.deepEqual(bytes(legacyLeft.file),replacement);legacyRight.job.record({url:'https://example.test/right',folder:'right',phases:[]});assert.equal(runs.readRunForTalk(legacyRight.root,'same','r').handoutUrl,'https://example.test/right');assert.equal(runs.readRunForTalk(legacyRight.root,'same','r').sourceOutline,undefined);checks++;console.log('PASS legacy same tuple two vault isolation');
const service = await moduleAt('src/main/handout-publishing.ts')
const direct = await moduleAt('src/main/pages-direct-upload.ts')
const { createFakeCloudflare, fakeCloudflareFetch } = await import(path.resolve('scripts/lib/cloudflare-api-stub.mjs'))
const site = path.join(base, 'service-site')
fs.mkdirSync(site)
let uploads = 0, published = 0
const api = createFakeCloudflare({ accountSites: { fixture: ['fixture'] }, pagesDeployments: { fixture: { fixture: { neverDeployed: true } } } })
const send = fakeCloudflareFetch(api)
const production = () => api.production('fixture', 'fixture')
const publishing = service.createHandoutPublishing({
  siteDir: () => site,
  preservationRoot: path.join(base, 'preservation'),
  stagingRoot: () => path.join(base, 'staging'),
  inventory: async () => {
    const deployment = production()
    const files = Object.entries(deployment?.files ?? {})
    return { complete: true, site: 'cf-pages:fixture:fixture', revision: deployment?.id ?? 'no-production-deployment', paths: files.map(([name]) => name), files }
  },
  authorise: async () => ({
    ok: true,
    authorisation: {
      project: 'fixture', accountId: 'fixture', productionBranch: 'main',
      current: () => true, clean: text => text, refusedForPermission: () => {},
      published: () => published++,
      run: async work => ({ superseded: false, result: await work({}) }),
    },
  }),
  bundlingHazard: () => null,
  live: async () => ({ baseUrl: '' }),
  pages: () => ({
    fetch: async (url, init) => {
      const response = await send(url, init)
      if (init?.method === 'POST' && String(url).endsWith('/deployments')) uploads++
      return response
    },
    apiBase: 'http://127.0.0.1:9/client/v4', allowLoopbackForTests: true,
    sleep: async () => {}, contentType: direct.loadWranglerMime(process.cwd()),
  }),
  blake3: () => direct.loadWranglerBlake3(process.cwd()),
})

const unavailable = fixture()
unavailable.load('publish')
unavailable.ctx.handoutPublishing = () => ({
  publish: job => {
    unavailable.mutate('unavailable')
    return publishing.publish(job)
  },
})
const refused = await unavailable.call('with-placeholders')
assert.equal(refused.success, false)
assert.equal(refused.error, 'run-source-unavailable')
assert.equal(unavailable.built, 0)
assert.equal(uploads, 0)
assert.equal(published, 0)
assert.equal(production(), null)
checks++
console.log('PASS Publish anyway still refuses an unavailable Run source before building or uploading')

const linkSave = fixture(true)
linkSave.load('publish')
await linkSave.call()
const before = bytes(linkSave.file)
const built = { url: 'https://example.test/page', folder: 'page', phases: [] }
const html = '<p>Uploaded page</p>'
let saveAttempted = false
const outcome = await publishing.publish({
  entry: 'run',
  prepare: async ({ dir, makeFolder }) => {
    fs.writeFileSync(path.join(makeFolder(path.join(dir, built.folder)), 'index.html'), html)
    return { ok: true, built }
  },
  record: publication => {
    saveAttempted = true
    linkSave.mutate('unavailable')
    linkSave.job.record(publication)
  },
})
assert.equal(saveAttempted, true)
assert.equal(outcome.ok, true)
assert.equal(outcome.localRecordFailed, true)
assert.equal(outcome.built.url, built.url)
assert.equal(uploads, 1)
assert.equal(published, 1)
assert.equal(api.model.assets.get(production().files['/page/index.html']).bytes.toString(), html)
assert.deepEqual(bytes(linkSave.file), before)
assert.equal(runs.readRunForTalk(linkSave.root, 'same', 'r').handoutUrl, undefined)
assert.equal(fs.readFileSync(path.join(site, 'page/index.html'), 'utf8'), html)
checks++
console.log('PASS confirmed deployment survives refused Run link save and reports the local failure')

const recordText=src.slice(src.indexOf('record: ({ url, folder, phases }) =>',src.indexOf("ipcMain.handle('run:publish-handout'")),src.indexOf('// A refusal of its first step',src.indexOf("ipcMain.handle('run:publish-handout'")));assert.ok(!/\bawait\b/.test(recordText.replace(/\/\/[^\n]*/g,'')));assert.ok(recordText.includes('persistRun(vault,'));console.log('PASS inspected synchronous actual record callback: no await')
console.log(`PASS ${checks} handler/filesystem checks at ${rev}`)
}finally{fs.rmSync(base,{recursive:true,force:true})}

/** Hidden built app, fixture profile; never attaches to any installed/running owner app. */
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { sourceIdentity } from '../scripts/precise-word-timing/source-identity.mjs'
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,rmSync } from 'node:fs'
import { join,resolve } from 'node:path'
const require=createRequire(import.meta.url),root=process.cwd(),scratch=mkdtempSync(join(root,'.tw-alignment-ui-'))
const shots=resolve('docs/design/2026-11-10-record-and-edit-video/built/slice-2b');mkdirSync(shots,{recursive:true})
let app
try {
 const profile=join(scratch,'profile'),home=join(scratch,'home');mkdirSync(profile);mkdirSync(home)
 const vault=join(scratch,'vault'),slug='timing-fixture',sid='public-timing-run',talk=join(vault,slug),runs=join(vault,'_PRESENTATIONS',slug)
 mkdirSync(talk,{recursive:true});mkdirSync(runs,{recursive:true});mkdirSync(join(profile,'recordings'),{recursive:true})
 writeFileSync(join(talk,slug+'-outline.md'),'---\ntitle: Public timing fixture\noutline_version: 2\n---\n\n### Words\n{id=words}\n\n- Public corpus fixture\n')
 const corpus=join(root,'docs/design/2026-11-10-record-and-edit-video/built/slice-2/continuous-speech'),ref=JSON.parse(readFileSync(join(corpus,'reference-english.json'),'utf8'))[0],raw=JSON.parse(readFileSync(join(corpus,ref.id+'-native.json'),'utf8'))
 const repeats=30,durationMs=ref.durationMs*repeats
 // A real public-derived WebM/Opus Run lasts long enough to cancel through the UI.
 execFileSync(join(root,'node_modules/ffmpeg-static/ffmpeg'),['-v','error','-y','-stream_loop',String(repeats-1),'-i',join(root,ref.audio),'-t',String(durationMs/1000),'-c:a','libopus','-b:a','64k','-ac','1','-ar','48000',join(profile,'recordings',sid+'.webm')])
 const uiRaw={segments:[{text:Array(repeats).fill(raw.segments.map(s=>s.text).join(' ')).join(' '),startMs:0,endMs:durationMs}],words:Array.from({length:repeats},(_,i)=>raw.words.map(w=>({...w,startMs:w.startMs+i*ref.durationMs,endMs:w.endMs+i*ref.durationMs}))).flat(),silence:Array.from({length:repeats},(_,i)=>raw.silence.map(s=>({start:s.start+i*ref.durationMs,end:s.end+i*ref.durationMs}))).flat()}
 writeFileSync(join(runs,sid+'.json'),JSON.stringify({id:sid,talkSlug:slug,talkTitle:'Public timing fixture',kind:'recording',status:'delivered',startedAt:'2026-11-10T12:00:00Z',endedAt:'2026-11-10T12:01:03Z',recordingMs:durationMs,wallClockMs:durationMs,slideSet:{kind:'full'},slideTimeIndex:[{event:'enter',slideId:'words',tMs:0}],audio:{uploaded:false,durationMs,segments:[{file:sid+'.webm',startMs:0,endMs:durationMs}]},events:[]}))
 const csRef=JSON.parse(readFileSync(join(corpus,'reference-czech.json'),'utf8'))[0],csRaw=JSON.parse(readFileSync(join(corpus,csRef.id+'-native.json'),'utf8')),csSid='public-czech-run'
 execFileSync(join(root,'node_modules/ffmpeg-static/ffmpeg'),['-v','error','-y','-i',join(root,csRef.audio),'-c:a','libopus','-b:a','64k','-ac','1','-ar','48000',join(profile,'recordings',csSid+'.webm')])
 writeFileSync(join(runs,csSid+'.json'),JSON.stringify({id:csSid,talkSlug:slug,talkTitle:'Public timing fixture',kind:'recording',status:'delivered',startedAt:'2026-11-10T11:00:00Z',endedAt:'2026-11-10T11:00:06Z',recordingMs:csRef.durationMs,wallClockMs:csRef.durationMs,slideSet:{kind:'full'},slideTimeIndex:[{event:'enter',slideId:'words',tMs:0}],audio:{uploaded:false,durationMs:csRef.durationMs,segments:[{file:csSid+'.webm',startMs:0,endMs:csRef.durationMs}]},events:[]}))
 const csTranscriptPath=join(runs,csSid+'.transcript.json')
 writeFileSync(csTranscriptPath,JSON.stringify({engine:'apple-dictation',createdAt:'2026-11-10',locale:'cs-CZ',timingClock:'recording-v2',segments:csRaw.segments.map(s=>({text:s.text,start:s.startMs,end:s.endMs})),words:csRaw.words.map(w=>({text:w.text,start:w.startMs,end:w.endMs})),silence:csRaw.silence}))
 const transcriptPath=join(runs,sid+'.transcript.json')
 writeFileSync(transcriptPath,JSON.stringify({engine:'parakeet',createdAt:'2026-11-10',locale:'en-US',timingClock:'recording-v2',segments:uiRaw.segments.map(s=>({text:s.text,start:s.startMs,end:s.endMs})),words:uiRaw.words.map(w=>({text:w.text,start:w.startMs,end:w.endMs})),silence:uiRaw.silence}))
 writeFileSync(join(profile,'config.json'),JSON.stringify({vaultRoot:vault,vaultRootMirrored:vault,vaults:[{id:'fixture',root:vault,open:true,order:0}]}))
 app=await electron.launch({executablePath:process.env.TW_ALIGNMENT_TEST_EXECUTABLE??require('electron'),args:[...(process.env.TW_ALIGNMENT_TEST_EXECUTABLE?[]:[root]),`--user-data-dir=${profile}`,'--use-mock-keychain'],env:{...process.env,HOME:home,TW_E2E:'1',TW_REC_TEST:'1',TW_E2E_HIDE:'1',ELECTRON_RUN_AS_NODE:''}})
 const editor=await app.firstWindow();await editor.waitForLoadState('domcontentloaded')
 // Calls the app's normal Settings route; TW_E2E keeps every app window show:false.
 const settingsPromise=app.waitForEvent('window');await editor.evaluate(()=>window.tw.settingsWindow.open('recording'));const settings=await settingsPromise
 await settings.waitForLoadState('domcontentloaded')
 await settings.locator('[data-precise-word-timing]').waitFor();await settings.locator('[data-precise-word-timing]').scrollIntoViewIfNeeded()
 assert.match(await settings.locator('[data-precise-word-timing]').innerText(),/English/)
 await settings.locator('[data-precise-word-timing]').scrollIntoViewIfNeeded();await settings.screenshot({path:join(shots,'settings-absent.png')})
 // Verify the editor is refused a Settings-only operation, with no picker or network access.
 const refused=await editor.evaluate(()=>window.tw.alignment.remove('en'));assert.equal(refused.ok,false)
 const manifest=JSON.parse(readFileSync(join(root,'resources/alignment-models/en.json'),'utf8'))
 const csManifest=JSON.parse(readFileSync(join(root,'resources/alignment-models/cs.json'),'utf8'))
 const models=join(profile,'alignment-models');mkdirSync(models,{recursive:true})
 const enRow=settings.locator('[data-precise-word-timing] .bsw-row').filter({has:settings.getByText('English',{exact:true})})
 if(manifest.source==='local'){
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]})},join(root,'scripts/precise-word-timing/local/model_int8.onnx'))
  await enRow.getByRole('button',{name:'Install from file…',exact:true}).click()
 }else await enRow.getByRole('button',{name:'Download',exact:true}).click()
 await settings.getByText('Precise word timing: installed on this Mac',{exact:true}).waitFor({timeout:120000})
 await settings.reload();await settings.locator('button.bsw-nav[data-section="recording"]').click();await settings.locator('[data-precise-word-timing]').waitFor()
 await settings.getByText('Precise word timing: installed on this Mac',{exact:true}).waitFor()
 await settings.locator('[data-precise-word-timing]').scrollIntoViewIfNeeded();await settings.screenshot({path:join(shots,'settings-installed.png')})
 await settings.locator('[data-precise-word-timing]').getByRole('button',{name:'Remove',exact:true}).click()
 await enRow.getByRole('button',{name:manifest.source==='local'?'Install from file…':'Download',exact:true}).waitFor()
 await settings.locator('[data-precise-word-timing]').scrollIntoViewIfNeeded();await settings.screenshot({path:join(shots,'settings-removed.png')})
 for(const [state,extra] of [['downloading',{received:manifest.bytes/2}],['failed',{note:'Offline. Connect once and Retry.'}],['unavailable',{}]]) {
  await app.evaluate(({BrowserWindow},{row,other})=>{for(const w of BrowserWindow.getAllWindows())if(w.webContents.getURL().includes('settings'))w.webContents.send('alignment:models-changed',[row,other])},{row:{language:'en',label:'English',state,bytes:manifest.bytes,host:manifest.url?new URL(manifest.url).hostname:undefined,local:manifest.source==='local',...extra},other:{language:'cs',label:'Czech',state:'absent',local:true,bytes:csManifest.bytes}})
  if(state==='downloading')await settings.getByRole('button',{name:'Cancel',exact:true}).waitFor()
  if(state==='failed')await settings.getByRole('button',{name:'Retry',exact:true}).waitFor()
  await settings.locator('[data-precise-word-timing]').scrollIntoViewIfNeeded();await settings.screenshot({path:join(shots,`settings-${state}-fixture.png`)})
 }
 copyFileSync(join(root,'scripts/precise-word-timing/local/model_int8.onnx'),join(models,`${manifest.id}-${manifest.sha256}.onnx`))
 const studioPromise=app.waitForEvent('window');await editor.evaluate(sid=>window.tw.tools.open('studio',sid),sid);const studio=await studioPromise
 await studio.waitForLoadState('domcontentloaded');await studio.getByRole('button',{name:'Align words again',exact:true}).waitFor()
 await studio.screenshot({path:join(shots,'run-earlier-times.png')})
 const before=readFileSync(transcriptPath,'utf8')
 await studio.getByRole('button',{name:'Align words again',exact:true}).click()
 await studio.getByRole('button',{name:'Cancel alignment',exact:true}).waitFor()
 await studio.getByText(/Aligning words: 1 of/).waitFor({timeout:60000})
 await studio.screenshot({path:join(shots,'run-aligning.png')})
 await studio.getByRole('button',{name:'Cancel alignment',exact:true}).click()
 await studio.getByText('cancelled',{exact:true}).waitFor();assert.equal(readFileSync(transcriptPath,'utf8'),before)
 await studio.screenshot({path:join(shots,'run-cancelled.png')})
 await studio.getByRole('button',{name:'Align words again',exact:true}).click()
 await studio.getByText(/Words aligned; .* words kept their earlier times/).waitFor({timeout:60000})
 assert.ok(JSON.parse(readFileSync(transcriptPath,'utf8')).alignment)
 await studio.screenshot({path:join(shots,'run-aligned.png')})
 await settings.reload();await settings.locator('button.bsw-nav[data-section="recording"]').click();await settings.locator('[data-precise-word-timing]').waitFor()
 const csRow=settings.locator('[data-precise-word-timing] .bsw-row').filter({has:settings.getByText('Czech',{exact:true})})
 await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]})},join(root,'scripts/precise-word-timing/local/cs/model-int8.onnx'))
 await csRow.getByRole('button',{name:'Install from file…',exact:true}).click();await csRow.getByText('Precise word timing: installed on this Mac',{exact:true}).waitFor({timeout:120000})
 await settings.locator('[data-precise-word-timing]').scrollIntoViewIfNeeded();await settings.screenshot({path:join(shots,'settings-both-installed.png')})
 await app.evaluate(({BrowserWindow},{sid,home})=>{for(const w of BrowserWindow.getAllWindows())w.webContents.send('alignment:state',{sessionId:sid,home,state:'working',note:'Fixture: late progress for the previous Run'})},{sid,home:vault})
 await studio.getByRole('button',{name:'Cancel alignment',exact:true}).waitFor()
 await editor.evaluate(sid=>window.tw.tools.open('studio',sid),csSid)
 await studio.getByText(csRaw.segments[0].text,{exact:true}).waitFor()
 assert.equal(await studio.getByRole('button',{name:'Cancel alignment',exact:true}).count(),0,'Previous Run progress cannot leave the new Run busy')
 assert.equal(await studio.getByRole('button',{name:'Align words again',exact:true}).isEnabled(),true)
 await studio.getByRole('button',{name:'Align words again',exact:true}).click();await studio.getByText(/Words aligned; .* words kept their earlier times/).waitFor({timeout:60000})
 const csSaved=JSON.parse(readFileSync(csTranscriptPath,'utf8'));assert.equal(csSaved.alignment.sha256,csManifest.sha256);assert.ok(csSaved.words.some(w=>w.alignment?.status==='aligned'),'Czech public speech must have confidently placed words')
 await studio.screenshot({path:join(shots,'run-czech-aligned.png')})
 const runtime=await app.evaluate(({app})=>({packaged:app.isPackaged,version:app.getVersion(),electron:process.versions.electron,node:process.versions.node,arch:process.arch,platform:process.platform}))
 writeFileSync(join(shots,'hidden-ui-evidence.json'),JSON.stringify({...runtime,source:sourceIdentity(),flavour:process.env.TW_ALIGNMENT_TEST_EXECUTABLE?'signed unpublished security-test':'development Electron with production source build',cancellationAfterNativeChunkProgress:true,realStates:['model absent','model verified installed','model removed','public Run aligning','public Run cancelled without write','public Run aligned after retry','Czech verified local installation','Czech public Run aligned through native utility'],eventFixtures:['model downloading','model failed/offline','language unavailable','late progress for previous Run during navigation']},null,2)+'\n')
 console.log('PASS hidden Settings absent/installed/removed; Settings event-fixture failure/progress/unavailable; actual public Run alignment cancel/retry/atomic save; screenshots captured')
}catch(error){
 console.error('Hidden alignment walkthrough failed:',error.message)
 if(app)for(const page of app.windows())try{if(page.url().includes('tools')){console.error('Isolated test Run state:',await page.locator('.tws-transcript-seam').innerText());await page.screenshot({path:join(shots,'run-failure.png')})}}catch{}
 throw error
}finally{await app?.close();rmSync(scratch,{recursive:true,force:true})}

// J1 through the real hidden Studio, package IPC, compiler and ffmpeg. Disposable author data only.
import assert from 'node:assert/strict'
import { _electron as electron } from 'playwright'
import { mkdirSync,mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync,realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { shutdownApp } from './lib/settings-window.mjs'
const root=process.cwd(),scratch=mkdtempSync(join(tmpdir(),'tw-video-j1-'))
const userData=join(scratch,'userData'), vault=join(scratch,'vault'), second=join(scratch,'secondary')
const slug='video-fixture',sid='sess-video-j1',noAudioId='sess-video-noaudio'
const outlineText='---\ntitle: Recorded voice fixture\noutline_version: 2\n---\n\n## Opening\n\n### One\n{id=one}\n\n- A spoken point\n\n## Demo\n\n### Two {code}\n{id=two}\n\n```js\nconst voice = "real"\n```\n'
for(const v of [vault,second]){mkdirSync(join(v,slug),{recursive:true});mkdirSync(join(v,'_PRESENTATIONS',slug),{recursive:true});writeFileSync(join(v,slug,slug+'-outline.md'),outlineText)}
mkdirSync(join(userData,'recordings'),{recursive:true})
writeFileSync(join(userData,'config.json'),JSON.stringify({vaultRoot:vault,vaultRootMirrored:vault,vaults:[{id:'first',root:vault,open:true,order:0},{id:'second',root:second,open:true,order:1}]}))
const audio=join(userData,'recordings',sid+'.webm'),ffmpeg=createRequire(import.meta.url)('ffmpeg-static')
const encode=spawnSync(ffmpeg,['-v','error','-f','lavfi','-i','sine=frequency=440:duration=2','-c:a','libopus',audio],{encoding:'utf8'})
assert.equal(encode.status,0,encode.stderr)
const original=readFileSync(audio)
let app
let processLog = ''
let count=0
const ok=name=>console.log(`PASS ${++count}. ${name}`)
try{
 const env={TW_E2E:'1'}
 for(const name of ['PATH','HOME','USER','LOGNAME','TMPDIR','LANG','SHELL','DISPLAY','SystemRoot','SYSTEMROOT','windir','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','USERNAME','PATHEXT','ComSpec'])if(process.env[name]!==undefined)env[name]=process.env[name]
 app=await electron.launch({args:['.','--use-mock-keychain',`--user-data-dir=${userData}`],cwd:root,env})
 app.process().stderr?.on('data', chunk => { processLog += chunk.toString() })
 const page=await app.firstWindow();await page.waitForFunction(()=>Boolean(window.tw?.tools))
 assert.equal(realpathSync(await app.evaluate(({app})=>app.getPath('userData'))),realpathSync(userData))
 const outline=join(vault,slug,slug+'-outline.md')
 const rows=await page.evaluate(async({outline,text})=>window.tw.talk.compile(outline,text),{outline,text:outlineText})
 assert.ok(rows?.length>=2,JSON.stringify(rows))
 const selected=rows.filter(r=>r.nav_title==='One'||r.nav_title==='Two'||r.title==='One'||r.title==='Two')
 assert.equal(selected.length,2,JSON.stringify(rows.map(r=>({title:r.title,nav_title:r.nav_title}))))
 const run={id:sid,talkSlug:slug,talkTitle:'Recorded voice fixture',kind:'delivery',status:'delivered',startedAt:'2026-10-18T12:00:00.000Z',endedAt:'2026-10-18T12:00:02.000Z',recordingMs:2000,wallClockMs:2000,slideSet:{kind:'full'},slideTimeIndex:[{event:'enter',slideId:selected[0].slide_id,tMs:0},{event:'enter',slideId:selected[1].slide_id,tMs:1000}],audio:{uploaded:false,segments:[{file:sid+'.webm',startMs:0,endMs:2000}],durationMs:2000},events:[]}
 const transcript={engine:'parakeet',createdAt:'2026-10-18T12:01:00.000Z',segments:[{text:'Real recorded voice.',start:0,end:1900}],words:[{text:'Real',start:0,end:500},{text:'recorded',start:500,end:1000},{text:'voice.',start:1000,end:1900}]}
 const runDir=join(vault,'_PRESENTATIONS',slug)
 writeFileSync(join(runDir,sid+'.json'),JSON.stringify(run));writeFileSync(join(runDir,sid+'.transcript.json'),JSON.stringify(transcript))
 writeFileSync(join(runDir,noAudioId+'.json'),JSON.stringify({...run,id:noAudioId,startedAt:'2026-10-17T12:00:00.000Z',audio:null,talkTitle:'Run without audio'}))
 // Same IDs in another open vault: its inline words must be resolved by the selected home.
 writeFileSync(join(second,'_PRESENTATIONS',slug,sid+'.json'),JSON.stringify(run))
 writeFileSync(join(second,'_PRESENTATIONS',slug,sid+'.transcript.json'),JSON.stringify({...transcript,words:[]}))
 const windowPromise=app.waitForEvent('window');windowPromise.catch(()=>{})
 await app.evaluate(({Menu})=>{
   const find=menu=>menu.items.flatMap(item=>[item,...(item.submenu?find(item.submenu):[])])
   const item=find(Menu.getApplicationMenu()).find(item=>item.label==='Animated video…')
   if(!item)throw new Error('Animated video menu item missing')
   item.click()
 })
 const studio=await windowPromise
 studio.setDefaultTimeout(30000);await studio.waitForLoadState('domcontentloaded')
 const action=studio.getByRole('button',{name:'Animated video…',exact:true});await action.waitFor();await studio.waitForFunction(()=>!document.querySelector('button[title="The slides are still loading."]'))
 await studio.getByText('Ready',{exact:true}).waitFor();ok('native menu creates Studio and opens the sheet after Run slides load')
 const other=await studio.evaluate(({talkSlug,sessionId,home})=>window.tw.videoPack.wordStatus({talkSlug,sessionId,home}),{talkSlug:slug,sessionId:sid,home:second})
 assert.equal(other.ok,true);assert.equal(other.hasWords,false)
 const refused=await studio.evaluate(({talkSlug,sessionId,home})=>window.tw.videoPack.wordStatus({talkSlug,sessionId,home}),{talkSlug:slug,sessionId:sid,home:scratch})
 assert.equal(refused.ok,false);ok('explicit registered vault home resolves the right pair; unregistered roots are refused')
 await studio.getByRole('button',{name:'Make package',exact:true}).click();await studio.getByRole('button',{name:'Copy prompt for your agent',exact:true}).waitFor({timeout:90000})
 const packs=join(vault,slug,'video-packs'),folders=()=>readdirSync(packs).filter(n=>!n.startsWith('.'))
 assert.equal(folders().length,1);const first=join(packs,folders()[0]),prompt=readFileSync(join(first,'PROMPT.md'),'utf8')
 assert.equal(await studio.getByRole('textbox',{name:'Prompt for your agent'}).inputValue(),prompt)
 // Isolate the clipboard from the owner's other active apps and test sessions.
 await studio.evaluate(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.videoCopiedPrompt=text}},configurable:true}))
 await studio.getByRole('button',{name:'Copy prompt for your agent',exact:true}).click()
 assert.equal(await studio.evaluate(()=>window.videoCopiedPrompt),prompt)
 assert.deepEqual(JSON.parse(readFileSync(join(first,'words.json'))).map(w=>w.text),['Real','recorded','voice.'])
 assert.deepEqual(readFileSync(audio),original);ok('full J1 writes a new complete package and copies exact PROMPT.md without changing the voice')
 await studio.getByRole('button',{name:'Close',exact:true}).click();await action.click();await studio.getByText('Ready',{exact:true}).waitFor();await studio.getByRole('button',{name:'Make package',exact:true}).click();await studio.getByRole('button',{name:'Copy prompt for your agent',exact:true}).waitFor({timeout:90000})
 assert.equal(folders().length,2);assert.equal(readFileSync(join(first,'PROMPT.md'),'utf8'),prompt);assert.deepEqual(readFileSync(audio),original);ok('repeating J1 creates a new version and preserves the first package and recording')
 await studio.getByRole('button',{name:'Close',exact:true}).click()
 await studio.getByText('Package made, waiting for the video',{exact:true}).waitFor()
 assert.equal(await studio.locator('[data-sid="sess-video-j1"]').getByText('Video pending',{exact:true}).count(),1)
 const newest=folders().map(name=>({name,created:JSON.parse(readFileSync(join(packs,name,'stretch.json'))).createdAt})).sort((a,b)=>b.created.localeCompare(a.created))[0]
 const output=join(packs,newest.name,'out','finished.mp4')
 const render=spawnSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=black:s=160x90:r=10:d=1.2','-c:v','libx264','-pix_fmt','yuv420p',output],{encoding:'utf8'})
 assert.equal(render.status,0,render.stderr)
 await studio.getByText('Animated video ready · 0:01',{exact:true}).waitFor()
 assert.equal(await studio.locator('[data-sid="sess-video-j1"]').getByText('Video ready',{exact:true}).count(),1)
 await studio.getByRole('button',{name:'Play',exact:true}).click()
 await studio.getByRole('button',{name:'Show in Finder',exact:true}).click()
 assert.equal(await studio.evaluate(input=>window.tw.videoPack.reveal(input,'video'),{talkSlug:slug,sessionId:sid,home:vault,packageId:newest.name}),true)
 assert.equal(await studio.evaluate(input=>window.tw.videoPack.reveal(input,'video'),{talkSlug:slug,sessionId:sid,home:vault,packageId:output}),false)
 assert.deepEqual(readFileSync(audio),original);ok('J3 watcher turns waiting card/chip into ready with real length and safe Play')

 const extraRunId='sess-video-extras',extraSlideId='extra-video-j1'
 const extraRun={...run,id:extraRunId,startedAt:'2026-10-18T13:00:00.000Z',trims:[{start:500,end:1000}],extraSlides:[{id:extraSlideId,title:'Run-only slide',text:'Words kept on this Run',after:selected[0].slide_id}],slideTimeIndex:[{event:'enter',slideId:selected[0].slide_id,tMs:0},{event:'enter',slideId:extraSlideId,tMs:1000},{event:'enter',slideId:selected[1].slide_id,tMs:1500}],audio:{...run.audio,segments:[{file:extraRunId+'.webm',startMs:0,endMs:2000}]}}
 writeFileSync(join(userData,'recordings',extraRunId+'.webm'),original);writeFileSync(join(runDir,extraRunId+'.json'),JSON.stringify(extraRun));writeFileSync(join(runDir,extraRunId+'.transcript.json'),JSON.stringify({...transcript,timingClock:'recording-v2'}))
 await page.evaluate(id=>window.tw.tools.open('studio',id),extraRunId)
 await studio.locator('[data-sid="sess-video-extras"].active').waitFor()
 await action.click();await studio.getByText('Ready',{exact:true}).waitFor()
 assert.equal(await studio.locator('.av-slide').filter({hasText:'Run-only slide'}).count(),1)
 await studio.getByRole('button',{name:'Make package',exact:true}).click();await studio.getByRole('button',{name:'Copy prompt for your agent',exact:true}).waitFor({timeout:90000})
 const extraFolder=join(packs,folders().find(name=>name.startsWith(extraRunId+'-')))
 assert.equal(JSON.parse(readFileSync(join(extraFolder,'stretch.json'))).durationMs,1500)
 assert.deepEqual(JSON.parse(readFileSync(join(extraFolder,'words.json'))).map(w=>w.text),['Real','voice.'])
 assert.ok(JSON.parse(readFileSync(join(extraFolder,'slides/index.json')))[extraSlideId])
 assert.equal(readFileSync(join(runDir,extraRunId+'.json'),'utf8'),JSON.stringify(extraRun));assert.deepEqual(readFileSync(join(userData,'recordings',extraRunId+'.webm')),original)
 ok('Studio loads Run-specific extra slides and exports the saved trim without restoring cut words')
 await studio.getByRole('button',{name:'Close',exact:true}).click()
 // House rule R5 (consistency batch 3): Studio's left list is Recorded Runs, the Runs that have audio. A delivered Run
 // without audio is in the Runs view, not here, so it is not offered a video from Studio.
 assert.equal(await studio.locator('[data-sid="sess-video-noaudio"]').count(),0);assert.equal(await studio.getByRole('heading',{name:'Recorded Runs'}).count(),1);ok('Studio lists Recorded Runs only: a delivered Run without audio is not in the list')
 const visible=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().some(w=>w.isVisible()))
 assert.equal(visible,false,'all test windows stay hidden');ok('all app and renderer windows remain hidden')
 console.log(`PASS animated video J1: ${count} checks`)
}catch(error){console.error(processLog);throw error}finally{await shutdownApp(app);rmSync(scratch,{recursive:true,force:true})}

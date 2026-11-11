import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createRequire} from 'node:module'
import {EventEmitter} from 'node:events'
import {build} from 'esbuild'
import {createRequire as requireFrom} from 'node:module'
import {renameSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {videoPackageStatus,videoPackageTarget,videoLengthReader,watchVideoPackages} from '../src/main/video-package-status.ts'
const root=mkdtempSync(join(tmpdir(),'tw-video-status-')),talkDir=join(root,'talk'),packs=join(talkDir,'video-packs'),source={vault:root,talkDir,sessionId:'run'}
mkdirSync(talkDir)
let checks=0,close=()=>{}
const ok=n=>console.log(`PASS ${++checks}. ${n}`)
const until=async check=>{const end=Date.now()+5000;while(!check()){if(Date.now()>end)throw new Error('watch notification timeout');await new Promise(r=>setTimeout(r,30))}}
const pack=(name,date)=>{const folder=join(packs,name);mkdirSync(join(folder,'out'),{recursive:true});writeFileSync(join(folder,'PROMPT.md'),'Exact prompt '+name);writeFileSync(join(folder,'stretch.json'),JSON.stringify({sessionId:'run',createdAt:date,durationMs:8000,sections:['Demo']}));return folder}
try{
 assert.deepEqual(await videoPackageStatus(source,async()=>1000),{state:'none'});ok('no package is none, with no writes')
 let events=0;close=watchVideoPackages(source,()=>events++)
 const first=pack('run-sections-first','2026-10-18T10:00:00Z');await until(()=>events>0)
 let status=await videoPackageStatus(source,async()=>1000)
 const stretchPath=join(first,'stretch.json'),savedStretch=readFileSync(stretchPath,'utf8')
 writeFileSync(stretchPath,JSON.stringify({ranges:[{start:1000,end:9000}],durationMs:8000}))
 assert.equal((await videoPackageStatus(source,async()=>1000)).stretch,'Selected sections')
 writeFileSync(stretchPath,savedStretch)
 assert.equal(status.state,'waiting');assert.equal(status.stretch,'Demo');assert.equal(status.prompt,'Exact prompt run-sections-first');ok('new package creation is noticed and read as waiting')
 events=0;const video=join(first,'out','finished.mp4');writeFileSync(video,'fixture');await until(()=>events>0)
 status=await videoPackageStatus(source,async()=>4567);assert.equal(status.state,'ready');assert.equal(status.videoPath,video);assert.equal(status.lengthMs,4567);ok('new MP4 is noticed without restart and carries its probed length')
 const later=pack('run-whole-run-later','2026-10-19T10:00:00Z')
 assert.equal((await videoPackageStatus(source,async()=>4567)).folder,first);ok('new waiting version never hides an older finished video')
 const second=join(later,'out','final.mp4');writeFileSync(second,'fixture2')
 assert.equal((await videoPackageStatus(source,async()=>9000)).videoPath,second);ok('the newest finished package wins')
 pack('another-run-whole-run-foreign','2026-10-25T10:00:00Z')
 const malformed=pack('run-whole-run-malformed','2026-10-30T10:00:00Z');writeFileSync(join(malformed,'stretch.json'),'not json')
 assert.equal((await videoPackageStatus(source,async()=>9000)).videoPath,second)
 assert.equal(readFileSync(join(malformed,'stretch.json'),'utf8'),'not json');ok('foreign and malformed versions are ignored and unchanged')
 const outside=join(root,'outside.mp4');writeFileSync(outside,'author video')
 symlinkSync(outside,join(later,'out','linked.mp4'))
 const folder=pack('run-whole-run-linked','2026-11-01T10:00:00Z');rmSync(join(folder,'out'),{recursive:true});symlinkSync(root,join(folder,'out'))
 const candidates=[];await videoPackageStatus(source,async file=>{candidates.push(file);return 5000})
 assert.equal(candidates.includes(outside),false);assert.equal(candidates.some(p=>p.endsWith('linked.mp4')),false);assert.equal(readFileSync(outside,'utf8'),'author video');ok('linked output folders and linked MP4 files are never followed')
 close();await new Promise(r=>setTimeout(r,350));const before=events;writeFileSync(join(first,'out','later.mp4'),'later');await new Promise(r=>setTimeout(r,450));assert.equal(events,before);ok('disposing the watcher removes its notifications')
 const ffmpeg=createRequire(import.meta.url)('ffmpeg-static'),real=join(root,'real.mp4')
 const made=spawnSync(ffmpeg,['-v','error','-f','lavfi','-i','color=c=black:s=160x90:r=10:d=1.2','-c:v','libx264','-pix_fmt','yuv420p',real],{encoding:'utf8'});assert.equal(made.status,0,made.stderr)
 const readLength=videoLengthReader(()=>ffmpeg);assert.ok(Math.abs(await readLength(real)-1200)<150);assert.equal(await readLength(outside),null)
 assert.equal(await readLength(real),await readLength(real));ok('existing ffmpeg reads actual MP4 duration and rejects invalid output without another binary')
 // Actual status discovery must reject an output ancestor replaced while duration is pending.
 const raceVault=join(root,'scope-vault');mkdirSync(raceVault)
 const raceDir=join(raceVault,'race-talk');mkdirSync(raceDir)
 const raceSource={vault:raceVault,talkDir:raceDir,sessionId:'race'}
 const packageId='race-whole-run-one',raceFolder=join(raceDir,'video-packs',packageId),out=join(raceFolder,'out'),away=join(raceFolder,'saved-out'),external=join(root,'outside-output')
 mkdirSync(out,{recursive:true});mkdirSync(external)
 writeFileSync(join(raceFolder,'PROMPT.md'),'voice')
 writeFileSync(join(raceFolder,'stretch.json'),JSON.stringify({sessionId:'race',durationMs:1000}))
 writeFileSync(join(out,'final.mp4'),'inside');writeFileSync(join(external,'final.mp4'),'outside')
 const empty=join(out,'empty.mp4');writeFileSync(empty,'')
 assert.throws(()=>videoPackageTarget(raceSource,packageId,'empty.mp4'),/empty-video/)
 rmSync(empty)
 const swap=(target=external)=>{renameSync(out,away);symlinkSync(target,out)}
 const restore=()=>{rmSync(out);renameSync(away,out)}
 await videoPackageStatus(raceSource,async()=>{swap();return 1000}).then(state=>assert.notEqual(state.state,'ready'))
 restore();ok('output replaced by an outside link during duration probing is never ready')

 const bundled=await build({entryPoints:['src/main/video-package-status-ipc.ts'],bundle:true,write:false,format:'cjs',platform:'node',packages:'external',plugins:[{name:'electron-boundary',setup(b){b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'stub'}));b.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'exports.ipcMain={handle(){}}'}))}}]})
 const filename=join(process.cwd(),'.tw-status-ipc-fixture.cjs'),m={exports:{}}
 new Function('require','module','exports',bundled.outputFiles[0].text)(requireFrom(filename),m,m.exports)
 const {registerVideoPackageStatusIpc}=m.exports
 const sender=new EventEmitter();let destroyed=false;sender.isDestroyed=()=>destroyed;const sentStatuses=[];sender.send=(channel,states)=>{if(channel==='video-pack:status')sentStatuses.push(states)}
 const handlers=new Map(),opened=[],revealed=[]
 let statusHomeOpen=true
 let probe=async()=>1000,lookup=async()=>[{slug:'talk',outlinePath:join(raceDir,'talk-outline.md')}],active=0,started=0,failWatch=false
 const host={toolsWindow:()=>({isDestroyed:()=>false,webContents:sender}),listTalks:()=>lookup(),openVideo:async p=>{opened.push(p);return true},revealVideo:p=>revealed.push(p)}
 const packageWritten=registerVideoPackageStatusIpc(host,()=>{if(!statusHomeOpen)throw new Error('closed vault');return{vault:raceVault}},{ipc:{handle:(name,handler)=>handlers.set(name,handler)},length:file=>probe(file),watch:()=>{started++;if(failWatch&&started%2===0)throw new Error('watch setup failed');active++;return()=>active--}})
 const event={sender},input={talkSlug:'talk',sessionId:'race',packageId}
 assert.equal(await handlers.get('video-pack:play')(event,input),true)
 assert.equal(await handlers.get('video-pack:reveal')(event,input,'video'),true)
 assert.deepEqual(opened,[realpathSync(join(out,'final.mp4'))]);assert.deepEqual(revealed,[realpathSync(join(out,'final.mp4'))])
 opened.length=0;revealed.length=0
 for(const action of ['video-pack:play','video-pack:reveal']){
   probe=async()=>{swap();return 1000}
   assert.equal(await handlers.get(action)(event,input,'video'),false)
   assert.deepEqual(opened,[]);assert.deepEqual(revealed,[])
   restore()
 }
 probe=async()=>1000
 swap()
 for(const action of ['video-pack:play','video-pack:reveal'])assert.equal(await handlers.get(action)(event,input,'video'),false)
 restore()
 const foreignDir=join(raceVault,'another-talk','video-packs',packageId);mkdirSync(join(foreignDir,'out'),{recursive:true})
 writeFileSync(join(foreignDir,'out','final.mp4'),'foreign author video')
 assert.equal((await videoPackageStatus(raceSource,async()=>1000)).state,'ready')
 swap(join(foreignDir,'out'))
 for(const action of ['video-pack:play','video-pack:reveal'])assert.equal(await handlers.get(action)(event,input,'video'),false)
 restore()
 for(const packageId of [foreignDir,'../another-talk/video-packs/'+input.packageId]){
   assert.equal(await handlers.get('video-pack:play')(event,{...input,packageId}),false)
   assert.equal(await handlers.get('video-pack:reveal')(event,{...input,packageId},'package'),false)
 }
 assert.deepEqual(opened,[]);assert.deepEqual(revealed,[])
 ok('Play and Finder re-resolve package identity, refusing late symlink swaps and another talk path')

 let finishLookup
 lookup=()=>new Promise(resolve=>{finishLookup=resolve})
 const pending=handlers.get('video-pack:watch')(event,[input])
 destroyed=true;sender.emit('destroyed');finishLookup([{slug:'talk',outlinePath:join(raceDir,'talk-outline.md')}])
 assert.deepEqual(await pending,{});assert.equal(started,0);assert.equal(active,0);assert.equal(sender.listenerCount('destroyed'),0)
 ok('window closed during awaited talk lookup never starts watchers or retains its listener')
 destroyed=false;lookup=async()=>[{slug:'talk',outlinePath:join(raceDir,'talk-outline.md')},{slug:'other',outlinePath:join(root,'another-talk','outline.md')}]
 failWatch=true
 assert.deepEqual(await handlers.get('video-pack:watch')(event,[input,{...input,talkSlug:'other'}]),{})
 assert.equal(active,0);assert.equal(sender.listenerCount('destroyed'),0)
 ok('partial watcher setup failure closes watchers already installed')
 failWatch=false
 const lookups=[];lookup=()=>new Promise(resolve=>lookups.push(resolve))
 const older=handlers.get('video-pack:watch')(event,[input]),newer=handlers.get('video-pack:watch')(event,[input])
 lookups[1]([{slug:'talk',outlinePath:join(raceDir,'talk-outline.md')}]);await newer;assert.equal(active,1)
 lookups[0]([{slug:'talk',outlinePath:join(raceDir,'talk-outline.md')}]);assert.deepEqual(await older,{});assert.equal(active,1)
 handlers.get('video-pack:unwatch')(event);assert.equal(active,0);assert.equal(sender.listenerCount('destroyed'),0)
 ok('late superseded setup cannot replace the new subscription or retain watchers')
 // A completed app-owned write must be acknowledged even if the native watcher misses its event.
 lookup=async()=>[{slug:'talk',outlinePath:join(raceDir,'talk-outline.md')}]
 const notified={...input,sessionId:'notified'}
 await handlers.get('video-pack:watch')(event,[notified])
 const notifiedFolder=join(raceDir,'video-packs','notified-whole-run-complete')
 mkdirSync(join(notifiedFolder,'out'),{recursive:true})
 writeFileSync(join(notifiedFolder,'PROMPT.md'),'Complete app package')
 writeFileSync(join(notifiedFolder,'stretch.json'),JSON.stringify({sessionId:'notified',durationMs:1000,createdAt:'2026-11-10T12:00:00Z'}))
 await packageWritten()
 assert.equal(Object.values(sentStatuses.at(-1))[0].state,'waiting')
 statusHomeOpen=false;await packageWritten();assert.equal(Object.values(sentStatuses.at(-1))[0].state,'none');statusHomeOpen=true
 ok('status reconciliation rechecks the vault authority before reading a stored source')
 handlers.get('video-pack:unwatch')(event)
 const sent=sentStatuses.length;await packageWritten();assert.equal(sentStatuses.length,sent)
 ok('completed app package refreshes status without a native event; disposal prevents later sends')
 console.log(`PASS video package status: ${checks} checks`)
}finally{close();rmSync(root,{recursive:true,force:true})}

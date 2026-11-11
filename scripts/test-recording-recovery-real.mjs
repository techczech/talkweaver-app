// Recovery through the actual IPC recovery writer, with real WebM packet clocks.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import fs, { readdirSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import childProcess, { execFileSync } from 'node:child_process'
import { audibleSegmentPaths, recordedSegmentPaths, readRecordingSource } from '../src/main/recording-paths.ts'
import { recordingTranscodeArgs } from '../src/main/transcode-args.ts'
import { recordingAudioTimeline } from '../src/main/recording-audio-timeline.ts'
import { encodeVideoVoice } from '../src/main/video-package.ts'
import { createTranscription } from '../src/main/transcription.ts'
import { recordingDurationMs } from '../src/main/recording-duration.ts'
const root = mkdtempSync(resolve('.test-recovery-'))
const ffmpeg = createRequire(import.meta.url)('ffmpeg-static')
try {
  globalThis.recoveryHandlers = new Map()
  const built = await build({ entryPoints:['src/main/recording-stream-ipc.ts'], bundle:true, write:false, platform:'node', format:'esm',
    plugins:[{name:'electron', setup(b) {
      b.onResolve({filter:/^electron$/}, () => ({path:'electron',namespace:'fake'}))
      b.onLoad({filter:/.*/,namespace:'fake'}, () => ({contents:`export const app={getAppPath:()=>${JSON.stringify(process.cwd())},isPackaged:false}; export const ipcMain={handle(name,fn){globalThis.recoveryHandlers.set(name,fn)}}; export const BrowserWindow={}; export const dialog={}; export const shell={};`}))
    }}] })
  const ipc = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'))
  const store = ipc.registerRecordingStreamIpc({userDataDir:()=>root,vaultRoot:()=>null,ledger:async()=>null})
  const sid='sess-crash-real'
  const audio = join(root,'tone.webm')
  execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','sine=frequency=440:duration=0.7','-c:a','libopus',audio])
  const webm = readFileSync(audio)
  assert.equal(store.open(1,{sessionId:sid,talkSlug:'talk',talkTitle:'Talk',vaultRoot:null}).ok,true)
  assert.equal(store.startSegment(1,sid,0,0).ok,true)
  assert.equal(store.append(1,sid,0,webm).ok,true)
  store.endSegment(1,sid,0,700)
  store.checkpoint(1,sid,{recordingMs:2000})
  assert.equal(store.startSegment(1,sid,1,2000).ok,true)
  assert.equal(store.append(1,sid,1,webm).ok,true)
  store.closeOwner(1) // simulate crash before the next five-second checkpoint
  assert.equal(await ipc.recoverInterruptedRecordings(),1)
  const source=readRecordingSource(null,root,'talk',sid)
  assert.equal(source.record.audio.partial,true,'the Run says recovered/partial')
  assert.ok(source.record.recordingMs>=2700)
  const segments=await audibleSegmentPaths(root,sid,source,ffmpeg)
  assert.equal(segments.length,2)
  assert.equal(segments[1].startMs,2000)
  assert.ok(segments[1].endMs>=2700)
  const graph=recordingAudioTimeline(segments,source.record.recordingMs).filters.join(';')
  assert.match(graph,/adelay=2000:all=1/)
  const wav=join(root,'transcription.wav')
  execFileSync(ffmpeg,['-v','error',...recordingTranscodeArgs(segments,source.record.recordingMs,wav)])
  // Check actual samples: silence in the gap, audible recovered tail at its original offset.
  const pcm=execFileSync(ffmpeg,['-v','error','-i',wav,'-f','s16le','-ac','1','-ar','48000','pipe:1'])
  const energy=(samples,start,end)=>{let sum=0;for(let i=start*48;i<end*48;i++)sum+=Math.abs(samples.readInt16LE(i*2));return sum/((end-start)*48)}
  assert.ok(energy(pcm,1100,1400)<2)
  assert.ok(energy(pcm,2200,2500)>100)
  const voice=join(root,'video-voice.m4a')
  await encodeVideoVoice({ffmpeg,segments,run:source.record},[{start:0,end:source.record.recordingMs}],voice,new AbortController().signal)
  const videoPcm=execFileSync(ffmpeg,['-v','error','-i',voice,'-f','s16le','-ac','1','-ar','48000','pipe:1'])
  assert.ok(energy(videoPcm,1100,1400)<2)
  assert.ok(energy(videoPcm,2200,2500)>100)
  console.log('ok 1. crash recovery keeps the real tail, measured end, recovered flag and transcription/export clock')

  // A real WebM initialisation header: ffmpeg itself refuses it, consumers leave it out.
  const cluster=webm.indexOf(Buffer.from([0x1f,0x43,0xb6,0x75]))
  assert.ok(cluster>0)
  const header=join(root,'recordings',sid+'.seg-3.webm')
  writeFileSync(header,webm.subarray(0,cluster))
  assert.throws(()=>execFileSync(ffmpeg,['-v','error','-i',header,'-f','null','-'],{stdio:'pipe'}))
  assert.equal(await recordingDurationMs(ffmpeg,header),0)
  source.record.audio.segments.push({file:sid+'.seg-3.webm',bytes:cluster,startMs:2700,endMs:2800})
  const heard=await audibleSegmentPaths(root,sid,source,ffmpeg)
  assert.equal(heard.length,2)
  execFileSync(ffmpeg,['-v','error',...recordingTranscodeArgs(heard,source.record.recordingMs,join(root,'header-tolerated.wav'))])
  await encodeVideoVoice({ffmpeg,segments:heard,run:source.record},[{start:0,end:source.record.recordingMs}],join(root,'header-tolerated.m4a'),new AbortController().signal)
  console.log('ok 2. real header-only WebM is refused by ffmpeg, safely excluded from transcription and export')
  const longFile=join(root,'long.webm')
  execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','sine=duration=3','-c:a','libopus','-cluster_time_limit','1000',longFile])
  const full=readFileSync(longFile), id=Buffer.from([0x1f,0x43,0xb6,0x75])
  const first=full.indexOf(id), last=full.lastIndexOf(id)
  for (const [name,bytes,expected] of [
    ['complete',full,3001], ['last-cluster-cut',full.subarray(0,full.length-20),3001],
    ['inside-cluster-id',full.subarray(0,first+2),0]
  ]) {
    const file=join(root,name+'.webm');writeFileSync(file,bytes)
    assert.ok(Math.abs(await recordingDurationMs(ffmpeg,file)-expected)<30,name)
  }
  console.log('ok 3. complete, last-cluster-cut and partial Cluster ID have the expected real packet durations')

  const hung=join(root,'hung-ffmpeg.cjs')
  writeFileSync(hung,'#!/usr/bin/env node\nsetInterval(()=>{},1000)\n');chmodSync(hung,0o755)
  const bad=join(root,'bad-ffmpeg.cjs')
  writeFileSync(bad,'#!/usr/bin/env node\nconsole.log("out_time_us=99999999999999999999")\n');chmodSync(bad,0o755)
  const negative=join(root,'negative-ffmpeg.cjs')
  writeFileSync(negative,'#!/usr/bin/env node\nconsole.log("out_time_us=-9223372036854775807")\n');chmodSync(negative,0o755)
  for (const [name,configured,bytes,checkpoint] of [
    ['first-cluster-cut',ffmpeg,full.subarray(0,first+8),2000],
    ['missing',join(root,'missing'),webm,2500], ['timeout',hung,webm,2500],
    ['absurd',bad,webm,2500], ['negative',negative,webm,2500], ['short-reading',ffmpeg,webm,3500]
  ]) {
    const sid='sess-'+name
    const store=ipc.registerRecordingStreamIpc({userDataDir:()=>root,vaultRoot:()=>null,ledger:async()=>null,configuredFfmpeg:()=>configured,durationTimeoutMs:150})
    store.open(2,{sessionId:sid,talkSlug:'talk',talkTitle:'Talk',vaultRoot:null})
    store.startSegment(2,sid,0,0);store.append(2,sid,0,webm);store.endSegment(2,sid,0,700)
    store.startSegment(2,sid,1,2000);store.append(2,sid,1,bytes)
    store.checkpoint(2,sid,{recordingMs:checkpoint});store.closeOwner(2)
    assert.equal(await ipc.recoverInterruptedRecordings(),1,name)
    const source=readRecordingSource(null,root,'talk',sid)
    assert.equal(source.record.audio.partial,true)
    assert.equal(source.record.audio.segments[0].endMs,700)
    assert.equal(source.record.audio.segments[1].endMs,checkpoint,'failed or short measurements keep the exact checkpoint')
    assert.deepEqual(readFileSync(join(root,'recordings',source.record.audio.segments[0].file)),webm,'earlier audio bytes are intact')
    if(name!=='short-reading')assert.match(source.record.audio.recoveryNote,/could not be measured/)
    else assert.equal(source.record.audio.recoveryNote,undefined,'short real reading succeeded but did not shorten the checkpoint')
    assert.equal(store.listInterrupted().length,0,'marker completed')
    const fallback=await audibleSegmentPaths(root,sid,source,join(root,'missing'))
    assert.equal(fallback.length,checkpoint===2000?1:2,'failed optional probes retain positive spans and omit zero spans')
    if(name==='first-cluster-cut'){
      const heard=await audibleSegmentPaths(root,sid,source,ffmpeg)
      assert.equal(heard.length,1)
      execFileSync(ffmpeg,['-v','error',...recordingTranscodeArgs(heard,source.record.recordingMs,join(root,'cut.wav'))])
      await encodeVideoVoice({ffmpeg,segments:heard,run:source.record},[{start:0,end:source.record.recordingMs}],join(root,'cut.m4a'),new AbortController().signal)
      // An old transcript must not consult readiness or spawn even a configured sentinel.
      const target=join(root,'recordings',sid+'.transcript.json')
      writeFileSync(target,JSON.stringify({segments:[{start:0,end:500,text:'Saved words'}],words:[]}))
      const tx=createTranscription({userDataDir:()=>root,vaultRoot:()=>null,readiness:()=>{throw Error('get must not ask for ffmpeg')},config:()=>{throw Error('no config needed')}})
      const realExec=childProcess.execFile
      let probes=0
      childProcess.execFile=(...args)=>{probes++;return realExec(...args)}
      syncBuiltinESMExports()
      try {
        const transcript=await tx.get('talk',sid)
        assert.equal(transcript.segments[0].text,'Saved words')
        assert.equal(probes,0,'old-clock transcript reads spawn no ffmpeg')
      } finally {childProcess.execFile=realExec;syncBuiltinESMExports()}
    }
    console.log('ok recovery '+name+' preserves Run, prior segment, checkpoint and completes marker')
  }
  const blocked=ipc.registerRecordingStreamIpc({userDataDir:()=>root,vaultRoot:()=>null,ledger:async()=>null})
  blocked.open(3,{sessionId:'sess-blocked',talkSlug:'talk',talkTitle:'Talk',vaultRoot:null})
  blocked.startSegment(3,'sess-blocked',0,0);blocked.append(3,'sess-blocked',0,webm);blocked.closeOwner(3)
  writeFileSync(join(root,'recordings','sess-blocked.json'),'occupied by another file')
  assert.equal(await ipc.recoverInterruptedRecordings(),0)
  assert.equal(ipc.listRecordingRecovery()[0].status,'needs-attention')
  assert.match(ipc.listRecordingRecovery()[0].message,/could not be safely completed/)
  console.log('ok 10. unrecoverable Run conflict surfaces as a stated recovery problem')
  // Repair of a middle zero span cannot overlap its successor or exceed the Run.
  source.record.audio.segments=[{file:sid+'.webm',bytes:webm.length,startMs:0,endMs:700},{file:sid+'.seg-2.webm',bytes:webm.length,startMs:2000,endMs:2000},{file:sid+'.seg-2.webm',bytes:webm.length,startMs:2200,endMs:2700}]
  const capped=await audibleSegmentPaths(root,sid,source,ffmpeg)
  assert.equal(capped[1].endMs,2200)
  source.record.audio.partial=false
  source.record.recordingMs=2100
  assert.equal((await audibleSegmentPaths(root,sid,source,ffmpeg))[1].endMs,2100)
  console.log('ok 11. repaired middle segment is capped at successor and Run end')

  // Legacy Runs have no segment list: main keeps their original 0–0 spans and concatenates.
  const legacyId='sess-legacy'
  const secondTone=join(root,'second-tone.webm')
  execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','sine=frequency=880:duration=0.7','-c:a','libopus',secondTone])
  writeFileSync(join(root,'recordings',legacyId+'.webm'),webm)
  writeFileSync(join(root,'recordings',legacyId+'.seg-2.webm'),readFileSync(secondTone))
  const legacySource={kind:'run',record:{...source.record,id:legacyId,recordingMs:1400,audio:{...source.record.audio,segments:undefined}}}
  const mainSegments=recordedSegmentPaths(root,legacyId,legacySource)
  assert.equal(mainSegments.length,2)
  assert.deepEqual(mainSegments.map(s=>[s.startMs,s.endMs]),[[0,0],[0,0]])
  const legacyHeard=await audibleSegmentPaths(root,legacyId,legacySource,ffmpeg)
  assert.deepEqual(legacyHeard.map(({path,startMs,endMs})=>({path,startMs,endMs})),mainSegments,'same files and untouched spans as main')
  const legacyWav=join(root,'legacy.wav'),legacyVoice=join(root,'legacy.m4a')
  execFileSync(ffmpeg,['-v','error',...recordingTranscodeArgs(legacyHeard,1400,legacyWav)])
  await encodeVideoVoice({ffmpeg,segments:legacyHeard,run:legacySource.record},[{start:0,end:1400}],legacyVoice,new AbortController().signal)
  // Count zero crossings in decoded sound to distinguish the two tones and their order.
  for(const file of [legacyWav,legacyVoice]){
    const pcm=execFileSync(ffmpeg,['-v','error','-i',file,'-f','s16le','-ac','1','-ar','48000','pipe:1'])
    const hz=(start,end)=>{let crossings=0;for(let i=start*48+1;i<end*48;i++)if(pcm.readInt16LE((i-1)*2)<=0&&pcm.readInt16LE(i*2)>0)crossings++;return crossings*1000/(end-start)}
    assert.ok(energy(pcm,100,500)>100)
    assert.ok(energy(pcm,800,1200)>100)
    assert.ok(Math.abs(hz(100,500)-440)<10)
    assert.ok(Math.abs(hz(800,1200)-880)<10)
  }
  console.log('ok 12. legacy Run retains both original spans and both tones in order in transcription and export')

  const partialId='sess-partial-tail'
  const tail=join(root,'recordings',partialId+'.seg-2.webm')
  execFileSync(ffmpeg,['-v','error','-f','lavfi','-i','sine=duration=1.5','-c:a','libopus',tail])
  writeFileSync(join(root,'recordings',partialId+'.webm'),readFileSync(tail))
  const partialSource={kind:'run',record:{...source.record,id:partialId,recordingMs:2000,audio:{partial:true,segments:[{file:partialId+'.webm',startMs:0,endMs:1500},{file:partialId+'.seg-2.webm',startMs:2000,endMs:2000}]}}}
  const repaired=await audibleSegmentPaths(root,partialId,partialSource,ffmpeg)
  assert.equal(repaired.length,2)
  assert.ok(Math.abs(repaired[1].endMs-(2000+Math.ceil(await recordingDurationMs(ffmpeg,tail))))<1)
  const partialWav=join(root,'partial.wav')
  execFileSync(ffmpeg,['-v','error',...recordingTranscodeArgs(repaired,2000,partialWav)])
  const partialPcm=execFileSync(ffmpeg,['-v','error','-i',partialWav,'-f','s16le','-ac','1','-ar','48000','pipe:1'])
  assert.ok(energy(partialPcm,1700,1900)<2)
  assert.ok(energy(partialPcm,2200,3400)>100)
  console.log('ok 13. partial Run repairs 2000–2000 tail beyond checkpoint total and transcodes its sound')

  const recoveryOrder=[]
  const throwing=ipc.registerRecordingStreamIpc({userDataDir:()=>root,vaultRoot:()=>null,ledger:async()=>null,onSessionSaved:({runId})=>recoveryOrder.push(runId)})
  for(const id of ['sess-throw','sess-z-after-throw']){
    throwing.open(4,{sessionId:id,talkSlug:'talk',talkTitle:'Talk',vaultRoot:null})
    throwing.startSegment(4,id,0,0);throwing.append(4,id,0,webm);throwing.endSegment(4,id,0,700);throwing.closeOwner(4)
  }
  const preserved=readdirSync(join(root,'recordings')).filter(f=>f.startsWith('sess-throw')).map(f=>[f,readFileSync(join(root,'recordings',f))])
  const realWrite=fs.writeFileSync
  let failures=0
  fs.writeFileSync=(path,...args)=>{
    if(String(path).includes('sess-throw.json.')){failures++;recoveryOrder.push('failed');throw Object.assign(Error('injected Run write failure'),{code:'EACCES',stack:'Error: injected Run write failure'})}
    return realWrite(path,...args)
  }
  syncBuiltinESMExports()
  try {assert.equal(await ipc.recoverInterruptedRecordings(),1)}
  finally {fs.writeFileSync=realWrite;syncBuiltinESMExports()}
  assert.equal(failures,1,'recovery genuinely attempted and failed the Run write')
  assert.deepEqual(recoveryOrder,['failed','sess-z-after-throw'],'the recovery pass continues after the exception')
  assert.ok(readRecordingSource(null,root,'talk','sess-z-after-throw'))
  assert.ok(throwing.listInterrupted().some(s=>s.manifest.sessionId==='sess-throw'),'failed marker remains')
  for(const [file,bytes] of preserved)assert.deepEqual(readFileSync(join(root,'recordings',file)),bytes,'nothing deleted or changed')
  // With the write failure removed, only recoveryProblems can still mark this safe path blocked.
  const problem=ipc.listRecordingRecovery().find(s=>s.sessionId==='sess-throw')
  assert.equal(problem.status,'needs-attention')
  assert.deepEqual(globalThis.recoveryHandlers.get('recording:list-recovery')().find(s=>s.sessionId==='sess-throw'),problem)
  console.log('ok 14. thrown Run write is remembered through IPC, preserves audio/marker and does not stop the recovery pass')

} finally { delete globalThis.recoveryHandlers; rmSync(root,{recursive:true,force:true}) }

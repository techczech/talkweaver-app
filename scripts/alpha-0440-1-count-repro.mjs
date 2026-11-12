// Tiny filesystem-only root-cause probe; no Electron, speech engine or model inference.
import assert from 'node:assert/strict'
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { transcribeSavedRun,savedTranscriptionStatus } from '../src/main/transcription.ts'
const root=mkdtempSync(join(process.cwd(),'.alpha-count-repro-'))
try {
 const vault=join(root,'vault'),data=join(root,'data'),slug='fixture',sid='count-repro-run',runs=join(vault,'_PRESENTATIONS',slug)
 mkdirSync(runs,{recursive:true});mkdirSync(join(data,'recordings'),{recursive:true})
 const run={id:sid,talkSlug:slug,kind:'recording',recordingMs:120000,audio:{segments:[{file:sid+'.webm',startMs:0,endMs:120000}]}}
 writeFileSync(join(runs,sid+'.json'),JSON.stringify(run));writeFileSync(join(data,'recordings',sid+'.webm'),'fixture audio')
 const before=readdirSync(runs),savedRun=readFileSync(join(runs,sid+'.json'),'utf8')
 const deps={userDataDir:()=>data,vaultRoot:()=>vault,config:()=>({python:'',script:''}),readiness:()=>({}),nativeAvailable:async()=>true,testMode:()=>true}
 await transcribeSavedRun(deps,slug,sid,()=>{})
 assert.equal(savedTranscriptionStatus(deps,slug,sid).state,'ready')
 const after=readdirSync(runs).sort(),added=after.filter(f=>!before.includes(f))
 assert.deepEqual(added,[sid+'.transcript.json',sid+'.transcript.json.attempt.json'])
 assert.equal(readFileSync(join(runs,sid+'.json'),'utf8'),savedRun)
 console.log(JSON.stringify({result:'PASS',before,after,added,runMetadataUnchanged:true,conclusion:'Automatic words add two legitimate non-Run JSON files; raw directory count is not a Run count.'},null,2))
} finally {rmSync(root,{recursive:true,force:true})}

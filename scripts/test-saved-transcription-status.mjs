import assert from 'node:assert/strict'
import { transcribeSavedRun, savedTranscriptionStatus } from '../src/main/transcription.ts'
const deps={userDataDir:()=>'/unused',vaultRoot:()=>null,config:()=>({python:'',script:''}),readiness:()=>({}),nativeAvailable:async()=>false}
await transcribeSavedRun(deps,'fixture','fixture-run',()=>assert.fail('unavailable automatic run must stay silent'))
assert.equal(savedTranscriptionStatus(deps,'fixture','fixture-run').state,'unavailable')
console.log('PASS saved status retains unavailable without starting a model')
const {registerTranscriptionIpc}=await import('../src/main/transcription.ts')
const handlers=new Map()
registerTranscriptionIpc({handle:(channel,handler)=>handlers.set(channel,handler)},{...deps,savedRunDeps:id=>id===7?deps:null})
const event=id=>({sender:{id,isDestroyed:()=>false,send:()=>assert.fail('refused caller must not start words')}})
assert.equal(handlers.get('transcript:saved-status')(event(7),'fixture','fixture-run').state,'unavailable')
assert.equal(handlers.get('transcript:saved-status')(event(8),'fixture','fixture-run').state,'failed')
await handlers.get('transcript:retry-saved')(event(8),'fixture','fixture-run')
console.log('PASS saved status and Retry use the saving presenter home; another window is refused')

assert.equal(savedTranscriptionStatus(deps,'fixture','silent-run').state,'none')
console.log('PASS a silent Run never shows endless transcription progress')

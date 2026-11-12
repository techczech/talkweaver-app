import { verifiedModelBytes } from './alignment-model-bytes'
import * as ort from 'onnxruntime-node'
import { inferAlignment } from './alignment-inference'
import type { Alphabet } from '../shared/word-alignment'
// Main owns this port; no renderer channel accepts model/PCM paths. Each worker checks the
// exact pinned model bytes. Cancellation kills the process, including synchronous native work.
const port = (process as unknown as { parentPort?: { on(event: string, listener: (event: { data: unknown }) => void): void; postMessage(value: unknown): void } }).parentPort
let modelIdentity: string | undefined
let session: ort.InferenceSession | undefined, busy = false
port?.on('message', async ({ data }) => {
  if (busy) { port.postMessage({ error:'Alignment worker busy' }); return }
  busy = true
  try {
    const m = data as { model?: string; sha256?:string;bytes?:number;threads?:number; pcm?: Float32Array; words?: string[]; alphabet?: Alphabet }
    if (typeof m.model !== 'string' || typeof m.sha256!=='string' || !/^[a-f0-9]{64}$/.test(m.sha256) || typeof m.bytes!=='number' || !Number.isSafeInteger(m.bytes) || m.bytes<1 || m.bytes>2_000_000_000 || m.threads!==undefined && ![2,4].includes(m.threads) || !(m.pcm instanceof Float32Array) || !Array.isArray(m.words) || !m.words.every(w => typeof w === 'string' && w.length <= 1000) || !m.alphabet) throw Error('Invalid alignment request')
    if (modelIdentity && modelIdentity !== JSON.stringify([m.model,m.sha256,m.bytes,m.threads??2])) throw Error('Model changed in alignment worker')
    modelIdentity = JSON.stringify([m.model,m.sha256,m.bytes,m.threads??2])
    let modelLoadSeconds=0
    if(!session){
      const started=performance.now()
      const modelBytes=verifiedModelBytes(m.model,m.sha256,m.bytes)
      // ORT receives the exact verified bytes, never a pathname it would reopen after checking.
      session=await ort.InferenceSession.create(modelBytes, { executionProviders:['cpu'], intraOpNumThreads:m.threads??2, interOpNumThreads:1 })
      modelLoadSeconds=(performance.now()-started)/1000
    }
    const started=performance.now(),words=await inferAlignment(session,m.pcm,m.words,m.alphabet)
    // Main ignores these local numeric diagnostics; qualification records the actual utility's
    // native/CTC time and RSS rather than attributing a host Node process's memory to Electron.
    port?.postMessage({words,metrics:{modelLoadSeconds,inferenceSeconds:(performance.now()-started)/1000,peakRSSBytes:process.resourceUsage().maxRSS*1024}})
  } catch { port?.postMessage({ error:'Word alignment failed; transcript kept' }) }
  finally { busy = false }
})

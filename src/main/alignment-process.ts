import type { EventEmitter } from 'node:events'
import type { Alphabet } from '../shared/word-alignment.ts'
import type { WordAlignment } from '../shared/transcript-contract.ts'
// Recorded Czech utility peak: 1,441,202,176 bytes. Native ORT allocations are outside
// V8's heap limit, so main samples the actual process working set and kills on excess.
export const ALIGNMENT_MEMORY_LIMIT_BYTES = 4 * 1024 ** 3
export type AlignmentChild = EventEmitter & {postMessage(value:unknown):void;kill():boolean}
export function createAlignmentProcess(child:AlignmentChild,signal:AbortSignal,identity:{sha256:string;bytes:number;threads?:number},memoryBytes:()=>number,pollMs=250){
  let stopped:Error|undefined,pending:((error:Error)=>void)|undefined
  const stop=(error=Error('Alignment process stopped')):void=>{
    if(stopped)return
    stopped=error;clearInterval(watch);pending?.(error);child.kill()
  }
  const exit=():void=>{if(!stopped){stopped=Error(signal.aborted?'cancelled':'Alignment process stopped');clearInterval(watch);pending?.(stopped)}}
  const abort=():void=>stop(Error('cancelled'))
  const check=():void=>{
    if(!stopped)try{if(memoryBytes()>ALIGNMENT_MEMORY_LIMIT_BYTES)stop(Error('Alignment exceeded its memory limit; earlier timings were kept.'))}catch{stop(Error('Alignment memory could not be checked; earlier timings were kept.'))}
    if(stopped)throw stopped
  }
  const watch=setInterval(()=>{try{check()}catch{/* stop already rejected any in-flight job */}},pollMs)
  child.on('exit',exit);signal.addEventListener('abort',abort,{once:true})
  if(signal.aborted)abort()
  return{
    check,
    infer(pcm:Float32Array,words:string[],alphabet:Alphabet):Promise<WordAlignment[]>{
      return new Promise((resolve,reject)=>{
        if(stopped || signal.aborted){reject(stopped??Error('cancelled'));return}
        if(pending){reject(Error('Alignment worker busy'));return}
        const cleanup=():void=>{clearTimeout(timer);child.removeListener('message',message);pending=undefined}
        const finish=(error?:Error,result?:WordAlignment[]):void=>{cleanup();if(error)reject(error);else resolve(result!)}
        const message=(data:{words?:WordAlignment[];error?:string;metrics?:{peakRSSBytes?:number}}):void=>{
          if(typeof data.metrics?.peakRSSBytes==='number' && data.metrics.peakRSSBytes>ALIGNMENT_MEMORY_LIMIT_BYTES){stop(Error('Alignment exceeded its memory limit; earlier timings were kept.'));return}
          finish(data.error || !Array.isArray(data.words)?Error(data.error??'Invalid alignment result'):undefined,data.words)
        }
        const timer=setTimeout(()=>stop(Error('Alignment timed out')),120000)
        pending=error=>finish(error);child.once('message',message)
        try{child.postMessage({...identity,pcm,words,alphabet})}catch{stop(Error('Alignment process stopped'))}
      })
    },
    close():void{signal.removeEventListener('abort',abort);stop();clearInterval(watch);child.removeListener('exit',exit)}
  }
}

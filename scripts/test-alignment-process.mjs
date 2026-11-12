import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createAlignmentProcess, ALIGNMENT_MEMORY_LIMIT_BYTES } from '../src/main/alignment-process.ts'
let checks=0
const check=async(name,fn)=>{await fn();console.log(`ok ${++checks} ${name}`)}
const alphabet={vocab:{A:1,'|':2},blank:0,delimiter:'|',uppercase:true}
function fixture(){
 const child=new EventEmitter();let killed=0,memory=0
 child.postMessage=()=>{};child.kill=()=>{killed++;queueMicrotask(()=>child.emit('exit',1));return true}
 const signal=new AbortController()
 return{child,signal,killed:()=>killed,setMemory:n=>{memory=n},make:()=>createAlignmentProcess(child,signal.signal,{sha256:'a'.repeat(64),bytes:10},()=>memory,5)}
}
await check('native RSS ceiling kills the utility and rejects in-flight inference',async()=>{
 assert.ok(ALIGNMENT_MEMORY_LIMIT_BYTES>1_441_202_176*2)
 const f=fixture(),worker=f.make(),run=worker.infer(new Float32Array(1),['A'],alphabet)
 f.setMemory(ALIGNMENT_MEMORY_LIMIT_BYTES+1)
 await assert.rejects(run,/memory limit/);assert.equal(f.killed(),1);worker.close()
})
await check('abort settles an in-flight request; late replies cannot succeed',async()=>{
 const f=fixture(),worker=f.make(),run=worker.infer(new Float32Array(1),['A'],alphabet)
 f.signal.abort();f.child.emit('message',{words:[]});await assert.rejects(run,/cancelled/);assert.equal(f.killed(),1);worker.close()
})
await check('exit between chunks fails immediately rather than waiting for timeout',async()=>{
 const f=fixture(),worker=f.make();f.child.emit('exit',1)
 await assert.rejects(worker.infer(new Float32Array(1),['A'],alphabet),/stopped/);worker.close()
})
await check('successful reply and close release all job listeners',async()=>{
 const f=fixture(),worker=f.make(),run=worker.infer(new Float32Array(1),['A'],alphabet)
 f.child.emit('message',{words:[{status:'unplaced'}]});assert.equal((await run).length,1)
 worker.close();assert.equal(f.child.listenerCount('message'),0);assert.equal(f.child.listenerCount('exit'),0)
})
await check('memory failure after the last reply remains visible to the publication guard',async()=>{
 const f=fixture(),worker=f.make(),run=worker.infer(new Float32Array(1),['A'],alphabet)
 f.child.emit('message',{words:[]});await run
 f.setMemory(ALIGNMENT_MEMORY_LIMIT_BYTES+1);await new Promise(r=>setTimeout(r,15))
 assert.throws(()=>worker.check(),/memory limit/);worker.close()
})
await check('a reported native peak above the ceiling fails even after current RSS falls',async()=>{
 const f=fixture(),worker=f.make(),run=worker.infer(new Float32Array(1),['A'],alphabet)
 f.child.emit('message',{words:[],metrics:{peakRSSBytes:ALIGNMENT_MEMORY_LIMIT_BYTES+1}})
 await assert.rejects(run,/memory limit/);assert.equal(f.killed(),1);worker.close()
})
console.log(`${checks} alignment process checks passed`)

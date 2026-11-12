import { join } from 'node:path'
import { app } from 'electron'
import { forkUtilityChild } from './prepare-talk-utility-process'
import { createAlignmentProcess } from './alignment-process'
export function alignmentUtility(model:string,signal:AbortSignal,identity:{sha256:string;bytes:number;threads?:number}){
  const child=forkUtilityChild(join(__dirname,'alignment-worker.js'),'TalkWeaver precise word timing',undefined,{...process.env,ORT_DISABLE_TELEMETRY:'1'})
  const transport={...identity,model}
  return createAlignmentProcess(child,signal,transport,()=>{
    const metric=app.getAppMetrics().find(m=>m.pid===child.pid)
    return metric ? Math.max(metric.memory.workingSetSize,metric.memory.peakWorkingSetSize??0)*1024 : 0
  })
}

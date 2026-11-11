// Serial, shared-slot validation; logs stay with this PR's evidence.
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const scripts = ['recording-empty-segments','microphone-choice','run-audio','recording-permissions','recording-stream','recording-paths','present-audio-loss','recording-recovery-real','transcription-words','transcription-words-assembly'].map(n=>'test:'+n).concat(['typecheck','build'])
let failed=0
for(const script of scripts){
  const result=spawnSync('npm',['run',script],{encoding:'utf8',maxBuffer:32*1024*1024})
  writeFileSync(`docs/design/microphone-choice/built/review-fixes-round-2/${script.replace('test:','')}.log`,(result.stdout??'')+(result.stderr??''))
  console.log(`${script}: exit ${result.status}`)
  if(result.status!==0)failed++
}
process.exitCode=failed?1:0

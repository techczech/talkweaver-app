import {readFileSync,writeFileSync} from 'node:fs'
const dir='docs/design/2026-11-10-record-and-edit-video/built/slice-2/continuous-speech'
const read=n=>JSON.parse(readFileSync(`${dir}/${n}`))
const old=read('measurement-summary.json'),next=read('measurement-summary-relative.json')
const regressions=[]
for(const set of ['librispeech-en','parlaspeech-cs','all'])for(const kind of ['trimmed','snapped']) {
 for(const edge of ['start','end'])for(const stat of ['median','p90','p95','max']) {
  const before=old.sets[set].errors[kind][edge][stat],after=next.sets[set].errors[kind][edge][stat]
  if(after>before+1e-6)regressions.push({set,kind,edge,stat,before,after})
 }
 for(const split of ['all','pause','continuous'])for(const stat of ['over30','over80']) {
  const before=old.sets[set].clipping[kind][split][stat],after=next.sets[set].clipping[kind][split][stat]
  if(after>before)regressions.push({set,kind,split,stat,before,after})
 }
}
writeFileSync(`${dir}/relative-comparison.json`,JSON.stringify({regressions,result:regressions.length?'FAIL':'PASS'},null,2)+'\n')
console.log(JSON.stringify(regressions,null,2));if(regressions.length)process.exitCode=1

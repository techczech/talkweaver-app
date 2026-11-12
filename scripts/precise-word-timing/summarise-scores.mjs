/** Primary scorer stays unchanged. Use its returned errors at exact shared midpoints;
 * retain the ORIGINAL scorer/silence rule everywhere else. Keep the denominator explicit. */
import { readFileSync,writeFileSync } from 'node:fs'
import { resolve,join } from 'node:path'
const relative='docs/design/2026-11-10-record-and-edit-video/built/slice-2/continuous-speech',base=resolve(relative),local=resolve('scripts/precise-word-timing/local'),output=resolve('docs/design/2026-11-10-record-and-edit-video/built/slice-2b')
const prefix=process.argv[2]??'';if(!['','fp32-'].includes(prefix))throw Error('Unknown measurement variant')
const rows=p=>readFileSync(p,'utf8').trim().split('\n').map(JSON.parse),baseline=rows(join(base,'measurement-rows.jsonl')),actual=rows(join(local,prefix+'both-scores',relative,'measurement-rows.jsonl'))
const key=r=>`${r.id}:${r.left}:${r.right}`,boundaries=new Map(actual.filter(r=>r.type==='boundary').map(r=>[`${key(r)}:${r.kind}`,r]))
const placements=new Map(JSON.parse(readFileSync(join(local,prefix+'both-placements.json'),'utf8')).map(p=>[p.id,p]))
const correspondence=new Map(baseline.filter(r=>r.type==='word'&&r.kind==='returned').map(r=>[`${r.id}:${r.referenceWord}`,r.returnedWord]))
const references=new Map(['english','czech'].flatMap(l=>JSON.parse(readFileSync(join(base,`reference-${l}.json`),'utf8'))).map(r=>[r.id,r]))
function errors(values){const a=values.map(Math.abs).sort((a,b)=>a-b),q=p=>a[Math.max(0,Math.ceil(p*a.length)-1)]??null;return{n:a.length,p50:q(.5),p90:q(.9),p95:q(.95),max:q(1)}}
function stats(scored){
 const r={pairs:scored.length}
 for(const threshold of [30,80]){
  r[`clipOver${threshold}`]=scored.filter(row=>row.clip>threshold+1e-6).length
  r[`remnantOver${threshold}`]=scored.filter(row=>Math.max(0,-row.endError,row.startError)>threshold+1e-6).length
  for(const kind of ['clip','remnant'])r[`${kind}Over${threshold}Percent`]=100*r[`${kind}Over${threshold}`]/scored.length
 }
 return r
}
const result={definition:'Unchanged scorer and frozen baseline continuous-speech pair labels. Exact confident shared midpoints use returned rows (no second silence snap). Other edges retain original baseline snapped times. Missing mappings are reported, never counted safe. Remnant=max(0,-endError,startError), a reference estimate, not a listening judgement.',languages:{}}
for(const [language,set] of [['English','librispeech-en'],['Czech','parlaspeech-cs']]){
 const wanted=baseline.filter(r=>r.type==='boundary' && r.kind==='snapped' && r.set===set && !r.pause)
 const confident=wanted.filter(row=>typeof placements.get(row.id)?.midpoints[correspondence.get(`${row.id}:${row.left}`)]==='number')
 const confidentKeys=new Set(confident.map(key)),exact=confident.map(row=>boundaries.get(`${key(row)}:returned`)).filter(Boolean)
 for(const row of exact){const midpoint=placements.get(row.id).midpoints[correspondence.get(`${row.id}:${row.left}`)];if(Math.abs(row.cutStart-midpoint)>1e-6 || Math.abs(row.cutEnd-midpoint)>1e-6)throw Error('Scored point is not the stored shared midpoint')}
 const complete=wanted.map(row=>confidentKeys.has(key(row))?boundaries.get(`${key(row)}:returned`):row).filter(Boolean)
 const spanErrors=baseline.filter(r=>r.type==='word' && r.kind==='returned' && r.set===set).flatMap(row=>{const p=placements.get(row.id)?.placements[row.returnedWord],ref=references.get(row.id).reference[row.referenceWord];return p?[{start:p.start-ref.start,end:p.end-ref.end}]:[]})
 result.languages[language]={baselinePairs:wanted.length,matchedPairs:complete.length,missing:wanted.length-complete.length,fallbackPairs:wanted.length-confident.length,confidentAligned:{...stats(exact),baselineCoveragePercent:100*exact.length/wanted.length},includingOriginalFallback:stats(complete),alignedSpanErrors:{start:errors(spanErrors.map(r=>r.start)),end:errors(spanErrors.map(r=>r.end))},subsequentScorerSnapOnAligned:stats(confident.map(row=>boundaries.get(`${key(row)}:snapped`)).filter(Boolean))}
}
result.originalScorerSummary=JSON.parse(readFileSync(join(local,prefix+'both-scores',relative,'measurement-summary.json'),'utf8'))
result.runtime=JSON.parse(readFileSync(join(local,prefix+'both-runtime.json'),'utf8'))
writeFileSync(join(output,prefix+'shipping-candidate-measurements.json'),JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify(result.languages,null,2))

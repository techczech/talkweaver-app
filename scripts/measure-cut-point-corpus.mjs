// Offline metrics: exact-token monotone alignment, not linguistic correctness judgement.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync,writeFileSync} from 'node:fs'
import {trimWords,snapToSilence,mapSentences,cutEdge} from '../src/shared/transcript-contract.ts'
const dir='docs/design/2026-11-10-record-and-edit-video/built/slice-2/continuous-speech'
const read=n=>JSON.parse(readFileSync(`${dir}/${n}`,'utf8'))
const norm=s=>s.toLocaleLowerCase().normalize('NFC').replaceAll('’',"'").replace(/[^\p{L}\p{N}']/gu,'')
function match(a,b){
 const d=Array.from({length:a.length+1},()=>new Uint16Array(b.length+1))
 for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)d[i][j]=a[i]&&a[i]===b[j]?1+d[i+1][j+1]:Math.max(d[i+1][j],d[i][j+1])
 const pairs=[];let i=0,j=0
 while(i<a.length&&j<b.length){if(a[i]&&a[i]===b[j]){pairs.push([i++,j++])}else if(d[i+1][j]>=d[i][j+1])i++;else j++}
 return pairs
}
// Word deletion semantics: the selected right word's start can remove the kept
// left tail, and the selected left word's end can remove the kept right onset.
function keptNeighbourLoss(cutStart,cutEnd,leftEnd,rightStart){
 const startClip=Math.max(0,leftEnd-cutStart),endClip=Math.max(0,cutEnd-rightStart)
 return {startClip,endClip,clip:Math.max(startClip,endClip)}
}
assert.deepEqual(keptNeighbourLoss(19,100,100,100),{startClip:81,endClip:0,clip:81})
assert.deepEqual(keptNeighbourLoss(100,181,100,100),{startClip:0,endClip:81,clip:81})
assert.deepEqual(keptNeighbourLoss(70,130,100,100),{startClip:30,endClip:30,clip:30})
assert.deepEqual(keptNeighbourLoss(130,70,100,100),{startClip:0,endClip:0,clip:0})
function stats(a){a=a.map(Math.abs).sort((a,b)=>a-b);const q=p=>a.length?a[Math.max(0,Math.ceil(p*a.length)-1)]:null;return {n:a.length,median:q(.5),p90:q(.9),p95:q(.95),max:q(1)}}
const variant=process.argv[2]??'baseline'
if(!['baseline','minimum-60ms','containing-only','radius-300ms'].includes(variant))throw Error('unknown exploratory variant')
const sentenceExceptions=read('reference-sentence-exceptions.json').records
const rows=[],details=[],qualityRows=[],coverageRows=[]
const thresholds=[[150,60],[200,80],[250,100],[300,120],[400,150],[500,200],[600,250],[800,300],[1000,400]]
for(const name of ['english','czech'])for(const ref of read(`reference-${name}.json`)){
 const baseline=read(ref.id+'-native.json')
 const raw=process.argv.includes('--relative')?read(ref.id+'-relative.json'):baseline,returned=raw.words.map(w=>({text:w.text,start:w.startMs,end:w.endMs})),trimmed=trimWords(returned,raw.silence)
 const labelTrimmed=trimWords(returned,baseline.silence)
 const snapSilence=variant==='minimum-60ms'?raw.silence.filter(s=>s.end-s.start>=60-1e-6):raw.silence
 const snap=boundary=>variant==='baseline'?snapToSilence(boundary,snapSilence):snapToSilence(boundary,snapSilence,boundary,variant==='containing-only'?0:300)
 const snapped=trimmed.map(w=>({...w,start:snap(w.start),end:snap(w.end)}))
 for(let j=0;j<trimmed.length-1;j++)for(const [silenceMs,keptMs] of thresholds) {
  const bounds={lower:trimmed[j].end,upper:Math.max(trimmed[j].end,trimmed[j+1].start)}
  const start=cutEdge(trimmed[j+1].start,'start',raw.silence,bounds,{silenceMs,keptMs}),end=cutEdge(trimmed[j].end,'end',raw.silence,bounds,{silenceMs,keptMs})
  coverageRows.push({set:ref.set,silenceMs,keptMs,cleanEdges:Number(start.quality==='clean')+Number(end.quality==='clean'),cleanBoundary:start.quality==='clean'||end.quality==='clean'})
 }
 const reference=ref.reference,pairs=match(reference.map(w=>norm(w.text)),returned.map(w=>norm(w.text)))
 const map=new Map(pairs),rmap=new Map(pairs.map(([i,j])=>[j,i]));const times={returned,trimmed,snapped}
 for(const [i,j]of pairs)for(const [kind,ws]of Object.entries(times))rows.push({set:ref.set,speaker:ref.speaker,id:ref.id,type:'word',kind,referenceWord:i,returnedWord:j,start:ws[j].start-reference[i].start,end:ws[j].end-reference[i].end})
 const boundaries=[]
 for(let i=0;i<reference.length-1;i++){
  const j=map.get(i),k=map.get(i+1);if(j===undefined||k!==j+1)continue
  // Operational pause label: the acoustic pass exposes >=20ms quiet inside the
  // returned inter-word window (allowing trimmed endpoints). No reference oracle.
  const pause=baseline.silence.some(s=>Math.min(s.end,labelTrimmed[k].start)-Math.max(s.start,labelTrimmed[j].end)>=20-1e-6)
  const b={id:ref.id,set:ref.set,speaker:ref.speaker,left:i,right:i+1,pause,referenceGapMs:reference[i+1].start-reference[i].end}
  for(const [kind,ws]of Object.entries(times)){
   // Delete right: its start must not remove left's tail. Delete left: its end must not remove right's onset.
   const {startClip,endClip,clip}=keptNeighbourLoss(ws[k].start,ws[j].end,reference[i].end,reference[i+1].start)
   rows.push({...b,type:'boundary',kind,cutStart:ws[k].start,cutEnd:ws[j].end,referenceLeftEnd:reference[i].end,referenceRightStart:reference[i+1].start,startError:ws[k].start-reference[i+1].start,endError:ws[j].end-reference[i].end,startClip,endClip,clip})
  }
  for(const [silenceMs,keptMs] of thresholds) for(const side of ['start','end']) {
   const boundary=side==='start'?trimmed[k].start:trimmed[j].end
   const edge=cutEdge(boundary,side,raw.silence,{lower:trimmed[j].end,upper:Math.max(trimmed[j].end,trimmed[k].start)},{silenceMs,keptMs})
   const clip=side==='start'?Math.max(0,reference[i].end-edge.time):Math.max(0,edge.time-reference[i+1].start)
   qualityRows.push({...b,side,silenceMs,keptMs,quality:edge.quality,clip})
  }
  boundaries.push(b)
 }
 // Sentence references: independent restored punctuation mapped to aligned words.
 // Only explicit .!? markers count; unmatched final tokens remain unscorable.
 const tokens=ref.punctuatedReference?.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*[^\p{L}\p{N}]*/gu)??[]
 const refPairs=match(tokens.map(norm),reference.map(w=>norm(w.text))),tokenMap=new Map(refPairs)
 const exception=sentenceExceptions.find(e=>e.id===ref.id)
 if(exception&&exception.textSha256!==createHash('sha256').update(ref.punctuatedReference).digest('hex'))throw Error('Sentence exception source changed')
 const sentenceTokens=tokens.map((s,i)=>/[.!?]/.test(s)?i:-1).filter(i=>i>=0&&!exception?.excludedTokenIndices.includes(i))
 const refEnds=new Set(sentenceTokens.filter(i=>tokenMap.has(i)).map(i=>tokenMap.get(i)))
 const segmentEnds=raw.segments.map(s=>returned.reduce((last,w,i)=>w.start>=s.startMs&&w.end<=s.endMs?i:last,-1)).filter(i=>i>=0)
 const sentences=mapSentences(trimmed,raw.sentenceEnds,raw.silence,segmentEnds)
 const predicted=sentences.map(s=>s.lastWord)
 const pausePredicted=sentences.filter(s=>s.cleanPause).map(s=>s.lastWord)
 const pauseFound=pausePredicted.filter(j=>refEnds.has(rmap.get(j))).length
 let tp=0,fp=0,unmapped=0
 for(const j of (ref.punctuatedReference?predicted:[])){const i=rmap.get(j);if(i===undefined){unmapped++;fp++}else if(refEnds.has(i))tp++;else fp++}
 details.push({id:ref.id,set:ref.set,speaker:ref.speaker,durationMs:ref.durationMs,referenceWords:reference.length,returnedWords:returned.length,matchedWords:pairs.length,eligibleBoundaries:boundaries.length,sentences:{pausePredicted:ref.punctuatedReference?pausePredicted.length:0,pauseFound:ref.punctuatedReference?pauseFound:0,referenceAvailable:!!ref.punctuatedReference,reference:refEnds.size,unscorableReference:sentenceTokens.length-refEnds.size,found:tp,false:fp,predicted:ref.punctuatedReference?predicted.length:0,unscoredPredictions:ref.punctuatedReference?0:predicted.length,unmappedPredictions:unmapped},multiTokenRuns:returned.filter(w=>w.text.trim().split(/\s+/).length>1).length})
}
const result={variant,metricVersion:2,definitions:{error:'absolute milliseconds, nearest-rank quantiles; signed per-word deltas in measurement-rows.jsonl',boundary:'adjacent reference words matched to adjacent returned runs; either kept-neighbour direction exceeds threshold',pause:'>=20ms baseline acoustic silence in baseline-trimmed inter-word window; fixed labels for relative comparison, independent of reference times',clipping:'word deletion: max(0, referenceLeftEnd - snappedRightStart, snappedLeftEnd - referenceRightStart); not human listening verification',sentences:'explicit .!? in independent LibriSpeech-PC / ParlaSpeech text; exact end-word match; unscorable reference and unmapped predictions reported'},sets:{},details}
for(const set of ['librispeech-en','parlaspeech-cs','all']){
 const rr=rows.filter(r=>set==='all'||r.set===set),dd=details.filter(r=>set==='all'||r.set===set)
 const sum=k=>dd.reduce((s,d)=>s+d[k],0)
 const obj={clips:dd.length,speakers:new Set(dd.map(d=>d.speaker)).size,durationSeconds:sum('durationMs')/1000,referenceWords:sum('referenceWords'),returnedWords:sum('returnedWords'),matchedWords:sum('matchedWords'),boundaries:sum('eligibleBoundaries'),errors:{},boundaryErrors:{},clipping:{}}
 for(const kind of ['returned','trimmed','snapped']){
  const words=rr.filter(r=>r.type==='word'&&r.kind===kind);obj.errors[kind]={start:stats(words.map(w=>w.start)),end:stats(words.map(w=>w.end))}
  obj.clipping[kind]={};obj.boundaryErrors[kind]={}
  for(const split of ['all','pause','continuous']){
   const b=rr.filter(r=>r.type==='boundary'&&r.kind===kind&&(split==='all'||r.pause===(split==='pause')))
   obj.boundaryErrors[kind][split]={start:stats(b.map(r=>r.startError)),end:stats(b.map(r=>r.endError))}
   const count=t=>b.filter(r=>r.clip>t+1e-6).length
   obj.clipping[kind][split]={n:b.length,over30:count(30),over80:count(80),over30Percent:b.length?100*count(30)/b.length:null,over80Percent:b.length?100*count(80)/b.length:null,startOver30:b.filter(r=>r.startClip>30+1e-6).length,endOver30:b.filter(r=>r.endClip>30+1e-6).length}
  }
 }
 const ss=k=>dd.reduce((s,d)=>s+d.sentences[k],0)
 obj.pauseSentences={predicted:ss('pausePredicted'),found:ss('pauseFound'),recallPercent:100*ss('pauseFound')/ss('reference'),falseDiscoveryPercent:ss('pausePredicted')?100*(ss('pausePredicted')-ss('pauseFound'))/ss('pausePredicted'):null}
 obj.cleanCuts=thresholds.map(([silenceMs,keptMs])=>{const all=qualityRows.filter(r=>(set==='all'||r.set===set)&&r.silenceMs===silenceMs&&r.keptMs===keptMs),clean=all.filter(r=>r.quality==='clean'),coverage=coverageRows.filter(r=>(set==='all'||r.set===set)&&r.silenceMs===silenceMs&&r.keptMs===keptMs);return {silenceMs,keptMs,allEdges:all.length,cleanEdges:clean.length,cleanBoundaries:new Set(clean.map(r=>r.id+':'+r.left)).size,boundaryCoveragePercent:100*coverage.filter(r=>r.cleanBoundary).length/coverage.length,allBoundaryCount:coverage.length,allCleanBoundaryCount:coverage.filter(r=>r.cleanBoundary).length,scorableBoundaryCoveragePercent:200*new Set(clean.map(r=>r.id+':'+r.left)).size/all.length,coveragePercent:100*clean.length/all.length,over30:clean.filter(r=>r.clip>30+1e-6).length,over80:clean.filter(r=>r.clip>80+1e-6).length,over30Percent:clean.length?100*clean.filter(r=>r.clip>30+1e-6).length/clean.length:null,over80Percent:clean.length?100*clean.filter(r=>r.clip>80+1e-6).length/clean.length:null}})
 obj.sentences={clipsWithReference:dd.filter(d=>d.sentences.referenceAvailable).length,unscoredPredictions:ss('unscoredPredictions'),reference:ss('reference'),unscorableReference:ss('unscorableReference'),found:ss('found'),predicted:ss('predicted'),false:ss('false'),recallPercent:ss('reference')?100*ss('found')/ss('reference'):null,falseDiscoveryPercent:ss('predicted')?100*ss('false')/ss('predicted'):null}
 result.sets[set]=obj
}
const suffix=(variant==='baseline'?'':'-'+variant)+(process.argv.includes('--relative')?'-relative':'')
if(variant==='baseline'&&!process.argv.includes('--relative'))writeFileSync(`${dir}/measurement-rows.jsonl`,rows.map(r=>JSON.stringify(r)).join('\n')+'\n')
writeFileSync(`${dir}/measurement-summary${suffix}.json`,JSON.stringify(result,null,2)+'\n')
console.log(JSON.stringify(result.sets,null,2))

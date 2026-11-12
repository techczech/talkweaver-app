import assert from 'node:assert/strict'
import {normaliseTranscript} from '../src/main/transcript-validation.ts'
import * as validation from '../src/main/transcript-validation.ts'
import {trimWords,snapToSilence,cutRangeQuality,cutEdge,proposeCleanEdges,mapSentences} from '../src/shared/transcript-contract.ts'
const pause=[{start:100,end:700}]
assert.equal(trimWords([{text:'quiet',start:200,end:400}],pause)[0].timing,'untrimmed')
assert.deepEqual(trimWords([{text:'quiet',start:200,end:400}],pause).map(w=>[w.start,w.end]),[[200,400]])
assert.equal(trimWords([{text:'short',start:680,end:720}],pause)[0].start,680)
assert.equal(snapToSilence(90,pause,90,300,{upper:95}),95,'short intervening word blocks snapping')
assert.equal(snapToSilence(110,pause,110,0,{previousCut:450}),450)
assert.equal(snapToSilence(0,pause),0)
assert.equal(snapToSilence(800,pause),800)
assert.throws(()=>snapToSilence(200,pause,200,0,{previousCut:500,upper:400}),RangeError)
assert.equal(cutEdge(100,'start',pause).quality,'clean')
assert.equal(cutEdge(99,'start',pause).quality,'tight')
assert.equal(cutEdge(200,'start',[{start:100,end:599}]).quality,'tight')
assert.deepEqual(cutRangeQuality({start:100,end:700},pause),{start:{time:400,quality:'clean',silenceMs:600},end:{time:400,quality:'clean',silenceMs:600}})
assert.deepEqual(proposeCleanEdges(90,'start',pause,500),{outward:null,inward:300})
assert.deepEqual(proposeCleanEdges(710,'end',pause,500),{outward:null,inward:500})
assert.deepEqual(proposeCleanEdges(0,'start',pause,50),{outward:null,inward:null})
assert.deepEqual(proposeCleanEdges(400,'start',pause,0),{outward:400,inward:400})
assert.equal(mapSentences([{text:'one',start:0,end:100},{text:'two',start:700,end:800}],[0],pause)[0].cleanPause,true)
assert.equal(snapToSilence(0,[{start:0,end:100}],0,0,{upper:0}),0)
assert.equal(snapToSilence(800,[{start:700,end:800}],800,0,{lower:800}),800)
const first=snapToSilence(100,pause),second=snapToSilence(150,[{start:100,end:200}],150,0,{previousCut:first})
assert.ok(second>=first)
assert.equal(trimWords([{text:'exact',start:680,end:740}],pause)[0].start,700)
const loaded=normaliseTranscript({schemaVersion:2,segments:[],words:[{text:'one',start:0,end:100,timing:'wrong'}],sentences:[{id:'one',firstWord:0,lastWord:0,start:0,end:100,boundarySource:'manual',cleanPause:'true'}]})
assert.equal(loaded.words[0].timing,undefined)
assert.equal(loaded.sentences[0].cleanPause,undefined)
const failures=[]
let regressions=0
const regression=(name,fn)=>{regressions++;try{fn()}catch(e){failures.push(`${name}: ${e.message}`)}}
regression('overlap stays ordered and bounded',()=>{
 const returned=[{text:'A',start:0,end:1000},{text:'B',start:100,end:620}]
 const trimmed=trimWords(returned,[{start:0,end:600}])
 trimmed.forEach((w,i)=>{assert.ok(w.start>=returned[i].start && w.end<=returned[i].end && w.end>=w.start);if(i)assert.ok(w.start>=trimmed[i-1].end)})
 const t=normaliseTranscript({segments:[],words:trimmed,sentences:mapSentences(trimmed,[],[])})
 assert.equal(t.words.length,2);assert.equal(t.sentences.length,1)
})
for(const bad of [NaN,Infinity,-Infinity])for(const [name,fn] of [
 ['snap',(b,bounds)=>snapToSilence(b,[],b,0,bounds)],
 ['edge',(b,bounds)=>cutEdge(b,'start',[],bounds)],
 ['range',(b,bounds)=>cutRangeQuality({start:b,end:100},[],{start:bounds})],
 ['range-end',(b,bounds)=>cutRangeQuality({start:0,end:b},[],{end:bounds})],
 ['proposal',(b,bounds)=>proposeCleanEdges(b,'start',[],100,bounds)]
]){
 regression(`${name} boundary ${bad}`,()=>assert.throws(()=>fn(bad,{}),RangeError))
 for(const key of ['lower','upper','previousCut']){
  if(key==='upper' && bad===Infinity)continue
  regression(`${name} ${key} ${bad}`,()=>assert.throws(()=>fn(10,{[key]:bad}),RangeError))
 }
}
regression('range end',()=>assert.throws(()=>cutRangeQuality({start:0,end:Infinity},[]),RangeError))
regression('Infinity remains an open upper bound',()=>{
 assert.equal(snapToSilence(10,[],10,0,{upper:Infinity}),10)
 assert.equal(cutEdge(10,'start',[],{upper:Infinity}).time,10)
 assert.equal(cutRangeQuality({start:0,end:10},[],{start:{upper:Infinity},end:{upper:Infinity}}).end.time,10)
 assert.deepEqual(proposeCleanEdges(90,'start',pause,500,{upper:Infinity}),{outward:null,inward:300})
})
regression('publish falls back before the reader can drop content',()=>{
 assert.equal(typeof validation.transcriptForPublish,'function')
 const words=[{text:'A',start:600,end:1000,returnedStart:0,returnedEnd:1000},{text:'B',start:100,end:620,returnedStart:100,returnedEnd:620}]
 const candidate={segments:[],words,sentences:[{id:'a',firstWord:0,lastWord:1,start:600,end:620,boundarySource:'transcriber'}]}
 const checked=validation.transcriptForPublish(candidate)
 assert.equal(checked.words.length,2);assert.equal(checked.sentences.length,1)
 assert.deepEqual(checked.words.map(w=>[w.start,w.end]),[[0,1000],[100,620]])
 assert.equal(checked.words[0].timing,'untrimmed')
 assert.equal(validation.transcriptForPublish({...candidate,words:words.map(({returnedStart,returnedEnd,...w})=>w)}),null)
 assert.equal(validation.transcriptForPublish({...candidate,sentences:[{...candidate.sentences[0],lastWord:99}]}),null)
})
assert.deepEqual(failures,[])
console.log(`22 cut safety, quality and metadata checks plus ${regressions} second-review regressions passed`)

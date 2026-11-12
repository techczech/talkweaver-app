import assert from 'node:assert/strict'
import {chmodSync,readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {trimWords,snapToSilence,mapSentences,sentenceSlide,rematchCorrections,defaultWordsEngine} from '../src/shared/transcript-contract.ts'
import {createTranscription} from '../src/main/transcription.ts'
let count=0
const check=(name,fn)=>{fn();console.log(`ok ${++count} ${name}`)}
const silence=[{start:0,end:700},{start:1000,end:1800},{start:2400,end:3000}]
const words=trimWords([{text:'One.',start:0,end:1500},{text:'Two.',start:1500,end:3000}],silence)
check('trim returned silence, retain raw times',()=>assert.deepEqual(words.map(w=>[w.start,w.end,w.returnedStart,w.returnedEnd]),[[700,1000,0,1500],[1800,2400,1500,3000]]))
check('nearest silence midpoint',()=>assert.equal(snapToSilence(1050,silence),1400))
check('a containing silence beats a closer midpoint inside the word',()=>assert.equal(snapToSilence(960,[{start:830,end:910},{start:960,end:1180}]),1070))
check('default snapping never jumps across spoken audio to nearby silence',()=>assert.equal(snapToSilence(500,[{start:600,end:700}]),500))
check('an explicitly requested search radius remains available',()=>assert.equal(snapToSilence(500,[{start:600,end:700}],500,300),650))
check('continuous speech falls back',()=>assert.equal(snapToSilence(5000,silence,4990),4990))
check('measured 600 ms pause splits sentence',()=>assert.equal(mapSentences(words,[],silence).length,2))
check('tokenizer boundaries retained',()=>assert.equal(mapSentences(words,[0,1],[])[0].boundarySource,'punctuation'))
check('returned ranges remain sentence boundaries without punctuation',()=>{const mapped=mapSentences(words,[],[],[0,1]);assert.equal(mapped.length,2);assert.equal(mapped[0].boundarySource,'transcriber')})
check('tie belongs to earlier slide',()=>assert.equal(sentenceSlide({start:0,end:1000},[{start:0,end:500},{start:500,end:1000}]),0))
check('spoken overlap excludes silence',()=>assert.equal(sentenceSlide({start:0,end:1200},[{start:0,end:600},{start:600,end:1200}],[{start:0,end:500}]),1))
check('ambiguous correction listed',()=>assert.equal(rematchCorrections([{original:'One.',text:'Won',start:0,end:3000}],[...words,words[0]]).unmatched.length,1))
check('unique correction re-matched',()=>assert.equal(rematchCorrections([{original:'One.',text:'Won',start:0,end:3000}],words).matched[0].start,700))
check('defaults and explicit choice',()=>{assert.equal(defaultWordsEngine(true,false),'native');assert.equal(defaultWordsEngine(false,true),'parakeet');assert.equal(defaultWordsEngine(true,true,'parakeet'),'parakeet')})
// All committed JSON transcript fixtures load via the real reader. No private audio is opened.
const scratch=mkdtempSync(join(process.cwd(),'.tw-slice2-'))
try {
 const vault=join(scratch,'vault'), data=join(scratch,'data'), folder=join(vault,'_PRESENTATIONS','fixture')
 mkdirSync(folder,{recursive:true})
 const service=createTranscription({userDataDir:()=>data,vaultRoot:()=>vault,config:()=>({python:'',script:''}),readiness:()=>{throw Error('not needed')}})
 const fixtures=[]
 for (const path of execFileSync('git',['ls-files','-z','*transcript*.json'],{encoding:'utf8'}).split('\0').filter(Boolean)) {
   try {const raw=JSON.parse(readFileSync(path,'utf8'));if(Array.isArray(raw.segments))fixtures.push([path,raw])} catch {}
 }
 // Historical inline fixtures mirror the pre-versioned stored contract.
 fixtures.push(['legacy-inline',{engine:'parakeet',createdAt:'2026-01-01',segments:[{start:0,end:1000,text:'Old run.'}]}])
 for(const [path,raw] of fixtures){writeFileSync(join(folder,'fixture-run.transcript.json'),JSON.stringify(raw));const read=await service.get('fixture','fixture-run');assert.deepEqual(read.segments,raw.segments,path);assert.deepEqual(read.words,raw.words,path)}
 console.log(`ok ${++count} ${fixtures.length} existing JSON transcript fixtures load`)
}finally{rmSync(scratch,{recursive:true,force:true})}
if (process.platform === 'win32') {
 console.log('SKIP: native child-process stand-ins require POSIX executable/shebang support; pure contract checks still ran')
} else {
const lifecycle=mkdtempSync(join(process.cwd(),'.tw-native-lifecycle-'))
try {
 const vault=join(lifecycle,'vault'),data=join(lifecycle,'data'),folder=join(vault,'_PRESENTATIONS','fixture'),sid='fixture-run'
 mkdirSync(folder,{recursive:true});mkdirSync(join(data,'recordings'),{recursive:true})
 const source=join(data,'recordings',`${sid}.webm`),target=join(folder,`${sid}.transcript.json`)
 writeFileSync(source,'audio');writeFileSync(join(folder,`${sid}.json`),JSON.stringify({id:sid,talkSlug:'fixture',audio:{segments:[{file:`${sid}.webm`,startMs:0,endMs:2000}]}}))
 const executable=(name,body)=>{const path=join(lifecycle,name);writeFileSync(path,`#!${process.execPath}\n${body}`);chmodSync(path,0o755);return path}
 const ffmpeg=executable('ffmpeg',`require('fs').writeFileSync(process.argv.at(-1),'converted')`)
 const output={engine:'apple-speech-transcriber',locale:'en-US',words:[{text:'Hello.',startMs:0,endMs:1500}],segments:[{text:'Hello.',startMs:0,endMs:1500}],sentenceEnds:[0],silence:[{start:0,end:500},{start:1000,end:2000}]}
 let body=`console.error('native progress');console.log(${JSON.stringify(JSON.stringify(output))})`
 const helper=executable('speech',body)
 const tx=createTranscription({userDataDir:()=>data,vaultRoot:()=>vault,config:()=>({python:'',script:'',engine:'native'}),nativeHelper:()=>helper,readiness:()=>({row:{state:'not-set-up'},ffmpeg:{found:true,path:ffmpeg,source:'configured'}})})
 const notes=[];assert.equal((await tx.run('fixture',sid,n=>notes.push(n))).ok,true)
 check('native ignores missing Python and reports progress',()=>assert.ok(notes.some(n=>n.includes('native progress'))))
 const good=readFileSync(target,'utf8')
 executable('speech',`console.error('failure');process.exit(1)`)
 assert.equal((await tx.run('fixture',sid,null)).ok,false)
 check('failure preserves previous transcript',()=>assert.equal(readFileSync(target,'utf8'),good))
 executable('speech',`require('fs').appendFileSync(${JSON.stringify(source)},'changed');${body}`)
 assert.equal((await tx.run('fixture',sid,null)).ok,false)
 check('late changed source rejected',()=>assert.equal(readFileSync(target,'utf8'),good))
 executable('speech',`setTimeout(()=>{${body}},2000)`)
 const abort=new AbortController();const pending=tx.run('fixture',sid,()=>{},abort.signal);setTimeout(()=>abort.abort(),100)
 assert.equal((await pending).ok,false)
 check('AbortSignal keeps previous transcript',()=>assert.equal(readFileSync(target,'utf8'),good))
 executable('speech',body)
 const duringWrite=new AbortController();let renamed=false
 const lateTx=createTranscription({userDataDir:()=>data,vaultRoot:()=>vault,config:()=>({python:'',script:'',engine:'native'}),nativeHelper:()=>helper,readiness:()=>({row:{state:'not-set-up'},ffmpeg:{found:true,path:ffmpeg,source:'configured'}}),files:{writeFile:(path,text)=>{writeFileSync(path,text);duringWrite.abort()},rename:()=>{renamed=true},remove:path=>rmSync(path,{force:true})}})
 assert.equal((await lateTx.run('fixture',sid,null,duringWrite.signal)).ok,false)
 check('final cancellation barrier is after staging and before rename',()=>{assert.equal(renamed,false);assert.equal(readFileSync(target,'utf8'),good)})
 const runPath=join(folder,`${sid}.json`)
 executable('speech',`const fs=require('fs');const p=${JSON.stringify(runPath)};const run=JSON.parse(fs.readFileSync(p,'utf8'));run.kind='rehearsal';fs.writeFileSync(p,JSON.stringify(run));${body}`)
 assert.equal((await tx.run('fixture',sid,null)).ok,true)
 check('changing Run kind does not invalidate unchanged audio and clock',()=>assert.equal(JSON.parse(readFileSync(runPath,'utf8')).kind,'rehearsal'))
 executable('speech',body)
 let liveRoot=vault,staged=0
 const beforeRevocation=readFileSync(target,'utf8')
 const revocable=createTranscription({userDataDir:()=>data,vaultRoot:()=>liveRoot,config:()=>({python:'',script:'',engine:'native'}),nativeHelper:()=>helper,readiness:()=>({row:{state:'not-set-up'},ffmpeg:{found:true,path:ffmpeg,source:'configured'}}),files:{writeFile:()=>{staged++},rename:()=>{throw Error('must not publish')},remove:()=>{}}})
 assert.equal((await revocable.run('fixture',sid,n=>{if(n.includes('native progress'))liveRoot=null})).ok,false)
 check('revoked vault refuses staging and keeps its previous transcript',()=>{assert.equal(staged,0);assert.equal(readFileSync(target,'utf8'),beforeRevocation)})
}finally{rmSync(lifecycle,{recursive:true,force:true})}

}

console.log(`${count} passed`)

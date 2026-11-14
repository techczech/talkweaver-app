import assert from 'node:assert/strict'
import {chmodSync,readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,existsSync,readdirSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {mock} from 'node:test'
import {syncBuiltinESMExports} from 'node:module'
import childProcess from 'node:child_process'
import {createTranscription,transcribeSavedRun,readTranscriptionAttempt,stopActiveTranscription,sweepTranscriptionTemps} from '../src/main/transcription.ts'
import {mapSentences,segmentWordEnds,defaultWordsEngine} from '../src/shared/transcript-contract.ts'
if (process.platform === 'win32') { console.log('SKIP: macOS transcription process-group stand-ins require POSIX executable support'); process.exit(0) }
let count=0
const check=(name)=>console.log(`ok ${++count} ${name}`)
const secondFailures=[]
const regression=async(name,fn)=>{try{await fn();check(name)}catch(e){secondFailures.push(`${name}: ${e.message}`)}}
const root=mkdtempSync(join(process.cwd(),'.tw-review-'))
try {
 const vault=join(root,'vault'),data=join(root,'data'),folder=join(vault,'_PRESENTATIONS','fixture'),sid='fixture-run'
 mkdirSync(folder,{recursive:true});mkdirSync(join(data,'recordings'),{recursive:true})
 writeFileSync(join(data,'recordings',`${sid}.webm`),'audio')
 writeFileSync(join(folder,`${sid}.json`),JSON.stringify({id:sid,talkSlug:'fixture',audio:{segments:[{file:`${sid}.webm`,startMs:0,endMs:2000}]}}))
 const target=join(folder,`${sid}.transcript.json`)
 const exe=(name,body)=>{const p=join(root,name);writeFileSync(p,`#!${process.execPath}\n${body}`);chmodSync(p,0o755);return p}
 const ffmpeg=exe('ffmpeg',`require('fs').writeFileSync(process.argv.at(-1),'converted')`)
 const script=exe('parakeet',`const fs=require('fs');if(process.argv.includes('--help'))console.log('--words FILE');else {fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],'1\\n00:00:00,100 --> 00:00:01,500\\nHello.\\n');fs.writeFileSync(process.argv[process.argv.indexOf('--words')+1],JSON.stringify([{text:'Hello.',start:.1,end:1.5}]))}`)
 const helper=exe('helper',`process.exit(1)`)
 const deps={userDataDir:()=>data,vaultRoot:()=>vault,config:()=>({python:process.execPath,script,engine:'parakeet'}),nativeHelper:()=>helper,annotationTimeoutMs:40,readiness:()=>({row:{state:'ready'},ffmpeg:{found:true,path:ffmpeg,source:'configured'}})}
 for(const failure of ['exit','timeout','missing','missing-executable']) {
   exe('helper',failure==='timeout'?`setTimeout(()=>{},10000)`:`process.exit(1)`)
   const tx=createTranscription({...deps,nativeHelper:()=>failure==='missing'?null:failure==='missing-executable'?join(root,'absent-helper'):helper})
   assert.equal((await tx.run('fixture',sid,null)).ok,true)
   const t=await tx.get('fixture',sid)
   assert.deepEqual(t.words,[{text:'Hello.',start:100,end:1500}]);assert.equal(t.acousticMeasurement,'unavailable');assert.equal(t.sentences[0].boundarySource,'transcriber');check(`Parakeet survives annotation ${failure}`)
 }
 exe('helper',`console.log(JSON.stringify({silence:[{start:0,end:500},{start:1000,end:2000}],sentenceEnds:[0]}))`)
 const success=createTranscription({...deps,annotationTimeoutMs:2000})
 assert.equal((await success.run('fixture',sid,null)).ok,true)
 assert.deepEqual((await success.get('fixture',sid)).words,[{text:'Hello.',start:100,end:1500,trimmedStart:500,trimmedEnd:1000,timing:'trimmed'}]);check('Parakeet primary times unchanged on annotation success')
 const marker=join(root,'annotating')
 exe('helper',`require('fs').writeFileSync(${JSON.stringify(marker)},'started');setTimeout(()=>{},10000)`)
 const tx=createTranscription({...deps,annotationTimeoutMs:10000})
 // 20 s, not 5: on a loaded machine a killed grandchild can take several seconds to be reaped (the wait still ends as soon as the condition holds).
 const waitFor=async predicate=>{const until=Date.now()+20000;while(!predicate()){assert.ok(Date.now()<until,'timed out');await new Promise(r=>setTimeout(r,10))}}
 const abort=new AbortController(),pending=tx.run('fixture',sid,null,abort.signal)
 await waitFor(()=>existsSync(marker));abort.abort();assert.deepEqual(await pending,{ok:false,error:'cancelled'});check('cancel during annotation stays cancelled')
 const spawnSpy=mock.method(childProcess,'spawn');syncBuiltinESMExports()
 for(const ready of [false,true]) {
   const notes=[]
   await transcribeSavedRun({...deps,nativeAvailable:async()=>false,readiness:()=>({...deps.readiness(),row:{state:ready?'ready':'not-set-up'}})},'fixture',sid,n=>notes.push(n))
   assert.deepEqual(notes,[])
 }
 const unavailable=createTranscription({...deps,config:()=>({...deps.config(),engine:'native'}),nativeHelper:()=>null});assert.equal((await unavailable.run('fixture',sid,null)).ok,false)
 assert.equal(spawnSpy.mock.callCount(),0);spawnSpy.mock.restore();syncBuiltinESMExports();assert.equal(defaultWordsEngine(false,false),null);check('unavailable native and Parakeet-only automatic calls spawn nothing and emit nothing')
 const old=readFileSync(target,'utf8')
 const native={engine:'apple-speech-transcriber',locale:'en-US',words:[{text:' Hello.',startMs:0,endMs:1500},{text:' ',startMs:1500,endMs:1600}],segments:[{text:'Hello.',startMs:0,endMs:1500}],sentenceEnds:[0,1],silence:[]}
 const nativeDeps={...deps,config:()=>({...deps.config(),engine:'native'}),annotationTimeoutMs:2000}
 const nativeTx=createTranscription(nativeDeps)
 writeFileSync(target,JSON.stringify({...JSON.parse(old),captionCorrections:[{original:'Hello.',text:'Hallo.',start:100,end:1500}]}))
 exe('helper',`console.log(${JSON.stringify(JSON.stringify(native))})`)
 assert.equal((await nativeTx.run('fixture',sid,null)).ok,true);assert.deepEqual((await nativeTx.get('fixture',sid)).words.map(w=>w.text),['Hello.']);assert.equal((await nativeTx.get('fixture',sid)).captionCorrections[0].text,'Hallo.');assert.deepEqual((await nativeTx.get('fixture',sid)).unmatchedCorrections,[]);check('native trims text, drops empties and preserves caption corrections across engines')
 for(const malformed of [{words:[null]},{locale:42},{words:{}},{segments:[{text:'x',startMs:NaN,endMs:100}]}]) {
   exe('helper',`console.log(${JSON.stringify(JSON.stringify({...native,...malformed}))})`)
   const before=readFileSync(target,'utf8');assert.equal((await nativeTx.run('fixture',sid,null)).ok,false);assert.equal(readFileSync(target,'utf8'),before)
 }
 check('malformed native core rejected without replacing stored words')
 const segmentOnly=exe('segment-only',`const fs=require('fs');if(process.argv.includes('--help'))console.log('usage');else fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],'1\\n00:00:00,100 --> 00:00:01,500\\nHello.\\n')`)
 const segmentsTx=createTranscription({...deps,config:()=>({...deps.config(),script:segmentOnly})})
 await regression('segments-only Parakeet rerun replaces built-in words as on main',async()=>{
 assert.equal((await segmentsTx.run('fixture',sid,null)).ok,true)
 assert.equal((await segmentsTx.get('fixture',sid)).segments[0].text,'Hello.')})
 writeFileSync(target,old)
 exe('segment-only',`const fs=require('fs');if(process.argv.includes('--help'))setTimeout(()=>{},10000);else fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],'1\\n00:00:00,100 --> 00:00:01,500\\nHello.\\n')`)
 const timedProbe=createTranscription({...deps,probeTimeoutMs:30,config:()=>({...deps.config(),script:segmentOnly})})
 await regression('segments-only Parakeet survives a timed-out help probe over stored words',async()=>{
 assert.equal((await timedProbe.run('fixture',sid,null)).ok,true)
 assert.equal((await timedProbe.get('fixture',sid)).segments[0].text,'Hello.')})
 writeFileSync(target,old)
 const overlap={...native,words:[{text:'A',startMs:0,endMs:1000},{text:'B',startMs:100,endMs:620}],segments:[{text:'A B',startMs:0,endMs:1000}],sentenceEnds:[1],silence:[{start:0,end:600}]}
 exe('helper',`console.log(${JSON.stringify(JSON.stringify(overlap))})`)
 await regression('overlapping native ranges are refused without replacing stored content',async()=>{
 const before=readFileSync(target,'utf8')
 assert.equal((await nativeTx.run('fixture',sid,null)).ok,false)
 assert.equal(readFileSync(target,'utf8'),before)})
 const emptyEnd={...native,words:[{text:'A',startMs:0,endMs:100},{text:' ',startMs:100,endMs:200},{text:'B',startMs:200,endMs:300}],segments:[],sentenceEnds:[1,2]}
 exe('helper',`console.log(${JSON.stringify(JSON.stringify(emptyEnd))})`)
 await regression('sentence ending on empty token moves to previous kept word',async()=>{
 assert.equal((await nativeTx.run('fixture',sid,null)).ok,true)
 assert.deepEqual((await nativeTx.get('fixture',sid)).sentences.map(s=>s.lastWord),[0,1])})
 writeFileSync(target,old)
 exe('helper',`console.log(${JSON.stringify(JSON.stringify({...native,silence:[{start:100,end:300},{start:200,end:400}],sentenceEnds:[999]}))})`)
 assert.equal((await nativeTx.run('fixture',sid,null)).ok,true);const optional=await nativeTx.get('fixture',sid);assert.deepEqual(optional.silence,[]);check('invalid optional acoustic arrays dropped')
 exe('helper',`console.log(${JSON.stringify(JSON.stringify({...native,words:[],segments:[],sentenceEnds:[]}))})`)
 const good=readFileSync(target,'utf8');assert.match((await nativeTx.run('fixture',sid,null)).error,/earlier transcript was kept/);assert.equal(readFileSync(target,'utf8'),good)
 rmSync(target);assert.equal((await nativeTx.run('fixture',sid,null)).ok,true);assert.deepEqual((await nativeTx.get('fixture',sid)).words,[]);check('empty result preserves earlier words but silent first result is stored')
 writeFileSync(target,good)
 const emptyScript=exe('empty-parakeet',`const fs=require('fs');if(process.argv.includes('--help'))console.log('--words FILE');else {fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],'');fs.writeFileSync(process.argv[process.argv.indexOf('--words')+1],'[]')}`)
 const emptyParakeet=createTranscription({...deps,config:()=>({...deps.config(),script:emptyScript})});assert.match((await emptyParakeet.run('fixture',sid,null)).error,/earlier transcript was kept/);assert.equal(readFileSync(target,'utf8'),good);check('empty Parakeet also keeps earlier words')
 for(const bad of [{unmatchedCorrections:{length:1}},{captionCorrections:[{}]},{engine:'other'},{sentences:[{firstWord:99,lastWord:100}]},{silence:[{start:5,end:1}]},{unmatchedCorrections:'bad'}]) {
   const payload=JSON.stringify({...JSON.parse(old),...bad});writeFileSync(target,payload)
   const read=await tx.get('fixture',sid);for(const key of Object.keys(bad))assert.equal(read[key],undefined,key);assert.equal(readFileSync(target,'utf8'),payload)
 }
 check('malformed version 2 optional fields dropped without rewriting')
 exe('helper',`process.exit(1)`)
 const notes=[];await transcribeSavedRun({...nativeDeps,nativeAvailable:async()=>true},'fixture',sid,n=>notes.push(n));assert.match(readTranscriptionAttempt(nativeDeps,'fixture',sid).reason,/Words could not/);assert.ok(notes.at(-1).startsWith('Words could not'));check('automatic failure persists engine, time and reason')
 for(const exit of ['cancel','vault-change']) await regression(`automatic ${exit} finishes Studio busy state`,async()=>{
   let current=vault
   exe('helper',`require('fs').writeFileSync(${JSON.stringify(marker)},'started');setTimeout(()=>{},10000)`)
   rmSync(marker,{force:true})
   const finalNotes=[]
   const automatic=transcribeSavedRun({...nativeDeps,vaultRoot:()=>current,nativeAvailable:async()=>true},'fixture',sid,n=>finalNotes.push(n))
   await waitFor(()=>existsSync(marker));if(exit==='vault-change')current=join(root,'other-vault');stopActiveTranscription();await automatic
   assert.equal(finalNotes.at(-1),'Words were not written. Retry from the Run.')
 })
 await regression('Studio clears busy on the final retry note',()=>assert.ok(readFileSync('src/renderer/src/components/Studio.tsx','utf8').includes("event.note === 'Words were not written. Retry from the Run.'")))
 const childPid=join(root,'child-pid'),wav=join(root,'wav-path')
 exe('helper',`const fs=require('fs');fs.writeFileSync(${JSON.stringify(wav)},process.argv[2]);const child=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},100000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(childPid+'.tmp')},String(child.pid));fs.renameSync(${JSON.stringify(childPid+'.tmp')},${JSON.stringify(childPid)});setTimeout(()=>{},100000)`)
 const quitting=nativeTx.run('fixture',sid,null);await waitFor(()=>existsSync(childPid))
 const busyNotes=[];await transcribeSavedRun({...nativeDeps,nativeAvailable:async()=>true},'fixture',sid,n=>busyNotes.push(n));assert.deepEqual(busyNotes,[]);check('busy automatic run is silent and leaves manual job active')
 stopActiveTranscription();assert.equal(existsSync(readFileSync(wav,'utf8')),false);assert.equal((await quitting).error,'cancelled')
 // The pid file is renamed into place, so it is never read half-written: an empty read gave pid 0, and kill(0, 0) signals our own group and always succeeds.
 const grandchild=Number(readFileSync(childPid,'utf8'));assert.ok(Number.isInteger(grandchild)&&grandchild>0,`grandchild pid ${grandchild}`)
 // Gone, or a zombie waiting to be reaped: either way it no longer runs. kill(pid, 0) alone also succeeds on a zombie.
 // ps exits 1 when no process has that pid; any other failure (ps missing, not permitted) is a broken check, not a stopped process.
 const stillRuns=()=>{try{return !/^Z/.test(childProcess.execFileSync('ps',['-o','stat=','-p',String(grandchild)]).toString().trim())}catch(error){if(error.status===1)return false;throw error}}
 await waitFor(()=>!stillRuns());check('quit kills child tree and removes WAV immediately')
 const {EventEmitter}=await import('node:events')
 const exited=new EventEmitter();Object.assign(exited,{pid:99999999,exitCode:0,signalCode:null,stdout:new EventEmitter(),stderr:new EventEmitter(),kill:()=>{throw Error('exited child killed')}})
 const killSpy=mock.method(process,'kill',()=>{throw Error('stale group signalled')})
 const exitedSpawn=mock.method(childProcess,'spawn',()=>{queueMicrotask(()=>exited.emit('close',0,null));return exited});syncBuiltinESMExports()
 await regression('already-exited child never receives a group kill',async()=>{
 try {const {nativeLocaleAvailable}=await import('../src/main/transcription.ts');await nativeLocaleAvailable('stand-in','en-US');assert.equal(killSpy.mock.callCount(),0)} finally {exitedSpawn.mock.restore();killSpy.mock.restore();syncBuiltinESMExports()}})
 const stale=join(root,'talkweaver-run-99999999-123-0123abcd.wav');writeFileSync(stale,'private');sweepTranscriptionTemps(root);assert.equal(existsSync(stale),false);check('startup sweeps dead-owner transcription temps')
 await regression('missing temp root cannot reject startup',()=>assert.doesNotThrow(()=>sweepTranscriptionTemps(join(root,'missing'))))
 const fs=await import('node:fs')
 const denied=mock.method(fs.default,'readdirSync',()=>{throw Object.assign(Error('denied'),{code:'EACCES'})});syncBuiltinESMExports()
 await regression('unreadable temp root cannot reject startup',()=>{
 try {assert.doesNotThrow(()=>sweepTranscriptionTemps(root))} finally {denied.mock.restore();syncBuiltinESMExports()}})
 await regression('unordered SRT retains every segment end',()=>assert.deepEqual(segmentWordEnds([{text:'A',start:0,end:100},{text:'B',start:200,end:300}],[{start:200,end:300},{start:0,end:100}]),[0,1]))
 const wordCount=10434,words=Array.from({length:wordCount},(_,i)=>({text:'word',start:i*345,end:i*345+100})),segments=words.map(w=>({...w})),silence=words.map(w=>({start:w.end,end:w.start+345}))
 const start=performance.now();assert.equal(segmentWordEnds(words,segments).length,wordCount);mapSentences(words,[],silence);assert.ok(performance.now()-start<2000);check('60-minute probe sizes complete within generous 2-second bound')
 const studio=readFileSync('src/renderer/src/components/Studio.tsx','utf8');assert.ok(studio.indexOf("event.note.includes('Words could not be written out: busy')") < studio.indexOf('setTranscriptNote(event.note)'));check('Studio ignores busy event before changing busy state')
 await regression('main wires quit barrier and nonblocking startup sweep',()=>{
 const main=readFileSync('src/main/index.ts','utf8');assert.match(main,/app.on\('before-quit', \(\) => \{ stopActiveTranscription\(\)/);assert.match(main,/sweepTranscriptionTemps\(\)/);assert.equal(/app.whenReady\(\).then\(async \(\) => \{\s+sweepTranscriptionTemps\(\)/.test(main),false)})
 assert.deepEqual(secondFailures,[])
} finally {rmSync(root,{recursive:true,force:true})}
console.log(`${count} passed`)

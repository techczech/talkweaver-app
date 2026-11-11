import assert from 'node:assert/strict'
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,symlinkSync,lstatSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { createTranscription } from '../src/main/transcription.ts'
const root=mkdtempSync(join(tmpdir(),'tw-transcription-inline-'))
const vault=join(root,'vault'), userData=join(root,'user-data'), dir=join(vault,'_PRESENTATIONS','talk')
mkdirSync(dir,{recursive:true})
const target=join(dir,'session.transcript.json')
const deps={vaultRoot:()=>vault,userDataDir:()=>userData,config:()=>({python:'',script:''}),readiness:()=>{throw new Error('fixture needs no engine')},testMode:()=>true}
let count=0
const ok=label=>console.log(`ok ${++count}. ${label}`)
try {
  const legacy={engine:'parakeet',createdAt:'old',segments:[{text:'Old segment',start:0,end:1000}],unrelated:'unknown fields remain readable'}
  writeFileSync(target,JSON.stringify(legacy))
  const tx=createTranscription(deps)
  const read=await tx.get('talk','session')
  assert.deepEqual(read.segments,legacy.segments);assert.equal(read.hasWords,false)
  assert.equal(read.unrelated,legacy.unrelated)
  ok('legacy transcripts remain readable and unknown fields do not affect segment readers')
  assert.equal((await tx.run('talk','session',null)).hasWords,true)
  const current=readFileSync(target,'utf8'), stored=JSON.parse(current)
  assert.ok(stored.segments.length && stored.words.length)
  assert.equal(existsSync(join(dir,'session.words.json')),false)
  ok('one canonical JSON holds segments and words; no sidecar or recovery record is created')
  const extra={
    'session.words.json':JSON.stringify({engine:'parakeet',createdAt:'later',words:[{text:'stale',start:0,end:9999}]}),
    'session.words-old.json':'not json',
    'session.transcript.json.pair-transaction.json':JSON.stringify({version:1,before:{transcript:JSON.stringify(legacy),words:'old words'}})
  }
  for(const [name,body] of Object.entries(extra))writeFileSync(join(dir,name),body)
  const newer=await tx.get('talk','session')
  assert.deepEqual(newer.words,stored.words);assert.equal(newer.hasWords,true)
  assert.equal(readFileSync(target,'utf8'),current,'a synced stale artifact never overwrites the newer pair')
  for(const [name,body] of Object.entries(extra))assert.equal(readFileSync(join(dir,name),'utf8'),body,'extra files are never repaired or deleted on read')
  ok('stale/invalid word files and a synced obsolete recovery record cannot change or delete a newer pair')
  const outside=join(root,'unrelated.words.json'), sidecar=join(dir,'session.words.json')
  writeFileSync(outside,'author data outside the talk')
  rmSync(sidecar);symlinkSync(outside,sidecar)
  assert.equal((await tx.get('talk','session')).hasWords,true)
  const repeated=await tx.run('talk','session',null)
  assert.equal(repeated.ok,true,repeated.error);assert.equal(repeated.hasWords,true)
  assert.equal(readFileSync(outside,'utf8'),'author data outside the talk')
  assert.equal(lstatSync(sidecar).isSymbolicLink(),true,'unused legacy sidecar is neither followed nor replaced')
  // Keep crash comparisons against the original complete canonical pair.
  writeFileSync(target,current)
  ok('a symlinked legacy words file never blocks a transcription or accesses its target')
  const runCrash=phase=>{
    const code=`
      import {writeFileSync,renameSync,rmSync} from 'node:fs';
      import {createTranscription} from ${JSON.stringify(new URL('../src/main/transcription.ts',import.meta.url).href)};
      const files={writeFile:(p,text)=>{writeFileSync(p,text,'utf8');if(${JSON.stringify(phase)}==='stage')process.exit(23)},rename:(a,b)=>{renameSync(a,b);if(${JSON.stringify(phase)}==='commit')process.exit(24)},remove:p=>rmSync(p,{force:true})};
      const tx=createTranscription({files,vaultRoot:()=>${JSON.stringify(vault)},userDataDir:()=>${JSON.stringify(userData)},config:()=>({python:'',script:''}),readiness:()=>{throw new Error('fixture')},testMode:()=>true});
      await tx.run('talk','session',null);
    `
    return spawnSync(process.execPath,['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON','--input-type=module','-e',code],{encoding:'utf8'})
  }
  const staged=runCrash('stage');assert.equal(staged.status,23,staged.stderr)
  assert.equal(readFileSync(target,'utf8'),current)
  assert.deepEqual((await tx.get('talk','session')).words,stored.words)
  ok('process exit after staging leaves the entire old pair intact without recovery')
  writeFileSync(target,JSON.stringify({...stored,testMarker:'previous version'}))
  const committed=runCrash('commit');assert.equal(committed.status,24,committed.stderr)
  const committedBytes=readFileSync(target,'utf8'), pair=JSON.parse(committedBytes)
  assert.equal(pair.testMarker,undefined);assert.ok(pair.words.length && pair.segments.length)
  assert.deepEqual((await tx.get('talk','session')).words,pair.words)
  assert.equal(readFileSync(target,'utf8'),committedBytes,'stale extra files cannot roll back the committed new pair')
  ok('process exit after the only rename leaves the entire new pair intact without recovery')
  console.log(`inline transcript store: ${count} checks passed`)
} finally {rmSync(root,{recursive:true,force:true})}

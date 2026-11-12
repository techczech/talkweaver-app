// Public, licensed speech fixtures only. Run through agent-run after native build.
import {spawnSync} from 'node:child_process'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import assert from 'node:assert/strict'
import {trimWords} from '../src/shared/transcript-contract.ts'
const helper=process.argv[2] ?? 'native/transcription'
const scratch=mkdtempSync(`${process.cwd()}/.tw-gain-`)
const run=(cmd,args)=>{const p=spawnSync(cmd,args,{encoding:'utf8'});assert.equal(p.status,0,p.stderr);return p.stdout}
try {
 for(const language of ['english','czech']) {
  const source=`docs/design/2026-11-10-record-and-edit-video/built/slice-2/fixtures/human-${language}.wav`
  const words=[{text:'fixture',startMs:0,endMs:2000}]
  writeFileSync(`${scratch}/words.json`,JSON.stringify(words))
  const maps=[]
  for(const gain of [0,-30]) {
   const wav=`${scratch}/${language}-${gain}.wav`
   run('node_modules/ffmpeg-static/ffmpeg',['-v','error','-y','-i',source,'-af',`volume=${gain}dB`,'-c:a','pcm_f32le',wav])
   maps.push(JSON.parse(run(helper,['--annotate',wav,language==='english'?'en-US':'cs-CZ',`${scratch}/words.json`])).silence)
  }
  assert.deepEqual(maps[1],maps[0],`${language} silence map at -30dB`)
  const returned=[{text:'fixture',start:0,end:2000}]
  assert.deepEqual(trimWords(returned,maps[1]),trimWords(returned,maps[0]))
 }
 console.log('4 public-speech gain equivalence checks passed (English and Czech, -30 dB; silence and trimming)')
} finally {rmSync(scratch,{recursive:true,force:true})}

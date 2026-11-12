import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {createTranscription} from '../src/main/transcription.ts'
import assert from 'node:assert/strict'
const out=resolve('docs/design/2026-11-10-record-and-edit-video/built/slice-2')
const scratch=mkdtempSync(join(process.cwd(),'.tw-native-adapter-'))
try {
 const vault=join(scratch,'vault'),data=join(scratch,'data'),folder=join(vault,'_PRESENTATIONS','probe'),sid='native-probe'
 mkdirSync(folder,{recursive:true});mkdirSync(join(data,'recordings'),{recursive:true})
 const aiff=join(scratch,'english.aiff'),audio=join(data,'recordings',`${sid}.webm`)
 let result=spawnSync('/usr/bin/say',['-v','Samantha','-o',aiff,'Welcome to this presentation. These words stay on this Mac.'],{encoding:'utf8'})
 assert.equal(result.status,0,result.stderr)
 const ffmpeg=resolve('node_modules/ffmpeg-static/ffmpeg')
 result=spawnSync(ffmpeg,['-y','-i',aiff,'-c:a','libopus',audio],{encoding:'utf8'});assert.equal(result.status,0,result.stderr)
 writeFileSync(join(folder,`${sid}.json`),JSON.stringify({id:sid,talkSlug:'probe',recordingMs:10000,audio:{segments:[{file:`${sid}.webm`,startMs:0,endMs:10000}]}}))
 const service=createTranscription({userDataDir:()=>data,vaultRoot:()=>vault,config:()=>({python:'',script:'',engine:'native',locale:'en-US'}),nativeHelper:()=>resolve('native/transcription'),readiness:()=>({row:{state:'not-set-up',ffmpegConfigured:false,ffmpeg:null},ffmpeg:{found:true,path:ffmpeg,source:'shipped'}})})
 const notes=[];result=await service.run('probe',sid,n=>notes.push(n));assert.equal(result.ok,true,result.error)
 const transcript=await service.get('probe',sid);assert.ok(transcript.hasWords);assert.equal(transcript.schemaVersion,2);assert.ok(transcript.sentences.length)
 writeFileSync(join(out,'native-adapter.json'),JSON.stringify({result,transcript,notes},null,2))
 console.log(`Real native adapter: ${transcript.words.length} words, ${transcript.sentences.length} sentences; source Run → ffmpeg → Apple speech → atomic transcript → get; no Python configured.`)
}finally{rmSync(scratch,{recursive:true,force:true})}

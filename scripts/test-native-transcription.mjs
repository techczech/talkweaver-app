import {spawnSync} from 'node:child_process'
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import assert from 'node:assert/strict'
// The helper runs on macOS 26 or later and builds only against an SDK whose Speech framework has
// SpeechAnalyzer (Xcode 26 or matching Command Line Tools; an older SDK, such as 15.x, lacks it).
// Without both this test is not run: scripts/run-tests.mjs counts "TEST NOT RUN:" apart from passes.
const notRun=(why)=>{console.log(`TEST NOT RUN: ${why}`);process.exit(0)}
if(process.platform!=='darwin')notRun('the native speech helper is macOS only')
const osMajor=Number(spawnSync('sw_vers',['-productVersion'],{encoding:'utf8'}).stdout.split('.')[0])
if(!(osMajor>=26))notRun(`the native speech helper runs on macOS 26 or later (this computer: ${osMajor})`)
const sdkPath=spawnSync('xcrun',['--show-sdk-path'],{encoding:'utf8'}).stdout?.trim()??''
const speechModule=join(sdkPath,'System/Library/Frameworks/Speech.framework/Modules/Speech.swiftmodule')
const sdkHasAnalyzer=!!sdkPath&&existsSync(speechModule)&&readdirSync(speechModule).some((f)=>f.endsWith('-macos.swiftinterface')&&readFileSync(join(speechModule,f),'utf8').includes('SpeechAnalyzer'))
if(!sdkHasAnalyzer)notRun(`the SDK ${sdkPath||'(none found)'} has no SpeechAnalyzer; the helper needs the macOS 26 SDK`)
const built=spawnSync('xcrun',['swiftc','-parse-as-library','native/transcription.swift','-o','native/transcription'],{encoding:'utf8'})
assert.equal(built.status,0,built.stderr)
const scratch=mkdtempSync(join(process.cwd(),'.tw-native-fixture-'))
try {
 const samples=32000, header=Buffer.alloc(44), pcm=Buffer.alloc(samples*2)
 header.write('RIFF');header.writeUInt32LE(36+pcm.length,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(1,22);header.writeUInt32LE(16000,24);header.writeUInt32LE(32000,28);header.writeUInt16LE(2,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40)
 for(let i=8000;i<16000;i++)pcm.writeInt16LE(Math.round(12000*Math.sin(i*2*Math.PI*220/16000)),i*2)
 const wav=join(scratch,'fixture.wav'),words=join(scratch,'words.json')
 writeFileSync(wav,Buffer.concat([header,pcm]));writeFileSync(words,JSON.stringify([{text:'Hello.',startMs:0,endMs:1000},{text:'Again.',startMs:1000,endMs:2000}]))
 const result=spawnSync('native/transcription',['--annotate',wav,'en-US',words],{encoding:'utf8'})
 assert.equal(result.status,0,result.stderr)
 const data=JSON.parse(result.stdout)
 assert.deepEqual(data.sentenceEnds,[0,1]);assert.equal(data.silence.length,2)
 assert.ok(Math.abs(data.silence[0].end-500)<=10);assert.ok(Math.abs(data.silence[1].start-1000)<=10)
 const measured={source:'synthetic 220 Hz tone, speech 500–1000 ms; two seconds total',before:{startErrorMs:500,endErrorMs:0},after:{startErrorMs:Math.abs(data.silence[0].end-500),endErrorMs:Math.abs(data.silence[1].start-1000)},humanSpeech:false}
 writeFileSync(join(scratch,'acoustic-fixture.json'),JSON.stringify(measured,null,2))
 const inventory=JSON.parse(spawnSync('native/transcription',['--inventory'],{encoding:'utf8'}).stdout)
 const route=spawnSync('native/transcription',['--route','cs-CZ'],{encoding:'utf8'})
 assert.equal(route.status,0,route.stderr)
 const expected=inventory.supported.some(l=>l.replaceAll('_','-')==='cs-CZ')?'apple-speech-transcriber':'apple-dictation'
 assert.equal(JSON.parse(route.stdout).engine,expected,'equivalentTo alone must not route unsupported Czech to SpeechTranscriber')
 console.log('5 native fixture checks passed; synthetic acoustic onset/end error <= 10 ms; Czech route respects engine inventory')
}finally{rmSync(scratch,{recursive:true,force:true})}

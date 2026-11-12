import {readFileSync,writeFileSync} from 'node:fs'
import {trimWords,snapToSilence} from '../src/shared/transcript-contract.ts'
const folder='docs/design/2026-11-10-record-and-edit-video/built/slice-2'
const english=process.argv[2]==='english'
const stem=english?'human-english':'human'
const raw=JSON.parse(readFileSync(`${folder}/${english?'human-english':'human-czech'}.json`,'utf8'))
const reference=JSON.parse(readFileSync(`${folder}/${stem}-boundaries.json`,'utf8'))
if(!raw.words?.length)throw Error('Human decoding has no word times: timing acceptance NOT MET')
const words=trimWords(raw.words.map(w=>({text:w.text,start:w.startMs,end:w.endMs})),raw.silence)
const first=words[0],last=words.at(-1)
const duration=JSON.parse(readFileSync(`${folder}/${english?'human-english-waveform':'human-waveform'}-info.json`,'utf8')).durationMs
const expectedCuts={start:reference.startMs/2,end:(reference.endMs+duration)/2}
const cutTimes={start:snapToSilence(first.start,raw.silence),end:snapToSilence(last.end,raw.silence)}
const result={reference,recognised:words.map(w=>w.text).join(' '),before:{startErrorMs:Math.abs(first.returnedStart-reference.startMs),endErrorMs:Math.abs(last.returnedEnd-reference.endMs)},after:{startErrorMs:Math.abs(first.start-reference.startMs),endErrorMs:Math.abs(last.end-reference.endMs)},snappedCuts:cutTimes,expectedCuts,beforeCutErrorMs:{start:Math.abs(first.returnedStart-expectedCuts.start),end:Math.abs(last.returnedEnd-expectedCuts.end)},afterCutErrorMs:{start:Math.abs(cutTimes.start-expectedCuts.start),end:Math.abs(cutTimes.end-expectedCuts.end)},safeWordCuts:false,reason:'One isolated word, approximate visual envelope only; continuous human speech and human listening review remain unproved'}
writeFileSync(`${folder}/${stem}-measurement.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2))

/** Twelve PUBLIC-only listening cuts. Audio stays in ignored .tw-listening-slice2b/. */
import { readFileSync,writeFileSync,mkdirSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
const root=process.cwd(),base=resolve('docs/design/2026-11-10-record-and-edit-video/built/slice-2/continuous-speech'),local=resolve('scripts/precise-word-timing/local')
const read=p=>JSON.parse(readFileSync(p,'utf8')),placements=read(join(local,'both-placements.json')),refs=[...read(join(base,'reference-english.json')),...read(join(base,'reference-czech.json'))]
const cases=[]
const baselineRows=readFileSync(join(base,'measurement-rows.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
for(const category of ['aligned-continuous','pause','tight-baseline']) {
 const wanted=category==='aligned-continuous'?6:3,quota=category==='aligned-continuous'?{en:3,cs:3}:category==='pause'?{en:2,cs:1}:{en:1,cs:2}
 for(const ref of refs) {
  if(cases.filter(c=>c.category===category).length===wanted)break
  if(cases.filter(c=>c.category===category && c.language.split('-')[0]===ref.locale.split('-')[0]).length>=quota[ref.locale.split('-')[0]])continue
  const raw=read(join(base,ref.id+'-native.json')),p=placements.find(p=>p.id===ref.id)
  let cut
  if(category==='pause') {
   const pauses=raw.silence.filter(s=>s.end-s.start>=500 && s.start>500 && s.end<ref.durationMs-500)
   if(pauses.length>=2)cut={start:(pauses[0].start+pauses[0].end)/2,end:(pauses[1].start+pauses[1].end)/2}
  }else {
   const wordRows=baselineRows.filter(r=>r.id===ref.id && r.type==='word' && r.kind==='returned'),wordMap=new Map(wordRows.map(r=>[r.referenceWord,r.returnedWord]))
   const pairs=new Set(baselineRows.filter(r=>r.id===ref.id && r.type==='boundary' && r.kind==='snapped' && !r.pause).map(r=>`${wordMap.get(r.left)}:${wordMap.get(r.right)}`))
   for(let i=1;i<raw.words.length-1;i++) {
    if(!pairs.has(`${i-1}:${i}`)||!pairs.has(`${i}:${i+1}`))continue
    const start=category==='aligned-continuous'?p?.midpoints[i-1]:raw.words[i].startMs,end=category==='aligned-continuous'?p?.midpoints[i]:raw.words[i].endMs
    if(typeof start==='number' && typeof end==='number' && end>start && start>500 && end<ref.durationMs-500){cut={start,end,word:i,text:raw.words[i].text};break}
   }
  }
  if(cut)cases.push({id:`${category}-${cases.filter(c=>c.category===category).length+1}`,category,clip:ref.id,language:ref.locale,sourceSpeaker:ref.speaker,sourceId:ref.sourceId??ref.id,licence:ref.locale.startsWith('cs')?'CC-BY-SA-4.0':'CC-BY-4.0',sourceURL:ref.locale.startsWith('cs')?'https://www.clarin.si/repository/xmlui/handle/11356/1785':'https://www.openslr.org/12/',attribution:ref.locale.startsWith('cs')?'Kopp and Ljubešić, ParlaSpeech-CZ 1.0, publisher-linked CLASSLA mirror':'LibriSpeech (OpenSLR 12); reference alignments by Loren Lugosch; LibriSpeech-PC punctuation (OpenSLR 145)',audio:ref.audio,audioSha256:ref.audioSha256,cut,fadeMs:15,fadeProvenance:'origin/design/tutorial-recording d52e92bdb90771aa4b2de1d0110f6334072b9ace src/shared/tutorial-export-timeline.ts:95; src/main/tutorial-export-ffmpeg.ts:72 (linear non-overlapping fades to zero)',durationMs:ref.durationMs})
 }
 if(cases.filter(c=>c.category===category).length!==wanted)throw Error(`Insufficient qualified public samples for ${category}; do not substitute private audio`)
}
const output=resolve('.tw-listening-slice2b');mkdirSync(output,{recursive:true})
const ffmpeg=resolve('node_modules/ffmpeg-static/ffmpeg')
for(const c of cases) {
 if(!c.audio.startsWith('.tw-cut-study/')||c.audio.includes('..'))throw Error('Public corpus path refused')
 const input=resolve(c.audio),bytes=readFileSync(input)
 if(createHash('sha256').update(bytes).digest('hex')!==c.audioSha256)throw Error('Public corpus hash mismatch')
 const from=Math.max(0,c.cut.start-1000),to=Math.min(c.durationMs,c.cut.end+1000),left=(c.cut.start-from)/1000,right=(to-c.cut.end)/1000,fade=Math.min(.015,left/2,right/2)
 const before=join(output,c.id+'-before.wav'),after=join(output,c.id+'-after.wav')
 execFileSync(ffmpeg,['-v','error','-y','-ss',String(from/1000),'-t',String((to-from)/1000),'-i',input,'-ac','1','-ar','48000',before])
 const filter=`[0:a]atrim=start=${from/1000}:end=${c.cut.start/1000},asetpts=PTS-STARTPTS,afade=t=out:st=${left-fade}:d=${fade}[left];[0:a]atrim=start=${c.cut.end/1000}:end=${to/1000},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fade}[right];[left][right]concat=n=2:v=0:a=1[out]`
 execFileSync(ffmpeg,['-v','error','-y','-i',input,'-filter_complex',filter,'-map','[out]','-ac','1','-ar','48000',after])
 c.before=before;c.after=after;c.window={start:from,end:to}
 c.beforeSha256=createHash('sha256').update(readFileSync(before)).digest('hex');c.afterSha256=createHash('sha256').update(readFileSync(after)).digest('hex')
}
const modelManifests=['en','cs'].map(l=>read(resolve(`resources/alignment-models/${l}.json`))).filter(Boolean).map(({language,name,revision,sha256,bytes})=>({language,name,revision,sha256,bytes}))
const manifest={version:1,modelManifests,status:'generated; awaiting owner listening',publicOnly:true,transformations:'Mono 48 kHz WAV; context before/after the selected interval; after removes it and applies the documented 15 ms fades. Each output inherits its source licence.',outputFolder:output,cases}
writeFileSync(resolve('docs/design/2026-11-10-record-and-edit-video/built/slice-2b/listening-manifest.json'),JSON.stringify(manifest,null,2)+'\n')
console.log(`Generated ${cases.length} before/after pairs in ${output}; no audio committed`)

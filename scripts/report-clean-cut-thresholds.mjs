import {readFileSync,writeFileSync} from 'node:fs'
const dir='docs/design/2026-11-10-record-and-edit-video/built/slice-2/continuous-speech'
const relative=process.argv.includes('--relative')
const r=JSON.parse(readFileSync(`${dir}/measurement-summary${relative?'-relative':''}.json`))
const out=['| Pause / kept ms | English >30 / >80 ms | English clean edge n / all boundary coverage | Czech >30 / >80 ms | Czech clean edge n / all boundary coverage |','|---|---|---|---|---|']
const fmt=n=>n===null?'n/a':n.toFixed(2)+'%'
for(let i=0;i<r.sets['librispeech-en'].cleanCuts.length;i++) {
 const a=r.sets['librispeech-en'].cleanCuts[i],b=r.sets['parlaspeech-cs'].cleanCuts[i]
 out.push(`| ${a.silenceMs} / ${a.keptMs} | ${fmt(a.over30Percent)} / ${fmt(a.over80Percent)} | ${a.cleanEdges} / ${fmt(a.boundaryCoveragePercent)} | ${fmt(b.over30Percent)} / ${fmt(b.over80Percent)} | ${b.cleanEdges} / ${fmt(b.boundaryCoveragePercent)} |`)
}
out.push('','Clipping: reference-aligned adjacent returned words, two directional deletion edges per boundary. Coverage: share of all adjacent returned word boundaries where at least one deletion direction is clean. Exact-token alignment is mechanical, not listening adjudication.','')
for(const name of ['librispeech-en','parlaspeech-cs'])out.push(`${name}: pause-only sentences ${JSON.stringify(r.sets[name].pauseSentences)}`)
writeFileSync(`evidence/builtin-transcription-review/clean-threshold-table${relative?'-relative':''}.md`,out.join('\n')+'\n')
console.log(out.join('\n'))

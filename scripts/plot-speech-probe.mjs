// Evidence plot only; no classifier or hand-labelled truth is generated here.
import {readFileSync,writeFileSync} from 'node:fs'
import sharp from 'sharp'
const folder='docs/design/2026-11-10-record-and-edit-video/built/slice-2'
const english=process.argv[2]==='english'
const stem=english?'human-english-waveform':'human-waveform'
const b=readFileSync(`${folder}/fixtures/human-${english?'english':'czech'}.wav`)
let offset=12,rate=0,channels=0,bits=0,pcm
while(offset+8<=b.length){const name=b.toString('ascii',offset,offset+4),n=b.readUInt32LE(offset+4);if(name==='fmt '){channels=b.readUInt16LE(offset+10);rate=b.readUInt32LE(offset+12);bits=b.readUInt16LE(offset+22)}if(name==='data')pcm=b.subarray(offset+8,offset+8+n);offset+=8+n+(n%2)}
if(bits!==16||!pcm)throw Error('Plot supports PCM16 only; no implicit conversion')
const frames=pcm.length/2/channels,ms=frames/rate*1000,width=1200,height=400
const points=[]
for(let x=0;x<width;x++){const from=Math.floor(x*frames/width),to=Math.max(from+1,Math.floor((x+1)*frames/width));let peak=0;for(let i=from;i<to;i++)peak=Math.max(peak,Math.abs(pcm.readInt16LE(i*2*channels))/32768);points.push(`<path d="M${x} ${200-peak*160}V${200+peak*160}" stroke="#254d70"/>`)}
const labels=Array.from({length:11},(_,i)=>`<text x="${20+i*115}" y="380" font-size="14">${Math.round(ms*i/10)} ms</text>`).join('')
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/><text x="20" y="25" font-size="18">${english?'Public English human speech: hello (Dvortygirl, public domain), 500 ms padding':'Public Czech human speech: návštěvník (Ghost4Man, CC0)'}</text>${points.join('')}${labels}</svg>`
await sharp(Buffer.from(svg)).png().toFile(`${folder}/${stem}.png`)
writeFileSync(`${folder}/${stem}-info.json`,JSON.stringify({durationMs:ms,rate,channels,bits,warning:'Waveform alone is not hand-checked phonetic word-boundary truth'},null,2))

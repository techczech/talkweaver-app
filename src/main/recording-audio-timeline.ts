import { audibleSegments } from '../shared/recording-clock.ts'

/**
 * The one ffmpeg recording clock: measured segments are trimmed/padded to their declared span.
 * Segments with no recorded span hold no audio and are left out (audibleSegments).
 */
/** `offsetMs` (optional): where in its file a segment starts (a piece of a file placed by Record this slide again). */
export function recordingAudioTimeline(all:ReadonlyArray<{path:string;startMs:number;endMs:number;offsetMs?:number}>,recordingMs:number){
  const segments=audibleSegments(all)
  if(!segments.length)throw new Error('The local recording has no audio segments.')
  const legacy=segments.every(s=>s.startMs===0&&s.endMs===0)
  const duration=Math.max(Number.isFinite(recordingMs)?recordingMs:0,...segments.map(s=>s.endMs))
  const inputs:string[]=[],filters:string[]=[]
  if(!legacy){
    if(!Number.isFinite(duration)||duration<=0)throw new Error('The recording has no measured duration.')
    inputs.push('-f','lavfi','-t',(duration/1000).toFixed(3),'-i','anullsrc=r=48000:cl=mono')
  }
  const labels:string[]=[]
  segments.forEach((s,i)=>{
    inputs.push('-i',s.path)
    const input=i+(legacy?0:1)
    if(!legacy&&(!Number.isFinite(s.startMs)||!Number.isFinite(s.endMs)||s.startMs<0||s.endMs<=s.startMs))throw new Error('An audio segment has invalid recording times.')
    const span=(s.endMs-s.startMs)/1000
    const skip=!legacy&&s.offsetMs&&s.offsetMs>0?`atrim=start=${s.offsetMs/1000},asetpts=PTS-STARTPTS,`:''
    const bounds=legacy?'':`${skip}atrim=duration=${span},apad=whole_dur=${span},atrim=duration=${span},`
    const delay=legacy?'':`,adelay=${Math.round(s.startMs)}:all=1`
    filters.push(`[${input}:a]${bounds}asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=mono${delay}[segment${i}]`)
    labels.push(`[segment${i}]`)
  })
  if(legacy){
    const bounds=duration>0?`,apad,atrim=duration=${duration/1000}`:''
    filters.push(`${labels.join('')}concat=n=${labels.length}:v=0:a=1${bounds}[recording]`)
  }else filters.push(`[0:a]${labels.join('')}amix=inputs=${labels.length+1}:duration=first:normalize=0[recording]`)
  return{inputs,filters,label:'[recording]'}
}

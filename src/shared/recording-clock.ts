/** One recording clock for transcription and video export. Unknown legacy clocks have no measured gaps. */
export function recordingClock(segments: ReadonlyArray<{startMs:number;endMs:number}>) {
  const legacy=segments.every(s=>s.startMs===0 && s.endMs===0)
  const leadingMs=legacy?0:Math.max(0,Math.round(Number(segments[0]?.startMs)||0))
  const silencesMs=segments.map((seg,i)=>{
    if(legacy)return 0
    if(i===0)return leadingMs
    const prevEnd=Number(segments[i-1].endMs),start=Number(seg.startMs)
    return Number.isFinite(prevEnd)&&Number.isFinite(start)?Math.max(0,Math.round(start-prevEnd)):0
  })
  return{legacy,leadingMs,silencesMs}
}

/**
 * The segments that can hold audio on a measured clock. A segment whose recorded span is zero or
 * negative holds none (the 9 Nov incident: nine reconnects while paused, each `start === end`) and is
 * dropped unless its known byte count says otherwise (recovery must measure that file). Legacy 0–0 lists are kept whole, and a segment with unusable times (NaN, a negative start)
 * is kept too, so the timeline still refuses it.
 */
export function audibleSegments<T extends {startMs:number;endMs:number;bytes?:number}>(segments: ReadonlyArray<T>): T[] {
  if(segments.every(s=>s.startMs===0 && s.endMs===0))return [...segments]
  return segments.filter(s=>s.bytes!==undefined&&s.bytes>0||!(Number.isFinite(s.startMs)&&Number.isFinite(s.endMs)&&s.startMs>=0&&s.endMs<=s.startMs))
}

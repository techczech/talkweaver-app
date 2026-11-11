import type { RecordingSession, WordTiming } from '../preload/index.ts'

export type VideoSlide = { id: string; title: string; section: string; layout: string; markdown: string; images: string[]; imageRefs?: Record<string,string>; missingImages?: boolean }
export type VideoRange = { start: number; end: number }
export type VideoWindow = VideoRange & { slideId: string; section: string }

/** The Run clock, including repeated visits; section selection preserves delivery order. */
export function videoWindows(run: Pick<RecordingSession, 'recordingMs' | 'slideTimeIndex'>, slides: VideoSlide[]): VideoWindow[] {
  if (!Number.isFinite(run.recordingMs) || run.recordingMs <= 0) throw new Error('This Run has no recorded duration.')
  const enters = run.slideTimeIndex.filter(m => m.event === 'enter' && Number.isFinite(m.tMs) && m.tMs >= 0 && m.tMs < run.recordingMs).sort((a,b) => a.tMs-b.tMs)
  const byId = new Map(slides.map(s => [s.id,s]))
  return enters.flatMap((m,i) => {
    const slide = byId.get(m.slideId ?? '')
    if (!slide) throw new Error('A slide shown in this Run is missing from the outline.')
    const end = enters[i+1]?.tMs ?? run.recordingMs
    return end > m.tMs ? [{ slideId: slide.id, section: slide.section, start: m.tMs, end }] : []
  })
}

export function selectedVideoRanges(windows: VideoWindow[], duration: number, sections?: string[], trims:VideoRange[]=[]): VideoRange[] {
  if (sections === undefined) return subtractVideoTrims([{ start: 0, end: duration }],trims)
  if (!Array.isArray(sections) || !sections.length || sections.some(s => typeof s !== 'string' || !windows.some(w => w.section === s))) throw new Error('Choose a section recorded in this Run.')
  const out: VideoRange[] = []
  for (const w of windows.filter(w => sections.includes(w.section))) {
    const last = out.at(-1)
    if (last?.end === w.start) last.end = w.end
    else out.push({ start: w.start, end: w.end })
  }
  return subtractVideoTrims(out,trims)
}

/** Subtract saved cuts once, before audio, words and marks share the output clock. */
function subtractVideoTrims(ranges:VideoRange[],trims:VideoRange[]):VideoRange[]{
  let kept=ranges
  for(const trim of trims.filter(t=>Number.isFinite(t.start)&&Number.isFinite(t.end)&&t.end>t.start)){
    kept=kept.flatMap(r=>trim.end<=r.start||trim.start>=r.end?[r]:[
      ...(trim.start>r.start?[{start:r.start,end:trim.start}]:[]),
      ...(trim.end<r.end?[{start:trim.end,end:r.end}]:[])
    ])
  }
  return kept
}

export function onVideoClock(t: number, ranges: VideoRange[]): number | null {
  let offset = 0
  for (const r of ranges) {
    if (t >= r.start && t < r.end) return offset + t-r.start
    offset += r.end-r.start
  }
  return null
}

export function videoWords(words: WordTiming[], ranges: VideoRange[]): WordTiming[] {
  const result: WordTiming[] = []
  const emitted = new Map<WordTiming, WordTiming>()
  let offset = 0
  for (const r of ranges) {
    for (const w of words) if (Number.isFinite(w.start) && Number.isFinite(w.end) && typeof w.text === 'string' && w.end > r.start && w.start < r.end) {
      const end = offset + Math.min(w.end,r.end)-r.start
      const previous = emitted.get(w)
      if (previous) previous.end = end
      else {
        const word = { text: w.text, start: offset + Math.max(w.start,r.start)-r.start, end }
        emitted.set(w, word)
        result.push(word)
      }
    }
    offset += r.end-r.start
  }
  return result.sort((a,b) => a.start-b.start)
}

/** Includes a fresh enter at each cut, so a section starting between marks has a slide at zero. */
export function videoMarks(marks: RecordingSession['slideTimeIndex'], windows: VideoWindow[], ranges: VideoRange[]) {
  const result: Array<Record<string, unknown> & { t: number }> = []
  let offset = 0
  for (const r of ranges) {
    const current = windows.find(w => w.start <= r.start && w.end > r.start)
    if (current && !marks.some(m => m.event === 'enter' && m.tMs === r.start)) result.push({ event:'enter', slideId:current.slideId, t:offset/1000 })
    for (const {tMs, ...m} of marks) if (Number.isFinite(tMs) && tMs >= r.start && tMs < r.end) result.push({...m,t:(offset+tMs-r.start)/1000})
    offset += r.end-r.start
  }
  return result.sort((a,b) => a.t-b.t)
}

export function videoGaps(segments: VideoRange[], ranges: VideoRange[]): VideoRange[] {
  const result: VideoRange[] = []
  for (const r of ranges) {
    let cursor = r.start
    for (const s of [...segments].sort((a,b) => a.start-b.start)) {
      if (s.end <= cursor || s.start >= r.end) continue
      if (s.start > cursor) result.push({start:cursor,end:Math.min(s.start,r.end)})
      cursor = Math.max(cursor,Math.min(s.end,r.end))
    }
    if (cursor < r.end) result.push({start:cursor,end:r.end})
  }
  return result
}

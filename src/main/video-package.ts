import { mkdir, readFile } from 'node:fs/promises'
import { createPackageStage } from './video-package-stage.ts'
import { recordingAudioTimeline } from './recording-audio-timeline.ts'
import { recordingClock } from './transcode-args.ts'
import { randomUUID, createHash } from 'node:crypto'
import { join, extname } from 'node:path'
import { spawn } from 'node:child_process'
import type { RecordingSession, VideoPackRequest, VideoPackResult, VideoPackProgress, WordTimings } from '../preload/index.ts'
import { assertPathInsideVault, resolveTalkTextPaths } from './talkTextPathSafety.ts'
import { videoWindows, selectedVideoRanges, videoMarks, videoWords, videoGaps, type VideoSlide, type VideoRange } from '../shared/video-package-timeline.ts'

export type VideoPackSource = {
  vault: string; talkDir: string; run: RecordingSession; slides: VideoSlide[]; tokensCss: string
  segments: Array<{path: string; startMs: number; endMs: number}>
  ffmpeg: string
  look?: Record<string,unknown>
  words: (signal: AbortSignal) => Promise<WordTimings>
  render: (slides: VideoSlide[], directory: string, signal: AbortSignal, beforeWrite:()=>void) => Promise<Record<string, string>>
}
export type VideoPackDeps = {
  source: (input: VideoPackRequest) => Promise<VideoPackSource>
  /** Only substituted by fixture tests; production always runs the app's resolved ffmpeg. */
  encode?: typeof encodeVideoVoice
}

function check(signal: AbortSignal) { if (signal.aborted) throw new Error('Package cancelled.') }

/** Synthesise silence on the Run clock and place only the Run-owned audio over it. */
export async function encodeVideoVoice(source: VideoPackSource, ranges: VideoRange[], output: string, signal: AbortSignal, beforeWrite:()=>void = ()=>{}): Promise<void> {
  check(signal)
  const timeline=recordingAudioTimeline(source.segments,source.run.recordingMs)
  const args=['-nostdin','-n',...timeline.inputs]
  const filters=[...timeline.filters]
  const splits = ranges.map((_,i) => `[v${i}]`).join('')
  filters.push(`${timeline.label}asplit=${ranges.length}${splits}`)
  ranges.forEach((r,i) => filters.push(`[v${i}]atrim=start=${r.start/1000}:end=${r.end/1000},asetpts=PTS-STARTPTS[c${i}]`))
  filters.push(`${ranges.map((_,i)=>`[c${i}]`).join('')}concat=n=${ranges.length}:v=0:a=1[out]`)
  args.push('-filter_complex',filters.join(';'),'-map','[out]','-c:a','aac','-b:a','192k',output)
  await new Promise<void>((resolve,reject) => {
    beforeWrite()
    const child = spawn(source.ffmpeg,args,{stdio:['ignore','ignore','pipe']})
    let detail = ''
    child.stderr.on('data', b => { detail = (detail+String(b)).slice(-3000) })
    let kill: ReturnType<typeof setTimeout> | undefined
    const cancel = () => { child.kill('SIGTERM'); kill = setTimeout(()=>child.kill('SIGKILL'),2000); kill.unref() }
    signal.addEventListener('abort',cancel,{once:true})
    child.once('error',reject)
    child.once('close',code => {
      signal.removeEventListener('abort',cancel); if (kill) clearTimeout(kill)
      if (signal.aborted) reject(new Error('Package cancelled.'))
      else if (code !== 0) reject(new Error(`The recording could not be prepared: ${detail.trim().split('\n').at(-1) || 'ffmpeg failed.'}`))
      else resolve()
    })
    if (signal.aborted) cancel()
  })
}

/** One private staging directory, one publication rename; published packages are never removed. */
export function createVideoPackage(deps: VideoPackDeps) {
  let active: AbortController | null = null
  return {
    cancel() { active?.abort() },
    async make(input: VideoPackRequest, progress: (p: VideoPackProgress) => void): Promise<VideoPackResult> {
      if (active) return {ok:false,error:'Another video package is being made.'}
      const controller = new AbortController(); active = controller
      const signal = controller.signal
      let stage: ReturnType<typeof createPackageStage> | null = null
      try {
        const source = await deps.source(input); check(signal)
        resolveTalkTextPaths(source.vault,input.talkSlug,input.sessionId)
        const windows = videoWindows(source.run,source.slides)
        const ranges = selectedVideoRanges(windows,source.run.recordingMs,input.sections,source.run.trims)
        const ids = [...new Set(windows.filter(w => ranges.some(r => w.start < r.end && w.end > r.start)).map(w=>w.slideId))]
        const selected = ids.map(id=>source.slides.find(s=>s.id===id)!)
        if (selected.some(s=>s.missingImages)) throw new Error('A picture used in this stretch is missing or is not stored in the vault. Save it to the talk first.')
        if (!selected.length || !source.segments.length) throw new Error('This stretch has no recorded slides or local audio.')
        const root = assertPathInsideVault(source.vault,join(source.talkDir,'video-packs'))
        await mkdir(root,{recursive:true}); check(signal)
        // Capture the staging inode before any long operation; all later writes re-check it.
        stage=createPackageStage(assertPathInsideVault(source.vault,root))
        const folder=stage.path
        for (const d of ['audio','slides','images','look','out']) stage.folder(d)
        progress({step:'audio'}); check(signal)
        await (deps.encode ?? encodeVideoVoice)(source,ranges,join(folder,'audio','voice.m4a'),signal,stage.guard); check(signal);stage.guard()
        progress({step:'words'})
        const words = videoWords((await source.words(signal)).words,ranges); check(signal);stage.guard()
        progress({step:'slides'})
        const pictures = await source.render(selected,join(folder,'slides'),signal,stage.guard); check(signal);stage.guard()
        for (const s of selected) if (!pictures[s.id]) throw new Error(`The picture of slide “${s.title}” could not be made.`)
        progress({step:'images'})
        const imageIndex: Record<string,string> = {}
        const imageNames=new Set<string>()
        for (const path of new Set(selected.flatMap(s=>s.images))) {
          check(signal)
          const safe = assertPathInsideVault(source.vault,path)
          const bytes = await readFile(safe)
          const name = createHash('sha256').update(bytes).digest('hex')+extname(safe).toLowerCase()
          stage.guard()
          if(!imageNames.has(name)){stage.write(`images/${name}`,bytes);imageNames.add(name)}
          imageIndex[path] = `images/${name}`
        }
        for (const s of selected) for (const [ref,path] of Object.entries(s.imageRefs ?? {})) if (imageIndex[path]) imageIndex[ref]=imageIndex[path]
        const durationMs = ranges.reduce((n,r)=>n+r.end-r.start,0)
        const marks = videoMarks(source.run.slideTimeIndex,windows,ranges)
        const gaps = recordingClock(source.segments).legacy?[]:videoGaps(source.segments.map(s=>({start:s.startMs,end:s.endMs})),ranges)
        const prompt = `Make an animated video from this recorded Run: ${source.run.talkTitle}.\nLength: ${(durationMs/1000).toFixed(3)} seconds. Use audio/voice.m4a exactly as recorded. Never use a synthetic or cloned voice unless explicitly asked.\n${!words.length?'This stretch has no transcribed words. Keep its recorded audio; do not add narration.\n':''}Read AGENTS.md and use the animated-talk-video skill. Animate slides marked animate; keep the others as slides. Write the finished MP4 and captions under out/.\n`
        const choices = Object.fromEntries(selected.map(s=>[s.id,input.animate?.[s.id] ?? (['code','image-grid'].includes(s.layout)?'keep':'animate')]))
        if (Object.values(choices).some(v=>v!=='animate' && v!=='keep')) throw new Error('Choose Animate or Keep as slide for each slide.')
        const json = (value:unknown)=>JSON.stringify(value,null,2)+'\n'
        const brief = '# Recorded talk video package\n\nUse the animated-talk-video skill. Inputs are read-only. Write only under out/. Preserve the recorded voice.\n\nmarks.json and words.json use seconds on one output clock. stretch.json maps the original recording to that clock. images/index.json maps original references to local pictures. slides/index.json maps slide ids to PNGs. Use animate.json for the per-slide choices.\n'
        const transcript = selected.map(s=> {
          const visits = windows.filter(w=>w.slideId===s.id)
          const spoken = words.filter(w=>visits.some(v=>ranges.some(r=>{
            const start = Math.max(v.start,r.start); const end = Math.min(v.end,r.end)
            if (start>=end) return false
            const offset = ranges.slice(0,ranges.indexOf(r)).reduce((n,p)=>n+p.end-p.start,0)
            return w.start >= offset+start-r.start && w.start < offset+end-r.start
          }))).map(w=>w.text).join(' ')
          return `## ${s.title}\n\n${spoken}`
        }).join('\n\n')
        const documents: Record<string,string> = {
          'PROMPT.md':prompt,'AGENTS.md':brief,'CLAUDE.md':'@./AGENTS.md\n',
          'outline.md':selected.map(s=>s.markdown || `# ${s.title} {${s.layout}}`).join('\n\n'),
          'marks.json':json(marks),'words.json':json(words.map(w=>({...w,start:w.start/1000,end:w.end/1000}))),
          'animate.json':json(choices),
          'transcript.md':transcript,'look/tokens.css':source.tokensCss,'look/deck.json':json({...source.look,sections:Array.isArray(source.look?.sections)?source.look.sections.filter((s:{slideId?:string})=>selected.some(row=>row.id===s.slideId)):[]}),
          'images/index.json':json(imageIndex),'slides/index.json':json(Object.fromEntries(selected.map(s=>[s.id,`slides/${pictures[s.id]!.split(/[\\/]/).at(-1)}`])))
        }
        for (const [name,body] of Object.entries(documents)) { check(signal); stage.write(name,body) }
        stage.write('stretch.json',json({ranges,durationMs,gaps,sessionId:input.sessionId,createdAt:new Date().toISOString(),sections:input.sections}))
        check(signal)
        const published=assertPathInsideVault(source.vault,join(root,`${input.sessionId}-${input.sections ? 'sections' : 'whole-run'}-${randomUUID()}`))
        stage.publish(published);stage=null
        return {ok:true,folder:published,prompt,durationMs,gaps:gaps.map(g=>({...g,length:g.end-g.start}))}
      } catch (e) {
        stage?.cleanup()
        return {ok:false,error:e instanceof Error?e.message:String(e)}
      } finally { active=null }
    }
  }
}

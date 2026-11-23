// IPC for the Run view's recording panel (slice 3a): open a layered Run, prepare playback, change its
// edits, export it. Only the Tools window may call these. Paths never come from the renderer: a Run is
// named by talk, Run id and vault home, and the export destination is chosen here, in the Mac's save
// panel, so no file is written outside the vault without the owner's own action (verb posture
// "approval" for recording.export). recording.cut / recording.restore are internal functions, not
// registered agent verbs: no recording verb uses the content-verb table yet (agent-verbs.ts holds
// research verbs only).
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { editsPath, listKeptRuns, listSessionJsonFiles, readRecordingSource, recordedSegmentPaths, audibleSegmentPaths } from './recording-paths.ts'
import { createRecordingEditsStore, type EditsSnapshot } from './recording-edits-store.ts'
import { createEvenVolume, createPlaybackPreparer, layersOnVideoClock, createTempRecord, createVideoExporter, removePlaybackCopies, resolvePictureLayers, type ExportState, type MissingLayer, type ResolvedLayers } from './recording-video.ts'
import { recordingFingerprint, type EditOp, type TimeRange } from '../shared/recording-edits.ts'
import { editorWords, planDigest, resolveRecording, type EditorTranscript } from '../shared/recording-editor.ts'
import { faceTrack, faceTrackOnClock, hasPictureLayers, type CaptureLike, type CaptionWord, type ChapterSlide } from '../shared/recording-video.ts'
import { TAKE_STEP_OFF_ERROR, TAKES_OFF_ERROR, takesInUse, type TakeClock } from '../shared/recording-takes.ts'
import { mediaPlaceOf, recordedOnFor, recordedOnOf, type MediaPlace } from '../shared/recording-place.ts'
import { takeEdges } from '../shared/recording-positions.ts'
import { isToolsWindowSender } from './talkTextSender.ts'

export type RecordingRef = { talkSlug: string; runId: string; home?: string | null }
export type RecordingOpen = {
  ok: true
  durationMs: number
  hasPicture: boolean
  hasCamera: boolean
  slides: Array<{ part: number; startMs: number; endMs: number }>
  camera: Array<{ part: number; startMs: number; endMs: number }>
  missing: MissingLayer[]
  runTrims: TimeRange[]
  edits: EditsSnapshot
  /** New takes of this Run's slides (Record this slide again), oldest first; none while it is off. */
  takes: TakeInfo[]
  /** Whether Record one slide again is on in this build (takesEnabled); off, the editor offers nothing of it. */
  recordAgain: boolean
  /** None of the Run's recorded files is on this Mac (0.45): where it is, as far as the Run says. Null when any file is here. */
  away: MediaPlace | null
}
/** A new take of one slide: its own Run, kept beside this one. */
export type TakeInfo = {
  run: string; change: number; slideId: string; durationMs: number; startedAt: string; hasCamera: boolean
  /**
   * The take's own words on its own clock (its transcript, precise word timing where it placed them), every
   * one of them: `timed: false` for a word it could not place, which the row shows and captions carry with its
   * timed neighbour, as for a Run. Null until written out.
   */
  words: Array<{ text: string; start: number; end: number; timed: boolean }> | null
  /** Whether its recorded files are all there (`missing`: a picture or voice file is gone or unreadable). */
  media: 'ok' | 'missing'
}
export type RecordingPlayback = { ok: true; identity: string; voice: string | null; slides: Array<{ url: string; startMs: number; endMs: number; offsetMs?: number; shownFromMs?: number }>; camera: Array<{ url: string; startMs: number; endMs: number; offsetMs?: number; shownFromMs?: number }>; unreadable: MissingLayer[] } | { ok: false; error: string }
/**
 * `revision`: the saved edits the window waited for; `plan`: planDigest of the state the window shows. Main
 * resolves the same from the saved files after its last read and refuses (with `stale: true`) when either
 * differs, so the file is exactly what the screen showed, or nothing.
 */
export type ExportOptions = { captions: boolean; chapterList: boolean; sound: boolean; title?: string; slides?: Record<string, ChapterSlide>; revision?: number; plan?: string; withoutWords?: boolean }
export type WordsRead = { state: 'none' } | { state: 'unreadable' } | { state: 'ok'; transcript: EditorTranscript & { segments?: Array<{ start: number; end: number; text: string }> } }
const UNREADABLE = 'The words for this recording could not be read, so TalkWeaver cannot check the cuts that follow them. You can export without captions: the video then follows the plan without words, which the editor shows first.'
const TAKE_MISSING = 'A new take chosen for a slide cannot be found, or some of its files are missing, so nothing was exported. On that slide, choose Use the first take, or put the take’s files back.'
const STALE = 'What would be exported differs from what the editor shows: the edits, the words or their timing changed. The editor has been refreshed; check it and choose Export again.'
export type ExportProgress = { jobId: string } & ExportState

type Host = {
  ipcMain: { handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void }
  toolsWindow: () => BrowserWindow | null
  userDataDir: () => string
  /** The vault for a Run's read-time home: undefined → the current vault, null → a kept Run (no vault). */
  vaultFor: (home: string | null | undefined) => string | null | undefined
  /** Where the record of unfinished export files lives (in app data). */
  tempRecordFile?: () => string
  /** The transcription setup's quick status: the app's resolved ffmpeg (shipped, or the one set in Settings). */
  readiness: () => { ffmpeg: { found: boolean; path: string | null } }
  /**
   * The Run's words for resolving the plan: `none` when it has no transcript, `unreadable` when one exists
   * but cannot be read (never reported as none), `ok` with the transcript otherwise.
   */
  readTranscript: (vault: string | null, talkSlug: string, runId: string) => Promise<WordsRead>
  showSaveDialog: (win: BrowserWindow | null, options: { title: string; defaultPath: string; filters: Array<{ name: string; extensions: string[] }>; buttonLabel: string }) => Promise<{ canceled: boolean; filePath?: string }>
  reveal: (path: string) => void
  defaultFolder: () => string
  /** Record one slide again (takesEnabled in recording-takes.ts); absent: off. */
  takesEnabled?: () => boolean
  /** The name this computer is listed under, compared with the Mac a Run names (0.45). */
  computerName?: () => string
  /** This app's version, written into every edits save with the computer's name (0.45). */
  appVersion?: () => string
}

const STRING_MAX = 300

/**
 * PR 316's source binding of its edit sidecar (src/main/recording-edits.ts on that branch): a hash of the
 * Run's identity, clock and audio files, plus the Run's folder for version 1. Reproduced here only to
 * decide whether such a sidecar belongs to this recording. Null when it cannot be computed.
 */
export function pr316Source(version: 1 | 2, folder: string, record: Record<string, unknown>, mediaPaths: readonly string[]): string | null {
  try {
    const audio = record.audio as { segments?: unknown; gaps?: unknown; audioMs?: unknown } | null | undefined
    const media = mediaPaths.map((path) => { const st = statSync(path); return [realpathSync(path), st.dev, st.ino, st.size, st.mtimeMs] })
    const parts = [record.id, record.talkSlug, record.startedAt, record.recordingMs, record.slideTimeIndex, audio?.segments, audio?.gaps, audio?.audioMs, media]
    return createHash('sha256').update(JSON.stringify(version === 1 ? [realpathSync(folder), ...parts] : parts)).digest('hex')
  } catch { return null }
}

/** The exported file the owner approved, and whether that exact file may be replaced (the save panel asked). */
export function exportDestination(chosen: string, extension: '.mp4' | '.m4a'): { destination: string; replace: boolean } {
  // The panel may return "lecture.MP4": that is the approved file. Only when the extension is missing is it added,
  // and then the new name was never approved, so an existing file of that name is not replaced.
  return chosen.toLowerCase().endsWith(extension) ? { destination: chosen, replace: true } : { destination: chosen + extension, replace: false }
}

function parseRef(value: unknown): RecordingRef {
  const v = value as RecordingRef | null
  if (!v || typeof v !== 'object' || typeof v.talkSlug !== 'string' || typeof v.runId !== 'string' || (v.home !== undefined && v.home !== null && typeof v.home !== 'string')) throw Error('Choose a recorded Run.')
  return { talkSlug: v.talkSlug, runId: v.runId, home: v.home }
}

export function registerRecordingVideoIpc(host: Host) {
  const takesOn = (): boolean => !!host.takesEnabled?.()
  /** The edits as playback and export use them: take choices ignored (kept in the file) while takes are off. */
  const inUse = (edits: EditsSnapshot): EditsSnapshot => (takesOn() ? edits : { ...edits, edits: { ...edits.edits, takes: takesInUse(false, edits.edits.takes) } })
  const ffmpeg = (): string | null => { const found = host.readiness().ffmpeg; return found.found ? found.path : null }
  const vaultOf = (ref: RecordingRef): string | null => {
    const vault = host.vaultFor(ref.home)
    if (vault === undefined) throw Error('Open this Run’s vault first.')
    return vault
  }
  function runOf(ref: RecordingRef) {
    const vault = vaultOf(ref)
    const source = readRecordingSource(vault, host.userDataDir(), ref.talkSlug, ref.runId)
    if (!source || source.kind !== 'run') throw Error('The recorded Run could not be found.')
    const record = source.record as Record<string, unknown> & { capture?: CaptureLike | null; trims?: TimeRange[]; slideTimeIndex?: Array<{ event: string; tMs: number; slideId?: string }> }
    // Whole milliseconds, as every cut is stored; the recording clock can carry fractions.
    const durationMs = Math.round(Number(record.recordingMs))
    if (!Number.isFinite(durationMs) || durationMs <= 0) throw Error('This Run has no recorded length.')
    return { vault, source, record, durationMs }
  }
  const store = createRecordingEditsStore({
    locate: (key) => {
      const ref = parseRef(key)
      const { vault, source, record, durationMs } = runOf(ref)
      const target = editsPath(vault, host.userDataDir(), ref.talkSlug, ref.runId)
      if (!target.ok) throw Error('This Run’s edits cannot be saved here.')
      const media = recordedSegmentPaths(host.userDataDir(), ref.runId, source).map((s) => s.path)
      return {
        path: target.path, runId: ref.runId, durationMs,
        fingerprint: recordingFingerprint({ id: ref.runId, talkSlug: ref.talkSlug, startedAt: record.startedAt, recordingMs: record.recordingMs }),
        context: { runTrims: Array.isArray(record.trims) ? record.trims : [], legacySource: (version) => pr316Source(version, dirname(target.path), record, media) }
      }
    },
    // Who saves: the same computer name a Run's recordedOn uses, and this version (0.45, second Mac).
    saver: () => ({ mac: recordedOnFor(host.computerName?.())?.computer ?? 'a Mac with no name', app: host.appVersion?.() ?? 'unknown version' }),
    // The edits this Mac last saved or opened, per edits file, so a version a sync replaced is kept on the next open.
    seenDir: () => join(host.userDataDir(), 'recording-edits-seen')
  })
  async function layersOf(ref: RecordingRef): Promise<ResolvedLayers & { here: boolean; runTrims: TimeRange[]; record: ReturnType<typeof runOf>['record']; vault: string | null }> {
    const { vault, source, record, durationMs } = runOf(ref)
    const pictures = resolvePictureLayers(host.userDataDir(), ref.runId, record.capture, durationMs)
    const listed = recordedSegmentPaths(host.userDataDir(), ref.runId, source)
    const missing = [...pictures.missing]
    const declared = Array.isArray((record.audio as { segments?: unknown } | null)?.segments) ? (record.audio as { segments: Array<{ file?: string }> }).segments : []
    for (const seg of declared) if (typeof seg?.file === 'string' && !listed.some((l) => basename(l.path) === seg.file)) missing.push({ layer: 'voice', file: seg.file })
    const tool = ffmpeg()
    const voice = tool ? await audibleSegmentPaths(host.userDataDir(), ref.runId, source, tool) : listed
    // Any recorded file on this Mac, judged by the files themselves (0.45).
    const here = listed.length > 0 || pictures.slides.length > 0 || pictures.camera.length > 0
    return { runId: ref.runId, durationMs, slides: pictures.slides, camera: pictures.camera, voice, missing, here, runTrims: Array.isArray(record.trims) ? record.trims : [], record, vault }
  }
  /** Whether a take's recorded files are all there: its voice and its slides picture, nothing missing. */
  const takeMediaOk = (l: Pick<ResolvedLayers, 'missing' | 'voice' | 'slides'>): boolean => !l.missing.length && l.voice.length > 0 && l.slides.length > 0
  /** The takes recorded for a Run: Runs of the same talk and home that name it in `takeOf`. */
  async function takesOf(ref: RecordingRef): Promise<TakeInfo[]> {
    // Off: no take is discovered, so nothing downstream sees one.
    if (!takesOn()) return []
    const vault = vaultOf(ref)
    // Takes are left out of every list of Runs; this is the one place that asks for them.
    const records: unknown[] = vault ? [] : listKeptRuns(host.userDataDir(), ref.talkSlug, undefined, true)
    if (vault) for (const file of await listSessionJsonFiles(vault, ref.talkSlug)) { try { records.push(JSON.parse(readFileSync(file, 'utf8'))) } catch { /* unreadable: not listed */ } }
    const out: TakeInfo[] = []
    for (const raw of records) {
      const r = raw as { id?: unknown; talkSlug?: unknown; takeOf?: { runId?: unknown; change?: unknown; slideId?: unknown }; recordingMs?: unknown; startedAt?: unknown; capture?: CaptureLike | null }
      if (!r || typeof r !== 'object' || r.talkSlug !== ref.talkSlug || r.takeOf?.runId !== ref.runId || typeof r.id !== 'string' || !Number.isFinite(r.takeOf?.change)) continue
      const durationMs = Math.round(Number(r.recordingMs))
      if (!(durationMs > 0)) continue
      // Its own words, written out after it was saved like any Run's; never another take's.
      let words: TakeInfo['words'] = null
      try {
        const read = await host.readTranscript(vault, ref.talkSlug, r.id)
        if (read.state === 'ok') words = editorWords(read.transcript, durationMs).words.map((w) => ({ text: w.text, start: w.start, end: w.end, timed: w.timed }))
      } catch { /* not written out: no captions for this take yet */ }
      let media: TakeInfo['media'] = 'missing'
      try { if (takeMediaOk(await layersOf({ talkSlug: ref.talkSlug, runId: r.id, home: ref.home }))) media = 'ok' } catch { /* missing */ }
      out.push({ run: r.id, change: Math.round(Number(r.takeOf.change)), slideId: typeof r.takeOf.slideId === 'string' ? r.takeOf.slideId : '', durationMs, startedAt: String(r.startedAt ?? ''), hasCamera: !!r.capture?.layers?.camera?.bytes || !!r.capture?.layers?.camera?.segments?.some((x) => x.bytes > 0), words, media })
    }
    return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  }
  /** The chosen takes that can be played, with their lengths, as the plan takes them. */
  function chosenTakes(edits: EditsSnapshot, takes: TakeInfo[]): Array<{ change: number; run: string; durationMs: number; words: TakeInfo['words'] }> {
    return edits.edits.takes.flatMap((t) => { const found = takes.find((x) => x.run === t.run && x.change === t.change); return found && found.media === 'ok' ? [{ change: t.change, run: t.run, durationMs: found.durationMs, words: found.words }] : [] })
  }
  /** Chosen takes that cannot be played: their Run is gone, or some of its files are. Export waits for them. */
  function unavailableTakes(edits: EditsSnapshot, takes: TakeInfo[]): Array<{ change: number; run: string; reason: 'gone' | 'media' }> {
    return edits.edits.takes.flatMap<{ change: number; run: string; reason: 'gone' | 'media' }>((t) => { const found = takes.find((x) => x.run === t.run && x.change === t.change); return !found ? [{ ...t, reason: 'gone' as const }] : found.media !== 'ok' ? [{ ...t, reason: 'media' as const }] : [] })
  }
  /**
   * A Run's layers on the video clock: its own files split where takes go in, each chosen take's files
   * placed where its take starts, and the voice the same way. Without takes, the Run's layers as they are.
   * `takeMissing`: a chosen take's files, read now, are not all there (never exported as a gap).
   */
  async function layersOnClock(ref: RecordingRef, layers: Awaited<ReturnType<typeof layersOf>>, clock: TakeClock, clockMs: number): Promise<{ layers: ResolvedLayers; takeMissing: boolean }> {
    if (!clock.inserts.length) return { layers, takeMissing: false }
    const takeLayers = new Map<string, Awaited<ReturnType<typeof layersOf>>>()
    let takeMissing = false
    for (const i of clock.inserts) {
      try { const l = await layersOf({ talkSlug: ref.talkSlug, runId: i.run, home: ref.home }); takeLayers.set(i.run, l); if (!takeMediaOk(l)) takeMissing = true } catch { takeMissing = true }
    }
    return { layers: { ...layers, ...layersOnVideoClock(layers, takeLayers, clock, clockMs) }, takeMissing }
  }
  const sender = (event: IpcMainInvokeEvent): boolean => isToolsWindowSender(event.sender, host.toolsWindow())
  const refuse = { ok: false as const, error: 'Open the Run in Studio first.' }
  const failed = (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) })

  host.ipcMain.handle('recording-video:open', async (event, raw) => {
    if (!sender(event)) return refuse
    try {
      const ref = parseRef(raw)
      const layers = await layersOf(ref)
      const result: RecordingOpen = {
        ok: true, durationMs: layers.durationMs,
        hasPicture: hasPictureLayers(layers.record.capture), hasCamera: layers.camera.length > 0,
        slides: layers.slides.map(({ part, startMs, endMs }) => ({ part, startMs, endMs })),
        camera: layers.camera.map(({ part, startMs, endMs }) => ({ part, startMs, endMs })),
        missing: layers.missing, runTrims: layers.runTrims, edits: store.get(ref), takes: await takesOf(ref), recordAgain: takesOn(),
        away: layers.here || (!layers.missing.length && !layers.record.audio) ? null : mediaPlaceOf(false, recordedOnOf(layers.record), host.computerName?.() ?? null)
      }
      return result
    } catch (error) { return failed(error) }
  })

  // One measurement of each voice for even volume, shared by the player's evened copy and the export.
  const even = createEvenVolume({ ffmpeg })
  const preparer = createPlaybackPreparer({ userDataDir: host.userDataDir, ffmpeg, even })
  host.ipcMain.handle('recording-video:prepare', async (event, raw): Promise<RecordingPlayback> => {
    if (!sender(event)) return refuse
    try {
      const ref = parseRef(raw)
      const set = await preparer.prepare(await layersOf(ref))
      const url = (name: string): string => `twrec://${ref.runId}?play=${encodeURIComponent(name)}&copy=${set.identity}`
      return { ok: true, identity: set.identity, voice: set.voice ? url(set.voice) : null, slides: set.slides.map((s) => ({ ...s, url: url(s.name) })), camera: set.camera.map((s) => ({ ...s, url: url(s.name) })), unreadable: set.unreadable }
    } catch (error) { return failed(error) }
  })

  // The evened voice for the player, made on first use (Look and sound › Even out the volume).
  host.ipcMain.handle('recording-video:prepare-even', async (event, raw): Promise<{ ok: true; voice: string | null } | { ok: false; error: string }> => {
    if (!sender(event)) return refuse
    try {
      const ref = parseRef(raw)
      const made = await preparer.prepareEven(await layersOf(ref))
      return { ok: true, voice: made ? `twrec://${ref.runId}?play=${encodeURIComponent(made.name)}&copy=${made.identity}` : null }
    } catch (error) { return failed(error) }
  })

  // The takes of a Run, read again (the editor asks when it comes back from recording one).
  host.ipcMain.handle('recording-video:takes', async (event, raw) => {
    if (!sender(event)) return refuse
    if (!takesOn()) return { ok: false, error: TAKES_OFF_ERROR }
    try { return { ok: true, takes: await takesOf(parseRef(raw)) } } catch (error) { return failed(error) }
  })

  host.ipcMain.handle('recording-video:edit', (event, raw, op, revision, digest) => {
    if (!sender(event)) return refuse
    try {
      if (!Number.isSafeInteger(revision)) throw Error('Reopen the recording to edit it.')
      // Choosing a take (Use this take, Use the first take) is refused while Record one slide again is off.
      if ((op as EditOp | null)?.kind === 'take' && !takesOn()) throw Error(TAKES_OFF_ERROR)
      // So is an Undo or Redo step that would change the take choices kept in the file; other steps work as ever.
      const kind = (op as EditOp | null)?.kind
      if ((kind === 'undo' || kind === 'redo') && !takesOn()) {
        const now = store.read(parseRef(raw)).edits
        const target = (kind === 'undo' ? now.undo : now.redo).at(-1)
        if (target && JSON.stringify(target.takes ?? []) !== JSON.stringify(now.takes ?? [])) throw Error(TAKE_STEP_OFF_ERROR)
      }
      // The bytes the editor's edits came from (0.45): a string, null for "no file yet", anything else is not given.
      const base = typeof digest === 'string' && /^[0-9a-f]{16}$/.test(digest) ? digest : digest === null ? null : undefined
      return { ok: true, edits: store.apply(parseRef(raw), op as EditOp, revision as number, base) }
    } catch (error) { return failed(error) }
  })
  host.ipcMain.handle('recording-video:start-fresh', (event, raw) => {
    if (!sender(event)) return refuse
    try { return { ok: true, edits: store.startFresh(parseRef(raw)) } } catch (error) { return failed(error) }
  })
  // Kept edits (0.45): the copies set aside, one opened read only, one restored as the edits.
  host.ipcMain.handle('recording-video:kept-list', (event, raw) => {
    if (!sender(event)) return refuse
    try { return { ok: true, kept: store.listKept(parseRef(raw)) } } catch (error) { return failed(error) }
  })
  host.ipcMain.handle('recording-video:kept-open', (event, raw, id) => {
    if (!sender(event)) return refuse
    try { return { ok: true, ...store.openKept(parseRef(raw), id) } } catch (error) { return failed(error) }
  })
  host.ipcMain.handle('recording-video:kept-restore', (event, raw, id) => {
    if (!sender(event)) return refuse
    try { return { ok: true, edits: store.restoreKept(parseRef(raw), id) } } catch (error) { return failed(error) }
  })

  const temps = createTempRecord(host.tempRecordFile?.() ?? join(host.userDataDir(), 'recording-export-temps.json'))
  // Files an earlier session left behind (a crash or forced quit during an export): only those it recorded.
  temps.sweep()
  const exporter = createVideoExporter({ ffmpeg, temps, even })
  const finished = new Map<string, string>()
  host.ipcMain.handle('recording-video:export', async (event, raw, rawOptions) => {
    if (!sender(event)) return refuse
    if (exporter.busy()) return { ok: false, error: 'Another video is being exported. Wait for it to finish.' }
    try {
      const ref = parseRef(raw)
      const options = (rawOptions ?? {}) as ExportOptions
      const layers = await layersOf(ref)
      // Words and the takes (their files and their own words), then the sidecar (after the last await),
      // then the plan and its fingerprint. Done before the save panel and again after it, after the last
      // preparation and immediately before the export is scheduled: words, takes or edits that changed
      // meanwhile refuse the export and write nothing.
      const resolveNow = async (): Promise<{ edits: EditsSnapshot; resolved: ReturnType<typeof resolveRecording>; segments: Array<{ start: number; end: number; text: string }> } | { refuse: Record<string, unknown> }> => {
        let words: WordsRead
        try { words = await host.readTranscript(layers.vault, ref.talkSlug, ref.runId) } catch { words = { state: 'unreadable' } }
        const takes = await takesOf(ref)
        if (words.state === 'unreadable' && !options.withoutWords) return { refuse: { ok: false, wordsUnreadable: true, error: UNREADABLE } }
        // "Export without captions" is for words that cannot be read. If they can be read again, the
        // wordless plan is stale: refuse and let the window go back to the plan with its words.
        if (options.withoutWords && words.state === 'ok') return { refuse: { ok: false, stale: true, error: STALE } }
        const transcript = options.withoutWords || words.state !== 'ok' ? null : words.transcript
        const edits = inUse(store.read(ref))
        if (edits.problem) throw Error(`${edits.problem.message} Choose Start new edits first.`)
        // A chosen take that cannot be played is never exported as the first take or as silence.
        if (unavailableTakes(edits, takes).length) return { refuse: { ok: false, error: TAKE_MISSING } }
        // The one resolved edit state (as the window shows it): saved cuts, the Run's Trims, slides left out,
        // moved slide starts, and word times from precise word timing where it placed a word.
        const resolved = resolveRecording({ durationMs: layers.durationMs, edits: edits.edits, runTrims: layers.runTrims, marks: layers.record.slideTimeIndex ?? [], transcript, takes: chosenTakes(edits, takes) })
        const segments = Array.isArray(transcript?.segments) ? transcript.segments : []
        if ((options.revision !== undefined && options.revision !== edits.edits.revision) || (options.plan !== undefined && options.plan !== planDigest(resolved, segments))) return { refuse: { ok: false, stale: true, error: STALE } }
        return { edits, resolved, segments }
      }
      const before = await resolveNow()
      if ('refuse' in before) return before.refuse
      if (before.resolved.editedMs <= 0) throw Error('Nothing is left to export: every part of the recording is cut or left out.')
      const audioOnly = layers.slides.length === 0
      const title = typeof options.title === 'string' ? options.title.slice(0, STRING_MAX) : ref.talkSlug
      const safeName = (title || ref.talkSlug).replace(/[/\\:*?"<>|\0]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'recording'
      const win = host.toolsWindow()
      const chosen = await host.showSaveDialog(win, {
        title: audioOnly ? 'Export sound' : 'Export video',
        defaultPath: `${host.defaultFolder()}/${safeName}.${audioOnly ? 'm4a' : 'mp4'}`,
        filters: audioOnly ? [{ name: 'Sound (M4A)', extensions: ['m4a'] }] : [{ name: 'Video (MP4)', extensions: ['mp4'] }],
        buttonLabel: 'Export'
      })
      if (chosen.canceled || !chosen.filePath) return { ok: false, cancelled: true }
      // The save panel waited on the owner: words, takes or edits may have changed. Resolve again, compose
      // the layers on the video clock (a chosen take's files must all be there), then resolve once more
      // after that last preparation and compare with what the save panel was opened for.
      const mid = await resolveNow()
      if ('refuse' in mid) return mid.refuse
      const composed = await layersOnClock(ref, layers, mid.resolved.clock, mid.resolved.clockMs)
      if (composed.takeMissing) return { ok: false, error: TAKE_MISSING }
      const now = await resolveNow()
      if ('refuse' in now) return now.refuse
      const sameClock = JSON.stringify(now.resolved.clock.inserts) === JSON.stringify(mid.resolved.clock.inserts) && now.resolved.clockMs === mid.resolved.clockMs
      if (!sameClock || now.edits.edits.revision !== before.edits.edits.revision || planDigest(now.resolved, now.segments) !== planDigest(before.resolved, before.segments)) return { ok: false, stale: true, error: STALE }
      const { edits, resolved } = now
      const onClock = composed.layers
      const { destination, replace } = exportDestination(chosen.filePath, audioOnly ? '.m4a' : '.mp4')
      const slides: Record<string, ChapterSlide> = {}
      for (const [id, s] of Object.entries(options.slides ?? {}).slice(0, 5000)) {
        if (!s || typeof s.title !== 'string') continue
        const cards = Array.isArray(s.cards) ? s.cards.filter((c): c is string => typeof c === 'string').slice(0, 500).map((c) => c.slice(0, STRING_MAX)) : []
        slides[id.slice(0, STRING_MAX)] = { title: s.title.slice(0, STRING_MAX), ...(typeof s.section === 'string' ? { section: s.section.slice(0, STRING_MAX) } : {}), ...(cards.length ? { cards } : {}) }
      }
      const jobId = `${ref.runId}:${Date.now()}`
      const target = event.sender
      const send = (state: ExportState): void => { if (!target.isDestroyed()) target.send('recording-video:export-progress', { jobId, ...state } satisfies ExportProgress) }
      // Started after this reply, so the window knows the job before its first progress report.
      // On the video clock (composed above): the Run's layers with each chosen take where its slide starts.
      setImmediate(() => void exporter.run({
        layers: onClock, cuts: resolved.clockCuts, camera: edits.edits.finish.camera, evenVolume: edits.edits.finish.evenVolume, smoothJoins: edits.edits.finish.smoothJoins, edges: takeEdges(resolved.clock), faces: faceTrackOnClock(faceTrack(resolved.rows, edits.edits.faces, layers.durationMs), resolved.clock, edits.edits.faces), replace,
        extras: { captions: !!options.captions && !options.withoutWords, chapterList: !!options.chapterList && !audioOnly, sound: !!options.sound && !audioOnly },
        destination, title, enters: resolved.chapterMarks, slides,
        words: resolved.captionSource === 'words' ? resolved.captionWords : [], segments: resolved.captionSegments
      }, (state) => { if (state.state === 'done') finished.set(jobId, state.file); send(state) }, jobId))
      return { ok: true, jobId, name: basename(destination) }
    } catch (error) { return failed(error) }
  })
  host.ipcMain.handle('recording-video:export-cancel', (event, jobId) => {
    if (!sender(event)) return false
    return exporter.cancel(typeof jobId === 'string' ? jobId : undefined)
  })
  host.ipcMain.handle('recording-video:reveal', (event, jobId) => {
    if (!sender(event) || typeof jobId !== 'string') return false
    const file = finished.get(jobId)
    if (!file) return false
    host.reveal(file)
    return true
  })
  return {
    busy: (): boolean => exporter.busy(),
    /** Stop a running export and wait up to `ms` for it to clean up (used when the app quits). */
    shutdown: (ms: number): Promise<void> => exporter.shutdown(ms),
    /** A deleted Run's derived playback copies go with it. */
    retire: (runId: string): void => removePlaybackCopies(host.userDataDir(), runId)
  }
}

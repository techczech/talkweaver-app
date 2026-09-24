import { memo, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from 'react'
import {
  ArrowDown, ArrowLeft, ArrowUp, BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Download,
  ExternalLink, FilePen, Folder, Globe, LocateFixed, MonitorPlay, PanelLeft, Pause, Pin, Play, Presentation,
  RotateCcw, Save, Search, Sparkles, Wand2, X
} from 'lucide-react'

const PLAYBACK_SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const
import type {
  CleanedSlideItem,
  CleanMode,
  DraftPart,
  NotesPart,
  RecordingSession,
  TalkTextModel
} from '../../../preload/index'
import NotesDocument, { type NotesDisplayPart } from './NotesDocument'
import { diffWords, type DiffToken } from '../lib/wordDiff'
import { buildSlideIndex, createRequestGeneration, createSurfaceRequestGeneration, mergeNoteSources, seekLoadedAudio } from '../lib/talkTextRuntime'
import '../talktext.css'

type Mode = 'notes' | 'script'
type Treatment = 'raw' | 'cleaned'
type Format = 'markdown' | 'plain' | 'rich'
type Session = RecordingSession & { audio: NonNullable<RecordingSession['audio']> }
type DocumentEntry =
  | { kind: 'heading'; node: TalkTextModel['outline'][number]; index: number; slides: number[] }
  | { kind: 'slide'; slide: TalkTextModel['slides'][number] }

const humanDate = (value?: string): string => {
  if (!value) return 'Date not recorded'
  const date = new Date(value.length === 10 ? `${value}T12:00:00` : value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(date)
}

const minutes = (ms: number): string => `${Math.max(0, Math.round(ms / 60000))}m`

const formatTimecode = (ms: number): string => {
  const seconds = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000))
  const hours = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  return hours > 0
    ? `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

const rawTranscript = (slide: TalkTextModel['slides'][number]): string => (
  slide.segments.map((segment) => segment.text).filter(Boolean).join(' ')
)

const descendantSlides = (node: TalkTextModel['outline'][number]): number[] => {
  const own = node.slideNumber === undefined ? [] : [node.slideNumber]
  return [...own, ...node.children.flatMap(descendantSlides)]
}

function documentEntries(model: TalkTextModel): DocumentEntry[] {
  const byNumber = new Map<number, TalkTextModel['slides']>()
  for (const slide of model.slides) byNumber.set(slide.slideNumber, [...(byNumber.get(slide.slideNumber) ?? []), slide])
  const used = new Map<number, number>()
  const entries: DocumentEntry[] = []
  const visit = (node: TalkTextModel['outline'][number], partIndex: number): void => {
    if (node.slideNumber === undefined) {
      entries.push({ kind: 'heading', node, index: partIndex, slides: descendantSlides(node) })
    } else {
      const occurrence = used.get(node.slideNumber) ?? 0
      const slide = byNumber.get(node.slideNumber)?.[occurrence]
      used.set(node.slideNumber, occurrence + 1)
      if (slide) entries.push({ kind: 'slide', slide })
    }
    node.children.forEach((child) => visit(child, partIndex))
  }
  model.outline.forEach((node, index) => visit(node, index + 1))
  return entries
}

function SlideThumbnail({
  url,
  title,
  rendering = false
}: {
  // The resolvable twthumb:// URL from the talk:thumbnails map — NOT reconstructed from the raw
  // render_hash, because the cache filenames are documentId-prefixed and would 404. undefined until
  // the render lands (or if that slide has no render).
  url?: string
  title: string
  rendering?: boolean
}): JSX.Element {
  const [state, setState] = useState<'loading' | 'ok' | 'failed'>(url ? 'loading' : 'failed')
  useEffect(() => { setState(url ? 'loading' : 'failed') }, [url])
  const loading = Boolean(url) && state === 'loading'
  const failed = !url || state === 'failed'
  return (
    <div className="tt-thumb">
      {url && state !== 'failed' ? (
        <img
          key={url}
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setState('ok')}
          onError={() => setState('failed')}
        />
      ) : null}
      {loading || (failed && rendering) ? <div className="tt-thumb-shimmer" aria-hidden="true">{rendering ? <span className="tt-thumb-note">rendering…</span> : null}</div> : null}
      {failed && !rendering ? <div className="tt-thumb-fallback">{title}</div> : null}
    </div>
  )
}

function OutlineTree({
  nodes,
  selectedSlide,
  onSelect
}: {
  nodes: TalkTextModel['outline']
  selectedSlide: number
  onSelect: (slideNumber: number) => void
}): JSX.Element {
  const render = (node: TalkTextModel['outline'][number], path: string): JSX.Element => {
    const slides = descendantSlides(node)
    const target = node.slideNumber ?? slides[0]
    const isLeaf = node.slideNumber !== undefined
    return (
      <div className={isLeaf ? 'tt-toc-leaf' : `tt-toc-branch depth-${Math.min(node.depth, 4)}`} key={path}>
        <button
          className={target === selectedSlide ? 'cur' : ''}
          onClick={() => target !== undefined && onSelect(target)}
          disabled={target === undefined}
        >
          {isLeaf ? <span className="sn">{node.slideNumber}</span> : node.depth === 1 ? <span className="tt-toc-num">{nodes.indexOf(node) + 1}</span> : null}
          <span>{node.title}</span>
          {!isLeaf && slides.length > 0 ? <span className="rng">{Math.min(...slides)}–{Math.max(...slides)}</span> : null}
        </button>
        {node.children.length > 0 ? <div className="tt-toc-children">{node.children.map((child, index) => render(child, `${path}-${index}`))}</div> : null}
      </div>
    )
  }
  return <>{nodes.map((node, index) => render(node, String(index)))}</>
}

function DiffColumn({
  label,
  tone,
  tokens
}: {
  label: string
  tone: 'original' | 'suggested'
  tokens: DiffToken[]
}): JSX.Element {
  return (
    <div className={`tt-diff-col tt-diff-${tone}`}>
      <div className="tt-diff-label">{label}</div>
      {tokens.length === 0
        ? <p className="tt-diff-text tt-diff-empty">Nothing was captured.</p>
        : <p className="tt-diff-text">{tokens.map((token, index) => (
            <span key={index} className={token.kind === 'same' ? undefined : `tt-d-${token.kind}`}>{token.text}{index < tokens.length - 1 ? ' ' : ''}</span>
          ))}</p>}
    </div>
  )
}

interface ScriptSlideTextProps {
  slide: TalkTextModel['slides'][number]
  treatment: Treatment
  cleaned?: CleanedSlideItem
  busy: boolean
  canPrev: boolean
  canNext: boolean
  onApprove: () => void
  onUnapprove: () => void
  onDiscard: () => void
  onSave: (markdown: string, keepApproval: boolean) => Promise<boolean>
  onMove: (direction: 'prev' | 'next', movedText: string, remainingText: string) => Promise<boolean>
  onSeek: () => void
}

const ScriptSlideText = memo(function ScriptSlideText({
  slide,
  treatment,
  cleaned,
  busy,
  canPrev,
  canNext,
  onApprove,
  onUnapprove,
  onDiscard,
  onSave,
  onMove,
  onSeek
}: ScriptSlideTextProps): JSX.Element {
  const raw = rawTranscript(slide)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [sel, setSel] = useState({ start: 0, end: 0 })
  const underReview = Boolean(treatment === 'cleaned' && cleaned && !cleaned.approved)
  const diff = useMemo(
    () => underReview && cleaned ? diffWords(raw, cleaned.markdown) : null,
    [underReview, raw, cleaned?.markdown]
  )

  const startEdit = (seed: string): void => { setDraft(seed); setSel({ start: 0, end: 0 }); setEditing(true) }
  const cancelEdit = (): void => { setEditing(false); setDraft('') }
  const saveEdit = async (): Promise<void> => {
    if (await onSave(draft.trim(), true)) setEditing(false)
  }
  const syncSel = (el: HTMLTextAreaElement): void => setSel({ start: el.selectionStart, end: el.selectionEnd })
  const hasSel = sel.end > sel.start
  const move = async (direction: 'prev' | 'next'): Promise<void> => {
    if (!hasSel) return
    const moved = draft.slice(sel.start, sel.end).trim()
    if (!moved) return
    const remaining = (draft.slice(0, sel.start) + draft.slice(sel.end))
      .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
    if (await onMove(direction, moved, remaining)) setEditing(false)
  }

  if (editing) {
    return <div className="tt-s-text tt-editing">
      <span className="tt-tc">{formatTimecode(slide.startMs)} – {formatTimecode(slide.endMs)}</span>
      <div className="tt-eval tt-eval-edit">
        <DiffColumn label="Original" tone="original" tokens={raw ? [{ text: raw, kind: 'same' }] : []} />
        <div className="tt-diff-col tt-diff-suggested tt-edit-col">
          <div className="tt-diff-label">Editing</div>
          <textarea
            className="tt-edit-area"
            value={draft}
            autoFocus
            spellCheck
            aria-label={`Edit the cleaned text for slide ${slide.slideNumber}`}
            onChange={(e) => { setDraft(e.target.value); syncSel(e.target) }}
            onSelect={(e) => syncSel(e.currentTarget)}
            onKeyUp={(e) => syncSel(e.currentTarget)}
            onMouseUp={(e) => syncSel(e.currentTarget)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit() }
              else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void saveEdit() }
            }}
          />
        </div>
      </div>
      <div className="review-bar tt-clean-review tt-edit-bar">
        <span className="rb-t">Select a run of words, then send it to the slide it belongs on.</span>
        <button className="rb-btn" type="button" disabled={busy || !canPrev || !hasSel} onClick={() => { void move('prev') }} title="Move the selected text to the previous slide"><ArrowUp className="lt-icon" />To previous</button>
        <button className="rb-btn" type="button" disabled={busy || !canNext || !hasSel} onClick={() => { void move('next') }} title="Move the selected text to the next slide"><ArrowDown className="lt-icon" />To next</button>
        <span className="tt-bar-sep" aria-hidden="true" />
        <button className="rb-btn approve" type="button" disabled={busy} onClick={() => { void saveEdit() }}><Save className="lt-icon" />Save</button>
        <button className="rb-btn" type="button" disabled={busy} onClick={cancelEdit}><X className="lt-icon" />Cancel</button>
      </div>
    </div>
  }

  const shown = treatment === 'cleaned' && cleaned?.approved ? cleaned.markdown : raw
  return <div className="tt-s-text">
    <button type="button" className="tt-tc tt-tc-seek" onClick={onSeek} title="Play the recording from here">{formatTimecode(slide.startMs)} – {formatTimecode(slide.endMs)}</button>
    {treatment === 'cleaned' ? <div className="tt-clean-state">
      {cleaned?.approved ? <>
        <span className="pchip ok"><Check className="lt-icon" />Cleaned</span>
        <button className="pchip-action" type="button" disabled={busy} onClick={onUnapprove} title="Return this slide to the side-by-side review"><RotateCcw className="lt-icon" />Review again</button>
        <button className="pchip-action edit" type="button" disabled={busy} onClick={() => startEdit(cleaned.markdown)} title="Edit this slide's text in place"><FilePen className="lt-icon" />Edit</button>
      </> : cleaned ? <span className="pchip draft">Draft · evaluate below</span> : <>
        <span className="pchip raw">Raw fallback · not cleaned</span>
        <button className="pchip-action edit" type="button" disabled={busy} onClick={() => startEdit(raw)} title="Clean this slide by hand — starts from the raw transcript"><FilePen className="lt-icon" />Edit</button>
      </>}
    </div> : null}
    {diff && cleaned ? <>
      <div className="tt-eval" role="group" aria-label={`Compare the cleaned text for slide ${slide.slideNumber} against the original`}>
        <DiffColumn label="Original" tone="original" tokens={diff.original} />
        <DiffColumn label="Suggested" tone="suggested" tokens={diff.suggested} />
      </div>
      <div className="review-bar tt-clean-review">
        <span className="rb-t">A faithful tidy-up? <span className="tt-leg del">dropped</span> · <span className="tt-leg add">new</span></span>
        <button className="rb-btn approve" type="button" disabled={busy} onClick={onApprove}><Check className="lt-icon" />Approve</button>
        <button className="rb-btn discard" type="button" disabled={busy} onClick={onDiscard}><X className="lt-icon" />Reject</button>
        <button className="rb-btn" type="button" disabled={busy} onClick={() => startEdit(cleaned.markdown)}><FilePen className="lt-icon" />Edit</button>
      </div>
    </> : <>
      {shown.split(/\n\s*\n/).filter(Boolean).map((paragraph, paragraphIndex) => <p key={paragraphIndex}>{paragraph}</p>)}
      {!shown ? <p className="tt-silence">No spoken words were captured during this slide.</p> : null}
    </>}
  </div>
}, (previous, next) => (
  previous.slide === next.slide &&
  previous.treatment === next.treatment &&
  previous.cleaned === next.cleaned &&
  previous.busy === next.busy &&
  previous.canPrev === next.canPrev &&
  previous.canNext === next.canNext
))

function PlaybackController({
  visible,
  active,
  slides,
  audioRef,
  curMsRef,
  durMsRef,
  playing,
  speedIdx,
  follow,
  onTogglePlay,
  onCycleSpeed,
  onToggleFollow,
  onSeek,
  onPlayingChange,
  onPlayingNumberChange,
  onShowSlide
}: {
  visible: boolean
  active: Session | null
  slides: TalkTextModel['slides']
  audioRef: RefObject<HTMLAudioElement>
  curMsRef: MutableRefObject<number>
  durMsRef: MutableRefObject<number>
  playing: boolean
  speedIdx: number
  follow: boolean
  onTogglePlay: () => void
  onCycleSpeed: () => void
  onToggleFollow: () => void
  onSeek: (ms: number) => void
  onPlayingChange: (playing: boolean) => void
  onPlayingNumberChange: (slideNumber: number | null) => void
  onShowSlide: (slideNumber: number) => void
}): JSX.Element {
  const [curMs, setCurMs] = useState(0)
  const [durMs, setDurMs] = useState(active?.recordingMs ?? 0)
  const playingIndexRef = useRef(-1)
  const playingNumberRef = useRef<number | null>(null)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !active) return
    audio.src = `twrec://${active.id}`
    audio.load()
    curMsRef.current = 0
    durMsRef.current = active.recordingMs ?? 0
    playingIndexRef.current = -1
    playingNumberRef.current = null
    setCurMs(0)
    setDurMs(durMsRef.current)
    onPlayingChange(false)
    onPlayingNumberChange(null)
  }, [active, audioRef, curMsRef, durMsRef, onPlayingChange, onPlayingNumberChange])

  const updateProgress = (nextMs: number): void => {
    curMsRef.current = nextMs
    setCurMs(nextMs)
    const currentSlide = slides[playingIndexRef.current]
    if (!currentSlide || nextMs < currentSlide.startMs || nextMs >= currentSlide.endMs) {
      playingIndexRef.current = slides.findIndex((slide) => nextMs >= slide.startMs && nextMs < slide.endMs)
    }
    const nextNumber = slides[playingIndexRef.current]?.slideNumber ?? null
    if (nextNumber !== playingNumberRef.current) {
      playingNumberRef.current = nextNumber
      onPlayingNumberChange(nextNumber)
    }
  }

  return <>
    <audio
      ref={audioRef}
      preload="auto"
      onTimeUpdate={(event) => updateProgress(event.currentTarget.currentTime * 1000)}
      onLoadedMetadata={(event) => {
        const duration = event.currentTarget.duration
        const nextDuration = Number.isFinite(duration) && duration > 0 ? duration * 1000 : (active?.recordingMs ?? 0)
        durMsRef.current = nextDuration
        setDurMs(nextDuration)
      }}
      onPlay={() => onPlayingChange(true)}
      onPause={() => onPlayingChange(false)}
      onEnded={() => onPlayingChange(false)}
    />
    {visible && active ? <div className="tt-player" role="group" aria-label="Recording playback">
      <button className="tt-play" type="button" onClick={onTogglePlay} aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (Space)' : 'Play (Space)'}>{playing ? <Pause className="lt-icon" /> : <Play className="lt-icon" />}</button>
      <span className="tt-time">{formatTimecode(curMs)}</span>
      <div
        className="tt-scrub"
        role="slider"
        tabIndex={0}
        aria-label="Seek recording"
        aria-valuemin={0}
        aria-valuemax={Math.round(durMs / 1000)}
        aria-valuenow={Math.round(curMs / 1000)}
        onKeyDown={(event) => { if (event.key === 'ArrowLeft') { event.preventDefault(); onSeek(curMs - 5000) } else if (event.key === 'ArrowRight') { event.preventDefault(); onSeek(curMs + 5000) } }}
        onMouseDown={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          const fraction = (clientX: number): number => Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
          onSeek(fraction(event.clientX) * durMs)
          const onMove = (moveEvent: MouseEvent): void => onSeek(fraction(moveEvent.clientX) * durMs)
          const onUp = (): void => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
          window.addEventListener('mousemove', onMove)
          window.addEventListener('mouseup', onUp)
        }}
      >
        <div className="tt-scrub-fill" style={{ width: durMs ? `${(curMs / durMs) * 100}%` : '0%' }} />
        <div className="tt-scrub-head" style={{ left: durMs ? `${(curMs / durMs) * 100}%` : '0%' }} />
      </div>
      <span className="tt-time tt-dur">{formatTimecode(durMs)}</span>
      <button className="tt-pill-btn" type="button" onClick={onCycleSpeed} title="Playback speed">{PLAYBACK_SPEEDS[speedIdx]}×</button>
      <button className={`tt-pill-btn ${follow ? 'on' : ''}`} type="button" onClick={onToggleFollow} aria-pressed={follow} title="Keep the slide being spoken in view as it plays"><LocateFixed className="lt-icon" />Follow</button>
      {playingNumberRef.current != null ? <button className="tt-nowslide" type="button" onClick={() => onShowSlide(playingNumberRef.current as number)} title="Jump to the slide now playing">Slide {playingNumberRef.current}</button> : null}
    </div> : null}
  </>
}

export default function TalkText({
  isOpen,
  sessionId,
  onBackToStudio,
  onClose
}: {
  isOpen: boolean
  sessionId: string | null
  onBackToStudio: (sessionId?: string) => void
  onClose: () => void
}): JSX.Element | null {
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeId, setActiveId] = useState<string | null>(sessionId)
  const [model, setModel] = useState<TalkTextModel | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [mode, setMode] = useState<Mode>('script')
  const [treatment, setTreatment] = useState<Treatment>('raw')
  const [format, setFormat] = useState<Format>('markdown')
  const [include, setInclude] = useState({ references: true, timecodes: false })
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerQuery, setPickerQuery] = useState('')
  const [formatOpen, setFormatOpen] = useState(false)
  const [rewriteOpen, setRewriteOpen] = useState(false)
  const [cleanOpen, setCleanOpen] = useState(false)
  const [cleanMode, setCleanMode] = useState<CleanMode>('section')
  const [cleanSlides, setCleanSlides] = useState<number[]>([])
  const [cleanPrepared, setCleanPrepared] = useState(false)
  const [cleanedDir, setCleanedDir] = useState<string | null>(null)
  const [cleanBusy, setCleanBusy] = useState(false)
  const [cleanError, setCleanError] = useState<string | null>(null)
  const [helpOpen, setHelpOpen] = useState(false)
  const [packDir, setPackDir] = useState<string | null>(null)
  const [packBusy, setPackBusy] = useState(false)
  const [packError, setPackError] = useState(false)
  const [selectedSlide, setSelectedSlide] = useState(1)
  const [previewVisible, setPreviewVisible] = useState(true)
  const [previewPinned, setPreviewPinned] = useState(true)
  const [toast, setToast] = useState<{ message: string; action?: () => void } | null>(null)
  const [draftParts, setDraftParts] = useState<DraftPart[]>([])
  const [approvedParts, setApprovedParts] = useState<NotesPart[]>([])
  const [notesLoading, setNotesLoading] = useState(false)
  const [notesError, setNotesError] = useState(false)
  const [busyPart, setBusyPart] = useState<string | null>(null)
  const [cleanedSlides, setCleanedSlides] = useState<CleanedSlideItem[]>([])
  const [cleanLoading, setCleanLoading] = useState(false)
  const [cleanListError, setCleanListError] = useState(false)
  const [busyCleanSlide, setBusyCleanSlide] = useState<number | null>(null)
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({})
  const [thumbsRendering, setThumbsRendering] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [playingNumber, setPlayingNumber] = useState<number | null>(null)
  const [speedIdx, setSpeedIdx] = useState(1)
  const [follow, setFollow] = useState(false)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const curMsRef = useRef(0)
  const durMsRef = useRef(0)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const partSlugs = useRef<string[]>([])
  const requestGeneration = useRef(createRequestGeneration())
  const notesGeneration = useRef(createSurfaceRequestGeneration())
  const cleanGeneration = useRef(createSurfaceRequestGeneration())
  const activeSessionId = useRef<string | null>(sessionId)

  const flash = useCallback((message: string, action?: () => void): void => {
    setToast({ message, action })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = action ? null : setTimeout(() => setToast(null), 2600)
  }, [])

  const load = useCallback(async (requestedId?: string | null): Promise<void> => {
    const generation = requestGeneration.current.begin()
    notesGeneration.current.invalidate()
    cleanGeneration.current.invalidate()
    activeSessionId.current = requestedId ?? null
    setLoading(true)
    setLoadError(false)
    setModel(null)
    setDraftParts([])
    setApprovedParts([])
    setCleanedSlides([])
    setCleanListError(false)
    setNotesError(false)
    setNotesLoading(false)
    setCleanLoading(false)
    setToast(null)
    partSlugs.current = []
    try {
      const all = await window.tw.recording.listAllSessions()
      const recorded = all.filter((item): item is Session => (
        item != null && typeof item.id === 'string' && typeof item.startedAt === 'string' && item.audio != null
      ))
      const active = recorded.find((item) => item.id === requestedId) ?? recorded[0]
      if (!requestGeneration.current.commit(generation, () => {
        activeSessionId.current = active?.id ?? null
        setSessions(recorded)
        setActiveId(active?.id ?? null)
      })) return
      if (!active) {
        return
      }
      const next = await window.tw.talktext.model(active.talkSlug, active.id)
      requestGeneration.current.commit(generation, () => {
        setModel(next)
        setSelectedSlide(next?.slides[0]?.slideNumber ?? 1)
      })
    } catch {
      requestGeneration.current.commit(generation, () => {
        setModel(null)
        setLoadError(true)
      })
    } finally {
      requestGeneration.current.commit(generation, () => setLoading(false))
    }
  }, [])

  useEffect(() => {
    if (!isOpen) {
      requestGeneration.current.begin()
      notesGeneration.current.invalidate()
      cleanGeneration.current.invalidate()
      activeSessionId.current = null
      setNotesLoading(false)
      setCleanLoading(false)
      return
    }
    void load(sessionId)
  }, [isOpen, sessionId, load])

  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current) }, [])

  useEffect(() => {
    if (!isOpen) return
    void window.tw.app.version().then(setAppVersion).catch(() => setAppVersion(null))
  }, [isOpen])

  const active = useMemo(() => sessions.find((item) => item.id === activeId) ?? null, [sessions, activeId])
  const currentSlide = model?.slides.find((slide) => slide.slideNumber === selectedSlide) ?? model?.slides[0] ?? null
  const entries = useMemo(() => model ? documentEntries(model) : [], [model])
  const filteredSessions = useMemo(() => {
    const query = pickerQuery.trim().toLocaleLowerCase('en-GB')
    return query ? sessions.filter((item) => `${item.talkTitle} ${item.context ?? ''} ${item.startedAt}`.toLocaleLowerCase('en-GB').includes(query)) : sessions
  }, [sessions, pickerQuery])

  const refreshNotes = useCallback(async (quiet = false): Promise<DraftPart[] | null> => {
    if (!active) return null
    const generation = notesGeneration.current.begin(!quiet, setNotesLoading)
    const commit = (action: () => void): boolean => (
      activeSessionId.current === active.id && notesGeneration.current.commit(generation, action)
    )
    setNotesError(false)
    try {
      const [drafts, notes] = await Promise.all([
        window.tw.rewrite.listParts(active.talkSlug, active.id),
        window.tw.rewrite.notes(active.talkSlug, active.id)
      ])
      if (!notes) throw new Error('notes-unavailable')
      const committed = commit(() => {
        setDraftParts(drafts)
        setApprovedParts(notes.parts)
        partSlugs.current = drafts.map((part) => part.slug)
      })
      return committed ? drafts : null
    } catch {
      commit(() => {
        setNotesError(true)
        if (quiet) flash('Notes could not be refreshed. Try again.')
      })
      return null
    } finally {
      if (activeSessionId.current === active.id) notesGeneration.current.settle(generation, setNotesLoading)
    }
  }, [active, flash])

  const refreshCleaned = useCallback(async (quiet = false): Promise<CleanedSlideItem[] | null> => {
    if (!active) return null
    const generation = cleanGeneration.current.begin(!quiet, setCleanLoading)
    const commit = (action: () => void): boolean => (
      activeSessionId.current === active.id && cleanGeneration.current.commit(generation, action)
    )
    setCleanListError(false)
    try {
      const slides = await window.tw.clean.list(active.talkSlug, active.id)
      const committed = commit(() => setCleanedSlides(slides))
      return committed ? slides : null
    } catch {
      commit(() => {
        setCleanListError(true)
        if (quiet) flash('Cleaned slides could not be refreshed. Try again.')
      })
      return null
    } finally {
      if (activeSessionId.current === active.id) cleanGeneration.current.settle(generation, setCleanLoading)
    }
  }, [active, flash])

  useEffect(() => {
    if (!isOpen || !active || !model) return
    void refreshNotes()
    void refreshCleaned()
  }, [isOpen, active, model, refreshNotes, refreshCleaned])

  useEffect(() => {
    if (!isOpen || mode !== 'notes' || !active) return
    void refreshNotes(true)
    return window.tw.rewrite.onPartsChanged((payload) => {
      if (payload.talkSlug !== active.talkSlug || payload.sessionId !== active.id) return
      const previous = new Set(partSlugs.current)
      void refreshNotes(true).then((next) => {
        if (next?.some((part) => !previous.has(part.slug))) flash('A new part arrived')
      })
    })
  }, [isOpen, mode, active, refreshNotes, flash])

  useEffect(() => {
    if (!isOpen || !active) return
    return window.tw.clean.onChanged((payload) => {
      if (payload.talkSlug === active.talkSlug && payload.sessionId === active.id) void refreshCleaned(true)
    })
  }, [isOpen, active, refreshCleaned])

  // Real slide renders: the thumbnail cache is only built when a talk is opened in the editor, and its
  // PNG filenames are documentId-prefixed — so we can't reconstruct the URL from render_hash. Trigger
  // the same render Studio uses and keep the returned map (render_hash → resolvable twthumb:// URL),
  // which is authoritative regardless of the on-disk naming scheme.
  useEffect(() => {
    if (!isOpen || !model) return
    let cancelled = false
    setThumbsRendering(true)
    setThumbUrls({})
    void (async () => {
      try {
        const talks = await window.tw.vault.listTalks()
        const talk = talks?.find((item) => item.slug === model.meta.talkSlug)
        if (!talk) return
        const content = await window.tw.talk.readOutline(talk.outlinePath)
        if (content == null) return
        const map = await window.tw.talk.thumbnails(talk.outlinePath, content)
        if (!cancelled && map) setThumbUrls(map)
      } catch {
        /* thumbnails are best-effort — the title fallback stays if a render is unavailable */
      } finally {
        if (!cancelled) setThumbsRendering(false)
      }
    })()
    return () => { cancelled = true }
  }, [isOpen, model])

  const noteSources = useMemo(
    () => mergeNoteSources(draftParts, approvedParts),
    [draftParts, approvedParts]
  )
  const notesParts = useMemo((): NotesDisplayPart[] => {
    if (!model) return []
    return noteSources.flatMap((source) => {
      const node = model.outline[source.order - 1]
      if (!node) return []
      return [{
        slug: source.slug,
        markdown: source.markdown,
        approved: source.approved,
        node,
        index: source.order,
        slides: descendantSlides(node)
      }]
    })
  }, [model, noteSources])

  const approvedCount = notesParts.filter((part) => part.approved).length
  const reviewCount = notesParts.length - approvedCount
  const cleanedByNumber = useMemo(
    () => new Map(cleanedSlides.map((slide) => [slide.slideNumber, slide])),
    [cleanedSlides]
  )
  const cleanedCount = cleanedSlides.filter((slide) => slide.approved).length
  const totalSlideCount = model ? new Set(model.slides.map((slide) => slide.slideNumber)).size : 0
  const orderedNumbers = useMemo(
    () => model ? [...new Set(model.slides.map((slide) => slide.slideNumber))].sort((a, b) => a - b) : [],
    [model]
  )
  const slideIndex = useMemo(() => buildSlideIndex(orderedNumbers), [orderedNumbers])

  const seekToMs = useCallback((ms: number): void => {
    const audio = audioRef.current
    if (!audio) return
    const clamped = Math.max(0, durMsRef.current ? Math.min(durMsRef.current, ms) : ms)
    audio.currentTime = clamped / 1000
    curMsRef.current = clamped
  }, [])

  const seekToSlideStart = useCallback((ms: number): void => {
    if (!seekLoadedAudio(audioRef.current, ms, durMsRef.current)) return
    curMsRef.current = Math.max(0, durMsRef.current ? Math.min(durMsRef.current, ms) : ms)
  }, [])

  const showSlide = useCallback((number: number): void => {
    if (!model?.slides.some((slide) => slide.slideNumber === number)) return
    setSelectedSlide(number)
    setPreviewVisible(true)
    document.getElementById(`tt-slide-${number}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [model])

  const navigateToSlide = useCallback((number: number, startMs?: number): void => {
    const slide = model?.slides.find((candidate) => candidate.slideNumber === number)
    if (!slide) return
    showSlide(number)
    seekToSlideStart(startMs ?? slide.startMs)
  }, [model, seekToSlideStart, showSlide])

  const stepSlide = useCallback((delta: number): void => {
    if (!orderedNumbers.length) return
    const index = slideIndex.get(selectedSlide) ?? 0
    navigateToSlide(orderedNumbers[Math.max(0, Math.min(orderedNumbers.length - 1, index + delta))])
  }, [orderedNumbers, slideIndex, selectedSlide, navigateToSlide])

  const exportText = useCallback(async (): Promise<string | null> => {
    if (!active || !model) return null
    try {
      return await window.tw.talktext.export(active.talkSlug, active.id, {
        mode,
        treatment,
        format,
        timecodes: include.timecodes,
        references: include.references
      })
    } catch {
      flash('The text could not be prepared. Try again.')
      return null
    }
  }, [active, model, mode, treatment, format, include, flash])

  const copyText = useCallback(async (): Promise<void> => {
    const text = await exportText()
    if (text === null) return
    try {
      await navigator.clipboard.writeText(text)
      flash('Copied to the clipboard')
    } catch {
      flash('Clipboard access was unavailable. Use Save… instead.')
    }
  }, [exportText, flash])

  const saveText = useCallback(async (): Promise<void> => {
    const text = await exportText()
    if (text === null || !model) return
    const extension = format === 'markdown' ? 'md' : format === 'rich' ? 'html' : 'txt'
    const blob = new Blob([text], { type: format === 'rich' ? 'text/html;charset=utf-8' : 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${model.meta.talkSlug}-${mode}.${extension}`
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
    flash('Saved to Downloads')
  }, [exportText, format, model, mode, flash])

  const openRewrite = useCallback((): void => {
    setRewriteOpen(true)
    setPackBusy(true)
    setPackError(false)
    setPackDir(null)
    if (!active) { setPackBusy(false); setPackError(true); return }
    void window.tw.rewrite.preparePack(active.talkSlug, active.id).then((result) => {
      if (result.ok && result.packDir) setPackDir(result.packDir)
      else setPackError(true)
    }).catch(() => setPackError(true)).finally(() => setPackBusy(false))
  }, [active])

  const openClean = useCallback((): void => {
    setCleanOpen(true)
    setCleanPrepared(false)
    setCleanedDir(null)
    setCleanError(null)
    setCleanBusy(false)
  }, [])

  const prepareClean = useCallback(async (): Promise<void> => {
    if (!active) return
    if (cleanMode === 'perslide' && cleanSlides.length === 0) {
      setCleanError('Choose at least one slide to clean.')
      return
    }
    setCleanBusy(true)
    setCleanError(null)
    try {
      const result = await window.tw.clean.prepare(active.talkSlug, active.id, {
        mode: cleanMode,
        slides: cleanMode === 'perslide' ? cleanSlides : undefined
      })
      if (!result.ok || !result.cleanedDir) {
        setCleanError(result.error === 'clean-slides-required'
          ? 'Choose at least one slide to clean.'
          : 'The clean pack could not be prepared. Check the recording and try again.')
        return
      }
      setCleanedDir(result.cleanedDir)
      setCleanPrepared(true)
      flash('Clean pack prepared')
    } catch {
      setCleanError('The clean pack could not be prepared. Check the recording and try again.')
    } finally {
      setCleanBusy(false)
    }
  }, [active, cleanMode, cleanSlides, flash])

  const setPartApproval = useCallback(async (slug: string, approved: boolean): Promise<void> => {
    if (!active) return
    setBusyPart(slug)
    try {
      const result = approved
        ? await window.tw.rewrite.approvePart(active.talkSlug, active.id, slug)
        : await window.tw.rewrite.unapprovePart(active.talkSlug, active.id, slug)
      if (!result.ok) {
        flash(approved ? 'This part could not be approved. Try again.' : 'This part could not be returned to review. Try again.')
        return
      }
      await refreshNotes(true)
      flash(approved ? 'Part approved' : 'Part returned to review')
    } catch {
      flash(approved ? 'This part could not be approved. Try again.' : 'This part could not be returned to review. Try again.')
    } finally {
      setBusyPart(null)
    }
  }, [active, refreshNotes, flash])

  const editPart = useCallback(async (slug: string): Promise<void> => {
    if (!active) return
    setBusyPart(slug)
    try {
      const opened = await window.tw.rewrite.openPart(active.talkSlug, active.id, slug)
      if (!opened) flash('The part file could not be opened. Reveal the rewrite folder and try again.')
    } catch {
      flash('The part file could not be opened. Reveal the rewrite folder and try again.')
    } finally {
      setBusyPart(null)
    }
  }, [active, flash])

  const discardPart = useCallback(async (slug: string): Promise<void> => {
    if (!active || !window.confirm('Discard this draft? The agent can redraw it by writing the part again.')) return
    setBusyPart(slug)
    try {
      const result = await window.tw.rewrite.discardPart(active.talkSlug, active.id, slug)
      if (!result.ok) {
        flash('The draft could not be discarded. Try again.')
        return
      }
      await refreshNotes(true)
      flash('Draft discarded — the agent can redraw it')
    } catch {
      flash('The draft could not be discarded. Try again.')
    } finally {
      setBusyPart(null)
    }
  }, [active, refreshNotes, flash])

  const setCleanApproval = useCallback(async (slideNumber: number, approved: boolean): Promise<void> => {
    if (!active) return
    setBusyCleanSlide(slideNumber)
    try {
      const result = approved
        ? await window.tw.clean.approve(active.talkSlug, active.id, slideNumber)
        : await window.tw.clean.unapprove(active.talkSlug, active.id, slideNumber)
      if (!result.ok) {
        flash(approved ? 'This cleaned slide could not be approved. Try again.' : 'This slide could not be returned to review. Try again.')
        return
      }
      await refreshCleaned(true)
      flash(approved ? `Slide ${slideNumber} approved` : `Slide ${slideNumber} returned to review`)
    } catch {
      flash(approved ? 'This cleaned slide could not be approved. Try again.' : 'This slide could not be returned to review. Try again.')
    } finally {
      setBusyCleanSlide(null)
    }
  }, [active, refreshCleaned, flash])

  const saveCleaned = useCallback(async (slideNumber: number, markdown: string, keepApproval: boolean): Promise<boolean> => {
    if (!active || !model) return false
    const slide = model.slides.find((candidate) => candidate.slideNumber === slideNumber)
    const existingMarkdown = cleanedByNumber.get(slideNumber)?.markdown ?? (slide ? rawTranscript(slide) : '')
    const allowEmpty = !markdown.trim() && Boolean(existingMarkdown.trim())
    if (allowEmpty && !window.confirm('Clear slide text? This will replace the current cleaned text with an empty slide.')) return false
    setBusyCleanSlide(slideNumber)
    try {
      const result = await window.tw.clean.save(active.talkSlug, active.id, slideNumber, markdown, keepApproval, allowEmpty)
      if (!result.ok) { flash('This slide could not be saved. Try again.'); return false }
      await refreshCleaned(true)
      flash(`Slide ${slideNumber} saved`)
      return true
    } catch {
      flash('This slide could not be saved. Try again.')
      return false
    } finally {
      setBusyCleanSlide(null)
    }
  }, [active, model, cleanedByNumber, refreshCleaned, flash])

  const undoMove = useCallback(async (): Promise<void> => {
    if (!active) return
    setToast(null)
    try {
      const result = await window.tw.clean.undoMove(active.talkSlug, active.id)
      if (!result.ok) {
        flash(result.error === 'undo-stale'
          ? 'Undo is no longer available because the slides changed since the move.'
          : 'The move could not be undone. The slides were left unchanged.')
        return
      }
      await refreshCleaned(true)
      flash('Move undone')
    } catch {
      flash('The move could not be undone. The slides were left unchanged.')
    }
  }, [active, refreshCleaned, flash])

  const moveCleaned = useCallback(async (
    slideNumber: number,
    direction: 'prev' | 'next',
    movedText: string,
    remainingText: string
  ): Promise<boolean> => {
    if (!active || !model) return false
    const idx = slideIndex.get(slideNumber) ?? -1
    const adj = orderedNumbers[idx + (direction === 'next' ? 1 : -1)]
    const adjSlide = model.slides.find((slide) => slide.slideNumber === adj)
    if (adj === undefined || !adjSlide) return false
    const adjCurrent = (cleanedByNumber.get(adj)?.markdown ?? rawTranscript(adjSlide)).trim()
    const adjNext = (direction === 'next' ? `${movedText}\n\n${adjCurrent}` : `${adjCurrent}\n\n${movedText}`).trim()
    setBusyCleanSlide(slideNumber)
    try {
      const result = await window.tw.clean.move(
        active.talkSlug,
        active.id,
        { slideNumber, markdown: remainingText },
        { slideNumber: adj, markdown: adjNext }
      )
      if (!result.ok) { flash('The move could not be completed. Try again.'); return false }
      await refreshCleaned(true)
      flash(`Moved to slide ${adj} —`, () => { void undoMove() })
      return true
    } catch {
      flash('The move could not be completed. Try again.')
      return false
    } finally {
      setBusyCleanSlide(null)
    }
  }, [active, model, orderedNumbers, slideIndex, cleanedByNumber, refreshCleaned, flash, undoMove])

  const togglePlay = useCallback((): void => {
    const audio = audioRef.current
    if (!audio || !active) return
    if (audio.paused) { audio.playbackRate = PLAYBACK_SPEEDS[speedIdx]; void audio.play().catch(() => flash('This recording could not be played. It may only be in R2.')) }
    else audio.pause()
  }, [active, speedIdx, flash])

  const cycleSpeed = useCallback((): void => {
    setSpeedIdx((idx) => {
      const next = (idx + 1) % PLAYBACK_SPEEDS.length
      if (audioRef.current) audioRef.current.playbackRate = PLAYBACK_SPEEDS[next]
      return next
    })
  }, [])

  // Follow mode: keep the slide being spoken in view as the recording plays (opt-in, off by default).
  useEffect(() => {
    if (!follow || !playing || playingNumber == null) return
    showSlide(playingNumber)
  }, [follow, playing, playingNumber, showSlide])

  const discardCleaned = useCallback(async (slideNumber: number): Promise<void> => {
    if (!active || !window.confirm(`Discard the cleaned draft for slide ${slideNumber}? Raw text will remain available.`)) return
    setBusyCleanSlide(slideNumber)
    try {
      const result = await window.tw.clean.discard(active.talkSlug, active.id, slideNumber)
      if (!result.ok) {
        flash('The cleaned draft could not be discarded. Try again.')
        return
      }
      await refreshCleaned(true)
      flash(`Slide ${slideNumber} returned to Raw`)
    } catch {
      flash('The cleaned draft could not be discarded. Try again.')
    } finally {
      setBusyCleanSlide(null)
    }
  }, [active, refreshCleaned, flash])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return
      if (e.key === 'Escape') {
        e.preventDefault()
        if (cleanOpen) setCleanOpen(false)
        else if (rewriteOpen) setRewriteOpen(false)
        else if (helpOpen) setHelpOpen(false)
        else if (pickerOpen) setPickerOpen(false)
        else if (formatOpen) setFormatOpen(false)
        else onClose()
        return
      }
      if (e.key === '?') { e.preventDefault(); setHelpOpen(true) }
      else if (e.key.toLowerCase() === 'n') { e.preventDefault(); setMode('notes') }
      else if (e.key.toLowerCase() === 's') { e.preventDefault(); setMode('script') }
      else if (e.key.toLowerCase() === 'r') { e.preventDefault(); openRewrite() }
      else if (e.key.toLowerCase() === 'c') { e.preventDefault(); void copyText() }
      else if (e.key === ' ' && mode === 'script' && !(e.target instanceof HTMLButtonElement)) { e.preventDefault(); togglePlay() }
      else if (e.key === ',' && mode === 'script') { e.preventDefault(); seekToMs(curMsRef.current - 5000) }
      else if (e.key === '.' && mode === 'script') { e.preventDefault(); seekToMs(curMsRef.current + 5000) }
      else if (e.key === '[') { e.preventDefault(); stepSlide(-1) }
      else if (e.key === ']') { e.preventDefault(); stepSlide(1) }
      else if (/^[1-9]$/.test(e.key)) { e.preventDefault(); navigateToSlide(Number(e.key)) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, cleanOpen, rewriteOpen, helpOpen, pickerOpen, formatOpen, onClose, openRewrite, copyText, stepSlide, navigateToSlide, mode, togglePlay, seekToMs])

  if (!isOpen) return null

  const trimmedMs = active?.trims?.reduce((sum, trim) => sum + Math.max(0, trim.end - trim.start), 0) ?? 0
  const documentMeta = model
    ? [model.meta.event, humanDate(model.meta.date), `${minutes(model.meta.recordedMs)} recorded`, trimmedMs ? `raw ${minutes(model.meta.recordedMs + trimmedMs)}` : null, `${model.slides.length} slides`].filter(Boolean).join(' · ')
    : ''

  return (
    <div className="lt tt-win" role="dialog" aria-label="Manage notes">
      <header className="tt-topbar">
        <button className="tt-iconbtn tt-back" onClick={() => onBackToStudio(active?.id)} title="Back to Studio"><ArrowLeft className="lt-icon" /></button>
        <div className="tt-brand"><span className="tt-wordmark">TalkWeaver</span><span className="tt-room">Manage notes</span></div>
        <span className="tt-spacer" />
        <button className="tt-iconbtn tt-help" onClick={() => setHelpOpen(true)} aria-label="Keyboard cheat-sheet" title="Keyboard cheat-sheet (?)">?</button>
        <button className="tt-iconbtn" onClick={onClose} aria-label="Close Manage notes" title="Close (Esc)"><X className="lt-icon" /></button>
      </header>

      {!loading && model && active ? (
        <div className="tt-subhead">
          <div className="tt-recwrap">
            <span className="tt-recchip"><b>{model.meta.talkTitle}</b><span>· {humanDate(model.meta.date)} · {minutes(model.meta.recordedMs)} · {model.slides.length} slides</span>
              <button className="tt-change" onClick={() => setPickerOpen((open) => !open)}><PanelLeft className="lt-icon" />Change</button>
            </span>
            {pickerOpen ? (
              <div className="tt-pop tt-recording-pop">
                <div className="tt-search"><Search className="lt-icon" /><input autoFocus value={pickerQuery} onChange={(e) => setPickerQuery(e.target.value)} placeholder="Search recordings…" aria-label="Search recordings" />{pickerQuery ? <button onClick={() => setPickerQuery('')} aria-label="Clear recording search"><X className="lt-icon" /></button> : null}</div>
                <div className="tt-recording-list">
                  {filteredSessions.map((item) => <button key={item.id} className={item.id === active.id ? 'sel' : ''} onClick={() => { setPickerOpen(false); setPickerQuery(''); void load(item.id) }}><span><b>{item.talkTitle}</b><small>{humanDate(item.startedAt)} · {minutes(item.recordingMs)}</small></span>{item.id === active.id ? <Check className="lt-icon" /> : null}</button>)}
                  {filteredSessions.length === 0 ? <p>No recordings match that search.</p> : null}
                </div>
              </div>
            ) : null}
          </div>
          <div className="tt-seg" role="group" aria-label="Mode">
            <button className={mode === 'notes' ? 'on' : ''} onClick={() => setMode('notes')}><BookOpen className="lt-icon" />Notes</button>
            <button className={mode === 'script' ? 'on' : ''} onClick={() => setMode('script')}><MonitorPlay className="lt-icon" />Script</button>
          </div>
          {mode === 'notes' ? <><span className="tt-partstat" title="Notes are written part by part; you approve each">{approvedCount > 0 ? <span className="ps-ok">{approvedCount} approved</span> : null}{approvedCount > 0 && reviewCount > 0 ? <span className="ps-sep">·</span> : null}{reviewCount > 0 ? <span className="ps-draft">{reviewCount} in review</span> : null}{approvedCount === 0 && reviewCount === 0 ? <span>No parts yet</span> : null}</span><button className="tt-btn" onClick={openRewrite}><Wand2 className="lt-icon" />Rewrite…</button></> : (
            <><div className="tt-seg" role="group" aria-label="Transcript treatment"><button className={treatment === 'raw' ? 'on' : ''} onClick={() => setTreatment('raw')}>Raw</button><button className={treatment === 'cleaned' ? 'on' : ''} onClick={() => setTreatment('cleaned')}>Cleaned</button></div><span className="tt-partstat" title="Approved agent-cleaned slides"><span className={cleanedCount > 0 ? 'ps-ok' : ''}>{cleanedCount}/{totalSlideCount} cleaned</span>{cleanedSlides.some((slide) => !slide.approved) ? <><span className="ps-sep">·</span><span className="ps-draft">review ready</span></> : null}</span><button className="tt-btn" onClick={openClean}><Sparkles className="lt-icon" />Clean…</button></>
          )}
          <div className="tt-exportcluster">
            <div className="tt-menubtn"><button className="tt-btn" onClick={() => setFormatOpen((open) => !open)}>{format === 'plain' ? 'Plain text' : format === 'rich' ? 'Rich' : 'Markdown'}<ChevronDown className="lt-icon" /></button>
              {formatOpen ? <div className="tt-pop tt-format-pop"><h5>Format</h5>{([['markdown', 'Markdown'], ['plain', 'Plain text'], ['rich', 'Rich (for paste)']] as Array<[Format, string]>).map(([value, label]) => <button className={`tt-opt ${format === value ? 'sel' : ''}`} key={value} onClick={() => setFormat(value)}>{label}{format === value ? <Check className="lt-icon" /> : null}</button>)}<h5>Include</h5>{mode === 'notes' ? <button className={`tt-opt ${include.references ? 'on' : ''}`} onClick={() => setInclude((current) => ({ ...current, references: !current.references }))}>Slide references<span className="tt-toggle" /></button> : <button className={`tt-opt ${include.timecodes ? 'on' : ''}`} onClick={() => setInclude((current) => ({ ...current, timecodes: !current.timecodes }))}>Timecodes<span className="tt-toggle" /></button>}</div> : null}
            </div>
            <button className="tt-btn primary" onClick={() => { void copyText() }}><Copy className="lt-icon" />Copy</button>
            <button className="tt-btn" onClick={() => { void saveText() }}><Download className="lt-icon" />Save…</button>
            {/* "Publish as handout…" is kept as an explicit TODO (Dominik 2026-07-19): the
                talk:publish-handout backend exists; wire it in a focused pass. "Send to outline"
                was removed — a no-op button nobody recognised (2026-07-19). */}
            <button className="tt-btn" title="Coming in a later step" onClick={() => flash('Coming in a later step')}><Globe className="lt-icon" />Publish as handout…</button>
          </div>
        </div>
      ) : null}

      <div className="tt-body">
        {loading ? <div className="tt-state"><div className="tt-state-icon loading"><Sparkles className="lt-icon" /></div><h2>Weaving the recording into text…</h2><p>Matching the outline, slides and transcript.</p></div> : !model ? <div className="tt-state"><div className="tt-state-icon"><Presentation className="lt-icon" /></div><h2>{loadError ? 'The recording could not be opened' : 'This recording is not ready for text yet'}</h2><p>{loadError ? 'TalkWeaver could not read the recording just now.' : 'This recording has no slide-time index yet — present it once, or transcribe it, to turn it into text.'}</p><button className="tt-btn primary" onClick={() => { void load(activeId ?? sessionId) }}><Sparkles className="lt-icon" />Try again</button></div> : (
          <>
            <nav className="tt-toc" aria-label="Contents"><h4 className="tt-eyebrow">Contents</h4><OutlineTree nodes={model.outline} selectedSlide={selectedSlide} onSelect={navigateToSlide} /></nav>
            <main className="tt-docwrap"><div className="tt-doc"><div className="tt-doc-title">{model.meta.talkTitle}</div><div className="tt-doc-meta">{documentMeta}</div><div className="tt-treat-tag">{mode === 'notes' ? <><Wand2 className="lt-icon" />Notes · agent-written, part by part</> : <><MonitorPlay className="lt-icon" />Script · {treatment === 'cleaned' ? 'cleaned transcript per slide' : 'raw transcript, verbatim'}</>}</div>
              {mode === 'notes' ? (
                notesLoading ? <div className="tt-notes-empty"><div className="tt-state-icon loading"><Sparkles className="lt-icon" /></div><h2>Opening the notes…</h2><p>Checking the agent-written parts and their approval state.</p></div> : notesError ? <div className="tt-notes-empty"><div className="tt-state-icon"><BookOpen className="lt-icon" /></div><h2>The notes could not be opened</h2><p>TalkWeaver could not read the part files just now.</p><button className="tt-btn primary" onClick={() => { void refreshNotes() }}><Sparkles className="lt-icon" />Try again</button></div> : noteSources.length === 0 ? <div className="tt-notes-empty"><div className="tt-state-icon"><BookOpen className="lt-icon" /></div><h2>Notes begin with an agent rewrite</h2><p>Notes are an independent, agent-written document — not the transcript reflowed.</p><button className="tt-btn primary" onClick={openRewrite}><Wand2 className="lt-icon" />Rewrite…</button><small>Parts will appear here for approval as they are written.</small></div> : notesParts.length === 0 ? <div className="tt-notes-empty"><div className="tt-state-icon"><BookOpen className="lt-icon" /></div><h2>The parts do not match this outline</h2><p>TalkWeaver found part files, but their numbers do not match the current top-level sections.</p><button className="tt-btn primary" onClick={openRewrite}><Wand2 className="lt-icon" />Open rewrite help</button></div> : <NotesDocument parts={notesParts} busySlug={busyPart} onApprove={(slug) => { void setPartApproval(slug, true) }} onUnapprove={(slug) => { void setPartApproval(slug, false) }} onEdit={(slug) => { void editPart(slug) }} onDiscard={(slug) => { void discardPart(slug) }} onShowSlide={navigateToSlide} />
              ) : treatment === 'cleaned' && cleanLoading ? <div className="tt-notes-empty"><div className="tt-state-icon loading"><Sparkles className="lt-icon" /></div><h2>Opening the cleaned Script…</h2><p>Checking agent-cleaned slides and their approval state.</p></div> : treatment === 'cleaned' && cleanListError ? <div className="tt-notes-empty"><div className="tt-state-icon"><Sparkles className="lt-icon" /></div><h2>Cleaned slides could not be opened</h2><p>Raw remains available while TalkWeaver tries the clean folder again.</p><button className="tt-btn primary" onClick={() => { void refreshCleaned() }}><Sparkles className="lt-icon" />Try again</button></div> : <div className="tt-script">{entries.map((entry, index) => entry.kind === 'heading' ? (entry.node.depth === 1 ? <div className="tt-part-head" key={`h-${index}`}><span className="n">{entry.index}</span><h2>{entry.node.title}</h2>{entry.slides.length ? <span className="rng">Slides {Math.min(...entry.slides)}–{Math.max(...entry.slides)}</span> : null}</div> : <div className="tt-mid-head" style={{ marginLeft: Math.max(0, entry.node.depth - 2) * 13 }} key={`h-${index}`}>{entry.node.title}</div>) : <div className={`tt-srow${playingNumber === entry.slide.slideNumber ? ' playing' : ''}`} id={`tt-slide-${entry.slide.slideNumber}`} key={`${entry.slide.slideId}-${entry.slide.startMs}`}><div className="tt-s-slide" role="button" tabIndex={0} onClick={() => navigateToSlide(entry.slide.slideNumber, entry.slide.startMs)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); navigateToSlide(entry.slide.slideNumber, entry.slide.startMs) } }}><SlideThumbnail url={entry.slide.thumbKey ? thumbUrls[entry.slide.thumbKey] : undefined} title={entry.slide.title} rendering={thumbsRendering} /><div className="cap"><span className="num">{entry.slide.slideNumber}</span><span className="st">{entry.slide.title}</span></div></div><ScriptSlideText slide={entry.slide} treatment={treatment} cleaned={cleanedByNumber.get(entry.slide.slideNumber)} busy={busyCleanSlide === entry.slide.slideNumber} canPrev={(slideIndex.get(entry.slide.slideNumber) ?? 0) > 0} canNext={(slideIndex.get(entry.slide.slideNumber) ?? orderedNumbers.length) < orderedNumbers.length - 1} onApprove={() => { void setCleanApproval(entry.slide.slideNumber, true) }} onUnapprove={() => { void setCleanApproval(entry.slide.slideNumber, false) }} onDiscard={() => { void discardCleaned(entry.slide.slideNumber) }} onSave={(markdown, keepApproval) => saveCleaned(entry.slide.slideNumber, markdown, keepApproval)} onMove={(direction, moved, remaining) => moveCleaned(entry.slide.slideNumber, direction, moved, remaining)} onSeek={() => seekToMs(entry.slide.startMs)} /></div>)}</div>}
              {trimmedMs > 0 ? <div className="tt-trim-note"><span className="line" /><Wand2 className="lt-icon" />{minutes(trimmedMs)} trimmed — omitted<span className="line" /></div> : null}
            </div></main>
            {mode === 'notes' && previewVisible && currentSlide ? <aside className="tt-preview"><div className="tt-pv-head"><span className="tt-eyebrow">Slide</span><button className={`tt-iconbtn ${previewPinned ? 'active' : ''}`} onClick={() => setPreviewPinned((pinned) => !pinned)} aria-pressed={previewPinned} title="Pin preview"><Pin className="lt-icon" /></button><button className="tt-iconbtn" onClick={() => setPreviewVisible(false)} title="Hide preview"><X className="lt-icon" /></button></div><div className="tt-pv-body"><div className="tt-pv-slide"><SlideThumbnail key={`${currentSlide.slideId}-${currentSlide.thumbKey ?? ''}`} url={currentSlide.thumbKey ? thumbUrls[currentSlide.thumbKey] : undefined} title={currentSlide.title} rendering={thumbsRendering} /></div><div className="tt-pv-cap"><div className="t">{currentSlide.title}</div><div className="path">{currentSlide.sectionPath.map((part, index) => <span key={part + index}>{index > 0 ? <span className="sep">›</span> : null}{part}</span>)}</div><div className="m"><span className="tt-tc">{formatTimecode(currentSlide.startMs)}–{formatTimecode(currentSlide.endMs)}</span></div></div><div className="tt-pv-nav"><button onClick={() => stepSlide(-1)} title="Previous slide"><ChevronLeft className="lt-icon" /></button><span>{`Slide ${currentSlide.slideNumber} of ${model.slides.length}`}</span><button onClick={() => stepSlide(1)} title="Next slide"><ChevronRight className="lt-icon" /></button></div></div><div className="tt-pv-foot"><button className="tt-btn" onClick={() => onBackToStudio(active?.id)}><ExternalLink className="lt-icon" />Open in Studio at {formatTimecode(currentSlide.startMs)}</button></div></aside> : null}
          </>
        )}
      </div>

      <PlaybackController
        visible={mode === 'script' && Boolean(model)}
        active={active}
        slides={model?.slides ?? []}
        audioRef={audioRef}
        curMsRef={curMsRef}
        durMsRef={durMsRef}
        playing={playing}
        speedIdx={speedIdx}
        follow={follow}
        onTogglePlay={togglePlay}
        onCycleSpeed={cycleSpeed}
        onToggleFollow={() => setFollow((current) => !current)}
        onSeek={seekToMs}
        onPlayingChange={setPlaying}
        onPlayingNumberChange={setPlayingNumber}
        onShowSlide={showSlide}
      />

      <footer className="tt-hintbar"><span><b>N</b>notes</span><span><b>S</b>script</span><span><b>R</b>rewrite</span><span><b>1–9</b>show slide</span><span><b>[ ]</b>prev · next slide</span><span><b>Space</b>play</span><span><b>C</b>copy</span><span className="push"><b>?</b>shortcuts</span>{appVersion ? <span className="tt-buildtag" title="Running build">v{appVersion}</span> : null}</footer>

      {cleanOpen ? <div className="tt-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setCleanOpen(false) }}><div className="tt-modal tt-clean-modal" role="dialog" aria-modal="true" aria-label="Clean the Script with an agent"><div className="tt-modal-head"><div><div className="ttl">Clean the Script with an agent</div><div className="sub">A faithful tidy-up, <b>one slide at a time</b>: disfluencies and transcription errors go; the speaker's meaning and order stay.</div></div><button className="tt-iconbtn" onClick={() => setCleanOpen(false)} aria-label="Close Clean"><X className="lt-icon" /></button></div><div className="tt-modal-body"><p className="tt-mb-lead">Choose how much the agent should clean in this run. TalkWeaver writes the instruction into <b>CLEAN.md</b>; the agent fills <b>cleaned/</b>, and each draft appears in the Cleaned view for approval.</p><div className="tt-clean-modes" role="radiogroup" aria-label="Clean working mode">{([
        ['section', 'Section by section — approve each', 'The agent stops after the first unfinished section.'],
        ['onepass', 'One pass — review the whole thing', 'The agent cleans every slide before stopping.'],
        ['perslide', 'Per slide — choose slides', 'Send only the slides you select below.']
      ] as Array<[CleanMode, string, string]>).map(([value, label, detail]) => <button type="button" role="radio" aria-checked={cleanMode === value} className={cleanMode === value ? 'selected' : ''} key={value} onClick={() => { setCleanMode(value); setCleanPrepared(false); setCleanError(null) }}><span className="tt-radio-dot" aria-hidden="true" /><span><b>{label}</b><small>{detail}</small></span>{cleanMode === value ? <Check className="lt-icon" /> : null}</button>)}</div>{cleanMode === 'perslide' ? <div className="tt-slide-picker"><div className="tt-slide-picker-head"><span>Slides to clean</span><small>{cleanSlides.length ? `${cleanSlides.length} selected` : 'Choose one or more'}</small></div><div className="tt-slide-numbers">{[...new Set(model?.slides.map((slide) => slide.slideNumber) ?? [])].map((slideNumber) => <button type="button" className={cleanSlides.includes(slideNumber) ? 'selected' : ''} aria-pressed={cleanSlides.includes(slideNumber)} key={slideNumber} onClick={() => { setCleanSlides((current) => current.includes(slideNumber) ? current.filter((number) => number !== slideNumber) : [...current, slideNumber].sort((a, b) => a - b)); setCleanPrepared(false); setCleanError(null) }}>{slideNumber}</button>)}</div></div> : null}{cleanError ? <div className="tt-clean-error" role="alert">{cleanError}</div> : null}{cleanPrepared ? <><div className="tt-packpath">{cleanedDir}</div><div className="tt-packtree"><b>{model?.meta.talkTitle ?? 'Talk'}</b>/agent-rewrite/<br />&nbsp;&nbsp;<b>{active?.id ?? 'run-id'}</b>/<br />&nbsp;&nbsp;<span className="hi">CLEAN.md</span> <span className="c"># start here — this run's mode</span><br />&nbsp;&nbsp;transcript.md <span className="c"># verbatim, grouped by slide</span><br />&nbsp;&nbsp;structure.json <span className="c"># outline + slide content for names</span><br />&nbsp;&nbsp;<span className="hi">instructions/clean-format.md</span> <span className="c"># faithfulness contract</span><br />&nbsp;&nbsp;<span className="hi">cleaned/</span> <span className="c"># one file per slide; TalkWeaver watches it</span></div><ol className="tt-steps"><li><b>Copy the prompt</b> or reveal this Run pack.</li><li><b>Point your agent at the folder</b> — CLEAN.md tells it exactly where to stop.</li><li><b>Review and approve</b> each cleaned slide in Script → Cleaned.</li></ol></> : null}<div className="tt-bridle-note"><Sparkles className="lt-icon" /><span>When <b>Bridle</b> is built into TalkWeaver, the same clean job runs in-app against these inputs and instructions. The pack is the stable handoff.</span></div></div><div className="tt-modal-foot">{!cleanPrepared ? <button className="tt-btn primary" disabled={cleanBusy || !active || (cleanMode === 'perslide' && cleanSlides.length === 0)} onClick={() => { void prepareClean() }}><Sparkles className="lt-icon" />{cleanBusy ? 'Preparing…' : 'Prepare clean pack'}</button> : <><button className="tt-btn primary" disabled={!active || cleanBusy} onClick={() => { if (!active) return; void window.tw.clean.copyPrompt(active.talkSlug, active.id).then(async (prompt) => { if (!prompt) { flash('The clean prompt could not be copied. Try again.'); return } await navigator.clipboard.writeText(prompt); flash('Clean prompt copied') }).catch(() => flash('The clean prompt could not be copied. Try again.')) }}><Copy className="lt-icon" />Copy prompt</button><button className="tt-btn" disabled={!active || cleanBusy} onClick={() => { if (!active) return; void window.tw.clean.revealFolder(active.talkSlug, active.id).then((shown) => flash(shown ? 'Folder revealed in Finder' : 'The folder could not be revealed.')).catch(() => flash('The folder could not be revealed.')) }}><Folder className="lt-icon" />Reveal folder in Finder</button></>}<span className="tt-spacer" /><button className="tt-btn ghost" onClick={() => setCleanOpen(false)}>Close</button></div></div></div> : null}

      {rewriteOpen ? <div className="tt-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setRewriteOpen(false) }}><div className="tt-modal" role="dialog" aria-modal="true" aria-label="Rewrite with an agent"><div className="tt-modal-head"><div><div className="ttl">Write the notes with an agent</div><div className="sub">Notes are an <b>independent document</b>, not the transcript reflowed. The agent drafts them <b>one part at a time</b> and pauses so you approve each.</div></div><button className="tt-iconbtn" onClick={() => setRewriteOpen(false)} aria-label="Close rewrite"><X className="lt-icon" /></button></div><div className="tt-modal-body"><p className="tt-mb-lead">TalkWeaver has written a self-contained folder for this recording. Point an agent at it — the instructions and inputs are all inside. Only approved parts show up in Notes.</p><div className="tt-packpath">{packBusy ? 'Preparing the rewrite pack…' : packError ? 'The pack could not be prepared. Close this window and try Rewrite again.' : packDir}</div><div className="tt-packtree"><b>{model?.meta.talkTitle ?? 'Talk'}</b>/agent-rewrite/<br />&nbsp;&nbsp;<b>{active?.id ?? 'run-id'}</b>/<br />&nbsp;&nbsp;<span className="hi">PROMPT.md</span> <span className="c"># start here — one section at a time</span><br />&nbsp;&nbsp;transcript.md <span className="c"># verbatim, grouped by slide</span><br />&nbsp;&nbsp;structure.json <span className="c"># recursive outline + slide content</span><br />&nbsp;&nbsp;<span className="hi">instructions/</span> <span className="c"># bundled LectureNotes instructions</span><br />&nbsp;&nbsp;<span className="hi">parts/</span> <span className="c"># TalkWeaver watches this</span></div><ol className="tt-steps"><li><b>Copy the prompt</b> (or reveal the folder in Finder).</li><li><b>Point your agent at the folder</b> — it drafts section 1, then pauses.</li><li><b>Approve, tweak, or regenerate</b> each part here; approved parts fold into Notes.</li></ol><div className="tt-bridle-note"><Sparkles className="lt-icon" /><span>When <b>Bridle</b> is built into TalkWeaver, this same rewrite runs in-app against the same inputs and instructions. This handoff is the seam that makes the swap invisible.</span></div></div><div className="tt-modal-foot"><button className="tt-btn primary" disabled={!active || packBusy || packError} onClick={() => { if (!active) return; void window.tw.rewrite.copyPrompt(active.talkSlug, active.id).then(async (prompt) => { if (!prompt) { flash('The prompt could not be copied. Try again.'); return } await navigator.clipboard.writeText(prompt); flash('Prompt copied') }).catch(() => flash('The prompt could not be copied. Try again.')) }}><Copy className="lt-icon" />Copy prompt</button><button className="tt-btn" disabled={!active || packBusy || packError} onClick={() => { if (!active) return; void window.tw.rewrite.revealFolder(active.talkSlug, active.id).then((shown) => flash(shown ? 'Folder revealed in Finder' : 'The folder could not be revealed.')).catch(() => flash('The folder could not be revealed.')) }}><Folder className="lt-icon" />Reveal folder in Finder</button><span className="tt-spacer" /><button className="tt-btn ghost" onClick={() => setRewriteOpen(false)}>Close</button></div></div></div> : null}

      {helpOpen ? <div className="tt-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setHelpOpen(false) }}><div className="tt-cheatsheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"><div className="tt-modal-head"><div><div className="ttl">Keyboard</div><div className="sub">Every core action has a key.</div></div><button className="tt-iconbtn" onClick={() => setHelpOpen(false)} aria-label="Close shortcuts"><X className="lt-icon" /></button></div><div className="tt-cheat-grid">{[['Notes mode', 'N'], ['Script mode', 'S'], ['Open rewrite', 'R'], ['Show slide', '1–9'], ['Previous slide', '['], ['Next slide', ']'], ['Play / pause (Script)', 'Space'], ['Back / forward 5s', ', .'], ['Copy', 'C'], ['Save edit', '⌘ ↵'], ['Shortcuts', '?'], ['Close overlay · cancel edit', 'Esc']].map(([label, key]) => <div className="tt-cheat-row" key={label}><span>{label}</span><kbd>{key}</kbd></div>)}</div></div></div> : null}
      {toast ? <div className="tt-toast" role="status"><Check className="lt-icon" />{toast.message}{toast.action ? <button type="button" onClick={toast.action}>Undo</button> : null}</div> : null}
    </div>
  )
}

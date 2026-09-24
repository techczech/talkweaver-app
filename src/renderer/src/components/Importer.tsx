import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronLeft,
  Clipboard,
  FileInput,
  FilePlus2,
  FolderOpen,
  History as HistoryIcon,
  Image as ImageIcon,
  LoaderCircle,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  X
} from 'lucide-react'
import type {
  ImportCleanupPass,
  ImportLayout,
  ImportProgress,
  ImportRepresentation,
  ImportRunDetail,
  ImportRunManifest,
  ImportRendererRecord,
  ImportSlideFilter,
  ImportSlideRecord,
  ImportSourceInfo,
  ImportSuggestion,
  ImporterSettings
} from '../../../shared/importer'
import { DEFAULT_IMPORTER_SETTINGS, isFlaggedImportStatus } from '../../../shared/importer'
import {
  appendImportSources,
  effectiveImportDestination,
  importRequestsForBatch,
  resetImportDestination,
  setImportDestination,
  type ImportDestinationOverrides
} from '../../../shared/importer-batch'
import {
  IMPORT_LAYOUT_CATEGORIES,
  IMPORT_LAYOUT_CATEGORY_LABELS,
  IMPORT_LAYOUT_CHOICES,
  isImportLayout
} from '../../../shared/importer-layouts'
import { moveSelection, visibleSlides } from './importerModel'
import '../importer.css'
import '../importer-batch.css'

type Draft = { title: string; layout: ImportLayout; representation: ImportRepresentation; markdown: string }

const PASSES: Array<{ id: ImportCleanupPass; label: string }> = [
  { id: 'structural-parity', label: 'Structural parity' },
  { id: 'layout-repair', label: 'Layout repair' },
  { id: 'accessibility', label: 'Accessibility' },
  { id: 'editorial', label: 'Editorial' }
]

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'imported-talk'
}

function sourceTitle(source: ImportSourceInfo): string {
  return source.fileName.replace(/\.pptx$/i, '').replace(/[_-]+/g, ' ').trim() || 'Imported talk'
}

function currentMarkdown(slide: ImportSlideRecord): string {
  return slide.decision.manualOverride?.markdown
    ?? (slide.decision.representation === 'fallback' ? slide.decision.fallbackMarkdown : slide.decision.candidateMarkdown)
}

function draftOf(slide: ImportSlideRecord): Draft {
  return {
    title: slide.decision.manualOverride?.title ?? slide.decision.title,
    layout: slide.decision.manualOverride?.layout ?? slide.decision.layout,
    representation: slide.decision.manualOverride?.representation ?? slide.decision.representation,
    markdown: currentMarkdown(slide)
  }
}

function statusLabel(run: ImportRunManifest): string {
  if (run.status === 'failed') return 'Needs attention'
  if (run.status === 'review') return 'Ready to review'
  if (run.status === 'reviewed') return 'Reviewed'
  return run.status.replace('-', ' ')
}

export default function Importer({
  isOpen,
  onClose,
  onShowStudio,
  onShowHistory
}: {
  isOpen: boolean
  onClose: () => void
  onShowStudio: () => void
  onShowHistory: () => void
}): JSX.Element | null {
  const [runs, setRuns] = useState<ImportRunManifest[]>([])
  const [detail, setDetail] = useState<ImportRunDetail | null>(null)
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null)
  const [sources, setSources] = useState<ImportSourceInfo[]>([])
  const [destinationOverrides, setDestinationOverrides] = useState<ImportDestinationOverrides>({})
  const [title, setTitle] = useState('')
  const [slug, setSlug] = useState('')
  const [topicFolder, setTopicFolder] = useState('')
  const [slideRange, setSlideRange] = useState('')
  const [settings, setSettings] = useState<ImporterSettings>(DEFAULT_IMPORTER_SETTINGS)
  const [capabilities, setCapabilities] = useState<{ available: boolean; platform: string; renderer: ImportRendererRecord } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ImportSlideFilter>('all')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [originalUrl, setOriginalUrl] = useState<string | null>(null)
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({})
  const [previewLoading, setPreviewLoading] = useState(false)
  const [cleanupSlides, setCleanupSlides] = useState<Set<number>>(() => new Set())
  const [cleanupPasses, setCleanupPasses] = useState<Set<ImportCleanupPass>>(() => new Set(PASSES.map((pass) => pass.id)))
  const [pack, setPack] = useState<{ packId: string; packDir: string } | null>(null)
  const [suggestions, setSuggestions] = useState<ImportSuggestion[]>([])
  const [suggestionErrors, setSuggestionErrors] = useState<string[]>([])
  const searchRef = useRef<HTMLInputElement>(null)

  const reloadRuns = useCallback(async (): Promise<void> => {
    const next = await window.tw.importer.listRuns()
    setRuns(next)
  }, [])

  const loadRun = useCallback(async (runId: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const next = await window.tw.importer.getRun(runId)
      setDetail(next)
      setSelectedNumber((current) => next.slides.some((slide) => slide.slideNumber === current) ? current : (next.slides[0]?.slideNumber ?? null))
      setCleanupSlides(new Set(next.slides.filter((slide) => isFlaggedImportStatus(slide.status)).map((slide) => slide.slideNumber)))
      setPack(null)
      setSuggestions([])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (!isOpen) return
    void Promise.all([reloadRuns(), window.tw.importer.getSettings(), window.tw.importer.capabilities()])
      .then(([, loadedSettings, loadedCapabilities]) => { setSettings(loadedSettings); setCapabilities(loadedCapabilities) })
    return window.tw.importer.onProgress(setProgress)
  }, [isOpen, reloadRuns])

  const selectedSlide = useMemo(
    () => detail?.slides.find((slide) => slide.slideNumber === selectedNumber) ?? null,
    [detail, selectedNumber]
  )

  useEffect(() => {
    if (!detail || !selectedSlide) { setPreviewLoading(false); return }
    let current = true
    setPreviewLoading(true)
    void window.tw.talk.selectedThumbnail(
      detail.manifest.talk.outlinePath,
      detail.outlineContent,
      selectedSlide.decision.sourceId
    ).then((rendered) => {
      if (!current) return
      if (rendered) {
        setThumbnails((existing) => ({ ...existing, [rendered.slideId]: rendered.url }))
      } else {
        setThumbnails((existing) => {
          const next = { ...existing }
          delete next[selectedSlide.decision.sourceId]
          return next
        })
      }
    }).catch(() => {
      if (!current) return
      setThumbnails((existing) => {
        const next = { ...existing }
        delete next[selectedSlide.decision.sourceId]
        return next
      })
    })
      .finally(() => { if (current) setPreviewLoading(false) })
    return () => { current = false }
  }, [detail?.manifest.talk.outlinePath, detail?.outlineContent, selectedSlide?.decision.sourceId])

  useEffect(() => { setThumbnails({}) }, [detail?.manifest.id])

  useEffect(() => {
    setDraft(selectedSlide ? draftOf(selectedSlide) : null)
    setOriginalUrl(null)
    if (detail && selectedSlide?.originalPath) {
      void window.tw.importer.originalDataUrl(detail.manifest.id, selectedSlide.slideNumber)
        .then(setOriginalUrl)
        .catch(() => setOriginalUrl(null))
    }
  }, [detail?.manifest.id, selectedSlide?.slideNumber])

  const visible = useMemo(
    () => detail ? visibleSlides(detail.slides, query, filter) : [],
    [detail, query, filter]
  )

  const chooseSources = useCallback(async (
    mode: 'files' | 'folder',
    behaviour: 'append' | 'replace' = 'replace'
  ): Promise<void> => {
    setError(null)
    try {
      const chosen = await window.tw.importer.chooseSources(mode)
      if (chosen.errors.length) setError(`${chosen.errors.length} PowerPoint file${chosen.errors.length === 1 ? '' : 's'} could not be read: ${chosen.errors.map((item) => item.path.split('/').at(-1)).join(', ')}`)
      if (!chosen.sources.length) {
        if (mode === 'folder' && !chosen.errors.length) setError('No PowerPoint files were found in that folder.')
        return
      }
      if (behaviour === 'append') {
        setSources((current) => appendImportSources(current, chosen.sources))
        return
      }
      const nextTitle = sourceTitle(chosen.sources[0])
      setSources(chosen.sources)
      setDestinationOverrides({})
      setTitle(nextTitle)
      setSlug(slugify(nextTitle))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  const chooseDestination = useCallback(async (sourcePath?: string): Promise<void> => {
    setError(null)
    try {
      const chosen = await window.tw.importer.chooseDestination()
      if (chosen == null) return
      if (sourcePath) {
        setDestinationOverrides((current) => setImportDestination(current, sourcePath, chosen))
      } else {
        setTopicFolder(chosen)
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  const beginImport = useCallback(async (): Promise<void> => {
    if (!sources.length || !title.trim() || !slug.trim()) return
    setBusy(true)
    setError(null)
    setProgress(null)
    try {
      const completed: ImportRunDetail[] = []
      const failures: string[] = []
      const requests = importRequestsForBatch({
        sources,
        singleTitle: title,
        singleSlug: slug,
        defaultDestination: topicFolder,
        destinationOverrides,
        slideRange,
        settings
      })
      for (const [index, request] of requests.entries()) {
        const source = sources[index]
        try {
          const next = await window.tw.importer.start(request)
          completed.push(next)
        } catch {
          failures.push(source.fileName)
        }
        setProgress((current) => current ? { ...current, note: `${index + 1} of ${sources.length}: ${current.note}` } : null)
      }
      const last = completed.at(-1)
      if (last) {
        setDetail(last)
        setSelectedNumber(last.slides[0]?.slideNumber ?? null)
      }
      setSources([])
      setDestinationOverrides({})
      if (failures.length) setError(`Imported ${completed.length} of ${sources.length}. Failed: ${failures.join(', ')}. Failed runs remain available under Recent imports.`)
      await reloadRuns()
    } finally {
      setBusy(false)
    }
  }, [destinationOverrides, reloadRuns, settings, slideRange, slug, sources, title, topicFolder])

  const resume = useCallback(async (runId: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const next = await window.tw.importer.resume(runId)
      setDetail(next)
      setSelectedNumber(next.slides[0]?.slideNumber ?? null)
      await reloadRuns()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
      await reloadRuns()
    } finally {
      setBusy(false)
    }
  }, [reloadRuns])

  const applyDraft = useCallback(async (): Promise<void> => {
    if (!detail || !selectedSlide || !draft) return
    setBusy(true)
    try {
      const next = await window.tw.importer.updateSlide(detail.manifest.id, selectedSlide.slideNumber, draft)
      setDetail(next)
      await reloadRuns()
    } finally {
      setBusy(false)
    }
  }, [detail, draft, reloadRuns, selectedSlide])

  const resetDraft = useCallback(async (): Promise<void> => {
    if (!detail || !selectedSlide) return
    const next = await window.tw.importer.resetSlide(detail.manifest.id, selectedSlide.slideNumber)
    setDetail(next)
    setDraft(draftOf(next.slides.find((slide) => slide.slideNumber === selectedSlide.slideNumber)!))
  }, [detail, selectedSlide])

  const preparePack = useCallback(async (): Promise<void> => {
    if (!detail) return
    const slideNumbers = cleanupSlides.size ? [...cleanupSlides] : detail.slides.map((slide) => slide.slideNumber)
    const passes = cleanupPasses.size ? [...cleanupPasses] : ['structural-parity' as const]
    setBusy(true)
    try {
      const created = await window.tw.importer.preparePack({ runId: detail.manifest.id, slideNumbers, passes })
      setPack(created)
      setSuggestions([])
      setSuggestionErrors([])
    } finally {
      setBusy(false)
    }
  }, [cleanupPasses, cleanupSlides, detail])

  const refreshSuggestions = useCallback(async (): Promise<void> => {
    if (!detail || !pack) return
    const result = await window.tw.importer.listSuggestions(detail.manifest.id, pack.packId)
    setSuggestions(result.suggestions)
    setSuggestionErrors(result.errors)
  }, [detail, pack])

  const applySuggestion = useCallback(async (suggestion: ImportSuggestion): Promise<void> => {
    if (!detail || !pack) return
    const next = await window.tw.importer.applySuggestion(detail.manifest.id, pack.packId, suggestion.slideNumber)
    setDetail(next)
    setSelectedNumber(suggestion.slideNumber)
  }, [detail, pack])

  const saveSettings = useCallback(async (patch: Partial<ImporterSettings>): Promise<void> => {
    setSettings(await window.tw.importer.setSettings(patch))
  }, [])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const editing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.tagName === 'SELECT'
      const key = event.key.toLowerCase()
      if (event.metaKey && key === 'enter') { event.preventDefault(); void applyDraft(); return }
      if (editing) return
      if (event.key === 'Escape') { event.preventDefault(); helpOpen ? setHelpOpen(false) : onClose(); return }
      if (event.metaKey && key === 'f') { event.preventDefault(); searchRef.current?.focus(); return }
      if (event.metaKey && ['1', '2', '3'].includes(event.key)) {
        event.preventDefault()
        if (event.key === '1') onShowStudio()
        else if (event.key === '2') onShowHistory()
        return
      }
      if (event.altKey && key === 'r') { event.preventDefault(); void resetDraft(); return }
      if (key === '?') { event.preventDefault(); setHelpOpen(true); return }
      if (key === 'f') { event.preventDefault(); setFilter((value) => value === 'flagged' ? 'all' : 'flagged'); return }
      if ((key === 'j' || key === 'k') && visible.length) {
        event.preventDefault()
        setSelectedNumber(moveSelection(visible, selectedNumber, key === 'j' ? 1 : -1))
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [applyDraft, helpOpen, isOpen, onClose, onShowHistory, onShowStudio, resetDraft, selectedNumber, visible])

  if (!isOpen) return null
  const compiledUrl = selectedSlide ? thumbnails[selectedSlide.decision.sourceId] ?? null : null

  return (
    <div className="twi" role="dialog" aria-label="TalkWeaver Importer">
      <header className="twi-topbar">
        <div className="twi-brand"><span>TalkWeaver</span><b>Importer</b></div>
        <nav className="twi-tabs" aria-label="Tools mode">
          <button onClick={onShowStudio}><Radio /> Studio</button>
          <button onClick={onShowHistory}><HistoryIcon /> History</button>
          <button className="active"><FileInput /> Importer</button>
        </nav>
        <div className="twi-spacer" />
        <button className="twi-icon" title="Importer settings" onClick={() => setSettingsOpen((value) => !value)}><Settings /></button>
        <button className="twi-icon" title="Keyboard cheat-sheet (?)" onClick={() => setHelpOpen(true)}>?</button>
        <button className="twi-icon" title="Close (Esc)" onClick={onClose}><X /></button>
        {settingsOpen ? (
          <div className="twi-popover">
            <h3>Import defaults</h3>
            <Toggle label="Include hidden slides" checked={settings.includeHidden} onChange={(value) => void saveSettings({ includeHidden: value })} />
            <Toggle label="Preserve speaker notes" checked={settings.preserveNotes} onChange={(value) => void saveSettings({ preserveNotes: value })} />
            <Toggle label="Extract embedded media" checked={settings.extractMedia} onChange={(value) => void saveSettings({ extractMedia: value })} />
            <label>Fallback policy<select value={settings.fallbackPolicy} onChange={(event) => void saveSettings({ fallbackPolicy: event.target.value as ImporterSettings['fallbackPolicy'] })}><option value="uncertain">Only uncertain slides</option><option value="always">Always retain fallback</option></select></label>
            <div className="twi-health"><b>Renderer</b><span className={capabilities?.renderer.status === 'ready' ? 'ready' : 'blocked'}>{capabilities?.renderer.status ?? 'checking'}</span><small>{capabilities?.renderer.officePath ?? 'LibreOffice not found'}</small><small>{capabilities?.renderer.rasterPath ?? 'pdftoppm not found'}</small></div>
            <button className="twi-link" onClick={() => void saveSettings(DEFAULT_IMPORTER_SETTINGS)}>Restore defaults</button>
          </div>
        ) : null}
      </header>

      {error ? <div className="twi-error"><AlertTriangle /> {error}<button onClick={() => setError(null)}><X /></button></div> : null}
      {busy && progress ? <div className="twi-progress"><LoaderCircle className="spin" /><div><b>{progress.note}</b><span>{progress.completed} of {progress.total || '—'} · {progress.status}</span></div><progress max={Math.max(1, progress.total)} value={progress.completed} /></div> : null}

      {!detail ? (
        <main className="twi-start">
          <section className="twi-source-card">
            <div className="twi-source-icon"><FileInput /></div>
            <p className="eyebrow">PowerPoint to editable TalkWeaver source</p>
            <h1>Bring an existing deck into your talk library.</h1>
            <p>The deterministic pass preserves text, notes, media and a visual fallback. You decide what becomes native TalkWeaver Markdown.</p>
            {capabilities && !capabilities.available ? <div className="twi-platform"><AlertTriangle /><div><b>PowerPoint import is available on macOS.</b><span>This first release uses the macOS rendering toolchain. Existing import runs remain readable here.</span></div></div> : !sources.length ? <div className="twi-source-actions"><button className="primary" onClick={() => void chooseSources('files')}><FileInput /> Choose PowerPoint files</button><button onClick={() => void chooseSources('folder')}><FolderOpen /> Choose a folder</button></div> : (
              <div className="twi-import-form">
                <div className="twi-file"><FileInput /><div><b>{sources.length === 1 ? sources[0].fileName : `${sources.length} PowerPoint files`}</b><span>{sources.reduce((count, source) => count + source.slideCount, 0)} slides · {(sources.reduce((bytes, source) => bytes + source.bytes, 0) / 1_000_000).toFixed(1)} MB</span></div><div className="twi-source-more"><button type="button" onClick={() => void chooseSources('files', 'append')}><FilePlus2 /> Add more files</button><button type="button" onClick={() => void chooseSources('files', 'replace')}><RefreshCw /> Replace selection</button></div></div>
                {sources.length > 1 ? <div className="twi-batch-list">{sources.map((source) => {
                  const hasOverride = Object.prototype.hasOwnProperty.call(destinationOverrides, source.path)
                  const effectiveDestination = effectiveImportDestination(source.path, topicFolder, destinationOverrides)
                  const destinationLabel = effectiveDestination || 'Vault root'
                  return <div className="twi-batch-row" key={source.path}>
                    <div className="twi-batch-source"><span>{source.fileName}</span><small>{source.slideCount} slides</small></div>
                    <span className="twi-batch-destination" title={destinationLabel}>{hasOverride ? destinationLabel : `Default · ${destinationLabel}`}</span>
                    <button type="button" aria-label={`Choose destination for ${source.fileName}`} onClick={() => void chooseDestination(source.path)}><FolderOpen /> Choose folder</button>
                    {hasOverride ? <button type="button" aria-label={`Reset destination for ${source.fileName} to default`} onClick={() => setDestinationOverrides((current) => resetImportDestination(current, source.path))}><RotateCcw /> Reset to default</button> : null}
                  </div>
                })}</div> : null}
                <div className="twi-form-grid">
                  <label>Talk title<input disabled={sources.length > 1} value={sources.length > 1 ? 'Taken from each file name' : title} onChange={(event) => { setTitle(event.target.value); setSlug(slugify(event.target.value)) }} /></label>
                  <label>Slug<input disabled={sources.length > 1} value={sources.length > 1 ? 'Generated for each talk' : slug} onChange={(event) => setSlug(slugify(event.target.value))} /></label>
                  <label>Destination folder<div className="twi-folder-input"><input value={topicFolder} onChange={(event) => setTopicFolder(event.target.value)} placeholder="Vault root" /><button type="button" onClick={() => void chooseDestination()}><FolderOpen /> Choose destination</button></div></label>
                  <label>Slides<input value={slideRange} onChange={(event) => setSlideRange(event.target.value)} placeholder="All, or 1-12, 16, 20-24" /></label>
                </div>
                <div className="twi-options"><Toggle label="Hidden" checked={settings.includeHidden} onChange={(value) => setSettings((current) => ({ ...current, includeHidden: value }))} /><Toggle label="Speaker notes" checked={settings.preserveNotes} onChange={(value) => setSettings((current) => ({ ...current, preserveNotes: value }))} /><Toggle label="Embedded media" checked={settings.extractMedia} onChange={(value) => setSettings((current) => ({ ...current, extractMedia: value }))} /></div>
                <button className="primary" disabled={busy} onClick={() => void beginImport()}>{busy ? <LoaderCircle className="spin" /> : <Play />} {sources.length === 1 ? 'Import into TalkWeaver' : `Import ${sources.length} presentations into TalkWeaver`}</button>
              </div>
            )}
          </section>
          <aside className="twi-runs">
            <div className="section-title"><span>Recent imports</span><button onClick={() => void reloadRuns()}><RefreshCw /></button></div>
            {runs.length ? runs.map((run) => <button key={run.id} className="twi-run" onClick={() => run.status === 'failed' ? void resume(run.id) : void loadRun(run.id)}><span className={`dot ${run.status}`} /><div><b>{run.talk.title}</b><span>{statusLabel(run)} · {run.slides.length} slides</span></div>{run.status === 'failed' ? <Play /> : <ChevronLeft className="reverse" />}</button>) : <p className="muted">No imports yet.</p>}
          </aside>
        </main>
      ) : (
        <main className="twi-bench">
          <aside className="twi-rail">
            <div className="twi-runhead"><button title="Back to imports" onClick={() => setDetail(null)}><ChevronLeft /></button><div><span>Inspection Bench</span><b>{detail.manifest.talk.title}</b></div><button title="Reveal run" onClick={() => void window.tw.importer.revealRun(detail.manifest.id)}><FolderOpen /></button></div>
            <label className="twi-search"><Search /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search slides" /><kbd>⌘F</kbd></label>
            <div className="twi-filters">{(['all', 'flagged', 'fallback', 'failed'] as ImportSlideFilter[]).map((value) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{value}</button>)}</div>
            <div className="twi-slide-list">{visible.map((slide) => <button key={slide.slideNumber} className={slide.slideNumber === selectedNumber ? 'selected' : ''} onClick={() => setSelectedNumber(slide.slideNumber)}><span>{slide.slideNumber}</span><div><b>{slide.title || `Slide ${slide.slideNumber}`}</b><small>{slide.decision.layout} · {slide.status}</small></div>{isFlaggedImportStatus(slide.status) ? <AlertTriangle /> : <Check />}</button>)}</div>
          </aside>

          {selectedSlide && draft ? <section className="twi-canvas">
            <div className="twi-compare">
              <figure><figcaption><span>Original PowerPoint</span><small>Ground truth</small></figcaption>{originalUrl ? <img src={originalUrl} alt={`Original slide ${selectedSlide.slideNumber}`} /> : <div className="twi-preview-empty"><ImageIcon /> Original render unavailable</div>}</figure>
              <figure><figcaption><span>TalkWeaver target</span><small>Compiled preview</small></figcaption>{compiledUrl ? <img src={compiledUrl} alt={`Compiled slide ${selectedSlide.slideNumber}`} /> : previewLoading ? <div className="twi-preview-empty"><LoaderCircle className="spin" /> Rendering preview…</div> : <div className="twi-preview-empty"><Sparkles /> Preview unavailable; Markdown remains editable</div>}</figure>
            </div>
            <div className="twi-editor-head"><div><span>Editable target Markdown</span><small>Deterministic candidate with your overrides</small></div><button onClick={() => setDraft((value) => value ? { ...value, representation: value.representation === 'candidate' ? 'fallback' : 'candidate', markdown: value.representation === 'candidate' ? selectedSlide.decision.fallbackMarkdown : selectedSlide.decision.candidateMarkdown } : value)}><RotateCcw /> Switch representation</button></div>
            <textarea value={draft.markdown} onChange={(event) => setDraft((value) => value ? { ...value, markdown: event.target.value } : value)} spellCheck={false} />
          </section> : <section className="twi-canvas empty">Select a slide.</section>}

          {selectedSlide && draft ? <aside className="twi-inspector">
            <div className="twi-inspector-title"><span>Slide {selectedSlide.slideNumber}</span><b>{selectedSlide.title}</b></div>
            <label>Title<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
            <label>Layout<select value={draft.layout} onChange={(event) => setDraft({ ...draft, layout: event.target.value as ImportLayout })}>
              {IMPORT_LAYOUT_CHOICES.filter((choice) => choice.category == null).map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
              {!isImportLayout(draft.layout) ? <option value={draft.layout}>{draft.layout} (legacy)</option> : null}
              {IMPORT_LAYOUT_CATEGORIES.map((category) => <optgroup key={category} label={IMPORT_LAYOUT_CATEGORY_LABELS[category]}>
                {IMPORT_LAYOUT_CHOICES.filter((choice) => choice.category === category).map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
              </optgroup>)}
            </select></label>
            <label>Representation<select value={draft.representation} onChange={(event) => setDraft({ ...draft, representation: event.target.value as ImportRepresentation })}><option value="candidate">Native candidate</option><option value="fallback">Visual fallback</option></select></label>
            <section><h3>Deterministic evidence</h3>{selectedSlide.decision.basis.map((basis) => <p key={basis} className="twi-evidence"><Check /> {basis}</p>)}{selectedSlide.warnings.map((warning) => <p key={warning} className="twi-warning"><AlertTriangle /> {warning}</p>)}</section>
            <div className="twi-actions"><button onClick={() => void resetDraft()}><RotateCcw /> Reset <kbd>⌥R</kbd></button><button className="primary" disabled={busy} onClick={() => void applyDraft()}><Check /> Apply <kbd>⌘↵</kbd></button></div>
            <section className="twi-cleanup"><h3><Bot /> Agent cleanup</h3><p>Build a self-contained evidence pack. An agent writes suggestions; you review every change here.</p><div className="twi-pass-list">{PASSES.map((pass) => <Toggle key={pass.id} label={pass.label} checked={cleanupPasses.has(pass.id)} onChange={(checked) => setCleanupPasses((current) => { const next = new Set(current); if (checked) next.add(pass.id); else next.delete(pass.id); return next })} />)}</div><Toggle label="Include this slide" checked={cleanupSlides.has(selectedSlide.slideNumber)} onChange={(checked) => setCleanupSlides((current) => { const next = new Set(current); if (checked) next.add(selectedSlide.slideNumber); else next.delete(selectedSlide.slideNumber); return next })} /><button onClick={() => void preparePack()}><Sparkles /> Generate cleanup pack</button>{pack ? <div className="twi-pack"><code>{pack.packDir}</code><div><button onClick={() => void navigator.clipboard.writeText(pack.packDir)}><Clipboard /> Copy</button><button onClick={() => void window.tw.importer.revealRun(detail.manifest.id)}><FolderOpen /> Reveal</button><button onClick={() => void refreshSuggestions()}><RefreshCw /> Refresh suggestions</button></div></div> : null}{suggestionErrors.map((message) => <p className="twi-warning" key={message}><AlertTriangle /> {message}</p>)}{suggestions.filter((item) => item.slideNumber === selectedSlide.slideNumber).map((suggestion) => <div className="twi-suggestion" key={`${suggestion.slideNumber}-${suggestion.category}`}><b>{suggestion.category}</b><p>{suggestion.rationale}</p><pre>{suggestion.markdown}</pre><button onClick={() => void applySuggestion(suggestion)}>Apply suggestion</button></div>)}</section>
          </aside> : <aside className="twi-inspector" />}
        </main>
      )}

      {helpOpen ? <div className="twi-sheet-backdrop" onClick={() => setHelpOpen(false)}><section className="twi-sheet" onClick={(event) => event.stopPropagation()}><button className="close" onClick={() => setHelpOpen(false)}><X /></button><p className="eyebrow">Importer lifecycle</p><h2>Extract, inspect, then improve.</h2><ol><li><b>Deterministic import</b><span>PowerPoint XML, notes and media become a traceable candidate plus a faithful visual fallback.</span></li><li><b>Inspection Bench</b><span>Compare original and compiled output. Warnings identify slides needing judgement.</span></li><li><b>Agent cleanup</b><span>Agents receive evidence and AGENTS.md instructions. Their suggestions never apply themselves.</span></li></ol><div className="twi-shortcuts"><span><kbd>J</kbd><kbd>K</kbd> move</span><span><kbd>F</kbd> flagged</span><span><kbd>⌘F</kbd> search</span><span><kbd>⌘↵</kbd> apply</span><span><kbd>⌥R</kbd> reset</span><span><kbd>Esc</kbd> close</span></div></section></div> : null}
    </div>
  )
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }): JSX.Element {
  return <label className="twi-toggle"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span aria-hidden="true" /><b>{label}</b></label>
}

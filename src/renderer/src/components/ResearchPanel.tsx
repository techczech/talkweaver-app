import ResearchTidySheet from './ResearchTidySheet'
import type { ResearchWriteOp } from '../../../shared/research'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { BookOpen, Plus, Search, X } from 'lucide-react'
import { RESEARCH_SCOPES, RESEARCH_SCOPE_LABELS, RESEARCH_DRAG_TYPE, researchReference, researchSourceLabel, type ResearchItem, type ResearchScope, type ResearchUse, type ResearchUsedResult } from '../../../shared/research'
import { eventMatchesEffectiveShortcut, liveShortcutLabel } from '../keymap/store'
import { notify } from '../lib/notify'
import ResearchPreview from './ResearchPreview'
import '../research-panel.css'

export type ResearchActions = Record<string, () => void>
interface Props {
  talkDir: string
  panelOpen: boolean
  pickerOpen: boolean
  refresh: number
  highlightedFile?: string | null
  registerActions: (actions: ResearchActions) => void
  onCommand: (id: string) => void
  onClosePanel: () => void
  onClosePicker: () => void
  onOpenPanel: () => void
  onCapture: (drop?: { body: string; artefact?: string }) => void
  onRevealFolder: () => void
  onInsert: (item: ResearchItem, slide: boolean) => Promise<boolean>
  onJump: (use: ResearchUse) => void
}
const usageLabel = (reply: ResearchUsedResult | undefined): string => !reply ? 'Checking use…' : !reply.ok ? 'Usage unavailable' : reply.uses.length ? `Used in ${reply.uses.length} slide${reply.uses.length === 1 ? '' : 's'}` : 'Not used yet'
const dateLabel = (value: string): string => {
  const date = new Date(value)
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}
export default function ResearchPanel(props: Props) {
  const { talkDir, panelOpen, pickerOpen, refresh, onCommand } = props
  const [query, setQuery] = useState(''), [scope, setScope] = useState<ResearchScope>('talk')
  const [items, setItems] = useState<ResearchItem[]>([]), [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<ResearchItem | null>(null), [uses, setUses] = useState<Record<string, ResearchUsedResult>>({})
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [skipped, setSkipped] = useState(0), [limited, setLimited] = useState(false)
  const [visibleFiles, setVisibleFiles] = useState<string[]>([])
  const usageCache = useRef<Record<string, ResearchUsedResult>>({})
  const usageSerial = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)
  const [tidy, setTidy] = useState<ResearchWriteOp | null>(null), [menu, setMenu] = useState(false)
  const [openFile, setOpenFile] = useState<string | null>(null)
  const [retry, setRetry] = useState(0), [busy, setBusy] = useState(false)
  const pickerInput = useRef<HTMLInputElement>(null), panelInput = useRef<HTMLInputElement>(null)
  const sourceTarget = useRef<string | null>(null), useTarget = useRef<ResearchUse | null>(null)
  const active = items.find(item => item.file === selected) ?? null
  const item = detail?.file === active?.file ? detail : active
  const local = !!item && (item.inCurrentTalk ?? item.project === talkDir) && !item.archive
  const visible = panelOpen || pickerOpen
  useEffect(() => {
    if (!visible) return
    let cancelled = false
    setLoading(true); setError('')
    const requestId = `search-${++usageSerial.current}`
    const timer = setTimeout(() => {
      const request = scope === 'talk' && !query.trim() ? window.tw.research.list({ talkDir }) : window.tw.research.search({ talkDir, query, scope, requestId })
      void request.then(reply => {
        if (cancelled) return
        setLoading(false)
        if (!reply.ok) { setError(reply.error.message); setItems([]); return }
        setItems(reply.items); setSkipped(reply.skipped); setLimited(reply.limited)
        setSelected(current => props.highlightedFile && reply.items.some(i => i.file === props.highlightedFile) ? props.highlightedFile : reply.items.some(i => i.file === current) ? current : reply.items[0]?.file ?? null)
      }).catch(() => { if (!cancelled) { setLoading(false); setError('Research could not be loaded. Try again.'); setItems([]) } })
    }, query.trim() ? 180 : 0)
    return () => { cancelled = true; clearTimeout(timer); window.tw.research.cancelUsage(requestId) }
  }, [talkDir, query, scope, refresh, retry, visible])
  useEffect(() => {
    setDetail(null)
    if (!active || active.archive) return
    let cancelled = false
    void window.tw.research.list({ talkDir: active.project, file: active.file }).then(reply => {
      if (!cancelled) {
        if (reply.ok) setDetail(reply.items[0] ? { ...reply.items[0], inCurrentTalk: active.inCurrentTalk ?? active.project === talkDir } : null)
        else setError(reply.error.message)
      }
    }).catch(() => { if (!cancelled) setError('This research item could not be opened. Try again.') })
    return () => { cancelled = true }
  }, [active?.file, refresh, retry])
  useEffect(() => {
    // Refresh is emitted after capture/insert. Only that item loses its session cache.
    const file = props.highlightedFile ?? selected
    if (file) { delete usageCache.current[file]; setUses(current => { const next = { ...current }; delete next[file]; return next }) }
  }, [refresh])
  useEffect(() => {
    const list = listRef.current
    if (!list || !visible) { setVisibleFiles([]); return }
    const observer = new IntersectionObserver(entries => {
      setVisibleFiles(current => {
        const next = new Set(current)
        for (const entry of entries) { const file = (entry.target as HTMLElement).dataset.file!; if (entry.isIntersecting) next.add(file); else next.delete(file) }
        return [...next]
      })
    }, { root: list })
    setVisibleFiles([])
    list.querySelectorAll('[data-file]').forEach(row => observer.observe(row))
    return () => observer.disconnect()
  }, [items, visible, pickerOpen])
  useEffect(() => {
    if (!visible) return
    let cancelled = false, next = 0
    const requests = new Set<string>()
    const wanted = new Set([selected, ...visibleFiles])
    const pending = items.filter(entry => wanted.has(entry.file) && !entry.archive && !usageCache.current[entry.file])
    setUses({ ...usageCache.current })
    const work = async (): Promise<void> => {
      while (!cancelled && next < pending.length) {
        const entry = pending[next++], requestId = `usage-${++usageSerial.current}`
        requests.add(requestId)
        const reply = await window.tw.research.whereUsed({ talkDir: entry.project, file: entry.file, requestId }).catch((): ResearchUsedResult => ({ ok: false, error: { code: 'read-failed', message: 'Usage could not be checked. Try again.' } }))
        requests.delete(requestId)
        if (!cancelled) { if (reply.ok) usageCache.current[entry.file] = reply; setUses(current => ({ ...current, [entry.file]: reply })) }
      }
    }
    const timer = setTimeout(() => { for (let i = 0; i < Math.min(2, pending.length); i++) void work() }, 120)
    return () => { cancelled = true; clearTimeout(timer); for (const request of requests) window.tw.research.cancelUsage(request) }
  }, [items, selected, visibleFiles, refresh, retry, visible])
  useEffect(() => { if (pickerOpen) pickerInput.current?.focus() }, [pickerOpen])
  useEffect(() => { if (panelOpen && !pickerOpen) panelInput.current?.focus() }, [panelOpen])
  useEffect(() => {
    if (!visible) return
    const row = document.querySelector(`.research-${pickerOpen ? 'picker' : 'panel'} [aria-selected="true"]`)
    row?.scrollIntoView({ block: 'nearest' })
  }, [selected, visible, pickerOpen])
  const move = (delta: number): void => {
    const index = Math.max(0, items.findIndex(i => i.file === selected))
    const next = Math.max(0, Math.min(items.length - 1, index + delta))
    setSelected(items[next]?.file ?? null)
    if (listRef.current?.contains(document.activeElement)) listRef.current.querySelectorAll<HTMLElement>('[data-file]')[next]?.focus()
  }
  const insert = async (slide: boolean): Promise<void> => {
    if (!item || busy || item.archive) return
    setBusy(true)
    try {
      if (!local) {
        const copied = await window.tw.research.write('insertHere', { file: item.file })
        if (!copied.ok) { notify(copied.error.message, 'error', 'research-insert'); return }
        props.onClosePicker(); setRetry(n => n + 1); return
      }
      if (await props.onInsert(item, slide)) { delete usageCache.current[item.file]; props.onClosePicker(); setRetry(n => n + 1) } }
    catch { notify('This research item could not be inserted. Try again.', 'error', 'research-insert') }
    finally { setBusy(false) }
  }
  const reveal = (file: string): void => {
    void window.tw.research.revealSource(file).then(reply => { if (!reply.ok) notify(reply.error.message, 'error', 'research-reveal') }).catch(() => notify('The source could not be revealed. Try again.', 'error', 'research-reveal'))
  }
  const openSource = (source: string): void => {
    const value = source.replace(/^url:/, '')
    if (/^https?:\/\//i.test(value)) void window.tw.shell.openExternal(value)
    else if (source.startsWith('file:')) { const path = source.slice(5); reveal(path.startsWith('/') ? path : `${item?.project}/${path}`) }
    else if (!/^[a-z][a-z\d+.-]*:/i.test(source) && item?.project) {
      // Relative file sources resolve in main through the existing safe reveal path.
      reveal(source.startsWith('/') ? source : `${item.project}/research/${source}`)
    }
  }
  const actions: ResearchActions = {
    ...Object.fromEntries([['rename', 'rename'], ['change-kind', 'kind'], ['delete', 'delete'], ['move', 'move'], ['copy', 'copy']].map(([id, op]) => [`research-${id}`, () => { if (local) { setMenu(false); setTidy(op as ResearchWriteOp) } }])),
    'research-insert-here': () => { void insert(false) },
    'research-insert': () => { void insert(false) },
    'research-make-slide': () => { void insert(true) },
    'research-copy-reference': () => { if (item) void navigator.clipboard.writeText(local ? researchReference(item) : `${item.title} — ${item.file}`).catch(() => notify('The reference could not be copied. Try again.', 'error')) },
    'research-open': () => { if (item) { setOpenFile(current => current === item.file && !pickerOpen ? null : item.file); props.onOpenPanel() } },
    'research-reveal': () => { if (item) reveal(!local && item.project ? item.project : item.file) },
    'research-source': () => { const source = sourceTarget.current ?? item?.sources[0]; if (source) openSource(source); sourceTarget.current = null },
    'research-used-in': () => { const reply = item ? uses[item.file] : undefined; const target = useTarget.current ?? (reply?.ok ? reply.uses[0] : undefined); if (target) props.onJump(target); useTarget.current = null },
    'research-next': () => move(1), 'research-previous': () => move(-1),
    'research-scope': () => setScope(current => RESEARCH_SCOPES[(RESEARCH_SCOPES.indexOf(current) + 1) % RESEARCH_SCOPES.length]),
    'research-scope-talk': () => setScope('talk'), 'research-scope-research': () => setScope('research'), 'research-scope-everything': () => setScope('everything'),
    'research-close': () => pickerOpen ? props.onClosePicker() : props.onClosePanel(),
    'research-retry': () => setRetry(n => n + 1)
  }
  useLayoutEffect(() => { props.registerActions(actions); return () => props.registerActions({}) })
  useEffect(() => {
    if (!visible) return
    const onKey = (event: KeyboardEvent): void => {
      if (tidy || (event.target as Element)?.closest('.research-actions, .research-detail')) return
      if (!pickerOpen && !(event.target as Element)?.closest('.research-list, .research-search input')) return
      for (const id of ['previous', 'next', 'insert', 'make-slide', 'open', 'scope', 'close']) {
        if (!eventMatchesEffectiveShortcut(event, `research.${id}`, `research-${id}`)) continue
        event.preventDefault(); event.stopImmediatePropagation(); onCommand(`research-${id}`); return
      }
    }
    // shortcut-id: research.previous research.next research.insert research.make-slide research.open research.scope research.close
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })
  if (!visible) return null
  const sourceButton = (source: string, index: number): JSX.Element => <button type="button" className="research-link" key={index} onClick={() => { sourceTarget.current = source; onCommand('research-source') }}>{researchSourceLabel(source)}</button>
  const used = item ? uses[item.file] : undefined
  const inspector = item && <section className="research-detail" aria-label="Research item preview">
    <div className="research-detail-title">{openFile === item.file && <span>Open research · Read-only preview</span>}<span className={`research-kind research-kind--${item.kind}`}>{item.kind}</span><h3>{item.title}</h3></div>
    {!local && <p className="research-project">{item.projectTitle} · Read-only preview</p>}
    <div className="research-sources">{item.sources.map(sourceButton)}</div>
    <ResearchPreview item={item} onSource={source => { sourceTarget.current = source; onCommand('research-source') }} />
    <div className={`research-uses${used?.ok && !used.uses.length ? ' is-unused' : ''}`}>
      <b>{item.archive ? 'Archive result' : usageLabel(used)}</b>
      {used?.ok && used.uses.map(use => <button className="research-link" type="button" key={`${use.file}:${use.slideLine}`} onClick={() => { useTarget.current = use; onCommand('research-used-in') }}>{`Slide ${use.slideNumber ?? 1} “${use.slideTitle}”`}</button>)}
      {used && !used.ok && <span>{used.error.message}</span>}
    </div>
    {item.prompt && <details><summary>Prompt and capture details</summary><p>{item.prompt}</p><p>{dateLabel(item.created)} · {item.by}</p></details>}
    <div className="research-actions">
      {local ? <><button type="button" className="research-primary" disabled={busy} onClick={() => onCommand('research-insert')}>Insert</button><button type="button" disabled={busy} onClick={() => onCommand('research-make-slide')}>Make slide</button><button type="button" onClick={() => onCommand('research-copy-reference')}>Copy reference</button></>
        : <><button type="button" disabled={busy || item.archive} onClick={() => onCommand('research-insert-here')}>Insert here</button><button type="button" onClick={() => onCommand('research-open')}>Open</button><button type="button" onClick={() => onCommand('research-reveal')}>{item.project ? 'Reveal talk' : 'Reveal'}</button></>}
      {local && <div className="research-tidy-menu"><button type="button" aria-label="Tidy research" aria-expanded={menu} onClick={() => setMenu(value => !value)}>…</button>{menu && <div role="group" aria-label="Tidy research actions">{[['rename', 'Rename…'], ['change-kind', 'Change kind…'], ['delete', 'Delete…'], ['move', 'Move to another talk…'], ['copy', 'Copy to another talk…']].map(([id, label]) => <button key={id} type="button" onClick={() => onCommand(`research-${id}`)}>{label}</button>)}</div>}</div>}
    </div>
  </section>
  const content = (picker: boolean): JSX.Element => <>
    <header className="research-head"><BookOpen size={16}/><b>Research</b>{!picker && <button type="button" onClick={() => props.onCapture()}><Plus size={13}/> Capture</button>}<button type="button" className="research-close" aria-label="Close research" onClick={() => onCommand('research-close')}><X size={16}/></button></header>
    <div className="research-search"><label><Search size={15}/><input ref={picker ? pickerInput : panelInput} value={query} placeholder="Search research by meaning" aria-label="Search research" onChange={event => setQuery(event.target.value)} /></label>
      <div className="research-scopes" role="group" aria-label="Research scope">{RESEARCH_SCOPES.map(value => <button key={value} type="button" aria-pressed={scope === value} onClick={() => onCommand(`research-scope-${value}`)}>{RESEARCH_SCOPE_LABELS[value]}</button>)}</div>
    </div>
    {scope === 'everything' && <p className="research-status">Everything: not in the scope now</p>}
    {scope !== 'talk' && items.some(entry => entry.project && !(entry.inCurrentTalk ?? entry.project === talkDir)) && <p className="research-status">{items.filter(entry => entry.project && !(entry.inCurrentTalk ?? entry.project === talkDir)).length} results in other talks</p>}
    {picker && <p className="research-status">{Math.max(0, items.findIndex(entry => entry.file === selected) + 1)} of {items.length} items</p>}
    {error && <div className="research-error" role="alert">{error}<button type="button" onClick={() => onCommand('research-retry')}>Try again</button></div>}
    {loading && <p className="research-status" role="status">Loading research…</p>}
    {!loading && !error && !items.length ? scope === 'talk' && !query.trim() ? <div className="research-empty"><BookOpen size={28}/><h3>Nothing collected for this talk yet</h3><p>Research keeps the evidence, tables, charts and search results you gather for this talk. Select text and capture it, drop a file here, or press Capture.</p><button type="button" className="research-primary" onClick={() => props.onCapture()}>Capture to research</button><button type="button" onClick={props.onRevealFolder}>Reveal research folder</button></div> : <p className="research-empty">No results in {RESEARCH_SCOPE_LABELS[scope]}</p>
      : <div className="research-body">{!picker && openFile === item?.file && <button type="button" onClick={() => onCommand('research-open')}>Back to results</button>}<div hidden={!picker && openFile === item?.file} ref={listRef} className="research-list" role="listbox" aria-label="Research items">{items.map(entry => <button data-file={entry.file} key={entry.file} type="button" role="option" aria-selected={entry.file === selected} className={`research-row${entry.file === selected ? ' is-selected' : ''}`} tabIndex={entry.file === selected ? 0 : -1} draggable={(entry.inCurrentTalk ?? entry.project === talkDir) && !entry.archive} onDragStart={event => { event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData(RESEARCH_DRAG_TYPE, entry.file) }} onClick={() => setSelected(entry.file)}>
        <span className="research-row-title"><span className={`research-kind research-kind--${entry.kind}`}>{entry.kind}</span><strong>{entry.title}</strong>{!entry.archive && <span className={`research-used${uses[entry.file]?.ok && !(uses[entry.file] as { ok: true; uses: ResearchUse[] }).uses.length ? ' is-unused' : ''}`}>{usageLabel(uses[entry.file])}</span>}</span><span className="research-preview">{entry.preview}</span>
        {scope !== 'talk' && <span className="research-project">{entry.projectTitle}</span>}
        <span className="research-row-meta"><span>{dateLabel(entry.created)}</span><span>{entry.sources[0] ? researchSourceLabel(entry.sources[0]) : ''}</span></span>
      </button>)}</div>{inspector}</div>}
    {(skipped > 0 || limited) && <p className="research-status">{skipped > 0 ? `${skipped} unreadable item${skipped === 1 ? '' : 's'} skipped. ` : ''}{limited ? 'Showing a limited result set. Narrow your search.' : ''}</p>}
    {picker && <footer className="research-picker-foot">{[['previous','↑'],['next','↓'],['insert','Insert at cursor'],['make-slide','Make slide'],['open','Open panel'],['scope','Change scope'],['close','Close']].map(([id, title]) => <span key={id}><kbd>{liveShortcutLabel(`research.${id}`)}</kbd> {title}</span>)}</footer>}
  </>
  return <>{tidy && item && <ResearchTidySheet key={`${item.file}:${tidy}`} item={item} op={tidy} onClose={() => { setTidy(null); panelInput.current?.focus() }} onDone={() => { setTidy(null); usageCache.current = {}; setDetail(null); setRetry(n => n + 1) }}/>} {panelOpen && !pickerOpen && <aside className="research-panel" aria-label="Research" onDragOver={event => { if (event.dataTransfer.types.includes('Files') || event.dataTransfer.types.includes('text/plain')) event.preventDefault() }} onDrop={event => {
    if (event.dataTransfer.types.includes(RESEARCH_DRAG_TYPE)) return
    const file = event.dataTransfer.files[0], body = event.dataTransfer.getData('text/plain')
    if (!file && !body) return
    event.preventDefault(); event.stopPropagation()
    props.onCapture({ body, ...(file ? { artefact: window.tw.asset.pathForFile(file) } : {}) })
  }}>{content(false)}</aside>}{pickerOpen && <div className="research-picker-overlay"><div className="research-picker" role="dialog" aria-modal="true" aria-label="Find in research">{content(true)}</div></div>}</>
}

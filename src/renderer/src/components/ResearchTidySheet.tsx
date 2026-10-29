import { useEffect, useRef, useState } from 'react'
import type { ResearchItem, ResearchWriteInput, ResearchWriteOp, ResearchWriteResult } from '../../../shared/research'

const kinds = ['evidence', 'table', 'visualisation', 'snippet', 'search', 'widget']
const labels = { rename: 'Rename research', kind: 'Change research kind', delete: 'Delete research', move: 'Move research to another talk', copy: 'Copy research to another talk', insertHere: 'Insert here' }
export default function ResearchTidySheet({ item, op, onClose, onDone }: { item: ResearchItem; op: ResearchWriteOp; onClose: () => void; onDone: (file: string) => void }) {
  const [title, setTitle] = useState(item.title), [kind, setKind] = useState(item.kind), [renameSlug, setRenameSlug] = useState(false)
  const [destination, setDestination] = useState(''), [talks, setTalks] = useState<{ path: string; title: string }[]>([])
  const [preview, setPreview] = useState<Extract<ResearchWriteResult, { ok: true }> | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const sheet = useRef<HTMLDivElement>(null), cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    cancel.current?.focus()
    if (op !== 'move' && op !== 'copy') return
    let cancelled = false
    void window.tw.research.destinations().then(list => { if (!cancelled) setTalks(list.filter(t => t.path !== item.project)) }).catch(() => { if (!cancelled) setError('The open talks could not be loaded. Try again.') })
    return () => { cancelled = true }
  }, [op, item.project])
  useEffect(() => { if (preview && !busy) cancel.current?.focus() }, [preview, busy])
  useEffect(() => { setPreview(null) }, [title, kind, renameSlug, destination])
  const submit = async (): Promise<void> => {
    if (busy) return
    const input: Omit<ResearchWriteInput, 'op'> = { file: item.file, ...(op === 'rename' ? { title, renameSlug } : {}), ...(op === 'kind' ? { kind } : {}), ...(['move', 'copy'].includes(op) ? { destination } : {}) }
    setBusy(true); setError('')
    try {
      const reply = await window.tw.research.write(op, { ...input, ...(preview ? { confirmation: preview.confirmation } : { preview: true }) })
      if (!reply.ok) { setError(reply.error.message); setPreview(null); return }
      if (!preview) { setPreview(reply); cancel.current?.focus() }
      else onDone(reply.file)
    } catch { setError('The research action could not finish. Try again.') }
    finally { setBusy(false) }
  }
  return <div className="research-tidy-overlay"><div ref={sheet} className="research-tidy-sheet" role="dialog" aria-modal="true" aria-label={labels[op]} onKeyDown={event => {
    // SCAN_IGNORE: local modal dismissal and focus containment; these are not content commands.
    if (event.key === 'Escape') { event.stopPropagation(); if (!busy) onClose() }
    if (event.key !== 'Tab') return
    const buttons = [...sheet.current!.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)')]
    const first = buttons[0], last = buttons.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }}>
    <h2>{labels[op]}</h2><p>{item.title}</p>
    {op === 'rename' && <><label>Title<input maxLength={500} value={title} disabled={busy} onChange={e => setTitle(e.target.value)}/></label><label><input type="checkbox" checked={renameSlug} disabled={busy} onChange={e => setRenameSlug(e.target.checked)}/> Rename the file slug too</label></>}
    {op === 'kind' && <label>Kind<select aria-label="Kind" value={kind} disabled={busy} onChange={e => setKind(e.target.value)}>{kinds.map(k => <option key={k}>{k}</option>)}</select></label>}
    {(op === 'move' || op === 'copy') && <label>Destination talk<select aria-label="Destination talk" value={destination} disabled={busy} onChange={e => setDestination(e.target.value)}><option value="">Choose a talk</option>{talks.map(t => <option key={t.path} value={t.path}>{t.title} · {t.path}</option>)}</select></label>}
    {op === 'delete' && <p>The item and its artefacts will move to the Trash.</p>}
    {preview && <section aria-label="Affected slides"><b>{preview.uses?.length ? `Used in ${preview.uses.length} slide${preview.uses.length === 1 ? '' : 's'}:` : 'No uses found'}</b><ul>{preview.uses?.map(use => <li key={`${use.file}:${use.slideLine}`}>Slide {use.slideNumber ?? 1} “{use.slideTitle}”{!use.file.startsWith(item.project + '/') && ` in ${talks.find(t => use.file.startsWith(t.path + '/'))?.title ?? use.file.split('/').at(-2)}`}</li>)}</ul>{(op === 'move' || op === 'rename' && renameSlug) && <><p>Backlinks in this talk will be updated to the {op === 'move' ? 'moved copy' : 'renamed file'}.</p>{preview.uses?.some(use => !use.file.startsWith(item.project + '/')) && <p>These slides in other talks will have broken links.</p>}</>}{!!preview.uncheckedOutlines?.length && <><p>Could not check these outlines. Their slides may have broken links:</p><ul>{preview.uncheckedOutlines.map(file => <li key={file}>{file}</li>)}</ul></>}</section>}
    {error && <p role="alert">{error}</p>}
    <footer><button type="button" ref={cancel} disabled={busy} onClick={onClose}>Cancel</button><button type="button" disabled={busy || op === 'rename' && !title.trim() || ['move', 'copy'].includes(op) && !destination} onClick={() => void submit()}>{busy ? 'Working…' : preview ? op === 'delete' ? 'Move to Trash' : 'Confirm' : 'Review changes'}</button></footer>
  </div></div>
}

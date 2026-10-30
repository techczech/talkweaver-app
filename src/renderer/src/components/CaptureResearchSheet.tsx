import { useEffect, useRef, useState } from 'react'
import { notify } from '../lib/notify'
import { capturedNotice, RESEARCH_KINDS } from '../lib/research-capture-wording'
import '../research-capture.css'

// "Capture to research…": file one reusable unit (evidence, a table, a snippet…) in the research folder
// beside the open talk. The sheet only collects the words; the file is written by `scout capture`,
// reached through window.tw.research.capture (src/main/research-capture.ts). The body starts as the
// editor's selection; "Use clipboard" replaces it with the clipboard's text.

interface Props {
  talkDir: string
  talkTitle: string
  /** The editor's selected text when the sheet opened ('' when nothing is selected). */
  initialBody: string
  initialArtefact?: string
  onCaptured?: (file: string) => void
  onClose: () => void
}

export default function CaptureResearchSheet({ talkDir, talkTitle, initialBody, initialArtefact, onCaptured, onClose }: Props) {
  const [title, setTitle] = useState('')
  const [kind, setKind] = useState('evidence')
  const [prompt, setPrompt] = useState('')
  const [body, setBody] = useState(initialBody)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [titleMissing, setTitleMissing] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)

  useEffect(() => { titleRef.current?.focus() }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const useClipboard = async (): Promise<void> => {
    try {
      const text = await navigator.clipboard.readText()
      if (!text) { setError('The clipboard has no text.'); return }
      setError(null)
      setBody(text)
    } catch {
      setError('TalkWeaver could not read the clipboard. Paste the text into the box instead.')
    }
  }

  const save = async (): Promise<void> => {
    if (busy) return
    if (!title.trim()) { setTitleMissing(true); setError('Give the capture a title.'); titleRef.current?.focus(); return }
    setBusy(true)
    setError(null)
    const reply = await window.tw.research.capture({ talkDir, title, kind, prompt: prompt.trim() || undefined, artefact: initialArtefact, body })
      .catch(() => null)
    setBusy(false)
    if (!reply) { setError('The capture could not be filed. Try again.'); return }
    if (!reply.ok) { setError(reply.error.message); return }
    onCaptured?.(reply.file)
    onClose()
    notify(capturedNotice(reply.file, reply.indexed), 'success', 'research-captured', {
      label: 'Reveal research folder',
      onAction: () => { void window.tw.research.revealFolder(talkDir).then((r) => { if (!r.ok) notify(r.error.message, 'error', 'research-reveal') }) }
    })
  }

  return (
    <div className="rc-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="rc-sheet" role="dialog" aria-modal="true" aria-labelledby="rc-title" data-testid="capture-research-sheet"
        onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void save() } }}>
        <div className="rc-head">
          {initialArtefact && <p>Attached file: {initialArtefact.split(/[\\/]/).at(-1)}</p>}
          <h2 id="rc-title">Capture to research</h2>
          <p>Files this in the research folder beside “{talkTitle}”, where Scout can find it later.</p>
        </div>
        <div className="rc-body">
          <div className="rc-row">
            <label className="rc-field"><span className="rc-label">Title <em>· required</em></span>
              <input ref={titleRef} data-field="title" value={title} maxLength={160} placeholder="Hebb's rule, one line"
                aria-invalid={titleMissing || undefined} className={titleMissing ? 'is-error' : undefined}
                onChange={(event) => { setTitle(event.target.value); setTitleMissing(false) }}
                onKeyDown={(event) => { if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); void save() } }} />
            </label>
            <label className="rc-field"><span className="rc-label">Kind</span>
              <select data-field="kind" value={kind} onChange={(event) => setKind(event.target.value)}>
                {RESEARCH_KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
              </select>
            </label>
          </div>
          <label className="rc-field"><span className="rc-label">Prompt <em>· optional</em></span>
            <input data-field="prompt" value={prompt} placeholder="The question that produced it" onChange={(event) => setPrompt(event.target.value)} />
          </label>
          <label className="rc-field">
            <span className="rc-label">Text
              <button type="button" className="rc-btn rc-btn-plain rc-btn-small" data-testid="capture-use-clipboard" onClick={() => { void useClipboard() }}>Use clipboard</button>
            </span>
            <textarea data-field="body" value={body} placeholder="The table, the quotation with its citation, the paragraph…" onChange={(event) => setBody(event.target.value)} />
          </label>
        </div>
        <div className="rc-foot">
          <span className={`rc-note ${error ? 'is-error' : ''}`} role={error ? 'alert' : undefined} data-testid="capture-research-message">{error ?? ''}</span>
          <button type="button" className="rc-btn rc-btn-plain" onClick={onClose} data-testid="capture-research-cancel">Cancel</button>
          <button type="button" className="rc-btn" disabled={busy} onClick={() => { void save() }} data-testid="capture-research-save">{busy ? 'Filing…' : 'Capture'}</button>
        </div>
      </div>
    </div>
  )
}

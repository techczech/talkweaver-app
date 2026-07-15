import { useState, useEffect, useRef, useMemo, KeyboardEvent } from 'react'
import type { TalkInfo } from '../../../preload/index'

interface Props {
  vaultRoot: string
  /** Existing subfolders (vault-rel paths) to choose from. */
  folders?: string[]
  /** Pre-selected subfolder (e.g. when "New talk here" was used on a folder). */
  defaultTopic?: string
  onCreated: (talk: TalkInfo) => void
  onClose: () => void
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export default function NewTalkDialog({ vaultRoot: _vaultRoot, folders = [], defaultTopic = '', onCreated, onClose }: Props) {
  const [title, setTitle] = useState('')
  const [topicFolder, setTopicFolder] = useState(defaultTopic)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const titleRef = useRef<HTMLInputElement>(null)

  const slug = slugify(title)

  // Sorted, de-duplicated subfolder options (always include the pre-selected one).
  const folderOptions = useMemo(() => {
    const set = new Set<string>()
    for (const f of folders) if (f) set.add(f)
    if (defaultTopic) set.add(defaultTopic)
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [folders, defaultTopic])

  useEffect(() => {
    titleRef.current?.focus()
  }, [])

  useEffect(() => {
    function handleKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  async function handleCreate() {
    if (!title.trim()) {
      setError('Title is required.')
      titleRef.current?.focus()
      return
    }
    if (!slug) {
      setError('Title must produce a valid slug.')
      return
    }

    setError(null)
    setCreating(true)

    try {
      // IPC handler vault:create-talk is wired in main/index.ts
      const newTalk: TalkInfo = await (window as any).tw.vault.createTalk({
        title: title.trim(),
        slug,
        topicFolder: topicFolder.trim() || undefined
      })
      onCreated(newTalk)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to create talk.')
      setCreating(false)
    }
  }

  function handleTitleKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleCreate()
    }
  }

  function handleBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  return (
    <div className="dialog-backdrop" onClick={handleBackdropClick} style={backdropStyle}>
      <div className="dialog-card" style={cardStyle}>
        <h2 style={headingStyle}>New Talk</h2>

        <div style={fieldStyle}>
          <label htmlFor="talk-title" style={labelStyle}>
            Talk title
          </label>
          <input
            id="talk-title"
            ref={titleRef}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={handleTitleKey}
            placeholder="e.g. AI in Higher Education"
            style={inputStyle}
            disabled={creating}
            autoComplete="off"
          />
          <div style={slugPreviewStyle}>
            {slug ? (
              <>
                <span style={slugLabelStyle}>Folder name: </span>
                <code style={slugCodeStyle}>{slug}</code>
              </>
            ) : (
              <span style={slugPlaceholderStyle}>Slug preview will appear here</span>
            )}
          </div>
        </div>

        <div style={fieldStyle}>
          <label htmlFor="talk-topic" style={labelStyle}>
            Subfolder <span style={optionalStyle}>(where to create it)</span>
          </label>
          <select
            id="talk-topic"
            value={topicFolder}
            onChange={(e) => setTopicFolder(e.target.value)}
            style={inputStyle}
            disabled={creating}
          >
            <option value="">Vault root</option>
            {folderOptions.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
          <div style={hintStyle}>Choose an existing folder, or create new folders in the sidebar.</div>
        </div>

        {error && <div style={errorStyle}>{error}</div>}

        <div style={actionsStyle}>
          <button
            onClick={onClose}
            disabled={creating}
            style={{ ...btnStyle, ...btnSecondaryStyle }}
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={creating || !title.trim()}
            style={{
              ...btnStyle,
              ...btnPrimaryStyle,
              ...(creating || !title.trim() ? btnDisabledStyle : {})
            }}
          >
            {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inline styles — uses CSS custom properties from the paper palette where
// available, so they automatically follow any theme the host sets.
// ---------------------------------------------------------------------------

const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  backgroundColor: 'rgba(0, 0, 0, 0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000
}

const cardStyle: React.CSSProperties = {
  background: 'var(--paper, #f5f0e8)',
  border: '1px solid var(--line, #c8b89a)',
  borderRadius: 8,
  padding: '2rem',
  width: 420,
  maxWidth: '90vw',
  boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem'
}

const headingStyle: React.CSSProperties = {
  margin: 0,
  fontSize: '1.2rem',
  fontWeight: 600,
  color: 'var(--ink, #1a1410)'
}

const fieldStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem'
}

const labelStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  fontWeight: 500,
  color: 'var(--ink, #1a1410)'
}

const optionalStyle: React.CSSProperties = {
  fontWeight: 400,
  color: 'var(--ink-faint, #888)'
}

const inputStyle: React.CSSProperties = {
  padding: '0.45rem 0.6rem',
  fontSize: '0.95rem',
  border: '1px solid var(--line, #c8b89a)',
  borderRadius: 4,
  background: 'var(--paper-light, #faf7f2)',
  color: 'var(--ink, #1a1410)',
  outline: 'none'
}

const slugPreviewStyle: React.CSSProperties = {
  fontSize: '0.8rem',
  minHeight: '1.2em',
  marginTop: 2
}

const slugLabelStyle: React.CSSProperties = {
  color: 'var(--ink-faint, #888)'
}

const slugCodeStyle: React.CSSProperties = {
  fontFamily: 'monospace',
  background: 'var(--paper-mid, #ede8df)',
  padding: '0 4px',
  borderRadius: 3,
  color: 'var(--oxford, #002147)'
}

const slugPlaceholderStyle: React.CSSProperties = {
  color: 'var(--ink-faint, #aaa)',
  fontStyle: 'italic'
}

const hintStyle: React.CSSProperties = {
  fontSize: '0.78rem',
  color: 'var(--ink-faint, #888)'
}

const errorStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  color: '#c0392b',
  background: '#fdecea',
  border: '1px solid #f5c6c6',
  borderRadius: 4,
  padding: '0.4rem 0.6rem'
}

const actionsStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: '0.5rem',
  marginTop: '0.5rem'
}

const btnStyle: React.CSSProperties = {
  padding: '0.45rem 1.1rem',
  fontSize: '0.9rem',
  borderRadius: 4,
  border: '1px solid transparent',
  cursor: 'pointer',
  fontWeight: 500,
  transition: 'opacity 0.15s'
}

const btnPrimaryStyle: React.CSSProperties = {
  background: 'var(--oxford, #002147)',
  color: '#fff',
  border: '1px solid var(--oxford, #002147)'
}

const btnSecondaryStyle: React.CSSProperties = {
  background: 'transparent',
  color: 'var(--ink, #1a1410)',
  border: '1px solid var(--line, #c8b89a)'
}

const btnDisabledStyle: React.CSSProperties = {
  opacity: 0.5,
  cursor: 'not-allowed'
}

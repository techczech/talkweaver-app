import { useState, useEffect, useRef, useCallback } from 'react'
import type { TalkInfo } from '../../../preload/index'

interface Props {
  talk: TalkInfo | null
  isOpen: boolean
  onClose: () => void
}

function scaffold(title: string): string {
  return `---
title: ${title}
genre: talk
series: []
deliveries: []
lineage: []
---

## Abstract

(one paragraph describing this talk)

## Delivery history

## Lineage
`
}

export default function AbstractPanel({ talk, isOpen, onClose }: Props) {
  const [raw, setRaw] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [isScaffold, setIsScaffold] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Load abstract.md when the panel opens for a talk.
  useEffect(() => {
    if (!isOpen || !talk) return

    let cancelled = false
    setLoading(true)
    setError(null)
    setSaved(false)
    setIsScaffold(false)
    ;(async () => {
      try {
        const result = await window.tw.abstract.read(talk.path)
        if (cancelled) return
        if (result) {
          setRaw(result.raw)
          setIsScaffold(false)
        } else {
          setRaw(scaffold(talk.title))
          setIsScaffold(true)
        }
      } catch (err) {
        if (cancelled) return
        setRaw(scaffold(talk.title))
        setIsScaffold(true)
        setError(err instanceof Error ? err.message : 'Failed to read abstract.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [isOpen, talk])

  const handleSave = useCallback(async () => {
    if (!talk) return
    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const ok = await window.tw.abstract.write(talk.path, raw)
      if (ok) {
        setSaved(true)
        setIsScaffold(false)
      } else {
        setError('Save failed.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to write abstract.')
    } finally {
      setSaving(false)
    }
  }, [talk, raw])

  // Escape closes.
  useEffect(() => {
    if (!isOpen) return
    function handleKeyDown(e: globalThis.KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  function handleBackdropClick(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose()
  }

  if (!isOpen || !talk) return null

  return (
    <div style={backdropStyle} onClick={handleBackdropClick}>
      <div style={modalStyle} role="dialog" aria-modal="true" aria-label="Abstract editor">
        <div style={headerStyle}>
          <span style={titleStyle}>Abstract — {talk.title}</span>
          <button
            type="button"
            onClick={onClose}
            style={closeBtnStyle}
            aria-label="Close abstract editor"
            title="Close"
          >
            ×
          </button>
        </div>

        <div style={bodyStyle}>
          {isScaffold && (
            <div style={noticeStyle}>
              No <code style={codeStyle}>abstract.md</code> yet. A scaffold is shown below — edit it
              and Save to create the file.
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value)
              setSaved(false)
            }}
            disabled={loading}
            spellCheck={false}
            style={textareaStyle}
            placeholder={loading ? 'Loading…' : ''}
          />
        </div>

        <div style={footerStyle}>
          <div style={statusStyle}>
            {error ? (
              <span style={errorStyle}>{error}</span>
            ) : saved ? (
              <span style={savedStyle}>Saved</span>
            ) : null}
          </div>
          <div style={actionsStyle}>
            <button
              type="button"
              onClick={onClose}
              style={{ ...btnStyle, ...btnSecondaryStyle }}
            >
              Close
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || loading}
              style={{
                ...btnStyle,
                ...btnPrimaryStyle,
                ...(saving || loading ? btnDisabledStyle : {})
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Inline styles — CSS custom properties with fallbacks, warm-paper palette.
// ---------------------------------------------------------------------------

const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  backgroundColor: 'rgba(0, 0, 0, 0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1100
}

const modalStyle: React.CSSProperties = {
  position: 'fixed',
  top: '50%',
  left: '50%',
  transform: 'translate(-50%, -50%)',
  width: 640,
  maxWidth: '92vw',
  maxHeight: '80vh',
  background: 'var(--panel, #f5f0e8)',
  border: '1px solid var(--line, #c8b89a)',
  borderRadius: 6,
  zIndex: 1100,
  overflow: 'hidden',
  display: 'flex',
  flexDirection: 'column',
  boxShadow: '0 8px 32px rgba(0,0,0,0.22)'
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '0.6rem 0.9rem',
  borderBottom: '1px solid var(--line, #c8b89a)',
  flex: '0 0 auto'
}

const titleStyle: React.CSSProperties = {
  fontSize: '0.95rem',
  fontWeight: 600,
  color: 'var(--ink, #1a1410)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}

const closeBtnStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--ink-faint, #888)',
  fontSize: '1.4rem',
  lineHeight: 1,
  cursor: 'pointer',
  padding: '0 0.25rem',
  marginLeft: '0.5rem'
}

const bodyStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
  padding: '0.9rem',
  overflow: 'hidden',
  minHeight: 0
}

const noticeStyle: React.CSSProperties = {
  fontSize: '0.8rem',
  color: 'var(--ink-faint, #7a6f5e)',
  background: 'var(--paper-mid, #ede8df)',
  border: '1px solid var(--line, #c8b89a)',
  borderRadius: 4,
  padding: '0.4rem 0.6rem',
  flex: '0 0 auto'
}

const codeStyle: React.CSSProperties = {
  fontFamily: 'monospace',
  background: 'var(--paper-light, #faf7f2)',
  padding: '0 3px',
  borderRadius: 3
}

const textareaStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 360,
  resize: 'none',
  width: '100%',
  boxSizing: 'border-box',
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", "Source Code Pro", monospace',
  fontSize: '0.85rem',
  lineHeight: 1.5,
  padding: '0.7rem 0.8rem',
  border: '1px solid var(--line, #c8b89a)',
  borderRadius: 4,
  background: 'var(--paper-light, #faf7f2)',
  color: 'var(--ink, #1a1410)',
  outline: 'none',
  tabSize: 2
}

const footerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.75rem',
  padding: '0.6rem 0.9rem',
  borderTop: '1px solid var(--line, #c8b89a)',
  flex: '0 0 auto'
}

const statusStyle: React.CSSProperties = {
  fontSize: '0.82rem',
  flex: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}

const savedStyle: React.CSSProperties = {
  color: 'var(--oxford, #006644)'
}

const errorStyle: React.CSSProperties = {
  color: '#c0392b'
}

const actionsStyle: React.CSSProperties = {
  display: 'flex',
  gap: '0.5rem',
  flex: '0 0 auto'
}

const btnStyle: React.CSSProperties = {
  padding: '0.4rem 1rem',
  fontSize: '0.88rem',
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

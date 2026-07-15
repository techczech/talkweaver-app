import { useEffect, useRef, useState } from 'react'

// Inline name prompt + destructive confirm (Electron blocks window.prompt/confirm).
// Moved verbatim from the pre-ADR-0008 TalkList; App imports PromptModal for New folder.

export function PromptModal({
  label,
  initial,
  cta,
  onCancel,
  onSubmit
}: {
  label: string
  initial: string
  cta: string
  onCancel: () => void
  onSubmit: (value: string) => void
}) {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select() }) }, [])
  return (
    <>
      <div style={promptBackdrop} onClick={onCancel} />
      <div style={promptModal} role="dialog" aria-modal="true" aria-label={label}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 8 }}>{label}</div>
        <input
          ref={inputRef}
          style={promptInput}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); onSubmit(value) }
            else if (e.key === 'Escape') { e.preventDefault(); onCancel() }
          }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button style={promptBtnGhost} onClick={onCancel}>Cancel</button>
          <button style={promptBtn} onClick={() => onSubmit(value)}>{cta}</button>
        </div>
      </div>
    </>
  )
}

export function ConfirmModal({
  label,
  cta,
  danger,
  onCancel,
  onConfirm
}: {
  label: string
  cta: string
  danger?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel() }
      else if (e.key === 'Enter') { e.preventDefault(); onConfirm() }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [onCancel, onConfirm])
  return (
    <>
      <div style={promptBackdrop} onClick={onCancel} />
      <div style={promptModal} role="dialog" aria-modal="true" aria-label={label}>
        <div style={{ fontSize: 13, color: 'var(--ink)', lineHeight: 1.5, marginBottom: 12 }}>{label}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button style={promptBtnGhost} onClick={onCancel}>Cancel</button>
          <button style={danger ? { ...promptBtn, background: '#b3261e', borderColor: '#b3261e' } : promptBtn} onClick={onConfirm}>{cta}</button>
        </div>
      </div>
    </>
  )
}

const promptBackdrop: React.CSSProperties = { position: 'fixed', inset: 0, zIndex: 1300, background: 'rgba(23,32,42,0.35)' }
const promptModal: React.CSSProperties = {
  position: 'fixed', top: '38%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 1301,
  width: 360, maxWidth: '90vw', background: 'var(--panel)', border: '1px solid var(--line)',
  borderRadius: 10, boxShadow: '0 12px 40px #17202a2e', padding: 16, fontFamily: 'var(--font-ui)'
}
const promptInput: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 14,
  border: '1px solid var(--line)', borderRadius: 6, background: 'var(--paper)', color: 'var(--ink)'
}
const promptBtn: React.CSSProperties = {
  fontSize: 13, padding: '6px 14px', borderRadius: 6, border: '1px solid var(--oxford)',
  background: 'var(--oxford)', color: '#fff', cursor: 'pointer'
}
const promptBtnGhost: React.CSSProperties = {
  fontSize: 13, padding: '6px 14px', borderRadius: 6, border: '1px solid var(--line)',
  background: 'transparent', color: 'var(--muted)', cursor: 'pointer'
}

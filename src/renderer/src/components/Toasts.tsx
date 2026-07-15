import { useEffect, useState } from 'react'
import { TOAST_DISMISS_EVENT, TOAST_EVENT, type ToastDetail } from '../lib/notify'

interface Toast extends ToastDetail {
  id: number
}

let nextId = 1

// Global toast stack (mounted once in App). Errors stay until dismissed; warnings ~8s; info/success
// ~4s. A toast with a `key` replaces any existing toast with that key (no duplicate spam).
export default function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([])

  useEffect(() => {
    function onToast(e: Event): void {
      const detail = (e as CustomEvent<ToastDetail>).detail
      if (!detail || !detail.message) return
      setToasts((prev) => {
        const withoutKey = detail.key ? prev.filter((t) => t.key !== detail.key) : prev
        const toast: Toast = { ...detail, id: nextId++ }
        const next = [...withoutKey, toast]
        // Errors and actionable toasts (e.g. the merge nudge) persist until dismissed/acted on;
        // otherwise info/success ~4s, warning ~8s.
        if (detail.level !== 'error' && !detail.action) {
          const ms = detail.level === 'warning' ? 8000 : 4000
          setTimeout(() => setToasts((cur) => cur.filter((t) => t.id !== toast.id)), ms)
        }
        return next.slice(-5) // cap the stack
      })
    }
    function onDismiss(e: Event): void {
      const key = (e as CustomEvent<string>).detail
      if (key) setToasts((prev) => prev.filter((t) => t.key !== key))
    }
    window.addEventListener(TOAST_EVENT, onToast)
    window.addEventListener(TOAST_DISMISS_EVENT, onDismiss)
    return () => {
      window.removeEventListener(TOAST_EVENT, onToast)
      window.removeEventListener(TOAST_DISMISS_EVENT, onDismiss)
    }
  }, [])

  function dismiss(id: number): void {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }

  if (toasts.length === 0) return null

  return (
    <div style={wrap} role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} style={{ ...toastStyle, ...levelStyle[t.level] }}>
          <span style={glyphStyle}>{GLYPH[t.level]}</span>
          <span style={{ flex: 1, lineHeight: 1.4 }}>{t.message}</span>
          {t.action && (
            <button
              style={actionStyle}
              onClick={() => { t.action?.onAction(); dismiss(t.id) }}
            >
              {t.action.label}
            </button>
          )}
          <button style={closeStyle} onClick={() => dismiss(t.id)} aria-label="Dismiss">×</button>
        </div>
      ))}
    </div>
  )
}

const GLYPH: Record<string, string> = { error: '⛔', warning: '⚠', info: 'ℹ', success: '✓' }

const wrap: React.CSSProperties = {
  position: 'fixed', bottom: 16, right: 16, zIndex: 2000,
  display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 'min(420px, 90vw)'
}
const toastStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', borderRadius: 8,
  fontSize: 13, fontFamily: 'var(--font-ui)', boxShadow: '0 8px 30px #17202a33',
  border: '1px solid', background: 'var(--panel)'
}
const levelStyle: Record<string, React.CSSProperties> = {
  error: { borderColor: '#b3261e', background: '#fdecec', color: '#7a1b14' },
  warning: { borderColor: '#b8860b', background: '#fbf3df', color: '#6b4e08' },
  info: { borderColor: 'var(--line)', color: 'var(--ink)' },
  success: { borderColor: '#1b7a44', background: '#e9f6ee', color: '#155c33' }
}
const glyphStyle: React.CSSProperties = { flexShrink: 0, fontSize: 14, lineHeight: 1.3 }
const closeStyle: React.CSSProperties = {
  flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', fontSize: 16,
  lineHeight: 1, color: 'inherit', opacity: 0.6, padding: '0 2px'
}
const actionStyle: React.CSSProperties = {
  flexShrink: 0, background: 'currentColor', border: 'none', cursor: 'pointer',
  fontSize: 12, fontWeight: 600, lineHeight: 1, padding: '5px 10px', borderRadius: 6,
  color: 'var(--panel)', mixBlendMode: 'normal'
}

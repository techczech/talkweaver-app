import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { STATUS_NOTICE_SLOT_EVENT, TOAST_DISMISS_EVENT, TOAST_EVENT, type ToastDetail } from '../lib/notify'

interface Toast extends ToastDetail {
  id: number
}

let nextId = 1

// Global toast stack (mounted once in App). Errors stay until dismissed; warnings ~8s; info/success
// ~4s. A toast with a `key` replaces any existing toast with that key (no duplicate spam).
export default function Toasts() {
  const [toasts, setToasts] = useState<Toast[]>([])
  // R2: notices are drawn in the status bar when there is one (a chip, with a popover for the whole text and the action);
  // a window without a status bar still gets the floating stack.
  const [slot, setSlot] = useState<HTMLElement | null>(() => document.querySelector<HTMLElement>('[data-status-notice-slot]'))
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onSlot = (e: Event): void => setSlot((e as CustomEvent<HTMLElement | null>).detail ?? null)
    window.addEventListener(STATUS_NOTICE_SLOT_EVENT, onSlot)
    return () => window.removeEventListener(STATUS_NOTICE_SLOT_EVENT, onSlot)
  }, [])
  useEffect(() => { if (toasts.length === 0) setOpen(false) }, [toasts.length])

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

  if (slot) {
    const latest = toasts[toasts.length - 1]
    const more = toasts.length - 1
    return createPortal(
      <span role="status" aria-live="polite" style={{ ...noticeChip, ...levelStyle[latest.level] }} data-status-notice={latest.level}>
        <button type="button" style={noticeMain} title={latest.message} aria-expanded={open} aria-label={`Notice: ${latest.message}`} onClick={() => setOpen((v) => !v)}>
          <span style={glyphStyle} aria-hidden>{GLYPH[latest.level]}</span>
          <span style={noticeText}>{latest.message}</span>
          {more > 0 && <span style={{ flexShrink: 0, opacity: 0.7 }}>+{more}</span>}
        </button>
        {latest.action && (
          <button style={{ ...noticeAction, ...actionTone[latest.level] }} data-toast-action={latest.level} onClick={() => { latest.action?.onAction(); dismiss(latest.id) }}>{latest.action.label}</button>
        )}
        <button style={closeStyle} onClick={() => dismiss(latest.id)} aria-label="Dismiss">×</button>
        {open && (
          <div role="dialog" aria-label="Notices" style={noticePop}>
            {toasts.slice().reverse().map((t) => (
              <div key={t.id} style={{ ...toastStyle, ...levelStyle[t.level], boxShadow: 'none' }}>
                <span style={glyphStyle}>{GLYPH[t.level]}</span>
                <span style={{ flex: 1, lineHeight: 1.4, whiteSpace: 'normal' }}>{t.message}</span>
                {t.action && (
                  <button style={{ ...actionStyle, ...actionTone[t.level] }} data-toast-action={t.level} onClick={() => { t.action?.onAction(); dismiss(t.id) }}>{t.action.label}</button>
                )}
                <button style={closeStyle} onClick={() => dismiss(t.id)} aria-label="Dismiss">×</button>
              </div>
            ))}
          </div>
        )}
      </span>,
      slot
    )
  }

  return (
    <div style={wrap} role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} style={{ ...toastStyle, ...levelStyle[t.level] }}>
          <span style={glyphStyle}>{GLYPH[t.level]}</span>
          <span style={{ flex: 1, lineHeight: 1.4 }}>{t.message}</span>
          {t.action && (
            <button
              style={{ ...actionStyle, ...actionTone[t.level] }}
              data-toast-action={t.level}
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
const noticeChip: React.CSSProperties = {
  position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 4, height: 18, padding: '0 4px 0 6px', borderRadius: 4,
  fontSize: 11, fontFamily: 'var(--font-ui)', border: '1px solid', whiteSpace: 'nowrap', maxWidth: 'min(360px, 40vw)'
}
const noticeMain: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0, background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', font: 'inherit', padding: 0 }
const noticeText: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, maxWidth: 'min(280px, 30vw)' }
const noticeAction: React.CSSProperties = { flexShrink: 0, border: 'none', cursor: 'pointer', fontSize: 10.5, fontWeight: 600, lineHeight: 1, padding: '3px 7px', borderRadius: 4 }
const noticePop: React.CSSProperties = {
  position: 'absolute', right: 0, bottom: 'calc(100% + 6px)', width: 'min(420px, 90vw)', zIndex: 2000, whiteSpace: 'normal',
  display: 'flex', flexDirection: 'column', gap: 6, padding: 6, borderRadius: 8, background: 'var(--panel)', border: '1px solid var(--line)', boxShadow: '0 8px 30px #17202a33'
}
const glyphStyle: React.CSSProperties = { flexShrink: 0, fontSize: 14, lineHeight: 1.3 }
const closeStyle: React.CSSProperties = {
  flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer', fontSize: 16,
  lineHeight: 1, color: 'inherit', opacity: 0.6, padding: '0 2px'
}
const actionStyle: React.CSSProperties = {
  flexShrink: 0, border: 'none', cursor: 'pointer',
  fontSize: 12, fontWeight: 600, lineHeight: 1, padding: '5px 10px', borderRadius: 6
}
// The action button is a filled button in the toast's own tone: its text colour as the fill, white
// on it (the app's filled-button pairing, as `.sh-btn`: var(--oxford) with #fff). It used to set
// `background: currentColor` with `color: var(--panel)`, which made the fill the panel colour too:
// a blank box, the label unreadable on every toast.
const actionTone: Record<string, React.CSSProperties> = {
  error: { background: '#7a1b14', color: '#fff' },
  warning: { background: '#6b4e08', color: '#fff' },
  info: { background: 'var(--oxford)', color: '#fff' },
  success: { background: '#155c33', color: '#fff' }
}

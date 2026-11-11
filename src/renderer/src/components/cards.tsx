import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'

// House rule R10: ONE confirm card for every destructive action and ONE name card for every new and
// rename. The confirm card names the item, says where it goes and whether it can be recovered, with
// Cancel on the left and a red verb button on the right. The name card is "New <kind>" or
// "Rename <kind>", one field, pre-filled and selected, with Cancel and a verb button. Both sit on the
// same frame (CardFrame), in the main window's button styles (navy primary, red destructive).

/** What a deletion into the Bin says (talks, research, recordings): where it goes and how to get it back. */
export const BIN_CONSEQUENCE = 'It moves to the Bin.'
export const BIN_RECOVERY = 'You can recover it from the Bin until you empty it.'

const isControl = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('button, a[href], select, textarea, summary, [role="button"], [role="link"]') !== null

interface FrameProps {
  /** The dialog's accessible name; also the visible heading unless `heading` is given. */
  label: string
  heading?: ReactNode
  onCancel: () => void
  /** True while a request is running: the card cannot be dismissed. */
  busy?: boolean
  cancelLabel?: string
  cta: string
  onConfirm: () => void
  /** A red verb button (destructive). */
  danger?: boolean
  disabled?: boolean
  /** Focus the Cancel button on open (confirm cards). Name cards focus their field instead. */
  focusCancel?: boolean
  /** Enter confirms from anywhere on the card (the talk list's long-standing behaviour). */
  enterConfirms?: boolean
  children?: ReactNode
  testId?: string
  className?: string
  /** Extra width for cards that list affected slides. */
  wide?: boolean
}

export function CardFrame({ label, heading, onCancel, busy, cancelLabel = 'Cancel', cta, onConfirm, danger, disabled, focusCancel, enterConfirms, children, testId, className, wide }: FrameProps) {
  const card = useRef<HTMLDivElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (focusCancel) cancel.current?.focus() }, [focusCancel])
  useEffect(() => {
    // Capture phase so the editor's keymap never sees Escape (or Enter) while a card is up.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!busy) onCancel() }
      // Enter on a focused control (Cancel, a link, a disclosure) does what that control does; only
      // Enter from elsewhere on the card confirms. Otherwise Enter on the focused Cancel would delete.
      else if (enterConfirms && e.key === 'Enter' && !disabled && !busy && !isControl(e.target)) { e.preventDefault(); onConfirm() }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [onCancel, onConfirm, busy, disabled, enterConfirms])
  // Tab stays inside the card.
  const contain = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Tab' || !card.current) return
    const items = [...card.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary')]
    const first = items[0]; const last = items.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  return (
    <>
      <div style={backdrop} onClick={() => { if (!busy) onCancel() }} />
      <div ref={card} className={`tw-card${className ? ` ${className}` : ''}`} data-testid={testId} style={{ ...cardStyle, ...(wide ? { width: 480 } : {}) }} role="dialog" aria-modal="true" aria-label={label} onKeyDown={contain}>
        <div style={headingStyle}>{heading ?? label}</div>
        {children}
        <div style={footerStyle}>
          <button type="button" ref={cancel} style={ghostBtn} disabled={busy} onClick={onCancel}>{cancelLabel}</button>
          <button type="button" style={{ ...(danger ? dangerBtn : primaryBtn), ...(disabled || busy ? disabledStyle : {}) }} disabled={disabled || busy} onClick={onConfirm}>{busy ? 'Working…' : cta}</button>
        </div>
      </div>
    </>
  )
}

export interface ConfirmCardProps {
  /** The question, naming the kind: "Delete this talk?" */
  title: string
  /** The item, shown in quotes so the person sees exactly what is affected. */
  itemName?: string
  /** What happens, in one sentence ("It moves to the Bin."). */
  consequence?: string
  /** Whether and how it can be undone ("You can recover it from the Bin."). */
  recovery?: string
  /** The verb on the red button: Delete, Unpublish, Combine. */
  cta: string
  onCancel: () => void
  onConfirm: () => void
  busy?: boolean
  danger?: boolean
  enterConfirms?: boolean
  /** A free-form body used instead of item, consequence and recovery (older call sites). */
  body?: ReactNode
  /** More detail under the sentences (for instance the slides a deletion would affect). */
  children?: ReactNode
  testId?: string
  wide?: boolean
}

export function ConfirmCard({ title, itemName, consequence, recovery, cta, onCancel, onConfirm, busy, danger = true, enterConfirms, body, children, testId, wide }: ConfirmCardProps) {
  return (
    <CardFrame label={title} onCancel={onCancel} onConfirm={onConfirm} cta={cta} danger={danger} busy={busy} focusCancel enterConfirms={enterConfirms} testId={testId ?? 'confirm-card'} wide={wide}>
      {body ?? (
        <div style={bodyStyle}>
          {itemName ? <div><b style={{ fontWeight: 650 }}>“{itemName}”</b></div> : null}
          {consequence ? <div>{consequence}</div> : null}
          {recovery ? <div style={{ color: 'var(--muted)' }}>{recovery}</div> : null}
        </div>
      )}
      {children}
    </CardFrame>
  )
}

export interface NameCardProps {
  /** What is being named: "talk", "folder", "pathway", "research item", "group". */
  kind: string
  mode: 'new' | 'rename'
  /** The current name (rename) or a suggestion; selected on open. */
  initial?: string
  placeholder?: string
  /** The verb button; "Create" for new and "Rename" for rename unless given. */
  cta?: string
  onCancel: () => void
  onSubmit: (value: string) => void
  busy?: boolean
  error?: string | null
  /** Older call sites: a whole sentence as the heading instead of "New <kind>" / "Rename <kind>". */
  headingOverride?: string
  /** An empty name is refused unless this is true. */
  allowEmpty?: boolean
  /** More fields below the name (a subfolder, a Details disclosure). */
  children?: ReactNode
  /** Existing hooks the end-to-end checks rely on. */
  inputId?: string
  className?: string
  /** Keep the name in the parent as it is typed (the New Talk dialog needs it for its checks). */
  onChange?: (value: string) => void
}

export function NameCard({ kind, mode, headingOverride, initial = '', placeholder, cta, onCancel, onSubmit, busy, error, allowEmpty, children, inputId, className, onChange }: NameCardProps) {
  const [value, setValue] = useState(initial)
  const input = useRef<HTMLInputElement>(null)
  const heading = headingOverride ?? `${mode === 'new' ? 'New' : 'Rename'} ${kind}`
  useEffect(() => { requestAnimationFrame(() => { input.current?.focus(); input.current?.select() }) }, [])
  const empty = !allowEmpty && !value.trim()
  const submit = (): void => { if (!empty && !busy) onSubmit(value) }
  return (
    <CardFrame label={heading} onCancel={onCancel} onConfirm={submit} cta={cta ?? (mode === 'new' ? 'Create' : 'Rename')} disabled={empty} busy={busy} className={className} testId="name-card">
      <input
        id={inputId}
        ref={input}
        style={inputStyle}
        value={value}
        placeholder={placeholder}
        aria-label={headingOverride ? 'Name' : `${kind[0].toUpperCase()}${kind.slice(1)} name`}
        autoComplete="off"
        disabled={busy}
        onChange={(e) => { setValue(e.target.value); onChange?.(e.target.value) }}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
      />
      {children}
      {error ? <div role="alert" style={errorStyle}>{error}</div> : null}
    </CardFrame>
  )
}

const backdrop: CSSProperties = { position: 'fixed', inset: 0, zIndex: 1300, background: 'rgba(23,32,42,0.35)' }
const cardStyle: CSSProperties = {
  position: 'fixed', top: '38%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 1301,
  width: 380, maxWidth: '90vw', maxHeight: '80vh', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 10,
  background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 10, boxShadow: '0 12px 40px #17202a2e',
  padding: 16, fontFamily: 'var(--font-ui)', color: 'var(--ink)'
}
const headingStyle: CSSProperties = { fontSize: 13, fontWeight: 600, color: 'var(--ink)' }
const bodyStyle: CSSProperties = { fontSize: 13, color: 'var(--ink)', lineHeight: 1.5, display: 'flex', flexDirection: 'column', gap: 2 }
const footerStyle: CSSProperties = { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 4 }
const inputStyle: CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 14,
  border: '1px solid var(--line)', borderRadius: 6, background: 'var(--paper)', color: 'var(--ink)'
}
const primaryBtn: CSSProperties = { fontSize: 13, padding: '6px 14px', borderRadius: 6, border: '1px solid var(--oxford)', background: 'var(--oxford)', color: '#fff', cursor: 'pointer' }
const dangerBtn: CSSProperties = { ...primaryBtn, background: '#b3261e', borderColor: '#b3261e' }
const ghostBtn: CSSProperties = { fontSize: 13, padding: '6px 14px', borderRadius: 6, border: '1px solid var(--line)', background: 'transparent', color: 'var(--muted)', cursor: 'pointer' }
const disabledStyle: CSSProperties = { opacity: 0.5, cursor: 'default' }
const errorStyle: CSSProperties = { fontSize: 12.5, color: '#b3261e', background: '#fdecea', border: '1px solid #f5c6c6', borderRadius: 6, padding: '6px 8px' }

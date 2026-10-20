import { useEffect, useRef } from 'react'
import { EyeOff, X } from 'lucide-react'

// The Unpublish confirmation of the Run page (work-files ticket 17; locked mockup state 12 "From the Run
// page"): a sheet hanging from the top of the Tools window, its title and one sentence (shared/run-page.ts
// unpublishConfirmText), Cancel and Unpublish. Presentational: SessionsView owns the call.
//
// A MODAL, kept as one (ticket 17 fix round): while it is open everything else in the window is `inert`
// (no focus, no click, hidden from assistive technology), and Tab and Shift+Tab go round its own buttons
// only. Esc cancels. Return unpublishes ONLY when the Unpublish button has the focus (it has it when the
// sheet opens, as drawn); on Cancel it cancels, and anywhere else it does nothing.

export interface UnpublishRunConfirmProps {
  title: string
  body: string
  /** True while the unpublish runs. */
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}

/**
 * Make everything in the document outside `keep` inert: each sibling of `keep` and of each of its
 * ancestors up to <body>. Answers the undo, which leaves alone what was inert already.
 */
export function inertOutside(keep: HTMLElement): () => void {
  const changed: HTMLElement[] = []
  for (let node: HTMLElement | null = keep; node && node !== node.ownerDocument.body; node = node.parentElement) {
    const parent: HTMLElement | null = node.parentElement
    if (!parent) break
    for (const sibling of Array.from(parent.children) as Element[]) {
      if (sibling === node || !(sibling instanceof HTMLElement) || sibling.hasAttribute('inert')) continue
      sibling.setAttribute('inert', '')
      changed.push(sibling)
    }
  }
  return () => { for (const element of changed) element.removeAttribute('inert') }
}

export function UnpublishRunConfirm({ title, body, busy = false, onCancel, onConfirm }: UnpublishRunConfirmProps): JSX.Element {
  const layerRef = useRef<HTMLDivElement | null>(null)
  const sheetRef = useRef<HTMLDivElement | null>(null)
  const confirmRef = useRef<HTMLButtonElement | null>(null)
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    const undo = layerRef.current ? inertOutside(layerRef.current) : () => {}
    confirmRef.current?.focus()
    return undo
  }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const focused = document.activeElement
      if (event.key === 'Tab') {
        // Round the sheet's own buttons; while it runs (both disabled) the focus stays on the sheet.
        event.preventDefault()
        event.stopPropagation()
        const buttons = [cancelRef.current, confirmRef.current].filter((button): button is HTMLButtonElement => !!button && !button.disabled)
        if (!buttons.length) { sheetRef.current?.focus(); return }
        const at = buttons.indexOf(focused as HTMLButtonElement)
        const next = at === -1 ? (event.shiftKey ? buttons.length - 1 : 0) : (at + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length
        buttons[next].focus()
        return
      }
      if (busy) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel(); return }
      if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        event.preventDefault()
        event.stopPropagation()
        if (focused === confirmRef.current) onConfirm()
        else if (focused === cancelRef.current) onCancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [busy, onCancel, onConfirm])
  return (
    <div className="tw-unpub-layer" ref={layerRef} data-unpublish-layer>
      <div className="tw-unpub-scrim" data-unpublish-scrim onMouseDown={() => { if (!busy) onCancel() }} />
      <div className="tw-unpub-sheet" ref={sheetRef} tabIndex={-1} role="alertdialog" aria-modal="true" aria-labelledby="tw-unpub-title" aria-describedby="tw-unpub-body" data-unpublish-confirm>
        <div className="shh"><EyeOff aria-hidden /><h2 id="tw-unpub-title">{title}</h2></div>
        <div className="shb" id="tw-unpub-body">{body}</div>
        <div className="shf">
          <span className="sp" />
          <button type="button" ref={cancelRef} className="tw-sess-btn" data-unpublish-action="cancel" disabled={busy} onClick={onCancel}><X aria-hidden />Cancel</button>
          <button type="button" ref={confirmRef} className="tw-sess-btn dng solid" data-unpublish-action="confirm" disabled={busy} onClick={onConfirm}><EyeOff aria-hidden />Unpublish</button>
        </div>
      </div>
    </div>
  )
}

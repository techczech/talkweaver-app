// Look and sound (docs/design/2026-11-10-record-and-edit-video, contract "look"): the finishing choices for
// the whole video. Each choice is one edit on the Run's sidecar (op `finish`), undoable like a cut, and
// shows in the player before exporting. The groups the 0.44 editor already has elsewhere (captions,
// chapters in the export sheet) stay there; title and end cards and the name check are not built.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import type { RecordingFinish } from '../../../../shared/recording-edits'
import type { PlayerSource } from './LayeredPlayer'

/**
 * The player's source with the evened voice when Even out the volume is on. The evened copy is made in
 * main on first use; until it is ready the player plays the voice as recorded and `evening` is true.
 */
export function useEvenVoice(runRef: { talkSlug: string; runId: string; home: string | null | undefined }, source: PlayerSource | null, on: boolean): { source: PlayerSource | null; evening: boolean; error: string | null } {
  const [voice, setVoice] = useState<{ key: PlayerSource; url: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ready = !!voice && voice.key === source
  useEffect(() => {
    if (!on || !source?.voice || ready || !window.tw.recordingVideo?.prepareEven) return
    let alive = true
    setError(null)
    void window.tw.recordingVideo.prepareEven(runRef).then((r) => {
      if (!alive) return
      if (r.ok) setVoice({ key: source, url: r.voice })
      else setError(r.error)
    }).catch((e) => { if (alive) setError(String(e)) })
    return () => { alive = false }
  }, [on, source, ready, runRef])
  if (!source || !on || !source.voice) return { source, evening: false, error: null }
  if (!ready || !voice) return { source, evening: !error, error }
  return { source: voice.url ? { ...source, voice: voice.url } : source, evening: false, error: null }
}

/** The sheet. `evening`: the evened voice for the player is still being made. */
export function LookAndSoundSheet({ finish, hasVoice, evening, evenError, disabled, onChange, onClose }: {
  finish: RecordingFinish
  hasVoice: boolean
  evening: boolean
  evenError: string | null
  disabled: boolean
  onChange: (finish: Partial<RecordingFinish>) => void
  onClose: () => void
}): ReactNode {
  return (
    <ModalSheet className="tre-look" labelledBy="tre-look-title" onClose={onClose}>
        <header><h2 id="tre-look-title">Look and sound</h2></header>
        <div className="tre-sheet-body">
          <div className="tre-look-set">
            <span className="tre-look-name" id="tre-look-cuts">Cuts</span>
            <div className="tre-look-choice" role="group" aria-labelledby="tre-look-cuts">
              <label><input type="checkbox" checked={finish.smoothJoins} disabled={disabled} onChange={(e) => onChange({ smoothJoins: e.target.checked })} /> Smooth each join with a quick fade, so your face does not jump</label>
              <span className="tre-look-note">{finish.smoothJoins ? 'The sound crosses over and the picture fades through at every cut.' : 'Each cut is a straight cut; the sound fades out and in.'}</span>
            </div>
            <span className="tre-look-name" id="tre-look-sound">Sound</span>
            <div className="tre-look-choice" role="group" aria-labelledby="tre-look-sound">
              <label><input type="checkbox" checked={finish.evenVolume} disabled={disabled || !hasVoice} onChange={(e) => onChange({ evenVolume: e.target.checked })} /> Even out the volume</label>
              {!hasVoice ? <span className="tre-look-note">This recording has no voice.</span>
                : finish.evenVolume && evening ? <span className="tre-look-note" role="status"><Loader2 className="lt-icon spin" /> Evening out the volume for the player…</span>
                : finish.evenVolume && evenError ? <span className="tre-look-note warn" role="status">The player could not even out the volume ({evenError}); the export still will.</span>
                : <span className="tre-look-note">Quiet and loud parts are brought to one level, as for a podcast.</span>}
            </div>
          </div>
        </div>
        <footer>
          <span className="tre-look-foot">These apply to the whole video and can be changed at any time.</span>
          <span className="tre-sp" />
          <button className="tw-btn tw-btn--primary" onClick={onClose}>Done</button>
        </footer>
    </ModalSheet>
  )
}

/**
 * A sheet over the editor as a native modal dialog (showModal): the rest of the window is inert, Tab stays
 * inside, Escape closes it (the dialog's own cancel), and a click outside it (pressed and released there) closes
 * it. Focus goes to its first control; when the sheet closes, by any of the three, focus goes back to the
 * control that opened it.
 */
/** A radio that Tab skips: another radio of its group is checked (Tab reaches a group once, on its checked radio). */
function all0(el: HTMLInputElement): boolean {
  return !!el.name && !!el.form?.querySelector(`input[type="radio"][name="${el.name}"]:checked`) || !!el.closest('dialog')?.querySelector(`input[type="radio"][name="${el.name}"]:checked`)
}

export function ModalSheet({ className, labelledBy, onClose, children }: { className: string; labelledBy: string; onClose: () => void; children: ReactNode }): ReactNode {
  const ref = useRef<HTMLDialogElement>(null)
  // A click outside closes on the click, not on pointerdown: closing on pointerdown put focus back on the
  // opener before the same press's mousedown moved focus to the page itself. Both ends of the press must be
  // outside the sheet's box: where the pointer went down and where that same pointer came up (by position,
  // so it holds for touch and pen, whose events stay with the element they began on).
  const press = useRef<{ id: number; down: boolean; up: boolean } | null>(null)
  const outside = (e: { clientX: number; clientY: number }): boolean => {
    const box = ref.current?.getBoundingClientRect()
    return !box || e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom
  }
  useEffect(() => {
    const d = ref.current
    // The control that opened the sheet, recorded before showModal moves focus in; focus goes back to it.
    const opener = document.activeElement instanceof HTMLElement && !d?.contains(document.activeElement) ? document.activeElement : null
    if (d && !d.open) d.showModal()
    return () => {
      if (d?.open) d.close()
      if (opener?.isConnected) opener.focus()
    }
  }, [])
  return (
    <dialog ref={ref} className={`tre-sheet tre-modal ${className}`} aria-labelledby={labelledBy}
      onCancel={(e) => { e.preventDefault(); onClose() }} onPointerDown={(e) => { press.current = { id: e.pointerId, down: outside(e), up: false } }}
      onPointerUp={(e) => { if (press.current?.id === e.pointerId) press.current.up = outside(e) }}
      onPointerCancel={() => { press.current = null }}
      onClick={() => { const p = press.current; press.current = null; if (p?.down && p.up) onClose() }}
      onKeyDown={(e) => {
        // The window behind is inert, but Tab past the last control would leave for the browser itself:
        // it wraps to the first instead (and Shift+Tab from the first to the last).
        if (e.key !== 'Tab') return
        const all = [...e.currentTarget.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')]
          .filter((el) => !(el as HTMLButtonElement).disabled && el.offsetParent !== null && !(el instanceof HTMLInputElement && el.type === 'radio' && !el.checked && all0(el)))
        if (!all.length) return
        const first = all[0], last = all[all.length - 1]
        if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
        else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
      }}>
      {children}
    </dialog>
  )
}

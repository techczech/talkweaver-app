import { useEffect, useRef } from 'react'
import { EXAMPLE_REMOVAL_TEXT, binDetail, type ExampleRemovalPreview } from '../../../shared/example-vault-removal'
import { VaultBadge } from './talklist/VaultRows'
import '../example-removal.css'

// "Remove the example vault?" (onboarding ticket 12; locked drawing state 15): one confirmation for
// both entry points (the example vault's ⋯ menu and the Guide's first screen), with three bounded
// lists. The folder and the count are the ones main read when the confirmation opened; Remove gives
// main back only the token. Pure presentation: App owns the calls.

export interface RemoveExampleConfirmProps {
  /** The example vault's badge (colour and initial), as in the Talks panel. */
  vault: { color: string; initial: string; name: string }
  /** null while main reads the folder. */
  preview: ExampleRemovalPreview | null
  /** True while the removal runs (the checks and the move). */
  busy: boolean
  /** One sentence when the removal did not go ahead. */
  error: string | null
  onCancel: () => void
  onConfirm: (token: string) => void
}

/** The example vault's folder, home-relative: fixed by main (example-vault-removal.ts rule A). Shown
 *  whenever the preview has no path to show (still reading, or refused), so the row never reads "…". */
const EXAMPLE_FOLDER_HOME_PATH = '~/Documents/TalkWeaver/Example vault'
const PATH_MAX_CHARS = 60

/** Keeps the start and end of a long path and joins them with "…" in the middle. */
export function middleTruncate(text: string, max: number = PATH_MAX_CHARS): string {
  if (text.length <= max) return text
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

export default function RemoveExampleConfirm({ vault, preview, busy, error, onCancel, onConfirm }: RemoveExampleConfirmProps) {
  const T = EXAMPLE_REMOVAL_TEXT.confirm
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { cancelRef.current?.focus() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape' && !busy) { e.preventDefault(); onCancel() } }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [busy, onCancel])
  const refused = preview && !preview.ok ? preview.message : null
  const ready = preview && preview.ok ? preview : null
  return (
    <div className="rx-scrim" data-remove-example-scrim onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel() }}>
      <div className="rx-sheet" role="dialog" aria-modal="true" aria-labelledby="rx-title" data-remove-example>
        <div className="rx-top">
          <VaultBadge vault={{ ...vault, open: true }} size={36} />
          <div>
            <h2 id="rx-title">{T.title}</h2>
            <p>{T.lead}</p>
          </div>
        </div>
        <div className="rx-group rx-group--bin" data-rx-group="bin">
          <div className="rx-bar">{T.binBar}</div>
          <div className="rx-item rx-item--path">
            <b data-rx-folder title={ready ? ready.folder : EXAMPLE_FOLDER_HOME_PATH}>{middleTruncate(ready ? ready.folder : EXAMPLE_FOLDER_HOME_PATH)}</b>
            <span data-rx-count>{ready ? binDetail(ready.talks) : ''}</span>
          </div>
        </div>
        <div className="rx-group" data-rx-group="off">
          <div className="rx-bar">{T.offBar}</div>
          {T.off.map((line) => <div key={line} className="rx-item">{line}</div>)}
        </div>
        <div className="rx-group rx-group--kept" data-rx-group="kept">
          <div className="rx-bar">{T.keptBar}</div>
          {T.kept.map((line) => <div key={line} className="rx-item">{line}</div>)}
        </div>
        {(refused || error) && <p className="rx-error" role="alert" data-rx-error>{refused ?? error}</p>}
        <div className="rx-foot">
          <button ref={cancelRef} type="button" className="rx-btn" data-rx-cancel disabled={busy} onClick={onCancel}>{T.cancel}</button>
          <button
            type="button"
            className="rx-btn rx-btn--danger"
            data-rx-confirm
            disabled={busy || !ready}
            onClick={() => { if (ready) onConfirm(ready.token) }}
          >
            {T.ok}
          </button>
        </div>
      </div>
    </div>
  )
}

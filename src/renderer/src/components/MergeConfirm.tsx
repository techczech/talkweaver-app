// Merge-into-one-slide confirm (Task 9, ADR-0032) — the sibling overlay that turns a byte-identical
// cluster into a single ledger slide. Mounted by the host (like PropagationChecklist) rather than
// inside the Browser, because the insert-time nudge opens it AFTER the Browser has closed on insert.
// Every close path is busy-gated while the merge IPC is in flight, mirroring the checklist fix: an
// in-flight merge must report back into this panel (partial failures as row strips), never the void.
import { useEffect, useRef, useState } from 'react'
import { FolderOpen, GitMerge, ShieldCheck, X } from 'lucide-react'
import type { LedgerMergeResult } from '../../../preload/index'
import { notify } from '../lib/notify'
import { type MergeRequest, joinTalkNames, mergeConfirmTitle, mergeSuccessLabel } from './slideBrowserModel'

interface Props {
  isOpen: boolean
  onClose: () => void
  request: MergeRequest
  /** Absolute vault root — resolves a failed target's vault-relative outline for Show in Finder. */
  vaultRoot: string
  /** Fired after a clean merge — the host re-runs the Browser search so the cluster now reads as
   *  'already one slide'. */
  onMerged?: (canonicalId: string) => void
  /** True while the cheat-sheet sits above this panel — suspends ALL keys + the focus trap. */
  suspendKeys?: boolean
}

type Failure = { outline: string; error: string }

export default function MergeConfirm({ isOpen, onClose, request, vaultRoot, onMerged, suspendKeys }: Props) {
  const [busy, setBusy] = useState(false)
  // A whole-call refusal (IPC null, or engine ok:false) — nothing was changed.
  const [refused, setRefused] = useState<string | null>(null)
  // Per-target failures after a partial merge: the panel stays open with recovery links.
  const [failures, setFailures] = useState<Failure[]>([])

  const panelRef = useRef<HTMLDivElement>(null)
  const prevFocusRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!isOpen) return
    prevFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setBusy(false); setRefused(null); setFailures([])
    requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>('.lt-btn.primary, button:not([disabled])')?.focus()
    })
    return () => { prevFocusRef.current?.focus?.() }
  }, [isOpen, request])

  async function confirm(): Promise<void> {
    if (busy || refused) return
    setBusy(true)
    let result: LedgerMergeResult | null = null
    try {
      result = await window.tw.ledger.mergeDuplicates(request.targets)
    } catch { result = null }
    setBusy(false)
    if (result === null || result.ok === false) {
      setRefused('Nothing was changed — the merge was refused.')
      return
    }
    if (result.failed.length === 0) {
      notify(mergeSuccessLabel(result.merged.length || request.count), 'success')
      onMerged?.(result.canonicalId)
      onClose()
      return
    }
    // Partial failure: stay open with the un-merged copies + Show-in-Finder recovery. The toast is
    // belt-and-braces in case the panel is somehow gone.
    notify(
      `Merged ${result.merged.length}, but ${result.failed.length} could not be stamped`,
      'error'
    )
    setFailures(result.failed)
  }

  function showInFinder(outline: string): void {
    void window.tw.shell.showInFolder(`${vaultRoot.replace(/\/$/, '')}/${outline}`)
  }

  useEffect(() => {
    if (!isOpen) return
    function handleKey(e: KeyboardEvent): void {
      if (suspendKeys) return
      const el = document.activeElement
      // Focus trap over the panel's visible controls.
      if (e.key === 'Tab' && panelRef.current) {
        const focusables = [...panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input, [tabindex]:not([tabindex="-1"])'
        )].filter((f) => {
          const style = window.getComputedStyle(f)
          return style.visibility !== 'hidden' && style.display !== 'none' && f.offsetParent !== null
        })
        if (focusables.length > 0) {
          const first = focusables[0]
          const last = focusables[focusables.length - 1]
          if (e.shiftKey && el === first) { e.preventDefault(); last.focus() }
          else if (!e.shiftKey && el === last) { e.preventDefault(); first.focus() }
          else if (!el || !panelRef.current.contains(el)) { e.preventDefault(); first.focus() }
        }
        e.stopPropagation()
        return
      }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!busy) onClose(); return }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void confirm(); return }
    }
    window.addEventListener('keydown', handleKey, { capture: true })
    return () => window.removeEventListener('keydown', handleKey, { capture: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, suspendKeys, busy, refused, request])

  if (!isOpen) return null

  const across = joinTalkNames(request.talkTitles)

  return (
    <div className="lt lt-merge-root">
      <div className="lt-scrim lt-merge-scrim open" onClick={() => { if (!busy) onClose() }}>
        <div
          ref={panelRef}
          className="lt-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Merge identical copies into one slide"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="lt-panel-head">
            <h2>{mergeConfirmTitle(request.count)}</h2>
            <button type="button" className="lt-ph-close" title="Close (Esc)" disabled={busy} onClick={onClose}>
              <X className="lt-icon" />
            </button>
          </div>
          <div className="lt-panel-sub">
            {request.count === 1
              ? <>This copy of <span className="lt-merge-name">{request.title}</span> is byte-identical to the others. </>
              : <>These {request.count} copies of <span className="lt-merge-name">{request.title}</span>{across ? <> across <b>{across}</b></> : null} are byte-identical. </>}
            Merging stamps them all with one shared id, so they become a single slide: future edits and
            versions are shared, and searches show it once. Nothing is lost — each copy’s content is
            unchanged.
          </div>

          {failures.length > 0 && (
            <div className="lt-prop-rows">
              {failures.map((f) => (
                <div key={f.outline} className="lt-prop-fail" role="alert">
                  <span>Couldn’t stamp {f.outline} — {f.error}</span>
                  <button type="button" className="lt-btn" onClick={() => showInFinder(f.outline)}>
                    <FolderOpen className="lt-icon" /> Show in Finder
                  </button>
                </div>
              ))}
            </div>
          )}
          {refused && (
            <div className="lt-prop-rows">
              <div className="lt-prop-fail" role="alert"><span>{refused}</span></div>
            </div>
          )}

          <div className="lt-panel-foot">
            <span className="lt-reassure">
              <ShieldCheck className="lt-icon" />
              Nothing is lost — every copy’s content is kept, byte-for-byte.
            </span>
            <span className="lt-spacer" />
            {refused ? (
              <button type="button" className="lt-btn" onClick={onClose}>Close <kbd>Esc</kbd></button>
            ) : failures.length > 0 ? (
              <button type="button" className="lt-btn" onClick={onClose}>Done <kbd>Esc</kbd></button>
            ) : (
              <>
                <button type="button" className="lt-btn" disabled={busy} onClick={onClose}>Cancel <kbd>Esc</kbd></button>
                <button type="button" className="lt-btn primary" disabled={busy} onClick={() => void confirm()}>
                  {busy ? 'Merging…' : <><GitMerge className="lt-icon" /> Merge <kbd>⌘↵</kbd></>}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

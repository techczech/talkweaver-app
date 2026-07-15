// Propagation checklist (PRD A5, ADR-0032) — the loss-proof adoption surface. Opened over
// the Slide Browser (and later Slide Focus) with a chosen version to adopt: every outline
// carrying the slide id gets a row (identical / behind / diverged), behind rows default to
// Replace, diverged rows default to Skip with a diff-on-demand drawer, and the confirm
// button recounts live. Adoption itself is the engine's adoptVersion — replaced wording is
// recorded as a version FIRST, so nothing is ever lost (the reassurance footer is literal).
import { useEffect, useRef, useState } from 'react'
import { Check, Columns2, ShieldCheck, X } from 'lucide-react'
import type { LedgerDiffLine, LedgerStatusRow, LedgerVersion, TalkInfo } from '../../../preload/index'
import { notify } from '../lib/notify'
import { propagationSummaryLabel, splitDiffColumns } from './slideBrowserModel'

/** The version being adopted, as the Browser/Focus filmstrip hands it over. */
export type AdoptVersion = {
  file: string
  markdown: string
  savedAt: number
  talk: string
  canonical: boolean
}

interface Props {
  isOpen: boolean
  onClose: () => void
  slideId: string
  adoptVersion: AdoptVersion
  /** Absolute outline path of the talk open in the editor — if adoption replaced it, the
   *  host must reload the editor content (wired via onAdopted in WorkspaceLayout). */
  currentOutlinePath: string | null
  vaultRoot: string
  onAdopted?: (result: { replaced: { talk: string; outline: string }[] }) => void
  /** True while another overlay (the cheat-sheet) is above the checklist — suspends ALL
   *  checklist keys + the focus trap, same contract as SlideBrowser. */
  suspendKeys?: boolean
}

const VDATE_FMT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

type Decision = 'replace' | 'skip'
// Per-row adoption outcome after a partial confirm: 'replaced' or a failure reason.
type RowResult = { kind: 'replaced' } | { kind: 'failed'; error: string }

export default function PropagationChecklist({
  isOpen, onClose, slideId, adoptVersion, currentOutlinePath: _currentOutlinePath, vaultRoot, onAdopted, suspendKeys
}: Props) {
  // rows === undefined → loading; null → the status IPC failed (error state with retry).
  const [rows, setRows] = useState<LedgerStatusRow[] | null | undefined>(undefined)
  const [versions, setVersions] = useState<LedgerVersion[]>([])
  const [talks, setTalks] = useState<TalkInfo[]>([])
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})
  const [rowResults, setRowResults] = useState<Record<string, RowResult>>({})
  const [drawerOutline, setDrawerOutline] = useState<string | null>(null)
  // Per-row diff state: lines, null (in flight) or 'error' (IPC failed / engine missing).
  const [diffs, setDiffs] = useState<Record<string, LedgerDiffLine[] | null | 'error'>>({})
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState(false)
  const [loadNonce, setLoadNonce] = useState(0) // bumped by 'Try again'

  const panelRef = useRef<HTMLDivElement>(null)
  const prevFocusRef = useRef<HTMLElement | null>(null)

  // ---------- load on open (and on retry) ----------
  useEffect(() => {
    if (!isOpen) return
    prevFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    let stale = false
    setRows(undefined); setDecisions({}); setRowResults({}); setDrawerOutline(null)
    setDiffs({}); setBusy(false); setRefused(false)
    Promise.all([
      window.tw.ledger.status(slideId, adoptVersion.markdown),
      window.tw.ledger.versions(slideId).catch(() => [] as LedgerVersion[]),
      window.tw.vault.listTalks().catch(() => [] as TalkInfo[])
    ]).then(([status, vers, talkList]) => {
      if (stale) return
      setVersions(vers ?? [])
      setTalks(talkList ?? [])
      setRows(status)
      if (status) {
        const d: Record<string, Decision> = {}
        for (const r of status) {
          if (r.status === 'behind') d[r.outline] = 'replace'
          if (r.status === 'diverged') d[r.outline] = 'skip'
        }
        setDecisions(d)
      }
    }).catch(() => { if (!stale) setRows(null) })
    requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>('[data-rs-toggle], button:not([disabled])')?.focus()
    })
    return () => { stale = true; prevFocusRef.current?.focus?.() }
  }, [isOpen, slideId, adoptVersion.markdown, loadNonce])

  // ---------- derived ----------
  const talkTitle = (row: LedgerStatusRow): string => {
    const t = talks.find((x) => x.slug === row.talk)
    if (t?.title) return t.title
    // Fallback: the outline's own folder name (vault-relative path, POSIX separators).
    const parts = row.outline.split('/')
    return parts.length >= 2 ? parts[parts.length - 2] : row.talk
  }
  // The engine's 'behind' literally means "matches a DIFFERENT recorded version" — only
  // when the adopted version is the HEAD does 'behind' read honestly as older.
  const adoptingHead = versions.length > 0 && versions[0].file === adoptVersion.file
  const behindNote = (row: LedgerStatusRow): string | null => {
    if (!adoptingHead) return 'has a different recorded version'
    const idx = versions.findIndex((v) => v.markdown.trim() === row.currentMarkdown.trim())
    if (idx < 0) return null // not derivable — say nothing rather than guess
    const age = idx === 1 ? 'one version old' : `${idx} versions old`
    return `has ${VDATE_FMT.format(new Date(versions[idx].savedAt))} — ${age}`
  }
  // A replaced row leaves the pending set (it now IS this version); identical rows never
  // entered it. The live recount runs over what a confirm would still touch.
  const pendingRows = (rows ?? []).filter((r) => r.status !== 'identical' && rowResults[r.outline]?.kind !== 'replaced')
  const nReplace = pendingRows.filter((r) => decisions[r.outline] === 'replace').length
  const nSkip = pendingRows.length - nReplace
  const empty = rows != null && rows.length === 0
  const canConfirm = !busy && !refused && nReplace > 0

  function flipDecision(outline: string): void {
    setDecisions((d) => ({ ...d, [outline]: d[outline] === 'replace' ? 'skip' : 'replace' }))
  }

  // ---------- diff drawer (one at a time; fetched once per row, then cached) ----------
  function toggleDrawer(outline: string, currentMarkdown: string): void {
    setDrawerOutline((open) => (open === outline ? null : outline))
    setDiffs((d) => {
      if (outline in d) return d
      window.tw.ledger.diff(currentMarkdown, adoptVersion.markdown)
        // An EMPTY diff on a diverged row is also a failure surface: the main handler
        // returns [] when the engine can't be loaded, and a genuinely diverged pair can
        // never produce zero lines — so [] must read as an error, not "no differences".
        .then((lines) => setDiffs((prev) => ({ ...prev, [outline]: lines.length > 0 ? lines : 'error' })))
        .catch(() => setDiffs((prev) => ({ ...prev, [outline]: 'error' })))
      return { ...d, [outline]: null } // null = in flight
    })
  }

  // ---------- confirm ----------
  async function confirm(): Promise<void> {
    if (!canConfirm || !rows) return
    const targets = pendingRows.filter((r) => decisions[r.outline] === 'replace').map((r) => r.outline)
    setBusy(true)
    let result: Awaited<ReturnType<typeof window.tw.ledger.adopt>> = null
    try {
      result = await window.tw.ledger.adopt(slideId, adoptVersion.markdown, targets)
    } catch { result = null }
    setBusy(false)
    if (result === null) { setRefused(true); return }
    if (result.replaced.length > 0) onAdopted?.(result)
    if (result.failed.length === 0) {
      notify(`Replaced in ${result.replaced.length} presentation${result.replaced.length === 1 ? '' : 's'}`, 'success')
      onClose()
      return
    }
    // Partial failure: stay open — replaced rows flip to 'replaced ✓', failed rows carry
    // an inline reason + a Show-in-Finder recovery. The toast is belt and braces: if the
    // panel is somehow gone by now, the failure still surfaces somewhere visible.
    notify(
      `Could not replace in ${result.failed.length} presentation${result.failed.length === 1 ? '' : 's'}`,
      'error'
    )
    setRowResults((prev) => {
      const next = { ...prev }
      for (const r of result!.replaced) next[r.outline] = { kind: 'replaced' }
      for (const f of result!.failed) next[f.outline] = { kind: 'failed', error: f.error }
      return next
    })
  }

  function showInFinder(outline: string): void {
    void window.tw.shell.showInFolder(`${vaultRoot.replace(/\/$/, '')}/${outline}`)
  }

  // ---------- keyboard (capture, SlideBrowser pattern) ----------
  useEffect(() => {
    if (!isOpen) return
    function handleKey(e: KeyboardEvent): void {
      if (suspendKeys) return // the cheat-sheet is above — hand it every key
      const el = document.activeElement
      const inField = el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement
      const mod = e.metaKey || e.ctrlKey

      // Focus trap: Tab cycles the panel's visible controls only.
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
      // Esc closes the whole panel (mockup 2337 — the drawer has its own View-diff toggle).
      // While the adopt IPC is in flight the panel must stay: closing would drop partial
      // failures on the floor, so Esc is swallowed (still trapped — never reaches the Browser).
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!busy) onClose(); return }
      if (mod && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void confirm(); return }
      if (inField) return
      const plain = !mod && !e.altKey
      // Space flips the focused Replace/Skip toggle (one tab stop per row).
      if (plain && e.key === ' ' && el instanceof HTMLElement && el.dataset.rsToggle != null) {
        e.preventDefault(); e.stopPropagation()
        if (!busy) flipDecision(el.dataset.outline ?? '')
        return
      }
      // D toggles the diff drawer of the focused diverged row, else the first diverged row.
      if (plain && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault(); e.stopPropagation()
        const focusedOutline = el instanceof HTMLElement
          ? el.closest<HTMLElement>('[data-prop-row]')?.dataset.outline
          : undefined
        const target = (rows ?? []).find((r) => r.status === 'diverged' && r.outline === focusedOutline)
          ?? (rows ?? []).find((r) => r.status === 'diverged' && rowResults[r.outline]?.kind !== 'replaced')
        if (target) toggleDrawer(target.outline, target.currentMarkdown)
        return
      }
    }
    window.addEventListener('keydown', handleKey, { capture: true })
    return () => window.removeEventListener('keydown', handleKey, { capture: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, suspendKeys, rows, decisions, rowResults, busy, refused, drawerOutline, onClose])

  if (!isOpen) return null

  const adoptChip = `${VDATE_FMT.format(new Date(adoptVersion.savedAt))}${adoptVersion.canonical ? ' · canonical' : ''}`

  // ---------- one status row (+ optional error strip + drawer) ----------
  function renderRow(row: LedgerStatusRow): React.ReactNode {
    const result = rowResults[row.outline]
    const replaced = result?.kind === 'replaced'
    const isIdentical = row.status === 'identical' || replaced
    const name = talkTitle(row)
    const decision = decisions[row.outline] ?? 'skip'
    const note = row.status === 'behind' ? behindNote(row) : null
    const drawerOpen = drawerOutline === row.outline
    const diff = diffs[row.outline]
    const diffFailed = diff === 'error'
    const cols = Array.isArray(diff) ? splitDiffColumns(diff) : null
    return (
      <div key={row.outline}>
        <div
          className={`lt-prop-row${isIdentical ? ' is-identical' : ''}`}
          data-prop-row
          data-outline={row.outline}
          data-status={replaced ? 'replaced' : row.status}
        >
          <div className="lt-pr-talk">
            <span className="lt-wt">{name}</span>
            {/* §section · slide N is not derivable from the status row (outline + headingLine
                only) — the vault-relative outline path is the honest small annotation. */}
            <span className="lt-ws">{row.outline}</span>
          </div>
          <span className={`lt-badge ${row.status}`}>{row.status}</span>
          {replaced && (
            <span className="lt-pr-ok"><Check className="lt-icon" /> replaced ✓</span>
          )}
          {!replaced && row.status === 'identical' && (
            <span className="lt-pr-ok"><Check className="lt-icon" /> already this version — nothing to do</span>
          )}
          {!replaced && row.status === 'behind' && note && <span className="lt-pr-note">{note}</span>}
          {!replaced && row.status === 'diverged' && (
            <button
              type="button"
              className={`lt-pr-diff${drawerOpen ? ' on' : ''}`}
              title="Compare before deciding (D)"
              onClick={() => toggleDrawer(row.outline, row.currentMarkdown)}
            >
              <Columns2 className="lt-icon" /> View diff
            </button>
          )}
          {!replaced && row.status !== 'identical' && (
            <div
              className="lt-rs-toggle"
              role="radiogroup"
              tabIndex={0}
              data-rs-toggle
              data-outline={row.outline}
              aria-label={`Replace or skip in ${name} (Space flips)`}
              title="Space flips Replace / Skip"
            >
              <button
                type="button"
                tabIndex={-1}
                disabled={busy}
                className={decision === 'replace' ? 'on-replace' : ''}
                aria-pressed={decision === 'replace'}
                onClick={() => setDecisions((d) => ({ ...d, [row.outline]: 'replace' }))}
              >
                Replace
              </button>
              <button
                type="button"
                tabIndex={-1}
                disabled={busy}
                className={decision === 'skip' ? 'on-skip' : ''}
                aria-pressed={decision === 'skip'}
                onClick={() => setDecisions((d) => ({ ...d, [row.outline]: 'skip' }))}
              >
                Skip
              </button>
            </div>
          )}
        </div>
        {result?.kind === 'failed' && (
          <div className="lt-prop-fail" role="alert">
            <span>Could not replace — {result.error}</span>
            <button type="button" className="lt-btn" onClick={() => showInFinder(row.outline)}>
              Show in Finder
            </button>
          </div>
        )}
        {drawerOpen && !replaced && diffFailed && (
          <div className="lt-diff-drawer open">
            {/* A failed comparison must never render as empty columns — on a diverged row
                that would read as "no differences", the opposite of the truth. */}
            <div className="lt-diff-note" role="alert">
              Couldn’t compare these versions — close and try again.
            </div>
          </div>
        )}
        {drawerOpen && !replaced && !diffFailed && (
          <div className="lt-diff-drawer open">
            <div className="lt-diff-cols">
              <div className="lt-diff-col">
                <div className="lt-dc-head"><b>In {name}</b><span>diverged</span></div>
                <div className="lt-diff-body">
                  {cols === null && <div className="lt-dl dim">comparing…</div>}
                  {cols?.left.map((l, i) => (
                    <div key={i} className={`lt-dl${l.kind === 'del' ? ' del' : ''}`}>{l.text || ' '}</div>
                  ))}
                </div>
              </div>
              <div className="lt-diff-col">
                <div className="lt-dc-head"><b>Version to adopt</b><span>{adoptChip}</span></div>
                <div className="lt-diff-body">
                  {cols === null && <div className="lt-dl dim">comparing…</div>}
                  {cols?.right.map((l, i) => (
                    <div key={i} className={`lt-dl${l.kind === 'add' ? ' add' : ''}`}>{l.text || ' '}</div>
                  ))}
                </div>
              </div>
            </div>
            <div className="lt-diff-note">
              The {name} copy carries its own wording. If you replace it, that wording is kept as a
              version of this slide — restorable any time.
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="lt lt-prop-root">
      {/* scrim/✕/Cancel/Esc are all busy-gated: an in-flight adopt must report back
          into this panel (partial failures render as row strips), never into the void */}
      <div className="lt-scrim lt-prop-scrim open" onClick={() => { if (!busy) onClose() }}>
        <div
          ref={panelRef}
          className="lt-panel"
          role="dialog"
          aria-modal="true"
          aria-label="Adopt this version across your presentations"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="lt-panel-head">
            <h2>Adopt this version across your presentations</h2>
            <span className="lt-ph-id">id={slideId}</span>
            <button type="button" className="lt-ph-close" title="Close (Esc)" disabled={busy} onClick={onClose}>
              <X className="lt-icon" />
            </button>
          </div>
          <div className="lt-panel-sub">
            {rows === undefined && 'Checking where this slide is used… — adopting '}
            {rows === null && 'Adopting '}
            {rows != null && !empty &&
              `${rows.length} presentation${rows.length === 1 ? ' carries' : 's carry'} this slide. Choose what happens in each — adopting `}
            {empty && 'Adopting '}
            <span className="lt-adopting">{adoptChip}</span>
          </div>

          <div className="lt-prop-rows">
            {/* loading: skeleton rows, never a blank panel */}
            {rows === undefined && [0, 1, 2].map((i) => (
              <div key={i} className="lt-prop-row" aria-hidden="true">
                <div className="lt-pr-talk" style={{ paddingBottom: 11 }}>
                  <div className="lt-sk-line" style={{ margin: 0, width: '55%' }} />
                  <div className="lt-sk-line short" />
                </div>
              </div>
            ))}
            {rows === null && (
              <div className="lt-prop-row">
                <div className="lt-pr-talk">
                  <span className="lt-wt">Couldn’t check where this slide is used</span>
                  <span className="lt-ws">the vault’s slide ledger didn’t answer — nothing has been changed</span>
                </div>
                <button type="button" className="lt-btn" onClick={() => setLoadNonce((n) => n + 1)}>
                  Try again
                </button>
              </div>
            )}
            {empty && (
              <div className="lt-prop-row is-identical">
                <div className="lt-pr-talk">
                  <span className="lt-wt">No other presentation carries this slide.</span>
                </div>
              </div>
            )}
            {rows != null && rows.map(renderRow)}
            {refused && (
              <div className="lt-prop-fail" role="alert">
                <span>Nothing was changed — the adoption was refused. Close and try again.</span>
              </div>
            )}
          </div>

          <div className="lt-panel-foot">
            <span className="lt-reassure">
              <ShieldCheck className="lt-icon" />
              Nothing is lost — replaced versions stay in history.
            </span>
            <span className="lt-spacer" />
            {empty || refused ? (
              <button type="button" className="lt-btn" onClick={onClose}>Close <kbd>Esc</kbd></button>
            ) : (
              <>
                <button type="button" className="lt-btn" disabled={busy} onClick={onClose}>Cancel <kbd>Esc</kbd></button>
                <button
                  type="button"
                  className="lt-btn primary"
                  disabled={!canConfirm}
                  onClick={() => void confirm()}
                >
                  {busy
                    ? 'Replacing…'
                    : <>{propagationSummaryLabel(nReplace, nSkip)} <kbd>⌘↵</kbd></>}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

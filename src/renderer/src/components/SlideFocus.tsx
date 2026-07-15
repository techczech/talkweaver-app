// Slide Focus surface (PRD B1/B3/B4, ADR-0034) — "zoom in on one slide". A full workspace VIEW
// (peer of gridMode, not a scrim): scoped editing on the LEFT (the SAME outline, reused editor,
// focus-scoped via the Task-8 extension), a live rendered preview on the RIGHT (the stage), a
// where-used strip under it, and detach. The version rail (B2) is Task 10 — here it is a closed
// placeholder. Built to docs/design/2026-07-03-browser-focus/light-table-hifi-v1.html 1544-1798.
//
// State this component OWNS: the debounced live preview, the where-used rows, and the detach confirm.
// Everything that mutates the outline (detach's flush→ipc→replace→toast, adopt→PropagationChecklist)
// is delegated UP to WorkspaceLayout, which holds the editor command/replace refs and the host-mount
// pattern. The editor itself is reparented in from WorkspaceLayout (reverse-portal) via editorSlotRef.
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ChevronLeft, ChevronRight, History, Waypoints, X } from 'lucide-react'
import type { LedgerStatusRow, TalkInfo } from '../../../preload/index'
import { tagsOfBlock } from '../../../shared/tags'
import {
  extractSlideBlock, slideIdOf, slideRefForLine, paneFootState
} from './slideFocusModel'
import { useLiveSlidePreview } from './useLiveSlidePreview'
import FixedDeckPreview from './FixedDeckPreview'

interface Props {
  talk: TalkInfo
  vaultRoot: string
  /** Compiled index of the focused slide (aligned to compiledSlides / slideLines). */
  slideIndex: number
  /** compiledSlides.length — the N in the crumb's `n / N`. */
  slideCount: number
  /** The focused slide's section + title, from its compiled row (authored case). */
  section: string
  slideTitle: string
  compiledSlideId: string
  /** 1-based source heading line of the focused slide (slideLines[slideIndex]); null never happens
   *  for a focusable slide but is handled defensively. */
  headingLine: number | null
  /** Live outline text (updates every keystroke) — the block markdown driving the preview + where-used
   *  is derived from this + headingLine, so both stay current as you type inside the band. */
  outlineContent: string
  /** Reverse-portal target: WorkspaceLayout appends the live editor host into this node. */
  editorSlotRef: (node: HTMLDivElement | null) => void
  onPrev: () => void
  onNext: () => void
  /** Esc / back button — return to the origin (Browser or workspace); WorkspaceLayout decides which. */
  onExit: () => void
  /** Open PropagationChecklist to adopt the CURRENT block across talks (behind/diverged rows + `A`). */
  onAdoptCurrent: (slideId: string, currentMarkdown: string) => void
  /** Detach: WorkspaceLayout flushes the pending autosave, calls ledger.detach, applies the returned
   *  text in place, and toasts. Resolves true on success so the strip can reload where-used. */
  onDetach: (ref: { heading: string; occurrence: number }, currentMarkdown: string, slideId: string) => Promise<boolean>
  /** Compile-error recovery: park the caret on this slide's heading line in the editor. */
  onShowOutlineLine: () => void
  /** True while a higher overlay (the app cheat-sheet / PropagationChecklist) is up — suspend keys. */
  suspendKeys?: boolean
}

const STATUS_DEBOUNCE_MS = 600

export default function SlideFocus({
  talk, vaultRoot, slideIndex, slideCount, section, slideTitle, compiledSlideId, headingLine, outlineContent,
  editorSlotRef, onPrev, onNext, onExit, onAdoptCurrent, onDetach, onShowOutlineLine, suspendKeys
}: Props) {
  // The focused block markdown + its id, derived live from the outline (recomputes each keystroke).
  const blockMarkdown = useMemo(() => extractSlideBlock(outlineContent, headingLine), [outlineContent, headingLine])
  const slideId = useMemo(() => slideIdOf(blockMarkdown), [blockMarkdown])
  const slideRef = useMemo(() => slideRefForLine(outlineContent, headingLine), [outlineContent, headingLine])
  // Curated tags (ADR-0037) — shown in the crumb beside the slide's title, live from the block.
  const slideTags = useMemo(() => tagsOfBlock(blockMarkdown), [blockMarkdown])

  // ---- live preview (the stage) ----
  // previewUrl holds the LAST good frame — never cleared on a recompile, so the stage never flickers
  // to blank. `compiling` dims it faintly; `previewErr` swaps in the human-readable error state.
  const lastStatusSlideRef = useRef<number>(-1)
  const { previewUrl, compiling, previewErr } = useLiveSlidePreview(talk.outlinePath, outlineContent, compiledSlideId)

  // ---- where-used strip ----
  // rows: undefined = loading, null = the status IPC failed (error + retry), [] = only-here.
  const [rows, setRows] = useState<LedgerStatusRow[] | null | undefined>(undefined)
  const [talks, setTalks] = useState<TalkInfo[]>([])
  const statusNonce = useRef(0)
  const [statusReload, setStatusReload] = useState(0)

  // Talk-title lookup (slug → title) for other talks' rows; the current talk uses its own title.
  useEffect(() => { window.tw.vault.listTalks().then((t) => setTalks(t ?? [])).catch(() => setTalks([])) }, [])

  useEffect(() => {
    if (!slideId) { setRows([]); return } // unstamped (B4) — no id to look up
    const id = slideId
    const md = blockMarkdown
    // Reload on slide change immediately; on in-band edits debounce so we don't rescan the vault on
    // every keystroke. Badges are judged against the CURRENT block (editing here makes copies behind).
    const immediate = lastStatusSlideRef.current !== slideIndex || statusReload > 0
    lastStatusSlideRef.current = slideIndex
    const run = async (): Promise<void> => {
      const mine = ++statusNonce.current
      setRows(undefined)
      let res: LedgerStatusRow[] | null = null
      try { res = await window.tw.ledger.status(id, md) } catch { res = null }
      if (mine !== statusNonce.current) return
      setRows(res)
    }
    const handle = setTimeout(() => { void run() }, immediate ? 0 : STATUS_DEBOUNCE_MS)
    return () => clearTimeout(handle)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slideId, blockMarkdown, slideIndex, statusReload])

  const talkTitleFor = (row: LedgerStatusRow): string => {
    const t = talks.find((x) => x.slug === row.talk)
    if (t?.title) return t.title
    const parts = row.outline.split('/')
    return parts.length >= 2 ? parts[parts.length - 2] : row.talk
  }
  const isCurrentRow = (row: LedgerStatusRow): boolean => {
    const root = vaultRoot.replace(/\/$/, '')
    return `${root}/${row.outline}` === talk.outlinePath
  }

  // ---- detach confirm ----
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [detaching, setDetaching] = useState(false)
  const canDetach = !!slideId && !!slideRef

  async function runDetach(): Promise<void> {
    if (!slideRef || !slideId || detaching) return
    setDetaching(true)
    const ok = await onDetach(slideRef, blockMarkdown, slideId)
    setDetaching(false)
    setConfirmOpen(false)
    if (ok) setStatusReload((n) => n + 1) // id changed — reload where-used
  }

  // ---- keyboard (capture, window-level) ----
  useEffect(() => {
    function isTyping(t: EventTarget | null): boolean {
      if (!(t instanceof HTMLElement)) return false
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return true
      if (t.isContentEditable) return true
      return !!t.closest('.cm-editor')
    }
    function handle(e: KeyboardEvent): void {
      if (suspendKeys) return
      // The detach confirm owns Esc/Enter while it is up.
      if (confirmOpen) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setConfirmOpen(false) }
        else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void runDetach() }
        return
      }
      // Esc returns to the origin — works even while the caret is in the editor (capture-phase, before
      // CodeMirror), so you never get trapped in the scoped editor.
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onExit(); return }
      // The rest are review-surface keys — never hijack typing in the scoped editor (plain-guard,
      // mirroring the SlideBrowser discipline). Click targets (stage arrows, adopt/detach buttons)
      // give full parity when the caret IS in the editor.
      if (isTyping(e.target)) return
      const mod = e.metaKey || e.ctrlKey
      if (mod || e.altKey) return
      if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); onPrev(); return }
      if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); onNext(); return }
      if ((e.key === 'a' || e.key === 'A') && slideId) { e.preventDefault(); e.stopPropagation(); onAdoptCurrent(slideId, blockMarkdown); return }
      if (e.shiftKey && (e.key === 'd' || e.key === 'D') && canDetach) { e.preventDefault(); e.stopPropagation(); setConfirmOpen(true); return }
      // V (version rail) is Task 10 — swallow it so it can't leak into the app as a stray character.
      if (e.key === 'v' || e.key === 'V') { e.preventDefault(); e.stopPropagation(); return }
    }
    window.addEventListener('keydown', handle, { capture: true })
    return () => window.removeEventListener('keydown', handle, { capture: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suspendKeys, confirmOpen, slideId, canDetach, blockMarkdown, onExit, onPrev, onNext, onAdoptCurrent])

  const pos = `${slideIndex + 1} / ${slideCount}`
  const foot = paneFootState(!!slideId)

  return (
    <div className="lt lt-focus">
      {/* ---------- top chrome: crumb + prev/next ---------- */}
      <div className="lt-focus-top">
        <button className="lt-nav-btn" onClick={onExit} title="Back to where you came from (Esc)" aria-label="Back">
          <ChevronLeft className="lt-icon" />
        </button>
        <div className="lt-crumb">
          <span className="lt-c-talk">{talk.title}</span>
          <ChevronRight className="lt-icon" />
          <span className="lt-c-sec">{section || 'slide'}</span>
          <ChevronRight className="lt-icon" />
          <span className="lt-c-slide">{slideTitle || 'untitled slide'}</span>
          {slideTags.map((t) => (
            <span key={t} className="lt-minitag" title="Slide tag — edit via ‘Tag current slide…’ or the Browser’s T">{t}</span>
          ))}
        </div>
        <div className="lt-focus-nav">
          <button className="lt-railtoggle" disabled title="Version history arrives in the next update">
            <History className="lt-icon" /> Versions <kbd>V</kbd>
          </button>
          <span className="lt-pos">{pos}</span>
          <button className="lt-nav-btn" onClick={onPrev} title="Previous slide (←)" aria-label="Previous slide">
            <ChevronLeft className="lt-icon" />
          </button>
          <button className="lt-nav-btn" onClick={onNext} title="Next slide (→)" aria-label="Next slide">
            <ChevronRight className="lt-icon" />
          </button>
        </div>
      </div>

      <div className="lt-focus-body">
        {/* ---------- LEFT: scoped editor (the reused instance is reparented in here) ---------- */}
        <aside className="lt-md-pane">
          <div className="lt-pane-head">
            <span className="lt-p-title">Outline — this slide</span>
            <span className="lt-p-note">scoped view of the Talk’s outline, not a copy</span>
          </div>
          <div className="lt-md-editor" ref={editorSlotRef} />
          <div className="lt-pane-foot">
            <span className={`lt-dot ${foot.tone === 'dirty' ? 'dirty' : ''}`} />
            {foot.text}
          </div>
        </aside>

        {/* ---------- RIGHT: stage + where-used ---------- */}
        <div className="lt-stage-col">
          <div className="lt-stage">
            <button className="lt-stage-arrow prev" onClick={onPrev} title="Previous slide (←)" aria-label="Previous slide">
              <ChevronLeft className="lt-icon" />
            </button>
            <div className={`lt-stage-print ${compiling ? 'compiling' : ''}`}>
              {previewErr && previewUrl == null ? (
                <div className="lt-stage-err">
                  <AlertTriangle className="lt-icon" style={{ width: 24, height: 24 }} />
                  <h4>This slide couldn’t be previewed</h4>
                  <p>The compiler couldn’t render this slide right now. Your text is safe — check the outline on the left, then it will refresh.</p>
                  <button className="lt-btn" onClick={onShowOutlineLine}>Show the outline line</button>
                </div>
              ) : (
                /* twpresent gives trusted app-generated output its own origin; a sandbox would only
                   disable capabilities the deck runtime legitimately needs. */
                <FixedDeckPreview
                  className="lt-stage-frame"
                  title="Slide preview"
                  src={previewUrl ?? undefined}
                />
              )}
            </div>
            <button className="lt-stage-arrow next" onClick={onNext} title="Next slide (→)" aria-label="Next slide">
              <ChevronRight className="lt-icon" />
            </button>
          </div>

          {/* where-used strip (B3) */}
          <div className="lt-whereused">
            <div className="lt-wu-head">
              <span className="lt-wu-title">Where this slide lives</span>
              {canDetach && (
                <>
                  <span className="lt-wu-detach-note">Detach makes an independent copy — this Talk stops receiving updates.</span>
                  <button className="lt-wu-detach" onClick={() => setConfirmOpen(true)} disabled={detaching} title="Detach as new slide (⇧D)">
                    <Waypoints className="lt-icon" /> Detach as new slide
                  </button>
                </>
              )}
            </div>
            <div className="lt-wu-rows">
              {!slideId ? (
                <span className="lt-wu-none">Only here so far. Sharing begins when this slide is inserted into another Talk — its id will follow it.</span>
              ) : rows === undefined ? (
                <span className="lt-wu-loading">Looking up where this slide is used…</span>
              ) : rows === null ? (
                <span className="lt-wu-error">
                  Couldn’t read the slide ledger.
                  <button className="lt-btn" onClick={() => setStatusReload((n) => n + 1)}>Try again</button>
                </span>
              ) : rows.length === 0 ? (
                <span className="lt-wu-none">Only here so far. Sharing begins when this slide is inserted into another Talk — its id will follow it.</span>
              ) : (
                rows.map((row) => {
                  const here = isCurrentRow(row)
                  return (
                    <div className="lt-wu-row" key={row.outline}>
                      <span className="lt-wt">{talkTitleFor(row)}</span>
                      {here && <span className="lt-ws">here</span>}
                      <span className={`lt-badge ${row.status}`}>{row.status}</span>
                      {!here && row.status !== 'identical' && (
                        <button className="lt-wu-adopt" onClick={() => slideId && onAdoptCurrent(slideId, blockMarkdown)} title="Adopt current version in… (A)">
                          {row.status === 'diverged' ? 'View diff · adopt…' : 'Adopt current version…'}
                        </button>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>

          {/* version-rail placeholder (B2/B4) — Task 10 fills this with the real filmstrip. */}
          <div className="lt-vrail-slot">Version history — arriving in the next update{slideId ? '' : ' (this slide has no history yet)'}.</div>
        </div>
      </div>

      {/* ---------- hint bar ---------- */}
      <footer className="lt-focus-hint">
        <span className="lt-h"><kbd>←</kbd><kbd>→</kbd> <b>prev / next slide</b></span>
        <span className="lt-h"><kbd>A</kbd> <b>adopt current version in…</b></span>
        <span className="lt-h"><kbd>⇧D</kbd> <b>detach as new slide</b></span>
        <span className="lt-h push"><kbd>Esc</kbd> <b>back to where you came from</b></span>
        <span className="lt-h"><kbd>?</kbd> <b>all shortcuts</b></span>
      </footer>

      {/* ---------- detach confirm (mockup 1959-1973) ---------- */}
      {confirmOpen && (
        <div className="lt-focus-confirm-scrim" onClick={() => !detaching && setConfirmOpen(false)}>
          <div className="lt-focus-confirm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Detach as a new slide?">
            <div className="cf-head">
              <h2>Detach as a new slide?</h2>
              <button className="cf-close" onClick={() => setConfirmOpen(false)} title="Close (Esc)" aria-label="Close">
                <X className="lt-icon" />
              </button>
            </div>
            <div className="cf-body">
              This copy in <b>{talk.title}</b> becomes an independent slide with a fresh id — it stops receiving updates from{' '}
              <b style={{ fontFamily: 'var(--lt-mono)', fontSize: 12 }}>{slideId}</b>, and its future edits stay its own.
              <span className="fine">History up to this moment is kept on both slides. The other Talks are unaffected.</span>
            </div>
            <div className="cf-foot">
              <span className="spacer" />
              <button className="cf-btn" onClick={() => setConfirmOpen(false)} disabled={detaching}>Cancel <kbd>Esc</kbd></button>
              <button className="cf-btn danger" onClick={() => void runDetach()} disabled={detaching}>
                {detaching ? 'Detaching…' : <>Detach <kbd>↵</kbd></>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

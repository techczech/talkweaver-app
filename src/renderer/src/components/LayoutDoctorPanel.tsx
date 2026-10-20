// Layout Doctor — the home of 'doctor'-surfaced warnings (ADR-0020 Consequences;
// ADR-0011 chrome: application panel, hairlines, paper/oxford palette).
import { plainInlineText } from '../../../../compiler/scripts/lib/00-inline-render.mjs'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, X } from 'lucide-react'
import type { LayoutDoctorTalk, ProjectionRow, TalkInfo } from '../../../preload/index'
import {
  scanOutlineTriggers,
  type DoctorFindingKind,
  type LayoutDoctorFinding
} from '../../../shared/layout-doctor'
import { STRANDED_TITLE_ICON_ACTION } from '../../../shared/title-icon-restore'
import { MOVE_PREWORK_ACTION } from '../../../shared/prework-move'
import { warningsForSurface } from '../../../../compiler/scripts/lib/warning-registry.mjs'
import { usePausedScan } from '../lib/pausedScan'

interface Props {
  isOpen: boolean
  onClose: () => void
  talk: TalkInfo
  outlineText: string
  slideRows: ProjectionRow[] | null
  onJumpToLine: (line: number) => void
  /**
   * The one fix the doctor makes itself (plain view ticket 15): move a title's icon from its layout
   * line to the title, in the open talk's buffer. Resolves to null when it was moved, or to the
   * words to show when it was not. `scan`: the talk and the exact outline text the finding was read
   * from; the move is refused unless the editor still holds that text.
   */
  onRestoreTitleIcon?: (finding: LayoutDoctorFinding, scan: { outlinePath: string; text: string }) => Promise<string | null>
}

type CompilerNote = {
  key: string
  message: string
  slideTitle: string
  line: number | null
  /** The warning's registry code; the note for a retired `{prework}` section carries the move action. */
  code: string
}
const RETIRED_PREWORK_CODE = 'prework-section-retired'

const KIND_ORDER: DoctorFindingKind[] = [
  'unknown-word',
  'unregistered-key',
  'unregistered-value',
  'trigger-conflict',
  'duplicate-layout',
  'duplicate-slide-id',
  'stranded-title-icon'
]

const KIND_LABELS: Record<DoctorFindingKind, string> = {
  'unknown-word': 'Unknown word',
  'unregistered-key': 'Unregistered key',
  'unregistered-value': 'Unregistered value',
  'trigger-conflict': 'Trigger conflict',
  'duplicate-layout': 'Duplicate layout',
  'duplicate-slide-id': 'Duplicate slide id',
  'stranded-title-icon': 'Icon not on the title'
}

function isErrorFinding(kind: DoctorFindingKind): boolean {
  return kind === 'unknown-word' || kind === 'unregistered-key' || kind === 'unregistered-value'
}

function groupedFindings(findings: LayoutDoctorFinding[]): Array<{
  kind: DoctorFindingKind
  findings: LayoutDoctorFinding[]
}> {
  const groups = new Map<DoctorFindingKind, LayoutDoctorFinding[]>()
  for (const finding of findings) {
    const rows = groups.get(finding.kind) ?? []
    rows.push(finding)
    groups.set(finding.kind, rows)
  }
  return KIND_ORDER.flatMap((kind) => {
    const rows = groups.get(kind)
    return rows?.length ? [{ kind, findings: rows }] : []
  })
}

function compilerNotesFor(rows: ProjectionRow[] | null): CompilerNote[] {
  const notes = new Map<string, CompilerNote>()
  for (const [index, row] of (rows ?? []).entries()) {
    const slideTitle = plainInlineText(row.nav_title || row.title) || `Slide ${index + 1}`
    for (const warning of row.warnings ?? []) {
      const code = String(warning).split(':')[0]
      for (const message of warningsForSurface([warning], 'doctor')) {
        const key = `${row.slide_id || index}:${message}`
        if (!notes.has(key)) {
          notes.set(key, {
            key,
            message,
            slideTitle,
            line: typeof row.source_line === 'number' ? row.source_line : null,
            code
          })
        }
      }
    }
  }
  return [...notes.values()]
}

/** The titles whose icon is on their layout line: the one reading here that costs (usePausedScan). */
function strandedTitleIconFindings(text: string): LayoutDoctorFinding[] {
  return scanOutlineTriggers(text, undefined, { strandedTitleIcons: true }).filter((finding) => finding.kind === 'stranded-title-icon')
}

const TABBABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

function FindingRow({
  finding,
  onJump,
  onFix,
  fixWaiting = false
}: {
  finding: LayoutDoctorFinding
  onJump?: () => void
  onFix?: () => Promise<string | null>
  /** The talk has changed since this row was read and is waiting to be read again: no fix from it. */
  fixWaiting?: boolean
}) {
  const error = isErrorFinding(finding.kind)
  const [fixing, setFixing] = useState(false)
  const [notFixed, setNotFixed] = useState<string | null>(null)
  if (finding.kind === 'stranded-title-icon' && onFix) {
    // A row with a button of its own: the line number is what jumps.
    const fix = (): void => {
      setFixing(true)
      setNotFixed(null)
      onFix()
        .then((refusal) => setNotFixed(refusal))
        .catch(() => setNotFixed('The icon could not be moved, so nothing was changed.'))
        .finally(() => setFixing(false))
    }
    return (
      <div style={{ ...S.findingRow, ...S.warningRow }}>
        <span style={{ ...S.kindChip, ...S.kindChipWarning }}>{KIND_LABELS[finding.kind]}</span>
        <code style={S.token}>{finding.token}</code>
        <span style={S.rowMain}>
          <span style={S.slideTitle}>{finding.slideTitle || '(untitled slide)'}</span>
          {finding.detail ? <span style={S.detail}>{finding.detail}</span> : null}
          {notFixed ? <span style={S.notFixed} role="alert">Could not fix. {notFixed}</span> : null}
        </span>
        <button
          type="button"
          style={{ ...S.fixAction, ...(fixWaiting ? S.fixActionWaiting : null) }}
          onClick={fix}
          disabled={fixing || fixWaiting}
          title={fixWaiting ? 'The talk has changed. This is available again once it has been read.' : undefined}
        >
          {STRANDED_TITLE_ICON_ACTION}
        </button>
        {onJump ? (
          <button type="button" style={{ ...S.line, ...S.lineJump }} onClick={onJump} title={`Jump to line ${finding.line}`}>
            line {finding.line}
          </button>
        ) : <span style={S.line}>line {finding.line}</span>}
      </div>
    )
  }
  const content = (
    <>
      <span style={{ ...S.kindChip, ...(error ? S.kindChipError : S.kindChipWarning) }}>
        {KIND_LABELS[finding.kind]}
      </span>
      <code style={S.token}>{finding.token}</code>
      <span style={S.rowMain}>
        <span style={S.slideTitle}>{finding.slideTitle || '(untitled slide)'}</span>
        {finding.detail ? <span style={S.detail}>{finding.detail}</span> : null}
      </span>
      <span style={S.line}>line {finding.line}</span>
    </>
  )

  if (!onJump) return <div style={{ ...S.findingRow, ...(error ? S.errorRow : S.warningRow) }}>{content}</div>
  return (
    <button
      type="button"
      style={{ ...S.findingRow, ...S.findingButton, ...(error ? S.errorRow : S.warningRow) }}
      onClick={onJump}
      title={`Jump to line ${finding.line}`}
    >
      {content}
    </button>
  )
}

/** The note for a retired `{prework}` section, with the one-step action that moves it into a work file. */
function MovePreworkRow({ note, outlinePath, onJump }: { note: CompilerNote; outlinePath: string; onJump?: () => void }) {
  const [moving, setMoving] = useState(false)
  const [notMoved, setNotMoved] = useState<string | null>(null)
  const [movedTo, setMovedTo] = useState<string | null>(null)
  const move = (): void => {
    setMoving(true)
    setNotMoved(null)
    window.tw.workFiles.movePrework(outlinePath)
      .then((result) => { if (result.ok) setMovedTo(result.fileName); else setNotMoved(result.error) })
      .catch(() => setNotMoved('The section could not be moved, so nothing was changed.'))
      .finally(() => setMoving(false))
  }
  return (
    <div style={{ ...S.compilerRow, ...S.warningRow }} data-doctor-prework-retired>
      <AlertTriangle size={14} style={{ color: AMBER, flexShrink: 0 }} />
      <span style={S.rowMain}>
        <span style={S.slideTitle}>{note.slideTitle}</span>
        <span style={S.detail}>{note.message}</span>
        {movedTo ? <span style={S.detail} role="status">Moved to Work files/{movedTo}.</span> : null}
        {notMoved ? <span style={S.notFixed} role="alert">Not moved. {notMoved}</span> : null}
      </span>
      <button type="button" style={S.fixAction} onClick={move} disabled={moving || movedTo !== null} data-doctor-move-prework>
        {MOVE_PREWORK_ACTION}
      </button>
      {onJump ? (
        <button type="button" style={{ ...S.line, ...S.lineJump }} onClick={onJump} title={`Jump to line ${note.line}`}>line {note.line}</button>
      ) : <span style={S.line}>generated slide</span>}
    </div>
  )
}

function FindingGroups({
  findings,
  onJumpToLine
}: {
  findings: LayoutDoctorFinding[]
  onJumpToLine?: (line: number) => void
}) {
  return (
    <>
      {groupedFindings(findings).map((group) => (
        <div key={group.kind} style={S.kindGroup}>
          <div style={S.kindHeading}>
            {KIND_LABELS[group.kind]} · {group.findings.length}
          </div>
          {group.findings.map((finding, index) => (
            <FindingRow
              key={`${finding.headingLine}:${finding.line}:${finding.kind}:${finding.token}:${index}`}
              finding={finding}
              onJump={onJumpToLine ? () => onJumpToLine(finding.line) : undefined}
            />
          ))}
        </div>
      ))}
    </>
  )
}

type EmptyStateScope = 'talk' | 'compiler' | 'vault'

const EMPTY_STATE_COPY: Record<EmptyStateScope, string> = {
  talk: 'All clear — every trigger in this talk resolves through the registry.',
  compiler: 'All clear — this talk has no compiler notes.',
  vault: 'All clear — every trigger in the vault resolves through the registry.'
}

function EmptyState({ scope, detail }: { scope: EmptyStateScope; detail: string }) {
  return (
    <div style={S.empty}>
      <CheckCircle2 size={15} style={{ color: GREEN, flexShrink: 0 }} />
      <span>
        <b style={{ color: GREEN }}>{EMPTY_STATE_COPY[scope]}</b>{' '}
        {detail}
      </span>
    </div>
  )
}

export default function LayoutDoctorPanel({
  isOpen,
  onClose,
  talk,
  outlineText,
  slideRows,
  onJumpToLine,
  onRestoreTitleIcon
}: Props) {
  const [vaultReport, setVaultReport] = useState<LayoutDoctorTalk[] | null>(null)
  const [vaultError, setVaultError] = useState<string | null>(null)
  const [expandedTalks, setExpandedTalks] = useState<Set<string>>(() => new Set())

  const modalRef = useRef<HTMLDivElement>(null)
  // The trigger findings are read at once, as they always were. The titles whose icon is on the
  // layout line are read with the compiler's facts (tens of milliseconds on a long talk), so that
  // reading waits until the outline has been unchanged for the workspace's compile pause and runs
  // from a timer, never during a render (lib/pausedScan.ts). Until the newer text has been read, the
  // rows of the older reading stay listed with their button off.
  const triggerFindings = useMemo(
    () => (isOpen ? scanOutlineTriggers(outlineText) : []),
    [isOpen, outlineText]
  )
  const stranded = usePausedScan(isOpen ? outlineText : null, strandedTitleIconFindings, talk.outlinePath)
  const strandedFindings = stranded.scanned?.result
  const talkFindings = useMemo(
    () => (strandedFindings?.length ? [...triggerFindings, ...strandedFindings] : triggerFindings),
    [triggerFindings, strandedFindings]
  )
  // The text the stranded-icon rows were read from, kept with them: a fix is bound to it (title-icon-restore.ts).
  const strandedText = stranded.scanned?.text
  const talkScan = useMemo(
    () => (strandedText === undefined ? null : { outlinePath: talk.outlinePath, text: strandedText }),
    [talk.outlinePath, strandedText]
  )
  const talkGroups = useMemo(() => groupedFindings(talkFindings), [talkFindings])
  const compilerNotes = useMemo(
    () => (isOpen ? compilerNotesFor(slideRows) : []),
    [isOpen, slideRows]
  )
  const vaultFindingCount = useMemo(
    () => (vaultReport ?? []).reduce((sum, entry) => sum + entry.findings.length, 0),
    [vaultReport]
  )

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    setVaultReport(null)
    setVaultError(null)
    setExpandedTalks(new Set())
    window.tw.layoutDoctor.scan()
      .then((report) => {
        if (!cancelled) setVaultReport(report ?? [])
      })
      .catch(() => {
        if (!cancelled) setVaultError('The vault scan could not be loaded. Close this panel and try again.')
      })
    return () => { cancelled = true }
  }, [isOpen, talk.outlinePath])

  // The panel takes the keyboard while it is open, so that typing never reaches the editor behind it
  // (the keyboard sheet focuses the editor before it runs the command that opens this), and hands it
  // back to where it was when it closes. As MergeConfirm does; there is no shared helper.
  useEffect(() => {
    if (!isOpen) return
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    modalRef.current?.focus()
    return () => { if (before?.isConnected) before.focus() }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key === 'Tab') {
        // Tab stays among the panel's own controls.
        const modal = modalRef.current
        if (!modal) return
        const stops = [...modal.querySelectorAll<HTMLElement>(TABBABLE)].filter((stop) => stop.offsetParent !== null)
        const at = document.activeElement
        const inside = at instanceof HTMLElement && modal.contains(at) && at !== modal
        if (!stops.length) { event.preventDefault(); modal.focus(); return }
        const first = stops[0]
        const last = stops[stops.length - 1]
        if (event.shiftKey && (!inside || at === first)) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && (!inside || at === last)) { event.preventDefault(); first.focus() }
        return
      }
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  if (!isOpen) return null

  const jump = (line: number) => {
    onJumpToLine(line)
    onClose()
  }
  const toggleTalk = (outlinePath: string) => {
    setExpandedTalks((current) => {
      const next = new Set(current)
      if (next.has(outlinePath)) next.delete(outlinePath)
      else next.add(outlinePath)
      return next
    })
  }

  return (
    <div style={S.backdrop} onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div ref={modalRef} tabIndex={-1} style={S.modal} role="dialog" aria-modal="true" aria-label={`Layout Doctor — ${talk.title}`}>
        <div style={S.header}>
          <div style={{ minWidth: 0 }}>
            <span style={S.title}>{talk.title}</span>
            <span style={S.headLabel}>Layout Doctor</span>
          </div>
          <span style={S.registryNote}>
            {talkFindings.length} trigger finding{talkFindings.length === 1 ? '' : 's'} · {compilerNotes.length} compiler note{compilerNotes.length === 1 ? '' : 's'}
          </span>
          <button type="button" onClick={onClose} style={S.closeBtn} aria-label="Close Layout Doctor" title="Close (Esc)">
            <X size={16} />
          </button>
        </div>
        <div style={S.srcPath}>{talk.outlinePath}</div>

        <div style={S.body}>
          <section style={S.section}>
            <div style={S.sectionHeader}>
              <span style={S.sectionTitle}>This talk</span>
              <span style={S.sectionCount}>{talkFindings.length}</span>
            </div>
            {talkFindings.length === 0 && stranded.pending ? (
              // Nothing found so far, and the title icons are still to be read: not yet "all clear".
              <div style={S.loading}>Checking where this talk’s title icons are written…</div>
            ) : talkFindings.length === 0 ? (
              <EmptyState scope="talk" detail="0 trigger findings in the live outline buffer." />
            ) : (
              <>
                <div style={S.sectionNote}>
                  Select a row to close the doctor and place the editor on its authored trigger line.
                </div>
                {talkGroups.map((group) => (
                  <div key={group.kind} style={S.kindGroup}>
                    <div style={S.kindHeading}>
                      {KIND_LABELS[group.kind]} · {group.findings.length}
                    </div>
                    {group.findings.map((finding, index) => (
                      <FindingRow
                        key={`${finding.headingLine}:${finding.line}:${finding.kind}:${finding.token}:${index}`}
                        finding={finding}
                        onJump={() => jump(finding.line)}
                        onFix={onRestoreTitleIcon && talkScan ? () => onRestoreTitleIcon(finding, talkScan) : undefined}
                        fixWaiting={stranded.pending}
                      />
                    ))}
                  </div>
                ))}
              </>
            )}
          </section>

          <section style={S.section}>
            <div style={S.sectionHeader}>
              <span style={S.sectionTitle}>Compiler notes</span>
              <span style={S.sectionCount}>{compilerNotes.length}</span>
            </div>
            {compilerNotes.length === 0 ? (
              <EmptyState scope="compiler" detail="0 doctor-surfaced compiler notes in the current projection." />
            ) : (
              compilerNotes.map((note) => {
                if (note.code === RETIRED_PREWORK_CODE) return <MovePreworkRow key={note.key} note={note} outlinePath={talk.outlinePath} onJump={note.line == null ? undefined : () => jump(note.line!)} />
                const content = (
                  <>
                    <AlertTriangle size={14} style={{ color: AMBER, flexShrink: 0 }} />
                    <span style={S.rowMain}>
                      <span style={S.slideTitle}>{note.slideTitle}</span>
                      <span style={S.detail}>{note.message}</span>
                    </span>
                    <span style={S.line}>{note.line == null ? 'generated slide' : `line ${note.line}`}</span>
                  </>
                )
                return note.line == null ? (
                  <div key={note.key} style={{ ...S.compilerRow, ...S.warningRow }}>{content}</div>
                ) : (
                  <button
                    key={note.key}
                    type="button"
                    style={{ ...S.compilerRow, ...S.findingButton, ...S.warningRow }}
                    onClick={() => jump(note.line!)}
                    title={`Jump to line ${note.line}`}
                  >
                    {content}
                  </button>
                )
              })
            )}
          </section>

          <section style={{ ...S.section, marginBottom: 0 }}>
            <div style={S.sectionHeader}>
              <span style={S.sectionTitle}>Whole vault</span>
              <span style={S.sectionCount}>
                {vaultReport == null ? '…' : `${vaultReport.length} talk${vaultReport.length === 1 ? '' : 's'} · ${vaultFindingCount} findings`}
              </span>
            </div>
            {vaultError ? <div style={S.errorBox}>{vaultError}</div> : null}
            {vaultReport == null && !vaultError ? <div style={S.loading}>Scanning the vault…</div> : null}
            {vaultReport?.length === 0 ? (
              <EmptyState scope="vault" detail="0 findings across the vault scan." />
            ) : null}
            {(vaultReport ?? []).map((entry) => {
              const expanded = expandedTalks.has(entry.outlinePath)
              const isCurrentTalk = entry.outlinePath === talk.outlinePath
              return (
                <div key={entry.outlinePath} style={S.vaultTalk}>
                  <button
                    type="button"
                    style={S.vaultTalkButton}
                    onClick={() => toggleTalk(entry.outlinePath)}
                    aria-expanded={expanded}
                  >
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span style={S.vaultTalkTitle}>{entry.talk}</span>
                    {isCurrentTalk ? <span style={S.currentBadge}>current</span> : null}
                    <span style={S.vaultTalkCount}>
                      {entry.findings.length} finding{entry.findings.length === 1 ? '' : 's'}
                    </span>
                  </button>
                  {expanded ? (
                    <div style={S.vaultFindings}>
                      <FindingGroups
                        findings={entry.findings}
                        onJumpToLine={isCurrentTalk ? jump : undefined}
                      />
                    </div>
                  ) : null}
                </div>
              )
            })}
          </section>
        </div>

        <div style={S.footer}>
          <span style={S.footerNote}>
            {onRestoreTitleIcon && talkFindings.some((finding) => finding.kind === 'stranded-title-icon')
              ? 'An icon can be moved to its title from here. Every other fix is made in the outline.'
              : 'Report only — fixes remain authored in the outline.'}
          </span>
          <button type="button" onClick={onClose} style={S.closeAction}>Close</button>
        </div>
      </div>
    </div>
  )
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
const AMBER = '#92600a'
const ERROR = '#a33a2b'
const GREEN = 'var(--green, #166534)'
const OXFORD = 'var(--oxford, #0b3a6b)'
const MUTED = 'var(--ink-muted, #5d6875)'
const FAINT = 'var(--ink-faint, #8a9099)'
const LINE = 'var(--line, #c8b89a)'
const PANEL = 'var(--panel, #f5f0e8)'
const PAPER = 'var(--paper-light, #faf7f2)'
const INK = 'var(--ink, #1a1410)'

const S: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.45)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100
  },
  modal: {
    width: 760, maxWidth: '94vw', maxHeight: '88vh',
    background: PANEL, border: `1px solid ${LINE}`, borderRadius: 6,
    overflow: 'hidden', display: 'flex', flexDirection: 'column',
    boxShadow: '0 8px 32px rgba(0,0,0,0.22)', outline: 'none'
  },
  header: {
    display: 'flex', alignItems: 'baseline', gap: 10,
    padding: '0.65rem 0.9rem 0.1rem', flex: '0 0 auto'
  },
  title: {
    fontFamily: "'Iowan Old Style', Palatino, Georgia, serif",
    fontSize: '1.15rem', fontWeight: 600, color: INK
  },
  headLabel: {
    fontSize: '0.62rem', letterSpacing: '0.1em', textTransform: 'uppercase',
    color: FAINT, fontWeight: 650, marginLeft: 10
  },
  registryNote: { marginLeft: 'auto', fontFamily: MONO, fontSize: '0.66rem', color: FAINT },
  closeBtn: {
    background: 'transparent', border: 'none', color: FAINT, cursor: 'pointer',
    padding: '0 0.15rem', alignSelf: 'center', display: 'flex'
  },
  srcPath: {
    fontFamily: MONO, fontSize: '0.66rem', color: FAINT,
    padding: '0 0.95rem 0.55rem', borderBottom: `1px solid ${LINE}`, flex: '0 0 auto',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
  },
  body: { flex: 1, overflowY: 'auto', padding: '0.85rem 0.95rem 1.1rem', minHeight: 0 },
  section: {
    border: `1px solid ${LINE}`, borderRadius: 6, background: PAPER,
    overflow: 'hidden', marginBottom: '0.85rem'
  },
  sectionHeader: {
    display: 'flex', alignItems: 'center', gap: 8, padding: '8px 11px',
    borderBottom: `1px solid ${LINE}`, background: 'rgba(11,58,107,.06)'
  },
  sectionTitle: { color: INK, fontSize: '0.78rem', fontWeight: 700, letterSpacing: '0.02em' },
  sectionCount: { marginLeft: 'auto', fontFamily: MONO, color: FAINT, fontSize: '0.68rem' },
  sectionNote: {
    padding: '7px 11px', color: MUTED, fontSize: '0.72rem',
    borderBottom: `1px dashed ${LINE}`, lineHeight: 1.4
  },
  empty: {
    display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 11px',
    color: MUTED, background: 'rgba(22,101,52,.05)', fontSize: '0.76rem', lineHeight: 1.45
  },
  kindGroup: { padding: '5px 8px 8px' },
  kindHeading: {
    padding: '4px 3px 3px', fontSize: '0.62rem', letterSpacing: '0.08em',
    textTransform: 'uppercase', color: FAINT, fontWeight: 700
  },
  findingRow: {
    width: '100%', display: 'flex', alignItems: 'center', gap: 8,
    padding: '7px 8px', border: 'none', borderTop: `1px dashed ${LINE}`,
    textAlign: 'left', color: INK
  },
  compilerRow: {
    width: '100%', display: 'flex', alignItems: 'flex-start', gap: 8,
    padding: '8px 11px', border: 'none', borderTop: `1px dashed ${LINE}`,
    textAlign: 'left', color: INK
  },
  findingButton: { cursor: 'pointer', font: 'inherit' },
  errorRow: { background: 'rgba(163,58,43,.06)' },
  warningRow: { background: 'rgba(146,96,10,.06)' },
  kindChip: {
    flexShrink: 0, borderRadius: 3, padding: '2px 5px',
    fontSize: '0.61rem', fontWeight: 700, letterSpacing: '0.03em'
  },
  kindChipError: { color: ERROR, background: 'rgba(163,58,43,.12)' },
  kindChipWarning: { color: AMBER, background: 'rgba(146,96,10,.12)' },
  token: {
    fontFamily: MONO, fontSize: '0.7rem', color: INK, background: 'rgba(0,0,0,.06)',
    borderRadius: 3, padding: '2px 5px', maxWidth: 185, overflow: 'hidden',
    textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0
  },
  rowMain: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: 1 },
  slideTitle: { fontSize: '0.76rem', fontWeight: 650, color: INK },
  detail: { fontSize: '0.68rem', color: MUTED, lineHeight: 1.35 },
  line: { fontFamily: MONO, color: FAINT, fontSize: '0.64rem', flexShrink: 0 },
  lineJump: { border: 'none', background: 'transparent', padding: 0, cursor: 'pointer', textDecoration: 'underline' },
  notFixed: { fontSize: '0.68rem', color: ERROR, lineHeight: 1.35 },
  fixAction: {
    flexShrink: 0, border: `1px solid ${LINE}`, borderRadius: 5, background: PAPER,
    color: OXFORD, padding: '3px 9px', fontSize: '0.7rem', fontWeight: 650, cursor: 'pointer'
  },
  fixActionWaiting: { color: FAINT, cursor: 'default' },
  loading: { color: FAINT, fontSize: '0.78rem', padding: '10px 11px' },
  errorBox: {
    color: ERROR, fontSize: '0.78rem', padding: '9px 11px',
    background: 'rgba(163,58,43,.06)'
  },
  vaultTalk: { borderTop: `1px solid ${LINE}` },
  vaultTalkButton: {
    width: '100%', display: 'flex', alignItems: 'center', gap: 7,
    padding: '8px 10px', border: 'none', background: 'transparent',
    color: INK, textAlign: 'left', cursor: 'pointer'
  },
  vaultTalkTitle: { fontSize: '0.77rem', fontWeight: 650, flex: 1 },
  vaultTalkCount: { fontFamily: MONO, fontSize: '0.65rem', color: FAINT },
  currentBadge: {
    color: OXFORD, background: 'rgba(11,58,107,.09)', borderRadius: 3,
    padding: '1px 5px', fontSize: '0.58rem', fontWeight: 700, textTransform: 'uppercase'
  },
  vaultFindings: { borderTop: `1px dashed ${LINE}`, paddingLeft: 12 },
  footer: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '0.65rem 0.9rem',
    borderTop: `1px solid ${LINE}`, background: PANEL
  },
  footerNote: { flex: 1, color: FAINT, fontSize: '0.7rem' },
  closeAction: {
    border: `1px solid ${LINE}`, borderRadius: 5, background: PAPER,
    color: MUTED, padding: '5px 13px', fontSize: '0.78rem', cursor: 'pointer'
  }
}

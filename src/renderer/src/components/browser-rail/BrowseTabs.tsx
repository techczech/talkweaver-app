// Browse group body — Files | Collections tabs (ADR-0009 §3). Files is DISK TRUTH ONLY and is
// the file list's own tree (ADR-0029 §4; frame K1): nested folders at their real depth, the
// Archive last and collapsed, the same folder open/closed memory — with slide counts. Talks
// expand to their sections; disclosure stays separate from the scoping click. Collections are
// lenses (recently edited, recently delivered). Both tabs' rows scope the grid: plain click
// replaces, ⌘click adds.
import { useMemo, useState } from 'react'
import { Archive, ChevronRight, FileText, Folder, FolderOpen, Layers, Monitor, Pencil } from 'lucide-react'
import type { CollectionRow, ScopeFn } from './railTypes'
import { type FilesRow, type FilesTreeSource, filesTreeRows } from './filesTreeModel'
import { useFolderMemory } from '../talklist/folderMemory'

function additive(e: React.MouseEvent): boolean {
  return e.metaKey || e.ctrlKey
}

// Indent per tree level, matching the rows' own 6px inset.
const INDENT = 16
const indent = (depth: number): React.CSSProperties => ({ paddingLeft: 6 + depth * INDENT })

export function FilesTree({ source, isScoped, onScope }: {
  source: FilesTreeSource
  isScoped: (scopeKey: string) => boolean
  onScope: ScopeFn
}) {
  // Folders: the shared memory (open by default, the Archive closed). Talks start closed and
  // their disclosure lasts for this opening.
  const [folderOpen, chooseFolders] = useFolderMemory(source.vaultRoot)
  const [openTalks, setOpenTalks] = useState<Set<string>>(() => new Set())
  const rows = useMemo(() => filesTreeRows(source, folderOpen, openTalks), [source, folderOpen, openTalks])

  const toggleTalk = (slug: string): void => {
    setOpenTalks((set) => {
      const n = new Set(set)
      if (n.has(slug)) n.delete(slug)
      else n.add(slug)
      return n
    })
  }

  const disclosure = (open: boolean, label: string, onToggle: () => void): React.ReactElement => (
    <span
      className={`lt-disc${open ? ' open' : ''}`}
      role="button"
      tabIndex={-1}
      aria-label={label}
      onClick={(e) => { e.stopPropagation(); onToggle() }}
    >
      <ChevronRight className="lt-icon" />
    </span>
  )

  function renderRow(r: FilesRow): React.ReactElement {
    if (r.kind === 'folder') {
      return (
        <button
          key={r.key}
          type="button"
          role="treeitem"
          aria-level={r.depth + 1}
          aria-expanded={r.open}
          data-folder-path={r.path}
          className={`lt-trow folder${r.archive ? ' archive' : ''}${isScoped(`folder:${r.path}`) ? ' scoped' : ''}`}
          style={indent(r.depth)}
          title="Scope to this folder and its subfolders (⌘click adds)"
          onClick={(e) => onScope({ kind: 'folder', folder: r.path }, additive(e))}
        >
          {disclosure(r.open, r.open ? 'Collapse folder' : 'Expand folder', () => chooseFolders({ [r.path]: !r.open }))}
          {r.archive ? <Archive className="lt-icon lt-ficon" /> : r.open ? <FolderOpen className="lt-icon lt-ficon" /> : <Folder className="lt-icon lt-ficon" />}
          <span className="lt-tn">{r.name}</span>
          <span className="lt-tc">{r.count}</span>
        </button>
      )
    }
    if (r.kind === 'talk') {
      return (
        <button
          key={r.key}
          type="button"
          role="treeitem"
          aria-level={r.depth + 1}
          aria-expanded={r.open}
          data-talk-slug={r.slug}
          className={`lt-trow talk${isScoped(`talk:${r.slug}`) ? ' scoped' : ''}${r.current ? ' current' : ''}`}
          style={indent(r.depth)}
          title={r.current
            ? 'The talk you are editing — its slides live in the grid/strip, not the Browser'
            : 'Scope to this talk (⌘click adds)'}
          onClick={r.current ? undefined : (e) => onScope({ kind: 'talk', talk: r.slug, talkTitle: r.title }, additive(e))}
        >
          {disclosure(r.open, r.open ? 'Collapse sections' : 'Expand sections', () => toggleTalk(r.slug))}
          <FileText className="lt-icon lt-ficon" />
          <span className="lt-tn">{r.title}</span>
          {r.current && <span className="lt-current-tag">current</span>}
          <span className="lt-tc">{r.count}</span>
        </button>
      )
    }
    return (
      <button
        key={r.key}
        type="button"
        role="treeitem"
        aria-level={r.depth + 1}
        data-section-of={r.slug}
        className={`lt-trow sec${isScoped(`section:${r.slug}:${r.sec}`) ? ' scoped' : ''}${r.current ? ' current' : ''}`}
        style={indent(r.depth)}
        title={r.current
          ? 'The current talk’s sections don’t scope the Browser'
          : 'Scope to this section (⌘click adds)'}
        onClick={r.current ? undefined : (e) => onScope(
          { kind: 'section', talk: r.slug, talkTitle: r.title, sec: r.sec, secLabel: r.label },
          additive(e)
        )}
      >
        <Layers className="lt-icon lt-ficon" />
        <span className="lt-tn">{r.label || '(no section)'}</span>
        <span className="lt-tc">{r.count}</span>
      </button>
    )
  }

  return (
    <div className="lt-ftree" role="tree" aria-label="Files — folders, talks and sections">
      {rows.map(renderRow)}
      {rows.length === 0 && <div className="lt-fzero">No talks indexed yet.</div>}
    </div>
  )
}

export function Collections({ recent, delivered, isScoped, onScope, currentTalkSlug }: {
  recent: CollectionRow[]
  delivered: CollectionRow[]
  isScoped: (scopeKey: string) => boolean
  onScope: ScopeFn
  /** Rows for the active talk render dimmed + "current" and never scope. */
  currentTalkSlug: string
}) {
  const row = (r: CollectionRow, icon: React.ReactNode, hint: string): React.ReactElement => {
    const isCurrent = r.slug === currentTalkSlug
    return (
      <button
        key={r.key}
        type="button"
        className={`lt-crow${isScoped(`talk:${r.slug}`) ? ' scoped' : ''}${isCurrent ? ' current' : ''}`}
        title={isCurrent ? 'The talk you are editing — its slides live in the grid/strip, not the Browser' : hint}
        onClick={isCurrent ? undefined : (e) => onScope({ kind: 'talk', talk: r.slug, talkTitle: r.title }, additive(e))}
      >
        {icon}
        <span className="lt-tn">
          {r.title}
          {r.sub && <span className="lt-csub"> · {r.sub}</span>}
        </span>
        {isCurrent && <span className="lt-current-tag">current</span>}
        <span className="lt-when">{r.when}</span>
      </button>
    )
  }
  return (
    <div className="lt-collections">
      <div className="lt-coll-label">Recently edited</div>
      {recent.map((r) => row(r, <Pencil className="lt-icon lt-ficon" />, 'Scope to this talk (⌘click adds)'))}
      {recent.length === 0 && <div className="lt-fzero">Nothing edited yet.</div>}
      <div className="lt-coll-label">Recently delivered</div>
      {delivered.map((r) => row(r, <Monitor className="lt-icon lt-ficon" />, 'Scope to the talk behind this delivery (⌘click adds)'))}
      {delivered.length === 0 && <div className="lt-fzero">No deliveries recorded yet.</div>}
      {/* The old dimmed "Pathways — v0.16" placeholder was removed 2026-07-19: pathways shipped
          long ago and open via tools:open-pathways (WorkspaceLayout / PathwayBadge). A stale
          version-badge on a delivered feature was misleading. */}
    </div>
  )
}

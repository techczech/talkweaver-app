// Browse group body — Files | Collections tabs (ADR-0009 §3). Files is DISK TRUTH ONLY
// (folder → talk → section, Talks-panel icon grammar, disclosure separate from the scoping
// click); Collections are lenses (recently edited, recently delivered, Pathways v0.16
// placeholder). Both tabs' rows scope the grid: plain click replaces, ⌘click adds.
import { useState } from 'react'
import { ChevronRight, FileText, Folder, FolderOpen, Layers, Monitor, Pencil, Waypoints } from 'lucide-react'
import type { CollectionRow, ScopeFn, TreeFolder } from './railTypes'

function additive(e: React.MouseEvent): boolean {
  return e.metaKey || e.ctrlKey
}

export function FilesTree({ tree, isScoped, onScope, currentTalkSlug }: {
  tree: TreeFolder[]
  isScoped: (scopeKey: string) => boolean
  onScope: ScopeFn
  /** The active talk stays LISTED (the tree tells disk truth) but renders dimmed with a
   *  "current" label and never scopes — its slides are never on the Browser's table. */
  currentTalkSlug: string
}) {
  // Disclosure state is per-opening (like the Talks panel's transient expansion) —
  // folders start open so the vault reads at a glance; talks start closed.
  const [closedFolders, setClosedFolders] = useState<Set<string>>(() => new Set())
  const [openTalks, setOpenTalks] = useState<Set<string>>(() => new Set())

  const toggleIn = (set: Set<string>, key: string): Set<string> => {
    const n = new Set(set)
    if (n.has(key)) n.delete(key)
    else n.add(key)
    return n
  }

  return (
    <div className="lt-ftree" role="tree" aria-label="Files — folders, talks and sections">
      {tree.map((f) => {
        const fOpen = !closedFolders.has(f.name)
        return (
          <div key={f.name}>
            <button
              type="button"
              className={`lt-trow${isScoped(`folder:${f.name}`) ? ' scoped' : ''}`}
              title="Scope to this folder (⌘click adds)"
              onClick={(e) => onScope({ kind: 'folder', folder: f.name }, additive(e))}
            >
              <span
                className={`lt-disc${fOpen ? ' open' : ''}`}
                role="button"
                tabIndex={-1}
                aria-label={fOpen ? 'Collapse folder' : 'Expand folder'}
                onClick={(e) => { e.stopPropagation(); setClosedFolders((s) => toggleIn(s, f.name)) }}
              >
                <ChevronRight className="lt-icon" />
              </span>
              {fOpen ? <FolderOpen className="lt-icon lt-ficon" /> : <Folder className="lt-icon lt-ficon" />}
              <span className="lt-tn">{f.name}</span>
              <span className="lt-tc">{f.count}</span>
            </button>
            {fOpen && f.talks.map((t) => {
              const tOpen = openTalks.has(t.slug)
              const isCurrent = t.slug === currentTalkSlug
              return (
                <div key={t.slug}>
                  <button
                    type="button"
                    className={`lt-trow talk d1${isScoped(`talk:${t.slug}`) ? ' scoped' : ''}${isCurrent ? ' current' : ''}`}
                    title={isCurrent
                      ? 'The talk you are editing — its slides live in the grid/strip, not the Browser'
                      : 'Scope to this talk (⌘click adds)'}
                    onClick={isCurrent ? undefined : (e) => onScope({ kind: 'talk', talk: t.slug, talkTitle: t.title }, additive(e))}
                  >
                    <span
                      className={`lt-disc${tOpen ? ' open' : ''}`}
                      role="button"
                      tabIndex={-1}
                      aria-label={tOpen ? 'Collapse sections' : 'Expand sections'}
                      onClick={(e) => { e.stopPropagation(); setOpenTalks((s) => toggleIn(s, t.slug)) }}
                    >
                      <ChevronRight className="lt-icon" />
                    </span>
                    <FileText className="lt-icon lt-ficon" />
                    <span className="lt-tn">{t.title}</span>
                    {isCurrent && <span className="lt-current-tag">current</span>}
                    <span className="lt-tc">{t.count}</span>
                  </button>
                  {tOpen && t.sections.map((s) => (
                    <button
                      key={`${t.slug}\n${s.sec}`}
                      type="button"
                      className={`lt-trow sec d2${isScoped(`section:${t.slug}:${s.sec}`) ? ' scoped' : ''}${isCurrent ? ' current' : ''}`}
                      title={isCurrent
                        ? 'The current talk’s sections don’t scope the Browser'
                        : 'Scope to this section (⌘click adds)'}
                      onClick={isCurrent ? undefined : (e) => onScope(
                        { kind: 'section', talk: t.slug, talkTitle: t.title, sec: s.sec, secLabel: s.label },
                        additive(e)
                      )}
                    >
                      <Layers className="lt-icon lt-ficon" />
                      <span className="lt-tn">{s.label || '(no section)'}</span>
                      <span className="lt-tc">{s.count}</span>
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
        )
      })}
      {tree.length === 0 && <div className="lt-fzero">No talks indexed yet.</div>}
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
      {/* Pathways land in v0.16 (ADR-0009: pathway rows live HERE, never in Files) —
          dimmed, non-interactive placeholder so the shape of the shelf is already visible. */}
      <div className="lt-coll-soon" aria-disabled="true">
        <div className="lt-coll-label">Pathways <span className="lt-vbadge-soon">v0.16</span></div>
        <div className="lt-crow soon">
          <Waypoints className="lt-icon lt-ficon" />
          <span className="lt-tn">Reusable slide pathways</span>
        </div>
      </div>
    </div>
  )
}

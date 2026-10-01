// The identical-stack LOCATIONS panel — the where-used list for a byte-identical cluster, in the
// same expansion slot as the filmstrip. Each copy: talk (serif, authored case) · §section · slide,
// a real thumbnail, insert-this-copy + Show in Finder, and a prominent Merge-into-one action.
import { ArrowDown, Check, FolderOpen, GitMerge, X } from 'lucide-react'
import {
  clusterAlreadyOneSlide, clusterMergeable, inTalksLabel, sectionKey, type SlideCluster
} from '../slideBrowserModel'
import { rowTitle } from './browserHelpers'
import { StripRow, Thumb } from './Thumbs'
import type { OpenLoc, SearchResult } from './types'

export function LocationsPanel({
  anchor, openLoc, sectionNoByKey, secName, thumbNonces, regenTalk, noteThumbUnavailable,
  canMerge, onClose, onInsertRow, onMerge
}: {
  anchor: number
  openLoc: OpenLoc
  sectionNoByKey: Map<string, number>
  secName: (key: string, fallback: string) => string
  thumbNonces: Record<string, number>
  regenTalk: string | null
  noteThumbUnavailable: (row: SearchResult) => void
  /** True when the host mounted a merge confirm (onRequestMerge was provided). */
  canMerge: boolean
  onClose: () => void
  onInsertRow: (row: SearchResult) => void
  onMerge: (cluster: SlideCluster) => void
}) {
  const cluster = openLoc.cluster
  if (cluster.kind !== 'identical') return null
  const rows = cluster.rows as SearchResult[]
  const mergeable = clusterMergeable(cluster)
  const alreadyOne = clusterAlreadyOneSlide(cluster)
  return (
    <StripRow key={`loc:${openLoc.rowKey}`} anchor={anchor}>
      <div className="lt-strip-inner lt-locs" onClick={(e) => e.stopPropagation()}>
        <div className="lt-strip-head">
          <span className="lt-sh-title">
            Where this slide lives — {cluster.count} identical {cluster.count === 1 ? 'copy' : 'copies'}
          </span>
          <span className="lt-sh-id">{inTalksLabel(cluster.talks.length)}</span>
          <button type="button" className="lt-sh-close" title="Close locations (Esc)" onClick={onClose}>
            <X className="lt-icon" />
          </button>
        </div>
        <div className="lt-loc-list">
          {rows.map((r, i) => {
            const sk = sectionKey(r.talkSlug, r.section ?? '')
            const secNo = sectionNoByKey.get(sk)
            return (
              <div key={`${r.outlinePath}#${i}`} className="lt-loc-row">
                <div className="lt-loc-thumb">
                  <Thumb
                    key={`${r.talkSlug}/${r.render_hash || r.content_hash}:${thumbNonces[r.talkSlug] ?? 0}`}
                    row={r}
                    regenerating={regenTalk === r.talkSlug}
                    onUnavailable={noteThumbUnavailable}
                  />
                </div>
                <div className="lt-loc-meta">
                  <div className="lt-loc-talk" title={r.talkTitle || r.talkSlug}>{r.talkTitle || r.talkSlug}</div>
                  <div className="lt-loc-where">
                    {r.section
                      ? <>{secNo ? <span className="lt-loc-sec">§{secNo}</span> : null} {secName(sk, r.section)} · {rowTitle(r)}</>
                      : rowTitle(r)}
                  </div>
                </div>
                <div className="lt-loc-acts">
                  <button type="button" className="lt-loc-btn" onClick={() => onInsertRow(r)}>
                    <ArrowDown className="lt-icon" /> Insert this copy
                  </button>
                  <button
                    type="button"
                    className="lt-loc-btn ghost"
                    title="Reveal the outline in Finder"
                    onClick={() => void window.tw.shell.showInFolder(r.outlinePath)}
                  >
                    <FolderOpen className="lt-icon" /> Finder
                  </button>
                </div>
              </div>
            )
          })}
        </div>
        <div className="lt-loc-foot">
          {alreadyOne ? (
            <span className="lt-loc-oneslide">
              <Check className="lt-icon" /> Already one slide — every copy shares a ledger id.
            </span>
          ) : (
            <>
              <span className="lt-loc-reassure">
                Merging stamps every copy with one shared id, so they become a single slide — searches
                show it once. Nothing is lost; each copy’s content is unchanged.
              </span>
              <span className="lt-loc-spacer" />
              <button
                type="button"
                className="lt-btn primary"
                disabled={!mergeable || !canMerge}
                onClick={() => onMerge(cluster)}
              >
                <GitMerge className="lt-icon" /> Merge into one slide
              </button>
            </>
          )}
        </div>
      </div>
    </StripRow>
  )
}

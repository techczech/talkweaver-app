// The version filmstrip — versions as archival prints, newest first, canonical starred. Opens in
// the grid's expansion slot under the card whose version badge (or E) asked for it.
import { Star, X } from 'lucide-react'
import type { LedgerVersion } from '../../../../preload/index'
import type { AdoptVersion } from '../PropagationChecklist'
import { canonicalVersion } from '../slideBrowserModel'
import { formatVersionDate, sealLabel, versionTitle } from './browserHelpers'
import { StripRow, VersionThumb } from './Thumbs'
import type { OpenStrip, SearchResult } from './types'

export function VersionStrip({
  anchor, row, openStrip, titleBySlug, flashFile, onClose, onInsertVersion, onAdoptVersion
}: {
  anchor: number
  row: SearchResult
  openStrip: OpenStrip
  titleBySlug: Map<string, string>
  flashFile: string | null
  onClose: () => void
  onInsertVersion: (v: LedgerVersion, row: SearchResult) => void
  onAdoptVersion?: (slideId: string, version: AdoptVersion) => void
}) {
  const versions = openStrip.versions
  const canon = versions ? canonicalVersion(versions) : null
  return (
    <StripRow key={`strip:${openStrip.rowKey}`} anchor={anchor}>
      <div className="lt-strip-inner" onClick={(e) => e.stopPropagation()}>
        <div className="lt-strip-head">
          <span className="lt-sh-title">Versions — newest first</span>
          <span className="lt-sh-id">id={openStrip.id}</span>
          <button type="button" className="lt-sh-close" title="Close versions (Esc)" onClick={onClose}>
            <X className="lt-icon" />
          </button>
        </div>
        <div className="lt-strip">
          {versions === null &&
            [0, 1].map((i) => (
              <div key={i} className="lt-vprint">
                <div className="lt-vframe"><div className="lt-vthumb"><div className="lt-sk-thumb" /></div></div>
              </div>
            ))}
          {versions?.map((v, idx) => {
            const isCanon = canon !== null && v.file === canon.file
            const seal = sealLabel(v, idx)
            const srcTalk = (v.talk && (titleBySlug.get(v.talk) ?? v.talk)) || row.talkTitle
            return (
              <div key={v.file} className={`lt-vprint${isCanon ? ' canonical' : ''}`}>
                <div className="lt-vframe">
                  <VersionThumb
                    url={openStrip.thumbs?.[v.file]}
                    pending={openStrip.thumbs === null}
                    title={versionTitle(v.markdown)}
                  />
                </div>
                <div className="lt-vcap">
                  <div className="lt-vdate">
                    {isCanon && <span className="lt-star"><Star className="lt-icon" /></span>}
                    {formatVersionDate(v.savedAt)}{isCanon ? ' · canonical' : ''}
                  </div>
                  <div className="lt-vsrc" title={srcTalk}>{srcTalk}</div>
                  <div className="lt-vseal">{seal}</div>
                </div>
                <button
                  type="button"
                  className="lt-vact"
                  onClick={(e) => { e.stopPropagation(); onInsertVersion(v, row) }}
                >
                  {flashFile === v.file ? 'Inserted ✓' : 'Insert this version ↵'}
                </button>
                {onAdoptVersion && (
                  <button
                    type="button"
                    className="lt-vact lt-vact-adopt"
                    title="Replace this slide with this version in other presentations (A5)"
                    onClick={(e) => {
                      e.stopPropagation()
                      onAdoptVersion(openStrip.id, {
                        file: v.file,
                        markdown: v.markdown,
                        savedAt: v.savedAt,
                        talk: v.talk ?? row.talkSlug,
                        canonical: isCanon
                      })
                    }}
                  >
                    Adopt this version in…
                  </button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </StripRow>
  )
}

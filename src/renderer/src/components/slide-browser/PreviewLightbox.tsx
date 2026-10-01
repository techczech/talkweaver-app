// Space preview lightbox (ported from SearchPalette; .preview-lightbox sits above the .lt root).
import { thumbUrl } from '../../lib/thumbUrl'
import { rowTitle } from './browserHelpers'
import type { SearchResult } from './types'

export function PreviewLightbox({ row, onClose }: { row: SearchResult; onClose: () => void }) {
  return (
    <div className="preview-lightbox" onClick={onClose} role="dialog" aria-label="Slide preview">
      <img
        src={thumbUrl(row.talkSlug, row.render_hash || row.content_hash, row.vaultId)}
        alt={rowTitle(row)}
      />
      <div className="preview-lightbox-cap">{rowTitle(row)} — {row.talkTitle}</div>
    </div>
  )
}

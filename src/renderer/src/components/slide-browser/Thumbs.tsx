// The Slide Browser's print thumbnails: a slide's real 16:9 render, a version print's render, and
// the animated row an expansion (filmstrip / locations) sits in.
import { thumbUrl } from '../../lib/thumbUrl'
import { useEffect, useState } from 'react'
import { rowTitle } from './browserHelpers'
import type { SearchResult } from './types'

// Real 16:9 print: shimmer while the twthumb:// render decodes, schematic title fallback
// when it 404s (GridView CellThumb pattern). Keyed by src + regen nonce at the call site so
// a re-render with a new hash (or a fresh background thumbnail run) restarts cleanly.
// `onUnavailable` reports a 404 upward so the Browser can queue a background per-talk
// thumbnail run (Gate-4 bug 4); while that run is in flight (`regenerating`) the failed
// print shows the shimmer, not the schematic — it will resolve either way in a moment.
export function Thumb({ row, regenerating, onUnavailable }: {
  row: SearchResult
  regenerating: boolean
  onUnavailable: (row: SearchResult) => void
}) {
  const hasHash = Boolean(row.content_hash)
  const [state, setState] = useState<'loading' | 'ok' | 'failed'>(hasHash ? 'loading' : 'failed')
  return (
    <div className="lt-thumb">
      {hasHash && state !== 'failed' && (
        <img
          src={thumbUrl(row.talkSlug, row.render_hash || row.content_hash, row.vaultId)}
          alt={rowTitle(row)}
          loading="lazy"
          decoding="async"
          onLoad={() => setState('ok')}
          onError={() => { setState('failed'); onUnavailable(row) }}
        />
      )}
      {state === 'loading' && <div className="lt-sk-thumb"><span className="lt-sk-note">rendering…</span></div>}
      {state === 'failed' && (hasHash && regenerating
        ? <div className="lt-sk-thumb"><span className="lt-sk-note">rendering…</span></div>
        : <div className="lt-thumb-fallback">{rowTitle(row)}</div>)}
    </div>
  )
}

// A version print's 16:9 thumbnail: real render from the versionThumbnails batch, shimmer
// while the batch promise is in flight (`urls === null`), schematic title fallback when the
// batch resolved without this version's key (or the image itself fails to decode).
export function VersionThumb({ url, pending, title }: { url?: string; pending: boolean; title: string }) {
  const [failed, setFailed] = useState(false)
  return (
    <div className="lt-vthumb">
      {url && !failed && <img src={url} alt={title} decoding="async" onError={() => setFailed(true)} />}
      {pending && <div className="lt-sk-thumb"><span className="lt-sk-note">rendering…</span></div>}
      {!pending && (!url || failed) && <div className="lt-vthumb-fallback">{title}</div>}
    </div>
  )
}

// Full-grid-width expansion row. Mounted closed and flipped to .open a frame later so the
// max-height/opacity transition actually plays on expand (mockup 457-462).
export function StripRow({ anchor, children }: { anchor: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setOpen(true))
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <div className={`lt-strip-row${open ? ' open' : ''}`} style={{ ['--anchor' as string]: `${anchor}%` }}>
      {children}
    </div>
  )
}

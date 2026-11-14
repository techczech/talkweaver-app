// Where your face appears (docs/design/2026-11-10-record-and-edit-video, contract "picture"): four
// layouts, corner and size for In the corner, and what it is used for (this slide, a run of slides, the
// whole video). Every choice is one edit (op `face`) and shows in the player at once; the recording keeps
// the camera separately, so it can be changed again at any time.
import { useState, type ReactNode } from 'react'
import { ModalSheet } from './LookAndSound'
import { DEFAULT_FACE, faceOf, type FaceCorner, type FaceLayout, type FacePlacement, type FaceSize, type RecordingFaces } from '../../../../shared/recording-edits'
import { placementRects, toPercent } from '../../../../shared/recording-video'

const LAYOUTS: Array<{ layout: FaceLayout; name: string }> = [
  { layout: 'corner', name: 'In the corner' },
  { layout: 'side', name: 'Side by side' },
  { layout: 'face', name: 'Face only' },
  { layout: 'slide', name: 'Slide only' }
]
const SIZES: Array<{ size: FaceSize; name: string }> = [{ size: 'small', name: 'Small' }, { size: 'medium', name: 'Medium' }, { size: 'large', name: 'Large' }]
const CORNERS: Array<{ corner: FaceCorner; name: string }> = [{ corner: 'bottom-right', name: 'Bottom right' }, { corner: 'bottom-left', name: 'Bottom left' }]

/** The row button's words: "Face: corner" and so on. */
export function faceLabel(face: FacePlacement): string {
  return face.layout === 'corner' ? 'Face: corner' : face.layout === 'side' ? 'Face: side by side' : face.layout === 'face' ? 'Face only' : 'Face: hidden'
}

/** A small picture of a layout, drawn from the export's own rectangles. */
function LayoutPicture({ face }: { face: FacePlacement }): ReactNode {
  const r = placementRects(face)
  const box = (rect: typeof r.slides, cls: string): ReactNode => {
    if (!rect) return null
    const p = toPercent(rect)
    return <i className={cls} style={{ left: `${p.left}%`, top: `${p.top}%`, width: `${p.width}%`, height: `${p.height}%` }} />
  }
  return <span className="tre-face-pic" aria-hidden="true">{box(r.slides, 'slide')}{box(r.camera, 'cam')}</span>
}

export type FaceRow = { index: number; change: number; n: number }

export function FacePositionSheet({ row, rows, faces, hasCamera, cameraOn, disabled, onApply, onClose }: {
  /** The slide whose face control was clicked. */
  row: FaceRow
  /** Every slide row, in order (for "Slides 3 to 5"). */
  rows: FaceRow[]
  faces: RecordingFaces
  hasCamera: boolean
  cameraOn: boolean
  disabled: boolean
  onApply: (changes: number[] | null, face: FacePlacement) => void
  onClose: () => void
}): ReactNode {
  const [scope, setScope] = useState<'slide' | 'range' | 'all'>('slide')
  const later = rows.filter((r) => r.index > row.index)
  const [to, setTo] = useState<number>(later[0]?.index ?? row.index)
  const face = faceOf(faces, row.change)
  const changesFor = (s: typeof scope, until = to): number[] | null =>
    s === 'all' ? null : s === 'slide' ? [row.change] : rows.filter((r) => r.index >= row.index && r.index <= until).map((r) => r.change)
  const apply = (next: FacePlacement, s = scope, until = to): void => onApply(changesFor(s, until), next)
  const off = disabled || !hasCamera
  const lastN = rows.find((r) => r.index === to)?.n ?? row.n
  return (
    <ModalSheet className="tre-face" labelledBy="tre-face-title" onClose={onClose}>
        <header><h2 id="tre-face-title">Slide {row.n}: where your face appears</h2></header>
        <div className="tre-sheet-body">
          {!hasCamera ? <p className="tre-look-note warn tre-face-none" role="note">This recording has no camera, so the video shows the slides only.</p>
            : !cameraOn ? <p className="tre-look-note warn tre-face-none" role="note">The camera is switched off for this video, so it shows the slides only. Your choice is kept for when it is on.</p> : null}
          <div className="tre-face-layouts" role="radiogroup" aria-label="Layout">
            {LAYOUTS.map((l) => (
              <label key={l.layout} className={`tre-face-tile${face.layout === l.layout ? ' on' : ''}${off ? ' off' : ''}`}>
                <input type="radio" className="tre-face-radio" name="tre-face-layout" value={l.layout} checked={face.layout === l.layout} disabled={off}
                  onChange={() => apply({ ...face, layout: l.layout })} />
                <LayoutPicture face={{ ...(face.layout === 'corner' && l.layout === 'corner' ? face : DEFAULT_FACE), layout: l.layout }} />
                <span>{l.name}</span>
              </label>
            ))}
          </div>
          {face.layout === 'corner' ? (
            <div className="tre-look-set">
              <span className="tre-look-name" id="tre-face-corner">Corner</span>
              <div className="tre-look-choice">
                <select aria-labelledby="tre-face-corner" value={face.corner} disabled={off} onChange={(e) => apply({ ...face, corner: e.target.value as FaceCorner })}>
                  {CORNERS.map((c) => <option key={c.corner} value={c.corner}>{c.name}</option>)}
                </select>
              </div>
              <span className="tre-look-name" id="tre-face-size">Size</span>
              <div className="tre-look-choice tre-seg" role="radiogroup" aria-labelledby="tre-face-size">
                {SIZES.map((z) => <label key={z.size} className={`tre-seg-opt${face.size === z.size ? ' on' : ''}`}><input type="radio" name="tre-face-size" value={z.size} checked={face.size === z.size} disabled={off} onChange={() => apply({ ...face, size: z.size })} /> {z.name}</label>)}
              </div>
            </div>
          ) : null}
          <div className="tre-look-set">
            <span className="tre-look-name" id="tre-face-scope">Use for</span>
            <div className="tre-look-choice" role="radiogroup" aria-labelledby="tre-face-scope">
              <label><input type="radio" name="tre-face-scope" checked={scope === 'slide'} disabled={off} onChange={() => { setScope('slide'); apply(face, 'slide') }} /> This slide</label>
              {later.length ? (
                <label><input type="radio" name="tre-face-scope" checked={scope === 'range'} disabled={off} onChange={() => { setScope('range'); apply(face, 'range') }} /> Slides {row.n} to{' '}
                  <select aria-label="Last slide" value={to} disabled={off} onChange={(e) => { const until = Number(e.target.value); setTo(until); setScope('range'); apply(face, 'range', until) }}>
                    {later.map((r) => <option key={r.index} value={r.index}>{r.n}</option>)}
                  </select>
                </label>
              ) : null}
              <label><input type="radio" name="tre-face-scope" checked={scope === 'all'} disabled={off} onChange={() => { setScope('all'); apply(face, 'all') }} /> The whole video</label>
              {scope === 'range' ? <span className="tre-look-note">Slides {row.n} to {lastN} use this.</span> : null}
            </div>
          </div>
        </div>
        <footer>
          <span className="tre-look-foot">The player shows the change straight away. You can change it again at any time.</span>
          <span className="tre-sp" />
          <button className="tw-btn tw-btn--primary" onClick={onClose}>Done</button>
        </footer>
    </ModalSheet>
  )
}

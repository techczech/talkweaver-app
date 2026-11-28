import { useLayoutEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { twoLineDiff } from '../../../shared/feedback'
import { readOutlineSlides } from '../../../shared/feedback-accept'
import { isGreyMark, pictureMarkUrl, type VariantPictureMarks } from '../../../shared/variant-picture-queue'
import RightPanelPictures, { type PanelTry } from './RightPanelPictures'
import { sectionModePicture, type PanelSurface } from './RightPanelPages'
import type { Design } from './rightPanelDesigns'

const FILTERS = [['all', 'All'], ['fits', 'Fits as is'], ['structure', 'Changes the structure']] as const

function StructureChanges({ preview, text, headingLine }: { preview: PanelTry; text: string; headingLine: number | null }) {
  const body = (outline: string) => {
    const { slides, lines, notes } = readOutlineSlides(outline)
    const slide = slides.find(item => item.line === headingLine)
    if (!slide) return ''
    return lines.slice(slide.start + 1, slide.blockEnd)
      .filter((line, index) => !notes.has(slide.start + 1 + index) && !/^\s*(?:\{[^}]*\}\s*)+$/.test(line))
      .join('\n')
  }
  const diff = twoLineDiff(body(text), body(preview.text))
  return <div className="tw-layout-gallery-changes">
    <strong>What changes in your text</strong>
    <p>{preview.whatChanges}</p>
    {diff.lines.length > 0 && <div className="tw-layout-gallery-diff">
      {diff.lines.map(({ op, text }, index) => op === 'del' ? <del key={index}>{text}</del> : <ins key={index}>{text}</ins>)}
      {diff.more > 0 && <span>{diff.more} more changed {diff.more === 1 ? 'line' : 'lines'}</span>}
    </div>}
  </div>
}

export default function LayoutGallery({ surface, designs, marks, preview, headingLine, section, onClose }: {
  surface: PanelSurface
  designs: Design[]
  marks: VariantPictureMarks
  preview?: PanelTry | null
  headingLine: number | null
  section: boolean
  onClose: () => void
}) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>('all')
  const close = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => { close.current?.focus({ preventScroll: true }) }, [])
  const ready = designs.filter(design => !design.unavailable && (!design.check || pictureMarkUrl(marks[design.label])))
  const fits = ready.filter(design => !design.structure)
  const structure = ready.filter(design => design.structure)
  const refused = designs.flatMap(design => {
    const mark = marks[design.label]
    const reason = design.unavailable ?? (isGreyMark(mark) ? mark.reason : undefined)
    return reason ? [{ label: design.label, reason }] : []
  })
  const pending = designs.some(design => design.check && !(design.label in marks))
  const failed = designs.some(design => design.check && marks[design.label] === null)
  const count = { all: ready.length, fits: fits.length, structure: structure.length }
  return <section id="tw-layout-gallery" className="tw-layout-gallery" aria-labelledby="tw-layout-gallery-title">
    <header className="tw-layout-gallery-head">
      <div>
        <h2 id="tw-layout-gallery-title">Layouts for this slide</h2>
        <p>Point at one to try it on the slide. Click to use it. Undo takes it back.</p>
      </div>
      <button type="button" className="toolbar-btn" ref={close} onClick={onClose} aria-keyshortcuts="Escape"><X size={14} />Close</button>
    </header>
    <div className="tw-layout-gallery-body">
      <div className="tw-layout-gallery-filters" role="group" aria-label="Filter layouts">
        {FILTERS.map(([id, label]) => <button type="button" key={id} className="toolbar-btn" aria-pressed={filter === id} onClick={() => {
          surface.onTry(null)
          setFilter(id)
        }}>{label} <span>{count[id]}</span></button>)}
      </div>
      {filter !== 'structure' && fits.length > 0 && <section className="tw-layout-gallery-group" aria-label="Fits as is">
        <h3>Fits as is · {fits.length}</h3>
        <RightPanelPictures {...surface} group="gallery-fits" choices={fits} columns="auto" checkedPictures={marks} trying={preview?.label}
          pendingPicture={section ? sectionModePicture : undefined} />
      </section>}
      {filter !== 'fits' && structure.length > 0 && <section className="tw-layout-gallery-group" aria-label="Changes the structure">
        <h3>Changes the structure · {structure.length}</h3>
        <RightPanelPictures {...surface} group="gallery-structure" choices={structure} columns="auto" checkedPictures={marks} trying={preview?.label} />
        {preview?.whatChanges && <StructureChanges preview={preview} text={surface.text} headingLine={headingLine} />}
      </section>}
      {pending ? <p role="status">Checking which layouts fit…</p>
        : count[filter] === 0 && <p>{filter === 'structure' ? 'No layouts that change the structure are available.' : 'No layouts in this view fit this slide.'}</p>}
      {failed && <p>Some layouts could not be previewed.</p>}
      {refused.length > 0 && <footer className="tw-layout-gallery-refused">
        <strong>Not offered</strong>{' '}
        {refused.map(({ label, reason }) => `${label} (${reason})`).join(' · ')}
      </footer>}
    </div>
  </section>
}

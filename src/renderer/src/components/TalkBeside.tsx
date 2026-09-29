// The right side of the picker's split (talk search 06; ADR-0029 §4; frame K5): a result's whole
// talk beside the results, under a header "‹talk› · § ‹section› · slide N of M · Esc close". The
// cards themselves are the picker's own (passed as children), so they select, preview and insert
// exactly as the results do. Mounted per opening (keyed by talk and slide), so each open scrolls
// afresh to the result's section with the slide in view.
import { useLayoutEffect, useRef } from 'react'
import { PanelRight } from 'lucide-react'
import { type BesideHeader, besideHeaderText, besideScrollTop } from './talkBesideModel'

export default function TalkBeside({ header, hlChunk, hlPos, onClose, children }: {
  header: BesideHeader
  /** Chunk index (data-chunk) of the highlighted slide's section. */
  hlChunk: number
  /** Visual position (data-pos) of the highlighted slide. */
  hlPos: number
  onClose: () => void
  children: React.ReactNode
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const box = scrollRef.current
    if (!box) return
    const sec = box.querySelector<HTMLElement>(`[data-chunk="${hlChunk}"]`)
    const card = box.querySelector<HTMLElement>(`[data-pos="${hlPos}"]`)
    if (!sec || !card) return
    const origin = box.getBoundingClientRect().top - box.scrollTop
    const s = sec.getBoundingClientRect()
    const c = card.getBoundingClientRect()
    box.scrollTop = besideScrollTop({
      sectionTop: s.top - origin - 4,
      cardTop: c.top - origin,
      cardBottom: c.bottom - origin,
      viewport: box.clientHeight
    })
    // Once per opening: the parent keys this component by talk and slide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <section className="lt-beside" aria-label={`${header.title} beside the results`}>
      <div className="lt-beside-head" title={besideHeaderText(header)}>
        <PanelRight className="lt-icon" />
        <b className="lt-beside-talk">{header.title}</b>
        {header.section && <span className="lt-beside-sec">{header.section}</span>}
        <span className="lt-beside-pos">{header.position}</span>
        <button type="button" className="lt-beside-x" title="Close the talk (Esc)" onClick={onClose}>
          Esc close
        </button>
      </div>
      <div className="lt-beside-scroll" ref={scrollRef}>{children}</div>
    </section>
  )
}

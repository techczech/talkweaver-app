import { useMemo, useState } from 'react'

interface Heading {
  line: number // 1-based source line
  level: number // 1..6
  text: string
}

interface Props {
  mode: 'outline' | 'slides'
  content: string
  onJump: (line: number) => void
}

// Parse the outline's headings, stripping inline {triggers} from the display text.
function parseHeadings(content: string): Heading[] {
  const out: Heading[] = []
  content.split('\n').forEach((t, i) => {
    const m = t.match(/^(#{1,6})\s+(.*)$/)
    if (m) {
      const text = m[2].replace(/\{[^}]*\}/g, '').trim()
      out.push({ line: i + 1, level: m[1].length, text: text || '(untitled)' })
    }
  })
  return out
}

// Which headings are hidden because an ancestor is collapsed.
function hiddenSet(headings: Heading[], collapsed: Set<number>): Set<number> {
  const hidden = new Set<number>()
  let collapseLevel: number | null = null
  for (const h of headings) {
    if (collapseLevel !== null && h.level > collapseLevel) {
      hidden.add(h.line)
      continue
    }
    collapseLevel = null
    if (collapsed.has(h.line)) collapseLevel = h.level
  }
  return hidden
}

export default function PresentationNav({ mode, content, onJump }: Props) {
  const headings = useMemo(() => parseHeadings(content), [content])
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set())

  function toggle(line: number): void {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(line)) next.delete(line)
      else next.add(line)
      return next
    })
  }

  if (headings.length === 0) {
    return (
      <div className="pres-nav-empty">
        {content ? 'No headings yet.' : 'Select a talk to see its structure.'}
      </div>
    )
  }

  if (mode === 'slides') {
    // Section headers (## / #) + their ### slides, numbered. Collapsible by section.
    let slideNo = 0
    const hidden = hiddenSet(
      headings.filter((h) => h.level <= 3),
      collapsed
    )
    return (
      <div className="pres-nav" data-pres-nav="slides">
        {headings
          .filter((h) => h.level <= 3)
          .map((h) => {
            if (h.level === 3) slideNo += 1
            if (hidden.has(h.line)) return null
            if (h.level <= 2) {
              const isCollapsed = collapsed.has(h.line)
              return (
                <div key={h.line} className="pres-nav-section" data-pres-section>
                  <button
                    type="button"
                    className="pres-nav-caret"
                    onClick={() => toggle(h.line)}
                    aria-expanded={!isCollapsed}
                  >
                    {isCollapsed ? '▸' : '▾'}
                  </button>
                  <button type="button" className="pres-nav-section-label" onClick={() => onJump(h.line)}>
                    {h.text}
                  </button>
                </div>
              )
            }
            return (
              <button
                key={h.line}
                type="button"
                className="pres-nav-slide"
                data-pres-slide
                onClick={() => onJump(h.line)}
              >
                <span className="pres-nav-slide-no">{String(slideNo).padStart(2, '0')}</span>
                <span className="pres-nav-slide-title">{h.text}</span>
              </button>
            )
          })}
      </div>
    )
  }

  // Outline mode: every heading, nested by level, collapsible at any level.
  const hidden = hiddenSet(headings, collapsed)
  return (
    <div className="pres-nav" data-pres-nav="outline" data-content-len={content.length} data-heading-count={headings.length}>
      {headings.map((h, i) => {
        if (hidden.has(h.line)) return null
        const next = headings[i + 1]
        const hasChildren = !!next && next.level > h.level
        const isCollapsed = collapsed.has(h.line)
        return (
          <div
            key={h.line}
            className="pres-nav-row"
            data-pres-heading
            style={{ paddingLeft: 4 + (h.level - 1) * 12 }}
          >
            {hasChildren ? (
              <button
                type="button"
                className="pres-nav-caret"
                onClick={() => toggle(h.line)}
                aria-expanded={!isCollapsed}
              >
                {isCollapsed ? '▸' : '▾'}
              </button>
            ) : (
              <span className="pres-nav-caret pres-nav-caret--leaf">·</span>
            )}
            <button
              type="button"
              className={`pres-nav-heading pres-nav-h${h.level}`}
              onClick={() => onJump(h.line)}
              title={h.text}
            >
              {h.text}
            </button>
          </div>
        )
      })}
    </div>
  )
}

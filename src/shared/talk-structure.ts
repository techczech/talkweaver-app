// ADR-0045 ST1 and LO2. The compiler decides which lines are headings and which
// descendants are part of a slide. Editing structure changes heading markers only.
import { readOutlineSlides } from './feedback-accept.ts'
import { readOutline, readSlides } from './insert-section.ts'
import { headingOrderFromLineOrder } from './outline-save-identity.ts'

export type SectionKind = 'section' | 'subsection'
export const NO_SECTION = 'Make a section first.'
export const NONCONTIGUOUS = 'Select slides next to each other.'
const SELECTED_SECTION = 'Sections can’t go inside a new section.'
const CAPTURES_UNSELECTED = 'A section runs until the next section. Select through to the end, or move these slides first.'
const TOO_DEEP = 'There is no room for another heading level here.'
const UNSAFE = 'The outline would read differently after this edit. Check its headings, comments and code fences.'

export type StructureResult = { ok: true; text: string; line: number; count: number; kind: SectionKind } | { ok: false; error: string }
type Reading = ReturnType<typeof readSlides>
type SourceSlide = Reading['slides'][number]
type Node = SourceSlide & { folded: boolean; container: boolean; section: boolean }
type Structure = ReturnType<typeof structureOf>

export function structureOf(text: string) {
  const reading = readSlides(text)
  const shape = readOutlineSlides(text)
  const below = new Map(shape.slides.map(slide => [slide.start, slide]))
  const nodes: Node[] = reading.slides.map(slide => {
    const source = below.get(slide.line)
    const attrs = JSON.parse(slide.attrs)
    const section = !source?.folded && !source?.container && (slide.level === 2 ||
      attrs.role === 'subsection-title' || attrs.sub === true ||
      (source?.opensSection === true && slide.content.trim() === ''))
    return { ...slide, folded: !!source?.folded, container: !!source?.container, section }
  })
  return { ...reading, nodes, lines: shape.lines, ...readOutline(text) }
}

/** The authored heading owning a 1-based source line, including a carousel pane. */
export function nodeAtSourceLine(structure: Structure, line: number): Node | undefined {
  for (let i = structure.nodes.length - 1; i >= 0; i--) {
    if (structure.nodes[i].line < line) return structure.nodes[i]
  }
  return undefined
}

export function carouselPaneSibling(structure: Structure, pane: Node, direction: 'up' | 'down'): Node | undefined {
  if (!pane.folded) return undefined
  const owner = pane.ancestors.at(-1)
  const siblings = structure.nodes.filter(node => node.folded && node.level === pane.level && node.ancestors.at(-1) === owner)
  const index = siblings.indexOf(pane)
  return index < 0 ? undefined : siblings[index + (direction === 'up' ? -1 : 1)]
}

function containerAt(nodes: readonly Node[], node: Node): Node {
  return node.ancestors.map(i => nodes[i]).find(parent => parent.container) ?? node
}

function sectionAt(nodes: readonly Node[], node: Node | undefined): Node | undefined {
  return node && [...node.ancestors.map(i => nodes[i]), node].find(parent => parent.level === 2 && parent.section)
}

export function subsectionOwner(structure: Structure, line: number | null): Node | undefined {
  return sectionAt(structure.nodes, structure.nodes.find(node => node.line + 1 === line))
}

function boundary(structure: Structure, node: Node, descendants: boolean): number {
  const { levels } = structure
  let at = node.line + 1
  while (at < levels.length && (!levels[at] || (descendants && levels[at] > node.level))) at++
  return at
}

function sectionEdit(
  structure: Structure, at: number, end: number, level: number, id: string, kind: SectionKind
): StructureResult {
  const { nodes, lines, levels, openComment, openFence } = structure
  if (!/^[\w-]+$/.test(id) || nodes.some(node => node.id === id) || openFence || openComment) return { ok: false, error: UNSAFE }
  const moved = nodes.filter(node => node.line >= at && node.line < end)
  const selected = new Set(moved)
  // Each root may start at a different depth (for example at the tail of a subsection).
  // Keep every descendant at the same distance from its root.
  const depths = new Map<Node, number>()
  for (const node of moved) {
    const parent = node.ancestors.map(i => nodes[i]).reverse().find(candidate => selected.has(candidate))
    const depth = parent ? depths.get(parent)! + node.level - parent.level : Math.max(level + 1, node.level)
    if (depth > 6) return { ok: false, error: TOO_DEEP }
    depths.set(node, depth)
  }
  const rewritten = lines.slice()
  for (const [node, depth] of depths) rewritten[node.line] = '#'.repeat(depth) + lines[node.line].slice(node.level)
  // Leave the file's trailing separators in place, including when it has no final newline.
  while (at > structure.bodyStart && !lines[at - 1].trim()) at--
  const terminal = at === lines.length
  const cr = lines.some(line => line.endsWith('\r')) ? '\r' : ''
  const prefix = at > 0 && lines[at - 1].trim() ? [cr] : []
  const heading = `${'#'.repeat(level)}  {id=${id}}`
  const trigger = kind === 'section' ? '{role=section-title}' : '{sub}{role=subsection-title}'
  if (terminal && cr) rewritten[at - 1] += cr
  const inserted = [...prefix, heading + cr, trigger + (terminal ? '' : cr)]
  rewritten.splice(at, 0, ...inserted)
  const text = rewritten.join('\n')
  const result = readSlides(text)
  const index = result.slides.findIndex(slide => slide.id === id)
  const newSection = result.slides[index]
  const others = result.slides.filter(slide => slide !== newSection)
  // Check the compiler sees the same slide IDs, prose, notes and attributes. Also
  // check the exact set owned by the inserted heading, including folded panes.
  const same = (before: SourceSlide, after: SourceSlide) =>
    before.id === after.id && before.title === after.title && before.attrs === after.attrs &&
    before.content === after.content && before.notes === after.notes
  if (!newSection || newSection.level !== level || result.deckTitle !== structure.deckTitle ||
      result.preamble !== structure.preamble || others.length !== nodes.length ||
      others.some((slide, i) => !same(nodes[i], slide) || slide.level !== (depths.get(nodes[i]) ?? nodes[i].level) ||
        slide.ancestors.includes(index) !== selected.has(nodes[i]))) return { ok: false, error: UNSAFE }
  const count = moved.filter(node => !node.folded && !node.section).length
  return { ok: true, text, line: newSection.line + 1, count, kind }
}

export function createSection(text: string, options: { kind: SectionKind; after: number | null; id: string }): StructureResult {
  const structure = structureOf(text)
  const { nodes, levels } = structure
  const matching = nodes.find(node => node.line + 1 === options.after)
  if (options.after !== null && !matching) return { ok: false, error: UNSAFE }
  const anchor = matching && containerAt(nodes, matching)
  const owner = sectionAt(nodes, anchor)
  const level = options.kind === 'section' ? 2 : 3
  if (options.kind === 'subsection' && !owner) return { ok: false, error: NO_SECTION }
  if (options.kind === 'section' && anchor?.section && anchor.level === 2) {
    const at = boundary(structure, anchor, true)
    return sectionEdit(structure, at, at, level, options.id, options.kind)
  }
  const at = anchor ? boundary(structure, anchor, !anchor.section)
    : nodes[0]?.line ?? levels.length
  // A subsection ends at the next subsection, including when splitting an existing one.
  const limit = (start: number): number => {
    let end = start
    while (end < levels.length && (levels[end] === 0 || levels[end] > (level === 2 ? 2 : 3))) end++
    return end
  }
  let end = limit(at)
  // A normal slide at the prospective section's depth is part of the tail to take.
  for (let next = nodes.find(node => node.line === end); next?.level === level && !next.section;
    next = nodes.find(node => node.line === end)) end = limit(end + 1)
  return sectionEdit(structure, at, end, level, options.id, options.kind)
}

function groupBounds(structure: Structure, lines: readonly number[]) {
  const { nodes, levels } = structure
  const chosen = new Set(lines)
  const selected = nodes.filter(node => chosen.has(node.line + 1))
  if (selected.some(node => node.section)) return { error: SELECTED_SECTION } as const
  if (selected.length !== chosen.size || selected.length < 2) return { error: NONCONTIGUOUS } as const
  const first = selected[0]
  const parent = first.ancestors.at(-1)
  const siblings = nodes.filter(node => node.ancestors.at(-1) === parent)
  const start = siblings.indexOf(first)
  if (selected.some((node, i) => node.folded || node.level !== first.level || node !== siblings[start + i])) {
    return { error: NONCONTIGUOUS } as const
  }
  const end = boundary(structure, selected.at(-1)!, true)
  const kind: SectionKind = sectionAt(nodes, first) ? 'subsection' : 'section'
  const level = kind === 'section' ? 2 : first.level
  if (levels[end] > level) return { error: CAPTURES_UNSELECTED } as const
  if (nodes.some(node => node.line >= first.line && node.line < end && node.level + Math.max(0, level + 1 - first.level) > 6)) {
    return { error: TOO_DEEP } as const
  }
  return { first, end, level, kind }
}

export function groupSectionReason(structure: Structure, lines: readonly number[]): string | undefined {
  return groupBounds(structure, lines).error
}

export function groupSection(text: string, lines: readonly number[], id: string): StructureResult {
  const structure = structureOf(text)
  const group = groupBounds(structure, lines)
  return 'first' in group && group.first
    ? sectionEdit(structure, group.first.line, group.end, group.level, id, group.kind)
    : { ok: false, error: group.error ?? NONCONTIGUOUS }
}

export type DropSide = 'before' | 'after' | 'inside'

export function structureDrop(structure: Structure, line: number, side: DropSide) {
  const { nodes } = structure
  const target = nodes.find(node => node.line + 1 === line)
  if (!target) return null
  const inside = side === 'inside' && target.section
  const parent = inside ? target : nodes[target.ancestors.at(-1) ?? -1]
  const firstChild = inside ? nodes.find(node => node.ancestors.at(-1) === nodes.indexOf(target)) : undefined
  const level = inside ? firstChild?.level ?? target.level + 1 : target.level
  const at = side === 'before' ? target.line : boundary(structure, target, !inside)
  const label = parent?.title ? `In ${parent.title}` : `${side === 'before' ? 'Before' : 'After'} ${target.title || 'this slide'}`
  return { at, level, label, parent: parent?.line ?? null }
}

export function reorderStructure(text: string, lines: readonly number[], targetLine: number, side: DropSide) {
  const structure = structureOf(text)
  const { nodes, levels } = structure
  const destination = structureDrop(structure, targetLine, side)
  if (!destination || destination.level > 6 || structure.openFence || structure.openComment) return { error: UNSAFE } as const
  const chosen = new Set(lines)
  const picked = nodes.filter(node => chosen.has(node.line + 1))
  if (!picked.length || picked.length !== chosen.size) return { error: UNSAFE } as const
  const ranges: { start: number; end: number; root: Node }[] = []
  for (const root of picked) {
    if (ranges.some(range => root.line < range.end)) continue
    ranges.push({ start: root.line, end: boundary(structure, root, true), root })
  }
  const { at, level, parent } = destination
  if (ranges.some(range => (at > range.start && at < range.end) ||
    (targetLine - 1 >= range.start && targetLine - 1 < range.end))) return { error: 'Choose a place outside the selected slides.' } as const
  const changes = new Map<number, number>()
  for (const { start, end, root } of ranges) {
    if ((root.section && root.level === 2 && level !== 2) || (root.folded && parent !== nodes[root.ancestors.at(-1) ?? -1]?.line)) {
      return { error: 'Choose a place at the same level for this heading.' } as const
    }
    for (let i = start; i < end; i++) if (levels[i] >= 2) {
      const depth = levels[i] + level - root.level
      if (depth < 2 || depth > 6) return { error: TOO_DEEP } as const
      changes.set(i, depth)
    }
  }
  // Keep the original byte-bearing lines, including trailing blanks. If the
  // last line changes place in a CRLF file, swap its terminator with the new last line.
  const order = structure.lines.map((_, i) => i)
  let tail = order.length
  while (tail > 0 && !structure.lines[tail - 1].trim()) tail--
  const moved = ranges.flatMap(({ start, end }) => order.slice(start, Math.min(end, tail)))
  const moving = new Set(moved)
  const boundaryAt = Math.min(at, tail)
  const arranged = [...order.slice(0, boundaryAt).filter(i => !moving.has(i)), ...moved,
    ...order.slice(boundaryAt).filter(i => !moving.has(i))]
  const textLines = arranged.map((i, position) => {
    const original = structure.lines[i]
    const depth = changes.get(i)
    const line = depth == null ? original : '#'.repeat(depth) + original.slice(levels[i])
    const last = position + 1 === arranged.length
    if (i === order.length - 1 && !last && structure.lines[arranged.at(-1)!].endsWith('\r')) return line + '\r'
    return last && i !== order.length - 1 ? line.replace(/\r$/, '') : line
  })
  const next = textLines.join('\n')
  if (next === text) return { error: 'The slides are already there.' } as const
  const originalByLine = new Map(nodes.map(node => [node.line, node]))
  const result = readSlides(next)
  const expectedParent = (node: Node) => ranges.some(range => range.root === node) ? parent : nodes[node.ancestors.at(-1) ?? -1]?.line ?? null
  if (result.slides.length !== nodes.length || result.deckTitle !== structure.deckTitle || result.preamble !== structure.preamble ||
      result.slides.some(slide => {
        const before = originalByLine.get(arranged[slide.line])
        const owner = result.slides[slide.ancestors.at(-1) ?? -1]
        return !before || slide.id !== before.id || slide.title !== before.title || slide.attrs !== before.attrs ||
          slide.content !== before.content || slide.notes !== before.notes || slide.level !== (changes.get(before.line) ?? before.level) ||
          (owner ? arranged[owner.line] : null) !== expectedParent(before)
      })) return { error: UNSAFE } as const
  return {
    text: next, line: arranged.indexOf(ranges[0].start) + 1, label: destination.label,
    headingOrder: headingOrderFromLineOrder(text, next, arranged)
  } as const
}

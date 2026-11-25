import type { OutlineSlide, OutlineSlides } from './feedback-accept.ts'

export const LIST_LAYOUT_STRUCTURES = {
  'groups-to-headings': 'compare',
  'nested-to-table': 'table',
  'split-into-groups': 'compare',
  'add-note-lines': 'list'
} as const

export type ListLayoutStructure = keyof typeof LIST_LAYOUT_STRUCTURES
export type ListStructurePlan = { outline: string; whatChanges: string } | { reason: string }

const LIST_ROW = /^([ \t]*)([-*]|\d+[.)])[ \t]+(\S.*)$/

export function planListStructure(
  read: OutlineSlides, slide: OutlineSlide, bodyStart: number, structure: ListLayoutStructure
): ListStructurePlan {
  if (slide.level !== 3 || slide.folded || slide.opensSection || slide.container) {
    return { reason: 'Needs a stand-alone slide with a list' }
  }
  const lines = read.lines
  const groups: Array<{ name: string; children: Array<{ words: string; source: string; numbered: boolean }> }> = []
  const rows: Array<{ line: number; source: string }> = []
  let groupDepth = 0
  for (let line = bodyStart; line < slide.end; line++) {
    const source = lines[line].replace(/\r$/, '')
    if (read.notes.has(line) || !read.blanked[line]?.trim()) continue
    const match = source.match(LIST_ROW)
    if (!match || read.blanked[line].trim() !== source.trim()) return { reason: 'Needs one list without other content' }
    const [, indent, marker, words] = match
    const depth = indent.replace(/\t/g, '  ').length
    if (depth === 0) {
      groups.push({ name: words, children: [] })
      groupDepth = 0
    } else {
      const group = groups.at(-1)
      if (!group || (groupDepth && depth !== groupDepth)) return { reason: 'Needs a list with at most one level of sub-points' }
      groupDepth = depth
      group.children.push({ words, source: source.trim(), numbered: /^\d/.test(marker) })
    }
    rows.push({ line, source })
  }
  const first = rows[0]?.line
  const last = rows.at(-1)?.line
  if (first == null || last == null || rows.length !== last - first + 1) return { reason: 'Needs one uninterrupted list' }

  const flat = groups.every(group => !group.children.length)
  const headings = structure === 'groups-to-headings' || structure === 'split-into-groups'
  // A line after the list would be inside the last new group after the rewrite.
  if (headings && lines.slice(last + 1, slide.end).some(line => line.trim())) {
    return { reason: 'Needs the list at the end of the slide' }
  }

  let replacement: string[]
  let whatChanges: string
  switch (structure) {
    case 'groups-to-headings': {
      if (groups.length !== 2 || groups.some(group => !group.children.length || /[{}]|^#/.test(group.name))) {
        return { reason: 'Needs two groups with sub-points and plain heading names' }
      }
      replacement = groups.flatMap((group, index) => [
        ...(index ? [''] : []), '#### ' + group.name, '', ...group.children.map(child => child.source)
      ])
      whatChanges = `${groups[0].name} and ${groups[1].name} become headings. The title is hidden.`
      break
    }
    case 'nested-to-table': {
      const count = groups[0].children.length
      if (groups.some(group => group.children.some(child => child.numbered))) {
        return { reason: 'Needs sub-points without numbering' }
      }
      if (groups.length !== 2 || !count || groups.some(group =>
        group.children.length !== count || [group.name, ...group.children.map(child => child.words)].some(cell => /[|{}]/.test(cell)))) {
        return { reason: 'Needs two groups with equally many sub-points and no table separators or inline attributes' }
      }
      const row = (cells: string[]): string => '| ' + cells.join(' | ') + ' |'
      replacement = [row(groups.map(group => group.name)), row(groups.map(() => '---')),
        ...groups[0].children.map((_, index) => row(groups.map(group => group.children[index].words)))]
      const countLabel = ['', 'one', 'two', 'three', 'four', 'five'][count] ?? String(count)
      whatChanges = `The points pair up in ${countLabel} ${count === 1 ? 'row' : 'rows'} under ${groups[0].name} and ${groups[1].name}.`
      break
    }
    case 'split-into-groups': {
      if (!flat || groups.length < 2) return { reason: 'Needs at least two points without sub-points' }
      const split = Math.ceil(groups.length / 2)
      replacement = ['#### —', '', ...rows.slice(0, split).map(row => row.source),
        '', '#### —', '', ...rows.slice(split).map(row => row.source)]
      whatChanges = `Splits after point ${split}. You name the two sides.`
      break
    }
    case 'add-note-lines':
      if (!flat) return { reason: 'Needs points without sub-points' }
      replacement = rows.flatMap(row => [row.source, '  -  '])
      whatChanges = 'Adds an empty line under each point for you to fill in.'
      break
    default:
      return { reason: 'Unknown list structure change' }
  }

  const cr = lines[slide.start].endsWith('\r') ? '\r' : ''
  const lastCr = lines[last].endsWith('\r') ? '\r' : ''
  const ending = replacement.map((line, index) => line + (index === replacement.length - 1 ? lastCr : cr))
  return { outline: [...lines.slice(0, first), ...ending, ...lines.slice(last + 1)].join('\n'), whatChanges }
}

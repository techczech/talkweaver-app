// Plain view, ticket 04 (spec T8): the level menu's two pure halves. `levelMenuFor` says which
// levels a heading's menu offers and which is current; `setHeadingKind` rewrites the outline so the
// heading takes the chosen level, its subtree keeping its relative depths (reLevelHeadingLines).
// No DOM, no CodeMirror. Lines are 1-based, as everywhere in the margin code.
import { headingLevelOf, headingLevelRange, reLevelHeadingLines } from './heading-relevel.ts'

export type HeadingKind = 'talk' | 'section' | 'slide'

export interface LevelMenuItem {
  kind: HeadingKind
  label: string
  /** The one-line note shown under the label. */
  note: string
  current: boolean
}

export const MAX_HEADING_DEPTH = 6

const ITEMS: ReadonlyArray<{ kind: HeadingKind; label: string; note: string }> = [
  { kind: 'talk', label: 'Talk title', note: "The talk's name, shown on the first slide" },
  { kind: 'section', label: 'Section', note: 'A divider between groups of slides' },
  { kind: 'slide', label: 'Slide', note: 'One slide' }
]

/** Per line: true when it is not outline structure (frontmatter or a fenced code block). */
function structureMask(lines: readonly string[]): boolean[] {
  const masked = lines.map(() => false)
  let i = 0
  if (lines[0]?.trim() === '---') {
    i = 1
    while (i < lines.length && lines[i].trim() !== '---') i += 1
    for (let k = 0; k <= Math.min(i, lines.length - 1); k += 1) masked[k] = true
    i += 1
  }
  let fence = ''
  for (; i < lines.length; i += 1) {
    const f = lines[i].match(/^\s*(```|~~~)/)
    if (f) {
      masked[i] = true
      fence = fence === '' ? f[1] : fence === f[1] ? '' : fence
      continue
    }
    if (fence) masked[i] = true
  }
  return masked
}

function depthAt(lines: readonly string[], masked: readonly boolean[], index: number): number {
  return masked[index] ? 0 : headingLevelOf(lines[index].replace(/\r$/, ''))
}

function kindOfDepth(depth: number): HeadingKind {
  return depth <= 1 ? 'talk' : depth === 2 ? 'section' : 'slide'
}

/** The items the level menu shows for the heading on `headingLine`, or [] when that line is not a heading. */
export function levelMenuFor(outlineText: string, headingLine: number): LevelMenuItem[] {
  const lines = outlineText.split('\n')
  const masked = structureMask(lines)
  const own = depthAt(lines, masked, headingLine - 1)
  if (!own) return []
  const talkLines = lines.reduce<number[]>((acc, _l, i) => (depthAt(lines, masked, i) === 1 ? [...acc, i + 1] : acc), [])
  const offerTalk = talkLines.length === 0 || talkLines.includes(headingLine)
  const current = kindOfDepth(own)
  return ITEMS.filter((item) => item.kind !== 'talk' || offerTalk).map((item) => ({ ...item, current: item.kind === current }))
}

/** The depth a heading of `own` depth takes as a Slide: one under its nearest enclosing section, `###` at least. */
function slideDepth(lines: readonly string[], masked: readonly boolean[], index: number, own: number): number {
  let limit = own
  for (let i = index - 1; i >= 0; i -= 1) {
    const d = depthAt(lines, masked, i)
    if (d === 0 || d >= limit) continue
    limit = d
    if (d >= 2) return Math.max(3, d + 1)
    if (d === 1) break
  }
  return 3
}

/** The outline with the heading on `headingLine` made a Talk title (`#`), Section (`##`) or Slide. */
export function setHeadingKind(outlineText: string, headingLine: number, kind: HeadingKind): string {
  const lines = outlineText.split('\n')
  const masked = structureMask(lines)
  const index = headingLine - 1
  const own = depthAt(lines, masked, index)
  if (!own) return outlineText
  const target = kind === 'talk' ? 1 : kind === 'section' ? 2 : slideDepth(lines, masked, index, own)
  let end = index + 1
  while (end < lines.length) {
    const d = depthAt(lines, masked, end)
    if (d !== 0 && d <= own) break
    end += 1
  }
  const block = lines.slice(index, end)
  const blockMask = masked.slice(index, end)
  const range = headingLevelRange(block, blockMask)
  if (!range) return outlineText
  // One uniform shift keeps the relative depths; it stops where the deepest heading reaches six.
  const delta = Math.min(target - own, MAX_HEADING_DEPTH - range.max)
  if (delta === 0) return outlineText
  // reLevelHeadingLines does not match across a CR, so CRLF lines go through without it and get it back.
  const moved = reLevelHeadingLines(block.map((l) => l.replace(/\r$/, '')), delta, blockMask)
    .map((l, i) => (block[i].endsWith('\r') ? `${l}\r` : l))
  return [...lines.slice(0, index), ...moved, ...lines.slice(end)].join('\n')
}

// Which placement label an editor image line gets. The placement itself is the compiler's decision
// (compiler/scripts/lib/image-line-rules.mjs, carried on each projection row as image_placements);
// this module only finds the slide that owns a line and the image's position within it. Pure.
import { computeSlideLines } from './slide-lines.ts'
import { audienceImageLineNumbers } from '../../compiler/scripts/lib/image-line-rules.mjs'

export type PlacementKind =
  | 'full' | 'beside' | 'thumbnail' | 'row' | 'gallery' | 'image-quote' | 'statement' | 'carousel'

export interface ImagePlacement { kind: string; index: number; count: number }
export interface PlacementRow {
  source_line?: number | null
  source_markdown?: string
  role?: string
  image_placements?: ImagePlacement[]
}
export interface PlacementLabel { kind: PlacementKind; name: string }

const NAMES: Record<PlacementKind, string> = {
  full: 'Full screen',
  beside: 'Beside text',
  thumbnail: 'Thumbnail',
  row: 'In a row',
  gallery: 'In a gallery',
  'image-quote': 'Image with quote',
  statement: 'With statement',
  carousel: 'In a carousel'
}
const POSITIONAL: ReadonlySet<string> = new Set(['row', 'gallery', 'carousel'])

/** The chip text for one image, or null when the compiler named no placement for it. */
export function placementLabel(p: ImagePlacement | null | undefined): PlacementLabel | null {
  if (!p || !(p.kind in NAMES)) return null
  const kind = p.kind as PlacementKind
  const base = NAMES[kind]
  const name = POSITIONAL.has(kind) && p.count > 1 ? `${base} (${p.index} of ${p.count})` : base
  return { kind, name }
}

// The image lines of the outline as the COMPILER counts them (no videos, notes, fences or
// comments), cached for the last outline seen: every image line of one redraw asks about it.
let cached: { content: string; lines: number[] } | null = null
function compilerImageLines(content: string): number[] {
  if (cached?.content !== content) cached = { content, lines: audienceImageLineNumbers(content.split('\n')) }
  return cached.lines
}

/**
 * Placement of the image on 1-based `line` of `content`: the slide whose range holds the line
 * (its heading line up to the next slide's heading), then the image's ordinal among that slide's
 * image lines. Null when the line is not in a compiled slide or the compiler listed fewer images.
 */
export function imagePlacementForLine(
  rows: readonly PlacementRow[] | null | undefined,
  content: string,
  line: number
): ImagePlacement | null {
  if (!rows || !rows.length) return null
  const headingLines = computeSlideLines(rows, content)
  let owner = -1
  let ownerLine = 0
  headingLines.forEach((l, i) => {
    if (typeof l === 'number' && l <= line && l >= ownerLine) { owner = i; ownerLine = l }
  })
  if (owner < 0) return null
  const next = headingLines.reduce<number>(
    (m, l) => (typeof l === 'number' && l > ownerLine && l < m ? l : m), Infinity)
  const imageLines = compilerImageLines(content)
  if (!imageLines.includes(line)) return null
  const ordinal = imageLines.filter((n) => n > ownerLine && n < line && n < next).length
  return rows[owner].image_placements?.[ordinal] ?? null
}

// Adapter: TalkWeaver compile rows + the raw outline → the pure TalkText model's row shape.
// This is the ONLY place that knows compiler field names (ProjectionRow) and the outline's heading
// syntax. It reconstructs each slide's FULL heading ancestry from the outline's heading depths — the
// flat projection only carries section/subsection (two levels), but decks nest deeper, so the tree is
// rebuilt here from the markdown (a depth-stack walk keyed by each slide heading's source line). Kept
// pure (sidecars injected as a lookup) so it is unit-testable without electron. See ADR-0013 / Parcel C.

import type { TalkTextImage, TalkTextRow } from './talkText.ts'

/** The subset of a compiler ProjectionRow this adapter reads. */
export interface AdapterRow {
  slide_id: string
  title?: string
  nav_title?: string
  source_markdown?: string
  render_hash?: string
  content_hash?: string
  /** 1-based source line of the slide's heading; null for synthesized cover/closing slides. */
  source_line?: number | null
}

/** Curated image metadata from an asset sidecar (asset.readSidecar → {alt, caption, ...}). */
export interface SidecarMeta {
  alt?: string
  caption?: string
}

export interface OutlineHeading {
  line: number // 1-based
  depth: number // number of leading '#'
  rawTitle: string
}

/**
 * Heading lines in the outline, in source order, skipping fenced code blocks (``` / ~~~) so a `#`
 * comment inside a code sample is never mistaken for a heading. Trailing Trigger tokens (`{...}`) and
 * trailing `#` are stripped from the raw title; the clean title is resolved from the row later.
 */
export function parseHeadings(outline: string): OutlineHeading[] {
  const headings: OutlineHeading[] = []
  let fence: string | null = null
  const lines = outline.replace(/\r\n/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fenceMatch = line.match(/^\s*(```+|~~~+)/)
    if (fenceMatch) {
      const marker = fenceMatch[1][0]
      if (fence === null) fence = marker
      else if (fence === marker) fence = null
      continue
    }
    if (fence !== null) continue
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/)
    if (!heading) continue
    const rawTitle = heading[2].replace(/\s*\{[^}]*\}\s*$/, '').trim()
    headings.push({ line: i + 1, depth: heading[1].length, rawTitle })
  }
  return headings
}

/**
 * Each slide's ancestor heading titles (root-first), reconstructed by a depth-stack walk over the
 * outline headings. A heading at depth d pops every stack entry with depth >= d, so the current stack
 * IS that slide's ancestry; the entry is then pushed using the row's clean nav/title (falling back to
 * the raw heading text). Unbounded depth; sparse jumps in `#` level never leave gaps.
 */
export function headingPathsBySlide(outline: string, rows: AdapterRow[]): Map<string, string[]> {
  const rowByLine = new Map<number, AdapterRow>()
  for (const row of rows) {
    if (typeof row.source_line === 'number') rowByLine.set(row.source_line, row)
  }
  const lineBySlide = new Map<string, number>()
  for (const row of rows) {
    if (typeof row.source_line === 'number') lineBySlide.set(row.slide_id, row.source_line)
  }

  const stack: Array<{ depth: number; title: string }> = []
  const pathByLine = new Map<number, string[]>()
  for (const heading of parseHeadings(outline)) {
    while (stack.length && stack[stack.length - 1].depth >= heading.depth) stack.pop()
    pathByLine.set(heading.line, stack.map((entry) => entry.title))
    const row = rowByLine.get(heading.line)
    const title = (row?.nav_title || row?.title || heading.rawTitle || '').trim()
    stack.push({ depth: heading.depth, title })
  }

  const bySlide = new Map<string, string[]>()
  for (const row of rows) {
    const line = lineBySlide.get(row.slide_id)
    bySlide.set(row.slide_id, (line != null ? pathByLine.get(line) : undefined)?.filter(Boolean) ?? [])
  }
  return bySlide
}

/**
 * Asset ids referenced by a slide's markdown. Matches both standard `![alt](src)` images and bare
 * TalkWeaver asset tokens (`img-…`, `vid-…`); the id is the basename stripped of directory + extension.
 */
export function slideImageRefs(sourceMarkdown: string): Array<{ id: string; alt: string }> {
  const refs: Array<{ id: string; alt: string }> = []
  const seen = new Set<string>()
  const push = (id: string, alt: string): void => {
    const clean = id.replace(/^.*\//, '').replace(/\.[a-z0-9]+$/i, '').trim()
    if (/^(img|vid)-/.test(clean) && !seen.has(clean)) {
      seen.add(clean)
      refs.push({ id: clean, alt: alt.trim() })
    }
  }
  for (const m of sourceMarkdown.matchAll(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g)) push(m[2], m[1])
  for (const m of sourceMarkdown.matchAll(/\b((?:img|vid)-[a-zA-Z0-9]+)\b/g)) push(m[1], '')
  return refs
}

/** A slide's images with the text extracted for search (sidecar alt + caption). Sidecars injected. */
export function slideImages(sourceMarkdown: string, sidecars: Map<string, SidecarMeta>): TalkTextImage[] {
  return slideImageRefs(sourceMarkdown).map(({ id, alt }): TalkTextImage => {
    const meta = sidecars.get(id)
    const resolvedAlt = (meta?.alt || alt || '').trim()
    const ocrText = (meta?.caption || '').trim()
    const image: TalkTextImage = { src: id }
    if (resolvedAlt) image.alt = resolvedAlt
    if (ocrText) image.ocrText = ocrText
    return image
  })
}

/**
 * The full row→TalkTextRow mapping: clean title, reconstructed unbounded headingPath, authored
 * markdown, and images joined to their sidecar search text. `sidecars` is pre-fetched by the IPC layer
 * so this stays pure.
 */
export function toTalkTextRows(
  outline: string,
  rows: AdapterRow[],
  sidecars: Map<string, SidecarMeta> = new Map()
): TalkTextRow[] {
  const paths = headingPathsBySlide(outline, rows)
  return rows.map((row): TalkTextRow => {
    const markdown = (row.source_markdown ?? '').trim()
    return {
      slideId: row.slide_id,
      title: (row.title ?? '').trim() || row.slide_id,
      navTitle: (row.nav_title ?? '').trim() || undefined,
      thumbKey: (row.render_hash || row.content_hash) || undefined,
      headingPath: paths.get(row.slide_id) ?? [],
      markdown,
      images: markdown ? slideImages(markdown, sidecars) : []
    }
  })
}

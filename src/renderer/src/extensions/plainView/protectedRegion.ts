// Plain view, ticket 07 (fifth fix round): what "protected text" is, in one shape for every owner.
//
// A protected region is a stretch of the document that Plain hides WHEN THE CARET IS ELSEWHERE: a
// heading's trailing `{…}` groups, the layout lines under a heading, the front matter under the
// Talk details panel, the icon token that ends a paragraph or a list item. Each owner reads its
// regions from the document's structure alone, with one pure function that takes no selection
// (hiddenLines.protectedRegions, iconPictures.iconProtectedRegions,
// talkDetails.talkDetailsProtectedRegions). What is DRAWN (hidden, or shown as text or a chip
// because the caret is on it) is a matter of display and never changes what is protected: the
// decorations, the settling filters and the key guard all read the same regions.
//
// The caret's own place is the one thing that is let in, and it is read here, not from the
// decorations: a caret that is already inside a part that may be edited by hand (an icon token it
// stepped into, a layout line it is on) may change that part's own characters.

export interface ProtectedPart {
  from: number
  /** The end of the part; a caret at `to` is still on it. */
  to: number
  /** The part as text, told apart by kind ("group {reveal}", "line {statement}", "icon {icon=…}"). */
  text: string
  /** A caret inside the part edits it by hand (an icon token's chip, a layout line the caret is on). */
  walk: boolean
}

export interface ProtectedRegion {
  kind: 'tail' | 'run' | 'frontmatter' | 'icon'
  /** The start of the line that owns it: tells one region from another across a change. */
  anchor: number
  /** The characters a single key must not delete or replace, as [from, to). */
  from: number
  to: number
  /** Where the caret must not arrive, both ends included. */
  zoneFrom: number
  zoneTo: number
  /** Where a caret that lands in the zone is put instead. */
  rest: number
  /**
   * The owner's filter moves the caret out of the zone after a change to the document as well, so
   * a key that would leave it there need not be held (a heading's tail, the front matter).
   */
  settles: boolean
  parts: readonly ProtectedPart[]
}

export function inZone(region: ProtectedRegion, pos: number): boolean {
  return pos >= region.zoneFrom && pos <= region.zoneTo
}

/** The part of `region` a caret at `caret` is editing by hand, if any. */
export function walkedPart(region: ProtectedRegion, caret: number): ProtectedPart | null {
  if (caret < 0 || !inZone(region, caret)) return null
  return region.parts.find((p) => p.walk && caret >= p.from && caret <= p.to) ?? null
}

/** The spans a single key must not reach into, as [from, to), for one empty caret (-1: none). */
export function guardSpansOf(regions: readonly ProtectedRegion[], caret: number): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = []
  for (const r of regions) {
    const part = walkedPart(r, caret)
    if (part) out.push({ from: r.from, to: part.from }, { from: part.to, to: r.to })
    else out.push({ from: r.from, to: r.to })
  }
  return out.filter((span) => span.to > span.from)
}

/** Every protected part as text, the one the caret is editing left out. */
export function inventoryOf(regions: readonly ProtectedRegion[], caret: number): string[] {
  const out: string[] = []
  for (const r of regions) {
    const part = walkedPart(r, caret)
    for (const p of r.parts) if (p !== part) out.push(p.text)
  }
  return out
}

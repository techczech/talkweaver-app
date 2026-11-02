// Slide Scratchpad ticket 2, the pure parts of inserting (no I/O): which visuals a picked slide's snapshot holds,
// and where in the talk an insert goes. The renderer runs the text operation inside the one-writer seam
// (lib/outlineMutation apply), so an insert is one change to the editor's buffer, saved through the file's queue.
// Spec: docs/design/2026-10-27-slide-scratchpad/slide-scratchpad-spec.md § Tickets 2.
//
// Placement. A place is "at the start" (before the first slide) or "after slide N", named by its heading line
// (1-based) and its title, so a place chosen a while ago is found again after the text moved (the line first,
// then the nearest heading with the same title). "After" follows the rule Insert › Old slide uses
// (shared/old-slide.ts insertSlideAfterCaret): the new slide is the slide's sibling, after its text, its notes
// and every slide under it; a top-level section heading in a talk with slides under its sections takes the new
// slide as its first slide instead. Unlike that rule, the slide may carry an `{id=…}` (a picked slide keeps
// its provenance, ADR-0032) and headings under its own are moved by the same number of levels. The result is
// checked: every heading outside the new lines keeps its level, the block opens no code fence or comment, and
// no existing slide ends up under the new one.

import { readOutline } from './insert-section.ts'

// ── Visuals in a picked slide's snapshot ──────────────────────────────────────────────────────────

/** pic: a picture (pool id, file or address); svg: an SVG file or an ```svg drawing; page: an `[Embed: …]` page. */
export type ScratchVisualKind = 'pic' | 'svg' | 'page'

export interface ScratchVisual {
  kind: ScratchVisualKind
  /** What the snapshot names: the image target or the embed source ('' for an ```svg drawing). */
  ref: string
  /** A short name for the chooser: the alt text, else the file name, else the address. */
  label: string
  /** The markdown that shows it, exactly as in the snapshot (an image, an `[Embed: …]` line or a whole fence). */
  markdown: string
  /** A file named by a path (relative to the source talk, or absolute), which has to be copied into this talk. */
  local: boolean
}

const IMAGE_RE = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g
const EMBED_RE = /^\[Embed:\s*(.+?)\]$/i
const POOL_RE = /^(?:img-(?:img-)?[0-9a-f]{7}|vid-[0-9a-f]{7})$/i
const VIDEO_RE = /\.(?:mp4|mov|m4v|webm)(?:[?#].*)?$/i
const ADDRESS_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i
const FENCE_RE = /^\s*(`{3,}|~{3,})\s*([\w-]*)/

const lastPart = (ref: string): string => {
  const clean = ref.split(/[?#]/)[0].replace(/\/+$/, '')
  const at = clean.lastIndexOf('/')
  let name = at >= 0 ? clean.slice(at + 1) : clean
  try { name = decodeURIComponent(name) } catch { /* keep as written */ }
  return name
}

/** The pictures, SVGs and pages a slide snapshot shows, in order, each once. Videos are not visuals here. */
export function scratchVisuals(markdown: string): ScratchVisual[] {
  const out: ScratchVisual[] = []
  const add = (visual: ScratchVisual): void => { if (!out.some((v) => v.markdown === visual.markdown)) out.push(visual) }
  const lines = String(markdown ?? '').split('\n')
  let fence: { mark: string; svg: boolean; start: number } | null = null
  lines.forEach((line, index) => {
    const open = FENCE_RE.exec(line)
    if (fence) {
      if (open && open[1][0] === fence.mark[0] && open[1].length >= fence.mark.length && line.trim() === open[1]) {
        if (fence.svg) add({ kind: 'svg', ref: '', label: 'SVG drawing', markdown: lines.slice(fence.start, index + 1).join('\n'), local: false })
        fence = null
      }
      return
    }
    if (open) { fence = { mark: open[1], svg: open[2].toLowerCase() === 'svg', start: index }; return }
    const embed = EMBED_RE.exec(line.trim())
    if (embed) {
      const ref = embed[1].trim()
      add({ kind: 'page', ref, label: lastPart(ref) || ref, markdown: line.trim(), local: !ADDRESS_RE.test(ref) })
      return
    }
    for (const m of line.matchAll(IMAGE_RE)) {
      const ref = m[2]
      if (/^vid-/i.test(ref) || VIDEO_RE.test(ref)) continue
      const pooled = POOL_RE.test(ref)
      const svg = !pooled && /\.svg(?:[?#].*)?$/i.test(ref)
      add({ kind: svg ? 'svg' : 'pic', ref, label: m[1].trim() || lastPart(ref) || ref, markdown: m[0], local: !pooled && !ADDRESS_RE.test(ref) })
    }
  })
  return out
}

/** Does this visual's file have to be copied by the main process (an SVG file or a page named by a path)?
 *  Pictures go through the slide insert's own media path instead (cross-vault copy or the vault pool). */
export function visualNeedsCopy(visual: ScratchVisual): boolean {
  return visual.local && (visual.kind === 'svg' || visual.kind === 'page') && visual.ref !== ''
}
// ── Places in the talk: src/shared/slide-handling/place.ts (the one placement rule; re-exported here) ──────────

export {
  headingTitle, insertionPoint, placeForLine, placeRows, resolvePlace, settlePlace, PLACE_GONE
} from './slide-handling/place.ts'
export type { InsertionPoint, PlaceRow, ScratchPlace } from './slide-handling/place.ts'
import { insertionPoint, headingTitle, UNSAFE_PLACE as UNSAFE, type ScratchPlace, type SlidePlace } from './slide-handling/place.ts'


export type PlacedSlide =
  | { ok: true; text: string; from: number; to: number; level: number; /** 1-based heading line of the new slide. */ line: number }
  | { ok: false; error: string }

const NOT_A_SLIDE = 'What would be inserted does not start with a slide heading. Nothing was inserted.'
const WOULD_CHANGE = 'Inserting it there would change other slides of the talk, so nothing was inserted. Choose another place.'

/** `block` (a slide: a `##`–`######` heading and what follows) put in as a new slide at `place`, its headings
 *  moved to the place's level. Refused, with the reason, when it would change any other slide. */
export function insertSlideAt(text: string, place: SlidePlace, block: string): PlacedSlide {
  const blockLines = block.replace(/\r\n?/g, '\n').split('\n')
  while (blockLines.length && /^\s*$/.test(blockLines[0])) blockLines.shift()
  while (blockLines.length && /^\s*$/.test(blockLines[blockLines.length - 1])) blockLines.pop()
  if (blockLines.length === 0 || !/^#{2,6}\s/.test(blockLines[0])) return { ok: false, error: NOT_A_SLIDE }
  const own = readOutline(blockLines.join('\n'))
  if (own.openFence || own.openComment) return { ok: false, error: UNSAFE }
  const point = insertionPoint(text, place)
  if (!point.ok) return point
  const shift = point.level - (/^(#+)/.exec(blockLines[0]) as RegExpExecArray)[1].length
  const moved = blockLines.map((line, i) => {
    if (own.levels[i] < 2) return line
    const next = Math.max(2, Math.min(6, own.levels[i] + shift))
    return line.replace(/^#+/, '#'.repeat(next))
  })
  const lines = text.split('\n')
  const before = lines.slice(0, point.at).join('\n')
  const after = lines.slice(point.at).join('\n')
  // One blank line on each side of the new slide; a blank line already there is used, never removed.
  const lead = before.length === 0 ? '' : /(^|\n)[ \t]*$/.test(before) ? `${before}\n` : `${before}\n\n`
  const body = moved.join('\n')
  const tail = after.length === 0 ? '\n' : after.startsWith('\n') ? `\n${after}` : `\n\n${after}`
  const out = lead + body + tail
  const from = lead.length
  const first = out.slice(0, from).split('\n').length - 1
  if (!placedAlone(text, out, first, moved.length, point.level)) return { ok: false, error: WOULD_CHANGE }
  return { ok: true, text: out, from, to: from + body.length, level: point.level, line: first + 1 }
}

/** The check on a placed slide: the talk reads as before plus these `count` lines from `first`, which open with
 *  one heading at `level` and hold only deeper ones; the next heading after them is not deeper than `level`. */
function placedAlone(before: string, after: string, first: number, count: number, level: number): boolean {
  const was = readOutline(before)
  const now = readOutline(after)
  if (now.openFence || now.openComment) return false
  if (now.levels[first] !== level) return false
  for (let i = first + 1; i < first + count; i += 1) if (now.levels[i] !== 0 && now.levels[i] <= level) return false
  const outside = [...now.levels.slice(0, first), ...now.levels.slice(first + count)].filter((l) => l !== 0)
  const old = was.levels.filter((l) => l !== 0)
  if (outside.length !== old.length || outside.some((l, i) => l !== old[i])) return false
  const next = now.levels.slice(first + count).find((l) => l !== 0)
  return next === undefined || next <= level
}

/** Is the caret (a character offset) inside a slide's body: on a line of a slide's own text, not its heading, not
 *  above the first slide, not inside a code fence, a comment or the slide's speaker notes? Only there does
 *  Insert visual only put the visual at the caret. */
export function caretInSlideBody(text: string, caret: number): boolean {
  if (!Number.isInteger(caret) || caret < 0 || caret > text.length) return false
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1
  const lineIndex = text.slice(0, lineStart).split('\n').length - 1
  const { levels, bodyStart } = readOutline(text)
  if (lineIndex < bodyStart || levels[lineIndex] !== 0) return false
  let owner = -1
  for (let i = lineIndex - 1; i >= bodyStart; i -= 1) { if (levels[i] !== 0) { owner = i; break } }
  if (owner < 0 || levels[owner] < 2) return false
  // Not inside a fence or comment, and not on a line that opens one: the text up to the line, up to the caret and up
  // to the end of the caret's line must each leave nothing open (a caret at the end of ```js or <!-- would put the
  // visual inside the block).
  const lineEnd = text.indexOf('\n', caret)
  for (const cut of [lineStart, caret, lineEnd < 0 ? text.length : lineEnd]) {
    const upTo = readOutline(text.slice(0, cut))
    if (upTo.openFence || upTo.openComment) return false
  }
  const lines = text.split('\n')
  let notes = false
  for (let i = owner + 1; i < lineIndex; i += 1) {
    if (/^\s*:::\s*notes\b/i.test(lines[i])) notes = true
    else if (notes && /^\s*:::\s*$/.test(lines[i])) notes = false
  }
  return !notes && !/^\s*:::/.test(lines[lineIndex])
}

/** The new slide that holds only a visual: its title as a heading, then the visual. */
export function visualSlide(title: string, visualMarkdown: string): string {
  const clean = String(title ?? '').replace(/\s+/g, ' ').replace(/[{}]/g, '').trim() || 'Visual'
  return `### ${clean}\n\n${visualMarkdown.trim()}`
}

const ID_TOKEN = /\{id=([A-Za-z0-9_-]+)\}/g

/** A slide id in the ledger's form (compiler/scripts/lib/13-slide-ledger.mjs mintId, as the cross-vault insert
 *  re-stamps with): five base-36 characters, none of `taken`. */
export function mintSlideId(taken: ReadonlySet<string>, rng: () => number = Math.random): string {
  for (;;) {
    const id = rng().toString(36).slice(2, 7)
    if (id.length === 5 && !taken.has(id)) return id
  }
}

/** `block` with every `{id=…}` the talk already uses given a fresh id (the same slide picked from this vault and
 *  inserted again would otherwise carry its id twice). Ids the talk does not use are kept: a reused slide keeps its
 *  provenance (ADR-0032). */
export function restampTakenIds(block: string, talkText: string, rng: () => number = Math.random): string {
  const used = new Set([...talkText.matchAll(ID_TOKEN)].map((m) => m[1]))
  const inBlock = [...block.matchAll(ID_TOKEN)].map((m) => m[1])
  if (!inBlock.some((id) => used.has(id))) return block
  const taken = new Set([...used, ...inBlock])
  const fresh = new Map<string, string>()
  return block.replace(ID_TOKEN, (whole, id: string) => {
    if (!used.has(id)) return whole
    let next = fresh.get(id)
    if (!next) { next = mintSlideId(taken, rng); taken.add(next); fresh.set(id, next) }
    return `{id=${next}}`
  })
}


/** Plan the entire selection without writing. Each block uses the existing placement proof.
 * Place in reverse at the same anchor so a section keeps its children and the next card
 * remains its sibling. IDs are reserved in displayed order before any placement. */
export function planScratchSlides(text: string, place: SlidePlace, blocks: readonly string[]):
  { ok: true; text: string; lines: number[]; selectionLines: number[]; lastPlace: ScratchPlace } | { ok: false; error: string } {
  if (!blocks.length || blocks.length > 5000) return { ok: false, error: 'Choose slides to insert.' }
  let reserved = text
  const ready = blocks.map(block => {
    const next = restampTakenIds(block, reserved)
    reserved += '\n' + next
    return next
  })
  for (const block of ready) {
    const source = block.replace(/\r\n?/g, '\n').split('\n')
    const parsed = readOutline(source.join('\n')); const ids: string[] = []
    source.forEach((line, index) => {
      if (parsed.levels[index] < 2) return
      const metadata = /^\s*\{[^}]+\}\s*$/.test(source[index + 1] ?? '') ? source[index + 1] : ''
      ids.push(...[...`${line}\n${metadata}`.matchAll(ID_TOKEN)].map(match => match[1]))
    })
    if (new Set(ids).size !== ids.length) return { ok: false, error: 'A selected snapshot contains duplicate slide identifiers. Nothing was inserted.' }
  }
  let current = text
  let lines: number[] = []
  for (let i = ready.length - 1; i >= 0; i--) {
    const result = insertSlideAt(current, place, ready[i])
    if (!result.ok) return result
    const delta = result.text.split('\n').length - current.split('\n').length
    lines = [result.line, ...lines.map(line => line + delta)]
    current = result.text
  }
  const lastRoot = lines[lines.length - 1] - 1
  const count = ready[ready.length - 1].trim().split('\n').length
  const parsed = readOutline(current)
  let last = lastRoot
  for (let i = lastRoot; i < lastRoot + count; i++) if (parsed.levels[i] >= 2) last = i
  return { ok: true, text: current, lines, selectionLines: parsed.levels.flatMap((level, index) => index >= lines[0] - 1 && index <= last && level >= 2 ? [index + 1] : []), lastPlace: { kind: 'after', line: last + 1, title: headingTitle(current.split('\n')[last]) } }
}

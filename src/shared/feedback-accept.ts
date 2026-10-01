// Accept (shared-talk ticket 06): the pure text operations behind the Feedback rail's Accept, Use
// theirs, the changed-since flag and Undo. Text in, text out, no I/O; the renderer runs them inside the
// one-writer seam (lib/outlineMutation apply), so an accept is one minimal change to the editor's
// buffer, saved through the file's queue and its external-change guard, never a file rewrite.
//
//   readOutlineSlides(text)                 every slide of the outline: id, heading line, block, and
//                                           its visible text exactly as the share push computes it
//                                           (main/shared-talk-build slideTextsByLine).
//   applyProposal(text, item, base)         the outline with their proposal applied, the changed-since
//                                           verdict, and where it landed.
//   spliceEdit(before, after) / undoEdit     the minimal splice an accept made, and its reversal.
//
// What a slide's text is: the pushed text is the heading, its Trigger line and its content lines,
// with speaker notes (`:::notes` … `:::`) and HTML comments removed. So a `replace` is a line merge,
// not a block swap: their lines are matched against the block's visible lines (LCS); matched lines keep
// his bytes (an inline comment survives), unmatched lines of his go, theirs come in where his went, and
// every notes line and comment-only line stays where it was. The block's `{id=…}` always survives: if
// their text dropped or changed it, it is put back on the Trigger line.
//
// Slides are found by their `{id=…}` (the compiled slide id); `base.line` (the compile's heading line)
// is the fallback for a slide the save has not stamped yet.
//
// Insert: after the named slide's own block (before the next heading, whatever its depth), at the
// depth that keeps every other slide's parent: the named slide's depth, or its first child's when it
// has children (the new slide then comes first among them). Their headings are re-levelled uniformly.
// With a section: a grouping heading at that depth and their slide one deeper as its first child, in
// Insert section's shape (heading, blank line, the slide re-levelled with the depth inside kept, a
// blank line each side). Unlike Insert section, whose placement goes to the end of the caret's
// section, it goes where they put it: right after the named slide. `{id=…}` tokens in their text are
// dropped: the save mints fresh ids (ADR-0032).
//
// Every result is checked: outside the lines it changed, the talk's headings must read exactly as
// before (their text cannot open a code fence or comment that swallows the rest of the talk).

import { parseOutlineTree, type OutlineTreeNode } from '../../compiler/scripts/lib/14-outline-tree.mjs'
import { parseTriggerLine } from '../../compiler/scripts/lib/02-triggers-layout.mjs'
import { outlineCompilerBody, slideVisibleText } from './slide-source-text.ts'
import { readOutline } from './insert-section.ts'
import { reLevelHeadingLines } from './heading-relevel.ts'
import type { FeedbackKind } from './feedback.ts'

/** One slide of an outline as the compiler reads it. */
export interface OutlineSlide {
  /** Its `{id=…}` ('' when the save has not stamped it yet). */
  id: string
  /** 1-based heading line. */
  line: number
  level: number
  /** 0-based line range of its own block: the heading through the line before the next heading
   *  (any depth, a `#` title line included) or the end of the text. Trailing blank lines included. */
  start: number
  end: number
  /** Exclusive end of everything the slide is: its own block plus, for a container the compiler folds
   *  (cards, carousel, columns, compare, contrast, image grid), every descendant heading's block. */
  blockEnd: number
  /** It folds its child headings into itself (they are not slides of their own). */
  container: boolean
  /** Folded into a container above it: not a slide of its own. */
  folded: boolean
  /** It has child slides of its own (it opens a section, or is a section divider). */
  opensSection: boolean
  /** The visible text, exactly as the share push computes it. */
  text: string
}

export interface OutlineSlides {
  slides: OutlineSlide[]
  /** text.split('\n') */
  lines: string[]
  /** The lines as the compiler reads them: frontmatter and comments blanked. */
  blanked: string[]
  /** 0-based indexes of speaker-notes lines (the markers included). */
  notes: Set<number>
}

/** What of an item Accept needs. */
export interface ProposalItem {
  kind: FeedbackKind
  slideId?: string
  afterSlideId?: string
  text?: string
  section?: string
}

export interface ProposalBase {
  /** The slide's visible text at the item's base revision; null when that revision is not kept. */
  text: string | null
  /** The compile's 1-based heading line of the item's slide (for insert: the named slide), used only
   *  when no block carries its `{id=…}`. */
  line?: number | null
  /** The splice an earlier Accept of this same item made that is not recorded as accepted (its save
   *  was refused, then kept). The only thing that links a block already in the outline to the item:
   *  equal text alone never does (it may be his own slide). */
  remembered?: AcceptedEdit | null
}

/** Recorded instead of a splice when Accept found the slide already saying what they wrote: accepted,
 *  nothing changed, no Undo. */
export const ALREADY = 'already' as const

/** What an accepted status records: the splice Accept made (Undo reverses it), or ALREADY. */
export type AcceptRecord = AcceptedEdit | typeof ALREADY

/** The minimal splice an accept made (what Undo reverses). Offsets are in the text after the accept. */
export interface AcceptedEdit {
  from: number
  removed: string
  inserted: string
  /** 1-based line of the slide it touched, in the text after the accept (the rail's "line 13"). */
  line: number
  /** Up to 80 characters either side of the splice, to find it again after later edits. */
  before: string
  after: string
}

export type ApplyProposalResult =
  | {
      ok: true
      text: string
      /** replace/delete: the slide's text now differs from the text at the base revision (null when
       *  the base text is not kept, so it cannot be told). Always false for insert. */
      changedSince: boolean | null
      edit: AcceptedEdit
      /** 1-based line of the slide touched (the new slide's heading for insert), in the new text. */
      line: number
      /** insert: the last non-blank line of the old text before the new block (the rail's "after line 19"). */
      afterLine: number | null
      /** The outline already holds their proposal: `text` is unchanged. For an insert this is only ever
       *  the block an earlier Accept of this item put there (`base.remembered`), and `edit` removes it.
       *  For a replace, `edit` is the remembered splice when it is still there, else an empty splice
       *  (removed === inserted): the slide already says what they wrote, and there is nothing to undo. */
      already?: boolean
    }
  | { ok: false; code: 'not-found' | 'refused' | 'note'; error: string }

const TRIGGER_LINE_RE = /^\s*\{[^}]*\}(\s*\{[^}]*\})*\s*$/
const ID_TOKEN_RE = /\{id=([A-Za-z0-9_-]+)\}/g
const isBlank = (line: string): boolean => /^\s*$/.test(line)

/** The talk's frontmatter `triggers:` defaults (the compiler's deckTriggerDefaults, layout and id
 *  ignored as it ignores them). */
function deckTriggerDefaults(text: string): Record<string, unknown> {
  const fm = text.startsWith('---') ? text.slice(3, Math.max(3, text.indexOf('\n---', 3))) : ''
  const raw = fm.match(/^triggers:[ \t]*(.+)$/m)?.[1]?.replace(/^["']|["']$/g, '').replace(/[{}]/g, ' ').trim()
  if (!raw) return {}
  const attrs = { ...(parseTriggerLine(`{${raw}}`)?.attrs ?? {}) }
  delete attrs.layout
  delete attrs.id
  return attrs
}

/** A node's attributes as the compiler resolves them for folding (08-source-adapters
 *  resolvedNodeAttrs): the deck defaults, the heading and Trigger line, and any stray Trigger-shaped
 *  line in its content outside code fences. */
function resolvedAttrs(node: OutlineTreeNode, defaults: Record<string, unknown>): Record<string, unknown> {
  const attrs: Record<string, unknown> = { ...defaults, ...(node.attrs || {}) }
  let fence = ''
  for (const line of node.contentLines || []) {
    const t = String(line).trim()
    if (fence) { const close = t.match(/^(`{3,})\s*$/); if (close && close[1].length >= fence.length) fence = ''; continue }
    const open = t.match(/^(`{3,})/)
    if (open) { fence = open[1]; continue }
    const stray = parseTriggerLine(line)
    if (stray) Object.assign(attrs, stray.attrs)
  }
  return attrs
}

/** Does the compiler fold this node's children into it (08-source-adapters foldChildLayoutNodes)? */
function foldsChildren(node: OutlineTreeNode, defaults: Record<string, unknown>): boolean {
  const n = node.children.length
  if (!n) return false
  const a = resolvedAttrs(node, defaults)
  if (a.carousel === true) return true
  if (a.cards === 'grid' || a.cards === 'rows') return true
  if (a.layout === 'image-grid') return true
  if (a.layout === 'contrast' && n >= 2 && n <= 3) return true
  if ((a.layout === 'columns' || (a.cols != null && a.cols !== true)) && n >= 2) return true
  if (a.layout === 'compare' && n >= 2) return true
  return false
}

export function readOutlineSlides(text: string): OutlineSlides {
  const src = String(text ?? '')
  const lines = src.split('\n')
  const { body } = outlineCompilerBody(src)
  const blanked = body.split('\n')
  const tree = parseOutlineTree(body) as ReturnType<typeof parseOutlineTree> & { notesLineIndexes?: number[] }
  const { levels } = readOutline(src)
  const defaults = deckTriggerDefaults(src)
  const slides: OutlineSlide[] = []
  /** Returns the exclusive end line of the node's whole subtree. */
  const visit = (node: OutlineTreeNode, folded: boolean): number => {
    let subtreeEnd = node.level >= 2 ? node.sourceLine : 0
    let own: OutlineSlide | null = null
    const container = node.level >= 2 && !folded && foldsChildren(node, defaults)
    if (node.level >= 2) {
      const start = node.sourceLine - 1
      let end = start + 1
      while (end < lines.length && !levels[end]) end += 1
      own = { id: node.id || '', line: node.sourceLine, level: node.level, start, end, blockEnd: end, container, folded, opensSection: false, text: slideVisibleText(node) }
      slides.push(own)
      subtreeEnd = end
    }
    for (const child of node.children) subtreeEnd = Math.max(subtreeEnd, visit(child, folded || container))
    if (own) {
      if (container) own.blockEnd = subtreeEnd
      own.opensSection = !container && !folded && node.children.length > 0
    }
    return subtreeEnd
  }
  visit(tree.root, false)
  slides.sort((a, b) => a.start - b.start)
  return { slides, lines, blanked, notes: new Set(tree.notesLineIndexes ?? []) }
}

/** The slide an item names: by `{id=…}` (the first, as the compiler keeps the first of a collision),
 *  else the compile's heading line. */
export function findSlide(read: OutlineSlides, slideId: string | undefined, line?: number | null): OutlineSlide | null {
  if (!slideId) return null
  const byId = read.slides.find((slide) => slide.id === slideId)
  if (byId) return byId
  if (Number.isInteger(line)) return read.slides.find((slide) => slide.line === line && !slide.id) ?? null
  return null
}

/** The slide's visible text now, or null when it is not in the outline. */
export function currentSlideText(text: string, slideId: string | undefined, line?: number | null): string | null {
  return findSlide(readOutlineSlides(text), slideId, line)?.text ?? null
}

/** replace/delete: has the slide changed since the base revision? null when it cannot be told (no base
 *  text kept, or the slide is not in the outline). */
export function changedSince(read: OutlineSlides, item: ProposalItem, base: ProposalBase): boolean | null {
  if (item.kind !== 'replace' && item.kind !== 'delete') return false
  const slide = findSlide(read, item.slideId, base.line)
  if (!slide || base.text == null) return null
  return slide.text !== base.text.replace(/\r\n?/g, '\n')
}

// ── Splices ──────────────────────────────────────────────────────────────────────────────────────

/** The splice from `before` to `after` in whole lines: common leading and trailing lines dropped, so
 *  what it removes and inserts are complete lines (an earlier Accept's block reads as that block). */
export function spliceEdit(before: string, after: string, line: number): AcceptedEdit {
  let p = 0
  const max = Math.min(before.length, after.length)
  while (p < max && before[p] === after[p]) p += 1
  if (!(p === before.length && p === after.length)) while (p > 0 && before[p - 1] !== '\n') p -= 1
  let s = 0
  while (s < max - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s += 1
  const atLineStart = (t: string, k: number): boolean => k === 0 || t[k - 1] === '\n'
  while (s > 0 && !(atLineStart(before, before.length - s) && atLineStart(after, after.length - s))) s -= 1
  const inserted = after.slice(p, after.length - s)
  return {
    from: p,
    removed: before.slice(p, before.length - s),
    inserted,
    line,
    before: after.slice(Math.max(0, p - 80), p),
    after: after.slice(p + inserted.length, p + inserted.length + 80),
  }
}

/** Every index of `needle` in `hay`. */
function indexesOf(hay: string, needle: string): number[] {
  const out: number[] = []
  if (!needle) return out
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i)
  return out
}

/** Undo an accept: `edit.inserted` back to `edit.removed`, where it is now. Found at its offset, else
 *  by its surrounding text (once only); refused when it cannot be found unambiguously. */
export function undoEdit(text: string, edit: AcceptedEdit): { ok: true; text: string } | { ok: false; error: string } {
  const splice = (at: number): string => text.slice(0, at) + edit.removed + text.slice(at + edit.inserted.length)
  const fits = (at: number): boolean =>
    at >= 0 && text.slice(at, at + edit.inserted.length) === edit.inserted &&
    text.slice(Math.max(0, at - edit.before.length), at) === edit.before &&
    text.slice(at + edit.inserted.length, at + edit.inserted.length + edit.after.length) === edit.after
  if (fits(edit.from)) return { ok: true, text: splice(edit.from) }
  const found = indexesOf(text, edit.before + edit.inserted + edit.after).map((i) => i + edit.before.length)
  if (found.length === 1) return { ok: true, text: splice(found[0]) }
  if (edit.inserted && edit.inserted.length >= 12) {
    const loose = indexesOf(text, edit.inserted)
    if (loose.length === 1) return { ok: true, text: splice(loose[0]) }
  }
  return { ok: false, error: 'The accepted text has been edited since, so Undo cannot put it back safely. Nothing was changed; edit the slide by hand, or use ⌘Z in the editor.' }
}

// ── Their text ─────────────────────────────────────────────────────────────────────────────────────

/** Their lines: line endings normalised, trailing space dropped, runs of blank lines as one, no
 *  leading or trailing blank lines. */
function herLines(text: string | undefined): string[] {
  const out: string[] = []
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.replace(/[ \t]+$/, '')
    if (isBlank(line) && (out.length === 0 || isBlank(out[out.length - 1]))) continue
    out.push(line)
  }
  while (out.length && isBlank(out[out.length - 1])) out.pop()
  return out
}

/** Drop `{id=…}` tokens (all, or all but `keep`) from their lines; a Trigger line left empty goes. */
function dropIds(lines: string[], keep?: string): string[] {
  const out: string[] = []
  for (const line of lines) {
    if (!line.includes('{id=')) { out.push(line); continue }
    const next = line.replace(ID_TOKEN_RE, (m, id) => (id === keep ? m : '')).replace(/\{\s*\}/g, '').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/, '')
    if (next.trim() === '' && line.trim() !== '') continue
    out.push(next)
  }
  return out
}

// ── Replace: the line merge ──────────────────────────────────────────────────────────────────────

type Unit = { item: number | null; lines: number[] }
type Op = { t: 'keep'; i: number; j: number } | { t: 'del'; i: number } | { t: 'add'; j: number }

/** LCS alignment of `a` onto `b`, changes grouped deletions first. */
function align(a: string[], b: string[]): Op[] {
  const cols = b.length + 1
  const table = new Uint32Array((a.length + 1) * cols)
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = a[i] === b[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1])
    }
  }
  const ops: Op[] = []
  let dels: Op[] = []
  let adds: Op[] = []
  const flush = (): void => { ops.push(...dels, ...adds); dels = []; adds = [] }
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { flush(); ops.push({ t: 'keep', i, j }); i += 1; j += 1 }
    else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) { dels.push({ t: 'del', i }); i += 1 }
    else { adds.push({ t: 'add', j }); j += 1 }
  }
  while (i < a.length) { dels.push({ t: 'del', i }); i += 1 }
  while (j < b.length) { adds.push({ t: 'add', j }); j += 1 }
  flush()
  return ops
}

/** For each line of `now`: true when it is not one of `base`'s lines kept in place (LCS), i.e. it
 *  changed or was added since. Compare highlights these in "Yours now". */
export function linesChangedSince(base: string, now: string): boolean[] {
  const split = (t: string): string[] => String(t ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''))
  const b = split(now)
  const marks = b.map(() => true)
  for (const op of align(split(base), b)) if (op.t === 'keep') marks[op.j] = false
  return marks
}

/** The block's visible lines replaced by theirs; notes and comment-only lines kept in place. Returns
 *  the block's new lines (its trailing blank and hidden lines untouched). */
function mergeBlock(read: OutlineSlides, slide: OutlineSlide, theirs: string[], eol: string): string[] {
  const { lines, blanked, notes } = read
  // Each line of the block: visible (keyed by what the push shows), blank, or hidden (a notes line,
  // or a line the comment blanking emptied). The push shows a comment-only line as a blank line.
  type Kind = 'visible' | 'blank' | 'hidden'
  const kindOf = (i: number): Kind => {
    if (notes.has(i)) return 'hidden'
    if (isBlank(lines[i])) return 'blank'
    return isBlank(blanked[i] ?? '') ? 'hidden' : 'visible'
  }
  let lastVisible = slide.start
  for (let i = slide.start; i < slide.end; i += 1) if (kindOf(i) === 'visible') lastVisible = i
  // Units: a visible line is one item; a run of non-visible lines is one "gap" item when the push
  // shows it as a blank line (it holds a blank or a comment-only line), else a hidden-only unit.
  const units: Unit[] = []
  const keys: string[] = []
  for (let i = slide.start; i <= lastVisible;) {
    if (kindOf(i) === 'visible') {
      units.push({ item: keys.length, lines: [i] })
      keys.push(blanked[i].replace(/[ \t\r]+$/, ''))
      i += 1
      continue
    }
    const run: number[] = []
    while (i <= lastVisible && kindOf(i) !== 'visible') { run.push(i); i += 1 }
    const showsBlank = run.some((k) => !notes.has(k))
    if (showsBlank) { units.push({ item: keys.length, lines: run }); keys.push('') }
    else units.push({ item: null, lines: run })
  }
  const their = theirs.map((line) => (isBlank(line) ? '' : line))
  const ops = align(keys, their)
  const unitOf = new Map<number, number>()
  units.forEach((unit, u) => { if (unit.item !== null) unitOf.set(unit.item, u) })

  const out: string[] = []
  let u = 0 // next unit not yet emitted
  const emitUpTo = (stop: number): void => {
    for (; u < stop; u += 1) for (const k of units[u].lines) out.push(lines[k])
  }
  const herLine = (j: number): string => their[j] + (eol === '\r\n' ? '\r' : '')
  // A change group (the deletions and additions between two kept lines): their lines take the places of
  // his deleted lines one for one, in order, so a comment or notes line between them keeps its place;
  // theirs left over follow their last placed line. With no deletion, theirs go right after the kept line.
  let dels: number[] = []
  let adds: number[] = []
  const flush = (): void => {
    let a = 0
    let anchor = out.length
    for (const i of dels) {
      const at = unitOf.get(i)!
      emitUpTo(at)
      if (i === dels[0]) anchor = out.length
      if (units[at].lines.length === 1 && kindOf(units[at].lines[0]) === 'visible') {
        if (a < adds.length) out.push(herLine(adds[a++]))
        anchor = out.length
      } else {
        // A deleted gap keeps its hidden lines (notes, comments); its blank lines go.
        for (const k of units[at].lines) if (kindOf(k) === 'hidden') out.push(lines[k])
      }
      u = at + 1
    }
    const rest = adds.slice(a).map(herLine)
    out.splice(anchor, 0, ...rest)
    dels = []
    adds = []
  }
  for (const op of ops) {
    if (op.t === 'keep') { flush(); emitUpTo(unitOf.get(op.i)! + 1) }
    else if (op.t === 'del') dels.push(op.i)
    else adds.push(op.j)
  }
  flush()
  emitUpTo(units.length)
  for (let k = lastVisible + 1; k < slide.end; k += 1) out.push(lines[k])
  return out
}

/** Puts `{id=<id>}` back on the block's Trigger line (or a new one under the heading). */
function ensureId(block: string[], id: string, eol: string): string[] {
  if (!id) return block
  const cr = eol === '\r\n' ? '\r' : ''
  const head = block[0] ?? ''
  if (new RegExp(`\\{id=${id}\\}`).test(head)) return block
  let j = 1
  while (j < block.length && isBlank(block[j])) j += 1
  if (j < block.length && TRIGGER_LINE_RE.test(block[j].replace(/\r$/, ''))) {
    if (new RegExp(`\\{id=${id}\\}`).test(block[j])) return block
    const next = block.slice()
    next[j] = `${block[j].replace(/\r$/, '').replace(/[ \t]+$/, '')} {id=${id}}${cr}`
    return next
  }
  return [head, `{id=${id}}${cr}`, ...block.slice(1)]
}

// ── Structure check ──────────────────────────────────────────────────────────────────────────────

/** Outside [from, from+newCount) of the new text (in place of [from, from+oldCount) of the old), the
 *  talk's headings read exactly as before. */
function structureKept(oldText: string, newText: string, from: number, oldCount: number, newCount: number): boolean {
  const a = readOutline(oldText).levels
  const b = readOutline(newText).levels
  if (b.length - newCount !== a.length - oldCount) return false
  for (let i = 0; i < from; i += 1) if (a[i] !== b[i]) return false
  for (let i = from + oldCount, k = from + newCount; i < a.length; i += 1, k += 1) if (a[i] !== b[k]) return false
  return true
}

export const SECTION_DELETE = 'This slide opens a section: deleting it would move its slides under the slide before it. Accept cannot do that; delete the section by hand if you mean to.'
const OPEN_MARKUP = 'Their text leaves an HTML comment (<!--) or a code fence open, so it would hide or swallow what follows it. Nothing was changed; open the slide and paste what you want by hand.'
const RESTRUCTURE = 'Their text changes the slide\u2019s heading level or adds a heading or a title line, which would change how the talk is organised. Nothing was changed; open the slide and edit it by hand.'
const NOT_PLACED = 'Their text could not be put into the slide without changing what else it shows. Nothing was changed; open the slide and edit it by hand.'

/** Their lines leave a code fence or an HTML comment open (read on their own, as the compiler would). */
function leavesMarkupOpen(lines: string[]): boolean {
  const r = readOutline(lines.join('\n'))
  return r.openFence || r.openComment
}

/** A line compared for "already there": `{id=…}` tokens dropped, line end trimmed; null for a line
 *  that is nothing but ids (one the save stamped). */
function withoutIds(line: string): string | null {
  if (/^\s*(\{id=[A-Za-z0-9_-]+\}\s*)+$/.test(line)) return null
  return line.replace(ID_TOKEN_RE, '').replace(/[ \t\r]+$/, '')
}

const REFUSED_STRUCTURE = 'Their text has a code fence or an HTML comment that is never closed, so it would change how the rest of the talk reads. Nothing was changed; open the slide and paste what you want by hand.'

/** The 1-based last non-blank line before 0-based line index `index` (0 when none). */
function lastNonBlankBefore(lines: string[], index: number): number {
  for (let i = Math.min(index, lines.length) - 1; i >= 0; i -= 1) if (!isBlank(lines[i])) return i + 1
  return 0
}

// ── applyProposal ────────────────────────────────────────────────────────────────────────────────

/** Is `edit` still in `text` as it was made (at its place, or unambiguously elsewhere)? */
export function editStillThere(text: string, edit: AcceptedEdit): boolean {
  const back = undoEdit(text, edit)
  return back.ok && back.text !== text
}

/** An edit that changes nothing (a text-only "already"): no Undo to offer. */
export function isEmptyEdit(edit: AcceptedEdit | null | undefined): boolean {
  return !edit || edit.removed === edit.inserted
}

/** The block an earlier Accept of this item inserted, if it is at line `at` now: `block` read line for
 *  line (the id lines its save stamped skipped), and linked to the item by `remembered` — the splice
 *  that Accept made holds the same lines, and starts within a line or two of `at`. Returns the splice
 *  that takes it out again (for Undo), or null. */
function rememberedInsert(text: string, lines: string[], at: number, block: string[], remembered: AcceptedEdit, headingOffset: number): AcceptedEdit | null {
  const want = block.map((line) => withoutIds(line) ?? '')
  const inked = (list: string[]): string[] => list.map((line) => withoutIds(line)).filter((line): line is string => line !== null && line.trim() !== '')
  // The remembered splice is this block: the same lines, in order.
  if (inked(remembered.inserted.split('\n')).join('\n') !== inked(want).join('\n')) return null
  let startOffset = 0
  for (let i = 0; i < at; i += 1) startOffset += lines[i].length + 1
  const rememberedLine = text.slice(0, Math.min(remembered.from, text.length)).split('\n').length - 1
  if (Math.abs(rememberedLine - at) > 2) return null
  const found: number[] = []
  for (let i = at; i < lines.length && found.length < want.length; i += 1) {
    const line = withoutIds(lines[i])
    if (line === null) continue // an id line the save stamped
    if (line !== want[found.length]) return null
    found.push(i)
  }
  if (found.length !== want.length || !want.length) return null
  let endLine = found[found.length - 1] + 1
  if (endLine < lines.length && isBlank(lines[endLine]) && endLine + 1 < lines.length) endLine += 1
  const inserted = lines.slice(at, endLine).map((line) => line + '\n').join('')
  return {
    from: startOffset, removed: '', inserted, line: at + 1 + headingOffset,
    before: text.slice(Math.max(0, startOffset - 80), startOffset),
    after: text.slice(startOffset + inserted.length, startOffset + inserted.length + 80),
  }
}

export function applyProposal(outlineText: string, item: ProposalItem, base: ProposalBase): ApplyProposalResult {
  const text = String(outlineText ?? '')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const read = readOutlineSlides(text)
  const { lines } = read
  const done = (next: string, line: number, since: boolean | null, afterLine: number | null): Extract<ApplyProposalResult, { ok: true }> => ({
    ok: true, text: next, changedSince: since, edit: spliceEdit(text, next, line), line, afterLine,
  })

  if (item.kind === 'note') return { ok: false, code: 'note', error: 'A note has nothing to accept; mark it Done.' }

  if (item.kind === 'replace' || item.kind === 'delete') {
    const slide = findSlide(read, item.slideId, base.line)
    if (!slide) return { ok: false, code: 'not-found', error: 'That slide is no longer in the talk. Nothing was changed.' }
    const since = changedSince(read, item, base)
    if (item.kind === 'delete') {
      // A section's heading cannot go alone (its slides would fall under the slide before); a
      // container goes with every child heading it folds in, so nothing is left to attach elsewhere.
      if (slide.opensSection) return { ok: false, code: 'refused', error: SECTION_DELETE }
      const next = [...lines.slice(0, slide.start), ...lines.slice(slide.blockEnd)].join('\n')
      if (!structureKept(text, next, slide.start, slide.blockEnd - slide.start, 0)) return { ok: false, code: 'refused', error: REFUSED_STRUCTURE }
      return done(next, Math.min(slide.line, next.split('\n').length), since, null)
    }
    const theirs = dropIds(herLines(item.text), slide.id || undefined)
    if (!theirs.length) return { ok: false, code: 'refused', error: 'Their proposed text is empty. Nothing was changed; use the deletion instead.' }
    if (leavesMarkupOpen(theirs)) return { ok: false, code: 'refused', error: OPEN_MARKUP }
    // The slide keeps its place in the talk: one heading, first, at its own depth; no title line.
    const herLevels = readOutline(theirs.join('\n')).levels
    if (herLevels[0] !== slide.level || herLevels.slice(1).some((level) => level > 0)) return { ok: false, code: 'refused', error: RESTRUCTURE }
    // Only the slide's own lines (a container's folded children are not in the text they saw, and stay).
    const merged = ensureId(mergeBlock(read, slide, theirs, eol), slide.id, eol)
    if (leavesMarkupOpen(merged)) return { ok: false, code: 'refused', error: OPEN_MARKUP }
    const next = [...lines.slice(0, slide.start), ...merged, ...lines.slice(slide.end)].join('\n')
    if (!structureKept(text, next, slide.start, slide.end - slide.start, merged.length)) return { ok: false, code: 'refused', error: REFUSED_STRUCTURE }
    // What the slide now shows must be exactly their text (with its id): nothing of his became visible
    // or hidden by their markup.
    // (Blank lines aside: his comment lines read as blank lines on their page.)
    const inked = (t: string | undefined): string => String(t ?? '').split('\n').filter((line) => !isBlank(line)).join('\n')
    const shown = readOutlineSlides(next).slides.find((s) => s.start === slide.start)?.text
    const meant = readOutlineSlides(ensureId(theirs, slide.id, '\n').join('\n')).slides[0]?.text
    if (!shown || inked(shown) !== inked(meant)) return { ok: false, code: 'refused', error: NOT_PLACED }
    if (next === text) {
      const undo = base.remembered && editStillThere(text, base.remembered) ? base.remembered : spliceEdit(text, text, slide.line)
      return { ...done(next, slide.line, since, null), edit: undo, already: true }
    }
    return done(next, slide.line, since, null)
  }

  // insert
  const atStart = item.afterSlideId === 'start'
  const after = atStart ? null : findSlide(read, item.afterSlideId, base.line)
  if (!atStart && !after) return { ok: false, code: 'not-found', error: 'The slide they put this after is no longer in the talk. Nothing was changed.' }
  const first = read.slides[0] ?? null
  let theirs = dropIds(herLines(item.text))
  if (!theirs.length) return { ok: false, code: 'refused', error: 'Their proposed slide is empty. Nothing was changed.' }
  if (leavesMarkupOpen(theirs)) return { ok: false, code: 'refused', error: OPEN_MARKUP }
  if (!readOutline(theirs.join('\n')).levels.some((level) => level >= 2)) theirs = ['## New slide', ...theirs]
  let herLevels = readOutline(theirs.join('\n')).levels
  if (herLevels.includes(1)) return { ok: false, code: 'refused', error: 'Their proposed slide has a talk title line (a single #) in it; inserted, it would retitle the talk. Nothing was changed.' }
  // Their own heading first: stray lines they wrote above it follow it.
  const rootAt = herLevels.findIndex((level) => level >= 2)
  if (rootAt > 0) {
    theirs = [...theirs.slice(rootAt), ...theirs.slice(0, rootAt)]
    herLevels = readOutline(theirs.join('\n')).levels
  }
  const masked = herLevels.map((level) => level < 2)
  const herMax = Math.max(...herLevels)
  /** Their lines with their heading at `depth`, every heading inside shifted with it; null past `######`. */
  const atDepth = (depth: number): string[] | null =>
    herMax + depth - herLevels[0] > 6 ? null : reLevelHeadingLines(theirs, depth - herLevels[0], masked)
  const TOO_DEEP = 'Their proposed slide nests too deep to go in here. Nothing was changed.'
  const cr = eol === '\r\n' ? '\r' : ''
  const section = item.section?.trim() || ''

  // After the named slide's own block, at a depth that keeps the talk's structure: the named slide's
  // depth, or its first child's when it has children (the new slide then comes first among them).
  const { levels } = readOutline(text)
  let at: number // 0-based line the block goes before
  let level: number
  if (after) {
    // After a container, past the children it folds in (between them the new slide would be folded too).
    at = after.blockEnd
    const nextLevel = at < levels.length ? levels[at] : 0
    level = !after.container && nextLevel > after.level ? nextLevel : after.level
  } else if (first) {
    at = first.start
    level = first.level
  } else {
    at = lines.length
    level = 2
  }
  // A section: its heading at that depth, their slide one deeper as its first child (Insert section's
  // shape and spacing: heading, blank line, the slide re-levelled with its depth inside kept).
  const slideAt = atDepth(section ? level + 1 : level)
  if (!slideAt || (section && level + 1 > 6)) return { ok: false, code: 'refused', error: TOO_DEEP }
  const block = section ? [`${'#'.repeat(level)} ${section.replace(/\s+/g, ' ')}`, '', ...slideAt] : slideAt
  // Already there: only the block an earlier Accept of this item put in (never his own slide that
  // happens to read the same).
  const earlier = base.remembered ? rememberedInsert(text, lines, at, block, base.remembered, section ? 2 : 0) : null
  if (earlier) return { ok: true, text, changedSince: false, edit: earlier, line: earlier.line, afterLine: lastNonBlankBefore(lines, at), already: true }
  // At the end of a text with a final newline, go before that newline so it stays final.
  if (at === lines.length && at > 0 && lines[at - 1] === '' && (!after || at - 1 > after.start)) at -= 1
  // One insertion with a blank line on each side (as Insert section spaces it); nothing else changed.
  const before = lines.slice(0, at)
  const rest = lines.slice(at)
  const lead = before.length && !isBlank(before[before.length - 1]) ? [cr] : []
  const trail = rest.length && !isBlank(rest[0]) ? [cr] : []
  const nextLines = [...before, ...lead, ...block.map((line) => line + cr), ...trail, ...rest]
  const next = nextLines.join('\n')
  if (!structureKept(text, next, at, 0, nextLines.length - lines.length)) return { ok: false, code: 'refused', error: REFUSED_STRUCTURE }
  return done(next, at + lead.length + 1 + (section ? 2 : 0), false, lastNonBlankBefore(lines, at))
}

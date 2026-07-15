// Context-aware outliner operations for the CodeMirror editor (ADR-0005 one-tree model:
// heading depth = structural spine; list indentation = nesting; paragraphs are leaf nodes).
//
// Keyboard contract (wired in Editor.tsx, ⌘ = Mod on macOS):
//   ⌘⇧↑ / ⌘⇧↓            move the current NODE among its siblings:
//                          - heading  → the whole section (heading + everything under it)
//                          - list item→ the item + all its sub-items
//                          - paragraph→ the selected line(s)
//   ⌘⇧← / ⌘⇧→            promote / demote ONLY the current line's level
//   ⌘⌥⇧← / ⌘⌥⇧→          promote / demote the current line AND its subtree below it
//
// All ops rewrite the whole doc in one transaction and restore the caret to the same
// logical line/column, so onContentChange + autosave stay in sync (ADR-0001 canonical).
import { EditorView } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'
import { relocateBlock } from './slideOutline'

const INDENT = '  ' // one list level = two spaces

export function headingLevel(s: string): number {
  const m = s.match(/^(#{1,6})\s/)
  return m ? m[1].length : 0
}
export function leadingWidth(s: string): number {
  const m = s.match(/^[ \t]*/)
  return m ? m[0].replace(/\t/g, INDENT).length : 0
}
export function listMatch(s: string): { indent: number } | null {
  const m = s.match(/^([ \t]*)([-*+]|\d+[.)])\s+/)
  return m ? { indent: m[1].replace(/\t/g, INDENT).length } : null
}
export function isBlank(s: string): boolean {
  return /^\s*$/.test(s)
}

// A line that is ONLY curly-attribute triggers — a Trigger line (ADR-0015).
const TRIGGER_LINE_RE = /^\s*(\{[^}]*\}\s*)+$/

// Per-line fence + HTML-comment mask — mirrors 12-outline-edit.mjs structuralHeadings (length-aware
// fences; a sequential comment state machine), the engine's proven implementation. A flagged line
// is INVISIBLE to structural decisions: a `# fake` inside a ``` fence or an HTML comment must never
// act as a block boundary, a move receiver, or a re-level target — otherwise a cross-container move
// tears the fence in half and rewrites its contents (reviewer scenarios (c)/(d), 2026-07-08). Both
// fence-marker lines are flagged too, so a fence travels whole inside its block.
export function fencedLineFlags(lines: string[]): boolean[] {
  const flags = new Array<boolean>(lines.length).fill(false)
  let inFence = false
  let fenceMark = ''
  let inComment = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const t = line.trim()
    const visibleAtStart = !inComment
    if (!inFence) {
      let pos = 0
      for (;;) {
        if (inComment) {
          const close = line.indexOf('-->', pos)
          if (close === -1) break
          inComment = false
          pos = close + 3
        } else {
          const open = line.indexOf('<!--', pos)
          if (open === -1) break
          inComment = true
          pos = open + 4
        }
      }
    }
    if (!visibleAtStart) { flags[i] = true; continue }
    if (inFence) {
      flags[i] = true
      const close = t.match(/^(`{3,})\s*$/)
      if (close && close[1].length >= fenceMark.length) { inFence = false; fenceMark = '' }
      continue
    }
    const open = t.match(/^(`{3,})/)
    if (open) { inFence = true; fenceMark = open[1]; flags[i] = true }
  }
  return flags
}

// headingLevel gated by the fence mask: a fenced/comment-hidden line is structurally level 0.
function levelAt(lines: string[], i: number, fenced?: boolean[]): number {
  if (fenced && fenced[i]) return 0
  return headingLevel(lines[i])
}

// Place a single bare layout trigger (e.g. `{cards}`) on the current slide's Trigger line — the
// line immediately after the heading — REPLACING an existing Trigger line instead of stacking a
// second `{...}` line lower down (which the compiler treats as literal content, not a trigger).
// `slashLineNum` is the 1-based line where the user typed "/". Returns true when it handled the
// placement (caller must not also insert); false to fall back to a plain replace. Multi-line
// templates (⌘-Enter) fall back — they scaffold a fresh slide rather than re-set one layout.
export function placeLayoutTrigger(view: EditorView, slashLineNum: number, trigger: string): boolean {
  if (trigger.includes('\n')) return false
  const doc = view.state.doc
  if (slashLineNum < 1 || slashLineNum > doc.lines) return false
  // Nearest heading at or above the slash line (any level). None → not on a slide; fall back.
  let headingNum = -1
  for (let n = slashLineNum; n >= 1; n -= 1) {
    if (headingLevel(doc.line(n).text) >= 1) { headingNum = n; break }
  }
  if (headingNum < 0) return false
  const slashLine = doc.line(slashLineNum)
  // Existing Trigger line: the line right after the heading, if trigger-only and not the slash line.
  let existing: { from: number; to: number } | null = null
  if (headingNum + 1 <= doc.lines) {
    const after = doc.line(headingNum + 1)
    if (after.number !== slashLineNum && TRIGGER_LINE_RE.test(after.text)) {
      existing = { from: after.from, to: after.to }
    }
  }
  const changes: { from: number; to: number; insert: string }[] = []
  // Drop the slash line (with its trailing newline when it is not the last line).
  changes.push({
    from: slashLine.from,
    to: Math.min(doc.length, slashLine.to + (slashLineNum < doc.lines ? 1 : 0)),
    insert: ''
  })
  if (existing) {
    changes.push({ from: existing.from, to: existing.to, insert: trigger })
  } else {
    const h = doc.line(headingNum)
    changes.push({ from: h.to, to: h.to, insert: '\n' + trigger })
  }
  changes.sort((a, b) => a.from - b.from)
  view.dispatch({ changes })
  view.focus()
  return true
}

// Place a bare layout trigger on the CURRENT slide's Trigger line, addressed by the caret position
// (no slash line to remove). Used by ⌘L — the keyboard replacement for the `/` picker. Finds the
// nearest heading at/above the caret, then sets/replaces that slide's Trigger line. Returns true on
// success; false when the caret is not under a heading (no slide to target). Multi-line templates
// (⌘-Enter) are handled elsewhere and pass through false.
export function placeLayoutTriggerAtCursor(view: EditorView, trigger: string): boolean {
  if (trigger.includes('\n')) return false
  const doc = view.state.doc
  const caretLineNum = doc.lineAt(view.state.selection.main.head).number
  let headingNum = -1
  for (let n = caretLineNum; n >= 1; n -= 1) {
    if (headingLevel(doc.line(n).text) >= 1) { headingNum = n; break }
  }
  if (headingNum < 0) return false
  // Existing Trigger line: the line right after the heading, if it is trigger-only.
  let existing: { from: number; to: number } | null = null
  if (headingNum + 1 <= doc.lines) {
    const after = doc.line(headingNum + 1)
    if (TRIGGER_LINE_RE.test(after.text)) existing = { from: after.from, to: after.to }
  }
  if (existing) {
    view.dispatch({ changes: { from: existing.from, to: existing.to, insert: trigger } })
  } else {
    const h = doc.line(headingNum)
    view.dispatch({ changes: { from: h.to, to: h.to, insert: '\n' + trigger } })
  }
  view.focus()
  return true
}

// 0-based index of the closing `---` of YAML frontmatter, or -1 if there is none. The body
// (editable outline) starts on the next line. The frontmatter is PROTECTED from outliner
// operations so a stray ⌘⇧-arrow can't reorder or re-level the deck's metadata.
export function frontmatterEnd(lines: string[]): number {
  if ((lines[0] ?? '').trim() !== '---') return -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') return i
  }
  return -1
}
function bodyStart(lines: string[]): number {
  const fe = frontmatterEnd(lines)
  return fe >= 0 ? fe + 1 : 0
}
function cursorInFrontmatter(view: EditorView): boolean {
  const lines = view.state.doc.toString().split('\n')
  const i = view.state.doc.lineAt(view.state.selection.main.head).number - 1
  return i <= frontmatterEnd(lines) // the --- lines and everything between them
}

type NodeKind = 'heading' | 'list' | 'para'
interface NodeBlock {
  start: number
  end: number // exclusive
  kind: NodeKind
  level: number // heading #-count, or list indent width, or 0 for paragraph
}

// The block of the node rooted at line `i`: a heading section, a list item + its sub-items,
// or a single paragraph line. Deeper-indented lines belong to a list item; blank lines and
// shallower/sibling lines end it. `fenced` (when supplied) hides fenced/comment lines from every
// boundary decision, so a `# fake` inside a fence never terminates a heading block.
function nodeBlock(lines: string[], i: number, fenced?: boolean[]): NodeBlock {
  const hl = levelAt(lines, i, fenced)
  if (hl > 0) {
    let end = i + 1
    while (end < lines.length) {
      const h = levelAt(lines, end, fenced)
      if (h > 0 && h <= hl) break
      end++
    }
    return { start: i, end, kind: 'heading', level: hl }
  }
  const lm = listMatch(lines[i])
  if (lm) {
    let end = i + 1
    while (end < lines.length) {
      if (levelAt(lines, end, fenced) > 0) break
      if (isBlank(lines[end])) break
      const elm = listMatch(lines[end])
      const indent = elm ? elm.indent : leadingWidth(lines[end])
      if (indent <= lm.indent) break // sibling or shallower
      end++
    }
    return { start: i, end, kind: 'list', level: lm.indent }
  }
  return { start: i, end: i + 1, kind: 'para', level: 0 }
}

// Find the sibling node block immediately before/after the block rooted at `i`, at the same
// structural level, without crossing a parent boundary. Returns null when there is no sibling
// in that direction (e.g. first child of a section).
function siblingBlock(
  lines: string[],
  block: NodeBlock,
  dir: 'up' | 'down',
  fenced?: boolean[]
): NodeBlock | null {
  if (block.kind === 'heading') {
    if (dir === 'down') {
      const j = block.end
      if (j >= lines.length) return null
      const h = levelAt(lines, j, fenced)
      if (h !== block.level) return null // shallower heading = parent boundary / end
      return nodeBlock(lines, j, fenced)
    }
    // up: nearest heading strictly before block.start
    let k = block.start - 1
    while (k >= 0 && levelAt(lines, k, fenced) === 0) k--
    if (k < 0) return null
    const h = levelAt(lines, k, fenced)
    if (h < block.level) return null // hit an ancestor → no previous sibling
    if (h > block.level) {
      // deeper heading belongs to a previous sibling section; root it
      let r = k
      while (r > 0 && !(levelAt(lines, r, fenced) > 0 && levelAt(lines, r, fenced) <= block.level)) r--
      if (levelAt(lines, r, fenced) !== block.level) return null
      return nodeBlock(lines, r, fenced)
    }
    return nodeBlock(lines, k, fenced)
  }
  if (block.kind === 'list') {
    if (dir === 'down') {
      const j = block.end
      if (j >= lines.length) return null
      if (levelAt(lines, j, fenced) > 0 || isBlank(lines[j])) return null
      const lm = listMatch(lines[j])
      const indent = lm ? lm.indent : leadingWidth(lines[j])
      if (!lm || indent !== block.level) return null
      return nodeBlock(lines, j, fenced)
    }
    let k = block.start - 1
    if (k < 0 || isBlank(lines[k]) || levelAt(lines, k, fenced) > 0) return null
    const lm = listMatch(lines[k])
    const indent = lm ? lm.indent : leadingWidth(lines[k])
    if (indent < block.level) return null // parent item
    // walk to the root of the previous sibling at the same indent
    let r = k
    while (r > 0) {
      const rlm = listMatch(lines[r])
      const rIndent = rlm ? rlm.indent : leadingWidth(lines[r])
      if (rlm && rIndent === block.level) break
      if (levelAt(lines, r, fenced) > 0 || isBlank(lines[r])) return null
      if (rIndent < block.level) return null
      r--
    }
    const rlm = listMatch(lines[r])
    if (!rlm || rlm.indent !== block.level) return null
    return nodeBlock(lines, r, fenced)
  }
  // paragraph: sibling is the adjacent single line (skip nothing — direct swap)
  if (dir === 'down') {
    const j = block.end
    if (j >= lines.length) return null
    return { start: j, end: j + 1, kind: 'para', level: 0 }
  }
  const k = block.start - 1
  if (k < 0) return null
  return { start: k, end: k + 1, kind: 'para', level: 0 }
}

// Uniform heading-level shift of a block of lines (spec Q5 re-levelling). Every heading line in
// `block` moves by `delta`; non-heading and fenced/comment-hidden lines are untouched (`fenced`
// is the mask slice aligned with `block`). Invariant: cross-container moves only SHALLOW the tree
// (the destination parent is always shallower than the block root, so delta ≤ 0 and the shifted
// levels stay within 2–6) — the 1–6 clamp is unreachable in practice and kept purely as defence.
function reLevelLines(block: string[], delta: number, fenced?: boolean[]): string[] {
  if (delta === 0) return block.slice()
  return block.map((l, idx) => {
    if (fenced && fenced[idx]) return l
    const m = l.match(/^(#{1,6})(\s.*)$/)
    if (!m) return l
    const n = Math.max(1, Math.min(6, m[1].length + delta))
    return '#'.repeat(n) + m[2]
  })
}

// Cross-container heading move (spec §5, decision Q5). When a heading block has NO same-level
// sibling in `dir` and the blocker is a heading boundary, the whole block (subtree included)
// relocates INTO the adjacent container — as its FIRST child moving down, LAST child moving up —
// and every heading in the block re-levels uniformly by `newParentLevel + 1 − block.level`
// (always ≤ 0: the destination parent is shallower than the block root, so cross-moves only
// shallow the tree — see reLevelLines). Returns the rewritten lines + the new 0-based index of
// the moved heading, or
// null when there is no adjacent container to cross into (document edge / above the first section).
// Pure (lines in, lines out) so scripts/test-outliner-moves.mjs can exercise it directly.
export function moveHeadingBlock(
  lines: string[],
  i: number,
  dir: 'up' | 'down',
  bs: number
): { lines: string[]; caret: number } | null {
  // Fence/comment mask, computed once per invocation: fenced lines are never block boundaries,
  // receivers, or re-level targets (reviewer scenarios (c)/(d) — live fence corruption otherwise).
  const fenced = fencedLineFlags(lines)
  const block = nodeBlock(lines, i, fenced)
  if (block.kind !== 'heading') return null
  if (block.start < bs) return null

  if (dir === 'down') {
    const j = block.end
    if (j >= lines.length) return null // document edge — no container below
    const boundaryLevel = levelAt(lines, j, fenced)
    // nodeBlock guarantees lines[j] (when present) is a heading ≤ block.level; a same-level one is
    // a sibling handled by siblingBlock, so here it must be strictly shallower (a real boundary).
    if (boundaryLevel === 0 || boundaryLevel >= block.level) return null
    const moved = reLevelLines(
      lines.slice(block.start, block.end),
      boundaryLevel + 1 - block.level,
      fenced.slice(block.start, block.end)
    )
    const rest = [...lines.slice(0, block.start), ...lines.slice(block.end)]
    // The boundary heading, once the block is spliced out, sits at index block.start in `rest`.
    let insertAt = block.start + 1 // right after the boundary heading = its first child
    // Keep a heading's Trigger line glued to it: never wedge the moved block between them.
    if (insertAt < rest.length && rest[insertAt].trim() !== '' && TRIGGER_LINE_RE.test(rest[insertAt])) {
      insertAt += 1
    }
    const out = [...rest.slice(0, insertAt), ...moved, ...rest.slice(insertAt)]
    return { lines: out, caret: insertAt + (i - block.start) }
  }

  // up: the block is the first child of its parent — leave the parent and become the LAST child of
  // the adjacent container above (the parent's previous sibling, or the grandparent if none).
  let p = block.start - 1
  while (p >= bs && levelAt(lines, p, fenced) === 0) p -= 1
  if (p < bs) return null // nothing above in the body
  const parentLevel = levelAt(lines, p, fenced)
  if (parentLevel === 0 || parentLevel >= block.level) return null // sibling/deeper — not our case
  // Receiver: nearest heading above the parent at ≤ parent's level. Everything between it and the
  // parent is its subtree, so inserting before the parent appends the block as its last child.
  let r = p - 1
  while (r >= bs && !(levelAt(lines, r, fenced) > 0 && levelAt(lines, r, fenced) <= parentLevel)) r -= 1
  if (r < bs) return null // parent is the first section — no container above to receive it
  const newParentLevel = levelAt(lines, r, fenced)
  const moved = reLevelLines(
    lines.slice(block.start, block.end),
    newParentLevel + 1 - block.level,
    fenced.slice(block.start, block.end)
  )
  const out = [
    ...lines.slice(0, p),
    ...moved,
    ...lines.slice(p, block.start),
    ...lines.slice(block.end)
  ]
  return { lines: out, caret: p + (i - block.start) }
}

function offsetOfLine(lines: string[], lineIdx: number, col: number): number {
  let off = 0
  for (let k = 0; k < lineIdx; k++) off += lines[k].length + 1
  return off + Math.min(col, lines[lineIdx]?.length ?? 0)
}

// Minimal change between two doc strings: the differing middle span only (common prefix/suffix
// trimmed). A full `from:0,to:end` replace makes CodeMirror treat the whole doc as new and DROP its
// scroll anchor (the viewport snaps to the top); a minimal change keeps the anchor, so an in-place
// edit stays exactly where it is. Outliner ops rebuild the whole `lines` array, so we diff here.
export function minimalChange(oldText: string, newText: string): { from: number; to: number; insert: string } {
  let start = 0
  const minLen = Math.min(oldText.length, newText.length)
  while (start < minLen && oldText.charCodeAt(start) === newText.charCodeAt(start)) start += 1
  let oldEnd = oldText.length
  let newEnd = newText.length
  while (oldEnd > start && newEnd > start && oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)) {
    oldEnd -= 1
    newEnd -= 1
  }
  return { from: start, to: oldEnd, insert: newText.slice(start, newEnd) }
}

function applyDoc(view: EditorView, lines: string[], caretLine: number, caretCol: number): boolean {
  const newText = lines.join('\n')
  const pos = offsetOfLine(lines, Math.max(0, Math.min(caretLine, lines.length - 1)), caretCol)
  const ch = minimalChange(view.state.doc.toString(), newText)
  view.dispatch({
    changes: { from: ch.from, to: ch.to, insert: ch.insert },
    selection: EditorSelection.cursor(pos),
    scrollIntoView: true
  })
  return true
}

export function moveNode(view: EditorView, dir: 'up' | 'down'): boolean {
  if (cursorInFrontmatter(view)) return true // protected metadata — consume, no-op
  const lines = view.state.doc.toString().split('\n')
  const bs = bodyStart(lines)
  const sel = view.state.selection.main
  const curLine = view.state.doc.lineAt(sel.head)
  const i = curLine.number - 1
  const col = sel.head - curLine.from

  // Fence/comment mask (once per keystroke): fenced heading-like lines are structurally invisible.
  const fenced = fencedLineFlags(lines)

  // A multi-line selection of plain lines moves as a unit.
  const headLine = view.state.doc.lineAt(sel.from).number - 1
  const tailLine = view.state.doc.lineAt(sel.to).number - 1
  const multi = headLine !== tailLine
  const isStructural = levelAt(lines, i, fenced) > 0 || listMatch(lines[i]) !== null

  let block: NodeBlock
  if (multi && !isStructural) {
    block = { start: headLine, end: tailLine + 1, kind: 'para', level: 0 }
  } else {
    block = nodeBlock(lines, i, fenced)
  }

  let sib = siblingBlock(lines, block, dir, fenced)
  if (!sib && block.kind === 'heading') {
    // No same-level sibling and the blocker is a heading boundary: cross INTO the adjacent
    // container with uniform re-levelling (spec Q5). Sections travel with their subtree. A true
    // edge (document end / above the first section) returns null → consume the key, no-op.
    const crossed = moveHeadingBlock(lines, i, dir, bs)
    if (crossed) return applyDoc(view, crossed.lines, crossed.caret, col)
    return false
  }
  if (!sib) {
    // No same-level sibling (e.g. the FIRST item of a list, or a top section): fall back to
    // swapping with the adjacent paragraph block, so it still moves past surrounding prose.
    // Never cross a heading boundary (that would reparent the node oddly).
    if (dir === 'up') {
      let j = block.start - 1
      while (j >= bs && isBlank(lines[j])) j -= 1
      if (j >= bs && headingLevel(lines[j]) === 0 && !listMatch(lines[j])) {
        let s = j
        while (s > bs && !isBlank(lines[s - 1]) && headingLevel(lines[s - 1]) === 0 && !listMatch(lines[s - 1])) s -= 1
        sib = { start: s, end: j + 1, kind: 'para', level: 0 }
      }
    } else {
      let j = block.end
      while (j < lines.length && isBlank(lines[j])) j += 1
      if (j < lines.length && headingLevel(lines[j]) === 0 && !listMatch(lines[j])) {
        let e = j
        while (e + 1 < lines.length && !isBlank(lines[e + 1]) && headingLevel(lines[e + 1]) === 0 && !listMatch(lines[e + 1])) e += 1
        sib = { start: j, end: e + 1, kind: 'para', level: 0 }
      }
    }
  }
  if (!sib) return false

  // Gap-preserving swap: any blank lines BETWEEN the node and its sibling stay put (they end
  // up between the two after the swap). Same-level siblings are adjacent (empty gap); the
  // paragraph fallback may have a blank-line gap.
  let newLines: string[]
  let newBlockStart: number
  if (dir === 'up') {
    // doc order: sib, gap, block  →  block, gap, sib
    const before = lines.slice(0, sib.start)
    const gap = lines.slice(sib.end, block.start)
    const after = lines.slice(block.end)
    newLines = [
      ...before,
      ...lines.slice(block.start, block.end),
      ...gap,
      ...lines.slice(sib.start, sib.end),
      ...after
    ]
    newBlockStart = sib.start
  } else {
    // doc order: block, gap, sib  →  sib, gap, block
    const before = lines.slice(0, block.start)
    const gap = lines.slice(block.end, sib.start)
    const after = lines.slice(sib.end)
    newLines = [
      ...before,
      ...lines.slice(sib.start, sib.end),
      ...gap,
      ...lines.slice(block.start, block.end),
      ...after
    ]
    newBlockStart = block.start + (sib.end - sib.start) + gap.length
  }
  const caretLine = newBlockStart + (i - block.start)
  return applyDoc(view, newLines, caretLine, col)
}

// delta: -1 = promote (heading: fewer #, list: outdent), +1 = demote.
export function reLevel(
  view: EditorView,
  delta: -1 | 1,
  withSubtree: boolean
): boolean {
  if (cursorInFrontmatter(view)) return true // protected metadata — consume, no-op
  const lines = view.state.doc.toString().split('\n')
  const sel = view.state.selection.main
  const curLine = view.state.doc.lineAt(sel.head)
  const i = curLine.number - 1
  const col = sel.head - curLine.from

  const hl = headingLevel(lines[i])
  if (hl > 0) {
    const range = withSubtree ? nodeBlock(lines, i) : { start: i, end: i + 1 }
    let changed = false
    for (let j = range.start; j < range.end; j++) {
      const m = lines[j].match(/^(#{1,6})(\s.*)$/)
      if (!m) continue
      const n = Math.max(1, Math.min(6, m[1].length + delta))
      if (n !== m[1].length) {
        lines[j] = '#'.repeat(n) + m[2]
        changed = true
      }
    }
    return changed ? applyDoc(view, lines, i, col) : false
  }

  // Non-heading lines (list item, > quote, plain paragraph, empty) promote/demote by
  // INDENTATION — so the shortcut works on any line, not just list items.
  const range = withSubtree ? nodeBlock(lines, i) : { start: i, end: i + 1 }
  let changed = false
  let caretCol = col
  for (let j = range.start; j < range.end; j++) {
    if (delta > 0) {
      // Don't indent a truly empty line into trailing whitespace unless it's the caret line.
      if (isBlank(lines[j]) && j !== i) continue
      lines[j] = INDENT + lines[j]
      if (j === i) caretCol = col + INDENT.length
      changed = true
    } else if (lines[j].startsWith(INDENT)) {
      lines[j] = lines[j].slice(INDENT.length)
      if (j === i) caretCol = Math.max(0, col - INDENT.length)
      changed = true
    } else if (/^[ \t]/.test(lines[j])) {
      lines[j] = lines[j].replace(/^[ \t]/, '')
      if (j === i) caretCol = Math.max(0, col - 1)
      changed = true
    }
  }
  return changed ? applyDoc(view, lines, i, caretCol) : false
}

// Jump the caret to the previous / next heading (slide). Consumes the key either way.
export function jumpHeading(view: EditorView, dir: 'up' | 'down'): boolean {
  const lines = view.state.doc.toString().split('\n')
  const i = view.state.doc.lineAt(view.state.selection.main.head).number - 1
  const found =
    dir === 'down'
      ? (() => { for (let j = i + 1; j < lines.length; j += 1) if (headingLevel(lines[j]) > 0) return j; return -1 })()
      : (() => { for (let j = i - 1; j >= 0; j -= 1) if (headingLevel(lines[j]) > 0) return j; return -1 })()
  if (found >= 0) {
    const line = view.state.doc.line(found + 1)
    view.dispatch({ selection: EditorSelection.cursor(line.from), scrollIntoView: true })
  }
  return true
}

// ── Icon-picker caret context (ADR-0021) ─────────────────────────────────────
//
// The icon picker writes a `{icon=KEY}` token onto whatever top-level list bullet the caret is
// in. The engine's setListItemIcon addresses that bullet by {heading, occurrence} + 0-based item
// index, where the index counts TOP-LEVEL (indent-0) list-item lines in document order across the
// whole `###` slide block. This mirrors that addressing so the index lines up exactly.
//
// Returns null when the caret is not inside a top-level list item of a `###` slide (so the caller
// can disable the picker / show a hint rather than guessing a target).

// A top-level list-item line: indent-0 marker followed by a non-space. Mirrors the engine's
// TOP_LEVEL_ITEM_RE in 12-outline-edit.mjs exactly so item indices agree.
const TOP_LEVEL_ITEM_RE = /^(?:[-*]\s+|\d+[.)]\s+)\S/

export interface CursorListItemContext {
  slideHeading: string // the verbatim heading line (any level ##–######)
  slideOccurrence: number // 1-based among identical heading lines
  itemIndex: number // 0-based position among the block's top-level list items
}

export function getCursorListItemContext(view: EditorView): CursorListItemContext | null {
  const lines = view.state.doc.toString().split('\n')
  const caret = view.state.doc.lineAt(view.state.selection.main.head).number - 1

  // Heading-is-slide model: the nearest heading of ANY level (##–######) at or above the caret is
  // the enclosing slide. The engine addresses the block by its VERBATIM heading line + occurrence
  // (12-outline-edit.mjs findBlock), so the whole line — `#`-prefix included — is the identity.
  let headingIdx = -1
  for (let j = caret; j >= 0; j -= 1) {
    if (headingLevel(lines[j]) > 0) { headingIdx = j; break }
  }
  if (headingIdx < 0) return null

  // Block end: the next structural heading (any level) after the slide heading, or EOF.
  let blockEnd = lines.length
  for (let j = headingIdx + 1; j < lines.length; j += 1) {
    if (headingLevel(lines[j]) > 0) { blockEnd = j; break }
  }
  if (caret >= blockEnd) return null

  // The caret's own top-level item: walk up to the nearest indent-0 list-item line, stopping at
  // the heading or a blank line (a blank ends the item's region just like the engine's scan).
  let itemLine = -1
  for (let j = caret; j > headingIdx; j -= 1) {
    if (TOP_LEVEL_ITEM_RE.test(lines[j])) { itemLine = j; break }
    if (isBlank(lines[j])) break
    if (headingLevel(lines[j]) > 0) break
  }
  if (itemLine < 0) return null

  // 0-based index of itemLine among the block's top-level item lines (document order).
  let itemIndex = -1
  for (let j = headingIdx + 1; j <= itemLine; j += 1) {
    if (TOP_LEVEL_ITEM_RE.test(lines[j])) itemIndex += 1
  }

  // Occurrence: 1-based count of identical heading lines at/before this one. The line includes its
  // `#`-prefix, so headings at different levels never collide — this matches listSlideBlocks, which
  // counts occurrence on the verbatim heading text.
  const headingText = lines[headingIdx]
  let slideOccurrence = 0
  for (let j = 0; j <= headingIdx; j += 1) {
    if (headingLevel(lines[j]) > 0 && lines[j] === headingText) slideOccurrence += 1
  }

  return { slideHeading: headingText, slideOccurrence, itemIndex }
}

// ── List editing: Enter continues, Tab/Shift-Tab indent/outdent ───────────────

const LIST_RE = /^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/

// Enter on a list item: continue the list (new marker, ordered numbers increment). An empty
// item outdents one level, or exits the list when already at column 0.
export function continueList(view: EditorView): boolean {
  const sel = view.state.selection.main
  if (!sel.empty) return false
  const line = view.state.doc.lineAt(sel.head)
  const m = line.text.match(LIST_RE)
  if (!m) return false
  const [, indent, marker, space, rest] = m
  if (rest.trim() === '') {
    // empty item → outdent one level, or clear the marker (exit) at column 0
    const insert = indent.length >= INDENT.length ? indent.slice(INDENT.length) : ''
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: EditorSelection.cursor(line.from + insert.length)
    })
    return true
  }
  let nextMarker = marker
  const om = marker.match(/^(\d+)([.)])$/)
  if (om) nextMarker = String(parseInt(om[1], 10) + 1) + om[2]
  const insert = '\n' + indent + nextMarker + space
  view.dispatch({
    changes: { from: sel.head, insert },
    selection: EditorSelection.cursor(sel.head + insert.length)
  })
  return true
}

// Tab: indent the list item (+ its subtree). On a non-list line, insert one indent so focus
// never escapes the editor.
export function indentList(view: EditorView): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  if (listMatch(line.text)) return reLevel(view, 1, true)
  const at = view.state.selection.main.head
  view.dispatch({ changes: { from: at, insert: INDENT }, selection: EditorSelection.cursor(at + INDENT.length) })
  return true
}

// Shift-Tab: outdent the list item (+ subtree), or strip one leading indent on any line.
export function outdentList(view: EditorView): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.head)
  if (listMatch(line.text) || /^[ \t]/.test(line.text)) return reLevel(view, -1, true)
  return false
}

// Relocate the heading-block at `fromLine` to before the heading-block at `toLine` (1-based), for the
// Slides organizer's drag-drop. Uses minimalChange to preserve CodeMirror's scroll anchor
// (a full from:0,to:end replace drops it, snapping the viewport to the top).
export function moveBlockTo(view: EditorView, fromLine: number, toLine: number): boolean {
  const text = view.state.doc.toString()
  const next = relocateBlock(text, fromLine, toLine)
  if (next === text) return false
  const ch = minimalChange(text, next)
  view.dispatch({ changes: { from: ch.from, to: ch.to, insert: ch.insert } })
  return true
}

// ── Trigger-line normalizer (ADR-0015) ───────────────────────────────────────
//
// Author metadata must live on the trigger line — the line immediately below the
// `### ` heading — not trailing the heading text itself. `normalizeTriggerLines`
// migrates any `### My title {group}{title=side}` form to two lines:
//   `### My title`
//   `{group}{title=side}`
// If a trigger-only line already exists directly below, the title's groups are
// prepended to it (merged), preserving any existing tokens.
// Rules:
//  - Every slide heading (`##`–`######`) is touched; the deck title (`# `) is left unchanged.
//  - Only a TRAILING run of `{…}` groups is moved — text to the left of the first
//    trailing brace group is the clean title and is left intact.
//  - Idempotent (running twice changes nothing).
//  - All other lines (blank, content, trigger-only) are preserved exactly.
//  - Fenced/comment-hidden lines are never touched: a heading-shaped line inside a ``` fence is
//    code, not a slide heading, and a fenced `{…}` line is never a merge target.

// Regex: one or more `{…}` groups that form the ENTIRE tail of a line.
const TRAILING_BRACES_RE = /\s*(\{[^}]*\}(?:\s*\{[^}]*\})*)\s*$/

export function normalizeTriggerLines(text: string): string {
  const lines = text.split('\n')
  const fenced = fencedLineFlags(lines)
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    // Act on any slide heading (##–######) that has trailing brace groups; skip the deck title (#)
    // and anything inside a fence or HTML comment (heading-shaped code lines).
    const isSlideHeading = !fenced[i] && /^#{2,6} /.test(line)
    if (!isSlideHeading) { out.push(line); i += 1; continue }
    const m = line.match(TRAILING_BRACES_RE)
    if (!m) { out.push(line); i += 1; continue }
    // Strip the trailing braces from the title.
    const cleanTitle = line.slice(0, line.length - m[0].length)
    const movedGroups = m[1] // e.g. `{statement}{title=side}`
    // Find the heading's existing Trigger line: the FIRST non-blank line below, if it is a
    // (non-fenced) {…}-only line — blank lines between the heading and it are TOLERATED (the shared
    // read rule, id-churn hotfix 2026-07-10). Merging must never create a duplicate Trigger line above
    // a blank-separated existing one, so scan past the blanks and merge into it.
    let j = i + 1
    while (j < lines.length && lines[j].trim() === '') j += 1
    const existingTrigger =
      j < lines.length && !fenced[j] && lines[j].trim() !== '' && TRIGGER_LINE_RE.test(lines[j])
    if (existingTrigger) {
      // Merge: prepend the moved groups to the existing trigger line and place it DIRECTLY below the
      // heading (dropping the intervening blanks), so a migrated heading never leaves a blank between
      // itself and the Trigger line it just merged into.
      out.push(cleanTitle)
      out.push(movedGroups + lines[j].trim())
      i = j + 1
    } else {
      // Insert a new trigger line directly below the heading.
      out.push(cleanTitle)
      out.push(movedGroups)
      i += 1
    }
  }
  return out.join('\n')
}

// Command: apply normalizeTriggerLines to the current document via the whole-doc
// replace channel (preserving caret + scroll via minimalChange).
// Delete the slide under the caret: the nearest heading at/above plus everything until the
// next heading of the same-or-shallower level. This is THE sanctioned way to remove a slide —
// the Trigger line (with its {id=…}) is protected against direct deletion (idProtect
// changeFilter), and this command passes that guard because the change swallows the heading.
// Undoable via the editor history like any edit.
export function deleteSlideAtCursor(view: EditorView): boolean {
  if (cursorInFrontmatter(view)) return true // protected metadata — consume, no-op
  const lines = view.state.doc.toString().split('\n')
  const bs = bodyStart(lines)
  const caret = view.state.doc.lineAt(view.state.selection.main.head).number - 1
  let headingIdx = -1
  for (let i = caret; i >= bs; i -= 1) {
    if (headingLevel(lines[i]) > 0) { headingIdx = i; break }
  }
  if (headingIdx < 0) return true // not on a slide — consume, no-op
  const block = nodeBlock(lines, headingIdx)
  const from = view.state.doc.line(block.start + 1).from
  // Take the trailing newline too (unless the block ends the doc), so no blank residue is left.
  const to = block.end >= view.state.doc.lines ? view.state.doc.length : view.state.doc.line(block.end + 1).from
  view.dispatch({
    changes: { from, to, insert: '' },
    selection: EditorSelection.cursor(Math.min(from, view.state.doc.length)),
    userEvent: 'delete.slide',
    scrollIntoView: true
  })
  return true
}

export function normalizeTriggersCommand(view: EditorView): boolean {
  const old = view.state.doc.toString()
  const next = normalizeTriggerLines(old)
  if (next === old) return false // nothing to do
  const ch = minimalChange(old, next)
  view.dispatch({ changes: { from: ch.from, to: ch.to, insert: ch.insert } })
  return true
}

// Ctrl-Shift-Up / Ctrl-Shift-Down: turn the current line into a heading whose level matches
// the previous heading ('same') or is one deeper ('sub'). Works on any line (empty, text,
// list, quote) — strips the existing prefix first.
export function setHeadingFromPrevious(view: EditorView, mode: 'same' | 'sub'): boolean {
  if (cursorInFrontmatter(view)) return true // protected metadata — consume, no-op
  const lines = view.state.doc.toString().split('\n')
  const sel = view.state.selection.main
  const i = view.state.doc.lineAt(sel.head).number - 1
  let prevLevel = 0
  for (let j = i - 1; j >= 0; j--) {
    const hl = headingLevel(lines[j])
    if (hl > 0) { prevLevel = hl; break }
  }
  let newLevel = mode === 'same' ? prevLevel || 1 : prevLevel ? prevLevel + 1 : 2
  newLevel = Math.max(1, Math.min(6, newLevel))
  // strip an existing heading / list-marker / blockquote prefix to get the bare text
  const text = lines[i].replace(/^(\s*)(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)?/, '')
  lines[i] = '#'.repeat(newLevel) + ' ' + text
  return applyDoc(view, lines, i, newLevel + 1)
}

// Verifies the pure cross-container move logic. The functions below MUST match
// src/renderer/src/extensions/outliner.ts exactly (same algorithm) — this is a logic guard, since
// the renderer has no TS test runner. (Same convention as scripts/test-slide-outline.mjs.)

// ---- BEGIN MUST-MATCH (copies from outliner.ts) ----
const INDENT = '  '
const TRIGGER_LINE_RE = /^\s*(\{[^}]*\}\s*)+$/

function headingLevel(s) {
  const m = s.match(/^(#{1,6})\s/)
  return m ? m[1].length : 0
}
function leadingWidth(s) {
  const m = s.match(/^[ \t]*/)
  return m ? m[0].replace(/\t/g, INDENT).length : 0
}
function listMatch(s) {
  const m = s.match(/^([ \t]*)([-*+]|\d+[.)])\s+/)
  return m ? { indent: m[1].replace(/\t/g, INDENT).length } : null
}
function isBlank(s) {
  return /^\s*$/.test(s)
}

// Per-line fence + HTML-comment mask — mirrors 12-outline-edit.mjs structuralHeadings.
function fencedLineFlags(lines) {
  const flags = new Array(lines.length).fill(false)
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

function levelAt(lines, i, fenced) {
  if (fenced && fenced[i]) return 0
  return headingLevel(lines[i])
}

function nodeBlock(lines, i, fenced) {
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
      if (indent <= lm.indent) break
      end++
    }
    return { start: i, end, kind: 'list', level: lm.indent }
  }
  return { start: i, end: i + 1, kind: 'para', level: 0 }
}

// Invariant: cross-moves only SHALLOW the tree (delta ≤ 0); the 1–6 clamp is defence only.
function reLevelLines(block, delta, fenced) {
  if (delta === 0) return block.slice()
  return block.map((l, idx) => {
    if (fenced && fenced[idx]) return l
    const m = l.match(/^(#{1,6})(\s.*)$/)
    if (!m) return l
    const n = Math.max(1, Math.min(6, m[1].length + delta))
    return '#'.repeat(n) + m[2]
  })
}

function moveHeadingBlock(lines, i, dir, bs) {
  const fenced = fencedLineFlags(lines)
  const block = nodeBlock(lines, i, fenced)
  if (block.kind !== 'heading') return null
  if (block.start < bs) return null

  if (dir === 'down') {
    const j = block.end
    if (j >= lines.length) return null
    const boundaryLevel = levelAt(lines, j, fenced)
    if (boundaryLevel === 0 || boundaryLevel >= block.level) return null
    const moved = reLevelLines(
      lines.slice(block.start, block.end),
      boundaryLevel + 1 - block.level,
      fenced.slice(block.start, block.end)
    )
    const rest = [...lines.slice(0, block.start), ...lines.slice(block.end)]
    let insertAt = block.start + 1
    if (insertAt < rest.length && rest[insertAt].trim() !== '' && TRIGGER_LINE_RE.test(rest[insertAt])) {
      insertAt += 1
    }
    const out = [...rest.slice(0, insertAt), ...moved, ...rest.slice(insertAt)]
    return { lines: out, caret: insertAt + (i - block.start) }
  }

  let p = block.start - 1
  while (p >= bs && levelAt(lines, p, fenced) === 0) p -= 1
  if (p < bs) return null
  const parentLevel = levelAt(lines, p, fenced)
  if (parentLevel === 0 || parentLevel >= block.level) return null
  let r = p - 1
  while (r >= bs && !(levelAt(lines, r, fenced) > 0 && levelAt(lines, r, fenced) <= parentLevel)) r -= 1
  if (r < bs) return null
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
// ---- END MUST-MATCH ----

let fail = 0
const ck = (c, m) => { if (!c) { console.error('FAIL:', m); fail++ } }
const L = (s) => s.split('\n')
const S = (r) => (r === null ? null : r.lines.join('\n'))

// 1. Last #### of subsection A ⌘↓ → first child of subsection B at B's child depth (re-level 0).
{
  const lines = L('## P\n### subA\n#### a1\n#### a2\n### subB\n#### b1')
  const r = moveHeadingBlock(lines, 3, 'down', 0) // i=3 = "#### a2"
  ck(S(r) === '## P\n### subA\n#### a1\n### subB\n#### a2\n#### b1', 'last #### of A ⌘↓ → first child of B')
  ck(r && r.caret === 4 && r.lines[r.caret] === '#### a2', 'caret follows moved block (down)')
}

// 2. Re-level across different depths: #### ⌘↓ past a ## boundary → becomes ### (delta -1).
{
  const lines = L('## A\n### subA\n#### x\n## B\n### subB')
  const r = moveHeadingBlock(lines, 2, 'down', 0) // i=2 = "#### x"
  ck(S(r) === '## A\n### subA\n## B\n### x\n### subB', 'relevel across depths: #### into ## → ### first child')
  ck(r && r.lines[r.caret] === '### x', 'caret on re-levelled heading (down, relevel)')
}

// 3. ### section WITH subtree ⌘↓ past its ## parent boundary → whole subtree moves (re-level 0).
{
  const lines = L('## A\n### s1\n#### s1a\n## B\n### s2')
  const r = moveHeadingBlock(lines, 1, 'down', 0) // i=1 = "### s1", block includes "#### s1a"
  ck(S(r) === '## A\n## B\n### s1\n#### s1a\n### s2', 'section + subtree ⌘↓ into next container')
}

// 3b. Section subtree ⌘↓ that ALSO re-levels: #### section (with a ##### child) into a ## boundary
//     → whole subtree shifts up by one level (delta -1) and lands as B's first child.
{
  const lines = L('## A\n### sa\n#### s1\n##### s1a\n## B')
  const r = moveHeadingBlock(lines, 2, 'down', 0) // i=2 = "#### s1" (+ "##### s1a" child)
  ck(S(r) === '## A\n### sa\n## B\n### s1\n#### s1a', 'section + subtree ⌘↓ re-levels uniformly (delta -1)')
}

// 4. Document edges → null.
{
  ck(moveHeadingBlock(L('## A\n### x'), 1, 'down', 0) === null, 'last block ⌘↓ at EOF → null')
  ck(moveHeadingBlock(L('## A\n### x'), 0, 'up', 0) === null, 'first ## ⌘↑ → null (no-op past first section)')
  ck(moveHeadingBlock(L('## A\n### x'), 1, 'up', 0) === null, 'first child of first ## ⌘↑ → null (nothing above to receive)')
}

// 5. First #### of subsection B ⌘↑ → last child of subsection A (re-level 0).
{
  const lines = L('## P\n### subA\n#### a1\n#### a2\n### subB\n#### b1\n#### b2')
  const r = moveHeadingBlock(lines, 5, 'up', 0) // i=5 = "#### b1", first child of subB
  ck(S(r) === '## P\n### subA\n#### a1\n#### a2\n#### b1\n### subB\n#### b2', 'first #### of B ⌘↑ → last child of A')
  ck(r && r.lines[r.caret] === '#### b1', 'caret follows moved block (up)')
}

// 5b. ⌘↑ where the parent is the FIRST child → re-levels to become a sibling of the parent.
{
  const lines = L('## P\n### subB\n#### b1\n#### b2')
  const r = moveHeadingBlock(lines, 2, 'up', 0) // i=2 = "#### b1"; subB has no prev sibling → receiver = P
  ck(S(r) === '## P\n### b1\n### subB\n#### b2', '⌘↑ into grandparent → re-levels to parent sibling')
  ck(r && r.lines[r.caret] === '### b1', 'caret on re-levelled heading (up, relevel)')
}

// 6. Blank-line gaps travel with the block.
{
  const lines = L('## P\n### subA\n#### a1\n\n### subB\n#### b1')
  const r = moveHeadingBlock(lines, 2, 'down', 0) // "#### a1" block includes the trailing blank line
  ck(S(r) === '## P\n### subA\n### subB\n#### a1\n\n#### b1', 'blank-line gap preserved with moved block')
}

// 7. Frontmatter / bodyStart is never crossed: bs guards the parent/receiver walk.
{
  const lines = L('---\ntitle: X\n---\n## A\n### x')
  ck(moveHeadingBlock(lines, 4, 'up', 3) === null, 'child of first section under frontmatter ⌘↑ → null')
}

// 8. Same-level neighbour is NOT a cross-boundary case (siblingBlock handles it) — down boundary
//    must be strictly shallower. Two ### siblings: down returns null here (caller swaps instead).
{
  const lines = L('## A\n### s1\n### s2')
  ck(moveHeadingBlock(lines, 1, 'down', 0) === null, 'same-level sibling below → null (swap path, not cross)')
}

// 9. REVIEWER SCENARIO (d), byte-for-byte: ⌘↓ on a slide whose subtree contains a fenced `# fake`
//    + `#### alsofake`. The fence must travel WHOLE inside the block (never torn), fenced lines
//    must not be re-levelled, and the boundary must be the real `## B` — not the fenced fakes.
{
  const src = '## A\n### a1\n```\n# fake\n#### alsofake\n```\n## B'
  const lines = L(src)
  const r = moveHeadingBlock(lines, 1, 'down', 0) // i=1 = "### a1"
  ck(S(r) === '## A\n## B\n### a1\n```\n# fake\n#### alsofake\n```',
    'scenario (d): fence travels intact inside the crossed block, fenced lines un-re-levelled')
  ck(r && r.lines[r.caret] === '### a1', 'scenario (d): caret on moved heading')
  // Round-trip byte-identity: ⌘↑ from B's first child returns the original document exactly.
  const back = moveHeadingBlock(r.lines, r.caret, 'up', 0)
  ck(back !== null && back.lines.join('\n') === src, 'scenario (d): ⌘↓ then ⌘↑ → byte-identical original')
}

// 10. REVIEWER SCENARIO (c), byte-for-byte: ⌘↑ on `#### b1` where section A holds a fenced
//     `# fakedeck`. The receiver must be the REAL `## A` (delta −1 → `### b1`), never the fenced
//     fake deck title, and the block must land AFTER A's fence — outside it — as p's sibling.
{
  const src = '## A\n```\n# fakedeck\n```\n### p\n#### b1'
  const lines = L(src)
  const r = moveHeadingBlock(lines, 5, 'up', 0) // i=5 = "#### b1"
  ck(S(r) === '## A\n```\n# fakedeck\n```\n### b1\n### p',
    'scenario (c): receiver is real ## A; b1 → ### b1 after the fence, not inside it')
  ck(r && r.lines[r.caret] === '### b1', 'scenario (c): caret on re-levelled heading')
  // Round-trip byte-identity of the fenced region: A's fence bytes are untouched by the move.
  ck(r && r.lines.slice(1, 4).join('\n') === '```\n# fakedeck\n```',
    'scenario (c): fence region byte-identical after the move')
  // And the result offers no further cross downward (### p is a same-level sibling → swap path).
  ck(moveHeadingBlock(r.lines, 4, 'down', 0) === null, 'scenario (c): no spurious cross past a sibling')
}

// 11. Fenced heading is never a MOVE TARGET root: nodeBlock on a fenced `# fake` line is a
//     paragraph, so moveHeadingBlock refuses (the caller's paragraph fallback applies instead).
{
  const lines = L('## A\n```\n# fake\n```\n## B')
  ck(moveHeadingBlock(lines, 2, 'down', 0) === null, 'fenced # line is not a heading block root')
}

// 12. Unterminated fence: everything after the opening ``` is masked — a cross that would use a
//     "heading" beyond it finds no boundary and no-ops rather than corrupting.
{
  const lines = L('## A\n### a1\n```\n# fake\n## B')
  ck(moveHeadingBlock(lines, 1, 'down', 0) === null, 'unterminated fence masks everything below → no-op')
}

if (fail) { console.error(`\n${fail} check(s) failed`); process.exit(1) }
console.log('outliner-moves: all checks passed')

// Compare and merge a conflict copy (several-vaults ticket 10; design:
// docs/design/2026-09-29-multi-vault/architecture.md, "Conflict copies" merge paragraph, invariant 3;
// LOCKED-conflict frames 2–4).
//
// Pure text functions, no fs. The slide-block scan (`listSlideBlocks`, 12-outline-edit.mjs) and the id
// minter (`mintId`, 13-slide-ledger.mjs) are the compiler's own and are passed in (main loads the
// compiler at run time; tests import it directly); a slide's id is read only through the shared
// resolver (slide-id.mjs `resolveSlideId`).
//
//   splitGitConflict(text)                 → the two sides of a file holding Git conflict markers.
//   listSlides(text, deps)                 → the head (text before the first slide) and the slides.
//   compareVersions(a, b, deps)            → both versions' slides, each matched to its counterpart
//                                            (by slide id, else by heading) and marked `differs`.
//   mergeConflict({ kept, other, pull }, deps) → the merged outline text.
//
// Merge contract (invariant 3):
//   - `kept` is kept whole: the result is `kept` with whole slide blocks inserted between its lines,
//     and removing the inserted text gives `kept` back byte for byte.
//   - each pulled slide of `other` (indices into compareVersions' `b` / listSlides(other).slides) goes
//     straight after its counterpart's block in `kept` (after earlier pulled slides with the same
//     counterpart, in `other`'s order); a slide with no counterpart goes at the end, in `other`'s order.
//   - a pulled slide whose resolved id is already used in `kept` (the usual case: the same slide
//     edited on two machines) or by an earlier pulled slide gets a fresh id from `mintId`, written on
//     the line the resolver reads it from; nothing else in the pulled block changes. The re-stamps are
//     returned (`restamped: [{ from, to }]`) for the ledger's lineage.
import { ID_TOKEN_RE, headingTitle, resolveSlideId } from '../../compiler/scripts/lib/slide-id.mjs'

const ID_GLOBAL = new RegExp(ID_TOKEN_RE.source, 'g')
const isBlank = (line) => String(line).trim() === ''

/** Git conflict markers at line starts, outside fenced code (the rule of conflict-copies.mjs
 *  hasGitConflictMarkers). Lines outside conflict blocks go to both sides; a diff3 base section
 *  (`||||||| …` up to `=======`) goes to neither (the whole file is kept in the Trash by the merge).
 *  Returns null when the text holds no complete conflict block. Line endings are kept as they are. */
export function splitGitConflict(text) {
  if (typeof text !== 'string' || !text.includes('<<<<<<<')) return null
  const lines = text.split('\n')
  const ours = []
  const theirs = []
  let stage = 0 // 0 outside, 1 ours, 2 base, 3 theirs
  let fence = null
  let blocks = 0
  let oursLabel = null
  let theirsLabel = null
  let pending = { ours: [], theirs: [] } // an unfinished block is given back to both sides verbatim
  let raw = []
  for (const line of lines) {
    const bare = line.replace(/\r$/, '')
    if (stage === 0) {
      const run = bare.match(/^ {0,3}(`{3,}|~{3,})/)?.[1]
      if (fence) {
        if (run && run[0] === fence[0] && run.length >= fence.length && bare.trim() === run) fence = null
        ours.push(line); theirs.push(line); continue
      }
      if (run) { fence = run; ours.push(line); theirs.push(line); continue }
      if (/^<{7}( |$)/.test(bare)) {
        stage = 1
        raw = [line]
        pending = { ours: [], theirs: [] }
        if (oursLabel === null) oursLabel = bare.slice(8).trim() || null
        continue
      }
      ours.push(line); theirs.push(line)
      continue
    }
    raw.push(line)
    if (stage === 1 && /^\|{7}( |$)/.test(bare)) { stage = 2; continue }
    if ((stage === 1 || stage === 2) && /^={7}\s*$/.test(bare)) { stage = 3; continue }
    if (stage === 3 && /^>{7}( |$)/.test(bare)) {
      if (theirsLabel === null) theirsLabel = bare.slice(8).trim() || null
      ours.push(...pending.ours); theirs.push(...pending.theirs)
      blocks += 1
      stage = 0
      continue
    }
    if (stage === 1) pending.ours.push(line)
    else if (stage === 3) pending.theirs.push(line)
  }
  if (stage !== 0) { ours.push(...raw); theirs.push(...raw) } // an unclosed block is text, on both sides
  if (blocks === 0) return null
  return { ours: ours.join('\n'), theirs: theirs.join('\n'), oursLabel, theirsLabel }
}

/** The outline's head (every line before the first slide) and its slides, in order. Each slide:
 *  { index, start, end, title, occurrence, id, lines, text } — `lines` is the block with its trailing
 *  blank lines taken off; `text` those lines joined; `id` the resolver's id or null. */
export function listSlides(text, { listSlideBlocks }) {
  const all = String(text ?? '').split('\n')
  const blocks = listSlideBlocks(String(text ?? ''))
  const firstStart = blocks.length ? blocks[0].start : all.length
  const byTitle = new Map()
  const slides = blocks.map((block, index) => {
    const blockLines = all.slice(block.start, block.end)
    let n = blockLines.length
    while (n > 1 && isBlank(blockLines[n - 1])) n -= 1
    const lines = blockLines.slice(0, n)
    const title = headingTitle(block.heading)
    const occurrence = (byTitle.get(title) ?? 0) + 1
    byTitle.set(title, occurrence)
    const resolved = resolveSlideId(all, block.start, block.end)
    return { index, start: block.start, end: block.end, title, occurrence, id: resolved ? resolved.id : null, lines, text: lines.join('\n') }
  })
  const head = all.slice(0, firstStart)
  while (head.length && isBlank(head[head.length - 1])) head.pop()
  return { head: head.join('\n'), slides, lines: all }
}

const sameText = (a, b) => a.replace(/\r/g, '') === b.replace(/\r/g, '')

/** Pair each slide of `b` with its counterpart in `a`: the same resolved id first, then (among the
 *  slides still unpaired) the same heading title and occurrence order. Returns `matchOfB[i]` = index
 *  in `a` or -1, and `matchOfA` likewise. */
export function matchSlides(aSlides, bSlides) {
  const matchOfB = bSlides.map(() => -1)
  const matchOfA = aSlides.map(() => -1)
  const byId = new Map()
  aSlides.forEach((s, i) => { if (s.id && !byId.has(s.id)) byId.set(s.id, i) })
  bSlides.forEach((s, j) => {
    if (!s.id) return
    const i = byId.get(s.id)
    if (i === undefined || matchOfA[i] !== -1) return
    matchOfA[i] = j; matchOfB[j] = i
  })
  bSlides.forEach((s, j) => {
    if (matchOfB[j] !== -1) return
    const i = aSlides.findIndex((t, k) => matchOfA[k] === -1 && t.title === s.title)
    if (i === -1) return
    matchOfA[i] = j; matchOfB[j] = i
  })
  return { matchOfA, matchOfB }
}

/** Both versions' slides, each with `match` (the counterpart's index in the other version, or -1) and
 *  `differs` (no counterpart, or its text is not the same once line endings are ignored), and
 *  `headDiffers` (the text before the first slide, front matter included, is not the same). */
export function compareVersions(aText, bText, deps) {
  const a = listSlides(aText, deps)
  const b = listSlides(bText, deps)
  const { matchOfA, matchOfB } = matchSlides(a.slides, b.slides)
  const view = (slides, match, other) => slides.map((s, i) => ({
    index: s.index, id: s.id, title: s.title, text: s.text, match: match[i],
    differs: match[i] === -1 || !sameText(s.text, other[match[i]].text)
  }))
  return {
    a: view(a.slides, matchOfA, b.slides),
    b: view(b.slides, matchOfB, a.slides),
    headDiffers: !sameText(a.head, b.head)
  }
}

function dominantBlank(lines) {
  let crlf = 0
  for (let i = 0; i < lines.length - 1; i += 1) if (lines[i].endsWith('\r')) crlf += 1
  return crlf * 2 > Math.max(1, lines.length - 1) ? '\r' : ''
}

/**
 * `kept` whole, plus the slides of `other` at the indices in `pull` (see the header).
 * @returns {{ text: string, added: Array<{ from: number, after: number | null, id: string | null }>,
 *   restamped: Array<{ from: string, to: string }> }} `after` is the kept slide's index (null: at the end).
 */
export function mergeConflict({ kept, other, pull }, { listSlideBlocks, mintId, rng = Math.random }) {
  const deps = { listSlideBlocks }
  const K = listSlides(kept, deps)
  const O = listSlides(other, deps)
  const { matchOfB } = matchSlides(K.slides, O.slides)
  const wanted = [...new Set((pull ?? []).map(Number))].filter((i) => Number.isInteger(i) && i >= 0 && i < O.slides.length).sort((x, y) => x - y)
  const lines = K.lines
  if (!wanted.length) return { text: kept, added: [], restamped: [] }

  const taken = new Set([...String(kept).matchAll(ID_GLOBAL)].map((m) => m[1]))
  const avoid = new Set([...taken, ...[...String(other).matchAll(ID_GLOBAL)].map((m) => m[1])])
  const restamped = []
  const added = []
  const groups = new Map() // kept slide index (or -1 for the end) → pulled line blocks
  for (const j of wanted) {
    const slide = O.slides[j]
    const block = slide.lines.slice()
    const resolved = resolveSlideId(block, 0, block.length)
    let id = resolved ? resolved.id : null
    if (resolved && taken.has(resolved.id)) {
      const fresh = mintId(rng, avoid)
      avoid.add(fresh)
      block[resolved.line] = block[resolved.line].replace(ID_TOKEN_RE, `{id=${fresh}}`)
      restamped.push({ from: resolved.id, to: fresh })
      id = fresh
    }
    if (id) taken.add(id)
    const after = matchOfB[j]
    added.push({ from: j, after: after === -1 ? null : after, id })
    const key = after === -1 ? -1 : after
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(block)
  }

  const blank = dominantBlank(lines)
  const terminated = lines.length > 0 && lines[lines.length - 1] === ''
  // Where each group goes, as a line index to insert before. Groups that land on the same line (the
  // last kept slide's and the end's) are one run there: the kept slide's first, then the end's.
  const at = new Map()
  const order = [...groups.keys()].sort((x, y) => (x === -1 ? Infinity : x) - (y === -1 ? Infinity : y))
  for (const after of order) {
    const eof = after === -1 || K.slides[after].end >= lines.length
    const pos = eof ? (terminated ? lines.length - 1 : lines.length) : K.slides[after].end
    if (!at.has(pos)) at.set(pos, { eof, blocks: [] })
    at.get(pos).blocks.push(...groups.get(after))
  }
  const out = lines.slice()
  for (const pos of [...at.keys()].sort((x, y) => y - x)) {
    const { eof, blocks } = at.get(pos)
    const prevBlank = pos > 0 && isBlank(lines[pos - 1])
    const chunk = []
    blocks.forEach((block, n) => {
      if (n > 0 || !prevBlank) chunk.push(blank)
      chunk.push(...block)
    })
    if (!eof && prevBlank) chunk.push(blank)
    out.splice(pos, 0, ...chunk)
  }
  return { text: out.join('\n'), added, restamped }
}

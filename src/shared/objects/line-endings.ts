// Line endings for a card body edited in a text field (ADR-0042: unchanged segments keep their bytes;
// review R1 of a02a05f2). A text field hands back LF only, so the original endings are put back on
// every line the edit did not change, wherever it sits: the lines are matched to the original by a
// longest common subsequence (the order-preserving match a diff makes), so an untouched line between
// two edits, and each of several identical lines, keeps its own ending. Lines with no match (new or
// changed) take the body's ending: CRLF when any original line has one.
//
// Bounded and exact (review R1 of a222975a): the common prefix and suffix are matched directly; the
// rest by an LCS table while it stays under MAX_CELLS, else by a shortest edit script (Myers) while it
// needs at most MAX_EDITS line edits and MAX_STEPS comparisons. Both are true diffs, so a long run of
// identical lines with mixed endings keeps every untouched line's ending. When neither bound holds the
// match is not attempted: restoreLineEndings answers null and the caller refuses the commit, unless every
// line's ending would come out the same whatever the match (no CR, or every line CRLF).
// Pure: no DOM.

const MAX_CELLS = 1_000_000
const MAX_EDITS = 1000
const MAX_STEPS = 20_000_000

/** For each line of `b`, the index of the line of `a` it is matched to as unchanged, or -1; null when the diff is past its bounds. */
export function matchLines(a: readonly string[], b: readonly string[]): number[] | null {
  const map = new Array<number>(b.length).fill(-1)
  return matchRange(a, b, 0, a.length, 0, b.length, map) ? map : null
}

function matchRange(a: readonly string[], b: readonly string[], a0: number, a1: number, b0: number, b1: number, map: number[]): boolean {
  while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) map[b0++] = a0++
  while (a0 < a1 && b0 < b1 && a[a1 - 1] === b[b1 - 1]) map[--b1] = --a1
  if (a0 === a1 || b0 === b1) return true
  if ((a1 - a0 + 1) * (b1 - b0 + 1) <= MAX_CELLS) {
    lcs(a, b, a0, a1, b0, b1, map)
    return true
  }
  return shortestEdit(a, b, a0, a1, b0, b1, map)
}

function lcs(a: readonly string[], b: readonly string[], a0: number, a1: number, b0: number, b1: number, map: number[]): void {
  const n = a1 - a0
  const m = b1 - b0
  const w = m + 1
  // table[i * w + j] = LCS length of a[a0+i..a1) and b[b0+j..b1)
  const table = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * w + j] = a[a0 + i] === b[b0 + j]
        ? table[(i + 1) * w + j + 1] + 1
        : Math.max(table[(i + 1) * w + j], table[i * w + j + 1])
    }
  }
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[a0 + i] === b[b0 + j]) { map[b0 + j] = a0 + i; i += 1; j += 1 }
    else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) i += 1
    else j += 1
  }
}

/**
 * Myers' O(ND) shortest edit script over a[a0..a1) and b[b0..b1): the matched lines of a minimal diff
 * written into `map`. False, with `map` untouched in this range, when it needs more than MAX_EDITS edits
 * or MAX_STEPS comparisons.
 */
function shortestEdit(a: readonly string[], b: readonly string[], a0: number, a1: number, b0: number, b1: number, map: number[]): boolean {
  const n = a1 - a0
  const m = b1 - b0
  const max = Math.min(n + m, MAX_EDITS)
  const off = max + 1
  const v = new Int32Array(2 * max + 3)
  // trace[d] = v before step d, for diagonals -d-1..d+1 (index k + d + 1).
  const trace: Int32Array[] = []
  let steps = 0
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice(off - d - 1, off + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[a0 + x] === b[b0 + y]) { x += 1; y += 1; steps += 1 }
      steps += 1
      if (steps > MAX_STEPS) return false
      v[off + k] = x
      if (x >= n && y >= m) {
        for (let e = d; e > 0; e -= 1) {
          const prev = trace[e]
          const at = (kk: number): number => prev[kk + e + 1]
          const kNow = x - y
          const kPrev = kNow === -e || (kNow !== e && at(kNow - 1) < at(kNow + 1)) ? kNow + 1 : kNow - 1
          const xPrev = at(kPrev)
          const yPrev = xPrev - kPrev
          while (x > xPrev && y > yPrev) { x -= 1; y -= 1; map[b0 + y] = a0 + x }
          x = xPrev
          y = yPrev
        }
        while (x > 0 && y > 0) { x -= 1; y -= 1; map[b0 + y] = a0 + x }
        return true
      }
    }
  }
  return false
}

/**
 * `edited` (LF only, from a text field) with the original ending back on every line matched as
 * unchanged to a line of `original`; other lines take the body's ending. The last line has no ending.
 * Null when the lines cannot be matched within the bounds and the endings are mixed, so writing would
 * risk an untouched line's ending: the caller writes nothing.
 */
export function restoreLineEndings(original: string, edited: string): string | null {
  const o = original.split('\n')
  const e = edited.split('\n')
  const bare = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line)
  const cr = original.includes('\r\n') ? '\r' : ''
  const lastO = o.length - 1
  let map = matchLines(o.map(bare), e)
  if (!map) {
    // Unmatched, every line takes the body's ending; that is exact only when every original line has it.
    if (o.some((line, i) => (i < lastO ? bare(line) + cr !== line : line.endsWith('\r')))) return null
    map = new Array<number>(e.length).fill(-1)
  }
  const matched = map
  return e.map((line, i) => {
    const j = matched[i]
    if (i === e.length - 1) return j === lastO ? o[j] : line
    if (j >= 0 && j < lastO) return o[j]
    return `${line}${cr}`
  }).join('\n')
}

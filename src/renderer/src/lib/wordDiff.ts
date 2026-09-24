// Word-level diff for the Clean review's side-by-side evaluation.
// A cleaned slide is judged against its raw original before Approve/Reject, so
// the reviewer must see *what changed*. The diff is an aid on top of two
// full, readable columns — it should surface genuine edits (disfluencies
// dropped, names fixed, words substituted), not cosmetic churn.

export type DiffKind = 'same' | 'removed' | 'added'
export interface DiffToken {
  text: string
  kind: DiffKind
}
export interface WordDiff {
  original: DiffToken[]
  suggested: DiffToken[]
}

const tokenize = (value: string): string[] => value.split(/\s+/).filter(Boolean)

// Equality key: lower-cased with surrounding punctuation stripped, so that
// adding a comma or capitalising a sentence start reads as *unchanged* and
// only real word insertions/deletions/substitutions surface. A punctuation-only
// token (e.g. an em dash) keeps its raw lower-cased form so it doesn't
// spuriously match every other punctuation token.
const eqKey = (token: string): string => {
  const stripped = token
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N}]+$/u, '')
  return stripped || token.toLowerCase()
}

/**
 * Compute a word-level diff between the raw original and the agent's suggestion.
 * Returns one token array per column: original tokens tagged `same`/`removed`,
 * suggested tokens tagged `same`/`added`. Pure and dependency-free.
 */
export function diffWords(original: string, suggested: string): WordDiff {
  const a = tokenize(original)
  const b = tokenize(suggested)
  const ka = a.map(eqKey)
  const kb = b.map(eqKey)
  const n = a.length
  const m = b.length

  // Longest-common-subsequence length table (suffix form: lcs[i][j] = LCS of
  // a[i..] and b[j..]) so a forward walk can reconstruct the alignment.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = ka[i] === kb[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }

  const originalTokens: DiffToken[] = []
  const suggestedTokens: DiffToken[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (ka[i] === kb[j]) {
      originalTokens.push({ text: a[i], kind: 'same' })
      suggestedTokens.push({ text: b[j], kind: 'same' })
      i++
      j++
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      originalTokens.push({ text: a[i], kind: 'removed' })
      i++
    } else {
      suggestedTokens.push({ text: b[j], kind: 'added' })
      j++
    }
  }
  while (i < n) {
    originalTokens.push({ text: a[i], kind: 'removed' })
    i++
  }
  while (j < m) {
    suggestedTokens.push({ text: b[j], kind: 'added' })
    j++
  }
  return { original: originalTokens, suggested: suggestedTokens }
}

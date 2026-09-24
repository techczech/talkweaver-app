import { TRIGGER_LINE_RE } from '../../compiler/scripts/lib/trigger-tokenizer.mjs'
import {
  scanFencedLines as compilerFenceLineScan,
  type MarkdownFenceOpening
} from '../../compiler/scripts/lib/03-object-token.mjs'
import { meaningForToken, parseTriggerLine, type TriggerToken } from './trigger-line.ts'

export interface FenceExtent {
  opening: MarkdownFenceOpening
  start: number
  /** Exclusive body boundary: the closing-marker line, reset boundary, or lines.length. */
  bodyEnd: number
  /** Exclusive flagged span. A reset boundary is not part of the fence. */
  end: number
  closed: boolean
}

export interface FenceLineScanOptions {
  /**
   * Reset only an otherwise unterminated fence at this structural boundary. A fence with a valid
   * later close remains opaque, so heading-shaped code inside a complete fence stays code.
   */
  resetAtLine?: (line: string, index: number) => boolean
}

/**
 * The shared structural fence scan: compiler-owned marker parsing plus the editor's sequential
 * HTML-comment opacity. Consumers that already split input by slide omit resetAtLine; the Doctor,
 * which scans a whole document, supplies the compiler's slide-heading boundary.
 */
export const scanFencedLines = compilerFenceLineScan as (
  lines: readonly string[],
  options?: FenceLineScanOptions
) => { flags: boolean[]; extents: FenceExtent[] }

// Per-line fence + HTML-comment mask. Fence extent delegates to the compiler authority used by the
// Markdown lexer and slide-script parser: backticks and tildes, same-character closes, and a closing
// marker at least as long as its opener. A flagged line is invisible to structural decisions, so
// heading- and Trigger-shaped code is never rewritten by editor write paths. Both marker lines are
// flagged too, so a fence travels whole inside its block.
export function fencedLineFlags(lines: string[]): boolean[] {
  return scanFencedLines(lines).flags
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
      j < lines.length
      && !fenced[j]
      && lines[j].trim() !== ''
      && TRIGGER_LINE_RE.test(lines[j].replace(/\r$/, '').trim())
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

/**
 * Position-only pass (silent, ADR-0020 D4): pull title-line braces down and make an existing
 * Trigger line adjacent to its heading. Authored tokens are never added, removed, reordered
 * or rewritten.
 */
export function normalizePositions(text: string): string {
  const normalized = normalizeTriggerLines(text)
  const lines = normalized.split('\n')
  const fenced = fencedLineFlags(lines)
  const out: string[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    const isCleanSlideHeading =
      !fenced[i]
      && /^#{2,6} /.test(line)
      && !TRAILING_BRACES_RE.test(line)
    if (!isCleanSlideHeading) {
      out.push(line)
      i += 1
      continue
    }

    let triggerIndex = i + 1
    while (triggerIndex < lines.length && lines[triggerIndex].replace(/\r$/, '').trim() === '') {
      triggerIndex += 1
    }
    const hasSeparatedTrigger =
      triggerIndex > i + 1
      && triggerIndex < lines.length
      && !fenced[triggerIndex]
      && TRIGGER_LINE_RE.test(lines[triggerIndex].replace(/\r$/, '').trim())
    if (!hasSeparatedTrigger) {
      out.push(line)
      i += 1
      continue
    }

    out.push(line)
    out.push(lines[triggerIndex])
    i = triggerIndex + 1
  }

  return out.join('\n')
}

function removeDuplicateLayoutTokens(line: string): { line: string; keptLayout: string | null } {
  const tokens = parseTriggerLine(line)
  const layouts = tokens.filter((token) =>
    meaningForToken(token.raw).some((pair) => pair.key === 'layout')
  )
  if (layouts.length < 2) return { line, keptLayout: null }

  const kept = layouts.at(-1)!
  const keptLayout = meaningForToken(kept.raw).find((pair) => pair.key === 'layout')?.value
  const removals = new Set<TriggerToken>(layouts.slice(0, -1))
  const grouped = new Map<number, TriggerToken[]>()
  for (const token of tokens) {
    const peers = grouped.get(token.groupStart) ?? []
    peers.push(token)
    grouped.set(token.groupStart, peers)
  }

  const edits: Array<{ start: number; end: number }> = []
  const removedGroups = new Set<number>()
  for (const token of removals) {
    const peers = grouped.get(token.groupStart) ?? []
    if (peers.every((peer) => removals.has(peer))) {
      if (removedGroups.has(token.groupStart)) continue
      let start = token.groupStart
      while (start > 0 && line[start - 1] === ' ') start -= 1
      edits.push({ start, end: token.groupEnd })
      removedGroups.add(token.groupStart)
    } else {
      edits.push({ start: token.start, end: token.end })
    }
  }

  let result = line
  for (const edit of edits.sort((left, right) => right.start - left.start || right.end - left.end)) {
    result = result.slice(0, edit.start) + result.slice(edit.end)
  }
  return { line: result, keptLayout: keptLayout == null ? kept.raw : String(keptLayout) }
}

/**
 * Token-changing pass (flagged, ADR-0020 D4): collapse duplicate layout tokens to the final
 * authored layout, matching the compiler's last-wins semantics. Automatic save paths never run it.
 */
export function collapseDuplicateLayouts(text: string): { text: string; tokenChanges: string[] } {
  const lines = text.split('\n')
  const fenced = fencedLineFlags(lines)
  const tokenChanges: string[] = []
  const normalized = lines.map((line, index) => {
    if (fenced[index]) return line
    const isTriggerLine = TRIGGER_LINE_RE.test(line.replace(/\r$/, '').trim())
    const isHeadingWithTrailingGroups = /^#{2,6} /.test(line) && TRAILING_BRACES_RE.test(line)
    if (!isTriggerLine && !isHeadingWithTrailingGroups) return line
    const collapsed = removeDuplicateLayoutTokens(line)
    if (collapsed.keptLayout) tokenChanges.push(`duplicate-layout:${collapsed.keptLayout}`)
    return collapsed.line
  })
  return { text: normalized.join('\n'), tokenChanges }
}

const DUPLICATE_KEY_EXCLUSIONS = new Set(['layout', 'from', 'clonedFrom'])

function removeDuplicateKeyTokens(line: string): { line: string; tokenChanges: string[] } {
  const tokens = parseTriggerLine(line)
  if (tokens.length < 2) return { line, tokenChanges: [] }

  const seenKeys = new Set<string>()
  const finalValues = new Map<string, string | boolean>()
  const removals = new Set<TriggerToken>()
  const changesByToken = new Map<TriggerToken, string[]>()

  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]
    const meaning = meaningForToken(token.raw)
    const keys = meaning.map((pair) => pair.key)
    const excluded = keys.some((key) => DUPLICATE_KEY_EXCLUSIONS.has(key))
    const fullyShadowed = meaning.length > 0 && meaning.every((pair) => seenKeys.has(pair.key))

    if (!excluded && fullyShadowed) {
      removals.add(token)
      changesByToken.set(token, meaning.map((pair) =>
        `duplicate-key:${pair.key}:${String(finalValues.get(pair.key) ?? pair.value)}`
      ))
      continue
    }

    for (const pair of meaning) {
      if (!seenKeys.has(pair.key)) finalValues.set(pair.key, pair.value)
      seenKeys.add(pair.key)
    }
  }

  if (removals.size === 0) return { line, tokenChanges: [] }

  const grouped = new Map<number, TriggerToken[]>()
  for (const token of tokens) {
    const peers = grouped.get(token.groupStart) ?? []
    peers.push(token)
    grouped.set(token.groupStart, peers)
  }

  const edits: Array<{ start: number; end: number }> = []
  const removedGroups = new Set<number>()
  for (const token of removals) {
    const peers = grouped.get(token.groupStart) ?? []
    if (peers.every((peer) => removals.has(peer))) {
      if (removedGroups.has(token.groupStart)) continue
      let start = token.groupStart
      let end = token.groupEnd
      const lineLeading = line.slice(0, token.groupStart).trim() === ''
      const trailingGroupRun = line.match(/\{[^}]*\}(?:[ \t]*\{[^}]*\})*[ \t]*$/)
      const firstHeadingGroup =
        /^#{2,6}\s/.test(line)
        && trailingGroupRun?.index === token.groupStart
      if (lineLeading || firstHeadingGroup) {
        while (end < line.length && (line[end] === ' ' || line[end] === '\t')) end += 1
      } else {
        while (start > 0 && (line[start - 1] === ' ' || line[start - 1] === '\t')) start -= 1
      }
      edits.push({ start, end })
      removedGroups.add(token.groupStart)
      continue
    }

    // Keep a partially emptied brace group readable without rewriting any surviving token.
    // The tokeniser treats commas and whitespace as separators, so the removed token must take
    // one adjacent separator run with it rather than leaving `{,next}` or `{ next}` behind.
    let end = token.end
    while (
      end < token.groupEnd - 1
      && (line[end] === ' ' || line[end] === '\t' || line[end] === ',')
    ) end += 1
    let start = token.start
    if (end === token.end) {
      while (
        start > token.groupStart + 1
        && (line[start - 1] === ' ' || line[start - 1] === '\t' || line[start - 1] === ',')
      ) start -= 1
    }
    edits.push({ start, end })
  }

  let result = line
  for (const edit of edits.sort((left, right) => right.start - left.start || right.end - left.end)) {
    result = result.slice(0, edit.start) + result.slice(edit.end)
  }
  const tokenChanges = [...removals]
    .sort((left, right) => left.start - right.start)
    .flatMap((token) => changesByToken.get(token) ?? [])
  return { line: result, tokenChanges }
}

/**
 * Token-changing pass (flagged, ADR-0020 D4): collapse duplicate same-key tokens to the final
 * authored value, matching compiler last-wins semantics. Layouts retain their dedicated report,
 * and provenance tokens are never rewritten. Automatic save paths never run this pass.
 */
export function collapseDuplicateKeys(text: string): { text: string; tokenChanges: string[] } {
  const lines = text.split('\n')
  const fenced = fencedLineFlags(lines)
  const tokenChanges: string[] = []
  const normalized = lines.map((line, index) => {
    if (fenced[index]) return line
    const isTriggerLine = TRIGGER_LINE_RE.test(line.replace(/\r$/, '').trim())
    const isHeadingWithTrailingGroups = /^#{2,6} /.test(line) && TRAILING_BRACES_RE.test(line)
    if (!isTriggerLine && !isHeadingWithTrailingGroups) return line
    const collapsed = removeDuplicateKeyTokens(line)
    tokenChanges.push(...collapsed.tokenChanges)
    return collapsed.line
  })
  return { text: normalized.join('\n'), tokenChanges }
}

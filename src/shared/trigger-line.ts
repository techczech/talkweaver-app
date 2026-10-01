import { GLOBAL_OPTION_GROUPS, LAYOUTS, systemTokens } from './layout-registry/entries.ts'
import type { LayoutDef, OptionGroup } from './layout-registry/entries.ts'
import { appliesToHoldsOnTokens, registryOptionGroups } from './layout-registry/options.ts'
import { LIST_VALUE_KEYS, TRIGGER_LINE_RE, tokenizeTriggerBody as tokenizeBody } from '../../compiler/scripts/lib/trigger-tokenizer.mjs'
import { parseTriggerLine as parseCompilerTriggerLine } from '../../compiler/scripts/lib/02-triggers-layout.mjs'
import { duplicateIdWarning, idTokensToKeep, resolveSlideId } from '../../compiler/scripts/lib/slide-id.mjs'
import { chartObjectTokenAt } from '../../compiler/scripts/lib/03-object-token.mjs'
import { formatWarning } from '../../compiler/scripts/lib/warning-registry.mjs'
import {
  STATEMENT_DEFAULTS, STATEMENT_DIMENSION_KEYS, resolveStatementOptions, statementDimensionTokens, type StatementDimension
} from '../../compiler/scripts/lib/statement-options.mjs'

export { LIST_VALUE_KEYS, TRIGGER_LINE_RE }
export { GLOBAL_OPTION_GROUPS }

/** Every heading level that participates in the heading-is-slide protected-line law. */
export const PROTECTED_HEADING_RE = /^#{2,6} /

export interface TriggerToken {
  raw: string
  source: string
  start: number
  end: number
  groupStart: number
  groupEnd: number
}

export function tokenizeTriggerBody(body: string, offset = 0, groupStart = offset - 1, groupEnd = offset + body.length + 1): TriggerToken[] {
  return tokenizeBody(body).map((token) => ({
    ...token,
    start: offset + token.start,
    end: offset + token.end,
    groupStart,
    groupEnd
  }))
}

function trailingGroups(line: string): Array<{ start: number; end: number; bodyStart: number; body: string }> {
  let cursor = line.length
  while (cursor > 0 && /\s/.test(line[cursor - 1])) cursor -= 1
  const groups: Array<{ start: number; end: number; bodyStart: number; body: string }> = []
  while (cursor > 0) {
    const prefix = line.slice(0, cursor)
    const match = prefix.match(/\{([^}]*)\}$/)
    if (!match || match.index == null) break
    groups.unshift({ start: match.index, end: cursor, bodyStart: match.index + 1, body: match[1] })
    cursor = match.index
    while (cursor > 0 && /\s/.test(line[cursor - 1])) cursor -= 1
  }
  return groups
}

function allGroups(line: string): Array<{ start: number; end: number; bodyStart: number; body: string }> {
  return [...line.matchAll(/\{([^}]*)\}/g)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    bodyStart: match.index + 1,
    body: match[1]
  }))
}

export function parseTriggerGroups(line: string): TriggerToken[] {
  return trailingGroups(line).flatMap((group) => tokenizeTriggerBody(group.body, group.bodyStart, group.start, group.end))
}

/** Parse the authored Trigger line without normalising any source bytes (ADR-0010). */
export function parseTriggerLine(line: string): TriggerToken[] {
  return parseTriggerGroups(line)
}

type TokenMeaning = Array<{ key: string; value: string | boolean }>

function targetForEntry(entry: LayoutDef): TokenMeaning {
  if (entry.resolvesTo) return [entry.resolvesTo]
  if (entry.kind === 'layout') return [{ key: 'layout', value: entry.name }]
  return [{ key: entry.name, value: true }]
}

export function meaningForToken(raw: string): TokenMeaning {
  const equals = raw.indexOf('=')
  if (equals > 0) return [{ key: raw.slice(0, equals), value: raw.slice(equals + 1) }]

  for (const entry of LAYOUTS) {
    // Keep this fenced-entry carve-out aligned with vocabulary.ts, generate-trigger-dictionary.mjs, and test-layout-registry-parity.mjs.
    if (!entry.trigger.startsWith('{')) continue
    if (entry.triggerWords.includes(raw)) return targetForEntry(entry)
    for (const alias of entry.bareAliases ?? []) {
      if (alias.word === raw) return [{ key: alias.key, value: alias.value }]
    }
    for (const pattern of entry.dynamicPatterns ?? []) {
      const match = new RegExp(pattern.source).exec(raw)
      if (match) {
        return pattern.resolution.map(({ key, value }) => ({
          key,
          value: value.replace(/\$(\d+)/g, (_whole, index) => match[Number(index)] ?? '')
        }))
      }
    }
  }
  return [{ key: raw, value: true }]
}

function sameMeaning(left: TokenMeaning, right: TokenMeaning): boolean {
  if (left.length !== right.length) return false
  return left.every((pair) => right.some((candidate) =>
    candidate.key === pair.key && candidate.value === pair.value
  ))
}

/** Bytes no option token may carry: they close or open a `{…}` group, or end the Trigger line. */
const UNSAFE_TOKEN_BYTES = /[{}\r\n]/

/** Whether `token` is a value of `group` a commit may write: a registry value ('' = the group's
 *  default), or a raw-valued token the group owns (a number, a reactions list) that stays inside one
 *  `{…}` group on one line. */
export function isOptionTokenForGroup(token: string, group: OptionGroup): boolean {
  if (typeof token !== 'string' || UNSAFE_TOKEN_BYTES.test(token)) return false
  return group.values.some((value) => value.token === token) || optionValueForToken(token, group) !== undefined
}

function optionValueForToken(raw: string, group: OptionGroup): string | undefined {
  // Ticket 04: every `reactions=` token the compiler reads is the Reactions group's value (the
  // authored bytes are the value; the Audience section reads its meaning with readReactionsValue).
  // A token is one `{…}` group on one line: bytes that would close the group, open another or end
  // the line are never a value (they would let a "value" write new tokens or new outline lines).
  if (group.reactionsKey && raw.startsWith(group.reactionsKey + '=') && raw.length > group.reactionsKey.length + 1) {
    return UNSAFE_TOKEN_BYTES.test(raw) ? undefined : raw
  }
  if (group.numberKey && raw.startsWith(group.numberKey + '=')) {
    const value = raw.slice(group.numberKey.length + 1)
    if (group.allowUnlimited && value === 'unlimited') return raw
    if (/^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value))) return raw
  }
  const meaning = meaningForToken(raw)
  // An alt token is another authored form of the SAME button (T32: Plain also means {plainlist}),
  // so it selects the button's canonical token — the row reads it, a rival commit sweeps it.
  return group.values.find((value) =>
    (Boolean(value.token) && sameMeaning(meaning, meaningForToken(value.token)))
    || (value.altTokens ?? []).some((alt) => sameMeaning(meaning, meaningForToken(alt)))
  )?.token
}

/** Whether the line carries ANY token this option group owns — the empty-token default included
 *  (T32: a `{plainlist}` override must read as authored, not as "following the deck"). */
export function groupHasSelection(line: string, group: OptionGroup): boolean {
  return parseAllGroups(line).some((token) => optionValueForToken(token.raw, group) !== undefined)
}

function parseAllGroups(line: string): TriggerToken[] {
  return allGroups(line).flatMap((group) =>
    tokenizeTriggerBody(group.body, group.bodyStart, group.start, group.end)
  )
}

export interface LogicalTriggerBlock {
  /** Zero-based first Trigger-only line. */
  start: number
  /** Zero-based exclusive end of the consecutive Trigger-only block. */
  end: number
  /** Canonical one-line rendering, with duplicate ids collapsed to the slide's resolved id. */
  line: string
  warnings: string[]
}

/**
 * Read the one logical Trigger block below a heading. Blank lines before the block are tolerated;
 * once it starts, every consecutive Trigger-only line belongs to it — except that a chart token owning
 * the list below it (chartObjectTokenAt) is a content object and ends the block, exactly where the
 * compiler tree's block ends (14-outline-tree.mjs furtherTriggerLines). Token order is preserved,
 * except that several slide ids collapse to the one the shared resolver (slide-id.mjs) reads for
 * the slide — the heading's own id, else the LAST in the block — so the merge never changes the
 * slide's id. The ids set aside are reported: `duplicate-slide-id-merged:kept a2, dropped a1 (Title)`.
 */
export function logicalTriggerBlockAfterHeading(lines: readonly string[], headingIndex: number): LogicalTriggerBlock | null {
  let start = headingIndex + 1
  while (start < lines.length && lines[start].replace(/\r$/, '').trim() === '') start += 1
  if (start >= lines.length || !TRIGGER_LINE_RE.test(lines[start].replace(/\r$/, '').trim())) return null

  let end = start
  const tokens: TriggerToken[] = []
  while (end < lines.length) {
    const line = lines[end].replace(/\r$/, '')
    if (!TRIGGER_LINE_RE.test(line.trim())) break
    if (end > start && chartObjectTokenAt(lines, end)) break
    tokens.push(...parseAllGroups(line))
    end += 1
  }

  const { keep, kept, dropped } = idTokensToKeep(tokens.map((token) => token.raw), resolveSlideId(lines, headingIndex), headingIndex)
  // Each token keeps its authored bytes (`source`): a quoted value ({kicker="A, B"},
  // {reactions="Too fast","Just right"}) must stay quoted, or it would re-read as several tokens.
  const rendered = tokens
    .filter((token, index) => !/^id=[A-Za-z0-9_-]+$/.test(token.raw) || keep.has(index))
    .map((token) => `{${token.source}}`)
    .join('')
  return {
    start,
    end,
    line: rendered,
    warnings: dropped.length && kept ? [duplicateIdWarning(kept, dropped, lines[headingIndex] ?? '')] : []
  }
}

/**
 * The one surface for what a Trigger-block merge set aside (`duplicate-slide-id-merged:…`): the warning
 * register's words in the log, never a modal. The editor's ↵, the Inspector, the ⌘L option commits and
 * the layout picker's verbs all report here.
 */
export function reportTriggerMergeWarnings(warnings: readonly string[], log: (message: string) => void = console.warn): void {
  for (const warning of warnings) log(`[trigger-merge] ${formatWarning(warning)}`)
}

/**
 * Dominik ruling, 2026-07-29: where Enter from any protected structural line lands. Returns the
 * existing first body line after the logical Trigger block, or requests a fresh line only when
 * another heading or EOF means that no body line exists.
 * Null when the heading has no Trigger block — callers fall through to default Enter.
 */
export function caretLineAfterTriggerBlock(
  lines: readonly string[],
  headingIndex: number
): { targetLine: number; insertBlankAt: number | null } | null {
  const block = logicalTriggerBlockAfterHeading(lines, headingIndex)
  if (!block) return null
  const next = block.end
  if (
    next < lines.length
    && !/^#{1,6}\s/.test(lines[next].replace(/\r$/, ''))
  ) {
    return { targetLine: next, insertBlankAt: null }
  }
  return { targetLine: next, insertBlankAt: next }
}

/** Whether this heading owns a later, deeper heading before the next peer/ancestor heading. */
export function headingHasChildSlides(lines: readonly string[], headingIndex: number): boolean {
  const ownLevel = lines[headingIndex]?.match(/^(#{1,6})\s/)?.[1].length
  if (!ownLevel) return false
  let inFence = false
  let fenceMark = ''
  let inComment = false
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()
    const visibleAtStart = !inComment
    if (!inFence) {
      let position = 0
      for (;;) {
        if (inComment) {
          const close = line.indexOf('-->', position)
          if (close < 0) break
          inComment = false
          position = close + 3
        } else {
          const open = line.indexOf('<!--', position)
          if (open < 0) break
          inComment = true
          position = open + 4
        }
      }
    }
    if (!visibleAtStart) continue
    if (inFence) {
      const close = trimmed.match(/^(`{3,})\s*$/)
      if (close && close[1].length >= fenceMark.length) { inFence = false; fenceMark = '' }
      continue
    }
    const open = trimmed.match(/^(`{3,})/)
    if (open) { inFence = true; fenceMark = open[1]; continue }
    const level = line.match(/^(#{1,6})\s/)?.[1].length
    if (!level) continue
    return level > ownLevel
  }
  return false
}

export function selectionForGroup(line: string, group: OptionGroup): string {
  let selection = ''
  for (const token of parseAllGroups(line)) {
    const value = optionValueForToken(token.raw, group)
    if (value !== undefined) selection = value
  }
  return selection
}

type SpanEdit = { start: number; end: number; text: string }

function applySpanEdits(line: string, edits: SpanEdit[]): string {
  let result = line
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  }
  return result
}

/**
 * Removal edits for `members` (tokens of one option group). A visual `{…}` group whose every
 * token belongs goes whole — and takes the spaces that separated it with it, so a removal never
 * leaves a trailing, doubled or leading space: the Trigger line is written byte-for-byte back
 * into the author's file. A group with foreign peers loses only the member token spans.
 */
function groupRemovalEdits(line: string, members: TriggerToken[], tokens: TriggerToken[], belongs: (raw: string) => boolean): SpanEdit[] {
  const grouped = new Map<number, TriggerToken[]>()
  for (const candidate of tokens) {
    const current = grouped.get(candidate.groupStart) ?? []
    current.push(candidate)
    grouped.set(candidate.groupStart, current)
  }
  const edits: SpanEdit[] = []
  const removedGroups = new Set<number>()
  for (const candidate of members) {
    const peers = grouped.get(candidate.groupStart) ?? []
    if (peers.every((peer) => belongs(peer.raw))) {
      if (!removedGroups.has(candidate.groupStart)) {
        let start = candidate.groupStart
        while (start > 0 && line[start - 1] === ' ') start -= 1
        let end = candidate.groupEnd
        // A removal that ends the line — a group at the very start, or the stale-token-then-
        // trailing-space shape the shipped bug saved into Dominik's file — takes the spaces that
        // would otherwise be left behind with it.
        if (start === 0 || !line.slice(end).trim()) while (end < line.length && line[end] === ' ') end += 1
        edits.push({ start, end, text: '' })
        removedGroups.add(candidate.groupStart)
      }
    } else {
      edits.push({ start: candidate.start, end: candidate.end, text: '' })
    }
  }
  return edits
}

/**
 * ADR-0020 §5 invariant, commit side: after an Inspector commit, the Trigger line carries no
 * token belonging to an option group whose `appliesTo` the resulting line no longer satisfies.
 * The case that proved the rule (T28, Dominik): a list-style commit away from {iconlist}
 * orphans a stale {iconlist=…} treatment token — invisible in the Inspector (the treatment
 * group no longer applies, so no control shows it) while it still decides the render. The
 * sweep reads relevance through the registry's own declarations (`appliesToHoldsOnTokens`),
 * never group-name `if`s. The committed group is exempt — its tokens were just decided by the
 * author — and removals can only make further declarations inapplicable, so sweep to a fixed
 * point.
 */
function sweepOrphanOptionTokens(line: string, committed: OptionGroup, context: OptionCommitContext): string {
  let result = line
  const groups = registryOptionGroups()
  for (let pass = 0; pass <= groups.length; pass += 1) {
    const unwritten = context.unwrittenSelections?.(result) ?? {}
    const selectedTokens: Record<string, string> = {}
    for (const candidate of groups) {
      selectedTokens[candidate.key] = groupHasSelection(result, candidate)
        ? selectionForGroup(result, candidate)
        : unwritten[candidate.key] ?? ''
    }
    const tokens = parseAllGroups(result)
    const edits: SpanEdit[] = []
    for (const candidate of groups) {
      if (candidate === committed) continue
      if (appliesToHoldsOnTokens(candidate, selectedTokens)) continue
      const members = tokens.filter((token) => optionValueForToken(token.raw, candidate) !== undefined)
      edits.push(...groupRemovalEdits(result, members, tokens, (raw) => optionValueForToken(raw, candidate) !== undefined))
    }
    if (edits.length === 0) break
    result = applySpanEdits(result, edits)
  }
  return result
}

/**
 * What the sweep reads for a group the line does not write (T32): the value the slide gets anyway.
 * The Inspector passes the deck's List style choice, so a treatment token on a slide whose icons
 * come from `defaults: { icons: on }` is relevant and survives. Called on each line the sweep
 * produces, because the answer can depend on the line (`{icons=off}`).
 */
export interface OptionCommitContext {
  unwrittenSelections?: (line: string) => Readonly<Record<string, string>>
  /**
   * Ticket 02: what a statement slide's options read beyond its own line — the deck's
   * `claim_style:` (a Bar deck decides an untokened statement) and whether the slide paints no
   * title (the older {statement=centred} centres only then). deckCommitContext fills both.
   */
  statement?: { deckClaimStyle?: string; titleHidden?: boolean }
}

// ── Ticket 02: the statement options are separate choices ─────────────────────────────────────
//
// Invariant: a write from any statement control changes only its own dimension of what the slide
// renders. The older one-word options ({statement=tint}, {claim=bar}, a deck `claim_style: bar`)
// are presets over several dimensions at once, so before the click lands they are rewritten as the
// per-dimension tokens they mean (statement-options.mjs resolves both, for the compiler too); the
// click then replaces its own group's token exactly as any other option write does.

/** The Inspector groups of a statement slide, by dimension ('colour' = the sidebar colour). */
export const STATEMENT_OPTION_GROUPS: Readonly<Record<string, StatementDimension | 'colour'>> = {
  'statement-sidebar': 'sidebar',
  'statement-bg': 'bg',
  'statement-align': 'align',
  'statement-bar': 'bar',
  'statement-colour': 'colour'
}

const DIMENSION_KEYS = new Set<string>(Object.values(STATEMENT_DIMENSION_KEYS))
const keyOf = (raw: string): string => raw.includes('=') ? raw.slice(0, raw.indexOf('=')) : ''
const isStatementPresetToken = (raw: string): boolean => keyOf(raw) === 'statement' || keyOf(raw) === 'claim'
const hasLayoutMeaning = (raw: string): boolean => meaningForToken(raw).some((pair) => pair.key === 'layout')

/** Insert `{token}…` after the line's last layout token, or at its end — the option write's place. */
function insertAfterLayout(line: string, tokens: readonly string[]): string {
  if (!tokens.length) return line
  const text = tokens.map((token) => `{${token}}`).join('')
  const layoutToken = [...parseAllGroups(line)].reverse().find((candidate) => hasLayoutMeaning(candidate.raw))
  if (layoutToken) return line.slice(0, layoutToken.groupEnd) + text + line.slice(layoutToken.groupEnd)
  return `${line}${line ? ' ' : ''}${text}`
}

/**
 * The line with every older one-word statement option (and a Bar deck's decision, when the slide
 * follows it) rewritten as the per-dimension tokens it means. Unchanged when there is nothing to
 * rewrite. A removed {statement=…} that was the line's only statement word leaves {statement}.
 */
export function expandStatementPresets(line: string, context: OptionCommitContext = {}): string {
  const tokens = parseAllGroups(line)
  const presets = tokens.filter((token) => isStatementPresetToken(token.raw))
  const deckClaimStyle = context.statement?.deckClaimStyle ?? ''
  const hasDimension = tokens.some((token) => DIMENSION_KEYS.has(keyOf(token.raw)))
  const followsBarDeck = !presets.length && !hasDimension && deckClaimStyle === 'bar'
  if (!presets.length && !followsBarDeck) return line
  const look = resolveStatementOptions(parseCompilerTriggerLine(line)?.attrs ?? {}, { deckClaimStyle })
  // The older {statement=centred} centres only a slide that paints no title (as preview.11 did).
  const align = look.centredNeedsNoTitle && context.statement?.titleHidden === false ? 'left' : look.align
  // A {statement=…} that is the line's only statement word becomes {statement} in place, so the
  // slide keeps its layout exactly where the author wrote it.
  const keepsLayout = tokens.some((token) => !isStatementPresetToken(token.raw) && hasLayoutMeaning(token.raw))
  const becomesLayout = keepsLayout ? undefined : presets.find((token) => keyOf(token.raw) === 'statement')
  const members = tokens.filter((token) => token !== becomesLayout && (isStatementPresetToken(token.raw) || DIMENSION_KEYS.has(keyOf(token.raw))))
  const belongs = (raw: string): boolean => isStatementPresetToken(raw) || DIMENSION_KEYS.has(keyOf(raw))
  const edits = groupRemovalEdits(line, members, tokens, (raw) => belongs(raw) && raw !== becomesLayout?.raw)
  if (becomesLayout) edits.push({ start: becomesLayout.start, end: becomesLayout.end, text: 'statement' })
  const written = statementDimensionTokens({ sidebar: look.sidebar, bg: look.bg, align, bar: look.bar })
  if (followsBarDeck && !written.length) return line
  return insertAfterLayout(applySpanEdits(line, edits), written)
}

function commitStatementOption(line: string, group: OptionGroup, token: string, context: OptionCommitContext): string {
  const expanded = expandStatementPresets(line, context)
  const committed = commitGroupToken(expanded, group, token, context)
  // A Bar deck decides a statement with no statement token of its own: a write that leaves the
  // line with none keeps its own dimension's default explicitly, so the slide stops following it.
  const dimension = STATEMENT_OPTION_GROUPS[group.key]
  if (token || dimension === 'colour' || dimension === 'sidebar' || context.statement?.deckClaimStyle !== 'bar') return committed
  const left = parseAllGroups(committed)
  if (left.some((candidate) => isStatementPresetToken(candidate.raw) || DIMENSION_KEYS.has(keyOf(candidate.raw)))) return committed
  return insertAfterLayout(committed, [`${STATEMENT_DIMENSION_KEYS[dimension]}=${STATEMENT_DEFAULTS[dimension]}`])
}

/** ADR-0011 keeps every option surface on the same byte-preserving Trigger-line write path. */
export function commitOptionSelection(line: string, group: OptionGroup, token: string, context: OptionCommitContext = {}): string {
  if (!isOptionTokenForGroup(token, group)) {
    throw new Error(`Unknown option token for ${group.key}: ${token}`)
  }
  if (STATEMENT_OPTION_GROUPS[group.key]) return commitStatementOption(line, group, token, context)
  return commitGroupToken(line, group, token, context)
}

function commitGroupToken(line: string, group: OptionGroup, token: string, context: OptionCommitContext): string {
  const tokens = parseAllGroups(line)
  // The compiler applies split=N to the Sidebar tint rail, so choosing a width keeps the Sidebar
  // style token while still removing every other title-placement rival.
  const keepSidebarForWidth = group.key === 'title-placement' && token.startsWith('split=')
  const belongsToGroup = (raw: string): boolean => {
    const value = optionValueForToken(raw, group)
    return value !== undefined && !(keepSidebarForWidth && value === 'sidebar')
  }
  const groupTokens = tokens.filter((candidate) => belongsToGroup(candidate.raw))
  // Re-choosing the value already written keeps its authored bytes. Never for the empty token:
  // committing '' means "no token of this group", so an alt spelling of the '' value (T32:
  // {plainlist} on Plain) is removed like any other member.
  const chosen = optionValueForToken(token, group) ?? token
  if (token && groupTokens.length === 1 && optionValueForToken(groupTokens[0].raw, group) === chosen) {
    return sweepOrphanOptionTokens(line, group, context)
  }

  const edits = groupRemovalEdits(line, groupTokens, tokens, belongsToGroup)

  // A new token goes after its group's anchor (ADR-0032: a board's settings follow {poll=board},
  // skipping the tokens this commit removes), else after the layout token, else at the end.
  // A rewritten value keeps its place: the anchor before the group's current token wins.
  const anchorKeys = group.anchorKeys ?? []
  const isAnchor = (candidate: TriggerToken): boolean => !groupTokens.includes(candidate)
    && meaningForToken(candidate.raw).some((pair) => anchorKeys.includes(pair.key))
  const firstMember = groupTokens[0]
  const anchorToken = anchorKeys.length
    ? (firstMember ? [...tokens].reverse().find((candidate) => candidate.start < firstMember.start && isAnchor(candidate)) : undefined)
      ?? [...tokens].reverse().find(isAnchor)
    : undefined
  const layoutToken = [...tokens].reverse().find((candidate) =>
    meaningForToken(candidate.raw).some((pair) => pair.key === 'layout')
  )
  const placeAfter = anchorToken ?? layoutToken
  if (token && placeAfter) {
    edits.push({ start: placeAfter.groupEnd, end: placeAfter.groupEnd, text: `{${token}}` })
  }

  let result = applySpanEdits(line, edits)
  if (token && !placeAfter) {
    result += `${result ? ' ' : ''}{${token}}`
  }
  return sweepOrphanOptionTokens(result, group, context)
}

export function applyLayoutSelection(
  line: string,
  selection: { layout?: string; modifiers: string[]; removeModifiers: string[] }
): string {
  const groups = trailingGroups(line)
  if (!groups.length) {
    if (line.trim()) return line
    return [selection.layout, ...selection.modifiers]
      .filter((token): token is string => Boolean(token))
      .map((token) => `{${token}}`)
      .join('')
  }
  const tokens = parseTriggerGroups(line)
  const protectedKeys = new Set<string>(systemTokens)
  const removals = new Set(selection.removeModifiers)
  const edits: Array<{ start: number; end: number; text: string }> = []
  const layoutTokens = selection.layout
    ? tokens.filter((token) => meaningForToken(token.raw).some((pair) => pair.key === 'layout'))
    : []
  const firstLayout = layoutTokens[0]
  const removedTokens = new Set<TriggerToken>()

  for (const token of tokens) {
    const key = token.raw.split('=', 1)[0]
    if (protectedKeys.has(key)) continue
    if (selection.layout && layoutTokens.includes(token)) {
      // Every token with layout meaning participates, including explicit layout=… forms.
      // Variant-value tokens such as contrast=rows deliberately ride along and re-apply if
      // their layout family returns later.
      if (token === firstLayout) edits.push({ start: token.start, end: token.end, text: selection.layout })
      else removedTokens.add(token)
      continue
    }
    if (removals.has(token.raw)) removedTokens.add(token)
  }

  const grouped = new Map<number, TriggerToken[]>()
  for (const token of tokens) {
    const peers = grouped.get(token.groupStart) ?? []
    peers.push(token)
    grouped.set(token.groupStart, peers)
  }
  const removedGroups = new Set<number>()
  for (const token of removedTokens) {
    const peers = grouped.get(token.groupStart) ?? []
    if (peers.every((peer) => removedTokens.has(peer))) {
      if (removedGroups.has(token.groupStart)) continue
      let start = token.groupStart
      while (start > 0 && line[start - 1] === ' ') start -= 1
      edits.push({ start, end: token.groupEnd, text: '' })
      removedGroups.add(token.groupStart)
    } else {
      edits.push({ start: token.start, end: token.end, text: '' })
    }
  }

  let result = line
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  }
  if (selection.layout && !firstLayout) result += ` {${selection.layout}}`
  for (const modifier of selection.modifiers) {
    if (!tokens.some((token) => token.raw === modifier) && !removals.has(modifier)) result += ` {${modifier}}`
  }
  return result
}

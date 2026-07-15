import { GLOBAL_OPTION_GROUPS, LAYOUTS, systemTokens } from './layout-registry/entries.ts'
import type { LayoutDef, OptionGroup } from './layout-registry/entries.ts'
import { LIST_VALUE_KEYS, TRIGGER_LINE_RE, tokenizeTriggerBody as tokenizeBody } from '../../compiler/scripts/lib/trigger-tokenizer.mjs'

export { LIST_VALUE_KEYS, TRIGGER_LINE_RE }
export { GLOBAL_OPTION_GROUPS }

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

function meaningForToken(raw: string): TokenMeaning {
  const equals = raw.indexOf('=')
  if (equals > 0) return [{ key: raw.slice(0, equals), value: raw.slice(equals + 1) }]

  for (const entry of LAYOUTS) {
    if (entry.triggerWords.includes(raw)) return targetForEntry(entry)
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

function optionValueForToken(raw: string, group: OptionGroup): string | undefined {
  const meaning = meaningForToken(raw)
  return group.values.find((value) => value.token && sameMeaning(meaning, meaningForToken(value.token)))?.token
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
  /** Canonical one-line rendering, with duplicate ids collapsed to the final authored id. */
  line: string
  warnings: string[]
}

/**
 * Read the one logical Trigger block below a heading. Blank lines before the block are tolerated;
 * once it starts, every consecutive Trigger-only line belongs to it. Token order is preserved,
 * except that duplicate slide ids collapse to the final id in reading order.
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
    tokens.push(...parseAllGroups(line))
    end += 1
  }

  const ids = tokens.filter((token) => /^id=/.test(token.raw))
  const keptId = ids.at(-1)?.raw
  const rendered = tokens
    .filter((token) => !/^id=/.test(token.raw) || token.raw === keptId && token === ids.at(-1))
    .map((token) => `{${token.raw}}`)
    .join('')
  const kept = keptId?.slice(3)
  return {
    start,
    end,
    line: rendered,
    warnings: ids.length > 1 && kept ? [`duplicate-slide-id-merged:${kept}`] : []
  }
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

/** ADR-0011 keeps every option surface on the same byte-preserving Trigger-line write path. */
export function commitOptionSelection(line: string, group: OptionGroup, token: string): string {
  if (!group.values.some((value) => value.token === token)) {
    throw new Error(`Unknown option token for ${group.key}: ${token}`)
  }

  const tokens = parseAllGroups(line)
  // The compiler applies split=N to the Sidebar tint rail, so choosing a width keeps the Sidebar
  // style token while still removing every other title-placement rival.
  const keepSidebarForWidth = group.key === 'title-placement' && token.startsWith('split=')
  const groupTokens = tokens.filter((candidate) => {
    const value = optionValueForToken(candidate.raw, group)
    return value !== undefined && !(keepSidebarForWidth && value === 'sidebar')
  })
  if (groupTokens.length === 1 && optionValueForToken(groupTokens[0].raw, group) === token) return line

  const grouped = new Map<number, TriggerToken[]>()
  for (const candidate of tokens) {
    const current = grouped.get(candidate.groupStart) ?? []
    current.push(candidate)
    grouped.set(candidate.groupStart, current)
  }

  const edits: Array<{ start: number; end: number; text: string }> = []
  const removedGroups = new Set<number>()
  for (const candidate of groupTokens) {
    const peers = grouped.get(candidate.groupStart) ?? []
    if (peers.every((peer) => optionValueForToken(peer.raw, group) !== undefined)) {
      if (!removedGroups.has(candidate.groupStart)) {
        edits.push({ start: candidate.groupStart, end: candidate.groupEnd, text: '' })
        removedGroups.add(candidate.groupStart)
      }
    } else {
      edits.push({ start: candidate.start, end: candidate.end, text: '' })
    }
  }

  if (token) {
    const layoutToken = [...tokens].reverse().find((candidate) =>
      meaningForToken(candidate.raw).some((pair) => pair.key === 'layout')
    )
    if (layoutToken) edits.push({ start: layoutToken.groupEnd, end: layoutToken.groupEnd, text: `{${token}}` })
  }

  let result = line
  for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  }
  if (token && !tokens.some((candidate) => meaningForToken(candidate.raw).some((pair) => pair.key === 'layout'))) {
    result += `${result ? ' ' : ''}{${token}}`
  }
  return result
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
  const layoutWords = new Set(LAYOUTS.filter((entry) => entry.kind === 'layout').flatMap((entry) =>
    parseTriggerGroups(entry.trigger).map((token) => token.raw)
  ))
  const protectedKeys = new Set<string>(systemTokens)
  const removals = new Set(selection.removeModifiers)
  let replacedLayout = false
  const edits: Array<{ start: number; end: number; text: string }> = []

  for (const token of tokens) {
    const key = token.raw.split('=', 1)[0]
    if (protectedKeys.has(key)) continue
    if (selection.layout && layoutWords.has(token.raw) && !replacedLayout) {
      edits.push({ start: token.start, end: token.end, text: selection.layout })
      replacedLayout = true
      continue
    }
    if (removals.has(token.raw)) edits.push({ start: token.start, end: token.end, text: '' })
  }

  let result = line
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  if (selection.layout && !replacedLayout) result += ` {${selection.layout}}`
  for (const modifier of selection.modifiers) {
    if (!tokens.some((token) => token.raw === modifier) && !removals.has(modifier)) result += ` {${modifier}}`
  }
  return result
}

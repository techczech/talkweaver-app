import {
  TRIGGER_DICTIONARY,
  VALUE_TRIGGER_DICTIONARY,
  resolveTrigger
} from '../triggers.mjs'
import { tokenizeTriggerBody } from './trigger-tokenizer.mjs'

const CHART_SHAPES = new Set(VALUE_TRIGGER_DICTIONARY.chart ?? [])
const LIST_ITEM_RE = /^\s*(?:[-*]\s+|\d+[.)]\s+)/
const LIST_ROW_RE = /^(\s*)([-*]\s+|\d+[.)]\s+)(.+)$/

/**
 * Parse one exact registered chart-family token line. The generated trigger dictionary and
 * value vocabulary remain the authority; this helper only applies the chart-family scope.
 */
export function parseChartObjectTokenLine(line) {
  const match = String(line ?? '').replace(/\r$/, '').match(/^\{([^{}]+)\}\s*$/)
  if (!match) return null
  const tokens = tokenizeTriggerBody(match[1])
  if (tokens.length !== 1) return null
  const token = tokens[0].raw
  const equals = token.indexOf('=')
  if (equals > 0) {
    const key = token.slice(0, equals)
    const value = token.slice(equals + 1)
    return key === 'chart' && CHART_SHAPES.has(value)
      ? { token, shape: value }
      : null
  }
  const resolved = resolveTrigger(token)
  if (resolved?.key === 'layout' && resolved.value === 'chart') {
    return { token, shape: 'bar' }
  }
  return resolved?.key === 'chart' && CHART_SHAPES.has(resolved.value)
    ? { token, shape: resolved.value }
    : null
}

// Fence aliases are every registry token accepted by the block-token resolver. Registry growth,
// including the later diagram-family extension, therefore expands both readings in one place.
export const CHART_FENCE_ALIASES = new Set(
  Object.keys(TRIGGER_DICTIONARY)
    .filter((token) => parseChartObjectTokenLine(`{${token}}`))
)

/** Resolve a chart fence by applying the exact block-token grammar to its whole info string. */
export function parseChartObjectFenceInfo(info) {
  const token = String(info ?? '').trim()
  return token ? parseChartObjectTokenLine(`{${token}}`) : null
}

/**
 * Parse a chart fence body only when its non-edge content is one uninterrupted Markdown list.
 * The returned tree is the compiler list shape consumed by the existing chart renderer.
 */
export function parseChartFenceBodyList(lines) {
  const body = Array.from(lines ?? [], (line) => String(line ?? ''))
  let start = 0
  let end = body.length
  while (start < end && !body[start].trim()) start += 1
  while (end > start && !body[end - 1].trim()) end -= 1
  if (start === end) return null

  const rows = []
  for (const line of body.slice(start, end)) {
    const match = line.match(LIST_ROW_RE)
    if (!match) return null
    rows.push({
      indent: match[1].replace(/\t/g, '  ').length,
      ordered: /\d/.test(match[2]),
      text: match[3].trim()
    })
  }

  const roots = []
  const stack = []
  for (const row of rows) {
    const node = { text: row.text, ordered: row.ordered, children: [] }
    while (stack.length && row.indent <= stack[stack.length - 1].indent) stack.pop()
    if (stack.length) stack[stack.length - 1].node.children.push(node)
    else roots.push(node)
    stack.push({ indent: row.indent, node })
  }
  return {
    type: 'list',
    ordered: roots.some((node) => node.ordered),
    items: roots.map((node) => node.text),
    children: roots.map((node) => node.children)
  }
}

/** Parse one Markdown backtick- or tilde-fence opening and retain its marker character and length. */
export function parseMarkdownFenceOpeningLine(line) {
  const match = String(line ?? '').replace(/\r$/, '').trim().match(/^(`{3,}|~{3,})(.*)$/)
  if (!match) return null
  return {
    marker: match[1],
    info: match[2].trim()
  }
}

/** A closing marker uses the opening marker's character and is at least as long. */
export function isMarkdownFenceClosingLine(line, opening) {
  const match = String(line ?? '').replace(/\r$/, '').trim().match(/^(`{3,}|~{3,})\s*$/)
  return Boolean(
    match
    && opening
    && match[1][0] === opening.marker[0]
    && match[1].length >= opening.marker.length
  )
}

/**
 * Scan structural fence extents with the compiler marker parser and the editor's sequential
 * HTML-comment opacity. `resetAtLine` may release only a fence with no valid later close.
 */
export function scanFencedLines(lines, options = {}) {
  const flags = new Array(lines.length).fill(false)
  const extents = []
  const laterBacktickCloseLength = new Array(lines.length).fill(0)
  const laterTildeCloseLength = new Array(lines.length).fill(0)
  if (options.resetAtLine) {
    let maxBacktickCloseLength = 0
    let maxTildeCloseLength = 0
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      laterBacktickCloseLength[i] = maxBacktickCloseLength
      laterTildeCloseLength[i] = maxTildeCloseLength
      const candidate = parseMarkdownFenceOpeningLine(lines[i])
      if (!candidate || candidate.info !== '') continue
      if (candidate.marker[0] === '`') {
        maxBacktickCloseLength = Math.max(maxBacktickCloseLength, candidate.marker.length)
      } else {
        maxTildeCloseLength = Math.max(maxTildeCloseLength, candidate.marker.length)
      }
    }
  }
  let active = null
  let inComment = false

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const visibleAtStart = !inComment
    if (!active) {
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
    if (!visibleAtStart) {
      flags[i] = true
      continue
    }
    if (active) {
      if (active.mayReset && options.resetAtLine?.(line, i)) {
        extents.push({
          opening: active.opening,
          start: active.start,
          bodyEnd: i,
          end: i,
          closed: false
        })
        active = null
      } else {
        flags[i] = true
        if (isMarkdownFenceClosingLine(line, active.opening)) {
          extents.push({
            opening: active.opening,
            start: active.start,
            bodyEnd: i,
            end: i + 1,
            closed: true
          })
          active = null
        }
        continue
      }
    }

    const opening = parseMarkdownFenceOpeningLine(line)
    if (!opening) continue
    flags[i] = true
    const laterCloseLength = opening.marker[0] === '`'
      ? laterBacktickCloseLength[i]
      : laterTildeCloseLength[i]
    active = {
      opening,
      start: i,
      mayReset: Boolean(
        options.resetAtLine
        && laterCloseLength < opening.marker.length
      )
    }
  }

  if (active) {
    extents.push({
      opening: active.opening,
      start: active.start,
      bodyEnd: lines.length,
      end: lines.length,
      closed: false
    })
  }
  return { flags, extents }
}

/**
 * Read one fence-marker line without inventing a second options grammar. `chartLike` is retained
 * for the Doctor so a value-form typo such as `chart=donut` blocks outbound use while ordinary
 * code languages remain ordinary code.
 */
export function parseChartFenceOpeningLine(line) {
  const opening = parseMarkdownFenceOpeningLine(line)
  if (!opening || opening.marker[0] !== '`') return null
  const { info } = opening
  const chart = parseChartObjectFenceInfo(info)
  const chartLikeToken = info.toLowerCase().split('=', 1)[0].trim()
  return {
    ...opening,
    info,
    chart,
    chartLike: CHART_FENCE_ALIASES.has(chartLikeToken)
  }
}

/** Resolve a chart token line only when its next non-blank line starts a compiler list. */
export function chartObjectTokenAt(lines, index) {
  const parsed = parseChartObjectTokenLine(lines[index])
  if (!parsed) return null
  let listStart = index + 1
  if (listStart < lines.length && String(lines[listStart]).trim() === '') listStart += 1
  return listStart < lines.length && LIST_ITEM_RE.test(String(lines[listStart]))
    ? { ...parsed, listStart }
    : null
}

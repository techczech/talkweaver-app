// Pure trigger-line health scan (ADR-0020 D1 / PRD R6): outline text in, findings out.
// No IO, no Electron — consumed by the audit CLI, the main-process vault scan, the doctor
// panel and the publish gate. Classification MUST stay in lockstep with the compiler's
// parseHeadingAttrs semantics (explicit key=value kept verbatim, bare words via dictionary,
// same-key last-wins) — see compiler/scripts/lib/02-triggers-layout.mjs:38-105.
import {
  buildTriggerVocabulary,
  isRegisteredTriggerToken,
  winningAuthoredLayout
} from './layout-registry/vocabulary.ts'
import type { TriggerVocabulary } from './layout-registry/vocabulary.ts'
import { LAYOUTS } from './layout-registry/entries.ts'
import {
  logicalTriggerBlockAfterHeading,
  meaningForToken,
  parseTriggerLine,
  TRIGGER_LINE_RE
} from './trigger-line.ts'
import {
  chartObjectTokenAt,
  parseChartFenceBodyList,
  parseChartFenceOpeningLine,
  parseChartObjectTokenLine
} from '../../compiler/scripts/lib/03-object-token.mjs'
import { scanFencedLines } from './outline-normalize.ts'

export type DoctorFindingKind =
  | 'unknown-word' | 'unregistered-key' | 'unregistered-value'
  | 'trigger-conflict' | 'duplicate-layout' | 'duplicate-slide-id'

export interface LayoutDoctorFinding {
  kind: DoctorFindingKind
  token: string
  line: number
  headingLine: number
  slideTitle: string
  detail?: string
  /** Visible projection row used only when the finding belongs to a folded child heading. */
  attributedHeadingLine?: number
  foldedChild?: true
}

const HEADING_RE = /^(#{2,6})\s+(.*)$/
export const LAYOUT_DOCTOR_VOCABULARY = buildTriggerVocabulary()
export const LAYOUT_DOCTOR_FENCE_AUTHORITY = scanFencedLines
const VALUE_FORM_LAYOUTS = new Map<string, string>()
for (const entry of LAYOUTS) {
  if (entry.kind !== 'layout') continue
  for (const trigger of [entry.trigger, ...entry.aliases]) {
    const raw = trigger.replace(/^\{|\}$/g, '')
    if (raw.includes('=')) VALUE_FORM_LAYOUTS.set(raw, entry.name)
  }
}

function leadingFrontmatter(lines: readonly string[]): {
  end: number
  triggers: { line: number; value: string } | null
} | null {
  if (lines[0]?.replace(/\r$/, '') !== '---') return null
  let triggerValue: { line: number; value: string } | null = null
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].replace(/\r$/, '')
    if (line === '---') return { end: i, triggers: triggerValue }
    const match = line.match(/^triggers:\s*(.*)$/)
    if (!match) continue
    const scalar = match[1].trim()
    const value = /^["'].*["']$/.test(scalar) ? scalar.slice(1, -1) : scalar
    triggerValue = scalar === '' || /^(?:true|false|null|\[\]|-?\d+(?:\.\d+)?)$/.test(scalar)
      ? null
      : { line: i + 1, value }
  }
  return null
}

export function scanOutlineTriggers(
  text: string,
  vocab: TriggerVocabulary = LAYOUT_DOCTOR_VOCABULARY
): LayoutDoctorFinding[] {
  const lines = text.split('\n')
  const fenceScan = LAYOUT_DOCTOR_FENCE_AUTHORITY(lines, {
    resetAtLine: (line) => HEADING_RE.test(line.replace(/\r$/, ''))
  })
  const fenced = fenceScan.flags
  type ChartFenceOpening = NonNullable<ReturnType<typeof parseChartFenceOpeningLine>> & {
    bodyIsExactlyOneList: boolean
  }
  const chartFenceOpenings = new Map<number, ChartFenceOpening>()
  for (const extent of fenceScan.extents) {
    const opening = parseChartFenceOpeningLine(lines[extent.start])
    if (!opening?.info) continue
    chartFenceOpenings.set(extent.start, {
      ...opening,
      bodyIsExactlyOneList:
        parseChartFenceBodyList(lines.slice(extent.start + 1, extent.bodyEnd)) !== null
    })
  }
  const findings: LayoutDoctorFinding[] = []
  const findingKeys = new Set<string>()
  const idOwners = new Map<string, number>() // id value → first heading line (1-based)
  const frontmatter = leadingFrontmatter(lines)
  const canonicalTriggerLines = new Set<number>()
  for (let index = 0; index < lines.length; index += 1) {
    if (frontmatter && index <= frontmatter.end) continue
    if (fenced[index] || !HEADING_RE.test(lines[index].replace(/\r$/, ''))) continue
    const triggerBlock = logicalTriggerBlockAfterHeading(lines, index)
    // parseOutlineTree consumes only this first Trigger-only line. Later lines stay in the
    // body, where a registered chart token may own its adjacent list.
    if (triggerBlock) canonicalTriggerLines.add(triggerBlock.start)
  }

  type ChartAuthority = {
    form: 'fence' | 'block token'
    token: string
    line: number
    shape: string
  }
  const chartContentAuthoritiesAfterHeading = (headingIndex: number): ChartAuthority[] => {
    let end = lines.length
    for (let index = headingIndex + 1; index < lines.length; index += 1) {
      if (!fenced[index] && HEADING_RE.test(lines[index].replace(/\r$/, ''))) {
        end = index
        break
      }
    }
    const authorities: ChartAuthority[] = []
    for (let index = headingIndex + 1; index < end; index += 1) {
      const opening = chartFenceOpenings.get(index)
      if (opening?.chart && opening.bodyIsExactlyOneList) {
        authorities.push({
          form: 'fence',
          token: opening.chart.token,
          line: index + 1,
          shape: opening.chart.shape
        })
      }
      if (fenced[index] || canonicalTriggerLines.has(index)) continue
      const block = chartObjectTokenAt(lines, index)
      if (block) {
        authorities.push({
          form: 'block token',
          token: block.token,
          line: index + 1,
          shape: block.shape
        })
      }
    }
    return authorities.sort((left, right) => left.line - right.line)
  }

  let heading: { line: number; title: string } | null = null
  let assigned: Map<string, string | boolean> = new Map()
  let layoutTokens: string[] = []
  let chartContentAuthorities: ChartAuthority[] = []
  const chartTriggerAuthority: {
    current: { raw: string; line: number; shape: string } | null
  } = { current: null }

  const pushFinding = (
    raw: string,
    lineNo: number,
    kind: DoctorFindingKind,
    detail?: string
  ): void => {
    if (!heading) return
    const finding = {
      kind,
      token: raw,
      line: lineNo,
      headingLine: heading.line,
      slideTitle: heading.title,
      detail
    }
    const findingKey = JSON.stringify(finding)
    if (findingKeys.has(findingKey)) return
    findingKeys.add(findingKey)
    findings.push(finding)
  }

  const classify = (raw: string, lineNo: number): void => {
    if (!heading) return
    const eq = raw.indexOf('=')
    const colon = raw.indexOf(':')
    let key = ''
    let value: string | boolean = true
    if (eq > 0) {
      key = raw.slice(0, eq); value = raw.slice(eq + 1)
      if (!isRegisteredTriggerToken(raw, vocab)) {
        return pushFinding(
          raw,
          lineNo,
          vocab.valueVocab.has(key) || vocab.openPatterns.has(key)
            ? 'unregistered-value'
            : 'unregistered-key'
        )
      }
    } else if (colon > 0 && /^[\w-]+$/.test(raw.slice(0, colon))) {
      key = raw.slice(0, colon); value = raw.slice(colon + 1)
      if (!isRegisteredTriggerToken(raw, vocab)) {
        return pushFinding(
          raw,
          lineNo,
          vocab.openPatterns.has(key) || vocab.valueVocab.has(key)
            ? 'unregistered-value'
            : 'unregistered-key'
        )
      }
    } else if (/^[\w-]+$/.test(raw)) {
      if (!isRegisteredTriggerToken(raw, vocab)) return pushFinding(raw, lineNo, 'unknown-word')
      const meaning = meaningForToken(raw)
      key = String(meaning[0]?.key ?? raw); value = meaning[0]?.value ?? true
    } else {
      return // not a legal token shape; parseHeadingAttrs skips it too
    }
    // Exclusivity + conflict bookkeeping (mirrors setKey at 02-triggers-layout.mjs:52-58).
    const valueFormLayout = eq > 0 ? VALUE_FORM_LAYOUTS.get(raw) : undefined
    const meaning = valueFormLayout
      ? [{ key: 'layout', value: valueFormLayout }]
      : eq > 0 || colon > 0
        ? [{ key, value }]
        : meaningForToken(raw)
    for (const pair of meaning) {
      if (pair.key === 'layout') {
        layoutTokens.push(raw)
        if (layoutTokens.length > 1) {
          pushFinding(raw, lineNo, 'duplicate-layout', `resolves layout to '${pair.value}' after an earlier layout token`)
        }
      } else if (assigned.has(pair.key) && assigned.get(pair.key) !== pair.value) {
        pushFinding(
          raw,
          lineNo,
          'trigger-conflict',
          `key '${pair.key}' was '${assigned.get(pair.key)}', now '${pair.value}' (last wins)`
        )
      }
      assigned.set(pair.key, pair.value)
      if (pair.key === 'id' && typeof pair.value === 'string') {
        const owner = idOwners.get(pair.value)
        if (owner !== undefined && owner !== heading!.line) {
          pushFinding(raw, lineNo, 'duplicate-slide-id', `also on the slide at line ${owner}`)
        }
        else idOwners.set(pair.value, heading!.line)
      }
    }
  }

  const recordChartAuthority = (line: string, lineNo: number): void => {
    const winner = winningAuthoredLayout(line, vocab)
    const parsed = winner?.layout === 'chart'
      ? parseChartObjectTokenLine(`{${winner.triggerToken}}`)
      : null
    chartTriggerAuthority.current = parsed && winner
      ? { raw: winner.triggerToken, line: lineNo, shape: parsed.shape }
      : null
    const fenceAuthority = chartContentAuthorities
      .filter((authority) => authority.form === 'fence')
      .at(-1)
    if (fenceAuthority) {
      if (chartTriggerAuthority.current) {
        pushFinding(
          chartTriggerAuthority.current.raw,
          chartTriggerAuthority.current.line,
          'trigger-conflict',
          `chart Trigger-line form is shadowed by fence `
            + `'${fenceAuthority.token}' at line ${fenceAuthority.line}`
        )
      }
      for (const authority of chartContentAuthorities) {
        if (authority.form !== 'block token') continue
        pushFinding(
          authority.token,
          authority.line,
          'trigger-conflict',
          `chart block-token form '${authority.token}' is shadowed by fence `
            + `'${fenceAuthority.token}' at line ${fenceAuthority.line}`
        )
      }
    } else if (chartTriggerAuthority.current) {
      for (const authority of chartContentAuthorities) {
        pushFinding(
          chartTriggerAuthority.current.raw,
          chartTriggerAuthority.current.line,
          'trigger-conflict',
          `chart Trigger-line form is shadowed by ${authority.form} `
            + `'${authority.token}' at line ${authority.line}`
        )
      }
    }
  }

  const deckTriggers = frontmatter?.triggers
  if (deckTriggers) {
    heading = { line: deckTriggers.line, title: 'Deck frontmatter (triggers:)' }
    assigned = new Map()
    layoutTokens = []
    chartContentAuthorities = []
    chartTriggerAuthority.current = null
    const body = deckTriggers.value.replace(/[{}]/g, ' ').trim()
    if (body) {
      for (const token of parseTriggerLine(`{${body}}`)) classify(token.raw, deckTriggers.line)
    }
    heading = null
    assigned = new Map()
    layoutTokens = []
    chartContentAuthorities = []
    idOwners.clear()
  }

  for (let i = 0; i < lines.length; i += 1) {
    if (frontmatter && i <= frontmatter.end) continue
    const line = lines[i].replace(/\r$/, '')
    const fenceOpening = chartFenceOpenings.get(i)
    if (
      fenceOpening
      && (
        (fenceOpening.chart && !fenceOpening.bodyIsExactlyOneList)
        || (fenceOpening.chartLike && !fenceOpening.chart)
      )
    ) {
      const authoredHeading: { line: number; title: string } | null = heading
      const preambleState = authoredHeading
        ? null
        : {
            assigned,
            layoutTokens,
            chartContentAuthorities,
            chartTriggerAuthority: chartTriggerAuthority.current,
            idOwners: new Map(idOwners)
          }
      if (!heading) {
        heading = { line: i + 1, title: 'Deck preamble' }
        assigned = new Map()
        layoutTokens = []
        chartContentAuthorities = []
        chartTriggerAuthority.current = null
      }
      if (fenceOpening.chart) {
        pushFinding(
          fenceOpening.info,
          i + 1,
          'unregistered-value',
          'registered chart fence body must be exactly one list'
        )
      } else {
        classify(fenceOpening.info, i + 1)
      }
      heading = authoredHeading
      if (preambleState) {
        assigned = preambleState.assigned
        layoutTokens = preambleState.layoutTokens
        chartContentAuthorities = preambleState.chartContentAuthorities
        chartTriggerAuthority.current = preambleState.chartTriggerAuthority
        idOwners.clear()
        for (const [id, owner] of preambleState.idOwners) idOwners.set(id, owner)
      }
    }
    if (fenced[i]) continue
    const headingMatch = line.match(HEADING_RE)
    if (headingMatch) {
      heading = { line: i + 1, title: headingMatch[2].replace(/\s*\{[^}]*\}/g, '').trim() }
      assigned = new Map(); layoutTokens = []
      chartContentAuthorities = chartContentAuthoritiesAfterHeading(i)
      chartTriggerAuthority.current = null
      // Heading-trailing trigger groups (duplicate-layout on the heading itself counts).
      for (const token of parseTriggerLine(line)) classify(token.raw, i + 1)
      recordChartAuthority(line, i + 1)
      continue
    }
    if (heading && TRIGGER_LINE_RE.test(line.trim())) {
      const blockToken = canonicalTriggerLines.has(i) ? null : chartObjectTokenAt(lines, i)
      if (blockToken) {
        continue
      }
      for (const token of parseTriggerLine(line.trim())) {
        classify(token.raw, i + 1)
      }
      if (canonicalTriggerLines.has(i)) recordChartAuthority(line.trim(), i + 1)
    }
  }
  return findings
}

/** The D1 blocking set: publish/export/present-live are refused while any of these exist. */
export function unresolvedTriggerFindings(text: string): LayoutDoctorFinding[] {
  return scanOutlineTriggers(text).filter((finding) =>
    finding.kind === 'unknown-word'
    || finding.kind === 'unregistered-key'
    || finding.kind === 'unregistered-value'
  )
}

export interface UnresolvedTriggerBlock {
  count: number
  first: LayoutDoctorFinding
  message: string
}

export function unresolvedTriggerBlock(text: string): UnresolvedTriggerBlock | null {
  const findings = unresolvedTriggerFindings(text)
  if (findings.length === 0) return null
  const count = findings.length
  return {
    count,
    first: findings[0],
    message: `This talk has ${count} unresolved trigger${count === 1 ? '' : 's'}. Publishing, exporting and presenting live are blocked until ${count === 1 ? 'it is' : 'they are'} fixed.`
  }
}

export function unresolvedOutboundFailure(
  text: string
): { success: false; error: string } | null {
  const block = unresolvedTriggerBlock(text)
  return block ? { success: false, error: block.message } : null
}

type FindingProjectionRow = {
  source_line?: number | null
}

/**
 * Attribute only projection-orphaned findings to the nearest rendered ancestor row. Carousel
 * children are folded into their parent's rendered slide, so their heading lines have no row of
 * their own. Exact source-line matches remain untouched and always win.
 */
export function attributeOrphanedTriggerFindings(
  text: string,
  rows: readonly FindingProjectionRow[],
  findings: readonly LayoutDoctorFinding[]
): LayoutDoctorFinding[] {
  const projectedLines = new Set(
    rows.flatMap((row) => typeof row.source_line === 'number' ? [row.source_line] : [])
  )
  const lines = text.split('\n')

  return findings.map((finding) => {
    if (projectedLines.has(finding.headingLine)) return finding

    const findingMatch = lines[finding.headingLine - 1]?.replace(/\r$/, '').match(/^(#{2,6})\s+/)
    if (!findingMatch) return finding
    let ancestorLevel = findingMatch[1].length
    let attributedHeadingLine: number | null = null
    for (let index = finding.headingLine - 2; index >= 0; index -= 1) {
      const headingMatch = lines[index].replace(/\r$/, '').match(/^(#{2,6})\s+/)
      if (!headingMatch || headingMatch[1].length >= ancestorLevel) continue
      ancestorLevel = headingMatch[1].length
      const headingLine = index + 1
      if (projectedLines.has(headingLine)) {
        attributedHeadingLine = headingLine
        break
      }
    }

    return attributedHeadingLine !== null
      ? {
          ...finding,
          attributedHeadingLine,
          foldedChild: true
        }
      : finding
  })
}

export function triggerFindingsForSlide(
  row: { source_line?: number | null } | null | undefined,
  findings: readonly LayoutDoctorFinding[]
): LayoutDoctorFinding[] {
  if (typeof row?.source_line !== 'number') return []
  return findings.filter((finding) =>
    (finding.attributedHeadingLine ?? finding.headingLine) === row.source_line
  )
}

/**
 * Convert source-scoped Layout Doctor findings into the compiler warning payloads consumed by
 * strip, Grid and Inspector badges. Trigger-related badges use this join instead of projection
 * warnings because compiler trigger warnings do not encode a slide id.
 */
export function triggerWarningPayloadsForSlide(
  row: { source_line?: number | null } | null | undefined,
  findings: readonly LayoutDoctorFinding[]
): string[] {
  return triggerFindingsForSlide(row, findings).flatMap((finding) => {
    const foldedChildNote = finding.foldedChild
      ? ` (folded child “${finding.slideTitle}”, line ${finding.headingLine})`
      : ''
    if (finding.kind === 'unknown-word') return [`unknown-trigger:${finding.token}${foldedChildNote}`]
    if (finding.kind === 'unregistered-key' || finding.kind === 'unregistered-value') {
      return [`unresolved-trigger:${finding.token}${foldedChildNote}`]
    }
    if (finding.kind === 'trigger-conflict' || finding.kind === 'duplicate-layout') {
      return [`trigger-conflict:${finding.detail ?? finding.token}${foldedChildNote}`]
    }
    return []
  })
}

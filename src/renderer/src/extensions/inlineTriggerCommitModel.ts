import { logicalTriggerBlockAfterHeading } from '../../../shared/trigger-line.ts'

export interface InlineTriggerChange {
  from: number
  to: number
  insert: string
}

export interface InlineTriggerCommitPlan {
  changes: InlineTriggerChange[]
  /** Original-document anchor. CodeMirror maps it through the transaction. */
  selection: number
  target: 'trigger' | 'inserted-trigger'
  warnings: string[]
}

export interface EditorTriggerCommitPlan {
  changes: InlineTriggerChange[]
  warnings: string[]
}

export interface PreparedObjectInsertDocument {
  doc: string
  at: number
}

const HEADING_RE = /^(#{1,6})\s/
interface TextLine {
  number: number
  from: number
  to: number
  text: string
}

function textLines(doc: string): TextLine[] {
  const raw = doc.split('\n')
  let from = 0
  return raw.map((text, index) => {
    const line = { number: index + 1, from, to: from + text.length, text }
    from += text.length + 1
    return line
  })
}

/**
 * Plan the one-transaction inline-picker write: remove the provisional `{…` at the
 * caret and run the registry writer against this slide's canonical Trigger line.
 */
export function commitInlineTriggerSelection(
  doc: string,
  tokenFrom: number,
  tokenTo: number,
  /** Receives the slide's canonical Trigger line and its 1-based heading line (for the deck context). */
  commit: (triggerLine: string, headingLine: number) => string
): InlineTriggerCommitPlan {
  const lines = textLines(doc)
  const origin = lines.find((line) => tokenFrom >= line.from && tokenFrom <= line.to)
  if (!origin) throw new Error('Inline trigger token is outside the document')

  let heading: TextLine | undefined
  for (let index = origin.number - 1; index >= 0; index -= 1) {
    if (HEADING_RE.test(lines[index].text)) { heading = lines[index]; break }
  }
  if (!heading) throw new Error('Inline trigger token is not inside a slide block')

  const rawLines = lines.map((line) => line.text)
  const block = logicalTriggerBlockAfterHeading(rawLines, heading.number - 1)
  const triggerLines = block ? lines.slice(block.start, block.end) : []
  const tokenIsOnTrigger = triggerLines.some((line) => line.number === origin.number)
  const originIsBraceLeadingPrelude = origin.number > heading.number && origin.text.trimStart().startsWith('{')
  if (tokenIsOnTrigger || originIsBraceLeadingPrelude) {
    rawLines[origin.number - 1] = origin.text.slice(0, tokenFrom - origin.from) + origin.text.slice(tokenTo - origin.from)
  }
  const cleanBlock = logicalTriggerBlockAfterHeading(rawLines, heading.number - 1)
  const committed = commit(cleanBlock?.line ?? '', heading.number)

  // A provisional brace-only line is part of the same edit-tolerant pre-content window as the
  // completed Trigger block. Replace that whole window in one dispatch, whichever order the
  // provisional line and id-bearing line currently occupy.
  if (originIsBraceLeadingPrelude) {
    const indices = [origin.number - 1]
    if (block) indices.push(block.start, block.end - 1)
    if (cleanBlock) indices.push(cleanBlock.start, cleanBlock.end - 1)
    const start = Math.min(...indices)
    const end = Math.max(...indices)
    const warnings = cleanBlock?.warnings ?? block?.warnings ?? []
    for (const warning of warnings) console.warn(warning)
    return {
      changes: [{ from: lines[start].from, to: lines[end].to, insert: committed }],
      selection: lines[start].from + committed.length,
      target: 'trigger',
      warnings
    }
  }

  if (block) {
    const first = lines[block.start]
    const last = lines[block.end - 1]
    const changes: InlineTriggerChange[] = tokenIsOnTrigger
      ? [{ from: first.from, to: last.to, insert: committed }]
      : [
          { from: first.from, to: last.to, insert: committed },
          { from: tokenFrom, to: tokenTo, insert: '' }
        ]
    for (const warning of block.warnings) console.warn(warning)
    return {
      changes,
      selection: tokenIsOnTrigger ? first.from + committed.length : tokenFrom,
      target: 'trigger',
      warnings: block.warnings
    }
  }

  const changes: InlineTriggerChange[] = [
    { from: tokenFrom, to: tokenTo, insert: '' }
  ]
  if (committed) {
    changes.unshift({ from: heading.to, to: heading.to, insert: `\n${committed}` })
  }
  return {
    changes,
    selection: tokenFrom,
    target: 'inserted-trigger',
    warnings: []
  }
}

/** Plan a mounted-editor option commit against the same merged logical Trigger block. */
export function planEditorTriggerCommit(
  doc: string,
  headingLine: number,
  commit: (triggerLine: string, headingLine: number) => string
): EditorTriggerCommitPlan {
  const lines = textLines(doc)
  const heading = lines[headingLine - 1]
  if (!heading || !HEADING_RE.test(heading.text)) throw new Error('Editor option target is not a heading')
  const block = logicalTriggerBlockAfterHeading(lines.map((line) => line.text), headingLine - 1)
  const committed = commit(block?.line ?? '', headingLine)
  if (block) {
    return {
      changes: [{ from: lines[block.start].from, to: lines[block.end - 1].to, insert: committed }],
      warnings: block.warnings
    }
  }
  return {
    changes: [{ from: heading.to, to: heading.to, insert: `\n${committed}` }],
    warnings: []
  }
}

function slideIdsInOutline(doc: string): Set<string> {
  return new Set(
    [...doc.matchAll(/\{id=([A-Za-z0-9_-]+)\}/g)]
      .map((match) => match[1])
  )
}

function mintEditorSlideId(rng: () => number, taken: Set<string>): string {
  for (;;) {
    const id = rng().toString(36).slice(2, 7)
    if (id.length === 5 && !taken.has(id)) {
      taken.add(id)
      return id
    }
  }
}

function mapPositionThroughChange(position: number, change: InlineTriggerChange): number {
  if (position < change.from) return position
  if (position > change.to) {
    return position + change.insert.length - (change.to - change.from)
  }
  return change.from + change.insert.length
}

function applyInlineTriggerChanges(doc: string, changes: InlineTriggerChange[]): string {
  return [...changes]
    .sort((left, right) => right.from - left.from)
    .reduce(
      (result, change) =>
        result.slice(0, change.from) + change.insert + result.slice(change.to),
      doc
    )
}

/**
 * Remove a provisional inline-picker token, then eagerly stamp only its enclosing slide through
 * planEditorTriggerCommit, the mounted editor's single Trigger-line write path. The returned
 * insertion anchor is mapped through the stamp.
 */
export function prepareObjectInsertDocument(
  doc: string,
  at: number,
  replace?: { from: number; to: number },
  rng: () => number = Math.random
): PreparedObjectInsertDocument {
  const lines = textLines(doc)
  const reference = replace?.from ?? at
  const origin = lines.find((line) => reference >= line.from && reference <= line.to)
  const removeFrom = replace?.from ?? at
  const removeTo = replace?.to ?? at
  const cleanDoc = doc.slice(0, removeFrom) + doc.slice(removeTo)
  if (!origin) return { doc: cleanDoc, at: removeFrom }

  let headingLine = origin.number
  while (headingLine > 0 && !HEADING_RE.test(lines[headingLine - 1].text)) headingLine -= 1
  if (headingLine === 0) return { doc: cleanDoc, at: removeFrom }

  const id = mintEditorSlideId(rng, slideIdsInOutline(cleanDoc))
  const plan = planEditorTriggerCommit(cleanDoc, headingLine, (triggerLine) => {
    if (/\{id=[A-Za-z0-9_-]+\}/.test(triggerLine)) return triggerLine
    return `${triggerLine}{id=${id}}`
  })
  const mappedAt = plan.changes.reduce(mapPositionThroughChange, removeFrom)
  return {
    doc: applyInlineTriggerChanges(cleanDoc, plan.changes),
    at: mappedAt
  }
}

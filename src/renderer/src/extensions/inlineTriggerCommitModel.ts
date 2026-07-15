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
  commit: (triggerLine: string) => string
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
  const committed = commit(cleanBlock?.line ?? '')

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

  return {
    changes: [
      { from: heading.to, to: heading.to, insert: `\n${committed}` },
      { from: tokenFrom, to: tokenTo, insert: '' }
    ],
    selection: tokenFrom,
    target: 'inserted-trigger',
    warnings: []
  }
}

/** Plan a mounted-editor option commit against the same merged logical Trigger block. */
export function planEditorTriggerCommit(
  doc: string,
  headingLine: number,
  commit: (triggerLine: string) => string
): EditorTriggerCommitPlan {
  const lines = textLines(doc)
  const heading = lines[headingLine - 1]
  if (!heading || !HEADING_RE.test(heading.text)) throw new Error('Editor option target is not a heading')
  const block = logicalTriggerBlockAfterHeading(lines.map((line) => line.text), headingLine - 1)
  const committed = commit(block?.line ?? '')
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

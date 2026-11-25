// Deleting a whole object (a table, chart, diagram, chat, page, notes block, comment): one change, one
// undo step, whole lines only, so no half fence or stray marker is ever left. The keyboard (Backspace or
// Delete on a selected object, field.ts) and the object's Delete button (widgets.ts, cardWidgets.ts) both
// come here. The lines go through the card planner (shared/objects/card-actions.ts): the object's own
// lines, and one of the blank lines around it when there is one on each side.
//
// An object read from a trigger list (`{table}`, `{chart}` and the other list objects of the layout
// registry) also owns its trigger token. The token goes with the body: on a line of its own the whole
// line goes (and the lines between it and the list, which are blank); on a line it shares with other
// tokens (the slide's id, a layout line under the title) only that token goes and the rest of the line
// stays as it was.
import { closedHtmlComments } from '../../../../../compiler/scripts/lib/outline-regions.mjs'
import type { AuthoredVideo } from '../../../../shared/video-marker-edits.ts'
import { isolateHistory } from '@codemirror/commands'
import type { EditorView } from '@codemirror/view'
import { locateCard, planCardRemoval } from '../../../../shared/objects/card-actions.ts'
import { parseTriggerLine } from '../../../../shared/trigger-line.ts'
import { notify } from '../../lib/notify.ts'
import { minimalChange } from '../../lib/minimalChange.ts'
import { detectObjectBlocks, type ObjectBlock } from './detect.ts'
import { exactTextWrite } from './effects.ts'

type RemovableObject = Pick<ObjectBlock, 'from' | 'to' | 'source' | 'video'>
type Edit = { from: number; to: number; insert: string }

export type ObjectRemovalPlan =
  | { ok: true; changes: Edit[]; caret: number }
  | { ok: false; reason: string }

/** `line` without the trigger token `token` (the last one written, as the layout reader takes the last).
 *  A group left empty goes with the space before it (or after it, at the start of the line); '' when
 *  nothing but space would be left. */
export function lineWithoutTriggerToken(line: string, token: string): string | null {
  const tokens = parseTriggerLine(line)
  const target = [...tokens].reverse().find((candidate) => candidate.raw === token)
  if (!target) return null
  const inGroup = tokens.filter((candidate) => candidate.groupStart === target.groupStart && candidate !== target)
  let from: number
  let to: number
  if (!inGroup.length) {
    from = target.groupStart
    to = target.groupEnd
    if (from > 0 && /[ \t]/.test(line[from - 1])) while (from > 0 && /[ \t]/.test(line[from - 1])) from -= 1
    else while (to < line.length && /[ \t]/.test(line[to])) to += 1
  } else {
    from = target.start
    to = target.end
    const next = inGroup.find((candidate) => candidate.start >= target.end)
    if (next) to = next.start
    else {
      const previous = [...inGroup].reverse().find((candidate) => candidate.end <= target.start)
      if (previous) from = previous.end
    }
  }
  const rest = line.slice(0, from) + line.slice(to)
  return rest.trim() === '' ? '' : rest
}

function markedVideoRemoval(card: RemovableObject, video: AuthoredVideo): ObjectRemovalPlan {
  const markerLines = new Set(video.markers.map(marker => marker.line - video.line))
  const last = video.markers.at(-1)!.line - video.line
  const lines = card.source.split('\n')
  const comments = closedHtmlComments(card.source)
  const changes: Edit[] = []
  let from = 0
  for (let index = 0; index <= last; index += 1) {
    const line = lines[index]
    const to = Math.min(card.source.length, from + line.length + 1)
    // A blank line inside a multiline comment is part of the comment's bytes.
    const blankBetween = !line.trim() && !comments.some(comment => from < comment.to && to > comment.from)
    if (index === 0 || markerLines.has(index) || blankBetween) {
      changes.push({ from: card.from + from, to: card.from + to, insert: '' })
    }
    from = to
  }
  return { ok: true, changes, caret: card.from }
}

/** The changes that delete `block` from `text`: its lines, and its trigger token when it has one. */
export function planObjectRemoval(text: string, block: RemovableObject): ObjectRemovalPlan {
  const body = planCardRemoval(text, block)
  if (!body.ok) return body
  const at = locateCard(text, block) ?? block
  // Read the object's current ownership from the outline, including a card that moved.
  const current = detectObjectBlocks(text).find((candidate) => candidate.from === at.from && candidate.to === at.to)
  if (current?.video?.markers.length) return markedVideoRemoval(at, current.video)
  if (block.video?.markers.length) return { ok: false, reason: 'The video or its markers changed. Try again.' }
  if (!current?.triggerLine || !current.triggerToken) return { ok: true, changes: [body.change], caret: body.change.from }
  const lines = text.split('\n')
  const index = current.triggerLine - 1
  const lineFrom = lines.slice(0, index).reduce((sum, line) => sum + line.length + 1, 0)
  const raw = lines[index] ?? ''
  const lineText = raw.replace(/\r$/, '')
  const kept = lineWithoutTriggerToken(lineText, current.triggerToken)
  if (kept === null) return { ok: true, changes: [body.change], caret: body.change.from }
  if (kept === '') {
    // The token stood alone: its line, the blank lines after it and the list go as one object.
    const whole = planCardRemoval(text, { from: lineFrom, to: at.to, source: text.slice(lineFrom, at.to) })
    return whole.ok ? { ok: true, changes: [whole.change], caret: whole.change.from } : whole
  }
  const tokenEdit = minimalChange(lineText, kept)
  const edit = { from: lineFrom + tokenEdit.from, to: lineFrom + tokenEdit.to, insert: tokenEdit.insert }
  return { ok: true, changes: [edit, body.change], caret: body.change.from - (lineText.length - kept.length) }
}

export function deleteObjectBlock(view: EditorView, block: RemovableObject): boolean {
  const plan = planObjectRemoval(view.state.doc.toString(), block)
  if (!plan.ok) {
    notify(plan.reason, 'warning', 'object-delete')
    return false
  }
  view.dispatch({
    changes: plan.changes,
    selection: { anchor: plan.caret },
    userEvent: 'delete.object',
    annotations: [isolateHistory.of('full'), exactTextWrite.of(true)],
    scrollIntoView: true
  })
  return true
}

// The agent verbs for speaker notes, HTML comments and the rows of chat, terminal and trace fences
// (design-speaker-notes-and-html-comment-objects §7; design-fenced-block-objects §13). Each is a pure
// function from the talk's text to a result: the same recogniser (readOutlineObjectRegions), the same
// segmenter (simulation-segments.mjs) and the same refusal rules (notes-body.ts) as the editor's cards.
// A write names the object it changes by position plus the hash of the text it expects there; a stale hash
// refuses with the current text, so nothing is written over a change the caller has not seen.
// TalkWeaver has no transport for talk text yet: OUTLINE_OBJECT_VERBS is the typed catalogue a transport
// (or the editor) calls. Pure: no fs, no DOM.
import {
  isMarkdownFenceClosingLine
} from '../../../compiler/scripts/lib/03-object-token.mjs'
import {
  describeHtmlComment,
  fenceKindForInfo
} from '../../../compiler/scripts/lib/outline-regions.mjs'
import {
  segmentHash,
  serialiseSegments,
  splitSegments
} from '../../../compiler/scripts/lib/simulation-segments.mjs'
import { readOutlineObjectRegions, type OutlineObjectRegions } from './outline-object-regions.ts'
import { notesBodyRefusal } from './notes-body.ts'
import { planNotesInsert, slideAround } from './notes-planner.ts'

export type VerbRefusal = { ok: false; code: 'not-found' | 'stale' | 'refused' | 'invalid-input' | 'exists'; message: string; current?: string }
export type VerbWrite = { ok: true; text: string; before: string; after: string }


function lineText(regions: OutlineObjectRegions, text: string, line: number): string {
  return text.slice(regions.lineStarts[line], regions.lineStarts[line + 1] - 1)
}

/** Text from the start of `start` through the end of `end - 1`, without the final line ending. */
function linesRange(regions: OutlineObjectRegions, text: string, start: number, end: number): { from: number; to: number } {
  const from = regions.lineStarts[start]
  const to = Math.min(text.length, regions.lineStarts[end] - 1)
  return { from, to }
}

/** Remove [from, to) and the line ending after it (or before it, at the end of the text). */
function removeLines(text: string, from: number, to: number): string {
  if (to < text.length) return text.slice(0, from) + text.slice(to + 1)
  return text.slice(0, Math.max(0, from - 1)) + text.slice(to)
}

// ── notes ──────────────────────────────────────────────────────────────────────────────────────────

export interface NotesEntry { index: number; line: number; closed: boolean; source: string; body: string; hash: string }

function notesEntries(text: string, regions = readOutlineObjectRegions(text)): NotesEntry[] {
  return regions.notes.map((n, index) => {
    const end = n.closed ? n.close + 1 : n.end
    const { from, to } = linesRange(regions, text, n.start, end)
    const source = text.slice(from, to)
    const lines = source.split('\n')
    const body = (n.closed ? lines.slice(1, -1) : lines.slice(1)).join('\n')
    return { index, line: n.start + 1, closed: n.closed, source, body, hash: segmentHash(source) }
  })
}

/** notes.get: every notes block of the talk, or of the slide whose heading is on `slideLine` (1-based). */
export function notesGet(text: string, slideLine?: number): { ok: true; blocks: NotesEntry[] } {
  const regions = readOutlineObjectRegions(text)
  const all = notesEntries(text, regions)
  if (slideLine === undefined) return { ok: true, blocks: all }
  const slide = slideAround(text, slideLine - 1, regions)
  return { ok: true, blocks: slide ? all.filter((b) => b.line - 1 > slide.heading && b.line - 1 < slide.end) : [] }
}

/** notes.insert: a notes block after the last text line of the slide on `slideLine`, through the shared
 *  planner (the compiler must read it as private notes); refuses when the slide has notes. */
export function notesInsert(text: string, slideLine: number, body = ''): VerbWrite | VerbRefusal {
  const plan = planNotesInsert(text, slideLine - 1, body)
  if (!plan.ok) {
    const current = plan.code === 'exists' ? notesEntries(text).find((b) => b.line - 1 === plan.open)?.source : undefined
    return { ok: false, code: plan.code, message: plan.message, ...(current ? { current } : {}) }
  }
  return { ok: true, text: plan.text, before: '', after: plan.insert.replace(/^(\r?\n)+/, '').replace(/\r?\n$/, '') }
}

function closedNotes(text: string, index: number, expectedHash: string): NotesEntry | VerbRefusal {
  const entry = notesEntries(text)[index]
  if (!entry || !entry.closed) return { ok: false, code: 'not-found', message: 'There is no closed notes block with that number.' }
  if (entry.hash !== expectedHash) return { ok: false, code: 'stale', message: 'The notes have changed since they were read.', current: entry.source }
  return entry
}

/** notes.replace: the body of closed notes block `index`, if its text still hashes to `expectedHash`. */
export function notesReplace(text: string, index: number, expectedHash: string, body: string): VerbWrite | VerbRefusal {
  const entry = closedNotes(text, index, expectedHash)
  if (!('index' in entry)) return entry
  const refusal = notesBodyRefusal(body)
  if (refusal) return { ok: false, code: 'refused', message: `Not written: ${refusal}.`, current: entry.source }
  if (body === entry.body) return { ok: true, text, before: entry.source, after: entry.source }
  const lines = entry.source.split('\n')
  const eol = entry.source.includes('\r\n') ? '\r\n' : '\n'
  const after = [lines[0], body.split(/\r?\n/).join(eol) + (eol === '\r\n' ? '\r' : ''), lines[lines.length - 1]].join('\n')
  const from = text.indexOf(entry.source, readOutlineObjectRegions(text).lineStarts[entry.line - 1])
  return { ok: true, text: text.slice(0, from) + after + text.slice(from + entry.source.length), before: entry.source, after }
}

/** notes.remove: the whole closed notes block `index`, with its line. */
export function notesRemove(text: string, index: number, expectedHash: string): VerbWrite | VerbRefusal {
  const entry = closedNotes(text, index, expectedHash)
  if (!('index' in entry)) return entry
  const from = readOutlineObjectRegions(text).lineStarts[entry.line - 1]
  return { ok: true, text: removeLines(text, from, from + entry.source.length), before: entry.source, after: '' }
}

// ── comments ───────────────────────────────────────────────────────────────────────────────────────

export interface CommentEntry { from: number; to: number; line: number; kind: string; label: string; effect: string; text: string; hash: string; standalone: boolean }

/** comment.list: every closed HTML comment outside fences and the front matter, with its exact kind. */
export function commentList(text: string): { ok: true; comments: CommentEntry[] } {
  const regions = readOutlineObjectRegions(text)
  const comments = regions.comments
    .filter((c) => c.container === 'outline' || c.container === 'notes')
    .map((c) => {
      const source = text.slice(c.from, c.to)
      let above = c.startLine - 1
      while (above >= 0 && lineText(regions, text, above).trim() === '') above -= 1
      const pageAbove = above >= 0 && /^\[(?:Embed|Simulation):/i.test(lineText(regions, text, above).trim())
      const d = describeHtmlComment(source, { aloneOnLine: c.standalone, pageAbove })
      return { from: c.from, to: c.to, line: c.startLine + 1, kind: d.kind, label: d.label, effect: d.effect, text: source, hash: segmentHash(source), standalone: c.standalone }
    })
  return { ok: true, comments }
}

function findComment(text: string, from: number, expectedHash: string): CommentEntry | VerbRefusal {
  const entry = commentList(text).comments.find((c) => c.from === from)
  if (!entry) return { ok: false, code: 'not-found', message: 'There is no comment at that position.' }
  if (entry.hash !== expectedHash) return { ok: false, code: 'stale', message: 'The comment has changed since it was read.', current: entry.text }
  return entry
}

/** comment.remove: the comment at `from`; one alone on its lines goes with its lines. */
export function commentRemove(text: string, from: number, expectedHash: string): (VerbWrite & { consequence?: string }) | VerbRefusal {
  const entry = findComment(text, from, expectedHash)
  if (!('hash' in entry)) return entry
  let next: string
  if (entry.standalone) {
    const regions = readOutlineObjectRegions(text)
    const start = regions.lineStarts[entry.line - 1]
    const endLine = entry.line - 1 + entry.text.split('\n').length - 1
    const end = regions.lineStarts[endLine] + lineText(regions, text, endLine).length
    next = removeLines(text, start, end)
  } else next = text.slice(0, entry.from) + text.slice(entry.to)
  const consequence = entry.kind === 'capture-marker'
    ? 'The saved-views marker is gone; if the page has no saved views left, earlier recorded views can show again. Undo or re-insert restores it.'
    : undefined
  return { ok: true, text: next, before: entry.text, after: '', ...(consequence ? { consequence } : {}) }
}

/** comment.replace: the comment at `from` with `next`, which must be one closed comment. */
export function commentReplace(text: string, from: number, expectedHash: string, next: string): VerbWrite | VerbRefusal {
  const entry = findComment(text, from, expectedHash)
  if (!('hash' in entry)) return entry
  if (!/^<!--[\s\S]*-->$/.test(next) || next.indexOf('-->') !== next.length - 3) {
    return { ok: false, code: 'refused', message: 'Not written: the comment must stay one block from <!-- to -->.', current: entry.text }
  }
  return { ok: true, text: text.slice(0, entry.from) + next + text.slice(entry.to), before: entry.text, after: next }
}

// ── rows of chat, terminal and trace fences ───────────────────────────────────────────────────────

type RowsKind = 'turns' | 'shell' | 'trace'
type AnyRow = { lines: string[] } & Record<string, unknown>
const ROWS_KIND: Readonly<Record<string, RowsKind>> = { chat: 'turns', 'chat-lanes': 'turns', 'terminal-agent': 'turns', terminal: 'shell', trace: 'trace' }

function rowsFence(text: string, fenceLine: number) {
  const regions = readOutlineObjectRegions(text)
  const fence = regions.fences.find((f) => f.start === fenceLine - 1 && f.closed && !f.inNotes)
  if (!fence) return null
  const kind = ROWS_KIND[fenceKindForInfo(fence.opening.info)]
  if (!kind) return null
  // The body ends before the line ending that precedes the closing marker (LF or CRLF), exactly as the
  // editor's recogniser cuts it (detect.ts): that separator stays outside the body and is never rewritten.
  const bodyFrom = regions.lineStarts[fence.start + 1]
  const closing = regions.lineStarts[fence.bodyEnd]
  const separator = text.slice(Math.max(bodyFrom, closing - 2), closing) === '\r\n' ? 2 : 1
  const bodyTo = Math.max(bodyFrom, closing - separator)
  return { fence, kind, body: text.slice(bodyFrom, bodyTo), bodyFrom, bodyTo }
}

/** object.row.list: the rows of the chat, terminal or trace fence opening on `fenceLine` (1-based). */
export function rowList(text: string, fenceLine: number) {
  const found = rowsFence(text, fenceLine)
  if (!found) return { ok: false as const, code: 'not-found' as const, message: 'There is no closed chat, terminal or trace block on that line.' }
  const split = splitSegments(found.kind, found.body)
  const rows = (split.rows as unknown as AnyRow[]).map((row) => {
    const { lines, gap: _gap, contentLength: _c, headOnLabel: _h, ...fields } = row
    return { ...fields, hash: segmentHash(lines.join('\n')) }
  })
  return { ok: true as const, kind: found.kind, objectHash: segmentHash(found.body), rows }
}

/** object.row.replace: change one row's fields; every other byte of the fence stays as it was. */
export function rowReplace(text: string, fenceLine: number, rowIndex: number, expectedRowHash: string, fields: Record<string, unknown>): VerbWrite | VerbRefusal {
  const found = rowsFence(text, fenceLine)
  if (!found) return { ok: false, code: 'not-found', message: 'There is no closed chat, terminal or trace block on that line.' }
  const split = splitSegments(found.kind, found.body)
  const original = split.rows[rowIndex]
  if (!original) return { ok: false, code: 'not-found', message: 'There is no row with that number.' }
  if (segmentHash(original.lines.join('\n')) !== expectedRowHash) {
    return { ok: false, code: 'stale', message: 'The row has changed since it was read.', current: original.lines.join('\n') }
  }
  const rows = (split.rows as unknown as AnyRow[]).map((row, index) => (
    index === rowIndex ? { ...row, ...fields, original: row } : { ...row, original: row }
  ))
  const body = serialiseSegments(found.kind, found.body, split, rows as never)
  if (body.split('\n').some((line: string) => isMarkdownFenceClosingLine(line.replace(/\r$/, ''), found.fence.opening))) {
    return { ok: false, code: 'refused', message: 'Not written: a line of the new text would end the block.' }
  }
  const resplit = splitSegments(found.kind, body)
  if (resplit.rows.length !== split.rows.length) {
    return { ok: false, code: 'refused', message: 'Not written: the new text would start or merge rows. Change the rows one at a time.' }
  }
  const before = original.lines.join('\n')
  return { ok: true, text: text.slice(0, found.bodyFrom) + body + text.slice(found.bodyTo), before, after: resplit.rows[rowIndex].lines.join('\n') }
}

// ── catalogue ─────────────────────────────────────────────────────────────────────────────────────

export interface OutlineObjectVerb {
  id: string
  tier: 'content'
  posture: 'read' | 'direct'
  inputs: Readonly<Record<string, string>>
}

export const OUTLINE_OBJECT_VERBS: readonly OutlineObjectVerb[] = [
  { id: 'notes.get', tier: 'content', posture: 'read', inputs: { text: 'talk text', slideLine: 'optional heading line (1-based)' } },
  { id: 'notes.insert', tier: 'content', posture: 'direct', inputs: { text: 'talk text', slideLine: 'heading line (1-based)', body: 'optional notes text' } },
  { id: 'notes.replace', tier: 'content', posture: 'direct', inputs: { text: 'talk text', index: 'notes block number', expectedHash: 'hash from notes.get', body: 'new notes text' } },
  { id: 'notes.remove', tier: 'content', posture: 'direct', inputs: { text: 'talk text', index: 'notes block number', expectedHash: 'hash from notes.get' } },
  { id: 'comment.list', tier: 'content', posture: 'read', inputs: { text: 'talk text' } },
  { id: 'comment.remove', tier: 'content', posture: 'direct', inputs: { text: 'talk text', from: 'comment position', expectedHash: 'hash from comment.list' } },
  { id: 'comment.replace', tier: 'content', posture: 'direct', inputs: { text: 'talk text', from: 'comment position', expectedHash: 'hash from comment.list', next: 'one closed comment' } },
  { id: 'object.row.list', tier: 'content', posture: 'read', inputs: { text: 'talk text', fenceLine: 'opening fence line (1-based)' } },
  { id: 'object.row.replace', tier: 'content', posture: 'direct', inputs: { text: 'talk text', fenceLine: 'opening fence line (1-based)', rowIndex: 'row number', expectedRowHash: 'hash from object.row.list', fields: 'role, duration, content / path, command, output / header, content' } }
]

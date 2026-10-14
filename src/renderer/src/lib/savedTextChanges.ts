// The pure half of extensions/savedTextAdoption.ts (read that file's header first): how the text a
// save wrote differs from the text the editor sent, as one small change per touched line. No
// CodeMirror, no DOM; scripts/test-saved-text-adoption-dom.mjs imports this file directly.
import { minimalChange } from './minimalChange.ts'

export interface TextChange { from: number; to: number; insert: string }

const ID_TOKEN = /\{id=([A-Za-z0-9_-]+)\}/g
/** How far ahead a line is looked for before two differing lines are read as one changed line. */
const LOOKAHEAD = 64

export const idsIn = (text: string): string[] => [...text.matchAll(ID_TOKEN)].map((m) => m[1])
const withoutIds = (line: string): string => line.replace(ID_TOKEN, '').replace(/\s+/g, ' ').trim()

function applyChanges(text: string, changes: readonly TextChange[]): string {
  let out = ''
  let at = 0
  for (const c of changes) {
    out += text.slice(at, c.from) + c.insert
    at = c.to
  }
  return out + text.slice(at)
}

/** The changes that turn `sent` into `saved`, one per touched line, in document order and all in
 *  `sent`'s offsets; null when no such list could be worked out (the caller falls back to a single
 *  replacement). Exact for what a save does: whole lines inserted, and tokens put into a line. */
export function savedTextChanges(sent: string, saved: string): TextChange[] | null {
  if (sent === saved) return []
  const a = sent.split('\n')
  const b = saved.split('\n')
  const start: number[] = []
  let offset = 0
  for (const line of a) { start.push(offset); offset += line.length + 1 }
  const changes: TextChange[] = []
  /** Lines of `saved` going in before line `i` of `sent` (after its last line when i is past it). */
  const insertLines = (i: number, lines: readonly string[]): void => {
    if (lines.length === 0) return
    const block = lines.join('\n')
    // At the end of the line before, so a caret at the start of line i stays on line i's text.
    if (i > 0) { const at = start[i - 1] + a[i - 1].length; changes.push({ from: at, to: at, insert: '\n' + block }) }
    else changes.push({ from: 0, to: 0, insert: block + '\n' })
  }
  /** Lines i..to of `sent` going out. */
  const deleteLines = (i: number, to: number): void => {
    if (to <= i) return
    if (i > 0) changes.push({ from: start[i - 1] + a[i - 1].length, to: start[to - 1] + a[to - 1].length, insert: '' })
    else if (to < a.length) changes.push({ from: 0, to: start[to], insert: '' })
    else changes.push({ from: 0, to: sent.length, insert: '' })
  }
  const changeLine = (i: number, next: string): void => {
    // One id put into the line: say so as the id itself going in (not as the smallest difference,
    // which for "{id=x} {columns}" over "{columns}" would be the rotated "id=x} {").
    for (const m of next.matchAll(ID_TOKEN)) {
      const at = m.index
      const end = at + m[0].length
      const forms: Array<[number, number]> = [[at, end]]
      if (next[end] === ' ') forms.unshift([at, end + 1])
      if (at > 0 && next[at - 1] === ' ') forms.push([at - 1, end])
      const form = forms.find(([from, to]) => next.slice(0, from) + next.slice(to) === a[i])
      if (form) { changes.push({ from: start[i] + form[0], to: start[i] + form[0], insert: next.slice(form[0], form[1]) }); return }
    }
    const ch = minimalChange(a[i], next)
    changes.push({ from: start[i] + ch.from, to: start[i] + ch.to, insert: ch.insert })
  }
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i += 1; j += 1; continue }
    // The same line with an id put on it (or taken off it).
    if (withoutIds(a[i]) === withoutIds(b[j]) && withoutIds(a[i]) !== '') { changeLine(i, b[j]); i += 1; j += 1; continue }
    let ahead = 0
    for (let k = 1; k <= LOOKAHEAD; k += 1) {
      if (j + k < b.length && b[j + k] === a[i]) { ahead = k; break }
      if (i + k < a.length && a[i + k] === b[j]) { ahead = -k; break }
    }
    if (ahead > 0) { insertLines(i, b.slice(j, j + ahead)); j += ahead }
    else if (ahead < 0) { deleteLines(i, i - ahead); i -= ahead }
    else { changeLine(i, b[j]); i += 1; j += 1 }
  }
  if (j < b.length) insertLines(a.length, b.slice(j))
  if (i < a.length) deleteLines(i, a.length)
  // insertLines(i) and deleteLines(i) for the same i share a position; keep the list in order.
  changes.sort((x, y) => x.from - y.from || x.to - y.to)
  for (let k = 1; k < changes.length; k += 1) if (changes[k].from < changes[k - 1].to) return null
  return applyChanges(sent, changes) === saved ? changes : null
}

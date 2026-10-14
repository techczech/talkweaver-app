// Plain view, ticket 13: the one line's new text for the icon verbs (icon-verbs.ts). Pure string
// work on a line without its line ending; what the line IS, and whether the result is kept, is
// decided in icon-verbs.ts and icon-verbs-verify.ts.
import { tokenizeTriggerBody } from '../../compiler/scripts/lib/trigger-tokenizer.mjs'
import { headingBraceGroups } from './plain-view-icon-tokens.ts'

/** The smallest single replacement that turns `was` into `now`. */
export function spliceOf(was: string, now: string): { from: number; to: number; insert: string } {
  let from = 0
  while (from < was.length && from < now.length && was[from] === now[from]) from += 1
  let tail = 0
  while (tail < was.length - from && tail < now.length - from && was[was.length - 1 - tail] === now[now.length - 1 - tail]) tail += 1
  return { from, to: was.length - tail, insert: now.slice(from, now.length - tail) }
}

/**
 * A heading line with its icon set (or, `key` null, removed): a port of the compiler's own edit
 * (12-outline-edit.mjs headingIconEdit). Only authored trailing groups are read. With several
 * `icon=` tokens a set keeps the first, gives it the key and deletes the rest; a remove deletes all.
 */
export function headingLineWith(body: string, key: string | null): string {
  const groups = headingBraceGroups(body).filter((group) => group.authored)
  const all = new Map(groups.map((group) => [group, tokenizeTriggerBody(group.inner)]))
  const tokens = groups.flatMap((group) => all.get(group)!.filter((token) => token.raw.startsWith('icon=')).map((token) => ({ group, from: group.start + 1 + token.start, to: group.start + 1 + token.end })))
  const deleted = new Set<number>()
  const inserted = new Map<number, string>()
  if (!tokens.length) {
    if (!key) return body
    let textEnd = groups.length ? groups[0].start : body.length
    while (textEnd > 0 && /\s/.test(body[textEnd - 1])) textEnd -= 1
    inserted.set(textEnd, ` {icon=${key}}`)
  } else {
    if (key) {
      const first = tokens[0]
      const valueFrom = body.startsWith('icon=', first.from) ? first.from + 5 : first.from
      const next = valueFrom === first.from ? `icon=${key}` : key
      if (body.slice(valueFrom, first.to) !== next) {
        for (let i = valueFrom; i < first.to; i += 1) deleted.add(i)
        inserted.set(valueFrom, next)
      }
    }
    const drop = key ? tokens.slice(1) : tokens
    for (const group of groups) {
      const dropped = drop.filter((entry) => entry.group === group)
      if (!dropped.length) continue
      const inGroup = all.get(group)!
      if (dropped.length === inGroup.length) {
        // Nothing else in the group: the group goes, with the one space before it.
        for (let i = group.start; i < group.end; i += 1) deleted.add(i)
        if (body[group.start - 1] === ' ') deleted.add(group.start - 1)
        continue
      }
      // The group keeps other tokens: the token goes with the separators between it and the kept
      // token before it (or, when none before it is kept, the token after it).
      const inner = group.start + 1
      const isDropped = (token: { start: number }): boolean => dropped.some((other) => other.from === inner + token.start)
      for (const entry of dropped) {
        const at = inGroup.findIndex((token) => inner + token.start === entry.from)
        const keptBefore = inGroup.slice(0, at).some((token) => !isDropped(token))
        const from = keptBefore ? inner + inGroup[at - 1].end : entry.from
        const to = keptBefore || at + 1 >= inGroup.length ? entry.to : inner + inGroup[at + 1].start
        for (let i = from; i < to; i += 1) deleted.add(i)
      }
    }
  }
  let out = ''
  for (let i = 0; i <= body.length; i += 1) {
    if (inserted.has(i)) out += inserted.get(i)
    if (i < body.length && !deleted.has(i)) out += body[i]
  }
  return out
}

/** A paragraph's last line or a list row with its located token set or removed. null: the token is not where the facts say. */
export function tokenLineWith(body: string, tokenFrom: number, key: string | null): string | null {
  const tokenTo = body.lastIndexOf('}') + 1
  if (tokenFrom < 0 || tokenTo <= tokenFrom || !/^\{[^}]*\}$/.test(body.slice(tokenFrom, tokenTo)) || body.slice(tokenTo).trim()) return null
  if (key) return `${body.slice(0, tokenFrom)}{icon=${key}}${body.slice(tokenTo)}`
  return body.slice(0, body[tokenFrom - 1] === ' ' ? tokenFrom - 1 : tokenFrom) + body.slice(tokenTo)
}

/** A line with a new token after its text (trailing spaces stay where they are). */
export function lineWithNewToken(body: string, key: string): string {
  const end = body.replace(/\s+$/, '').length
  return `${body.slice(0, end)} {icon=${key}}${body.slice(end)}`
}

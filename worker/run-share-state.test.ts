import { describe, expect, test } from 'bun:test'
import {
  DAY_MS, parseRunSharePush, parseRunShareRoute, renderRunSharePage, runShareAlarmAt, runShareExpired, runShareRouteMethod,
  type StoredRunShare,
} from './run-share-state'

const NOW = Date.UTC(2026, 8, 29, 9)

function push(extra: Record<string, unknown> = {}) {
  return {
    expiresAt: NOW + 30 * DAY_MS, title: 'The current state of AI agents', subtitle: 'Mon 28 Sep 2026 · ITSS Briefing, Oxford',
    boards: [{ question: 'What should we keep, change, try?', cardCount: 3, state: 'final', when: '28 Sep 2026', columns: [
      { label: 'Keep', count: 3, entries: [{ n: 1, text: 'More time for hands-on', count: 2 }, { text: 'The pace of the first half' }] },
    ] }],
    polls: [
      { kind: 'bars', question: 'Which tools?', people: 4, rows: [{ label: 'ChatGPT', count: 3 }, { label: 'Claude', count: 1 }] },
      { kind: 'scale', question: 'How confident?', people: 2, labels: ['Not yet', 'Very'], rows: [{ label: 'Writing', counts: [1, 1] }] },
      { kind: 'text', question: 'Hopes?', people: 1, responses: ['A safe way to use agents'] },
    ],
    ...extra,
  }
}

describe('what a push may carry', () => {
  test('a well-formed push is rebuilt from its allowed fields only', () => {
    const parsed = parseRunSharePush({ ...push(), extra: 'ignored' }, NOW)
    if ('error' in parsed) throw new Error(parsed.error.code)
    expect(parsed.value.boards[0].columns[0].entries).toEqual([{ n: 1, text: 'More time for hands-on', count: 2 }, { text: 'The pace of the first half' }])
    expect('extra' in parsed.value).toBe(false)
    expect(parsed.value.polls.map((poll) => poll.kind)).toEqual(['bars', 'scale', 'text'])
  })

  test('a card, column, board or poll that names or hides someone is refused outright', () => {
    const withCard = (card: Record<string, unknown>) => push({ boards: [{ ...push().boards[0], columns: [{ label: 'Keep', count: 1, entries: [card] }] }] })
    expect(parseRunSharePush(withCard({ text: 'x', hidden: true }), NOW)).toEqual({ error: expect.objectContaining({ code: 'invalid_board' }) })
    expect(parseRunSharePush(withCard({ text: 'x', name: 'Sam' }), NOW)).toEqual({ error: expect.objectContaining({ code: 'invalid_board' }) })
    expect(parseRunSharePush(push({ polls: [{ kind: 'text', question: 'Q', people: 1, responses: ['a'], name: 'Sam' }] }), NOW))
      .toEqual({ error: expect.objectContaining({ code: 'invalid_poll' }) })
  })

  test('the lifetime is null (until stopped) or within 31 days; an empty push is refused', () => {
    expect('value' in parseRunSharePush(push({ expiresAt: null }), NOW)).toBe(true)
    expect('value' in parseRunSharePush(push({ expiresAt: NOW + 7 * DAY_MS }), NOW)).toBe(true)
    expect(parseRunSharePush(push({ expiresAt: NOW - 1 }), NOW)).toEqual({ error: expect.objectContaining({ code: 'invalid_expiry' }) })
    expect(parseRunSharePush(push({ expiresAt: NOW + 32 * DAY_MS }), NOW)).toEqual({ error: expect.objectContaining({ code: 'invalid_expiry' }) })
    expect(parseRunSharePush(push({ expiresAt: undefined }), NOW)).toEqual({ error: expect.objectContaining({ code: 'invalid_expiry' }) })
    expect(parseRunSharePush(push({ boards: [], polls: [] }), NOW)).toEqual({ error: expect.objectContaining({ code: 'nothing_to_share' }) })
  })
})

describe('the page', () => {
  test('writes every string as text: markup in a card, a title or an answer is escaped', () => {
    const hostile = '<img src=x onerror=alert(1)>'
    const parsed = parseRunSharePush(push({ title: hostile, boards: [{ ...push().boards[0], question: hostile,
      columns: [{ label: hostile, count: 1, entries: [{ text: hostile }] }] }],
      polls: [{ kind: 'text', question: hostile, people: 1, responses: [hostile] }] }), NOW)
    if ('error' in parsed) throw new Error(parsed.error.code)
    const html = renderRunSharePage(parsed.value)
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<form')
  })

  test('says Final board or Still open, the card count, groups with their counts, and that no names were collected', () => {
    const parsed = parseRunSharePush(push(), NOW)
    if ('error' in parsed) throw new Error(parsed.error.code)
    const html = renderRunSharePage(parsed.value)
    expect(html).toContain('Final board · 28 Sep 2026')
    expect(html).toContain('3 cards from the room, grouped by the speaker. No names were collected.')
    expect(html).toContain('×2')
    const open = parseRunSharePush(push({ boards: [{ ...push().boards[0], state: 'open', when: 'Mon 5 Oct' }] }), NOW)
    if ('error' in open) throw new Error(open.error.code)
    expect(renderRunSharePage(open.value)).toContain('Still open for cards · until Mon 5 Oct')
  })
})

describe('routes and lifetime', () => {
  test('the route grammar is exactly three paths, each with one method', () => {
    expect(parseRunShareRoute('/results/abcd1234')).toEqual({ shareId: 'abcd1234', action: 'page' })
    expect(parseRunShareRoute('/results/abcd1234/results.json')).toBeNull()
    expect(parseRunShareRoute('/results/abcd1234/content')?.action).toBe('content')
    expect(parseRunShareRoute('/results/abcd1234/close')?.action).toBe('close')
    expect(parseRunShareRoute('/results/abcd1234/')).toBeNull()
    expect(parseRunShareRoute('/results/abcd1234/items')).toBeNull()
    expect(parseRunShareRoute('/results/internal')).toBeNull()
    expect(parseRunShareRoute('/results/sessions')).toBeNull()
    expect(runShareRouteMethod({ shareId: 'abcd1234', action: 'page' })).toBe('GET')
    expect(runShareRouteMethod({ shareId: 'abcd1234', action: 'content' })).toBe('PUT')
    expect(runShareRouteMethod({ shareId: 'abcd1234', action: 'close' })).toBe('POST')
  })

  test('a link expires at its time and not before; "until I stop it" never expires', () => {
    const share: StoredRunShare = { shareId: 'abcd1234', createdAt: NOW, status: 'open', expiresAt: NOW + 7 * DAY_MS, pushedAt: NOW }
    expect(runShareExpired(share, NOW + 7 * DAY_MS - 1)).toBe(false)
    expect(runShareExpired(share, NOW + 7 * DAY_MS)).toBe(true)
    expect(runShareAlarmAt(share)).toBe(NOW + 7 * DAY_MS)
    const forever = { ...share, expiresAt: null }
    expect(runShareExpired(forever, NOW + 400 * DAY_MS)).toBe(false)
    expect(runShareAlarmAt(forever)).toBeNull()
  })
})

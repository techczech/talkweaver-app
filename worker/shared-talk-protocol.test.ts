import { describe, expect, test } from 'bun:test'
import {
  SHARED_TALK_LIMITS,
  parseItemStatusPatch,
  parseSharedItemPost,
  parseSharedTalkPush,
  parseSharedTalkServerMessage,
} from './protocol'

function errorCode(result: { error?: { code: string } } | object): string | undefined {
  return 'error' in result ? (result.error as { code: string }).code : undefined
}

describe('shared talk push protocol', () => {
  const push = { revision: 1, html: '<html></html>', slides: [{ slideId: 's1', title: 'One', text: '# One' }] }

  test('accepts a well-formed push', () => {
    expect(parseSharedTalkPush(push)).toEqual({ value: push })
  })

  test('rejects bad revisions, missing HTML, duplicate slides and oversize text', () => {
    expect(errorCode(parseSharedTalkPush({ ...push, revision: 0 }))).toBe('invalid_revision')
    expect(errorCode(parseSharedTalkPush({ ...push, revision: 1.5 }))).toBe('invalid_revision')
    expect(errorCode(parseSharedTalkPush({ ...push, html: '' }))).toBe('invalid_html')
    expect(errorCode(parseSharedTalkPush({ ...push, slides: [push.slides[0], push.slides[0]] }))).toBe('duplicate_slide_id')
    expect(errorCode(parseSharedTalkPush({ ...push, slides: [{ slideId: 's1', title: 'One', text: 'x'.repeat(SHARED_TALK_LIMITS.slideTextChars + 1) }] }))).toBe('slide_too_large')
    expect(errorCode(parseSharedTalkPush({ ...push, slides: [{ slideId: '', title: 'One', text: '' }] }))).toBe('invalid_slide')
  })
})

describe('shared talk item protocol', () => {
  test('accepts each of the four kinds and keeps only their own fields', () => {
    expect(parseSharedItemPost({ itemId: 'a-1', kind: 'note', slideId: 's3', text: 'Too dense', name: '  Colleague ', extra: 'dropped' }))
      .toEqual({ value: { itemId: 'a-1', kind: 'note', slideId: 's3', text: 'Too dense', name: 'Colleague' } })
    expect(parseSharedItemPost({ itemId: 'a-2', kind: 'replace', slideId: 's3', baseRevision: 2, text: '# New' }))
      .toEqual({ value: { itemId: 'a-2', kind: 'replace', slideId: 's3', baseRevision: 2, text: '# New' } })
    expect(parseSharedItemPost({ itemId: 'a-3', kind: 'delete', slideId: 's3', baseRevision: 2, reason: '' }))
      .toEqual({ value: { itemId: 'a-3', kind: 'delete', slideId: 's3', baseRevision: 2 } })
    expect(parseSharedItemPost({ itemId: 'a-4', kind: 'insert', afterSlideId: 'start', baseRevision: 2, text: '# Hello', section: 'Opening' }))
      .toEqual({ value: { itemId: 'a-4', kind: 'insert', afterSlideId: 'start', baseRevision: 2, text: '# Hello', section: 'Opening' } })
  })

  test('rejects an unknown kind', () => {
    expect(errorCode(parseSharedItemPost({ itemId: 'a', kind: 'vote', slideId: 's3', text: 'x' }))).toBe('invalid_item_kind')
    expect(errorCode(parseSharedItemPost({ itemId: 'a', slideId: 's3', text: 'x' }))).toBe('invalid_item_kind')
  })

  test('validates each kind\'s required fields', () => {
    expect(errorCode(parseSharedItemPost({ itemId: 'a', kind: 'note', text: 'x' }))).toBe('invalid_slide_id')
    expect(errorCode(parseSharedItemPost({ itemId: 'a', kind: 'note', slideId: 's3', text: '   ' }))).toBe('invalid_text')
    expect(errorCode(parseSharedItemPost({ itemId: 'a', kind: 'replace', slideId: 's3', text: 'x' }))).toBe('invalid_base_revision')
    expect(errorCode(parseSharedItemPost({ itemId: 'a', kind: 'delete', slideId: 's3', baseRevision: 0 }))).toBe('invalid_base_revision')
    expect(errorCode(parseSharedItemPost({ itemId: 'a', kind: 'insert', slideId: 's3', baseRevision: 1, text: 'x' }))).toBe('invalid_slide_id')
    expect(errorCode(parseSharedItemPost({ itemId: 'has space', kind: 'note', slideId: 's3', text: 'x' }))).toBe('invalid_item_id')
    expect(errorCode(parseSharedItemPost({ itemId: 'a', kind: 'note', slideId: 's3', text: 'x', name: 'n'.repeat(81) }))).toBe('invalid_name')
  })

  test('caps text size', () => {
    const long = 'x'.repeat(SHARED_TALK_LIMITS.itemTextChars + 1)
    expect(errorCode(parseSharedItemPost({ itemId: 'a', kind: 'note', slideId: 's3', text: long }))).toBe('item_too_large')
    expect(errorCode(parseSharedItemPost({ itemId: 'a', kind: 'insert', afterSlideId: 's3', baseRevision: 1, text: long }))).toBe('item_too_large')
    expect(errorCode(parseSharedItemPost({ itemId: 'a', kind: 'delete', slideId: 's3', baseRevision: 1, reason: 'r'.repeat(SHARED_TALK_LIMITS.reasonChars + 1) }))).toBe('item_too_large')
    expect(errorCode(parseSharedItemPost({ itemId: 'a', kind: 'note', slideId: 's3', text: 'x'.repeat(SHARED_TALK_LIMITS.itemTextChars) }))).toBeUndefined()
  })

  test('status patches accept new, accepted, dismissed and done', () => {
    for (const status of ['new', 'accepted', 'dismissed', 'done']) expect(parseItemStatusPatch({ status })).toEqual({ value: status as never })
    expect(errorCode(parseItemStatusPatch({ status: 'archived' }))).toBe('invalid_status')
    expect(errorCode(parseItemStatusPatch(null))).toBe('invalid_status')
  })
})

describe('shared talk server messages', () => {
  test('round-trips the socket events both sides receive', () => {
    const item = { itemId: 'a-1', kind: 'note', slideId: 's3', text: 'Too dense', createdAt: 5, seq: 2, status: 'new', statusSeq: 2 }
    for (const message of [
      { type: 'talk.updated', revision: 2, seq: 3 },
      { type: 'item.status', itemId: 'a-1', status: 'accepted', at: 9, seq: 4 },
      { type: 'item.new', item, seq: 2 },
      { type: 'share.closed', reason: 'retired' },
    ]) {
      expect(parseSharedTalkServerMessage(JSON.stringify(message))).toEqual(message as never)
    }
  })

  test('rejects malformed events', () => {
    expect(parseSharedTalkServerMessage('{"type":"talk.updated","revision":0,"seq":1}')).toBeNull()
    expect(parseSharedTalkServerMessage('{"type":"item.new","item":{"itemId":"a","kind":"vote"},"seq":1}')).toBeNull()
    expect(parseSharedTalkServerMessage('not json')).toBeNull()
  })
})

import { describe, expect, test } from 'bun:test'
import {
  lookupSession,
  lookupShare,
  registerSession,
  registerShare,
  removeSession,
  removeShare,
  type RegistryEntry,
  type ShareRegistryEntry,
} from './registry-state'

describe('SessionRegistry state', () => {
  test('looks up an active session by talk slug', () => {
    const entries = new Map<string, RegistryEntry>()
    registerSession(entries, { talkSlug: 'talk-slug', sessionId: 'session-1', expiresAt: 2_000 })

    expect(lookupSession(entries, 'talk-slug', 1_500)).toEqual({ live: true, sessionId: 'session-1' })
  })

  test('expires a stale session during lookup', () => {
    const entries = new Map<string, RegistryEntry>()
    registerSession(entries, { talkSlug: 'talk-slug', sessionId: 'session-1', expiresAt: 2_000 })

    expect(lookupSession(entries, 'talk-slug', 2_000)).toEqual({ live: false })
    expect(entries.has('talk-slug')).toBe(false)
  })

  test('removes only the matching session on close', () => {
    const entries = new Map<string, RegistryEntry>()
    registerSession(entries, { talkSlug: 'talk-slug', sessionId: 'session-2', expiresAt: 3_000 })

    removeSession(entries, 'talk-slug', 'session-1')
    expect(lookupSession(entries, 'talk-slug', 1_500)).toEqual({ live: true, sessionId: 'session-2' })

    removeSession(entries, 'talk-slug', 'session-2')
    expect(lookupSession(entries, 'talk-slug', 1_500)).toEqual({ live: false })
  })
})

describe('Shared talk registry state', () => {
  test('maps a talk slug to its active share until Stop sharing removes it', () => {
    const entries = new Map<string, ShareRegistryEntry>()
    registerShare(entries, { talkSlug: 'talk-slug', shareId: 'share-a1' })
    expect(lookupShare(entries, 'talk-slug')).toEqual({ active: true, shareId: 'share-a1' })

    registerShare(entries, { talkSlug: 'talk-slug', shareId: 'share-b2' })
    removeShare(entries, 'talk-slug', 'share-a1')
    expect(lookupShare(entries, 'talk-slug')).toEqual({ active: true, shareId: 'share-b2' })

    removeShare(entries, 'talk-slug', 'share-b2')
    expect(lookupShare(entries, 'talk-slug')).toEqual({ active: false })
  })
})

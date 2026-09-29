import { expect, test } from 'bun:test'
import { applyPollOperation } from './recovery-state'
import { createSession } from './session-state'
import { parseRecoveryClientMessage, parseRecoveryServerMessage } from './recovery-protocol'

test('acknowledged instant operations are idempotent and appear in reconnect snapshots', () => {
  const session = createSession({ sessionId: 'session-a', shortId: 'abc12345', talkSlug: 'talk', createdAt: 1, expiresAt: 999999 })
  const action = { type: 'instant.show' as const, slide: { kind: 'text' as const, text: 'Discuss this', shownAt: 1000 } }
  const wire = parseRecoveryClientMessage(JSON.stringify({ type: 'operation', operationId: 'operation-123', action }))
  expect(wire?.type).toBe('operation')
  if (wire?.type !== 'operation') throw new Error('Expected operation')
  expect(applyPollOperation(session, wire).status).toBe('confirmed')
  expect(session.instantSlide).toEqual(action.slide)
  expect(applyPollOperation(session, wire).status).toBe('confirmed')
  const snapshot = parseRecoveryServerMessage(JSON.stringify({ type: 'session.snapshot', protocol: 2,
    syncId: 'sync-123', sessionId: session.sessionId, expiresAt: session.expiresAt,
    slideState: null, polls: [], receipts: [], instantSlide: session.instantSlide }))
  expect(snapshot?.type).toBe('session.snapshot')
  if (snapshot?.type !== 'session.snapshot') throw new Error('Expected snapshot')
  expect(snapshot.instantSlide).toEqual(action.slide)
  const clear = parseRecoveryClientMessage(JSON.stringify({ type: 'operation', operationId: 'operation-456', action: { type: 'instant.clear' } }))
  if (clear?.type !== 'operation') throw new Error('Expected clear operation')
  expect(applyPollOperation(session, clear).status).toBe('confirmed')
  expect(session.instantSlide).toBeNull()
})

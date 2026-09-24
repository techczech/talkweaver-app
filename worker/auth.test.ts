import { describe, expect, test } from 'bun:test'
import { createSignedToken, hashSecret, verifySignedToken } from './auth'

describe('presenter token authentication', () => {
  test('verifies a signed presenter token for its session', async () => {
    const token = await createSignedToken({ role: 'presenter', sessionId: 'session-1', exp: 2_000 }, 'signing-secret')

    expect(await verifySignedToken(token, 'signing-secret', 1_000)).toEqual({
      role: 'presenter',
      sessionId: 'session-1',
      exp: 2_000,
    })
  })

  test('rejects expired or incorrectly signed tokens', async () => {
    const token = await createSignedToken({ role: 'presenter', sessionId: 'session-1', exp: 2_000 }, 'signing-secret')

    expect(await verifySignedToken(token, 'signing-secret', 2_000)).toBeNull()
    expect(await verifySignedToken(token, 'different-secret', 1_000)).toBeNull()
  })

  test('hashes admin secrets before comparison', async () => {
    expect(await hashSecret('admin-secret')).toHaveLength(64)
    expect(await hashSecret('admin-secret')).not.toBe('admin-secret')
  })
})

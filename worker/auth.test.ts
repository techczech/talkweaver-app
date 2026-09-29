import { describe, expect, test } from 'bun:test'
import { createOwnerToken, createSignedToken, hashSecret, verifyOwnerToken, verifySignedToken } from './auth'

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

describe('shared talk owner token', () => {
  test('verifies only for its own share and signing secret', async () => {
    const token = await createOwnerToken({ role: 'owner', shareId: 'k7m2ab9x', iat: 1_000 }, 'signing-secret')

    expect(await verifyOwnerToken(token, 'signing-secret', 'k7m2ab9x')).toEqual({ role: 'owner', shareId: 'k7m2ab9x', iat: 1_000 })
    expect(await verifyOwnerToken(token, 'signing-secret', 'otherone')).toBeNull()
    expect(await verifyOwnerToken(token, 'different-secret', 'k7m2ab9x')).toBeNull()
    expect(await verifyOwnerToken(null, 'signing-secret', 'k7m2ab9x')).toBeNull()
    expect(await verifyOwnerToken(`${token}x`, 'signing-secret', 'k7m2ab9x')).toBeNull()
  })

  test('owner and presenter tokens never stand in for each other', async () => {
    const owner = await createOwnerToken({ role: 'owner', shareId: 'k7m2ab9x', iat: 1_000 }, 'signing-secret')
    const presenter = await createSignedToken({ role: 'presenter', sessionId: 'k7m2ab9x', exp: 5_000 }, 'signing-secret')

    expect(await verifySignedToken(owner, 'signing-secret', 1_000)).toBeNull()
    expect(await verifyOwnerToken(presenter, 'signing-secret', 'k7m2ab9x')).toBeNull()
  })

  test('the admin secret is not an owner token', async () => {
    expect(await verifyOwnerToken('admin-secret', 'signing-secret', 'k7m2ab9x')).toBeNull()
  })
})

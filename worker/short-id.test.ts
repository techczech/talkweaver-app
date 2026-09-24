import { expect, test } from 'bun:test'
import { generateShortId } from './short-id'

test('matches TalkWeaver publishing\'s four-character short-id style', () => {
  const id = generateShortId(() => new Uint8Array([0, 1, 26, 35]))

  expect(id).toBe('ab09')
  expect(id).toMatch(/^[a-z0-9]{4}$/)
})

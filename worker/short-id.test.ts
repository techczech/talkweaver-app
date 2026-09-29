import { expect, test } from 'bun:test'
import { generateShortId } from './short-id'

test('matches TalkWeaver publishing\'s four-character short-id style', () => {
  const id = generateShortId(() => new Uint8Array([0, 1, 26, 35]))

  expect(id).toBe('ab09')
  expect(id).toMatch(/^[a-z0-9]{4}$/)
})

test('generates longer ids on request (shared talks use eight characters)', () => {
  expect(generateShortId(undefined, 8)).toMatch(/^[a-z0-9]{8}$/)
  expect(generateShortId((length) => new Uint8Array(length).fill(1), 8)).toBe('bbbbbbbb')
})

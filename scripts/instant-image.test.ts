import { expect, test } from 'bun:test'
import sharp from 'sharp'
import { fitInstantImage, INSTANT_IMAGE_REFUSAL } from '../src/main/instant-image'
import { parseRecoveryClientMessage } from '../worker/recovery-protocol'

test('fits a 2880 by 1800 screenshot into the live operation', async () => {
  const screenshot = await sharp({ create: { width: 2880, height: 1800, channels: 3, background: '#f8f7f2' } })
    .composite([{ input: Buffer.from('<svg width="2880" height="1800"><rect x="100" y="100" width="2680" height="110" fill="#16324b"/><text x="160" y="180" font-size="60" fill="white">Screenshot of a discussion</text><rect x="160" y="300" width="1600" height="650" fill="#d9e8ef"/></svg>') }])
    .png().toBuffer()
  const result = await fitInstantImage(screenshot)
  expect(result.success).toBe(true)
  if (!result.success) return
  expect([result.sourceWidth, result.sourceHeight]).toEqual([2880, 1800])
  expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(1600)
  expect((await sharp(Buffer.from(result.dataUrl.split(',')[1], 'base64')).metadata()).format).toBe('webp')
  const slide = { kind: 'image', dataUrl: result.dataUrl, width: result.width, height: result.height, shownAt: 1000 }
  expect(parseRecoveryClientMessage(JSON.stringify({ type: 'operation', operationId: 'image-show-1', action: { type: 'instant.show', slide } }))?.type).toBe('operation')
})

test('refuses an incompressible image that still exceeds the budget at 960px', async () => {
  const pixels = Buffer.alloc(960 * 960 * 3)
  let seed = 123456789
  for (let i = 0; i < pixels.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; pixels[i] = seed & 255 }
  const image = await sharp(pixels, { raw: { width: 960, height: 960, channels: 3 } }).png().toBuffer()
  expect(await fitInstantImage(image)).toEqual({ success: false, error: INSTANT_IMAGE_REFUSAL })
})

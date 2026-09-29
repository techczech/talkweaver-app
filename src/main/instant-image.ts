import sharp from 'sharp'

// The Worker accepts 128,000 characters for the entire operation. Leave room for
// its envelope, and stay below the legacy Durable Object's 128 KiB value limit too.
export const MAX_INSTANT_IMAGE_DATA_URL = 120_000
export const INSTANT_IMAGE_REFUSAL = 'This image is too detailed to show live. Try a smaller screenshot or crop it first.'

export async function fitInstantImage(bytes: Uint8Array): Promise<
  { success: true; dataUrl: string; width: number; height: number; sourceWidth: number; sourceHeight: number }
  | { success: false; error: string }
> {
  try {
    const source = sharp(bytes, { limitInputPixels: 100_000_000 })
    const metadata = await source.metadata()
    if (!metadata.width || !metadata.height) throw new Error('Missing image dimensions')
    for (const longest of [1600, 1400, 1200, 960]) {
      for (const quality of [78, 60, 42, 25, 10]) {
        const { data, info } = await source.clone()
          .resize({ width: longest, height: longest, fit: 'inside', withoutEnlargement: true })
          .webp({ quality, effort: 4 }).toBuffer({ resolveWithObject: true })
        const dataUrl = `data:image/webp;base64,${data.toString('base64')}`
        if (dataUrl.length <= MAX_INSTANT_IMAGE_DATA_URL) {
          return { success: true, dataUrl, width: info.width, height: info.height,
            sourceWidth: metadata.width, sourceHeight: metadata.height }
        }
      }
    }
  } catch { /* The preview gives the same actionable message for unsupported images. */ }
  return { success: false, error: INSTANT_IMAGE_REFUSAL }
}

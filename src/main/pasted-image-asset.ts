// ADR-0020 pasted-image store — the one code path behind `asset:paste-image` and "Add to talk" for an
// instant image slide (live-presenting ticket 07). Clipboard images are normalised to WebP (the smaller
// of WebP and the original is kept; any conversion failure keeps the original, so a paste never fails),
// content-addressed by the STORED bytes as `img-<sha256:7>` under `<vault>/_assets`, with a minimal
// sidecar .yml. The outline references the asset by id: `![](img-xxxxxxx)`.
//
// "Add to talk" calls it with `requireDecode`: the conversion IS the decode, so a failed (or empty)
// conversion refuses and writes nothing — the original bytes are never stored as a fallback on that
// route. The clipboard paste route keeps its never-fail fallback unchanged.
import { createHash } from 'crypto'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

export async function storePastedImage(
  vaultRoot: string,
  bytes: Uint8Array,
  ext: string,
  toWebp: (buf: Buffer) => Promise<Buffer>,
  options: { requireDecode?: boolean } = {},
): Promise<{ id: string; ext: string; path: string }> {
  const origBuf: Buffer = Buffer.from(bytes)
  const originalFormat = ext
  let storeBuf: Buffer = origBuf
  let storeExt = ext
  let note = 'stored as-is (no conversion)'
  let webp: Buffer | null = null
  try {
    webp = await toWebp(origBuf)
  } catch (convErr) {
    if (!options.requireDecode) console.warn('[asset:paste-image] sharp webp conversion unavailable, falling back to original:', convErr)
  }
  if (options.requireDecode && (!webp || webp.length === 0)) throw new Error('image-not-decodable')
  if (!webp) {
    note = 'webp conversion failed; kept ' + originalFormat
  } else if (webp.length > 0 && webp.length <= origBuf.length) {
    // Keep the smaller file (ADR-0020: "If conversion produces a larger file or fails, the original
    // format is kept").
    storeBuf = webp
    storeExt = 'webp'
    note = 'converted to webp via sharp (quality 82)'
  } else {
    note = 'webp larger than original; kept ' + originalFormat
  }
  const hash = createHash('sha256').update(storeBuf).digest('hex').slice(0, 7)
  const id = 'img-' + hash
  const assetsDir = join(vaultRoot, '_assets')
  if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true })
  const assetPath = join(assetsDir, id + '.' + storeExt)
  if (!existsSync(assetPath)) {
    writeFileSync(assetPath, storeBuf)
    const sidecarPath = join(assetsDir, id + '.yml')
    if (!existsSync(sidecarPath)) {
      writeFileSync(sidecarPath, [
        'id: ' + id,
        'created: ' + new Date().toISOString().slice(0, 10),
        'original_format: ' + originalFormat,
        'note: ' + JSON.stringify(note),
        'alt: ""',
        'caption: ""',
        'source: ""',
        'tags: []',
      ].join('\n') + '\n', 'utf8')
    }
  }
  return { id, ext: storeExt, path: assetPath }
}

type SharpLike = (input: Buffer) => {
  metadata(): Promise<{ width?: number; height?: number }>
  webp(options: { quality: number }): { toBuffer(): Promise<Buffer> }
}

/**
 * The strict converter for "Add to talk": the image library must read a width and height above zero
 * and decode the pixels to WebP, or this throws. `sharp` is passed in (loaded lazily by the caller).
 */
export async function decodeToWebp(sharp: SharpLike, buf: Buffer): Promise<Buffer> {
  const meta = await sharp(buf).metadata()
  if (!(Number(meta.width) > 0 && Number(meta.height) > 0)) throw new Error('image-not-decodable')
  const webp = await sharp(buf).webp({ quality: 82 }).toBuffer()
  if (!webp.length) throw new Error('image-not-decodable')
  return webp
}

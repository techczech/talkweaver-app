// Is this file an image? By its extension AND its first bytes (ticket 10, fix round 1). The
// archive provider serves and imports nothing else, so a database, a package.json or any other file
// that happens to sit inside the archive root is refused even when a URL names it.

import { closeSync, openSync, readSync, statSync } from 'fs'

export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic'])

export const extOf = (p: string): string => (p.split('.').pop() || '').toLowerCase()

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) // all eight bytes
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'])

/** The image format the leading bytes announce, or null when they are not a known image. */
export function imageMagic(b: Buffer): string | null {
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b.length >= 6 && (b.toString('latin1', 0, 6) === 'GIF87a' || b.toString('latin1', 0, 6) === 'GIF89a')) return 'gif'
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp'
  if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a))) return 'tiff'
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp' && HEIF_BRANDS.has(b.toString('latin1', 8, 12))) return 'heic'
  return null
}

/** An image extension and image bytes. Either kind of image is accepted for either extension: a
 *  mislabelled picture (a JPEG saved as .png) is still a picture; anything that is not one is refused. */
export function isImageFile(absPath: string): boolean {
  if (!IMAGE_EXTS.has(extOf(absPath))) return false
  let fd: number | null = null
  try {
    if (!statSync(absPath).isFile()) return false // never open a directory, FIFO or device
    fd = openSync(absPath, 'r')
    const head = Buffer.alloc(16)
    const n = readSync(fd, head, 0, 16, 0)
    return imageMagic(head.subarray(0, n)) !== null
  } catch {
    return false // missing, a directory, unreadable
  } finally {
    if (fd !== null) try { closeSync(fd) } catch { /* already closed */ }
  }
}

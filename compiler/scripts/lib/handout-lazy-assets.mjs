// Published handout pages (index.html, <slug>.html) load their heavy slide assets lazily. This module
// moves every inline image or video in a slide whose data is at least `minBytes` into a content-hashed
// file beside the page and leaves a placeholder: an image keeps its exact intrinsic size through a tiny
// SVG of the same width and height, so the slide lays out as it will look; a video loses only its src.
// Both carry data-lazy-src for the page's loader (compiler/assets/runtime/lazy-slide-assets.js).
// An image whose size cannot be read stays inline. The Download handout never goes through here.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const SLIDE_ASSET_DIR = 'slide-assets'
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' }

/** Width and height of a PNG, JPEG, GIF, WebP or SVG, or null. */
export function imageSize(buf, mime) {
  try {
    if (mime === 'image/png' && buf.length > 24 && buf.toString('ascii', 12, 16) === 'IHDR') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
    if (mime === 'image/gif' && buf.length > 10) return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) }
    if (mime === 'image/webp' && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const chunk = buf.toString('ascii', 12, 16)
      if (chunk === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) }
      if (chunk === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff }
      if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); return { w: 1 + (b & 0x3fff), h: 1 + ((b >> 14) & 0x3fff) } }
      return null
    }
    if ((mime === 'image/jpeg' || mime === 'image/jpg') && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue }
        const marker = buf[i + 1]
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
        const len = buf.readUInt16BE(i + 2)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) }
        i += 2 + len
      }
      return null
    }
    if (mime === 'image/svg+xml') {
      const head = buf.toString('utf8', 0, Math.min(buf.length, 4096))
      const tag = (head.match(/<svg\b[^>]*>/i) || [''])[0]
      const num = (name) => Number(((tag.match(new RegExp(`\\b${name}="([\\d.]+)(px)?"`)) || [])[1]))
      if (num('width') > 0 && num('height') > 0) return { w: num('width'), h: num('height') }
      const vb = (tag.match(/viewBox="[\d.\-]+[\s,]+[\d.\-]+[\s,]+([\d.]+)[\s,]+([\d.]+)"/) || [])
      if (Number(vb[1]) > 0 && Number(vb[2]) > 0) return { w: Number(vb[1]), h: Number(vb[2]) }
    }
  } catch { /* unreadable header */ }
  return null
}

const placeholderSrc = ({ w, h }) => `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'%3E%3C/svg%3E`

// Spans of the page that are never slide markup: scripts, styles and inert templates (pre-work steps).
function skipSpans(html) {
  const spans = []
  for (const m of html.matchAll(/<(script|style|template)\b[\s\S]*?<\/\1>/gi)) spans.push([m.index, m.index + m[0].length])
  return spans
}

/** Cloudflare Pages refuses a file over 25 MiB: an asset above this stays inline (and is slimmed with the page). */
export const MAX_ASSET_BYTES = 24 * 1024 * 1024
export const PAGE_FILE_LIMIT = 25 * 1024 * 1024
const hashPath = (dir, data, ext) => `${dir}/${createHash('sha256').update(data).digest('hex').slice(0, 20)}.${ext}`
const DATA_ATTR = (attr) => new RegExp(`\\s${attr}="data:([a-z]+\\/[a-z0-9+.-]+);base64,([A-Za-z0-9+/=]+)"`, 'i')

/**
 * @param {string} html a built handout page (buildShareHtml with lazyAssets: true)
 * @param {{ minBytes?: number, maxAssetBytes?: number, dir?: string }} [options]
 * @returns {{ html: string, files: Array<{ path: string, data: Buffer, type: string }>, oversize: Array<{ type: string, bytes: number }> }}
 */
export function externaliseSlideAssets(html, { minBytes = 8 * 1024, maxAssetBytes = MAX_ASSET_BYTES, dir = SLIDE_ASSET_DIR } = {}) {
  const firstSlide = html.search(/<section\b[^>]*\bdata-share-index="/)
  if (firstSlide < 0) return { html, files: [], oversize: [] }
  const spans = skipSpans(html)
  const skipped = (at) => at < firstSlide || spans.some(([a, b]) => at >= a && at < b)
  const files = new Map()
  const oversize = []
  // One data attribute of a tag → [the replacement text, or null to leave it inline].
  const take = (match, kind) => {
    const mime = match[1].toLowerCase()
    const ext = EXT[mime]
    if (!ext || !mime.startsWith(kind === 'video' ? 'video/' : 'image/')) return null
    const data = Buffer.from(match[2], 'base64')
    if (data.length < minBytes) return null
    if (data.length > maxAssetBytes) { oversize.push({ type: mime, bytes: data.length }); return null }
    const size = kind === 'img' ? imageSize(data, mime) : null
    if (kind === 'img' && !size) return null
    const path = hashPath(dir, data, ext)
    files.set(path, { path, data, type: mime })
    if (kind === 'img') return ` src="${placeholderSrc(size)}" data-lazy-src="${path}"`
    if (kind === 'poster') return ` data-lazy-poster="${path}"`
    return ` data-lazy-src="${path}" preload="none"`
  }
  const out = html.replace(/<(img|video)\b[^>]*>/gi, (tag, name, at) => {
    if (skipped(at)) return tag
    const isImg = name.toLowerCase() === 'img'
    let next = tag
    const src = tag.match(DATA_ATTR('src'))
    const srcText = src && take(src, isImg ? 'img' : 'video')
    if (srcText) next = next.replace(src[0], srcText)
    if (!isImg) {
      const poster = next.match(DATA_ATTR('poster'))
      const posterText = poster && take(poster, 'poster')
      if (posterText) next = next.replace(poster[0], posterText)
    }
    return next
  })
  return { html: out, files: [...files.values()], oversize }
}

const referencedAssets = (html) => new Set([...String(html).matchAll(/data-lazy-(?:src|poster)="([^"]+)"/g)].map((m) => m[1]))
const defaultIo = { writeFile: (path, data) => writeFileSync(path, data), rename: (from, to) => renameSync(from, to) }

/**
 * Publish a talk folder's handout pages together. `pages`: [{ fileName, html, lazy? }]; a lazy page has
 * its heavy slide media moved into slide-assets/ first and only the residual page is slimmed (and only
 * when it is still over the Pages limit); a page with lazy: false (the Download handout) is slimmed
 * whole. Order, so a throw anywhere leaves the previous pages and their assets loadable:
 *   1. build every page and asset in memory;  2. write new assets (hashed names never collide with
 *   files in use);  3. write every page to a temp file;  4. rename the temps over the pages;
 *   5. prune assets referenced neither by the new pages nor by the pages they replaced, so phones
 *   still open on the previous publish keep loading their images for one generation.
 * @param {string} talkOutDir
 * @param {Array<{ fileName: string, html: string, lazy?: boolean }>} pages
 * @param {{ slim?: (html: string) => string, minBytes?: number, maxAssetBytes?: number, io?: { writeFile: Function, rename: Function } }} [options]
 * @returns {{ pages: Array<{ fileName: string, bytes: number, assets: number }>, warnings: string[] }}
 */
export function publishLazyHandoutPages(talkOutDir, pages, options = {}) {
  const slim = options.slim || ((html) => html)
  const io = options.io || defaultIo
  const warnings = []
  // Unique per call (pid + nonce): two overlapping publishes of one talk never share a temp file.
  const tempSuffix = `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`
  const built = pages.map((page) => {
    if (page.lazy === false) return { fileName: page.fileName, html: slim(page.html), files: [] }
    const { html, files, oversize } = externaliseSlideAssets(page.html, options)
    for (const o of oversize) warnings.push(`${page.fileName}: a ${o.type} of ${(o.bytes / 1048576).toFixed(1)} MB is over the per-file limit; it stays in the page and may be replaced by a placeholder.`)
    return { fileName: page.fileName, html: Buffer.byteLength(html, 'utf8') > MAX_ASSET_BYTES ? slim(html) : html, files }
  })
  const previous = new Set()
  for (const page of pages) {
    const path = join(talkOutDir, page.fileName)
    if (existsSync(path)) for (const ref of referencedAssets(readFileSync(path, 'utf8'))) previous.add(ref)
  }
  const assetDir = join(talkOutDir, SLIDE_ASSET_DIR)
  const files = new Map(built.flatMap((page) => page.files.map((file) => [file.path, file])))
  if (files.size) mkdirSync(assetDir, { recursive: true })
  for (const file of files.values()) {
    const target = join(talkOutDir, file.path)
    if (existsSync(target)) continue
    const temp = `${target}${tempSuffix}`
    io.writeFile(temp, file.data)
    io.rename(temp, target)
  }
  const temps = []
  try {
    for (const page of built) {
      const temp = join(talkOutDir, `.${page.fileName}${tempSuffix}`)
      temps.push(temp)
      io.writeFile(temp, page.html)
    }
  } catch (error) {
    for (const temp of temps) rmSync(temp, { force: true })
    throw error
  }
  built.forEach((page, i) => io.rename(temps[i], join(talkOutDir, page.fileName)))
  const keep = new Set([...previous, ...built.flatMap((page) => [...referencedAssets(page.html)])])
  if (existsSync(assetDir)) {
    for (const name of readdirSync(assetDir)) if (!name.includes('.tmp-') && !keep.has(`${SLIDE_ASSET_DIR}/${name}`)) rmSync(join(assetDir, name), { force: true })
  }
  const result = built.map((page) => ({ fileName: page.fileName, bytes: Buffer.byteLength(page.html, 'utf8'), assets: referencedAssets(page.html).size }))
  for (const page of result) if (page.bytes > PAGE_FILE_LIMIT) warnings.push(`${page.fileName} is ${(page.bytes / 1048576).toFixed(1)} MB, over the 25 MiB per-file limit.`)
  return { pages: result, warnings }
}

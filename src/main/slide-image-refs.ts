// The one answer to "which picture files does this slide show?", used both to decide what to read
// for image text and by the slide search to attach that text to a slide.
//
// Syntaxes a TalkWeaver slide can name a picture by (read from the compiler: 03-markdown-lexer-core
// IMAGE_SYNTAX_RE / image-line-rules, 08-source-adapters asset visitor, title-poster.mjs, image-refs.ts):
//   1. Markdown image  ![alt](path "caption"){attrs}  - own line or inline; path relative to the talk,
//      absolute, percent-encoded, or `<angle bracketed>`; also a pooled id  ![](img-1a2b3c4).
//   2. A video in image syntax or [Video: file]: the compiler shows a sibling poster picture with the
//      video's stem (talk.mp4 -> talk.webp/.png/.jpg/.jpeg); a pooled clip id vid-1a2b3c4 has the poster
//      _assets/vid-1a2b3c4.jpg.
//   3. The deck's frontmatter `logo:` (title poster).
//   4. HTML  <img src=...>  and  <video poster=...>  (not rendered by the lexer today, but pasted HTML is
//      read as the author meant it).
//   5. Obsidian-style embeds  ![[file.png]] / ![[file.png|300]]  (the compiler does not draw these today;
//      extracted so a talk imported from Obsidian is found by its picture text).
// Inline <svg> in a `:::object` block is slide text already: the body haystack has its <text> content.

import { existsSync } from 'fs'
import { dirname, extname, join } from 'path'
import { pathStaysInside } from './path-containment.ts'
import { extractImageRefs, type ImageRef, type ImageRefKind } from '../shared/slide-handling/image-refs.ts'

/** Formats macOS Vision reads. */
export const OCR_IMAGE_EXTS: readonly string[] = ['webp', 'png', 'jpg', 'jpeg', 'gif', 'heic', 'heif', 'tif', 'tiff', 'bmp']
/** A picture whose text is read straight from its XML, not by Vision. */
export const SVG_EXT = 'svg'
const POOL_EXTS = OCR_IMAGE_EXTS
const POSTER_EXTS = ['webp', 'png', 'jpg', 'jpeg']
const VIDEO_RE = /\.(mp4|webm|mov|m4v)$/i
export { extractImageRefs }
export type { ImageRef, ImageRefKind }

/** Picture references in a talk's frontmatter (the title poster's `logo:`). */
export function extractFrontmatterImageRefs(outlineText: string): ImageRef[] {
  const fm = String(outlineText || '').match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/)
  if (!fm) return []
  const out: ImageRef[] = []
  for (const line of fm[1].split(/\r?\n/)) {
    const m = line.match(/^logo:\s*(.+)$/)
    if (m) {
      const ref = m[1].trim().replace(/^["']|["']$/g, '')
      if (ref) out.push({ ref, kind: 'picture' })
    }
  }
  return out
}

/**
 * The deck-level pictures the compiler draws on generated slides. Today: the frontmatter `logo:`,
 * which the title poster shows (title-poster.mjs posterBlockFor + 06-block-renderers): on every
 * slide whose layout is `closing` (the closing variant always draws it) and on every `title`
 * slide when the opening uses the default `poster` variant (`title_style: split|banner` draws no
 * logo). That covers the synthesised deck-title / deck-thanks rows (empty source markdown) and
 * authored {title} / {closing} slides alike.
 */
export interface DeckPictures { logo: ImageRef[]; openingShowsLogo: boolean }

const POSTER_TITLE_STYLES = ['poster', 'split', 'banner']

export function deckPicturesOf(outlineText: string): DeckPictures {
  const logo = extractFrontmatterImageRefs(outlineText)
  let style = 'poster'
  const fm = String(outlineText || '').match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/)
  if (fm) {
    for (const line of fm[1].split(/\r?\n/)) {
      const m = line.match(/^title_style:\s*(.*)$/)
      if (m) {
        const named = m[1].trim().replace(/^["']|["']$/g, '').toLowerCase()
        style = POSTER_TITLE_STYLES.includes(named) ? named : 'poster'
      }
    }
  }
  return { logo, openingShowsLogo: style === 'poster' }
}

/** Does the compiler draw the deck logo on this row's slide? */
export function rowShowsDeckLogo(row: { layout?: unknown }, deck: DeckPictures | null | undefined): boolean {
  if (!deck || !deck.logo.length) return false
  return row.layout === 'closing' || (row.layout === 'title' && deck.openingShowsLogo)
}

/** Every picture reference one row's slide shows: its own markdown's, plus the deck logo where drawn. */
export function rowImageRefs(row: { source_markdown?: unknown; layout?: unknown }, deck?: DeckPictures | null): ImageRef[] {
  const own = extractImageRefs(String(row.source_markdown || ''))
  if (!rowShowsDeckLogo(row, deck)) return own
  const seen = new Set(own.map((r) => r.ref))
  return [...own, ...deck!.logo.filter((r) => !seen.has(r.ref))]
}

export interface ResolveDeps { exists?: (path: string) => boolean }

function hasExt(path: string, exts: readonly string[]): boolean {
  return exts.includes(extname(path).slice(1).toLowerCase())
}

/**
 * Resolve references to absolute picture files inside the vault (a slide must not pick up the text
 * of a picture elsewhere on this Mac, ADR-0036). Pictures only: the result holds OCR-able files and
 * svg; a video contributes its poster picture when one exists.
 */
export function resolveImagePaths(refs: ImageRef[], talkDir: string, vaultRoot: string, deps: ResolveDeps = {}): string[] {
  const exists = deps.exists ?? existsSync
  const out: string[] = []
  const seen = new Set<string>()
  const push = (p: string | null): void => { if (p && !seen.has(p)) { seen.add(p); out.push(p) } }
  const inside = (abs: string): string | null => (pathStaysInside(vaultRoot, abs) ? abs : null)
  for (const { ref, kind } of refs) {
    let s = ref.trim()
    if (!s || /^(https?:|data:|file:|blob:)/i.test(s)) continue
    s = s.replace(/^img-img-([0-9a-f]{7})$/, 'img-$1')
    if (/^img-[0-9a-f]{7}$/.test(s)) {
      for (const ext of POOL_EXTS) {
        const p = join(vaultRoot, '_assets', s + '.' + ext)
        if (exists(p)) { push(inside(p)); break }
      }
      continue
    }
    if (/^vid-[0-9a-f]{7}$/.test(s)) {
      const p = join(vaultRoot, '_assets', s + '.jpg')
      if (exists(p)) push(inside(p))
      continue
    }
    try { s = decodeURIComponent(s) } catch { /* keep raw */ }
    const candidates: string[] = []
    const absOf = (v: string): string => (v.startsWith('/') ? v : join(talkDir, v))
    if (!/[/\\]/.test(s) && kind === 'picture' && !VIDEO_RE.test(s)) {
      // A bare file name (an ![[embed]]): next to the outline, in its assets/, or in the pool.
      candidates.push(join(talkDir, s), join(talkDir, 'assets', s), join(vaultRoot, '_assets', s))
    } else {
      candidates.push(absOf(s))
    }
    for (const c of candidates) {
      let path = c
      if (!exists(path) && /[?#]/.test(path)) path = path.split(/[?#]/)[0]
      if (VIDEO_RE.test(path)) {
        // The compiler's poster: a sibling picture with the video's stem.
        const stem = path.slice(0, -extname(path).length)
        for (const ext of POSTER_EXTS) {
          const poster = stem + '.' + ext
          if (exists(poster)) { push(inside(poster)); break }
        }
        break
      }
      if (hasExt(path, OCR_IMAGE_EXTS) || hasExt(path, [SVG_EXT])) {
        // A reference that does not exist is still reported: the file may arrive later and its
        // text then attaches. An existing one is the first candidate that is a file.
        if (exists(path) || candidates.length === 1) { push(inside(path)); break }
      }
    }
  }
  return out
}

/** Absolute picture files one slide's markdown names (extract + resolve). */
export function slideImagePaths(markdown: string, talkDir: string, vaultRoot: string, deps: ResolveDeps = {}): string[] {
  const refs = extractImageRefs(markdown)
  return refs.length ? resolveImagePaths(refs, talkDir, vaultRoot, deps) : []
}

/** Absolute picture files a whole talk names: every slide's, plus the frontmatter's. */
export function talkImagePaths(rows: Array<{ source_markdown?: unknown }>, outlinePath: string, vaultRoot: string, outlineText?: string, deps: ResolveDeps = {}): string[] {
  const talkDir = dirname(outlinePath)
  const seen = new Set<string>()
  const out: string[] = []
  const take = (paths: string[]): void => { for (const p of paths) if (!seen.has(p)) { seen.add(p); out.push(p) } }
  for (const row of rows) take(slideImagePaths(String(row.source_markdown || ''), talkDir, vaultRoot, deps))
  if (outlineText) take(resolveImagePaths(extractFrontmatterImageRefs(outlineText), talkDir, vaultRoot, deps))
  return out
}

/** Does this path get read for image text (Vision or svg)? */
export function isReadableImagePath(path: string): boolean {
  return hasExt(path, OCR_IMAGE_EXTS) || hasExt(path, [SVG_EXT])
}

/** The extensions (with dot) the asset-folder scan collects for image text: Vision formats + svg. */
export const OCR_PICTURE_EXTS: ReadonlySet<string> = new Set([...OCR_IMAGE_EXTS, SVG_EXT].map((e) => '.' + e))

// Slide Scratchpad ticket 2: Insert visual only, main's side. A visual becomes a line the renderer puts into the
// talk through the editor (one undo step); this module only copies the file it needs into the talk's vault and
// names the line. It never writes the outline, and it never writes, moves or deletes the file it copies from.
//
//   picture (.png .jpg .jpeg .webp .gif) → the image drawer's import into the vault pool (image-search/image-import.ts
//       importImageForTalk): `![](img-<hash>)`.
//   SVG → the vault pool does not take SVG (main/image-refs.ts resolves `img-` ids to webp/png/jpg/jpeg/gif only, so
//       an `img-…svg` would never show), so the nearest path that does: the talk's own `assets/` folder, through
//       Insert › HTML page…'s checked copy (html-page-import.ts, kind 'svg'): `![](assets/<name>.svg)`, which the
//       compiler inlines as a picture.
//   HTML page → Insert › HTML page…'s copy into `assets/`: `[Embed: assets/<name>.html]`. Always a copy, even though
//       the agent's file already sits inside the talk folder (alwaysCopy): the agent may write that file again.
//
// For a picked slide's SVG file or page named by a path, the file is found below the source talk's folder and must
// stay inside that talk's vault (slideVisualFile).
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathStaysInside } from './path-containment.ts'
import type { HtmlPageImport } from '../shared/html-page-import.ts'
import type { ScratchFileKind, ScratchSlide, ScratchVisualImport } from '../shared/scratchpad.ts'

export interface ScratchVisualImportDeps {
  /** The pool import for one file (importImageForTalk with a lookup that answers only this file); null: refused. */
  importPicture(path: string, outlinePath: string, provenance: { source: string; note: string }): Promise<{ id: string } | null>
  /** The checked copy into `<talk folder>/assets/` (importHtmlPage with alwaysCopy). */
  copyIntoAssets(path: string, outlinePath: string, kind: 'html' | 'svg'): Promise<HtmlPageImport>
}

export interface VisualRequest {
  kind: ScratchFileKind
  /** The file to copy from (absolute, checked by the caller). */
  path: string
  /** The talk the line will go into. */
  outlinePath: string
  /** Where the file came from, for the picture's provenance sidecar ("scratchpad/chart.png", "a talk's assets/x.png"). */
  from: string
}

export const VISUAL_TEXT = {
  picture: 'The picture could not be copied into the vault’s pictures, so nothing was inserted.',
  copy: (what: 'SVG' | 'page', why: string): string => `The ${what} could not be copied into the talk’s assets folder, so nothing was inserted. ${why}`.trim()
} as const

export function createScratchVisualImporter(deps: ScratchVisualImportDeps): (request: VisualRequest) => Promise<ScratchVisualImport> {
  return async ({ kind, path, outlinePath, from }) => {
    if (kind === 'pic') {
      let imported: { id: string } | null = null
      try { imported = await deps.importPicture(path, outlinePath, { source: from, note: 'from the Slide Scratchpad' }) } catch { imported = null }
      if (!imported?.id) return { ok: false, error: VISUAL_TEXT.picture }
      const id = imported.id.startsWith('img-') ? imported.id : `img-${imported.id}`
      return { ok: true, line: `![](${id})` }
    }
    let copied: HtmlPageImport
    try { copied = await deps.copyIntoAssets(path, outlinePath, kind === 'svg' ? 'svg' : 'html') } catch { copied = { ok: false, reason: 'write-failed', message: '' } }
    if (!copied.ok) return { ok: false, error: VISUAL_TEXT.copy(kind === 'svg' ? 'SVG' : 'page', copied.reason === 'not-html' ? '' : copied.message) }
    if (kind === 'svg') return { ok: true, line: `![](${copied.embedPath})` }
    return { ok: true, line: `[Embed: ${copied.embedPath}]`, page: { embedPath: copied.embedPath, how: copied.how, localReferences: copied.localReferences } }
  }
}

/**
 * The outline of the talk a slide was picked from. A picked slide names its talk relative to the vault that was
 * open when it was picked (or absolutely, for a talk outside it); `roots` are the vault roots to try, in order (the
 * vault holding this talk, the slide's own vault, the current vault). The first that holds the file wins; the first
 * that could hold it otherwise (the source talk may have been deleted: the snapshot still inserts). Null when the
 * name leaves every root.
 */
export function slideSourceOutline(slide: Pick<ScratchSlide, 'talkPath'>, roots: readonly string[], exists: (path: string) => boolean = existsSync): string | null {
  const name = slide.talkPath
  if (typeof name !== 'string' || name === '' || name.includes('\0')) return null
  if (isAbsolute(name)) return resolve(name)
  // The path as the vault names it (not its real path): the vault registry finds a talk by that spelling.
  const candidates: string[] = []
  for (const root of roots) {
    if (!root) continue
    const path = join(root, name)
    if (!candidates.includes(path) && pathStaysInside(root, path) !== null) candidates.push(path)
  }
  return candidates.find((p) => exists(p)) ?? candidates[0] ?? null
}

/** A picked slide's SVG file or page, from what the snapshot names: below the source talk's folder (or absolute),
 *  decoded as the compiler reads it, and inside `sourceRoot` (that talk's vault). Null for anything else. */
export function slideVisualFile(sourceOutline: string, ref: string, sourceRoot: string): string | null {
  let name = String(ref ?? '').split(/[?#]/)[0].trim()
  if (!name || name.includes('\0') || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(name)) return null
  try { name = decodeURIComponent(name) } catch { /* as written */ }
  const path = isAbsolute(name) ? resolve(name) : join(dirname(sourceOutline), name)
  return pathStaysInside(sourceRoot, path) ? path : null
}

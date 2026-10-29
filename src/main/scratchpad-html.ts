// The Slide Scratchpad's live preview of an agent's HTML file: the same page, policy and sandbox an
// `[Embed: assets/….html]` page gets (compiler/scripts/lib/embed-frame.mjs, 08-source-adapters.mjs).
// The document is kept in a small preview store and served by the existing twpresent://preview/… path;
// the renderer shows it in an iframe with the returned sandbox value (an opaque origin: allow-scripts
// and allow-forms, never allow-same-origin). It gets no preload, no Node and no file access.
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { slidePreviewUrl, type SlidePreviewStore } from '../shared/slide-preview.ts'

const MAX_PAGE_BYTES = 20 * 1024 * 1024

export interface ScratchHtmlPreview { url: string; sandbox: string }

const SCRATCH_PREVIEW_PREFIX = 'twpresent://preview/scratch-'
const SCRATCH_PREVIEW_ID = /^[0-9a-f]{24}\.html$/

const withoutHash = (url: string): string => { const cut = url.indexOf('#'); return cut < 0 ? url : url.slice(0, cut) }

/** An agent page's live preview address (what previewFor answers), with or without a hash. */
export function isScratchPreviewUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false
  const page = withoutHash(url)
  return page.startsWith(SCRATCH_PREVIEW_PREFIX) && SCRATCH_PREVIEW_ID.test(page.slice(SCRATCH_PREVIEW_PREFIX.length))
}

/**
 * A frame that shows an agent's page may not leave it: the page's own script could otherwise send its frame to
 * twfile:// or twpresent:// (app schemes the general frame rule lets through) and read another file of the vault.
 * Its CSP keeps app schemes out of anything it loads or frames; this covers the frame's own navigation, which CSP
 * cannot. 'deny' when `frameUrl` is a scratch preview and `to` is any other address (its own address, a reload,
 * stays allowed); null when the frame is not on a scratch preview, so the general rule decides.
 * Seen in the built app (Electron 42, 2026-10-28, e2e/diagnose-scratchpad-insert.mjs): a page's own move to another
 * twpresent:// page raises will-frame-navigate and is refused here; a move to twfile:// raises none, but the
 * sandboxed frame is left on an empty document and never shows the file. The thumbnail capture checks the frame's
 * address itself before reading anything (scratchpad-html-capture.ts).
 */
export function scratchFrameNavigation(frameUrl: unknown, to: unknown): 'deny' | null {
  if (!isScratchPreviewUrl(frameUrl)) return null
  return typeof to === 'string' && withoutHash(to) === withoutHash(frameUrl as string) ? null : 'deny'
}

/** Two addresses of the same page (a hash is the page's own business). */
export const samePreviewAddress = (a: unknown, b: string): boolean => typeof a === 'string' && withoutHash(a) === withoutHash(b)

/** The capture wrapper's one child frame, when it (still) shows the page's own preview address; otherwise null, and
 *  nothing is captured (scratchpad-html-capture.ts). `topUrl`: the wrapper's address, itself a preview page. */
export function previewFrame<F>(topUrl: string, children: readonly { frame: F; url: string }[], previewUrl: string): F | null {
  if (!topUrl.startsWith('twpresent://preview/')) return null
  if (children.length !== 1) return null
  return samePreviewAddress(children[0].url, previewUrl) ? children[0].frame : null
}

export function createScratchpadHtmlPreviews(deps: { compilerDir: () => string | null; store: SlidePreviewStore }) {
  return async function previewFor(path: string): Promise<ScratchHtmlPreview | { error: string }> {
    const compilerDir = deps.compilerDir()
    if (!compilerDir) return { error: 'The page renderer is not available.' }
    let text: string
    try {
      const info = lstatSync(path)
      if (!info.isFile()) return { error: 'This file is not a page.' }
      if (info.size > MAX_PAGE_BYTES) return { error: 'This page is too large to preview.' }
      text = readFileSync(path, 'utf8')
    } catch { return { error: 'The file could not be read.' } }
    const frame = await import(pathToFileURL(join(compilerDir, 'lib/embed-frame.mjs')).href) as {
      withEmbedLead: (html: string, policyMeta: string) => string
      embedSandboxValue: (kind: 'local' | 'remote') => string
    }
    const adapters = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href) as { EMBED_PAGE_POLICY: string }
    const policyMeta = `<meta http-equiv="Content-Security-Policy" content="${adapters.EMBED_PAGE_POLICY}">`
    const doc = frame.withEmbedLead(text, policyMeta)
    const id = `scratch-${createHash('sha256').update(doc).digest('hex').slice(0, 24)}`
    deps.store.set(id, doc)
    return { url: slidePreviewUrl(id), sandbox: frame.embedSandboxValue('local') }
  }
}

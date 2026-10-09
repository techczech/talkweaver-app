import {
  EditorView,
  ViewPlugin,
  Decoration,
  type DecorationSet,
  WidgetType,
  type ViewUpdate
} from '@codemirror/view'
import { type Extension, RangeSetBuilder, StateEffect, type Text } from '@codemirror/state'
import { placementLabel, type ImagePlacement, type PlacementKind } from '../../../shared/image-placement.ts'
import { openFullScreenPreview } from './imageFullScreenPreview.ts'

/** Dispatch when the compiled slides change so the placement labels redraw. */
export const imagePlacementsChanged = StateEffect.define<null>()

const CHIP_ICONS: Record<PlacementKind, string> = {
  full: '<path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"/>',
  beside: '<rect x="1.5" y="3" width="13" height="10" rx="1"/><path d="M9 3v10"/>',
  thumbnail: '<rect x="1.5" y="3" width="13" height="10" rx="1"/><rect x="3.5" y="5" width="4" height="3" rx=".5"/>',
  row: '<rect x="1.5" y="4" width="5.5" height="8" rx="1"/><rect x="9" y="4" width="5.5" height="8" rx="1"/>',
  gallery: '<rect x="1.5" y="2.5" width="5.5" height="5" rx="1"/><rect x="9" y="2.5" width="5.5" height="5" rx="1"/><rect x="1.5" y="9" width="5.5" height="5" rx="1"/><rect x="9" y="9" width="5.5" height="5" rx="1"/>',
  'image-quote': '<rect x="1.5" y="3" width="13" height="10" rx="1"/><path d="M9 6h3M9 8.5h3M9 11h2"/>',
  statement: '<rect x="1.5" y="3" width="13" height="10" rx="1"/><path d="M9 6h3M9 8.5h3M9 11h2"/>',
  carousel: '<rect x="4" y="3.5" width="8" height="9" rx="1"/><path d="M2 6v4M14 6v4"/>'
}

function makePlacementChip(label: { kind: PlacementKind; name: string }): HTMLElement {
  const chip = document.createElement('span')
  chip.className = 'cm-image-placement-chip'
  chip.dataset.placement = label.kind
  chip.style.cssText = [
    'position: absolute', 'left: 6px', 'top: 6px', 'display: inline-flex', 'align-items: center', 'gap: 5px',
    'background: rgba(23, 32, 42, 0.86)', 'color: #fff', 'font: 600 11px var(--font-ui, system-ui, sans-serif)',
    'padding: 3px 8px 3px 6px', 'border-radius: 999px', 'line-height: 1.3', 'white-space: nowrap', 'pointer-events: none'
  ].join('; ')
  chip.innerHTML = `<svg viewBox="0 0 16 16" width="13" height="13" style="stroke:#fff;fill:none;stroke-width:1.6">${CHIP_ICONS[label.kind]}</svg>`
  chip.appendChild(document.createTextNode(label.name))
  return chip
}

// Any markdown image at the start of a line: ![alt](src) (optional "title" ignored).
// src may be a vault asset id (img-XXXXXXX), a legacy double-prefixed id (img-img-XXXXXXX),
// an absolute path, a relative path (resolved against the Talk dir), or an http(s)/data URL.
const IMAGE_LINE_RE = /^!\[([^\]]*)\]\(([^)]+)\)/

type ImageWidgetClick = (id: string) => void

// base64url of a UTF-8 string, matching the main process's fromBase64Url (twfile:// payload).
function b64url(s: string): string {
  const b64 = btoa(unescape(encodeURIComponent(s)))
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

interface Resolved {
  url: string | null
  vaultId: string | null // set only for img-XXXXXXX vault assets (clickable → metadata panel)
  isVideo: boolean // a vid-XXXXXXX clip: the url serves its POSTER, shown with a ▶ badge (ADR-0028)
}

// Turn a markdown image src into a URL the renderer can load.
function resolveSrc(
  rawSrc: string,
  vaultRoot: string | null | undefined,
  talkDir: string | null | undefined
): Resolved {
  let src = rawSrc.trim().replace(/\s+"[^"]*"$/, '') // drop optional title
  // Legacy: archive imports once produced ![](img-img-XXXXXXX); normalise to the real id.
  src = src.replace(/^img-img-([0-9a-f]{7})$/, 'img-$1')

  if (/^img-[0-9a-f]{7}$/.test(src)) {
    return { url: vaultRoot ? `twasset://${src}` : null, vaultId: src, isVideo: false }
  }
  // A clip: authoring shows the POSTER only (ADR-0028). twasset://vid-<id> serves vid-<id>.jpg.
  if (/^vid-[0-9a-f]{7}$/.test(src)) {
    return { url: vaultRoot ? `twasset://${src}` : null, vaultId: null, isVideo: true }
  }
  if (/^(https?:|data:)/.test(src)) {
    return { url: src, vaultId: null, isVideo: false }
  }
  // Local file path: absolute as-is, relative resolved against the Talk dir. Served via the
  // guarded twfile:// scheme (works from both the dev http origin and the prod file:// page,
  // unlike a bare file:// URL which webSecurity blocks from http).
  // URL-DECODE first: imported outlines (Obsidian etc.) write `assets/Pasted%20image.png` for a
  // file whose real name has spaces — the on-disk file is `Pasted image.png`, so a literal `%20`
  // path doesn't exist and the preview went grey. The compiler already decodes (Present worked);
  // this brings the editor preview in line. Malformed `%` sequences fall back to the raw string.
  let decoded = src
  try { decoded = decodeURIComponent(src) } catch { decoded = src }
  let abs = decoded
  if (!decoded.startsWith('/')) {
    if (!talkDir) return { url: null, vaultId: null, isVideo: false }
    abs = talkDir.replace(/\/+$/, '') + '/' + decoded
  }
  return { url: `twfile://f/${b64url(abs)}`, vaultId: null, isVideo: false }
}

export class ImageWidget extends WidgetType {
  private readonly url: string | null
  private readonly caption: string
  private readonly vaultId: string | null
  private readonly onClick: ImageWidgetClick | null | undefined
  private readonly isVideo: boolean
  private readonly placement: ImagePlacement | null

  // Explicit fields, not parameter properties: the unit tier loads this file with Node's
  // type-stripping, which does not support them.
  constructor(
    url: string | null,
    caption: string,
    vaultId: string | null,
    onClick: ImageWidgetClick | null | undefined,
    isVideo: boolean = false,
    placement: ImagePlacement | null = null
  ) {
    super()
    this.url = url
    this.caption = caption
    this.vaultId = vaultId
    this.onClick = onClick
    this.isVideo = isVideo
    this.placement = placement
  }

  eq(other: ImageWidget): boolean {
    return (
      other.url === this.url &&
      other.caption === this.caption &&
      other.vaultId === this.vaultId &&
      other.onClick === this.onClick &&
      other.isVideo === this.isVideo &&
      other.placement?.kind === this.placement?.kind &&
      other.placement?.index === this.placement?.index &&
      other.placement?.count === this.placement?.count
    )
  }

  toDOM(): HTMLElement {
    const clickable = !!this.url && !this.isVideo
    const wrap = document.createElement('span')
    wrap.className = 'cm-image-widget'
    if (this.vaultId) wrap.dataset.imgId = this.vaultId
    wrap.style.cssText = [
      'display: inline-flex',
      'flex-direction: column',
      'align-items: flex-start',
      'gap: 4px',
      'padding: 4px',
      'border: 1px solid var(--line-color, #d9d0c1)',
      'border-radius: 4px',
      'background: transparent',
      'vertical-align: middle',
      clickable ? 'cursor: pointer' : 'pointer-events: none'
    ].join('; ')

    if (clickable) {
      // Click opens the full-screen (Z) view; the arrow keys still reach the image line as text.
      const url = this.url as string
      const details = this.onClick && this.vaultId ? () => (this.onClick as ImageWidgetClick)(this.vaultId as string) : null
      wrap.addEventListener('mousedown', (event) => {
        event.preventDefault()
        event.stopPropagation()
      })
      wrap.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        openFullScreenPreview({ url, caption: this.caption, onDetails: details })
      })
    }

    if (this.url) {
      // A clip's poster sits under a ▶ badge so it reads as motion, not a still (ADR-0028:
      // authoring previews never play — playback is present-mode only).
      const frame = document.createElement('span')
      frame.style.cssText = ['position: relative', 'display: inline-block', 'line-height: 0'].join('; ')
      const img = document.createElement('img')
      img.src = this.url
      img.alt = this.caption
      img.style.cssText = [
        'max-width: 220px',
        'max-height: 130px',
        'object-fit: contain',
        'display: block',
        'border-radius: 2px'
      ].join('; ')
      const placeholder = makePlaceholder()
      placeholder.style.display = 'none'
      img.addEventListener('error', () => {
        img.style.display = 'none'
        placeholder.style.display = 'block'
      })
      frame.appendChild(img)
      frame.appendChild(placeholder)
      if (this.isVideo) frame.appendChild(makePlayBadge())
      const label = placementLabel(this.placement)
      if (label) frame.appendChild(makePlacementChip(label))
      wrap.appendChild(frame)
    } else if (this.isVideo) {
      const frame = document.createElement('span')
      frame.style.cssText = ['position: relative', 'display: inline-block', 'line-height: 0'].join('; ')
      frame.appendChild(makePlaceholder())
      frame.appendChild(makePlayBadge())
      wrap.appendChild(frame)
    } else {
      wrap.appendChild(makePlaceholder())
    }

    if (this.caption) {
      const cap = document.createElement('span')
      cap.textContent = this.caption
      cap.style.cssText = [
        'font-size: 11px',
        'color: var(--caption-color, #8a9099)',
        'max-width: 220px',
        'overflow: hidden',
        'text-overflow: ellipsis',
        'white-space: nowrap'
      ].join('; ')
      wrap.appendChild(cap)
    }

    return wrap
  }

  ignoreEvent(): boolean {
    return false
  }
}

function makePlaceholder(): HTMLElement {
  const box = document.createElement('span')
  box.style.cssText = [
    'display: block',
    'width: 160px',
    'height: 90px',
    'background: #c8c8c8',
    'border-radius: 2px'
  ].join('; ')
  return box
}

// A centred ▶ badge overlaid on a clip's poster so a video reads as motion in the editor.
function makePlayBadge(): HTMLElement {
  const badge = document.createElement('span')
  badge.textContent = '▶'
  badge.style.cssText = [
    'position: absolute',
    'top: 50%',
    'left: 50%',
    'transform: translate(-50%, -50%)',
    'width: 34px',
    'height: 34px',
    'display: flex',
    'align-items: center',
    'justify-content: center',
    'padding-left: 3px', // optically centre the triangle
    'box-sizing: border-box',
    'border-radius: 50%',
    'background: rgba(0, 0, 0, 0.55)',
    'color: #fff',
    'font-size: 14px',
    'line-height: 1',
    'pointer-events: none'
  ].join('; ')
  return badge
}

interface WidgetOpts {
  vaultRoot?: string | null
  // A getter (not a static value) because the editor is reused across talks — the Talk dir
  // changes when the user switches talks, and relative image paths resolve against it.
  talkDir?: string | null | (() => string | null | undefined)
  onClick?: ImageWidgetClick | null
  // The compiler's placement for the image on this 1-based line (null when unknown).
  placementForLine?: ((line: number, doc: Text) => ImagePlacement | null) | null
}

function buildDecorations(view: EditorView, opts: WidgetOpts): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const talkDir = typeof opts.talkDir === 'function' ? opts.talkDir() : opts.talkDir
  for (const { from, to } of view.visibleRanges) {
    let pos = from
    while (pos <= to) {
      const line = view.state.doc.lineAt(pos)
      const match = IMAGE_LINE_RE.exec(line.text)
      if (match) {
        const caption = match[1]
        const { url, vaultId, isVideo } = resolveSrc(match[2], opts.vaultRoot, talkDir)
        const widget = new ImageWidget(url, caption, vaultId, opts.onClick, isVideo, opts.placementForLine?.(line.number, view.state.doc) ?? null)
        builder.add(line.from, line.to, Decoration.replace({ widget, inclusive: false, block: false }))
      }
      pos = line.to + 1
    }
  }
  return builder.finish()
}

/**
 * CodeMirror 6 extension that renders an inline preview for EVERY markdown image line —
 * vault assets (img-XXXXXXX via twasset://), local file paths (absolute or relative-to-Talk
 * via twfile://), and remote/data URLs — so pasted, imported, and path images all preview
 * the same way. Vault-asset widgets are clickable (onClick → metadata panel).
 */
export function imageWidgetExtension(opts: WidgetOpts): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, opts)
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.transactions.some((t) => t.effects.some((e) => e.is(imagePlacementsChanged)))) {
          this.decorations = buildDecorations(update.view, opts)
        }
      }
    },
    { decorations: (v) => v.decorations }
  )
}

export default imageWidgetExtension

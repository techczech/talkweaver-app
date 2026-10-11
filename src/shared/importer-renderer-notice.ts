// What the Importer says about the tools that draw pictures of the original slides (LibreOffice and
// Poppler's pdftoppm). Pure, no imports. Decision D17 (docs/plans/cloudflare-setup-in-app): when a
// tool is missing the Importer does not report a missing tool; it says the pictures come from the
// separate TalkWeaver PPT Extractor app and still imports text, notes and media.

/**
 * Download page of the separate TalkWeaver PPT Extractor app. A fixed address, never built from
 * input. The product page `https://talkweaver.app/tools/ppt-extractor` is the address the extractor's
 * own package.json (`homepage`) and README name; the ticket wrote it with `.html`, which no file on
 * this machine confirms.
 */
export const PPT_EXTRACTOR_URL = 'https://talkweaver.app/tools/ppt-extractor'

export const PPT_EXTRACTOR_POINTER =
  'Pictures of the original slides come from the separate TalkWeaver PPT Extractor app. Text, notes and media import without it.'
export const SLIDE_PICTURES_LABEL = 'Slide pictures'
export const PPT_EXTRACTOR_BUTTON = 'Get the PPT Extractor'

export interface RendererNoticeInput {
  status: 'ready' | 'blocked' | 'failed'
  officePath: string | null
  rasterPath: string | null
}

export interface RendererNotice {
  /** The word shown beside "Slide pictures": the status, "Not available" when a tool is missing, or "checking" before capabilities arrive. */
  statusLabel: string
  ready: boolean
  /** Lines under the status: the two tool paths when present, nothing about a missing tool. */
  paths: string[]
  /** True when the pointer to the PPT Extractor and its button are shown. */
  showPointer: boolean
}

export function rendererNotice(renderer: RendererNoticeInput | null | undefined): RendererNotice {
  if (!renderer) return { statusLabel: 'checking', ready: false, paths: [], showPointer: false }
  const paths = [renderer.officePath, renderer.rasterPath].filter((p): p is string => !!p)
  const missing = !renderer.officePath || !renderer.rasterPath
  return { statusLabel: missing ? 'Not available' : renderer.status, ready: renderer.status === 'ready', paths, showPointer: missing }
}

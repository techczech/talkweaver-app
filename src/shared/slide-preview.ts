const PREVIEW_STYLE = `<style data-tw-preview-style>
body[data-tw-preview] .share-footer,
body[data-tw-preview] footer.footer,
body[data-tw-preview] .progress,
body[data-tw-preview] .drawer,
body[data-tw-preview] .notes-drawer,
body[data-tw-preview] .nav-panel,
body[data-tw-preview] .notes-panel,
body[data-tw-preview] .mynotes-panel,
body[data-tw-preview] .help-fab,
body[data-tw-preview] .help-overlay,
body[data-tw-preview] .note-pop,
body[data-tw-preview] .focus-banner,
body[data-tw-preview] .license-modal,
body[data-tw-preview] .lightbox,
body[data-tw-preview] .embed-return-btn,
body[data-tw-preview] .presenter-reminder,
body[data-tw-preview] .section-timer-float,
body[data-tw-preview] .presenter-root,
body[data-tw-preview] #presenterBtn { display: none !important; }
body[data-tw-preview] .share-shell { min-height: 100vh; grid-template-rows: 1fr; }
</style>`

// The scheme-hosted preview has its own origin, so the parent cannot synthesise arrow keys
// inside it. postMessage crosses that boundary and this bridge replays the deck step locally.
const STEP_BRIDGE = `<script data-tw-step-bridge>window.addEventListener('message',function(e){var d=e&&e.data;if(d&&d.type==='tw-step'&&(d.key==='ArrowRight'||d.key==='ArrowLeft')){window.dispatchEvent(new KeyboardEvent('keydown',{key:d.key,code:d.key,bubbles:true}))}})</script>`

export type SlidePreviewStore = {
  get: (id: string) => string | undefined
  set: (id: string, html: string) => void
}

/** Create the small FIFO store used by the main process for scheme-hosted preview documents. */
export function createSlidePreviewStore(maxEntries = 8): SlidePreviewStore {
  const previews = new Map<string, string>()
  return {
    get: (id) => previews.get(id),
    set: (id, html) => {
      previews.delete(id)
      previews.set(id, html)
      while (previews.size > maxEntries) {
        const oldest = previews.keys().next().value
        if (oldest === undefined) break
        previews.delete(oldest)
      }
    }
  }
}

export function slidePreviewUrl(id: string, slideId = ''): string {
  const base = `twpresent://preview/${encodeURIComponent(id)}.html`
  return slideId ? `${base}#${encodeURIComponent(slideId)}` : base
}

export function slidePreviewIdFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== 'twpresent:' || url.hostname !== 'preview') return null
    const match = url.pathname.match(/^\/([^/]+)\.html$/)
    return match ? decodeURIComponent(match[1]) : null
  } catch {
    return null
  }
}

/** Keep a logical slide key while invalidating its PNG whenever the full deck document changes. */
export function thumbnailDocumentCacheKey(documentId: string, slideKey: string): string {
  return `${documentId}-${slideKey}`
}

/** Mark shared preview HTML so Slide Focus and Inspector use the same chrome-free stage. */
export function markSlidePreviewHtml(html: string): string {
  const withHook = /<body\b[^>]*data-tw-preview/i.test(html)
    ? html
    : /<body\b[^>]*>/i.test(html)
    ? html.replace(/<body\b([^>]*)>/i, '<body$1 data-tw-preview>')
    : html
  const withStyle = withHook.includes('data-tw-preview-style')
    ? withHook
    : withHook.includes('</head>')
    ? withHook.replace('</head>', `${PREVIEW_STYLE}\n</head>`)
    : PREVIEW_STYLE + withHook
  // The compiled deck EMBEDS the presenter template as a string, so '</body>' occurs inside
  // script literals long before the document's real closing tag. A first-occurrence replace
  // split a script mid-string ("Unexpected end of input", dead runtime, blank stage) — anchor
  // the bridge at the LAST '</body>', which is the document's own.
  if (withStyle.includes('data-tw-step-bridge')) return withStyle
  const at = withStyle.lastIndexOf('</body>')
  return at < 0
    ? withStyle + STEP_BRIDGE
    : withStyle.slice(0, at) + STEP_BRIDGE + withStyle.slice(at)
}

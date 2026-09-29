import { buildShareHtml } from './09-output-builders.mjs'

/** The venue and audience use the same slide markup, layout, live client and poll renderer. */
export function buildVenuePageHtml({ title, slides, styles, slug, license, workerBaseUrl, liveTalkSlug = slug, qr, handoutUrl }) {
  return buildShareHtml({
    title, slides, styles, slug, license, workerBaseUrl, liveTalkSlug,
    includeNotes: false, venue: true, venueQr: qr, venueUrl: handoutUrl,
  })
}

/** Cloudflare Pages serves this for unknown and unpublished venue URLs. */
export function buildUnavailableVenuePageHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>This talk isn’t available</title><style>
    html,body{margin:0;min-height:100%;background:#fdfdfb;color:#17202a;font-family:system-ui,-apple-system,sans-serif}
    main{min-height:100vh;display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:clamp(24px,8vw,100px)}
    .block{display:flex;align-items:flex-start;gap:36px;max-width:850px}svg{flex:none;width:80px;height:80px;color:#84919b}
    h1{font-size:clamp(28px,4vw,50px);line-height:1.1;margin:0 0 18px}p{font-size:clamp(16px,2vw,23px);line-height:1.5;margin:0 0 15px}.soft{color:#65717b}
    code{font-family:ui-monospace,monospace;font-size:.85em;overflow-wrap:anywhere}@media(max-width:650px){.block{display:block}svg{margin-bottom:28px}}
  </style></head><body><main><div class="block"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M12 17h.01"/><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M9.1 9a3 3 0 0 1 5.82 1c0 2-3 3-3 3"/></svg><div><h1>This talk isn’t available</h1><p><code id="venueAddress"></code> doesn’t match a published talk. It may have been unpublished, or the address may have a typo.</p><p class="soft">Check the link with the speaker.</p></div></div></main><script>document.getElementById('venueAddress').textContent = location.host + location.pathname.replace(/\\/$/, '')</script></body></html>`
}

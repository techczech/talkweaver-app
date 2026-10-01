import { join } from 'path'
import { pathToFileURL } from 'url'

// The handout's landing/viewer page (Open + Download + QR + short link). The Open/Download buttons point
// at the sibling handout file. The heading shows the title's inline formatting (**bold**, *italic*,
// `code`) as HTML through the compiler's own inline renderer, which escapes everything else first; the
// <title> element takes the same title as plain text. The two helpers come from the compiler
// (compiler/scripts/lib/00-inline-render.mjs), which main loads at run time, so they are passed in.
export interface InlineTitleHelpers {
  renderInline(text: string): string
  plainInlineText(text: string): string
}

/** The compiler's inline-title helpers, loaded the way main loads every compiler module. */
async function inlineTitleHelpers(compilerDir: string): Promise<InlineTitleHelpers> {
  const { renderInline, plainInlineText } = await import(pathToFileURL(join(compilerDir, 'lib/00-inline-render.mjs')).href)
  return { renderInline, plainInlineText }
}

export function escapeHtmlAttr(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export async function viewerPageHtml(opts: { title: string; handoutFile: string; url: string; qr: string }, compilerDir: string | InlineTitleHelpers): Promise<string> {
  const inline = typeof compilerDir === 'string' ? await inlineTitleHelpers(compilerDir) : compilerDir
  const display = opts.url.replace(/^https?:\/\//, '')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtmlAttr(inline.plainInlineText(opts.title))} — handout</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, system-ui, sans-serif; background: #f7f3ea; color: #17202a; margin: 0; display: grid; place-items: center; min-height: 96vh; }
  main { text-align: center; padding: 28px; max-width: 640px; }
  h1 { font-family: Georgia, serif; font-weight: 500; font-size: clamp(26px, 5vw, 40px); margin: 0 0 6px; }
  p.sub { color: #5b6470; margin: 0 0 26px; }
  .actions { display: flex; gap: 14px; justify-content: center; flex-wrap: wrap; margin-bottom: 30px; }
  a.btn { display: inline-block; padding: 13px 26px; border-radius: 10px; text-decoration: none; font-weight: 600; font-size: 17px; }
  a.open { background: #0b3a6b; color: #fff; }
  a.dl { border: 2px solid #0b3a6b; color: #0b3a6b; }
  .qr { width: 150px; margin: 0 auto; opacity: 0.9; }
  .qr svg { width: 100%; height: auto; }
  p.tiny { color: #8a93a0; font-size: 13px; }
</style></head>
<body><main>
  <h1>${inline.renderInline(opts.title)}</h1>
  <p class="sub">Slides handout — browse online or keep a copy. It is one self-contained file; everything works offline.</p>
  <div class="actions">
    <a class="btn open" href="${opts.handoutFile}">Open the slides</a>
    <a class="btn dl" href="${opts.handoutFile}" download="${opts.handoutFile}">Download</a>
  </div>
  <div class="qr">${opts.qr}</div>
  <p class="tiny">${escapeHtmlAttr(display)}</p>
</main></body></html>
`
}

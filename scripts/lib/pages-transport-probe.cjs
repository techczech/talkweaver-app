// TESTS ONLY (loaded with the launcher's trace argument, which the main process never passes): what the
// bundled wrangler's own HTTP client really carries on each request as it goes out. One JSON line per
// request, to the trace file. Paths and timeouts only: no header, body or token is read.
const { subscribe } = require('node:diagnostics_channel')
const { appendFileSync } = require('node:fs')

const file = process.env.TALKWEAVER_WRANGLER_TRACE_FILE
subscribe('undici:client:sendHeaders', ({ request }) => {
  appendFileSync(file, `${JSON.stringify({
    method: request.method, path: String(request.path).split('?')[0], headersTimeout: request.headersTimeout ?? null, bodyTimeout: request.bodyTimeout ?? null,
  })}\n`)
})

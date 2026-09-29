// The colleague's page: the handout HTML the owner pushed, with the comments-runtime slot
// injected. The slot is a JSON config block the runtime reads and an empty script element the
// runtime build fills; the Worker never rewrites the handout otherwise.

export interface SharedTalkPageConfig {
  shareId: string
  revision: number
  /** Share-wide event sequence when the page was served: the runtime's first `?since=`. */
  seq: number
  /** Base path of this share's HTTP routes (talk.json, items). */
  api: string
  /** Path of the audience socket; the runtime appends `?since=<seq>` on reconnect. */
  audienceSocket: string
}

export const SHARED_TALK_CONFIG_ELEMENT_ID = 'tw-shared-talk-config'
export const SHARED_TALK_RUNTIME_ELEMENT_ID = 'tw-shared-talk-runtime'

export function sharedTalkPageConfig(shareId: string, revision: number, seq: number): SharedTalkPageConfig {
  const api = `/shares/${shareId}`
  return { shareId, revision, seq, api, audienceSocket: `${api}/audience` }
}

/**
 * Split HTML into chunks of at most `size` UTF-16 units without separating a surrogate pair,
 * so joining the stored chunks gives back the exact string.
 */
export function splitOnCodePoints(html: string, size: number): string[] {
  if (size < 2) throw new Error('Chunk size must be at least 2.')
  const chunks: string[] = []
  let start = 0
  while (start < html.length) {
    let end = Math.min(start + size, html.length)
    const last = html.charCodeAt(end - 1)
    if (end < html.length && last >= 0xd800 && last <= 0xdbff) end -= 1
    chunks.push(html.slice(start, end))
    start = end
  }
  return chunks
}

export function sharedTalkRuntimeSlot(config: SharedTalkPageConfig): string {
  // `<` is escaped so no value can close the script element early.
  const json = JSON.stringify(config).replace(/</g, '\\u003c')
  return `<script type="application/json" id="${SHARED_TALK_CONFIG_ELEMENT_ID}">${json}</script>`
    + `<script id="${SHARED_TALK_RUNTIME_ELEMENT_ID}" data-slot="shared-talk-runtime"></script>`
}

/** Insert the slot before `</head>`, else after `<body…>`, else at the start. */
export function injectSharedTalkRuntime(html: string, config: SharedTalkPageConfig): string {
  const slot = sharedTalkRuntimeSlot(config)
  const headClose = html.search(/<\/head\s*>/i)
  if (headClose >= 0) return html.slice(0, headClose) + slot + html.slice(headClose)
  const bodyOpen = html.match(/<body\b[^>]*>/i)
  if (bodyOpen?.index !== undefined) {
    const at = bodyOpen.index + bodyOpen[0].length
    return html.slice(0, at) + slot + html.slice(at)
  }
  return slot + html
}

export function sharedTalkUnavailablePage(reason: 'not_pushed' | 'closed'): string {
  const message = reason === 'closed'
    ? 'Sharing has stopped for this talk.'
    : 'This talk has not been shared yet. Try again in a moment.'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shared talk</title></head>`
    + `<body style="font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 32rem; padding: 0 1rem; color: #222;"><p>${message}</p></body></html>`
}

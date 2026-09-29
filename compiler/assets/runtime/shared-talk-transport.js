// Shared talk, ticket 04: the colleague page's real transport — fetch and WebSocket against the
// worker that served the page, on the relative paths in its #tw-shared-talk-config block. The
// tests replace it with a fake at createSharedTalkClient's `transport` seam. Injected into the
// handout by toString() with the rest of the runtime (shared-talk-page.js sharedTalkRuntimeSource).

/** fetch + WebSocket against the worker that served the page (relative paths from the config). */
export function sharedTalkBrowserTransport(win, config) {
  const api = config.api
  async function read(response) {
    let json = null
    try { json = await response.json() } catch {}
    return json
  }
  return {
    async postItem(body) {
      const response = await win.fetch(api + '/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: response.status, json: await read(response), retryAfter: response.headers.get('retry-after') }
    },
    async fetchTalk() {
      const response = await win.fetch(api + '/talk.json', { cache: 'no-store' })
      if (!response.ok) throw new Error('talk.json ' + response.status)
      return response.json()
    },
    async fetchPage() {
      const response = await win.fetch(api, { cache: 'no-store' })
      if (!response.ok) throw new Error('page ' + response.status)
      return response.text()
    },
    openSocket(since, handlers) {
      const url = new URL(config.audienceSocket, win.location.href)
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
      url.search = ''
      url.searchParams.set('since', String(since))
      let socket
      try { socket = new win.WebSocket(url.toString()) } catch {
        win.setTimeout(() => handlers.onClose(), 0)
        return { close() {} }
      }
      socket.onopen = () => handlers.onOpen()
      socket.onmessage = (event) => handlers.onMessage(String(event.data))
      socket.onclose = () => handlers.onClose()
      socket.onerror = () => {}
      return { close() { try { socket.close() } catch {} } }
    },
  }
}

// Test-only, loaded into the Electron main process with `-r` before any app code runs (e2e/diagnose-core-journey.mjs).
// The app records the live service at a made-up workers.dev address (the fake Cloudflare API "deployed" it) and
// refuses to use or publish an address on this computer. This points that one made-up host at the live Worker
// under local `wrangler dev`, for the app's own requests, and nothing else:
//   TW_SHIM_HOST   the made-up host; TW_SHIM_BASE  the local Worker's origin; TW_SHIM_ADMIN  its admin secret.
// Admin requests (everything but an owner's own /prework/<id>/… calls) carry the local Worker's admin secret
// in place of this computer's key, and the Worker's answer to "whose key is this" (GET /computers) names the
// computer whose key the app sent (the app put it on the fake Cloudflare Worker as ADMIN_SECRET_<id>; the
// shim reads that off the secrets request). With the variables unset it does nothing.
'use strict'
const host = process.env.TW_SHIM_HOST
const base = process.env.TW_SHIM_BASE
const admin = process.env.TW_SHIM_ADMIN
if (host && base && admin && typeof globalThis.fetch === 'function') {
  const real = globalThis.fetch.bind(globalThis)
  const prefix = 'ADMIN_SECRET_'
  const held = new Map() // key value → computer id
  globalThis.__liveShim = []
  const note = (line) => { globalThis.__liveShim.push(line); if (globalThis.__liveShim.length > 200) globalThis.__liveShim.shift() }
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.host !== host) {
      if (url.pathname.endsWith('/secrets-bulk') && typeof init?.body === 'string') {
        try {
          for (const [name, entry] of Object.entries(JSON.parse(init.body).secrets ?? {})) {
            if (name.startsWith(prefix) && entry && typeof entry.text === 'string') held.set(entry.text, name.slice(prefix.length))
          }
        } catch { /* not a secrets request we can read */ }
      }
      return real(input, init)
    }
    const request = typeof input === 'object' && input !== null && 'headers' in input ? input : null
    const headers = new Headers(init?.headers ?? request?.headers)
    const computerId = held.get((headers.get('authorization') ?? '').replace(/^Bearer /, ''))
    if (!/^\/prework\/[^/]+\//.test(url.pathname) && headers.has('authorization')) headers.set('authorization', `Bearer ${admin}`)
    const method = init?.method ?? request?.method ?? 'GET'
    note(`${method} ${url.pathname}`)
    const carry = request ? { method: request.method, body: request.body, duplex: 'half' } : {}
    const response = await real(`${base}${url.pathname}${url.search}`, { ...carry, ...init, headers }).catch((error) => {
      note(`FAILED ${url.pathname}: ${error?.cause?.code ?? error?.message}`)
      throw error
    })
    if (computerId && url.pathname === '/computers' && method === 'GET' && response.status === 200) {
      const body = await response.json()
      return new Response(JSON.stringify({ ...body, self: computerId }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return response
  }
}

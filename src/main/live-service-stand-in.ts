// Tests only. An app that is not packaged and started as a test harness (TW_E2E=1) on a profile the
// harness made for this run (test-network-guard.ts, the one rule for every test-only network override;
// index.ts reads the address only through it) and given http://127.0.0.1:<port> in
// TW_E2E_LIVE_SERVICE_URL sends what it would send to a live service at a workers.dev address to that
// address instead, naming the address it meant in `x-tw-e2e-live-host`. Since several Macs (ticket 02)
// the set-up asks the live service itself whether it accepts this computer's key; without this an
// end-to-end test of the set-up would reach the real workers.dev. Everything else goes as it was.
// A packaged build, or any other address (`localhost`, no port, a path), never takes this path:
// the same strictness as the Cloudflare API override (loopbackApiBase).
import { loopbackOrigin } from './test-network-guard.ts'

export const LIVE_STAND_IN_HOST_HEADER = 'x-tw-e2e-live-host'

/** The stand-in's origin when all conditions hold, else null. */
export function liveServiceStandIn(context: { packaged: boolean; e2e: boolean; override: unknown }): string | null {
  if (context.packaged || !context.e2e) return null
  return loopbackOrigin(context.override)
}

/** `realFetch`, except that a request to `https://<anything>.workers.dev/…` goes to `standIn` with the same path. */
export function fetchWithLiveStandIn(standIn: string, realFetch: typeof fetch): typeof fetch {
  return (input, init) => {
    const text = typeof input === 'string' ? input : input instanceof URL ? input.href : null
    if (text === null) return realFetch(input, init)
    let url: URL
    try { url = new URL(text) } catch { return realFetch(input, init) }
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.workers.dev')) return realFetch(input, init)
    const headers = new Headers(init?.headers)
    headers.set(LIVE_STAND_IN_HOST_HEADER, url.host)
    return realFetch(`${standIn}${url.pathname}${url.search}`, { ...init, headers })
  }
}

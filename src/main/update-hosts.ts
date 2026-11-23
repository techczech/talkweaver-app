// Updating in place (ADR-0044 §7): where electron-updater's own session may go. The feed (talkweaver.app) is read
// on a separate session (update-notices.ts) and is not affected. The update file is a GitHub release asset:
// github.com/techczech/talkweaver-app/releases/download/… (the feed validation allows nothing else), which GitHub
// answers with a redirect to release-assets.githubusercontent.com (objects.githubusercontent.com on older assets).
// Every request of the updater's session, each redirect hop included (Chromium asks webRequest again for each),
// must be HTTPS to one of these hosts; anything else is cancelled. The local-address filter still runs after it.
// Squirrel.Mac's fetch of the verified file from electron-updater's 127.0.0.1 address is made by macOS, not by
// this session, and is not affected.
import { localAddressRequestListener, FILTERED_URL_PATTERNS } from './local-address-filter.ts'

export const UPDATE_DOWNLOAD_HOSTS: readonly string[] = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']

/** Whether the updater's session may request this address: HTTPS, default port, no user name, an allowed host. */
export function updateDownloadAllowed(url: unknown): boolean {
  let u: URL
  try { u = new URL(String(url)) } catch { return false }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return false
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  return UPDATE_DOWNLOAD_HOSTS.includes(host)
}

type Details = { url: string } & Record<string, unknown>
type Callback = (response: { cancel?: boolean }) => void
type Listener = (details: any, callback: Callback) => void

/** The updater session's onBeforeRequest: the host allowlist first, then the given listener (the local-address filter). */
export function updaterRequestListener(inner: Listener, log: (message: string) => void): Listener {
  return (details: Details, callback: Callback) => {
    if (!updateDownloadAllowed(details?.url)) {
      let target = 'an unreadable address'
      try { const u = new URL(String(details.url)); target = `${u.protocol}//${u.host}` } catch { /* keep */ }
      log(`refused a request to ${target}: updates download only from GitHub`)
      callback({ cancel: true })
      return
    }
    inner(details, callback)
  }
}

type FilterSession = {
  webRequest: { onBeforeRequest(filter: { urls: string[] }, listener: Listener): void }
  resolveHost(host: string): Promise<{ endpoints: Array<{ address: string }> }>
}

/**
 * Install once on electron-updater's session (Electron keeps one onBeforeRequest listener per session, so this one
 * listener does both jobs). Web requests (http, https, ws, wss) are the only ones that reach the network.
 */
export function installUpdaterRequestFilter(session: FilterSession, log: (message: string) => void): void {
  const resolveHost = async (host: string): Promise<readonly string[]> => (await session.resolveHost(host)).endpoints.map((e) => e.address)
  const local = localAddressRequestListener({ resolveHost, log })
  session.webRequest.onBeforeRequest({ urls: [...FILTERED_URL_PATTERNS] }, updaterRequestListener(local, log))
}

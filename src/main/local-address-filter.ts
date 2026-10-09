// A page embedded in a slide does not reach this Mac's own services or the local network
// (embed-sandbox design 3.1). The embed sandbox and the inlined page's policy both allow `http:`, so
// an embedded page (a local page, a remote site, a video player, and anything they frame) could
// otherwise fetch `http://127.0.0.1:<port>/`, a router or a printer and, with CORS, read the answer.
//
// The rule, applied in main to every web request (http, https, ws, wss) of the default session:
// only a window's own page may reach a local address. Every other requester is refused there.
//
//   Who is asking (`requesterOf`), from the request's frame, and what is caught for each:
//     - 'main-frame': the window's own page (the frame has no parent). NEVER refused: the app's
//       pages, the dev server, the live-session worker on 127.0.0.1, a picture the talk names,
//       DevTools. Not caught, by design: anything a page that shares the deck's origin adds to the
//       deck's own document (until the embed sandbox, an embedded page can do that);
//     - 'embed-frame-itself': a frame directly inside the main frame loading its OWN document
//       (`resourceType` subFrame). Main cannot tell these apart, and all of them are this requester:
//       the deck setting the frame's address for an `[Embed: …]` line, the embedded page sending its
//       own frame somewhere, a form in it submitting (GET or POST), a server redirect of the frame's
//       document, and a frame that an embedded page sharing the deck's origin adds to the deck's
//       document. REFUSED at a local address (OUTLINE_NAMED_LOCAL_EMBED is 'refuse'), so a slide
//       cannot show a page served from this Mac: the cost the design accepts;
//     - 'inside-embed': everything else in a subframe — a subresource, fetch, WebSocket or
//       dedicated-worker request of any frame, the document of any frame nested deeper, and a
//       request whose frame has gone. REFUSED at a local address;
//     - 'app': no frame and no window — main's own requests through the session, and the fetches of
//       a shared worker or service worker (a remote site with its own origin can start one).
//       REFUSED at a local address unless main registered that host as its own (`appLocalHosts`:
//       the dev server in development). Main makes no other request to a local address through the
//       session: its calls to the live-session worker use Node's fetch, which does not pass here.
//
//   What is local (`classifyHost`): the unspecified address, loopback, RFC 1918 private ranges,
//   link-local, carrier-grade NAT, unique-local and site-local IPv6, multicast and broadcast, an
//   IPv6 address that carries one of those IPv4 addresses (mapped, compatible, NAT64, 6to4), the
//   names `localhost`, `*.localhost` and `*.local`, and any other name that resolves to one of them.
//   The host is read the way Chromium reads it (the URL parser turns `2130706433`, `0x7f.1` and
//   `0177.0.0.1` into 127.0.0.1 and lower-cases names) and anything unreadable counts as local.
//
// Redirects: Chromium asks again for each hop of a redirect, with the same frame and resource type.
// A public address that redirects to a local one is refused at the hop that is local, for a fetch
// and for a frame's own document alike.
//
// NOT closed here (stated in the design and in ADR-0036):
//   - a name whose address changes between this lookup and Chromium's connection (DNS rebinding);
//   - WebRTC, WebTransport, and preconnect / DNS prefetch, which do not pass through webRequest;
//   - a picture or media address the talk itself names loads from the deck's main frame (ticket 12).
//     In the editor's slide preview and Studio's replay the deck is itself a frame, so the same
//     picture at a private address is refused there and shown in the presenter window;
//   - share pages and exported decks in a browser: no filter exists there.
// A name that cannot be resolved is let through: the request then fails in Chromium for the same
// reason, or goes through a proxy, which connects from somewhere other than this Mac.

/**
 * OPEN OWNER QUESTION (design section 12, question 4): may a slide show a page served from this Mac
 * or the local network when the outline itself names it (`[Embed: http://localhost:7860]`)?
 *
 *   'refuse' — no frame in a slide loads its document from a local address (the design's
 *              recommendation, answer a). The slide shows the box with its "Open ↗" link. This is
 *              the value in force: under 'load' main cannot tell the deck setting the frame's
 *              address from the embedded page navigating its own frame, a form submitted from it
 *              (a POST with a body the page chose), a redirect of the frame, or a frame added to the
 *              deck's document by a page that shares its origin — every one of them reached a
 *              loopback server in the security review.
 *   'load'   — a frame directly inside the main frame may load its own document from a local
 *              address; requests from inside embedded frames are still refused.
 *
 * The owner's question stays open. Answer (a): nothing to do. Answer (b) must NOT be 'load' as it
 * stands. Wire it as a narrower third case: give `decideLocalRequest` the embed addresses of the
 * window's deck (main already extracts them per deck, `extractDeckEmbeds` in index.ts) and let
 * 'embed-frame-itself' through only for a GET of exactly one of those addresses that is not a
 * redirect hop (keep the request ids seen, to tell a first request from a later hop). Self-navigation
 * to another address, form posts and redirects then stay refused.
 */
export type OutlineNamedLocalEmbed = 'load' | 'refuse'
export const OUTLINE_NAMED_LOCAL_EMBED: OutlineNamedLocalEmbed = 'refuse'

const WEB_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:'])

/** The URL patterns the listener is registered for: web requests only, never file: or an app scheme. */
export const FILTERED_URL_PATTERNS = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] as const

export type HostClass = 'local' | 'public' | 'name'

function isLocalIPv4(a: number, b: number): boolean {
  if (a === 0) return true // 0.0.0.0/8: the unspecified address and "this network"
  if (a === 10) return true // RFC 1918
  if (a === 127) return true // loopback
  if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT, 100.64.0.0/10
  if (a === 169 && b === 254) return true // link-local
  if (a === 172 && b >= 16 && b <= 31) return true // RFC 1918
  if (a === 192 && b === 168) return true // RFC 1918
  if (a >= 224) return true // multicast, reserved, broadcast
  return false
}

function parseIPv4(text: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
  if (!m) return null
  const parts = m.slice(1).map(Number) as [number, number, number, number]
  return parts.every((n) => n <= 255) ? parts : null
}

/** Eight 16-bit groups of an IPv6 address in text form (no brackets, no zone), or null. */
function parseIPv6(text: string): number[] | null {
  if (!/^[0-9a-f:.]+$/i.test(text) || !text.includes(':')) return null
  let body = text
  const tail: number[] = []
  const lastColon = body.lastIndexOf(':')
  if (body.slice(lastColon + 1).includes('.')) {
    const v4 = parseIPv4(body.slice(lastColon + 1))
    if (!v4) return null
    tail.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3])
    body = body.slice(0, lastColon + 1)
    if (body.endsWith('::')) { /* keep the :: */ } else body = body.slice(0, -1)
    if (body === '') return null
  }
  const halves = body.split('::')
  if (halves.length > 2) return null
  const groups = (part: string): number[] | null => {
    if (part === '') return []
    const out: number[] = []
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null
      out.push(parseInt(g, 16))
    }
    return out
  }
  const head = groups(halves[0])
  const rest = halves.length === 2 ? groups(halves[1]) : []
  if (!head || !rest) return null
  const known = head.length + rest.length + tail.length
  if (halves.length === 2) {
    if (known > 7) return null
    return [...head, ...new Array(8 - known).fill(0), ...rest, ...tail]
  }
  return known === 8 ? [...head, ...tail] : null
}

function isLocalIPv6(h: number[]): boolean {
  const v4 = (hi: number): boolean => isLocalIPv4(hi >> 8, hi & 0xff) // the first two bytes decide every range
  const leadingZeros = (n: number): boolean => h.slice(0, n).every((g) => g === 0)
  if (leadingZeros(8)) return true // ::
  if (leadingZeros(7) && h[7] === 1) return true // ::1
  if (leadingZeros(5) && h[5] === 0xffff) return v4(h[6]) // IPv4-mapped ::ffff:a.b.c.d
  if (leadingZeros(6)) return v4(h[6]) // IPv4-compatible ::a.b.c.d (deprecated)
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0) return v4(h[6]) // NAT64 64:ff9b::/96
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) return true // local-use NAT64 64:ff9b:1::/48
  if (h[0] === 0x2002) return v4(h[1]) // 6to4 carries an IPv4 address
  if ((h[0] & 0xfe00) === 0xfc00) return true // unique-local fc00::/7
  if ((h[0] & 0xffc0) === 0xfe80) return true // link-local fe80::/10
  if ((h[0] & 0xffc0) === 0xfec0) return true // site-local fec0::/10 (deprecated)
  if ((h[0] & 0xff00) === 0xff00) return true // multicast
  return false
}

/** An address in text form as a resolver returns it (`127.0.0.1`, `::1`, `fe80::1`). Unreadable is local. */
export function isLocalAddress(address: unknown): boolean {
  if (typeof address !== 'string' || !address) return true
  const text = address.trim().replace(/^\[|\]$/g, '')
  const v4 = parseIPv4(text)
  if (v4) return isLocalIPv4(v4[0], v4[1])
  const v6 = parseIPv6(text)
  return v6 ? isLocalIPv6(v6) : true
}

/**
 * A host as it stands in a URL (`localhost`, `127.0.0.1`, `[::1]`, `0x7f.1`, `Printer.LOCAL.`):
 * 'local', 'public' (a literal public address) or 'name' (a name that has to be resolved).
 */
export function classifyHost(host: unknown): HostClass {
  if (typeof host !== 'string' || !host.trim()) return 'local'
  let name = host.trim()
  // Normalise as Chromium does: numbers in other bases, upper case, percent-escapes, IDNA.
  try {
    const bare = name.replace(/^\[|\]$/g, '')
    name = new URL(`http://${bare.includes(':') ? `[${bare}]` : bare}/`).hostname
  } catch { return 'local' }
  name = name.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '')
  if (!name) return 'local'
  if (name.includes(':')) return isLocalAddress(name) ? 'local' : 'public'
  if (/^[\d.]+$/.test(name)) return isLocalAddress(name) ? 'local' : 'public'
  if (name === 'localhost' || name.endsWith('.localhost')) return 'local'
  if (name === 'local' || name.endsWith('.local')) return 'local'
  return 'name'
}

/** The host of a web URL (http, https, ws, wss), or null when the URL is another scheme. Throws on an unreadable URL. */
function webHostOf(url: string): string | null {
  const u = new URL(url)
  return WEB_SCHEMES.has(u.protocol) ? u.hostname : null
}

export type Requester = 'app' | 'main-frame' | 'embed-frame-itself' | 'inside-embed'

type FrameLike = { parent?: FrameLike | null } | null | undefined

export interface RequestFacts {
  url: string
  resourceType?: string
  /** `details.frame`: the frame that makes the request, or (for a frame's own document) the frame that loads. */
  frame?: FrameLike
  webContents?: unknown
  webContentsId?: unknown
}

/** Who is asking. Anything that cannot be read is treated as inside an embedded frame. */
export function requesterOf(details: RequestFacts): Requester {
  let frame: FrameLike
  try { frame = details.frame } catch { return 'inside-embed' }
  if (frame === null || frame === undefined) {
    if (details.resourceType === 'mainFrame') return 'main-frame' // a window's own page before its frame exists
    const window = details.webContents ?? details.webContentsId
    return window === null || window === undefined ? 'app' : 'inside-embed' // a frame that has gone
  }
  let parent: FrameLike
  try { parent = frame.parent } catch { return 'inside-embed' }
  if (parent === null || parent === undefined) return 'main-frame'
  if (details.resourceType !== 'subFrame') return 'inside-embed'
  let grandparent: FrameLike
  try { grandparent = parent.parent } catch { return 'inside-embed' }
  return grandparent === null || grandparent === undefined ? 'embed-frame-itself' : 'inside-embed'
}

export type LocalRequestDecision = 'allow' | 'refuse' | 'resolve'

/** `host:port` of a web address as main registers it (`localhost:5173`), lower case; null when unreadable. */
export function appLocalHostOf(url: unknown): string | null {
  try {
    const u = new URL(String(url))
    return WEB_SCHEMES.has(u.protocol) && u.host ? u.host.toLowerCase() : null
  } catch { return null }
}

function isAppLocalHost(url: string, hosts: Iterable<string> | undefined): boolean {
  if (!hosts) return false
  const host = appLocalHostOf(url)
  if (!host) return false
  for (const allowed of hosts) if (typeof allowed === 'string' && allowed.toLowerCase() === host) return true
  return false
}

/**
 * `resolved`: the addresses the host's name resolves to, when it has been looked up. Without it a
 * request to a name returns 'resolve': look the name up and ask again.
 */
export function decideLocalRequest(request: { url: string; requester: Requester; resolved?: readonly string[]; outlineNamedLocalEmbed?: OutlineNamedLocalEmbed; appLocalHosts?: Iterable<string> }): LocalRequestDecision {
  const { requester } = request
  if (requester === 'main-frame') return 'allow'
  let host: string | null
  try { host = webHostOf(request.url) } catch { return 'refuse' }
  if (host === null) return 'allow' // not a web request: file:, data:, blob:, the app schemes, devtools:
  if (requester === 'app' && isAppLocalHost(request.url, request.appLocalHosts)) return 'allow'
  if (requester === 'embed-frame-itself' && (request.outlineNamedLocalEmbed ?? OUTLINE_NAMED_LOCAL_EMBED) === 'load') return 'allow'
  const kind = classifyHost(host)
  if (kind === 'local') return 'refuse'
  if (kind === 'public') return 'allow'
  if (!request.resolved) return 'resolve'
  return request.resolved.some((address) => isLocalAddress(address)) ? 'refuse' : 'allow'
}

type BeforeRequestDetails = RequestFacts & { webContents?: { id?: unknown; getURL?: () => string } | null }
type BeforeRequestCallback = (response: { cancel?: boolean }) => void

export interface LocalAddressFilterOptions {
  /** The addresses a name resolves to (`session.resolveHost`). */
  resolveHost(host: string): Promise<readonly string[]>
  log?: (message: string) => void
  outlineNamedLocalEmbed?: OutlineNamedLocalEmbed
  /**
   * The local `host:port`s main itself asks for through the session with no frame (the dev server
   * in development). A frameless request to any other local address is refused.
   */
  appLocalHosts?: Iterable<string>
  now?: () => number
}

const RESOLVE_TTL_MS = 30_000
const RESOLVE_CACHE_MAX = 500
const LOG_PER_WINDOW = 20
const LOG_WINDOW_MS = 10_000

/** The `webRequest.onBeforeRequest` listener (exported for the test). Calls back exactly once. */
export function localAddressRequestListener(opts: LocalAddressFilterOptions): (details: BeforeRequestDetails, callback: BeforeRequestCallback) => void {
  const log = opts.log ?? console.warn
  const now = opts.now ?? (() => Date.now())
  const resolved = new Map<string, { at: number; addresses: readonly string[] }>()
  const pending = new Map<string, Promise<readonly string[]>>()
  const logged = new Map<string, { since: number; count: number }>()

  const lookup = (host: string): Promise<readonly string[]> => {
    const hit = resolved.get(host)
    if (hit && now() - hit.at >= 0 && now() - hit.at < RESOLVE_TTL_MS) return Promise.resolve(hit.addresses)
    const running = pending.get(host)
    if (running) return running
    const started = Promise.resolve().then(() => opts.resolveHost(host)).then((addresses) => {
      if (resolved.size >= RESOLVE_CACHE_MAX) resolved.clear()
      resolved.set(host, { at: now(), addresses })
      return addresses
    }).finally(() => { pending.delete(host) })
    pending.set(host, started)
    return started
  }

  const report = (details: BeforeRequestDetails): void => {
    try {
      const key = String(details.webContents?.id ?? details.webContentsId ?? '?')
      const entry = logged.get(key)
      const t = now()
      const fresh = !entry || t - entry.since >= LOG_WINDOW_MS || t < entry.since
      const state = fresh ? { since: t, count: 0 } : entry
      state.count++
      if (logged.size > 200) logged.clear()
      logged.set(key, state)
      if (state.count > LOG_PER_WINDOW + 1) return
      if (state.count === LOG_PER_WINDOW + 1) { log(`[local-address] further refusals in window ${key} are not logged for ${LOG_WINDOW_MS / 1000} s`); return }
      let target = ''
      try { const u = new URL(details.url); target = `${u.protocol}//${u.host}` } catch { target = 'an unreadable address' }
      let top = ''
      try { top = String(details.webContents?.getURL?.() ?? '').slice(0, 120) } catch { /* destroyed */ }
      log(`[local-address] refused ${String(details.resourceType ?? 'a')} request to ${target} from ${details.frame || key !== '?' ? 'an embedded frame' : 'a worker or a request with no frame'} in window ${key}${top ? ` (${top})` : ''}`)
    } catch { /* logging never changes the answer */ }
  }

  return (details, callback) => {
    let answered = false
    const answer = (cancel: boolean): void => {
      if (answered) return
      answered = true
      if (cancel) report(details)
      callback(cancel ? { cancel: true } : {})
    }
    let requester: Requester = 'inside-embed'
    try {
      requester = requesterOf(details)
      const first = decideLocalRequest({ url: details.url, requester, outlineNamedLocalEmbed: opts.outlineNamedLocalEmbed, appLocalHosts: opts.appLocalHosts })
      if (first !== 'resolve') { answer(first === 'refuse'); return }
      const host = new URL(details.url).hostname.toLowerCase().replace(/\.+$/, '')
      lookup(host).then(
        (addresses) => answer(decideLocalRequest({ url: details.url, requester, resolved: addresses, outlineNamedLocalEmbed: opts.outlineNamedLocalEmbed, appLocalHosts: opts.appLocalHosts }) === 'refuse'),
        () => answer(false), // the name does not resolve: the request fails in Chromium too
      )
    } catch {
      answer(requester !== 'main-frame')
    }
  }
}

type FilterSession = {
  webRequest: { onBeforeRequest(filter: { urls: string[] }, listener: (details: any, callback: BeforeRequestCallback) => void): void }
  resolveHost(host: string): Promise<{ endpoints: Array<{ address: string }> }>
}

/**
 * Install once on the session every window uses (the default session). Electron keeps ONE
 * onBeforeRequest listener per session: nothing else in the app registers one.
 */
export function installLocalAddressFilter(session: FilterSession, opts: Omit<LocalAddressFilterOptions, 'resolveHost'> & { resolveHost?: LocalAddressFilterOptions['resolveHost'] } = {}): void {
  const resolveHost = opts.resolveHost ?? (async (host: string) => (await session.resolveHost(host)).endpoints.map((endpoint) => endpoint.address))
  session.webRequest.onBeforeRequest({ urls: [...FILTERED_URL_PATTERNS] }, localAddressRequestListener({ ...opts, resolveHost }))
}

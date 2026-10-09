// The twthumb:// address of one rendered picture: built here by every producer (main and renderer)
// and read back here by the protocol handler (main/thumb-cache-dirs.ts parseThumbUrl), so the two
// cannot drift.
//
//   twthumb://thumb/<slug>/<key>        slug and key each percent-encoded as one path segment
//
// The slug used to be the URL's HOST (`twthumb://<slug>/<key>`). twthumb is registered as a standard
// scheme (main/index.ts), so Chromium parses that host as a domain name: a space makes the URL
// invalid, non-ASCII letters are turned into punycode and capitals are lowercased — "two words" and
// "Přednáška o agentech" never reached the handler. In the path, any slug survives as it is. The
// host is now the fixed word `thumb`. The handler still reads the older host form (one path segment)
// so a URL kept from an older build resolves.
//
// Pure: no I/O. Containment (no `..`, no separator, no absolute path) is checked by the caller on
// the DECODED values this returns (thumb-cache-dirs.ts isPlainSegment, vault-paths.ts thumbCacheDir).

export const THUMB_HOST = 'thumb'

/** The address of picture `key` of talk `slug`, without the vault query. */
export function thumbAddress(slug: string, key: string): string {
  return `twthumb://${THUMB_HOST}/${encodeURIComponent(slug)}/${encodeURIComponent(key)}`
}

/** The slug and key a twthumb:// URL names, decoded; null when it is not one or does not decode.
 *  Values are NOT checked for containment here. */
export function thumbAddressParts(url: URL): { slug: string; key: string } | null {
  if (url.protocol !== 'twthumb:') return null
  const segments = url.pathname.replace(/^\//, '').split('/')
  try {
    if (url.hostname === THUMB_HOST && segments.length === 2) {
      return { slug: decodeURIComponent(segments[0]), key: decodeURIComponent(segments[1]) }
    }
    // The older form: the slug in the host, the key the only path segment.
    if (segments.length === 1) return { slug: decodeURIComponent(url.hostname), key: decodeURIComponent(segments[0]) }
  } catch { /* a malformed escape */ }
  return null
}

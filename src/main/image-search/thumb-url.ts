// twarchive:// URLs for search thumbnails (moved out of index.ts, ticket 10). The payload is the
// base64url (RFC 4648 §5, no padding) of an absolute file path. Which files may be served is the
// providers' decision (ImageSearchProvider.fileFor), never this module's.

import { realpathSync } from 'fs'
import { resolve as resolvePath, sep as pathSep } from 'path'

export function toBase64Url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(b64, 'base64').toString('utf8')
}

// twarchive:// is registered as a STANDARD scheme, so Chromium canonicalises the URL host to
// lowercase — which would corrupt the case-sensitive base64url payload. Keep the payload in the
// URL PATH (case-preserved) behind a fixed throwaway host. The thumbUrl value still carries the
// base64url of the absolute file path, per contract; decoding tolerates both shapes.
const TWARCHIVE_HOST = 'f'
export function twarchiveUrl(absPath: string): string {
  return 'twarchive://' + TWARCHIVE_HOST + '/' + toBase64Url(absPath)
}
// Pull the base64url payload out of any twarchive:// URL shape (path-first, or legacy host).
export function twarchivePayload(url: string): string {
  const rest = url.slice('twarchive://'.length)
  const slash = rest.indexOf('/')
  // Path form twarchive://<host>/<payload>: take everything after the first slash.
  if (slash >= 0) return rest.slice(slash + 1).replace(/\/+$/, '')
  // Bare form twarchive://<payload> (legacy / raw): the whole remainder.
  return rest.replace(/\/+$/, '')
}

/** The absolute path a thumbUrl (or a raw absolute path, as the archive import always took) names. */
export function pathFromThumbUrl(thumbUrlOrPath: string): string {
  if (typeof thumbUrlOrPath !== 'string') return ''
  try {
    const raw = thumbUrlOrPath.startsWith('twarchive://')
      ? fromBase64Url(decodeURIComponent(twarchivePayload(thumbUrlOrPath)))
      : thumbUrlOrPath
    return raw && !raw.includes('\0') ? resolvePath(raw) : ''
  } catch {
    return '' // a malformed %-escape
  }
}

// Guard: resolve symlinks where possible and require the path to sit inside the root.
export function isInsideRoot(absPath: string, root: string): boolean {
  let resolvedRoot: string
  let resolvedPath: string
  try {
    resolvedRoot = realpathSync(root)
  } catch {
    resolvedRoot = resolvePath(root)
  }
  try {
    resolvedPath = realpathSync(absPath)
  } catch {
    resolvedPath = resolvePath(absPath)
  }
  const rootWithSep = resolvedRoot.endsWith(pathSep) ? resolvedRoot : resolvedRoot + pathSep
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(rootWithSep)
}

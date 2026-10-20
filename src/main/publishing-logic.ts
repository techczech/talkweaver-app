// Pure publishing logic (no Electron/fs). The replica in scripts/test-publishing-logic.mjs MUST
// match these algorithms (the main process has no TS test runner — same convention as
// searchPaletteSelection.ts / test-selector-logic.mjs).

import { posix, win32 } from 'node:path'

/**
 * The folder the published site is kept in, always ABSOLUTE: the default, or the `publishSiteDir`
 * override; a relative override is taken from the user-data folder. The one value is used both for
 * building the site and as wrangler's argument, so the two can never disagree about where it is
 * (wrangler runs in a folder of its own and would read a relative path from there).
 */
export function resolveSiteDir(userData: string, override: string | undefined, platform: string = process.platform): string {
  const path = platform === 'win32' ? win32 : posix
  return override && override.trim() ? path.resolve(userData, override.trim()) : path.join(userData, 'cloudflare-pages-site')
}

/**
 * `pages deploy` compiles code (starts esbuild) only for a site with Functions: a `functions` folder
 * where wrangler runs, or a `_worker.js` (file or folder) in the site. The handout site has neither.
 * Should one ever appear, publishing stops with this message rather than bring run-time compiling
 * back. Null when the site is plain files.
 */
export function pagesBundlingHazard(
  siteDir: string, runFolder: string, exists: (path: string) => boolean, platform: string = process.platform,
): string | null {
  const path = platform === 'win32' ? win32 : posix
  const found = [path.join(siteDir, '_worker.js'), path.join(siteDir, 'functions'), path.join(runFolder, 'functions')].find(exists)
  return found ? `Publishing stopped: ${found} would make the site run code, which TalkWeaver handouts never do. Remove it and publish again.` : null
}

const CFG_ERR = 'Configure Cloudflare publishing in Settings → Cloudflare (see docs/PUBLISHING.md)'

export function checkPreconditions(c: {
  accountId?: string
  project?: string
  hasToken: boolean
}): { ok: true } | { ok: false; error: string } {
  if (!c.accountId || !c.project || !c.hasToken) return { ok: false, error: CFG_ERR }
  return { ok: true }
}

export const PUBLISH_REFUSED = 'Cloudflare did not accept the token for publishing. In Settings → Cloudflare, check that the token has the permission Account · Cloudflare Pages · Edit.'
export const PUBLISH_TOKEN_REJECTED = 'Cloudflare did not accept this token, so nothing was published. Replace it in Settings → Cloudflare.'
export const PUBLISH_NO_SITE = 'The site to publish to was not found at Cloudflare, so nothing was published. Check it in Settings → Cloudflare.'
export const PUBLISH_UNREACHABLE = 'Cloudflare could not be reached, so nothing was published. Try again when this computer is online.'
export const PUBLISH_TOO_LARGE = 'A file in the site is over the size Cloudflare accepts (25 MiB), so nothing was published.'
export const PUBLISH_FAILED = 'Publishing to Cloudflare did not finish.'

/**
 * `permission`: the token is a real one that may not publish to this site (the Publishing handouts
 * row then says so). `token`: Cloudflare does not know the token at all. `failed`: none of the others.
 */
export type PublishFailureKind = 'permission' | 'token' | 'no-site' | 'unreachable' | 'too-large' | 'failed'

const PUBLISH_FAILURE_TEXT: Record<PublishFailureKind, string> = {
  permission: PUBLISH_REFUSED, token: PUBLISH_TOKEN_REJECTED, 'no-site': PUBLISH_NO_SITE,
  unreachable: PUBLISH_UNREACHABLE, 'too-large': PUBLISH_TOO_LARGE, failed: PUBLISH_FAILED,
}

/** Which of the sorted failures the publishing tool's output shows (decision D12). Reads error numbers and fixed phrases only. */
export function pagesDeployFailureKind(output: string): PublishFailureKind {
  if (/Authentication error|\[code: 10000\]|\b403\b/i.test(output)) return 'permission'
  if (/Invalid API Token|\[code: 1000\]|\[code: 10001\]|\b401\b|Unable to authenticate/i.test(output)) return 'token'
  if (/Project not found|\[code: 8000007\]/i.test(output)) return 'no-site'
  if (/\b25 ?MiB\b|exceeds the (?:maximum|file size)|file size limit/i.test(output)) return 'too-large'
  if (/\b(?:ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|UND_ERR_[A-Z_]+)\b|fetch failed|getaddrinfo|socket hang up/i.test(output)) return 'unreachable'
  return 'failed'
}

/**
 * A failed `pages deploy`, for the person: one of the fixed sentences above, never what the
 * publishing tool or Cloudflare wrote. What they wrote (its end) goes in `details`, for "Details"
 * only; the caller takes the token out of it first (handout-publishing.ts).
 */
export function pagesDeployFailure(output: string): { error: string; details: string; kind: PublishFailureKind } {
  const kind = pagesDeployFailureKind(output)
  return { error: PUBLISH_FAILURE_TEXT[kind], details: output.trim().slice(-600), kind }
}

export function resolveBase(opts: { baseUrl?: string; project: string }): string {
  const raw = opts.baseUrl && opts.baseUrl.trim() ? opts.baseUrl.trim() : `https://${opts.project}.pages.dev`
  return raw.replace(/\/+$/, '')
}

/**
 * A name (a talk's folder, a short id) as ONE segment of a path on the site. A talk's name is the
 * author's, taken from a file name: a space, `#`, `?`, `%` or `/` in it must stay part of the name,
 * never start a second field of a redirect line, a fragment, a query or another segment. An
 * ordinary name (letters, digits, `-`, `_`, `.`, `~`) comes out exactly as it is. `*` is encoded
 * too: in a redirect's source it would be a wildcard.
 */
export function pathSegment(name: string): string {
  return encodeURIComponent(String(name)).replace(/\*/g, '%2A')
}

export const SITE_FOLDER_REFUSED = 'Publishing stopped: this name cannot be a folder of the site (it would not stay inside the site folder, or the computer could not keep it as written). Rename the talk\'s file and publish again. Nothing was written or removed.'

/** Names Windows keeps for devices, with any extension: a folder cannot have one. */
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\..*)?$/i

/**
 * THE only way a name becomes a folder under the site folder: the absolute path of `name` as an
 * immediate child of `siteDir`, or null. A name is taken only when it is ONE plain segment: not
 * empty, not `.` or `..`, with no `/`, no `\`, no NUL or other control character, no leading or
 * trailing space and no trailing dot (Windows strips those, so the folder made would not be the one
 * named), not a Windows device name (`CON`, `NUL`, `COM1`…), on Windows no `:` (a drive or a
 * stream), and such that the path it gives is exactly a child of the site folder. Names come from
 * outside the app's control (an outline's file name, a link stored on a Run, a registry file), so
 * every publish, unpublish and listing goes through here before anything is written or removed.
 */
export function siteFolder(siteDir: string, name: unknown, platform: string = process.platform): string | null {
  if (typeof name !== 'string' || name === '' || name === '.' || name === '..') return null
  // eslint-disable-next-line no-control-regex
  if (/[/\\\u0000-\u001f\u007f]/.test(name)) return null
  if (/^\s|[\s.]$/.test(name)) return null
  if (WINDOWS_DEVICE.test(name)) return null
  if (platform === 'win32' && name.includes(':')) return null
  const path = platform === 'win32' ? win32 : posix
  const root = path.resolve(siteDir)
  const full = path.resolve(root, name)
  return path.dirname(full) === root && path.basename(full) === name ? full : null
}

export function publishUrl(opts: { base: string; slug: string; id?: string; useShortIds: boolean }): string {
  if (opts.useShortIds && opts.id) return `${opts.base}/${pathSegment(opts.id)}`
  return `${opts.base}/${pathSegment(opts.slug)}/`
}

export function readHandoutUrl(text: string): string | null {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const scope = fm ? fm[1] : ''
  const m = scope.match(/^\s*handout_url\s*:\s*(.+?)\s*$/m)
  return m ? m[1].replace(/^["']|["']$/g, '') : null
}

export function recoverIdFromUrl(handoutUrl: string | null | undefined, base: string): string | null {
  if (!handoutUrl) return null
  const b = base.replace(/\/+$/, '')
  if (!handoutUrl.startsWith(b + '/')) return null
  const rest = handoutUrl.slice(b.length + 1).replace(/\/+$/, '')
  return /^[a-z0-9]{3,8}$/.test(rest) ? rest : null
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
export function generateShortId(rand: (n: number) => Uint8Array): string {
  const bytes = rand(4)
  let s = ''
  for (let i = 0; i < 4; i++) s += ALPHABET[bytes[i] % 36]
  return s
}

export function pickShortId(opts: {
  registry: Record<string, string>
  slug: string
  recoveredId?: string | null
  gen: () => string
}): { id: string; registry: Record<string, string> } {
  const { registry, slug } = opts
  if (registry[slug]) return { id: registry[slug], registry }
  const used = new Set(Object.values(registry))
  let id: string | null = null
  if (opts.recoveredId && !used.has(opts.recoveredId)) id = opts.recoveredId
  while (!id) {
    const c = opts.gen()
    if (!used.has(c)) id = c
  }
  return { id, registry: { ...registry, [slug]: id } }
}

export function buildRedirects(registry: Record<string, string>, existingSlugs: Iterable<string>): string {
  const exists = new Set(existingSlugs)
  const lines = Object.entries(registry)
    .filter(([slug]) => exists.has(slug))
    .sort((a, b) => a[1].localeCompare(b[1]))
    // Each name is one encoded path segment: `two words` is `/two%20words/`, not a third field. A Run's
    // pre-work and post-work pages sit in its folder (work-files ticket 16): its short link leads there too.
    .flatMap(([slug, id]) => [`/${pathSegment(id)}  /${pathSegment(slug)}/  302`, `/${pathSegment(id)}/p  /${pathSegment(slug)}/p/  302`,
      `/${pathSegment(id)}/pre-work  /${pathSegment(slug)}/pre-work/  302`, `/${pathSegment(id)}/post-work  /${pathSegment(slug)}/post-work/  302`])
  return lines.length ? lines.join('\n') + '\n' : ''
}

// Pure, shared with the renderer (which stamps an open talk's buffer, one-writer spec D1).
export { stampHandoutUrl } from '../shared/handout-stamp.ts'

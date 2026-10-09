// What main hands to the OS as a link (shell.openExternal), and in what form. Every site in main
// that opens a link for a page or for a talk's content goes through `handOutLink`:
//   - the string is parsed ONCE (`new URL`), and the SAME parsed object is what the rules judge and
//     what is handed out, as its normalised `href`. The raw string is never handed to the OS, so a
//     spelling that reads one way to a check and another way to a browser cannot arise
//     (`http:127.0.0.1`, backslashes, leading control characters, a percent-escaped or full-width
//     host, `http://example.com@127.0.0.1/`);
//   - the scheme is exactly `http:`, `https:` or `mailto:`; anything else, anything unparseable, and
//     anything longer than 2,000 characters (as given or as normalised) is refused;
//   - a web link loses its user name and password;
//   - a mail link keeps its address(es) and four parameters: `subject`, `body`, `cc` and `bcc` (a
//     slide's "email me your feedback" link with a prepared subject and body is ordinary talk
//     content). Every other parameter is dropped, `attach` / `attachment` among them (some mail
//     programs attach a file a link names) and `to`. Names are matched without regard to case and
//     written in lower case; the first of each is kept, in the order given; values are re-encoded.
//     The whole normalised mail link is under the same 2,000-character limit.
//
// `contentHandOutRefusal` is the further rule for a link that comes from a page that is not the
// app's own (a deck, a talk's content in a preview): never a web link whose host is local as
// written, and nothing from a blank page that navigates itself.
import { classifyHost } from './local-address-filter.ts'

export const HAND_OUT_MAX_LENGTH = 2_000

/** The only parameters a mail link keeps. */
const MAIL_PARAMETERS: ReadonlySet<string> = new Set(['subject', 'body', 'cc', 'bcc'])

export interface HandOutLink {
  /** The normalised address: the only string ever passed to the OS. */
  href: string
  kind: 'web' | 'mail'
  /** The host of a web link as the URL parser reads it; '' for mail. */
  hostname: string
}

export function handOutLink(raw: unknown): HandOutLink | null {
  if (typeof raw !== 'string' || !raw || raw.length > HAND_OUT_MAX_LENGTH) return null
  let u: URL
  try { u = new URL(raw) } catch { return null }
  let link: HandOutLink
  if (u.protocol === 'http:' || u.protocol === 'https:') {
    if (!u.hostname) return null
    u.username = ''
    u.password = ''
    link = { href: u.href, kind: 'web', hostname: u.hostname }
  } else if (u.protocol === 'mailto:') {
    if (!u.pathname) return null
    const kept: string[] = []
    const seen = new Set<string>()
    for (const [given, value] of u.searchParams) {
      const name = given.toLowerCase()
      if (!MAIL_PARAMETERS.has(name) || seen.has(name)) continue
      seen.add(name)
      if (value) kept.push(`${name}=${encodeURIComponent(value)}`)
    }
    link = { href: `mailto:${u.pathname}${kept.length ? `?${kept.join('&')}` : ''}`, kind: 'mail', hostname: '' }
  } else return null
  return link.href.length <= HAND_OUT_MAX_LENGTH ? link : null
}

export type ContentHandOutRefusal = 'a local address' | 'a blank page hands nothing out' | 'not a link that can be handed out'

/**
 * May a page that is not the app's own hand this link to the OS? `from`: the page the window
 * shows, given when the window is navigating itself; absent for window.open. A name is not
 * resolved: a public name that resolves to this Mac is not caught here.
 */
export function contentHandOutRefusal(request: { url: unknown; from?: unknown }): ContentHandOutRefusal | null {
  const link = handOutLink(request.url)
  if (!link) return 'not a link that can be handed out'
  if (link.kind === 'web' && classifyHost(link.hostname) === 'local') return 'a local address'
  if (typeof request.from === 'string') {
    let about = false
    try { about = new URL(request.from).protocol === 'about:' } catch { about = false }
    if (about) return 'a blank page hands nothing out'
  }
  return null
}

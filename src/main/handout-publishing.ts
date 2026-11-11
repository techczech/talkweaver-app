import { beginPublication, candidatePath, preservationMessage, publicationPaths, publicationBinding, PreservationRefusal, readPublicationRecord, type PreservationInventory, type PreservationAttempt, type PublicationLaunch } from './publication-preservation.ts'
// Publishing handouts to the person's Cloudflare Pages site: the one sequence every publish goes
// through, and the one place the site is uploaded (spec docs/plans/cloudflare-setup-in-app, D7, D8,
// D12 and the table "What each user action does when its feature is not ready").
//
// PER-TALK PUBLISHING (spec docs/plans/2026-11-05-per-talk-publishing/spec.md). A deployment is the live manifest with ONE
// change merged in. A publish reads the production deployment (its id and every path with its hash) and the site record
// (`/_talkweaver/site.json`, site-record.ts), lays the site out in a private folder of its own (an EMPTY stand-in for every live
// file: nothing of the other handouts is read or even present), lets the job build there, and sends only what the job wrote:
// hashed as wrangler hashes, the bytes Cloudflare lacks uploaded, every other path keeping its live hash
// (pages-direct-upload.ts). `_redirects` is made from the site record, `_headers` is the record's, and the new record goes up in
// the same deployment. The production deployment is read once more immediately before the deployment is created; when it moved,
// nothing is created (PUBLISH_REVISION_CHANGED). No copy of the site is needed on this computer, and no publishing tool runs:
// `wrangler pages deploy` is not used for handouts (scripts/test-per-talk-publishing.mjs holds the five invariants).
//
// EVERY WAY THE SITE IS CHANGED. Each is a `PublishJob` given to `publish()`; nothing else in the
// app sends to the site (scripts/test-handout-publishing.mjs reads the main process to show it).
//
//   Entry point (`PublishEntry`) | Reached from                         | What it does to the site             | Live address in its pages
//   -----------------------------|--------------------------------------|--------------------------------------|--------------------------
//   talk                         | Publish handout (`talk:publish-      | writes the talk's pages              | yes, when the live service
//                                | handout`)                            |                                      | is ready
//   run                          | Publish handout for this Run /       | writes the Run's pages: its handout, | yes, when the live service
//                                | Publish for this run                 | and its `pre-work/` and `post-work/` | is ready (the work pages:
//                                | (`run:publish-handout`)              | pages (work-files ticket 16)         | the Worker's own address)
//   run-unpublish                | Unpublish (the Run checklist) /      | a Run with a sent phase (stamped on  | none: the one page it
//                                | Unpublish Run handout                | the Run or in the work service's     | writes holds no address
//                                | (`run:unpublish-handout`)            | record): every page of the Run's     |
//                                |                                      | folder becomes "This page is not     |
//                                |                                      | available", the rest of the folder   |
//                                |                                      | goes (ticket 17); else removes the   |
//                                |                                      | Run's pages                          |
//   talk-unpublish               | Unpublish a talk handout (Published  | removes the talk's own folder, and   | none: it writes no page
//                                | pages; `published:unpublish-talk`)   | its line of the redirect file        |
//                                |                                      | (talk-unpublish.ts, ticket 22)       |
//   live-short-link              | Go live, when the talk's short link  | rewrites `_redirects` only           | none: it writes no page
//                                | is new (`live:go`)                   |                                      |
//
//   There is no other: no republish or refresh command, no automatic publish on save, and no
//   command-line or agent path (the `setup` command of a later ticket does not publish). "Export
//   handout" / "Save as a file instead" and "Build Run handout" write a file on this computer and
//   upload nothing; the live service's own deploy (live-service-deploy.ts) and Share for comments
//   (shared-talk.ts) send to the live service, never to the site. They are outside this module.
//
//   The Run's folder for `run` and `run-unpublish` is decided from the Run's own facts (its recorded
//   folder and its link), never from what the site's copy holds (run-unpublish.ts runSiteFolder,
//   runPublishFolder): a recorded folder missing here is published back into by the same name.
//   A CHANGE TOUCHES ONLY ITS OWN FOLDERS: the folders the job builds (`makeFolder`, replaced whole) or unpublishes
//   (`removalRoots`), and top-level files it writes (the 404 page). Anything else that differs from the live manifest stops the
//   publish before anything is sent (PUBLISH_UNRELATED_REMOVAL, an assertion: the merge itself cannot drop a path it did not
//   stage). The preservation guard (publication-preservation.ts) still holds the site lock, the recovery journal and the record
//   the other writer reads, and needs a complete production inventory.
//
// WHAT MUST HOLD, for every row of that table. Each is a test in scripts/test-handout-publishing.mjs
// (the sequence) or in scripts/test-handout-from-buffer.mjs and test-prework-publish.mjs (the real
// handlers of the main process).
//
//   PUBLISHED OUTPUT. No published page carries a loopback or `file:` address in a position
//   TalkWeaver writes: the live-service address and anything derived from it (the live config, the
//   short link, QR targets, sockets), asset and script URLs the compiler generates, and links the
//   app generates. Text and links the author wrote are the author's: a talk about a local server
//   may say `http://localhost:3000`, link to it and show code that calls `127.0.0.1`, and it
//   publishes unchanged. (Earlier versions published `http://127.0.0.1:8787` as the live address,
//   which no phone can reach.)
//     ONE function decides whether an address is on this computer: `addressKind`. It parses with
//     the platform's URL parser first, so every spelling of the same host is the same host
//     (`127.1`, `2130706433`, `0x7f000001` are all 127.0.0.1), and then tests the normalised host:
//     `localhost` and `*.localhost`, all of 127.0.0.0/8, `0.0.0.0`, `::1`, `::`, the IPv4-mapped
//     IPv6 forms of those, and any `file:` address. Where an address is REQUIRED, anything that is
//     not an absolute http(s) address elsewhere is refused.
//     It is applied in two places, and nowhere is a page's prose searched:
//       ENTRY FIRST is the control: every address TalkWeaver writes into a page or a redirect is
//       checked before anything is written. AFTER THE BUILD the app's marked config lines and the
//       redirect file are checked once more; if that ever fails, this publish is not uploaded and
//       reports the fixed sentence. Nothing is moved or remembered; what the publish built NEW is taken
//       away again (as for every publish that stops before anything is sent), so a later upload cannot carry the rejected page. Reaching this needs a
//       fault in the entry check itself.
//         What ENTRY FIRST checks, each before the job writes its first file: the live address
//         (`liveForPages`); every link (`link()` handed to the job: the address every link of the
//         handout starts with, the handout's own link, which is also the venue screen's join link,
//         the QR target and the link shown on the home page; the going-live short link); and the
//         WHOLE text of the redirect file, built in memory first (`redirects()` handed to the job:
//         every line a source path, a target that is a path of this site or an https address not on
//         this computer, and a status). A refusal there (PUBLISH_LINK_REFUSED,
//         PUBLISH_REDIRECTS_REFUSED) leaves the site folder byte for byte as it was. Names the author
//         chose (a talk's file name) reach links and redirects only as encoded path segments
//         (publishing-logic.ts `pathSegment`), so a space, `#`, `?` or `%` in a name is a name and
//         never a second field or another address. The pre-work address goes through
//         `liveAddressForPages` in the handler. The Download button's and the slides view's targets
//         are file NAMES, made into relative, encoded links by the compiler (`pageLink`).
//         What the check AFTER THE BUILD reads, in the pages this build wrote: the configuration
//         lines the compiler wrote AND MARKED as its own
//         (`const LIVE_CONFIG|VENUE_JOIN|PREWORK_CONFIG = {json}; /* talkweaver:app-config */`), EVERY
//         line that starts a Run's pre-work or post-work page (`startWorkPage(window, {json});`: its
//         Worker address and handout link; work-files ticket 16), and
//         the redirect file by the same rule as at entry. An unmarked line that reads the same is the
//         author's and is not read; the same marked line twice means the author copied the mark too,
//         and neither is read. The author always wins, except over a start line: every one is read,
//         and one that cannot be read refuses the publish (a refusal, never a leak).
//       Every publish builds in a PRIVATE folder of its own (`build.dir`, a `tw-site-*` folder of the app's data folder), laid
//       out from the live manifest; it is deleted whatever happens. A publish that stops before anything is sent leaves nothing
//       behind. This computer's copy of the site (`siteDir`) takes the change only once the deployment is up (`mirror`): it is a
//       copy for what reads it here, never what is published.
//     (Earlier versions counted handouts whose pages still carried a dead live address; that needed every page of the site on
//     this computer, which per-talk publishing never reads, so `earlierNotice` is always null now.)
//
//   LIVE NEVER FAILS A PUBLISH. Any failure, refusal, supersession or absence of the live service
//   gives a published handout without live features, and a result whose notice is the sentence of
//   decision D7 ("Published. Going live is not set up: Settings → Cloudflare") followed, when a
//   set-up was tried and failed, by the sorted reason. A live service recorded as deployed for a
//   DIFFERENT Cloudflare account than the one publishing is "not set up for this account": its
//   address is not published. (One with no account recorded, as every install before this version
//   has, is taken to be this account's.) The only things that fail a publish are the publish's
//   own: no leave to publish, the pages could not be built, the upload failed.
//
//   ONE CONNECTION. A publish takes its token, account and site name as ONE authorisation from the
//   connection (`authorisePublish` in cloudflare-connection.ts: one turn of its queue, one
//   generation). The token reaches Cloudflare only through `authorisation.run`, which does
//   not start a launch, and does not hand back its result, once the token, account or site name has
//   changed.
//     A publish superseded before or during its upload uploads nothing further and records nothing.
//     A publish whose upload completed is recorded, whatever happens to the connection afterwards.
//   (Once the upload has completed the page exists at that address, so writing the address down is
//   true.) Before launch a superseded publish reports PUBLISH_SUPERSEDED_ERROR; after launch it
//   reports an unknown outcome with the superseded flag, for the recovery check.
//
//   NO RAW TEXT. Every failure shown is a fixed sentence: one of publishing-logic.ts's sorted
//   failures, a refusal from the connection, or one of this file's. `details` holds fixed words, the HTTP status and
//   Cloudflare's error numbers only (pages-direct-upload.ts PagesApiError), never a reply's text, shown only when "Details" is
//   pressed, and the token is taken out of it all the same (`authorisation.clean`).
//
//   ROW STATE FROM A REFUSED PUBLISH. A publish Cloudflare refuses for permission tells the
//   connection (`refusedForPermission`), which turns the Publishing handouts row to "The token
//   cannot publish pages"; a publish that goes up tells it too (`published`). The rule for that row
//   is in cloudflare-connection.ts. It does not start a new generation.
//
// ORDER AND TIME. One site, one manifest, one deployment at a time: so every publish that
// writes or removes pages (talk, run, run-unpublish, talk-unpublish) runs ONE AT A TIME, in the order asked for (a
// keyed queue, the key being the site folder). A job that depends on what an earlier one recorded
// reads it when its turn BEGINS (`begin`, `prepare`), never when it was asked for: an unpublish
// asked for while the publish is still running finds the link that publish recorded.
//   GOING LIVE checks the shared site lock immediately, outside the ordinary queue. If another
//   publish owns the site, it refuses before writing redirects; the user can try again when idle.
//   A refused attempt never starts a settling upload.
//   TIME LIMITS. A job's first step (saving the open talk): BEGIN_LIMIT_MS, one minute. The
//   connection's own requests: 10 s each. The live service: `LIVE_STEP_LIMIT_MS`
//   (7 minutes), after which the handout goes up without live features. Each request to Cloudflare: one minute (ten for one
//   upload of at most 40 MiB), with wrangler's retries (pages-direct-upload.ts). The queue moves on only once the last one
//   answered.
//
// No Electron import and erasable TypeScript only: scripts/test-handout-publishing.mjs imports this
// file as it is. The main process supplies the connection, the live service, Cloudflare's address and the pages.
import { createHash } from 'node:crypto'
import { type Stats, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { PUBLISH_SUPERSEDED_ERROR, type PublishAuthorisation, type PublishGrant } from './cloudflare-connection.ts'
import { LIVE_SETUP_FAILED, LiveServiceError } from './live-service-deploy.ts'
import { createKeyedQueue } from './owner-tokens.ts'
import { PAGES_UPLOAD, PagesApiError, UploadSuperseded, pagesAssetHash, pagesSiteApi, readLiveAsset, siteAssetAddresses, type Blake3, type PagesTransport, type StagedAsset } from './pages-direct-upload.ts'
import { NO_PRODUCTION_REVISION } from './publishing-inventory.ts'
import { PUBLISH_FAILED, PUBLISH_FAILURE_TEXT, buildRedirects, siteFolder } from './publishing-logic.ts'
import { SITE_RECORD_PATH, manifestFolders, parseSiteRecord, registryClashes, sameSite, serialiseSiteRecord, type SiteRecord } from './site-record.ts'
import { RegistryOriginUnavailable, type RegistryOrigin } from './registry-origin.ts'
import { publishedWithoutLiveText, type PublishNotReady } from '../shared/publish-status.ts'

export type PublishEntry = 'talk' | 'run' | 'run-unpublish' | 'talk-unpublish' | 'live-short-link'

/** The table at the top, for the code and the tests. `live`: its pages may carry the live address. */
export const PUBLISH_ENTRY_POINTS: Record<PublishEntry, { ipc: string; what: string; live: boolean }> = {
  talk: { ipc: 'talk:publish-handout', what: 'Publish handout', live: true },
  run: { ipc: 'run:publish-handout', what: 'Publish handout for this Run', live: true },
  'run-unpublish': { ipc: 'run:unpublish-handout', what: 'Unpublish a Run', live: false },
  'talk-unpublish': { ipc: 'published:unpublish-talk', what: 'Unpublish a talk handout', live: false },
  'live-short-link': { ipc: 'live:go', what: 'Go live, when the short link is new', live: false },
}

export const PUBLISH_LOOPBACK_REFUSED = 'Publishing stopped: a page just built holds an address on this computer, which nobody else can open. Nothing was uploaded.'
export const PUBLISH_REDIRECTS_REFUSED = 'Publishing stopped: a short link of the site would not lead to a page of the site. Nothing was written or uploaded.'
export const PUBLISH_LINK_REFUSED = 'Publishing stopped: the address of the site in Settings → Cloudflare (Custom domain) is on this computer, or is not a web address, so nobody else could open the handout. Nothing was changed or uploaded.'
export const LIVE_TIMED_OUT = 'The live service took too long to answer.'
export const LIVE_OTHER_ACCOUNT = 'Going live is not set up for this Cloudflare account.'
export const PUBLISH_BEGIN_TIMED_OUT = 'Publishing could not start: the talk could not be saved in time.'
/** How long a job's first step (saving the open talk) may hold the queue. */
export const BEGIN_LIMIT_MS = 60_000
export const PUBLISH_TIMED_OUT = 'Publishing to Cloudflare took too long and was stopped.'
/** How long the live service may take before the handout goes up without it. */
export const LIVE_STEP_LIMIT_MS = 7 * 60_000
/** The mark the compiler puts on the configuration lines it writes (compiler/scripts/lib/09-output-builders.mjs, APP_CONFIG_MARK). */
export const APP_CONFIG_MARK = '/* talkweaver:app-config */'
const DETAILS_CHARS = 600

// ── Is this address on this computer? ───────────────────────────────────────────────────────────

/** The schemes whose host the URL parser normalises (so `127.1` and `0x7f000001` come out as `127.0.0.1`). */
const HOSTED = new Set(['http:', 'https:', 'ws:', 'wss:', 'ftp:'])

function hostOnThisComputer(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) return v4[1] === '127' || host === '0.0.0.0'
  if (host.startsWith('[') && host.endsWith(']')) {
    const inner = host.slice(1, -1)
    if (inner === '::1' || inner === '::') return true
    // IPv4 written inside IPv6 (`::ffff:127.0.0.1`, which the parser gives back as `::ffff:7f00:1`).
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(inner)
    if (mapped) {
      const high = Number.parseInt(mapped[1], 16)
      return (high >> 8) === 127 || (high === 0 && Number.parseInt(mapped[2], 16) === 0)
    }
  }
  return false
}

/**
 * THE one answer to "where does this address point". `this-computer`: its host, as the URL parser
 * normalises it, is this computer (`localhost`, `*.localhost`, 127.0.0.0/8, `0.0.0.0`, `::1`, `::`,
 * those written as IPv4 inside IPv6), or it is a `file:` address. `elsewhere`: an absolute http(s)
 * address (or ws, wss, ftp) of another host. `not-an-address`: anything else, including a relative
 * path. An address with no scheme but with a host (`//host/x`) is read as https.
 */
export function addressKind(value: unknown): 'this-computer' | 'elsewhere' | 'not-an-address' {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return 'not-an-address'
  let url: URL
  try { url = new URL(text.startsWith('//') ? `https:${text}` : text) } catch { return 'not-an-address' }
  if (url.protocol === 'file:') return 'this-computer'
  if (!HOSTED.has(url.protocol) || !url.hostname) return 'not-an-address'
  return hostOnThisComputer(url.hostname) ? 'this-computer' : 'elsewhere'
}

/**
 * Decision D8: the live service on `127.0.0.1` is reachable only in an unpackaged build started
 * with TW_LIVE_LOCAL=1. `flag` is that variable's value.
 */
export function localLiveAllowed(context: { packaged: boolean; flag: unknown }): boolean {
  return !context.packaged && context.flag === '1'
}

/**
 * Where an address is REQUIRED (the live address, a link the app writes into a page): `address`
 * without its trailing slash when it is an absolute http(s) address somebody else can open, else ''.
 */
export function liveAddressForPages(address: unknown): string {
  const text = typeof address === 'string' ? address.trim().replace(/\/+$/, '') : ''
  return /^https?:\/\//i.test(text) && addressKind(text) === 'elsewhere' ? text : ''
}

// ── What the app wrote into a built page ────────────────────────────────────────────────────────

const CONFIG_ADDRESS = { LIVE_CONFIG: ['workerBaseUrl', 'the live address'], PREWORK_CONFIG: ['workerBaseUrl', 'the pre-work address'], VENUE_JOIN: ['shortUrl', "the venue screen's join link"] } as const
type ConfigName = keyof typeof CONFIG_ADDRESS
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/** The objects of the `const NAME = {json};` lines of a page; `marked`: only lines that carry the compiler's mark. */
function configLines(html: string, name: ConfigName, marked: boolean): Array<Record<string, unknown> | null> {
  const pattern = new RegExp(String.raw`^[ \t]*const ${name} = (.*);${marked ? `[ \\t]*${escaped(APP_CONFIG_MARK)}` : ''}[ \t]*\r?$`, 'gm')
  return [...html.matchAll(pattern)].map((line) => {
    try {
      const parsed = JSON.parse(line[1]) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
    } catch {
      return null
    }
  })
}

const shown = (position: string, value: unknown): string => `${position}: ${String(value).replace(/[^\x20-\x7e]/g, ' ').trim().slice(0, 80)}`

/**
 * The redirect file's rule, for its whole text: every line that is not empty is exactly a SOURCE (a
 * path of this site: one leading slash, no scheme, no host), a TARGET (a path of this site, or an
 * https address that is not on this computer) and a STATUS (three digits, with `!` or without).
 * Answers the first line that is not, or null. Used on the text in memory before anything is written
 * (ENTRY FIRST) and on the file after the build.
 */
export function redirectsRefusal(text: string): string | null {
  const sitePath = (word: string): boolean => /^\/(?!\/)[^\s\\]*$/.test(word)
  for (const line of text.split(/\r?\n/)) {
    const words = line.trim().split(/\s+/)
    if (words[0] === '') continue // an empty line
    const fine = words.length === 3 && sitePath(words[0])
      && (sitePath(words[1]) || (words[1].toLowerCase().startsWith('https://') && addressKind(words[1]) === 'elsewhere'))
      && /^\d{3}!?$/.test(words[2])
    if (!fine) return line.trim()
  }
  return null
}

/**
 * PUBLISHED OUTPUT (after the build), for one file THIS publish built: the first position the app wrote that
 * holds an address it must not, as "<position>: <address>", or null. A page (`.html`): every
 * `startWorkPage(window, {json});` line (its Worker address must be http(s) elsewhere; its handout
 * link, when it has a scheme, elsewhere), and the configuration lines that carry the compiler's
 * mark, for each kind only when the page holds exactly one (two marked lines of a kind means the
 * author copied the mark: the author's, not read). The address in such a marked line must be an
 * http(s) address elsewhere, or empty. `_redirects`:
 * every word of every line that is not a path of the site or a status number. Nothing else.
 */
export function appWrittenLoopback(file: string, text: string): string | null {
  const name = file.split(/[\\/]/).pop() ?? file
  if (name === '_redirects') {
    const bad = redirectsRefusal(text)
    return bad ? shown('a redirect', bad) : null
  }
  if (!/\.html?$/i.test(name)) return null
  // A Run's pre-work or post-work page (work-files ticket 16, compiler/scripts/lib/work-page.mjs): the one
  // line that starts it holds the Worker's address and the handout's link, both written by the app.
  // Every such line is checked, and the first refusal is returned.
  const starts = [...text.matchAll(/^startWorkPage\(window, (.*)\);[ \t]*\r?$/gm)]
  for (const start of starts) {
    let config: Record<string, unknown> | null = null
    try { config = JSON.parse(start[1]) as Record<string, unknown> } catch { config = null }
    if (!config || typeof config !== 'object') return shown('the work page\'s settings', start[1])
    const worker = config.workerBaseUrl
    if (typeof worker !== 'string' || addressKind(worker) !== 'elsewhere' || !/^https?:/i.test(worker.trim())) return shown('the work page\'s live address', worker)
    const handout = config.handoutUrl
    if (typeof handout === 'string' && /^[a-z][a-z0-9+.-]*:/i.test(handout.trim()) && addressKind(handout) !== 'elsewhere') return shown('the work page\'s handout link', handout)
  }
  for (const config of Object.keys(CONFIG_ADDRESS) as ConfigName[]) {
    const [field, position] = CONFIG_ADDRESS[config]
    const lines = configLines(text, config, true)
    if (lines.length !== 1) continue
    const value = lines[0]?.[field]
    if (value === undefined || value === null || value === '') continue
    if (typeof value !== 'string' || addressKind(value) !== 'elsewhere' || !/^https?:/i.test(value.trim())) return shown(position, value)
  }
  return null
}

/**
 * For a page that was ALREADY in the site folder (an earlier publish, perhaps by an earlier
 * version, whose pages carry no mark): does the live address it was built with point at this
 * computer? Read from the marked line when there is exactly one, else from the last `LIVE_CONFIG`
 * line. Used to count, never to refuse.
 */
export function earlierPageLoopback(file: string, text: string): boolean {
  if (!/\.html?$/i.test(file)) return false
  const marked = configLines(text, 'LIVE_CONFIG', true)
  const lines = marked.length === 1 ? marked : marked.length > 1 ? [] : configLines(text, 'LIVE_CONFIG', false)
  return addressKind(lines[lines.length - 1]?.workerBaseUrl) === 'this-computer'
}

/** Every page and redirect file under `dir`, as a path relative to it with forward slashes. */
function pagesUnder(dir: string): string[] {
  const pages: string[] = []
  if (!existsSync(dir)) return pages
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) { walk(path); continue }
      if (entry.isFile() && (entry.name === '_redirects' || /\.html?$/i.test(entry.name))) pages.push(relative(dir, path).split('\\').join('/'))
    }
  }
  walk(dir)
  return pages.sort()
}

// ── Folders of the site ─────────────────────────────────────────────────────────────────────────

/**
 * The handouts the site folder holds: the names of its REAL immediate children (read from its own
 * listing) that are folders, not links, with a home page in them. A name comes out only if
 * `siteFolder` takes it. Used for the redirect file's list and to find a Run's folder again.
 */
export function publishedFolders(siteDir: string): string[] {
  if (!existsSync(siteDir)) return []
  return readdirSync(siteDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
    .filter((name) => { const folder = siteFolder(siteDir, name); return folder !== null && existsSync(join(folder, 'index.html')) })
    .sort()
}

/**
 * The folder a handout is BUILT in: `siteFolder`'s path for `name`, and only when what is there now
 * is nothing or a real folder. A link at that name (which could lead out of the site folder) or a
 * file is not built into: null, and the publish is refused before anything is written.
 */
export function writableSiteFolder(siteDir: string, name: unknown): string | null {
  const folder = siteFolder(siteDir, name)
  if (folder === null) return null
  let stat
  try { stat = lstatSync(folder) } catch { return folder } // nothing there yet
  return stat.isDirectory() && !stat.isSymbolicLink() ? folder : null
}

/**
 * Take one handout's folder out of the site folder (Unpublish). The folder is chosen by MEMBERSHIP:
 * `name` must be one of the names in the site folder's own listing, and `siteFolder` must take it;
 * a path is never made from the name first and then looked for. What is there is looked at without
 * following it (`lstat`): a real folder is removed with what it holds; a LINK (to a folder or a
 * file, inside the site or outside it) is unlinked, and what it points at is not touched (`rmSync`
 * with `recursive` also removes only the link, but that is not relied on); anything else is left.
 */
export function removeSiteFolder(siteDir: string, name: unknown): 'removed' | 'unlinked' | 'absent' {
  if (typeof name !== 'string' || !existsSync(siteDir) || !readdirSync(siteDir).includes(name)) return 'absent'
  const folder = siteFolder(siteDir, name)
  if (folder === null) return 'absent'
  const stat = lstatSync(folder)
  if (stat.isSymbolicLink()) { unlinkSync(folder); return 'unlinked' }
  if (!stat.isDirectory()) return 'absent'
  rmSync(folder, { recursive: true, force: true })
  return 'removed'
}

// ── The sequence ────────────────────────────────────────────────────────────────────────────────

/** The live service as a publish found it. `reason`: a sorted sentence when a set-up was tried and failed; null when there simply is none. */
export type LiveOutcome =
  | { ready: true; address: string }
  | { ready: false; reason: string | null; details: string | null }

export type PublishFailure = {
  ok: false
  /** A fixed sentence. */
  error: string
  /** What lies behind it (fixed words, statuses and Cloudflare's error numbers, cleaned): for "Details" only. */
  details?: string
  /** Publishing could not start: what is missing, for the sheet. */
  notReady?: PublishNotReady
  /** The connection changed before or during the upload: nothing was recorded. */
  superseded?: true
  /** The job's own answer for a failure of its first step (`begin`), untouched. */
  reply?: unknown
}

export type PublishSuccess<Built> = {
  ok: true
  built: Built
  /** Null for an entry point that writes no page. */
  live: LiveOutcome | null
  /** "Published. Going live is not set up: Settings → Cloudflare" (and the reason), or null. */
  notice: string | null
  /** What lies behind `notice`, for "Details". */
  noticeDetails: string | null
  /** How many handouts an earlier version left with an address on this computer (one fixed sentence), or null. */
  earlierNotice: string | null
  /** Their names, one to a line: for "Details". */
  earlierDetails: string | null
}

/** What a job is handed to build with. */
export type PublishBuild = {
  /**
   * The site as this publish sees it: a private folder made for this attempt alone, laid out from the LIVE manifest (every file
   * of the site there, as an empty stand-in; the redirect file as the site record makes it). The job writes its pages here and
   * reads the site's folders here, as it always has. Only what the job writes or removes is sent.
   */
  dir: string
  /**
   * ENTRY FIRST: the whole text of the redirect file, built in memory, goes through here BEFORE the
   * job writes anything. Gives the text back, or stops the publish (PUBLISH_REDIRECTS_REFUSED).
   */
  redirects(text: string): string
  project: string
  /** The live address pages may carry, or '' for none: nothing else may be put in a page as the live service. */
  live: string
  /**
   * ENTRY FIRST: every link the app is about to write into a page goes through here BEFORE the job
   * writes anything. Gives the link back, or stops the publish (PUBLISH_LINK_REFUSED) when it is on
   * this computer or is not an absolute http(s) address.
   */
  link(url: string): string
  /**
   * The folder a job is about to write a handout into: `path` must be a direct child of `dir`. The folder is this publish's: what
   * the live site holds there is replaced whole by what the job writes (spec: the merge removes the talk's prefix and adds what
   * was built). Asked twice for the same folder, it gives the same folder back untouched.
   */
  makeFolder(path: string): string
  /** Write a top-level file of the site (the redirect file). True when it was not there before. `path` must be a direct child of `dir`. */
  writeSiteFile(path: string, text: string): boolean
  /** For a top-level file that something else is about to write (the shared 404 page): create it empty when it is not there (true). */
  claimFile(path: string): boolean
  /**
   * The short links this computer itself gave (its registry before it first followed the site's record): the only registry that
   * may bind a Run published before its folder was recorded to a folder it replaces or removes. Null when there is none.
   */
  trustedRegistry: Readonly<Record<string, string>> | null
  /** This computer's record of its own short links could not be read or kept (so `trustedRegistry` is null for that reason). */
  ownShortLinksUnreadable?: boolean
}

/**
 * `fail`: the job's own failure, a fixed sentence; `details` (already cleaned by the job) is shown only
 * under "Details"; `reply` is handed back untouched as `PublishFailure.reply` (the handler's own answer for it).
 */
export type PublishBegin<Built> = { done: Built } | { fail: { error: string; details?: string; reply?: unknown } } | null

export interface PublishJob<Built> {
  entry: PublishEntry
  /** Source identity/revision read at the job turn and rechecked before upload. */
  revision?(): string
  /** The site folders (`/<name>`) this job changes in place without `makeFolder` (an unpublish). */
  removalRoots?(built: Built): string[]
  /**
   * Runs first, when the job's turn begins and before leave is asked. `{ done }` ends the job there
   * as a success with nothing built or uploaded (an unpublish of something that is not published);
   * `{ fail }` ends it as the publish's own failure (the talk could not be saved). What a job must
   * read as it stands at its turn, it reads here or in `prepare`. It has BEGIN_LIMIT_MS.
   */
  begin?(): PublishBegin<Built> | Promise<PublishBegin<Built>>
  /**
   * Build this entry's pages in the site as this publish sees it (`build.dir`). Called only with leave to publish, at the job's
   * turn. Every link it writes goes through `build.link` FIRST, before it writes anything. A returned failure is the publish's
   * own (a fixed sentence).
   */
  prepare(build: PublishBuild): Promise<{ ok: true; built: Built } | { ok: false; error: string; details?: string }>
  /**
   * Keep the result on this computer (the Run's link). Called once the deployment is up,
   * whatever has happened to the connection since. Local and quick: it runs inside the queue.
   */
  record?(built: Built): void | Promise<void>
}

export interface PublishingPorts {
  /** The production deployment: its id, every path and its hash (publishing-inventory.ts). */
  inventory?(authorisation: PublishAuthorisation): Promise<PreservationInventory | null>
  preservationRoot?: string
  /** Where an attempt lays out the site as it sees it (a folder only this app writes). Default: the system temporary folder. */
  stagingRoot?(): string
  /**
   * This computer's copy of what it published: kept up to date after each publish that went up (the pages this publish sent,
   * what it removed, the redirect file) for what reads it here (the published pages list, the gallery). Never needed to publish.
   */
  siteDir(): string
  authorise(): Promise<PublishGrant>
  /**
   * The live service's address, and the account it was deployed for when that is recorded. A throw
   * (a LiveServiceError, or anything else) means there is none to use.
   */
  live(): Promise<{ baseUrl: string; accountId?: string | null }>
  /** A message when the change about to be sent would make the site run code; else null. */
  bundlingHazard(siteDir: string): string | null
  /** How Cloudflare's API is reached for the direct upload (no publishing tool runs). */
  pages(): PagesTransport
  /** wrangler's own blake3 module, for the Pages hash. */
  blake3(): Blake3
  /** This computer's short-link registry: a cache of the site record, and what a site with no record starts from. */
  registry?: {
    /** The registry on this computer; null when it is missing or cannot be read (never taken as an empty one). */
    read(): Record<string, string> | null
    write(registry: Record<string, string>): void
    /**
     * This computer's own registry as it was before it first followed a site's record, recorded once and durably (registry-
     * origin.ts): what alone may bind a Run published before its folder was recorded. Throws RegistryOriginUnavailable when
     * that record cannot be written or read. Without this port nothing is trusted.
     */
    origin?(): RegistryOrigin
  }
  /** This computer's link style (`publishing.shortLinks`): the same. */
  shortLinks?: { read(): boolean; write(value: boolean): void }
  /** The text of `_headers` for a site with no record yet (this computer's copy of it), or ''. */
  headers?(): string
  /** This computer's name, kept in the site record. */
  computerName?(): string
  /** One line for the app's log (a short link of this computer's that the site's record overrides). Never a token. */
  log?(line: string): void
  /**
   * The app's own test mode (TW_REC_TEST=1): pages are built and checked, and nothing is
   * authorised or uploaded. Null otherwise.
   */
  rehearsal?(): { project: string } | null
  liveLimitMs?: number
}

export interface HandoutPublishing {
  publish<Built>(job: PublishJob<Built>): Promise<PublishSuccess<Built> | PublishFailure>
  /** Everything asked for so far has finished (tests). */
  idle(): Promise<void>
}

export const SITE_RECORD_UNREADABLE = 'Publishing stopped: the site\'s own record of its short links (/_talkweaver/site.json) could not be read, so nothing was uploaded. Check the connection and publish again.'
export const SITE_RECORD_NEWER = 'Publishing stopped: the site was last published by a newer version of TalkWeaver. Update TalkWeaver on this computer and publish again. Nothing was uploaded.'
export const REGISTRY_ORIGIN_UNWRITABLE = 'Publishing stopped: this Mac could not write down the short links it gave itself, which it must do before it follows the site\'s. Check that TalkWeaver\'s data folder can be written, and publish again. Nothing was uploaded.'
export const REGISTRY_ORIGIN_UNAVAILABLE = 'Stopped: this Run was published by an older version, before its folder was recorded, and this Mac\'s record of the short links it gave itself cannot be read, so this one Run cannot be changed from this Mac. Republish or unpublish it from the Mac that originally published it. Nothing was withdrawn, written or removed.'
export const SITE_BOOTSTRAP_CHANGED = 'Publishing stopped: the site has no shared record of its short links yet, and the short-link list or headers on this computer are no longer the ones it last published, so publishing from here could change the site\'s short links. Nothing was uploaded.'
export const SITE_BOOTSTRAP_REFUSED = 'Publishing stopped: the site has no shared record of its short links yet, and what is live now was not published from this computer, so publishing from here could change its short links. Publish once from the computer that published last; after that any computer can publish. Nothing was uploaded.'

const SUPERSEDED: PublishFailure = { ok: false, error: PUBLISH_SUPERSEDED_ERROR, superseded: true }
/** Clocks of this computer and Cloudflare may differ by this much: the search reads back that far before the request. */
const CLOCK_SKEW_MS = 10 * 60_000
/** Cloudflare's "unknown error": never a proven refusal. */
const CLOUDFLARE_UNKNOWN_ERROR = 8000000

class TimeLimit extends Error {}
/** A link the app was about to write into a page, refused (PUBLISHED OUTPUT (a)). */
class LinkRefused extends Error {}
/** The redirect text the app was about to write, refused (its message: the line). */
class RedirectsRefused extends Error {}
/** A fixed sentence that stops this publish before anything is sent. */
class Stop extends Error { readonly failure: PublishFailure; constructor(failure: PublishFailure) { super(failure.error); this.failure = failure } }

/** `work`, or a rejection (a TimeLimit) after `ms`. The work itself is not stopped: its own limit does that. */
function limited<Result>(work: Promise<Result>, ms: number): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeLimit('time limit')), ms)
    work.then((value) => { clearTimeout(timer); resolve(value) }, (error) => { clearTimeout(timer); reject(error) })
  })
}

/** Names wrangler never sends (validate: `**\/.DS_Store`, `**\/node_modules`, `**\/.git`, `.wrangler`). */
const IGNORED = (name: string, top: boolean): boolean => name === '.DS_Store' || name === 'node_modules' || name === '.git' || (top && name === '.wrangler')
/** The site-level files: sent beside the manifest, never as assets. */
const SITE_FILES = new Set(['/_redirects', '/_headers'])
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
const segmentsOf = (path: string): string[] => path.slice(1).split('/')

/** The site as a publish found it: the production deployment's id, its manifest and its record. */
interface LiveSite {
  revision: string
  deploymentUrl?: string
  /** Path (as Cloudflare keeps it) → asset hash. */
  manifest: Map<string, string>
  record: SiteRecord
  /** The site had a record: false when this publish makes the first one (bootstrap). */
  hadRecord: boolean
}

/** An empty stand-in for a live file, and how it was made: if it is still exactly that after the build, the live hash is kept. */
type Placeholder = { dev: number; ino: number; mtimeMs: number; ctimeMs: number }
/** A file the build wrote, to be sent. */
type Written = { path: string; full: string; size: number; hash: string }

export function createHandoutPublishing(ports: PublishingPorts): HandoutPublishing {
  const queue = createKeyedQueue()
  let tail: Promise<unknown> = Promise.resolve()

  /** LIVE NEVER FAILS A PUBLISH: whatever happens here, the answer is an address or its absence. */
  async function liveForPages(authorisation: PublishAuthorisation, rehearsal: boolean): Promise<LiveOutcome> {
    try {
      const live = await limited(Promise.resolve().then(() => ports.live()), ports.liveLimitMs ?? LIVE_STEP_LIMIT_MS)
      // PUBLISHED OUTPUT (a): an address on this computer (the test-only local service), or one that is no web address, is never published.
      const address = liveAddressForPages(live?.baseUrl)
      if (!address) return { ready: false, reason: null, details: null }
      // Deployed for another account than the one publishing: not this connection's live service.
      if (!rehearsal && live.accountId && live.accountId !== authorisation.accountId) return { ready: false, reason: LIVE_OTHER_ACCOUNT, details: null }
      return { ready: true, address }
    } catch (error) {
      if (error instanceof LiveServiceError) {
        return { ready: false, reason: error.kind === 'failed' ? error.message : null, details: error.details ? authorisation.clean(error.details).slice(-DETAILS_CHARS) : null }
      }
      if (error instanceof TimeLimit) return { ready: false, reason: LIVE_TIMED_OUT, details: null }
      // Not a sorted failure: its text is never the message (NO RAW TEXT), only Details.
      const text = authorisation.clean(error instanceof Error ? error.message : String(error)).trim()
      return { ready: false, reason: LIVE_SETUP_FAILED, details: text ? text.slice(-DETAILS_CHARS) : null }
    }
  }

  /** Every page and redirect file of the site, with its size and time of change: to tell which ones a build wrote. */
  function stamps(dir: string): Map<string, string> {
    return new Map(pagesUnder(dir).map((file) => { const stat = statSync(join(dir, file)); return [file, `${stat.size}:${stat.mtimeMs}:${stat.ino}`] }))
  }

  /**
   * AFTER THE BUILD: the pages this build wrote (new, or changed since it began), read once more. If one fails, this publish
   * sends nothing. Pages it did not write (the empty stand-ins of the live site) are not read.
   */
  function checkBuilt(dir: string, before: Map<string, string>): PublishFailure | null {
    const written = [...stamps(dir)].filter(([file, stamp]) => before.get(file) !== stamp).map(([file]) => ({ file, path: join(dir, file) }))
    const finds = written.flatMap(({ file, path }) => {
      const found = appWrittenLoopback(file, readFileSync(path, 'latin1'))
      return found ? [`${file}: ${found}`] : []
    })
    return finds.length ? { ok: false, error: PUBLISH_LOOPBACK_REFUSED, details: finds.slice(0, 20).join('\n') } : null
  }

  /** This computer's registry and link style, and the `_headers` it has: what a site with no record starts from. */
  function localDefaults(): SiteRecord {
    const registry = ports.registry?.read() ?? {}
    return { registry: { ...registry }, shortLinks: ports.shortLinks?.read() ?? false, headers: ports.headers?.() ?? '' }
  }
  /** `publicationBinding([[name, sha256(text)]])`: how the publication record names a site-level file it sent (empty: not sent). */
  const controlDigest = (name: string, text: string): string | undefined => (text ? publicationBinding([[name, sha256(text)]]) : undefined)

  /**
   * Step 1, and the site record: the production deployment as the preservation check read it, and `/_talkweaver/site.json` read
   * through the deployment's own address (its bytes taken only when their hash is the manifest's). No record: the bootstrap rule.
   */
  async function readLiveSite(inventory: PreservationInventory, blake3: Blake3): Promise<LiveSite> {
    const files = inventory.files ?? (inventory.paths.length === 0 ? [] : null)
    if (!files) throw new PreservationRefusal('PUBLISH_INVENTORY_UNAVAILABLE')
    const manifest = new Map(files)
    const revision = inventory.revision
    const recordHash = manifest.get(SITE_RECORD_PATH)
    if (recordHash) {
      const transport = ports.pages()
      const bytes = await readLiveAsset(transport, blake3, siteAssetAddresses(transport, { id: revision, url: inventory.deploymentUrl }, SITE_RECORD_PATH), SITE_RECORD_PATH, recordHash)
      if (!bytes) throw new Stop({ ok: false, error: SITE_RECORD_UNREADABLE })
      const parsed = parseSiteRecord(bytes)
      if (!parsed.ok) throw new Stop({ ok: false, error: parsed.reason === 'newer' ? SITE_RECORD_NEWER : SITE_RECORD_UNREADABLE })
      return { revision, deploymentUrl: inventory.deploymentUrl, manifest, record: parsed.record, hadRecord: true }
    }
    // BOOTSTRAP: the first record is made from this computer's registry, link style and `_headers`, and only when this computer
    // made what is live now: its own publication record (written by the preservation guard when its publish was accepted) is for
    // this site's live production deployment, by its id or by the candidate digest that deployment carries. A site with nothing
    // deployed has nothing to lose. (A live site with no record holds no name of the computer that published it last.)
    const mine = readPublicationRecord(inventory.site, ports.preservationRoot)
    const liveIsMine = mine !== null && (mine.revision === revision || (mine.candidateDigest !== undefined && mine.candidateDigest === inventory.candidateDigest))
    if (manifest.size === 0) return { revision, deploymentUrl: inventory.deploymentUrl, manifest, record: localDefaults(), hadRecord: false }
    if (!liveIsMine) {
      throw new Stop({ ok: false, error: SITE_BOOTSTRAP_REFUSED, details: mine ? `This computer last published the site at deployment ${mine.revision}; the site is now at ${revision}.` : 'This computer has no record of publishing this site.' })
    }
    // And what it would send now must be what went live then: the redirect file made from today's registry, and today's
    // `_headers`, each the very digest the publication record keeps. A registry that is missing or unreadable proves nothing.
    const registry = ports.registry ? ports.registry.read() : null
    if (registry === null) throw new Stop({ ok: false, error: SITE_BOOTSTRAP_CHANGED, details: 'This computer\'s short-link list is missing or cannot be read.' })
    const headers = ports.headers?.() ?? ''
    const changed = [['/_redirects', buildRedirects(registry, manifestFolders(manifest.keys()))], ['/_headers', headers]]
      .filter(([name, text]) => controlDigest(name, text) !== mine.controls[name]).map(([name]) => name)
    if (changed.length) throw new Stop({ ok: false, error: SITE_BOOTSTRAP_CHANGED, details: `Not as this computer last published them: ${changed.join(', ')}.` })
    return { revision, deploymentUrl: inventory.deploymentUrl, manifest, record: { registry: { ...registry }, shortLinks: ports.shortLinks?.read() ?? false, headers }, hadRecord: false }
  }

  /** The test mode's site: this computer's copy, as it is (nothing is asked of Cloudflare). */
  function rehearsalSite(dir: string): LiveSite {
    const paths = existsSync(dir) ? publicationPaths(dir).filter((path) => !SITE_FILES.has(path)) : []
    return { revision: 'rehearsal', manifest: new Map(paths.map((path) => [path, ''])), record: localDefaults(), hadRecord: true }
  }

  /** The live site laid out in `shadow`: an empty file for every live path, recorded so that an untouched one keeps its live hash. */
  function layOut(shadow: string, site: LiveSite): Map<string, Placeholder> {
    const placeholders = new Map<string, Placeholder>()
    for (const path of site.manifest.keys()) {
      if (path === SITE_RECORD_PATH) continue
      const full = join(shadow, ...segmentsOf(path))
      try {
        mkdirSync(dirname(full), { recursive: true })
        writeFileSync(full, '', { flag: 'wx' })
      } catch {
        // Two live names this computer keeps as one (`A` and `a` on a disk that does not tell them apart), or a name it cannot keep.
        throw new PreservationRefusal('PUBLISH_INVENTORY_UNAVAILABLE', path)
      }
      const stat = lstatSync(full)
      placeholders.set(path, { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs })
    }
    const redirects = buildRedirects(site.record.registry, manifestFolders(site.manifest.keys()))
    if (redirects) writeFileSync(join(shadow, '_redirects'), redirects)
    if (site.record.headers) writeFileSync(join(shadow, '_headers'), site.record.headers)
    return placeholders
  }

  /** Every file of `shadow` as `[path, full path, stat]`; anything but files and folders stops the publish. */
  function filesIn(shadow: string): Array<[string, string, Stats]> {
    const found: Array<[string, string, Stats]> = []
    const walk = (folder: string, prefix: string): void => {
      for (const name of readdirSync(folder).sort()) {
        if (IGNORED(name, prefix === '')) continue
        const full = join(folder, name)
        const stat = lstatSync(full)
        const path = `${prefix}/${name}`
        if (stat.isDirectory()) walk(full, path)
        else if (stat.isFile()) found.push([path, full, stat])
        else throw new PreservationRefusal('PUBLISH_CANDIDATE_CHANGED')
      }
    }
    walk(shadow, '')
    return found
  }

  /**
   * After a deployment went up (or a rehearsal built its pages): this computer's copy of the site takes the same change, for what
   * reads it here. It never writes, removes or follows through a link or anything but a real folder: such an entry (another
   * writer's) is left as it is and the rest goes on. Never a reason for the publish to fail: it went up.
   */
  function mirror(dir: string, change: { folders: readonly string[]; written: readonly Written[]; removed: readonly string[]; redirects: string }): void {
    const kind = (full: string): 'none' | 'folder' | 'file' | 'other' => {
      try { const stat = lstatSync(full); return stat.isSymbolicLink() ? 'other' : stat.isDirectory() ? 'folder' : stat.isFile() ? 'file' : 'other' } catch { return 'none' }
    }
    /** Every folder on the way to `segments` that is there is a real folder (missing ones are made fresh). */
    const realWay = (segments: readonly string[]): boolean => {
      let at = dir
      for (const segment of segments.slice(0, -1)) {
        at = join(at, segment)
        const found = kind(at)
        if (found === 'none') return true
        if (found !== 'folder') return false
      }
      return true
    }
    let skipped = 0
    try {
      mkdirSync(dir, { recursive: true })
      for (const folder of change.folders) {
        const found = kind(join(dir, folder))
        if (found === 'folder') removeSiteFolder(dir, folder)
        else if (found !== 'none') skipped++
      }
      for (const path of change.removed) {
        const segments = segmentsOf(path)
        const full = join(dir, ...segments)
        if (!realWay(segments) || kind(full) !== 'file') continue
        unlinkSync(full)
        for (let parent = dirname(full); parent !== resolve(dir) && parent.startsWith(resolve(dir)); parent = dirname(parent)) {
          try { rmdirSync(parent) } catch { break }
        }
      }
      for (const file of change.written) {
        if (file.path === SITE_RECORD_PATH) continue
        const segments = segmentsOf(file.path)
        const target = join(dir, ...segments)
        if (!realWay(segments) || !['none', 'file'].includes(kind(target))) { skipped++; continue }
        mkdirSync(dirname(target), { recursive: true })
        if (!realWay(segments)) { skipped++; continue }
        copyFileSync(file.full, target)
      }
      const redirects = join(dir, '_redirects')
      const found = kind(redirects)
      if (found === 'file' || (found === 'none' && change.redirects)) writeFileSync(redirects, change.redirects)
      else if (found !== 'none') skipped++
    } catch (error) {
      ports.log?.(`[publish] this computer's copy of the site could not be brought up to date: ${error instanceof Error ? error.name : 'error'}`)
    }
    if (skipped) ports.log?.(`[publish] this computer's copy of the site: ${skipped} entr${skipped === 1 ? 'y was' : 'ies were'} left alone (a link or not a plain file or folder)`)
  }

  /**
   * Steps 4 to 8, THE one place anything is sent: the bytes Cloudflare lacks, the revision checked again, the deployment, its
   * confirmation. The token reaches Cloudflare only inside `authorisation.run`. The connection is asked again between uploads
   * and immediately before the one deployment request (superseded: nothing further is sent), and the production revision is read
   * again immediately before it. The request is never repeated: one that may have made a deployment is an unknown outcome, which
   * the next publish reconciles (`reconcile`) before it sends anything. `outcome`: whether a deployment may exist.
   */
  async function send(authorisation: PublishAuthorisation, change: { revision: string; manifest: Record<string, string>; staged: StagedAsset[]; redirects: string; headers: string; candidateDigest: string }, context: PublicationLaunch): Promise<{ outcome: 'accepted' | 'failed' | 'unknown'; value: { ok: true } | PublishFailure }> {
    const sorted = (error: unknown): PublishFailure => {
      const kind = error instanceof PagesApiError ? error.kind : 'failed'
      if (kind === 'permission') authorisation.refusedForPermission()
      const details = authorisation.clean(error instanceof PagesApiError ? error.message : 'Cloudflare: the request could not be made').slice(-DETAILS_CHARS)
      return { ok: false, error: PUBLISH_FAILURE_TEXT[kind], details }
    }
    type Step = { kind: 'superseded' } | { kind: 'upload-failed'; error: unknown } | { kind: 'revision-changed' } | { kind: 'deploy-failed'; error: unknown } | { kind: 'sent'; confirmed: boolean }
    /** Set the moment the deployment request is about to go: from then on a deployment may exist. */
    let posted = false
    let launched: { superseded: true } | { superseded: false; result: Step }
    try {
      launched = await authorisation.run(async (credentials): Promise<Step> => {
        const api = pagesSiteApi(ports.pages(), { token: credentials.CLOUDFLARE_API_TOKEN, accountId: authorisation.accountId, project: authorisation.project })
        try {
          await api.uploadAssets(change.staged, Object.values(change.manifest), () => authorisation.current())
          if (!authorisation.current()) return { kind: 'superseded' }
          // Step 6, immediately before the deployment is created.
          const now = (await api.productionId()) ?? NO_PRODUCTION_REVISION
          if (now !== change.revision) return { kind: 'revision-changed' }
        } catch (error) {
          return error instanceof UploadSuperseded ? { kind: 'superseded' } : { kind: 'upload-failed', error }
        }
        if (!authorisation.current()) return { kind: 'superseded' }
        context.posting?.() // its time is journalled before it can make anything (the settlement window below)
        posted = true
        let id: string
        try {
          id = (await api.createDeployment({ manifest: change.manifest, branch: authorisation.productionBranch, commitMessage: `tw-candidate:${change.candidateDigest}`, redirects: change.redirects, headers: change.headers })).id
        } catch (error) { return { kind: 'deploy-failed', error } }
        context.deployed?.(id)
        return { kind: 'sent', confirmed: await api.confirm(id, change.manifest) }
      })
    } catch (error) {
      // The launch itself threw: nothing of it is shown but Details.
      const failure: PublishFailure = { ok: false, error: PUBLISH_FAILED, details: authorisation.clean(error instanceof Error ? error.name : 'error') }
      return { outcome: posted ? 'unknown' : 'failed', value: failure }
    }
    if (launched.superseded) return { outcome: posted ? 'unknown' : 'failed', value: { ...SUPERSEDED } }
    const step = launched.result
    if (step.kind === 'superseded') return { outcome: 'failed', value: { ...SUPERSEDED } }
    if (step.kind === 'upload-failed') return { outcome: 'failed', value: sorted(step.error) }
    if (step.kind === 'revision-changed') return { outcome: 'failed', value: { ok: false, error: 'PUBLISH_REVISION_CHANGED' } }
    if (step.kind === 'deploy-failed') {
      // Only a refusal Cloudflare stated, and not its "unknown error" (wrangler retries that one: it may have made a deployment).
      const definite = step.error instanceof PagesApiError && step.error.definite && !step.error.codes.includes(CLOUDFLARE_UNKNOWN_ERROR)
      return { outcome: definite ? 'failed' : 'unknown', value: sorted(step.error) }
    }
    if (!step.confirmed) return { outcome: 'unknown', value: { ok: false, error: 'PUBLISH_OUTCOME_UNKNOWN' } }
    return { outcome: 'accepted', value: { ok: true } }
  }

  /**
   * What became of an earlier attempt whose outcome is unknown (the preservation guard asks before anything else is sent): its
   * deployment by id, or by its candidate digest searched page by page back to just before its request was sent. Found: its own
   * state decides. Not found proves nothing was made ONLY when the journal proves the request was never sent (`sent: false`);
   * otherwise, however long ago, it stays unknown until the deployment shows up and settles, or the manual recovery in the spec
   * clears the journal. Cloudflare gives no bound on when a request it received can still become a deployment.
   */
  async function reconcile(authorisation: PublishAuthorisation, attempt: { candidateDigest: string; deploymentId?: string; postedAt?: number; sent: boolean }): Promise<{ state: 'deployed'; id: string } | { state: 'not-deployed' | 'pending' | 'unknown' }> {
    try {
      const read = await authorisation.run((credentials) => pagesSiteApi(ports.pages(), { token: credentials.CLOUDFLARE_API_TOKEN, accountId: authorisation.accountId, project: authorisation.project })
        .findDeployment({ ...(attempt.deploymentId ? { id: attempt.deploymentId } : {}), candidateDigest: attempt.candidateDigest,
          ...(attempt.postedAt !== undefined ? { notBefore: attempt.postedAt - CLOCK_SKEW_MS } : {}) }))
      if (read.superseded) return { state: 'unknown' }
      const found = read.result
      if (found.state === 'failure') return { state: 'not-deployed' }
      if (found.state === 'pending') return { state: 'pending' }
      if (found.state === 'success') return { state: 'deployed', id: found.id }
      return attempt.sent ? { state: 'unknown' } : { state: 'not-deployed' }
    } catch {
      return { state: 'unknown' }
    }
  }

  async function run<Built>(job: PublishJob<Built>): Promise<PublishSuccess<Built> | PublishFailure> {
    const nothing = { live: null, notice: null, noticeDetails: null, earlierNotice: null, earlierDetails: null }
    let begun: PublishBegin<Built> = null
    if (job.begin) {
      try {
        begun = await limited(Promise.resolve().then(() => job.begin?.() ?? null), BEGIN_LIMIT_MS)
      } catch (error) {
        if (error instanceof TimeLimit) return { ok: false, error: PUBLISH_BEGIN_TIMED_OUT }
        throw error
      }
    }
    if (begun && 'fail' in begun) {
      return { ok: false, error: begun.fail.error, ...(begun.fail.details ? { details: begun.fail.details } : {}), ...(begun.fail.reply !== undefined ? { reply: begun.fail.reply } : {}) }
    }
    if (begun) return { ok: true, built: begun.done, ...nothing }
    const rehearsal = ports.rehearsal?.() ?? null
    let authorisation: PublishAuthorisation
    if (rehearsal) {
      authorisation = {
        accountId: 'rehearsal', project: rehearsal.project, productionBranch: 'main', current: () => true,
        run: async (launch) => ({ superseded: false, result: await launch({ CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '' }) }),
        clean: (text) => String(text), refusedForPermission: () => {}, published: () => {},
      }
    } else {
      // ONE CONNECTION: nothing is built, and the live service is not touched, without leave to publish.
      const granted = await ports.authorise()
      if (!granted.ok) return { ok: false, error: granted.error, ...(granted.notReady ? { notReady: granted.notReady } : {}), ...(granted.superseded ? { superseded: true as const } : {}) }
      authorisation = granted.authorisation
    }
    const live = PUBLISH_ENTRY_POINTS[job.entry].live ? await liveForPages(authorisation, rehearsal !== null) : null
    if (!authorisation.current()) return SUPERSEDED
    const dir = ports.siteDir()
    let attempt: PreservationAttempt | null = null
    try {
      if (!rehearsal) {
        const site = `cf-pages:${authorisation.accountId}:${authorisation.project}`
        const revision = job.revision?.() ?? 'per-talk-merge'
        const binding = () => publicationBinding([site, authorisation.productionBranch, authorisation.current(), job.revision?.() ?? revision])
        attempt = await beginPublication({ site, inventory: () => ports.inventory?.(authorisation) ?? Promise.resolve(null),
          binding, approvedBinding: binding(), candidateDigest: null, storageRoot: ports.preservationRoot,
          reconcile: (earlier) => reconcile(authorisation, earlier) })
      }
    } catch (error) {
      attempt?.close()
      return { ok: false, error: error instanceof PreservationRefusal ? error.reason : 'PUBLISH_CANDIDATE_CHANGED', ...(error instanceof PreservationRefusal ? { details: error.message } : {}) }
    }
    const stagingRoot = ports.stagingRoot?.() ?? tmpdir()
    let shadow: string | null = null
    try {
      // ── The site as it is ──────────────────────────────────────────────────────────────────────────────────────────────
      const blake3 = rehearsal ? null : ports.blake3()
      let site: LiveSite
      try {
        site = attempt && blake3 ? await readLiveSite(attempt.live, blake3) : rehearsalSite(dir)
      } catch (error) {
        if (error instanceof Stop) return error.failure
        if (error instanceof PreservationRefusal) return { ok: false, error: error.reason, details: error.message }
        throw error
      }
      // The short links this computer itself gave, recorded before it first follows a site's record (see PublishBuild). When that
      // record cannot be read or kept, nothing is trusted: only what needs it (a Run published before its folder was recorded)
      // is refused, everything else goes on. No record is made from what is synced below (registry-origin.ts).
      let trustedRegistry: Record<string, string> | null = null
      let ownShortLinksUnreadable = false
      try {
        const origin = ports.registry?.origin?.()
        trustedRegistry = origin?.state === 'registry' ? origin.registry : null
      } catch (error) {
        if (!(error instanceof RegistryOriginUnavailable)) throw error
        // No record, and none can be made: following the site's record now would let a later attempt record the copy as its own.
        if (error.kind === 'unwritable' && !rehearsal) return { ok: false, error: REGISTRY_ORIGIN_UNWRITABLE, details: authorisation.clean(error.message) }
        ownShortLinksUnreadable = true
        ports.log?.(`[publish] short links: ${error.message}; Runs published before their folder was recorded cannot be changed from here`)
      }
      // This computer's registry and link style become the site's (the live record wins; each difference is logged).
      if (!rehearsal) {
        if (ports.registry) {
          const local = ports.registry.read()
          if (local === null) ports.log?.('[publish] short links: this computer\'s list was missing or unreadable; the site\'s is kept')
          for (const clash of registryClashes(local ?? {}, site.record.registry)) ports.log?.(`[publish] short links: ${clash}`)
          if (local === null || JSON.stringify(Object.entries(local).sort()) !== JSON.stringify(Object.entries(site.record.registry).sort())) ports.registry.write({ ...site.record.registry })
        }
        if (ports.shortLinks && ports.shortLinks.read() !== site.record.shortLinks) ports.shortLinks.write(site.record.shortLinks)
      }
      mkdirSync(stagingRoot, { recursive: true })
      shadow = mkdtempSync(join(stagingRoot, 'tw-site-'))
      const root = shadow
      const placeholders = layOut(root, site)
      const before = stamps(root)

      // ── The build: into the site as this publish sees it ───────────────────────────────────────────────────────────────
      /** Folders the job builds with `makeFolder`: replaced whole. */
      const folders = new Set<string>()
      const directChild = (path: string): string => {
        const full = resolve(path)
        if (dirname(full) !== resolve(root)) throw new Error('A publish creates only top-level entries of the site folder.')
        return full
      }
      const present = (full: string): boolean => { try { lstatSync(full); return true } catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false; throw error } }
      const plain = (full: string, folder?: true): void => {
        let stat; try { stat = lstatSync(full) } catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return; throw error }
        if (folder ? !stat.isDirectory() : !stat.isFile()) throw new PreservationRefusal('PUBLISH_CANDIDATE_CHANGED')
      }
      const makeFolder = (path: string): string => {
        const full = directChild(path)
        const name = basename(full)
        if (folders.has(name)) return full
        if (present(full)) { plain(full, true); rmSync(full, { recursive: true, force: true }) } // the live folder's stand-ins: replaced whole
        mkdirSync(full)
        folders.add(name)
        return full
      }
      const writeSiteFile = (path: string, text: string): boolean => {
        const full = directChild(path)
        const fresh = !present(full)
        if (!fresh) plain(full)
        writeFileSync(full, text, 'utf8')
        return fresh
      }
      const claimFile = (path: string): boolean => {
        const full = directChild(path)
        if (present(full)) { plain(full); return false }
        writeFileSync(full, '', 'utf8')
        return true
      }
      let prepared: Awaited<ReturnType<PublishJob<Built>['prepare']>>
      try {
        prepared = await job.prepare({
          dir: root, project: authorisation.project, live: live?.ready ? live.address : '',
          // ENTRY FIRST: refused before the job has written anything.
          link: (url) => { if (!liveAddressForPages(url)) throw new LinkRefused(); return url },
          redirects: (text) => { const bad = redirectsRefusal(text); if (bad !== null) throw new RedirectsRefused(bad); return text },
          makeFolder, writeSiteFile, claimFile, trustedRegistry, ownShortLinksUnreadable,
        })
      } catch (error) {
        if (error instanceof LinkRefused) return { ok: false, error: PUBLISH_LINK_REFUSED }
        if (error instanceof PreservationRefusal) return { ok: false, error: error.reason, details: error.message }
        if (error instanceof RedirectsRefused) return { ok: false, error: PUBLISH_REDIRECTS_REFUSED, details: error.message.replace(/[^\x20-\x7e]/g, ' ').slice(0, 200) }
        throw error
      }
      if (!prepared.ok) return prepared
      const refused = checkBuilt(root, before)
      if (refused) return refused
      if (!authorisation.current()) return SUPERSEDED

      // ── The change: what the build wrote and removed, and nothing else ─────────────────────────────────────────────────
      const merged = new Map<string, string>()
      const written: Written[] = []
      const tooLarge: string[] = []
      for (const [raw, full, stat] of filesIn(root)) {
        if (SITE_FILES.has(raw)) continue
        const standIn = placeholders.get(raw)
        if (standIn && stat.size === 0 && stat.dev === standIn.dev && stat.ino === standIn.ino && stat.mtimeMs === standIn.mtimeMs && stat.ctimeMs === standIn.ctimeMs) {
          merged.set(raw, site.manifest.get(raw) as string)
          continue
        }
        const path = candidatePath(raw) // %, ? or #, or a name Cloudflare could not keep: refused before anything is sent
        if (path === SITE_RECORD_PATH) throw new PreservationRefusal('PUBLISH_CANDIDATE_CHANGED')
        if (stat.size > PAGES_UPLOAD.maxAssetBytes) { tooLarge.push(raw); continue }
        written.push({ path: raw, full, size: Number(stat.size), hash: blake3 ? pagesAssetHash(blake3, readFileSync(full), raw) : '' })
      }
      if (tooLarge.length) return { ok: false, error: PUBLISH_FAILURE_TEXT['too-large'], details: tooLarge.slice(0, 20).join('\n') }
      const kept = new Set([...merged.keys(), ...written.map((file) => file.path)])
      const removed = [...site.manifest.keys()].filter((path) => path !== SITE_RECORD_PATH && !kept.has(path))
      // INVARIANT: nothing outside the folders this job builds or unpublishes changes, apart from top-level files it wrote.
      const scopes = new Set([...folders, ...(job.removalRoots?.(prepared.built) ?? []).map((root) => segmentsOf(root)[0])])
      const outside = [...written.map((file) => file.path).filter((path) => segmentsOf(path).length > 1 && !scopes.has(segmentsOf(path)[0])),
        ...removed.filter((path) => segmentsOf(path).length === 1 || !scopes.has(segmentsOf(path)[0]))]
      if (outside.length) return { ok: false, error: 'PUBLISH_UNRELATED_REMOVAL', details: `${preservationMessage('PUBLISH_UNRELATED_REMOVAL')}\n${outside.slice(0, 20).join('\n')}` }
      for (const file of written) merged.set(file.path, file.hash)

      // ── The site record and the site-level files, made from it ─────────────────────────────────────────────────────────
      const registry = rehearsal ? site.record.registry : sanitisedRegistry(ports.registry?.read() ?? site.record.registry)
      const record: SiteRecord = { registry, shortLinks: site.record.shortLinks, headers: site.record.headers, ...(ports.computerName ? { publishedBy: ports.computerName() } : {}) }
      const redirects = buildRedirects(record.registry, manifestFolders(merged.keys()))
      const badRedirect = redirectsRefusal(redirects)
      if (badRedirect !== null) return { ok: false, error: PUBLISH_REDIRECTS_REFUSED, details: badRedirect.replace(/[^\x20-\x7e]/g, ' ').slice(0, 200) }
      const headersChanged = existsSync(join(root, '_headers')) ? readFileSync(join(root, '_headers'), 'utf8') !== record.headers : record.headers !== ''
      if (headersChanged) return { ok: false, error: 'PUBLISH_UNRELATED_REMOVAL', details: `${preservationMessage('PUBLISH_UNRELATED_REMOVAL')}\n/_headers` }
      const hazard = ports.bundlingHazard(root)
      if (hazard) return { ok: false, error: hazard }
      const change = { folders: [...folders], written, removed, redirects }

      const succeed = async (): Promise<PublishSuccess<Built>> => {
        await job.record?.(prepared.built)
        const without = live && !live.ready ? live : null
        return { ok: true, built: (prepared as { ok: true; built: Built }).built, live,
          notice: without ? publishedWithoutLiveText(without.reason) : null, noticeDetails: without?.details ?? null, earlierNotice: null, earlierDetails: null }
      }
      if (rehearsal || !attempt || !blake3) {
        mirror(dir, change)
        return await succeed()
      }

      const recordText = serialiseSiteRecord(record)
      const recordBytes = Buffer.from(recordText, 'utf8')
      const manifest: Record<string, string> = Object.fromEntries([...merged].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      manifest[SITE_RECORD_PATH] = pagesAssetHash(blake3, recordBytes, SITE_RECORD_PATH)
      // Nothing would change (a republish of the same bytes, a short link the site already has): nothing is sent.
      const liveWithout = [...site.manifest].filter(([path]) => path !== SITE_RECORD_PATH)
      if (site.hadRecord && sameSite(record, site.record) && liveWithout.length === merged.size && liveWithout.every(([path, hash]) => merged.get(path) === hash)) {
        mirror(dir, change)
        return await succeed()
      }
      const staged: StagedAsset[] = [
        ...written.map((file) => ({ path: file.path, hash: file.hash, size: file.size, read: () => readFileSync(file.full) })),
        { path: SITE_RECORD_PATH, hash: manifest[SITE_RECORD_PATH], size: recordBytes.byteLength, read: () => recordBytes },
      ]
      const controls: Record<string, string> = {
        ...(redirects ? { '/_redirects': publicationBinding([['/_redirects', sha256(redirects)]]) } : {}),
        ...(record.headers ? { '/_headers': publicationBinding([['/_headers', sha256(record.headers)]]) } : {}),
      }
      const candidateDigest = publicationBinding([Object.entries(manifest), sha256(redirects), sha256(record.headers)])
      let uncertain: PublishFailure | null = null
      let sent: { ok: true } | PublishFailure
      try {
        sent = await attempt.deploy({ candidateDigest, paths: Object.keys(manifest), controls }, async (context) => {
          const result = await send(authorisation, { revision: site.revision, manifest, staged, redirects, headers: record.headers, candidateDigest }, context)
          uncertain = result.value.ok ? null : result.value
          return result
        })
      } catch (error) {
        if (!(error instanceof PreservationRefusal)) throw error
        const known = uncertain as PublishFailure | null
        return { ...(known ?? {}), ok: false, error: error.reason, ...(error.reason !== 'PUBLISH_OUTCOME_UNKNOWN' ? { details: error.message } : known?.details ? { details: known.details } : {}) }
      }
      if (!sent.ok) return sent
      // The deployment is up and confirmed: recorded, whatever the connection is now.
      authorisation.published()
      mirror(dir, change)
      return await succeed()
    } catch (error) {
      // A refusal before anything was sent (a live name this computer cannot lay out, a written name Cloudflare could not keep).
      if (error instanceof PreservationRefusal) return { ok: false, error: error.reason, details: error.message }
      throw error
    } finally {
      if (shadow) rmSync(shadow, { recursive: true, force: true })
      attempt?.close()
    }
  }

  function inQueue<Result>(work: () => Promise<Result>): Promise<Result> {
    const result = queue.run(ports.siteDir(), work)
    tail = result.then(() => {}, () => {})
    return result
  }
  return {
    publish(job) {
      if (job.entry !== 'live-short-link') return inQueue(() => run(job))
      // A short-link attempt checks the common site lock immediately. A refused attempt
      // wrote nothing and must not enqueue an unsolicited settling upload.
      const result = run(job)
      const done = result.then(() => {}, () => {})
      tail = Promise.all([tail, done])
      return result
    },
    async idle() {
      for (let settled: unknown = null; settled !== tail;) {
        settled = tail
        await tail
      }
    },
  }
}

/** Entries the record can hold (`parseSiteRecord`'s rule), first come first kept for a short id given twice. */
function sanitisedRegistry(registry: Record<string, string>): Record<string, string> {
  const ids = new Set<string>()
  const kept: Record<string, string> = {}
  for (const [folder, id] of Object.entries(registry ?? {})) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(id) || !/^[^/\\\x00-\x1f\x7f]{1,255}$/u.test(folder) || ids.has(id)) continue
    ids.add(id)
    kept[folder] = id
  }
  return kept
}

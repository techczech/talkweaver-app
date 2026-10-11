// Publishing handouts to the person's Cloudflare Pages site: the one sequence every publish goes
// through, and the one place the site is uploaded (spec docs/plans/cloudflare-setup-in-app, D7, D8,
// D12 and the table "What each user action does when its feature is not ready").
//
// EVERY WAY THE SITE IS UPLOADED. Each is a `PublishJob` given to `publish()`; nothing else in the
// app runs `pages deploy` (scripts/test-handout-publishing.mjs reads the main process to show it).
//
//   Entry point (`PublishEntry`) | Reached from                         | What it does to the site folder      | Live address in its pages
//   -----------------------------|--------------------------------------|--------------------------------------|--------------------------
//   talk                         | Publish handout (`talk:publish-      | writes the talk's pages              | yes, when the live service
//                                | handout`)                            |                                      | is ready
//   run                          | Publish handout for this Run         | writes the Run's pages               | yes, when the live service
//                                | (`run:publish-handout`)              |                                      | is ready
//   run-unpublish                | Unpublish Run handout                | removes the Run's pages              | none: it writes no page
//                                | (`run:unpublish-handout`)            |                                      |
//   live-short-link              | Go live, when the talk's short link  | rewrites `_redirects` only           | none: it writes no page
//                                | is new (`live:go`)                   |                                      |
//
//   There is no other: no republish or refresh command, no automatic publish on save, and no
//   command-line or agent path (the `setup` command of a later ticket does not publish). "Export
//   handout" / "Save as a file instead" and "Build Run handout" write a file on this computer and
//   upload nothing; the live service's own deploy (live-service-deploy.ts) and Share for comments
//   (shared-talk.ts) send to the live service, never to the site. They are outside this module.
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
//       reports the fixed sentence. Nothing is deleted, moved or remembered. Written limit: the
//       rejected page stays in the site folder, as the output of a failed build always has, and a
//       later upload of the site would carry it; reaching this needs a fault in the entry check
//       itself. Before this work no check existed at all.
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
//         (`const LIVE_CONFIG|VENUE_JOIN|PREWORK_CONFIG = {json}; /* talkweaver:app-config */`), and
//         the redirect file by the same rule as at entry. An unmarked line that reads the same is the
//         author's and is not read; the same marked line twice means the author copied the mark too,
//         and neither is read. The author always wins.
//       Pages are built in the site folder itself, as before this ticket; publishing moves, renames
//       and deletes nothing there. (Unpublish Run handout removes that Run's folder, as it always
//       did: that is what it is for.) A build that simply FAILS (the compiler threw, a file could
//       not be written) may leave its pages part-written in the site folder: that too is the
//       behaviour before this ticket and is not changed here.
//     Pages an EARLIER version left in the site folder with the dead live address are already
//     public. They do not stop a publish and are not rewritten: the result carries one sentence
//     saying how many earlier handouts need publishing again (`earlierHandoutsText`), with their
//     names in Details. (Those pages have no mark: their one `LIVE_CONFIG` line is read, to count.)
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
//   generation). The token reaches the publishing tool only through `authorisation.run`, which does
//   not start a launch, and does not hand back its result, once the token, account or site name has
//   changed.
//     A publish superseded before or during its upload uploads nothing further and records nothing.
//     A publish whose upload completed is recorded, whatever happens to the connection afterwards.
//   (Once the upload has completed the page exists at that address, so writing the address down is
//   true.) A superseded publish reports PUBLISH_SUPERSEDED_ERROR. Pages it had already built in the
//   site folder stay there, checked, and go up with the next publish.
//
//   NO RAW TEXT. Every failure shown is a fixed sentence: one of publishing-logic.ts's sorted
//   failures, a refusal from the connection, or one of this file's. What the publishing tool printed
//   is `details`, shown only when "Details" is pressed, and the token is taken out of it first
//   (`authorisation.clean`), before it is cut to its end.
//
//   ROW STATE FROM A REFUSED PUBLISH. A publish Cloudflare refuses for permission tells the
//   connection (`refusedForPermission`), which turns the Publishing handouts row to "The token
//   cannot publish pages"; a publish that goes up tells it too (`published`). The rule for that row
//   is in cloudflare-connection.ts. It does not start a new generation.
//
// ORDER AND TIME. One site, one folder, one upload of the whole folder: so every publish that
// writes or removes pages (talk, run, run-unpublish) runs ONE AT A TIME, in the order asked for (a
// keyed queue, the key being the site folder). A job that depends on what an earlier one recorded
// reads it when its turn BEGINS (`begin`, `prepare`), never when it was asked for: an unpublish
// asked for while the publish is still running finds the link that publish recorded.
//   GOING LIVE DOES NOT WAIT. `live-short-link` (Go live) writes one small file and must not sit
//   behind a slow handout upload. It runs AT ONCE, outside the queue; the most it waits is its own
//   leave (the connection's requests, 10 s each) and its own upload (3 minutes, below). Whichever
//   upload Cloudflare finishes last is the one served, so when a short-link upload overlapped a
//   queued publish, ONE more upload of the folder as it then stands is put at the end of the queue
//   (`settle`): the site served ends as the folder is. A settling upload records nothing and its
//   failure is dropped.
//   TIME LIMITS. A job's first step (saving the open talk): BEGIN_LIMIT_MS, one minute. The
//   connection's own requests: 10 s each. The live service: `LIVE_STEP_LIMIT_MS`
//   (7 minutes), after which the handout goes up without live features. The upload: the launcher
//   stops the tool at 3 minutes (SIGTERM, then SIGKILL 5 s later; the whole process tree on
//   Windows) and answers only once the tool has EXITED, and the queue moves on only then. There is
//   no second timer here that could let the next upload start while a late one is still sending.
//
// No Electron import and erasable TypeScript only: scripts/test-handout-publishing.mjs imports this
// file as it is. The main process supplies the connection, the live service, the tool and the pages.
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { join, relative } from 'node:path'
import { PUBLISH_SUPERSEDED_ERROR, type DeployCredentials, type PublishAuthorisation, type PublishGrant } from './cloudflare-connection.ts'
import { LIVE_SETUP_FAILED, LiveServiceError, type ToolRun } from './live-service-deploy.ts'
import { createKeyedQueue } from './owner-tokens.ts'
import { PUBLISH_FAILED, pagesDeployFailure, siteFolder } from './publishing-logic.ts'
import { earlierHandoutsText, publishedWithoutLiveText, type PublishNotReady } from '../shared/publish-status.ts'

export type PublishEntry = 'talk' | 'run' | 'run-unpublish' | 'live-short-link'

/** The table at the top, for the code and the tests. `live`: its pages may carry the live address. */
export const PUBLISH_ENTRY_POINTS: Record<PublishEntry, { ipc: string; what: string; live: boolean }> = {
  talk: { ipc: 'talk:publish-handout', what: 'Publish handout', live: true },
  run: { ipc: 'run:publish-handout', what: 'Publish handout for this Run', live: true },
  'run-unpublish': { ipc: 'run:unpublish-handout', what: 'Unpublish Run handout', live: false },
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
 * holds an address it must not, as "<position>: <address>", or null. A page (`.html`): only the
 * configuration lines that carry the compiler's mark, and for each kind only when the page holds
 * exactly one (two marked lines of a kind means the author copied the mark: the author's, not
 * read). The address in such a line must be an http(s) address elsewhere, or empty. `_redirects`:
 * every word of every line that is not a path of the site or a status number. Nothing else.
 */
export function appWrittenLoopback(file: string, text: string): string | null {
  const name = file.split(/[\\/]/).pop() ?? file
  if (name === '_redirects') {
    const bad = redirectsRefusal(text)
    return bad ? shown('a redirect', bad) : null
  }
  if (!/\.html?$/i.test(name)) return null
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
  /** What the tool printed, cleaned: for "Details" only. */
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
  /** The site folder: the job writes its pages here, as it always has. */
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
}

/** `fail`: the job's own failure; `reply` is handed back untouched as `PublishFailure.reply` (the handler's own answer for it). */
export type PublishBegin<Built> = { done: Built } | { fail: { error: string; reply?: unknown } } | null

export interface PublishJob<Built> {
  entry: PublishEntry
  /**
   * Runs first, when the job's turn begins and before leave is asked. `{ done }` ends the job there
   * as a success with nothing built or uploaded (an unpublish of something that is not published);
   * `{ fail }` ends it as the publish's own failure (the talk could not be saved). What a job must
   * read as it stands at its turn, it reads here or in `prepare`. It has BEGIN_LIMIT_MS.
   */
  begin?(): PublishBegin<Built> | Promise<PublishBegin<Built>>
  /**
   * Build this entry's pages in the site folder. Called only with leave to publish, at the job's
   * turn. Every link it writes goes through `build.link` FIRST, before it writes anything. A
   * returned failure is the publish's own (a fixed sentence).
   */
  prepare(build: PublishBuild): Promise<{ ok: true; built: Built } | { ok: false; error: string; details?: string }>
  /**
   * Keep the result on this computer (the Run's link). Called once the upload has completed,
   * whatever has happened to the connection since. Local and quick: it runs inside the queue.
   */
  record?(built: Built): void | Promise<void>
}

export interface PublishingPorts {
  /** The folder the whole site is kept in. */
  siteDir(): string
  authorise(): Promise<PublishGrant>
  /**
   * The live service's address, and the account it was deployed for when that is recorded. A throw
   * (a LiveServiceError, or anything else) means there is none to use.
   */
  live(): Promise<{ baseUrl: string; accountId?: string | null }>
  /** The bundled publishing tool is not there: the message and its Details. */
  toolMissing(): { error: string; details: string } | null
  /** A message when uploading this folder would make Cloudflare compile code; else null. */
  bundlingHazard(siteDir: string): string | null
  /** Run `pages deploy` with these credentials. Answers only once the tool has exited (`timedOut` when it was stopped at its limit). */
  upload(args: string[], credentials: DeployCredentials): Promise<ToolRun & { missing?: { error: string; details: string }; timedOut?: true }>
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

const SUPERSEDED: PublishFailure = { ok: false, error: PUBLISH_SUPERSEDED_ERROR, superseded: true }

class TimeLimit extends Error {}
/** A link the app was about to write into a page, refused (PUBLISHED OUTPUT (a)). */
class LinkRefused extends Error {}
/** The redirect text the app was about to write, refused (its message: the line). */
class RedirectsRefused extends Error {}

/** `work`, or a rejection (a TimeLimit) after `ms`. The work itself is not stopped: its own limit does that. */
function limited<Result>(work: Promise<Result>, ms: number): Promise<Result> {
  return new Promise<Result>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeLimit('time limit')), ms)
    work.then((value) => { clearTimeout(timer); resolve(value) }, (error) => { clearTimeout(timer); reject(error) })
  })
}

export function createHandoutPublishing(ports: PublishingPorts): HandoutPublishing {
  const queue = createKeyedQueue()
  /** What an earlier page was found to hold, by its size and time of change: an unchanged page is not read again. */
  const seen = new Map<string, { stamp: string; found: boolean }>()
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

  /** The handouts (folders) already in the site, outside `replaced`, whose pages carry a live address on this computer. */
  function earlierHandouts(dir: string, replaced: Set<string>): string[] {
    const names = new Set<string>()
    for (const file of pagesUnder(dir)) {
      const top = file.split('/')[0]
      if (replaced.has(top) || !file.includes('/')) continue
      const path = join(dir, file)
      const stat = statSync(path)
      const stamp = `${stat.size}:${stat.mtimeMs}`
      const known = seen.get(path)
      // latin1: one byte, one character, so no file is too odd to be read (the line read is plain ASCII).
      const found = known && known.stamp === stamp ? known.found : earlierPageLoopback(file, readFileSync(path, 'latin1'))
      seen.set(path, { stamp, found })
      if (found) names.add(top)
    }
    return [...names].sort()
  }

  /** Every page and redirect file of the site, with its size and time of change: to tell which ones a build wrote. */
  function stamps(dir: string): Map<string, string> {
    return new Map(pagesUnder(dir).map((file) => { const stat = statSync(join(dir, file)); return [file, `${stat.size}:${stat.mtimeMs}:${stat.ino}`] }))
  }

  /**
   * AFTER THE BUILD: the pages this build wrote (new, or changed since it began), read once more.
   * If one fails, this publish is not uploaded. Nothing is deleted, moved or remembered.
   * Answers the refusal, or the handouts (folders) this build wrote.
   */
  function checkBuilt(dir: string, before: Map<string, string>): PublishFailure | { written: Set<string> } {
    const written = [...stamps(dir)].filter(([file, stamp]) => before.get(file) !== stamp).map(([file]) => file)
    const finds = written.flatMap((file) => {
      const found = appWrittenLoopback(file, readFileSync(join(dir, file), 'latin1'))
      return found ? [`${file}: ${found}`] : []
    })
    if (finds.length) return { ok: false, error: PUBLISH_LOOPBACK_REFUSED, details: finds.slice(0, 20).join('\n') }
    return { written: new Set(written.map((file) => file.split('/')[0])) }
  }

  /**
   * THE choke point, part two: the one place the site folder is uploaded. Nothing goes up when the
   * connection is no longer the one this publish was authorised for. Answers only once the tool has
   * exited, so the queue never starts the next upload while this one may still be sending.
   */
  async function uploadSite(authorisation: PublishAuthorisation, dir: string, rehearsal: boolean): Promise<{ ok: true } | PublishFailure> {
    const hazard = ports.bundlingHazard(dir)
    if (hazard) return { ok: false, error: hazard }
    if (rehearsal) return { ok: true }
    let launched: { superseded: true } | { superseded: false; result: Uploaded }
    try {
      launched = await authorisation.run((credentials) => ports.upload(
        ['pages', 'deploy', dir, '--project-name', authorisation.project, '--branch', authorisation.productionBranch, '--commit-dirty=true'], credentials,
      ))
    } catch (error) {
      if (!authorisation.current()) return SUPERSEDED
      // The launch itself threw: its text is Details, never the message.
      const text = authorisation.clean(error instanceof Error ? error.message : String(error)).trim().slice(-DETAILS_CHARS)
      return text ? { ok: false, error: PUBLISH_FAILED, details: text } : { ok: false, error: PUBLISH_FAILED }
    }
    if (launched.superseded) return SUPERSEDED
    const run = launched.result
    if (run.missing) return { ok: false, error: run.missing.error, details: run.missing.details }
    if (run.ok) return { ok: true }
    const output = `${run.stdout}\n${run.stderr}`
    // The token comes out of the WHOLE of what was printed, and only then is the end kept.
    const details = authorisation.clean(output).trim().slice(-DETAILS_CHARS)
    if (run.timedOut) return details ? { ok: false, error: PUBLISH_TIMED_OUT, details } : { ok: false, error: PUBLISH_TIMED_OUT }
    const sorted = pagesDeployFailure(output)
    if (sorted.kind === 'permission') authorisation.refusedForPermission()
    return details ? { ok: false, error: sorted.error, details } : { ok: false, error: sorted.error }
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
    if (begun && 'fail' in begun) return { ok: false, error: begun.fail.error, ...(begun.fail.reply !== undefined ? { reply: begun.fail.reply } : {}) }
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
      const missing = ports.toolMissing()
      if (missing) return { ok: false, error: missing.error, details: missing.details }
    }
    const live = PUBLISH_ENTRY_POINTS[job.entry].live ? await liveForPages(authorisation, rehearsal !== null) : null
    if (!authorisation.current()) return SUPERSEDED
    const dir = ports.siteDir()
    const before = stamps(dir)
    let prepared: Awaited<ReturnType<PublishJob<Built>['prepare']>>
    try {
      prepared = await job.prepare({
        dir, project: authorisation.project, live: live?.ready ? live.address : '',
        // ENTRY FIRST: refused before the job has written anything.
        link: (url) => { if (!liveAddressForPages(url)) throw new LinkRefused(); return url },
        redirects: (text) => { const bad = redirectsRefusal(text); if (bad !== null) throw new RedirectsRefused(bad); return text },
      })
    } catch (error) {
      if (error instanceof LinkRefused) return { ok: false, error: PUBLISH_LINK_REFUSED }
      if (error instanceof RedirectsRefused) return { ok: false, error: PUBLISH_REDIRECTS_REFUSED, details: error.message.replace(/[^\x20-\x7e]/g, ' ').slice(0, 200) }
      throw error // a build that fails is the caller's own, as before this ticket
    }
    if (!prepared.ok) return prepared
    const checked = checkBuilt(dir, before)
    if ('ok' in checked) return checked
    const earlier = earlierHandouts(dir, checked.written)
    const uploaded = await uploadSite(authorisation, dir, rehearsal !== null)
    if (!uploaded.ok) return uploaded
    // The upload completed: the pages are at their address, and that is recorded whatever the connection is now.
    authorisation.published()
    await job.record?.(prepared.built)
    const without = live && !live.ready ? live : null
    return {
      ok: true, built: prepared.built, live,
      notice: without ? publishedWithoutLiveText(without.reason) : null,
      noticeDetails: without?.details ?? null,
      earlierNotice: earlier.length ? earlierHandoutsText(earlier.length) : null,
      earlierDetails: earlier.length ? earlier.join('\n') : null,
    }
  }

  /** How many queued publishes are waiting or running: a short-link upload that meets one is followed by `settle`. */
  let queued = 0
  function inQueue<Result>(work: () => Promise<Result>): Promise<Result> {
    queued += 1
    const result = queue.run(ports.siteDir(), work).finally(() => { queued -= 1 })
    tail = result.then(() => {}, () => {})
    return result
  }
  /** One more upload of the folder as it stands, after everything queued: so the site served ends as the folder is. */
  function settle(): void {
    void inQueue(() => run({ entry: 'live-short-link', prepare: async () => ({ ok: true, built: null }) })).catch(() => {})
  }

  return {
    publish(job) {
      if (job.entry !== 'live-short-link') return inQueue(() => run(job))
      // GOING LIVE DOES NOT WAIT: at once, outside the queue. If a queued publish was writing the
      // folder at any time while this ran, one settling upload follows them.
      let overlapped = queued > 0
      const watch = setInterval(() => { overlapped ||= queued > 0 }, 20)
      const result = run(job).finally(() => {
        clearInterval(watch)
        if (overlapped || queued > 0) settle()
      })
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

type Uploaded = Awaited<ReturnType<PublishingPorts['upload']>>

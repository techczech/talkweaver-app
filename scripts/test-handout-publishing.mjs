// Publishing handouts (src/main/handout-publishing.ts, src/shared/publish-status.ts and the publish
// side of src/main/cloudflare-connection.ts; spec "Cloudflare set-up in the app", D7, D8, D12 and
// the "not ready" table). No network: the REAL connection and the REAL publishing sequence, the
// fake Cloudflare API's model behind a `fetch` of its own and behind a stand-in for the publishing
// tool that asks it what `pages deploy` asks, the real secrets store over memory, made-up tokens.
// The invariants at the top of handout-publishing.ts, each driven over EVERY entry point of its table:
//  1. the entry points: the table, and that the main process uploads the site nowhere else;
//  2. PUBLISHED OUTPUT: what counts as an address on this computer (and what does not: the
//     handout's own bundled code and real compiled pages), and the choke point before the upload;
//  3. LIVE NEVER FAILS A PUBLISH: every state of the live service, for every entry point;
//  4. ONE CONNECTION: no leave, each "not ready" state, and supersession at each point;
//  5. NO RAW TEXT: every sorted failure, with the token in what the tool printed and not in Details;
//  6. ROW STATE FROM A REFUSED PUBLISH: the row, the next check, a publish that goes up, a new token;
//  7. order and time limits: two publishes, publish then unpublish, a step that never answers;
//  8. the loopback rule (D8) and the app's test mode;
//  9. the live service's own set-up failures, sorted, with Details cleaned.
import { singleKeyPort } from './lib/live-worker-double.mjs'
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CLOUDFLARE_API_BASE, DEPLOY_SUPERSEDED_ERROR, PUBLISH_REFUSED_DETAIL, PUBLISH_SUPERSEDED_ERROR, SITE_FOUND_DETAIL, TOKEN_REMOVED, createCloudflareConnection,
} from '../src/main/cloudflare-connection.ts'
import {
  APP_CONFIG_MARK, LIVE_OTHER_ACCOUNT, LIVE_STEP_LIMIT_MS, LIVE_TIMED_OUT, PUBLISH_ENTRY_POINTS, PUBLISH_LINK_REFUSED, PUBLISH_LOOPBACK_REFUSED, PUBLISH_REDIRECTS_REFUSED, PUBLISH_TIMED_OUT, addressKind,
  appWrittenLoopback, createHandoutPublishing, liveAddressForPages, localLiveAllowed, publishedFolders, redirectsRefusal, removeSiteFolder, writableSiteFolder,
} from '../src/main/handout-publishing.ts'
import {
  KEY_REMOVED, LIVE_ACCESS_REMOVED, LIVE_KEYS_FAILED, LIVE_NOT_SET_UP, LIVE_SETUP_FAILED, LIVE_SETUP_REFUSED, LiveServiceError, deployLiveService,
} from '../src/main/live-service-deploy.ts'
import {
  PUBLISH_FAILED, PUBLISH_NO_SITE, PUBLISH_REFUSED, PUBLISH_TOKEN_REJECTED, PUBLISH_TOO_LARGE, PUBLISH_UNREACHABLE, buildRedirects, pagesDeployFailure, pathSegment, siteFolder,
} from '../src/main/publishing-logic.ts'
import { PAGES_PERMISSION, WORKERS_PERMISSION, publishingLabel } from '../src/shared/cloudflare-status.ts'
import {
  NOT_CONNECTED_TITLE, OPEN_SETTINGS, PUBLISHED_WITHOUT_LIVE, SAVE_AS_FILE, publishNotReady, publishedWithoutLiveText,
} from '../src/shared/publish-status.ts'
import { REPLY_TEXT_MARK, createFakeCloudflare, fakeCloudflareFetch } from './lib/cloudflare-api-stub.mjs'
import { memorySecrets } from './lib/memory-secrets.mjs'
import { workerDistFiles } from './lib/worker-dist.mjs'
import { readSource } from './lib/read-source.mjs'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const scratch = mkdtempSync(join(tmpdir(), 'tw-handout-publishing-'))
// Made up, and built so that no source file holds a whole value.
const fake = (name) => ['test', 'token', 'publishing', name, '0123456789abcdef'].join('-')
const TOKEN = fake('full')
const OTHER = fake('other')
const READ_ONLY = fake('readonly')
const PAGES_ONLY = fake('pagesonly')
const NO_PAGES = fake('nopages')
const BOTH_ACCOUNTS = fake('both')
const UNKNOWN = fake('unknown')
const ALL_TOKENS = [TOKEN, OTHER, READ_ONLY, PAGES_ONLY, NO_PAGES, BOTH_ACCOUNTS, UNKNOWN]
const ADA = { id: 'acc-ada-0001', name: 'Ada Lovelace' }
const GRACE = { id: 'acc-grace-0002', name: 'Grace Hopper' }
const LIVE = 'https://talkweaver-live-sessions.example-subdomain.workers.dev'
const ENTRIES = Object.keys(PUBLISH_ENTRY_POINTS)
const WITH_LIVE = ENTRIES.filter((entry) => PUBLISH_ENTRY_POINTS[entry].live)

/** Everything a window or a caller could see: searched at the end for tokens. */
const observed = []
const see = (value) => { observed.push(value); return value }
const soon = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(condition, ms = 3000) { for (const end = Date.now() + ms; Date.now() < end;) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 2)) } assert.fail('timed out waiting') }
const gate = () => { let open; const wait = new Promise((resolve) => { open = resolve }); return { wait, open } }
const within = (promise, ms, what) => Promise.race([promise, soon(ms).then(() => assert.fail(`${what} did not finish within ${ms} ms`))])
let sites = 0

/** The brief's own list, as plain words: the gate greps every file of the uploaded site for these. */
const LITERALLY = /127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0|file:/i
/** A path inside the site as the tests name it: forward slashes, whatever the platform's separator. */
const slashed = (path) => path.split(sep).join('/')
function filesOf(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesOf(join(dir, entry.name)) : [join(dir, entry.name)]))
}

/**
 * One app: a connection over the fake API, a site folder, a live service and a publishing tool.
 * `tool` stands in for `pages deploy`: it asks the fake API what the real one asks (the site, an
 * upload token, a deployment) with the credentials it was handed, and on a refusal prints what the
 * real one prints PLUS the token it was given, so that a test can show the token is taken out.
 */
function world(overrides = {}) {
  const secrets = memorySecrets()
  const api = createFakeCloudflare({
    sites: [], accounts: [ADA, GRACE], accountSites: { [ADA.id]: ['talks'], [GRACE.id]: ['talks'] },
    tokens: {
      [TOKEN]: { accounts: [ADA.id] }, [OTHER]: { accounts: [GRACE.id] }, [READ_ONLY]: { accounts: [ADA.id], pages: 'read' },
      [PAGES_ONLY]: { accounts: [ADA.id], workers: false }, [NO_PAGES]: { accounts: [ADA.id], pages: false }, [BOTH_ACCOUNTS]: { accounts: [ADA.id, GRACE.id] },
    },
    ...overrides.api,
  })
  const config = { accountId: '', project: 'talks', baseUrl: '', productionBranch: 'main', ...overrides.config }
  const emitted = []
  if (overrides.stored) secrets.store.write('cloudflare-token', overrides.stored)
  const connection = createCloudflareConnection({
    secrets: secrets.store,
    settings: { read: () => ({ ...config }), write: (patch) => Object.assign(config, patch) },
    fetch: fakeCloudflareFetch(api, { honourAbort: true }),
    apiBase: () => CLOUDFLARE_API_BASE,
    timeoutMs: overrides.timeoutMs ?? 150,
    onChange: (status) => { emitted.push(status); observed.push(status) },
  })
  const dir = join(scratch, `site-${sites += 1}`)
  mkdirSync(dir, { recursive: true })
  const log = []
  const w = {
    secrets, api, config, emitted, connection, dir, log,
    /** What the live service does when asked: an address, or a throw. */
    live: async () => ({ baseUrl: LIVE }),
    liveCalls: 0,
    /** Every upload: its arguments, its credentials, what it printed and the files of the site at that moment. */
    uploads: [],
    recorded: [],
    prepared: [],
    built: [],
    hooks: {},
    rehearsal: null,
  }
  async function tool(args, credentials) {
    // Keys are paths inside the site with FORWARD slashes on every platform (`relative` gives back-slashes on Windows).
    const upload = { args, credentials, said: '', files: Object.fromEntries(filesOf(dir).map((path) => [slashed(relative(dir, path)), readFileSync(path, 'latin1')])) }
    w.uploads.push(upload)
    log.push('upload:start')
    await w.hooks.duringUpload?.()
    const project = args[args.indexOf('--project-name') + 1]
    const base = `/accounts/${credentials.CLOUDFLARE_ACCOUNT_ID}/pages/projects/${project}`
    const said = (text) => { upload.said = text; log.push('upload:end'); return text }
    if (w.hooks.toolResult) { said(w.hooks.toolResult.stderr); return w.hooks.toolResult }
    if (w.hooks.toolOutput) return { ok: false, stdout: '', stderr: said(w.hooks.toolOutput(credentials)) }
    for (const [method, path] of [['GET', base], ['GET', `${base}/upload-token`], ['POST', `${base}/deployments`]]) {
      const reply = api.handle({ method, path, search: '', authorization: `Bearer ${credentials.CLOUDFLARE_API_TOKEN}`, body: Buffer.from('{}') })
      if (reply.status >= 400) {
        const error = reply.body.errors[0]
        return { ok: false, stdout: '', stderr: said(`✘ [ERROR] A request to the Cloudflare API (${path}) failed.\n\n  ${error.message} [code: ${error.code}]\n\n  Authorization: Bearer ${credentials.CLOUDFLARE_API_TOKEN}\n`) }
      }
    }
    return { ok: true, stdout: said(`✨ Deployment complete! Take a peek over at https://dep00000001.${project}.pages.dev\n`), stderr: '' }
  }
  const ports = {
    siteDir: () => dir,
    authorise: () => connection.authorisePublish(),
    live: async () => { w.liveCalls += 1; log.push('live'); return w.live() },
    toolMissing: () => w.hooks.toolMissing ?? null,
    bundlingHazard: () => w.hooks.hazard ?? null,
    upload: tool,
    rehearsal: () => w.rehearsal,
    liveLimitMs: overrides.liveLimitMs ?? 2000,
  }
  w.publishing = createHandoutPublishing(ports)
  /** The app is quit and started again: a new sequence over the same folders and files. */
  w.restart = () => { w.publishing = createHandoutPublishing(ports) }
  /** A job for an entry point, building what the app's own handler for it builds, in small. */
  w.job = (entry, options = {}) => {
    const name = options.name ?? (entry === 'talk' ? 'talk-a' : 'run-a')
    return {
      entry,
      prepare: async ({ dir: siteDir, project, live, link, redirects }) => {
        log.push(`prepare:${entry}:${name}`)
        w.prepared.push({ entry, project, live })
        await options.duringPrepare?.()
        // As the handlers do, ENTRY FIRST: the handout's own link and the whole redirect text are
        // checked before anything is written.
        const url = link(options.link ?? `https://talks.test/${name}/`)
        const pageEntry = entry === 'talk' || entry === 'run'
        const redirectsText = options.redirectsText !== undefined ? redirects(options.redirectsText) : pageEntry ? null : redirects(entry === 'run-unpublish' ? '' : '/abcd  /talk-a/  302\n')
        w.built.push(url)
        if (options.half) writeFileSync(join(siteDir, 'half-built.html'), 'half')
        if (options.failBuild) return { ok: false, error: options.failBuild }
        if (pageEntry) {
          mkdirSync(join(siteDir, name), { recursive: true })
          // As the compiler does: the live address is carried in the page as JSON on a line it marks as its own.
          const liveConfig = options.plant ?? `<script>\n  const LIVE_CONFIG = ${live ? JSON.stringify({ workerBaseUrl: live, talkSlug: name }) : 'null'}; ${APP_CONFIG_MARK}\n</script>`
          writeFileSync(join(siteDir, name, 'index.html'), `<!doctype html><title>${name}</title>${liveConfig}<p>${options.text ?? 'A handout.'}</p>`)
          if (redirectsText !== null) writeFileSync(join(siteDir, '_redirects'), redirectsText)
        } else {
          if (entry === 'run-unpublish') rmSync(join(siteDir, name), { recursive: true, force: true })
          // `plant`: written WITHOUT the entry check, as only a fault in that check could.
          writeFileSync(join(siteDir, '_redirects'), options.plant ?? redirectsText)
        }
        return { ok: true, built: { entry, name } }
      },
      record: (built) => { log.push(`record:${entry}`); w.recorded.push(built) },
    }
  }
  w.publish = async (entry, options) => see(await within(w.publishing.publish(w.job(entry, options)), 4000, `publish ${entry}`))
  w.connect = async (token) => { see(await connection.saveToken(token)); await connection.idle(); return connection.status() }
  return w
}
/** A connected app whose check found the row Ready. */
async function connected(overrides = {}, token = TOKEN) {
  const w = world(overrides)
  const status = await w.connect(token)
  assert.equal(status.connection.state, 'connected', 'connected')
  assert.equal(status.publishing.state, 'ready', 'the check finds the site: the row is Ready')
  return w
}

// ── 1. The entry points ─────────────────────────────────────────────────────────────────────────
{
  assert.deepEqual(ENTRIES, ['talk', 'run', 'run-unpublish', 'live-short-link'])
  assert.deepEqual(WITH_LIVE, ['talk', 'run'], 'the two that write pages may carry the live address')
  // (Read with LF line endings on every platform: a Windows checkout has CRLF.)
  const main = readSource(join(repo, 'src/main/index.ts'))
  const between = (from, to) => { const start = main.indexOf(from); assert.ok(start >= 0, `${from} is in the main process`); return main.slice(start, main.indexOf(to, start + from.length)) }
  const BODIES = {
    talk: between("ipcMain.handle('talk:publish-handout'", '\n})\n'),
    run: between("ipcMain.handle('run:publish-handout'", '\n})\n'),
    'run-unpublish': between("ipcMain.handle('run:unpublish-handout'", '\n})\n'),
    'live-short-link': between('async function ensureLiveJoinUrl(', '\n}\n'),
  }
  for (const entry of ENTRIES) {
    const body = BODIES[entry]
    assert.ok(new RegExp(`handoutPublishing\\(\\)\\.publish\\(\\{\\s*entry: '${entry}'`).test(body), `${entry}: goes through the one publishing sequence, as entry '${entry}'`)
    assert.ok(!/readToken\(|runBundledWrangler\(|ensureLiveWorker\(|CLOUDFLARE_API_TOKEN|tokenExists\(/.test(body), `${entry}: its handler reads no token, starts no tool and asks the live service nothing itself`)
  }
  assert.ok(main.includes(`ipcMain.handle('live:go'`) && between("ipcMain.handle('live:go'", '\n})\n').includes('ensureLiveJoinUrl(context)'), 'Go live reaches the short-link upload')
  assert.equal(main.split('handoutPublishing().publish(').length - 1, ENTRIES.length, 'there are exactly as many uploads of the site as rows in the table')
  assert.ok(!main.includes("'pages', 'deploy'") && !/deployPublishedSite/.test(main), 'the main process has no upload of its own left')
  // Every call of the bundled tool in the main process: its definition and the publishing sequence's
  // upload port. The live service is set up without it (ticket 11: uploaded with Cloudflare's API).
  const toolCalls = main.split('\n').filter((line) => line.includes('runBundledWrangler(')).map((line) => line.trim())
  assert.deepEqual(toolCalls.map((line) => line.replace(/\s+/g, ' ')), [
    'function runBundledWrangler(',
    'upload: (args, credentials) => runBundledWrangler(args, { set: credentials }),',
  ])
  // Nothing publishes by itself: no command line, no timer, no save hook reaches the sequence.
  for (const file of ['src/main/setup-cli.ts', 'src/main/talk-writer.ts']) {
    if (existsSync(join(repo, file))) assert.ok(!readSource(join(repo, file)).includes('handoutPublishing'), `${file} does not publish`)
  }
  console.log('PASS 1: four entry points, each through the one sequence; the main process uploads the site nowhere else')
}

// ── 2. PUBLISHED OUTPUT ─────────────────────────────────────────────────────────────────────────
// Every spelling of an address on this computer, and addresses that only look like one.
const ON_THIS_COMPUTER = [
  'http://127.0.0.1:8787', 'http://127.1:8787', 'http://2130706433:8787', 'http://0x7f000001:8787', 'http://0177.0.0.1/', 'http://127.0.0.1.:8787', 'http://127.255.255.254',
  'https://localhost/x', 'http://LOCALHOST:3000', 'http://localhost.:3000', 'http://sub.localhost', 'http://a.b.localhost:1/', 'http://user:pass@localhost/', 'http://user@127.0.0.1/',
  'http://0.0.0.0:8787', 'http://0/', 'http://[::1]:8787', 'ws://[::1]:8787/live', 'http://[::]/', 'http://[0:0:0:0:0:0:0:1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]:8787', 'http://[::ffff:0.0.0.0]/',
  'wss://127.9.9.9/', 'ftp://localhost/x', '//localhost:3000/a', '//127.1/x', 'file:///Users/ada/talk/dist/talk-handout.html', 'file://server/share/x.html', 'file:/Users/ada/x.html', '  http://127.0.0.1:8787  ',
]
const ELSEWHERE = [
  LIVE, 'https://live.example.test', 'https://localhost.example.com/', 'https://notlocalhost/', 'https://my-localhost-site.dev', 'http://128.0.0.1/', 'http://126.255.255.255/', 'http://1.127.0.1/',
  'http://10.0.0.1:8787', 'http://192.168.1.20/', 'https://[2001:db8::1]/', 'https://[::ffff:8.8.8.8]/', 'https://talks.test/127.0.0.1/', 'https://talks.test/?u=http://localhost', 'https://localhost.evil.test/',
  'wss://live.example.test/socket', '//talks.test/x', 'https://xn--lcalhost-m2a.test/', 'http://2147483648/', 'https://1.0.0.127/',
]
const NOT_AN_ADDRESS = ['', '   ', 'localhost', 'localhost:3000/x', '127.0.0.1:8787', 'slide-assets/photo.png', '/talk-a/', 'talk-a-download.html', 'javascript:alert(1)', 'data:text/html,x', 'mailto:a@localhost', 'http://', 'about:blank', undefined, null, 42, {}]
{
  assert.ok(ON_THIS_COMPUTER.length >= 20 && ELSEWHERE.length >= 20)
  for (const address of ON_THIS_COMPUTER) assert.equal(addressKind(address), 'this-computer', `on this computer: ${address}`)
  for (const address of ELSEWHERE) assert.equal(addressKind(address), 'elsewhere', `elsewhere: ${address}`)
  for (const value of NOT_AN_ADDRESS) assert.equal(addressKind(value), 'not-an-address', `not an address: ${String(value)}`)
  // Where an address is REQUIRED (the live address, a link the app writes): only an absolute http(s) address elsewhere.
  for (const address of [...ON_THIS_COMPUTER, ...NOT_AN_ADDRESS, 'wss://live.example.test/socket', '//talks.test/x', 'ftp://files.example.test/']) assert.equal(liveAddressForPages(address), '', `never put in a page: ${String(address)}`)
  assert.deepEqual([liveAddressForPages(`${LIVE}//`), liveAddressForPages(' https://talks.test/a/ ')], [LIVE, 'https://talks.test/a'])
  // The whole app has that one function: no second test of "localhost" or "127." anywhere in what publishes or goes live.
  for (const file of ['src/main/index.ts', 'src/main/handout-publishing.ts', 'src/main/live-service-deploy.ts']) {
    const code = readSource(join(repo, file)).split('\n').filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line)).join('\n')
    const own = file.endsWith('handout-publishing.ts') ? code.slice(0, code.indexOf('function hostOnThisComputer')) + code.slice(code.indexOf('export function addressKind')) : code
    assert.deepEqual(own.match(/hostname\s*[!=]==\s*['"](?:127|localhost|0\.0|\[::)|(?:startsWith|includes|endsWith)\(['"](?:127\.|localhost|\.localhost)/g) ?? [], [], `${file} compares a host with this computer's nowhere else`)
  }

  // ── What the author wrote, and what TalkWeaver wrote ──
  const AUTHOR_LINES = [
    '- Open http://localhost:3000 in your browser, or 127.0.0.1:8787, or ws://[::1]:8787/live',
    '- [the dev server](http://localhost:3000/admin) and <a href="http://127.0.0.1:8080/x">a raw link</a>',
    '- The config says "workerBaseUrl":"http://localhost:8787" and the short link is http://0.0.0.0:8787',
  ]
  const AUTHOR_CODE = ['```js', 'const LIVE_CONFIG = {"workerBaseUrl":"http://localhost:8787","talkSlug":"mine"};', 'const VENUE_JOIN = {"shortUrl":"file:///Users/ada/x.html"};', 'fetch("http://127.0.0.1:8787/sessions")', '```']
  // Raw HTML of the author's that reads exactly like the app's own lines (the two cases the review named).
  const AUTHOR_RAW = ['<script>', '  const VENUE_JOIN = {"shortUrl":"http://localhost:8787/x","qrSvg":""};', '  const PREWORK_CONFIG = {"preworkId":"p","workerBaseUrl":"http://localhost:8787"};', '  const LIVE_CONFIG = {"workerBaseUrl":"http://127.0.0.1:8787","talkSlug":"mine"};', '</script>']
  const AUTHOR_MARKS = ['http://localhost:3000', '127.0.0.1:8787', 'http://localhost:3000/admin', 'http://127.0.0.1:8080/x', 'http://0.0.0.0:8787']

  const { prepareSource } = await import('../compiler/scripts/lib/08-source-adapters.mjs')
  const { extractStyles, extractSlides } = await import('../compiler/scripts/lib/04-html-extraction.mjs')
  const builders = await import('../compiler/scripts/lib/09-output-builders.mjs')
  const { buildShareHtml } = builders
  const { buildHandoutHomePageHtml } = await import('../compiler/scripts/lib/handout-home-page.mjs')
  const { buildVenuePageHtml, buildUnavailableVenuePageHtml } = await import('../compiler/scripts/lib/venue-page.mjs')
  assert.equal(builders.APP_CONFIG_MARK, APP_CONFIG_MARK, 'the compiler marks its configuration lines with the mark the publisher looks for')
  const outlinePath = join(scratch, 'probe-outline.md')
  const outline = ['---', 'title: Probe', 'outline_version: 2', '---', '', '### Local servers', '{id=one}', '', ...AUTHOR_LINES, '', '### Code', '{id=code}', '', ...AUTHOR_CODE, '', '### Diagram', '{id=two}', '', '```mermaid', 'graph TD; A-->B;', '```', ''].join('\n')
  writeFileSync(outlinePath, outline)
  const model = await prepareSource(outlinePath, outline, 'probe', statSync(outlinePath))
  const styles = extractStyles(model.fullHtml)
  const compiled = extractSlides(model.fullHtml)
  // A slide whose HTML holds the author's raw script, as raw HTML in a talk reaches the builders.
  const slides = [...compiled, { id: 'raw', html: `<section class="slide" data-id="raw"><div class="slide-content">${AUTHOR_RAW.join('\n')}</div></section>`, notes: '' }]
  const pagesFor = (workerBaseUrl, link = 'https://talks.test/probe/', prework = null) => ({
    handout: buildShareHtml({ title: 'Probe', slides, styles, includeNotes: false, slug: 'probe', workerBaseUrl, liveTalkSlug: 'probe', prework }),
    home: buildHandoutHomePageHtml({ title: 'Probe', slides, styles, slug: 'probe', workerBaseUrl, liveTalkSlug: 'probe', lazyAssets: true, home: { url: link, qr: '', downloadHref: 'probe-download.html' } }),
    venue: buildVenuePageHtml({ title: 'Probe', slides, styles, slug: 'probe', workerBaseUrl, liveTalkSlug: 'probe', qr: '', handoutUrl: link }),
    unavailable: buildUnavailableVenuePageHtml(),
  })
  const marked = (html, name) => (html.match(new RegExp(`^\\s*const ${name} = .*; \\/\\* talkweaver:app-config \\*\\/$`, 'gm')) ?? []).length
  // (a) Real pages with the author teaching about a local server, AND with the author's look-alike lines: nothing is refused.
  for (const [state, address] of [['ready', LIVE], ['absent', '']]) {
    const pages = pagesFor(address)
    for (const [name, html] of Object.entries(pages)) {
      assert.equal(appWrittenLoopback(`probe/${name}.html`, html), null, `a real ${name} page, live service ${state}: the author's words, links, code and look-alike lines are not the app's`)
      if (name === 'unavailable') continue
      for (const mark of AUTHOR_MARKS) assert.ok(html.includes(mark), `the author's ${mark} is in the ${name} page`)
      assert.ok(html.includes(AUTHOR_RAW[1].trim()) && html.includes(AUTHOR_RAW[2].trim()), `the author's raw lines are in the ${name} page as written`)
      assert.equal(marked(html, 'LIVE_CONFIG'), 1, `the ${name} page holds exactly one LIVE_CONFIG line of the app's`)
    }
    // The two cases by name: an ordinary handout has NO VENUE_JOIN and NO PREWORK_CONFIG of the app's; the author's lines there are the author's.
    assert.deepEqual([marked(pages.handout, 'VENUE_JOIN'), marked(pages.handout, 'PREWORK_CONFIG'), marked(pages.venue, 'VENUE_JOIN')], [0, 0, 1])
    assert.ok(/^\s*const VENUE_JOIN = \{"shortUrl":"http:\/\/localhost:8787\/x"/m.test(pages.handout) && /^\s*const PREWORK_CONFIG = \{"preworkId":"p","workerBaseUrl":"http:\/\/localhost:8787"\};$/m.test(pages.handout), 'and they do stand in the handout on lines of their own')
  }
  assert.ok(pagesFor(LIVE).handout.includes(`const LIVE_CONFIG = {"workerBaseUrl":"${LIVE}","talkSlug":"probe"}; ${APP_CONFIG_MARK}`), 'with the live service ready the page carries its address, as now')
  assert.ok(pagesFor('').handout.includes(`const LIVE_CONFIG = null; ${APP_CONFIG_MARK}`), 'and with none it carries no live address at all')
  // (b) The same real pages built with an address on this computer where the APP writes one: caught, in every spelling.
  for (const local of ['http://127.0.0.1:8787', 'http://localhost:8787', 'http://127.1:8787', 'http://2130706433:8787', 'http://0x7f000001:8787', 'http://[::1]:8787']) {
    for (const [name, html] of Object.entries(pagesFor(local))) {
      if (name !== 'unavailable') assert.ok(appWrittenLoopback(`probe/${name}.html`, html)?.startsWith('the live address'), `a real ${name} page built with the live address ${local} IS caught`)
    }
    assert.ok(appWrittenLoopback('probe/p/index.html', pagesFor(LIVE, `${local}/probe/`).venue)?.startsWith("the venue screen's join link"), `a real venue page whose join link is ${local} is caught`)
    const withPrework = pagesFor(LIVE, undefined, { preworkId: 'p1', workerBaseUrl: local, form: { steps: [] }, steps: [] }).handout
    assert.equal(marked(withPrework, 'PREWORK_CONFIG'), 1)
    assert.ok(appWrittenLoopback('probe/probe.html', withPrework)?.startsWith('the pre-work address'), `a real handout whose pre-work address is ${local} is caught`)
  }
  // An author who copies the mark too: two marked lines of a kind, and neither is read. The author wins.
  const copied = pagesFor('http://127.0.0.1:8787').handout.replace('</body>', `<script>\n  const LIVE_CONFIG = {"workerBaseUrl":"http://localhost:1"}; ${APP_CONFIG_MARK}\n</script></body>`)
  assert.equal(appWrittenLoopback('probe/probe.html', copied), null, 'a page with two marked LIVE_CONFIG lines is never refused on a guess')
  // Lines of the app's that hold something other than an address elsewhere.
  const line = (name, value) => `<script>\n  const ${name} = ${JSON.stringify(value)}; ${APP_CONFIG_MARK}\n</script>`
  for (const bad of ['http://127.1:8787', 'localhost:8787', 'ws://live.example.test', 'file:///x', 42, 'not an address']) {
    assert.ok(appWrittenLoopback('a/index.html', line('LIVE_CONFIG', { workerBaseUrl: bad })), `the app's live address may not be ${JSON.stringify(bad)}`)
  }
  for (const fine of [null, { workerBaseUrl: LIVE }, { workerBaseUrl: '' }]) assert.equal(appWrittenLoopback('a/index.html', line('LIVE_CONFIG', fine)), null)
  assert.equal(appWrittenLoopback('a/index.html', line('VENUE_JOIN', { shortUrl: '', qrSvg: '' })), null, 'a venue page with no link yet')
  assert.equal(appWrittenLoopback('a/slide-assets/photo.png', line('LIVE_CONFIG', { workerBaseUrl: 'http://127.0.0.1:8787' })), null, 'pictures, sound and video are not pages')
  // Redirects: every word that is not a path of the site or a status.
  for (const address of ON_THIS_COMPUTER.map((value) => value.trim())) assert.ok(appWrittenLoopback('_redirects', `/abcd  ${address}  302\n`)?.startsWith('a redirect'), `a redirect to ${address}: caught`)
  assert.ok(appWrittenLoopback('_redirects', '/abcd  localhost:3000/x  302\n'), 'a redirect to something that is no address and no path: caught')
  assert.equal(appWrittenLoopback('_redirects', `/abcd  /talk-a/  302\n/abcd/p  /talk-a/p/  302\n/out  ${LIVE}/x  301!\n`), null)

  // The Download button and "Open slides" point at files beside the page, BY NAME. A talk's name is
  // the author's (it comes from the outline's file name): whatever it is, the link stays under the page.
  const { pageLink } = await import('../compiler/scripts/lib/handout-home.mjs')
  const AWKWARD = ['http:127.0.0.1#', 'file:', 'file:///etc/passwd', '//evil.test/x', 'a#b', 'a?b=c', 'two words', '..', '../up', '/rooted', 'javascript:alert(1)', 'data:text/html,x', 'ünïcødé-講演', '%2e%2e', 'a\\b', 'https://evil.test', 'mailto:x', 'a&b"c<d>']
  const PAGE = 'https://talks.test/some%20talk/'
  for (const name of AWKWARD) {
    const home = buildHandoutHomePageHtml({ title: 'Probe', slides: compiled, styles, slug: name, workerBaseUrl: '', liveTalkSlug: name, lazyAssets: true, home: { url: 'https://talks.test/x/', qr: '', downloadFile: `${name}-download.html` } })
    const unescape = (text) => text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    // The home page's two buttons (locked design 2026-10-07 "Handout 4b"): "Download slides" and "Open slides".
    const download = /<a class="hh-btn" id="hhDownload" data-hh-for="handout" href="([^"]*)" download="([^"]*)">/.exec(home)
    const open = /<a class="hh-btn primary" href="([^"]*)">(?:<svg\b[\s\S]*?<\/svg>)?Open slides<\/a>/.exec(home)
    assert.ok(download && open, `${name}: the home page has both buttons`)
    for (const [what, href, file] of [['Download', unescape(download[1]), `${name}-download.html`], ['Open slides', unescape(open[1]), `${name}.html`]]) {
      const target = new URL(href, PAGE)
      assert.equal(target.origin, 'https://talks.test', `${name}: ${what} stays on the site (${href})`)
      assert.ok(target.pathname.startsWith('/some%20talk/') && !target.pathname.slice('/some%20talk/'.length).includes('/'), `${name}: ${what} is a file beside the page (${target.pathname})`)
      assert.deepEqual([decodeURIComponent(target.pathname.slice('/some%20talk/'.length)), target.search, target.hash], [file, '', ''], `${name}: ${what} names exactly that file`)
      assert.equal(addressKind(href), 'not-an-address', `${name}: ${what} is not an address of its own`)
    }
    assert.equal(unescape(download[2]), `${name}.html`, `${name}: the name the download is saved under is the name itself`)
  }
  // An ordinary name comes out exactly as before: no published page of an ordinary talk changes.
  for (const name of ['my-talk', 'agents-itss-2026-10-06', 'Talk_2.final', 'a~b!c(d)*e']) {
    assert.equal(pageLink(`${name}-download.html`), `${name}-download.html`, `${name}: its link is its name, byte for byte`)
    const args = { title: 'Probe', slides: compiled, styles, slug: name, workerBaseUrl: LIVE, liveTalkSlug: name, lazyAssets: true }
    assert.equal(buildHandoutHomePageHtml({ ...args, home: { url: 'https://talks.test/x/', qr: '', downloadFile: `${name}-download.html` } }),
      buildHandoutHomePageHtml({ ...args, home: { url: 'https://talks.test/x/', qr: '', downloadHref: `${name}-download.html` } }), `${name}: the whole home page is identical to the one built before this change`)
  }
  // The pages are built off the main thread (src/main/handout-pages.ts), for the talk and the Run alike.
  const main = readSource(join(repo, 'src/main/index.ts')) + readSource(join(repo, 'src/main/handout-pages.ts'))
  assert.equal(main.split('home: { url, qr, downloadFile,').length - 1, 2, 'both publish handlers hand the Download target over as a file name')
  assert.ok(!/downloadHref/.test(main), 'and neither builds a link from a name itself')

  // ENTRY FIRST, and the check after the build, for every entry point.
  const tree = (dir) => Object.fromEntries(filesOf(dir).sort().map((path) => [slashed(relative(dir, path)), readFileSync(path, 'latin1')]))
  const authored = `${AUTHOR_MARKS.map((mark) => `<a href="${mark}">${mark}</a>`).join(' ')} <img src="file:///Users/ada/p.png">\n${AUTHOR_RAW.join('\n')}`
  const appLine = (name, value) => `<script>\n  const ${name} = ${JSON.stringify(value)}; ${APP_CONFIG_MARK}\n</script>`
  const APP_POSITIONS = {
    'the live address': (value) => appLine('LIVE_CONFIG', { workerBaseUrl: value, talkSlug: 't' }),
    'the pre-work address': (value) => appLine('PREWORK_CONFIG', { preworkId: 'p1', workerBaseUrl: value, form: {} }),
    "the venue screen's join link": (value) => appLine('VENUE_JOIN', { shortUrl: value, qrSvg: '' }),
  }
  for (const entry of ENTRIES) {
    const pageEntry = entry === 'talk' || entry === 'run'
    const folder = entry === 'talk' ? 'talk-a' : 'run-a'
    const page = `${folder}/index.html`
    // What the author wrote goes up, unchanged.
    const free = await connected()
    const went = await free.publish(entry, { text: authored })
    assert.equal(went.ok, true, `${entry}: a talk about a local server publishes (${went.error ?? ''})`)
    assert.deepEqual([went.earlierNotice, went.earlierDetails], [null, null])
    if (pageEntry) assert.ok(free.uploads[0].files[page].includes(authored), `${entry}: and the author's text, links and look-alike lines are in the uploaded page exactly as written`)

    // ENTRY FIRST: a link the app is about to write is refused BEFORE the build starts. Nothing is written at all.
    for (const link of ['http://localhost:4000/talk-a/', 'http://127.1/talk-a/', 'http://2130706433/x', 'http://0x7f000001/x', 'file:///Users/ada/site/', 'talks.test/talk-a/', 'ftp://talks.test/x', '']) {
      const w = await connected()
      assert.equal((await w.publish('talk')).ok && (await w.publish('run')).ok, true)
      const before = tree(w.dir)
      const result = await w.publish(entry, { link })
      assert.deepEqual(result, { ok: false, error: PUBLISH_LINK_REFUSED }, `${entry}: the site's own link ${JSON.stringify(link)} stops the publish`)
      assert.deepEqual(tree(w.dir), before, `${entry}: the site folder is byte for byte as it was: nothing was built`)
      assert.deepEqual([w.uploads.length, w.recorded.length, w.built.length], [2, 2, 2], `${entry}: nothing uploaded, nothing recorded`)
    }
    assert.equal((await (await connected()).publish(entry, { link: 'https://talks.test/talk-a/' })).ok, true)

    // ENTRY FIRST covers the redirect file: its whole text, built in memory, before anything is written.
    for (const text of ['/abcd  /two words/  302\n', '/abcd  http://localhost:8787/x  302\n', '/abcd  http://127.1/x  302\n', '/abcd  //0x7f000001/x  302\n', '/abcd  file:///Users/ada/x  302\n', '/abcd  https://talks.test/x\n', 'abcd  /talk-a/  302\n', '//evil.test/x  /talk-a/  302\n', '/abcd  http://talks.test/x  302\n', '/abcd  /talk-a/  three\n']) {
      const w = await connected()
      assert.equal((await w.publish('talk')).ok && (await w.publish('run')).ok, true)
      const before = tree(w.dir)
      const result = await w.publish(entry, { redirectsText: text })
      assert.deepEqual([result.ok, result.error, result.details], [false, PUBLISH_REDIRECTS_REFUSED, text.trim()], `${entry}: the redirect line ${JSON.stringify(text.trim())} stops the publish, the line behind Details`)
      assert.deepEqual(tree(w.dir), before, `${entry}: the site folder is byte for byte as it was: nothing was written`)
      assert.deepEqual([w.uploads.length, w.recorded.length], [2, 2], `${entry}: nothing uploaded, nothing recorded`)
    }
    assert.equal((await (await connected()).publish(entry, { redirectsText: '/abcd  /two%20words/  302\n/out  https://talks.test/x  301!\n\n' })).ok, true)

    // AFTER THE BUILD, once more: the pages this build wrote. A failure here needs a fault in the entry
    // check itself (the job below writes what the entry check would never have let through).
    const cases = pageEntry
      ? Object.entries(APP_POSITIONS).flatMap(([position, write]) => ['http://127.0.0.1:8787', 'http://127.1:8787', 'http://2130706433:8787', 'file:///Users/ada/x.html'].map((value) => [position, write(value), value]))
      : ['http://localhost:8787/x', 'http://127.1/x', '//0x7f000001/x'].map((value) => ['a redirect', `/abcd  ${value}  302\n`, value])
    for (const [position, plant, value] of cases) {
      const w = await connected()
      assert.equal((await w.publish('talk', { name: 'other-talk', text: 'kept' })).ok && (await w.publish('run')).ok && (await w.publish('talk')).ok, true)
      const others = Object.fromEntries(Object.entries(tree(w.dir)).filter(([file]) => !file.startsWith(`${folder}/`) && file !== '_redirects'))
      const beside = readdirSync(dirname(w.dir)).filter((name) => !/^site-\d+$/.test(name)).sort()
      const result = await w.publish(entry, { plant, text: authored })
      assert.deepEqual([result.ok, result.error], [false, PUBLISH_LOOPBACK_REFUSED], `${entry}: ${position} = ${value} is not uploaded`)
      assert.ok(result.details.includes(`${pageEntry ? page : '_redirects'}: ${position}`), `Details names the file and the place (${result.details})`)
      assert.deepEqual([w.uploads.length, w.recorded.length], [3, 3], `${entry}: this publish is not uploaded and records nothing`)
      // Nothing is deleted or moved, and nothing is remembered: no file appears anywhere beside the site.
      const after = tree(w.dir)
      for (const [file, text] of Object.entries(others)) assert.equal(after[file], text, `${entry}: ${file} is untouched`)
      assert.ok(after[pageEntry ? page : '_redirects'].includes(value), `${entry}: the rejected page is where it was built, not removed`)
      assert.deepEqual(readdirSync(dirname(w.dir)).filter((name) => !/^site-\d+$/.test(name)).sort(), beside, `${entry}: nothing is written down about it`)
      assert.equal(w.connection.status().publishing.state, 'ready', 'the row is untouched')
      // Nothing is held up: another handout publishes, also after a restart. (The written limit: that
      // upload of the site carries the rejected page, as it would the output of any failed build.)
      w.restart()
      const next = await w.publish('talk', { name: 'other-talk', text: 'again' })
      assert.equal(next.ok, true, `${entry}: the next publish of another handout goes up (${next.error ?? ''})`)
      assert.equal(w.uploads.length, 4)
      assert.ok(w.uploads[3].files[pageEntry ? page : '_redirects'].includes(value), `${entry}: carrying the rejected page: the limit the header states`)
      // Built again cleanly, it is gone.
      assert.equal((await w.publish(entry, { text: 'fixed' })).ok, true)
      assert.ok(!Object.values(w.uploads[4].files).some((text) => text.includes(value)), `${entry}: once built again cleanly, nothing of it is left`)
    }
  }
  for (const entry of ENTRIES) {
    // A build that simply FAILS (the compiler threw, a file could not be written): as before this ticket.
    const w = await connected()
    assert.equal((await w.publish('talk')).ok, true)
    assert.equal((await w.publish(entry, { failBuild: 'Compiler not found', half: true })).error, 'Compiler not found')
    await assert.rejects(w.publishing.publish({ entry, prepare: async ({ dir }) => { writeFileSync(join(dir, 'half.html'), 'half'); throw new Error('the compiler threw') } }), /the compiler threw/)
    assert.equal((await w.publish('talk')).ok, true, `${entry}: a failed build holds nothing up`)
  }
  {
    // A name as one path segment (the real function; scripts/test-publishing-logic.mjs holds its replica).
    for (const [name, segment] of [['two words', 'two%20words'], ['a#b', 'a%23b'], ['50%', '50%25'], ['q?x', 'q%3Fx'], ['a/b', 'a%2Fb'], ['a*b', 'a%2Ab'], ['http:x', 'http%3Ax'], ['..', '..'], ['é', '%C3%A9']]) assert.equal(pathSegment(name), segment)
    for (const name of ['my-talk', 'agents-itss-2026-10-06', 'Talk_2.final~x']) assert.equal(pathSegment(name), name, 'an ordinary name is byte for byte itself')
    assert.equal(redirectsRefusal(buildRedirects({ 'two words': 'ab12', 'a#b': 'cd34', '50%': 'ef56', 'a*b': 'gh78', 'http://localhost/x': 'ij90' }, ['two words', 'a#b', '50%', 'a*b', 'http://localhost/x'])), null, 'whatever the names, the redirect file the app builds passes its own rule')
    assert.ok(!buildRedirects({ 'a*b': 'x*y' }, ['a*b']).includes('*'), 'and no name puts a wildcard in it')
  }
  {
    // THE only way a name becomes a folder under the site folder.
    const site = join(scratch, 'folders', 'site')
    const victim = join(scratch, 'folders', 'victim')
    mkdirSync(join(victim, 'deep'), { recursive: true })
    writeFileSync(join(victim, 'deep', 'keep.txt'), 'keep')
    for (const name of ['real', 'two words', 'a#b', '50%', 'ünï-講演', 'no-home']) mkdirSync(join(site, name), { recursive: true })
    for (const name of ['real', 'two words', 'a#b', '50%', 'ünï-講演']) writeFileSync(join(site, name, 'index.html'), name)
    writeFileSync(join(site, 'a-file'), 'x')
    // (A link cannot always be made on Windows without a privilege: the link cases are then left out there.)
    let linked = true
    try { symlinkSync(victim, join(site, 'linked'), 'junction') } catch { linked = false }
    writeFileSync(join(victim, 'index.html'), 'the victim\'s')
    for (const name of ['talk', 'two words', 'a#b', '50%', 'ünï-講演', '.well-known', 'a..b', 'x'.repeat(200)]) assert.equal(siteFolder(site, name), join(site, name), `a plain name: ${name}`)
    assert.equal(siteFolder('/ud/site', 'http:127.0.0.1#', 'darwin'), '/ud/site/http:127.0.0.1#', 'a colon is part of a name everywhere but on Windows')
    const NOT_NAMES = ['', '.', '..', 'a/b', '../victim', '../..', '/etc', victim, 'a\\b', '..\\victim', 'a\u0000b', '\u0000', 'a\nb', 'a\tb', 'a\u007fb', ' leading', 'trailing ', 'trailing.', 'trailing..', '\ttab', 'CON', 'con', 'nul.txt', 'COM1', 'com9.html', 'LPT1', 'PRN.x', 'AUX', 123, null, undefined, {}, ['a']]
    for (const name of NOT_NAMES) for (const platform of ['darwin', 'linux', 'win32']) assert.equal(siteFolder(platform === 'win32' ? 'C:\\ud\\site' : '/ud/site', name, platform), null, `not a folder of the site (${platform}): ${JSON.stringify(name)}`)
    for (const name of ['a:b', 'C:', 'C:x', 'x:$DATA', 'name:stream', 'talk::$DATA', 'http:127.0.0.1#']) assert.equal(siteFolder('C:\\ud\\site', name, 'win32'), null, `on Windows, not a folder of the site: ${name}`)
    assert.equal(siteFolder('C:\\ud\\site', 'two words', 'win32'), 'C:\\ud\\site\\two words')
    assert.equal(siteFolder(join(site, '..', 'site', '.'), 'real'), join(site, 'real'), 'the site folder itself may be written any way')
    // The site's handouts: its real folders with a home page, never a link, a file or a folder without one.
    assert.deepEqual(publishedFolders(site), ['50%', 'a#b', 'real', 'two words', 'ünï-講演'].sort())
    assert.deepEqual(publishedFolders(join(site, 'missing')), [])
    // Built into: a new name or a real folder; never through a link, never over a file.
    assert.deepEqual([writableSiteFolder(site, 'real'), writableSiteFolder(site, 'new-talk'), writableSiteFolder(site, 'a-file'), writableSiteFolder(site, '../victim')], [join(site, 'real'), join(site, 'new-talk'), null, null])
    if (linked) assert.equal(writableSiteFolder(site, 'linked'), null, 'never through a link')
    // Removed: by membership in the site folder's own listing, and a link is unlinked, not followed.
    const whole = () => readdirSync(victim, { recursive: true }).map(String).sort().join('|') + readFileSync(join(victim, 'deep', 'keep.txt'), 'utf8')
    const before = whole()
    for (const name of ['../victim', '..', '.', '', victim, 'real/../../victim', 'linked/deep', 'missing', 'a-file', 'REAL ', 'real.', 'real/', null, 7]) {
      const listing = readdirSync(site).sort()
      assert.equal(removeSiteFolder(site, name), 'absent', `nothing is removed for ${JSON.stringify(name)}`)
      assert.deepEqual([readdirSync(site).sort(), whole(), existsSync(join(scratch, 'folders', 'victim'))], [listing, before, true])
    }
    if (linked) {
      assert.equal(removeSiteFolder(site, 'linked'), 'unlinked', 'a link in the site folder is unlinked')
      assert.deepEqual([existsSync(join(site, 'linked')), whole()], [false, before], 'and what it pointed at is untouched')
    }
    for (const name of ['two words', 'a#b', '50%', 'ünï-講演', 'real']) assert.equal(removeSiteFolder(site, name), 'removed')
    assert.deepEqual([readdirSync(site).sort(), whole()], [['a-file', 'no-home'], before])
    assert.equal(removeSiteFolder(join(site, 'missing'), 'real'), 'absent')
    // Every path under the site folder that the main process builds from a NAME goes through these.
    const main = readSource(join(repo, 'src/main/index.ts'))
    assert.deepEqual([...main.matchAll(/join\((?:siteDir|publishSiteDir\(\)), ([^)]*)\)/g)].map((found) => found[1]).filter((rest) => !/^'(?:404\.html|_redirects)'$/.test(rest)), [], 'the only paths joined straight onto the site folder are its two fixed files')
    assert.ok(!/rmSync\(join\(siteDir|existsSync\(join\(siteDir, (?!')/.test(main), 'and nothing is looked for or removed there by a joined name')
    assert.deepEqual([main.split('writableSiteFolder(siteDir, slug)').length - 1, main.split('removeSiteFolder(siteDir, slug)').length - 1, main.split('siteFolder(siteDir, context.talkSlug)').length - 1, main.split('publishedFolders(siteDir)').length - 1], [2, 1, 1, 4])
  }
  {
    // The redirect rule itself.
    for (const fine of ['', '\n', '/a1  /talk/  302\n/a1/p  /talk/p/  302\n', '/a1 /two%20words/ 302', '/a1\t/a%23b/\t301!', '/out  https://elsewhere.example/x  302\r\n']) assert.equal(redirectsRefusal(fine), null, `fine: ${JSON.stringify(fine)}`)
    for (const bad of ['/a1  /two words/  302', '/a1  /talk/', '/a1  /talk/  302  extra', 'a1  /talk/  302', '//host/x  /talk/  302', '/a1  //host/x  302', '/a1  http://elsewhere.example/x  302', '/a1  https://localhost/x  302', '/a1  https://127.1/x  302', '/a1  https://[::1]/x  302', '/a1  file:///x  302', '/a1  javascript:alert(1)  302', '/a1  talk/  302', '/a1  /talk/  30', '/a1  /talk/  abc', ...ON_THIS_COMPUTER.map((address) => `/a1  ${address.trim()}  302`)]) {
      assert.equal(redirectsRefusal(`/ok  /fine/  302\n${bad}\n`), bad, `refused: ${bad}`)
    }
  }
  // Pages an EARLIER version left, with the dead live address (and no mark: that version wrote none): already
  // public. They do not stop this publish and are not rewritten; the result says how many handouts need publishing again.
  const oldLine = (value) => `<script>\n  const LIVE_CONFIG = ${JSON.stringify({ workerBaseUrl: value, talkSlug: 'old' })};\n</script>`
  for (const entry of ENTRIES) {
    const w = await connected()
    const old = { 'old-talk/index.html': oldLine('http://127.0.0.1:8787'), 'old-talk/old-talk.html': oldLine('http://127.0.0.1:8787'), 'old-talk/p/index.html': oldLine('http://localhost:8787'), 'older-run/index.html': oldLine('http://127.1:8787'), 'fine-talk/index.html': `${authored}${oldLine(LIVE)}`, 'new-talk/index.html': `${authored}${appLine('LIVE_CONFIG', null)}` }
    for (const [file, text] of Object.entries(old)) { mkdirSync(dirname(join(w.dir, file)), { recursive: true }); writeFileSync(join(w.dir, file), text) }
    const result = await w.publish(entry)
    assert.equal(result.ok, true, `${entry}: an earlier version's pages do not stop a publish (${result.error ?? ''})`)
    assert.equal(result.earlierNotice, '2 earlier handouts on this site still carry an address on this computer, so their live features cannot work. Publish them again.', `${entry}: the result says how many`)
    assert.equal(result.earlierDetails, 'old-talk\nolder-run', `${entry}: and Details names them`)
    assert.equal(w.uploads.length, 1)
    for (const [file, text] of Object.entries(old)) assert.equal(w.uploads[0].files[file], text, `${entry}: ${file} went up as it was: not rewritten`)
    assert.equal(w.recorded.length, 1)
    // Publishing one of them again builds it afresh: one left.
    assert.equal((await w.publish('talk', { name: 'older-run' })).earlierNotice, '1 earlier handout on this site still carries an address on this computer, so its live features cannot work. Publish it again.')
    rmSync(join(w.dir, 'old-talk'), { recursive: true })
    assert.deepEqual([(await w.publish('run')).earlierNotice], [null], 'none left: no sentence')
  }
  console.log(`PASS 2: ${ON_THIS_COMPUTER.length} spellings of an address on this computer and ${ELSEWHERE.length} elsewhere by one function; the author's text and look-alike lines publish unchanged; the app's own lines, links and redirects are checked; a publish refused at entry (a link or a redirect line) writes nothing; a build that fails the check after it is not uploaded, and nothing is deleted, moved or remembered`)
}

// ── 3. LIVE NEVER FAILS A PUBLISH ───────────────────────────────────────────────────────────────
// Every state the live service can be in when a publish asks. `reason`: what follows the D7 sentence.
const LIVE_STATES = [
  ['ready', async () => ({ baseUrl: `${LIVE}/` }), { ready: true }],
  ['never set up (no connection for it)', async () => { throw new LiveServiceError('not-set-up', LIVE_NOT_SET_UP) }, { reason: null }],
  ['refused: the token cannot run it', async () => { throw new LiveServiceError('failed', LIVE_SETUP_REFUSED, `Authentication error [code: 10000] Bearer ${TOKEN}`) }, { reason: LIVE_SETUP_REFUSED, details: true }],
  ['its set-up failed', async () => { throw new LiveServiceError('failed', LIVE_SETUP_FAILED, `esbuild exploded ${REPLY_TEXT_MARK}`) }, { reason: LIVE_SETUP_FAILED, details: true }],
  ['its keys could not be set', async () => { throw new LiveServiceError('failed', LIVE_KEYS_FAILED, 'secret bulk said no') }, { reason: LIVE_KEYS_FAILED, details: true }],
  ['this computer\'s access was removed', async () => { throw new LiveServiceError('failed', LIVE_ACCESS_REMOVED) }, { reason: LIVE_ACCESS_REMOVED }],
  ['its set-up was superseded', async () => { throw new LiveServiceError('failed', DEPLOY_SUPERSEDED_ERROR) }, { reason: DEPLOY_SUPERSEDED_ERROR }],
  ['it threw something unsorted', async () => { throw new Error(`Local live Worker did not start. raw tool text ${REPLY_TEXT_MARK} Bearer ${TOKEN}`) }, { reason: LIVE_SETUP_FAILED, details: true }],
  ['it threw a non-error', async () => { throw 'plain string' }, { reason: LIVE_SETUP_FAILED, details: true }], // eslint-disable-line no-throw-literal
  ['it answers with an address on this computer', async () => ({ baseUrl: 'http://127.0.0.1:8787' }), { reason: null }],
  ['it answers with localhost', async () => ({ baseUrl: 'http://localhost:8787' }), { reason: null }],
  ['it answers with no address', async () => ({ baseUrl: '' }), { reason: null }],
  ['it answers with nothing', async () => null, { reason: null }],
  ['it answers with something that is not a web address', async () => ({ baseUrl: 'javascript:alert(1)' }), { reason: null }],
  ['it never answers', () => new Promise(() => {}), { reason: LIVE_TIMED_OUT, liveLimitMs: 40 }],
]
for (const entry of ENTRIES) {
  for (const [state, live, expected] of LIVE_STATES) {
    const w = await connected(expected.liveLimitMs ? { liveLimitMs: expected.liveLimitMs } : {})
    w.live = live
    const result = await w.publish(entry)
    const label = `${entry}, live service ${state}`
    assert.equal(result.ok, true, `${label}: the publish succeeds (${result.error ?? ''})`)
    assert.equal(w.uploads.length, 1, `${label}: the site went up once`)
    assert.deepEqual(w.recorded, [{ entry, name: entry === 'talk' ? 'talk-a' : 'run-a' }], `${label}: the result is recorded`)
    // The gate: every file of the site as it was uploaded, searched for the plain words.
    for (const [file, text] of Object.entries(w.uploads[0].files)) assert.ok(!LITERALLY.test(text), `${label}: ${file} holds no loopback address`)
    if (!PUBLISH_ENTRY_POINTS[entry].live) {
      assert.deepEqual([w.liveCalls, result.live, result.notice, result.noticeDetails], [0, null, null, null], `${label}: an entry that writes no page does not ask the live service at all`)
      continue
    }
    assert.equal(w.liveCalls, 1)
    const page = w.uploads[0].files[`${entry === 'talk' ? 'talk-a' : 'run-a'}/index.html`]
    if (expected.ready) {
      assert.ok(page.includes(`"workerBaseUrl":"${LIVE}"`), `${label}: the page carries the live address, without its trailing slash`)
      assert.deepEqual([result.notice, result.noticeDetails, result.live], [null, null, { ready: true, address: LIVE }])
      continue
    }
    assert.ok(!page.includes('workerBaseUrl'), `${label}: the page is published without live features`)
    assert.equal(w.prepared[0].live, '', `${label}: the builder is given no live address`)
    assert.equal(result.notice, expected.reason ? `${PUBLISHED_WITHOUT_LIVE}. ${expected.reason}` : PUBLISHED_WITHOUT_LIVE, `${label}: the result says so, with the route to Settings`)
    assert.ok(result.notice.startsWith('Published. Going live is not set up: Settings → Cloudflare'), 'in the words of decision D7')
    assert.ok(!result.notice.includes(REPLY_TEXT_MARK) && !result.notice.includes('raw tool text') && !result.notice.includes(TOKEN), `${label}: no raw text in the notice`)
    assert.equal(Boolean(result.noticeDetails), Boolean(expected.details), `${label}: what the tool printed is Details only`)
    if (result.noticeDetails) assert.ok(!result.noticeDetails.includes(TOKEN), `${label}: and the token is not in it`)
  }
}
// The live service's address was recorded as deployed for one account; another account is publishing.
for (const entry of WITH_LIVE) {
  for (const [recorded, expected] of [[GRACE.id, 'other'], [ADA.id, 'ready'], [null, 'ready'], [undefined, 'ready'], ['', 'ready']]) {
    const w = await connected()
    w.live = async () => ({ baseUrl: LIVE, accountId: recorded })
    const result = await w.publish(entry)
    const page = w.uploads[0].files[`${entry === 'talk' ? 'talk-a' : 'run-a'}/index.html`]
    assert.equal(result.ok, true)
    if (expected === 'ready') {
      assert.deepEqual([result.notice, page.includes(`"workerBaseUrl":"${LIVE}"`)], [null, true], `${entry}: a live service recorded for this account${recorded ? '' : ' (or with no account recorded, as every earlier install has)'} is published as before`)
    } else {
      assert.deepEqual([result.notice, page.includes(LIVE), w.prepared[0].live], [`${PUBLISHED_WITHOUT_LIVE}. ${LIVE_OTHER_ACCOUNT}`, false, ''], `${entry}: another account's live address is not published, and the result says going live is not set up for this account`)
    }
  }
}
console.log(`PASS 3: ${LIVE_STATES.length} states of the live service × ${ENTRIES.length} entry points: always published, never a loopback address, the notice in D7's words`)

// ── 4. ONE CONNECTION ───────────────────────────────────────────────────────────────────────────
// (a) No leave: nothing is built, the live service is not asked, nothing goes up.
const NOT_READY = [
  ['not connected', {}, null, { kind: 'not-connected', title: NOT_CONNECTED_TITLE, action: 'open-settings' }],
  ['a token Cloudflare does not know', {}, UNKNOWN, { kind: 'not-ready', title: 'Cloudflare did not accept this token', action: 'open-settings' }],
  ['several accounts, none chosen', {}, BOTH_ACCOUNTS, { kind: 'not-ready', title: 'Choose a Cloudflare account', action: 'open-settings' }],
  ['no site yet', { config: { project: 'not-made-yet' } }, TOKEN, { kind: 'not-ready', title: 'No site yet', action: 'create-site', label: 'Create not-made-yet' }],
  ['a token that cannot even read Pages', {}, NO_PAGES, { kind: 'not-ready', title: 'The token cannot publish pages', action: 'open-settings' }],
  ['a site name that cannot be used', { config: { project: 'not a name' } }, TOKEN, { kind: 'not-ready', title: 'Publishing is not ready', action: 'open-settings' }],
  ['Cloudflare does not answer', { timeoutMs: 30, hang: true }, TOKEN, { kind: 'not-ready', title: 'Cloudflare could not be reached', action: 'open-settings' }],
]
for (const entry of ENTRIES) {
  for (const [state, overrides, token, expected] of NOT_READY) {
    const w = world({ ...overrides, ...(token ? { stored: token } : {}) })
    if (overrides.hang) w.api.model.hang = () => true
    const result = await w.publish(entry)
    const label = `${entry}, ${state}`
    assert.equal(result.ok, false, label)
    assert.deepEqual([result.notReady.kind, result.notReady.title, result.notReady.fix.action], [expected.kind, expected.title, expected.action], `${label}: names what is missing and the one button`)
    if (expected.label) assert.equal(result.notReady.fix.label, expected.label)
    assert.ok(result.error.startsWith(expected.title), `${label}: the message is that fixed sentence`)
    assert.deepEqual([w.prepared.length, w.liveCalls, w.uploads.length, w.recorded.length], [0, 0, 0, 0], `${label}: nothing built, the live service not asked, nothing uploaded, nothing recorded`)
    assert.equal(existsSync(join(w.dir, 'talk-a')) || existsSync(join(w.dir, '_redirects')), false, `${label}: the site folder is untouched`)
  }
}
{
  // The sheet for "Not connected", in the spec's words.
  const sheet = (await world().publish('talk')).notReady
  assert.deepEqual([sheet.title, sheet.fix.label, SAVE_AS_FILE], ['Publishing needs a Cloudflare account', 'Open Settings', 'Save as a file instead'])
  assert.equal(OPEN_SETTINGS, 'Open Settings')
  // "No site yet": the one button makes the site, and the publish then goes.
  const w = world({ stored: TOKEN, config: { project: 'not-made-yet' } })
  assert.equal((await w.publish('talk')).notReady.fix.action, 'create-site')
  see(await w.connection.createSite())
  assert.equal((await w.publish('talk')).ok, true, 'after "Create not-made-yet" the same publish goes up, with no "Check again" in between')
  assert.equal(w.uploads[0].args[w.uploads[0].args.indexOf('--project-name') + 1], 'not-made-yet')
  // A connection that was offline is asked again at the next publish, not held against the person.
  const flaky = world({ stored: TOKEN, timeoutMs: 30 })
  flaky.api.model.hang = () => true
  assert.equal((await flaky.publish('talk')).notReady.title, 'Cloudflare could not be reached')
  flaky.api.model.hang = null
  assert.equal((await flaky.publish('talk')).ok, true, 'back online: the next publish checks again and goes')
}
// (b) With leave: one authorisation, the token and account of one generation, the site the check found.
for (const entry of ENTRIES) {
  const w = await connected({ config: { productionBranch: 'live' } })
  const before = w.api.requests.length
  assert.equal((await w.publish(entry)).ok, true)
  const upload = w.uploads[0]
  assert.deepEqual(upload.credentials, { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ADA.id }, `${entry}: the tool is given the token and the account of the connection`)
  assert.deepEqual(upload.args, ['pages', 'deploy', w.dir, '--project-name', 'talks', '--branch', 'live', '--commit-dirty=true'])
  assert.equal(w.prepared[0].project, 'talks', 'the builder is given the site the check found')
  assert.deepEqual(w.api.requests.slice(before).map((request) => request.path).filter((path) => !path.includes('/pages/projects/talks')), [], `${entry}: with the row Ready a publish asks Cloudflare nothing but the upload itself`)
}
// (c) Supersession: every event that changes the token, the account or the site, at every point of a publish.
const CHANGES = [
  ['Replace token', (w) => w.connection.saveToken(OTHER)],
  ['Disconnect', (w) => w.connection.disconnect()],
  ['the account changed in Settings', (w) => { w.config.accountId = GRACE.id; return w.connection.settingsChanged() }],
  ['the site changed in Settings', (w) => { w.config.project = 'another-site'; return w.connection.settingsChanged() }],
]
const POINTS = ['while the live service is asked', 'while the pages are built', 'while the upload runs']
for (const entry of ENTRIES) {
  for (const [change, apply] of CHANGES) {
    for (const point of POINTS) {
      if (point === POINTS[0] && !PUBLISH_ENTRY_POINTS[entry].live) continue
      const w = await connected()
      const settled = []
      const now = async () => { const applied = apply(w); settled.push(applied); await soon(5) } // not awaited to its end: the publish must not need it
      if (point === POINTS[0]) w.live = async () => { await now(); return { baseUrl: LIVE } }
      if (point === POINTS[2]) w.hooks.duringUpload = now
      const result = await w.publish(entry, point === POINTS[1] ? { duringPrepare: now } : {})
      await Promise.all(settled)
      await w.connection.idle()
      const label = `${entry}, ${change} ${point}`
      assert.deepEqual([result.ok, result.error, result.superseded], [false, PUBLISH_SUPERSEDED_ERROR, true], `${label}: the publish reports that it was superseded`)
      assert.deepEqual(w.recorded, [], `${label}: no result is written`)
      assert.equal(w.uploads.length, point === POINTS[2] ? 1 : 0, `${label}: ${point === POINTS[2] ? 'the upload under way is the only one' : 'no upload starts'}`)
      if (point === POINTS[0]) assert.equal(w.prepared.length, 0, `${label}: nothing is built for a connection that is gone`)
      for (const upload of w.uploads) assert.equal(upload.credentials.CLOUDFLARE_API_TOKEN, TOKEN, `${label}: no upload carries any token but the one it was authorised with`)
      assert.ok(!w.api.requests.some((request) => request.path.endsWith('/deployments') && request.authorization !== `Bearer ${TOKEN}`), `${label}: and none reaches Cloudflare with another`)
      // The row belongs to the new connection: a superseded publish said nothing about it.
      const row = w.connection.status().publishing
      assert.notEqual(row.state, 'no-permission', `${label}: the row is not marked by the superseded publish`)
    }
  }
}
{
  // Superseded while it waits for leave: the answer is the same, and nothing was built.
  const w = await connected()
  w.api.model.tokens.get(TOKEN).pages = true
  const publish = w.publishing.publish(w.job('talk'))
  see(await w.connection.saveToken(OTHER))
  const result = see(await publish)
  await w.connection.idle()
  assert.ok(result.ok === true || result.superseded === true, 'a publish asked for just before Replace token either belongs to the new token or is superseded')
  for (const upload of w.uploads) assert.equal(upload.credentials.CLOUDFLARE_API_TOKEN, OTHER, 'never the replaced token')
}
console.log(`PASS 4: ${NOT_READY.length} "not ready" states and ${CHANGES.length} changes × ${POINTS.length} points × ${ENTRIES.length} entry points: no stale upload, no result written`)

// ── 5. NO RAW TEXT ──────────────────────────────────────────────────────────────────────────────
const echo = (text) => (credentials) => `${text}\n  Authorization: Bearer ${credentials.CLOUDFLARE_API_TOKEN}\n`
const FAILURES = [
  ['a token that may read the site but not publish', { token: READ_ONLY }, PUBLISH_REFUSED, 'permission'],
  ['a token Cloudflare no longer knows', { output: echo(`✘ [ERROR] Invalid API Token [code: 1000] ${REPLY_TEXT_MARK}`) }, PUBLISH_TOKEN_REJECTED, 'token'],
  ['the site is gone', { output: echo(`✘ [ERROR] Project not found [code: 8000007] ${REPLY_TEXT_MARK}`) }, PUBLISH_NO_SITE, 'no-site'],
  ['Cloudflare cannot be reached', { output: echo(`TypeError: fetch failed\n  cause: Error: getaddrinfo ENOTFOUND api.cloudflare.com ${REPLY_TEXT_MARK}`) }, PUBLISH_UNREACHABLE, 'unreachable'],
  ['a file over the limit', { output: echo(`✘ [ERROR] Error: Pages only supports files up to 25 MiB in size ${REPLY_TEXT_MARK}`) }, PUBLISH_TOO_LARGE, 'too-large'],
  ['anything else', { output: echo(`ENOSPC: no space left on device ${REPLY_TEXT_MARK}`) }, PUBLISH_FAILED, 'failed'],
  // The token sits just where a cut to the last 600 characters would leave half of it.
  ['a long output with the token across the cut', { output: (credentials) => `${'x'.repeat(4000)} ${REPLY_TEXT_MARK} ${credentials.CLOUDFLARE_API_TOKEN}${'y'.repeat(570)}` }, PUBLISH_FAILED, 'failed'],
]
for (const entry of ENTRIES) {
  for (const [what, setup, sentence, kind] of FAILURES) {
    const token = setup.token ?? TOKEN
    const w = await connected({}, token)
    if (setup.output) w.hooks.toolOutput = setup.output
    const result = await w.publish(entry)
    const label = `${entry}, ${what}`
    assert.deepEqual([result.ok, result.error], [false, sentence], `${label}: the message is the sorted sentence`)
    const raw = w.uploads[0].said
    assert.equal(pagesDeployFailure(raw).kind, kind)
    // On the raw text first: the stand-in really printed the token and the reply's own words.
    assert.ok(raw.includes(token) && raw.includes(REPLY_TEXT_MARK), `${label}: what the tool printed held the token and Cloudflare's own text`)
    assert.ok(!result.error.includes(REPLY_TEXT_MARK) && !result.error.includes(token), `${label}: neither is in the message`)
    assert.ok(result.details.includes(REPLY_TEXT_MARK) || what.startsWith('a long'), `${label}: the raw text is behind Details`)
    assert.ok(!result.details.includes(token) && result.details.length <= 600, `${label}: Details does not hold the token`)
    for (let at = 0; at + 12 <= token.length; at += 1) assert.ok(!result.details.includes(token.slice(at, at + 12)), `${label}: nor a part of it`)
    assert.ok(result.details.includes(TOKEN_REMOVED) || what.startsWith('a long'), `${label}: it was taken out, not cut off by luck`)
    assert.deepEqual(w.recorded, [], `${label}: nothing is recorded`)
    assert.equal(result.notReady, undefined)
  }
}
{
  // The publish's own failures pass through as they are; a missing tool and a site that would run code are fixed sentences.
  const w = await connected()
  assert.deepEqual(await w.publish('run', { failBuild: 'Compiler not found' }), { ok: false, error: 'Compiler not found' })
  w.hooks.toolMissing = { error: 'This TalkWeaver installation is incomplete', details: 'wrangler.js is missing' }
  assert.deepEqual(await w.publish('talk'), { ok: false, error: 'This TalkWeaver installation is incomplete', details: 'wrangler.js is missing' })
  w.hooks.toolMissing = null
  w.hooks.hazard = 'Publishing stopped: /site/_worker.js would make the site run code, which TalkWeaver handouts never do. Remove it and publish again.'
  assert.equal((await w.publish('talk')).error, w.hooks.hazard)
  assert.deepEqual([w.uploads.length, w.recorded.length], [0, 0])
}
console.log(`PASS 5: ${FAILURES.length} failures × ${ENTRIES.length} entry points: a fixed sentence each; the token is in what the tool printed and not in Details`)

// ── 6. ROW STATE FROM A REFUSED PUBLISH ─────────────────────────────────────────────────────────
for (const entry of ENTRIES) {
  const w = await connected({}, READ_ONLY)
  assert.ok(w.connection.status().details.includes(SITE_FOUND_DETAIL), 'before any publish Details says the permission is proven by the first publish')
  // An authorisation taken before the refusal: still current after it, so the refusal started no new generation.
  const before = await w.connection.authoriseLiveDeploy()
  const emittedBefore = w.emitted.length
  const refused = await w.publish(entry)
  assert.equal(refused.error, PUBLISH_REFUSED, `${entry}: Cloudflare refuses the publish`)
  const row = () => w.connection.status().publishing
  assert.deepEqual([row().state, publishingLabel(row()), row().permission], ['no-permission', 'The token cannot publish pages', PAGES_PERMISSION], `${entry}: the row says so, with the permission named`)
  assert.ok(w.emitted.slice(emittedBefore).some((status) => status.publishing.state === 'no-permission'), `${entry}: and the windows are told`)
  assert.equal(before.ok && before.authorisation.current(), true, `${entry}: the refusal does not start a new generation`)
  assert.ok(w.connection.status().details.includes(PUBLISH_REFUSED_DETAIL) && !w.connection.status().details.includes(SITE_FOUND_DETAIL), 'Details says what was found out')
  // The next check reads the site, finds it, and does NOT turn the row back to Ready.
  for (const reason of ['asked', 'opened', 'asked']) {
    see(await w.connection.check(reason))
    await w.connection.idle()
    assert.equal(row().state, 'no-permission', `${entry}: after "Check again" (${reason}) the row is still not Ready`)
  }
  assert.equal(w.connection.status().connection.state, 'connected')
  // It does not stop the next attempt: the permission may have been added at Cloudflare.
  const again = await w.publish(entry)
  assert.equal(again.error, PUBLISH_REFUSED, `${entry}: the next publish is tried, and refused again`)
  assert.equal(w.uploads.length, 2)
  w.api.model.tokens.get(READ_ONLY).pages = true
  assert.equal((await w.publish(entry)).ok, true, `${entry}: with the permission added the publish goes up`)
  assert.deepEqual([row().state, publishingLabel(row())], ['ready', 'Ready'], `${entry}: and only then is the row Ready again`)
}
{
  // Replace token: the row is the new token's. Disconnect and an edit in Settings clear it too.
  const CLEARED_BY = [
    ['Replace token', async (w) => { await w.connect(TOKEN) }, 'ready'],
    ['Disconnect', async (w) => { see(await w.connection.disconnect()) }, 'unknown'],
    ['the site changed in Settings', async (w) => { w.config.baseUrl = 'https://handouts.example.com'; see(await w.connection.settingsChanged()); await w.connection.idle() }, 'ready'],
  ]
  for (const [event, apply, expected] of CLEARED_BY) {
    const w = await connected({}, READ_ONLY)
    await w.publish('talk')
    assert.equal(w.connection.status().publishing.state, 'no-permission')
    await apply(w)
    assert.equal(w.connection.status().publishing.state, expected, `${event}: the refusal was about the earlier connection`)
  }
  // A refusal that arrives after the token was replaced says nothing about the new token.
  const w = await connected({}, READ_ONLY)
  w.hooks.duringUpload = async () => { await w.connect(TOKEN) }
  const late = await w.publish('talk')
  assert.equal(late.superseded, true)
  assert.equal(w.connection.status().publishing.state, 'ready', 'the new token\'s row is not marked by the old token\'s refusal')
  // Only a refusal for permission marks the row.
  for (const output of ['Invalid API Token [code: 1000]', 'Project not found [code: 8000007]', 'fetch failed ENOTFOUND', 'something else']) {
    const other = await connected()
    other.hooks.toolOutput = () => output
    await other.publish('talk')
    assert.equal(other.connection.status().publishing.state, 'ready', `"${output}" does not turn the row to "The token cannot publish pages"`)
  }
  // The row is not Ready-then-refused for a token whose check already says no: that one is not even tried.
  assert.equal(publishNotReady((await connected({}, PAGES_ONLY)).connection.status()), null, 'a token without the live-service permission can still publish')
}
console.log('PASS 6: a refused publish turns the row to "The token cannot publish pages"; checks leave it; a publish that goes up, or a new token, clears it')

// ── 7. Order and time limits ────────────────────────────────────────────────────────────────────
{
  // Two publishes of the same talk, asked for at once: the second builds only after the first is up and recorded.
  const w = await connected()
  const [first, second] = await Promise.all([w.publish('talk', { text: 'first' }), w.publish('talk', { text: 'second' })])
  assert.deepEqual([first.ok, second.ok], [true, true])
  assert.deepEqual(w.log, ['live', 'prepare:talk:talk-a', 'upload:start', 'upload:end', 'record:talk', 'live', 'prepare:talk:talk-a', 'upload:start', 'upload:end', 'record:talk'], 'one after the other, in the order asked for')
  assert.ok(w.uploads[0].files['talk-a/index.html'].includes('first') && w.uploads[1].files['talk-a/index.html'].includes('second'), 'each upload carries its own pages, whole')
}
{
  // Publish then unpublish (and a different talk in between): one site, one queue.
  const w = await connected()
  const results = await Promise.all([w.publish('run'), w.publish('talk'), w.publish('run-unpublish')])
  assert.ok(results.every((result) => result.ok))
  assert.deepEqual(w.log.filter((line) => /^(?:prepare|record)/.test(line)), ['prepare:run:run-a', 'record:run', 'prepare:talk:talk-a', 'record:talk', 'prepare:run-unpublish:run-a', 'record:run-unpublish'])
  assert.deepEqual(w.uploads.map((upload) => Object.keys(upload.files).sort()), [['run-a/index.html'], ['run-a/index.html', 'talk-a/index.html'], ['_redirects', 'talk-a/index.html']], 'the site as each upload found it: published, then unpublished')
  assert.equal(existsSync(join(w.dir, 'run-a')), false)
}
{
  // GOING LIVE DOES NOT WAIT: its short-link upload is not held behind a slow handout upload.
  const w = await connected()
  const slow = gate()
  let talkUploading
  const reached = new Promise((resolve) => { talkUploading = resolve })
  w.hooks.duringUpload = async () => { if (w.uploads.length === 1) { talkUploading(); await slow.wait } }
  const talk = w.publish('talk')
  const behind = w.publish('run')
  await reached
  const live = await within(w.publish('live-short-link'), 1500, 'the short-link upload, with a handout upload still running')
  assert.equal(live.ok, true, 'Go live\'s upload finishes while the handout\'s is still running')
  assert.deepEqual([w.recorded.map((built) => built.entry), w.uploads.length], [['live-short-link'], 2], 'and before the publish queued behind that handout has even started')
  assert.deepEqual(w.uploads[1].credentials, { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ADA.id }, 'with leave of its own from the one connection')
  slow.open()
  assert.deepEqual([(await talk).ok, (await behind).ok], [true, true])
  await w.publishing.idle()
  // Because it overlapped a queued publish, one more upload follows everything queued: the folder as it stands.
  assert.equal(w.uploads.length, 4, 'talk, short link, run, and one settling upload')
  assert.deepEqual(Object.keys(w.uploads[3].files).sort(), ['_redirects', 'run-a/index.html', 'talk-a/index.html'], 'the last upload carries everything: the site served ends as the folder is')
  assert.deepEqual(w.recorded.map((built) => built.entry), ['live-short-link', 'talk', 'run'], 'the settling upload records nothing')
  // With nothing queued there is nothing to settle: one upload.
  const quiet = await connected()
  assert.equal((await quiet.publish('live-short-link')).ok, true)
  await quiet.publishing.idle()
  await soon(60)
  assert.equal(quiet.uploads.length, 1, 'a short-link upload on its own is one upload')
  // A settling upload that fails is nobody's failure, and holds nothing up.
  const failing = await connected()
  const hold = gate()
  failing.hooks.duringUpload = async () => { if (failing.uploads.length === 1) await hold.wait }
  const first = failing.publish('talk')
  await until(() => failing.uploads.length === 1)
  assert.equal((await failing.publish('live-short-link')).ok, true)
  failing.hooks.toolOutput = () => 'something else'
  hold.open()
  await first
  await failing.publishing.idle()
  failing.hooks.toolOutput = null
  assert.equal((await failing.publish('talk')).ok, true, 'the next publish goes up after a failed settling upload')
}
{
  // A publish that throws, and one that fails, do not hold up the next; nothing is held while idle.
  const w = await connected()
  const thrown = w.publishing.publish({ entry: 'talk', prepare: async () => { throw new Error('the compiler threw') } })
  const next = w.publish('talk')
  await assert.rejects(thrown, /the compiler threw/, 'a throw while building is the caller\'s own, as before')
  assert.equal((await next).ok, true, 'and the next publish runs')
  await w.publishing.idle()
  const started = Date.now()
  assert.equal((await w.publish('talk')).ok, true)
  assert.ok(Date.now() - started < 1000, 'an idle queue starts the next publish at once')
}
{
  // The upload has ONE time limit, the launcher's, which answers only once the tool has exited. The
  // queue moves on only then: a late upload can never still be sending when the next one starts.
  assert.ok(LIVE_STEP_LIMIT_MS <= 10 * 60_000, 'the live step\'s limit is finite and under ten minutes')
  const module = readSource(join(repo, 'src/main/handout-publishing.ts'))
  const upload = module.slice(module.indexOf('async function uploadSite('), module.indexOf('async function run<Built>('))
  assert.ok(!/limited\(|setTimeout|UPLOAD_LIMIT/.test(upload), 'no second timer around the upload: nothing releases the queue before the tool has exited')
  const w = await connected()
  const exited = gate()
  // The tool is stopped at its limit: the launcher answers `timedOut`, and not before the process is gone.
  w.hooks.duringUpload = async () => { if (w.uploads.length === 1) { await exited.wait; w.hooks.toolResult = { ok: false, stdout: '', stderr: `stopped ${REPLY_TEXT_MARK}`, timedOut: true } } else { w.hooks.toolResult = null } }
  const stuck = w.publish('talk')
  const after = w.publish('run-unpublish')
  await until(() => w.uploads.length === 1)
  await soon(80)
  assert.deepEqual([w.uploads.length, w.log.filter((line) => line.startsWith('prepare')).length], [1, 1], 'while the first upload\'s tool has not exited, the next publish has not even begun')
  exited.open()
  const timedOut = await stuck
  assert.deepEqual([timedOut.ok, timedOut.error, timedOut.details.includes(REPLY_TEXT_MARK)], [false, PUBLISH_TIMED_OUT, true], 'an upload stopped at its limit is reported as too long, what the tool printed behind Details')
  assert.equal((await after).ok, true, 'and the publish waiting behind it runs, after it')
  assert.deepEqual(w.log.filter((line) => /^upload/.test(line)), ['upload:start', 'upload:end', 'upload:start', 'upload:end'], 'the two uploads never overlapped')
  assert.deepEqual(w.recorded, [{ entry: 'run-unpublish', name: 'run-a' }], 'the one that timed out recorded nothing')
  assert.equal(w.connection.status().publishing.state, 'ready', 'and it does not mark the row')
}
console.log('PASS 7: publishes of one site run one at a time, in order; a thrown, failed or stuck publish does not hold the next')

// ── 8. The loopback rule (D8) and the app's test mode ───────────────────────────────────────────
{
  assert.equal(localLiveAllowed({ packaged: false, flag: '1' }), true, 'an unpackaged build started with TW_LIVE_LOCAL=1')
  for (const context of [{ packaged: true, flag: '1' }, { packaged: false, flag: undefined }, { packaged: false, flag: '0' }, { packaged: false, flag: 'true' }, { packaged: false, flag: 1 }, { packaged: true, flag: undefined }]) {
    assert.equal(localLiveAllowed(context), false, `not allowed: ${JSON.stringify(context)}`)
  }
  assert.equal(liveAddressForPages(`${LIVE}//`), LIVE)
  for (const address of ['http://127.0.0.1:8787', 'http://localhost:8787/', 'ws://example.com', 'example.com', '', undefined, null, 42, 'file:///x', 'https://[::1]:8787']) {
    assert.equal(liveAddressForPages(address), '', `never put in a page as the live address: ${String(address)}`)
  }
  // (Read with LF line endings on every platform: a Windows checkout has CRLF.)
  const main = readSource(join(repo, 'src/main/index.ts'))
  const ensure = main.slice(main.indexOf('async function ensureLiveWorker('), main.indexOf('// ── Pre-work for a planned Run'))
  const starts = [...ensure.matchAll(/startLocalLiveWorker\(/g)].map((found) => found.index)
  assert.equal(starts.length, 2, 'the local service is started from two places in ensureLiveWorker')
  assert.ok(ensure.indexOf("if (!local) throw new LiveServiceError('not-set-up', LIVE_NOT_SET_UP)") < starts[0] && ensure.indexOf('if (local) return startLocalLiveWorker()') === starts[1] - 'if (local) return '.length, 'each only where local live is allowed')
  assert.ok(/const local = liveLocalAllowed\(\)/.test(ensure) && /function liveLocalAllowed\(\): boolean \{\s*return localLiveAllowed\(\{ packaged: app\.isPackaged, flag: process\.env\.TW_LIVE_LOCAL \}\)/.test(main), 'by the one rule: unpackaged and TW_LIVE_LOCAL=1')
  assert.equal(main.split('startLocalLiveWorker(').length - 1, 3, 'and from nowhere else (its definition and those two)')
  assert.ok(!/!readToken\(\) \|\| process\.env\.TW_LIVE_LOCAL/.test(main), 'a missing token no longer starts, or names, a service on this computer')
  const saved = main.slice(main.indexOf('function localHandoutWorkerBaseUrl('), main.indexOf('async function ensureLiveJoinUrl('))
  assert.ok(/if \(liveLocalAllowed\(\)\) return configured \|\| 'http:\/\/127\.0\.0\.1:8787'\s+return liveAddressForPages\(configured\)/.test(saved), 'a handout saved as a file carries the local address only where local live is allowed')
  assert.equal(main.split('127.0.0.1:8787').length - 1, 2, 'the local address is written in two places: that one and the local service\'s own default')

  // The app's test mode (TW_REC_TEST=1): nothing is asked of Cloudflare or uploaded, and the pages are still read.
  const w = world()
  w.rehearsal = { project: 'talkweaver-test' }
  w.live = async () => ({ baseUrl: 'http://127.0.0.1:8787' })
  const result = await w.publish('run')
  assert.deepEqual([result.ok, result.notice, w.uploads.length, w.api.requests.length, w.prepared[0].project, w.prepared[0].live], [true, PUBLISHED_WITHOUT_LIVE, 0, 0, 'talkweaver-test', ''], 'built, read, recorded; no leave asked and no upload; a local live address is still not published')
  assert.equal(w.recorded.length, 1)
  assert.equal((await w.publish('talk', { plant: `<script>\n  const LIVE_CONFIG = {"workerBaseUrl":"http://localhost:1","talkSlug":"t"}; ${APP_CONFIG_MARK}\n</script>` })).error, PUBLISH_LOOPBACK_REFUSED, 'the choke point holds in test mode too')
  assert.ok(/if \(app\.isPackaged \|\| process\.env\.TW_REC_TEST !== '1'\) return null/.test(main), 'and a packaged build has no test mode')
  console.log('PASS 8: a live service on this computer only unpackaged with TW_LIVE_LOCAL=1; never in a published page, nor in a saved one in a packaged build')
}

// ── 9. The live service's own set-up failures ───────────────────────────────────────────────────
// Set up with Cloudflare's API (ticket 11; scripts/test-live-service-upload.mjs has the whole
// sequence). Here: each failure is a sorted sentence, and Details carry no token, no key and no text
// of a Cloudflare reply, even when the reply quoted them.
{
  const KEYS = { adminSecret: 'made-up-admin-secret-0123456789', signingSecret: 'made-up-signing-secret-0123456789' }
  const files = workerDistFiles({ repo, bundle: Buffer.from('export default {}\n') })
  const deploy = async (failAt) => {
    const w = await connected()
    // Cloudflare's refusal quotes the token and both keys back, and its own text.
    w.api.model.answer = (request) => (failAt(request) ? { status: failAt(request), body: { success: false, errors: [{ code: failAt(request) === 403 ? 10000 : 10013, message: `refused ${REPLY_TEXT_MARK} token ${TOKEN} keys ${KEYS.adminSecret} ${KEYS.signingSecret}` }], messages: [], result: null } } : null)
    const result = see(await deployLiveService({
      shipped: () => ({ manifest: files.manifestText, bundle: files.bundle, config: files.configBytes }),
      expectedBuild: files.manifest.build,
      authorise: () => w.connection.authoriseLiveDeploy(),
      keys: singleKeyPort({ stored: { computerId: 'aaaa0000bbbb1111', adminSecret: KEYS.adminSecret } }, () => ({ computerId: 'aaaa0000bbbb1111', adminSecret: KEYS.adminSecret })),
      computerName: () => 'Test computer',
      liveFetch: async () => { throw new TypeError('fetch failed') }, live: { wait: async () => {}, requestMs: 2000, waitMs: 0 },
      fetch: fakeCloudflareFetch(w.api),
      apiBase: () => CLOUDFLARE_API_BASE,
      save: () => {},
      timeoutMs: { upload: 2000, request: 2000 },
    }))
    return result
  }
  const at = (method, status) => (request) => (request.method === method ? status : 0)
  const CASES = [
    ['the upload is refused for permission', at('PUT', 403), LIVE_SETUP_REFUSED],
    ['the upload fails', at('PUT', 400), LIVE_SETUP_FAILED],
    ['the keys cannot be set', at('PATCH', 500), LIVE_KEYS_FAILED],
    ['the keys are refused for permission', at('PATCH', 403), LIVE_SETUP_REFUSED],
  ]
  for (const [what, failAt, sentence] of CASES) {
    const result = await deploy(failAt)
    assert.deepEqual([result.ok, result.error], [false, sentence], `${what}: the sorted sentence`)
    assert.match(result.details, /^(?:Uploading the live service|Adding this computer's key): Cloudflare answered \d{3} \(error \d+\)\.$/, `${what}: Details say the step and the answer in numbers`)
    for (const secret of [TOKEN, KEYS.adminSecret, KEYS.signingSecret, REPLY_TEXT_MARK]) assert.ok(!result.details.includes(secret) && !result.error.includes(secret), `${what}: no token, no key and no reply text in the message or in Details`)
  }
  assert.ok(LIVE_SETUP_REFUSED.includes('The token cannot run the live service') && LIVE_SETUP_REFUSED.includes(WORKERS_PERMISSION), 'the refusal names the permission')
  assert.equal(publishedWithoutLiveText(null), 'Published. Going live is not set up: Settings → Cloudflare')
  assert.equal(publishedWithoutLiveText(LIVE_SETUP_FAILED), 'Published. Going live is not set up: Settings → Cloudflare. The live service could not be set up.')
  assert.ok(KEY_REMOVED && TOKEN_REMOVED, 'what stands in for a key or the token, should either ever reach Details')
  console.log('PASS 9: live-service set-up and key failures are sorted; Details hold no token, no key and no reply text')
}

// ── Nothing secret anywhere a window or a caller could see ──────────────────────────────────────
{
  const seen = JSON.stringify(observed)
  for (const token of ALL_TOKENS) assert.ok(!seen.includes(token), 'no token in any result, status or reply of this whole run')
  assert.ok(observed.length > 500, 'and there was plenty to search')
}
rmSync(scratch, { recursive: true, force: true })
console.log('handout publishing: entry points, published output, live never fails a publish, one connection, no raw text, row state, order and limits, the loopback rule — passed')

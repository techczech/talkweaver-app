import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// The REAL publishing sequence (src/main/handout-publishing.ts) over ports that always give leave:
// for tests of what the publish handlers build, which lift those handlers out of the main process
// and need a `handoutPublishing()` to call. The change is merged and "deployed" into the fake
// Cloudflare model in memory (scripts/lib/cloudflare-api-stub.mjs, no network); `onUpload` sees each
// deployment as the model keeps it. The sequence itself, and every way leave is refused or lost, is
// tested in scripts/test-handout-publishing.mjs and scripts/test-per-talk-publishing.mjs.
import { createHandoutPublishing } from '../../src/main/handout-publishing.ts'
import { loadWranglerBlake3, loadWranglerMime, pagesAssetHash } from '../../src/main/pages-direct-upload.ts'
import { NO_PRODUCTION_REVISION } from '../../src/main/publishing-inventory.ts'
import { SITE_RECORD_PATH } from '../../src/main/site-record.ts'
import { publicationBinding } from '../../src/main/publication-preservation.ts'
import { createFakeCloudflare, fakeCloudflareFetch } from './cloudflare-api-stub.mjs'

// Test metadata lives outside output fixtures, as production metadata lives outside the site.
const coordinationRoot = mkdtempSync(join(tmpdir(), 'tw-publishing-fakes-'))
process.once('exit', () => rmSync(coordinationRoot, { recursive: true, force: true }))
const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const blake3 = loadWranglerBlake3(repo)
/** wrangler's own content types. */
export const wranglerContentType = loadWranglerMime(repo)
/** The stand-in's address: only ever handed to the in-memory fetch below, which never opens a connection. */
const STAND_IN = 'http://127.0.0.1:9/client/v4'

/**
 * For tests written when the site folder on this computer WAS the site: make what `dir` holds the site's production deployment
 * (as if it had been deployed from there), unless the production deployment already has exactly those files. The redirect file
 * goes with it as the deployment's own. The site record, which this computer never keeps, stays as the live site has it.
 * `publishedFrom`: the preservation folder of the computer that "deployed" it: its publication record is written, as the
 * preservation guard writes it after an accepted publish (what lets that computer make the site's first record).
 */
export function seedLiveFromFolder(api, account, project, dir, publishedFrom) {
  const files = {}
  const bytes = {}
  const walk = (folder, prefix) => {
    for (const name of readdirSync(folder).sort()) {
      if (name === '.DS_Store' || name === '.wrangler' || (prefix === '' && (name === '_redirects' || name === '_headers'))) continue
      const full = join(folder, name)
      const stat = lstatSync(full)
      if (stat.isDirectory()) walk(full, `${prefix}/${name}`)
      else if (stat.isFile()) { const content = readFileSync(full); const path = `${prefix}/${name}`; files[path] = pagesAssetHash(blake3, content, path); bytes[files[path]] = content }
    }
  }
  if (existsSync(dir)) walk(dir, '')
  const live = { ...(api.production(account, project)?.files ?? {}) }
  const record = live[SITE_RECORD_PATH]
  delete live[SITE_RECORD_PATH]
  const same = Object.keys(live).length === Object.keys(files).length && Object.entries(files).every(([path, hash]) => live[path] === hash)
  if (same) return
  const redirects = existsSync(join(dir, '_redirects')) ? readFileSync(join(dir, '_redirects'), 'utf8') : ''
  const made = api.seed(account, project, { files: { ...files, ...(record ? { [SITE_RECORD_PATH]: record } : {}) }, bytes, redirects })
  // The receipt names the redirect file that went live, as the preservation guard records it.
  if (publishedFrom) writePublicationRecord(publishedFrom, `cf-pages:${account}:${project}`, made.id, { controls: redirects ? { '/_redirects': publicationBinding([['/_redirects', createHash('sha256').update(redirects).digest('hex')]]) } : {} })
}

/** The preservation guard's record of an accepted publish (`<binding>.controls.json`), as it writes it. */
export function writePublicationRecord(root, site, revision, extra = {}) {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, publicationBinding(site) + '.controls.json'), JSON.stringify({ site, revision, controls: {}, published: true, ...extra }))
}

/** One stand-in site per site folder, kept across publishes as Cloudflare keeps a site. */
const sites = new Map()

/** A live address somebody else could open (never one on this computer: that is never published). */
export const FAKE_LIVE_ADDRESS = 'https://live.example.test'

/**
 * `supersede`: when the connection changes under the publish. `during-upload`: while the upload runs
 * (its result is then not handed back). `after-upload`: the moment the upload has completed.
 * `registry` / `shortLinks`: this computer's caches, when the test needs them read back.
 */
export function grantedPublishing({ siteDir, project = 'talks', live = async () => ({ baseUrl: FAKE_LIVE_ADDRESS }), onUpload = () => {}, supersede = 'never', registry, shortLinks }) {
  let current = true
  const account = 'acct'
  const api = sites.get(`${siteDir}\n${project}`) ?? createFakeCloudflare({ accountSites: { [account]: [project] }, pagesDeployments: { [account]: { [project]: { neverDeployed: true } } } })
  sites.set(`${siteDir}\n${project}`, api)
  let seeded = false
  const send = fakeCloudflareFetch(api)
  const transport = async (address, init) => {
    const response = await send(address, init)
    if ((init?.method ?? 'GET') === 'POST' && String(address).endsWith('/deployments') && response.status === 200) onUpload(api.production(account, project))
    return response
  }
  const publishing = createHandoutPublishing({
    siteDir: () => siteDir,
    preservationRoot: join(coordinationRoot, createHash('sha256').update(siteDir).digest('hex')),
    inventory: async () => {
      // Each publish finds the site as this test's site folder holds it (the folder was the site when these tests were written).
      if (!seeded) { seedLiveFromFolder(api, account, project, siteDir, join(coordinationRoot, createHash('sha256').update(siteDir).digest('hex'))); seeded = true }
      const production = api.production(account, project)
      const files = Object.entries(production?.files ?? {})
      return { complete: true, site: `cf-pages:${account}:${project}`, revision: production?.id ?? NO_PRODUCTION_REVISION, paths: files.map(([path]) => path), files }
    },
    authorise: async () => (seeded = false, {
      ok: true,
      authorisation: {
        accountId: account, project, productionBranch: 'main', current: () => current,
        run: async (launch) => {
          const result = await launch({ CLOUDFLARE_API_TOKEN: 'made-up-token-for-tests', CLOUDFLARE_ACCOUNT_ID: account })
          if (supersede !== 'never') current = false
          return supersede === 'during-upload' ? { superseded: true } : { superseded: false, result }
        },
        clean: (text) => String(text), refusedForPermission() {}, published() {},
      },
    }),
    live,
    bundlingHazard: () => null,
    pages: () => ({ fetch: transport, apiBase: STAND_IN, allowLoopbackForTests: true, sleep: async () => {}, contentType: wranglerContentType }),
    blake3: () => blake3,
    // This computer's registry (an empty one kept in memory unless the test gives its own).
    registry: registry ?? (() => { let kept = {}; return { read: () => ({ ...kept }), write: (next) => { kept = { ...next } } } })(),
    ...(shortLinks ? { shortLinks } : {}),
  })
  return Object.assign(publishing, { api })
}

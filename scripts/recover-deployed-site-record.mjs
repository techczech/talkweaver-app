// Recover a legacy site's shared record from its explicitly trusted, clean deployed Git source.
// Default is read-only. --apply is for the owner/authorised manager, never this investigation.
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, hostname, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createHandoutPublishing } from '../src/main/handout-publishing.ts'
import { readPublishingInventory } from '../src/main/publishing-inventory.ts'
import { buildRedirects } from '../src/main/publishing-logic.ts'
import { manifestFolders, parseSiteRecord, serialiseSiteRecord, SITE_RECORD_PATH } from '../src/main/site-record.ts'
import { publicationBinding } from '../src/main/publication-preservation.ts'
import { loadWranglerBlake3, loadWranglerMime, pagesAssetHash, readLiveAsset, siteAssetAddresses } from '../src/main/pages-direct-upload.ts'
import { testNetworkPermit, permittedOverride } from '../src/main/test-network-guard.ts'
import { standInApiBase } from '../src/main/cloudflare-connection.ts'

class CheckedStop extends Error {}
const stop = message => { throw new CheckedStop(message) }
async function main() {
  const args = process.argv.slice(2)
  if (args.length !== 4 || !['--check', '--apply'].includes(args[0]) || !/^[a-f0-9]{40}$/u.test(args[2]) || !/^[a-z0-9-]+$/u.test(args[3])) stop('Use --check|--apply <trusted-site-repository> <deployed-commit> <Pages-project>.')
  const [mode, rawRepo, commit, project] = args
  const source = resolve(rawRepo)
  const appRepo = dirname(dirname(fileURLToPath(import.meta.url)))
  const testProfile = process.env.TW_E2E_USER_DATA_DIR
  const userData = testProfile ?? join(homedir(), 'Library/Application Support/talk-weaver')
  const permit = testNetworkPermit({ packaged: false, env: process.env, userData, tempDirs: [tmpdir()],
    realpath: path => { try { return realpathSync(path) } catch { return null } }, readMarker: path => { try { return readFileSync(path, 'utf8') } catch { return null } } })
  if (permit.state === 'refused') stop('The test network override was refused for this profile.')
  if (testProfile && permit.state !== 'granted') stop('A test profile requires the granted loopback network guard.')
  const standIn = standInApiBase({ packaged: false, e2e: permit.state === 'granted', override: permittedOverride(permit, process.env, 'TW_E2E_CLOUDFLARE_API_BASE_URL') })
  if (permit.state === 'granted' && !standIn) stop('The test API address is invalid.')
  const apiBase = standIn ?? 'https://api.cloudflare.com/client/v4'
  const cfg = JSON.parse(readFileSync(join(userData, 'config.json'), 'utf8'))
  const accountId = cfg.cfAccountId, token = process.env.CLOUDFLARE_API_TOKEN
  if (typeof accountId !== 'string' || !token) stop('The configured account or runtime credential is unavailable.')
  const auth = { accountId, project, productionBranch: 'main', current: () => true,
    run: async launch => ({ superseded: false, result: await launch({ CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId }) }),
    clean: value => String(value).split(token).join('[concealed]'), refusedForPermission() {}, published() {} }
  const response = await fetch(`${apiBase}/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(project)}`, {
    method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) stop('The selected project could not be read. Nothing was sent.')
  const envelope = await response.json(), production = envelope.result?.canonical_deployment
  const meta = production?.deployment_trigger?.metadata
  if (envelope.success !== true || meta?.commit_hash !== commit || meta?.commit_dirty !== false) stop('Production does not attest this exact clean source commit. Nothing was sent.')
  const inventory = await readPublishingInventory(auth, standIn)
  if (!inventory?.files || inventory.revision !== production.id) stop('Production moved or its complete inventory was unavailable. Nothing was sent.')
  if (inventory.files.some(([p]) => p === SITE_RECORD_PATH)) stop('A shared record is already present. Check it through the app; this recovery will not replace it.')
  const git = (...argv) => execFileSync('git', ['-C', source, ...argv], { maxBuffer: 32 * 1024 * 1024, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] })
  if (git('rev-parse', `${commit}^{commit}`).toString().trim() !== commit) stop('The trusted source commit is unavailable.')
  const redirects = git('show', `${commit}:public/_redirects`).toString('utf8')
  const headers = git('show', `${commit}:public/_headers`).toString('utf8')
  const liveRegistry = {}
  for (const line of redirects.split('\n')) {
    const fields = line.trim().split(/\s+/u)
    if (!/^\/[a-z0-9]{4}$/u.test(fields[0])) continue
    const target = /^\/([^/]+)\/$/u.exec(fields[1] ?? '')
    if (!target || fields.length !== 3 || fields[2] !== '302') stop('The deployed redirect table needs a different recovery format.')
    const folder = decodeURIComponent(target[1]), id = fields[0].slice(1)
    if (Object.hasOwn(liveRegistry, folder) || Object.values(liveRegistry).includes(id)) stop('The deployed redirect table has ambiguous short-link ownership.')
    liveRegistry[folder] = id
  }
  const folders = manifestFolders(inventory.files.map(([p]) => p))
  const registry = { ...liveRegistry }
  const blake3 = loadWranglerBlake3(appRepo)
  // A later full-folder writer can delete the record. Recover reservations from the site's history,
  // including allocations that exist on neither of the person's current Macs.
  const listed = await fetch(`${apiBase}/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(project)}/deployments?env=production&per_page=25`, {
    method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
  })
  if (!listed.ok) stop('The site history could not be checked for retained short-link ids. Nothing was sent.')
  const history = await listed.json()
  if (history.success !== true || !Array.isArray(history.result)) stop('The site history could not be read. Nothing was sent.')
  let previousRecordRevision = null, retainedHistoricalIds = 0
  const reserve = entries => {
    let kept = 0
    for (const [folder, id] of entries) {
      if (typeof id === 'string' && !folders.includes(folder) && !Object.hasOwn(registry, folder) && !Object.values(registry).includes(id)) { registry[folder] = id; kept++ }
    }
    return kept
  }
  for (const prior of history.result) {
    if (prior.id === inventory.revision || prior.environment !== 'production' || prior.latest_stage?.status !== 'success' || !/^[a-f0-9-]{36}$/u.test(prior.id ?? '')) continue
    const detailResponse = await fetch(`${apiBase}/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(project)}/deployments/${prior.id}`, {
      method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
    })
    if (!detailResponse.ok) stop('A previous deployment could not be checked. Nothing was sent.')
    const detail = await detailResponse.json(), hash = detail.result?.files?.[SITE_RECORD_PATH]
    if (!hash) continue
    if (detail.success !== true || detail.result.id !== prior.id || detail.result.environment !== 'production' || !/^[a-f0-9]{32}$/u.test(hash)) stop('A previous site record has invalid provenance. Nothing was sent.')
    const transport = { fetch, ...(standIn ? { apiBase: standIn, allowLoopbackForTests: true } : {}) }
    const bytes = await readLiveAsset(transport, blake3, siteAssetAddresses(transport, { id: prior.id, url: detail.result.url }, SITE_RECORD_PATH), SITE_RECORD_PATH, hash)
    const parsed = bytes ? parseSiteRecord(bytes) : null
    if (!parsed?.ok) stop('The previous shared record is unreadable or needs a newer app. Nothing was sent.')
    retainedHistoricalIds = reserve(Object.entries(parsed.record.registry)); previousRecordRevision = prior.id
    break
  }
  // Only already-public routing/history is authority. A local-only draft allocation is private.
  if (buildRedirects(registry, folders) !== redirects) stop('The shared record cannot reproduce the deployed redirects byte for byte. Nothing was sent.')
  const record = { registry, shortLinks: true, headers, publishedBy: hostname().replace(/\.local$/, '') }
  if (!parseSiteRecord(serialiseSiteRecord(record)).ok) stop('The recovered site record is not valid. Nothing was sent.')
  const manifest = new Map(inventory.files)
  const entries = git('ls-tree', '-r', '-z', '--long', commit, '--', 'public').toString().split('\0').filter(Boolean).map(row => {
    const [info, path] = row.split('\t'), parts = info.trim().split(/\s+/u)
    return { type: parts[1], oid: parts[2], size: Number(parts[3]), path: '/' + path.slice('public/'.length) }
  }).filter(file => !['/_redirects', '/_headers'].includes(file.path))
  if (entries.length !== manifest.size || entries.some(f => f.type !== 'blob' || !manifest.has(f.path) || f.size > 25 * 1024 * 1024)) stop('The committed source and production do not contain the same safe file set. Nothing was sent.')
  let bytes = 0
  for (const file of entries) {
    const content = git('cat-file', 'blob', file.oid)
    if (pagesAssetHash(blake3, content, file.path) !== manifest.get(file.path)) stop('A committed source file differs from production. Nothing was sent.')
    bytes += content.length
  }
  const checkedAgain = await readPublishingInventory(auth, standIn)
  if (!checkedAgain || checkedAgain.revision !== inventory.revision) stop('Production changed during verification. Nothing was sent.')
  const digest = (path, text) => text ? publicationBinding([[path, createHash('sha256').update(text).digest('hex')]]) : undefined
  const controls = Object.fromEntries([['/_redirects', digest('/_redirects', redirects)], ['/_headers', digest('/_headers', headers)]].filter(([,value]) => value !== undefined))
  const proof = { format: 'talkweaver-site-recovery', version: 1, site: inventory.site, revision: inventory.revision, record, controls }
  console.log(JSON.stringify({ checkedProject: project, accountId, production: inventory.revision, deployedCommit: commit,
    matchedFiles: entries.length, matchedBytes: bytes, liveShortIds: Object.keys(liveRegistry).length, redirectRoutes: redirects.trim().split('\n').length,
    previousRecordRevision, retainedHistoricalIds, recordIds: Object.keys(registry).length, plan: { add: SITE_RECORD_PATH, rebuiltPages: 0, withdrawnPaths: 0, reissuedLiveIds: 0, redirectBytesChanged: 0, headerBytesChanged: 0 } }))
  console.log('Routing inputs are trusted from the attested clean deployed source; Cloudflare does not return their original text. All ordinary production asset hashes match that source.')
  if (mode === '--check') { console.log('Read-only verification complete. The authorised manager may run the same command with --apply in a quiet publishing window.'); return }
  const scratch = mkdtempSync(join(tmpdir(), 'tw-deployed-source-recovery-'))
  try {
    const service = createHandoutPublishing({ siteDir: () => join(scratch, 'cache'), stagingRoot: () => scratch,
      ...(standIn ? { preservationRoot: join(userData, 'publication-coordination') } : {}),
      inventory: a => readPublishingInventory(a, standIn), authorise: async () => ({ ok: true, authorisation: auth }),
      live: async () => { throw Error('Record-only recovery cannot start live services') }, bundlingHazard: () => null,
      pages: () => ({ fetch, ...(standIn ? { apiBase: standIn, allowLoopbackForTests: true } : {}), publicBase: cfg.publishBaseUrl, contentType: loadWranglerMime(appRepo) }), blake3: () => blake3,
      registry: { read: () => ({ ...registry }), write: next => { if (JSON.stringify(next) !== JSON.stringify(registry)) throw Error('Unexpected registry mutation') }, origin: () => ({ state: 'none' }) },
      headers: () => headers, shortLinks: { read: () => true, write: () => {} }, computerName: () => record.publishedBy })
    const result = await service.publish({ entry: 'site-adoption', siteRecovery: proof, prepare: async () => ({ ok: true, built: null }) })
    if (!result.ok) stop('Record-only publication was not confirmed. Check production before trying again; do not bypass its recovery journal.')
    const after = await readPublishingInventory(auth, standIn), afterFiles = new Map(after?.files ?? [])
    if (afterFiles.size !== manifest.size + 1 || !afterFiles.has(SITE_RECORD_PATH) || [...manifest].some(([p,h]) => afterFiles.get(p) !== h)) stop('Read-back differs from the approved record-only plan. Inspect production before any retry.')
    console.log(`Confirmed ${after.revision}: only the shared site record was added; every previous file hash was kept.`)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error instanceof CheckedStop ? error.message : 'Recovery could not be checked or confirmed. No credential or raw remote error is printed. Check the site before any retry.'); process.exitCode = 1 })

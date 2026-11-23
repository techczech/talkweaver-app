// Record-only migration. Default: read-only check. Run --apply only with the owner's live-write authorisation.
// Receives ONE Cloudflare token at runtime; never reads TalkWeaver's secret store or starts Electron.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, hostname, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createHandoutPublishing } from '../src/main/handout-publishing.ts'
import { readPublishingInventory } from '../src/main/publishing-inventory.ts'
import { buildRedirects, resolveSiteDir } from '../src/main/publishing-logic.ts'
import { manifestFolders, parseSiteRecord, serialiseSiteRecord, SITE_RECORD_PATH } from '../src/main/site-record.ts'
import { publicationBinding, readPublicationRecord } from '../src/main/publication-preservation.ts'
import { loadWranglerBlake3, loadWranglerMime, readLiveAsset, siteAssetAddresses } from '../src/main/pages-direct-upload.ts'

async function main() {
  const args = process.argv.slice(2)
  const exporting = args[0] === '--export' && args.length === 2
  if (!exporting && (args.length > 1 || (args.length && !['--check', '--apply'].includes(args[0])))) throw Error('Use --check, --apply, or --export <new-file.json>.')
  const token = process.env.CLOUDFLARE_API_TOKEN
  if (!token) throw Error('Supply the Cloudflare token through bws_manager.py run. No token store is read.')
  const data = join(homedir(), 'Library/Application Support/talk-weaver')
  const config = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'))
  const { cfAccountId: accountId, cfPagesProject: project } = config
  if (typeof accountId !== 'string' || typeof project !== 'string') throw Error('The Pro has no publishing account and project configured.')
  const authorisation = { accountId, project, productionBranch: config.publishProdBranch || 'main', current: () => true,
    run: async launch => ({ superseded: false, result: await launch({ CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId }) }),
    clean: value => String(value).split(token).join('[concealed]'), refusedForPermission() {}, published() {} }
  const inventory = await readPublishingInventory(authorisation)
  if (!inventory?.complete || !inventory.files) throw Error('The complete live inventory could not be read. Nothing changed.')
  const existing = inventory.files.find(([path]) => path === SITE_RECORD_PATH)
  if (existing) {
    const repo = dirname(dirname(fileURLToPath(import.meta.url)))
    const transport = { fetch, publicBase: config.publishBaseUrl }
    const bytes = await readLiveAsset(transport, loadWranglerBlake3(repo), siteAssetAddresses(transport, { id: inventory.revision, url: inventory.deploymentUrl }, SITE_RECORD_PATH), SITE_RECORD_PATH, existing[1])
    if (!bytes || !parseSiteRecord(bytes).ok) throw Error('The existing site record could not be verified. Inspect it before publishing on the Air.')
    console.log('The site already has a readable, hash-verified record. No deployment was created; use the app to publish on the Air.')
    return
  }
  const registry = JSON.parse(readFileSync(join(data, 'handout-registry.json'), 'utf8'))
  const siteDir = resolveSiteDir(data, config.publishSiteDir)
  // Required rather than silently substituting an empty file. Missing controls need investigation.
  const headers = readFileSync(join(siteDir, '_headers'), 'utf8')
  const record = { registry, shortLinks: config.publishUseShortIds === true, headers, publishedBy: hostname().replace(/\.local$/, '') }
  if (!parseSiteRecord(serialiseSiteRecord(record)).ok) throw Error('The Pro registry is invalid or has duplicate short ids. Nothing changed.')
  const receipt = readPublicationRecord(inventory.site)
  if (!receipt || !(receipt.revision === inventory.revision || (receipt.candidateDigest && receipt.candidateDigest === inventory.candidateDigest))) throw Error('The Pro receipt does not match production. Nothing changed; investigate before recovery.')
  const redirects = buildRedirects(registry, manifestFolders(inventory.files.map(([path]) => path)))
  const digest = (name, text) => text ? publicationBinding([[name, createHash('sha256').update(text).digest('hex')]]) : undefined
  for (const [name, text] of [['/_redirects', redirects], ['/_headers', headers]]) {
    if (digest(name, text) !== receipt.controls[name]) throw Error(`The Pro copy of ${name} differs from the published receipt. Nothing changed.`)
  }
  console.log(`Checked site ${project}, deployment ${inventory.revision}.`)
  console.log(`Plan: add ${SITE_RECORD_PATH}; keep ${inventory.files.length} file hashes, ${Object.keys(registry).length} short-link ids and exact redirects/headers. Rebuild 0 pages, withdraw 0 pages, reissue 0 ids.`)
  if (exporting) {
    writeFileSync(args[1], JSON.stringify({ format: 'talkweaver-site-recovery', version: 1, site: inventory.site, revision: inventory.revision,
      ...(inventory.candidateDigest ? { candidateDigest: inventory.candidateDigest } : {}), record, controls: receipt.controls }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    console.log('Exported the non-secret recovery record. Production was not changed. Import it on the other Mac and review its preview.')
    return
  }
  if (args[0] !== '--apply') { console.log('Read-only check complete. Run the same command with --apply to perform this plan.'); return }
  const scratch = mkdtempSync(join(tmpdir(), 'tw-record-recovery-'))
  try {
    const repo = dirname(dirname(fileURLToPath(import.meta.url)))
    const publishing = createHandoutPublishing({ siteDir: () => join(scratch, 'cache'), stagingRoot: () => scratch,
      inventory: a => readPublishingInventory(a), authorise: async () => ({ ok: true, authorisation }),
      live: async () => { throw Error('Record-only migration must never start the live service') }, bundlingHazard: () => null,
      pages: () => ({ fetch, publicBase: config.publishBaseUrl, contentType: loadWranglerMime(repo) }), blake3: () => loadWranglerBlake3(repo),
      registry: { read: () => ({ ...registry }), write: next => { if (JSON.stringify(next) !== JSON.stringify(registry)) throw Error('Record-only migration must not change the registry') } },
      shortLinks: { read: () => record.shortLinks, write: () => { throw Error('Record-only migration must not change link style') } },
      headers: () => headers, computerName: () => record.publishedBy,
    })
    const result = await publishing.publish({ entry: 'live-short-link', prepare: async () => ({ ok: true, built: null }) })
    if (!result.ok) throw Error(result.error)
    const after = await readPublishingInventory(authorisation)
    if (!after?.complete || !after.files) throw Error('Upload returned success but read-back failed. Do not retry blindly; inspect production.')
    const beforeFiles = new Map(inventory.files)
    const afterFiles = new Map(after.files)
    if (!afterFiles.has(SITE_RECORD_PATH) || afterFiles.size !== beforeFiles.size + 1 || [...beforeFiles].some(([path, hash]) => afterFiles.get(path) !== hash)) throw Error('Read-back did not match the record-only plan. Inspect production; do not retry blindly.')
    console.log(`Confirmed deployment ${after.revision}: only the shared record was added. Existing file hashes are unchanged.`)
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}
main().catch(() => { console.error('Record recovery stopped. Check the read-only preflight, matching Pro receipt, configured site and token permissions. No token or remote error text is printed.'); process.exitCode = 1 })

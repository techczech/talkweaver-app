import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startCloudflareApiStub } from './lib/cloudflare-api-stub.mjs'
import { loadWranglerBlake3, pagesAssetHash } from '../src/main/pages-direct-upload.ts'
import { buildRedirects } from '../src/main/publishing-logic.ts'
import { SITE_RECORD_PATH, parseSiteRecord, serialiseSiteRecord } from '../src/main/site-record.ts'
import { TEST_PROFILE_MARKER_FILE } from '../src/main/test-network-guard.ts'
const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const account = '01'.repeat(16), project = 'handouts'
const syntheticCredential = randomUUID()
const blake3 = loadWranglerBlake3(repo)
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'tw-deployed-source-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const source = join(root, 'source'), profile = join(root, 'profile')
  mkdirSync(join(source, 'public', 'older-talk-aaaa'), { recursive: true }); mkdirSync(profile)
  const contents = { '/older-talk-aaaa/index.html': '<!doctype html><p>Existing synthetic handout</p>', '/index.html': '<!doctype html><p>Existing index</p>' }
  const redirects = buildRedirects({ 'older-talk-aaaa': 'aaaa' }, ['older-talk-aaaa'])
  const headers = 'https://:project.pages.dev/*\n  X-Robots-Tag: noindex\n'
  for (const [path, text] of Object.entries(contents)) writeFileSync(join(source, 'public', path.slice(1)), text)
  writeFileSync(join(source, 'public/_redirects'), redirects); writeFileSync(join(source, 'public/_headers'), headers)
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }).trim()
  git('init'); git('config', 'user.name', 'Synthetic fixture'); git('config', 'user.email', 'fixture@example.invalid')
  git('add', 'public'); git('commit', '-m', 'Keep synthetic deployed inputs')
  const commit = git('rev-parse', 'HEAD')
  const files = Object.fromEntries(Object.entries(contents).map(([path, text]) => [path, pagesAssetHash(blake3, Buffer.from(text), path)]))
  const assets = Object.fromEntries(Object.entries(contents).map(([path, text]) => [files[path], Buffer.from(text)]))
  const api = await startCloudflareApiStub({ accounts: [{ id: account, name: 'Fixture' }], tokens: { [syntheticCredential]: { accounts: [account] } },
    accountSites: { [account]: [project] }, pagesDeployments: { [account]: { [project]: { files } } }, pagesAssets: assets })
  t.after(() => api.close())
  const production = api.production(account, project)
  Object.assign(production.deployment_trigger.metadata, { commit_hash: commit, commit_dirty: false })
  production.redirects = redirects; production.headers = headers
  const marker = 'synthetic-publish-recovery-profile'
  writeFileSync(join(profile, TEST_PROFILE_MARKER_FILE), marker)
  writeFileSync(join(profile, 'config.json'), JSON.stringify({ cfAccountId: account, cfPagesProject: project, publishBaseUrl: 'https://handouts.invalid' }))
  const cached = { 'older-talk': 'aaaa', 'future-talk': 'bbbb' }
  writeFileSync(join(profile, 'handout-registry.json'), JSON.stringify(cached))
  const run = (mode, envPatch = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', join(repo, 'scripts/recover-deployed-site-record.mjs'), mode, source, commit, project], {
      env: { ...process.env, CLOUDFLARE_API_TOKEN: syntheticCredential, TW_E2E: '1', TW_E2E_CLOUDFLARE_API_BASE_URL: api.baseUrl,
        TW_E2E_PROFILE_MARKER: marker, TW_E2E_USER_DATA_DIR: profile, ...envPatch }, stdio: ['ignore', 'pipe', 'pipe'], cwd: repo,
    })
    let output = ''; child.stdout.on('data', b => { output += b }); child.stderr.on('data', b => { output += b })
    const timeout = setTimeout(() => child.kill('SIGTERM'), 30000)
    child.once('error', reject); child.once('close', code => { clearTimeout(timeout); resolve({ code, output }) })
  })
  return { api, production, files, redirects, headers, profile, cached, run, deployed: () => api.production(account, project),
    posts: () => api.requests.filter(r => r.method === 'POST' && r.path.endsWith('/deployments')) }
}
test('the deployed-source CLI checks without writes, then adds only the record with live and reserved ids retained', async t => {
  const w = await fixture(t)
  const historical = serialiseSiteRecord({ registry: { 'older-talk-aaaa': 'aaaa', 'future-talk': 'bbbb' }, shortLinks: true, headers: w.headers })
  const historicalHash = pagesAssetHash(blake3, Buffer.from(historical), SITE_RECORD_PATH)
  w.api.seed(account, project, { files: { ...w.files, [SITE_RECORD_PATH]: historicalHash }, bytes: { [historicalHash]: historical } })
  const latest = w.api.seed(account, project, { files: w.files, redirects: w.redirects, headers: w.headers })
  Object.assign(latest.deployment_trigger.metadata, w.production.deployment_trigger.metadata)
  const checked = await w.run('--check')
  assert.equal(checked.code, 0, checked.output); assert.equal(w.posts().length, 0)
  assert.ok(w.api.requests.every(r => r.method === 'GET'))
  const result = await w.run('--apply')
  assert.equal(result.code, 0, result.output); assert.equal(w.posts().length, 1)
  const after = { ...w.deployed().files }, recordHash = after[SITE_RECORD_PATH]; delete after[SITE_RECORD_PATH]
  assert.deepEqual(after, w.files); assert.equal(w.deployed().redirects, w.redirects); assert.equal(w.deployed().headers, w.headers)
  const parsed = parseSiteRecord(w.api.model.assets.get(recordHash).bytes); assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.record.registry, { 'older-talk-aaaa': 'aaaa', 'future-talk': 'bbbb' })
  assert.deepEqual(JSON.parse(readFileSync(join(w.profile, 'handout-registry.json'), 'utf8')), w.cached, 'real app caches are not rewritten by recovery')
  assert.equal(result.output.includes(syntheticCredential), false)
})
test('a deployment marked dirty cannot be adopted from an alleged clean Git source', async t => {
  const w = await fixture(t); w.production.deployment_trigger.metadata.commit_dirty = true
  const result = await w.run('--apply')
  assert.equal(result.code, 1); assert.match(result.output, /exact clean source commit/); assert.equal(w.posts().length, 0)
  assert.deepEqual(w.deployed().files, w.files)
})
test('a differing production asset refuses recovery before any deployment', async t => {
  const w = await fixture(t); w.production.files['/index.html'] = 'a'.repeat(32)
  const before = { ...w.deployed().files }, result = await w.run('--apply')
  assert.equal(result.code, 1); assert.match(result.output, /source file differs from production/); assert.equal(w.posts().length, 0)
  assert.deepEqual(w.deployed().files, before)
})
test('an unrecognised test profile is refused before any network request', async t => {
  const w = await fixture(t)
  const result = await w.run('--apply', { TW_E2E_PROFILE_MARKER: 'different-synthetic-profile-marker' })
  assert.equal(result.code, 1); assert.match(result.output, /test network override was refused/)
  assert.equal(w.api.requests.length, 0); assert.deepEqual(w.deployed().files, w.files)
})
test('recovery keeps allocations from the last shared record even when this Mac never had them', async t => {
  const w = await fixture(t)
  const historical = serialiseSiteRecord({ registry: { 'older-talk-aaaa': 'aaaa', 'remote-only-talk': 'cccc' }, shortLinks: true, headers: w.headers })
  const hash = pagesAssetHash(blake3, Buffer.from(historical), SITE_RECORD_PATH)
  w.api.seed(account, project, { files: { ...w.files, [SITE_RECORD_PATH]: hash }, bytes: { [hash]: historical } })
  const latest = w.api.seed(account, project, { files: w.files, redirects: w.redirects, headers: w.headers })
  Object.assign(latest.deployment_trigger.metadata, w.production.deployment_trigger.metadata)
  const result = await w.run('--apply')
  assert.equal(result.code, 0, result.output)
  const recordHash = w.deployed().files[SITE_RECORD_PATH]
  const parsed = parseSiteRecord(w.api.model.assets.get(recordHash).bytes)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.record.registry['remote-only-talk'], 'cccc')
  assert.equal(parsed.record.registry['future-talk'], undefined, 'a local-only unpublished allocation is not public site authority')
  assert.equal(w.deployed().redirects, w.redirects, 'inactive reservations add no live routes')
})
test('recovery never publishes the name or id of an unpublished local-only draft', async t => {
  const w = await fixture(t)
  const result = await w.run('--apply')
  assert.equal(result.code, 0, result.output)
  const bytes = w.api.model.assets.get(w.deployed().files[SITE_RECORD_PATH]).bytes
  const parsed = parseSiteRecord(bytes)
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.record.registry, { 'older-talk-aaaa': 'aaaa' })
  assert.equal(bytes.toString().includes('future-talk'), false)
  assert.equal(bytes.toString().includes('bbbb'), false)
  assert.deepEqual(JSON.parse(readFileSync(join(w.profile, 'handout-registry.json'), 'utf8')), w.cached)
})

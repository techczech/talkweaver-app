import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, realpathSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createCloudflareConnection } from '../src/main/cloudflare-connection.ts'
import { buildHandoutPages } from '../src/main/handout-pages.ts'
import { createHandoutPublishing } from '../src/main/handout-publishing.ts'
import { outlineIdentity } from '../src/main/outline-identity.ts'
import { loadWranglerBlake3, loadWranglerMime } from '../src/main/pages-direct-upload.ts'
import { createPublishHistory } from '../src/main/publish-history.ts'
import { readPublishingInventory } from '../src/main/publishing-inventory.ts'
import { publishConnectionFailure, publishFromRunningApp, runPublishCli, resolvePublishTalk } from '../src/main/publish-cli.ts'
import { forwardPublish, listenForPublish } from '../src/main/publish-socket.ts'
import { publishTalkHandout } from '../src/main/talk-handout-publish.ts'
import { configureTalkWriter } from '../src/main/talk-writer.ts'
import { startCloudflareApiStub } from './lib/cloudflare-api-stub.mjs'
import { memorySecrets } from './lib/memory-secrets.mjs'

const repo = fileURLToPath(new URL('../', import.meta.url))
const compilerDir = join(repo, 'compiler', 'scripts')
const account = { id: 'a1'.repeat(16), name: 'Test account' }
const project = 'cli-publish-fixture'
const token = ['test', 'cli', 'publish', '0123456789abcdef'].join('-')
const root = mkdtempSync(join(tmpdir(), 'tw-cli-publish-'))
const slug = 'fixture-talk'
const folder = join(root, 'vault', slug)
const outlinePath = join(folder, slug + '-outline.md')
// A talk previously published on pages.dev keeps its short code when the custom domain takes over.
const customDomain = 'handouts.test'
const publicLink = 'https://' + customDomain + '/fixture1'
const fallbackLink = 'https://' + project + '.pages.dev/fixture1'
const original = '---\ntitle: Command line handout\nhandout_url: ' + fallbackLink + '\n---\n\n# Command line handout\n\n## Opening {id=a001}\n\n- The fixture has one point.\n'
mkdirSync(folder, { recursive: true })
writeFileSync(outlinePath, original)
configureTalkWriter({ editorBufferFor: () => null })

const api = await startCloudflareApiStub({
  sites: [], accounts: [account], accountSites: { [account.id]: [project] },
  tokens: { [token]: { accounts: [account.id], workers: false } },
  pagesDeployments: { [account.id]: { [project]: { neverDeployed: true } } },
})
try {
  const send = (input, init) => {
    assert.equal(new URL(input).origin, new URL(api.baseUrl).origin, 'all requests stay on fixture loopback')
    return fetch(input, init)
  }
  const secrets = memorySecrets()
  const settings = { accountId: account.id, project, baseUrl: '', productionBranch: 'main' }
  const connection = createCloudflareConnection({
    secrets: secrets.store,
    settings: { read: () => ({ ...settings }), write: patch => Object.assign(settings, patch) },
    fetch: send, apiBase: () => api.baseUrl, timeoutMs: 1000,
  })
  const historyPath = join(root, 'history.json')
  const history = createPublishHistory(historyPath)
  const siteDir = join(root, 'site')
  let registry = {}
  let liveCalls = 0
  const publishing = createHandoutPublishing({
    siteDir: () => siteDir, preservationRoot: join(root, 'preservation'), stagingRoot: () => join(root, 'staging'),
    authorise: () => connection.authorisePublish(),
    inventory: grant => readPublishingInventory(grant, api.baseUrl),
    live: async () => { liveCalls++; return { baseUrl: '' } },
    bundlingHazard: () => null, observe: event => history.record(event),
    pages: () => ({ fetch: send, apiBase: api.baseUrl, allowLoopbackForTests: true, sleep: async () => {}, contentType: loadWranglerMime(repo) }),
    blake3: () => loadWranglerBlake3(repo),
    registry: { read: () => registry, write: value => { registry = value } },
    shortLinks: { read: () => true, write: () => assert.fail('the fixture keeps its link style') },
  })
  let lastHandoutBuild
  const host = {
    assetRootsFor: () => [join(root, 'vault')],
    buildHandoutPagesOffThread: job => {
      if (job.kind === 'talk') lastHandoutBuild = job
      return buildHandoutPages(job, html => html)
    },
    getCompilerPath: () => compilerDir,
    getConfig: key => key === 'publishUseShortIds' ? true : key === 'publishBaseUrl' ? settings.baseUrl : undefined,
    handoutPublishing: () => publishing,
    ledgerSeal: async () => {},
    outlineRefused: file => file === outlinePath ? null : 'The talk is outside the vault.',
    presenterPublications: { ticket: () => 1, published: () => {} },
    publishingHistory: () => history,
    readHandoutRegistry: () => registry,
    resolvePooledRefs: text => text,
    writeHandoutRegistry: value => { registry = value },
  }
  const duplicate = join(root, 'other-vault', slug, slug + '-outline.md')
  let outlines = [outlinePath]
  const depsFor = (cwd = root) => ({
    resolve: input => resolvePublishTalk(input, cwd, {
      findOutlineIn: dir => dir === folder ? outlinePath : null,
      isTalk: path => outlines.includes(path),
      listTalks: () => outlines.map(path => ({ slug, outlinePath: path })),
    }),
    status: path => history.forOutline(outlineIdentity(path).key),
    publish: (path, options) => publishTalkHandout(host, path, '', undefined, options),
  })
  const deps = depsFor()
  async function cli(argv, signal, forward = false) {
    let stdout = '', stderr = ''
    const io = { stdout: text => { stdout += text }, stderr: text => { stderr += text } }
    const code = forward ? await forwardPublish(root, { args: argv, cwd: root }, io, signal ?? new AbortController().signal)
      : await runPublishCli(argv, deps, io, signal)
    assert.ok(!stdout.includes(token) && !stderr.includes(token), 'the CLI keeps credentials private')
    const lines = argv.includes('--json') ? stdout.trim().split('\n').map(line => JSON.parse(line)) : []
    return { code, lines, last: lines.at(-1), stdout, stderr }
  }
  const posts = () => api.requests.filter(request => request.method === 'POST')

  const typo = await cli(['fixtur-talk', '--json'])
  assert.equal(typo.code, 2)
  assert.equal(typo.last.outcome, 'usage')
  assert.equal(typo.last.liveSite, 'untouched')
  assert.deepEqual(typo.last.candidates, [outlinePath])

  outlines = [outlinePath, duplicate]
  const ambiguous = await cli([slug, '--json'])
  assert.equal(ambiguous.code, 2)
  assert.equal(ambiguous.last.outcome, 'usage')
  assert.deepEqual(ambiguous.last.candidates, [outlinePath, duplicate])
  const ambiguousText = await cli([slug, '--status'])
  assert.equal(ambiguousText.code, 2)
  assert.ok(ambiguousText.stderr.includes(outlinePath) && ambiguousText.stderr.includes(duplicate))
  outlines = [outlinePath]
  assert.equal(api.requests.length, 0)
  assert.deepEqual(history.forOutline(outlineIdentity(outlinePath).key), [])

  let windowsMessage = ''
  const windowsExit = publishConnectionFailure([slug, '--dry-run'], {
    stdout: () => assert.fail('Windows setup guidance should go to stderr'),
    stderr: value => { windowsMessage += value },
  }, 'unavailable', 'win32')
  assert.equal(windowsExit, 4)
  assert.match(windowsMessage, /Close TalkWeaver and retry\./)

  const missing = await cli([slug, '--json'])
  assert.equal(missing.code, 4)
  assert.equal(missing.last.outcome, 'setup-required')
  assert.equal(missing.last.liveSite, 'untouched')
  assert.match(missing.last.nextStep, /Settings.*Cloudflare/)
  assert.equal(api.requests.length, 0)

  await connection.saveToken(token)
  await connection.idle()
  const fallback = await connection.authorisePublish()
  assert.equal(fallback.authorisation?.handoutBase(publicLink), 'https://' + project + '.pages.dev', 'a successful lookup found no active custom domains')
  const domains = api.model.sites.get(account.id).get(project).domains
  domains.push({ name: 'drafts.' + customDomain, status: 'active' }, { name: customDomain, status: 'active' })
  await connection.settingsChanged()
  const postCount = posts().length
  const historyBeforePreview = readFileSync(historyPath, 'utf8')
  const preview = await cli(['vault/' + slug, '--dry-run', '--json'])
  assert.equal(preview.code, 0, JSON.stringify(preview.last))
  assert.equal(preview.last.outcome, 'dry-run')
  assert.ok(preview.last.files > 0 && preview.last.bytes > 0)
  assert.equal(preview.last.liveSite, 'untouched')
  assert.equal(posts().length, postCount, 'dry-run sends no upload or deployment request')
  assert.equal(liveCalls, 0, 'dry-run does not provision or update the live service')
  assert.deepEqual(registry, {}, 'dry-run never reserves a short link')
  assert.equal(existsSync(siteDir), false)
  assert.equal(readFileSync(outlinePath, 'utf8'), original)
  assert.equal(readFileSync(historyPath, 'utf8'), historyBeforePreview)

  const success = await cli([outlinePath, '--json'])
  assert.equal(success.code, 0, JSON.stringify(success.last))
  assert.equal(success.last.outcome, 'published')
  assert.equal(success.last.url, publicLink)
  const stamped = original.replace(fallbackLink, publicLink)
  assert.equal(readFileSync(outlinePath, 'utf8'), stamped)
  assert.equal(lastHandoutBuild.url, publicLink)
  assert.equal(lastHandoutBuild.text, original, 'the worker receives the exact saved outline')
  const manifest = api.production(account.id, project).files
  const deck = api.model.assets.get(manifest['/fixture-talk/fixture-talk-download.html']).bytes.toString('utf8')
  assert.ok(deck.includes('<figcaption class="qr-caption"><a href="' + publicLink + '"'), 'the published slide QR links to the custom domain')
  assert.ok(!deck.includes(fallbackLink), 'the published slides leave out the old Pages address')
  const { makeQrSvg } = await import('../compiler/scripts/lib/01-cli-utils.mjs')
  assert.equal(lastHandoutBuild.qr, makeQrSvg(publicLink), 'the handout home and venue QR encode the public URL')
  assert.equal(history.list()[0].events.at(-1).handoutUrl, publicLink)
  assert.equal(JSON.parse(readFileSync(historyPath, 'utf8')).attempts[0].events.at(-1).handoutUrl, publicLink)
  domains.unshift({ name: 'other.example.test', status: 'active' })
  settings.baseUrl = customDomain
  await connection.settingsChanged()
  for (const step of ['building', 'upload', 'confirm']) {
    assert.ok(success.lines.some(event => event.event === 'progress' && event.step === step), step)
  }
  assert.ok(api.production(account.id, project).files['/fixture-talk/index.html'])
  for (const file of [`${slug}.html`, `${slug}-download.html`]) {
    assert.ok(api.production(account.id, project).files[`/${slug}/${file}`])
    const html = readFileSync(join(siteDir, slug, file), 'utf8')
    assert.ok(html.includes('<title>Command line handout</title>'), `${file}: the outline title is used`)
    assert.ok(html.includes('<meta name="deck-title" content="Command line handout">'), `${file}: deck title metadata matches`)
  }
  let revision = api.production(account.id, project).id
  const unchanged = await cli([slug, '--json'])
  assert.equal(unchanged.code, 0, JSON.stringify(unchanged.last))
  assert.equal(unchanged.last.outcome, 'unchanged')
  assert.equal(unchanged.last.url, publicLink, 'the explicitly configured hostname wins over another active domain')
  assert.equal(api.production(account.id, project).id, revision)

  // The editor calls the same operation with its regular flush mode (no savedOnly option).
  api.model.answer = request => request.path.endsWith('/domains') ? { status: 503, body: {} } : null
  settings.baseUrl = 'https://' + customDomain
  await connection.settingsChanged()
  writeFileSync(outlinePath, original)
  const editor = await publishTalkHandout(host, outlinePath, original)
  assert.equal(editor.success, true)
  assert.equal(editor.url, publicLink, 'the editor prefers the configured address over an existing Pages address')
  assert.equal(readFileSync(outlinePath, 'utf8'), stamped)

  // settingsChanged drops the last check, matching a fresh app with no cached domain lookup.
  settings.baseUrl = ''
  await connection.settingsChanged()
  assert.equal(connection.status().publishing.address, null)
  assert.equal(connection.handoutBase('http://speaker.localhost/fixture1'), 'https://' + project + '.pages.dev',
    'an earlier local link cannot be reused as a public address')
  const offlineDomains = await publishTalkHandout(host, outlinePath, stamped)
  assert.equal(offlineDomains.success, true)
  assert.equal(offlineDomains.url, publicLink, 'a failed domain lookup keeps the existing handout domain')
  assert.equal(readFileSync(outlinePath, 'utf8'), stamped)
  assert.equal(lastHandoutBuild.qr, makeQrSvg(publicLink))
  assert.equal(history.list()[0].events.at(-1).handoutUrl, publicLink)
  assert.equal(api.production(account.id, project).id, revision, 'the printed QR and deployed pages need no change')
  api.model.answer = null
  await connection.settingsChanged()

  const running = typeof process.getuid === 'function'
  const updates = []
  let closeSocket
  let editorText
  let commits = 0
  let saved = stamped
  try {
    if (running) {
      const base = stamped.replace('handout_url: ' + publicLink + '\n', '')
      saved = base + '\n## Saved checkpoint {id=a002}\n\n- Saved copy reaches Pages.\n'
      editorText = saved + '\n## Private draft {id=a003}\n\n- Unsaved draft stays here.\n'
      const dirty = editorText
      writeFileSync(outlinePath, saved)
      configureTalkWriter({ editorBufferFor: () => ({
        read: async () => editorText,
        commit: async (_base, next) => { commits++; editorText = next; return { ok: true, text: next } },
      }) })
      closeSocket = await listenForPublish(root, ({ args, cwd }, io, signal) => {
        const ports = depsFor(cwd)
        return runPublishCli(args, {
          ...ports, publish: (path, options) => publishFromRunningApp(path, options, ports.publish, item => updates.push(item)),
        }, io, signal)
      })
      const id = createHash('sha256').update(realpathSync(root)).digest('hex').slice(0, 24)
      const socketDir = join(realpathSync('/tmp'), `tw-publish-${process.getuid()}-${id}`)
      assert.equal(lstatSync(socketDir).mode & 0o777, 0o700)
      assert.equal(lstatSync(socketDir).uid, process.getuid())
      assert.equal(lstatSync(join(socketDir, 'publish.sock')).isSocket(), true)
      assert.equal(lstatSync(join(socketDir, 'publish.sock')).mode & 0o777, 0o600)
      chmodSync(socketDir, 0o755)
      try { await assert.rejects(() => listenForPublish(root, () => assert.fail('unsafe listener')), /Unsafe socket directory/) }
      finally { chmodSync(socketDir, 0o700) }

      const beforeDry = posts().length
      const runningPreview = await cli(['vault/' + slug, '--dry-run', '--json'], undefined, true)
      assert.equal(runningPreview.code, 0, JSON.stringify(runningPreview.last))
      assert.equal(runningPreview.last.outcome, 'dry-run')
      assert.ok(runningPreview.lines.some(event => /unsaved changes.*saved version/.test(event.warning ?? '')))
      assert.equal(posts().length, beforeDry)
      assert.deepEqual(updates, [], 'dry-run does not show a live publish in the editor')

      const runningPublish = await cli(['vault/' + slug, '--json'], undefined, true)
      assert.equal(runningPublish.code, 0, JSON.stringify(runningPublish.last))
      assert.equal(runningPublish.last.outcome, 'published')
      assert.equal(runningPublish.last.url, publicLink)
      assert.ok(runningPublish.lines.some(event => event.event === 'warning' && /unsaved changes.*saved version/.test(event.warning)))
      assert.ok(runningPublish.lines.some(event => event.step === 'confirm'))
      assert.ok(updates.some(event => event.kind === 'progress' && event.progress.step === 'upload'))
      assert.deepEqual(updates.at(-1), { outlinePath, kind: 'finished', url: publicLink })
      const deployment = api.production(account.id, project)
      const content = api.model.assets.get(deployment.files['/fixture-talk/index.html']).bytes.toString('utf8')
      assert.match(content, /Saved copy reaches Pages/)
      assert.doesNotMatch(content, /Unsaved draft stays here/)
      assert.doesNotMatch(runningPublish.stdout, /updatedOutline|Unsaved draft stays here/)
      assert.equal(commits, 0)
      assert.equal(editorText, dirty)
      assert.equal(readFileSync(outlinePath, 'utf8'), saved)
      revision = deployment.id
    }

    saved += '\n## More {id=a004}\n\n- A new point.\n'
    writeFileSync(outlinePath, saved)
    api.model.answer = request => request.path === '/pages/assets/upload'
      ? { status: 400, body: { success: false, errors: [{ code: 8765, message: 'Fixture rejected the asset.' }] } } : null
    const beforeFailed = editorText
    const failed = await cli([slug, '--json'], undefined, running)
    assert.equal(failed.code, 1)
    assert.equal(failed.last.outcome, 'failed')
    assert.equal(failed.last.liveSite, 'untouched')
    assert.equal(failed.last.diagnostic.step, 'upload')
    assert.equal(failed.last.diagnostic.status, 400)
    assert.match(failed.last.nextStep, /Try again/)
    assert.equal(api.production(account.id, project).id, revision)
    assert.equal(readFileSync(outlinePath, 'utf8'), saved)
    if (running) {
      assert.equal(commits, 0)
      assert.equal(editorText, beforeFailed)
      assert.equal(updates.at(-1).diagnostic.status, 400)
    }
  } finally {
    closeSocket?.()
    configureTalkWriter({ editorBufferFor: () => null })
  }

  const cancelled = await cli([slug, '--json'], AbortSignal.abort())
  assert.equal(cancelled.code, 130)
  assert.equal(cancelled.last.outcome, 'cancelled')
  assert.equal(cancelled.last.liveSite, 'untouched')
  assert.equal(api.production(account.id, project).id, revision)

  api.model.answer = request => request.method === 'POST' && request.path.endsWith('/deployments')
    ? { status: 503, body: { success: false, errors: [{ code: 9999, message: 'Fixture has no deployment response.' }] } } : null
  const unknown = await cli([slug, '--json'])
  assert.equal(unknown.code, 3, JSON.stringify(unknown.last))
  assert.equal(unknown.last.outcome, 'failed')
  assert.equal(unknown.last.code, 'PUBLISH_OUTCOME_UNKNOWN')
  assert.equal(unknown.last.liveSite, 'unknown')
  assert.equal(unknown.last.diagnostic.uncertain, true)
  assert.match(unknown.last.nextStep, /Check the site/)

  const requests = api.requests.length
  const status = await cli([outlinePath, '--status', '--json'])
  assert.equal(status.code, 0)
  assert.deepEqual(status.last.attempts.map(attempt => attempt.outcome), ['unknown', 'cancelled', 'failed', ...(running ? ['published'] : []), 'unchanged', 'unchanged', 'unchanged', 'published', 'failed'])
  assert.equal(status.last.attempts[2].events.at(-1).diagnostic.status, 400)
  assert.equal(api.requests.length, requests, 'history is read locally')
  assert.doesNotMatch(status.stdout, /sourceOutline|updatedOutline/)

  console.log('PASS: CLI publish, dry-run, diagnostics, setup, invalid and ambiguous IDs, Windows guidance, running-app forwarding, unsaved edits and history against loopback Pages')
} finally {
  await api.close()
  rmSync(root, { recursive: true, force: true })
}

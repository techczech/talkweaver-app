// Feedback-boards ticket 09 fix round: publishing a planned Run's handout with pre-work, and the
// evergreen handout, through the REAL ipcMain handlers lifted out of src/main/index.ts with the
// TypeScript compiler (as test-handout-from-buffer.mjs does), over a temp vault with the REAL Run
// writer, the REAL compiler and the REAL pre-work service against a fake Worker. Wrangler is a fake.
//   1. publish → unpublish → republish keeps the same open pre-work object and its answers
//      (unpublishing never closes it); a Run closed early stays closed and says so on republish;
//   2. a window that closes before it opens refuses the publish in plain words;
//   3. pre-work steps are never slides of the evergreen handout (talk:publish-handout, talk:export-handout).
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-prework-publish.mjs
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { configureTalkWriter, flushTalkForPublish, writeTalkOutline } from '../src/main/talk-writer.ts'
import { checkPreconditions, publishUrl, resolveBase } from '../src/main/publishing-logic.ts'
import { stampHandoutUrl } from '../src/shared/handout-stamp.ts'
import { outlineRefusal } from '../src/main/vault-paths.ts'
import { clearRunHandoutUrl, persistRun, persistRunForTalk, preworkWindow, readRun, readRunForTalk, normaliseRun, setRunHandoutUrl } from '../src/main/runs.ts'
import { createRunPrework } from '../src/main/run-prework.ts'
import { preworkWindowMs, publicPreworkForm, withoutPreworkSlides } from '../src/shared/run-prework.ts'
import { handoutHomeDetails, handoutHomePrework } from '../src/shared/handout-home.ts'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { assetRootsForTalk } from '../src/main/asset-roots.ts'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourceText = readFileSync(join(REPO, 'src/main/index.ts'), 'utf8')
const sourceFile = ts.createSourceFile('src/main/index.ts', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

function loadHandler(channel, dependencies) {
  let callback = null
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.expression.getText(sourceFile) === 'ipcMain' && node.expression.name.text === 'handle'
      && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === channel) {
      callback = node.arguments[1]
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  assert.ok(callback, `${channel}: handler is registered`)
  const transpiled = ts.transpileModule(`const handler = ${callback.getText(sourceFile)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  return Function(...Object.keys(dependencies), `${transpiled}\nreturn handler`)(...Object.values(dependencies))
}

configureTalkWriter({ editorBufferFor: () => null })
const root = mkdtempSync(join(tmpdir(), 'tw-prework-publish-'))
const vault = join(root, 'vault')
const slug = 'agents'
const talkDir = join(vault, slug)
mkdirSync(talkDir, { recursive: true })
mkdirSync(join(vault, '_PRESENTATIONS', slug), { recursive: true })
const outlinePath = join(talkDir, `${slug}-outline.md`)
const OUTLINE = ['---', 'title: The current state of AI agents', 'auto_title_slide: false', 'auto_thanks_slide: false', '---', '',
  '## Opening', '{id=open}', '', '### Why we are here', '{id=why}', '', 'Kestrelwing talk text.', '',
  '## Before the session', '{id=pwform}{prework}', '', 'Two short steps.', '',
  '### Welcome: Zebrafinch pre-reading', '{id=pwwelcome}', '', '- Read this first', '',
  '### Quick check: what makes an agent?', '{poll=single}{id=pwquiz}{check}', '', '- Full sentences', '- Tools that carry out steps {right}', '',
  '## Your turn', '{id=turn}', '', '### Discuss', '{id=discuss}', '', 'Talk slide.', ''].join('\n')
writeFileSync(outlinePath, OUTLINE)
const talk = { slug, outlinePath }

// ── A fake live Worker: pre-work objects with their answers ──────────────────────────────────
const worker = { objects: new Map(), created: 0, closes: 0 }
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const fakeFetch = async (url, init = {}) => {
  const { pathname, searchParams } = new URL(url)
  if (pathname === '/prework') {
    worker.created += 1
    const id = `pw${String(worker.created).padStart(6, '0')}`
    worker.objects.set(id, { form: null, closed: false, entries: [] })
    return reply({ preworkId: id, ownerToken: `owner-token-${id}-0123456789` }, 201)
  }
  const [, , id, action] = pathname.split('/')
  const object = worker.objects.get(id)
  if (!object) return reply({ error: { code: 'not_found' } }, 404)
  if (action === 'form') { object.form = JSON.parse(init.body); return reply({ ok: true }) }
  if (action === 'close') { worker.closes += 1; object.closed = true; return reply({ ok: true, closedAt: 1_700_000_000_000 }) }
  if (action === 'results') {
    const after = Number(searchParams.get('after'))
    return reply({ seq: object.entries.length, people: 1, entries: object.entries.filter((entry) => entry.seq > after), more: false })
  }
  return reply({ error: { code: 'not_found' } }, 404)
}
const service = createRunPrework({ registryPath: join(root, 'prework-registry.json'), endpoint: async () => ({ baseUrl: 'https://live.example.test', adminSecret: 'admin' }),
  vaultRoot: () => vault, fetch: fakeFetch })

// ── The handlers' world ──────────────────────────────────────────────────────────────────────
const siteDir = join(root, 'site')
const built = []
const trace = { deploys: 0 }
const config = { vaultRoot: vault, cfAccountId: 'acct', cfPagesProject: 'talks', publishBaseUrl: 'https://talks.test', publishUseShortIds: false, liveWorkerBaseUrl: 'https://live.example.test' }
const common = {
  getConfig: (key, fallback) => (key in config ? config[key] : fallback),
  currentVaultRoot: () => vault, writableVaultRoot: () => vault, vaultRootFor: () => vault,
  // The real root choice (ADR-0036), with the test's vault as the one registered vault.
  assetRootsFor: (path) => assetRootsForTalk({ resolve: () => ({ vault: { root: vault } }) }, path),
  unresolvedOutboundFailure: () => null,
  flushTalkForPublish, readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, rmSync, join, basename, dirname, statSync, pathToFileURL,
  getCompilerPath: () => join(REPO, 'compiler/scripts'),
  resolveBase, publishUrl, checkPreconditions, stampHandoutUrl, writeTalkOutline,
  readHandoutRegistry: () => ({}), writeHandoutRegistry: () => {}, buildRedirects: () => '', recoverIdFromUrl: () => undefined,
  pickShortId: () => { throw new Error('short ids are off') }, generateShortId: () => 'x', randomBytes: () => Buffer.alloc(8),
  publishSiteDir: () => siteDir,
  slimHandoutHtml: (html) => html,
  handoutHomeDetails, handoutHomePrework,
  deployPublishedSite: async () => { trace.deploys += 1; return { ok: true } },
  ensureLiveWorker: async () => ({ baseUrl: 'https://live.example.test', adminSecret: 'admin' }),
  process: { env: {} },
  withoutPreworkSlides,
  preworkEnabled: () => true, // pre-work is hidden for 0.37; the pre-work publish test forces it on
}
const runHandlerDeps = {
  ...common,
  readRun, persistRun, setRunHandoutUrl, clearRunHandoutUrl, talkBySlug: () => talk,
  runHandoutSlug: () => 'agents-itss-2026-10-06',
  prepareTalk: async (path, content) => ({ model: await prepareSource(path, content, slug, statSync(path)) }),
  timerSettings: () => ({}),
  publicPreworkForm, preworkWindowMs, preworkWindow,
  runPrework: () => service,
  buildRunHandoutArtifact: async (_talk, run, _content, outputSlug, _base, prework) => {
    built.push({ runId: run.id, prework })
    return { path: join(root, 'run.html'), html: '<html>run handout</html>', title: 'T', slug: outputSlug, slideIds: [], missing: [],
      venueSource: { slides: [], styles: '', license: null, liveTalkSlug: slug } }
  },
}
const publish = loadHandler('run:publish-handout', runHandlerDeps)
const unpublish = loadHandler('run:unpublish-handout', runHandlerDeps)

const planned = (id, extra = {}) => normaliseRun({ id, talkSlug: slug, talkTitle: 'T', kind: 'delivery', status: 'planned', plannedDate: '2099-10-06',
  eventTitle: 'ITSS', startTime: '10:00', preworkOpens: '2026-09-01T09:00', timeZone: 'Europe/London', slideSet: { kind: 'full' },
  startedAt: '2099-10-06T00:00:00.000Z', ...extra })

// 1. publish → unpublish → republish: the same open object, and its answers.
{
  persistRunForTalk(vault, slug, 'run-pw', planned('run-pw'))
  const first = await publish(null, { talkSlug: slug, runId: 'run-pw' })
  assert.equal(first.success, true, first.error)
  assert.equal(built.at(-1).prework?.preworkId, 'pw000001', 'the handout carries the pre-work object')
  assert.equal(/right/i.test(JSON.stringify(built.at(-1).prework.form)), false, 'the form sent and carried has no right answer')
  const object = worker.objects.get('pw000001')
  assert.equal(object.form.closesAt, Date.UTC(2099, 9, 6, 9), 'the window is read in the Run\'s zone (10:00 London in October = 09:00 UTC)')
  object.entries.push({ id: 'a1b2c3d4e5f60718:read:pwwelcome', seq: 1, participant: 'a1b2c3d4e5f60718', stepId: 'pwwelcome', kind: 'read', at: 1_600_000_000_000 })
  assert.equal((await service.pull(slug, 'run-pw')).ok, true)
  assert.equal(readRunForTalk(vault, slug, 'run-pw').prework.entries.length, 1)

  const down = await unpublish(null, { talkSlug: slug, runId: 'run-pw' })
  assert.equal(down.success, true, down.error)
  assert.equal(worker.closes, 0, 'unpublishing does not close the pre-work')
  assert.equal(object.closed, false)
  assert.equal(readRunForTalk(vault, slug, 'run-pw').handoutUrl, undefined)
  assert.equal(readRunForTalk(vault, slug, 'run-pw').prework.entries.length, 1, 'the answers stay on the Run')

  const again = await publish(null, { talkSlug: slug, runId: 'run-pw' })
  assert.equal(again.success, true, again.error)
  assert.equal(again.warning, undefined)
  assert.equal(worker.created, 1, 'republishing reuses the same object')
  assert.equal(built.at(-1).prework?.preworkId, 'pw000001', 'and the handout names it again')
  object.entries.push({ id: '0f1e2d3c4b5a6978:read:pwwelcome', seq: 2, participant: '0f1e2d3c4b5a6978', stepId: 'pwwelcome', kind: 'read', at: 1_600_000_000_000 })
  await service.pull(slug, 'run-pw')
  assert.equal(readRunForTalk(vault, slug, 'run-pw').prework.entries.length, 2, 'the answers before and after are all on the Run')
  assert.ok(readRunForTalk(vault, slug, 'run-pw').handoutUrl, 'the Run has its link again')

  // Closed early: it stays closed, and republishing says so.
  assert.equal((await service.close(slug, 'run-pw')).ok, true)
  const closed = await publish(null, { talkSlug: slug, runId: 'run-pw' })
  assert.equal(closed.success, true, closed.error)
  assert.equal(closed.warning, 'Pre-work was closed; it stays closed.')
  assert.equal(worker.created, 1, 'no new object is made')
  assert.equal(object.closed, true)
}

// 2. A window that closes before it opens refuses the publish in plain words.
{
  persistRunForTalk(vault, slug, 'run-bad', planned('run-bad', { preworkOpens: '2099-10-07T09:00' }))
  const before = built.length
  const result = await publish(null, { talkSlug: slug, runId: 'run-bad' })
  assert.deepEqual(result, { success: false, error: 'Pre-work closes before it opens; fix the dates in the plan.' })
  assert.equal(built.length, before, 'nothing is built')
  assert.equal(readRunForTalk(vault, slug, 'run-bad').handoutUrl, undefined)
}

// 3. The evergreen handout: pre-work steps are never its slides.
{
  const evergreen = { ...common, outlineRefused: (p) => outlineRefusal(vault, p), readToken: () => 'token', augmentedPath: (p) => p, wranglerFoundOn: () => true,
    resolveImageRefs: (text) => text, resolvePooledRefs: (text) => text, readHandoutUrl: () => null, app: { getPath: () => root },
    execFile: (_cmd, _args, _opts, cb) => { trace.deploys += 1; cb(null, '', '') },
    ledgerSeal: async () => {}, localHandoutWorkerBaseUrl: () => 'http://127.0.0.1:8787' }
  const published = await loadHandler('talk:publish-handout', evergreen)(null, outlinePath, OUTLINE)
  assert.equal(published.success, true, published.error)
  const html = readFileSync(join(siteDir, slug, `${slug}.html`), 'utf8')
  const exported = await loadHandler('talk:export-handout', evergreen)(null, outlinePath, OUTLINE)
  assert.equal(exported.success, true, exported.error)
  const exportedHtml = readFileSync(exported.path, 'utf8')
  for (const [label, page] of [['published', html], ['exported', exportedHtml]]) {
    assert.ok(page.includes('Kestrelwing'), `${label}: the talk's own slides are there`)
    assert.equal(page.includes('Zebrafinch'), false, `${label}: no pre-work step is a slide of the evergreen handout`)
    assert.equal(/data-id="pw/.test(page), false, `${label}: no pre-work slide id`)
    assert.equal(page.includes('preworkSteps'), false, `${label}: and it carries no form`)
  }
}

console.log('prework publish: publish → unpublish → republish keeps the same open object and its answers; closed early stays closed and says so; a window closing before it opens is refused; pre-work steps stay out of the evergreen handout (publish and export) passed')

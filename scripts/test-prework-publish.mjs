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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { configureTalkWriter, flushTalkForPublish, writeTalkOutline } from '../src/main/talk-writer.ts'
import { SITE_FOLDER_REFUSED, checkPreconditions, publishUrl, resolveBase } from '../src/main/publishing-logic.ts'
import { stampHandoutUrl } from '../src/shared/handout-stamp.ts'
import { outlineRefusal } from '../src/main/vault-paths.ts'
import { clearRunHandoutUrl, persistRun, persistRunForTalk, preworkWindow, readRun, readRunForTalk, normaliseRun, setRunHandoutUrl } from '../src/main/runs.ts'
import { createRunPrework } from '../src/main/run-prework.ts'
import { memoryOwnerTokens } from './lib/memory-secrets.mjs'

// Owner tokens live in the secrets store (an in-memory one here), never in a registry file.
const testOwnerTokens = memoryOwnerTokens()
import { preworkWindowMs, publicPreworkForm, withoutPreworkSlides } from '../src/shared/run-prework.ts'
import { handoutHomeDetails, handoutHomePrework } from '../src/shared/handout-home.ts'
// The pages are built and written as the main process's worker thread does it, here in this process.
import { buildHandoutPages } from '../src/main/handout-pages.ts'
import { liveAddressForPages, publishedFolders, removeSiteFolder, writableSiteFolder } from '../src/main/handout-publishing.ts'
import { grantedPublishing } from './lib/publishing-fakes.mjs'
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
const service = createRunPrework({ ownerTokens: testOwnerTokens, registryPath: join(root, 'prework-registry.json'), endpoint: async () => ({ baseUrl: 'https://live.example.test', adminSecret: 'admin' }),
  vaultRoot: () => vault, fetch: fakeFetch })

// ── The handlers' world ──────────────────────────────────────────────────────────────────────
const siteDir = join(root, 'site')
const built = []
const trace = { deploys: 0 }
const config = { vaultRoot: vault, cfAccountId: 'acct', cfPagesProject: 'talks', publishBaseUrl: 'https://talks.test', publishUseShortIds: false, liveWorkerBaseUrl: 'https://live.example.test' }
const publishing = grantedPublishing({ siteDir, onUpload: () => { trace.deploys += 1 } })
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
  buildHandoutPagesOffThread: (job) => buildHandoutPages(job, (html) => html),
  SITE_FOLDER_REFUSED, publishedFolders, removeSiteFolder, writableSiteFolder,
  handoutHomeDetails, handoutHomePrework,
  handoutPublishing: () => publishing,
  liveAddressForPages,
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
  // Publish handout for this Run: the Run's compiled deck, then its pages built as the worker thread
  // builds them (here in this process, with the real buildHandoutPages); what the handout carries is recorded.
  runForHandout: (_talk, run) => ({ eventTitle: run.eventTitle, talkTitle: run.talkTitle, plannedDate: run.plannedDate, startedAt: run.startedAt }),
  resolvePooledRefs: (text) => text,
  runHandoutDistPath: () => join(root, 'run.html'),
  buildHandoutPagesOffThread: (job) => {
    if (job.kind === 'run') built.push({ prework: job.prework })
    return buildHandoutPages(job, (html) => html)
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

// 1b. Publish and unpublish asked for together, through the real handlers (ticket 04 fix round):
//     every unpublish takes its turn in the site's queue and reads the Run's link when its turn
//     begins, so it finds the link the publish before it recorded, and the Run ends unpublished.
{
  persistRunForTalk(vault, slug, 'run-race', planned('run-race', { status: 'delivered' }))
  const folder = join(siteDir, 'agents-itss-2026-10-06')
  const before = trace.deploys
  const up = publish(null, { talkSlug: slug, runId: 'run-race' })
  const down = unpublish(null, { talkSlug: slug, runId: 'run-race' }) // asked while the publish has not even built its pages
  const [published, removed] = await Promise.all([up, down])
  assert.deepEqual([published.success, removed.success], [true, true], `${published.error ?? ''} ${removed.error ?? ''}`)
  assert.equal(readRunForTalk(vault, slug, 'run-race').handoutUrl, undefined, 'publish then unpublish ends unpublished: the Run has no link')
  assert.equal(existsSync(folder), false, 'and its pages are gone from the site folder')
  assert.equal(trace.deploys, before + 2, 'the site went up twice: with the pages, then without them')
  // The other order ends published.
  const down2 = unpublish(null, { talkSlug: slug, runId: 'run-race' })
  const up2 = publish(null, { talkSlug: slug, runId: 'run-race' })
  await Promise.all([down2, up2])
  assert.ok(readRunForTalk(vault, slug, 'run-race').handoutUrl && existsSync(join(folder, 'index.html')), 'unpublish then publish ends published')
  assert.equal(trace.deploys, before + 3, 'an unpublish of what is not published uploads nothing')
  assert.equal((await unpublish(null, { talkSlug: slug, runId: 'run-race' })).success, true)
}

// 1c. A Run whose handout folder has a space and a `#` in its name (round 3): its link holds the name
//     as an encoded path segment, and Unpublish finds the folder from that link.
{
  const awkward = 'two words #1 run'
  const deps = { ...runHandlerDeps, runHandoutSlug: () => awkward }
  persistRunForTalk(vault, slug, 'run-awkward', planned('run-awkward', { status: 'delivered' }))
  const up = await loadHandler('run:publish-handout', deps)(null, { talkSlug: slug, runId: 'run-awkward' })
  assert.equal(up.success, true, up.error)
  assert.deepEqual([up.url, decodeURIComponent(new URL(up.url).pathname), new URL(up.url).hash], ['https://talks.test/two%20words%20%231%20run/', `/${awkward}/`, ''])
  assert.ok(existsSync(join(siteDir, awkward, 'index.html')) && readRunForTalk(vault, slug, 'run-awkward').handoutUrl === up.url)
  // Published again: the same folder is found from the link, not a second one made.
  assert.equal((await loadHandler('run:publish-handout', { ...deps, runHandoutSlug: () => 'a-second-folder' })(null, { talkSlug: slug, runId: 'run-awkward' })).url, up.url)
  const down = await loadHandler('run:unpublish-handout', deps)(null, { talkSlug: slug, runId: 'run-awkward' })
  assert.equal(down.success, true, down.error)
  assert.deepEqual([existsSync(join(siteDir, awkward)), existsSync(join(siteDir, 'a-second-folder')), readRunForTalk(vault, slug, 'run-awkward').handoutUrl], [false, false, undefined], 'unpublished: its folder is gone and the Run has no link')
}

// 1d. Names that come from outside (the link stored on a Run, a registry file, the name a Run's
//     folder is given) never reach outside the site folder, through the real handlers. A folder
//     beside the site folder, and one a link inside the site points at, are byte for byte as they were.
{
  const snapshot = (dir) => Object.fromEntries(readdirSync(dir, { recursive: true, withFileTypes: true }).map((entry) => {
    const path = join(entry.parentPath ?? entry.path, entry.name)
    return [path.slice(dir.length), entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'dir' : readFileSync(path, 'latin1')]
  }).sort())
  const victim = join(dirname(siteDir), 'victim')
  mkdirSync(join(victim, 'deep'), { recursive: true })
  writeFileSync(join(victim, 'index.html'), 'not the site\'s')
  writeFileSync(join(victim, 'deep', 'keep.txt'), 'keep')
  symlinkSync(victim, join(siteDir, 'linked'))
  // Outside the site folder: the folder beside it, whole, and the NAMES of everything beside the site folder
  // (the vault is there too, and changes). The folder above that is the computer's shared temporary folder,
  // which other programs write to: nothing is claimed about it.
  const outside = () => ({ beside: readdirSync(dirname(siteDir)).sort(), victim: snapshot(victim) })
  const before = outside()
  const EVIL = ['%2e%2e%2fvictim', '..%2Fvictim', '..%2F..', '%2Fetc', '%2F' + encodeURIComponent(victim.slice(1)), '%5C..%5Cvictim', '%00', 'victim%00', '%2e', '%2e%2e', 'linked', 'linked%2Fdeep', 'victim.', '%E0%A4%A', '%20victim', 'CON']
  for (const segment of EVIL) {
    for (const registry of [{}, { '../victim': 'abcd', [victim]: 'abce', linked: 'abcf', '..': 'abcg' }]) {
      const deps = { ...runHandlerDeps, readHandoutRegistry: () => ({ ...registry }), writeHandoutRegistry: () => {} }
      for (const link of [`https://talks.test/${segment}/`, 'https://talks.test/abcd', 'https://talks.test/abce', 'https://talks.test/abcf', 'https://talks.test/abcg']) {
        const stored = { ...planned('run-evil', { status: 'delivered' }), handoutUrl: link }
        persistRunForTalk(vault, slug, 'run-evil', stored)
        const siteBefore = snapshot(siteDir)
        const down = await loadHandler('run:unpublish-handout', deps)(null, { talkSlug: slug, runId: 'run-evil' })
        assert.deepEqual(outside(), before, `unpublish with the link ${link}: nothing outside the site folder is created, written or removed`)
        assert.deepEqual(Object.keys(snapshot(siteDir)).filter((path) => !path.endsWith('_redirects')), Object.keys(siteBefore).filter((path) => !path.endsWith('_redirects')), `unpublish with the link ${link}: no folder of the site is taken away either (it names none)`)
        assert.ok(down.success === true || typeof down.error === 'string')
        // The same link on a Run that is published again: its folder is the one the app names, inside the site.
        persistRunForTalk(vault, slug, 'run-evil', stored)
        const up = await loadHandler('run:publish-handout', { ...deps, runHandoutSlug: () => 'run-evil-folder' })(null, { talkSlug: slug, runId: 'run-evil' })
        assert.equal(up.success, true, up.error)
        assert.deepEqual([outside(), existsSync(join(siteDir, 'run-evil-folder', 'index.html'))], [before, true], `publish with the stored link ${link}: built in its own folder inside the site`)
        assert.equal((await loadHandler('run:unpublish-handout', deps)(null, { talkSlug: slug, runId: 'run-evil' })).success, true)
        assert.deepEqual([outside(), existsSync(join(siteDir, 'run-evil-folder'))], [before, false])
      }
    }
  }
  // A Run whose folder NAME is not a plain segment, or is a link: refused before anything is written.
  for (const name of ['../victim', '..', '.', 'victim/deep', victim, '..\\victim', 'bad\u0000name', 'trailing.', ' leading', 'trailing ', 'NUL', 'com1.html', '', 'linked']) {
    persistRunForTalk(vault, slug, 'run-evil', planned('run-evil', { status: 'delivered' }))
    const siteBefore = snapshot(siteDir)
    const up = await loadHandler('run:publish-handout', { ...runHandlerDeps, runHandoutSlug: () => name })(null, { talkSlug: slug, runId: 'run-evil' })
    assert.deepEqual([up.success, up.error], [false, SITE_FOLDER_REFUSED], `a Run folder named ${JSON.stringify(name)} is refused`)
    assert.deepEqual([outside(), snapshot(siteDir), readRunForTalk(vault, slug, 'run-evil').handoutUrl], [before, siteBefore, undefined], `${JSON.stringify(name)}: nothing was written anywhere`)
  }
  // The link inside the site is still a link, and what it points at is whole.
  assert.ok(lstatSync(join(siteDir, 'linked')).isSymbolicLink() && readFileSync(join(victim, 'deep', 'keep.txt'), 'utf8') === 'keep')
  // Ordinary and awkward names still publish and unpublish.
  for (const name of ['two words', 'a#b', '50%', 'ünï-講演', 'plain-run']) {
    persistRunForTalk(vault, slug, 'run-named', planned('run-named', { status: 'delivered' }))
    const deps = { ...runHandlerDeps, runHandoutSlug: () => name }
    const up = await loadHandler('run:publish-handout', deps)(null, { talkSlug: slug, runId: 'run-named' })
    assert.deepEqual([up.success, existsSync(join(siteDir, name, 'index.html')), decodeURIComponent(new URL(up.url).pathname)], [true, true, `/${name}/`], `${name} publishes`)
    assert.equal((await loadHandler('run:unpublish-handout', deps)(null, { talkSlug: slug, runId: 'run-named' })).success, true)
    assert.deepEqual([existsSync(join(siteDir, name)), readRunForTalk(vault, slug, 'run-named').handoutUrl], [false, undefined], `${name} unpublishes`)
  }
  assert.deepEqual(outside(), before)
  rmSync(join(siteDir, 'linked'))
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
  const evergreen = { ...common, outlineRefused: (p) => outlineRefusal(vault, p),
    resolveImageRefs: (text) => text, resolvePooledRefs: (text) => text, readHandoutUrl: () => null, app: { getPath: () => root },
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

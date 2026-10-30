// Publishing a planned Run (feedback-boards ticket 09; work-files ticket 16 "Publish for this run"), and the
// evergreen handout, through the REAL ipcMain handlers lifted out of src/main/index.ts with the
// TypeScript compiler (as test-handout-from-buffer.mjs does), over a temp vault with the REAL Run
// writer, the REAL compiler and the REAL pre-work service against a fake Worker. Cloudflare is a fake
// (grantedPublishing: the site folder is what would be uploaded).
//   0. ticket 16: a Run with a pre-work and a post-work file publishes three pages in its folder (the
//      handout, pre-work/ and post-work/); the handout links to both and embeds no form; no file of the
//      folder holds an address on this computer or a right answer; each phase's object on the Worker gets
//      the public form and its window (post-work not yet open until the session ends); the files are
//      pinned and both phases stamped published; unpublish → republish reuses the pins and the objects,
//      whatever the vault file says since; unpublish (ticket 17) makes every page of the Run's folder "This
//      page is not available" at the same address, withdraws both phases and stamps them unpublished, and
//      Publish again serves them again at the same address;
//   0e. ticket 17 fix round: the Run's folder recorded and bound to it (a legacy short-id link is the
//      registry's folder only, never a folder named by the id; a missing folder refuses Unpublish until Publish again writes it back);
//      pre-work detached after it went out is still withdrawn; a withdraw failure is a fixed sentence with
//      the Worker's text only in Details; a withdraw whose answer was lost is still undone by Publish again;
//   0f. ticket 17 round 3: Publish again writes into the recorded folder when it is missing here (another
//      Run recording it refuses); attachments taken off after they went out still mean REPLACE, and the
//      Run reads Unpublished;
//   0b. a work file that is not ready (a blocking finding, or missing) refuses the publish with the finding,
//      before anything is pinned, pushed, built or written; a 0.39 Run folder in the site is untouched;
//   0d. Preview page builds the participant page into the Run's vault folder: nothing pushed or uploaded;
//   0c. pre-work written in the talk (a 0.39 Run) is not sent, with a warning;
//   1. publish/unpublish order, awkward and hostile folder names (as before);
//   2. a window that closes before it opens refuses the publish in plain words;
//   3. pre-work steps are never slides of the evergreen handout (talk:publish-handout, talk:export-handout).
//   4. ticket 24: a Run's extras (intro note, links) show on its handout home page only, escaped; a link that is
//      not http(s) never reaches a page; the talk's own handout pages are byte-identical before and after.
//   5. ticket 25: a Run's extra slides (kept on its Run record, never in the outline): its handout is exactly its
//      pathway's slides plus its extra slides, each after its chosen slide or at the end; a second Run of the talk
//      never sees them; the talk's own handout pages and its outline file stay byte-identical.
// Usage: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/test-prework-publish.mjs
import assert from 'node:assert/strict'
import { withPrewarmYield } from '../src/main/preparation-gate.ts'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { configureTalkWriter, flushTalkForPublish, writeTalkOutline } from '../src/main/talk-writer.ts'
import { SITE_FOLDER_REFUSED, checkPreconditions, publishUrl, resolveBase } from '../src/main/publishing-logic.ts'
import { stampHandoutUrl } from '../src/shared/handout-stamp.ts'
import { outlineRefusal } from '../src/main/vault-paths.ts'
import { clearRunHandoutUrl, listRuns, persistRun, persistRunForTalk, readRun, readRunForTalk, normaliseRun, runPathForTalk, setRunExtras, setRunHandoutUrl, stampRunWork, updateRunExtraSlides } from '../src/main/runs.ts'
import { buildRunWorkPreview, planRunWork, sendRunWork, writeRunWorkPages, runLineFor, WORK_LEGACY_NOT_PUBLISHED, WORK_PREVIEW_NONE } from '../src/main/run-work-publish.ts'
import { WORK_PAGE_FOLDER } from '../src/shared/run-work.ts'
import { zonedLocalToMs } from '../src/shared/run-prework.ts'
import { PRE_WORK, POST_WORK, TASK_PICTURE } from './lib/work-page-fixture.mjs'
import { createRunPrework } from '../src/main/run-prework.ts'
import { memoryOwnerTokens } from './lib/memory-secrets.mjs'

// Owner tokens live in the secrets store (an in-memory one here), never in a registry file.
const testOwnerTokens = memoryOwnerTokens()
import { withoutPreworkSlides } from '../src/shared/run-prework.ts'
import { handoutHomeDetails, handoutHomePostwork, handoutHomePrework } from '../src/shared/handout-home.ts'
// The pages are built and written as the main process's worker thread does it, here in this process.
import { buildHandoutPages, runForHandoutOf } from '../src/main/handout-pages.ts'
import { readPathwayManifest } from '../src/main/pathways.ts'
import { liveAddressForPages, publishedFolders, removeSiteFolder, writableSiteFolder } from '../src/main/handout-publishing.ts'
import { runChecklist } from '../src/shared/run-checklist.ts'
import { sessionSource } from '../src/main/sessions-list.ts'
import { RUN_FOLDER_UNCLEAR, UNPUBLISH_FOLDER_MISSING, runPublishFolder, runSiteFolder, runUnpublishJob } from '../src/main/run-unpublish.ts'
import { buildNotAvailablePage } from '../src/main/work-page.ts'
import { RUN_VAULT_NOT_OPEN, runVaultRoot } from '../src/main/run-page.ts'
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
// `withdrawFault`: 'lost' applies a withdraw and loses its answer (the request throws); 'refuse' answers 500 with internal text.
const worker = { objects: new Map(), created: 0, forms: 0, closes: 0, withdraws: [], withdrawFault: null }
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
  if (action === 'form') { worker.forms += 1; object.form = JSON.parse(init.body); return reply({ ok: true }) }
  if (action === 'withdraw') {
    const withdrawn = JSON.parse(init.body || '{}').withdrawn !== false
    if (worker.withdrawFault === 'refuse') return reply({ error: { code: 'internal', message: `stack trace at /srv/worker.js with owner-token-${id}-0123456789\u0007` } }, 500)
    worker.withdraws.push([id, withdrawn])
    object.withdrawn = withdrawn
    if (worker.withdrawFault === 'lost') throw new TypeError('socket hang up')
    return reply({ ok: true, withdrawn, withdrawnAt: withdrawn ? 1_700_000_000_000 : null })
  }
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
  withPrewarmYield,
  // ticket 2b: the OCR text handed to the compiler; this test has no OCR index.
  pictureTextForCompile: () => ({}),
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
  handoutHomeDetails, handoutHomePrework, handoutHomePostwork,
  handoutPublishing: () => publishing,
  liveAddressForPages,
  process: { env: {} },
  withoutPreworkSlides,
}
const postWorkAsked = []
const runHandlerDeps = {
  ...common,
  readRun, persistRun, setRunHandoutUrl, clearRunHandoutUrl, talkBySlug: () => talk,
  runHandoutSlug: () => 'agents-itss-2026-10-06',
  prepareTalk: async (path, content) => ({ model: await prepareSource(path, content, slug, statSync(path)) }),
  timerSettings: () => ({}),
  runPrework: () => service,
  planRunWork, sendRunWork, writeRunWorkPages, runLineFor, stampRunWork, WORK_PAGE_FOLDER,
  // Ticket 19: a Run published (again) asks whether its post-work opens now.
  openPostWorkFor: (talkSlug, runId) => { postWorkAsked.push(`${talkSlug}/${runId}`) },
  runSiteFolder, runPublishFolder, listRuns, RUN_FOLDER_UNCLEAR, runUnpublishJob, buildNotAvailablePage,
  // Publish handout for this Run: the Run's compiled deck, then its pages built as the worker thread
  // builds them (here in this process, with the real buildHandoutPages); what the handout carries is recorded.
  runForHandout: (_talk, run) => ({ eventTitle: run.eventTitle, talkTitle: run.talkTitle, plannedDate: run.plannedDate, startedAt: run.startedAt }),
  resolvePooledRefs: (text) => text,
  runHandoutDistPath: () => join(root, 'run.html'),
  buildHandoutPagesOffThread: (job) => {
    if (job.kind === 'run') built.push({ homePrework: job.homePrework, homePostwork: job.homePostwork })
    return buildHandoutPages(job, (html) => html)
  },
}
const publish = loadHandler('run:publish-handout', runHandlerDeps)
const unpublish = loadHandler('run:unpublish-handout', runHandlerDeps)

const planned = (id, extra = {}) => normaliseRun({ id, talkSlug: slug, talkTitle: 'T', kind: 'delivery', status: 'planned', plannedDate: '2099-10-06',
  eventTitle: 'ITSS', startTime: '10:00', preworkOpens: '2026-09-01T09:00', timeZone: 'Europe/London', slideSet: { kind: 'full' },
  startedAt: '2099-10-06T00:00:00.000Z', ...extra })

// ── Work files (ticket 16) ───────────────────────────────────────────────────────────────────
const workDir = join(vault, 'Work files')
mkdirSync(workDir, { recursive: true })
writeFileSync(join(workDir, 'paper-and-chat.svg'), TASK_PICTURE)
writeFileSync(join(workDir, 'research-teams-intake.md'), PRE_WORK)
writeFileSync(join(workDir, 'after-the-session.md'), POST_WORK)
const TZ = 'Europe/London'
const withWork = (id, work, extra = {}) => normaliseRun({ ...planned(id, extra), preworkOpens: undefined, work })
const PRE_ATTACHED = { fileId: 'research-teams-intake', opens: '2026-09-01T09:00', closes: '2099-10-06T09:00', timeZone: TZ }
const POST_ATTACHED = { fileId: 'after-the-session', opens: 'session-end', closes: '2099-10-20T17:00', timeZone: TZ }
const filesIn = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath ?? entry.path, entry.name))
// An address on this computer, in any of the spellings a page could carry (handout-publishing.ts checks more).
const LOOPBACK = /(?:https?|wss?):\/\/(?:localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(?=[:/"'\s]|$)/i
// A right answer, as the work file marks it or as a form could carry it.
const RIGHT = /\{\s*right\s*\}|"(?:right|correct|answer|correctOption)"\s*:/i
const startLine = (html) => {
  const lines = [...html.matchAll(/^startWorkPage\(window, (.*)\);$/gm)]
  assert.equal(lines.length, 1, 'a work page has one start line')
  return JSON.parse(lines[0][1])
}

// 0. Publish for this run: three pages, both links, no form, nothing local, no right answer.
{
  const deps = { ...runHandlerDeps, runHandoutSlug: () => 'agents-wf' }
  const up = (id) => loadHandler('run:publish-handout', deps)(null, { talkSlug: slug, runId: id })
  const down = (id) => loadHandler('run:unpublish-handout', deps)(null, { talkSlug: slug, runId: id })
  // A Run published in 0.39: its folder in the site is never touched by another Run's publish.
  mkdirSync(join(siteDir, 'agents-0-39-run'), { recursive: true })
  writeFileSync(join(siteDir, 'agents-0-39-run', 'index.html'), '<!doctype html><title>0.39</title>')
  persistRunForTalk(vault, slug, 'run-wf', withWork('run-wf', { pre: PRE_ATTACHED, post: POST_ATTACHED }))
  const objectsBefore = worker.created
  const first = await up('run-wf')
  assert.equal(first.success, true, first.error)
  assert.equal(first.warning, undefined, 'no warning: both phases went out')
  const folder = join(siteDir, 'agents-wf')
  for (const page of ['index.html', 'agents-wf.html', join('pre-work', 'index.html'), join('post-work', 'index.html')]) assert.ok(existsSync(join(folder, page)), `the Run's folder holds ${page}`)
  assert.equal(first.url, 'https://talks.test/agents-wf/')
  assert.deepEqual(postWorkAsked, [`${slug}/run-wf`], 'once published, the Run is asked whether its post-work opens now (ticket 19)')

  // The handout links to both pages; no form is embedded in any handout page.
  const home = readFileSync(join(folder, 'index.html'), 'utf8')
  assert.match(home, /id="hhPrework"[\s\S]*href="pre-work\/"/, 'the home page links to the pre-work page')
  assert.match(home, /id="hhPostwork"[\s\S]*href="post-work\/"/, 'and to the post-work page')
  for (const page of ['index.html', 'agents-wf.html', 'agents-wf-download.html'].filter((name) => existsSync(join(folder, name)))) {
    const html = readFileSync(join(folder, page), 'utf8')
    assert.equal(/startPreworkForm|prework-form|data-prework-host|PREWORK_CONFIG = \{/.test(html), false, `${page}: no form embedded`)
    assert.equal(html.includes('Zebrafinch'), false, `${page}: the talk's own {prework} section is not a slide`)
  }
  assert.deepEqual([built.at(-1).homePrework?.href, built.at(-1).homePostwork?.href], ['pre-work/', 'post-work/'])

  // Each phase's object: the public form and its window.
  assert.equal(worker.created, objectsBefore + 2, 'one object per phase')
  const run = readRunForTalk(vault, slug, 'run-wf')
  const ids = { pre: service.status(slug, 'run-wf', 'pre')?.preworkId, post: service.status(slug, 'run-wf', 'post')?.preworkId }
  assert.ok(ids.pre && ids.post && ids.pre !== ids.post)
  // Ticket 19 review round 2: each row records the vault the Run was published from (post-work opens only there).
  assert.deepEqual([service.status(slug, 'run-wf', 'pre')?.vaultRoot, service.status(slug, 'run-wf', 'post')?.vaultRoot], [vault, vault])
  const preObject = worker.objects.get(ids.pre)
  const postObject = worker.objects.get(ids.post)
  assert.equal(preObject.form.closesAt, Date.UTC(2099, 9, 6, 8), 'pre-work closes at 09:00 London (08:00 UTC in October)')
  assert.equal(postObject.form.phase, 'post')
  assert.equal(postObject.form.closesAt - postObject.form.opensAt, 1, 'post-work is not yet open: it opens when the session ends')
  assert.equal(RIGHT.test(JSON.stringify(preObject.form)) || RIGHT.test(JSON.stringify(postObject.form)), false, 'the forms sent carry no right answer')
  assert.deepEqual(preObject.form.form.steps.map((step) => step.id), ['watch', 'quick-check', 'try-a-prompt', 'what-you-want'])

  // The work pages: their object, a Worker address others can reach, the handout's link.
  for (const [phase, id] of [['pre', ids.pre], ['post', ids.post]]) {
    const html = readFileSync(join(folder, WORK_PAGE_FOLDER[phase], 'index.html'), 'utf8')
    const config = startLine(html)
    assert.deepEqual([config.phase, config.preworkId, config.workerBaseUrl, config.handoutUrl], [phase, id, 'https://live.example.test', first.url], `${phase}-work page config`)
  }
  assert.match(readFileSync(join(folder, 'pre-work', 'index.html'), 'utf8'), /The caveats and limitations/, 'the options are on the page')

  // Every file of the Run's folder (what is uploaded): no address on this computer, no right answer.
  const files = filesIn(folder)
  assert.ok(files.length >= 4)
  for (const file of files) {
    const text = readFileSync(file, 'latin1')
    assert.equal(LOOPBACK.test(text), false, `${file.slice(folder.length)}: no address on this computer`)
    assert.equal(RIGHT.test(text), false, `${file.slice(folder.length)}: no right answer`)
  }

  // The Run: both files pinned, both phases published.
  assert.equal(run.handoutUrl, first.url)
  for (const phase of ['pre', 'post']) {
    assert.ok(run.work[phase].pinned?.revision !== undefined, `${phase}: pinned`)
    assert.ok(Date.parse(run.work[phase].publishedAt) > 0, `${phase}: stamped published`)
  }
  const pinnedPre = run.work.pre.pinned

  // Unpublish (ticket 17): every page of the Run's folder shows "This page is not available" at the same
  // address, the rest of the folder goes, both phases are withdrawn on the Worker (not closed), the Run
  // keeps its link and both phases are stamped unpublished.
  const NA = await buildNotAvailablePage(join(REPO, 'compiler/scripts'))
  const pagesBefore = filesIn(folder).filter((file) => /\.html$/.test(file)).sort()
  const withdrawsBefore = worker.withdraws.length
  const removed = await down('run-wf')
  assert.equal(removed.success, true, removed.error)
  assert.deepEqual(filesIn(folder).sort(), pagesBefore, 'the same pages at the same addresses, and nothing else of the folder')
  for (const file of pagesBefore) assert.equal(readFileSync(file, 'utf8'), NA, `${file.slice(folder.length)} shows "This page is not available"`)
  assert.deepEqual(worker.withdraws.slice(withdrawsBefore), [[ids.pre, true], [ids.post, true]], 'both phases withdrawn')
  assert.deepEqual([preObject.withdrawn, postObject.withdrawn, preObject.closed], [true, true, false], 'withdrawn, not closed: the answers stay')
  const afterDown = readRunForTalk(vault, slug, 'run-wf')
  assert.equal(afterDown.handoutUrl, first.url, 'the Run keeps its link')
  assert.ok(Date.parse(afterDown.work.pre.unpublishedAt) >= Date.parse(afterDown.work.pre.publishedAt) && afterDown.work.post.unpublishedAt, 'both phases stamped unpublished')
  assert.equal(readFileSync(join(siteDir, 'agents-0-39-run', 'index.html'), 'utf8'), '<!doctype html><title>0.39</title>', 'another Run\'s folder is untouched')

  // The vault file changes; republishing uses the pinned copy and the same objects.
  writeFileSync(join(workDir, 'research-teams-intake.md'), PRE_WORK.replace('revision: 3', 'revision: 4').replace('Four short steps', 'Okapiword changed text'))
  const again = await up('run-wf')
  assert.equal(again.success, true, again.error)
  assert.equal(again.url, first.url, 'Publish again: the same address')
  assert.deepEqual(worker.withdraws.slice(withdrawsBefore + 2), [[ids.pre, false], [ids.post, false]], 'and both phases served again')
  assert.deepEqual([preObject.withdrawn, postObject.withdrawn], [false, false])
  assert.notEqual(readFileSync(join(folder, 'index.html'), 'utf8'), NA, 'the handout is back')
  assert.equal(worker.created, objectsBefore + 2, 'republishing reuses both objects')
  assert.deepEqual(readRunForTalk(vault, slug, 'run-wf').work.pre.pinned, pinnedPre, 'and the pin')
  const republished = readFileSync(join(folder, 'pre-work', 'index.html'), 'utf8')
  assert.equal(republished.includes('Okapiword'), false, 'the page is the pinned copy, not the edited file')
  assert.ok(republished.includes('Four short steps'))
  assert.equal(startLine(republished).preworkId, ids.pre)
  assert.equal(readFileSync(join(siteDir, 'agents-0-39-run', 'index.html'), 'utf8'), '<!doctype html><title>0.39</title>', 'a 0.39 Run folder is untouched')
  writeFileSync(join(workDir, 'research-teams-intake.md'), PRE_WORK)
  assert.equal((await down('run-wf')).success, true)
}

// 0e. Ticket 17 fix round, through the real handlers and the REAL work service:
//   - the folder a publish wrote is recorded on the Run, and Publish again uses it;
//   - pre-work taken off the Run after it went out is still withdrawn by Unpublish;
//   - a withdraw failure is a fixed sentence, the Worker's text only in Details, without the owner key;
//   - a withdraw the Worker applied but whose answer was lost: Publish again still serves the phase again;
//   - a legacy Run's registered short id is the registry's folder only, never a site folder named by the id.
{
  const deps = { ...runHandlerDeps, runHandoutSlug: () => 'agents-wf2' }
  const up = (id) => loadHandler('run:publish-handout', deps)(null, { talkSlug: slug, runId: id })
  const down = (id) => loadHandler('run:unpublish-handout', deps)(null, { talkSlug: slug, runId: id })
  persistRunForTalk(vault, slug, 'run-wf2', withWork('run-wf2', { pre: PRE_ATTACHED, post: POST_ATTACHED }))
  const first = await up('run-wf2')
  assert.equal(first.success, true, first.error)
  assert.equal(readRunForTalk(vault, slug, 'run-wf2').handoutFolder, 'agents-wf2', 'the folder the publish wrote is recorded with the link')
  const ids = { pre: service.status(slug, 'run-wf2', 'pre').preworkId, post: service.status(slug, 'run-wf2', 'post').preworkId }
  const folder = join(siteDir, 'agents-wf2')
  const NA = await buildNotAvailablePage(join(REPO, 'compiler/scripts'))

  // Pre-work detached after it went out: Unpublish still withdraws it (the service's record of what was sent).
  const detached = readRunForTalk(vault, slug, 'run-wf2')
  persistRunForTalk(vault, slug, 'run-wf2', normaliseRun({ ...detached, work: { post: detached.work.post } }))
  let mark = worker.withdraws.length
  const removed = await down('run-wf2')
  assert.equal(removed.success, true, removed.error)
  assert.deepEqual(worker.withdraws.slice(mark), [[ids.pre, true], [ids.post, true]], 'both phases withdrawn, the detached pre-work too')
  assert.equal(worker.objects.get(ids.pre).withdrawn, true)
  assert.equal(readFileSync(join(folder, 'index.html'), 'utf8'), NA)

  // Publish again (post-work only now): the same folder and address, post-work served again; pre-work stays withdrawn.
  mark = worker.withdraws.length
  const again = await up('run-wf2')
  assert.deepEqual([again.success, again.url], [true, first.url], again.error)
  assert.deepEqual(worker.withdraws.slice(mark), [[ids.post, false]])
  assert.deepEqual([worker.objects.get(ids.pre).withdrawn, worker.objects.get(ids.post).withdrawn], [true, false])

  // NO RAW TEXT: a refused withdraw is a fixed sentence; the Worker's words only in Details, without the owner key.
  worker.withdrawFault = 'refuse'
  const refused = await down('run-wf2')
  worker.withdrawFault = null
  assert.equal(refused.success, false)
  assert.equal(refused.error, 'Pre-work could not be changed (HTTP 500). Try again.', 'the service\'s fixed sentence, never its reply')
  assert.match(refused.details, /^internal: stack trace at \/srv\/worker\.js with \[owner key\]$/, 'its reply in Details, cleaned')
  assert.notEqual(readFileSync(join(folder, 'index.html'), 'utf8'), NA, 'nothing written: the Run is still published')

  // A withdraw applied on the Worker whose answer is lost: Unpublish fails and stamps nothing, but the
  // request was noted first, so Publish again serves the phase again.
  worker.withdrawFault = 'lost'
  mark = worker.withdraws.length
  const lost = await down('run-wf2')
  worker.withdrawFault = null
  assert.equal(lost.success, false)
  assert.equal(lost.error, 'The pre-work service could not be reached, so nothing was changed. Try again.')
  assert.deepEqual([worker.withdraws.slice(mark), worker.objects.get(ids.post).withdrawn], [[[ids.pre, true]], false], 'the pre-work withdraw reached the Worker and was applied')
  // Post-work, published again since it was last unpublished: its withdraw is applied and the answer lost,
  // so neither the Run's stamps nor a known withdrawal prove anything; only the note made before asking.
  worker.withdrawFault = 'lost'
  const lostPost = await service.withdraw(slug, 'run-wf2', 'post', true)
  worker.withdrawFault = null
  assert.equal(lostPost.ok, false)
  assert.deepEqual([worker.objects.get(ids.post).withdrawn, service.status(slug, 'run-wf2', 'post').withdrawnAt, typeof service.status(slug, 'run-wf2', 'post').withdrawAskedAt],
    [true, undefined, 'number'], 'withdrawn on the Worker, not known to be here, but noted as asked')
  const runNow = readRunForTalk(vault, slug, 'run-wf2')
  assert.ok(!runNow.work.post.unpublishedAt || Date.parse(runNow.work.post.unpublishedAt) < Date.parse(runNow.work.post.publishedAt), 'the Run is not stamped unpublished')
  mark = worker.withdraws.length
  const restored = await up('run-wf2')
  assert.equal(restored.success, true, restored.error)
  assert.deepEqual(worker.withdraws.slice(mark), [[ids.post, false]], 'Publish again serves post-work again')
  assert.equal(worker.objects.get(ids.post).withdrawn, false)
  assert.equal(service.status(slug, 'run-wf2', 'post').withdrawAskedAt, undefined, 'and the note is cleared')

  // A Run from before the folder was recorded, linked by its registered short id, and another folder of the
  // site that happens to carry that id as its name (amended D2): the registry's folder agents-wf2 and only
  // that. Publish again and Unpublish both work on agents-wf2; the folder called by the id is untouched.
  const clash = 'agents-wf2-clash'
  mkdirSync(join(siteDir, clash), { recursive: true })
  writeFileSync(join(siteDir, clash, 'index.html'), 'another handout')
  const legacy = readRunForTalk(vault, slug, 'run-wf2')
  delete legacy.handoutFolder
  persistRunForTalk(vault, slug, 'run-wf2', normaliseRun({ ...legacy, handoutUrl: `https://talks.test/${clash}` }))
  const clashDeps = { ...deps, readHandoutRegistry: () => ({ 'agents-wf2': clash }) }
  const bound = await loadHandler('run:publish-handout', clashDeps)(null, { talkSlug: slug, runId: 'run-wf2' })
  assert.equal(bound.success, true, bound.error)
  assert.deepEqual([readRunForTalk(vault, slug, 'run-wf2').handoutFolder, existsSync(join(siteDir, 'agents-wf2', 'index.html')), readFileSync(join(siteDir, clash, 'index.html'), 'utf8')], ['agents-wf2', true, 'another handout'], 'Publish again: into agents-wf2, never the folder called by the id')
  const relegacy = readRunForTalk(vault, slug, 'run-wf2')
  delete relegacy.handoutFolder
  persistRunForTalk(vault, slug, 'run-wf2', normaliseRun({ ...relegacy, handoutUrl: `https://talks.test/${clash}` }))
  const boundDown = await loadHandler('run:unpublish-handout', clashDeps)(null, { talkSlug: slug, runId: 'run-wf2' })
  assert.equal(boundDown.success, true, boundDown.error)
  assert.deepEqual([readFileSync(join(folder, 'index.html'), 'utf8'), readFileSync(join(siteDir, clash, 'index.html'), 'utf8')], [NA, 'another handout'], 'Unpublish: agents-wf2 "not available", the folder called by the id untouched')
  rmSync(join(siteDir, clash), { recursive: true, force: true })
  persistRunForTalk(vault, slug, 'run-wf2', normaliseRun({ ...legacy, handoutUrl: first.url, handoutFolder: 'agents-wf2' }))
  assert.equal((await down('run-wf2')).success, true)
  // The Run's folder missing from the site's copy: refused, nothing withdrawn.
  assert.equal((await up('run-wf2')).success, true)
  rmSync(folder, { recursive: true, force: true })
  mark = worker.withdraws.length
  const noFolder = await down('run-wf2')
  assert.deepEqual([noFolder.success, noFolder.error, worker.withdraws.length], [false, UNPUBLISH_FOLDER_MISSING, mark])
  assert.equal((await up('run-wf2')).success, true, 'Publish again writes the folder back')
  assert.ok(existsSync(join(folder, 'index.html')))
  assert.equal((await down('run-wf2')).success, true, 'and Unpublish then works')
}

// 0f. Ticket 17 round 3, through the real handlers and the REAL work service:
//   - D4: the Run's recorded folder (a collision-suffixed name) missing on this computer: Publish again
//     writes into that same name, not a fresh slug, so the link is the same; another Run recording that
//     name refuses before anything is pushed or written;
//   - D1: both attachments taken off after they went out: Unpublish still REPLACES (the service's record
//     is the sent set), keeps the link, and the Run reads Unpublished on the checklist.
{
  const SUFFIXED = 'agents-wf3-2'
  const deps = { ...runHandlerDeps, runHandoutSlug: () => SUFFIXED }
  const fresh = { ...runHandlerDeps, runHandoutSlug: () => 'agents-wf3' }
  const up = (d = deps) => loadHandler('run:publish-handout', d)(null, { talkSlug: slug, runId: 'run-wf3' })
  const down = () => loadHandler('run:unpublish-handout', deps)(null, { talkSlug: slug, runId: 'run-wf3' })
  persistRunForTalk(vault, slug, 'run-wf3', withWork('run-wf3', { pre: PRE_ATTACHED, post: POST_ATTACHED }))
  const first = await up()
  assert.equal(first.success, true, first.error)
  assert.equal(readRunForTalk(vault, slug, 'run-wf3').handoutFolder, SUFFIXED)
  const folder = join(siteDir, SUFFIXED)

  // D4: the folder lost on this computer; the name a fresh publish would pick is different.
  rmSync(folder, { recursive: true, force: true })
  const again = await up(fresh)
  assert.deepEqual([again.success, again.url], [true, first.url], again.error)
  assert.deepEqual([existsSync(join(folder, 'index.html')), existsSync(join(folder, 'pre-work', 'index.html')), existsSync(join(siteDir, 'agents-wf3'))], [true, true, false], 'written into the recorded folder, not a fresh slug')
  assert.equal(readRunForTalk(vault, slug, 'run-wf3').handoutFolder, SUFFIXED)

  // D4: another Run has recorded that folder: refused, nothing pushed, built or uploaded.
  persistRunForTalk(vault, slug, 'run-wf3-other', normaliseRun({ ...planned('run-wf3-other'), handoutUrl: first.url, handoutFolder: SUFFIXED }))
  rmSync(folder, { recursive: true, force: true })
  const counts = [worker.created, worker.forms, trace.deploys, built.length]
  const taken = await up(fresh)
  assert.deepEqual([taken.success, taken.error], [false, RUN_FOLDER_UNCLEAR])
  assert.deepEqual([worker.created, worker.forms, trace.deploys, built.length, existsSync(folder), existsSync(join(siteDir, 'agents-wf3'))], [...counts, false, false], 'nothing pushed, built, written or uploaded')
  persistRunForTalk(vault, slug, 'run-wf3-other', clearRunHandoutUrl(readRunForTalk(vault, slug, 'run-wf3-other')))
  assert.equal((await up(fresh)).url, first.url, 'once no other Run holds it, the same folder again')

  // D1: both attachments taken off the Run after they went out. The sent set comes only from the service's
  // record, and it still chooses REPLACE: every page "not available", the link and folder kept, both withdrawn.
  const ids = { pre: service.status(slug, 'run-wf3', 'pre').preworkId, post: service.status(slug, 'run-wf3', 'post').preworkId }
  const attached = readRunForTalk(vault, slug, 'run-wf3')
  const bare = { ...attached }
  delete bare.work
  persistRunForTalk(vault, slug, 'run-wf3', normaliseRun(bare))
  assert.equal(readRunForTalk(vault, slug, 'run-wf3').work, undefined)
  const mark = worker.withdraws.length
  const removed = await down()
  assert.equal(removed.success, true, removed.error)
  assert.deepEqual(worker.withdraws.slice(mark), [[ids.pre, true], [ids.post, true]], 'both phases withdrawn')
  const NA = await buildNotAvailablePage(join(REPO, 'compiler/scripts'))
  for (const page of ['index.html', 'pre-work/index.html', 'post-work/index.html']) assert.equal(readFileSync(join(folder, page), 'utf8'), NA, `${page} "not available" at the same address`)
  const after = readRunForTalk(vault, slug, 'run-wf3')
  assert.deepEqual([after.handoutUrl, after.handoutFolder, typeof after.unpublishedAt], [first.url, SUFFIXED, 'string'], 'REPLACE, not REMOVE: the link and folder kept, the Run stamped')
  assert.equal(runChecklist(sessionSource('v', after), new Date('2026-10-16T10:00:00Z')).publication, 'unpublished', 'the checklist says Unpublished')
  // Publish again: published, the Run's stamp gone.
  const restored = await up()
  assert.deepEqual([restored.success, restored.url], [true, first.url], restored.error)
  const back = readRunForTalk(vault, slug, 'run-wf3')
  assert.deepEqual([back.unpublishedAt, runChecklist(sessionSource('v', back), new Date('2026-10-16T10:00:00Z')).publication], [undefined, 'published'])
  assert.equal((await down()).success, true)
}

// 0b. A file that is not ready refuses the publish, with the finding, before anything is done.
{
  const deps = { ...runHandlerDeps, runHandoutSlug: () => 'agents-wf-bad' }
  const up = (id) => loadHandler('run:publish-handout', deps)(null, { talkSlug: slug, runId: id })
  writeFileSync(join(workDir, 'clashing-ids.md'), ['---', 'id: clashing-ids', 'title: Clashing ids', 'revision: 1', '---', '', '### One', '{id=same}{poll=open}', '', '### Two', '{id=same}{poll=open}', ''].join('\n'))
  const cases = [
    ['run-wf-dup', { pre: { ...PRE_ATTACHED, fileId: 'clashing-ids' } }, /Clashing ids[\s\S]*share the id “same”/],
    ['run-wf-missing', { pre: PRE_ATTACHED, post: { ...POST_ATTACHED, fileId: 'not-there' } }, /post-work file “not-there” was not found/],
    ['run-wf-window', { pre: { ...PRE_ATTACHED, opens: '2099-10-07T09:00' } }, /^Pre-work closes before it opens; fix the dates in the plan\.$/],
  ]
  for (const [id, work, finding] of cases) {
    persistRunForTalk(vault, slug, id, withWork(id, work))
    const counts = [worker.created, built.length, trace.deploys]
    const result = await up(id)
    assert.equal(result.success, false, `${id} is refused`)
    assert.match(result.error, finding, `${id}: the refusal names its reason`)
    assert.deepEqual([worker.created, built.length, trace.deploys], counts, `${id}: nothing pushed, built or uploaded`)
    assert.equal(existsSync(join(siteDir, 'agents-wf-bad')), false, `${id}: nothing written`)
    const stored = readRunForTalk(vault, slug, id)
    assert.deepEqual([stored.handoutUrl, stored.work.pre?.pinned, stored.work.pre?.publishedAt], [undefined, undefined, undefined], `${id}: nothing pinned or stamped`)
  }
}

// 0d. Preview page: built on this computer into the Run's own vault folder, asking nothing of the Worker.
{
  persistRunForTalk(vault, slug, 'run-preview', withWork('run-preview', { pre: PRE_ATTACHED }))
  const counts = [worker.created, trace.deploys]
  const siteBefore = filesIn(siteDir).sort()
  const preview = await buildRunWorkPreview({ vaultRoot: vault, run: readRunForTalk(vault, slug, 'run-preview'), compilerDir: join(REPO, 'compiler/scripts'), talkTitle: 'Agents' })
  assert.equal(preview.ok, true, preview.error)
  assert.ok(preview.path.startsWith(join(vault, '_PRESENTATIONS', slug)) && preview.path.endsWith('preview-pre.html'), 'written in the Run\'s folder in the vault')
  const html = readFileSync(preview.path, 'utf8')
  const config = startLine(html)
  assert.deepEqual([config.preview, config.preworkId, config.workerBaseUrl], [true, 'preview', 'https://preview.invalid'], 'the page runs offline')
  assert.deepEqual(config.previewWindow, { opensAt: zonedLocalToMs(PRE_ATTACHED.opens, TZ), closesAt: zonedLocalToMs(PRE_ATTACHED.closes, TZ) }, 'the preview carries the Run\'s own opening and closing times, not a week from now')
  assert.equal(RIGHT.test(html) || LOOPBACK.test(html), false)
  assert.deepEqual([worker.created, trace.deploys, filesIn(siteDir).sort()], [...counts, siteBefore], 'nothing pushed, uploaded or written to the site')
  assert.equal(readRunForTalk(vault, slug, 'run-preview').work.pre.pinned, undefined, 'and nothing pinned')
  persistRunForTalk(vault, slug, 'run-nowork', planned('run-nowork'))
  assert.deepEqual(await buildRunWorkPreview({ vaultRoot: vault, run: readRunForTalk(vault, slug, 'run-nowork'), compilerDir: join(REPO, 'compiler/scripts'), talkTitle: 'Agents' }), { ok: false, error: WORK_PREVIEW_NONE })
}

// 0c. Pre-work written in the talk (a 0.39 Run) is not sent.
{
  const deps = { ...runHandlerDeps, runHandoutSlug: () => 'agents-legacy' }
  persistRunForTalk(vault, slug, 'run-legacy', planned('run-legacy'))
  assert.equal(readRunForTalk(vault, slug, 'run-legacy').work.pre.fileId, 'legacy-section')
  const created = worker.created
  const legacy = await loadHandler('run:publish-handout', deps)(null, { talkSlug: slug, runId: 'run-legacy' })
  assert.equal(legacy.success, true, legacy.error)
  assert.equal(legacy.warning, WORK_LEGACY_NOT_PUBLISHED)
  assert.equal(worker.created, created, 'no object is made')
  assert.deepEqual([existsSync(join(siteDir, 'agents-legacy', 'index.html')), existsSync(join(siteDir, 'agents-legacy', 'pre-work'))], [true, false])
  assert.equal((await loadHandler('run:unpublish-handout', deps)(null, { talkSlug: slug, runId: 'run-legacy' })).success, true)
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
        // A short id the registry gives a hostile name (no folder recorded, amended D2): that name only, never a
        // folder of the site, so missing here; the Run gets a new folder, as a first publish does.
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

// 1e. Ticket 17 round 3, finding 1: two open vaults hold the same talk and the same Run identity. Publish
//     and Unpublish name the selected Run's vault and act on that vault's Run only; a vault that is not
//     open is refused, never replaced by the first writable vault.
{
  const vaultB = join(root, 'vault-b')
  mkdirSync(join(vaultB, slug), { recursive: true })
  mkdirSync(join(vaultB, '_PRESENTATIONS', slug), { recursive: true })
  const outlineB = join(vaultB, slug, `${slug}-outline.md`)
  writeFileSync(outlineB, OUTLINE)
  const talkB = { slug, outlinePath: outlineB }
  let open = [{ id: 'va', root: vault }, { id: 'vb', root: vaultB }]
  const deps = {
    ...runHandlerDeps, runHandoutSlug: () => 'twin-run-b',
    runVaultFor: (vaultId) => runVaultRoot(open, vaultId, () => vault, (r) => r),
    talkInVault: (r, s) => (s !== slug ? null : r === vaultB ? talkB : talk),
  }
  persistRunForTalk(vault, slug, 'run-twin', planned('run-twin'))
  persistRunForTalk(vaultB, slug, 'run-twin', planned('run-twin'))
  const runFileA = join(vault, '_PRESENTATIONS', slug, 'run-twin.json')
  const aBytes = readFileSync(runFileA, 'utf8')
  const ask = (channel, vaultId) => loadHandler(channel, deps)(null, { talkSlug: slug, runId: 'run-twin', ...(vaultId !== undefined ? { vaultId } : {}) })

  const up = await ask('run:publish-handout', 'vb')
  assert.equal(up.success, true, up.error)
  assert.deepEqual([readRunForTalk(vaultB, slug, 'run-twin').handoutFolder, existsSync(join(siteDir, 'twin-run-b', 'index.html')), readFileSync(runFileA, 'utf8')], ['twin-run-b', true, aBytes], 'published: vault B\'s Run, vault A\'s byte for byte as it was')
  const down = await ask('run:unpublish-handout', 'vb')
  assert.equal(down.success, true, down.error)
  assert.deepEqual([readRunForTalk(vaultB, slug, 'run-twin').handoutUrl, existsSync(join(siteDir, 'twin-run-b')), readFileSync(runFileA, 'utf8')], [undefined, false, aBytes], 'unpublished: vault B\'s Run, vault A\'s untouched')

  // Vault B's Run published again, then vault B closed: refused, nothing done to either vault's Run.
  assert.equal((await ask('run:publish-handout', 'vb')).success, true)
  const bBytes = readFileSync(join(vaultB, '_PRESENTATIONS', slug, 'run-twin.json'), 'utf8')
  open = [{ id: 'va', root: vault }]
  for (const vaultId of ['vb', 'vz', '', 7, null]) {
    for (const channel of ['run:publish-handout', 'run:unpublish-handout']) {
      const refused = await ask(channel, vaultId)
      assert.deepEqual([refused.success, refused.error], [false, RUN_VAULT_NOT_OPEN], `${channel} with vault ${JSON.stringify(vaultId)}: refused`)
    }
  }
  assert.deepEqual([readFileSync(runFileA, 'utf8'), readFileSync(join(vaultB, '_PRESENTATIONS', slug, 'run-twin.json'), 'utf8'), existsSync(join(siteDir, 'twin-run-b', 'index.html'))], [aBytes, bBytes, true], 'nothing written to either Run or the site')
  // Clean up: vault B's pages off the site.
  open = [{ id: 'va', root: vault }, { id: 'vb', root: vaultB }]
  assert.equal((await ask('run:unpublish-handout', 'vb')).success, true)
}

// 2. A window that closes before it opens refuses the publish in plain words (a work file's window).
{
  persistRunForTalk(vault, slug, 'run-bad', withWork('run-bad', { post: { ...POST_ATTACHED, opens: '2099-10-21T09:00', closes: '2099-10-20T17:00' } }))
  const before = built.length
  const result = await publish(null, { talkSlug: slug, runId: 'run-bad' })
  assert.deepEqual(result, { success: false, error: 'Post-work closes before it opens; fix the dates in the plan.' })
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

// 3b. A talk that NAMES work files (prework: / postwork:) still publishes a handout with no work-file step
//     in it, whether published or exported (work-files ticket 23): they go out with a Run, never with the talk.
{
  const named = OUTLINE.replace('title: The current state of AI agents', 'title: The current state of AI agents\nprework: research-teams-intake\npostwork: after-the-session')
  assert.notEqual(named, OUTLINE)
  const evergreen = { ...common, outlineRefused: (p) => outlineRefusal(vault, p),
    resolveImageRefs: (text) => text, resolvePooledRefs: (text) => text, readHandoutUrl: () => null, app: { getPath: () => root },
    ledgerSeal: async () => {}, localHandoutWorkerBaseUrl: () => 'http://127.0.0.1:8787' }
  const published = await loadHandler('talk:publish-handout', evergreen)(null, outlinePath, named)
  assert.equal(published.success, true, published.error)
  const exported = await loadHandler('talk:export-handout', evergreen)(null, outlinePath, named)
  assert.equal(exported.success, true, exported.error)
  for (const [label, page] of [['published', readFileSync(join(siteDir, slug, `${slug}.html`), 'utf8')], ['exported', readFileSync(exported.path, 'utf8')]]) {
    assert.ok(page.includes('Kestrelwing'), `${label}: the talk's own slides are there`)
    for (const step of ['Watch: what the tools can do', 'Try one prompt on a paper of your own', 'What do you most want from the session?', 'How useful was the session for your work?', 'One thing you will try', 'Anything unclear?', 'Research teams intake', 'After the session']) {
      assert.equal(page.includes(step), false, `${label}: a talk naming work files has no work-file step in its handout ("${step}")`)
    }
  }
}

// 4. Extras for this run (work-files ticket 24): the intro note and links kept on the Run show on the Run's
//    handout home page from its next publish, escaped, and only there; a link that is not http(s) never reaches
//    a page; the talk's own handout pages are byte for byte the same before and after the Run has extras.
{
  const evergreen = { ...common, outlineRefused: (p) => outlineRefusal(vault, p),
    resolveImageRefs: (text) => text, resolvePooledRefs: (text) => text, readHandoutUrl: () => null, app: { getPath: () => root },
    ledgerSeal: async () => {}, localHandoutWorkerBaseUrl: () => 'http://127.0.0.1:8787' }
  const talkFolder = join(siteDir, slug)
  const snapshot = () => new Map(filesIn(talkFolder).sort().map((file) => [file.slice(talkFolder.length), readFileSync(file)]))
  const publishTalk = async () => {
    const published = await loadHandler('talk:publish-handout', evergreen)(null, outlinePath, OUTLINE)
    assert.equal(published.success, true, published.error)
  }
  await publishTalk()
  const talkBefore = snapshot()
  assert.ok(talkBefore.size >= 3, 'the talk handout has its pages')

  const deps = { ...runHandlerDeps, runHandoutSlug: () => 'agents-ex' }
  const up = (id) => loadHandler('run:publish-handout', deps)(null, { talkSlug: slug, runId: id })
  persistRunForTalk(vault, slug, 'run-ex', planned('run-ex', { preworkOpens: undefined }))
  const first = await up('run-ex')
  assert.equal(first.success, true, first.error)
  const folder = join(siteDir, 'agents-ex')
  assert.equal(readFileSync(join(folder, 'index.html'), 'utf8').includes('id="hhExtras"'), false, 'no extras: no card')
  assert.equal(readFileSync(join(folder, 'index.html'), 'utf8').includes('id="hhAbout"'), false, 'before the slides are out, the handout page carries no slide-count card')

  // Added on the Run page (the one writer: setRunExtras, as sessions:set-extras calls it) and, beside them,
  // a link edited into the Run file by hand that is not a web address.
  const kept = setRunExtras(vault, slug, 'run-ex', {
    intro: 'Bring a laptop & a paper <script>alert("Quokkanote")</script>\nSecond line',
    links: [{ url: 'https://example.org/reading?a=1&b=2', label: 'Reading "list" <img src=x onerror=alert(1)>' }, { url: 'https://example.org/plain' }],
  })
  assert.ok(kept.extras)
  const file = runPathForTalk(vault, slug, 'run-ex')
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  onDisk.extras.links.push({ url: 'javascript:alert(1)', label: 'Sneaky' }, { url: 'data:text/html,<b>x</b>', label: 'Sneaky data' })
  writeFileSync(file, JSON.stringify(onDisk))
  const again = await up('run-ex')
  assert.equal(again.success, true, again.error)
  assert.equal(again.url, first.url)

  const home = readFileSync(join(folder, 'index.html'), 'utf8')
  const card = /<section class="hh-card hh-list" id="hhExtras" data-hh-for="before handout">[\s\S]*?<\/section>/.exec(home)?.[0]
  assert.ok(card, 'the Run home page has the extras card')
  assert.ok(card.includes('Bring a laptop &amp; a paper &lt;script&gt;alert(&quot;Quokkanote&quot;)&lt;/script&gt;<br>Second line'), 'the intro is escaped, its line break kept')
  assert.ok(card.includes('href="https://example.org/reading?a=1&amp;b=2" target="_blank" rel="noopener noreferrer"'), 'the link, escaped in its attribute')
  assert.ok(card.includes('Reading &quot;list&quot; &lt;img src=x onerror=alert(1)&gt;'), 'the label is escaped')
  assert.ok(card.includes('href="https://example.org/plain"') && card.includes('<span class="hh-row-text">example.org</span>'), 'a link without a name shows its host')
  assert.equal(/<script>alert|<img src=x/.test(home), false, 'no markup from the extras on the page')
  assert.equal(/javascript:|data:text\/html|Sneaky/.test(card), false, 'a link that is not http(s) never reaches the page')
  for (const page of ['agents-ex.html', 'agents-ex-download.html']) {
    assert.equal(readFileSync(join(folder, page), 'utf8').includes('Quokkanote'), false, `${page}: the slides pages carry no extras`)
  }
  // The Run reads with its good links only, and the next write drops the bad ones from the file.
  assert.deepEqual(readRunForTalk(vault, slug, 'run-ex').extras, kept.extras)

  // The talk's own handout: published again after the Run has extras, every page is byte for byte the same.
  await publishTalk()
  const talkAfter = snapshot()
  assert.deepEqual([...talkAfter.keys()], [...talkBefore.keys()], 'the same files')
  for (const [name, bytes] of talkBefore) assert.ok(bytes.equals(talkAfter.get(name)), `${name}: byte-identical`)
  for (const bytes of talkAfter.values()) assert.equal(bytes.includes('Quokkanote') || bytes.includes('hhExtras'), false, 'no extras on the talk handout')
}

const INJECTION = '[click](https://safe "a https://x/onmouseover=alert(1)// z")'
// 5. Extra slides for a Run (work-files ticket 25), kept on the Run record: the Run's handout is its pathway's
//    slides plus its extra slides, in place; another Run never sees them; the talk's own handout and its outline
//    file do not change.
{
  const evergreen = { ...common, outlineRefused: (p) => outlineRefusal(vault, p),
    resolveImageRefs: (text) => text, resolvePooledRefs: (text) => text, readHandoutUrl: () => null, app: { getPath: () => root },
    ledgerSeal: async () => {}, localHandoutWorkerBaseUrl: () => 'http://127.0.0.1:8787' }
  const talkFolder = join(siteDir, slug)
  const snapshot = () => new Map(filesIn(talkFolder).sort().map((file) => [file.slice(talkFolder.length), readFileSync(file)]))
  const publishTalk = async () => {
    const published = await loadHandler('talk:publish-handout', evergreen)(null, outlinePath, readFileSync(outlinePath, 'utf8'))
    assert.equal(published.success, true, published.error)
  }
  await publishTalk()
  const talkBefore = snapshot()
  const original = readFileSync(outlinePath, 'utf8')

  // Two Runs of the talk: one on a pathway (Why we are here, Discuss), one on the whole talk.
  writeFileSync(join(vault, '_PRESENTATIONS', slug, 'manifest.json'), JSON.stringify({ pathways: [{ id: 'short', name: 'Short', slideIds: ['why', 'discuss'] }] }, null, 2) + '\n')
  persistRunForTalk(vault, slug, 'run-sl', planned('run-sl', { preworkOpens: undefined, eventTitle: 'Slides run', slideSet: { kind: 'pathway', pathwayId: 'short' } }))
  persistRunForTalk(vault, slug, 'run-other', planned('run-other', { preworkOpens: undefined, eventTitle: 'Other run' }))
  // Kept on the Run as the Run page keeps them (runs.ts updateRunExtraSlides).
  updateRunExtraSlides(vault, slug, 'run-sl', () => [
    { id: 'extra-quokk', title: 'Quokka datasets', text: 'Which datasets <b>could</b> go into an AI tool?', after: 'why' },
    { id: 'extra-ibisx', title: 'Ibis ethics', text: 'Ethics approval.', after: 'open' },
    // Review round 2: a link title holding an address, an <img> and a bare address are plain text on the handout.
    { id: 'extra-xinjx', title: INJECTION, text: `${INJECTION}\nAn <img src=x onerror=alert(1)> here\nsee https://example.com/page now`, after: 'discuss' },
  ])
  updateRunExtraSlides(vault, slug, 'run-other', () => [{ id: 'extra-pelic', title: 'Pelican other run', text: 'Only for the other run.', after: 'discuss' }])

  const deps = { ...runHandlerDeps, runForHandout: (_talk, run) => runForHandoutOf(run, () => readPathwayManifest(vault, slug).pathways) }
  const up = async (id, folderName) => {
    const result = await loadHandler('run:publish-handout', { ...deps, runHandoutSlug: () => folderName })(null, { talkSlug: slug, runId: id })
    assert.equal(result.success, true, result.error)
    return { result, page: readFileSync(join(siteDir, folderName, `${folderName}-download.html`), 'utf8') }
  }
  const sl = await up('run-sl', 'agents-sl')
  assert.deepEqual(sl.result.slideIds, ['why', 'extra-quokk', 'discuss', 'extra-xinjx', 'extra-ibisx'], 'the pathway\'s slides and the extra slides: after its slide; one whose slide is not in the pathway at the end')
  const shown = [...sl.page.matchAll(/<section class="slide" data-id="([^"]+)"/g)].map((match) => match[1])
  assert.deepEqual(shown, ['why', 'extra-quokk', 'discuss', 'extra-xinjx', 'extra-ibisx'], 'exactly those slides, in that order, on the handout')
  {
    const start = sl.page.indexOf('<section class="slide" data-id="extra-xinjx"')
    const inner = sl.page.slice(sl.page.indexOf('>', start) + 1, sl.page.indexOf('</section>', start)).replace(/&nbsp;/g, ' ')
    const tags = inner.match(/<[^>]+>/g) || []
    assert.equal(tags.some((tag) => /^<(a|img)\b/i.test(tag) || /\s(title|href|onmouseover|onerror|src)=/i.test(tag)), false, 'no tag or attribute from the words on the handout: ' + tags.join(' '))
    const escaped = '[click](https://safe &quot;a https://x/onmouseover=alert(1)// z&quot;)'
    for (const words of [escaped, 'An &lt;img src=x onerror=alert(1)&gt; here', 'see https://example.com/page now']) assert.ok(inner.includes(words), `as typed, escaped: ${words}`)
    assert.equal(/href="https:\/\/x\/onmouseover|href="https:\/\/example\.com\/page"|<img src=x/.test(sl.page), false, 'nowhere on the handout page')
    // The handout's phone text view: the extra slide's lines are its text, shown as text; its title as text.
    const at = shown.indexOf('extra-xinjx')
    const phoneText = JSON.parse(sl.page.match(/var SLIDE_SCRIPT = (.*);\n/)[1])[at]
    assert.deepEqual(phoneText, [{ type: 'p', html: escaped }, { type: 'p', html: 'An &lt;img src=x onerror=alert(1)&gt; here' }, { type: 'p', html: 'see https://example.com/page now' }], 'the phone text has the slide\'s lines, escaped')
    assert.equal(JSON.parse(sl.page.match(/var PHONE_TITLE_HTML = (.*);\n/)[1])[at], escaped, 'the phone title is the title, escaped')
  }
  assert.ok(sl.page.includes('Which datasets &lt;b&gt;could&lt;/b&gt; go into an AI&nbsp;tool?'), 'the slide text is escaped')
  assert.equal(sl.page.includes('<b>could</b>'), false)
  assert.equal(/Pelican other run|Zebrafinch/.test(sl.page), false, 'no other Run\'s slide, no pre-work step')

  const other = await up('run-other', 'agents-other')
  assert.ok(other.page.includes('Pelican other run') && other.page.includes('Kestrelwing'), 'the whole talk and its own extra slide')
  assert.equal(/Quokka datasets|Ibis ethics/.test(other.page), false, 'a second Run of the talk does not see the first Run\'s extra slides')

  assert.equal(readFileSync(outlinePath, 'utf8'), original, 'the talk\'s outline file is never written for them')

  // The talk's own handout: published again while both Runs hold extra slides, byte for byte the same.
  await publishTalk()
  const talkAfter = snapshot()
  assert.deepEqual([...talkAfter.keys()], [...talkBefore.keys()], 'the same files')
  for (const [name, bytes] of talkBefore) assert.ok(bytes.equals(talkAfter.get(name)), `${name}: byte-identical`)
  for (const bytes of talkAfter.values()) assert.equal(/Quokka|Ibis ethics|Pelican/.test(bytes.toString('utf8')), false, 'no extra slide on the talk handout')

  // Removing every extra slide: the outline is still the talk's own bytes.
  for (const runId of ['run-sl', 'run-other']) updateRunExtraSlides(vault, slug, runId, () => [])
  assert.equal(readFileSync(outlinePath, 'utf8'), original)
}

console.log('prework publish: a Run with work files publishes three pages (handout linking to both, pre-work/, post-work/) with no local address and no right answer; pins and objects are reused on republish; a file that is not ready is refused with its finding; legacy pre-work publishes as in 0.39; a window closing before it opens is refused; pre-work steps stay out of the evergreen handout (publish and export), also for a talk that names work files; the extras of a Run show on its handout home page only, escaped, and the talk handout stays byte-identical; a Run’s handout is its pathway’s slides plus its own extra slides, passed')

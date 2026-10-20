// Handout built from the buffer (roadmap idea handout-built-from-the-buffer, 2026-09-28).
// Invariant: what is published equals the editor's buffer at the moment Publish was pressed, and no
// outline is ever written by publishing except through the existing save path (the one writer,
// src/main/talk-writer.ts: an open talk is saved by its editor window; a closed talk is read, not
// rewritten).
// Seams: the REAL ipcMain handlers talk:publish-handout, run:build-handout and run:publish-handout,
// lifted out of src/main/index.ts with the TypeScript compiler (as test-outbound-trigger-gates.mjs
// does), run over a temp talk with the REAL talk writer wired to a fake editor window, and — for the
// talk handout — the REAL bundled compiler, and the REAL publishing sequence (handout-publishing.ts)
// with leave always given. The upload, the live service and the ledger are fakes.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { configureTalkWriter, flushTalkForPublish, withTalkFileLock, writeTalkOutline } from '../src/main/talk-writer.ts'
import { canonicalOutlinePath } from '../src/main/outline-identity.ts'
import { createOutlineMutator } from '../src/renderer/src/lib/outlineMutation.ts'
import { outlineWritesSettled, queueOutlineWrite, setOutlinePathResolver } from '../src/renderer/src/lib/saveQueue.ts'
import { buildRedirects, generateShortId, pickShortId, publishUrl, readHandoutUrl, recoverIdFromUrl, resolveBase } from '../src/main/publishing-logic.ts'
import { randomBytes } from 'node:crypto'
import { FAKE_LIVE_ADDRESS, grantedPublishing } from './lib/publishing-fakes.mjs'
import { PUBLISH_SUPERSEDED_ERROR } from '../src/main/cloudflare-connection.ts'
import { PUBLISH_LINK_REFUSED, publishedFolders, redirectsRefusal, removeSiteFolder, writableSiteFolder } from '../src/main/handout-publishing.ts'
import { SITE_FOLDER_REFUSED } from '../src/main/publishing-logic.ts'
import { stampHandoutUrl } from '../src/shared/handout-stamp.ts'
import { outlineRefusal } from '../src/main/vault-paths.ts'
import { assetRootsForTalk } from '../src/main/asset-roots.ts'
import { withoutPreworkSlides } from '../src/shared/run-prework.ts'
import { handoutHomeDetails, handoutHomePostwork, handoutHomePrework } from '../src/shared/handout-home.ts'
import { planRunWork, sendRunWork, writeRunWorkPages, runLineFor } from '../src/main/run-work-publish.ts'
import { RUN_FOLDER_UNCLEAR, runPublishFolder, runSiteFolder } from '../src/main/run-unpublish.ts'
import { stampRunWork } from '../src/main/runs.ts'
import { WORK_PAGE_FOLDER } from '../src/shared/run-work.ts'
// The pages are built and written as the main process's worker thread does it, here in this process.
import { buildHandoutPages } from '../src/main/handout-pages.ts'

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

const root = mkdtempSync(join(tmpdir(), 'tw-handout-buffer-'))
let seq = 0
const OUTLINE = [
  '---',
  'title: Buffer Talk',
  'handout_url: https://talks.test/buffer-talk-1',
  '---',
  '',
  '## Opening {id=aa11}',
  '',
  '- saved point',
  '',
].join('\n')
function talkFile(text = OUTLINE) {
  const name = `buffer-talk-${++seq}`
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${name}-outline.md`)
  writeFileSync(path, text, 'utf8')
  return path
}

// A fake editor window with the real seams: the REAL buffer-first mutator (lib/outlineMutation.ts,
// its real replies and refusal words) over the REAL shared save queue (lib/saveQueue.ts), whose saves
// write the file IN PLACE — truncate, then write — under the REAL file lock (talk-writer.ts
// withTalkFileLock), as talk:write-outline does. `stamp` makes each save stamp an id (the save's
// returned `content`, adopted into the buffer). Main sees the window exactly as index.ts
// editorOutlineDocument does: read = readForMain, commit = applyFromMain, the reply's text passed on.
setOutlinePathResolver(async (p) => canonicalOutlinePath(p))
const STAMP_FROM = '## Unsaved in the editor\n'
const STAMP_TO = '## Unsaved in the editor {id=st01}\n'
function editorWindow(path, buffer, { stamp = false, failSaves = false } = {}) {
  const ed = { doc: buffer, saves: [], midSave: null, afterCommit: null }
  const inPlace = (text) => withTalkFileLock(path, async (held) => {
    const fh = await open(held.realPath, 'r+')
    try {
      await fh.truncate(0)
      if (ed.midSave) { const hold = ed.midSave; ed.midSave = null; await hold() }
      const bytes = Buffer.from(text, 'utf8')
      await fh.write(bytes, 0, bytes.length, 0)
      await fh.sync()
    } finally { await fh.close() }
  })
  // talk:write-outline: stamps ids, writes in place, answers false when the write fails.
  const save = async (text) => {
    if (failSaves) return false
    const out = stamp ? text.replace(STAMP_FROM, STAMP_TO) : text
    try { await inPlace(out) } catch { return false }
    ed.saves.push(out)
    return out === text ? { ok: true, collisions: [] } : { ok: true, collisions: [], content: out }
  }
  ed.save = (text) => queueOutlineWrite(path, () => save(text))
  ed.mutator = createOutlineMutator({
    bufferFor: (p) => (p === path ? {
      read: () => ed.doc,
      apply: (_p, next) => { ed.doc = next; return ed.doc },
      adopt: (_p, sent, saved) => { if (ed.doc === sent) ed.doc = saved },
    } : null),
    settled: outlineWritesSettled,
    write: (_p, text) => ed.save(text),
  })
  ed.route = {
    async read() { const r = await ed.mutator.readForMain(path); if (!r.ok) throw new Error(r.error); return r.text },
    async commit(base, next, origin) {
      const reply = await ed.mutator.applyFromMain(path, base, next, origin)
      if (reply.ok && ed.afterCommit) { const after = ed.afterCommit; ed.afterCommit = null; await after() }
      return reply.ok ? { ok: true, ...(typeof reply.text === 'string' ? { text: reply.text } : {}) } : { ok: false, error: reply.error, moved: reply.moved === true }
    },
  }
  // The person types just after the flush's save; the autosave of that typing starts at once and is
  // caught mid-write (file truncated, new bytes not yet in) when the window's reply reaches main.
  ed.typeRightAfterCommit = (later, holdMs = 40) => {
    ed.afterCommit = async () => {
      ed.doc = later
      let truncated
      const reached = new Promise((resolve) => { truncated = resolve })
      ed.midSave = () => new Promise((resolve) => { truncated(); setTimeout(resolve, holdMs) })
      ed.autosave = ed.save(later)
      await reached
    }
  }
  ed.idle = async () => { await outlineWritesSettled(path) }
  configureTalkWriter({ editorBufferFor: (p) => (p === path ? ed.route : null) })
  return ed
}
const closeAll = () => configureTalkWriter({ editorBufferFor: () => null })

const BROKEN = { success: false, error: 'This talk has 1 unresolved trigger.' }
const unresolvedOutboundFailure = (text) => (text.includes('{nonsense}') ? BROKEN : null)

// ── talk:publish-handout ────────────────────────────────────────────────────────────────────
function publishDeps(siteDir, trace) {
  const config = { cfAccountId: 'acct', cfPagesProject: 'talks', publishBaseUrl: trace.baseUrl ?? 'https://talks.test', publishUseShortIds: Boolean(trace.registry), publishProdBranch: 'main' }
  // With `trace.registry` (short links on): the REAL short-id and redirect functions over a registry kept in memory.
  const shortIds = trace.registry
    ? { readHandoutUrl, recoverIdFromUrl, readHandoutRegistry: () => ({ ...trace.registry.kept }), writeHandoutRegistry: (next) => { trace.registry.kept = { ...next } }, pickShortId, generateShortId, randomBytes, buildRedirects }
    : null
  return {
    unresolvedOutboundFailure,
    // The real outline guard, with the temp root as the vault (every talk here lives inside it).
    outlineRefused: (p) => outlineRefusal(root, p),
    getCompilerPath: () => join(REPO, 'compiler/scripts'),
    getConfig: (key, fallback) => (key in config ? config[key] : fallback),
    // Vault lookups go through the vault registry (several vaults, ticket 01); no vault here.
    currentVaultRoot: () => config.vaultRoot,
    writableVaultRoot: () => config.vaultRoot,
    vaultRootFor: () => config.vaultRoot,
    // The real root choice (ADR-0036), with the test's vault as the one registered vault.
    assetRootsFor: (path) => assetRootsForTalk({ resolve: () => (config.vaultRoot ? { vault: { root: config.vaultRoot } } : null) }, path),
    handoutPublishing: () => trace.publishing ??= grantedPublishing({
      siteDir, supersede: trace.supersede ?? 'never',
      live: async () => { trace.liveWorker += 1; return { baseUrl: FAKE_LIVE_ADDRESS, adminSecret: 'x' } },
      onUpload: () => { trace.deploys += 1 },
    }),
    flushTalkForPublish,
    statSync, basename, join, pathToFileURL, existsSync, mkdirSync, writeFileSync, readdirSync,
    resolveImageRefs: (text) => text, resolvePooledRefs: (text) => text,
    publishSiteDir: () => siteDir,
    resolveBase, publishUrl, stampHandoutUrl, writeTalkOutline,
    readHandoutUrl: () => null, recoverIdFromUrl: () => undefined, readHandoutRegistry: () => ({}), writeHandoutRegistry: () => {},
    pickShortId: () => { throw new Error('short ids are off') }, generateShortId: () => 'x', randomBytes: () => Buffer.alloc(8), buildRedirects: () => '',
    ...shortIds,
    slimHandoutHtml: (html) => html,
    buildHandoutPagesOffThread: (job) => buildHandoutPages(job, (html) => html),
    SITE_FOLDER_REFUSED, publishedFolders, removeSiteFolder, writableSiteFolder,
    withoutPreworkSlides,
    handoutHomeDetails, handoutHomePrework,
    app: { getPath: () => root },
    ledgerSeal: async (path, text, reason) => { trace.sealed.push({ path, text, reason }) },
  }
}
const handoutOf = (siteDir, path) => {
  const slug = basename(path).replace('-outline.md', '')
  const file = join(siteDir, slug, `${slug}.html`)
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

// 1. The renderer's copy trails the buffer, and the person types again right after the flush's save
//    (its autosave is mid-write — file truncated — when main gets the window's reply): the handout,
//    the ledger seal and the stamp carry exactly the text the flush's save committed, never a torn
//    or later read of the file; every outline write is an editor save.
{
  const path = talkFile()
  const sentByRenderer = OUTLINE + '## Typed and in React {id=bb22}\n\n- Kestrelwing\n'
  const ed = editorWindow(path, sentByRenderer + '\n## Typed just before Publish {id=cc33}\n\n- Zebrafinch\n')
  const atPress = ed.doc
  ed.typeRightAfterCommit(atPress + '\n- Typed during the deploy\n')
  const siteDir = join(root, 'site-1')
  const trace = { liveWorker: 0, deploys: 0, sealed: [] }
  try {
    const publish = loadHandler('talk:publish-handout', publishDeps(siteDir, trace))
    const result = await publish(null, path, sentByRenderer)
    assert.equal(result.success, true, result.error)
    const html = handoutOf(siteDir, path)
    assert.ok(html, 'the handout was built')
    const home = readFileSync(join(siteDir, basename(path).replace('-outline.md', ''), 'index.html'), 'utf8')
    assert.ok(home.includes('id="handoutHome"') && home.includes(`"workerBaseUrl":"${FAKE_LIVE_ADDRESS}"`), 'the home page is the handout bundle in home mode, with its live client')
    assert.ok(home.includes('Kestrelwing'), 'the home page carries the same slides as the handout')
    assert.ok(html.includes('Kestrelwing'), 'the handout has what the renderer sent')
    assert.ok(html.includes('Zebrafinch'), 'the handout has the buffer\'s last keystrokes, which the renderer\'s copy lacked')
    assert.ok(!html.includes('Typed during the deploy'), 'and nothing typed after the flush')
    assert.equal(trace.sealed.length, 1)
    assert.equal(trace.sealed[0].text, atPress, 'the ledger seals exactly the text the flush committed')
    assert.equal(trace.deploys, 1)
    await ed.idle()
    const disk = readFileSync(path, 'utf8')
    assert.equal(disk, ed.doc, 'disk is the buffer (every outline write went through the editor)')
    assert.ok(disk.includes('Typed during the deploy') && disk.includes('handout_url: https://talks.test/buffer-talk-'), 'the stamp is on top of the later typing')
    assert.deepEqual(ed.saves.map((t) => t.includes('Typed during the deploy') ? (t.includes('talks.test/buffer-talk-1\n') ? 'autosave' : 'stamp') : 'flush'), ['flush', 'autosave', 'stamp'])
  } finally {
    closeAll()
  }
}

// 1b. ONE CONNECTION, through the real handler (ticket 04 fix round). "A publish whose upload
//     completed is recorded, whatever happens to the connection afterwards": the token is replaced
//     the moment the upload ends, and the link is still stamped and the ledger sealed (the page is
//     at that address). "A publish superseded before or during its upload … records nothing": the
//     token is replaced while the upload runs, and nothing is stamped or sealed.
for (const [supersede, recorded] of [['after-upload', true], ['during-upload', false]]) {
  const path = talkFile()
  const name = basename(path).replace('-outline.md', '')
  const ed = editorWindow(path, OUTLINE + '\n## Second {id=bb22}\n\n- Kestrelwing\n')
  const siteDir = join(root, `site-superseded-${supersede}`)
  const trace = { liveWorker: 0, deploys: 0, sealed: [], supersede }
  try {
    const result = await loadHandler('talk:publish-handout', publishDeps(siteDir, trace))(null, path, ed.doc)
    await ed.idle()
    const stamp = `handout_url: https://talks.test/${name}/`
    assert.equal(trace.deploys, 1, 'the upload ran')
    if (recorded) {
      assert.equal(result.success, true, result.error)
      assert.equal(result.url, `https://talks.test/${name}/`)
      assert.ok(readFileSync(path, 'utf8').includes(stamp) && ed.doc.includes(stamp), 'the upload completed: the link is written into the outline although the connection has changed since')
      assert.deepEqual(trace.sealed.map((seal) => seal.reason), ['publish'], 'and the publish is in the ledger')
    } else {
      assert.deepEqual([result.success, result.error, result.url], [false, PUBLISH_SUPERSEDED_ERROR, undefined], 'superseded during its upload: the publish says so')
      assert.ok(!readFileSync(path, 'utf8').includes(stamp) && !ed.doc.includes(stamp), 'and no link is written into the outline')
      assert.deepEqual(trace.sealed, [], 'and nothing is sealed in the ledger')
    }
  } finally {
    closeAll()
  }
}

// 1c. ENTRY FIRST, through the real handler (ticket 04 fix round 2): with a site address on this
//     computer in Settings (in any spelling), the publish is refused before anything is built: the
//     site folder is not even made, nothing is uploaded, stamped or sealed.
for (const baseUrl of ['http://localhost:4000', 'http://127.1:4000', 'http://2130706433', 'file:///Users/ada/site']) {
  const path = talkFile()
  const ed = editorWindow(path, OUTLINE)
  const siteDir = join(root, `site-entry-${seq}`)
  const trace = { liveWorker: 0, deploys: 0, sealed: [], baseUrl }
  try {
    const before = readFileSync(path, 'utf8')
    const result = await loadHandler('talk:publish-handout', publishDeps(siteDir, trace))(null, path, ed.doc)
    await ed.idle()
    assert.deepEqual([result.success, result.error], [false, PUBLISH_LINK_REFUSED], `a site address of ${baseUrl} stops the publish`)
    assert.deepEqual([existsSync(siteDir), trace.deploys, trace.sealed.length, readFileSync(path, 'utf8')], [false, 0, 0, before], 'nothing was built, uploaded, sealed or stamped')
  } finally {
    closeAll()
  }
}
// 1d. A talk whose file name reads like an address: its pages' own links stay beside the page.
{
  const name = 'http:127.0.0.1#'
  mkdirSync(join(root, name), { recursive: true })
  const path = join(root, name, `${name}-outline.md`)
  writeFileSync(path, OUTLINE, 'utf8')
  const ed = editorWindow(path, OUTLINE)
  const siteDir = join(root, 'site-awkward-name')
  const trace = { liveWorker: 0, deploys: 0, sealed: [] }
  try {
    const result = await loadHandler('talk:publish-handout', publishDeps(siteDir, trace))(null, path, ed.doc)
    await ed.idle()
    assert.equal(result.success, true, result.error)
    const home = readFileSync(join(siteDir, name, 'index.html'), 'utf8')
    const hrefs = [/<a class="hh-btn" id="hhDownload" data-hh-for="handout" href="([^"]*)" download=/.exec(home)[1], /<a class="hh-btn primary" href="([^"]*)">/.exec(home)[1]]
    assert.deepEqual(hrefs.map((href) => new URL(href, 'https://talks.test/t/').href), [`https://talks.test/t/${encodeURIComponent(`${name}-download.html`)}`, `https://talks.test/t/${encodeURIComponent(`${name}.html`)}`], 'Download and Open slides resolve to the files beside the page')
    assert.ok(existsSync(join(siteDir, name, `${name}-download.html`)) && existsSync(join(siteDir, name, `${name}.html`)), 'which are there under their names')
  } finally {
    closeAll()
  }
}

// 1e. ENTRY FIRST covers redirects, through the real handler (ticket 04 round 3). Talks whose file
//     names hold a space, `#`, `%`, `?` or letters outside ASCII publish, with short links on and
//     off, and every link and redirect leads to that talk's own folder.
{
  const NAMES = ['two words', 'a#b', '50%', 'q?x', 'ünï-講演', 'plain-talk']
  const BASE = 'https://talks.test'
  const shortSite = join(root, 'site-awkward-short')
  const longSite = join(root, 'site-awkward-long')
  const registry = { kept: {} }
  const plainOutline = OUTLINE.replace('handout_url: https://talks.test/buffer-talk-1\n', '')
  for (const name of NAMES) {
    for (const [siteDir, short] of [[shortSite, true], [longSite, false]]) {
      mkdirSync(join(root, `${short ? 's' : 'l'}-awkward`, name), { recursive: true })
      const path = join(root, `${short ? 's' : 'l'}-awkward`, name, `${name}-outline.md`)
      writeFileSync(path, plainOutline, 'utf8')
      const ed = editorWindow(path, plainOutline)
      const trace = { liveWorker: 0, deploys: 0, sealed: [], ...(short ? { registry } : {}) }
      try {
        const result = await loadHandler('talk:publish-handout', publishDeps(siteDir, trace))(null, path, ed.doc)
        await ed.idle()
        assert.equal(result.success, true, `${name} (${short ? 'short links' : 'plain links'}): ${result.error}`)
        assert.ok(existsSync(join(siteDir, name, 'index.html')), `${name}: its pages are in its own folder`)
        const link = new URL(result.url)
        assert.deepEqual([link.origin, link.search, link.hash], [BASE, '', ''], `${name}: its link is on the site, with no query and no fragment (${result.url})`)
        assert.ok(readFileSync(path, 'utf8').includes(`handout_url: ${result.url}`), `${name}: and is stamped as it is`)
        if (short) {
          const id = registry.kept[name]
          assert.equal(result.url, `${BASE}/${id}`)
          const text = readFileSync(join(siteDir, '_redirects'), 'utf8')
          assert.equal(redirectsRefusal(text), null, `${name}: every redirect line is a source, a target and a status`)
          const line = text.split('\n').map((row) => row.split(/\s+/)).find((row) => row[0] === `/${id}`)
          assert.deepEqual([line.length, decodeURIComponent(new URL(line[1], `${BASE}/`).pathname), new URL(line[1], `${BASE}/`).origin, line[2]], [3, `/${name}/`, BASE, '302'], `${name}: its short link leads to its own folder (${line.join(' ')})`)
        } else {
          assert.equal(decodeURIComponent(link.pathname), `/${name}/`, `${name}: its link leads to its own folder`)
        }
        if (name === 'plain-talk') assert.equal(result.url, short ? `${BASE}/${registry.kept[name]}` : `${BASE}/plain-talk/`, 'an ordinary name gives the link it always gave')
      } finally {
        closeAll()
      }
    }
  }
  assert.equal(readFileSync(join(shortSite, '_redirects'), 'utf8').trim().split('\n').length, NAMES.length * 4, 'all of them are in the redirect file together (the link, the venue screen, pre-work and post-work)')
}

// 1f. A talk's folder in the site comes from its file's name: a name that would not stay inside the
//     site folder, or that the computer would not keep as written, or where a link stands, is
//     refused before anything is written (the one function, publishing-logic.ts siteFolder).
{
  const siteDir = join(root, 'site-names', 'site')
  const victim = join(root, 'site-names', 'victim')
  mkdirSync(join(victim, 'deep'), { recursive: true })
  mkdirSync(siteDir, { recursive: true })
  writeFileSync(join(victim, 'deep', 'keep.txt'), 'keep')
  symlinkSync(victim, join(siteDir, 'linked'))
  const all = (dir) => readdirSync(dir, { recursive: true }).map(String).sort()
  const before = [all(join(root, 'site-names')), readFileSync(join(victim, 'deep', 'keep.txt'), 'utf8')]
  for (const name of ['..', '.', 'trailing.', 'trailing ', ' leading', 'NUL', 'com1.x', 'linked']) {
    mkdirSync(join(root, 'named', `d-${seq += 1}`), { recursive: true })
    const path = join(root, 'named', `d-${seq}`, `${name}-outline.md`)
    writeFileSync(path, OUTLINE, 'utf8')
    const ed = editorWindow(path, OUTLINE)
    const trace = { liveWorker: 0, deploys: 0, sealed: [] }
    try {
      const result = await loadHandler('talk:publish-handout', publishDeps(siteDir, trace))(null, path, ed.doc)
      await ed.idle()
      assert.deepEqual([result.success, result.error], [false, SITE_FOLDER_REFUSED], `a talk file named ${JSON.stringify(name)} is refused`)
      assert.deepEqual([[all(join(root, 'site-names')), readFileSync(join(victim, 'deep', 'keep.txt'), 'utf8')], trace.deploys, trace.sealed.length], [before, 0, 0], `${JSON.stringify(name)}: nothing was written inside or outside the site folder`)
    } finally {
      closeAll()
    }
  }
}

// 2. The flush's save fails (not a read-only file): nothing is built, deployed or sealed, and the
//    refusal is publishing's own — it never tells the person to undo (⌘Z would undo their own edit).
{
  const path = talkFile()
  const ed = editorWindow(path, OUTLINE + '## Unsaved {id=bb22}\n\n- Zebrafinch\n', { failSaves: true })
  const siteDir = join(root, 'site-2')
  const trace = { liveWorker: 0, deploys: 0, sealed: [] }
  try {
    const publish = loadHandler('talk:publish-handout', publishDeps(siteDir, trace))
    const result = await publish(null, path, OUTLINE)
    assert.deepEqual(result, { success: false, error: 'The talk could not be saved to disk, so nothing was published. Your edits are still in the editor.' })
    assert.ok(!/⌘Z|undo/i.test(result.error))
    assert.equal(handoutOf(siteDir, path), null, 'no handout was built')
    assert.deepEqual([trace.deploys, trace.sealed.length, trace.liveWorker], [0, 0, 0])
    assert.equal(readFileSync(path, 'utf8'), OUTLINE, 'the file is untouched')
    assert.ok(ed.doc.includes('Zebrafinch'), 'the edit stays in the editor')
  } finally {
    closeAll()
  }
}

// 3. An unresolved trigger typed after the renderer's copy was taken still blocks the publish.
{
  const path = talkFile()
  editorWindow(path, OUTLINE + '## Broken {id=bb22}\n{nonsense}\n')
  const siteDir = join(root, 'site-3')
  const trace = { liveWorker: 0, deploys: 0, sealed: [] }
  try {
    const publish = loadHandler('talk:publish-handout', publishDeps(siteDir, trace))
    const result = await publish(null, path, OUTLINE)
    assert.deepEqual(result, BROKEN, 'the buffer is gated, not only the renderer\'s copy')
    assert.equal(handoutOf(siteDir, path), null)
    assert.equal(trace.deploys, 0)
  } finally {
    closeAll()
  }
}

// 3b. Empty or whitespace-only talk text is never published or sealed — open or closed.
for (const [label, setup] of [
  ['open talk, whitespace-only buffer', () => { const path = talkFile(); editorWindow(path, '  \n\n'); return path }],
  ['closed talk, empty file', () => talkFile('')],
]) {
  const path = setup()
  const siteDir = join(root, `site-empty-${seq}`)
  const trace = { liveWorker: 0, deploys: 0, sealed: [] }
  try {
    const publish = loadHandler('talk:publish-handout', publishDeps(siteDir, trace))
    const result = await publish(null, path, OUTLINE)
    assert.deepEqual(result, { success: false, error: 'The talk is empty, so nothing was published.' }, label)
    assert.deepEqual([trace.deploys, trace.sealed.length, handoutOf(siteDir, path)], [0, 0, null], label)
  } finally {
    closeAll()
  }
}

// ── run:build-handout / run:publish-handout ────────────────────────────────────────────────
function runDeps(path, built, extra = {}) {
  const talk = { slug: basename(path).replace('-outline.md', ''), outlinePath: path }
  return {
    unresolvedOutboundFailure,
    getConfig: (key, fallback) => ({ vaultRoot: root, cfPagesProject: 'talks', liveWorkerBaseUrl: 'http://127.0.0.1:8787' }[key] ?? fallback),
    currentVaultRoot: () => root,
    writableVaultRoot: () => root, // a write resolves the vault only while its folder is there (vaults 07)
    vaultRootFor: () => root,
    readRun: () => ({ id: 'run-1', status: 'delivered', eventTitle: 'Event', plannedDate: '2026-09-28', startedAt: '2026-09-28T10:00:00Z' }),
    talkBySlug: () => talk,
    flushTalkForPublish,
    readFileSync,
    localHandoutWorkerBaseUrl: () => 'http://127.0.0.1:8787',
    buildRunHandoutArtifact: async (_talk, _run, content) => {
      built.push(content)
      if (extra.stopAfterBuild) throw new Error('stop after build')
      return { path: join(dirname(path), 'dist', 'run.html'), slideIds: [], missing: [] }
    },
    // Publish handout for this Run compiles and builds its pages off the main thread: the text it is handed is what is built.
    runForHandout: (_talk, run) => ({ eventTitle: run.eventTitle, talkTitle: run.talkTitle, plannedDate: run.plannedDate, startedAt: run.startedAt }),
    resolvePooledRefs: (text) => text,
    // What the Run's publish reads before it hands the build over (its link, its QR code, where its copy goes).
    publishUrl, pathToFileURL, getCompilerPath: () => join(REPO, 'compiler/scripts'), writeHandoutRegistry: () => {}, writeFileSync,
    runHandoutDistPath: () => join(dirname(path), 'dist', 'run.html'), handoutHomeDetails, handoutHomePrework, timerSettings: () => ({}),
    // Publish for this run (work-files ticket 16): with pre-work hidden no work page is sent; the handler still names these.
    handoutHomePostwork, planRunWork, sendRunWork, writeRunWorkPages, runLineFor, stampRunWork, WORK_PAGE_FOLDER, runSiteFolder, runPublishFolder, RUN_FOLDER_UNCLEAR, listRuns: () => [],
    assetRootsFor: () => [root],
    buildHandoutPagesOffThread: async (job) => {
      built.push(job.text)
      if (extra.stopAfterBuild) throw new Error('stop after build')
      return { warnings: [], slideIds: [], missing: [] }
    },
    handoutPublishing: () => extra.publishing ??= grantedPublishing({ siteDir: join(root, 'run-site') }),
    publishSiteDir: () => join(root, 'run-site'),
    existsSync, mkdirSync, readdirSync, join, resolveBase, SITE_FOLDER_REFUSED, publishedFolders, removeSiteFolder, writableSiteFolder,
    readHandoutRegistry: () => ({}),
    runHandoutSlug: () => 'run-slug',
    process: { env: {} },
  }
}

// 4. A Run's handout (build and publish) from an open talk with unsaved edits: the editor saves the
//    buffer (stamping an id), the person types again at once (their autosave is mid-write when main
//    gets the reply), and the handout is built from EXACTLY the text the flush's save committed —
//    the stamped buffer at the press — not from any read of the file (empty mid-write, later after).
for (const [channel, extra] of [['run:build-handout', {}], ['run:publish-handout', { stopAfterBuild: true }]]) {
  const path = talkFile()
  const ed = editorWindow(path, OUTLINE + STAMP_FROM + '\n- Zebrafinch\n', { stamp: true })
  const committed = OUTLINE + STAMP_TO + '\n- Zebrafinch\n'
  const later = committed + '\n- Typed after pressing Publish\n'
  ed.typeRightAfterCommit(later)
  const built = []
  try {
    const handler = loadHandler(channel, runDeps(path, built, extra))
    const result = await handler(null, { talkSlug: 'buffer-talk', runId: 'run-1' })
    if (extra.stopAfterBuild) assert.deepEqual(result, { success: false, error: 'stop after build' })
    else assert.equal(result.success, true, result.error)
    assert.deepEqual(built, [committed], `${channel}: built from the committed text (with its stamped id), not a read of the file`)
    await ed.idle()
    assert.equal(readFileSync(path, 'utf8'), later, `${channel}: and the later typing's autosave then lands as usual`)
    assert.deepEqual(ed.saves, [committed, later], `${channel}: the flush's save, then the autosave`)
  } finally {
    closeAll()
  }
}

// 4b. An open talk whose buffer already equals its file: the buffer text is used with NO write, so
//     a read-only open talk builds its Run handout and the file is not touched (not an app edit).
{
  const path = talkFile(OUTLINE + '## Saved already {id=bb22}\n')
  const ed = editorWindow(path, OUTLINE + '## Saved already {id=bb22}\n')
  const before = statSync(path)
  chmodSync(path, 0o444)
  const built = []
  try {
    const handler = loadHandler('run:build-handout', runDeps(path, built))
    const result = await handler(null, { talkSlug: 'buffer-talk', runId: 'run-1' })
    assert.equal(result.success, true, result.error)
    assert.deepEqual(built, [OUTLINE + '## Saved already {id=bb22}\n'])
    assert.deepEqual(ed.saves, [], 'no save')
    const after = statSync(path)
    assert.deepEqual([after.ino, after.mtimeMs], [before.ino, before.mtimeMs], 'the file was not rewritten')
  } finally {
    chmodSync(path, 0o644)
    closeAll()
  }
}

// 4c. An open talk with unsaved changes over a read-only file: refused in publishing's words (never
//     the ⌘Z advice), nothing built, the file and the buffer untouched.
for (const channel of ['run:build-handout', 'run:publish-handout']) {
  const path = talkFile()
  const ed = editorWindow(path, OUTLINE + '## Unsaved {id=bb22}\n')
  chmodSync(path, 0o444)
  const built = []
  try {
    const handler = loadHandler(channel, runDeps(path, built))
    const result = await handler(null, { talkSlug: 'buffer-talk', runId: 'run-1' })
    assert.deepEqual(result, { success: false, error: 'The talk has unsaved changes and its file is read-only, so nothing was published.' }, channel)
    assert.deepEqual([built, ed.saves], [[], []], channel)
    assert.equal(readFileSync(path, 'utf8'), OUTLINE, channel)
    assert.equal(ed.doc, OUTLINE + '## Unsaved {id=bb22}\n', channel)
  } finally {
    chmodSync(path, 0o644)
    closeAll()
  }
}

// 5. A closed talk: built from its file, which is read, never rewritten — so a read-only talk still
//    builds its Run handout.
{
  const path = talkFile(OUTLINE + '## On disk only {id=bb22}\n')
  const before = statSync(path)
  chmodSync(path, 0o444)
  const built = []
  try {
    const handler = loadHandler('run:build-handout', runDeps(path, built))
    const result = await handler(null, { talkSlug: 'buffer-talk', runId: 'run-1' })
    assert.equal(result.success, true, result.error)
    assert.deepEqual(built, [OUTLINE + '## On disk only {id=bb22}\n'])
    const after = statSync(path)
    assert.deepEqual([after.ino, after.mtimeMs], [before.ino, before.mtimeMs], 'the file was not rewritten')
  } finally {
    chmodSync(path, 0o644)
  }
}

// 6. A Run's flush whose save fails refuses in publishing's words; nothing is built.
{
  const path = talkFile()
  editorWindow(path, OUTLINE + '## Unsaved {id=bb22}\n', { failSaves: true })
  const built = []
  try {
    const handler = loadHandler('run:build-handout', runDeps(path, built))
    const result = await handler(null, { talkSlug: 'buffer-talk', runId: 'run-1' })
    assert.deepEqual(result, { success: false, error: 'The talk could not be saved to disk, so nothing was published. Your edits are still in the editor.' })
    assert.deepEqual(built, [])
    assert.equal(readFileSync(path, 'utf8'), OUTLINE)
  } finally {
    closeAll()
  }
}

// 7. The review's race probe (2026-09-28, /tmp/tw-probe/probe-flush-race.mjs), as a test: the
//    flush's save goes through the real in-place editor save; right after it the person's typing is
//    saved too (not awaited), with a varying delay before the window's reply. The flush's text is
//    ALWAYS exactly the committed buffer — never empty, torn or the later typing.
{
  const big = (tag, n) => '---\ntitle: T\n---\n\n' + Array.from({ length: n }, (_, i) => `## S${i} {id=a${i}}\n- ${tag} point ${i}\n`).join('\n')
  const tally = { committed: 0, other: [] }
  for (let i = 0; i < 120; i += 1) {
    const n = i % 4 === 0 ? 12000 : 600
    const path = talkFile(big('DISK', n))
    const atPress = big('PRESS', n)
    const later = big('LATER-TYPING', n)
    let buf = atPress
    let autosave = null
    configureTalkWriter({ editorBufferFor: (p) => (p === path ? {
      async read() { return buf },
      async commit(base, next) {
        if (buf !== base) return { ok: false, error: 'moved', moved: true }
        const r = await writeTalkOutline(path, next, 'editor')
        buf = later
        autosave = writeTalkOutline(path, later, 'editor')
        await new Promise((resolve) => setTimeout(resolve, i % 7))
        return r.ok ? { ok: true, text: next } : { ok: false, error: r.error }
      },
    } : null) })
    const res = await flushTalkForPublish(path)
    await autosave
    if (res.ok && res.text === atPress) tally.committed += 1
    else tally.other.push(res.ok ? `length ${res.text.length} of ${atPress.length}` : res.error)
  }
  closeAll()
  assert.deepEqual(tally, { committed: 120, other: [] }, 'every flush returned exactly the committed text')
}

console.log('handout from the buffer: talk handout, ledger seal and stamp are exactly the text the flush committed (a racing in-place autosave never tears it); publishing\'s own refusals (save failed, unsaved over read-only, empty talk; never ⌘Z); unresolved buffer refuses; Run build and publish from the committed buffer; a buffer equal to its file is used with no write; closed read-only talk read, not rewritten; race probe ×120 passed')

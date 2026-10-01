// Handout built from the buffer (roadmap idea handout-built-from-the-buffer, 2026-09-28).
// Invariant: what is published equals the editor's buffer at the moment Publish was pressed, and no
// outline is ever written by publishing except through the existing save path (the one writer,
// src/main/talk-writer.ts: an open talk is saved by its editor window; a closed talk is read, not
// rewritten).
// Seams: the REAL ipcMain handlers talk:publish-handout, run:build-handout and run:publish-handout,
// lifted out of src/main/index.ts with the TypeScript compiler (as test-outbound-trigger-gates.mjs
// does), run over a temp talk with the REAL talk writer wired to a fake editor window, and — for the
// talk handout — the REAL bundled compiler. Wrangler, the live Worker and the ledger are fakes.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { configureTalkWriter, flushTalkForPublish, withTalkFileLock, writeTalkOutline } from '../src/main/talk-writer.ts'
import { canonicalOutlinePath } from '../src/main/outline-identity.ts'
import { createOutlineMutator } from '../src/renderer/src/lib/outlineMutation.ts'
import { outlineWritesSettled, queueOutlineWrite, setOutlinePathResolver } from '../src/renderer/src/lib/saveQueue.ts'
import { checkPreconditions, publishUrl, resolveBase } from '../src/main/publishing-logic.ts'
import { stampHandoutUrl } from '../src/shared/handout-stamp.ts'
import { outlineRefusal } from '../src/main/vault-paths.ts'
import { withoutPreworkSlides } from '../src/shared/run-prework.ts'

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
  const config = { cfAccountId: 'acct', cfPagesProject: 'talks', publishBaseUrl: 'https://talks.test', publishUseShortIds: false, publishProdBranch: 'main' }
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
    readToken: () => 'token',
    augmentedPath: (p) => p,
    wranglerFoundOn: () => true,
    checkPreconditions,
    ensureLiveWorker: async () => { trace.liveWorker += 1; return { baseUrl: 'http://127.0.0.1:8787', adminSecret: 'x' } },
    flushTalkForPublish,
    statSync, basename, join, pathToFileURL, existsSync, mkdirSync, writeFileSync, readdirSync,
    resolveImageRefs: (text) => text,
    publishSiteDir: () => siteDir,
    resolveBase, publishUrl, stampHandoutUrl, writeTalkOutline,
    readHandoutUrl: () => null, recoverIdFromUrl: () => undefined, readHandoutRegistry: () => ({}), writeHandoutRegistry: () => {},
    pickShortId: () => { throw new Error('short ids are off') }, generateShortId: () => 'x', randomBytes: () => Buffer.alloc(8), buildRedirects: () => '',
    slimHandoutHtml: (html) => html,
    withoutPreworkSlides,
    preworkEnabled: () => false, // pre-work is hidden for 0.37; the pre-work publish test forces it on
    viewerPageHtml: () => '<!doctype html><title>viewer</title>',
    app: { getPath: () => root },
    execFile: (_cmd, _args, _opts, cb) => { trace.deploys += 1; cb(null, '', '') },
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
    preworkEnabled: () => false,
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
    ensureLiveWorker: async () => ({ baseUrl: 'http://127.0.0.1:8787' }),
    publishSiteDir: () => join(root, 'run-site'),
    existsSync, mkdirSync, readdirSync, join,
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

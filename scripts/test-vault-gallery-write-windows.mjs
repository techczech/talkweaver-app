// The write windows of Rename, Duplicate and PowerPoint import: the place is judged again where the bytes would
// go in, not only before the awaits. Handlers are the real source of index.ts; the outline writer, importer service
// and vault-paths are real, on real files. Stand-ins: the Trash transport, window bookkeeping, PowerPoint extraction
// and rendering, an editor window's buffer, and each swap, which stands for another local process acting at a fixed
// moment. A swap is snapshotted as it happens, so "the disk did not change" means nothing was written after it.
// Every fixture lives under one per-run folder in the checkout, ignored by Git and removed in finally.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import * as path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import * as vaultPaths from '../src/main/vault-paths.ts'
import { canonicalOutlinePath } from '../src/main/outline-identity.ts'
import { pickOutlineName } from '../src/main/talk-scan.mjs'
import { mkdirBelowRoot, writableRoot } from '../src/main/vault-availability.ts'
import { resolveInVaults } from '../src/main/vault-registry.ts'
import { configureTalkWriter, withTalkFileLock, writeTalkOutline as actualWriter } from '../src/main/talk-writer.ts'
import * as importerService from '../src/main/importer/service.ts'

const { resumeImport, startImport, IMPORT_RUN_PLACE_REFUSED } = importerService
const source = fs.readFileSync('src/main/index.ts', 'utf8')
const run = fs.mkdtempSync(path.resolve('.tw-write-windows-'))

const code = (text) => transformSync(text, { loader: 'ts' }).code
const fnSource = (name) => {
  const start = source.search(new RegExp(`^(async )?function ${name}\\(`, 'm'))
  assert.ok(start >= 0, `function ${name} is in index.ts`)
  return source.slice(start, source.indexOf('\n}\n', start) + 3)
}
const handlerSource = (name) => {
  const start = source.indexOf(`ipcMain.handle('${name}'`)
  assert.ok(start >= 0, `handler ${name} is in index.ts`)
  return source.slice(start, source.indexOf('\n})', start) + 3)
}

const OUTLINE = (title) => `---\ntitle: ${title}\nhandout_url: https://fixture.invalid/x\n---\n\n## One\n\nBody of ${title}\n`
const FILES = {
  'vault/assets/logo.png': 'root-asset', 'vault/assets/parked/parked-outline.md': OUTLINE('Parked'), 'vault/assets/talk1/talk1-outline.md': OUTLINE('Protected twin'),
  'vault/Work/talk1/talk1-outline.md': OUTLINE('Talk one'), 'vault/Work/talk1/assets/p.png': 'talk media', 'vault/Work/Sub/keep.txt': 'x',
  'vault/solo/solo-outline.md': OUTLINE('Solo'), 'vault/Other/keep.txt': 'other',
  'outside/talk1/talk1-outline.md': OUTLINE('Outside twin'), 'outside/x/fresh-title/fresh-title-outline.md': OUTLINE('Outside stage twin'), 'outside/x/fresh-title/extra.txt': 'outside extra',
}

function makeVault(extra = {}) {
  const base = fs.mkdtempSync(path.join(run, 'v-'))
  for (const [rel, text] of Object.entries({ ...FILES, ...extra })) {
    fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true })
    fs.writeFileSync(path.join(base, rel), text)
  }
  fs.writeFileSync(path.join(base, 'source.pptx'), 'fixture pptx')
  return { base, root: path.join(base, 'vault') }
}

/** Every entry under base, links as links, by identity and content. */
function snapshot(base) {
  const out = {}
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name)
      const rel = path.relative(base, full)
      const stat = fs.lstatSync(full)
      if (stat.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(full)}`
      else if (stat.isDirectory()) { out[rel] = `dir:${stat.ino}`; walk(full) }
      else out[rel] = `file:${stat.ino}:${createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`
    }
  }
  walk(base)
  return out
}
/** Duplicate's own hidden stage is removed on the way out: that is the handler tidying, not a write. */
const outsideStage = (shot) => Object.fromEntries(Object.entries(shot).filter(([rel]) => !rel.startsWith('vault/.tw-clone-')))

function loadHandlers(fixture, hooks = {}) {
  const handlers = new Map()
  const trash = []
  const invalidated = []
  const vaults = [{ id: 'v1', name: 'Fixture', root: fixture.root, open: true }]
  const context = {
    ...fs, ...path, ...vaultPaths, console: { ...console, error() {} },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    readdirAsync: fsp.readdir, resolvePath: path.resolve, pathSep: path.sep, writableRoot, mkdirBelowRoot, resolveInVaults, canonicalOutlinePath, pickOutlineName,
    vaultAvailability: { isUnavailable: () => false },
    vaultRegistry: { get: (id) => vaults.find((v) => v.id === id) ?? null, list: () => vaults, primary: () => vaults[0], resolve: (abs) => resolveInVaults(vaults, abs), readFile: () => null, personal: () => ({}) },
    rootFs: { isDirectory: (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }, mkdir: (p) => { fs.mkdirSync(p, { recursive: true }) } },
    shell: { trashItem: async (p) => { trash.push(p); fs.renameSync(p, path.join(fixture.base, `fixture-bin-${trash.length}`)) } },
    outlineDiskGuard: { forget() {}, release() {}, openUnder: () => [], check: async () => {} },
    outlineRecovery: { rekey: async () => {} },
    // The real writer with the options the handler gave it. `park` holds a write in the real queue; `afterWrite` is the moment after it.
    writeTalkOutline: async (p, next, origin, opts) => {
      const write = () => actualWriter(p, next, origin, opts)
      const result = await (hooks.park ? hooks.park(p, write, origin) : write())
      await hooks.afterWrite?.(p, origin)
      return result
    },
    invalidateTalkCache: (root) => invalidated.push(root), invalidateVaultCaches: (root) => invalidated.push(root),
    otherEditorHolding: () => null, editorWindows: new Map(), galleryEpoch: 0, establishedGalleryClaims: new Map(), galleryClaimEpochs: new Map(), galleryReservations: new Map(),
    vaultOfRoot: () => null, resolveNewTalkDefaults: () => ({ defaults: {} }), metadataDefaults: () => ({}), talkFolderRelOf: () => '', applyMetadataDefaults: () => ({ edits: [] }),
    parseFrontmatterPairs: () => [], normaliseMetadataDefaults: () => ({}), METADATA_REGISTRY: {}, editFrontmatterText: (text) => text,
  }
  vm.createContext(context)
  const start = source.indexOf('const movedEditorReceipts =')
  vm.runInContext(code(source.slice(start, source.indexOf('const galleryReservations =', start))).replace(/\b(const|let) (managementMutations|movedEditorReceipts) =/g, 'var $2 ='), context)
  for (const name of ['vaultAvailable', 'rootOfVault', 'writableRootOfVault', 'writableVaultRoot', 'writableTalkRoot', 'writableRootFor', 'vaultRootFor', 'currentVaultRoot', 'primaryVault', 'availableVaults',
    'mkdirInVault', 'vaultRel', 'otherEditorUnder', 'slugifyTalk', 'renameSlugFiles', 'retitleOutline', 'stripPublishedFields', 'findOutlineIn', 'talkInfoFor', 'transferMovedEditor']) {
    vm.runInContext(code(fnSource(name)), context)
  }
  for (const name of ['clone-talk', 'rename-talk', 'move-talk', 'delete-talk']) vm.runInContext(code(handlerSource(`vault:${name}`)), context)
  const event = { sender: { id: 1 } }
  return { call: (name, ...args) => handlers.get(`vault:${name}`)(event, ...args), trash, invalidated, context }
}

let checks = 0
const failures = []
async function check(name, body, extra) {
  checks += 1
  const vault = makeVault(extra)
  try { await body(vault) } catch (error) {
    failures.push(`${name}: ${String(error?.message ?? error).split('\n')[0]}`)
  } finally {
    configureTalkWriter({ editorBufferFor: () => null })
    fs.rmSync(vault.base, { recursive: true, force: true })
  }
}

const settle = async () => { for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve)) }
/** A real write already holds the file's lock: this one joins the real queue behind it, the swap happens, then the queue moves. */
const behindLock = (swap, onlyOrigin) => {
  let done = false
  return async (p, write, origin) => {
    if (done || (onlyOrigin && origin !== onlyOrigin)) return write()
    done = true
    let open
    const gate = new Promise((resolve) => { open = resolve })
    let entered
    const inside = new Promise((resolve) => { entered = resolve })
    const holder = withTalkFileLock(p, async () => { entered(); await gate })
    await inside
    const pending = write()
    await settle()
    swap(p)
    open()
    await holder
    return pending
  }
}
const ren = (root, from, to) => fs.renameSync(path.join(root, from), path.join(root, to))
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8')
const gone = (root, rel) => assert.equal(fs.existsSync(path.join(root, rel)), false, `${rel} is there`)
const linkInPlaceOf = (root, rel, target) => { ren(root, rel, `${rel}.was`); fs.symlinkSync(target, path.join(root, rel)) }
const TALK = 'Work/talk1/talk1-outline.md'
const outlineAt = (root) => path.join(root, TALK)
const outlineLinkTo = (target) => ({ root }) => { fs.rmSync(outlineAt(root)); fs.symlinkSync(target, outlineAt(root)) }

try {
  // ── Rename, closed talk, real queue: the swap lands while the write waits its turn. ──
  const RENAMES = [['new slug', 'Fresh title'], ['same slug', 'Talk1']]
  const LINK_SWAPS = [
    ['Work replaced by a link to assets', ({ root }) => linkInPlaceOf(root, 'Work', 'assets')],
    ['Work replaced by a link out of the vault', ({ root }) => linkInPlaceOf(root, 'Work', '../outside')],
    ['the outline replaced by a link into assets', outlineLinkTo('../../assets/parked/parked-outline.md')],
    ['the outline replaced by a link out of the vault', outlineLinkTo('../../../outside/talk1/talk1-outline.md')],
    // Same name and no link anywhere: only the identity of the talk folder tells this one.
    ['the talk folder replaced by a real folder with the same outline', ({ root }) => { ren(root, 'Work/talk1', 'Work/talk1.was'); ren(root, 'assets/talk1', 'Work/talk1') }],
    // Same name, same talk folder, no link: only the identity of the folder holding it tells this one.
    ['the same talk folder now filed in what was assets', ({ root }) => { fs.rmSync(path.join(root, 'assets/talk1'), { recursive: true }); ren(root, 'Work/talk1', 'assets/talk1'); ren(root, 'Work', 'Work.was'); ren(root, 'assets', 'Work') }],
  ]
  for (const [label, title] of RENAMES) {
    for (const [name, swap] of LINK_SWAPS) {
      await check(`Rename, ${label}: ${name}`, async (vault) => {
        let frozen
        const app = loadHandlers(vault, { park: behindLock(() => { swap(vault); frozen = snapshot(vault.base) }) })
        const answer = await app.call('rename-talk', outlineAt(vault.root), title)
        assert.equal(answer, null, `answered ${JSON.stringify(answer)}`)
        assert.deepEqual(snapshot(vault.base), frozen, 'the disk changed after the swap')
        assert.deepEqual(app.trash, [], 'Trash was called')
        assert.deepEqual(app.invalidated, [], 'caches were dropped for a refused request')
        assert.equal(vm.runInContext('managementMutations.size', app.context), 0, 'a reservation was left')
      })
    }
  }
  await check('Rename, new slug, queued write with no swap', async ({ base, root }) => {
    const app = loadHandlers({ base, root }, { park: behindLock(() => {}) })
    const answer = await app.call('rename-talk', outlineAt(root), 'Fresh title')
    assert.equal(answer.path, path.join(root, 'Work/fresh-title'))
    assert.match(read(root, 'Work/fresh-title/fresh-title-outline.md'), /^title: "Fresh title"$/m)
    assert.equal(read(root, 'Work/fresh-title/assets/p.png'), 'talk media')
    gone(root, 'Work/talk1')
  })
  await check('Rename, same slug, queued write with no swap', async ({ base, root }) => {
    const app = loadHandlers({ base, root }, { park: behindLock(() => {}) })
    const answer = await app.call('rename-talk', outlineAt(root), 'Talk1')
    assert.equal(answer.path, path.join(root, 'Work/talk1'))
    assert.match(read(root, TALK), /^title: "Talk1"$/m)
    assert.match(read(root, TALK), /handout_url/)
  })

  // ── Rename, open talk: the writer asks before the window is asked to apply. ──
  const windowFor = (outline, onRead) => {
    const window = { commits: 0 }
    configureTalkWriter({
      editorBufferFor: (p) => (p === outline ? {
        read: async () => { const text = fs.readFileSync(outline, 'utf8'); onRead?.(); return text },
        commit: async (_base, text) => {
          window.commits += 1
          const written = await actualWriter(outline, text, 'editor')
          return written.ok ? { ok: true, text } : { ok: false, error: written.error }
        },
      } : null),
    })
    return window
  }
  for (const [label, title] of RENAMES) {
    for (const [name, swap] of LINK_SWAPS.slice(0, 2)) {
      await check(`Rename of an open talk, ${label}: ${name}`, async (vault) => {
        let frozen
        const outline = outlineAt(vault.root)
        const window = windowFor(outline, () => { swap(vault); frozen = snapshot(vault.base) })
        const app = loadHandlers(vault)
        assert.equal(await app.call('rename-talk', outline, title), null)
        assert.equal(window.commits, 0, 'the window was asked to apply')
        assert.deepEqual(snapshot(vault.base), frozen, 'the disk changed after the swap')
      })
    }
    await check(`Rename of an open talk, ${label}, no swap`, async ({ base, root }) => {
      const outline = outlineAt(root)
      const window = windowFor(outline)
      const app = loadHandlers({ base, root })
      assert.ok((await app.call('rename-talk', outline, title))?.outlinePath)
      assert.equal(window.commits, 1)
    })
  }

  // ── Duplicate's hidden stage: nothing the two writes reach may have been swapped since it was made. ──
  const stageOf = (p) => path.dirname(path.dirname(p))
  const STAGE_SWAPS = [
    ['its stage replaced by a link out of the vault', (p) => { const stage = stageOf(p); fs.renameSync(stage, `${stage}-was`); fs.symlinkSync('../outside/x', stage) }],
    ['the folder in its stage replaced by a link out of the vault', (p, { base }) => { const folder = path.dirname(p); fs.renameSync(folder, `${folder}-was`); fs.symlinkSync(path.join(base, 'outside/x/fresh-title'), folder) }],
    ['the outline in its stage replaced by a link out of the vault', (p, { base }) => { fs.rmSync(p); fs.symlinkSync(path.join(base, 'outside/x/fresh-title/fresh-title-outline.md'), p) }],
    ['the outline in its stage replaced by a link into assets', (p, { root }) => { fs.rmSync(p); fs.symlinkSync(path.join(root, 'assets/parked/parked-outline.md'), p) }],
    // The files themselves are unchanged and would be written: only the identity of what holds them tells these two.
    ['its stage moved out of the vault with a link left behind', (p, { base }) => { const stage = stageOf(p); fs.renameSync(stage, path.join(base, 'outside/moved')); fs.symlinkSync(path.join(base, 'outside/moved'), stage) }],
    ['the folder in its stage moved out of the vault with a link left behind', (p, { base }) => { const folder = path.dirname(p); fs.renameSync(folder, path.join(base, 'outside/moved')); fs.symlinkSync(path.join(base, 'outside/moved'), folder) }],
  ]
  for (const origin of ['retitle', 'strip-published']) {
    for (const [name, swap] of STAGE_SWAPS) {
      await check(`Duplicate, ${origin}: ${name}`, async (vault) => {
        let frozen
        const app = loadHandlers(vault, { park: behindLock((p) => { swap(p, vault); frozen = snapshot(vault.base) }, origin) })
        assert.equal(await app.call('clone-talk', outlineAt(vault.root), 'Fresh title'), null)
        assert.deepEqual(outsideStage(snapshot(vault.base)), outsideStage(frozen), 'the disk changed after the swap')
        gone(vault.root, 'Work/fresh-title')
        assert.equal(vm.runInContext('managementMutations.size', app.context), 0, 'a reservation was left')
      })
    }
  }
  await check('Duplicate: its stage swapped after the last write publishes nothing from there', async (vault) => {
    const app = loadHandlers(vault, { afterWrite: (p, origin) => { if (origin === 'strip-published') STAGE_SWAPS[0][1](p) } })
    assert.equal(await app.call('clone-talk', outlineAt(vault.root), 'Fresh title'), null)
    gone(vault.root, 'Work/fresh-title')
  })
  await check('Duplicate, queued writes with no swap', async ({ base, root }) => {
    const app = loadHandlers({ base, root }, { park: behindLock(() => {}) })
    const copy = await app.call('clone-talk', outlineAt(root), 'Fresh title')
    assert.equal(copy.path, path.join(root, 'Work/fresh-title'))
    const text = read(root, 'Work/fresh-title/fresh-title-outline.md')
    assert.match(text, /^title: "Fresh title"$/m)
    assert.doesNotMatch(text, /handout_url/)
    assert.deepEqual(fs.readdirSync(root).filter((entry) => entry.startsWith('.tw-clone-')), [])
    assert.match(read(root, TALK), /title: Talk one/)
  })

  // ── A talk's own stored name: an alias no list of names can hold. The disk's answer is a stand-in, the folder is real. ──
  await check('a stray outline in a folder the disk stores as assets is no talk, under any other spelling', async ({ base, root }) => {
    fs.mkdirSync(path.join(root, 'Work/ASSE~1'))
    fs.writeFileSync(path.join(root, 'Work/ASSE~1/promo-outline.md'), OUTLINE('Promo'))
    const native = fs.realpathSync.native
    fs.realpathSync.native = (p, ...rest) => native(p, ...rest).replace('ASSE~1', 'assets')
    try {
      const app = loadHandlers({ base, root })
      const before = snapshot(base)
      const stray = path.join(root, 'Work/ASSE~1/promo-outline.md')
      assert.ok(!await app.call('delete-talk', stray), 'Bin answered')
      assert.ok(!await app.call('rename-talk', stray, 'Fresh title'), 'Rename answered')
      assert.ok(!await app.call('clone-talk', stray, 'Fresh title'), 'Duplicate answered')
      assert.ok(!await app.call('move-talk', stray, 'Other'), 'Move answered')
      assert.deepEqual(app.trash, [], 'Trash was called')
      assert.deepEqual(snapshot(base), before, 'the disk changed')
    } finally { fs.realpathSync.native = native }
  })

  // ── PowerPoint import. Extraction and rendering stand in; the writers are real. ──
  const SOURCE_HASH = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
  const fileRun = (vault) => path.join(vault.base, 'source.pptx')
  const importDeps = (sourcePath, extras = {}) => ({
    extractPptx: async (_source, outputDir) => {
      fs.mkdirSync(path.join(outputDir, 'package'), { recursive: true })
      await extras.duringExtract?.()
      return { source: { path: sourcePath, fileName: 'source.pptx', hash: SOURCE_HASH, bytes: 12, slideCount: 1, width: 1, height: 1 }, packageDir: path.join(outputDir, 'package'),
        slides: [{ slideNumber: 1, hidden: false, title: 'Opening', paragraphs: ['Opening'], notes: '', shapes: [], warnings: [] }] }
    },
    renderOriginalSlides: async (_source, runDir) => {
      const dir = path.join(runDir, 'slides', '001')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'original.png'), 'rendered')
      await extras.duringRender?.()
      return { renderer: { name: 'libreoffice', status: 'ready', officePath: '/s', rasterPath: '/p', officeVersion: 'f', rasterVersion: 'f' }, files: [path.join(dir, 'original.png')] }
    },
    createId: () => 'run-fixture', now: () => '2026-10-30T12:00:00.000Z',
    ...(extras.failExtract ? { extractPptx: async () => { await extras.failExtract(); throw new Error('fixture extraction failed') } } : {}),
    ...(extras.failRender ? { renderOriginalSlides: async () => { await extras.failRender(); throw new Error('fixture rendering failed') } } : {}),
  })
  function importInto(vault, topicFolder, extras, onProgress = () => {}, slug = 'imported') {
    const sourcePath = fileRun(vault)
    const options = { title: 'Imported', slug, topicFolder, slideRange: '', includeHidden: true, preserveNotes: true, extractMedia: true, fallbackPolicy: 'uncertain', renderer: 'automatic' }
    return startImport({ vaultRoot: vault.root, request: { sourcePath, options }, onProgress, dependencies: importDeps(sourcePath, extras) })
  }
  const runFolder = 'import-runs/run-fixture'
  const PLACE_SWAPS = [
    ['Work replaced by a link to assets', ({ root }) => linkInPlaceOf(root, 'Work', 'assets')],
    ['Work replaced by a link out of the vault', ({ root }) => linkInPlaceOf(root, 'Work', '../outside')],
    ['Work replaced by the real assets folder', ({ root }) => { ren(root, 'Work', 'Work.was'); ren(root, 'assets', 'Work') }],
    ['the talk folder replaced by a real folder', ({ root }) => { ren(root, 'Work/imported', 'Work/imported.was'); fs.mkdirSync(path.join(root, 'Work/imported')) }],
    ['the run folder replaced by a link out of the vault', ({ root, base }) => { fs.mkdirSync(path.join(base, 'outside/run')); linkInPlaceOf(root, `Work/imported/${runFolder}`, path.join(base, 'outside/run')) }],
    // The run folder moves with it and keeps its identity: only the identity of `import-runs` tells this one.
    ['import-runs moved out of the vault with a link left behind', ({ root, base }) => { const runs = path.join(root, 'Work/imported/import-runs'); fs.renameSync(runs, path.join(base, 'outside/runs')); fs.symlinkSync(path.join(base, 'outside/runs'), runs) }],
    // The run's own folders stand: only the identity of the talk folder, or of the folder holding it, tells these two.
    ['the runs refiled in a new real talk folder', ({ root }) => { ren(root, 'Work/imported', 'Work/imported.was'); fs.mkdirSync(path.join(root, 'Work/imported')); ren(root, 'Work/imported.was/import-runs', 'Work/imported/import-runs') }],
    ['the same talk folder now filed in what was assets', ({ root }) => { ren(root, 'Work/imported', 'assets/imported'); ren(root, 'Work', 'Work.was'); ren(root, 'assets', 'Work') }],
  ]
  for (const [moment, stage] of [['during extraction', 'duringExtract'], ['during rendering', 'duringRender']]) {
    for (const [name, swap] of PLACE_SWAPS) {
      await check(`import, ${moment}: ${name}`, async (vault) => {
        let frozen
        const progress = []
        await assert.rejects(importInto(vault, 'Work', { [stage]: () => { swap(vault); frozen = snapshot(vault.base) } }, (event) => progress.push(event)), { message: IMPORT_RUN_PLACE_REFUSED })
        assert.deepEqual(snapshot(vault.base), frozen, 'the disk changed after the swap')
        assert.deepEqual([progress.at(-1).status, progress.at(-1).note], ['failed', IMPORT_RUN_PLACE_REFUSED], 'the panel was left on a step')
      })
    }
  }
  // A failed long await is the same moment: its failure note would go through the refused place.
  for (const [moment, stage] of [['extraction', 'failExtract'], ['rendering', 'failRender']]) {
    for (const [name, swap] of PLACE_SWAPS) {
      await check(`import, ${moment} fails after this swap, no failure note goes through: ${name}`, async (vault) => {
        let frozen
        await assert.rejects(importInto(vault, 'Work', { [stage]: () => { swap(vault); frozen = snapshot(vault.base) } }), { message: IMPORT_RUN_PLACE_REFUSED })
        assert.deepEqual(snapshot(vault.base), frozen, 'the disk changed after the swap')
      })
    }
    await check(`import, ${moment} fails with no swap: the failure note is written`, async (vault) => {
      await assert.rejects(importInto(vault, 'Work', { [stage]: () => {} }), /fixture (extraction|rendering) failed/)
      const manifest = JSON.parse(read(vault.root, `Work/imported/${runFolder}/manifest.json`))
      assert.equal(manifest.status, 'failed')
      assert.match(manifest.error, /fixture (extraction|rendering) failed/)
    })
  }
  // Not reachable in the app: importer:start and importer:resume hold the whole vault's reservation for the import.
  await check('import: a category renamed by another process during rendering leaves no ghost at the old name', async (vault) => {
    await assert.rejects(importInto(vault, 'Work', { duringRender: () => ren(vault.root, 'Work', 'Done') }), { message: IMPORT_RUN_PLACE_REFUSED })
    gone(vault.root, 'Work')
    assert.equal(fs.existsSync(path.join(vault.root, `Done/imported/${runFolder}/manifest.json`)), true)
  })
  await check('import with no swap lands whole', async (vault) => {
    const detail = await importInto(vault, 'Work')
    assert.equal(detail.manifest.status, 'review')
    const talk = path.join(vault.root, 'Work/imported')
    assert.equal(detail.manifest.talk.path, talk)
    assert.match(fs.readFileSync(path.join(talk, 'imported-outline.md'), 'utf8'), /Opening/)
    assert.equal(fs.existsSync(path.join(talk, `assets/import-${SOURCE_HASH.slice(0, 12)}-slide-001.png`)), true)
  })

  // ── A new import's source work: a deck can take seconds, and the destination is judged after it, beside the first write. ──
  const builtin = createRequire(import.meta.url)
  /** The service's named imports follow the builtin, so this wraps its real call. `onCall` sees each call's first argument. */
  async function wrappingBuiltin(holder, name, onCall, body) {
    const real = holder[name]
    holder[name] = function (...args) { onCall(args[0]); return real.apply(this, args) }
    syncBuiltinESMExports()
    try { return await body() } finally { holder[name] = real; syncBuiltinESMExports() }
  }
  const SOURCE_WORK = [
    ['reading the deck', builtin('node:fs'), 'readFileSync', (vault, arg) => arg === fileRun(vault)],
    ['sizing the deck', builtin('node:fs'), 'statSync', (vault, arg) => arg === fileRun(vault)],
    ['hashing the deck', builtin('node:crypto'), 'createHash', () => true],
  ]
  const DESTINATION_SWAPS = [
    ['Work replaced by a link to assets', ({ root }) => linkInPlaceOf(root, 'Work', 'assets')],
    ['Work replaced by a link out of the vault', ({ root }) => linkInPlaceOf(root, 'Work', '../outside')],
  ]
  const TWINS = { 'vault/assets/imported/imported-outline.md': OUTLINE('Protected twin'), 'outside/imported/imported-outline.md': OUTLINE('Outside twin') }
  for (const [moment, holder, name, isSourceCall] of SOURCE_WORK) {
    for (const [swapName, swap] of DESTINATION_SWAPS) {
      await check(`import, while ${moment}: ${swapName} over an existing outline`, async (vault) => {
        let frozen
        const onCall = (arg) => { if (!frozen && isSourceCall(vault, arg)) { frozen = {}; swap(vault); frozen = snapshot(vault.base) } }
        const refusal = await wrappingBuiltin(holder, name, onCall, () => importInto(vault, 'Work').then(() => null, (error) => error))
        assert.deepEqual(snapshot(vault.base), frozen, 'the disk changed after the swap')
        assert.equal(refusal?.message, vaultPaths.IMPORT_DESTINATION_REFUSED)
      }, TWINS)
    }
  }
  await check('import: the wrapped source work with no swap still lands whole', async (vault) => {
    const detail = await wrappingBuiltin(builtin('node:fs'), 'readFileSync', () => {}, () => importInto(vault, 'Work'))
    assert.equal(detail.manifest.status, 'review')
    assert.equal(detail.manifest.source.path, fileRun(vault))
  })
  for (const [name, topicFolder, slug, message] of [['slug', 'Work', 'Not A Slug', 'importer-slug-invalid'], ['topic folder', '../outside', 'imported', 'importer-topic-folder-invalid']]) {
    await check(`import refuses an invalid ${name} without reading the deck`, async (vault) => {
      const before = snapshot(vault.base)
      let reads = 0
      await wrappingBuiltin(builtin('node:fs'), 'readFileSync', (arg) => { if (arg === fileRun(vault)) reads += 1 }, () => assert.rejects(importInto(vault, topicFolder, {}, () => {}, slug), { message }))
      assert.equal(reads, 0, 'the deck was read')
      assert.deepEqual(snapshot(vault.base), before, 'the disk changed')
    })
  }

  // ── Resume: the same folder however it was spelled, and nothing else. ──
  const failedRun = (vault, topic) => assert.rejects(importInto(vault, topic, { failExtract: () => {} }), /fixture extraction failed/)
  const resume = (vault, vaultRoot = vault.root, extras) => resumeImport({ vaultRoot, runId: 'run-fixture', onProgress() {}, dependencies: importDeps(fileRun(vault), extras) })
  const editManifest = (root, change) => {
    const file = path.join(root, `Work/imported/${runFolder}/manifest.json`)
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    change(manifest)
    fs.writeFileSync(file, JSON.stringify(manifest))
  }
  async function resumeRefused(vault, vaultRoot) {
    const before = snapshot(vault.base)
    await assert.rejects(resume(vault, vaultRoot), { message: IMPORT_RUN_PLACE_REFUSED })
    assert.deepEqual(snapshot(vault.base), before, 'the disk changed')
  }
  const CZ = 'Přednášky'
  const SPELLINGS = [
    ['a category stored decomposed and typed composed', CZ.normalize('NFC'), { [`vault/${CZ.normalize('NFD')}/keep.txt`]: 'x' }, CZ.normalize('NFD')],
    ['a category stored composed and typed decomposed', CZ.normalize('NFD'), { [`vault/${CZ.normalize('NFC')}/keep.txt`]: 'x' }, CZ.normalize('NFC')],
    ['a category typed in another case', 'work', {}, 'Work'],
  ]
  for (const [name, typed, extra, stored] of SPELLINGS) {
    await check(`a resume reaches ${name}`, async (vault) => {
      await failedRun(vault, typed)
      const detail = await resume(vault)
      assert.equal(detail.manifest.status, 'review')
      assert.deepEqual(fs.readdirSync(vault.root).filter((entry) => entry.normalize('NFC').toLowerCase() === stored.normalize('NFC').toLowerCase()), [stored], 'a second folder appeared')
      assert.equal(fs.existsSync(path.join(vault.root, stored, 'imported/imported-outline.md')), true)
    }, extra)
  }
  await check('a resume still writes where the run lives after a mid-run failure', async (vault) => {
    await failedRun(vault, 'Work')
    assert.equal((await resume(vault)).manifest.status, 'review')
  })
  await check('a resume re-judges its place after its own long awaits', async (vault) => {
    await failedRun(vault, 'Work')
    let frozen
    await assert.rejects(resume(vault, vault.root, { duringRender: () => { linkInPlaceOf(vault.root, 'Work', 'assets'); frozen = snapshot(vault.base) } }), { message: IMPORT_RUN_PLACE_REFUSED })
    assert.deepEqual(snapshot(vault.base), frozen, 'the disk changed after the swap')
  })
  await check('a resume refuses a talk moved since, and does not recreate the old place', async (vault) => {
    await failedRun(vault, 'Work')
    ren(vault.root, 'Work/imported', 'Other/imported')
    await resumeRefused(vault)
    gone(vault.root, 'Work/imported')
  })
  await check('a resume refuses a vault folder renamed since, and does not recreate the old vault', async (vault) => {
    await failedRun(vault, 'Work')
    const moved = path.join(vault.base, 'vault-moved')
    fs.renameSync(vault.root, moved)
    await resumeRefused(vault, moved)
    gone(vault.base, 'vault')
  })
  const talkPath = (root) => path.join(root, 'Work/imported')
  const EDITS = [
    ['only the talk path edited to name assets', (m, { root }) => { m.talk.path = path.join(root, 'assets/imported') }],
    ['only the talk path edited to leave the vault', (m, { base }) => { m.talk.path = path.join(base, 'outside/imported') }],
    ['only the talk path spelled through `hop/..`', (m, { root }) => { fs.symlinkSync('../../../outside', path.join(talkPath(root), 'hop')); m.talk.path = `${talkPath(root)}/hop/../../imported` }],
    ['only the outline path spelled through `hop/..`', (m, { root }) => { fs.symlinkSync('../../../outside', path.join(talkPath(root), 'hop')); m.talk.outlinePath = `${talkPath(root)}/hop/../imported-outline.md` }],
    // The link stands beside the talk, so the OS and the letters agree today: only the spelling tells these two.
    ['only the talk path spelled through `hop/..` the disk agrees with', (m, { root }) => { fs.symlinkSync('Sub', path.join(root, 'Work/hop')); m.talk.path = `${root}/Work/hop/../imported` }],
    ['only the outline path spelled through `hop/..` the disk agrees with', (m, { root }) => { fs.symlinkSync('Sub', path.join(root, 'Work/hop')); m.talk.outlinePath = `${root}/Work/hop/../imported/imported-outline.md` }],
    ['only the talk path spelled through a link that reaches the same folder', (m, { root }) => { fs.symlinkSync('Work', path.join(root, 'link-to-work')); m.talk.path = path.join(root, 'link-to-work/imported') }],
    ['only the outline path spelled through a link that reaches the same folder', (m, { root }) => { fs.symlinkSync('Work', path.join(root, 'link-to-work')); m.talk.outlinePath = path.join(root, 'link-to-work/imported/imported-outline.md') }],
    ['the talk path not a path', (m) => { m.talk.path = 7 }],
    ['no talk at all', (m) => { delete m.talk }],
  ]
  for (const [name, edit] of EDITS) {
    await check(`a resume refuses ${name}`, async (vault) => {
      await failedRun(vault, 'Work')
      editManifest(vault.root, (manifest) => edit(manifest, vault))
      await resumeRefused(vault)
    })
  }
} finally {
  configureTalkWriter({ editorBufferFor: () => null })
  fs.rmSync(run, { recursive: true, force: true })
}

if (failures.length) {
  console.error(failures.map((line) => `FAIL ${line}`).join('\n'))
  console.error(`${failures.length} of ${checks} checks failed`)
  process.exitCode = 1
} else console.log(`PASS ${checks} write-window checks on the actual handlers, outline writer and importer: a swap at the writer's moment, during a new import's source work or after an import's long await writes nothing further, valid work and valid resumes unchanged`)

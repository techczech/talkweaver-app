// The folder-management guard: assets, research, system folders, links, plain files and the insides of a
// talk are inspect-only to the vault:* management handlers, however the request reaches them, and ordinary
// category work and the app's own writers carry on. The handlers below are the real source of index.ts on
// real files; the only stand-ins are the Trash transport, the outline writer (the real one where a case says
// so) and the window bookkeeping, so Electron and the OS Trash are never touched. A direct call stands for a
// renderer that offered the action. Every fixture lives under one per-run folder, removed in finally.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import * as vaultPaths from '../src/main/vault-paths.ts'
import { canonicalOutlinePath } from '../src/main/outline-identity.ts'
import { pickOutlineName } from '../src/main/talk-scan.mjs'
import { mkdirBelowRoot, writableRoot } from '../src/main/vault-availability.ts'
import { resolveInVaults } from '../src/main/vault-registry.ts'
import { writeTalkOutline as actualWriter } from '../src/main/talk-writer.ts'
import { registerImporterIpc } from '../src/main/importer/ipc.ts'
import { IMPORT_RUN_PLACE_REFUSED, resumeImport, startImport } from '../src/main/importer/service.ts'

const source = fs.readFileSync('src/main/index.ts', 'utf8')
// In the checkout and ignored by Git (`.tw-*`); never the temp dir, never a committed evidence folder.
const run = fs.mkdtempSync(path.resolve('.tw-protected-folders-'))

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
  'assets/logo.png': 'root-asset', 'assets/sub/deep.png': 'deep-asset', 'assets/parked/parked-outline.md': OUTLINE('Parked'),
  '_assets/img-1.webp': 'pool', '_assets/logos/mark.svg': '<svg/>', '_PRESENTATIONS/talk1/run-1.json': '{}',
  'research/note.md': 'research', 'Work/Research/note.md': 'nested research', '.hidden/secret': 'hidden', '.git/HEAD': 'ref',
  'dist/index.html': 'built', 'bundle/app.js': 'js', 'node_modules/pkg/index.js': 'pkg', 'notes.txt': 'a plain file',
  'Cases/ASSETS/a.png': 'upper', 'Cases/_Assets/b.png': 'mixed', 'Cases/RESEARCH/c.md': 'upper research', 'Cases/Dist/d.html': 'built',
  'Cases/Node_Modules/e.js': 'pkg',
  'Work/assets/w.png': 'work asset', 'Work/assets/sub/s.png': 'work deep asset', 'Work/Sub/Deep/keep.txt': 'deep',
  'Work/talk1/talk1-outline.md': OUTLINE('Talk one'), 'Work/talk1/assets/p.png': 'talk media', 'Work/talk1/scratchpad/n.md': 'scratch',
  'Work/talk1/dist/t.html': 'talk build',
  'solo/solo-outline.md': OUTLINE('Solo'), 'Other/keep.txt': 'other', 'assets-2026/keep.txt': 'x', 'my_assets/keep.txt': 'x',
  'research-notes/keep.txt': 'x', 'bundles/keep.txt': 'x', 'dist-notes/keep.txt': 'x',
}
const LINKS = { 'link-to-assets': 'assets', 'link-to-work': 'Work', 'link-to-pool': '_assets', 'Work/link-up': '../_assets', 'link-out': '../outside', 'link-to-talk': 'Work/talk1' }

function makeVault(extra = {}) {
  const base = fs.mkdtempSync(path.join(run, 'v-'))
  const root = path.join(base, 'vault')
  fs.mkdirSync(path.join(base, 'outside'), { recursive: true })
  fs.writeFileSync(path.join(base, 'outside', 'o.txt'), 'outside')
  for (const [rel, text] of Object.entries({ ...FILES, ...extra })) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    fs.writeFileSync(path.join(root, rel), text)
  }
  for (const [rel, target] of Object.entries(LINKS)) fs.symlinkSync(target, path.join(root, rel))
  return { base, root }
}

/** Every entry under base, links as links, by content: nothing moved, nothing changed. */
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

function loadHandlers(fixture, hooks = {}) {
  const handlers = new Map()
  const trash = []
  const invalidated = []
  const vaults = [
    { id: 'v1', name: 'Fixture', root: fixture.rootAs ?? fixture.root, open: true },
    { id: 'closed', name: 'Closed', root: fixture.root, open: false },
    { id: 'gone', name: 'Gone', root: fixture.root, open: true },
  ]
  const context = {
    ...fs, ...path, ...vaultPaths, console: { ...console, error() {} },
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    readdirAsync: fsp.readdir, resolvePath: path.resolve, pathSep: path.sep, writableRoot, mkdirBelowRoot, resolveInVaults, canonicalOutlinePath, pickOutlineName,
    vaultAvailability: { isUnavailable: (id) => id === 'gone' },
    vaultRegistry: {
      get: (id) => vaults.find((v) => v.id === id) ?? null, list: () => vaults, primary: () => vaults.find((v) => v.open) ?? null,
      resolve: (abs) => resolveInVaults(vaults, abs), readFile: () => null, personal: () => ({}),
    },
    rootFs: { isDirectory: (p) => { try { return fs.statSync(p).isDirectory() } catch { return false } }, mkdir: (p) => { fs.mkdirSync(p, { recursive: true }) } },
    shell: { trashItem: async (p) => { trash.push(p); fs.renameSync(p, path.join(fixture.base, `fixture-bin-${trash.length}`)) } },
    outlineDiskGuard: { forget() {}, release() {}, openUnder: () => [], check: async () => {} },
    outlineRecovery: { rekey: async () => {} },
    // `afterWrite` is the moment the handler is parked on the writer's await: where another process can act.
    writeTalkOutline: async (p, next, origin, opts) => {
      const result = hooks.actualWriter ? await actualWriter(p, next, origin, opts) : (fs.writeFileSync(p, typeof next === 'function' ? next(fs.readFileSync(p, 'utf8')) : next), { ok: true })
      await hooks.afterWrite?.(p)
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
  for (const name of ['create-talk', 'clone-talk', 'rename-talk', 'create-folder', 'rename-folder', 'move-talk', 'list-folders', 'delete-talk', 'delete-folder']) {
    vm.runInContext(code(handlerSource(`vault:${name}`)), context)
  }
  const event = { sender: { id: 1 } }
  const call = (name, ...args) => handlers.get(`vault:${name}`)(event, ...args)
  return { call, trash, invalidated, context, event }
}

let checks = 0
const failures = []
async function check(name, body, options = {}) {
  checks++
  const vault = makeVault(options.extra)
  try {
    options.setup?.(vault)
    await body(vault)
  } catch (error) {
    failures.push(`${name}: ${String(error?.message ?? error).split('\n')[0]}`)
  } finally {
    fs.rmSync(vault.base, { recursive: true, force: true })
  }
}

/** The request is refused: a falsy answer, not one byte or link changed, Trash never called, no reservation left. */
function refused(name, request, options = {}) {
  return check(`refused ${name}`, async (vault) => {
    const fixture = { ...vault, rootAs: options.rootAs?.(vault) }
    const app = loadHandlers(fixture, options.hooks)
    const before = snapshot(vault.base)
    const answer = await request(app, vault.root)
    assert.ok(!answer, `answered ${JSON.stringify(answer)}`)
    assert.deepEqual(app.trash, [], 'Trash was called')
    assert.deepEqual(snapshot(vault.base), before, 'the disk changed')
    assert.equal(vm.runInContext('managementMutations.size', app.context), 0, 'a reservation was left')
    assert.deepEqual(app.invalidated, [], 'caches were dropped for a refused request')
  }, options)
}

try {
  const outline = (root, rel) => path.join(root, rel)
  const TALK = 'Work/talk1/talk1-outline.md'
  const PROTECTED_FOLDERS = ['assets', 'assets/', 'assets/sub', '_assets', '_assets/logos', '_PRESENTATIONS', '_PRESENTATIONS/talk1', 'research', 'Work/Research', '.hidden', '.git', 'dist', 'bundle', 'node_modules',
    'Work/assets', 'Work/assets/sub', 'Cases/ASSETS', 'Cases/_Assets', 'Cases/RESEARCH', 'Cases/Dist', 'Cases/Node_Modules', 'Work\\assets', 'assets\\sub', 'Cases/ASSETS/',
    'Work/talk1/assets', 'Work/talk1/scratchpad', 'Work/talk1/dist']
  const LINKED_FOLDERS = ['link-to-assets', 'link-to-work', 'link-to-pool', 'Work/link-up', 'link-to-talk', 'link-to-work/Sub', 'link-to-work/Sub/Deep', 'link-to-work/assets', 'link-to-assets/sub']
  const NOT_CATEGORIES = ['notes.txt', 'Work/talk1', 'solo', 'Work/talk1/talk1-outline.md']
  const ESCAPES = ['', '.', '/', 'Work/../assets', './assets', '../outside', 'link-out', 'link-out/o.txt']

  for (const rel of [...PROTECTED_FOLDERS, ...LINKED_FOLDERS, ...NOT_CATEGORIES, ...ESCAPES]) {
    await refused(`Rename of ${JSON.stringify(rel)}`, (app) => app.call('rename-folder', rel, 'Renamed', 'v1'))
    await refused(`Bin of ${JSON.stringify(rel)}`, (app) => app.call('delete-folder', rel, 'v1'))
  }

  const PROTECTED_NAMES = ['assets', 'ASSETS', 'Assets', '_assets', '_Assets', '_PRESENTATIONS', 'research', 'Research', '.hidden', 'dist', 'bundle', 'node_modules', 'Node_Modules', '.git', 'assets.', 'assets ', 'aſſets', 'ａｓｓｅｔｓ']
  for (const name of PROTECTED_NAMES) {
    await refused(`Rename Other to ${JSON.stringify(name)}`, (app) => app.call('rename-folder', 'Other', name, 'v1'))
    await refused(`Rename nested Work/Sub to ${JSON.stringify(name)}`, (app) => app.call('rename-folder', 'Work/Sub', name, 'v1'))
    await refused(`new folder ${JSON.stringify(name)} at the root`, (app) => app.call('create-folder', name, '', 'v1'))
    await refused(`new folder ${JSON.stringify(name)} in Work`, (app) => app.call('create-folder', name, 'Work', 'v1'))
  }
  for (const slug of ['assets', 'research', '_assets', 'dist', 'bundle']) {
    await refused(`new talk with slug ${slug}`, (app) => app.call('create-talk', { title: slug, slug, topicFolder: '', vaultId: 'v1' }))
    await refused(`new talk with slug ${slug} in Work`, (app) => app.call('create-talk', { title: slug, slug, topicFolder: 'Work', vaultId: 'v1' }))
  }

  const PROTECTED_DESTINATIONS = [...PROTECTED_FOLDERS, 'assets/new', '_assets/new/deeper', 'Cases/ASSETS/new', ...LINKED_FOLDERS, 'link-out', 'Work/talk1', 'solo', 'Work/talk1/scratchpad', 'notes.txt']
  for (const rel of PROTECTED_DESTINATIONS) {
    await refused(`new folder in ${JSON.stringify(rel)}`, (app) => app.call('create-folder', 'New', rel, 'v1'))
    await refused(`new talk in ${JSON.stringify(rel)}`, (app) => app.call('create-talk', { title: 'New', slug: 'new-talk', topicFolder: rel, vaultId: 'v1' }))
    await refused(`talk Move to ${JSON.stringify(rel)}`, (app, root) => app.call('move-talk', outline(root, 'solo/solo-outline.md'), rel))
  }

  const PARKED = 'assets/parked/parked-outline.md'
  await refused('Bin of a talk filed inside assets', (app, root) => app.call('delete-talk', outline(root, PARKED)))
  await refused('Move of a talk out of assets', (app, root) => app.call('move-talk', outline(root, PARKED), 'Other'))
  await refused('Rename of a talk inside assets', (app, root) => app.call('rename-talk', outline(root, PARKED), 'Fresh title'))
  await refused('retitle of a talk inside assets', (app, root) => app.call('rename-talk', outline(root, PARKED), 'Parked'))
  await refused('Duplicate of a talk inside assets', (app, root) => app.call('clone-talk', outline(root, PARKED), 'Fresh title'))
  for (const [label, rel] of [['link to its folder', 'link-to-talk/talk1-outline.md'], ['link above its folder', 'link-to-work/talk1/talk1-outline.md']]) {
    await refused(`Bin of a talk by a ${label}`, (app, root) => app.call('delete-talk', outline(root, rel)))
    await refused(`Move of a talk by a ${label}`, (app, root) => app.call('move-talk', outline(root, rel), 'Other'))
    await refused(`Rename of a talk by a ${label}`, (app, root) => app.call('rename-talk', outline(root, rel), 'Fresh title'))
    await refused(`Duplicate of a talk by a ${label}`, (app, root) => app.call('clone-talk', outline(root, rel), 'Fresh title'))
  }

  // The registry only says where a vault is: no answer it gives makes a protected folder writable.
  for (const id of ['closed', 'gone', 'no-such-vault']) {
    await refused(`Rename in vault ${id}`, (app) => app.call('rename-folder', 'Other', 'Renamed', id))
    await refused(`Bin in vault ${id}`, (app) => app.call('delete-folder', 'Other', id))
    await refused(`new folder in vault ${id}`, (app) => app.call('create-folder', 'New', '', id))
  }
  await refused('Bin of assets with no vault id', (app) => app.call('delete-folder', 'assets'))
  await refused('Rename of assets with no vault id', (app) => app.call('rename-folder', 'assets', 'Renamed'))
  await refused('Bin of assets when the registry holds the root with a trailing slash', (app) => app.call('delete-folder', 'assets', 'v1'), { rootAs: ({ root }) => `${root}${path.sep}` })
  await refused('Bin of assets when the registry reaches the root through a link', (app) => app.call('delete-folder', 'assets', 'v1'), {
    rootAs: ({ base, root }) => { fs.symlinkSync(root, path.join(base, 'root-link')); return path.join(base, 'root-link') },
  })

  await check('the category list leaves out everything inspect-only and keeps ordinary folders', async (vault) => {
    const app = loadHandlers(vault)
    const listed = [...await app.call('list-folders', 'v1')].sort()
    assert.deepEqual(listed, ['Cases', 'Other', 'Work', 'Work/Sub', 'Work/Sub/Deep', 'assets-2026', 'bundles', 'dist-notes', 'my_assets', 'research-notes'].sort())
  })

  // Ordinary work: the guard never gets in the way of it.
  const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8')
  const gone = (root, rel) => assert.equal(fs.existsSync(path.join(root, rel)), false, `${rel} is still there`)

  await check('Rename of a category at the root', async ({ base, root }) => {
    const app = loadHandlers({ base, root })
    assert.equal(await app.call('rename-folder', 'Other', 'Renamed', 'v1'), 'Renamed')
    assert.equal(read(root, 'Renamed/keep.txt'), 'other')
    gone(root, 'Other')
  })
  await check('Rename of a nested category', async ({ base, root }) => {
    const app = loadHandlers({ base, root })
    assert.equal(await app.call('rename-folder', 'Work/Sub', 'Moved on', 'v1'), 'Work/Moved on')
    assert.equal(read(root, 'Work/Moved on/Deep/keep.txt'), 'deep')
  })
  await check('Rename of a category holding talks and their assets', async ({ base, root }) => {
    const app = loadHandlers({ base, root })
    assert.equal(await app.call('rename-folder', 'Work', 'Job', 'v1'), 'Job')
    assert.equal(read(root, 'Job/talk1/assets/p.png'), 'talk media')
    assert.equal(read(root, 'Job/assets/w.png'), 'work asset')
  })
  for (const name of ['assets-2026', 'my_assets', 'research-notes', 'bundles', 'dist-notes']) {
    await check(`Rename of the ordinary name ${name}`, async ({ base, root }) => {
      const app = loadHandlers({ base, root })
      assert.equal(await app.call('rename-folder', name, `${name}-b`, 'v1'), `${name}-b`)
    })
    await check(`Rename to the ordinary name ${name}-c`, async ({ base, root }) => {
      const app = loadHandlers({ base, root })
      assert.equal(await app.call('rename-folder', 'Other', `${name}-c`, 'v1'), `${name}-c`)
    })
  }
  await check('Bin of a category at the root reaches the Trash transport once', async ({ base, root }) => {
    const app = loadHandlers({ base, root })
    assert.equal(await app.call('delete-folder', 'Other', 'v1'), true)
    assert.deepEqual(app.trash, [path.join(root, 'Other')])
    gone(root, 'Other')
    assert.equal(fs.readFileSync(path.join(base, 'fixture-bin-1', 'keep.txt'), 'utf8'), 'other')
  })
  await check('Bin of a nested category', async ({ base, root }) => {
    const app = loadHandlers({ base, root })
    assert.equal(await app.call('delete-folder', 'Work/Sub/Deep', 'v1'), true)
    assert.deepEqual(app.trash, [path.join(root, 'Work/Sub/Deep')])
  })
  await check('Bin of a category holding assets, research and talks', async ({ base, root }) => {
    const app = loadHandlers({ base, root })
    assert.equal(await app.call('delete-folder', 'Work', 'v1'), true)
    assert.equal(fs.readFileSync(path.join(base, 'fixture-bin-1', 'talk1/assets/p.png'), 'utf8'), 'talk media')
  })
  await check('new folders at the root and nested', async ({ base, root }) => {
    const app = loadHandlers({ base, root })
    assert.equal(await app.call('create-folder', 'Fresh', '', 'v1'), 'Fresh')
    assert.equal(await app.call('create-folder', 'Fresh', 'Work/Sub', 'v1'), 'Work/Sub/Fresh')
    assert.equal(await app.call('create-folder', 'assets-2027', '', 'v1'), 'assets-2027')
    assert.equal(await app.call('create-folder', 'Other', '', 'v1'), 'Other')
    assert.equal(fs.statSync(path.join(root, 'Work/Sub/Fresh')).isDirectory(), true)
  })
  await check('new talks at the root and nested', async ({ base, root }) => {
    const app = loadHandlers({ base, root })
    const a = await app.call('create-talk', { title: 'New', slug: 'new-talk', topicFolder: '', vaultId: 'v1' })
    const b = await app.call('create-talk', { title: 'New', slug: 'new-talk', topicFolder: 'Work/Sub', vaultId: 'v1' })
    const c = await app.call('create-talk', { title: 'New', slug: 'assets-review', topicFolder: 'Other', vaultId: 'v1' })
    for (const talk of [a, b, c]) assert.ok(talk && fs.existsSync(talk.outlinePath))
  })
  await check('talk Move to a category, a nested category and the root keeps its bytes', async ({ base, root }) => {
    const app = loadHandlers({ base, root })
    const first = await app.call('move-talk', outline(root, TALK), 'Other')
    assert.equal(first.path, path.join(root, 'Other/talk1'))
    assert.equal(read(root, 'Other/talk1/assets/p.png'), 'talk media')
    const second = await app.call('move-talk', first.outlinePath, 'Work/Sub')
    assert.equal(second.path, path.join(root, 'Work/Sub/talk1'))
    const third = await app.call('move-talk', second.outlinePath, '')
    assert.equal(third.path, path.join(root, 'talk1'))
    assert.match(read(root, 'talk1/talk1-outline.md'), /Body of Talk one/)
  })
  await check('talk Duplicate, Rename and Bin', async ({ base, root }) => {
    const app = loadHandlers({ base, root })
    const copy = await app.call('clone-talk', outline(root, TALK), 'Talk copy')
    assert.equal(copy.path, path.join(root, 'Work/talk-copy'))
    assert.equal(read(root, 'Work/talk-copy/assets/p.png'), 'talk media')
    const renamed = await app.call('rename-talk', copy.outlinePath, 'Assets review')
    assert.equal(renamed.path, path.join(root, 'Work/assets-review'))
    assert.equal(await app.call('delete-talk', renamed.outlinePath), true)
    assert.deepEqual(app.trash, [path.join(root, 'Work/assets-review')])
    gone(root, 'Work/assets-review')
  })
  await check('a talk folder that is itself called assets stays a talk: its own folder is not what is judged', async ({ base, root }) => {
    fs.mkdirSync(path.join(root, 'Other/assets'))
    fs.writeFileSync(path.join(root, 'Other/assets/assets-outline.md'), OUTLINE('Called assets'))
    const app = loadHandlers({ base, root })
    const renamed = await app.call('rename-talk', path.join(root, 'Other/assets/assets-outline.md'), 'Better name')
    assert.equal(renamed.path, path.join(root, 'Other/better-name'))
  })

  // The app's own writers do not go through the guard.
  await check('media, pool, Run and outline writers keep their paths', async ({ base, root }) => {
    const app = loadHandlers({ base, root })
    vm.runInContext(`mkdirInVault(${JSON.stringify(root)}, ${JSON.stringify(path.join(root, 'Work/talk1/assets/imported'))})`, app.context)
    vm.runInContext(`mkdirInVault(${JSON.stringify(root)}, ${JSON.stringify(path.join(root, '_assets/logos/new'))})`, app.context)
    vm.runInContext(`mkdirInVault(${JSON.stringify(root)}, ${JSON.stringify(path.join(root, '_PRESENTATIONS/talk2'))})`, app.context)
    assert.equal(fs.statSync(path.join(root, 'Work/talk1/assets/imported')).isDirectory(), true)
    assert.equal(fs.statSync(path.join(root, '_PRESENTATIONS/talk2')).isDirectory(), true)
    assert.equal(vaultPaths.assetSidecarPath(root, 'img-1').ok, true)
    assert.equal(vaultPaths.outlineInVault(root, outline(root, PARKED)).ok, true)
    assert.equal(vaultPaths.talkFolderPath(root, path.join(root, 'assets/parked')).ok, true)
    assert.equal(vaultPaths.abstractPaths(root, path.join(root, 'assets/parked')).ok, true)
  })

  // Reservations and window claims still decide first, unchanged.
  await check('an open reservation holds an ordinary Rename until it is released', async ({ base, root }) => {
    const app = loadHandlers({ base, root })
    const release = vm.runInContext(`reserveManagementMutation(2, [${JSON.stringify(path.join(root, 'Other'))}])`, app.context)
    assert.equal(await app.call('rename-folder', 'Other', 'Renamed', 'v1'), null)
    assert.equal(fs.existsSync(path.join(root, 'Other')), true)
    release()
    assert.equal(await app.call('rename-folder', 'Other', 'Renamed', 'v1'), 'Renamed')
    assert.equal(vm.runInContext('managementMutations.size', app.context), 0)
  })
  await check('a window with a Gallery claim in flight is refused before any folder work', async ({ base, root }) => {
    const app = loadHandlers({ base, root })
    app.context.galleryReservations.set(app.event.sender.id, null)
    assert.equal(await app.call('rename-folder', 'Other', 'Renamed', 'v1'), null)
    assert.equal(await app.call('delete-folder', 'Other', 'v1'), false)
    assert.equal(fs.existsSync(path.join(root, 'Other')), true)
  })

  // ── The spellings the disk folds: APFS reaches `assets` by `aßets` and `aẞets`. ──
  for (const spelling of ['aßets', 'aẞets', 'Work/aßets', 'Work/aẞets']) {
    await refused(`Bin of ${spelling}`, (app) => app.call('delete-folder', spelling, 'v1'))
    await refused(`Rename of ${spelling}`, (app) => app.call('rename-folder', spelling, 'Renamed', 'v1'))
    await refused(`new folder in ${spelling}`, (app) => app.call('create-folder', 'New', spelling, 'v1'))
    await refused(`new talk in ${spelling}`, (app) => app.call('create-talk', { title: 'New', slug: 'new-talk', topicFolder: spelling, vaultId: 'v1' }))
    await refused(`talk Move to ${spelling}`, (app, root) => app.call('move-talk', outline(root, 'solo/solo-outline.md'), spelling))
  }
  await refused('Bin of a talk addressed through aßets', (app, root) => app.call('delete-talk', outline(root, 'aßets/parked/parked-outline.md')))
  await refused('Move of a talk addressed through aßets', (app, root) => app.call('move-talk', outline(root, 'aßets/parked/parked-outline.md'), 'Other'))
  await refused('Rename of a talk addressed through aßets', (app, root) => app.call('rename-talk', outline(root, 'aßets/parked/parked-outline.md'), 'Fresh title'))
  await refused('new talk with the slug aßets', (app) => app.call('create-talk', { title: 'x', slug: 'aßets', topicFolder: '', vaultId: 'v1' }))
  const NO_ASSETS = { setup: ({ root }) => { fs.rmSync(path.join(root, 'assets'), { recursive: true }); fs.rmSync(path.join(root, 'link-to-assets')) } }
  for (const name of ['aßets', 'aẞets']) {
    await refused(`Rename of Other to ${name} with no assets folder there`, (app) => app.call('rename-folder', 'Other', name, 'v1'), NO_ASSETS)
    await refused(`new folder ${name} with no assets folder there`, (app) => app.call('create-folder', name, '', 'v1'), NO_ASSETS)
  }
  // An alias no list of names can hold: the disk's answer is a stand-in (an NTFS short name is the reasoned case), the folder is real.
  await check('a folder the disk stores as assets is refused under any other spelling', async ({ base, root }) => {
    fs.mkdirSync(path.join(root, 'ASSE~1'))
    fs.writeFileSync(path.join(root, 'ASSE~1/logo.png'), 'x')
    fs.mkdirSync(path.join(root, 'ASSE~1/parked'))
    fs.writeFileSync(path.join(root, 'ASSE~1/parked/parked-outline.md'), OUTLINE('Parked'))
    const native = fs.realpathSync.native
    fs.realpathSync.native = (p, ...rest) => native(p, ...rest).replace('ASSE~1', 'assets')
    try {
      const app = loadHandlers({ base, root })
      const before = snapshot(base)
      assert.ok(!await app.call('delete-folder', 'ASSE~1', 'v1'), 'Bin answered')
      assert.ok(!await app.call('rename-folder', 'ASSE~1', 'Renamed', 'v1'), 'Rename answered')
      assert.ok(!await app.call('create-folder', 'New', 'ASSE~1', 'v1'), 'new folder answered')
      assert.ok(!await app.call('delete-talk', outline(root, 'ASSE~1/parked/parked-outline.md')), 'talk Bin answered')
      assert.ok(!await app.call('move-talk', outline(root, 'solo/solo-outline.md'), 'ASSE~1'), 'talk Move answered')
      assert.deepEqual(app.trash, [], 'Trash was called')
      assert.deepEqual(snapshot(base), before, 'the disk changed')
    } finally { fs.realpathSync.native = native }
  })

  // ── A stray outline makes nothing a talk: only the outline named for a protected folder does. ──
  const STRAY = {
    'assets/promo-outline.md': OUTLINE('Promo'), 'Work/assets/promo-outline.md': OUTLINE('Promo'), 'Cases/ASSETS/promo-outline.md': OUTLINE('Promo'),
    'dist/promo-outline.md': OUTLINE('Promo'), 'bundle/promo-outline.md': OUTLINE('Promo'), 'Cases/Dist/promo-outline.md': OUTLINE('Promo'),
  }
  for (const rel of Object.keys(STRAY)) {
    await refused(`Bin through a stray outline at ${rel}`, (app, root) => app.call('delete-talk', outline(root, rel)), { extra: STRAY })
    await refused(`Rename through a stray outline at ${rel}`, (app, root) => app.call('rename-talk', outline(root, rel), 'Fresh title'), { extra: STRAY })
    await refused(`retitle through a stray outline at ${rel}`, (app, root) => app.call('rename-talk', outline(root, rel), 'Promo'), { extra: STRAY })
    await refused(`Duplicate through a stray outline at ${rel}`, (app, root) => app.call('clone-talk', outline(root, rel), 'Fresh title'), { extra: STRAY })
    await refused(`Move through a stray outline at ${rel}`, (app, root) => app.call('move-talk', outline(root, rel), 'Other'), { extra: STRAY })
  }
  await refused('folder Bin of assets holding a stray outline', (app) => app.call('delete-folder', 'assets', 'v1'), { extra: STRAY })
  await refused('a stray outline beside one named for the folder is still stray', (app, root) => app.call('delete-talk', outline(root, 'Other/assets/promo-outline.md')), {
    extra: { 'Other/assets/assets-outline.md': OUTLINE('Called assets'), 'Other/assets/promo-outline.md': OUTLINE('Promo') },
  })

  const CALLED_ASSETS = { 'Other/assets/assets-outline.md': OUTLINE('Called assets'), 'Other/assets/logo.png': 'beside the outline' }
  const BELOW_IT = { ...CALLED_ASSETS, 'Other/assets/child/child-outline.md': OUTLINE('Child') }
  await refused('Bin of a talk filed below a talk called assets', (app, root) => app.call('delete-talk', outline(root, 'Other/assets/child/child-outline.md')), { extra: BELOW_IT })
  await refused('Move of a talk filed below a talk called assets', (app, root) => app.call('move-talk', outline(root, 'Other/assets/child/child-outline.md'), 'Work'), { extra: BELOW_IT })
  for (const dest of ['assets', 'Work/assets', 'research', 'dist', 'Work/talk1', 'link-to-work']) {
    await refused(`a talk called assets cannot move into ${dest}`, (app, root) => app.call('move-talk', outline(root, 'Other/assets/assets-outline.md'), dest), { extra: CALLED_ASSETS })
  }
  await check('a talk called assets moves into a category with what sits beside its outline', async ({ base, root }) => {
    const app = loadHandlers({ base, root })
    const moved = await app.call('move-talk', outline(root, 'Other/assets/assets-outline.md'), 'Work/Sub')
    assert.equal(moved.path, path.join(root, 'Work/Sub/assets'))
    assert.equal(read(root, 'Work/Sub/assets/logo.png'), 'beside the outline')
    gone(root, 'Other/assets')
  }, { extra: CALLED_ASSETS })
  await check('a talk called assets can be binned as a talk', async ({ base, root }) => {
    const app = loadHandlers({ base, root })
    assert.equal(await app.call('delete-talk', outline(root, 'Other/assets/assets-outline.md')), true)
    assert.deepEqual(app.trash, [path.join(root, 'Other/assets')])
  }, { extra: CALLED_ASSETS })
  await check('a talk called assets can be duplicated', async ({ base, root }) => {
    const app = loadHandlers({ base, root })
    const copy = await app.call('clone-talk', outline(root, 'Other/assets/assets-outline.md'), 'Better name')
    assert.equal(copy.path, path.join(root, 'Other/better-name'))
    assert.equal(read(root, 'Other/better-name/logo.png'), 'beside the outline')
  }, { extra: CALLED_ASSETS })
  await check('retitling a talk called assets to its own slug leaves its folder where it is', async ({ base, root }) => {
    const app = loadHandlers({ base, root })
    const same = await app.call('rename-talk', outline(root, 'Other/assets/assets-outline.md'), 'Assets')
    assert.equal(same.path, path.join(root, 'Other/assets'))
    assert.match(read(root, 'Other/assets/assets-outline.md'), /^title: "Assets"$/m)
  }, { extra: CALLED_ASSETS })

  // ── An outline that is a link, through the actual writer: refused with the bytes it points at unchanged. ──
  const LINKED_OUTLINE = {
    hooks: { actualWriter: true },
    setup: ({ root }) => { fs.mkdirSync(path.join(root, 'Work/lnk')); fs.symlinkSync('../../assets/parked/parked-outline.md', path.join(root, 'Work/lnk/lnk-outline.md')) },
  }
  const LINK = 'Work/lnk/lnk-outline.md'
  await check('the actual writer follows an outline link, so only the guard keeps the file inside assets', async ({ root }) => {
    const before = read(root, PARKED)
    const written = await actualWriter(outline(root, LINK), (text) => text.replace('title: Parked', 'title: Through the link'), 'retitle')
    assert.equal(written.ok, true)
    assert.notEqual(read(root, PARKED), before, 'the fixture is not live: the writer did not reach the file')
  }, LINKED_OUTLINE)
  for (const title of ['Lnk', 'Fresh title']) await refused(`Rename to ${title} through an outline link into assets`, (app, root) => app.call('rename-talk', outline(root, LINK), title), LINKED_OUTLINE)
  await refused('Duplicate through an outline link into assets', (app, root) => app.call('clone-talk', outline(root, LINK), 'Fresh title'), LINKED_OUTLINE)
  await refused('Move through an outline link into assets', (app, root) => app.call('move-talk', outline(root, LINK), 'Other'), LINKED_OUTLINE)
  await refused('Bin through an outline link into assets', (app, root) => app.call('delete-talk', outline(root, LINK)), LINKED_OUTLINE)
  // APFS reaches a link stored in capitals by the lower-case name a talk's outline must have.
  await refused('Rename through an outline link stored in capitals', (app, root) => app.call('rename-talk', outline(root, 'Work/caps/caps-outline.md'), 'Fresh title'), {
    hooks: { actualWriter: true },
    setup: ({ root }) => { fs.mkdirSync(path.join(root, 'Work/caps')); fs.symlinkSync('../../assets/parked/parked-outline.md', path.join(root, 'Work/caps/CAPS-OUTLINE.MD')) },
  })
  // The handler picks the outline again by name after the guard, and a link named for the folder wins that pick.
  const LINK_BESIDE = {
    hooks: { actualWriter: true },
    extra: { 'Work/pair/real-outline.md': OUTLINE('Real') },
    setup: ({ root }) => fs.symlinkSync('../../assets/parked/parked-outline.md', path.join(root, 'Work/pair/pair-outline.md')),
  }
  await refused('retitle of a real outline with a link into assets beside it', (app, root) => app.call('rename-talk', outline(root, 'Work/pair/real-outline.md'), 'Real'), LINK_BESIDE)
  await refused('Rename of a real outline with a link into assets beside it', (app, root) => app.call('rename-talk', outline(root, 'Work/pair/real-outline.md'), 'Fresh title'), LINK_BESIDE)

  // ── The await on the outline writer: another process acts while the handler is parked on it. ──
  const once = (act) => { let done = false; return { actualWriter: true, afterWrite: () => { if (done) return; done = true; act() } } }
  const TAKEN = 'Work/fresh-title'
  const names = (root, rel) => fs.readdirSync(path.join(root, rel)).sort()
  const ren = (root, from, to) => fs.renameSync(path.join(root, from), path.join(root, to))
  /** The handler refuses after the swap: what was swapped in is untouched, no stage or reservation is left. */
  function swapped(name, request, act, verify, setup) {
    return check(`nothing is touched: ${name}`, async (vault) => {
      const app = loadHandlers(vault, once(() => act(vault.root)))
      const answer = await request(app, vault.root)
      assert.ok(!answer, `answered ${JSON.stringify(answer)}`)
      verify(vault.root)
      assert.deepEqual(fs.readdirSync(vault.root).filter((entry) => entry.startsWith('.tw-clone-')), [], 'a stage was left')
      assert.equal(vm.runInContext('managementMutations.size', app.context), 0, 'a reservation was left')
    }, { setup })
  }
  const renameIt = (app, root) => app.call('rename-talk', outline(root, TALK), 'Fresh title')
  const duplicateIt = (app, root) => app.call('clone-talk', outline(root, TALK), 'Fresh title')
  const parkedTalk1 = ({ root }) => { fs.mkdirSync(path.join(root, 'assets/talk1')); fs.writeFileSync(path.join(root, 'assets/talk1/talk1-outline.md'), OUTLINE('In assets')) }
  const workForLink = (root) => { ren(root, 'Work', 'Work.was'); fs.symlinkSync('assets', path.join(root, 'Work')) }
  await swapped('Rename, Work replaced by a link to assets', renameIt, workForLink, (root) => {
    assert.deepEqual(names(root, 'assets'), ['logo.png', 'parked', 'sub', 'talk1'])
    assert.match(read(root, 'assets/talk1/talk1-outline.md'), /title: In assets/)
  }, parkedTalk1)
  await swapped('Duplicate, Work replaced by a link to assets', duplicateIt, workForLink, (root) => assert.deepEqual(names(root, 'assets'), ['logo.png', 'parked', 'sub']))
  const leafForAssets = (root) => { ren(root, 'Work/talk1', 'Work/talk1.was'); ren(root, 'assets', 'Work/talk1') }
  await swapped('Rename, the talk folder replaced by assets itself', renameIt, leafForAssets, (root) => {
    assert.equal(read(root, 'Work/talk1/logo.png'), 'root-asset')
    gone(root, TAKEN)
  })
  await swapped('Duplicate, the talk folder replaced by assets itself', duplicateIt, leafForAssets, (root) => {
    assert.equal(read(root, 'Work/talk1/logo.png'), 'root-asset')
    gone(root, TAKEN)
  })
  // Every name and the talk folder itself are as judged; only the parent's identity tells this one.
  const parentForAssets = (root) => { ren(root, 'Work/talk1', 'assets/talk1'); ren(root, 'Work', 'Work.was'); ren(root, 'assets', 'Work') }
  await swapped('Rename, the same talk folder now filed in what was assets', renameIt, parentForAssets, (root) => {
    assert.deepEqual(names(root, 'Work'), ['logo.png', 'parked', 'sub', 'talk1'])
  })
  await swapped('Duplicate, what was assets now standing where Work was', duplicateIt, parentForAssets, (root) => {
    assert.deepEqual(names(root, 'Work'), ['logo.png', 'parked', 'sub', 'talk1'])
  })
  // The folder, its parent and the destination are all as judged: only judging the talk again tells this one.
  const outlineForLink = (root) => { fs.rmSync(path.join(root, TALK)); fs.symlinkSync('../../assets/parked/parked-outline.md', path.join(root, TALK)) }
  for (const [name, request] of [['Rename', renameIt], ['Duplicate', duplicateIt]]) {
    await swapped(`${name}, the outline replaced by a link into assets`, request, outlineForLink, (root) => {
      assert.equal(fs.lstatSync(path.join(root, TALK)).isSymbolicLink(), true)
      assert.match(read(root, PARKED), /title: Parked/)
      gone(root, TAKEN)
    })
  }
  await swapped('Rename, a folder appeared at the destination', renameIt, (root) => fs.mkdirSync(path.join(root, TAKEN)), (root) => {
    assert.deepEqual(names(root, TAKEN), [])
    assert.equal(fs.existsSync(path.join(root, 'Work/talk1/talk1-outline.md')), true)
  })
  await check('Rename and Duplicate through the actual writer, with no swap', async ({ base, root }) => {
    const app = loadHandlers({ base, root }, { actualWriter: true })
    const copy = await app.call('clone-talk', outline(root, TALK), 'Second')
    assert.equal(copy.path, path.join(root, 'Work/second'))
    assert.doesNotMatch(read(root, 'Work/second/second-outline.md'), /handout_url/)
    const renamed = await app.call('rename-talk', outline(root, TALK), 'Fresh title')
    assert.equal(renamed.path, path.join(root, TAKEN))
    assert.match(read(root, 'Work/fresh-title/fresh-title-outline.md'), /^title: "Fresh title"$/m)
  })

  // ── A title is not a folder. ──
  for (const [title, folder] of [['Assets', 'assets-talk'], ['Research', 'research-talk'], ['dist', 'dist-talk'], ['Bundle', 'bundle-talk']]) {
    await check(`Rename to the title ${title} keeps the title and files the talk as ${folder}`, async ({ base, root }) => {
      const app = loadHandlers({ base, root })
      const renamed = await app.call('rename-talk', outline(root, TALK), title)
      assert.equal(renamed.path, path.join(root, 'Work', folder))
      assert.equal(renamed.title, title)
      assert.match(read(root, `Work/${folder}/${folder}-outline.md`), new RegExp(`^title: "${title}"$`, 'm'))
      assert.equal(read(root, `Work/${folder}/assets/p.png`), 'talk media')
      gone(root, 'Work/talk1')
    })
    await check(`Duplicate as ${title} keeps the title and files the copy as ${folder}`, async ({ base, root }) => {
      const app = loadHandlers({ base, root })
      const copy = await app.call('clone-talk', outline(root, TALK), title)
      assert.equal(copy.path, path.join(root, 'Work', folder))
      assert.equal(copy.title, title)
      assert.match(read(root, `Work/${folder}/${folder}-outline.md`), new RegExp(`^title: "${title}"$`, 'm'))
    })
  }
  await check('the safe folder name takes turns like any other: Duplicate suffixes it, Rename refuses it', async ({ base, root }) => {
    fs.mkdirSync(path.join(root, 'Work/assets-talk'))
    const app = loadHandlers({ base, root })
    const copy = await app.call('clone-talk', outline(root, TALK), 'Assets')
    assert.equal(copy.path, path.join(root, 'Work/assets-talk-2'))
    assert.equal((await app.call('rename-talk', outline(root, TALK), 'Assets')).error, 'target-exists')
    assert.deepEqual(names(root, 'Work/assets-talk'), [])
  })
  await check('titles that only start like a protected name keep their own folder', async ({ base, root }) => {
    const app = loadHandlers({ base, root })
    assert.equal((await app.call('rename-talk', outline(root, TALK), 'Research methods')).path, path.join(root, 'Work/research-methods'))
    assert.equal((await app.call('clone-talk', outline(root, 'Work/research-methods/research-methods-outline.md'), 'Bundles')).path, path.join(root, 'Work/bundles'))
  })

  // ── A destination a person chose for a PowerPoint import. Extraction and rendering stand in; the writers are real. ──
  const SOURCE_HASH = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
  const importDeps = (sourcePath, extras = {}) => ({
    extractPptx: async (_source, outputDir) => {
      fs.mkdirSync(path.join(outputDir, 'package'), { recursive: true })
      return { source: { path: sourcePath, fileName: 'source.pptx', hash: SOURCE_HASH, bytes: 12, slideCount: 1, width: 1, height: 1 }, packageDir: path.join(outputDir, 'package'),
        slides: [{ slideNumber: 1, hidden: false, title: 'Opening', paragraphs: ['Opening'], notes: '', shapes: [], warnings: [] }] }
    },
    renderOriginalSlides: async (_source, runDir) => {
      const dir = path.join(runDir, 'slides', '001')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'original.png'), 'rendered')
      return { renderer: { name: 'libreoffice', status: 'ready', officePath: '/s', rasterPath: '/p', officeVersion: 'f', rasterVersion: 'f' }, files: [path.join(dir, 'original.png')] }
    },
    createId: () => 'run-fixture', now: () => '2026-10-30T12:00:00.000Z', ...extras,
  })
  const sourceOf = ({ base }) => { const file = path.join(base, 'source.pptx'); fs.writeFileSync(file, 'fixture pptx'); return file }
  function importInto(vault, topicFolder, slug = 'imported', extras) {
    const sourcePath = path.join(vault.base, 'source.pptx')
    const options = { title: 'Imported', slug, topicFolder, slideRange: '', includeHidden: true, preserveNotes: true, extractMedia: true, fallbackPolicy: 'uncertain', renderer: 'automatic' }
    return startImport({ vaultRoot: vault.root, request: { sourcePath, options }, onProgress() {}, dependencies: importDeps(sourcePath, extras) })
  }
  function pickDestination(vault, chosen) {
    const handlers = new Map()
    registerImporterIpc({
      ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [chosen] }) }, shell: { showItemInFolder() {} },
      platform: 'darwin', getVaultRoot: () => vault.root, getSettings: () => ({}), setSettings() {}, resourcesDir: '',
    })
    return handlers.get('importer:choose-destination')()
  }
  const REFUSED_DESTINATIONS = ['assets', 'assets/new/deeper', 'ASSETS', 'aßets', '_assets', '_assets/logos/new', 'research', 'Work/Research', 'dist', 'bundle', 'node_modules', '.hidden',
    'Work/assets', 'Work/assets/new', 'Work/aẞets', 'Cases/ASSETS', 'Work/talk1', 'Work/talk1/assets', 'Work/talk1/new', 'solo', 'notes.txt', 'notes.txt/new',
    'link-to-assets', 'link-to-assets/sub', 'link-to-work', 'link-to-work/Sub', 'link-to-talk', 'Work/link-up', 'link-out', 'link-out/new']
  for (const topic of REFUSED_DESTINATIONS) {
    await check(`import refused at ${topic}, nothing created`, async (vault) => {
      sourceOf(vault)
      const before = snapshot(vault.base)
      await assert.rejects(importInto(vault, topic))
      assert.deepEqual(snapshot(vault.base), before, 'the disk changed')
    })
    await check(`destination picker refuses ${topic}`, async (vault) => {
      await assert.rejects(pickDestination(vault, path.join(vault.root, topic)))
    })
  }
  for (const topic of ['', 'Work', 'Work/Sub', 'Other', 'Fresh/Nested']) {
    await check(`import lands at ${JSON.stringify(topic)} with its assets, run and outline`, async (vault) => {
      sourceOf(vault)
      const detail = await importInto(vault, topic)
      const talk = path.join(vault.root, topic, 'imported')
      assert.equal(detail.manifest.talk.path, talk)
      assert.equal(fs.existsSync(path.join(talk, 'imported-outline.md')), true)
      assert.equal(fs.existsSync(path.join(talk, 'import-runs/run-fixture/manifest.json')), true)
      assert.equal(fs.existsSync(path.join(talk, `assets/import-${SOURCE_HASH.slice(0, 12)}-slide-001.png`)), true)
    })
  }
  for (const topic of ['', 'Work', 'Work/Sub']) {
    await check(`destination picker offers ${JSON.stringify(topic)}`, async (vault) => {
      assert.equal(await pickDestination(vault, path.join(vault.root, topic)), topic)
    })
  }
  await check('destination picker still refuses a folder outside the vault', async (vault) => {
    await assert.rejects(pickDestination(vault, path.join(vault.base, 'outside')))
  })
  for (const [slug, topic, landed] of [['research', '', 'research-import-2'], ['assets', 'Other', 'Other/assets-import-2'], ['dist', 'Work', 'Work/dist-import-2'], ['bundle', '', 'bundle-import-2']]) {
    await check(`an import with the slug ${slug} is never that folder`, async (vault) => {
      sourceOf(vault)
      const detail = await importInto(vault, topic, slug)
      assert.equal(detail.manifest.talk.path, path.join(vault.root, landed))
    }, { setup: ({ root }) => fs.rmSync(path.join(root, 'research'), { recursive: true }) })
  }
  await check('an import passes over a link standing at its slug, and writes nothing through it', async (vault) => {
    fs.mkdirSync(path.join(vault.base, 'outside/empty'))
    fs.symlinkSync('../../outside/empty', path.join(vault.root, 'Work/imported'))
    sourceOf(vault)
    const detail = await importInto(vault, 'Work')
    assert.equal(detail.manifest.talk.path, path.join(vault.root, 'Work/imported-import-2'))
    assert.deepEqual(fs.readdirSync(path.join(vault.base, 'outside/empty')), [])
  })
  await check('an import passes over a dangling link at its slug', async (vault) => {
    fs.symlinkSync('../../outside/not-there', path.join(vault.root, 'Work/imported'))
    sourceOf(vault)
    const detail = await importInto(vault, 'Work')
    assert.equal(detail.manifest.talk.path, path.join(vault.root, 'Work/imported-import-2'))
    assert.equal(fs.existsSync(path.join(vault.base, 'outside/not-there')), false)
  })

  // Resuming writes the same talk's assets and outline again: its destination is the folder that holds the run, proved again.
  const failing = { extractPptx: async () => { throw new Error('fixture extraction failed') } }
  async function failedRun(vault, topic = 'Work') {
    sourceOf(vault)
    await assert.rejects(importInto(vault, topic, 'imported', failing), /fixture extraction failed/)
    return path.join(vault.root, topic, 'imported')
  }
  const resume = (vault) => resumeImport({ vaultRoot: vault.root, runId: 'run-fixture', onProgress() {}, dependencies: importDeps(path.join(vault.base, 'source.pptx')) })
  const editManifest = (talkDir, change) => {
    const file = path.join(talkDir, 'import-runs/run-fixture/manifest.json')
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    change(manifest)
    fs.writeFileSync(file, JSON.stringify(manifest))
  }
  async function resumeRefused(vault) {
    const before = snapshot(vault.base)
    await assert.rejects(resume(vault), { message: IMPORT_RUN_PLACE_REFUSED })
    assert.deepEqual(snapshot(vault.base), before, 'the disk changed')
  }
  await check('a resume writes where the run lives', async (vault) => {
    const talk = await failedRun(vault)
    const detail = await resume(vault)
    assert.equal(detail.manifest.status, 'review')
    assert.equal(fs.existsSync(path.join(talk, `assets/import-${SOURCE_HASH.slice(0, 12)}-slide-001.png`)), true)
  })
  await check('a resume refuses a manifest pointing outside the vault', async (vault) => {
    const talk = await failedRun(vault)
    const victim = path.join(vault.base, 'outside/victim')
    editManifest(talk, (manifest) => { manifest.talk.path = victim; manifest.talk.outlinePath = path.join(victim, 'victim-outline.md') })
    await resumeRefused(vault)
  })
  await check('a resume refuses a manifest pointing into assets', async (vault) => {
    const talk = await failedRun(vault)
    const inside = path.join(vault.root, 'assets')
    editManifest(talk, (manifest) => { manifest.talk.path = inside; manifest.talk.outlinePath = path.join(inside, 'imported-outline.md') })
    await resumeRefused(vault)
  })
  await check('a resume refuses an outline path outside the folder that holds the run', async (vault) => {
    const talk = await failedRun(vault)
    editManifest(talk, (manifest) => { manifest.talk.outlinePath = path.join(vault.base, 'outside/victim-outline.md') })
    await resumeRefused(vault)
  })
  await check('a resume refuses a path that only comes to the right folder by way of a link', async (vault) => {
    const talk = await failedRun(vault)
    fs.symlinkSync('../../../outside', path.join(talk, 'hop'))
    editManifest(talk, (manifest) => { manifest.talk.outlinePath = `${talk}/hop/../imported-outline.md` })
    await resumeRefused(vault)
  })
  await check('a resume does not recreate a talk that has since moved', async (vault) => {
    const talk = await failedRun(vault)
    fs.renameSync(talk, path.join(vault.root, 'Work/renamed'))
    await resumeRefused(vault)
  })
  await check('a resume refuses a run filed in a protected folder', async (vault) => {
    const talk = await failedRun(vault)
    const parked = path.join(vault.root, 'assets/imported')
    fs.renameSync(talk, parked)
    editManifest(parked, (manifest) => { manifest.talk.path = parked; manifest.talk.outlinePath = path.join(parked, 'imported-outline.md') })
    await resumeRefused(vault)
  })

  // ── Requests that are not what they claim to be. ──
  for (const junk of [['assets', 'sub'], ['Other'], ['Work', 'Sub'], [], {}, 1, true]) {
    const shown = JSON.stringify(junk)
    await refused(`Rename of the folder ${shown}`, (app) => app.call('rename-folder', junk, 'Renamed', 'v1'))
    await refused(`Rename of Other to ${shown}`, (app) => app.call('rename-folder', 'Other', junk, 'v1'))
    await refused(`Bin of the folder ${shown}`, (app) => app.call('delete-folder', junk, 'v1'))
    await refused(`new folder named ${shown}`, (app) => app.call('create-folder', junk, '', 'v1'))
    await refused(`new folder in ${shown}`, (app) => app.call('create-folder', 'New', junk, 'v1'))
    await refused(`new talk in ${shown}`, (app) => app.call('create-talk', { title: 'New', slug: 'new-talk', topicFolder: junk, vaultId: 'v1' }))
    await refused(`talk Move to ${shown}`, (app, root) => app.call('move-talk', outline(root, 'solo/solo-outline.md'), junk))
  }
  for (const rel of ['Missing', 'Work/Missing', 'Fresh/Nested']) await refused(`Bin of ${rel}, which is not there`, (app) => app.call('delete-folder', rel, 'v1'))
} finally {
  fs.rmSync(run, { recursive: true, force: true })
}

if (failures.length) {
  console.error(failures.map((line) => `FAIL ${line}`).join('\n'))
  console.error(`${failures.length} of ${checks} checks failed`)
  process.exitCode = 1
} else console.log(`PASS ${checks} checks on actual management handlers and real files: inspect-only folders, links, files and talk insides refused unchanged with no Trash call; ordinary category and talk work, and the app's own writers, unaffected`)

// Open example vault (onboarding ticket 06). Seams: the ExampleVault writer in
// src/main/example-vault.ts over a temporary home (injected; never the real ~/Documents), the vault
// registry as index.ts wires it (in-memory config.json, real vault-file store, real realpath), the
// view's example flag, the bundled talks, and render checks of VaultSetup, the Add vault sheet and the
// vault header. Each rule A to H in the module header has a case here.
import assert from 'node:assert/strict'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync,
  symlinkSync, writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import {
  BUNDLE_LIMITS, ExampleVault, EXAMPLE_START_TALK, EXAMPLE_VAULT_MESSAGES, nodeExampleVaultFs, resolveExampleHome
} from '../src/main/example-vault.ts'
import { createVaultRegistry, migrateVaultConfig } from '../src/main/vault-registry.ts'
import { createVaultFileStore } from '../src/main/vault-file.ts'
import { viewVaults, EXAMPLE_VAULT_COLOUR } from '../src/main/vault-view.ts'
import { EXAMPLE_VAULT_TEXT } from '../src/shared/example-vault.ts'
import { TEXT, EX_TALKS } from '../docs/design/2026-10-09-onboarding-and-command-help/mockup-onboarding-talkweaver-text.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE = join(REPO, 'resources', 'example-vault')
const base = realpathSync(mkdtempSync(join(tmpdir(), 'tw-example-vault-')))
let passed = 0
const ok = (name) => { passed += 1; console.log(`PASS  ${name}`) }
async function test(name, fn) {
  try { await fn(); ok(name) } catch (error) { console.error(`FAIL  ${name}`); throw error }
}

let homeN = 0
/** A fresh home with a Documents folder (unless told otherwise) and a file of the person's own. */
function makeHome({ documents = true } = {}) {
  const home = join(base, `home-${++homeN}`)
  mkdirSync(home)
  if (documents) {
    mkdirSync(join(home, 'Documents'))
    writeFileSync(join(home, 'Documents', 'Letter.txt'), 'mine')
  }
  return home
}
const rootOf = (home) => join(home, 'Documents', 'TalkWeaver', 'Example vault')

/** Every path under dir (relative), with its type, size and mtime. */
function listing(dir) {
  const out = new Map()
  const walk = (d, rel) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      const r = rel ? `${rel}/${name}` : name
      const st = lstatSync(p)
      out.set(r, `${st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file'}:${st.isFile() ? st.size : ''}:${st.isFile() ? st.mtimeMs : ''}`)
      if (st.isDirectory() && !st.isSymbolicLink()) walk(p, r)
    }
  }
  walk(dir, '')
  return out
}
function added(before, after) {
  return [...after.keys()].filter((k) => !before.has(k))
}
function changed(before, after) {
  return [...before.keys()].filter((k) => after.get(k) !== before.get(k))
}

function harness(home, { initial = {}, failWrites = false, fs, bundleDir = BUNDLE } = {}) {
  let config = structuredClone(initial)
  let n = 0
  let failing = failWrites
  const registry = createVaultRegistry({
    read: () => structuredClone(config),
    write: (patch) => { if (failing) throw Object.assign(new Error('EROFS'), { code: 'EROFS' }); config = { ...config, ...structuredClone(patch) } },
    realpath: (p) => realpathSync(p),
    files: createVaultFileStore(),
    newId: () => `reg-${++n}`
  })
  const logs = []
  const example = new ExampleVault({
    home: () => home,
    bundleDir,
    registry,
    newId: () => 'example-id-1',
    now: () => new Date('2026-10-09T12:00:00.000Z'),
    log: (event, details) => logs.push({ event, details }),
    fs
  })
  return { registry, example, logs, config: () => config, setFailing: (v) => { failing = v } }
}

const bundleFiles = () => {
  const out = []
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      if (name === '.DS_Store') continue
      const p = join(d, name)
      const r = rel ? `${rel}/${name}` : name
      if (statSync(p).isDirectory()) walk(p, r)
      else out.push(r)
    }
  }
  walk(BUNDLE, '')
  return out
}

try {
  // ── the strings and the bundle ──
  await test('the fixed strings are the drawing’s (TEXT in the mockup text module)', () => {
    assert.equal(EXAMPLE_VAULT_TEXT.name, TEXT.vaultExample)
    assert.equal(EXAMPLE_VAULT_TEXT.mark, TEXT.exampleMark)
    assert.equal(EXAMPLE_VAULT_TEXT.or, TEXT.firstLaunch.or)
    assert.equal(EXAMPLE_VAULT_TEXT.title, TEXT.firstLaunch.exTitle)
    assert.equal(EXAMPLE_VAULT_TEXT.sub, TEXT.firstLaunch.exSub)
    assert.equal(EXAMPLE_VAULT_TEXT.button, TEXT.firstLaunch.exBtn)
    assert.equal(EXAMPLE_VAULT_TEXT.path, TEXT.firstLaunch.exPath)
    assert.ok(EXAMPLE_VAULT_TEXT.path.startsWith(TEXT.exampleDir))
    const parts = readFileSync(join(REPO, 'docs/design/2026-10-09-onboarding-and-command-help/mockup-onboarding-talkweaver-parts.mjs'), 'utf8')
    assert.ok(parts.includes(`'${EXAMPLE_VAULT_TEXT.subline}'`), 'the header line is the drawing’s')
  })

  await test('the bundle holds the five talks with the drawing’s titles, the start talk first in the list', () => {
    const files = bundleFiles()
    const outlines = files.filter((f) => f.endsWith('-outline.md'))
    assert.equal(outlines.length, 5)
    const titles = outlines.map((f) => /^title:\s*"?(.*?)"?\s*$/m.exec(readFileSync(join(BUNDLE, f), 'utf8'))?.[1])
    assert.deepEqual([...titles].sort(), EX_TALKS.map((t) => t[0]).sort())
    assert.ok(files.includes(EXAMPLE_START_TALK))
    assert.match(readFileSync(join(BUNDLE, EXAMPLE_START_TALK), 'utf8'), /title: "The Saturday market"/)
    assert.ok(!files.some((f) => f.startsWith('.talkweaver')), 'the vault file is made by the writer, not bundled')
  })

  await test('the bundle is packaged (electron-builder extraResources, asar off)', () => {
    const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
    assert.ok(pkg.build.extraResources.some((r) => r.from === 'resources/example-vault' && r.to === 'example-vault'))
    assert.equal(pkg.build.asar, false)
    const index = readFileSync(join(REPO, 'src/main/index.ts'), 'utf8')
    assert.ok(index.includes("join(process.resourcesPath, 'example-vault')"), 'the packaged app reads it from resources')
  })

  // ── rule A: the home ──
  await test('resolveExampleHome: a normal launch uses the system home; an e2e run only a temp stand-in, never packaged', () => {
    const real = (p) => realpathSync(p)
    assert.equal(resolveExampleHome({ isPackaged: true, env: {}, systemHome: () => '/Users/x' }), '/Users/x')
    assert.equal(resolveExampleHome({ isPackaged: false, env: { TW_E2E_HOME: base }, systemHome: () => '/Users/x' }), '/Users/x', 'the override is ignored without TW_E2E')
    assert.equal(resolveExampleHome({ isPackaged: false, env: { TW_E2E: '1' }, systemHome: () => '/Users/x' }), null)
    assert.equal(resolveExampleHome({ isPackaged: true, env: { TW_E2E: '1', TW_E2E_HOME: base }, systemHome: () => '/Users/x', realpath: real }), null)
    assert.equal(resolveExampleHome({ isPackaged: false, env: { TW_E2E: '1', TW_E2E_HOME: base }, systemHome: () => '/Users/x', realpath: real }), base)
    assert.equal(resolveExampleHome({ isPackaged: false, env: { TW_E2E: '1', TW_E2E_HOME: REPO }, systemHome: () => '/Users/x', realpath: real }), null, 'outside the temp folder')
    assert.equal(resolveExampleHome({ isPackaged: false, env: { TW_E2E: '1', TW_E2E_HOME: join(base, 'missing') }, systemHome: () => '/Users/x', realpath: real }), null)
  })

  // ── fresh ──
  await test('fresh: the five talks and the vault file are written, flagged in the list, nothing outside the folder', async () => {
    const home = makeHome()
    const before = listing(home)
    const { example, registry, logs } = harness(home)
    const result = await example.open()
    assert.deepEqual(result, { ok: true, vaultId: 'example-id-1', outcome: 'written', startTalk: join(rootOf(home), ...EXAMPLE_START_TALK.split('/')) })
    const after = listing(home)
    const prefix = 'Documents/TalkWeaver/Example vault'
    for (const p of added(before, after)) assert.ok(p === 'Documents/TalkWeaver' || p === prefix || p.startsWith(prefix + '/'), `written outside the example folder: ${p}`)
    assert.deepEqual(changed(before, after), [], 'nothing that was there changed')
    for (const f of bundleFiles()) assert.deepEqual(readFileSync(join(rootOf(home), f)), readFileSync(join(BUNDLE, f)), f)
    const file = JSON.parse(readFileSync(join(rootOf(home), '.talkweaver', 'vault.json'), 'utf8'))
    assert.deepEqual(file, { schema: 1, id: 'example-id-1', name: 'Example vault', shared: false, example: true, created_by: 'TalkWeaver', created_at: '2026-10-09T12:00:00.000Z' })
    const vaults = registry.list()
    assert.deepEqual(vaults, [{ id: 'example-id-1', root: rootOf(home), open: true, order: 0, example: true }])
    assert.equal(registry.primary()?.id, 'example-id-1', 'the first open vault (vaultRoot mirrors it)')
    assert.deepEqual(logs, [{ event: 'example-vault.open', details: { outcome: 'written' } }])
    assert.ok(!JSON.stringify(logs).includes(home), 'the log holds no path')
  })

  await test('fresh with TalkWeaver already there (holding the person’s own things): only Example vault is added', async () => {
    const home = makeHome()
    mkdirSync(join(home, 'Documents', 'TalkWeaver'))
    writeFileSync(join(home, 'Documents', 'TalkWeaver', 'notes.md'), 'own')
    const before = listing(home)
    const { example } = harness(home)
    const result = await example.open()
    assert.equal(result.ok && result.outcome, 'written')
    const after = listing(home)
    assert.deepEqual(changed(before, after), [])
    for (const p of added(before, after)) assert.ok(p.startsWith('Documents/TalkWeaver/Example vault'), p)
  })

  // ── rule C ──
  await test('already written and listed: opened again, no byte written; a closed example is reopened', async () => {
    const home = makeHome()
    const { example, registry } = harness(home, { initial: {} })
    await example.open()
    const before = listing(home)
    const again = await example.open()
    assert.deepEqual(again, { ok: true, vaultId: 'example-id-1', outcome: 'reopened', startTalk: join(rootOf(home), ...EXAMPLE_START_TALK.split('/')) })
    assert.deepEqual(listing(home), before, 'no byte or mtime changed')
    // The person closed it (another vault keeps one open).
    const own = join(home, 'Talks')
    mkdirSync(own)
    registry.add(own)
    registry.setOpen('example-id-1', false)
    const closedBefore = listing(rootOf(home))
    const reopened = await example.open()
    assert.equal(reopened.ok && reopened.outcome, 'reopened')
    assert.equal(registry.get('example-id-1')?.open, true)
    assert.deepEqual(listing(rootOf(home)), closedBefore)
    assert.equal(registry.list().length, 2, 'nothing else added')
  })

  await test('a foreign folder at the path: left alone, one sentence, nothing added', async () => {
    const home = makeHome()
    mkdirSync(rootOf(home), { recursive: true })
    writeFileSync(join(rootOf(home), 'my-notes.md'), 'own')
    const before = listing(home)
    const { example, registry, config } = harness(home)
    const result = await example.open()
    assert.deepEqual(result, { ok: false, reason: 'in-the-way', message: EXAMPLE_VAULT_MESSAGES.inTheWay })
    assert.deepEqual(listing(home), before)
    assert.deepEqual(registry.list(), [])
    assert.deepEqual(config(), {})
  })

  await test('an empty foreign folder, a file at the path, and a folder with a non-example vault file: all in the way', async () => {
    for (const make of [
      (root) => mkdirSync(root, { recursive: true }),
      (root) => { mkdirSync(dirname(root), { recursive: true }); writeFileSync(root, 'a file') },
      (root) => { mkdirSync(join(root, '.talkweaver'), { recursive: true }); writeFileSync(join(root, '.talkweaver', 'vault.json'), JSON.stringify({ schema: 1, id: 'someone-else', name: 'Mine' })) },
    ]) {
      const home = makeHome()
      make(rootOf(home))
      const before = listing(home)
      const { example, registry } = harness(home)
      const result = await example.open()
      assert.equal(result.ok, false)
      assert.equal(result.reason, 'in-the-way')
      assert.deepEqual(listing(home), before)
      assert.deepEqual(registry.list(), [])
    }
  })

  await test('the person’s own vault at the path (in the list, not the example): in the way, list unchanged', async () => {
    const home = makeHome()
    mkdirSync(rootOf(home), { recursive: true })
    const { example, registry } = harness(home)
    registry.add(rootOf(home))
    const listed = registry.list()
    const result = await example.open()
    assert.equal(result.ok === false && result.reason, 'in-the-way')
    assert.deepEqual(registry.list(), listed)
  })

  await test('something named TalkWeaver that is not a folder: in the way, nothing written', async () => {
    const home = makeHome()
    writeFileSync(join(home, 'Documents', 'TalkWeaver'), 'a file')
    const before = listing(home)
    const { example } = harness(home)
    const result = await example.open()
    assert.deepEqual(result, { ok: false, reason: 'in-the-way', message: EXAMPLE_VAULT_MESSAGES.parentInTheWay })
    assert.deepEqual(listing(home), before)
  })

  // ── rule B: symlinks ──
  await test('a symlink at the path, at TalkWeaver, or at Documents: refused, nothing written at either end', async () => {
    const cases = [
      (home, elsewhere) => { mkdirSync(join(home, 'Documents', 'TalkWeaver')); symlinkSync(elsewhere, rootOf(home)) },
      (home, elsewhere) => { symlinkSync(elsewhere, join(home, 'Documents', 'TalkWeaver')) },
      (home, elsewhere) => { rmSync(join(home, 'Documents'), { recursive: true }); symlinkSync(elsewhere, join(home, 'Documents')) },
      (home, elsewhere) => { mkdirSync(join(home, 'Documents', 'TalkWeaver')); symlinkSync(join(elsewhere, 'nothing-here'), rootOf(home)) },
    ]
    for (const make of cases) {
      const home = makeHome()
      const elsewhere = join(base, `elsewhere-${homeN}`)
      mkdirSync(elsewhere)
      make(home, elsewhere)
      const before = listing(home)
      const { example, registry } = harness(home)
      const result = await example.open()
      assert.deepEqual(result, { ok: false, reason: 'refused', message: EXAMPLE_VAULT_MESSAGES.symlink })
      assert.deepEqual(listing(home), before)
      assert.deepEqual(readdirSync(elsewhere), [], 'nothing written through the link')
      assert.deepEqual(registry.list(), [])
    }
  })

  await test('no Documents folder: refused, Documents is never created', async () => {
    const home = makeHome({ documents: false })
    const { example } = harness(home)
    const result = await example.open()
    assert.deepEqual(result, { ok: false, reason: 'refused', message: EXAMPLE_VAULT_MESSAGES.noDocuments })
    assert.deepEqual(readdirSync(home), [])
  })

  await test('a folder swapped for a symlink part-way (after a talk folder is made): refused, nothing written through it', async () => {
    const home = makeHome()
    const elsewhere = join(base, `swap-target-${homeN}`)
    mkdirSync(elsewhere)
    let swapped = false
    const fs = {
      ...nodeExampleVaultFs,
      mkdir: async (path) => {
        await nodeExampleVaultFs.mkdir(path)
        if (!swapped && path.startsWith(rootOf(home) + '/')) {
          swapped = true
          renameSync(rootOf(home), rootOf(home) + ' moved')
          symlinkSync(elsewhere, rootOf(home))
        }
      }
    }
    const { example, registry } = harness(home, { fs })
    const result = await example.open()
    assert.ok(swapped)
    assert.deepEqual(result, { ok: false, reason: 'refused', message: EXAMPLE_VAULT_MESSAGES.symlink })
    assert.deepEqual(readdirSync(elsewhere), [], 'no create followed the swapped-in link')
    assert.deepEqual(registry.list(), [])
  })

  await test('Documents or TalkWeaver swapped for a link while the bundle is read: refused before either first mkdir, nothing made through it', async () => {
    const cases = [
      // TalkWeaver missing: Documents is swapped; the TalkWeaver mkdir must not follow it.
      { pre: () => {}, swap: (home, elsewhere) => { renameSync(join(home, 'Documents'), join(home, 'Documents moved')); symlinkSync(elsewhere, join(home, 'Documents')) } },
      // TalkWeaver there: it is swapped; the Example vault mkdir must not follow it.
      { pre: (home) => mkdirSync(join(home, 'Documents', 'TalkWeaver')), swap: (home, elsewhere) => { const p = join(home, 'Documents', 'TalkWeaver'); renameSync(p, p + ' moved'); symlinkSync(elsewhere, p) } },
    ]
    for (const { pre, swap } of cases) {
      const home = makeHome()
      pre(home)
      const elsewhere = join(base, `read-swap-${homeN}`)
      mkdirSync(elsewhere)
      let swapped = false
      const fs = {
        ...nodeExampleVaultFs,
        openRead: async (path) => {
          if (!swapped) { swapped = true; swap(home, elsewhere) }
          return nodeExampleVaultFs.openRead(path)
        }
      }
      const { example, registry } = harness(home, { fs })
      const result = await example.open()
      assert.ok(swapped)
      assert.deepEqual(result, { ok: false, reason: 'refused', message: EXAMPLE_VAULT_MESSAGES.symlink })
      assert.deepEqual(readdirSync(elsewhere), [], 'no mkdir followed the swapped-in link')
      assert.deepEqual(registry.list(), [])
    }
  })

  // ── rule F: partial writes ──
  await test('a write that fails part-way: what was written stays, no vault file, not listed; the next click refuses it (in the way)', async () => {
    const home = makeHome()
    let creates = 0
    const fs = {
      ...nodeExampleVaultFs,
      createFile: async (path, data) => {
        creates += 1
        if (creates === 3) throw Object.assign(new Error('no space'), { code: 'ENOSPC' })
        return nodeExampleVaultFs.createFile(path, data)
      }
    }
    const { example, registry, logs } = harness(home, { fs })
    const result = await example.open()
    assert.deepEqual(result, { ok: false, reason: 'failed', message: EXAMPLE_VAULT_MESSAGES.failed })
    assert.deepEqual(logs.at(-1), { event: 'example-vault.open', details: { outcome: 'failed', code: 'ENOSPC' } })
    assert.ok(!existsSync(join(rootOf(home), '.talkweaver')), 'no vault file: the write never counts as the example')
    assert.deepEqual(registry.list(), [])
    const before = listing(home)
    const retry = await harness(home).example.open()
    assert.deepEqual(retry, { ok: false, reason: 'in-the-way', message: EXAMPLE_VAULT_MESSAGES.inTheWay })
    assert.deepEqual(listing(home), before, 'never written into')
  })

  await test('a write whose last step (adding to the list) failed: the next click adopts the folder, nothing written', async () => {
    const home = makeHome()
    const h = harness(home, { failWrites: true })
    const first = await h.example.open()
    assert.deepEqual(first, { ok: false, reason: 'failed', message: EXAMPLE_VAULT_MESSAGES.notListed })
    assert.ok(existsSync(join(rootOf(home), '.talkweaver', 'vault.json')))
    const before = listing(home)
    h.setFailing(false)
    const second = await h.example.open()
    assert.deepEqual(second, { ok: true, vaultId: 'example-id-1', outcome: 'adopted', startTalk: join(rootOf(home), ...EXAMPLE_START_TALK.split('/')) })
    assert.deepEqual(listing(home), before)
    assert.deepEqual(h.registry.list(), [{ id: 'example-id-1', root: rootOf(home), open: true, order: 0, example: true }])
  })

  await test('unwritable Documents: failed, nothing written, list unchanged, no throw', async () => {
    const home = makeHome()
    chmodSync(join(home, 'Documents'), 0o555)
    try {
      const before = listing(home)
      const { example, registry } = harness(home)
      const result = await example.open()
      assert.deepEqual(result, { ok: false, reason: 'failed', message: EXAMPLE_VAULT_MESSAGES.failed })
      assert.deepEqual(listing(home), before)
      assert.deepEqual(registry.list(), [])
    } finally {
      chmodSync(join(home, 'Documents'), 0o755)
    }
  })

  // ── rule D: the list first ──
  await test('the path would sit inside a vault in the list (Documents is a vault): refused before anything is written', async () => {
    const home = makeHome()
    const { example, registry } = harness(home)
    registry.add(join(home, 'Documents'))
    const listed = registry.list()
    const before = listing(home)
    const result = await example.open()
    assert.equal(result.ok === false && result.reason, 'nested')
    assert.match(result.message, /inside another vault \(Documents\)/)
    assert.deepEqual(listing(home), before)
    assert.deepEqual(registry.list(), listed)
  })

  // ── rule E: the bundle ──
  await test('a bundle with a link, a vault file, no start talk or an oversized file: nothing written (TalkWeaver not even made)', async () => {
    const bundles = []
    const mk = (name, fill) => { const d = join(base, `bundle-${name}`); mkdirSync(join(d, 'the-saturday-market'), { recursive: true }); fill(d); bundles.push(d) }
    const start = (d) => writeFileSync(join(d, 'the-saturday-market', 'the-saturday-market-outline.md'), '---\ntitle: x\n---\n')
    mk('link', (d) => { start(d); symlinkSync('/etc/hosts', join(d, 'hosts')) })
    mk('vaultfile', (d) => { start(d); mkdirSync(join(d, '.talkweaver')); writeFileSync(join(d, '.talkweaver', 'vault.json'), '{}') })
    mk('nostart', (d) => { writeFileSync(join(d, 'the-saturday-market', 'other.md'), 'x') })
    mk('big', (d) => { start(d); writeFileSync(join(d, 'big.bin'), Buffer.alloc(8 * 1024 * 1024 + 1)) })
    for (const bundleDir of bundles) {
      const home = makeHome()
      const before = listing(home)
      const { example, registry } = harness(home, { bundleDir })
      const result = await example.open()
      assert.deepEqual(result, { ok: false, reason: 'failed', message: EXAMPLE_VAULT_MESSAGES.bundle }, bundleDir)
      assert.deepEqual(listing(home), before, bundleDir)
      assert.deepEqual(registry.list(), [])
    }
  })

  await test('a bundle folder with more entries than the cap: the reader stops one past the cap, nothing written', async () => {
    const home = makeHome()
    let pulled = 0
    const fs = {
      ...nodeExampleVaultFs,
      opendir: async (path) => {
        if (path !== BUNDLE) return nodeExampleVaultFs.opendir(path)
        return (async function* () { for (;;) { pulled += 1; yield { name: `f-${pulled}.md`, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false } } })()
      }
    }
    const before = listing(home)
    const { example, logs } = harness(home, { fs })
    const result = await example.open()
    assert.deepEqual(result, { ok: false, reason: 'failed', message: EXAMPLE_VAULT_MESSAGES.bundle })
    assert.equal(pulled, BUNDLE_LIMITS.entries + 1, 'never read past the cap')
    assert.deepEqual(logs.at(-1).details, { outcome: 'failed', code: 'BUNDLE_ENTRIES' })
    assert.deepEqual(listing(home), before)
  })

  await test('a bundle file whose descriptor is over the cap, or that grows while read: at most cap + 1 bytes read, nothing written', async () => {
    const start = join(BUNDLE, ...EXAMPLE_START_TALK.split('/'))
    const variants = [
      // fstat on the open descriptor reports more than the cap (lstat saw the real, small size).
      { stat: (st) => Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size: BUNDLE_LIMITS.fileBytes + 1 }), endless: false, expectRead: 0 },
      // fstat is small, but the file keeps giving bytes.
      { stat: (st) => st, endless: true, expectRead: BUNDLE_LIMITS.fileBytes + 1 },
    ]
    for (const v of variants) {
      const home = makeHome()
      let readBytes = 0
      let closed = false
      const fs = {
        ...nodeExampleVaultFs,
        openRead: async (path) => {
          const real = await nodeExampleVaultFs.openRead(path)
          if (path !== start) return real
          return {
            stat: async () => v.stat(await real.stat()),
            read: async (buffer, offset, length, position) => {
              if (!v.endless) { const r = await real.read(buffer, offset, length, position); readBytes += r.bytesRead; return r }
              readBytes += length
              return { bytesRead: length }
            },
            close: async () => { closed = true; await real.close() }
          }
        }
      }
      const before = listing(home)
      const { example, logs } = harness(home, { fs })
      const result = await example.open()
      assert.deepEqual(result, { ok: false, reason: 'failed', message: EXAMPLE_VAULT_MESSAGES.bundle })
      assert.equal(readBytes, v.expectRead)
      assert.ok(closed, 'the descriptor is closed')
      assert.deepEqual(logs.at(-1).details, { outcome: 'failed', code: 'BUNDLE_FILE_SIZE' })
      assert.deepEqual(listing(home), before)
    }
  })

  await test('no home for this run: unavailable, nothing written', async () => {
    const { registry } = harness(base)
    const example = new ExampleVault({ home: () => null, bundleDir: BUNDLE, registry })
    assert.deepEqual(await example.open(), { ok: false, reason: 'unavailable', message: EXAMPLE_VAULT_MESSAGES.unavailable })
    assert.equal(await example.root(), null)
  })

  // ── rule H ──
  await test('two clicks at once: one writes, the other finds it (one at a time)', async () => {
    const home = makeHome()
    const { example, registry } = harness(home)
    const [a, b] = await Promise.all([example.open(), example.open()])
    assert.equal(a.ok && a.outcome, 'written')
    assert.equal(b.ok && b.outcome, 'reopened')
    assert.equal(registry.list().length, 1)
  })

  // ── the registry and the view ──
  await test('registry: the example flag is stored only when true, survives migration, and only add({ example }) sets it', () => {
    const slice = { vaults: [{ id: 'a', root: '/a', open: true, order: 0, example: true }, { id: 'b', root: '/b', open: true, order: 1, example: 'yes' }] }
    const { slice: out } = migrateVaultConfig(slice, () => 'n')
    assert.deepEqual(out.vaults, [{ id: 'a', root: '/a', open: true, order: 0, example: true }, { id: 'b', root: '/b', open: true, order: 1 }])
    const again = migrateVaultConfig(out, () => 'n')
    assert.equal(again.changed, false, 'reading is idempotent with the flag')
    const home = makeHome()
    const plain = join(home, 'Plain')
    mkdirSync(plain)
    const { registry } = harness(home)
    assert.equal('example' in registry.add(plain), false)
    const ids = registry.list().map((v) => v.id)
    assert.equal(new Set(ids).size, ids.length, 'unique ids')
    assert.deepEqual(registry.list().map((v) => v.order), [0], 'ordered list')
  })

  await test('view: the example vault is marked and teal unless the person chose a colour', () => {
    const probe = { home: '/Users/x', exists: () => false }
    const vaults = [{ id: 'p', root: '/Users/x/Talks', open: true, order: 0 }, { id: 'e', root: '/Users/x/Documents/TalkWeaver/Example vault', open: true, order: 1, example: true }]
    const views = viewVaults(vaults, probe, (v) => (v.id === 'e' ? { file: { state: 'ok', file: { id: 'e', name: 'Example vault', example: true } } } : {}))
    assert.equal(views[0].example, false)
    assert.equal(views[1].example, true)
    assert.equal(views[1].color, EXAMPLE_VAULT_COLOUR)
    assert.equal(views[1].initial, 'E')
    assert.equal(views[1].name, 'Example vault')
    const own = viewVaults(vaults, probe, (v) => (v.id === 'e' ? { personal: { badgeColour: '#be185d' } } : {}))
    assert.equal(own[1].color, '#be185d')
  })

  // ── render ──
  const renderDir = mkdtempSync(join(REPO, '.test-example-vault-'))
  const bundle = join(renderDir, 'bundle.mjs')
  await build({
    stdin: {
      contents: [
        "import React from 'react'",
        "import { renderToStaticMarkup } from 'react-dom/server'",
        "import VaultSetup from './src/renderer/src/components/VaultSetup.tsx'",
        "import { VaultSheet } from './src/renderer/src/components/talklist/VaultSheet.tsx'",
        "import { VaultHeader } from './src/renderer/src/components/talklist/VaultRows.tsx'",
        "export const setup = (props) => renderToStaticMarkup(React.createElement(VaultSetup, props))",
        "export const sheet = (props) => renderToStaticMarkup(React.createElement(VaultSheet, props))",
        "export const header = (props) => renderToStaticMarkup(React.createElement(VaultHeader, props))"
      ].join('\n'),
      resolveDir: REPO,
      sourcefile: 'test-example-vault-entry.tsx'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    external: ['react', 'react/*', 'react-dom', 'react-dom/*', 'lucide-react'],
    outfile: bundle,
    logLevel: 'silent'
  })
  const m = await import(pathToFileURL(bundle).href)
  const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()

  await test('VaultSetup shows both choices: Choose Vault Folder, and the example card as drawn (state 01)', () => {
    const html = m.setup({ onVaultChosen: () => {}, onOpenExample: async () => null })
    const t = text(html)
    for (const s of ['Choose your Vault', 'Choose Vault Folder', TEXT.firstLaunch.or, TEXT.firstLaunch.exTitle, TEXT.exampleMark, TEXT.firstLaunch.exSub, TEXT.firstLaunch.exPath, TEXT.firstLaunch.exBtn]) {
      assert.ok(t.includes(s), `missing: ${s}`)
    }
    assert.ok(t.indexOf('Choose Vault Folder') < t.indexOf(TEXT.firstLaunch.or), 'the folder first, the example under “or look around first”')
    assert.ok(html.includes('data-open-example'))
    const plain = text(m.setup({ onVaultChosen: () => {} }))
    assert.ok(!plain.includes(TEXT.firstLaunch.exBtn), 'without the handler the screen is the old one')
  })

  await test('the Add vault… sheet offers a folder and the example vault', () => {
    const html = m.sheet({ state: { mode: 'add' }, onClose: () => {}, onDone: () => {}, onChooseAnother: () => {}, onShowVault: () => {}, onOpenExample: async () => null })
    assert.ok(html.includes('data-vault-sheet="add"'))
    assert.ok(html.includes('data-choose-folder'))
    const t = text(html)
    assert.ok(t.includes('Choose a folder…') && t.includes(TEXT.firstLaunch.exBtn) && t.includes(TEXT.firstLaunch.exPath))
  })

  await test('the example vault’s header: Example pill and “Removable · local folder” with the graduation cap; another vault has neither', () => {
    const view = { id: 'e', root: '/r', open: true, order: 0, name: 'Example vault', baseName: 'Example vault', initial: 'E', color: EXAMPLE_VAULT_COLOUR, service: 'Local', shared: false, hasFile: true, createdBy: 'TalkWeaver', duplicateOf: null, unavailable: null, example: true }
    const props = { expanded: true, focused: false, rowRef: () => {}, onToggle: () => {}, onMenu: () => {} }
    const html = m.header({ ...props, vault: view })
    const t = text(html)
    assert.ok(t.includes('Example vault') && t.includes(TEXT.exampleMark) && t.includes('Removable · local folder'))
    assert.ok(html.includes('data-vault-example-line') && html.includes('M22 10v6'), 'the lucide graduation cap')
    assert.ok(html.includes('data-vault-example="true"'))
    const own = m.header({ ...props, vault: { ...view, id: 'p', name: 'Personal', baseName: 'Personal', example: false } })
    assert.ok(!own.includes('data-vault-example') && !text(own).includes('Removable'))
    assert.ok(text(own).includes('Local · private'))
  })

  console.log(`\n${passed} passed`)
} finally {
  rmSync(base, { recursive: true, force: true })
  for (const name of readdirSync(REPO)) if (name.startsWith('.test-example-vault-')) rmSync(join(REPO, name), { recursive: true, force: true })
}

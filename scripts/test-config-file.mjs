// config.json writes are atomic and keep their merge semantics (several-vaults ticket 02, carried
// from the ticket 01 review). Seam: createConfigFile (src/main/config-file.ts).
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createConfigFile } from '../src/main/config-file.ts'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const base = fs.mkdtempSync(join(tmpdir(), 'tw-config-file-'))
const path = join(base, 'userData', 'config.json')
const vaults = [{ id: 'v1', root: '/Users/x/vault', open: true, order: 0 }]
const tmpFiles = () => fs.readdirSync(dirname(path)).filter((f) => f.endsWith('.tmp'))

let passed = 0
const test = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`) }

try {
  test('a write shallow-merges the patch over the stored config (creating the folder)', () => {
    const config = createConfigFile(path)
    assert.deepEqual(config.read(), {}, 'no file reads as {}')
    config.write({ vaults, vaultRoot: '/Users/x/vault', windowBounds: { x: 1 } })
    config.write({ windowBounds: { y: 2 } })
    assert.deepEqual(config.read(), { vaults, vaultRoot: '/Users/x/vault', windowBounds: { y: 2 } }, 'patch keys replace, others are kept')
    assert.equal(fs.readFileSync(path, 'utf8'), JSON.stringify(config.read(), null, 2), 'same pretty JSON as before')
    assert.deepEqual(tmpFiles(), [], 'no temp file is left after a write')
  })

  test('replace() stores exactly the given object (removing a key)', () => {
    const config = createConfigFile(path)
    const c = config.read(); delete c.windowBounds
    config.replace(c)
    assert.deepEqual(config.read(), { vaults, vaultRoot: '/Users/x/vault' })
  })

  test('a failed write (disk full at the temp file) leaves the old file intact and throws', () => {
    const before = fs.readFileSync(path, 'utf8')
    const failing = { ...fs, writeSync: (fd, buf) => { fs.writeSync(fd, buf, 0, 7); throw new Error('ENOSPC') } }
    assert.throws(() => createConfigFile(path, failing).write({ vaults: [] }), /ENOSPC/)
    assert.equal(fs.readFileSync(path, 'utf8'), before)
    assert.deepEqual(tmpFiles(), [], 'the partial temp file is removed')
  })

  test('the temp file is fsynced and closed before the rename; the folder is fsynced after it', () => {
    const calls = []
    const fds = new Map()
    const spying = {
      ...fs,
      openSync: (p, flags) => { const fd = fs.openSync(p, flags); fds.set(fd, p); calls.push(`open ${p === dirname(path) ? 'dir' : 'tmp'}`); return fd },
      fsyncSync: (fd) => { calls.push(`fsync ${fds.get(fd) === dirname(path) ? 'dir' : 'tmp'}`); return fs.fsyncSync(fd) },
      closeSync: (fd) => { calls.push(`close ${fds.get(fd) === dirname(path) ? 'dir' : 'tmp'}`); return fs.closeSync(fd) },
      renameSync: (a, b) => { calls.push('rename'); return fs.renameSync(a, b) }
    }
    createConfigFile(path, spying).write({ synced: true })
    assert.deepEqual(calls, ['open tmp', 'fsync tmp', 'close tmp', 'rename', 'open dir', 'fsync dir', 'close dir'])
    assert.equal(createConfigFile(path).read().synced, true)
  })

  test('a platform that refuses to fsync a folder (EISDIR/EINVAL) still writes', () => {
    for (const code of ['EISDIR', 'EINVAL']) {
      const refusing = {
        ...fs,
        openSync: (p, flags) => { if (p === dirname(path)) { const e = new Error(code); e.code = code; throw e } return fs.openSync(p, flags) }
      }
      createConfigFile(path, refusing).write({ refused: code })
      assert.equal(createConfigFile(path).read().refused, code)
    }
    const c = createConfigFile(path).read(); delete c.refused; delete c.synced
    createConfigFile(path).replace(c)
  })

  test('a crash between the temp write and the rename leaves the old file intact', () => {
    const before = fs.readFileSync(path, 'utf8')
    // A real process, killed (SIGKILL: no cleanup runs) at the moment it would rename.
    const child = `
      import * as fs from 'node:fs'
      import { createConfigFile } from ${JSON.stringify(pathToFileURL(join(repo, 'src/main/config-file.ts')).href)}
      const crashing = { ...fs, renameSync: () => process.kill(process.pid, 'SIGKILL') }
      createConfigFile(${JSON.stringify(path)}, crashing).write({ vaults: [], note: 'x'.repeat(100000) })
    `
    const run = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--input-type=module', '-e', child], { encoding: 'utf8' })
    assert.equal(run.signal, 'SIGKILL', `the child died mid-write (${run.stderr})`)
    assert.equal(fs.readFileSync(path, 'utf8'), before, 'config.json is byte-identical')
    assert.deepEqual(createConfigFile(path).read().vaults, vaults, 'the vault list survives')
    assert.equal(tmpFiles().length, 1, 'only the orphaned temp file holds the unfinished write')
    // The next write succeeds and does not read the orphan.
    createConfigFile(path).write({ later: true })
    assert.deepEqual(createConfigFile(path).read(), { vaults, vaultRoot: '/Users/x/vault', later: true })
  })

  test('startup sweep removes only stale <name>.<pid>.tmp files beside the config', () => {
    const d = dirname(path)
    const now = Date.now()
    const names = ['config.json.123.tmp', 'config.json.456.tmp', 'config.json.tmp', 'other.json.1.tmp', 'config.json.1.tmp.bak']
    for (const n of names) fs.writeFileSync(join(d, n), 'x')
    const old = (now - 5 * 60_000) / 1000
    for (const n of names) fs.utimesSync(join(d, n), old, old)
    fs.utimesSync(join(d, 'config.json.456.tmp'), now / 1000, now / 1000) // a write in flight
    const orphan = tmpFiles().filter((n) => !names.includes(n)) // left by the SIGKILL test
    for (const n of orphan) fs.utimesSync(join(d, n), old, old)
    assert.equal(createConfigFile(path).sweepStaleTemps(60_000, now), 1 + orphan.length)
    const left = fs.readdirSync(d).sort()
    assert.ok(!left.includes('config.json.123.tmp'))
    for (const n of ['config.json.456.tmp', 'config.json.tmp', 'other.json.1.tmp', 'config.json.1.tmp.bak', 'config.json']) assert.ok(left.includes(n), n)
    assert.equal(createConfigFile(join(base, 'nowhere', 'config.json')).sweepStaleTemps(), 0)
  })

  test('the temp file is created exclusively: a stale temp or a link planted at its name is replaced, never written through', () => {
    const d = join(base, 'excl')
    fs.mkdirSync(d, { recursive: true })
    const p = join(d, 'config.json')
    const tmp = `${p}.${process.pid}.tmp`
    const victim = join(base, 'victim.txt')
    fs.writeFileSync(victim, 'untouched')
    fs.symlinkSync(victim, tmp)
    createConfigFile(p).write({ a: 1 })
    assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched', 'nothing written through the link')
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { a: 1 })
    fs.writeFileSync(tmp, 'stale')
    createConfigFile(p).write({ b: 2 })
    assert.deepEqual(JSON.parse(fs.readFileSync(p, 'utf8')), { a: 1, b: 2 })
    assert.equal(fs.existsSync(tmp), false)
  })

  console.log(`config file tests passed (${passed})`)
} finally {
  fs.rmSync(base, { recursive: true, force: true })
}

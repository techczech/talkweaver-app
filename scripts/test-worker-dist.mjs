// The build step of the live service (ticket 11): worker-dist/ is compiled once, in the repository,
// and the app is not built or packaged when it is missing, empty, does not match its manifest, or is
// older than the Worker's sources (scripts/lib/worker-dist.mjs, scripts/build-worker-dist.mjs,
// scripts/check-worker-dist.mjs, scripts/electron-builder-before-pack.cjs). Everything is built in
// throwaway folders; the repository's own worker-dist/ is not touched.
//
// "Older" is decided by content, never by file times: a checkout gives files whatever times it
// likes, on every platform. Line endings are not content: the same sources checked out with CRLF
// (as Git can on Windows) are not stale.
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { buildWorkerDist, checkWorkerDist, workerSourceDigest, workerSourceFiles } from './lib/worker-dist.mjs'
import { verifyShippedBundle } from '../src/main/live-service-upload.ts'

const started = Date.now()
const repo = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tw-worker-dist-')))
const hex = (bytes) => createHash('sha256').update(bytes).digest('hex')
const node = (script, args) => spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', join(repo, 'scripts', script), ...args], { cwd: repo, encoding: 'utf8', timeout: 180_000, windowsHide: true })

try {
  // ── A build ────────────────────────────────────────────────────────────────────────────────────
  const dist = join(scratch, 'worker-dist')
  const built = node('build-worker-dist.mjs', ['--out', dist])
  assert.equal(built.status, 0, `the build step runs\n${built.stdout}\n${built.stderr}`)
  assert.deepEqual(readdirSync(dist).sort(), ['index.js', 'manifest.json', 'upload-config.json'], 'it writes the bundle, its settings and the manifest, and nothing else')
  const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'))
  const bundle = readFileSync(join(dist, 'index.js'))
  assert.ok(bundle.length > 10_000, `a real bundle (${bundle.length} bytes)`)
  assert.match(bundle.toString('utf8'), /export\s*\{[\s\S]*\bdefault\b/, 'the Worker module, with its default export')
  assert.deepEqual([manifest.files['index.js'].sha256, manifest.files['index.js'].bytes], [hex(bundle), bundle.length], 'the manifest holds its SHA-256 and size')
  assert.equal(manifest.wrangler, JSON.parse(readFileSync(join(repo, 'node_modules', 'wrangler', 'package.json'), 'utf8')).version, 'and the wrangler that compiled it')
  assert.equal(manifest.build, /export const LIVE_WORKER_BUILD\s*=\s*'([^']+)'/.exec(readFileSync(join(repo, 'worker', 'recovery-protocol.ts'), 'utf8'))[1], 'and the Worker\'s build string')
  assert.equal(manifest.sources, workerSourceDigest(join(repo, 'worker')))
  assert.ok(!/\/(?:Users|home)\/|[A-Za-z]:\\\\/.test(bundle.toString('utf8').split('\n').filter((line) => line.startsWith('// ')).join('\n')), 'the source comments in the bundle hold no path of the machine that built it')
  assert.deepEqual(checkWorkerDist({ repo, distDir: dist }), [], 'the check passes on what was just built')
  assert.equal(verifyShippedBundle(readFileSync(join(dist, 'manifest.json'), 'utf8'), { bundle, config: readFileSync(join(dist, 'upload-config.json')) }, manifest.build).ok, true, 'and so does the app\'s own check')
  // The compile's own folder inside the repository is gone afterwards.
  assert.deepEqual(readdirSync(repo).filter((name) => name.startsWith('.worker-dist-build-')), [], 'the build leaves no run folder in the repository')
  // The same sources give the same bytes.
  const again = join(scratch, 'again')
  assert.equal(node('build-worker-dist.mjs', ['--out', again]).status, 0)
  assert.ok(readFileSync(join(again, 'index.js')).equals(bundle), 'a second build of the same sources is byte for byte the same')
  console.log(`PASS 1: the build step compiles the Worker once into worker-dist/ (${bundle.length} bytes) with its manifest; the same sources give the same bytes`)

  // ── What stops a build ─────────────────────────────────────────────────────────────────────────
  const copy = (name) => { const to = join(scratch, name); cpSync(dist, to, { recursive: true }); return to }
  const fails = (distDir, pattern, what, workerDir) => {
    const problems = checkWorkerDist({ repo, distDir, ...(workerDir ? { workerDir } : {}) })
    assert.ok(problems.length > 0 && problems.some((line) => pattern.test(line)), `${what}: ${JSON.stringify(problems)}`)
  }
  fails(join(scratch, 'not-there'), /is missing/, 'a missing folder')
  mkdirSync(join(scratch, 'empty'))
  fails(join(scratch, 'empty'), /is empty/, 'an empty folder')
  const emptied = copy('emptied')
  writeFileSync(join(emptied, 'index.js'), '')
  fails(emptied, /incomplete.*index\.js is empty/, 'an empty bundle')
  const gone = copy('gone')
  rmSync(join(gone, 'index.js'))
  fails(gone, /incomplete.*index\.js is missing/, 'a missing bundle')
  const changed = copy('changed')
  writeFileSync(join(changed, 'index.js'), Buffer.concat([bundle, Buffer.from('\n// one more line\n')]))
  fails(changed, /index\.js does not match its manifest/, 'a bundle changed after it was built')
  const noManifest = copy('no-manifest')
  rmSync(join(noManifest, 'manifest.json'))
  fails(noManifest, /manifest\.json is missing/, 'no manifest')
  const otherWrangler = copy('other-wrangler')
  writeFileSync(join(otherWrangler, 'manifest.json'), JSON.stringify({ ...manifest, wrangler: '4.0.0' }))
  fails(otherWrangler, /compiled with wrangler 4\.0\.0/, 'a bundle from another wrangler')

  // Stale: the Worker's sources changed after the folder was built (a copy of worker/ is built and then edited).
  const worker = join(scratch, 'worker')
  cpSync(join(repo, 'worker'), worker, { recursive: true, filter: (file) => !/[\\/]\.wrangler(?:[\\/]|$)/.test(file) })
  const ownDist = join(scratch, 'own-dist')
  buildWorkerDist({ repo, outDir: ownDist, workerDir: worker })
  assert.deepEqual(checkWorkerDist({ repo, distDir: ownDist, workerDir: worker }), [])
  const source = join(worker, 'short-id.ts')
  const original = readFileSync(source, 'utf8')
  writeFileSync(source, `${original}\n// changed after the build\n`)
  fails(ownDist, /older than the Worker's sources/, 'a source changed after the build', worker)
  // Line endings are not a change (a Windows checkout).
  writeFileSync(source, original.replace(/\r?\n/g, '\r\n'))
  assert.deepEqual(checkWorkerDist({ repo, distDir: ownDist, workerDir: worker }), [], 'the same sources with CRLF line endings are not stale')
  writeFileSync(source, original)
  for (const name of ['wrangler.jsonc', 'package.json', 'tsconfig.json']) {
    assert.ok(workerSourceFiles(worker).includes(name), `${name} counts as a source`)
    const before = readFileSync(join(worker, name), 'utf8')
    writeFileSync(join(worker, name), before.replace(/\n$/, '\n\n'))
    fails(ownDist, /older than the Worker's sources/, `${name} changed after the build`, worker)
    writeFileSync(join(worker, name), before)
  }
  assert.ok(!workerSourceFiles(worker).some((name) => name.endsWith('.test.ts') || name === 'README.md'), 'tests and the README do not')
  // A new source file is a change too.
  writeFileSync(join(worker, 'added.ts'), 'export const added = 1\n')
  fails(ownDist, /older than the Worker's sources/, 'a source file added after the build', worker)
  rmSync(join(worker, 'added.ts'))
  assert.deepEqual(checkWorkerDist({ repo, distDir: ownDist, workerDir: worker }), [])
  console.log('PASS 2: the build stops on a missing or empty folder, a missing or empty bundle, a bundle that does not match its manifest, another wrangler, and sources changed or added since; not on line endings')

  // ── The scripts and the build wiring ───────────────────────────────────────────────────────────
  const checked = node('check-worker-dist.mjs', [join(scratch, 'not-there')])
  assert.equal(checked.status, 1, 'the check script exits 1 on a missing folder')
  assert.match(checked.stderr, /worker-dist is not ready to ship:\n {2}- .*is missing/)
  assert.equal(node('check-worker-dist.mjs', [emptied]).status, 1, 'and on an empty bundle')
  assert.equal(node('check-worker-dist.mjs', [dist]).status, 0, 'and 0 on a good one')
  const broken = join(scratch, 'broken-worker')
  cpSync(worker, broken, { recursive: true })
  writeFileSync(join(broken, 'index.ts'), 'export default { this is not TypeScript')
  assert.throws(() => buildWorkerDist({ repo, outDir: join(scratch, 'never'), workerDir: broken }), /compiling the Worker failed/, 'a Worker that does not compile fails the build step')
  assert.ok(!readdirSync(scratch).includes('never'), 'and leaves no folder')
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
  assert.ok(pkg.scripts.build.startsWith('npm run build:worker-dist && '), 'npm run build compiles worker-dist first')
  assert.ok(pkg.build.extraResources.some((entry) => entry.from === 'worker-dist' && entry.to === 'worker-dist'), 'worker-dist ships in the app\'s resources')
  assert.equal(pkg.build.beforePack, 'scripts/electron-builder-before-pack.cjs', 'electron-builder checks it before it packs')
  assert.match(readFileSync(join(repo, 'scripts', 'electron-builder-before-pack.cjs'), 'utf8'), /check-worker-dist\.mjs/)
  assert.match(readFileSync(join(repo, '.gitignore'), 'utf8'), /^worker-dist\/$/m, 'it is a build product, not committed')
  console.log('PASS 3: the check script exits 1 when the folder is not ready; npm run build compiles it first, electron-builder checks it before packing, and it ships in resources')
  console.log(`worker-dist build step — passed in ${((Date.now() - started) / 1000).toFixed(1)}s`)
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
}

// What wrangler compiles and would upload as the live service is the shipped Worker and nothing else,
// whatever `package.json` and `tsconfig.json` files sit in the folders above it.
//
// wrangler compiles the Worker with esbuild at run time, and esbuild reads `tsconfig.json`,
// `jsconfig.json` and `package.json` in every parent folder of the Worker's files and of the folder
// wrangler runs in. Besides stopping the compile when malformed, such a file can be a route for
// swapping the code that is compiled. The routes found, each reproduced here with the real toolchain
// (a dry-run deploy through the launcher in a throwaway tree, judged by the output bytes) and closed:
//
//   1. A `browser` map in a parent `package.json` redirects one of the Worker's relative imports
//      (wrangler builds for esbuild's browser platform; the map of the nearest package.json that HAS
//      one applies: esbuild 0.28.1 resolver.go:1592 and :1622-1626, package_json.go:378-398).
//      Closed by `worker/package.json` with an explicit empty map, which makes the Worker's folder
//      its own browser scope. `{ "private": true }` alone does not: the map must be there.
//   2. `paths` in a `tsconfig.json` above the folder wrangler RUNS in redirects the Worker's entry
//      file itself (esbuild resolves the entry, an absolute path, from the working folder and asks
//      that folder's nearest tsconfig for a `paths` match first: resolver.go:968-977).
//      Closed by the empty `tsconfig.json` the launcher keeps in the run folder.
//   3. Compiler options in a `tsconfig.json` above the Worker change the compiled bytes, but only
//      if the Worker has no tsconfig of its own (the nearest one wins: resolver.go:1640-1655).
//      `worker/tsconfig.json` ships; this test pins that it must keep shipping.
//
// Looked at and found not to reach this Worker (tested below unless marked "reasoned"):
//   - `sideEffects`, `type`, `main`, `module`, `exports`, `imports` in a parent package.json: bytes
//     unchanged, with and without the Worker's own package.json. (`main`/`module`/`exports` describe
//     a package being imported by name and `imports` serves `#name` imports, resolver.go:2390; the
//     Worker imports only its own files by relative path, asserted below.)
//   - tsconfig `paths` and `baseUrl` above the Worker for its relative imports: they apply to
//     package-style and absolute imports only (resolver.go:968-977 and :2364-2372).
//   - `node_modules` in a parent folder: searched for package-style imports only (resolver.go:2358);
//     the Worker has none.
//   - tsconfig `extends` (reasoned): only followed from a tsconfig that is in use; the two in use
//     are the Worker's own and the run folder's stand-in, and neither has `extends` (asserted).
//
// This closes the routes found for wrangler's own compile, which tests, the unpackaged app (`dev`)
// and the build step (scripts/build-worker-dist.mjs) still use. The class is gone for the live
// service as people set it up: nothing is compiled at run time (ticket 11). The last section runs
// the same planted files against that set-up: the bundle shipped in worker-dist/ is uploaded with
// Cloudflare's API, and not one uploaded byte changes.
//
// Integration tier: about 8 seconds alone but over half a minute beside the unit pool, so it is run
// by name and in the "Packaged builds" workflow on macOS and Windows; not part of `npm test`.
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { liveWorkerDeployConfig } from '../src/main/live-worker-deploy-config.ts'
import { prepareWranglerRun, wranglerRunFolder } from '../src/main/wrangler-launcher.ts'
import { readSource } from './lib/read-source.mjs'
import { createHash } from 'node:crypto'
import { startCloudflareApiStub } from './lib/cloudflare-api-stub.mjs'
import { buildWorkerDist } from './lib/worker-dist.mjs'
import { setUpLiveService, steadyLeave, uploadedOf } from './lib/live-service-setup.mjs'

const started = Date.now()
const repo = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))))
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tw-worker-integrity-')))
// A machine: the installed app under one tree, the person's home (with the app's user data) under another.
const aboveApp = join(scratch, 'Applications')
const worker = join(aboveApp, 'TalkWeaver', 'resources', 'worker')
const home = join(scratch, 'home')
const userData = join(home, 'Library', 'Application Support', 'TalkWeaver')
const install = { execPath: process.execPath, appRoot: repo, platform: process.platform, workDir: join(userData, 'wrangler-runs') }
const config = join(install.workDir, 'live-worker-wrangler.generated.jsonc')
const out = join(scratch, 'out')
const MARK = 'TW_SUBSTITUTED_CODE_7f3a'
const slash = (path) => path.split('\\').join('/')

/** A dry-run deploy of the Worker copy, as the app deploys it. `beforeStart` runs after the run folder is prepared. */
function compile({ beforeStart } = {}) {
  mkdirSync(install.workDir, { recursive: true })
  writeFileSync(config, JSON.stringify(liveWorkerDeployConfig(readFileSync(join(repo, 'worker', 'wrangler.jsonc'), 'utf8'), worker, null)))
  rmSync(out, { recursive: true, force: true })
  const resolved = prepareWranglerRun(install, ['deploy', '--dry-run', '--outdir', out, '--config', config], { inherited: process.env })
  assert.equal(resolved.ok, true)
  beforeStart?.()
  const { command, args, env, cwd } = resolved.launch
  const done = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 120_000, windowsHide: true })
  assert.equal(done.status, 0, `the Worker compiles\n${done.stdout}\n${done.stderr}`)
  return readFileSync(join(out, 'index.js'))
}
/** Put files in place for one compile, then take them away again. */
function withFiles(files, run) {
  const saved = Object.keys(files).map((path) => [path, existsSync(path) ? readFileSync(path) : null])
  for (const [path, text] of Object.entries(files)) {
    if (text === null) rmSync(path, { force: true })
    else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
  }
  try { return run() } finally {
    for (const [path, bytes] of saved) { if (bytes === null) rmSync(path, { force: true }); else writeFileSync(path, bytes) }
  }
}
/** The same, around work that takes time: the files stay in place until it has finished. */
async function withFilesWhile(files, run) {
  const saved = Object.keys(files).map((path) => [path, existsSync(path) ? readFileSync(path) : null])
  for (const [path, text] of Object.entries(files)) {
    if (text === null) rmSync(path, { force: true })
    else { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
  }
  try { return await run() } finally {
    for (const [path, bytes] of saved) { if (bytes === null) rmSync(path, { force: true }); else writeFileSync(path, bytes) }
  }
}
const substituted = (bytes) => bytes.includes(MARK)

try {
  // The Worker as it ships (sources and the files beside them; not its tests).
  cpSync(join(repo, 'worker'), worker, { recursive: true, filter: (file) => !/[\\/]\.wrangler(?:[\\/]|$)|\.test\.ts$/.test(file) })
  const shippedPackage = JSON.parse(readFileSync(join(worker, 'package.json'), 'utf8'))
  assert.deepEqual(shippedPackage.browser, {}, 'worker/package.json carries an explicit empty browser map')
  assert.equal(shippedPackage.private, true)
  for (const field of ['type', 'main', 'module', 'exports', 'imports', 'sideEffects', 'dependencies', 'devDependencies']) {
    assert.ok(!(field in shippedPackage), `worker/package.json sets no "${field}": nothing else about how the Worker is resolved changes`)
  }
  const shippedTsconfig = JSON.parse(readFileSync(join(worker, 'tsconfig.json'), 'utf8'))
  assert.ok(!('extends' in shippedTsconfig) && !shippedTsconfig.compilerOptions?.paths && !shippedTsconfig.compilerOptions?.baseUrl, 'worker/tsconfig.json has no extends, paths or baseUrl')
  // The Worker imports only its own files, by relative path.
  const specifiers = readdirSync(worker).filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts')).flatMap((name) => {
    const text = readSource(join(worker, name)) // LF on every platform
    return [...text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^"';]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']/g)].map((match) => match[1] ?? match[2] ?? match[3])
  })
  assert.ok(specifiers.length > 20 && specifiers.every((specifier) => specifier.startsWith('./')), `every import in the Worker is a relative one: ${[...new Set(specifiers.filter((specifier) => !specifier.startsWith('./')))]}`)

  // The files code would be swapped FOR: copies of the real ones that leave a mark in the output.
  const evil = join(aboveApp, 'evil')
  mkdirSync(evil, { recursive: true })
  writeFileSync(join(evil, 'short-id.ts'), `globalThis.__tw = '${MARK}';\n${readFileSync(join(worker, 'short-id.ts'), 'utf8')}`)
  writeFileSync(join(evil, 'index.ts'), `globalThis.__tw = '${MARK}';\n${readFileSync(join(worker, 'index.ts'), 'utf8').replaceAll("from './", `from '${slash(worker)}/`)}`)
  mkdirSync(join(aboveApp, 'node_modules', 'short-id'), { recursive: true })
  writeFileSync(join(aboveApp, 'node_modules', 'short-id', 'package.json'), '{ "name": "short-id", "main": "index.js" }')
  writeFileSync(join(aboveApp, 'node_modules', 'short-id', 'index.js'), `globalThis.__tw = '${MARK}'`)

  const clean = compile()
  assert.ok(clean.length > 1000 && !substituted(clean))

  // ── 1. A browser map in a parent package.json ─────────────────────────────────────────────────
  const browserMap = JSON.stringify({ browser: { './TalkWeaver/resources/worker/short-id.ts': './evil/short-id.ts', './TalkWeaver/resources/worker/short-id': './evil/short-id.ts' } })
  const hostilePackage = join(aboveApp, 'package.json')
  const ownPackage = join(worker, 'package.json')
  // The new file changes nothing about a clean compile: byte for byte the output without it.
  assert.ok(withFiles({ [ownPackage]: null }, compile).equals(clean), 'the clean output is identical with and without worker/package.json')
  // The finding, reproduced: without the Worker's own package.json the parent's map swaps a module.
  // (The two reproductions are required on macOS and Linux, where they were observed. On Windows,
  // where this was written without a machine to try it on, a reproduction that does not happen is
  // reported and not failed; the "closed" assertions below hold on every platform.)
  const reproduced = (what, bytes) => {
    if (process.platform === 'win32' && !substituted(bytes)) { console.log(`note (Windows): not reproduced here: ${what}`); return }
    assert.equal(substituted(bytes), true, `reproduced: ${what}`)
  }
  reproduced('a browser map in a parent package.json redirects a relative import of the Worker', withFiles({ [ownPackage]: null, [hostilePackage]: browserMap }, compile))
  // `private` alone does not end the parent's scope; the empty map does.
  reproduced('a package.json without a browser map does not stop it', withFiles({ [ownPackage]: '{ "private": true }', [hostilePackage]: browserMap }, compile))
  assert.ok(withFiles({ [hostilePackage]: browserMap }, compile).equals(clean), 'closed: with the shipped worker/package.json the hostile map changes not one byte')

  // ── 2. `paths` in a tsconfig above the folder wrangler runs in ────────────────────────────────
  const entryPaths = JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { [slash(join(worker, 'index.ts'))]: [slash(join(evil, 'index.ts'))], '/*': [slash(join(evil, 'index.ts'))], '*': [slash(join(evil, 'index.ts'))] } } })
  for (const dir of [userData, home]) {
    const hostileTsconfig = join(dir, 'tsconfig.json')
    assert.ok(withFiles({ [hostileTsconfig]: entryPaths }, compile).equals(clean), `closed: a tsconfig.json with paths in ${dir === home ? 'the home folder' : 'user data'} does not swap the entry file`)
  }
  if (process.platform !== 'win32') {
    // What the run folder's own tsconfig.json is for (POSIX shape of the entry path; the stand-in is taken away after preparing).
    const withoutStandIn = withFiles({ [join(home, 'tsconfig.json')]: entryPaths }, () => compile({ beforeStart: () => rmSync(wranglerRunFolder(install).tsconfig) }))
    assert.equal(substituted(withoutStandIn), true, 'reproduced: without the run folder\'s tsconfig.json, paths in a parent tsconfig swap the Worker\'s entry file')
  }
  assert.ok(compile().equals(clean))
  assert.equal(readFileSync(wranglerRunFolder(install).tsconfig, 'utf8'), '{}\n', 'the next run puts the stand-in back')

  // ── 3. Compiler options in a tsconfig above the Worker ────────────────────────────────────────
  const hostileOptions = JSON.stringify({ compilerOptions: {
    target: 'es5', useDefineForClassFields: false, experimentalDecorators: true, verbatimModuleSyntax: true, preserveValueImports: true,
    importsNotUsedAsValues: 'preserve', alwaysStrict: true, jsx: 'preserve', baseUrl: '.', paths: { './short-id': ['./evil/short-id.ts'], '*': ['./evil/*'] },
  } })
  const tsconfigAboveApp = join(aboveApp, 'tsconfig.json')
  assert.ok(withFiles({ [tsconfigAboveApp]: hostileOptions }, compile).equals(clean), 'a tsconfig.json above the Worker changes nothing: the Worker\'s own is the nearest')
  const withoutOwnTsconfig = withFiles({ [tsconfigAboveApp]: hostileOptions, [join(worker, 'tsconfig.json')]: null }, compile)
  assert.ok(!withoutOwnTsconfig.equals(clean), 'pinned: without worker/tsconfig.json those options WOULD change the compiled bytes, so it must keep shipping')
  assert.equal(substituted(withoutOwnTsconfig), false, '(its paths still do not reach the Worker\'s relative imports)')

  // ── Other fields and folders: no effect, with and without the Worker's own package.json ──────
  const otherFields = {
    'sideEffects: false': { sideEffects: false },
    'type, main, module, exports, imports': { type: 'commonjs', main: './evil/index.ts', module: './evil/index.ts', exports: { '.': './evil/index.ts', './*': './evil/*' }, imports: { '#*': './evil/*' } },
  }
  for (const [name, fields] of Object.entries(otherFields)) {
    assert.ok(withFiles({ [hostilePackage]: JSON.stringify(fields) }, compile).equals(clean), `${name} in a parent package.json: no effect`)
    assert.ok(withFiles({ [hostilePackage]: JSON.stringify(fields), [ownPackage]: null }, compile).equals(clean), `${name}: no effect even without worker/package.json`)
  }
  // A browser map above the RUN folder naming the entry file: the entry's own folder decides its scope.
  assert.ok(withFiles({ [join(userData, 'package.json')]: JSON.stringify({ browser: { [slash(join(worker, 'index.ts'))]: slash(join(evil, 'index.ts')) } }) }, compile).equals(clean), 'a browser map above the run folder: no effect')
  // (`node_modules/short-id` has sat above the Worker for every compile here, the clean one included.)

  // ── 4. The live service as the app sets it up: the planted files against the upload ───────────
  // The bundle compiled when the app is built, shipped beside the Worker's sources in the app tree
  // (under every planted file above), uploaded to the fake API with the app's own set-up.
  {
    const distDir = join(aboveApp, 'TalkWeaver', 'resources', 'worker-dist')
    const manifest = buildWorkerDist({ repo, outDir: join(scratch, 'built-worker-dist') })
    cpSync(join(scratch, 'built-worker-dist'), distDir, { recursive: true })
    const shippedBytes = readFileSync(join(distDir, 'index.js'))
    const stub = await startCloudflareApiStub()
    const here = process.cwd()
    const keys = { stored: null } // one computer: the keys made on the first set-up are reused after it
    try {
      mkdirSync(install.workDir, { recursive: true })
      process.chdir(install.workDir) // as the app runs: below the user-data folder, under the planted files
      const upload = (files) => withFilesWhile(files, async () => {
        const before = stub.requests.length
        // Each one a first set-up: code is uploaded only where there is no Worker, or an older one (decision R3).
        stub.model.workers.clear()
        const { result } = await setUpLiveService({ distDir, expectedBuild: manifest.build, authorise: async () => ({ ok: true, authorisation: steadyLeave('integrity-test-token-0123456789', 'integrity0account') }), apiBase: stub.baseUrl, keys })
        assert.equal(result.ok, true, JSON.stringify({ ...result, adminSecret: undefined }))
        const request = stub.requests.slice(before).find((entry) => entry.method === 'PUT' && entry.path === '/accounts/integrity0account/workers/scripts/talkweaver-live-sessions')
        return uploadedOf(request).module.bytes
      })
      const PLANTED = {
        'nothing planted': {},
        'a browser map in a parent package.json': { [hostilePackage]: browserMap },
        'paths in a tsconfig.json in user data': { [join(userData, 'tsconfig.json')]: entryPaths },
        'paths in a tsconfig.json in the home folder': { [join(home, 'tsconfig.json')]: entryPaths },
        'compiler options in a tsconfig.json above the app': { [tsconfigAboveApp]: hostileOptions },
        'all of them at once, and the Worker\'s own package.json and tsconfig.json gone': { [hostilePackage]: browserMap, [join(userData, 'tsconfig.json')]: entryPaths, [tsconfigAboveApp]: hostileOptions, [ownPackage]: null, [join(worker, 'tsconfig.json')]: null },
        'malformed ones': { [hostilePackage]: '{ "browser": ', [tsconfigAboveApp]: '{ this is not JSON', [join(aboveApp, 'jsconfig.json')]: '{ "compilerOptions": ', [join(userData, 'package.json')]: '{ "type": ' },
      }
      for (const [what, files] of Object.entries(PLANTED)) {
        const bytes = await upload(files)
        assert.ok(bytes.equals(shippedBytes), `${what}: the uploaded bytes are the shipped bundle`)
        assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.files['index.js'].sha256, `${what}: by the manifest's hash`)
        assert.equal(substituted(bytes), false)
      }
      console.log(`  the live service as the app sets it up: ${Object.keys(PLANTED).length} sets of planted files, not one uploaded byte changed`)
    } finally {
      process.chdir(here)
      await stub.close()
    }
  }

  console.log(`worker compile integrity: a browser map in a parent package.json (closed by worker/package.json) and tsconfig paths above the run folder (closed by the run folder's tsconfig.json) no longer change the compiled Worker; parent tsconfig options, sideEffects, type, main, module, exports, imports and node_modules do not reach it; the app's own set-up uploads the shipped bundle unchanged whatever is planted — passed in ${((Date.now() - started) / 1000).toFixed(1)}s`)
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
}

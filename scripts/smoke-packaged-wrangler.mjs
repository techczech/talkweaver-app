// Packaged-build smoke for the bundled wrangler (spec docs/plans/cloudflare-setup-in-app, D2 and D13).
//
//   node scripts/smoke-packaged-wrangler.mjs [path to TalkWeaver.app | path to win-unpacked]
//
// Takes a build made by electron-builder (default: the unpacked one under release/) and, through the
// app's launcher exactly as the main process uses it (the packaged executable as `execPath`, its
// resources/app folder as the app root; the launcher gives wrangler no PATH to any program and a home
// folder of its own):
//   1. runs `wrangler --version` (the tool starts on the app's own Node);
//   2. runs `wrangler deploy --dry-run --outdir <temp>` on the Worker that ships in the build's
//      resources, with the config the app's `wrangler dev` is given (the shipped wrangler.jsonc
//      rewritten into a folder outside the build, src/main/live-worker-deploy-config.ts): wrangler
//      compiles the Worker with the bundled esbuild binary, as `dev` does (tests and the unpackaged
//      app; the live service is set up from worker-dist, step 7); the bundle must exist and be non-empty;
//   3. finds workerd the way miniflare does (`require('workerd')` from miniflare's folder) and runs
//      it: the binary must be inside the build and report a version;
//   4. serves the shipped Worker: packaged `wrangler dev` on a free loopback port with throwaway
//      secrets (as the test harness starts it), `GET /capabilities` must answer 200 with the build
//      string of the shipped Worker; then it is stopped by PID;
//   5. checks, after step 3 and again after step 4, that none of this wrote into the build (a signed
//      app must stay as it was sealed);
//   6. publishes a handout site: packaged `wrangler pages deploy` against the fake Cloudflare API
//      (scripts/lib/cloudflare-api-stub.mjs, on this computer's loopback address), to its end: the
//      site looked up, the page uploaded, the deployment made;
//   7. the live service as the app sets it up, without wrangler (ticket 11): the build's
//      resources/worker-dist is checked against its manifest (the bundle's SHA-256 and size, the
//      Worker build the shipped sources name, and that it was compiled from exactly those sources);
//      then the set-up sequence runs ON THE PACKAGED EXECUTABLE as Node, uploads that bundle to the
//      fake API (bytes equal to the manifest's hash, every migration, workers.dev on, this computer's key alone),
//      runs once more as an update (no migration, no secret re-sent, no domain touched), and starts no process;
//   8. checks once more that the build is unchanged;
//   9. searches the main-process code inside the build for the Bitwarden and Keychain-command route
//      to a Cloudflare token (spec D1): it is not there.
//  10. loads `sharp` (handout slimming, spec D11) on the packaged executable and has it scale a
//      picture and write WebP: the native module and its binaries are in the build and are loaded
//      from there, on macOS and on Windows.
//  11. the ffmpeg that ships with the app (ticket 08, spec D16): with no path set, the resolver the
//      main process uses picks resources/ffmpeg/ffmpeg (ffmpeg.exe on Windows) inside the build; it
//      runs and makes the WAV transcription makes; it is not a nonfree build (on macOS: the pinned
//      GPL build, as scripts/verify-mac-package.mjs decides from the package: the afterPack attestation,
//      and the pinned SHA-256 (unsigned) or a verifying seal plus the pinned content hash (signed),
//      with COPYING.GPLv3 and FFMPEG-NOTICE.md beside it; on Windows: ffmpeg-static's
//      licence files); and the transcription set-up folder (SETUP.md, the script, requirements.txt)
//      is in the resources.
// Every command runs in a throwaway folder of its own, as the app runs them in its wrangler-runs folder.
//
// It never opens a window (the executable runs as Node), never reads the real user-data folder and
// never contacts Cloudflare: steps 1 to 4 set no token, a dry run uploads nothing and `dev` here is
// local only; steps 6 and 7 are given a made-up token and the fake API's address, both on the
// launcher's explicit `set` side (the same side the main process hands the real ones over on).
// Step 7 is given them in the set-up's own environment, as a test only.
//
// NOT covered: the packaged MAIN PROCESS calling the launcher (this script calls it), and Cloudflare
// itself (the fake API answers what wrangler 4.144 asks; a real publish is on the release checklist).
import { strict as assert } from 'node:assert'
import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { startCloudflareApiStub, WORKERS_SUBDOMAIN } from './lib/cloudflare-api-stub.mjs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { liveWorkerDeployConfig } from '../src/main/live-worker-deploy-config.ts'
import { createHash } from 'node:crypto'
import { verifyShippedBundle } from '../src/main/live-service-upload.ts'
import { workerBuildString, workerSourceDigest } from './lib/worker-dist.mjs'
import { shippedFrom, uploadedOf } from './lib/live-service-setup.mjs'
import { prepareWranglerRun, windowsSystemRoot, wranglerRunFolder } from '../src/main/wrangler-launcher.ts'
import { ffmpegExecutableName, resolveFfmpeg, shippedFfmpegCandidates } from '../src/main/ffmpeg-path.ts'
import { macAppProblem } from './verify-mac-package.mjs'
import { transcodeArgs } from '../src/main/transcode-args.ts'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const productName = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).build.productName

function defaultBuild() {
  const release = join(repo, 'release')
  const candidates = process.platform === 'darwin'
    ? ['mac-arm64', 'mac', 'mac-universal'].map((dir) => join(release, dir, `${productName}.app`))
    : process.platform === 'win32'
      ? ['win-unpacked', 'win-arm64-unpacked'].map((dir) => join(release, dir))
      : ['linux-unpacked', 'linux-arm64-unpacked'].map((dir) => join(release, dir))
  return candidates.find((path) => existsSync(path))
}

/** Where electron-builder puts the executable, the app folder and the extra resources, per platform. */
function layout(build) {
  if (build.endsWith('.app')) {
    const resources = join(build, 'Contents', 'Resources')
    return { execPath: join(build, 'Contents', 'MacOS', productName), resources, appRoot: join(resources, 'app') }
  }
  const exe = process.platform === 'win32' ? `${productName}.exe` : readdirSync(build).find((name) => name.toLowerCase() === productName.toLowerCase()) ?? productName
  return { execPath: join(build, exe), resources: join(build, 'resources'), appRoot: join(build, 'resources', 'app') }
}

/** Every file under `dir` with its size and modification time: enough to see a write. */
function listing(dir) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .map((entry) => { const path = join(entry.parentPath, entry.name); const stat = statSync(path); return `${path} ${entry.isDirectory() ? 'dir' : `${stat.size} ${stat.mtimeMs}`}` })
    .sort()
}

const build = process.argv[2] ? resolve(process.argv[2]) : defaultBuild()
assert.ok(build && existsSync(build), `no packaged build found${build ? ` at ${build}` : ' under release/'}; package first (electron-builder --dir) or pass its path`)
const { execPath, resources, appRoot } = layout(build)
assert.ok(existsSync(execPath), `the packaged executable is missing: ${execPath}`)
assert.ok(existsSync(join(appRoot, 'package.json')), `the packaged app folder is missing: ${appRoot} (is asar on? the launcher expects plain files)`)
const workerDir = join(resources, 'worker')
const workerConfig = join(workerDir, 'wrangler.jsonc')
assert.ok(existsSync(workerConfig), `the Worker that ships with the app is missing: ${workerConfig}`)

const scratch = mkdtempSync(join(tmpdir(), 'tw-packaged-wrangler-'))
const workDir = join(scratch, 'wrangler-runs')
const install = { execPath, appRoot, platform: process.platform, workDir }
// What the app would inherit: this process's own environment, as it is (a Node and perhaps a
// wrangler and a git on its PATH, the real home folder). Confining wrangler is the launcher's job:
// it gives the child no PATH to any of them and a home, settings and cache folder inside the run
// folder, which here is in the throwaway folder. Only the temp folder is pointed there as well.
const inherited = { ...process.env, TEMP: scratch, TMP: scratch, TMPDIR: scratch }
const set = { WRANGLER_LOG_PATH: join(scratch, 'logs') }
function launchFor(args, credentials = null) {
  const resolved = prepareWranglerRun(install, args, { inherited, set: { ...set, ...credentials } })
  assert.equal(resolved.ok, true, resolved.ok ? '' : `${resolved.error}. ${resolved.details}`)
  const { command, args: argv, env, cwd } = resolved.launch
  assert.ok(command.startsWith(build), 'the command is the packaged executable')
  assert.ok(argv.some((arg) => arg.startsWith(appRoot) && arg.endsWith('cli.js')), 'wrangler is the copy inside the packaged app')
  if (credentials) {
    assert.equal(env.CLOUDFLARE_API_TOKEN, credentials.CLOUDFLARE_API_TOKEN, 'the token is the one set for this call')
    assert.match(env.CLOUDFLARE_API_BASE_URL, /^http:\/\/127\.0\.0\.1:\d+\/client\/v4$/, 'and the API it is sent to is the fake one on loopback')
  } else {
    assert.ok(!('CLOUDFLARE_API_TOKEN' in env), 'no token is set: nothing here can reach a Cloudflare account')
    assert.ok(!('CLOUDFLARE_API_BASE_URL' in env), 'and no API address')
  }
  assert.equal(cwd, workDir, 'it runs in the folder kept for wrangler runs')
  assert.ok(env.HOME.startsWith(workDir), 'with a home of its own inside it')
  // What is true of PATH differs by platform (System32 is on every Windows machine's PATH too):
  // macOS and Linux, exactly the run folder's empty folder; Windows, exactly the checked System32,
  // with its cmd.exe as the shell.
  if (process.platform === 'win32') {
    const root = windowsSystemRoot(process.env)
    assert.equal(env.PATH, join(root, 'System32'), 'PATH is exactly the checked System32')
    assert.equal(env.ComSpec, join(root, 'System32', 'cmd.exe'), 'and the shell is its cmd.exe')
  } else {
    assert.equal(env.PATH, wranglerRunFolder(install).emptyPath, 'PATH is exactly the run folder\'s empty folder')
    assert.deepEqual(readdirSync(env.PATH), [], 'which is empty')
  }
  return resolved.launch
}
function wrangler(args) {
  const launch = launchFor(args)
  const { command, args: argv, env, cwd } = launch
  const run = spawnSync(command, argv, { cwd, env, encoding: 'utf8', timeout: 180_000, windowsHide: true })
  assert.equal(run.error, undefined, `could not start ${command}: ${run.error?.message}`)
  assert.equal(run.status, 0, `wrangler ${args.join(' ')} exited ${run.status} (signal ${run.signal})\nstdout: ${run.stdout}\nstderr: ${run.stderr}`)
  return { run, launch }
}
/** A command that talks to the fake API, which lives in this process: so not spawnSync. */
function wranglerAgainstFakeApi(args, credentials, input = '') {
  const { command, args: argv, env, cwd } = launchFor(args, credentials)
  return new Promise((resolveRun) => {
    const child = spawn(command, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let said = ''
    child.stdout.on('data', (chunk) => { said += String(chunk) })
    child.stderr.on('data', (chunk) => { said += String(chunk) })
    const timer = setTimeout(() => { void stopByPid(child) }, 180_000)
    child.on('close', (status) => {
      clearTimeout(timer)
      // Looked for in what wrangler really printed; only then struck out, so a failure below can quote the output.
      resolveRun({ status, printedToken: said.includes(credentials.CLOUDFLARE_API_TOKEN), said: said.split(credentials.CLOUDFLARE_API_TOKEN).join('[token]') })
    })
    child.stdin.end(input)
  })
}
function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolvePort(port)) })
  })
}
/** Stop exactly the process this script started (and, on Windows, the workerd it started), by PID. */
async function stopByPid(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit))
  if (process.platform === 'win32') {
    spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else {
    process.kill(child.pid, 'SIGTERM')
    setTimeout(() => { if (child.exitCode === null && child.signalCode === null) process.kill(child.pid, 'SIGKILL') }, 5000).unref()
  }
  await exited
}

try {
  const sealed = listing(build)
  console.log(`packaged wrangler: ${execPath}`)

  // 1. The tool starts.
  const version = wrangler(['--version'])
  const shipped = JSON.parse(readFileSync(join(appRoot, 'node_modules', 'wrangler', 'package.json'), 'utf8')).version
  const pinned = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).dependencies.wrangler
  assert.equal(version.run.stdout.trim(), shipped, 'it printed the version of the wrangler shipped in the build')
  assert.equal(shipped, pinned, 'which is the version package.json pins')
  console.log(`  1. --version with PATH=${JSON.stringify(version.launch.env.PATH)} → ${shipped}`)

  // 2. The shipped Worker compiles with the bundled esbuild (a dry run: no network, no token).
  // As startLocalLiveWorker does: the config wrangler is given sits outside the build, so wrangler's
  // scratch folder does too; its `main` points back at the shipped Worker.
  mkdirSync(workDir, { recursive: true })
  const deployConfig = join(workDir, 'live-worker-wrangler.generated.jsonc')
  writeFileSync(deployConfig, JSON.stringify(liveWorkerDeployConfig(readFileSync(workerConfig, 'utf8'), workerDir, null), null, 2))
  const outdir = join(scratch, 'dry-run-out')
  wrangler(['deploy', '--dry-run', '--outdir', outdir, '--config', deployConfig])
  const bundles = existsSync(outdir) ? readdirSync(outdir).filter((name) => /\.m?js$/.test(name)) : []
  assert.ok(bundles.length > 0, `deploy --dry-run wrote no bundle into ${outdir}`)
  const bundleBytes = statSync(join(outdir, bundles[0])).size
  assert.ok(bundleBytes > 1000, `the compiled Worker ${bundles[0]} is ${bundleBytes} bytes`)
  assert.match(readFileSync(join(outdir, bundles[0]), 'utf8'), /export\s*\{[\s\S]*\bdefault\b/, 'the bundle is the Worker module (it has a default export)')
  console.log(`  2. deploy --dry-run compiled ${join(workerDir, 'index.ts')} → ${bundles[0]} (${bundleBytes} bytes)`)

  // 3. workerd, found the way miniflare finds it: require('workerd') from miniflare's own folder.
  const probe = `const { createRequire } = require('node:module'); process.stdout.write(createRequire(${JSON.stringify(join(appRoot, 'node_modules', 'miniflare', 'package.json'))})('workerd').default)`
  const found = spawnSync(version.launch.command, ['-e', probe], { cwd: scratch, env: version.launch.env, encoding: 'utf8', timeout: 60_000, windowsHide: true })
  assert.equal(found.status, 0, `could not resolve workerd from the packaged miniflare\nstdout: ${found.stdout}\nstderr: ${found.stderr}`)
  const workerd = found.stdout.trim()
  assert.ok(workerd.startsWith(appRoot) && existsSync(workerd), `workerd resolves to a file inside the build: ${workerd}`)
  const ran = spawnSync(workerd, ['--version'], { cwd: scratch, env: version.launch.env, encoding: 'utf8', timeout: 60_000, windowsHide: true })
  assert.equal(ran.error, undefined, `could not start ${workerd}: ${ran.error?.message}`)
  assert.equal(ran.status, 0, `workerd --version exited ${ran.status} (signal ${ran.signal})\nstdout: ${ran.stdout}\nstderr: ${ran.stderr}`)
  assert.match(ran.stdout, /workerd \d{4}-\d{2}-\d{2}/, 'workerd reports its version')
  console.log(`  3. ${workerd} --version → ${ran.stdout.trim()}`)

  assert.deepEqual(listing(build), sealed, 'running wrangler changed files inside the packaged build')

  // 4. workerd serves the shipped Worker: packaged `wrangler dev`, local only, throwaway secrets.
  const port = await freePort()
  const dev = launchFor([
    'dev', '--config', deployConfig, '--ip', '127.0.0.1', '--port', String(port),
    '--var', `ADMIN_SECRET:${randomBytes(24).toString('hex')}`, '--var', `SESSION_SIGNING_SECRET:${randomBytes(24).toString('hex')}`,
    '--var', 'PREWORK_LOCAL_SOURCE:1',
    '--persist-to', join(scratch, 'dev-state'), '--show-interactive-dev-session=false', '--log-level=error',
  ])
  const child = spawn(dev.command, dev.args, { cwd: dev.cwd, env: dev.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let devOutput = ''
  child.stdout.on('data', (chunk) => { devOutput += String(chunk) })
  child.stderr.on('data', (chunk) => { devOutput += String(chunk) })
  try {
    const expectedBuild = /LIVE_WORKER_BUILD\s*=\s*'([^']+)'/.exec(readFileSync(join(workerDir, 'recovery-protocol.ts'), 'utf8'))?.[1]
    assert.ok(expectedBuild, 'the shipped Worker names its build')
    let response = null
    const deadline = Date.now() + 60_000
    while (!response && Date.now() < deadline) {
      assert.equal(child.exitCode, null, `wrangler dev stopped (${child.exitCode})\n${devOutput.slice(-4000)}`)
      try { response = await fetch(`http://127.0.0.1:${port}/capabilities`) } catch { await new Promise((wait) => setTimeout(wait, 200)) }
    }
    assert.ok(response, `wrangler dev did not answer on 127.0.0.1:${port}\n${devOutput.slice(-4000)}`)
    assert.equal(response.status, 200, `GET /capabilities answered ${response.status}`)
    const capabilities = await response.json()
    assert.equal(capabilities.build, expectedBuild, 'the Worker being served is the one shipped in the build')
    console.log(`  4. wrangler dev (pid ${child.pid}) served GET /capabilities on 127.0.0.1:${port} → 200 ${JSON.stringify(capabilities)}`)
  } finally {
    await stopByPid(child)
  }
  await assert.rejects(fetch(`http://127.0.0.1:${port}/capabilities`), 'the Worker is stopped')

  // 5. Nothing was written into the build.
  assert.deepEqual(listing(build), sealed, 'running wrangler dev changed files inside the packaged build')
  console.log('  5. the build is unchanged after the compile and after serving')

  // 6 and 7. The two commands that talk to Cloudflare, against the fake API on loopback. The token
  // is made up (and built so that this file does not hold it whole).
  const token = ['smoke', 'test', 'token', 'packaged', '0123456789abcdef'].join('-')
  const account = 'smoke0account'
  const api = await startCloudflareApiStub({ sites: ['talkweaver-handouts'], accounts: [{ id: account, name: 'Smoke' }], tokens: { [token]: { accounts: [account] } } })
  try {
    const credentials = { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_BASE_URL: api.baseUrl }

    // 6. pages deploy, as talk:publish-handout runs it.
    const siteDir = join(scratch, 'cloudflare-pages-site')
    mkdirSync(siteDir, { recursive: true })
    writeFileSync(join(siteDir, 'index.html'), '<!doctype html><title>Packaged smoke</title>')
    const pages = await wranglerAgainstFakeApi(['pages', 'deploy', siteDir, '--project-name', 'talkweaver-handouts', '--branch', 'main', '--commit-dirty=true'], credentials)
    assert.equal(pages.printedToken, false, 'pages deploy printed the token')
    assert.equal(pages.status, 0, `packaged pages deploy against the fake API exited ${pages.status}\n${pages.said}`)
    let reached = api.reached()
    assert.ok(reached.includes(`GET /accounts/${account}/pages/projects/talkweaver-handouts`), 'the site was looked up in the account set for the call')
    assert.ok(reached.includes('POST /pages/assets/upload'), 'the page was uploaded')
    assert.ok(reached.includes(`POST /accounts/${account}/pages/projects/talkweaver-handouts/deployments`), 'and the deployment made')
    const uploaded = api.requests.find((request) => request.path === '/pages/assets/upload').body.toString()
    assert.ok(uploaded.includes(Buffer.from('<!doctype html><title>Packaged smoke</title>').toString('base64')), 'the uploaded file is the one in the site folder')
    console.log(`  6. pages deploy published ${siteDir} to the fake API (${reached.length} requests)`)

    // 7. The live service as deployLiveWorker sets it up: the shipped bundle, checked, uploaded with the API.
    const distDir = join(resources, 'worker-dist')
    const shippedFiles = shippedFrom(distDir)
    const build = workerBuildString(workerDir)
    const verified = verifyShippedBundle(shippedFiles.manifest, { bundle: shippedFiles.bundle, config: shippedFiles.config }, build)
    assert.equal(verified.ok, true, `the build's worker-dist matches its manifest: ${verified.ok ? '' : `${verified.error} ${verified.details}`}`)
    assert.equal(verified.manifest.sources, workerSourceDigest(workerDir), 'and was compiled from exactly the Worker sources shipped beside it')
    const before = api.requests.length
    const driver = join(repo, 'scripts', 'lib', 'live-service-setup-driver.mjs')
    const setUp = await new Promise((resolveRun) => {
      // The packaged executable as Node, with an environment of its own: nothing else on the machine is asked for.
      const env = { ELECTRON_RUN_AS_NODE: '1', TW_TEST_LIVE_SETUP: JSON.stringify({ distDir, expectedBuild: build, apiBase: api.baseUrl, token, accountId: account, runs: 2 }) }
      for (const name of ['SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'TMPDIR']) if (process.env[name] !== undefined) env[name] = process.env[name]
      const child = spawn(execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', driver], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += String(chunk) })
      child.stderr.on('data', (chunk) => { stderr += String(chunk) })
      const timer = setTimeout(() => { void stopByPid(child) }, 120_000)
      child.on('close', (status) => { clearTimeout(timer); resolveRun({ status, stdout, stderr }) })
    })
    assert.ok(!`${setUp.stdout}${setUp.stderr}`.includes(token), 'the set-up printed no token')
    assert.equal(setUp.status, 0, `the set-up on the packaged executable exited ${setUp.status}\n${setUp.stdout}\n${setUp.stderr}`)
    const results = JSON.parse(setUp.stdout.trim().split('\n').pop())
    const address = `https://talkweaver-live-sessions.${WORKERS_SUBDOMAIN}.workers.dev`
    assert.deepEqual(results.map((result) => [result.ok, result.baseUrl]), [[true, address], [true, address]], `set up, then updated: ${JSON.stringify(results)}`)
    const uploads = api.requests.slice(before).filter((request) => request.method === 'PUT' && request.path === `/accounts/${account}/workers/scripts/talkweaver-live-sessions`)
    assert.equal(uploads.length, 2)
    for (const upload of uploads) {
      assert.equal(upload.authorization, `Bearer ${token}`, 'with the token of the leave')
      assert.equal(createHash('sha256').update(uploadedOf(upload).module.bytes).digest('hex'), verified.manifest.files['index.js'].sha256, 'the uploaded bytes are the shipped bundle by its manifest hash')
    }
    assert.deepEqual([uploadedOf(uploads[0]).metadata.migrations?.steps.length, 'migrations' in uploadedOf(uploads[1]).metadata], [4, false], 'every migration first; none on the update')
    const deployedWorker = api.model.workers.get(account).get('talkweaver-live-sessions')
    // The model decided after the review of ticket 02 (spec, R1, R2, R8): set-up's one secrets request
    // names this computer's key and nothing else; the app sends no signing secret and no `ADMIN_SECRET`;
    // the update is the script and its workers.dev switch, re-sends no secret, and neither run asks
    // about, attaches or removes a custom domain or a route.
    const ownSecret = 'ADMIN_SECRET_aaaa0000bbbb1111' // the computer id the test driver's key port makes (scripts/lib/live-service-setup.mjs)
    assert.deepEqual([deployedWorker.migrationTag, deployedWorker.workersDev, deployedWorker.secrets], ['v4', true, [ownSecret]], 'the one secret at Cloudflare is this computer\'s key')
    const patches = api.requests.slice(before).filter((request) => request.method === 'PATCH')
    assert.deepEqual(patches.map((request) => [request.path, Object.keys(JSON.parse(request.body.toString()).secrets)]), [[`/accounts/${account}/workers/scripts/talkweaver-live-sessions/secrets-bulk`, [ownSecret]]], 'one secrets request in the two runs: the first set-up\'s, naming this computer\'s key alone; the update re-sent nothing')
    assert.ok(api.requests.indexOf(patches[0]) < api.requests.indexOf(uploads[1]), 'and it belongs to the first set-up, before the update\'s upload')
    assert.deepEqual(api.namingSigningSecret(), [], 'no request names a signing secret')
    assert.deepEqual(api.requests.slice(before).filter((request) => request.method === 'DELETE' || /\/domains|\/routes|\/zones|\/secrets(?:$|\?)/.test(request.path)).map((request) => `${request.method} ${request.path}`), [], 'no DELETE, no custom domain or route, and the Worker\'s secrets are never listed')
    assert.deepEqual(api.requests.slice(before).filter((request) => request.method !== 'GET').map((request) => `${request.method} ${request.path.replace(`/accounts/${account}/workers/scripts/talkweaver-live-sessions`, '<script>')}`), ['PUT <script>', 'POST <script>/subdomain', 'PATCH <script>/secrets-bulk', 'PUT <script>', 'POST <script>/subdomain'], 'every write of the two runs: the script, its workers.dev switch and one key; then the script and its switch')
    reached = api.reached()
    assert.ok(api.requests.every((request) => !request.authorization || request.authorization === `Bearer ${token}` || /^Bearer ey/.test(request.authorization)), 'only the call\'s own token (or the upload token the API issued) was sent')
    assert.deepEqual(api.unknown, [], 'nothing was asked that the fake API does not model')
    console.log(`  7. the live service, set up and updated on the packaged executable without wrangler: ${distDir} matches its manifest (sha256 ${verified.manifest.files['index.js'].sha256.slice(0, 12)}…), uploaded twice to the fake API, reported ${address} (${reached.length - before} requests)`)
  } finally {
    await api.close()
  }

  // 8. Still nothing written into the build.
  assert.deepEqual(listing(build), sealed, 'publishing or deploying against the fake API changed files inside the packaged build')
  console.log('  8. the build is unchanged after publishing and deploying')

  // 9. The one token has one source. What shipped holds no Bitwarden or Keychain-command route to it
  // and reads no Cloudflare credential from the environment.
  const mainDir = join(appRoot, 'out', 'main')
  const mainFiles = readdirSync(mainDir, { recursive: true }).map(String).filter((name) => /\.(?:c?js|mjs)$/.test(name))
  assert.ok(mainFiles.includes('index.js'), `the packaged main process is missing from ${mainDir}`)
  const gone = ['BWS_ACCESS_TOKEN', 'find-generic-password', 'CLOUDFLARE-WORKER-', 'process.env.CLOUDFLARE_API_TOKEN', 'process.env.CLOUDFLARE_ACCOUNT_ID', 'process.env.CF_API_TOKEN']
  const mainCode = mainFiles.map((name) => readFileSync(join(mainDir, name), 'utf8')).join('\n')
  assert.ok(mainCode.includes('cloudflare:save-token'), 'the searched code is the main process with the Cloudflare screen in it')
  assert.deepEqual(gone.filter((text) => mainCode.includes(text)), [], 'the packaged main process holds no Bitwarden, Keychain-command or environment source for a Cloudflare token')
  console.log(`  9. ${mainFiles.length} main-process files in the build hold no Bitwarden, Keychain-command or environment source for the token — passed`)

  // 10. Handout slimming (spec D11): `sharp`, a native module, is in the build and loads on the
  // packaged executable itself, where the main process loads it. The build is not packed into an
  // archive (`asar: false`), so there is nothing to unpack; were that changed, sharp and its
  // `@img` binaries would have to be listed under `asarUnpack`, and this step says so.
  assert.equal(existsSync(join(resources, 'app.asar')), false, 'the app is packed into app.asar: sharp and node_modules/@img must then be listed under asarUnpack (a native module cannot load from inside the archive)')
  const sharpDir = join(appRoot, 'node_modules', 'sharp')
  assert.ok(existsSync(join(sharpDir, 'package.json')), `sharp is missing from the build (${sharpDir})`)
  assert.ok(/import\(["']sharp["']\)|require\(["']sharp["']\)/.test(mainCode), 'the packaged main process loads sharp by name (it is not bundled into the main file, where its native binary could not follow)')
  const sharpProbe = join(scratch, 'sharp-probe.cjs')
  writeFileSync(sharpProbe, `
    const sharp = require(${JSON.stringify(sharpDir)})
    const { IMAGE } = { IMAGE: { create: { width: 640, height: 400, channels: 3, background: '#002147' } } }
    sharp(IMAGE).png().toBuffer()
      .then((png) => sharp(png).resize({ width: 320, kernel: 'linear' }).webp({ nearLossless: true, quality: 60 }).toBuffer().then((webp) => sharp(webp).metadata().then((meta) => ({ png: png.length, webp: webp.length, format: meta.format, width: meta.width }))))
      .then((result) => { console.log(JSON.stringify({ ...result, versions: sharp.versions, loaded: Object.keys(require.cache).filter((path) => path.endsWith('.node')) })) })
      .catch((error) => { console.error(String(error && error.stack || error)); process.exit(1) })
  `)
  const sharpEnv = { ELECTRON_RUN_AS_NODE: '1' }
  for (const name of ['SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE']) if (process.env[name] !== undefined) sharpEnv[name] = process.env[name]
  const slim = spawnSync(execPath, [sharpProbe], { cwd: scratch, env: sharpEnv, encoding: 'utf8', timeout: 60_000, windowsHide: true })
  assert.equal(slim.status, 0, `sharp did not load or run on the packaged executable (exit ${slim.status})\n${slim.stdout}\n${slim.stderr}`)
  const slimmed = JSON.parse(slim.stdout.trim().split('\n').pop())
  assert.deepEqual([slimmed.format, slimmed.width], ['webp', 320], 'the packaged sharp read a PNG, scaled it and wrote WebP')
  assert.ok(slimmed.loaded.length > 0 && slimmed.loaded.every((path) => resolve(path).startsWith(resolve(build))), `sharp's native binary was loaded from inside the build: ${slimmed.loaded.join(', ')}`)
  assert.deepEqual(listing(build), sealed, 'running sharp changed files inside the packaged build')
  console.log(`  10. sharp ${slimmed.versions.sharp} (libvips ${slimmed.versions.vips}, libwebp ${slimmed.versions.webp}) loads on the packaged executable from inside the build and writes WebP; nothing is packed into an archive, so nothing needs unpacking — passed`)

  // 11. Transcription's ffmpeg ships inside the build and is the one used when no path is set.
  const ffmpegName = ffmpegExecutableName(process.platform)
  const ffmpegShipped = resolveFfmpeg({
    configured: '',
    shipped: shippedFfmpegCandidates({ platform: process.platform, resourcesPath: resources, appPath: appRoot, packaged: true }),
    system: [],
    exists: existsSync,
  })
  assert.ok(ffmpegShipped.found, `the build has no ffmpeg of its own (expected ${join(resources, 'ffmpeg', ffmpegName)})`)
  assert.equal(ffmpegShipped.path, join(resources, 'ffmpeg', ffmpegName), 'with no path set, the resolver picks the ffmpeg in the build\'s resources')
  if (process.platform === 'darwin') {
    // macOS ships the pinned plain-GPL build (ADR-0003, amendment of 2026-10-09), its GPL text and notice.
    assert.deepEqual(readdirSync(join(resources, 'ffmpeg')).sort(), ['COPYING.GPLv3', 'FFMPEG-NOTICE.md', 'ffmpeg', 'ffmpeg.pin.json'], 'the pinned ffmpeg ships with its GPL text, notice and afterPack attestation, and nothing from ffmpeg-static')
  } else {
    assert.ok(existsSync(join(resources, 'ffmpeg', 'LICENSE')) && readdirSync(join(resources, 'ffmpeg')).some((name) => name.endsWith('.LICENSE')), 'the ffmpeg licence files ship beside it')
  }
  assert.equal(existsSync(join(appRoot, 'node_modules', 'ffmpeg-static')), false, 'ffmpeg is in the build once, not a second time inside resources/app')
  for (const name of ['SETUP.md', 'parakeet_to_srt.py', 'requirements.txt', 'PROVENANCE.md']) {
    assert.ok(existsSync(join(resources, 'agent-setup', 'transcription', name)), `the transcription set-up folder ships ${name}`)
  }
  const ffmpegRun = (args) => spawnSync(ffmpegShipped.path, ['-hide_banner', '-loglevel', 'error', ...args], { cwd: scratch, encoding: 'utf8', timeout: 60_000, windowsHide: true })
  const ffmpegVersion = spawnSync(ffmpegShipped.path, ['-version'], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
  assert.equal(ffmpegVersion.status, 0, `the shipped ffmpeg does not run (exit ${ffmpegVersion.status})\n${ffmpegVersion.stderr}`)
  assert.ok(!ffmpegVersion.stdout.includes('--enable-nonfree'), 'the shipped ffmpeg is not a nonfree (unredistributable) build')
  let ffmpegPinNote = ''
  if (process.platform === 'darwin') {
    // The pinned build is identified by the release gate, scripts/verify-mac-package.mjs, from the
    // package alone: the afterPack attestation must be there and name the committed pin; a signed app's
    // seal must verify (codesign --verify --deep --strict) and its ffmpeg, signature removed, must be
    // the pinned program; an unsigned app's ffmpeg must have the pinned SHA-256.
    const problem = macAppProblem(build)
    assert.equal(problem, null, `the packaged app does not pass the release gate: ${problem}`)
    const signed = existsSync(join(build, 'Contents', '_CodeSignature', 'CodeResources'))
    ffmpegPinNote = `${signed ? 'signed' : 'unsigned'} package passes scripts/verify-mac-package.mjs (attestation, ${signed ? 'seal and content hash' : 'pinned SHA-256'})`
  }
  const toneWav = join(scratch, 'tone.wav')
  assert.equal(ffmpegRun(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', toneWav]).status, 0, 'the shipped ffmpeg makes a test recording')
  const joinedWav = join(scratch, 'joined.wav')
  const joinedRun = ffmpegRun(transcodeArgs([toneWav, toneWav], [0, 500], joinedWav))
  assert.equal(joinedRun.status, 0, `the shipped ffmpeg could not make transcription's WAV\n${joinedRun.stderr}`)
  assert.ok(statSync(joinedWav).size > 1000, 'the WAV was written')
  assert.deepEqual(listing(build), sealed, 'running ffmpeg changed files inside the packaged build')
  console.log(`  11. ${ffmpegVersion.stdout.split('\n')[0].split(' Copyright')[0]} ships at resources/ffmpeg/${ffmpegName}, is chosen with no path set and makes transcription's WAV; the set-up folder ships${ffmpegPinNote ? `; ${ffmpegPinNote}` : ''} — passed`)
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
}

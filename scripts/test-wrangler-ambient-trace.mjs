// Ambient-access trace for the bundled wrangler (spec "Cloudflare set-up in the app", D2: "wrangler
// is given no executable, configuration or credential source that TalkWeaver did not write or ship").
//
// wrangler reads its surroundings by design. This test runs the REAL commands the app runs, through
// the launcher, inside a throwaway tree shaped like a real machine
//     home / Library / Application Support / TalkWeaver (user data) / wrangler-runs
// with a canary of every kind wrangler is known to look for planted in each folder above the run
// folder, and with a tracing preload (scripts/lib/wrangler-trace-preload.cjs, switched on by a
// launcher argument the app never passes) recording every file touched, module loaded, process
// started and socket opened by the wrangler process. It then asserts that
//   - no canary did anything (each would leave a marker file) and none was even looked at;
//   - no process was started except the app's own Node, the bundled esbuild and workerd, and a shell
//     running wrangler's `git` probe (which finds no git and is taken as "not a repository");
//   - every file touched lies in the app root, the run folder, a folder named in the command's own
//     arguments, the system's own folders, the temp folder, or ALLOWED_ELSEWHERE below;
//   - every socket goes to this machine (the stub API, the local dev server).
// Commands: `deploy --dry-run`; `dev` (start, one request, stop); `pages deploy` and `secret bulk`
// against a small local stand-in for the Cloudflare API (nothing here can reach Cloudflare: the
// address and a fake token are set for those commands). `pages deploy` runs to the end (project
// looked up, file uploaded, deployment created); `secret bulk` as far as the stand-in's answers allow.
// (`deploy` and `dev` are what tests and the unpackaged app still use; the app sets the live service
// up without wrangler.)
//
// Then the app's OWN set-up of the live service (ticket 11: the shipped bundle uploaded with
// Cloudflare's API, src/main/live-service-deploy.ts) under the same trace, with malformed
// tsconfig.json, jsconfig.json and package.json files planted in every folder above the shipped
// bundle and above the folder it runs in: it starts no process at all (no esbuild, no wrangler, no
// Node), opens only the shipped bundle's folder, its own code and the system's, connects only to the
// stand-in API, and succeeds, uploading the shipped bytes.
//
// What the trace cannot see is said in the preload's header: inside esbuild, workerd and the shell.
// The canaries cover that side: a fake `git` and `node` on the person's PATH, and a repository above
// the run folder whose hooks would run if any git ever looked at it.
import { strict as assert } from 'node:assert'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { liveWorkerDeployConfig } from '../src/main/live-worker-deploy-config.ts'
import { blockingFileText, brokenJsonFileInOutput } from '../src/main/wrangler-failures.ts'
import { pagesBundlingHazard, resolveSiteDir } from '../src/main/publishing-logic.ts'
import { prepareWranglerRun, windowsSystemRoot, wranglerRunFolder } from '../src/main/wrangler-launcher.ts'
import { startCloudflareApiStub } from './lib/cloudflare-api-stub.mjs'
import { createHash } from 'node:crypto'
import { buildWorkerDist } from './lib/worker-dist.mjs'
import { uploadedOf } from './lib/live-service-setup.mjs'
import { classifyProcess, isLocalConnect, isSystemPath, pathRules } from './lib/wrangler-trace-rules.mjs'

const started = Date.now()
const repo = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))))
const windows = process.platform === 'win32'
const preload = join(repo, 'scripts', 'lib', 'wrangler-trace-preload.cjs')
const verbose = process.argv.includes('--verbose')

// Files touched outside the app root, the run folder, the command's own arguments, the system's
// folders and the temp folder. Each entry: a test on the path, and why wrangler may touch it.
const ALLOWED_ELSEWHERE = [
  // Node's CommonJS loader asks for the real path of the entry script, which stats each folder on
  // the way down to the checkout (a packaged app: down to the app bundle). Folders only, never a
  // file in them.
  { why: 'folders on the way down to the app root (realpath of the entry script)', test: (path) => isAncestorOf(path, repo) },
  // The same for the run folder: wrangler resolves its working folder and the config it was given.
  { why: 'folders on the way down to the run folder (realpath of the working folder)', test: (path, tree) => isAncestorOf(path, tree.workDir) },
]

const systemRoot = windowsSystemRoot(process.env) // the same checked folder the launcher builds PATH from
const { under, isAncestorOf } = pathRules(process.platform)

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolvePort(port)) })
  })
}

// ── The throwaway machine ───────────────────────────────────────────────────────────────────────
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tw-wrangler-ambient-')))
const home = join(scratch, 'home')
const userData = join(home, 'Library', 'Application Support', 'TalkWeaver')
const tree = {
  home,
  userData,
  workDir: join(userData, 'wrangler-runs'),
  markers: join(scratch, 'markers'),
  personBin: join(home, 'bin'),
  outdir: join(scratch, 'dry-run-out'),
  devState: join(scratch, 'dev-state'),
  // The supported relative override (`publishSiteDir: "site"`), resolved once as the app does.
  siteDir: resolveSiteDir(userData, 'site'),
}
const install = { execPath: process.execPath, appRoot: repo, platform: process.platform, workDir: tree.workDir }
const marker = (name) => join(tree.markers, name)
const ancestors = [home, join(home, 'Library'), join(home, 'Library', 'Application Support'), userData]

/** A program that, if it is ever run, leaves a marker saying so. */
function plantProgram(dir, name) {
  mkdirSync(dir, { recursive: true })
  const leaves = marker(`ran-${name}-in-${relative(scratch, dir).split(sep).join('_')}`)
  if (windows) {
    writeFileSync(join(dir, `${name}.cmd`), `@echo off\r\necho ran> "${leaves}"\r\nexit /b 0\r\n`)
  } else {
    writeFileSync(join(dir, name), `#!/bin/sh\necho ran > "${leaves}"\nexit 0\n`)
    chmodSync(join(dir, name), 0o755)
  }
  return join(dir, windows ? `${name}.cmd` : name)
}

function plantCanaries() {
  mkdirSync(tree.markers, { recursive: true })
  // On the person's PATH: a git and a node.
  plantProgram(tree.personBin, 'git')
  plantProgram(tree.personBin, 'node')
  for (const dir of ancestors) {
    mkdirSync(dir, { recursive: true })
    const tag = relative(scratch, dir).split(sep).join('_')
    // A dotenv file. If wrangler loads it, WRANGLER_OUTPUT_FILE_PATH makes it write the marker.
    const dotenv = [
      `WRANGLER_OUTPUT_FILE_PATH=${marker(`dotenv-loaded-from-${tag}`).split('\\').join('/')}`,
      'CLOUDFLARE_API_BASE_URL=http://127.0.0.1:9/evil', 'CLOUDFLARE_ACCOUNT_ID=evil-account', 'MINIFLARE_WORKERD_PATH=/nonexistent/evil-workerd', '',
    ].join('\n')
    for (const name of ['.env', '.env.local', '.dev.vars']) writeFileSync(join(dir, name), dotenv)
    // A wrangler config, and a deploy redirect pointing at it.
    writeFileSync(join(dir, 'wrangler.jsonc'), JSON.stringify({ name: 'evil-project', pages_build_output_dir: './evil-site', account_id: 'evil-account' }))
    writeFileSync(join(dir, 'wrangler.toml'), 'name = "evil-project"\npages_build_output_dir = "./evil-site"\n')
    mkdirSync(join(dir, '.wrangler', 'deploy'), { recursive: true })
    writeFileSync(join(dir, '.wrangler', 'deploy', 'config.json'), JSON.stringify({ configPath: '../../wrangler.jsonc' }))
    // wrangler's cache, where it looks for the nearest node_modules.
    mkdirSync(join(dir, 'node_modules', '.cache', 'wrangler'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', '.cache', 'wrangler', 'pages.json'), JSON.stringify({ account_id: 'evil-account', project_name: 'evil-project' }))
    writeFileSync(join(dir, 'node_modules', '.cache', 'wrangler', 'wrangler-account.json'), JSON.stringify({ account: { id: 'evil-account', name: 'evil' } }))
    // npm settings (wrangler's update check reads them and calls the registry they name).
    writeFileSync(join(dir, '.npmrc'), 'registry=http://127.0.0.1:9/evil-registry/\n//127.0.0.1:9/evil-registry/:_authToken=evil\n')
    // A git repository whose settings run a program on `git status` and on every hook.
    const hook = plantProgram(join(dir, 'evil-git-hooks'), 'fsmonitor')
    for (const name of ['pre-commit', 'post-checkout', 'post-index-change', 'reference-transaction']) plantProgram(join(dir, 'evil-git-hooks'), name)
    for (const sub of ['objects/info', 'objects/pack', 'refs/heads', 'refs/tags']) mkdirSync(join(dir, '.git', sub), { recursive: true })
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(dir, '.git', 'config'), [
      '[core]', '\trepositoryformatversion = 0', '\tbare = false',
      `\tfsmonitor = ${hook.split('\\').join('/')}`, `\thooksPath = ${join(dir, 'evil-git-hooks').split('\\').join('/')}`, '',
    ].join('\n'))
  }
  // A saved wrangler sign-in in the person's home, in each place wrangler looks.
  for (const dir of [join(home, '.wrangler'), join(home, '.config', '.wrangler'), join(home, 'Library', 'Preferences', '.wrangler'), join(home, 'AppData', 'Roaming', 'xdg.config', '.wrangler')]) {
    mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(join(dir, 'config', 'default.toml'), 'oauth_token = "evil-oauth-token"\nrefresh_token = "evil-refresh"\nexpiration_time = "2099-01-01T00:00:00.000Z"\nscopes = ["account:read"]\n')
    writeFileSync(join(dir, 'metrics.json'), JSON.stringify({ permission: { enabled: true, date: '2099-01-01T00:00:00.000Z', bannerLastShown: 'x' }, deviceId: 'evil-device' }))
  }
  // The site to publish (a relative override resolves here), and a decoy where a relative path
  // would land if wrangler resolved it from its own working folder.
  mkdirSync(tree.siteDir, { recursive: true })
  writeFileSync(join(tree.siteDir, 'index.html'), '<!doctype html><title>The real site</title>')
}

/** A tsconfig that parses and asks for a different compile (older target, other class fields, a path mapping). */
function plantValidHostileTsconfig() {
  writeFileSync(join(home, 'Library', 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'es5', useDefineForClassFields: false, baseUrl: '.', paths: { '*': ['./evil/*'] } } }))
}
/** Files esbuild looks for in every folder above what it compiles and above where it runs. */
function plantCompilerFiles() {
  writeFileSync(join(home, 'tsconfig.json'), '{ "compilerOptions": { this is not JSON')
  plantValidHostileTsconfig()
  writeFileSync(join(home, 'Library', 'Application Support', 'jsconfig.json'), '{ "compilerOptions": { nor is this')
  // Directly above the run folder's own package.json stand-in.
  writeFileSync(join(userData, 'package.json'), '{ "name": "evil", "type": ')
}

// What the app would inherit on a developer's machine: this process's whole environment, the
// throwaway home, and a PATH that starts with the planted git and node (the real ones follow).
const inherited = {
  ...process.env,
  HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
  PATH: `${tree.personBin}${delimiter}${process.env.PATH ?? ''}`,
  CLOUDFLARE_API_TOKEN: 'inherited-token-that-must-not-be-used', CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:9/evil',
}

// ── Running a command under the trace ───────────────────────────────────────────────────────────
function launch(name, args, set = {}) {
  const file = join(scratch, `trace-${name}.ndjson`)
  const resolved = prepareWranglerRun(install, args, { inherited, set }, { preload, file })
  assert.equal(resolved.ok, true, resolved.ok ? '' : resolved.details)
  return { ...resolved.launch, file }
}
const events = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])

/** Check one command's trace. `named`: folders the command's own arguments name. */
function check(name, file, { named = [], localPorts = [], minEvents = 50 } = {}) {
  const trace = events(file)
  assert.ok(trace.length > minEvents, `${name}: the trace has ${trace.length} events (is the preload loaded?)`)
  const problems = []
  const elsewhere = new Map()
  const started = new Set()
  for (const event of trace) {
    if (event.kind === 'file' || event.kind === 'module') {
      const path = event.path
      if (path === file) continue
      if (under(path, repo) || under(path, tree.workDir) || named.some((dir) => under(path, dir))) continue
      if (under(path, scratch)) {
        // Inside the throwaway machine but outside the run folder: only the folders leading to it.
        if (isAncestorOf(path, tree.workDir)) continue
        problems.push(`${event.kind} ${event.op ?? ''} ${relative(scratch, path)}`)
        continue
      }
      if (isSystemPath(path, { platform: process.platform, systemRoot })) continue
      const allowed = ALLOWED_ELSEWHERE.find((entry) => entry.test(path, tree))
      if (allowed) { elsewhere.set(path, allowed.why); continue }
      if (under(path, realpathSync(tmpdir())) || under(path, tmpdir())) { elsewhere.set(path, 'the temp folder'); continue }
      problems.push(`${event.kind} ${event.op ?? ''} ${path}`)
    } else if (event.kind === 'process') {
      // The app's Node, the bundled esbuild or workerd, or the system shell running wrangler's git probe.
      const kind = classifyProcess(event, { platform: process.platform, execPath: process.execPath, appRoot: repo, systemRoot })
      if (kind) started.add(kind)
      else problems.push(`process ${event.file} ${event.args.join(' ')}`)
    } else if (event.kind === 'connect') {
      const local = isLocalConnect(event.to)
      if (!local) problems.push(`connect ${event.to}`)
      const port = Number(event.to.split(':').pop())
      if (local && !event.to.startsWith('pipe:') && localPorts.length && !localPorts.includes(port)) elsewhere.set(`connect ${event.to}`, 'a loopback port of its own (dev server internals)')
    }
  }
  const processes = [...new Set(trace.filter((event) => event.kind === 'process').map((event) => `${event.file.startsWith(repo) ? relative(repo, event.file) : event.file} ${event.shell || /sh$|cmd\.exe$/i.test(event.file) ? event.args.join(' ') : ''}`.trim()))]
  if (verbose) {
    console.log(`\n── ${name}: ${trace.length} events`)
    console.log('  processes:', processes)
    console.log('  sockets:', [...new Set(trace.filter((event) => event.kind === 'connect').map((event) => event.to))])
    console.log('  outside app root / run folder / named / system:', [...elsewhere].map(([path, why]) => `${path}  (${why})`))
    console.log('  in the run folder:', [...new Set(trace.filter((event) => event.kind === 'file' && under(event.path, tree.workDir)).map((event) => relative(tree.workDir, event.path) || '.'))].sort())
  }
  assert.deepEqual([...new Set(problems)], [], `${name}: wrangler touched something it was not given`)
  const leftBehind = existsSync(tree.markers) ? readdirSync(tree.markers) : []
  assert.deepEqual(leftBehind, [], `${name}: a canary ran or was loaded`)
  return { trace, processes, started: [...started].sort() }
}

try {
  plantCanaries()
  const config = join(tree.workDir, 'live-worker-wrangler.generated.jsonc')
  const writeConfig = () => { mkdirSync(tree.workDir, { recursive: true }); writeFileSync(config, JSON.stringify(liveWorkerDeployConfig(readFileSync(join(repo, 'worker', 'wrangler.jsonc'), 'utf8'), join(repo, 'worker'), null))) }
  writeConfig()

  // The launcher's part, before anything runs: nothing of the person's is in the child's environment.
  {
    const { env, cwd } = launch('env', ['--version'])
    const folder = wranglerRunFolder(install)
    assert.equal(cwd, tree.workDir)
    if (!windows) {
      assert.equal(env.PATH, folder.emptyPath, 'PATH is one folder')
      assert.deepEqual(readdirSync(folder.emptyPath), [], 'which is empty')
    } else {
      assert.equal(env.PATH, `${systemRoot}\\System32`, 'PATH is the checked System32 only')
      assert.equal(env.ComSpec, `${systemRoot}\\System32\\cmd.exe`, 'and the shell is its cmd.exe')
    }
    assert.ok(!Object.values(env).some((value) => String(value).includes(tree.personBin)), 'the person\'s PATH is nowhere in it')
    assert.equal(env.HOME, folder.home)
    assert.ok(under(env.HOME, tree.workDir), 'wrangler\'s home is inside the run folder')
    assert.equal(env.GIT_CEILING_DIRECTORIES, userData)
    assert.deepEqual([env.GIT_CONFIG_GLOBAL, env.GIT_CONFIG_SYSTEM, env.GIT_CONFIG_NOSYSTEM, env.GIT_TERMINAL_PROMPT], [folder.envFile, folder.envFile, '1', '0'])
    assert.equal(env.CLOUDFLARE_API_TOKEN, undefined, 'an inherited token is not passed on')
    assert.equal(env.CLOUDFLARE_API_BASE_URL, undefined)
  }

  // ── 1. deploy --dry-run ───────────────────────────────────────────────────────────────────────
  {
    const run = launch('deploy-dry-run', ['deploy', '--dry-run', '--outdir', tree.outdir, '--config', config])
    const done = spawnSync(run.command, run.args, { cwd: run.cwd, env: run.env, encoding: 'utf8', timeout: 120_000, windowsHide: true })
    assert.equal(done.status, 0, `deploy --dry-run\n${done.stdout}\n${done.stderr}`)
    assert.ok(readdirSync(tree.outdir).some((name) => name.endsWith('.js')), 'the Worker compiled')
    const { started } = check('deploy --dry-run', run.file, { named: [tree.outdir] })
    assert.deepEqual(started, ['esbuild'], 'the bundled esbuild did the compiling, and nothing else was started')
  }

  // ── 2. dev: start, one request, stop ──────────────────────────────────────────────────────────
  {
    writeConfig()
    const port = await freePort()
    const run = launch('dev', [
      'dev', '--config', config, '--ip', '127.0.0.1', '--port', String(port),
      '--var', 'ADMIN_SECRET:trace-admin', '--var', 'SESSION_SIGNING_SECRET:trace-signing', '--var', 'PREWORK_LOCAL_SOURCE:1',
      '--persist-to', tree.devState, '--show-interactive-dev-session=false', '--log-level=error',
    ])
    const child = spawn(run.command, run.args, { cwd: run.cwd, env: run.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = ''
    child.stdout.on('data', (chunk) => { output += String(chunk) })
    child.stderr.on('data', (chunk) => { output += String(chunk) })
    try {
      let response = null
      const deadline = Date.now() + 60_000
      while (!response && Date.now() < deadline) {
        assert.equal(child.exitCode, null, `wrangler dev stopped\n${output.slice(-3000)}`)
        try { response = await fetch(`http://127.0.0.1:${port}/capabilities`) } catch { await new Promise((wait) => setTimeout(wait, 150)) }
      }
      assert.equal(response?.status, 200, `wrangler dev did not serve /capabilities\n${output.slice(-3000)}`)
      await response.text()
    } finally {
      const exited = new Promise((resolveExit) => child.once('exit', resolveExit))
      if (windows) spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
      else child.kill('SIGTERM')
      await exited
    }
    const { started } = check('dev', run.file, { named: [tree.devState], localPorts: [port] })
    assert.deepEqual(started, ['esbuild', 'workerd'], 'the bundled esbuild compiled it and the bundled workerd served it')
  }

  // What is uploaded cannot be altered by files outside the app: with a tsconfig.json that PARSES
  // and asks for a different compile in a parent folder, the compiled Worker is byte for byte the
  // one from the clean run in step 1 (wrangler gives esbuild its settings explicitly).
  {
    plantValidHostileTsconfig()
    writeConfig()
    const again = join(scratch, 'dry-run-again')
    const run = launch('deploy-dry-run-hostile-tsconfig', ['deploy', '--dry-run', '--outdir', again, '--config', config])
    const done = spawnSync(run.command, run.args, { cwd: run.cwd, env: run.env, encoding: 'utf8', timeout: 120_000, windowsHide: true })
    assert.equal(done.status, 0, `deploy --dry-run with a valid hostile tsconfig above\n${done.stdout}\n${done.stderr}`)
    assert.ok(readFileSync(join(again, 'index.js')).equals(readFileSync(join(tree.outdir, 'index.js'))), 'a valid tsconfig.json in a parent folder does not change one byte of the compiled Worker')
  }

  // From here on the folders above the run folder also hold files that esbuild reads by itself in
  // every parent folder (the trace cannot see inside esbuild): broken ones and ones that would change
  // a compile. The two commands that publish a handout and set the Worker's secrets start no
  // esbuild, so none of it matters to them.
  plantCompilerFiles()

  // ── 3. pages deploy, against the stand-in API ─────────────────────────────────────────────────
  {
    const stub = await startCloudflareApiStub()
    try {
      assert.equal(tree.siteDir, join(userData, 'site'), 'a relative publishSiteDir is taken from user data')
      const run = launch('pages-deploy', ['pages', 'deploy', tree.siteDir, '--project-name', 'talks', '--branch', 'main', '--commit-dirty=true'], {
        CLOUDFLARE_API_TOKEN: 'trace-test-token', CLOUDFLARE_ACCOUNT_ID: 'trace0account', CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${stub.port}/client/v4`,
      })
      // Not spawnSync: the stand-in API lives in this process and must be able to answer.
      const done = await new Promise((resolveDone) => {
        const child = spawn(run.command, run.args, { cwd: run.cwd, env: run.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => { stdout += String(chunk) })
        child.stderr.on('data', (chunk) => { stderr += String(chunk) })
        const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
        child.on('close', (status) => { clearTimeout(timer); resolveDone({ status, stdout, stderr }) })
      })
      const said = `${done.stdout}\n${done.stderr}`
      const reached = stub.requests.map((request) => `${request.method} ${request.path}`)
      if (verbose) console.log('\n── pages deploy said:\n', said, '\n  stub requests:', reached)
      const { processes, started } = check('pages deploy', run.file, { named: [tree.siteDir], localPorts: [stub.port] })
      assert.deepEqual(started, ['git-probe'], 'pages deploy for a site without Functions starts no esbuild and no workerd: only its git probe')
      assert.equal(pagesBundlingHazard(tree.siteDir, tree.workDir, existsSync), null, 'the site and the run folder hold nothing that would make it compile')

      // How far it gets: the whole way. Project looked up, files hashed and uploaded, deployment made.
      assert.equal(done.status, 0, `pages deploy against the stub\n${said}`)
      assert.ok(reached.includes('GET /accounts/trace0account/pages/projects/talks'), 'the project named on the command line, in the account set for the call')
      assert.ok(reached.includes('POST /pages/assets/upload'), 'the site\'s file was uploaded')
      assert.ok(reached.includes('POST /accounts/trace0account/pages/projects/talks/deployments'), 'and the deployment created')
      assert.ok(!said.includes('evil'), 'nothing from a planted config, cache or sign-in shows in what wrangler says')
      assert.ok(!reached.some((line) => line.includes('evil')), 'nor in what it asks the API for')
      // The token: only the one set for this call, and only ever sent to the stub.
      const tokens = new Set(stub.requests.map((request) => request.authorization).filter(Boolean))
      assert.ok([...tokens].every((value) => value === 'Bearer trace-test-token' || /^Bearer ey/.test(value)), `only the call's own token (or the upload token the API issued) is sent: ${[...tokens]}`)
      // The upload came from the real site folder, not from a `site` folder beside wrangler.
      const upload = stub.requests.find((request) => request.path === '/pages/assets/upload')
      assert.ok(upload.body.toString().includes(Buffer.from('<!doctype html><title>The real site</title>').toString('base64')), 'the uploaded file is the one in <user data>/site')
      // git: asked for by name through the shell, never found; so the deployment carries no commit.
      assert.ok(processes.some((line) => /git rev-parse --is-inside-work-tree/.test(line)), 'wrangler made its git probe')
      assert.ok(!processes.some((line) => /git status/.test(line)), 'and, finding no git, went no further')
      const created = stub.requests.find((request) => request.method === 'POST' && request.path.endsWith('/deployments')).body.toString()
      assert.ok(!/name="commit_hash"/.test(created), 'no commit is attached to the deployment')
      assert.ok(!/name="wrangler_config_hash"/.test(created), 'and no wrangler config: the project stays managed as before')
    } finally {
      await stub.close()
    }
  }

  // ── 4. secret bulk, against the stand-in API ──────────────────────────────────────────────────
  // The stand-in answers every request with an empty success, which is not what wrangler needs to
  // finish; the point here is what the command reads and starts on the way, not whether it succeeds.
  {
    const stub = await startCloudflareApiStub()
    try {
      writeConfig()
      const run = launch('secret-bulk', ['secret', 'bulk', '--config', config], {
        CLOUDFLARE_API_TOKEN: 'trace-test-token', CLOUDFLARE_ACCOUNT_ID: 'trace0account', CLOUDFLARE_API_BASE_URL: `http://127.0.0.1:${stub.port}/client/v4`,
      })
      const done = await new Promise((resolveDone) => {
        const child = spawn(run.command, run.args, { cwd: run.cwd, env: run.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
        let said = ''
        child.stdout.on('data', (chunk) => { said += String(chunk) })
        child.stderr.on('data', (chunk) => { said += String(chunk) })
        const timer = setTimeout(() => child.kill('SIGKILL'), 60_000)
        child.on('close', (status) => { clearTimeout(timer); resolveDone({ status, said }) })
        child.stdin.end(JSON.stringify({ ADMIN_SECRET: 'trace-admin', SESSION_SIGNING_SECRET: 'trace-signing' }))
      })
      const reached = stub.requests.map((request) => `${request.method} ${request.path}`)
      if (verbose) console.log('\n── secret bulk exited', done.status, 'and said:\n', done.said, '\n  stub requests:', reached)
      const { started } = check('secret bulk', run.file, { localPorts: [stub.port] })
      assert.deepEqual(started, [], 'secret bulk starts no process at all')
      assert.ok(reached.length > 0 && reached.every((line) => line.includes('/accounts/trace0account/workers/scripts/talkweaver-live-sessions')), `it asked the stand-in API about the shipped Worker in the call's account, and nothing else: ${reached}`)
      assert.ok(!done.said.includes('evil'))
    } finally {
      await stub.close()
    }
  }

  // ── 5. The app's own set-up of the live service, with the malformed files planted ─────────────
  // Whenever wrangler handles a Worker it starts esbuild, and esbuild reads tsconfig.json,
  // jsconfig.json and package.json in every folder above; a broken one stopped `deploy` (`--no-bundle`
  // too). The app no longer compiles anything when it sets the live service up (ticket 11): it
  // uploads the bundle compiled when the app was built. Here that set-up runs as a process of its own
  // under the trace, from a shipped folder inside an app tree that has broken files above it too,
  // in the run folder (broken files above it since step 3), against the stand-in API.
  {
    const app = join(scratch, 'Applications', 'TalkWeaver')
    const distDir = join(app, 'resources', 'worker-dist')
    // Compiled as the build step does, in the repository; then shipped into the app tree.
    const built = join(scratch, 'built-worker-dist')
    const manifest = buildWorkerDist({ repo, outDir: built })
    cpSync(built, distDir, { recursive: true })
    for (const dir of [join(scratch, 'Applications'), app, join(app, 'resources')]) {
      writeFileSync(join(dir, 'tsconfig.json'), '{ "compilerOptions": { this is not JSON')
      writeFileSync(join(dir, 'jsconfig.json'), '{ "compilerOptions": ')
      writeFileSync(join(dir, 'package.json'), '{ "name": "evil", "type": ')
    }
    const planted = [join(home, 'tsconfig.json'), join(home, 'Library', 'Application Support', 'jsconfig.json'), join(userData, 'package.json')]
    assert.ok(planted.every((path) => existsSync(path)), 'the broken files above the run folder are still there')
    const stub = await startCloudflareApiStub()
    try {
      const file = join(scratch, 'trace-live-set-up.ndjson')
      const token = ['trace', 'live', 'token', '0123456789abcdef'].join('-') // gitleaks:allow (made-up test value)
      const env = { ...inherited, TALKWEAVER_WRANGLER_TRACE_FILE: file, TW_TEST_LIVE_SETUP: JSON.stringify({ distDir, expectedBuild: manifest.build, apiBase: stub.baseUrl, token, accountId: 'trace0account', runs: 2 }) }
      const driver = join(repo, 'scripts', 'lib', 'live-service-setup-driver.mjs')
      const done = await new Promise((resolveDone) => {
        const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--require', preload, driver], { cwd: tree.workDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (chunk) => { stdout += String(chunk) })
        child.stderr.on('data', (chunk) => { stderr += String(chunk) })
        const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
        child.on('close', (status) => { clearTimeout(timer); resolveDone({ status, stdout, stderr }) })
      })
      assert.equal(done.status, 0, `the set-up process\n${done.stdout}\n${done.stderr}`)
      const results = JSON.parse(done.stdout.trim().split('\n').pop())
      assert.deepEqual(results.map((result) => [result.ok, result.baseUrl]), [[true, 'https://talkweaver-live-sessions.stand-in.workers.dev'], [true, 'https://talkweaver-live-sessions.stand-in.workers.dev']], `the live service is set up, then updated, with the malformed files planted: ${JSON.stringify(results)}`)
      assert.equal(stub.requests.filter((request) => request.method === 'PUT' && request.path.endsWith('/workers/scripts/talkweaver-live-sessions')).length, 2, 'two uploads: the set-up and the update')
      assert.ok(!done.stdout.includes(token) && !done.stderr.includes(token), 'the token is not printed')
      const trace = events(file)
      assert.deepEqual(trace.filter((event) => event.kind === 'process'), [], 'no process at all is started, for the set-up or the update: no esbuild, no wrangler, no Node')
      const { started } = check('live service set-up', file, { named: [distDir], localPorts: [stub.port], minEvents: 3 })
      assert.deepEqual(started, [])
      assert.ok(trace.some((event) => event.kind === 'file' && under(event.path, distDir)), 'it read the shipped bundle')
      assert.ok(trace.some((event) => event.kind === 'connect' && event.to.endsWith(`:${stub.port}`)), 'and talked to the stand-in API')
      assert.ok(!trace.some((event) => event.kind === 'file' && /(?:^|[\\/])(?:tsconfig|jsconfig|package)\.json$/.test(event.path) && !under(event.path, repo)), 'no tsconfig.json, jsconfig.json or package.json outside the app\'s own code is even looked at')
      // What was uploaded is the shipped bundle, byte for byte.
      for (const upload of stub.requests.filter((request) => request.method === 'PUT' && request.path === '/accounts/trace0account/workers/scripts/talkweaver-live-sessions')) {
        assert.equal(createHash('sha256').update(uploadedOf(upload).module.bytes).digest('hex'), manifest.files['index.js'].sha256, 'the uploaded bytes match the manifest')
      }
      assert.deepEqual(stub.unknown, [], 'and nothing was asked that the stand-in does not model')
    } finally {
      await stub.close()
    }
  }

  // ── 6. wrangler's own compile, which tests and the unpackaged app still use (`dev`) ────────────
  // There esbuild still reads the folders above, and a broken file stops it. That failure is
  // recognised in what wrangler printed and reported by naming the file (src/main/wrangler-failures.ts);
  // the app itself opens no file outside its own folders. Real output, sorted:
  {
    writeConfig()
    const bundled = launch('gap-deploy', ['deploy', '--dry-run', '--outdir', join(scratch, 'gap-out'), '--config', config])
    const failed = spawnSync(bundled.command, bundled.args, { cwd: bundled.cwd, env: bundled.env, encoding: 'utf8', timeout: 120_000, windowsHide: true })
    assert.notEqual(failed.status, 0, 'a broken tsconfig.json or package.json above the run folder stops wrangler\'s compile')
    assert.match(`${failed.stdout}${failed.stderr}`, /in JSON/, 'and the failure is esbuild refusing the planted file')
    // Real output, recognised: the nearest broken file esbuild met is one of the three planted, by full path.
    const named = brokenJsonFileInOutput(`${failed.stdout}\n${failed.stderr}`, bundled.cwd)
    const plantedBroken = [join(home, 'tsconfig.json'), join(home, 'Library', 'Application Support', 'jsconfig.json'), join(userData, 'package.json')]
    assert.ok(named && plantedBroken.includes(named.path), `the failure is sorted by naming the file: ${named?.path}\n${failed.stderr}`)
    assert.ok(blockingFileText(named.path).startsWith('A file on this computer stops the live service from being prepared. Details: '))
    assert.ok(!/\u001b/.test(failed.stderr.split(/\r?\n/).find((line) => /(?:tsconfig|jsconfig|package)\.json:\d+:\d+:/.test(line)) ?? ''), 'the place line is printed without colour codes (the launcher asks for none; the lines around it are coloured regardless)')
    // A broken file under a folder whose NAME contains escape bytes (not possible on Windows, where
    // such names cannot exist): the file named is the real one, and what is shown has them written out.
    if (!windows) {
      const odd = join(scratch, 'Applications', '\u001b[31mactual\u001b[0m')
      const oddWorker = join(odd, 'worker')
      cpSync(join(repo, 'worker'), oddWorker, { recursive: true, filter: (file) => !/[\\/]\.wrangler(?:[\\/]|$)|\.test\.ts$/.test(file) })
      writeFileSync(join(odd, 'jsconfig.json'), '{ "compilerOptions": ')
      const oddConfig = join(tree.workDir, 'odd.jsonc')
      // The broken files above the run folder are taken away for this one run, so that this is the file esbuild stops at.
      const aside = [join(home, 'tsconfig.json'), join(home, 'Library', 'Application Support', 'jsconfig.json'), join(userData, 'package.json')].map((path) => [path, readFileSync(path)])
      for (const [path] of aside) rmSync(path)
      writeFileSync(oddConfig, JSON.stringify(liveWorkerDeployConfig(readFileSync(join(repo, 'worker', 'wrangler.jsonc'), 'utf8'), oddWorker, null)))
      const run = launch('gap-odd-name', ['deploy', '--dry-run', '--outdir', join(scratch, 'gap-out-odd'), '--config', oddConfig])
      const stopped = spawnSync(run.command, run.args, { cwd: run.cwd, env: run.env, encoding: 'utf8', timeout: 120_000, windowsHide: true })
      for (const [path, bytes] of aside) writeFileSync(path, bytes)
      assert.notEqual(stopped.status, 0)
      const real = brokenJsonFileInOutput(`${stopped.stdout}\n${stopped.stderr}`, run.cwd)
      assert.equal(real?.path, join(odd, 'jsconfig.json'), 'real output: the path with escape bytes in it resolves to the real file')
      assert.ok(existsSync(real.path))
      const shown = blockingFileText(real.path)
      assert.ok(shown.includes('\\x1b[31mactual\\x1b[0m') && !/[\u0000-\u001f]/.test(shown), 'and is shown with the escape bytes written out')
    }
  }

  console.log(`wrangler ambient-access trace: deploy --dry-run, dev, pages deploy and secret bulk (the last two to a local stand-in API) touched only the app root, the run folder, their own arguments, system folders and the temp folder; started only the app's Node, the bundled esbuild and workerd (pages deploy and secret bulk: neither), and a shell whose git probe found no git; no canary ran; the app's own live-service set-up and update, with broken tsconfig.json, jsconfig.json and package.json above them, started no process and succeeded — passed in ${((Date.now() - started) / 1000).toFixed(1)}s`)
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5 })
}

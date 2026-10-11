// The one way TalkWeaver starts `wrangler` (Cloudflare's publishing tool).
//
// wrangler is a dependency of the app and ships inside the packaged build (spec
// docs/plans/cloudflare-setup-in-app, decision D2). It is started by absolute path with the app's
// own Node: the Electron executable with ELECTRON_RUN_AS_NODE=1. Nothing is looked up on PATH and no
// Node has to be installed on the machine. The same function serves the packaged app (macOS and
// Windows), the unpackaged app and the test harness (where `execPath` is plain Node and `appRoot`
// the repository).
//
// The child's environment is BUILT, not copied: the child carries the Cloudflare token, so nothing
// the app merely inherited may decide which program runs, which module loads, which settings file is
// read or which server is called. Two separate inputs:
//   - `inherited` (the app's own process.env): only the names in INHERITED_NAMES pass; PATH and the
//     home folder are never inherited (see `fixed` in `wranglerChildEnv`);
//   - `set` (what this one call asks for, e.g. the token): passed as given, except names that change
//     how Node itself starts, which are refused.
//
// Variables read by wrangler 4.144, miniflare 5, esbuild 0.28, workerd and Node that select an
// executable, a module path, a settings location or an endpoint. None is in INHERITED_NAMES, so none
// can arrive from the inherited side (scripts/test-wrangler-launcher.mjs checks each):
//   executables   ESBUILD_BINARY_PATH, MINIFLARE_WORKERD_PATH, CLOUDFLARED_PATH, WRANGLER_DOCKER_BIN,
//                 WRANGLER_C3_COMMAND, DOCKER_HOST, WRANGLER_DOCKER_HOST, ComSpec, PATHEXT, PATH
//   module/loader NODE_OPTIONS, NODE_PATH, VSCODE_INSPECTOR_OPTIONS, DYLD_*, LD_*, ELECTRON_*,
//                 WRANGLER_BUILD_CONDITIONS, WRANGLER_BUILD_PLATFORM, MINIFLARE_WORKERD_V8_FLAGS,
//                 MINIFLARE_WORKERD_AUTOGATES, ESBUILD_WORKER_THREADS, ESBUILD_MAX_BUFFER
//   settings/file XDG_CONFIG_HOME, XDG_CACHE_HOME, XDG_DATA_HOME, WRANGLER_CACHE_DIR,
//                 WRANGLER_REGISTRY_PATH, MINIFLARE_REGISTRY_PATH, MINIFLARE_CACHE_DIR,
//                 WRANGLER_LOG_PATH, WRANGLER_OUTPUT_FILE_PATH, WRANGLER_OUTPUT_FILE_DIRECTORY,
//                 WRANGLER_HTTPS_CERT_PATH, WRANGLER_HTTPS_KEY_PATH, CLOUDFLARE_ENV,
//                 CLOUDFLARE_INCLUDE_PROCESS_ENV, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV, DOTENV_KEY
//   endpoints     CLOUDFLARE_API_BASE_URL, CF_API_BASE_URL, WRANGLER_API_ENVIRONMENT,
//                 WRANGLER_AUTH_DOMAIN, WRANGLER_AUTH_URL, WRANGLER_TOKEN_URL, WRANGLER_REVOKE_URL,
//                 CLOUDFLARE_COMPLIANCE_REGION, CLOUDFLARE_CONTAINER_REGISTRY, SENTRY_DSN
//   trust         NODE_EXTRA_CA_CERTS, NODE_TLS_REJECT_UNAUTHORIZED, SSL_CERT_FILE, SSL_CERT_DIR
//   identity      CLOUDFLARE_API_TOKEN, CLOUDFLARE_API_KEY, CLOUDFLARE_EMAIL, CLOUDFLARE_ACCOUNT_ID,
//                 CF_API_TOKEN, CF_API_KEY, CF_EMAIL, CF_ACCOUNT_ID, CLOUDFLARE_ACCESS_CLIENT_ID,
//                 CLOUDFLARE_ACCESS_CLIENT_SECRET, WRANGLER_CF_AUTHORIZATION_TOKEN,
//                 WRANGLER_R2_SQL_AUTH_TOKEN, CF_PAGES_UPLOAD_JWT, WRANGLER_CLIENT_ID,
//                 CLOUDFLARE_CLIENT_ID, WRANGLER_CI_OVERRIDE_NAME, WRANGLER_CI_MATCH_TAG,
//                 WORKERS_CI_BRANCH, CF_PAGES_COMMIT_SHA
// Kept on purpose, because a machine behind a proxy cannot publish without them: the proxy variables.
//
// wrangler also reads variables from FILES: `.env` and `.env.local` in its working folder (loaded
// into its own process.env at start-up, cli.js `getDefaultEnvFiles`), and for `dev` a `.dev.vars` or
// `.env` beside the config. Such a file would bring back every name filtered above. Three things
// close that, for every command:
//   - `--env-file <a file TalkWeaver writes, empty>`: wrangler then loads that file and no default
//     one, at start-up and for `dev` (where a given env file also switches `.dev.vars` off);
//   - CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false and CLOUDFLARE_INCLUDE_PROCESS_ENV=false, fixed;
//   - every command runs in a folder of its own (`install.workDir`, inside user data but not user
//     data itself), which `prepareWranglerWorkDir` clears of `.env*` and `.dev.vars*` first.
//
// wrangler is a developer's tool and reads its surroundings by design: programs by name (`git`), a
// `wrangler.jsonc` or `.wrangler/deploy/config.json` in any folder above, the nearest `node_modules`
// for its cache, the home folder for a saved sign-in, the npm settings for its update check. The
// rule here is that it is given NONE of that: no program reachable by name, an app-written config
// for every command, a home, cache and settings folder inside the run folder
// (`wranglerRunFolder`, and the `fixed` part of `wranglerChildEnv`). scripts/test-wrangler-ambient-
// trace.mjs runs the real commands under a trace and fails if wrangler reads or starts anything else.
//
// Boundary: the launcher defends against variables and files that arrive from the person's shell, profile or stray tools. A party that can set the environment of the TalkWeaver process itself on Windows, or write inside TalkWeaver's user-data folder, is outside it: at that point the operating system's own loader and the app's own settings are already theirs. Within the boundary the rule is: wrangler is given no executable, credential source, endpoint setting or wrangler configuration that TalkWeaver did not write or ship; the ambient-access trace test enforces it. The live service is not set up with wrangler (ticket 11: the ladder's direct-API rung, for that command only): its Worker is compiled once when the app is built, into `worker-dist/` with a manifest (the wrangler version, the Worker's build string, a SHA-256 of the bundle), and uploaded with Cloudflare's API after the bundle is checked against the manifest, so nothing is compiled on the person's computer and no file outside the app can stop or change it. `wrangler dev` remains for tests and the unpackaged app. Publishing handouts uses the bundled wrangler's `pages deploy`, which starts no esbuild.
//
// No Electron import and erasable TypeScript only: the scripts in scripts/ import this file as is.
//
// When TalkWeaver quits, every tool still under way is ended with what it started
// (`endAllWranglerRuns`). Limit: On Windows a helper process that outlives the publishing tool's own
// process is not ended when TalkWeaver quits. (There a tree can be ended only through the tool's
// process id, and once the tool has exited that id may belong to another program.) Elsewhere: A
// helper that outlives the tool and has closed the output it inherited is not ended at quit. (With
// the tool gone and both its outputs closed, nothing proves its group's number is still that group's.)

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix, win32 } from 'node:path'

/** What the person is told when the bundled tool is not there. `details` says what is missing. */
export const WRANGLER_MISSING_MESSAGE = 'This TalkWeaver installation is incomplete'
/** What a run reports when wrangler printed more than the limit and was stopped. */
export const WRANGLER_OUTPUT_LIMIT_MESSAGE = 'The publishing tool printed far more than expected and was stopped.'
/** Per stream (stdout, stderr): the limit both Pages deploy calls had as `maxBuffer`. */
export const WRANGLER_MAX_OUTPUT_BYTES = 64 * 1024 * 1024
/** How much of the end of each stream a run keeps. wrangler prints its result (URL, error) last. */
export const WRANGLER_KEPT_OUTPUT_CHARS = 256 * 1024

export type WranglerInstall = {
  /** The executable that runs JavaScript: `process.execPath` (Electron in the app, Node in tests). */
  execPath: string
  /** The folder holding the app's `node_modules`: `app.getAppPath()` in the app, the repository in tests. */
  appRoot: string
  /** `process.platform`; decides the path separator, so Windows shapes can be resolved anywhere. */
  platform: string
  /**
   * The folder every wrangler command runs in: one the app makes for this alone (in the app,
   * `<user data>/wrangler-runs`; never user data itself). `prepareWranglerWorkDir` creates and clears it.
   */
  workDir: string
  /** Test seam; defaults to the file system. Asked about wrangler's entry script and, on Windows, the system folder. */
  exists?: (path: string) => boolean
}

export type WranglerEnvironment = {
  /** The environment the app itself runs in (`process.env`). Filtered: see the top of this file. */
  inherited?: NodeJS.ProcessEnv
  /** Variables this one command needs (credentials, a log path, test overrides). Passed as given. */
  set?: Record<string, string>
}

/**
 * TESTS ONLY (scripts/test-wrangler-ambient-trace.mjs): load `preload` into the wrangler process
 * before anything else and have it write what the run touched to `file`. It can be asked for only
 * through this argument, which the main process never passes; no environment variable turns it on
 * (the variable below only tells an already-loaded preload where to write).
 */
export type WranglerTrace = { preload: string; file: string }
export const TRACE_FILE_VARIABLE = 'TALKWEAVER_WRANGLER_TRACE_FILE'

export type WranglerLaunch = { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }
export type WranglerMissing = { ok: false; error: string; details: string }
export type WranglerLaunchResult = { ok: true; launch: WranglerLaunch } | WranglerMissing

// wrangler's command line is parsed by yargs, which drops ONE leading argument instead of two when
// it believes it is the main script of a packaged Electron app (`process.versions.electron` set and
// `process.defaultApp` unset). Under ELECTRON_RUN_AS_NODE that guess is wrong and wrangler fails
// with "Unknown argument: …/wrangler-dist/cli.js". Marking the process as a default app before
// wrangler loads restores the ordinary Node reading of argv. Harmless under plain Node.
const ARGV_FIX = 'data:text/javascript,process.defaultApp=true'

// What a child needs in order to run at all, and nothing that steers it. Compared without regard to
// case on Windows, where names are case-insensitive. The home folder is NOT inherited: see `fixed`.
const INHERITED_NAMES = [
  'USER', 'LOGNAME', 'USERNAME',
  'TMPDIR', 'TEMP', 'TMP',
  'SystemRoot', 'SystemDrive', 'windir',
  'LANG',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
]
const INHERITED_PREFIXES = ['LC_']
// Refused even when a call asks for them: they change how the Node that runs wrangler starts
// (preloaded code, module search, the dynamic loader, Electron's own switches).
const NEVER_SET = /^(?:NODE_|ELECTRON_|DYLD_|LD_)/i

const DEFAULT_WINDOWS_ROOT = 'C:\\Windows'

/**
 * The Windows folder to build PATH from. The inherited SystemRoot is checked, not trusted: it must be
 * an absolute drive-letter path with no `..` segment that holds System32\kernel32.dll and
 * System32\cmd.exe; anything else falls back to C:\Windows.
 */
export function windowsSystemRoot(inherited: NodeJS.ProcessEnv, exists: (path: string) => boolean = existsSync): string {
  const name = Object.keys(inherited).find((key) => key.toLowerCase() === 'systemroot')
  const root = name ? inherited[name] : undefined
  if (!root || !/^[A-Za-z]:[\\/]/.test(root)) return DEFAULT_WINDOWS_ROOT
  if (root.split(/[\\/]/).includes('..')) return DEFAULT_WINDOWS_ROOT
  const normal = win32.normalize(root).replace(/\\+$/, '')
  if (!exists(win32.join(normal, 'System32', 'kernel32.dll')) || !exists(win32.join(normal, 'System32', 'cmd.exe'))) return DEFAULT_WINDOWS_ROOT
  return normal
}

type RunFolder = Pick<WranglerInstall, 'workDir' | 'platform'>

/**
 * What the app writes inside the folder wrangler runs in. Everything wrangler would otherwise look
 * for around itself (programs, settings, caches, a home folder) is given to it here instead.
 */
export function wranglerRunFolder(install: RunFolder): {
  /** The empty file `--env-file` and git's config variables point at. */
  envFile: string
  /** macOS and Linux: the child's whole PATH. Always empty, so no program is found by name. */
  emptyPath: string
  /** The child's home folder (wrangler's sign-in, registry and log folders live under it). */
  home: string
  cache: string
  /** A config that is NOT a Pages config, and a redirect pointing at it: with both present in the
   *  working folder, `pages deploy` (which refuses `--config`) finds them first and never searches
   *  the folders above; it then ignores the config and deploys from its arguments, as before.
   *  The name must be `wrangler.json`: wrangler looks for that name in EVERY folder above before it
   *  looks for `wrangler.jsonc` anywhere. */
  pagesConfigStub: string
  pagesRedirect: string
  /** `pages deploy` takes the nearest `package.json` above it as the project and writes its scratch
   *  there. With one here, that is the run folder and no folder above is looked at. */
  packageJson: string
  /** esbuild resolves the Worker's entry file (an absolute path) from the folder wrangler runs in,
   *  and first asks the nearest `tsconfig.json` at or above that folder for a `paths` mapping. With
   *  an empty one here, that is the app's, and a tsconfig.json in a folder above cannot swap the
   *  entry file for another (scripts/test-worker-compile-integrity.mjs). */
  tsconfig: string
} {
  const path = install.platform === 'win32' ? win32 : posix
  return {
    envFile: path.join(install.workDir, 'talkweaver-no-dotenv.env'),
    emptyPath: path.join(install.workDir, 'empty-path'),
    home: path.join(install.workDir, 'home'),
    cache: path.join(install.workDir, 'cache'),
    pagesConfigStub: path.join(install.workDir, 'wrangler.json'),
    pagesRedirect: path.join(install.workDir, '.wrangler', 'deploy', 'config.json'),
    packageJson: path.join(install.workDir, 'package.json'),
    tsconfig: path.join(install.workDir, 'tsconfig.json'),
  }
}

/**
 * The environment a wrangler child runs in. Throws on a `set` name that changes how Node starts:
 * that is a mistake in the calling code, never something a person's machine can cause.
 */
export function wranglerChildEnv(
  install: RunFolder & Pick<WranglerInstall, 'exists'>, environment: WranglerEnvironment = {},
): NodeJS.ProcessEnv {
  const inherited = environment.inherited ?? {}
  const set = environment.set ?? {}
  const refused = Object.keys(set).filter((name) => NEVER_SET.test(name))
  if (refused.length) throw new TypeError(`wrangler launcher: ${refused.join(', ')} cannot be set for a wrangler command`)
  const windows = install.platform === 'win32'
  const path = windows ? win32 : posix
  const key = (name: string): string => (windows ? name.toUpperCase() : name)
  const allowed = new Set(INHERITED_NAMES.map(key))
  const windowsRoot = windows ? windowsSystemRoot(inherited, install.exists ?? existsSync) : ''
  const folder = wranglerRunFolder(install)
  // The launcher's own: a call cannot change these.
  const fixed: Record<string, string> = {
    ELECTRON_RUN_AS_NODE: '1',
    // No program is found by name. macOS and Linux: PATH is one folder the app keeps empty (Node
    // starts a shell by its absolute path, so `execSync` still works; `git` is then "not found",
    // which wrangler treats as "not a git repository"). Windows: the checked System32 only, where
    // there is no git, and the shell is the checked cmd.exe.
    PATH: windows ? win32.join(windowsRoot, 'System32') : folder.emptyPath,
    ...(windows ? { ComSpec: win32.join(windowsRoot, 'System32', 'cmd.exe') } : {}),
    // Should a git ever be reachable all the same: no settings of the person's, no repository above
    // the run folder (so no hook or fsmonitor of theirs runs with the token), no prompt.
    GIT_CONFIG_GLOBAL: folder.envFile,
    GIT_CONFIG_SYSTEM: folder.envFile,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: path.dirname(install.workDir),
    GIT_TERMINAL_PROMPT: '0',
    // wrangler's home is the app's, not the person's: its saved sign-in, its registry of local dev
    // servers, its logs and anything else it keeps under a home or settings folder.
    HOME: folder.home,
    USERPROFILE: folder.home,
    XDG_CONFIG_HOME: path.join(folder.home, '.config'),
    XDG_CACHE_HOME: path.join(folder.home, '.cache'),
    XDG_DATA_HOME: path.join(folder.home, '.local', 'share'),
    APPDATA: path.join(folder.home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(folder.home, 'AppData', 'Local'),
    // Otherwise wrangler looks upward for the nearest `node_modules` and keeps its cache there.
    WRANGLER_CACHE_DIR: folder.cache,
    // The banner brings an update check, which reads the person's npm settings and calls their registry.
    WRANGLER_HIDE_BANNER: 'true',
    // `wrangler dev` otherwise fetches https://workers.cloudflare.com/cf.json (what `request.cf` looks
    // like) on every start whose cache is older than 30 days; with this it uses its built-in placeholder.
    CLOUDFLARE_CF_FETCH_ENABLED: 'false',
    // No colour: what wrangler prints is read by the app (wrangler-failures.ts), not by a terminal.
    // wrangler's own text honours these (its chalk and supports-color copies: FORCE_COLOR=0 turns
    // colour off, NO_COLOR is the convention other parts follow). The error blocks wrangler formats
    // with esbuild are coloured regardless (cli.js `formatMessagesSync(…, { color: true })`), which is
    // why the reader of that output looks at the uncoloured place line only.
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    // No variables from `.env` files, and none of wrangler's own process.env, become Worker secrets.
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
    CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false',
  }
  const taken = new Set(['WRANGLER_SEND_METRICS', ...Object.keys(fixed), ...Object.keys(set)].map(key))
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined || taken.has(key(name))) continue
    if (!allowed.has(key(name)) && !INHERITED_PREFIXES.some((prefix) => key(name).startsWith(prefix))) continue
    // The child is told the same Windows folder its PATH was built from.
    env[name] = windows && (key(name) === 'SYSTEMROOT' || key(name) === 'WINDIR') ? windowsRoot : value
  }
  const asked = Object.fromEntries(Object.entries(set).filter(([name]) => !Object.keys(fixed).some((own) => key(own) === key(name))))
  return {
    ...env,
    // The app is not the person's own wrangler set-up: no usage reports unless a call asks.
    WRANGLER_SEND_METRICS: 'false',
    ...asked,
    ...fixed,
  }
}

/** The empty file wrangler is told to read instead of any `.env` (see the top of this file). */
export function wranglerEnvFilePath(install: RunFolder): string {
  return wranglerRunFolder(install).envFile
}

/**
 * Put `bytes` at `path` without ever letting a reader see a missing or half-written file: a file that
 * already holds exactly these bytes is left untouched (so a wrangler that is reading it right now is
 * not disturbed); anything else is replaced by writing a temporary file beside it and renaming it over.
 */
function writeStandIn(path: string, bytes: string): void {
  const holds = (): boolean => { try { return readFileSync(path, 'utf8') === bytes } catch { return false } }
  if (holds()) return
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(temporary, bytes, { flag: 'wx' })
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    // Windows refuses to rename over a file another process holds open. If that process (another
    // run of this function) has meanwhile put the right bytes there, the work is done.
    if (!holds()) throw error
  }
}

/**
 * Make the folder wrangler runs in ready for one command: create it and what the app keeps in it
 * (`wranglerRunFolder`), remove every `.env*` and `.dev.vars*` (never the app's own env file, whose
 * name does not start that way), keep the PATH folder empty, and make sure the files wrangler is
 * pointed at hold what they should. Safe while another wrangler runs in the same folder: the app's
 * own files are written once and then left alone. Returns the folder. `runWrangler` and
 * `prepareWranglerRun` call it; nothing else needs to.
 */
export function prepareWranglerWorkDir(install: RunFolder): string {
  const folder = wranglerRunFolder(install)
  for (const dir of [install.workDir, folder.home, folder.cache, folder.emptyPath, dirname(folder.pagesRedirect)]) mkdirSync(dir, { recursive: true })
  const own = new Set(Object.values(folder))
  for (const name of readdirSync(install.workDir)) {
    const path = join(install.workDir, name)
    if (/^\.(?:env|dev\.vars)(?:\.|$)/i.test(name) && !own.has(path)) rmSync(path, { recursive: true, force: true })
  }
  for (const name of readdirSync(folder.emptyPath)) rmSync(join(folder.emptyPath, name), { recursive: true, force: true })
  writeStandIn(folder.envFile, '')
  writeStandIn(folder.pagesConfigStub, '{}\n')
  writeStandIn(folder.pagesRedirect, '{ "configPath": "../../wrangler.json" }\n')
  writeStandIn(folder.packageJson, '{ "private": true }\n')
  writeStandIn(folder.tsconfig, '{}\n')
  return install.workDir
}

/** Absolute path of wrangler's entry script inside an installation. */
export function wranglerEntryPath(install: Pick<WranglerInstall, 'appRoot' | 'platform'>): string {
  const path = install.platform === 'win32' ? win32 : posix
  // The package's main entry (`exports["."]`). Its `bin/wrangler.js` only re-spawns this file in a
  // second process; starting it directly means a kill reaches wrangler itself on every platform.
  return path.join(install.appRoot, 'node_modules', 'wrangler', 'wrangler-dist', 'cli.js')
}

/**
 * Resolve the executable, arguments, environment and working folder for one wrangler command.
 * Pure: it touches no file. Whoever starts the process uses `prepareWranglerRun` (or `runWrangler`),
 * which makes the working folder ready first.
 */
export function resolveWranglerLaunch(
  install: WranglerInstall, wranglerArgs: readonly string[], environment: WranglerEnvironment = {}, trace?: WranglerTrace,
): WranglerLaunchResult {
  const env = wranglerChildEnv(install, environment)
  if (trace) env[TRACE_FILE_VARIABLE] = trace.file
  const entry = wranglerEntryPath(install)
  if (!(install.exists ?? existsSync)(entry)) {
    return {
      ok: false,
      error: WRANGLER_MISSING_MESSAGE,
      details: `The publishing tool that ships with TalkWeaver was not found at ${entry}. Install TalkWeaver again.`,
    }
  }
  return {
    ok: true,
    launch: {
      command: install.execPath,
      // `--env-file` comes LAST: it takes a list, so placed before the command it would swallow the
      // command name as a second file.
      args: [
        '--no-warnings', ...(trace ? ['--require', trace.preload] : []), '--import', ARGV_FIX,
        entry, ...wranglerArgs, '--env-file', wranglerEnvFilePath(install),
      ],
      env,
      cwd: install.workDir,
    },
  }
}

/** `resolveWranglerLaunch`, after making the working folder ready: for callers that start the process themselves. */
export function prepareWranglerRun(
  install: WranglerInstall, wranglerArgs: readonly string[], environment: WranglerEnvironment = {}, trace?: WranglerTrace,
): WranglerLaunchResult {
  const resolved = resolveWranglerLaunch(install, wranglerArgs, environment, trace)
  if (resolved.ok) prepareWranglerWorkDir(install)
  return resolved
}

export type WranglerRun = {
  ok: boolean
  /** The end of what wrangler printed (at most WRANGLER_KEPT_OUTPUT_CHARS per stream). */
  stdout: string
  stderr: string
  missing?: WranglerMissing
  /** Set when the command was stopped for printing more than the limit; `stderr` ends with the message. */
  outputLimitExceeded?: true
  /** Set when the command was stopped at its time limit; `stderr` ends with the message. */
  timedOut?: true
}

export const WRANGLER_TIMED_OUT_MESSAGE = 'The publishing tool took too long and was stopped.'
/** How long one command may run. */
export const WRANGLER_TIME_LIMIT_MS = 180_000
/** After the time limit the tool is asked to stop (SIGTERM); this much later it is killed (SIGKILL). */
export const WRANGLER_KILL_GRACE_MS = 5_000
/** After the kill the run is answered this much later at the latest, whether or not the process was seen to go. */
export const WRANGLER_KILL_DEADLINE_MS = 3_000
/** After the tool has exited, how long what it printed last may still arrive before the run is answered without it. */
export const WRANGLER_DRAIN_MS = 2_000

/** The part of a child process `runWrangler` uses; `spawn` satisfies it, and a test can fake it. */
export type WranglerChild = {
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown }
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown }
  stdin: { on(event: 'error', listener: (error: Error) => void): unknown; end(input: string): unknown }
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: (code: number | null) => void): unknown
  on(event: 'exit', listener: (code: number | null) => void): unknown
  kill(signal?: NodeJS.Signals): unknown
  /** The process id, when there is one: on Windows the whole tree under it is ended at the time limit. */
  pid?: number
  /** Started as the leader of a process group of its own (not Windows): signals go to the whole group. */
  group?: boolean
}

/**
 * Start the tool. Everywhere but Windows it leads a process group of its own (`detached`), so that
 * a signal can be sent to it AND to every process it started (esbuild, workerd): a signal to the
 * tool alone leaves those running, holding its output open. `detached` changes nothing else: the
 * environment and the working folder are the launch's, exactly as before. On Windows a group is a
 * new console window, so the tree is ended with `taskkill /T /F` instead.
 */
/**
 * Ending a process tree on Windows: `taskkill /pid <pid> /T /F`, by the ABSOLUTE path of taskkill
 * inside the Windows folder this launcher already checks (`windowsSystemRoot`), never by its bare
 * name (which would be looked up along PATH and in the working folder, where a planted
 * `taskkill.exe` could be found first). It is started in that System32 folder, with the launcher's
 * own allowlisted environment and nothing the call set (no credential is handed to it), and never
 * through a shell.
 */
export function taskkillCommand(
  install: RunFolder & Pick<WranglerInstall, 'exists'>, inherited: NodeJS.ProcessEnv, pid: number,
): { command: string; args: string[]; options: { cwd: string; env: NodeJS.ProcessEnv; stdio: 'ignore'; windowsHide: true; shell: false } } {
  const system32 = win32.join(windowsSystemRoot(inherited, install.exists ?? existsSync), 'System32')
  return {
    command: win32.join(system32, 'taskkill.exe'),
    args: ['/pid', String(Math.trunc(pid)), '/T', '/F'],
    options: { cwd: system32, env: wranglerChildEnv({ ...install, platform: 'win32' }, { inherited }), stdio: 'ignore', windowsHide: true, shell: false },
  }
}

/**
 * The runs under way: every tool `runWrangler` started, from its start until the run has been
 * answered and its group cleared up. `exited`: the tool's own process has gone (its last output may
 * still be awaited, and something it started may still be alive).
 */
type LiveRun = {
  child: WranglerChild; install: WranglerInstall; inherited: NodeJS.ProcessEnv; exited: boolean; killTree?: (pid: number) => void
  /** How many of the tool's two outputs have not closed yet. While one is open, a member of its group is alive. */
  openPipes: number
  /** Send `signal` to the process group `pid` leads (a test's seam; `process.kill(-pid, signal)`). */
  signalGroup: (pid: number, signal: NodeJS.Signals) => void
}
const liveRuns = new Set<LiveRun>()
let exitHookSet = false

/**
 * End every publishing tool this process started and has not finished with, AT ONCE and without
 * waiting: for the moment TalkWeaver quits. A tool leads a process group of its own (so that it can
 * be stopped together with what it started), which also means it would otherwise go on uploading
 * after the app has gone. Synchronous. Called from the app's quit path, and as the last resort when
 * this process exits. Answers how many runs something was sent to.
 *   Everywhere but Windows: SIGKILL to the tool's process GROUP while the tool's own process is
 *   alive; and, once it has exited, only while one of its two outputs is still open. An open output
 *   proves a member of that group is still alive, so the group's number is still that group's. Once
 *   both have closed the group may be empty and its number given to an unrelated group: nothing is
 *   sent. (A helper that outlives the tool and has closed the output it inherited is not ended at quit.)
 *   On Windows: the tree under the tool is ended (`taskkill /T /F`, by absolute path) only while
 *   the tool's own process is alive. Once it has exited its process id may be given to another
 *   program, so nothing is sent. On Windows a helper process that outlives the publishing tool's own process is not ended when TalkWeaver quits.
 * (`wrangler dev` started through `prepareWranglerRun` is not one of these runs and is not touched.)
 */
/** The group's number is known to be that group's: its leader is alive, or one of its outputs is still open. */
const groupIsStillTheirs = (run: LiveRun): boolean => !run.exited || run.openPipes > 0

export function endAllWranglerRuns(): number {
  let ended = 0
  for (const run of [...liveRuns]) {
    liveRuns.delete(run)
    const pid = run.child.pid
    let sent = false
    try {
      if (run.install.platform === 'win32') {
        if (!run.exited && typeof pid === 'number') {
          if (run.killTree) run.killTree(pid)
          else {
            const kill = taskkillCommand(run.install, run.inherited, pid)
            spawnSync(kill.command, kill.args, { ...kill.options, timeout: 5_000 })
          }
          sent = true
        }
      } else if (run.child.group && typeof pid === 'number' && groupIsStillTheirs(run)) {
        sent = true
        run.signalGroup(pid, 'SIGKILL') // ESRCH: nobody is left in the group
      }
    } catch { /* already gone */ }
    // The tool itself, by its own handle (never by a number), and only while it runs.
    if (!run.exited && !(run.install.platform === 'win32' && sent)) { try { run.child.kill('SIGKILL'); sent = true } catch { /* already gone */ } }
    if (sent) ended += 1
  }
  return ended
}

export function startWranglerProcess(launch: WranglerLaunch, platform: string): WranglerChild {
  const grouped = platform !== 'win32'
  const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: grouped })
  return Object.assign(child, { group: grouped }) as unknown as WranglerChild
}

/**
 * Run one wrangler command to completion. `missing` is set when the bundled tool is not there
 * (nothing was started). `input` is written to standard input, which is how secrets are passed.
 * Only the end of each output stream is kept, and a command that prints more than
 * `maxOutputBytes` on either stream is stopped and reported as failed.
 *
 * Time limit, and no wait without one. At `timeoutMs` the tool AND everything it started are asked
 * to stop (SIGTERM to its process group; on Windows the tree is ended with `taskkill /T /F`), and
 * `killGraceMs` later killed (SIGKILL to the group). The run is answered when the tool's process
 * has EXITED (its `exit`, not the closing of its output, which a process it started can hold open
 * for ever): so a caller that runs one command after another (the site's upload queue) does not
 * start the next while this one is still sending. After `exit`, what was printed last has
 * `drainMs` to arrive. And `killDeadlineMs` after the kill the run is answered as timed out
 * whether or not any event arrived (a kill is not refused by a process, but an event can be lost):
 * its output pipes are destroyed and the group is killed once more. In every outcome the group is
 * killed when the run is answered, so nothing the tool started outlives it.
 */
export function runWrangler(
  install: WranglerInstall,
  wranglerArgs: readonly string[],
  options: WranglerEnvironment & {
    input?: string
    timeoutMs?: number
    killGraceMs?: number
    killDeadlineMs?: number
    drainMs?: number
    maxOutputBytes?: number
    /** Test seam: signals a process group; defaults to `process.kill(-pid, signal)`. */
    signalGroup?: (pid: number, signal: NodeJS.Signals) => void
    /** Test seam: ends a process tree on Windows; defaults to starting `taskkillCommand(...)`. */
    killTree?: (pid: number) => void
    /** Test seam; defaults to making the working folder ready and starting the real process. */
    start?: (launch: WranglerLaunch) => WranglerChild
  } = {},
): Promise<WranglerRun> {
  const resolved = resolveWranglerLaunch(install, wranglerArgs, options)
  if (!resolved.ok) return Promise.resolve({ ok: false, stdout: '', stderr: resolved.details, missing: resolved })
  const start = options.start ?? ((launch: WranglerLaunch): WranglerChild => {
    prepareWranglerWorkDir(install)
    return startWranglerProcess(launch, install.platform)
  })
  const limit = options.maxOutputBytes ?? WRANGLER_MAX_OUTPUT_BYTES
  return new Promise((resolveRun) => {
    const child = start(resolved.launch)
    // Known to `endAllWranglerRuns` from now until the run is answered and its group cleared up (`finish`): it must not outlive the app.
    const live: LiveRun = {
      child, install, inherited: options.inherited ?? {}, exited: false, killTree: options.killTree, openPipes: 2,
      signalGroup: options.signalGroup ?? ((pid, name) => { process.kill(-pid, name) }),
    }
    for (const stream of [child.stdout, child.stderr] as unknown as Array<{ on(event: 'close', listener: () => void): unknown }>) {
      let open = true
      stream.on('close', () => { if (open) { open = false; live.openPipes -= 1 } })
    }
    liveRuns.add(live)
    if (!exitHookSet) { exitHookSet = true; process.on('exit', () => { endAllWranglerRuns() }) }
    const kept = { stdout: '', stderr: '' }
    const seen = { stdout: 0, stderr: 0 }
    let settled = false
    let timedOut = false
    /** The tool's process has gone: nothing is signalled by its process id any more. */
    let exited = false
    let hardKill: ReturnType<typeof setTimeout> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    let drain: ReturnType<typeof setTimeout> | undefined
    /** A signal to the tool and, where it leads a group, to every process it started. */
    const signal = (name: NodeJS.Signals): void => {
      if (child.group && typeof child.pid === 'number' && groupIsStillTheirs(live)) {
        try { live.signalGroup(child.pid, name); return } catch { /* the group is gone, or was never made: the tool itself, below */ }
      }
      try { child.kill(name) } catch { /* already gone */ }
    }
    const finish = (run: WranglerRun): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(hardKill)
      clearTimeout(deadline)
      clearTimeout(drain)
      // Nothing the tool started outlives the run; and nothing more is read from it. (The GROUP is
      // named by the tool's process id, which stays the group's for as long as any member lives.)
      // (Only while that number is known to be this group's: `groupIsStillTheirs`.)
      if (child.group && typeof child.pid === 'number' && groupIsStillTheirs(live)) { try { live.signalGroup(child.pid, 'SIGKILL') } catch { /* nothing left */ } }
      for (const stream of [child.stdout, child.stderr] as Array<{ destroy?: () => void }>) { try { stream.destroy?.() } catch { /* closed */ } }
      // Off the quit list only now, after the group has been cleared up.
      liveRuns.delete(live)
      resolveRun(run)
    }
    const stopped = (): WranglerRun => ({ ok: false, stdout: kept.stdout, stderr: `${kept.stderr}\n${WRANGLER_TIMED_OUT_MESSAGE}`, timedOut: true })
    const stopTree = options.killTree ?? ((pid: number): void => {
      // By absolute path inside the checked Windows folder, never by bare name (`taskkillCommand`).
      const kill = taskkillCommand(install, options.inherited ?? {}, pid)
      spawn(kill.command, kill.args, kill.options).on('error', () => { /* the kill below still ends the tool itself */ })
    })
    const timer = setTimeout(() => {
      // Already gone (its last output is being awaited): nothing is sent to a process id that is no longer its own.
      if (exited) return
      timedOut = true
      if (install.platform === 'win32' && typeof child.pid === 'number') { try { stopTree(child.pid) } catch { /* fall through to kill */ } }
      signal('SIGTERM')
      hardKill = setTimeout(() => {
        signal('SIGKILL')
        // No path waits without a deadline: answered now at the latest, seen to exit or not.
        deadline = setTimeout(() => finish(stopped()), options.killDeadlineMs ?? WRANGLER_KILL_DEADLINE_MS)
      }, options.killGraceMs ?? WRANGLER_KILL_GRACE_MS)
    }, options.timeoutMs ?? WRANGLER_TIME_LIMIT_MS)
    const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer | string): void => {
      if (settled) return
      seen[stream] += chunk.length
      kept[stream] = `${kept[stream]}${String(chunk)}`.slice(-WRANGLER_KEPT_OUTPUT_CHARS)
      if (seen[stream] <= limit) return
      child.kill('SIGKILL')
      finish({ ok: false, stdout: kept.stdout, stderr: `${kept.stderr}\n${WRANGLER_OUTPUT_LIMIT_MESSAGE}`, outputLimitExceeded: true })
    }
    child.stdout.on('data', collect('stdout'))
    child.stderr.on('data', collect('stderr'))
    child.stdin.on('error', () => { /* wrangler exited before reading its input; `close` reports it */ })
    child.on('error', (error) => finish({ ok: false, stdout: kept.stdout, stderr: `${kept.stderr}\n${error.message}` }))
    const ended = (code: number | null): WranglerRun => (timedOut ? stopped() : { ok: code === 0, stdout: kept.stdout, stderr: kept.stderr })
    // Answered when the PROCESS has exited. Its output usually closes with it (`close`); when a
    // process it started holds the output open, `close` may never come, so what was printed last
    // is waited for only `drainMs`.
    child.on('exit', (code) => {
      // Marked as gone at once, before any draining: its process id is no longer its own (on
      // Windows nothing is sent to it from here on). Its GROUP stays on the quit list until `finish`.
      live.exited = true
      exited = true
      drain = setTimeout(() => finish(ended(code)), options.drainMs ?? WRANGLER_DRAIN_MS)
    })
    child.on('close', (code) => finish(ended(code)))
    child.stdin.end(options.input ?? '')
  })
}

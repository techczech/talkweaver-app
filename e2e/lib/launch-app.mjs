// New Electron E2E scripts must launch through this helper.
import { cpSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { ensureFreshBuild } from './ensure-fresh-build.mjs'
import { testProfileEnv } from './test-profile.mjs'

const repo = fileURLToPath(new URL('../../', import.meta.url))
const active = new WeakMap()

function inside(root, path) {
  const fromRoot = relative(root, path)
  return fromRoot !== '' && !isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith('..' + sep)
}

function profileEnvironment(root, userData, home, temp, markers, env) {
  if (!inside(root, userData)) throw new Error('Electron test profile must be inside its scratch folder')
  mkdirSync(home, { recursive: true })
  mkdirSync(userData, { recursive: true })
  const profile = realpathSync(userData)
  if (!inside(root, profile)) throw new Error('Electron test profile resolves outside its scratch folder')
  // A GUI launch and its CLI siblings may use the same seeded profile in one test.
  if (!markers.has(profile)) markers.set(profile, testProfileEnv(profile))
  const variables = {
    ...env, ...markers.get(profile), TW_E2E: '1',
    HOME: home, USERPROFILE: home, CFFIXED_USER_HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'), XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local/share'),
    TMPDIR: temp, TMP: temp, TEMP: temp,
  }
  delete variables.ELECTRON_RUN_AS_NODE
  return variables
}

function ownFolder(prefix) {
  const path = mkdtempSync(join(realpathSync(dirname(prefix)), basename(prefix)))
  const owner = lstatSync(path)
  return {
    path,
    remove() {
      const current = lstatSync(path, { throwIfNoEntry: false })
      if (!current) return
      if (!current.isDirectory() || current.dev !== owner.dev || current.ino !== owner.ino) {
        throw new Error('Electron test scratch directory identity changed: ' + path)
      }
      rmSync(path, { recursive: true, force: true, maxRetries: 3 })
    },
  }
}

/** Fixtures that seed a profile or make several launches can own one scope for the entire script. */
export function createAppScratch({ vault, profilePrefix } = {}) {
  const temp = ownFolder(join(tmpdir(), 'tw-app-'))
  let fixture
  try {
    // Fixtures with a path-bound guard can keep their original profile location.
    // The app rejects test network overrides when the profile lies outside the run temp directory.
    fixture = profilePrefix ? ownFolder(profilePrefix) : temp
  } catch (error) {
    temp.remove()
    throw error
  }
  const root = fixture.path
  function cleanFolders() {
    if (fixture === temp) temp.remove()
    else {
      try { fixture.remove() }
      finally { temp.remove() }
    }
  }
  const home = join(root, 'home')
  const userData = join(root, 'userData')
  const vaultPath = vault ? join(root, 'vault') : undefined
  const sessions = new Map()
  const markers = new Map()
  let closing
  function close() {
    return closing ??= (async () => {
      try {
        const results = await Promise.allSettled([...sessions.values()].map(stop => stop()))
        const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
        if (failures.length) throw new AggregateError(failures, 'Could not close Electron test processes')
      } finally {
        cleanFolders()
      }
    })()
  }
  try {
    if (vault) {
      cpSync(vault === 'example' ? join(repo, 'resources/example-vault') : resolve(vault), vaultPath, { recursive: true })
      mkdirSync(userData)
      writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaultRoot: vaultPath }))
    }
  } catch (error) {
    cleanFolders()
    throw error
  }
  const scratch = {
    root, home, userData, temp: temp.path, vault: vaultPath,
    env: (profile = userData, env = process.env) => profileEnvironment(root, profile, home, temp.path, markers, env),
    closeApp: app => sessions.get(app)?.() ?? Promise.resolve(),
    close,
    [Symbol.asyncDispose]: close,
  }
  active.set(scratch, sessions)
  return scratch
}

async function within(promise, ms) {
  let timer
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function stopApp(app, child, closed) {
  // Playwright may dispose its handle before the process and its output streams close.
  if (child.exitCode === null && child.signalCode === null) void app.close().catch(() => {})
  if (await within(closed, 5_000)) return

  // Playwright starts Electron in its own process group on POSIX. Kill only that group.
  try {
    if (process.platform === 'win32') child.kill('SIGKILL')
    else process.kill(-child.pid, 'SIGKILL')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
  if (!await within(closed, 5_000)) throw new Error('Electron test process did not close after SIGKILL')
}

export async function launchApp({
  vault, env, args, scratch, userData, executablePath, timeout, firstWindowOptions,
} = {}) {
  if (!executablePath) await ensureFreshBuild(repo)
  const ownsScratch = !scratch
  scratch ??= createAppScratch({ vault })
  const sessions = active.get(scratch)
  if (!sessions) throw new Error('Expected an Electron test scratch scope')
  let app
  let child
  let closed
  let artifactsDir
  let shutdown
  const stop = () => shutdown ??= (async () => {
    try {
      if (child) await stopApp(app, child, closed)
    } finally {
      if (artifactsDir) rmSync(artifactsDir, { recursive: true, force: true, maxRetries: 3 })
      sessions.delete(app)
    }
  })()
  const close = () => ownsScratch ? scratch.close() : stop()
  try {
    const profile = userData ?? scratch.userData
    const appEnv = scratch.env(profile, env)
    artifactsDir = mkdtempSync(join(scratch.root, 'artifacts-'))
    app = await electron.launch({
      cwd: repo, executablePath, timeout, artifactsDir,
      args: [...(args ?? (executablePath ? [] : ['.'])), '--user-data-dir=' + profile], env: appEnv,
    })
    child = app.process()
    closed = new Promise(resolve => child.once('close', resolve))
    sessions.set(app, stop)
    const page = await app.firstWindow(firstWindowOptions)
    return { app, page, paths: { root: scratch.root, home: scratch.home, temp: scratch.temp, vault: scratch.vault, userData: profile }, close, [Symbol.asyncDispose]: close }
  } catch (error) {
    try { await stop() }
    finally { if (ownsScratch) await scratch.close() }
    throw error
  }
}

export async function withApp(options, fn) {
  const run = await launchApp(options)
  try { return await fn(run) }
  finally { await run.close() }
}

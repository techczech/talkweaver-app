// The live service's shipped bundle, `worker-dist/` (ticket 11): built once when the app is built,
// checked before it is packaged. The app uploads these bytes and compiles nothing (see the header of
// src/main/live-service-upload.ts for what the folder holds and how the app checks it).
//
//   buildWorkerDist({ repo, outDir })  compiles worker/ with the repository's own wrangler (a dry-run
//                                      `deploy`, the same bundling a real `deploy` does) through the
//                                      app's launcher, and writes index.js, upload-config.json and
//                                      manifest.json into outDir (replacing what was there);
//   checkWorkerDist({ repo, distDir }) the problems that stop a build: the folder or a file missing,
//                                      a file empty, a file that does not match the manifest, or a
//                                      folder older than the Worker's sources.
//
// "Older than the sources" is decided by content, not by file times (a fresh checkout gives every
// file the same time, on every platform): the manifest records a digest of the Worker's sources and
// the wrangler version that compiled them, and the folder is stale when either has changed since.
// The digest reads every file the compile reads (worker/*.ts except tests, wrangler.jsonc,
// package.json, tsconfig.json) with line endings made LF and names sorted, so the same sources give
// the same digest on macOS and on Windows.
import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { liveWorkerDeployConfig, stripJsonComments } from '../../src/main/live-worker-deploy-config.ts'
import { prepareWranglerRun } from '../../src/main/wrangler-launcher.ts'
import { MANIFEST_FILE, MANIFEST_FORMAT, readShippedConfig, readShippedFiles, sha256, verifyShippedBundle } from '../../src/main/live-service-upload.ts'

export const MAIN_MODULE = 'index.js'
export const CONFIG_FILE = 'upload-config.json'
/** The fields of worker/wrangler.jsonc the upload uses. */
const UPLOAD_FIELDS = ['name', 'compatibility_date', 'compatibility_flags', 'durable_objects', 'migrations', 'observability']
const SOURCE_EXTRA = ['wrangler.jsonc', 'package.json', 'tsconfig.json']

/** The files the Worker's compile reads, by name, sorted. */
export function workerSourceFiles(workerDir) {
  const ts = readdirSync(workerDir).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts') && statSync(join(workerDir, name)).isFile())
  return [...ts, ...SOURCE_EXTRA.filter((name) => existsSync(join(workerDir, name)))].sort()
}

/** A digest of the Worker's sources: the same on every platform for the same text. */
export function workerSourceDigest(workerDir) {
  const hash = createHash('sha256')
  for (const name of workerSourceFiles(workerDir)) {
    const text = readFileSync(join(workerDir, name), 'utf8').replace(/\r\n/g, '\n')
    hash.update(`${name}\0${Buffer.byteLength(text)}\0`).update(text).update('\0')
  }
  return hash.digest('hex')
}

export function wranglerVersion(repo) {
  return JSON.parse(readFileSync(join(repo, 'node_modules', 'wrangler', 'package.json'), 'utf8')).version
}
export function workerBuildString(workerDir) {
  const build = /export const LIVE_WORKER_BUILD\s*=\s*'([^']+)'/.exec(readFileSync(join(workerDir, 'recovery-protocol.ts'), 'utf8'))?.[1]
  if (!build) throw new Error('worker/recovery-protocol.ts does not name LIVE_WORKER_BUILD')
  return build
}

/**
 * Compile the Worker and write the folder. Returns the manifest. Throws, with what wrangler printed,
 * when the compile fails or writes no bundle or an empty one.
 */
export function buildWorkerDist({ repo, outDir, workerDir = join(repo, 'worker') }) {
  const sources = workerSourceDigest(workerDir)
  // The compile runs in a folder INSIDE the repository, so the source comments esbuild writes into
  // the bundle are short relative paths (`../../worker/auth.ts`), the same on every machine.
  const runRoot = join(repo, `.worker-dist-build-${randomBytes(4).toString('hex')}`)
  const workDir = join(runRoot, 'runs')
  const compiled = join(runRoot, 'out')
  try {
    mkdirSync(workDir, { recursive: true })
    const configPath = join(workDir, 'live-worker-wrangler.build.jsonc')
    const shippedConfig = readFileSync(join(workerDir, 'wrangler.jsonc'), 'utf8')
    writeFileSync(configPath, JSON.stringify(liveWorkerDeployConfig(shippedConfig, workerDir, null)))
    const resolved = prepareWranglerRun({ execPath: process.execPath, appRoot: repo, platform: process.platform, workDir }, ['deploy', '--dry-run', '--outdir', compiled, '--config', configPath], { inherited: process.env })
    if (!resolved.ok) throw new Error(`the repository's wrangler cannot be started: ${resolved.error}. ${resolved.details}`)
    const { command, args, env, cwd } = resolved.launch
    const done = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 180_000, windowsHide: true })
    if (done.status !== 0) throw new Error(`compiling the Worker failed (exit ${done.status})\n${done.stdout}\n${done.stderr}`)
    const bundlePath = join(compiled, MAIN_MODULE)
    if (!existsSync(bundlePath)) throw new Error(`compiling the Worker wrote no ${MAIN_MODULE}\n${done.stdout}\n${done.stderr}`)
    const bundle = readFileSync(bundlePath)
    if (bundle.length === 0) throw new Error(`compiling the Worker wrote an empty ${MAIN_MODULE}`)

    const { manifest, configBytes } = workerDistFiles({ repo, workerDir, bundle, sources })
    // Written beside, then put in place: a half-written folder is never left where the app looks.
    const staged = `${outDir}.staged-${randomBytes(4).toString('hex')}`
    writeWorkerDist(staged, { manifestText: `${JSON.stringify(manifest, null, 2)}\n`, configBytes, bundle })
    mkdirSync(dirname(outDir), { recursive: true })
    rmSync(outDir, { recursive: true, force: true, maxRetries: 5 })
    renameSync(staged, outDir)
    return manifest
  } finally {
    rmSync(runRoot, { recursive: true, force: true, maxRetries: 5 })
  }
}

/** The upload settings (upload-config.json) as bytes, from worker/wrangler.jsonc. */
export function uploadConfigBytes(workerDir) {
  const parsed = JSON.parse(stripJsonComments(readFileSync(join(workerDir, 'wrangler.jsonc'), 'utf8')))
  const upload = Object.fromEntries(UPLOAD_FIELDS.filter((field) => field in parsed).map((field) => [field, parsed[field]]))
  const checked = readShippedConfig(upload)
  if (typeof checked === 'string') throw new Error(`worker/wrangler.jsonc: ${checked}`)
  return Buffer.from(`${JSON.stringify(upload, null, 2)}\n`)
}

/**
 * The manifest for a bundle (and the settings beside it). Tests use it to make a shipped folder from
 * any bytes. `wrangler`: the version to record; by default the installed wrangler's.
 */
export function workerDistFiles({ repo, workerDir = join(repo, 'worker'), bundle, sources = workerSourceDigest(workerDir), wrangler = wranglerVersion(repo) }) {
  const configBytes = uploadConfigBytes(workerDir)
  const manifest = {
    format: MANIFEST_FORMAT,
    wrangler,
    build: workerBuildString(workerDir),
    mainModule: MAIN_MODULE,
    configFile: CONFIG_FILE,
    files: {
      [MAIN_MODULE]: { sha256: sha256(bundle), bytes: bundle.length },
      [CONFIG_FILE]: { sha256: sha256(configBytes), bytes: configBytes.length },
    },
    sources,
  }
  return { manifest, manifestText: `${JSON.stringify(manifest, null, 2)}\n`, configBytes, bundle }
}

/** Write a shipped folder (index.js, upload-config.json, manifest.json) into `dir`. */
export function writeWorkerDist(dir, { manifestText, configBytes, bundle }) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, MAIN_MODULE), bundle)
  writeFileSync(join(dir, CONFIG_FILE), configBytes)
  writeFileSync(join(dir, MANIFEST_FILE), manifestText)
}

/** What stops a build, as sentences; empty when the folder is ready to ship. */
export function checkWorkerDist({ repo, distDir, workerDir = join(repo, 'worker') }) {
  if (!existsSync(distDir) || !statSync(distDir).isDirectory()) return [`${distDir} is missing: run npm run build:worker-dist`]
  if (readdirSync(distDir).length === 0) return [`${distDir} is empty: run npm run build:worker-dist`]
  const files = readShippedFiles((name) => (existsSync(join(distDir, name)) ? readFileSync(join(distDir, name)) : null))
  const verified = verifyShippedBundle(files.manifest, { bundle: files.bundle, config: files.config }, workerBuildString(workerDir))
  if (!verified.ok) return [`${verified.error} ${verified.details}`]
  const problems = []
  if (verified.manifest.sources !== workerSourceDigest(workerDir)) problems.push(`${distDir} is older than the Worker's sources in ${workerDir}: run npm run build:worker-dist`)
  if (verified.manifest.wrangler !== wranglerVersion(repo)) problems.push(`${distDir} was compiled with wrangler ${verified.manifest.wrangler}, and the repository now has ${wranglerVersion(repo)}: run npm run build:worker-dist`)
  return problems
}

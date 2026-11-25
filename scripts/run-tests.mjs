#!/usr/bin/env node
// Runs npm test scripts with bounded parallelism, continuing past failures.
//
//   node scripts/run-tests.mjs --tier unit            # one tier from scripts/test-tiers.json
//   node scripts/run-tests.mjs --tier all --jobs 2    # every tier
//   node scripts/run-tests.mjs test:beats test:tags   # named scripts
//   node scripts/run-tests.mjs --check                # only verify the tier file
//   node scripts/run-tests.mjs --tier dom --allow-dirty-tree  # local evidence experiments
//
// Tiers (scripts/test-tiers.json): unit = plain Node, dom = Playwright Chromium,
// e2e = Electron. "npm test" runs all three tiers. Before running anything,
// check that every tier entry names an npm script and belongs to one tier.
// Scripts listed under "serial" (wall-clock budget checks)
// run one at a time after the parallel pool, so CPU contention from other
// tests cannot push them over their budget. A script that exits 0 after printing a line
// "TEST NOT RUN: <reason>" (it cannot run on this computer) is counted as not run, not as a pass.
// Dependency-free on purpose.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from 'node:fs'
import { availableParallelism, cpus, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TIERS = ['unit', 'dom', 'e2e']
const E2E_GROUPS = ['e2e-release', 'e2e-extended']

function usage(message) {
  if (message) console.error(`run-tests: ${message}`)
  console.error(
    'usage: node scripts/run-tests.mjs [--tier unit|dom|e2e|e2e-release|e2e-extended|all] [--jobs N] [--tail LINES] [--timeout SECONDS] [--check] [script ...]',
  )
  console.error('  --allow-dirty-tree   allow this run to change the checkout')
  process.exit(2)
}

function parseArgs(argv) {
  const opts = {
    tier: null,
    jobs: typeof availableParallelism === 'function' ? availableParallelism() : cpus().length,
    tail: 40,
    timeout: 900,
    check: false,
    allowDirtyTree: false,
    names: [],
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? arg.split(/=(.*)/s) : [arg, undefined]
    const value = () => (inline !== undefined ? inline : argv[++i] ?? usage(`${flag} needs a value`))
    const int = () => {
      const n = Number(value())
      if (!Number.isInteger(n) || n < 0) usage(`${flag} must be a non-negative integer`)
      return n
    }
    if (flag === '--tier') opts.tier = value()
    else if (flag === '--jobs' || flag === '-j') opts.jobs = Math.max(1, int())
    else if (flag === '--tail') opts.tail = int()
    else if (flag === '--timeout') opts.timeout = int()
    else if (flag === '--check') opts.check = true
    else if (flag === '--allow-dirty-tree') opts.allowDirtyTree = true
    else if (flag === '--help' || flag === '-h') usage()
    else if (flag.startsWith('-')) usage(`unknown flag ${flag}`)
    else opts.names.push(arg)
  }
  if (opts.tier && ![...TIERS, ...E2E_GROUPS, 'all'].includes(opts.tier)) usage(`unknown tier "${opts.tier}"`)
  return opts
}

// The tier file is the suite inventory. npm scripts outside it can run by name.
function checkTiers(pkg, tiers) {
  const problems = []
  const where = new Map()
  for (const tier of TIERS) {
    if (!Array.isArray(tiers[tier])) {
      problems.push(`test-tiers.json has no "${tier}" array`)
      continue
    }
    for (const name of tiers[tier]) where.set(name, [...(where.get(name) ?? []), tier])
  }
  for (const [name, found] of where) {
    if (found.length > 1) problems.push(`${name} appears more than once in the tiers: ${found.join(', ')}`)
    if (!Object.hasOwn(pkg.scripts, name)) problems.push(`${name} is in scripts/test-tiers.json but is not an npm script`)
  }
  for (const name of tiers.serial ?? []) {
    if (!where.has(name)) problems.push(`${name} is listed under "serial" but is in no tier`)
  }
  for (const name of tiers.requiresNativeGallery ?? []) {
    if (!where.get(name)?.includes('unit')) problems.push(`${name} requires native Gallery but is not in the unit tier`)
  }
  if (!Array.isArray(tiers.e2eRelease) || tiers.e2eRelease.length === 0) {
    problems.push('test-tiers.json needs a non-empty "e2eRelease" array')
  } else {
    const release = new Set(tiers.e2eRelease)
    if (release.size !== tiers.e2eRelease.length) problems.push('duplicate scripts in "e2eRelease"')
    for (const name of release) {
      if (!where.get(name)?.includes('e2e')) problems.push(`${name} is in "e2eRelease" but not in the e2e tier`)
    }
    if (!tiers.e2e?.some((name) => !release.has(name))) problems.push('no scripts remain in the extended E2E group')
  }
  return problems
}

function makeRunTemp() {
  const path = mkdtempSync(join(realpathSync(tmpdir()), 'tw-run.'))
  const owner = lstatSync(path)
  // Also runs after the signal handler has stopped the active process groups.
  process.once('exit', () => {
    try {
      const current = lstatSync(path, { throwIfNoEntry: false })
      if (!current) return
      if (!current.isDirectory() || current.dev !== owner.dev || current.ino !== owner.ino) {
        throw new Error('directory identity changed')
      }
      rmSync(path, { recursive: true, force: true, maxRetries: 3 })
    } catch (error) {
      console.error(`run-tests: could not clean owned scratch ${path}: ${error.message}`)
      process.exitCode ||= 1
    }
  })
  return path
}

function tempEnvironment(path) {
  return { TMPDIR: path, TMP: path, TEMP: path }
}

// Each test runs in its own process group (POSIX), so a timeout or an interrupted run can kill
// the whole tree — npm, its shell and the test — not just the npm wrapper, whose descendants
// would otherwise keep the output pipes open and the run waiting.
const ownGroup = process.platform !== 'win32'
const running = new Set()
function killTree(child) {
  if (ownGroup && child.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); return } catch { /* group already gone */ }
  }
  try { child.kill('SIGKILL') } catch { /* already exited */ }
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    for (const child of running) killTree(child)
    process.exit(130)
  })
}

function runScript(name, timeoutSeconds, scratch) {
  return new Promise((resolve) => {
    mkdirSync(scratch)
    const started = Date.now()
    const chunks = []
    const child = spawn('npm', ['run', '-s', name], {
      cwd: root,
      env: { ...process.env, ...tempEnvironment(scratch), FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      detached: ownGroup,
    })
    running.add(child)
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.stderr.on('data', (chunk) => chunks.push(chunk))
    let timedOut = false
    let done = false
    const timer =
      timeoutSeconds > 0
        ? setTimeout(() => {
            timedOut = true
            killTree(child)
            // Do not wait for a descendant that survived the kill to close the pipes.
            setTimeout(() => finish(null), 5000).unref()
          }, timeoutSeconds * 1000)
        : null
    const finish = (code, error) => {
      if (done) return
      done = true
      running.delete(child)
      if (timer) clearTimeout(timer)
      let output = Buffer.concat(chunks).toString('utf8')
      if (error) output += `\n[run-tests] failed to start: ${error.message}`
      if (timedOut) output += `\n[run-tests] killed after ${timeoutSeconds}s timeout`
      const ok = code === 0 && !timedOut && !error
      const notRun = ok ? /^TEST NOT RUN: (.*)$/m.exec(output)?.[1] ?? null : null
      resolve({ name, ok, notRun, code, seconds: (Date.now() - started) / 1000, output })
    }
    child.on('error', (error) => finish(null, error))
    child.on('close', (code) => finish(code))
  })
}

async function runAll(names, jobs, timeout, serial, scratch) {
  // Parallel scripts first, then the serial ones alone; results keep input order.
  const order = [...names.keys()].sort((a, b) => serial.has(names[a]) - serial.has(names[b]))
  const firstSerial = order.findIndex((index) => serial.has(names[index]))
  const results = new Array(names.length)
  let next = 0
  let done = 0
  async function worker() {
    while (next < names.length) {
      const index = order[next]
      if (firstSerial !== -1 && next >= firstSerial && running > 0) {
        await Promise.race(inFlight)
        continue
      }
      next++
      running++
      const promise = runScript(names[index], timeout, join(scratch, index.toString(36)))
      inFlight.add(promise)
      const result = await promise
      inFlight.delete(promise)
      running--
      results[index] = result
      done++
      console.log(`[${String(done).padStart(String(names.length).length)}/${names.length}] ${result.notRun !== null ? 'not run' : result.ok ? 'pass' : 'FAIL'} ${result.name} (${result.seconds.toFixed(1)}s)`)
    }
  }
  let running = 0
  const inFlight = new Set()
  await Promise.all(Array.from({ length: Math.min(jobs, names.length) }, worker))
  return results
}

function tail(text, lines) {
  const all = text.replace(/\s+$/, '').split('\n')
  return (all.length > lines ? ['...', ...all.slice(-lines)] : all).join('\n')
}

function worktreeSnapshot() {
  const git = (...args) => execFileSync('git', ['--literal-pathspecs', ...args], { cwd: root, encoding: 'utf8' })
  const porcelain = git('status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames')
  const files = new Map()
  for (const entry of porcelain.split('\0').filter(Boolean)) {
    const status = entry.slice(0, 2)
    const path = entry.slice(3)
    const states = files.get(path) ?? []
    files.set(path, states)
    states.push(status)
    if (status === '??') continue
    // An existing modification can change bytes while keeping the same porcelain status.
    const stat = lstatSync(join(root, path), { throwIfNoEntry: false })
    const content = stat?.isSymbolicLink() ? readlinkSync(join(root, path))
      : stat?.isFile() ? git('hash-object', '--no-filters', '--', path) : null
    states.push(git('ls-files', '--stage', '-z', '--', path), stat?.mode, content)
  }
  return files
}

function changedPaths(before, after) {
  const paths = new Set([...before.keys(), ...after.keys()])
  return [...paths].filter((path) => JSON.stringify(before.get(path)) !== JSON.stringify(after.get(path))).sort()
}

function tempEntries() {
  return readdirSync(tmpdir()).filter((name) => /^(?:\.?tw-|talkweaver-|talk-weaver-)/.test(name)).sort()
}

const opts = parseArgs(process.argv.slice(2))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tiers = JSON.parse(readFileSync(join(root, 'scripts', 'test-tiers.json'), 'utf8'))

const problems = checkTiers(pkg, tiers)
if (problems.length) {
  console.error('run-tests: invalid scripts/test-tiers.json:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
if (opts.check) {
  const counts = TIERS.map((tier) => `${tier} ${tiers[tier].length}`).join(', ')
  const release = tiers.e2eRelease.length
  console.log(`run-tests: tier inventory is valid (${counts}; ${release} release, ${tiers.e2e.length - release} extended)`)
  process.exit(0)
}

const names = [...opts.names]
if (E2E_GROUPS.includes(opts.tier)) {
  const release = new Set(tiers.e2eRelease)
  names.push(...tiers.e2e.filter((name) => release.has(name) === (opts.tier === 'e2e-release')))
} else if (opts.tier) {
  names.push(...(opts.tier === 'all' ? TIERS.flatMap((tier) => tiers[tier]) : tiers[opts.tier]))
}
if (names.length === 0) usage('give --tier or script names')
const unknown = names.filter((name) => !(name in pkg.scripts))
if (unknown.length) usage(`unknown npm script(s): ${unknown.join(', ')}`)

const label = opts.tier ? `tier ${opts.tier}` : 'selected scripts'
console.log(`run-tests: ${names.length} script(s) from ${label}, ${opts.jobs} at a time`)
const beforeTree = opts.allowDirtyTree ? null : worktreeSnapshot()
const scratch = makeRunTemp()
const beforeTemp = new Set(tempEntries())
if (process.platform === 'darwin' &&
    tiers.requiresNativeGallery?.some(name => names.includes(name)) &&
    !existsSync(join(root, 'native/vault-gallery'))) {
  console.log('run-tests: building the native Gallery helper for this checkout')
  try {
    execFileSync('npm', ['run', 'build:gallery-native'], {
      cwd: root, env: { ...process.env, ...tempEnvironment(scratch) }, stdio: 'inherit',
    })
  } catch {
    console.error('run-tests: native Gallery helper build failed; see compiler output above')
    process.exit(1)
  }
}
if (pkg.scripts['generate:deck-styles']) {
  execFileSync(process.execPath, [
    '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/build-deck-styles.mjs',
  ], { cwd: root, stdio: 'inherit' })
}
const started = Date.now()
const results = await runAll(names, opts.jobs, opts.timeout, new Set(tiers.serial ?? []), scratch)
const failed = results.filter((result) => !result.ok)

for (const result of failed) {
  console.log(`\n----- FAIL ${result.name} (exit ${result.code ?? 'none'}) -- last ${opts.tail} lines -----`)
  console.log(tail(result.output, opts.tail))
}

const width = Math.max(6, ...results.map((result) => result.name.length))
console.log(`\n${'script'.padEnd(width)}  result  seconds`)
console.log(`${'-'.repeat(width)}  ------  -------`)
for (const result of results) {
  console.log(`${result.name.padEnd(width)}  ${(result.notRun !== null ? 'notrun' : result.ok ? 'pass' : 'FAIL').padEnd(6)}  ${result.seconds.toFixed(1).padStart(7)}`)
}
const wall = ((Date.now() - started) / 1000).toFixed(1)
const notRun = results.filter((result) => result.notRun !== null)
console.log(`\n${results.length - failed.length - notRun.length} passed, ${failed.length} failed, ${notRun.length} not run, ${wall}s wall clock`)
for (const result of notRun) console.log(`not run: ${result.name}: ${result.notRun}`)
if (failed.length) console.log(`failed: ${failed.map((result) => result.name).join(' ')}`)
for (const entry of tempEntries()) {
  if (!beforeTemp.has(entry)) console.log(`run-tests: new temporary entry ${JSON.stringify(entry)}`)
}
const changes = beforeTree === null ? [] : changedPaths(beforeTree, worktreeSnapshot())
if (changes.length) {
  console.error('run-tests: tests changed the repository:')
  for (const path of changes) console.error(`  - ${JSON.stringify(path)}`)
}
process.exit(failed.length || changes.length ? 1 : 0)

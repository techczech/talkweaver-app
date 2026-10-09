#!/usr/bin/env node
// Runs npm test scripts with bounded parallelism, continuing past failures.
//
//   node scripts/run-tests.mjs --tier unit            # one tier from scripts/test-tiers.json
//   node scripts/run-tests.mjs --tier all --jobs 2    # every tier
//   node scripts/run-tests.mjs test:beats test:tags   # named scripts
//   node scripts/run-tests.mjs --check                # only verify the tier file
//
// Tiers (scripts/test-tiers.json): unit = plain Node, dom = Playwright Chromium,
// e2e = Electron. Before running anything it checks that every script chained in
// the npm "test" script sits in exactly one tier, so a new test cannot be left
// out of CI silently. Scripts listed under "serial" (wall-clock budget checks)
// run one at a time after the parallel pool, so CPU contention from other
// tests cannot push them over their budget. Dependency-free on purpose.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { availableParallelism, cpus } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TIERS = ['unit', 'dom', 'e2e']

function usage(message) {
  if (message) console.error(`run-tests: ${message}`)
  console.error(
    'usage: node scripts/run-tests.mjs [--tier unit|dom|e2e|all] [--jobs N] [--tail LINES] [--timeout SECONDS] [--check] [script ...]',
  )
  process.exit(2)
}

function parseArgs(argv) {
  const opts = {
    tier: null,
    jobs: typeof availableParallelism === 'function' ? availableParallelism() : cpus().length,
    tail: 40,
    timeout: 900,
    check: false,
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
    else if (flag === '--help' || flag === '-h') usage()
    else if (flag.startsWith('-')) usage(`unknown flag ${flag}`)
    else opts.names.push(arg)
  }
  if (opts.tier && ![...TIERS, 'all'].includes(opts.tier)) usage(`unknown tier "${opts.tier}"`)
  return opts
}

// Every script in `npm test` must be in exactly one tier, and every tier entry
// must be a script in `npm test`. Returns a list of problems (empty = ok).
function checkTiers(pkg, tiers) {
  const problems = []
  const chained = pkg.scripts.test
    .split('&&')
    .map((part) => part.trim())
    .map((part) => {
      const match = /^npm run (?:-s )?([^\s]+)$/.exec(part)
      if (!match) problems.push(`npm test step is not a plain "npm run <script>": ${part}`)
      return match?.[1]
    })
    .filter(Boolean)
  const where = new Map()
  for (const tier of TIERS) {
    if (!Array.isArray(tiers[tier])) {
      problems.push(`test-tiers.json has no "${tier}" array`)
      continue
    }
    for (const name of tiers[tier]) where.set(name, [...(where.get(name) ?? []), tier])
  }
  for (const name of chained) {
    const found = where.get(name) ?? []
    if (found.length === 0) problems.push(`${name} is in npm test but in no tier (add it to scripts/test-tiers.json)`)
    if (found.length > 1) problems.push(`${name} is in more than one tier: ${found.join(', ')}`)
  }
  for (const name of tiers.serial ?? []) {
    if (!where.has(name)) problems.push(`${name} is listed under "serial" but is in no tier`)
  }
  const chainedSet = new Set(chained)
  for (const name of where.keys()) {
    if (!chainedSet.has(name)) problems.push(`${name} is in scripts/test-tiers.json but not chained in npm test`)
    if (!(name in pkg.scripts)) problems.push(`${name} is in scripts/test-tiers.json but is not an npm script`)
  }
  return problems
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
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const child of running) killTree(child)
    process.exit(130)
  })
}

function runScript(name, timeoutSeconds) {
  return new Promise((resolve) => {
    const started = Date.now()
    const chunks = []
    const child = spawn('npm', ['run', '-s', name], {
      cwd: root,
      env: { ...process.env, FORCE_COLOR: '0' },
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
      resolve({ name, ok: code === 0 && !timedOut && !error, code, seconds: (Date.now() - started) / 1000, output })
    }
    child.on('error', (error) => finish(null, error))
    child.on('close', (code) => finish(code))
  })
}

async function runAll(names, jobs, timeout, serial) {
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
      const promise = runScript(names[index], timeout)
      inFlight.add(promise)
      const result = await promise
      inFlight.delete(promise)
      running--
      results[index] = result
      done++
      console.log(`[${String(done).padStart(String(names.length).length)}/${names.length}] ${result.ok ? 'pass' : 'FAIL'} ${result.name} (${result.seconds.toFixed(1)}s)`)
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

const opts = parseArgs(process.argv.slice(2))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const tiers = JSON.parse(readFileSync(join(root, 'scripts', 'test-tiers.json'), 'utf8'))

const problems = checkTiers(pkg, tiers)
if (problems.length) {
  console.error('run-tests: scripts/test-tiers.json is out of sync with the npm "test" script:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
if (opts.check) {
  const counts = TIERS.map((tier) => `${tier} ${tiers[tier].length}`).join(', ')
  console.log(`run-tests: tiers cover every npm test script (${counts})`)
  process.exit(0)
}

const names = [...opts.names]
if (opts.tier) names.push(...(opts.tier === 'all' ? TIERS.flatMap((tier) => tiers[tier]) : tiers[opts.tier]))
if (names.length === 0) usage('give --tier or script names')
const unknown = names.filter((name) => !(name in pkg.scripts))
if (unknown.length) usage(`unknown npm script(s): ${unknown.join(', ')}`)

const label = opts.tier ? `tier ${opts.tier}` : 'selected scripts'
console.log(`run-tests: ${names.length} script(s) from ${label}, ${opts.jobs} at a time`)
const started = Date.now()
const results = await runAll(names, opts.jobs, opts.timeout, new Set(tiers.serial ?? []))
const failed = results.filter((result) => !result.ok)

for (const result of failed) {
  console.log(`\n----- FAIL ${result.name} (exit ${result.code ?? 'none'}) -- last ${opts.tail} lines -----`)
  console.log(tail(result.output, opts.tail))
}

const width = Math.max(6, ...results.map((result) => result.name.length))
console.log(`\n${'script'.padEnd(width)}  result  seconds`)
console.log(`${'-'.repeat(width)}  ------  -------`)
for (const result of results) {
  console.log(`${result.name.padEnd(width)}  ${(result.ok ? 'pass' : 'FAIL').padEnd(6)}  ${result.seconds.toFixed(1).padStart(7)}`)
}
const wall = ((Date.now() - started) / 1000).toFixed(1)
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${wall}s wall clock`)
if (failed.length) console.log(`failed: ${failed.map((result) => result.name).join(' ')}`)
process.exit(failed.length ? 1 : 0)

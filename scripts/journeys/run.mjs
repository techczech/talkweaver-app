// The start-to-finish journey: every stage in order, one line per check as it completes and one per stage,
// exit 1 on any failure. What passes is decided in policy.mjs: every check id in checks.mjs reported exactly
// once, no FAIL, COULD-NOT only as could-not-allowed.mjs allows. Each stage's output goes to
// artefacts/journey/<stage>.log; timings, with the machine and the run's scope, to
// artefacts/journey/timings/<time>.json and timings-latest.json.
//
//   npm run check:journey                                   the gate: every stage (macOS; needs npm run build:native && npm run build)
//   npm run check:journey -- --only section-colours,edit    a diagnostic subset: never prints PASSED, never qualifies
//
// Clean-up: each stage gets its state folder (user data, vault, recordings) and its TMPDIR under one temp folder
// made here, and a file where it writes the process ids, groups and start times of the apps and browsers it
// launches (lib.mjs). After a stage, on its time limit and on Ctrl-C the runner asks the stage to stop
// (SIGTERM, bounded), then stops exactly those recorded processes that are still the same processes (pid and
// start time; a group only while its recorded leader leads it; reap.mjs; never by name), waits for them to exit, and only then removes their state and single-instance folders. Paths the
// run owns that are still there afterwards fail the run; other new entries in the system temp dir are reported.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, createWriteStream, mkdtempSync, realpathSync, readlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir, cpus, totalmem, release } from 'node:os'
import { randomBytes } from 'node:crypto'
import { REPO, OUT_ROOT, procInfo, pause, recordAgainOn } from './lib.mjs'
import { requiredIds } from './checks.mjs'
import { COULD_NOT_ALLOWED } from './could-not-allowed.mjs'
import { parseSelection, judgeStage, judgeRun } from './policy.mjs'
import { reapProcesses } from './reap.mjs'
import { ensureFreshBuild } from '../../e2e/lib/ensure-fresh-build.mjs'

const RECORDING = 'recording'
// limit: the stage's own hard limit (TW_LIMIT_MS); the runner stops the stage 60 s after it.
const STAGES = [
  { name: 'section-colours', script: 'section-colours.mjs', limit: 240, app: false, tools: [] },
  { name: 'edit-present-share', script: 'edit-present-share.mjs', limit: 600, app: true, tools: ['pdfinfo', 'pdftotext', 'pdftoppm'] },
  { name: 'updates', script: 'updates.mjs', limit: 300, app: true, tools: [] },
  ...['record', 'edit', 'reopen', 'export', 'sentence', 'retake', 'second-mac', 'delete'].map((phase) => ({
    name: phase, script: 'record-edit-export.mjs', limit: phase === 'export' ? 900 : 540, app: true, chain: RECORDING, env: { TW_PHASE: phase }, tools: phase === 'export' ? ['ffprobe'] : [],
  })),
]
const ALL = STAGES.map((s) => s.name)

const sel = parseSelection(process.argv.slice(2), ALL)
if (sel.error) { console.error(`NO STAGES SELECTED: ${sel.error}`); process.exit(2) }
const chosen = STAGES.filter((s) => sel.names.includes(s.name))
const ctx = { recordAgain: await recordAgainOn() }

// Prerequisites, before anything runs: tools on PATH and a fresh build.
const missingTools = [...new Set(chosen.flatMap((s) => s.tools))].filter((t) => spawnSync('sh', ['-c', `command -v ${t}`]).status !== 0)
if (missingTools.length) { console.error(`missing on PATH: ${missingTools.join(', ')} (Homebrew: brew install poppler ffmpeg)`); process.exit(2) }
if (chosen.some((s) => s.app)) {
  if (process.platform !== 'darwin') { console.error('the app stages need macOS'); process.exit(2) }
  await ensureFreshBuild(REPO)
}

// A stage's environment: the runner's, without any inherited TW_ switch (TW_STEPS, TW_PHASE and the like would
// narrow a stage) except TW_RECORD_AGAIN, which turns a feature on and is recorded in the timings.
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TW_') || k === 'TW_RECORD_AGAIN'))
const runId = `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`

const listTemp = () => new Set(readdirSync(tmpdir()).filter((f) => f !== '.DS_Store'))
const tempBefore = listTemp()
const systemTemp = process.platform === 'darwin' ? spawnSync('getconf', ['DARWIN_USER_TEMP_DIR'], { encoding: 'utf8' }).stdout.trim() : ''
const listChromium = () => new Set(systemTemp && existsSync(systemTemp) ? readdirSync(systemTemp).filter((f) => f.startsWith('scoped_dir')) : [])
const chromiumBefore = listChromium()
const root = realpathSync(mkdtempSync(join(tmpdir(), 'tw-journey-run-')))
const ownedPaths = new Set([root])
const cleanupProblems = []

// ── Owned processes ─────────────────────────────────────────────────────────────────────────────────
const myGroup = procInfo(process.pid)?.pgid
const readOwned = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : [])
/** Stop the processes a stage recorded, only while each is still the process recorded (reap.mjs: pid and start
 *  time, a group only under its recorded leader), wait for them to exit, then remove their single-instance
 *  folders. Returns problems. */
async function reapOwned(file) {
  const entries = readOwned(file)
  const problems = []
  const { targets, left } = await reapProcesses({ entries, myGroup, wait: pause })
  for (const e of left) problems.push(`${e.kind} process ${e.pid} did not exit`)
  if (targets.length) console.log(`      clean-up: stopped ${targets.length} process(es) the stage left running: ${targets.map((e) => `${e.kind} ${e.pid}`).join(', ')}`)
  // Single-instance folders: recorded at launch, and read from each profile's link now.
  const singles = new Set(entries.filter((e) => e.kind === 'singleton').map((e) => e.path))
  for (const e of entries.filter((x) => x.userData)) { try { const t = readlinkSync(join(e.userData, 'SingletonSocket')); if (/\/scoped_dir[^/]+\/SingletonSocket$/.test(t)) singles.add(dirname(t)) } catch {} }
  for (const d of singles) { ownedPaths.add(d); if (problems.length === 0) rmSync(d, { recursive: true, force: true }) }
  return problems
}

let current = null // { child, ownedFile, closed: Promise, started: the stage's start time read at launch }
async function stopStage(reason) {
  if (!current) return []
  const { child, ownedFile, closed, started } = current
  // The stage's group is signalled only while the stage is still the process launched: not yet exited as Node
  // sees it, leading its own group, and showing the start time read at launch (a pid can be reused once reaped).
  const stillOurs = () => { if (child.exitCode !== null || child.signalCode !== null) return false; const p = procInfo(child.pid); return !!p && p.pgid === child.pid && p.pgid !== myGroup && !!started && p.started === started }
  if (stillOurs()) {
    console.error(`      ${reason}: asking the stage to stop`)
    try { process.kill(-child.pid, 'SIGTERM') } catch {}
    await Promise.race([closed, pause(15000)])
    if (stillOurs()) { try { process.kill(-child.pid, 'SIGKILL') } catch {} ; await Promise.race([closed, pause(5000)]) }
  }
  return reapOwned(ownedFile)
}
let interrupted = false
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, async () => {
  if (interrupted) { console.error('second signal: removing the run folder and leaving'); rmSync(root, { recursive: true, force: true }); process.exit(130) }
  interrupted = true
  console.error(`\n${sig}: stopping`)
  const problems = await stopStage(sig)
  for (const p of problems) console.error(`      clean-up: ${p}; state kept at ${root}`)
  if (!problems.length) rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  process.exit(130)
})

mkdirSync(OUT_ROOT, { recursive: true })
const git = (...a) => spawnSync('git', a, { cwd: REPO, encoding: 'utf8' }).stdout.trim()
const sysctl = (k) => spawnSync('sysctl', ['-n', k], { encoding: 'utf8' }).stdout?.trim() || null
const startedAt = new Date()
const verdicts = []
const results = []
const failedChains = new Set()
console.log(`journey on ${git('rev-parse', '--short', 'HEAD')}${git('status', '--porcelain') ? ' (uncommitted changes)' : ''}: ${sel.mode === 'full' ? 'FULL run' : 'SUBSET (diagnostic)'}, ${chosen.length} stages; record-again ${ctx.recordAgain ? 'on' : 'off'}; logs in artefacts/journey/; runner pid ${process.pid}, run folder ${root}`)

function runStage(stage, state, tmp, ownedFile) {
  const log = createWriteStream(join(OUT_ROOT, `${stage.name}.log`))
  const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--disable-warning=ExperimentalWarning', join(REPO, 'scripts', 'journeys', stage.script)], {
    cwd: REPO, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...baseEnv, TMPDIR: tmp, TW_JOURNEY_STATE: state, TW_JOURNEY_OWNED: ownedFile, TW_JOURNEY_RUN: runId, TW_LIMIT_MS: String(stage.limit * 1000), ...stage.env },
  })
  const t0 = Date.now()
  let lastLine = Date.now(), buf = ''
  child.stdout.on('data', (d) => {
    log.write(d); buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      if (/^(PASS|FAIL|COULD-NOT)\s/.test(line)) { console.log(`      ${line.slice(0, 220)}`); lastLine = Date.now() }
    }
  })
  child.stderr.on('data', (d) => log.write(d))
  const beat = setInterval(() => { if (Date.now() - lastLine > 60000) { console.log(`      … ${stage.name} still running, ${Math.round((Date.now() - t0) / 1000)} s`); lastLine = Date.now() } }, 5000)
  const closed = new Promise((done) => child.on('close', (code, signal) => { clearInterval(beat); log.end(); done({ code, signal }) }))
  current = { child, ownedFile, closed, started: procInfo(child.pid)?.started ?? null }
  let timedOut = false
  const killer = setTimeout(() => { timedOut = true; void stopStage(`${stage.name} passed its ${stage.limit + 60} s limit`) }, (stage.limit + 60) * 1000)
  return closed.then(async (r) => { clearTimeout(killer); const problems = await stopStage('stage ended'); current = null; return { ...r, timedOut, problems } })
}

const lastError = (name) => { try { return readFileSync(join(OUT_ROOT, `${name}.log`), 'utf8').split('\n').filter((l) => /error|Error|limit/.test(l)).at(-1)?.trim().slice(0, 240) ?? '' } catch { return '' } }

for (const stage of chosen) {
  const t0 = Date.now()
  const required = requiredIds(stage.name, ctx)
  // A stale ledger from an earlier run can never count: the folder goes before the stage starts.
  rmSync(join(OUT_ROOT, stage.name), { recursive: true, force: true })
  let verdict, exit = null
  console.log(`----  ${stage.name}: ${required.length} checks`)
  if (stage.chain && failedChains.has(stage.chain)) {
    verdict = { name: stage.name, ok: false, pass: 0, fail: 0, couldNot: 0, allowedCouldNot: 0, missing: required, problems: [`not run: an earlier ${stage.chain} stage broke`] }
  } else {
    const state = join(root, stage.chain || stage.name)
    const tmp = join(root, `tmp-${stage.name}`)
    const ownedFile = join(root, `owned-${stage.name}.jsonl`)
    mkdirSync(state, { recursive: true }); mkdirSync(tmp, { recursive: true })
    const { code, signal, timedOut, problems } = await runStage(stage, state, tmp, ownedFile)
    exit = timedOut ? 'time limit' : signal || code
    cleanupProblems.push(...problems.map((p) => `${stage.name}: ${p}`))
    if (!problems.length) rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    const ledgerFile = join(OUT_ROOT, stage.name, 'results.jsonl')
    const rows = existsSync(ledgerFile) ? readFileSync(ledgerFile, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return { id: null, raw: l } } }) : []
    verdict = judgeStage({ name: stage.name, required, rows, exit: timedOut ? 'time limit' : (signal || code), runId, allow: COULD_NOT_ALLOWED })
    if (!rows.length) verdict.problems.push(`no checks recorded: ${lastError(stage.name)}`)
    if (problems.length) { verdict.ok = false; verdict.problems.push(...problems.map((p) => `clean-up: ${p}`)) }
    if (!stage.chain && !problems.length) rmSync(state, { recursive: true, force: true, maxRetries: 3 })
    // The recording stages build on each other's state. A check that failed leaves that state usable, so the
    // next stages still run (and are judged); a stage that broke (bad exit, harness failure, checks it never
    // reached, clean-up trouble) stops the chain.
    const broke = exit !== 0 || !rows.length || verdict.missing.length > 0 || rows.some((r) => r.id === `${stage.name}.harness`) || problems.length > 0
    if (broke && stage.chain) failedChains.add(stage.chain)
  }
  // The recording stages share one state folder: removed once the last of them has run.
  if (stage.chain && chosen.filter((s) => s.chain === stage.chain).at(-1) === stage && !cleanupProblems.length) rmSync(join(root, stage.chain), { recursive: true, force: true, maxRetries: 3 })
  const seconds = +((Date.now() - t0) / 1000).toFixed(1)
  verdicts.push(verdict)
  results.push({ name: stage.name, result: verdict.ok ? 'PASS' : 'FAIL', seconds, exit, required: required.length, pass: verdict.pass, fail: verdict.fail, couldNot: verdict.couldNot, allowedCouldNot: verdict.allowedCouldNot, problems: verdict.problems })
  console.log(`${verdict.ok ? 'PASS' : 'FAIL'}  ${stage.name.padEnd(20)} ${String(seconds).padStart(6)} s  ${verdict.pass}/${required.length} passed, ${verdict.fail} failed, ${verdict.couldNot} could not check (${verdict.allowedCouldNot} allowed)${verdict.problems.length ? '\n      ' + verdict.problems.join('\n      ') : ''}`)
}

// Temp: the paths this run owns must be gone; anything else new in the temp dirs is reported, not failed.
if (!cleanupProblems.length) rmSync(root, { recursive: true, force: true, maxRetries: 3 })
const leftOwned = [...ownedPaths].filter((p) => existsSync(p))
const unrelatedTemp = [...listTemp()].filter((f) => !tempBefore.has(f))
const chromiumNew = [...listChromium()].filter((f) => !chromiumBefore.has(f))
const extraFailures = [...cleanupProblems]
if (leftOwned.length) extraFailures.push(`temp: left behind ${leftOwned.join(', ')}`)
console.log(leftOwned.length ? `FAIL  temp: the run left behind ${leftOwned.join(', ')}` : `PASS  temp: every path the run owned is gone (${ownedPaths.size} paths)`)
if (unrelatedTemp.length || chromiumNew.length) console.log(`NOTE  temp: new entries the run does not own (not failed; another app may have made them): ${[...unrelatedTemp, ...chromiumNew].join(', ')}`)
for (const p of cleanupProblems) console.log(`FAIL  clean-up: ${p}`)

const run = judgeRun({ mode: sel.mode, selected: chosen.map((s) => s.name), allNames: ALL, stages: verdicts, extraFailures })
const totalSeconds = +((Date.now() - startedAt) / 1000).toFixed(1)
const swVers = (k) => spawnSync('sw_vers', [k], { encoding: 'utf8' }).stdout?.trim() || null
const timings = {
  scope: sel.mode, stagesSelected: chosen.map((s) => s.name), verdict: run.verdict, qualifiesForRelease: run.qualifies, runId,
  commit: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), dirtyTree: !!git('status', '--porcelain'),
  recordAgain: ctx.recordAgain, startedAt: startedAt.toISOString(), totalSeconds,
  machine: { model: sysctl('hw.model'), cpu: cpus()[0]?.model ?? null, cores: cpus().length, memoryGB: Math.round(totalmem() / 2 ** 30), platform: process.platform, arch: process.arch, osVersion: swVers('-productVersion'), osBuild: swVers('-buildVersion'), kernel: release(), node: process.version },
  stages: results, tempLeftOwned: leftOwned, tempUnrelatedNew: [...unrelatedTemp, ...chromiumNew], cleanupProblems,
}
mkdirSync(join(OUT_ROOT, 'timings'), { recursive: true })
const stamp = startedAt.toISOString().replace(/[:.]/g, '-')
writeFileSync(join(OUT_ROOT, 'timings', `${stamp}.json`), JSON.stringify(timings, null, 2))
writeFileSync(join(OUT_ROOT, 'timings-latest.json'), JSON.stringify(timings, null, 2))
console.log(`${run.line} in ${totalSeconds} s; timings: artefacts/journey/timings/${stamp}.json`)
process.exitCode = run.exitCode

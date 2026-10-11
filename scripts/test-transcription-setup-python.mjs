// Integration (ticket 08, spec D16): the transcription script that ships in
// resources/agent-setup/transcription answers --help in a fresh Python environment built from the
// shipped requirements.txt, the way SETUP.md tells an agent to build it, and TalkWeaver's
// Transcription row reads that environment as Ready.
//
//   npm run test:transcription-setup:python
//
// Needs Python 3.10 or newer and the network (pip downloads the speech packages: about 600 MB on a
// Mac with Apple silicon, nothing elsewhere). Without Python it is skipped with a message. Not in
// `npm test`: it is slow and downloads; run it when the script or requirements.txt change.
// Everything is made in a throwaway folder; no speech model is fetched.
import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTranscriptionSetup } from '../src/main/transcription-setup.ts'
import { transcriptionRowLabel } from '../src/shared/transcription-status.ts'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const folder = join(repo, 'resources', 'agent-setup', 'transcription')
const windows = process.platform === 'win32'

/** The first Python 3.10+ on this computer, as [command, ...args], or null. */
function findPython() {
  const candidates = windows ? [['py', '-3'], ['python']] : [['python3'], ['python']]
  for (const [command, ...args] of candidates) {
    const probe = spawnSync(command, [...args, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8', timeout: 20_000, windowsHide: true })
    if (probe.status !== 0) continue
    const [major, minor] = probe.stdout.trim().split('.').map(Number)
    if (major === 3 && minor >= 10) return { command, args, version: probe.stdout.trim() }
  }
  return null
}

const found = findPython()
if (!found) {
  console.log('SKIP transcription set-up (Python): no Python 3.10 or newer on this computer (python3/python, or py -3 on Windows). Install one to run this test.')
  process.exit(0)
}

const scratch = mkdtempSync(join(tmpdir(), 'tw-transcription-python-'))
const run = (command, args, timeout = 120_000) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, windowsHide: true, cwd: scratch })
  return { ...result, all: `${result.stdout ?? ''}\n${result.stderr ?? ''}` }
}
try {
  console.log(`  Python ${found.version} (${[found.command, ...found.args].join(' ')})`)
  const venv = join(scratch, 'user-data', 'transcription', 'venv')
  const made = run(found.command, [...found.args, '-m', 'venv', venv])
  assert.equal(made.status, 0, `venv could not be created:\n${made.all}`)
  const python = windows ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python')
  assert.ok(existsSync(python), `the environment has no Python at ${python}`)
  console.log('  1. a fresh environment, as SETUP.md step 2 makes it')

  const installed = run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-r', join(folder, 'requirements.txt')], 20 * 60_000)
  assert.equal(installed.status, 0, `pip could not install the shipped requirements:\n${installed.all.slice(-4000)}`)
  const appleSilicon = process.platform === 'darwin' && process.arch === 'arm64'
  const engine = run(python, ['-c', 'import importlib.util, sys; sys.exit(0 if importlib.util.find_spec("parakeet_mlx") else 3)'])
  if (appleSilicon) assert.equal(engine.status, 0, `parakeet_mlx is not importable after installing requirements.txt:\n${engine.all}`)
  else assert.equal(engine.status, 3, 'off Apple silicon the requirements install no speech engine (MLX cannot run there)')
  console.log(`  2. requirements.txt installed (${appleSilicon ? 'parakeet-mlx present' : 'no engine on this platform, as the file says'})`)

  const help = run(python, [join(folder, 'parakeet_to_srt.py'), '--help'])
  assert.equal(help.status, 0, `the vendored script did not answer --help:\n${help.all}`)
  assert.match(help.stdout, /usage: parakeet_to_srt\.py/)
  assert.match(help.stdout, /-o OUTPUT, --output OUTPUT/, 'the arguments TalkWeaver passes (<audio> -o <out.srt>) are the script\'s')
  console.log('  3. the vendored script answers --help in that environment')

  // The row, for exactly what SETUP.md step 6 sets, with a stand-in ffmpeg (ffmpeg is not this test's subject).
  const setup = createTranscriptionSetup({
    read: () => ({ python, script: join(folder, 'parakeet_to_srt.py'), ffmpeg: '' }),
    write: () => {},
    shippedFfmpeg: () => [python], // any file that exists
    systemFfmpeg: () => [],
    setupFolder: () => folder,
    userData: () => join(scratch, 'user-data'),
  })
  const row = await setup.status()
  assert.equal(row.state, 'ready')
  assert.equal(row.pythonVersion, found.version, 'the version is read from the environment')
  console.log(`  4. Settings → Transcription reads "${transcriptionRowLabel(row)}"`)
  console.log('\nPASS transcription set-up (Python)')
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
}

// Transcription, optional and set up from what ships (src/main/transcription-setup.ts,
// src/main/ffmpeg-path.ts, src/shared/transcription-status.ts; spec "Cloudflare set-up in the app",
// D16; ticket 08). Plain Node, fixture paths in a throwaway folder, no network:
// 1. the status function: every state of the row from fixture paths, in D16's words;
// 2. nothing configured: "Not set up — optional", and the action says where to set it up;
// 3. the ffmpeg resolver: the path set in Settings, else the shipped one, else the system's;
//    Windows names and no system places there; the engine's PATH on Windows;
// 4. the set-up operations (what Settings and `setup transcription` call): setPaths, the version
//    read from the environment without running Python, the agent prompt;
// 5. Settings text, the row's words, the prompt and the shipped steps name no path, skill or person
//    from Dominik's machines;
// 6. what ships: the set-up folder and ffmpeg in the build config, the vendored script against its
//    provenance note, and the package check (missing ffmpeg; an unredistributable one in an installer);
// 7. the real shipped ffmpeg (node_modules/ffmpeg-static), when installed: chosen with no path set,
//    and it makes the WAV transcription makes (one segment, and two with a silence between);
// 8. the pinned macOS ffmpeg (ADR-0003, amendment of 2026-10-09): the committed pin and the addresses
//    it refuses, the package check against the pinned hash (and a nonfree build still refused), the
//    GPL text and notice, and the fetch with the download and unzip handed in (ditto for real on macOS);
// 9. the staged check (afterPack): the binary inside the laid-out app is the pin, a plain file, mode
//    755, and only then is the attestation written; no hook keeps state or authorises a package;
// 10. the release gate (scripts/verify-mac-package.mjs, macOS) on fixture apps, zips and disk images:
//    no attestation (a prepackaged app), a wrong hash, a broken seal, a forged attestation, a binary
//    for another architecture, an Apple Development or another team's signature (codesign's account
//    handed in), a second app anywhere in a zip or disk image and a link out of the package refused.
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  childEnvWithFfmpegDir, ffmpegExecutableName, resolveFfmpeg, shippedFfmpegCandidates, systemFfmpegCandidates,
} from '../src/main/ffmpeg-path.ts'
import { createTranscriptionSetup, recordedPythonVersion, transcriptionAgentPrompt, transcriptionStatus } from '../src/main/transcription-setup.ts'
import {
  NOT_SET_UP_OPTIONAL, TRANSCRIPTION_ROW_NAME, TRANSCRIPTION_SETUP_STEPS, TRANSCRIPTION_STATES, shortPythonVersion,
  transcriptionActionMessage, transcriptionRowDetail, transcriptionRowEdge, transcriptionRowLabel,
} from '../src/shared/transcription-status.ts'
import { transcodeArgs } from '../src/main/transcode-args.ts'
import { ensurePinnedMacFfmpeg, readMacFfmpegPin } from './lib/ffmpeg-mac-fetch.mjs'
import { ELECTRON_HELPERS, contentSha256Of, developerIdProblem, developerIdRequirement, expectedTeamIdentifier, macAppProblem, verifyMacPackage } from './verify-mac-package.mjs'

const repo = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
const { ffmpegShipProblem, macFfmpegNoticeProblem, macFfmpegPinProblem, sha256: shaOf, shippedFfmpegPath, stagedMacFfmpegPath, stagedMacFfmpegProblem } = require('./lib/ffmpeg-ship-check.cjs')
const { createStagedCheck } = require('./electron-builder-staged-check.cjs')
const { MAC_FFMPEG_ATTESTATION, macFfmpegAttestationProblem, machoContentSha256 } = require('./lib/ffmpeg-ship-check.cjs')
const scratch = mkdtempSync(join(tmpdir(), 'tw-transcription-setup-'))
let passed = 0
const ok = (label) => { passed += 1; console.log(`  ok ${passed}. ${label}`) }
const touch = (path, body = 'x') => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body); return path }

try {
  // ── Fixture computer: an environment with its pyvenv.cfg, the script, a shipped and a system ffmpeg.
  const env = join(scratch, 'user-data', 'transcription', 'venv')
  const python = touch(join(env, 'bin', 'python'))
  touch(join(env, 'pyvenv.cfg'), 'home = /usr/bin\ninclude-system-site-packages = false\nversion = 3.11.7\n')
  const script = touch(join(scratch, 'Resources', 'agent-setup', 'transcription', 'parakeet_to_srt.py'), '# script')
  const shipped = touch(join(scratch, 'Resources', 'ffmpeg', 'ffmpeg'))
  const system = touch(join(scratch, 'system', 'ffmpeg'))
  const own = touch(join(scratch, 'own', 'ffmpeg'))
  if (process.platform !== 'win32') chmodSync(own, 0o755)
  const gone = join(scratch, 'nowhere')
  const status = (paths, { shippedList = [shipped], systemList = [system], version = '3.11.7' } = {}) =>
    transcriptionStatus({ paths: { python: '', script: '', ffmpeg: '', ...paths }, exists: existsSync, shippedFfmpeg: shippedList, systemFfmpeg: systemList, pythonVersion: version })

  // ── 1. Every state of the row, from fixture paths ───────────────────────────────────────────
  {
    const seen = new Map()
    const take = (name, result) => { seen.set(result.row.state, result.row); assert.equal(result.row.state, name); return result }
    take('not-set-up', status({}))
    take('python-not-set', status({ script }))
    take('python-not-found', status({ python: gone, script }))
    take('script-not-set', status({ python }))
    take('script-not-found', status({ python, script: gone }))
    const missingOwn = take('ffmpeg-not-found', status({ python, script, ffmpeg: gone }))
    assert.equal(missingOwn.row.ffmpegConfigured, true, 'a path set in Settings that is not there is named as such')
    const noneShipped = take('ffmpeg-not-found', status({ python, script }, { shippedList: [gone], systemList: [] }))
    assert.equal(noneShipped.row.ffmpegConfigured, false)
    const ready = take('ready', status({ python, script }))
    assert.deepEqual(TRANSCRIPTION_STATES.filter((state) => !seen.has(state)), [], 'every state is produced')

    const edges = Object.fromEntries([...seen].map(([state, row]) => [state, transcriptionRowEdge(row)]))
    assert.deepEqual(edges['not-set-up'], { kind: 'state', text: 'Not set up — optional', tone: 'quiet' }, 'optional, said calmly')
    assert.deepEqual(edges.ready, { kind: 'state', text: 'Ready', tone: 'good' })
    for (const [state, text] of [['python-not-set', 'Python not set'], ['python-not-found', 'Python not found'], ['script-not-set', 'Script not set'], ['script-not-found', 'Script not found'], ['ffmpeg-not-found', 'ffmpeg not found']]) {
      assert.deepEqual(edges[state], { kind: 'state', text, tone: 'warn' }, `${state}: the one missing thing`)
    }
    assert.equal(transcriptionRowLabel(ready.row), 'Ready (Python 3.11, script found, ffmpeg found (shipped with TalkWeaver))', 'D16: Ready (Python 3.x, script found, ffmpeg found)')
    assert.equal(transcriptionRowDetail(ready.row), 'Python 3.11, script found, ffmpeg found (shipped with TalkWeaver)')
    assert.equal(transcriptionRowLabel(status({ python, script, ffmpeg: own }).row), 'Ready (Python 3.11, script found, ffmpeg found)')
    assert.equal(transcriptionRowLabel(status({ python, script }, { version: null }).row), 'Ready (Python found, script found, ffmpeg found (shipped with TalkWeaver))', 'an unknown version is not guessed')
    assert.match(transcriptionRowDetail(missingOwn.row), /Clear it to use the ffmpeg that ships with TalkWeaver/)
    assert.match(transcriptionRowDetail(noneShipped.row), /no ffmpeg of its own/)
    assert.equal(TRANSCRIPTION_ROW_NAME, 'Transcription')
    // Only the first missing thing is named, in the order Python, script, ffmpeg.
    assert.equal(status({ python: gone, script: gone, ffmpeg: gone }).row.state, 'python-not-found')
    assert.equal(status({ python, script: gone, ffmpeg: gone }).row.state, 'script-not-found')
    // Spaces around a pasted path do not count as a path.
    assert.equal(status({ python: '  ', script: ' ' }).row.state, 'not-set-up')
    ok('every state of the row comes from the one function, from fixture paths, in D16\'s words')
  }

  // ── 2. Nothing configured: optional, and the action says where to set it up ──────────────────
  {
    for (const lists of [{}, { shippedList: [], systemList: [] }]) {
      const { row } = status({}, lists)
      assert.equal(row.state, 'not-set-up', 'with or without an ffmpeg, nothing set is "not set up"')
      assert.equal(transcriptionRowLabel(row), NOT_SET_UP_OPTIONAL)
      assert.equal(transcriptionActionMessage(row), 'Transcription is not set up. It is optional: Settings → Transcription has the set-up steps.')
    }
    for (const state of TRANSCRIPTION_STATES.filter((name) => name !== 'ready')) {
      const message = transcriptionActionMessage({ state, pythonVersion: null, ffmpeg: null, ffmpegConfigured: false })
      assert.ok(message && message.includes('Settings → Transcription'), `${state}: the action names where to set it up`)
    }
    assert.equal(transcriptionActionMessage(status({ python, script }).row), null, 'Ready: nothing is refused')
    // The Transcribe action asks this row before it runs (the refusal is the row's sentence), and
    // nothing else in the app reads it to decide anything: transcription blocks nothing. (The Guide's
    // Connections row only shows it: `transcription: () => transcriptionSetup().status()`, so the Guide and
    // Settings never disagree.)
    const bridge = readFileSync(join(repo, 'src', 'main', 'transcription.ts'), 'utf8')
    assert.match(bridge, /transcriptionActionMessage\(ready\.row\)/, 'transcript:run refuses with the row\'s sentence')
    const readers = ['src/main/index.ts', 'src/preload/index.ts'].map((file) => readFileSync(join(repo, file), 'utf8'))
    const uses = readers[0].split(/\r?\n/).filter((line) => line.includes('transcriptionSetup()'))
    // ...the Guide's connections row (reads the Settings status) and the `setup transcription` command (ticket 07), which sets the paths through the same operations as Settings.
    assert.ok(uses.length >= 3 && uses.every((line) => /function transcriptionSetup\(\)|ipcMain\.handle\('transcription:|^\s*(config|readiness): \(\) => transcriptionSetup\(\)|^\s*transcription: \(\) => transcriptionSetup\(\)\.status\(\),$|^\s*transcription: transcriptionSetup\(\),$/.test(line)), `the main process uses the row only for Settings, the transcription bridge, the Guide's connections and the setup command:\n${uses.join('\n')}`)
    assert.match(readers[1], /transcriptionStatus: \(\): Promise<TranscriptionRow>/)
    ok('nothing configured reads "Not set up — optional"; every transcription refusal says where to set it up')
  }

  // ── 3. The ffmpeg resolver ──────────────────────────────────────────────────────────────────
  {
    const exists = (set) => (path) => set.includes(path)
    assert.deepEqual(resolveFfmpeg({ configured: own, shipped: [shipped], system: [system], exists: existsSync }), { found: true, path: own, source: 'configured' }, 'a path set in Settings is used')
    assert.deepEqual(resolveFfmpeg({ configured: gone, shipped: [shipped], system: [system], exists: existsSync }), { found: false, path: null, source: 'configured' }, 'a set path that is not there is not replaced silently')
    assert.deepEqual(resolveFfmpeg({ configured: '', shipped: [shipped], system: [system], exists: existsSync }), { found: true, path: shipped, source: 'shipped' }, 'no path set: the shipped ffmpeg, before the system one')
    assert.deepEqual(resolveFfmpeg({ configured: '', shipped: [gone], system: [system], exists: existsSync }), { found: true, path: system, source: 'system' })
    assert.deepEqual(resolveFfmpeg({ configured: '', shipped: [], system: [], exists: existsSync }), { found: false, path: null, source: null })
    // A path set in Settings must be absolute and an existing regular file that can be run. A bare
    // name or a relative path is "not found" even when something by that name exists, because
    // spawning it would look it up on PATH (or in the current folder): never PATH.
    const notFound = { found: false, path: null, source: 'configured' }
    const yes = () => true
    for (const name of ['ffmpeg', 'ffmpeg.exe', 'own/ffmpeg', './ffmpeg', join('..', 'own', 'ffmpeg')]) {
      assert.deepEqual(resolveFfmpeg({ configured: name, shipped: [shipped], system: [system], exists: yes, executable: yes }), notFound, `a bare name or relative path set in Settings (${name}) is not found, never looked up on PATH`)
    }
    assert.deepEqual(resolveFfmpeg({ configured: ' ffmpeg ', shipped: [shipped], system: [system], exists: yes }), notFound, 'with the real checks too')
    assert.deepEqual(resolveFfmpeg({ configured: own, shipped: [shipped], system: [system], exists: () => false, executable: yes }), { found: true, path: own, source: 'configured' }, 'an absolute path that can be run is used')
    if (process.platform !== 'win32') {
      const plain = touch(join(scratch, 'own', 'not-runnable'))
      chmodSync(plain, 0o644)
      assert.deepEqual(resolveFfmpeg({ configured: plain, shipped: [shipped], system: [system], exists: existsSync }), notFound, 'an absolute file that cannot be run is not found')
      assert.deepEqual(resolveFfmpeg({ configured: join(scratch, 'own'), shipped: [shipped], system: [system], exists: existsSync }), notFound, 'a folder is not found')
    }
    const bareRow = transcriptionStatus({ paths: { python, script, ffmpeg: 'ffmpeg' }, exists: existsSync, shippedFfmpeg: [shipped], systemFfmpeg: [system], pythonVersion: '3.11' })
    assert.deepEqual([bareRow.row.state, bareRow.row.ffmpegConfigured, bareRow.ffmpeg.found], ['ffmpeg-not-found', true, false], 'the row: a bare name set in Settings reads as the not-found path')
    assert.match(transcriptionRowDetail(bareRow.row), /There is no file at the ffmpeg path below/)

    assert.equal(ffmpegExecutableName('win32'), 'ffmpeg.exe')
    assert.equal(ffmpegExecutableName('darwin'), 'ffmpeg')
    const packaged = shippedFfmpegCandidates({ platform: 'darwin', resourcesPath: '/App/Contents/Resources', appPath: '/App/Contents/Resources/app', packaged: true })
    assert.deepEqual(packaged, [join('/App/Contents/Resources', 'ffmpeg', 'ffmpeg'), join('/App/Contents/Resources/app', 'node_modules', 'ffmpeg-static', 'ffmpeg')], 'a packaged build looks in its resources first')
    const dev = shippedFfmpegCandidates({ platform: 'darwin', resourcesPath: '/electron/Resources', appPath: '/checkout', packaged: false })
    assert.equal(dev[0], join('/checkout', 'node_modules', 'ffmpeg-static', 'ffmpeg'), 'an unpackaged app uses the copy bun install downloaded')
    const windows = shippedFfmpegCandidates({ platform: 'win32', resourcesPath: 'C:\\TW\\resources', appPath: 'C:\\TW\\resources\\app', packaged: true })
    assert.ok(windows.every((path) => path.endsWith('ffmpeg.exe')), 'Windows: ffmpeg.exe')
    assert.deepEqual(systemFfmpegCandidates('win32'), [], 'Windows has no system places to guess')
    assert.ok(systemFfmpegCandidates('darwin').length > 0)
    const winResolved = resolveFfmpeg({ configured: '', shipped: windows, system: systemFfmpegCandidates('win32'), exists: exists([windows[0]]) })
    assert.deepEqual(winResolved, { found: true, path: windows[0], source: 'shipped' })

    // The engine's PATH: the ffmpeg folder first, with the platform's separator, one PATH key.
    const winEnv = childEnvWithFfmpegDir('C:\\TW\\resources\\ffmpeg\\ffmpeg.exe', { Path: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows' }, ';', win32.dirname)
    assert.deepEqual(Object.keys(winEnv).filter((key) => key.toUpperCase() === 'PATH'), ['Path'], 'Windows keeps one Path variable')
    assert.equal(winEnv.Path, 'C:\\TW\\resources\\ffmpeg;C:\\Windows\\System32')
    const macEnv = childEnvWithFfmpegDir('/App/ffmpeg/ffmpeg', { PATH: '/usr/bin' }, ':')
    assert.equal(macEnv.PATH, '/App/ffmpeg:/usr/bin')
    assert.equal(childEnvWithFfmpegDir('/App/ffmpeg/ffmpeg', {}, ':').PATH, '/App/ffmpeg')
    ok('ffmpeg: the set path (absolute, a runnable file; a bare name or relative path is not found), else the shipped one first, else the system one; Windows names and PATH handled')
  }

  // ── 4. The set-up operations ────────────────────────────────────────────────────────────────
  {
    assert.equal(recordedPythonVersion(python), '3.11', 'the version an environment records, read without running Python')
    assert.equal(recordedPythonVersion(join(scratch, 'bare', 'python')), null)
    const uvEnv = join(scratch, 'uv-env')
    touch(join(uvEnv, 'pyvenv.cfg'), 'home = C:\\Python\r\nimplementation = CPython\r\nversion_info = 3.12.1.final.0\r\n')
    assert.equal(recordedPythonVersion(join(uvEnv, 'Scripts', 'python.exe')), '3.12', 'uv and Windows line endings')
    assert.equal(shortPythonVersion('Python 3.13.0'), '3.13')
    assert.equal(shortPythonVersion('nonsense'), null)

    const config = {}
    const asked = []
    const setup = createTranscriptionSetup({
      read: () => ({ python: config.python ?? '', script: config.script ?? '', ffmpeg: config.ffmpeg ?? '' }),
      write: (paths) => { for (const [key, value] of Object.entries(paths)) { if (value) config[key] = value; else delete config[key] } },
      shippedFfmpeg: () => [shipped],
      systemFfmpeg: () => [],
      setupFolder: () => join(scratch, 'Resources', 'agent-setup', 'transcription'),
      userData: () => join(scratch, 'user-data'),
      platform: process.platform,
      pythonVersion: async (path) => { asked.push(path); return recordedPythonVersion(path) },
    })
    assert.equal((await setup.status()).state, 'not-set-up')
    assert.deepEqual(asked, [], 'Python is not asked anything until the row could be Ready')
    let row = await setup.setPaths({ python: ` ${python} `, script })
    assert.deepEqual(row, { state: 'ready', pythonVersion: '3.11', ffmpeg: 'shipped', ffmpegConfigured: false }, '`setup transcription --python --script`: set and checked')
    assert.deepEqual(config, { python, script }, 'trimmed, ffmpeg left unset')
    row = await setup.setPaths({ ffmpeg: gone })
    assert.equal(row.state, 'ffmpeg-not-found', 'an undefined path is left as it is; the new one is checked')
    assert.equal(config.python, python)
    row = await setup.setPaths({ ffmpeg: '' })
    assert.equal(row.state, 'ready', 'an empty path clears the setting: the shipped ffmpeg again')
    assert.equal(config.ffmpeg, undefined)
    assert.equal(setup.quickStatus().ffmpeg.path, shipped, 'the bridge is given the shipped ffmpeg to run')

    const prompt = setup.agentPrompt()
    assert.ok(prompt.includes(join(scratch, 'Resources', 'agent-setup', 'transcription', 'SETUP.md')), 'the prompt points at the shipped steps')
    assert.ok(prompt.includes(join(scratch, 'user-data', 'transcription', 'venv')), 'and at the environment in the user-data folder')
    assert.match(prompt, /never ask me for one/)
    const winPrompt = transcriptionAgentPrompt({ setupFolder: 'C:\\TW\\resources\\agent-setup\\transcription', userData: 'C:\\Users\\ann\\AppData\\Roaming\\TalkWeaver', platform: 'win32' })
    assert.ok(winPrompt.includes('C:\\Users\\ann\\AppData\\Roaming\\TalkWeaver\\transcription\\venv\\Scripts\\python.exe'), 'Windows: the venv\'s Scripts\\python.exe')
    assert.ok(!winPrompt.includes('/'), 'no forward slash in a Windows prompt')
    ok('setPaths and status (what Settings and `setup transcription` call), the recorded version and the agent prompt')
  }

  // ── 5. No path, skill or person from Dominik's machines in what Settings shows ───────────────
  {
    const personal = [/gitrepos/i, /05_skills/i, /_SKILLS/, /speech-to-text/i, /\/Users\//, /dominik/i, /luke[sš]/i, /~\//, /local-models/i, /02_workskills/i]
    // 0.42: the rows are schema settings; the status row is on the Settings window's Get started page.
    const { schema } = await import('../src/shared/settings-schema.ts')
    const transcriptionRows = schema.settings.filter((d) => d.group === 'Transcription')
    assert.ok(transcriptionRows.length === 3, 'the Transcription rows of Settings are found')
    const pages = readFileSync(join(repo, 'src', 'renderer', 'src', 'components', 'SettingsWindowPages.tsx'), 'utf8')
    const shown = {
      'Settings › Recording › Transcription': transcriptionRows.map((d) => `${d.label}\n${d.help ?? ''}`).join('\n'),
      'Settings › Get started': pages.slice(pages.indexOf('Transcription</div>'), pages.indexOf('<TranscriptionStatusRow')),
      'the status row': readFileSync(join(repo, 'src', 'renderer', 'src', 'components', 'TranscriptionStatusRow.tsx'), 'utf8'),
      'the row\'s words': readFileSync(join(repo, 'src', 'shared', 'transcription-status.ts'), 'utf8'),
      'every row text': TRANSCRIPTION_STATES.flatMap((state) => {
        const row = { state, pythonVersion: '3.11', ffmpeg: 'shipped', ffmpegConfigured: state === 'ffmpeg-not-found' }
        return [transcriptionRowDetail(row), transcriptionRowLabel(row), transcriptionActionMessage(row) ?? '']
      }).concat(TRANSCRIPTION_SETUP_STEPS).join('\n'),
      'the agent prompt template': transcriptionAgentPrompt({ setupFolder: '<set-up>', userData: '<user-data>', platform: 'darwin' }),
      'SETUP.md': readFileSync(join(repo, 'resources', 'agent-setup', 'transcription', 'SETUP.md'), 'utf8'),
      'requirements.txt': readFileSync(join(repo, 'resources', 'agent-setup', 'transcription', 'requirements.txt'), 'utf8'),
    }
    for (const [where, text] of Object.entries(shown)) {
      for (const pattern of personal) assert.ok(!pattern.test(text), `${where} names something from Dominik's machines (${pattern})`)
    }
    // Settings names no skill at all (the agent prompt may mention the public TalkWeaver skill).
    for (const where of ['Settings → Transcription', 'Settings search words', 'every row text']) {
      assert.ok(!/\bskill\b/i.test(shown[where]), `${where} names a skill`)
    }
    ok('Settings, the row, the prompt and the shipped steps name no path, skill or person from Dominik\'s machines')
  }

  // ── 6. What ships ───────────────────────────────────────────────────────────────────────────
  {
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
    const extra = pkg.build.extraResources
    assert.ok(extra.some((entry) => entry.from === 'resources/agent-setup' && entry.to === 'agent-setup'), 'the set-up folder ships')
    assert.equal(extra.find((entry) => entry.to === 'ffmpeg'), undefined, 'no ffmpeg for every platform: each platform names its own')
    const ff = pkg.build.win.extraResources.find((entry) => entry.to === 'ffmpeg')
    assert.ok(ff && ff.from === 'node_modules/ffmpeg-static', 'Windows: ffmpeg ships from ffmpeg-static into resources/ffmpeg')
    assert.ok(['ffmpeg.exe', 'LICENSE'].every((name) => ff.filter.includes(name)), 'the binary and its licence')
    const macFf = pkg.build.mac.extraResources.filter((entry) => entry.to === 'ffmpeg')
    assert.deepEqual(macFf.map((entry) => [entry.from, entry.filter]), [['ffmpeg-mac', ['ffmpeg']], ['resources/ffmpeg-mac', ['COPYING.GPLv3', 'FFMPEG-NOTICE.md']]], 'macOS: the pinned GPL ffmpeg, its GPL text and notice, into resources/ffmpeg')
    assert.ok(pkg.build.mac.target.every((target) => target.arch === 'arm64'), 'every macOS package is arm64, the one architecture pinned')
    assert.match(readFileSync(join(repo, '.gitignore'), 'utf8'), /^\/ffmpeg-mac\/$/m, 'the downloaded binary is never committed (anchored: resources/ffmpeg-mac holds the notice, which is committed)')
    for (const name of ['COPYING.GPLv3', 'FFMPEG-NOTICE.md']) {
      const ignored = spawnSync('git', ['check-ignore', '-q', join('resources', 'ffmpeg-mac', name)], { cwd: repo, windowsHide: true })
      if (ignored.status !== null && ignored.status <= 1) assert.equal(ignored.status, 1, `resources/ffmpeg-mac/${name} is git-ignored, so it would never be committed`)
    }
    assert.ok(pkg.devDependencies['ffmpeg-static'], 'ffmpeg-static is a build-time dependency (not copied a second time into resources/app)')
    assert.equal(pkg.dependencies['ffmpeg-static'], undefined)

    const folder = join(repo, 'resources', 'agent-setup', 'transcription')
    const vendored = readFileSync(join(folder, 'parakeet_to_srt.py'))
    const provenance = readFileSync(join(folder, 'PROVENANCE.md'), 'utf8')
    assert.ok(provenance.includes(createHash('sha256').update(vendored).digest('hex')), 'the provenance note carries the hash of the vendored script')
    assert.match(provenance, /Licence:[\s\S]*TalkWeaver's MIT licence/, 'the vendored script ships under TalkWeaver\'s MIT licence')
    assert.match(provenance, /speech-to-text\/scripts\/parakeet_to_srt\.py[\s\S]*techczech\/speech-to-text-skill/, 'and its source: the skill script and its upstream repository')
    assert.match(readFileSync(join(folder, 'requirements.txt'), 'utf8'), /^parakeet-mlx==\d/m, 'the engine is pinned')

    const big = Buffer.alloc(2 * 1024 * 1024, 0x61)
    const nonfree = Buffer.concat([big, Buffer.from('configuration: --enable-gpl --enable-nonfree --enable-neon')])
    const read = (bytes) => () => bytes
    assert.match(ffmpegShipProblem({ binary: 'x', targets: ['dir'], read: () => null }), /missing/, 'no package without the shipped ffmpeg')
    assert.match(ffmpegShipProblem({ binary: 'x', targets: ['nsis'], read: read(Buffer.from('tiny')) }), /missing/)
    assert.equal(ffmpegShipProblem({ binary: 'x', targets: ['dir'], read: read(nonfree) }), null, 'an unpacked build may carry it')
    assert.match(ffmpegShipProblem({ binary: 'x', targets: ['dmg', 'zip'], read: read(nonfree) }), /unredistributable.*dmg, zip/, 'an installer may not')
    assert.equal(ffmpegShipProblem({ binary: 'x', targets: ['nsis'], read: read(big) }), null)
    assert.equal(shippedFfmpegPath('/r', 'win32'), join('/r', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe'))
    assert.equal(shippedFfmpegPath('/r', 'darwin'), join('/r', 'ffmpeg-mac', 'ffmpeg'), 'macOS packs the fetched pinned build, not ffmpeg-static')
    assert.match(readFileSync(join(repo, 'scripts', 'electron-builder-before-pack.cjs'), 'utf8'), /ffmpegShipProblem/, 'electron-builder runs the check before it packs')
    ok('the set-up folder and ffmpeg ship; the vendored script matches its provenance; the package check')
  }

  // ── 7. The real shipped ffmpeg, when bun install has downloaded it ──────────────────────────
  {
    // TW_TEST_SHIPPED_FFMPEG (this test only): a downloaded ffmpeg-static binary elsewhere, for a checkout whose node_modules has none yet.
    const real = process.env.TW_TEST_SHIPPED_FFMPEG || join(repo, 'node_modules', 'ffmpeg-static', ffmpegExecutableName(process.platform))
    if (!existsSync(real)) {
      console.log('  skipped 7: node_modules/ffmpeg-static has no ffmpeg binary (run bun install); the packaged smoke checks the build')
    } else {
      // A fixture app folder whose node_modules holds the downloaded binary: no path set → it is the one.
      const app = join(scratch, 'app')
      const binary = join(app, 'node_modules', 'ffmpeg-static', ffmpegExecutableName(process.platform))
      mkdirSync(dirname(binary), { recursive: true })
      if (process.platform === 'win32') copyFileSync(real, binary); else symlinkSync(real, binary)
      const candidates = shippedFfmpegCandidates({ platform: process.platform, resourcesPath: join(scratch, 'no-resources'), appPath: app, packaged: false })
      const chosen = transcriptionStatus({ paths: { python, script, ffmpeg: '' }, exists: existsSync, shippedFfmpeg: candidates, systemFfmpeg: systemFfmpegCandidates(process.platform), pythonVersion: '3.11' })
      assert.equal(chosen.row.state, 'ready')
      assert.deepEqual([chosen.ffmpeg.source, chosen.ffmpeg.path], ['shipped', binary], 'no path set: the shipped ffmpeg is used, not one on the system')
      const run = (args) => spawnSync(chosen.ffmpeg.path, ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8', timeout: 60_000, windowsHide: true, env: childEnvWithFfmpegDir(chosen.ffmpeg.path) })
      const version = spawnSync(chosen.ffmpeg.path, ['-version'], { encoding: 'utf8', timeout: 30_000, windowsHide: true })
      assert.equal(version.status, 0, version.stderr)
      const tone = join(scratch, 'tone.wav')
      assert.equal(run(['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', tone]).status, 0, 'a test recording is made')
      const one = join(scratch, 'one.wav')
      const single = run(transcodeArgs([tone], [0], one))
      assert.equal(single.status, 0, single.stderr)
      const two = join(scratch, 'two.wav')
      const joined = run(transcodeArgs([tone, tone], [0, 500], two))
      assert.equal(joined.status, 0, joined.stderr)
      assert.ok(statSync(two).size > statSync(one).size * 2, 'two segments and the silence between them make one longer WAV')
      ok(`the shipped ${version.stdout.split('\n')[0].split(' Copyright')[0]} is used with no path set and makes transcription's WAV (${process.platform})`)
    }
  }

  // ── 8. The pinned macOS ffmpeg: the pin, the fetch, the package check ───────────────────────
  {
    const pin = readMacFfmpegPin()
    assert.equal(macFfmpegPinProblem(pin), null, 'the committed pin is a pinned release build')
    assert.deepEqual([pin.platform, pin.arch, pin.licence], ['darwin', 'arm64', 'GPL-3.0-or-later'])
    const refused = {
      'a "latest" redirect': { url: 'https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip' },
      'a snapshot build': { url: 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1791391111_N-127236-g17ec998942/ffmpeg.zip' },
      'another version in the address': { url: 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.1/ffmpeg.zip' },
      'plain http': { url: pin.url.replace('https:', 'http:') },
      'another host': { url: pin.url.replace('ffmpeg.martin-riedl.de', 'ffmpeg.example.org') },
      'a query string': { url: `${pin.url}?v=latest` },
      'the Intel folder for arm64': { url: pin.url.replace('/arm64/', '/amd64/') },
      'no archive hash': { archiveSha256: '' },
      'a short binary hash': { binarySha256: 'abc123' },
      'a snapshot version': { version: 'N-127236' },
      'another platform': { platform: 'win32' },
    }
    for (const [what, change] of Object.entries(refused)) assert.ok(macFfmpegPinProblem({ ...pin, ...change }), `refused: ${what}`)

    // The package check with the pin: only the pinned bytes, in every target; never a nonfree build.
    const good = Buffer.concat([Buffer.alloc(2 * 1024 * 1024, 0x62), Buffer.from('configuration: --enable-gpl --enable-version3')])
    const nonfreeBytes = Buffer.concat([good, Buffer.from(' --enable-nonfree')])
    const pinOf = (bytes) => ({ ...pin, binarySha256: shaOf(bytes) })
    const check = (bytes, targets, extra = {}) => ffmpegShipProblem({ binary: 'ffmpeg-mac/ffmpeg', targets, read: () => bytes, pin: pinOf(good), ...extra })
    assert.equal(check(good, ['dmg', 'zip']), null, 'the pinned hash: a disk image and archive may carry it')
    assert.equal(check(good, ['dir'], { arch: 3 }), null, 'and an unpacked arm64 build')
    assert.match(check(Buffer.concat([good, Buffer.from('x')]), ['dir']), /not the pinned build/, 'another hash is refused, unpacked builds included')
    assert.match(check(null, ['dmg']), /missing.*fetch:ffmpeg-mac/)
    assert.match(check(good, ['dmg'], { arch: 1 }), /pinned macOS ffmpeg is for arm64; this package is for x64/, 'an architecture with no pin is refused')
    assert.match(ffmpegShipProblem({ binary: 'b', targets: ['dir'], read: () => nonfreeBytes, pin: pinOf(nonfreeBytes) }), /--enable-nonfree/, 'a nonfree build is refused even when its hash is pinned')
    const before = readFileSync(join(repo, 'scripts', 'electron-builder-before-pack.cjs'), 'utf8')
    assert.match(before, /macFfmpegPinProblem\(pin\)[\s\S]*fetch-ffmpeg-mac\.mjs[\s\S]*macFfmpegNoticeProblem[\s\S]*ffmpegShipProblem\(\{[\s\S]*pin,/, 'before-pack checks the pin, fetches, checks the notice, then the binary against the pin')

    // The GPL text and the notice that ship beside the binary name what is pinned.
    const licence = readFileSync(join(repo, 'resources', 'ffmpeg-mac', 'COPYING.GPLv3'), 'utf8')
    const notice = readFileSync(join(repo, 'resources', 'ffmpeg-mac', 'FFMPEG-NOTICE.md'), 'utf8')
    assert.equal(macFfmpegNoticeProblem({ licence, notice, pin }), null, 'the shipped notice names the pinned version, address and hash')
    assert.ok(notice.includes(`TalkWeaver-<version>-ffmpeg-${pin.version}-corresponding-source.tar`), 'and where to get the corresponding source: the release asset (scripts/test-ffmpeg-source-bundle.mjs checks it in full)')
    assert.match(macFfmpegNoticeProblem({ licence, notice: notice.replaceAll(pin.version, '9.0.1'), pin }), /version/, 'a notice for another version is refused')
    assert.match(macFfmpegNoticeProblem({ licence: null, notice, pin }), /COPYING\.GPLv3/)
    const thirdParty = readFileSync(join(repo, 'THIRD-PARTY-NOTICES.md'), 'utf8')
    assert.ok(thirdParty.includes(`FFmpeg ${pin.version}`) && thirdParty.includes(pin.url), 'the third-party notices name the macOS ffmpeg')

    // The fetch, with the download and the unzip handed in: fixture bytes under a fixture pin.
    const archive = Buffer.from('fixture archive bytes')
    const fixturePin = { ...pin, archiveSha256: shaOf(archive), binarySha256: shaOf(good) }
    const out = join(scratch, 'ffmpeg-mac')
    let downloads = 0
    const download = async (url) => { downloads += 1; assert.equal(url, fixturePin.url, 'only the pinned address is fetched'); return archive }
    const extractAs = (bytes) => (zip, into) => { assert.deepEqual(readFileSync(zip), archive); writeFileSync(join(into, 'ffmpeg'), bytes) }
    const fetched = await ensurePinnedMacFfmpeg({ pin: fixturePin, outDir: out, download, extract: extractAs(good) })
    assert.deepEqual(fetched, { path: join(out, 'ffmpeg'), fetched: true })
    assert.equal(shaOf(readFileSync(fetched.path)), fixturePin.binarySha256, 'the matching build is put in place')
    if (process.platform !== 'win32') assert.equal(statSync(fetched.path).mode & 0o111, 0o111, 'and can be run')
    assert.deepEqual(readdirSync(out), ['ffmpeg'], 'nothing else is left behind')
    assert.deepEqual(await ensurePinnedMacFfmpeg({ pin: fixturePin, outDir: out, download, extract: extractAs(good) }), { path: fetched.path, fetched: false })
    assert.equal(downloads, 1, 'a copy with the pinned hash is kept: no second download')

    const fresh = (name) => join(scratch, name)
    await assert.rejects(ensurePinnedMacFfmpeg({ pin: { ...fixturePin, archiveSha256: shaOf(Buffer.from('other')) }, outDir: fresh('wrong-archive'), download, extract: extractAs(good) }), /archive .* not the pinned .*nothing was written/)
    assert.equal(existsSync(fresh('wrong-archive')), false, 'a wrong archive writes nothing')
    await assert.rejects(ensurePinnedMacFfmpeg({ pin: fixturePin, outDir: fresh('wrong-binary'), download, extract: extractAs(Buffer.from('not ffmpeg')) }), /extracted ffmpeg .* not the pinned/)
    assert.deepEqual(readdirSync(fresh('wrong-binary')), [], 'a wrong binary is not put in place')
    const nonfreePin = { ...fixturePin, binarySha256: shaOf(nonfreeBytes) }
    await assert.rejects(ensurePinnedMacFfmpeg({ pin: nonfreePin, outDir: fresh('nonfree'), download, extract: extractAs(nonfreeBytes) }), /--enable-nonfree/, 'a pinned nonfree build is still refused')
    const before2 = downloads
    await assert.rejects(ensurePinnedMacFfmpeg({ pin: { ...fixturePin, url: 'https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip' }, outDir: fresh('latest'), download, extract: extractAs(good) }), /never a "latest"/)
    assert.equal(downloads, before2, 'an unpinned address is never fetched')
    if (process.platform !== 'win32') {
      // A copy kept from an earlier fetch is made runnable too (the staged check refuses one that is not).
      chmodSync(join(out, 'ffmpeg'), 0o644)
      assert.equal((await ensurePinnedMacFfmpeg({ pin: fixturePin, outDir: out, download, extract: extractAs(good) })).fetched, false)
      assert.equal(statSync(join(out, 'ffmpeg')).mode & 0o777, 0o755, 'a kept copy is set to mode 755')
    }
    // A stale or swapped file in ffmpeg-mac/ is replaced by the pinned one.
    writeFileSync(join(out, 'ffmpeg'), 'swapped')
    assert.equal((await ensurePinnedMacFfmpeg({ pin: fixturePin, outDir: out, download, extract: extractAs(good) })).fetched, true)
    assert.equal(shaOf(readFileSync(join(out, 'ffmpeg'))), fixturePin.binarySha256)
    if (process.platform !== 'win32') {
      const linked = (zip, into) => { writeFileSync(join(into, 'real'), good); symlinkSync(join(into, 'real'), join(into, 'ffmpeg')) }
      await assert.rejects(ensurePinnedMacFfmpeg({ pin: fixturePin, outDir: fresh('link'), download, extract: linked }), /no plain file named ffmpeg/, 'a link in the archive is refused')
    }
    if (process.platform === 'darwin') {
      // The real unzip: a zip made by ditto, as the published one is, comes back byte for byte.
      const staged = join(scratch, 'zip-src')
      mkdirSync(staged)
      writeFileSync(join(staged, 'ffmpeg'), good)
      const zip = join(scratch, 'fixture.zip')
      spawnSync('/usr/bin/ditto', ['-c', '-k', join(staged, 'ffmpeg'), zip])
      const zipped = readFileSync(zip)
      const real = await ensurePinnedMacFfmpeg({ pin: { ...fixturePin, archiveSha256: shaOf(zipped) }, outDir: fresh('ditto'), download: async () => zipped })
      assert.equal(shaOf(readFileSync(real.path)), fixturePin.binarySha256, 'ditto extracts the pinned binary')
    }
    ok('macOS ffmpeg: only the pinned GPL build is fetched and packed (matching hash passes; wrong hash, unpinned address, nonfree refused); its licence and notice ship')
  }

  // ── 9. The staged macOS ffmpeg (afterPack) and no package from a prepackaged app ────────────
  {
    const pin = readMacFfmpegPin()
    const good = Buffer.concat([Buffer.alloc(2 * 1024 * 1024, 0x63), Buffer.from('configuration: --enable-gpl --enable-version3')])
    const stagePin = { ...pin, binarySha256: shaOf(good) }
    const lstat = (path) => { try { return lstatSync(path) } catch { return null } }
    const read = (path) => { try { return readFileSync(path) } catch { return null } }
    let n = 0
    /** A staged build: <appOutDir>/TalkWeaver.app/Contents/Resources/ffmpeg/ffmpeg. */
    const stage = (bytes = good, mode = 0o755) => {
      const appOutDir = join(scratch, `staged-${n += 1}`)
      const binary = stagedMacFfmpegPath(appOutDir, 'TalkWeaver')
      mkdirSync(dirname(binary), { recursive: true })
      writeFileSync(binary, bytes)
      chmodSync(binary, mode)
      return { appOutDir, app: join(appOutDir, 'TalkWeaver.app'), binary }
    }
    const problem = (app, pinUsed = stagePin) => stagedMacFfmpegProblem({ app, pin: pinUsed, lstat, read })
    assert.equal(stagedMacFfmpegPath('/out/mac-arm64', 'TalkWeaver'), join('/out/mac-arm64', 'TalkWeaver.app', 'Contents', 'Resources', 'ffmpeg', 'ffmpeg'))
    assert.match(problem(join(scratch, 'no-such-out', 'TalkWeaver.app')), /no .*Contents/, 'no staged ffmpeg: refused')
    // macOS apps are packed on a Mac; Windows has no execute bit or the same links, so the staged
    // files themselves are checked on macOS and Linux only.
    const posix = process.platform !== 'win32'
    if (posix) {
      assert.equal(problem(stage().app), null, 'the pinned bytes, a plain file, mode 755: accepted')
      assert.match(problem(stage(Buffer.concat([good, Buffer.from('x')])).app), /not the pinned build.*changed after the before-pack check/, 'a binary swapped after the before-pack check is refused')
      assert.match(problem(stage(good, 0o644).app), /cannot be run \(mode 644/, 'a staged binary that cannot be run is refused')
      assert.match(problem(stage(good, 0o744).app), /cannot be run/, 'nor one only its owner can run')
      const linkedFile = stage()
      rmSync(linkedFile.binary)
      const elsewhere = touch(join(scratch, 'elsewhere', 'ffmpeg'), good)
      chmodSync(elsewhere, 0o755)
      symlinkSync(elsewhere, linkedFile.binary)
      assert.match(problem(linkedFile.app), /not a plain file/, 'a link to the pinned bytes is refused')
      const linkedFolder = stage()
      const folder = dirname(linkedFolder.binary)
      rmSync(folder, { recursive: true })
      symlinkSync(dirname(elsewhere), folder)
      assert.match(problem(linkedFolder.app), /not a plain folder/, 'so is a linked ffmpeg folder')
    }

    // afterPack (electron-builder, after copying and before signing): checks the staged binary and, only
    // then, writes the attestation beside it. It keeps no state and authorises nothing.
    const stagePinBytes = Buffer.from(JSON.stringify(stagePin, null, 2))
    const hooks = createStagedCheck({ readPinBytes: () => stagePinBytes })
    const context = (appOutDir, arch = 3, platform = 'darwin') => ({ appOutDir, arch, electronPlatformName: platform, packager: { appInfo: { productFilename: 'TalkWeaver' } } })
    const attestationOf = (staged) => join(dirname(staged.binary), MAC_FFMPEG_ATTESTATION)
    const swapped = stage(Buffer.from('swapped'))
    await assert.rejects(hooks(context(swapped.appOutDir)), /not the pinned build|cannot be run/, 'afterPack refuses a staged binary that is not the pin')
    assert.equal(existsSync(attestationOf(swapped)), false, 'and writes no attestation for it')
    await assert.rejects(createStagedCheck({ readPinBytes: () => Buffer.from(JSON.stringify({ ...stagePin, url: 'https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip' })) })(context(stage().appOutDir)), /never a "latest"/, 'afterPack checks the pin itself')
    if (posix) {
      const checked = stage()
      await hooks(context(checked.appOutDir, 3, 'darwin'))
      const written = JSON.parse(readFileSync(attestationOf(checked), 'utf8'))
      assert.deepEqual({ version: written.version, binarySha256: written.binarySha256, pinSha256: written.pinSha256 }, { version: stagePin.version, binarySha256: shaOf(good), pinSha256: shaOf(stagePinBytes) }, 'the attestation names the version, the checked bytes and the pin file')
      assert.equal(macFfmpegAttestationProblem({ text: readFileSync(attestationOf(checked), 'utf8'), pin: stagePin, pinBytes: stagePinBytes }), null)
      await assert.rejects(hooks(context(checked.appOutDir)), /could not write .*something is already there/, 'an attestation already in the staged app is never replaced')
      await assert.rejects(createStagedCheck({ readPinBytes: () => stagePinBytes })(context(stage(good, 0o644).appOutDir, 3, 'mas')), /cannot be run/, 'the Mac App Store build is checked the same way')
      const linked = stage()
      rmSync(linked.binary)
      symlinkSync(join(scratch, 'elsewhere', 'ffmpeg'), linked.binary)
      await assert.rejects(hooks(context(linked.appOutDir)), /not a plain file/, 'afterPack does not follow a link to the pinned bytes')
      const preplaced = stage()
      symlinkSync(join(scratch, 'elsewhere', 'target.json'), attestationOf(preplaced))
      await assert.rejects(hooks(context(preplaced.appOutDir)), /something is already there/, 'nor write through a link placed where the attestation goes')
      assert.equal(existsSync(join(scratch, 'elsewhere', 'target.json')), false)
    }
    const win = createStagedCheck({ readPinBytes: () => { throw new Error('the macOS pin is not read for Windows') } })
    await win(context(join(scratch, 'win-unpacked'), 1, 'win32'))

    // The attestation check (scripts/verify-mac-package.mjs uses it) and the content hash, pure.
    const fine = JSON.stringify({ version: stagePin.version, arch: stagePin.arch, binarySha256: stagePin.binarySha256, pinSha256: shaOf(stagePinBytes) })
    assert.equal(macFfmpegAttestationProblem({ text: fine, pin: stagePin, pinBytes: stagePinBytes }), null)
    assert.match(macFfmpegAttestationProblem({ text: JSON.stringify({ ...JSON.parse(fine), arch: 'x64' }), pin: stagePin, pinBytes: stagePinBytes }), /names the architecture x64; the pin is for arm64/, 'an attestation for another architecture: refused')
    const { arch: _arch, ...noArch } = JSON.parse(fine)
    assert.match(macFfmpegAttestationProblem({ text: JSON.stringify(noArch), pin: stagePin, pinBytes: stagePinBytes }), /names no architecture/, 'an attestation without one: refused')
    assert.match(macFfmpegAttestationProblem({ text: null, pin: stagePin, pinBytes: stagePinBytes }), /no ffmpeg\.pin\.json .*never checked by afterPack.*prepackaged/, 'no attestation: refused')
    assert.match(macFfmpegAttestationProblem({ text: 'not json', pin: stagePin, pinBytes: stagePinBytes }), /not JSON/)
    assert.match(macFfmpegAttestationProblem({ text: JSON.stringify({ ...JSON.parse(fine), binarySha256: 'f'.repeat(64) }), pin: stagePin, pinBytes: stagePinBytes }), /checked binary had SHA-256 f{64}/, 'another binary: refused')
    assert.match(macFfmpegAttestationProblem({ text: JSON.stringify({ ...JSON.parse(fine), version: '8.0' }), pin: stagePin, pinBytes: stagePinBytes }), /names FFmpeg 8\.0/)
    assert.match(macFfmpegAttestationProblem({ text: fine, pin: stagePin, pinBytes: Buffer.concat([stagePinBytes, Buffer.from(' ')]) }), /another pin file/, 'written against another pin file: refused')
    assert.match(machoContentSha256(Buffer.from('not a program at all, not a program at all')).problem, /not a thin 64-bit Mach-O/)
    assert.equal(macFfmpegPinProblem({ ...pin, contentSha256: undefined }), 'the macOS ffmpeg pin has no valid contentSha256 (64 lower-case hex digits)', 'the pin carries the content hash')

    // Wired into electron-builder: afterPack by name; no artifactBuildStarted, no other hook, no state.
    const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
    assert.equal(pkg.build.beforePack, 'scripts/electron-builder-before-pack.cjs')
    assert.equal(pkg.build.afterPack, 'scripts/electron-builder-staged-check.cjs', 'electron-builder runs the staged check after copying and before signing')
    assert.equal(pkg.build.artifactBuildStarted, undefined, 'no artifactBuildStarted hook: nothing in the builder authorises a package')
    const module = require('./electron-builder-staged-check.cjs')
    assert.deepEqual(Object.keys(module).sort(), ['afterPack', 'createStagedCheck'], 'the module exports the hook and its factory, and keeps no record of what it checked')
    assert.equal(typeof module.afterPack, 'function', 'electron-builder takes the export named after the hook')
    assert.doesNotMatch(readFileSync(join(repo, 'scripts', 'electron-builder-staged-check.cjs'), 'utf8'), /new Set\(|checked\.add|artifactBuildStarted\s*[(:=]/, 'no in-process record of checked builds')
    for (const where of [pkg.build.mac, pkg.build.win, pkg.build.mas ?? {}]) {
      for (const key of ['afterPack', 'artifactBuildStarted', 'beforePack']) assert.equal(where[key], undefined, `no platform section replaces ${key}`)
    }
    ok('afterPack checks the staged macOS ffmpeg (pinned bytes, plain file, mode 755) and only then writes the attestation; no hook keeps state or authorises a package')
  }

  // ── 10. The release gate: scripts/verify-mac-package.mjs on fixture apps (macOS) ──────────
  if (process.platform === 'darwin') {
    const pin = readMacFfmpegPin()
    const run = (command, args) => { const result = spawnSync(command, args, { encoding: 'utf8' }); assert.equal(result.status, 0, `${command} ${args.join(' ')}: ${result.stderr}`); return result }
    // Two small thin arm64 programs stand in for ffmpeg (the pin is for arm64): the "pinned" one and
    // another; and a thin x86_64 one, for the wrong architecture.
    const tools = join(scratch, 'gate-tools')
    mkdirSync(tools)
    const pinnedProgram = join(tools, 'pinned')
    const otherProgram = join(tools, 'other')
    const intelProgram = join(tools, 'intel')
    const compile = (body, to) => { const source = `${to}.c`; writeFileSync(source, `int main(void) { ${body} }\n`); run('/usr/bin/clang', ['-arch', 'arm64', '-o', to, source]) }
    compile('return 0;', pinnedProgram)
    compile('return 1 + 1;', otherProgram)
    run('/usr/bin/lipo', ['/usr/bin/true', '-thin', 'x86_64', '-output', intelProgram])
    assert.equal(run('/usr/bin/lipo', ['-archs', pinnedProgram]).stdout.trim(), 'arm64', 'the fixture program is arm64')
    const pinnedBytes = readFileSync(pinnedProgram)
    const content = contentSha256Of(pinnedProgram)
    assert.ok('sha256' in content, `the fixture program has a content hash: ${content.problem}`)
    const gatePin = { ...pin, binarySha256: shaOf(pinnedBytes), contentSha256: content.sha256 }
    const gatePinBytes = Buffer.from(JSON.stringify(gatePin, null, 2))
    const licence = readFileSync(join(repo, 'resources', 'ffmpeg-mac', 'COPYING.GPLv3'))
    const notice = readFileSync(join(repo, 'resources', 'ffmpeg-mac', 'FFMPEG-NOTICE.md'), 'utf8').replaceAll(pin.binarySha256, gatePin.binarySha256)
    const afterPack = createStagedCheck({ readPinBytes: () => gatePinBytes })
    const context = (appOutDir, arch = 3, platform = 'darwin') => ({ appOutDir, arch, electronPlatformName: platform, packager: { appInfo: { productFilename: 'TalkWeaver' } } })
    let apps = 0
    /** An app as electron-builder lays it out: executable, Info.plist, Resources/ffmpeg with the program, licence and notice. */
    const layOut = (program = pinnedProgram) => {
      const appOutDir = join(scratch, `gate-${apps += 1}`)
      const app = join(appOutDir, 'TalkWeaver.app')
      mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true })
      copyFileSync(pinnedProgram, join(app, 'Contents', 'MacOS', 'TalkWeaver'))
      chmodSync(join(app, 'Contents', 'MacOS', 'TalkWeaver'), 0o755)
      writeFileSync(join(app, 'Contents', 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>TalkWeaver</string><key>CFBundleIdentifier</key><string>test.talkweaver.gate</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n')
      const folder = join(app, 'Contents', 'Resources', 'ffmpeg')
      mkdirSync(folder, { recursive: true })
      copyFileSync(program, join(folder, 'ffmpeg'))
      chmodSync(join(folder, 'ffmpeg'), 0o755)
      writeFileSync(join(folder, 'COPYING.GPLv3'), licence)
      writeFileSync(join(folder, 'FFMPEG-NOTICE.md'), notice)
      return { appOutDir, app, folder, binary: join(folder, 'ffmpeg') }
    }
    /** Ad-hoc signing as electron-builder signs: the nested program first, then the app. */
    const sign = (laid) => {
      run('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', laid.binary])
      run('/usr/bin/codesign', ['--force', '--sign', '-', laid.app])
    }
    const gate = (target, options = {}) => verifyMacPackage(target, { pinBytes: gatePinBytes, ...options })
    const gateApp = (app, options = {}) => macAppProblem(app, { pinBytes: gatePinBytes, ...options })

    // Unsigned, laid out and checked by afterPack: accepted.
    const good = layOut()
    await afterPack(context(good.appOutDir))
    assert.equal(gateApp(good.app), null, 'unsigned app with the attestation and the pinned bytes: accepted')
    // A prepackaged app (laid out without afterPack): no attestation, refused.
    const prepackaged = layOut()
    assert.match(gateApp(prepackaged.app), /no ffmpeg\.pin\.json.*never checked by afterPack/, 'an app with no attestation is refused')
    // The earlier reproduction: an unrelated Windows stage passes through afterPack, then a Mac app
    // laid out without it is packaged in the same process. Nothing carries over; the gate refuses it.
    await afterPack(context(join(scratch, 'unrelated-win-unpacked'), 1, 'win32'))
    const afterWindows = layOut()
    assert.match(gateApp(afterWindows.app), /never checked by afterPack/, 'an unrelated Windows stage authorises nothing: the prepackaged Mac app is refused')
    // Unsigned, the binary changed after afterPack: refused.
    const changed = layOut()
    await afterPack(context(changed.appOutDir))
    copyFileSync(otherProgram, changed.binary)
    assert.match(gateApp(changed.app), /unsigned app is not the pinned build/, 'unsigned app whose ffmpeg is not the pinned bytes: refused')
    // An attestation written against another pin file: refused.
    const otherPin = layOut()
    await afterPack(context(otherPin.appOutDir))
    assert.match(macAppProblem(otherPin.app, { pinBytes: Buffer.concat([gatePinBytes, Buffer.from('\n')]) }), /another pin file/, 'attestation for another pin: refused')
    // An extra file in the ffmpeg folder: refused.
    const extra = layOut()
    await afterPack(context(extra.appOutDir))
    writeFileSync(join(extra.folder, 'libextra.dylib'), 'x')
    assert.match(gateApp(extra.app), /must hold exactly/, 'anything else in the ffmpeg folder: refused')

    // Signed (ad hoc): seal verifies and the program, signature removed, is the pinned one.
    const signed = layOut()
    await afterPack(context(signed.appOutDir))
    sign(signed)
    assert.notEqual(shaOf(readFileSync(signed.binary)), gatePin.binarySha256, 'signing changed the binary')
    assert.equal(gateApp(signed.app), null, 'signed app, seal intact, the pinned program: accepted')
    assert.match(gateApp(signed.app, { requireSigned: true }), /Developer ID Application certificate; this one is ad-hoc signed/, 'a release requires a Developer ID signature, not ad hoc')
    assert.match(gateApp(good.app, { requireSigned: true }), /must be signed/, 'and refuses an unsigned app')
    // codesign's account of the signer, handed in (no Developer ID certificate here): the seal and the
    // program are still checked for real.
    const team = expectedTeamIdentifier()
    assert.match(team, /^[A-Z0-9]{10}$/, 'package.json build.mac.identity names the team')
    // `anchored`: also stand in for codesign accepting the Apple-anchored Developer ID requirement (-R);
    // otherwise the real codesign judges the ad-hoc fixture against it.
    const requirements = []
    const signedBy = (authority, teamIdentifier, { anchored = true } = {}) => (command, args) => args.some((arg) => arg.startsWith('-R=')) && (requirements.push(args.find((arg) => arg.startsWith('-R='))), anchored)
      ? { status: 0, stdout: '', stderr: '' }
      : args[0] === '-dvv'
      ? { status: 0, stdout: '', stderr: `Executable=${signed.app}/Contents/MacOS/TalkWeaver\nIdentifier=test.talkweaver.gate\nFormat=app bundle with Mach-O thin (arm64)\nCodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1+1 location=embedded\nSignature size=9000\nAuthority=${authority}\nAuthority=Apple Worldwide Developer Relations Certification Authority\nAuthority=Apple Root CA\nTimestamp=9 Oct 2026 at 12:00:00\nInfo.plist entries=3\nTeamIdentifier=${teamIdentifier}\nSealed Resources version=2 rules=13 files=4\nInternal requirements count=1 size=200\n` }
      : spawnSync(command, args, { encoding: 'utf8' })
    assert.equal(gateApp(signed.app, { requireSigned: true, run: signedBy(`Developer ID Application: Test Person (${team})`, team) }), null, 'a Developer ID Application signature of the team in build.mac.identity: accepted')
    assert.deepEqual(requirements, [`-R=${developerIdRequirement(team)}`], 'once codesign accepts the Apple-anchored Developer ID requirement for that team')
    assert.equal(developerIdRequirement(team), `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${team}"`, 'Apple\'s Developer ID designated requirement')
    // A counterfeit: the certificate is named "Developer ID Application: … (team)" and the TeamIdentifier
    // is the team, but the signature is not anchored to Apple (here the real ad-hoc signature): refused.
    assert.match(gateApp(signed.app, { requireSigned: true, run: signedBy(`Developer ID Application: Test Person (${team})`, team, { anchored: false }) }), new RegExp(`does not satisfy Apple's Developer ID requirement for team ${team}[^]*failed to satisfy specified code requirement`), 'a Developer ID name and team without Apple\'s anchor: refused by codesign -R')
    const adhocAgainstRequirement = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', `-R=${developerIdRequirement(team)}`, signed.app], { encoding: 'utf8' })
    assert.notEqual(adhocAgainstRequirement.status, 0, 'codesign refuses the ad-hoc fixture against the requirement')
    assert.match(adhocAgainstRequirement.stderr, /failed to satisfy specified code requirement/, 'because it does not satisfy it (the requirement itself parses)')
    assert.throws(() => developerIdRequirement('M7H45AGG8A" or anchor apple'), /not a team identifier/)
    assert.match(gateApp(signed.app, { requireSigned: true, run: signedBy(`Apple Development: Test Person (${team})`, team) }), /Developer ID Application certificate; this one is signed by "Apple Development: Test Person/, 'an Apple Development signature of the same team: refused')
    assert.match(gateApp(signed.app, { requireSigned: true, run: signedBy('Developer ID Application: Someone Else (ABCDE12345)', 'ABCDE12345') }), new RegExp(`signed by team ${team} .*names team ABCDE12345`), 'a Developer ID of another team: refused')
    assert.match(gateApp(signed.app, { requireSigned: true, run: signedBy(`Developer ID Application: Test Person (${team})`, 'ABCDE12345') }), /names team ABCDE12345/, 'a TeamIdentifier other than the certificate\'s: refused')
    assert.match(developerIdProblem('Signature size=9000\nTeamIdentifier=ABCDE12345\n', 'ABCDE12345'), /signed by no certificate/, 'no Authority: refused')
    assert.match(developerIdProblem(`Authority=Developer ID Application: X (${team})\nTeamIdentifier=${team}\n`, null), /names no team/, 'no team to check against: refused')
    // The binary must be built for the pinned architecture, as the attestation says.
    const intel = layOut(intelProgram)
    writeFileSync(join(intel.folder, MAC_FFMPEG_ATTESTATION), JSON.stringify({ version: gatePin.version, arch: gatePin.arch, binarySha256: gatePin.binarySha256, pinSha256: shaOf(gatePinBytes) }))
    assert.match(gateApp(intel.app), /is built for x86_64; the pin and the attestation are for arm64 only/, 'an x86_64 ffmpeg under an arm64 attestation: refused')
    const wrongArch = layOut()
    await afterPack(context(wrongArch.appOutDir))
    writeFileSync(join(wrongArch.folder, MAC_FFMPEG_ATTESTATION), readFileSync(join(wrongArch.folder, MAC_FFMPEG_ATTESTATION), 'utf8').replace('"arch": "arm64"', '"arch": "x64"'))
    assert.match(gateApp(wrongArch.app), /names the architecture x64/, 'an app whose attestation names another architecture: refused')
    // Broken seal: the binary replaced after signing.
    const broken = layOut()
    await afterPack(context(broken.appOutDir))
    sign(broken)
    copyFileSync(otherProgram, broken.binary)
    assert.match(gateApp(broken.app), /signature does not verify/, 'signed app whose ffmpeg changed after signing: refused')
    // Broken seal: the attestation edited after signing.
    const edited = layOut()
    await afterPack(context(edited.appOutDir))
    sign(edited)
    writeFileSync(join(edited.folder, MAC_FFMPEG_ATTESTATION), readFileSync(join(edited.folder, MAC_FFMPEG_ATTESTATION), 'utf8').replace('"about"', '"About"'))
    assert.match(gateApp(edited.app), /signature does not verify/, 'signed app whose attestation changed after signing: refused')
    // A prepackaged app carrying a hand-written attestation, then signed: the seal is intact, but the
    // program is not the pinned one.
    const forged = layOut(otherProgram)
    writeFileSync(join(forged.folder, MAC_FFMPEG_ATTESTATION), JSON.stringify({ version: gatePin.version, arch: gatePin.arch, binarySha256: gatePin.binarySha256, pinSha256: shaOf(gatePinBytes) }))
    sign(forged)
    assert.match(gateApp(forged.app), /not the pinned program \(its content SHA-256/, 'signed over a forged attestation and another program: refused by the content hash')

    // Disk image and zip: unpacked or attached read-only, the app inside judged the same way.
    const zip = join(scratch, 'gate.zip')
    run('/usr/bin/ditto', ['-c', '-k', '--keepParent', signed.app, zip])
    assert.deepEqual(gate(zip).problems, [], 'a zip of the good signed app: accepted')
    const badZip = join(scratch, 'gate-bad.zip')
    run('/usr/bin/ditto', ['-c', '-k', '--keepParent', prepackaged.app, badZip])
    assert.match(gate(badZip).problems.join('\n'), /never checked by afterPack/, 'a zip of an app with no attestation: refused')
    // As electron-builder's disk image: the app and a link to /Applications.
    symlinkSync('/Applications', join(signed.appOutDir, 'Applications'))
    const dmg = join(scratch, 'gate.dmg')
    run('/usr/bin/hdiutil', ['create', '-quiet', '-fs', 'HFS+', '-format', 'UDZO', '-volname', 'TalkWeaverGate', '-srcfolder', signed.appOutDir, dmg])
    assert.deepEqual(gate(dmg).problems, [], 'a disk image of the good signed app, with its Applications link: accepted')

    // One app per package, at the top: a second app anywhere is refused; Electron's helpers are not apps
    // of their own. Each package is made from a folder holding the good signed app.
    const packageOf = (kind, build) => {
      const folder = join(scratch, `gate-package-${apps += 1}`)
      mkdirSync(folder)
      run('/usr/bin/ditto', [signed.app, join(folder, 'TalkWeaver.app')])
      build(folder)
      const out = join(scratch, `gate-package-${apps}.${kind}`)
      if (kind === 'zip') run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', folder, out])
      else run('/usr/bin/hdiutil', ['create', '-quiet', '-fs', 'HFS+', '-format', 'UDZO', '-volname', `TalkWeaverGate${apps}`, '-srcfolder', folder, out])
      return out
    }
    const nestedSecond = (folder) => { mkdirSync(join(folder, 'Other')); run('/usr/bin/ditto', [prepackaged.app, join(folder, 'Other', 'TalkWeaver.app')]) }
    assert.match(gate(packageOf('zip', nestedSecond)).problems.join('\n'), /holds a second app, Other\/TalkWeaver\.app; it must hold exactly one, at its top level/, 'a zip with a second app in a folder: refused')
    assert.match(gate(packageOf('dmg', nestedSecond)).problems.join('\n'), /holds a second app, Other\/TalkWeaver\.app/, 'so is a disk image')
    assert.match(gate(packageOf('zip', (folder) => run('/usr/bin/ditto', [prepackaged.app, join(folder, 'Spare.app')]))).problems.join('\n'), /holds 2 apps at its top level/, 'two apps at the top: refused')
    assert.match(gate(packageOf('zip', (folder) => run('/usr/bin/ditto', [prepackaged.app, join(folder, 'TalkWeaver.app', 'Contents', 'Resources', 'Inner.app')]))).problems.join('\n'), /second app inside the app, TalkWeaver\.app\/Contents\/Resources\/Inner\.app/, 'an app inside the app (not a helper): refused, signature or not')
    assert.match(gate(packageOf('zip', (folder) => run('/usr/bin/ditto', [prepackaged.app, join(folder, 'TalkWeaver.app', 'Contents', 'Frameworks', 'Other Helper.app')]))).problems.join('\n'), /second app inside the app/, 'a "helper" not named after the app: refused')
    const withHelpers = layOut()
    await afterPack(context(withHelpers.appOutDir))
    assert.deepEqual(ELECTRON_HELPERS, ['Helper', 'Helper (GPU)', 'Helper (Plugin)', 'Helper (Renderer)'], 'the helpers Electron 42 builds')
    for (const helper of ['TalkWeaver Helper.app', 'TalkWeaver Helper (GPU).app', 'TalkWeaver Helper (Plugin).app', 'TalkWeaver Helper (Renderer).app']) mkdirSync(join(withHelpers.app, 'Contents', 'Frameworks', helper, 'Contents', 'MacOS'), { recursive: true })
    assert.equal(gateApp(withHelpers.app), null, 'and its checks pass')
    assert.deepEqual(gate(withHelpers.app).problems, [], 'Electron\'s helpers in Contents/Frameworks: accepted')
    // A helper name Electron does not build: refused, even in Contents/Frameworks.
    const extraHelper = join(withHelpers.app, 'Contents', 'Frameworks', 'TalkWeaver Helper (Extra).app')
    mkdirSync(join(extraHelper, 'Contents'), { recursive: true })
    assert.match(gate(withHelpers.app).problems.join('\n'), /second app inside the app, Contents\/Frameworks\/TalkWeaver Helper \(Extra\)\.app/, 'a helper not on the list ("TalkWeaver Helper (Extra).app"): refused')
    rmSync(extraHelper, { recursive: true })
    // Anything but the app's own Contents/Resources/ffmpeg/ffmpeg named ffmpeg, anywhere: refused.
    const gpuHelper = join(withHelpers.app, 'Contents', 'Frameworks', 'TalkWeaver Helper (GPU).app')
    writeFileSync(join(gpuHelper, 'Contents', 'MacOS', 'ffmpeg'), 'x')
    assert.match(gate(withHelpers.app).problems.join('\n'), /Contents\/Frameworks\/TalkWeaver Helper \(GPU\)\.app\/Contents\/MacOS\/ffmpeg is named ffmpeg; the one ffmpeg allowed in the package is Contents\/Resources\/ffmpeg\/ffmpeg/, 'an ffmpeg file in a helper: refused')
    rmSync(join(gpuHelper, 'Contents', 'MacOS', 'ffmpeg'))
    mkdirSync(join(gpuHelper, 'Contents', 'Resources', 'ffmpeg'), { recursive: true })
    assert.match(gate(withHelpers.app).problems.join('\n'), /TalkWeaver Helper \(GPU\)\.app\/Contents\/Resources\/ffmpeg is named ffmpeg/, 'a Resources/ffmpeg folder in a helper: refused')
    rmSync(join(gpuHelper, 'Contents', 'Resources'), { recursive: true })
    const secondFfmpeg = join(withHelpers.app, 'Contents', 'Resources', 'tools', 'FFmpeg')
    mkdirSync(dirname(secondFfmpeg), { recursive: true })
    copyFileSync(withHelpers.binary, secondFfmpeg)
    assert.match(gate(withHelpers.app).problems.join('\n'), /Contents\/Resources\/tools\/FFmpeg is named ffmpeg; the one ffmpeg allowed/, 'a second ffmpeg outside any helper, in another case: refused')
    rmSync(dirname(secondFfmpeg), { recursive: true })
    symlinkSync('../Resources/ffmpeg/ffmpeg', join(withHelpers.app, 'Contents', 'MacOS', 'FFMPEG'))
    assert.match(gate(withHelpers.app).problems.join('\n'), /Contents\/MacOS\/FFMPEG is named ffmpeg/, 'a link named ffmpeg to the real one: refused')
    rmSync(join(withHelpers.app, 'Contents', 'MacOS', 'FFMPEG'))
    assert.match(gate(packageOf('zip', (folder) => writeFileSync(join(folder, 'ffmpeg'), 'x'))).problems.join('\n'), /ffmpeg is named ffmpeg; the one ffmpeg allowed in the package is TalkWeaver\.app\/Contents\/Resources\/ffmpeg\/ffmpeg/, 'an ffmpeg beside the app in a zip: refused')
    // No link of any kind inside a helper. The review's case: the GPU helper's Contents/Resources a link
    // into the app's own Resources, to a folder holding an ffmpeg.
    const shared = join(withHelpers.app, 'Contents', 'Resources', 'shared-helper')
    mkdirSync(shared)
    copyFileSync(withHelpers.binary, join(shared, 'ffmpeg'))
    symlinkSync('../../../Resources/shared-helper', join(gpuHelper, 'Contents', 'Resources'))
    assert.match(gate(withHelpers.app).problems.join('\n'), /refused: (Electron's helper holds a symbolic link|.*is named ffmpeg)/, 'a helper Resources linked to a shared folder holding an ffmpeg: refused')
    rmSync(join(shared, 'ffmpeg'))
    assert.match(gate(withHelpers.app).problems.join('\n'), /Electron's helper holds a symbolic link, Contents\/Frameworks\/TalkWeaver Helper \(GPU\)\.app\/Contents\/Resources \(\.\.\/\.\.\/\.\.\/Resources\/shared-helper\); no link is allowed inside a helper/, 'and the link alone, with nothing named ffmpeg behind it: refused')
    rmSync(join(gpuHelper, 'Contents', 'Resources'))
    rmSync(shared, { recursive: true })
    symlinkSync('MacOS', join(withHelpers.app, 'Contents', 'Frameworks', 'TalkWeaver Helper.app', 'Contents', 'Alias'))
    assert.match(gate(withHelpers.app).problems.join('\n'), /Electron's helper holds a symbolic link, Contents\/Frameworks\/TalkWeaver Helper\.app\/Contents\/Alias/, 'a link within a helper, pointing inside it: refused')
    rmSync(join(withHelpers.app, 'Contents', 'Frameworks', 'TalkWeaver Helper.app', 'Contents', 'Alias'))
    assert.deepEqual(gate(withHelpers.app).problems, [], 'and with those removed, accepted again')
    mkdirSync(join(withHelpers.app, 'Contents', 'Frameworks', 'TalkWeaver Helper.app', 'Contents', 'Nested.app'))
    assert.match(gate(withHelpers.app).problems.join('\n'), /second app inside the app, Contents\/Frameworks\/TalkWeaver Helper\.app\/Contents\/Nested\.app/, 'an app inside a helper: refused')
    // Links: none may point outside the package; inside it, they may.
    assert.match(gate(packageOf('zip', (folder) => symlinkSync('/etc', join(folder, 'etc')))).problems.join('\n'), /the link etc points outside the package \(\/etc\)/, 'an absolute link: refused')
    assert.match(gate(packageOf('zip', (folder) => symlinkSync('../../..', join(folder, 'TalkWeaver.app', 'up')))).problems.join('\n'), /the link TalkWeaver\.app\/up points outside the package/, 'a relative link out: refused')
    assert.match(gate(packageOf('dmg', (folder) => symlinkSync('/Users', join(folder, 'Applications')))).problems.join('\n'), /the link Applications points outside the package \(\/Users\)/, 'an "Applications" link to anywhere but /Applications: refused')
    assert.match(gate(packageOf('zip', (folder) => symlinkSync('/Applications', join(folder, 'Applications')))).problems.join('\n'), /the link Applications points outside/, 'and in a zip, even to /Applications')
    assert.deepEqual(gate(packageOf('zip', (folder) => symlinkSync('TalkWeaver.app/Contents/Info.plist', join(folder, 'Info.plist')))).problems, [], 'a link inside the package: accepted')
    const badDmg = join(scratch, 'gate-bad.dmg')
    run('/usr/bin/hdiutil', ['create', '-quiet', '-fs', 'HFS+', '-format', 'UDZO', '-volname', 'TalkWeaverGateBad', '-srcfolder', broken.appOutDir, badDmg])
    assert.match(gate(badDmg).problems.join('\n'), /signature does not verify/, 'a disk image of a broken app: refused')
    assert.match(gate(join(scratch, 'gate.tar')).problems.join('\n'), /does not exist/)

    // The command line: exit 1 on a refusal, 0 on a pass, never trusting electron-builder's config.
    const cli = spawnSync(process.execPath, [join(repo, 'scripts', 'verify-mac-package.mjs'), prepackaged.app], { encoding: 'utf8' })
    assert.equal(cli.status, 1, 'the command fails for a refused app')
    assert.match(cli.stderr, /FAIL .*never checked by afterPack/)
    const gateSource = readFileSync(join(repo, 'scripts', 'verify-mac-package.mjs'), 'utf8')
    assert.doesNotMatch(gateSource, /electron-builder-staged-check|require\(['"][^'"]*package\.json|\bpkg\.build\b/, 'the gate does not read the hooks')
    assert.deepEqual([...gateSource.matchAll(/\.build\??\.(\w+)(?:\??\.(\w+))?/g)].map((match) => match.slice(1).join('.')), ['mac.identity'], 'and reads one setting of the builder configuration: the team in build.mac.identity')

    // The real pinned binary, when fetched: its content hash is the pin's, and so is that of a
    // re-signed copy (hardened runtime, as electron-builder signs it).
    const real = join(repo, 'ffmpeg-mac', 'ffmpeg')
    if (existsSync(real) && shaOf(readFileSync(real)) === pin.binarySha256) {
      assert.equal(contentSha256Of(real).sha256, pin.contentSha256, 'the published binary has the pinned content hash')
      const resigned = join(tools, 'ffmpeg-resigned')
      copyFileSync(real, resigned)
      run('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', resigned])
      assert.notEqual(shaOf(readFileSync(resigned)), pin.binarySha256)
      assert.equal(contentSha256Of(resigned).sha256, pin.contentSha256, 'a re-signed copy has the same content hash')
    } else console.log('  (ffmpeg-mac/ffmpeg not fetched: the real binary\'s content hash was not checked)')
    ok('the release gate refuses an app with no attestation (prepackaged, also after an unrelated Windows stage), a wrong hash (unsigned), a broken seal and another program under a forged attestation (signed), another architecture, a signature other than a Developer ID Application of the build.mac.identity team, a second app anywhere in the package and a link out of it; accepts a good app, zip and disk image')
  }

  console.log(`\nPASS transcription set-up: ${passed} checks`)
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 })
}

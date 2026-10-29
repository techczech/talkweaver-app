import { macAppMenu, helpMenu } from '../src/main/app-menu.ts'
// The research-capture verb (src/main/research-capture.ts) against a fake `scout` on PATH: the argv it
// builds, the body on stdin, the JSON it reads, scout missing, a failing scout, and the vault
// containment refusals. Also: research/ never turns a folder into a talk, and the command registry
// pairs each research command with its verb or its chrome reason.
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureArgs, captureResearch, findScout, revealResearchFolder, withoutDetail } from '../src/main/research-capture.ts'
import { AGENT_VERBS, CHROME_COMMANDS, COMMAND_VERBS, RESEARCH_CAPTURE_VERB, researchCaptureHandler, researchRevealHandler } from '../src/main/agent-verbs.ts'
import { isSkippedScanDir, scanTalkFoldersSync } from '../src/main/talk-scan.mjs'
import { abstractPaths, talkFolderPath } from '../src/main/vault-paths.ts'
import { capturedFileName, capturedNotice, RESEARCH_KINDS } from '../src/renderer/src/lib/research-capture-wording.ts'
import { CAPTURE_KINDS } from '../src/main/research-capture.ts'
import { COMMAND_REGISTRY } from '../src/shared/command-registry.ts'

const scratch = mkdtempSync(join(tmpdir(), 'tw-research-'))
const vault = join(scratch, 'vault')
const talk = join(vault, 'bucket', 'hebb')
const outside = join(scratch, 'outside', 'talk')
const bin = join(scratch, 'bin')
const home = join(scratch, 'home')
const logs = join(scratch, 'logs')
for (const dir of [talk, outside, bin, join(home, '.cargo', 'bin'), logs]) mkdirSync(dir, { recursive: true })
writeFileSync(join(talk, 'hebb-outline.md'), '# Hebb\n')
writeFileSync(join(talk, 'a.html'), '<p>x</p>')
const rtalk = realpathSync(talk)
const rartefact = join(rtalk, 'a.html')

const FAKE = `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a"; done > "$FAKE_DIR/argv"
cat > "$FAKE_DIR/stdin"
case "$FAKE_MODE" in
  fail) echo 'no such project' >&2; exit 2 ;;
  junk) echo 'not json'; exit 0 ;;
  unindexed) printf '{"file":"research/2026-10-20-x.md","manifest":true,"corpus":null,"indexed":false,"passages":0}'; exit 0 ;;
  *) printf '{"file":"research/2026-10-20-hebb.md","manifest":true,"corpus":"talks","indexed":true,"passages":3}'; exit 0 ;;
esac
`
const fakePath = join(bin, 'scout')
writeFileSync(fakePath, FAKE)
chmodSync(fakePath, 0o755)
const env = (mode = 'ok') => ({ PATH: `${bin}:/usr/bin:/bin`, FAKE_DIR: logs, FAKE_MODE: mode })
const deps = (mode) => ({ vaultRoot: vault, env: env(mode), home })
const input = { talkDir: talk, title: ' Hebb\'s rule, one line ', kind: 'evidence', prompt: 'connections strengthening', sources: ['scout:highlights:readings/hebb.md:12', 'url:https://example.org/p'], artefact: join(talk, 'a.html'), body: 'Cells that fire together wire together.\n' }

let checks = 0
async function test(name, run) {
  await run()
  checks++
  console.log(`pass ${name}`)
}

try {
  await test('argv: every flag, values joined with =, body marker last', async () => {
    await captureResearch(input, deps())
    const argv = readFileSync(join(logs, 'argv'), 'utf8').trimEnd().split('\n')
    assert.deepEqual(argv, [
      'capture', `--project=${rtalk}`, '--kind=evidence', "--title=Hebb's rule, one line",
      '--prompt=connections strengthening',
      '--source=scout:highlights:readings/hebb.md:12', '--source=url:https://example.org/p',
      `--artefact=${rartefact}`, '--by=app:talkweaver', '--json', '-'
    ])
  })
  await test('argv: optional flags are left out', () => {
    assert.deepEqual(captureArgs({ talkDir: '/t', title: 'T', kind: 'table', body: '' }),
      ['capture', '--project=/t', '--kind=table', '--title=T', '--by=app:talkweaver', '--json', '-'])
  })
  await test('stdin carries the body; the JSON reply is parsed', async () => {
    const result = await captureResearch(input, deps())
    assert.equal(readFileSync(join(logs, 'stdin'), 'utf8'), input.body)
    assert.deepEqual(result, { ok: true, file: 'research/2026-10-20-hebb.md', corpus: 'talks', indexed: true })
  })
  await test('a capture outside every corpus comes back unindexed', async () => {
    const result = await captureResearch(input, deps('unindexed'))
    assert.deepEqual(result, { ok: true, file: 'research/2026-10-20-x.md', corpus: null, indexed: false })
  })
  await test('a title starting with a dash is still a value', async () => {
    await captureResearch({ ...input, title: '-1 degree' }, deps())
    assert.ok(readFileSync(join(logs, 'argv'), 'utf8').split('\n').includes('--title=-1 degree'))
  })
  await test('scout missing: not on PATH, not in ~/.cargo/bin', async () => {
    const result = await captureResearch(input, { vaultRoot: vault, env: { PATH: join(scratch, 'empty') }, home })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'scout-missing')
    assert.match(result.error.message, /not installed/)
  })
  await test('scout found in ~/.cargo/bin when PATH has none', () => {
    const cargo = join(home, '.cargo', 'bin', 'scout')
    writeFileSync(cargo, FAKE)
    chmodSync(cargo, 0o755)
    assert.equal(findScout({ PATH: join(scratch, 'empty') }, home, 'darwin'), cargo)
    assert.equal(findScout(env(), home, 'darwin'), fakePath)
    rmSync(cargo)
  })
  await test('non-zero exit: scout\'s raw stderr goes to the log only; the IPC handler and the agent verb return code and message', async () => {
    const logged = []
    const result = await captureResearch(input, { ...deps('fail'), log: (m) => logged.push(m) })
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'capture-failed')
    assert.equal(result.error.message, 'Scout could not file this. The research folder may not be writable.')
    assert.doesNotMatch(result.error.message, /no such project/)
    assert.match(result.error.detail, /no such project/)
    assert.ok(logged.some((m) => /no such project/.test(m)))
    const ipcLogged = []
    const viaIpc = await researchCaptureHandler(input, { vaultRootFor: () => vault, env: env('fail'), home, log: (m) => ipcLogged.push(m) })
    assert.deepEqual(Object.keys(viaIpc.error).sort(), ['code', 'message'], 'the renderer never receives scout\'s stderr')
    assert.doesNotMatch(JSON.stringify(viaIpc), /detail|no such project/)
    assert.ok(ipcLogged.some((m) => /no such project/.test(m)), 'the IPC path logs the raw stderr')
    const verbLogged = []
    const viaVerb = await RESEARCH_CAPTURE_VERB.run(input, { ...deps('fail'), log: (m) => verbLogged.push(m) })
    assert.deepEqual(Object.keys(viaVerb.error).sort(), ['code', 'message'], 'the agent verb result has no detail either')
    assert.doesNotMatch(JSON.stringify(viaVerb), /detail|no such project/)
    assert.ok(verbLogged.some((m) => /no such project/.test(m)), 'the agent path logs the raw stderr')
    assert.deepEqual(withoutDetail(result), viaVerb, 'one strip function: the verb result is the stripped captureResearch result')
  })
  await test('an unreadable reply is a failure, not a silent success', async () => {
    const result = await captureResearch(input, deps('junk'))
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'capture-failed')
  })
  await test('containment: a folder outside the vault is refused and scout is never run', async () => {
    rmSync(join(logs, 'argv'), { force: true })
    for (const talkDir of [outside, join(vault, '..', 'outside', 'talk'), vault, '/']) {
      const result = await captureResearch({ ...input, talkDir }, deps())
      assert.equal(result.ok, false)
      assert.equal(result.error.code, 'outside-vault')
    }
    assert.equal(existsSync(join(logs, 'argv')), false)
  })
  await test('containment: a symlink inside the vault that leaves it is refused', async () => {
    const link = join(vault, 'bucket', 'escape')
    symlinkSync(join(scratch, 'outside'), link)
    const result = await captureResearch({ ...input, talkDir: join(link, 'talk') }, deps())
    assert.equal(result.error.code, 'outside-vault')
  })
  await test('no vault open: refused', async () => {
    const result = await captureResearch(input, { vaultRoot: null, env: env(), home })
    assert.equal(result.error.code, 'outside-vault')
  })
  await test('talk folder missing: named, scout not run', async () => {
    const result = await captureResearch({ ...input, talkDir: join(vault, 'bucket', 'gone') }, deps())
    assert.equal(result.error.code, 'talk-folder-missing')
  })
  await test('input: empty title, unknown kind', async () => {
    assert.equal((await captureResearch({ ...input, title: '   ' }, deps())).error.code, 'invalid-input')
    assert.equal((await captureResearch({ ...input, kind: 'poem' }, deps())).error.code, 'invalid-input')
  })
  await test('reveal: creates research/ once, hands it to Finder, refuses outside the vault', () => {
    const shown = []
    const result = revealResearchFolder(talk, { vaultRoot: vault, reveal: (path) => shown.push(path) })
    assert.deepEqual(result, { ok: true, path: join(rtalk, 'research') })
    assert.ok(existsSync(join(talk, 'research')))
    assert.deepEqual(shown, [join(rtalk, 'research')])
    assert.equal(revealResearchFolder(outside, { vaultRoot: vault, reveal: (path) => shown.push(path) }).ok, false)
    assert.equal(shown.length, 1)
    assert.equal(existsSync(join(outside, 'research')), false)
  })
  await test('research/ never becomes a talk: parent without an outline, research/ holding x-outline.md and x-abstract.md', () => {
    const parent = join(vault, 'bucket2', 'notes')
    mkdirSync(join(parent, 'research'), { recursive: true })
    writeFileSync(join(parent, 'research', 'x-outline.md'), '# not an outline\n')
    writeFileSync(join(parent, 'research', 'x-abstract.md'), '# not an abstract\n')
    writeFileSync(join(parent, 'RESEARCH-note.md'), 'x')
    assert.deepEqual(scanTalkFoldersSync(vault).map((t) => t.dir), [talk])
    assert.equal(isSkippedScanDir('research'), true)
    assert.equal(isSkippedScanDir('Research'), true)
    assert.equal(isSkippedScanDir('researchers'), false)
    const paths = abstractPaths(vault, parent)
    assert.equal(paths.ok, true)
    assert.equal(paths.readPath, null)
    assert.deepEqual(paths.candidates, [])
    assert.equal(paths.writePath, join(parent, 'notes-abstract.md'))
    assert.equal(abstractPaths(vault, join(parent, 'research')).ok, false)
  })
  await test('an empty <vault>/Research folder is not a talk: the resolver refuses it and abstract:write gets no path', () => {
    const upper = join(vault, 'Research')
    mkdirSync(upper, { recursive: true })
    assert.equal(talkFolderPath(vault, upper).ok, false)
    assert.equal(talkFolderPath(vault, join(upper, 'x')).ok, false)
    const paths = abstractPaths(vault, upper)
    assert.equal(paths.ok, false)
    assert.equal(paths.writePath, undefined)
    assert.equal(existsSync(join(upper, 'Research-abstract.md')), false)
    rmSync(upper, { recursive: true, force: true })
  })
  await test('research/ under an intact talk is not a talk either', () => {
    writeFileSync(join(talk, 'research', 'old-outline.md'), '# no\n')
    assert.deepEqual(scanTalkFoldersSync(vault).map((t) => t.dir), [talk])
  })
  await test('vault index walk skips research/ too', async () => {
    const { isSkippedScanDir: skip } = await import('../src/main/talk-scan.mjs')
    assert.equal(skip('research'), true)
  })
  await test('relative talkDir that exists in the cwd is refused; scout not run; Reveal creates nothing', async () => {
    const cwd = process.cwd()
    mkdirSync(join(scratch, 'cwd', 'relative-talk'), { recursive: true })
    writeFileSync(join(scratch, 'cwd', 'relative-talk', 'r-outline.md'), '#')
    process.chdir(join(scratch, 'cwd'))
    try {
      rmSync(join(logs, 'argv'), { force: true })
      const rel = { ...input, talkDir: 'relative-talk' }
      assert.equal((await captureResearch(rel, { vaultRoot: join(scratch, 'cwd'), env: env(), home })).error.code, 'invalid-input')
      assert.equal((await researchCaptureHandler(rel, { vaultRootFor: () => join(scratch, 'cwd'), env: env(), home })).ok, false)
      assert.equal(existsSync(join(logs, 'argv')), false)
      assert.equal(revealResearchFolder('relative-talk', { vaultRoot: join(scratch, 'cwd'), reveal: () => assert.fail('revealed') }).ok, false)
      assert.equal(existsSync(join(scratch, 'cwd', 'relative-talk', 'research')), false)
    } finally { process.chdir(cwd) }
  })
  await test('the canonical real path is what scout, mkdir and reveal get (a symlinked talk path inside the vault)', async () => {
    const alias = join(vault, 'bucket', 'alias')
    symlinkSync(talk, alias)
    await captureResearch({ ...input, talkDir: alias }, deps())
    assert.ok(readFileSync(join(logs, 'argv'), 'utf8').split('\n').includes(`--project=${rtalk}`))
    rmSync(alias)
  })
  await test('a symlinked vault with research above its real root accepts a normal talk', async () => {
    const realVault = join(scratch, 'research', 'real-vault')
    const realTalk = join(realVault, 'normal-talk')
    mkdirSync(realTalk, { recursive: true })
    writeFileSync(join(realTalk, 'normal-talk-outline.md'), '# Normal talk\n')
    const aliasVault = join(scratch, 'vault-alias')
    symlinkSync(realVault, aliasVault)
    const aliasTalk = join(aliasVault, 'normal-talk')
    const result = await captureResearch({ ...input, talkDir: aliasTalk, artefact: undefined }, { ...deps(), vaultRoot: aliasVault })
    assert.equal(result.ok, true)
    assert.ok(readFileSync(join(logs, 'argv'), 'utf8').split('\n').includes(`--project=${realpathSync(realTalk)}`))
    const shown = []
    assert.deepEqual(revealResearchFolder(aliasTalk, { vaultRoot: aliasVault, reveal: (path) => shown.push(path) }), {
      ok: true, path: join(realpathSync(realTalk), 'research')
    })
    assert.deepEqual(shown, [join(realpathSync(realTalk), 'research')])
  })
  await test('reveal: research/ as a symlink out of the vault, or a file, is refused and nothing is revealed', () => {
    const t2 = join(vault, 'bucket', 'linked'); mkdirSync(t2, { recursive: true }); writeFileSync(join(t2, 'l-outline.md'), '#')
    const ext = join(scratch, 'outside', 'ext'); mkdirSync(ext, { recursive: true })
    symlinkSync(ext, join(t2, 'research'))
    const shown = []
    const r = revealResearchFolder(t2, { vaultRoot: vault, reveal: (p) => shown.push(p) })
    assert.equal(r.ok, false)
    assert.deepEqual(shown, [])
    const t3 = join(vault, 'bucket', 'filed'); mkdirSync(t3, { recursive: true }); writeFileSync(join(t3, 'f-outline.md'), '#')
    writeFileSync(join(t3, 'research'), 'a file')
    assert.equal(revealResearchFolder(t3, { vaultRoot: vault, reveal: (p) => shown.push(p) }).ok, false)
    assert.deepEqual(shown, [])
  })
  await test('an in-vault folder without an outline is "not a talk"; capture and reveal refuse', async () => {
    const bare = join(vault, 'bucket', 'plain'); mkdirSync(bare, { recursive: true })
    rmSync(join(logs, 'argv'), { force: true })
    const r = await captureResearch({ ...input, talkDir: bare }, deps())
    assert.equal(r.error.code, 'not-a-talk')
    assert.equal(r.error.message, 'This folder is not a talk.')
    assert.equal(existsSync(join(logs, 'argv')), false)
    const v = revealResearchFolder(bare, { vaultRoot: vault, reveal: () => assert.fail('revealed') })
    assert.equal(v.error.message, 'This folder is not a talk.')
    assert.equal(existsSync(join(bare, 'research')), false)
  })
  await test('a talk under <vault>/Research (any case) is "not a talk" even with an outline; capture and reveal refuse', async () => {
    const upper = join(vault, 'Research', 't'); mkdirSync(upper, { recursive: true }); writeFileSync(join(upper, 't-outline.md'), '# t\n')
    const lower = join(vault, 'research', 't'); mkdirSync(lower, { recursive: true }); writeFileSync(join(lower, 't-outline.md'), '# t\n')
    rmSync(join(logs, 'argv'), { force: true })
    for (const dir of [upper, lower]) {
      const r = await captureResearch({ ...input, talkDir: dir }, deps())
      assert.equal(r.ok, false, dir)
      assert.equal(r.error.code, 'not-a-talk', dir)
      assert.equal(r.error.message, 'This folder is not a talk.')
      const v = revealResearchFolder(dir, { vaultRoot: vault, reveal: () => assert.fail('revealed') })
      assert.equal(v.ok, false, dir)
      assert.equal(v.error.code, 'not-a-talk', dir)
      assert.equal(existsSync(join(dir, 'research')), false, dir)
    }
    assert.equal(existsSync(join(logs, 'argv')), false)
    rmSync(join(vault, 'Research'), { recursive: true, force: true })
    rmSync(join(vault, 'research'), { recursive: true, force: true })
  })
  await test('malformed input: null, undefined, wrong types, NUL bytes, unknown kind -> invalid-input, scout never run', async () => {
    rmSync(join(logs, 'argv'), { force: true })
    const cases = [null, undefined, 'x', 7, [], {}, { ...input, talkDir: 5 }, { ...input, title: 5 }, { ...input, kind: 5 }, { ...input, kind: 'poem' }, { ...input, body: {} },
      { ...input, prompt: { a: 1 } }, { ...input, sources: 'scout:x' }, { ...input, sources: [1] }, { ...input, artefact: 3 },
      { ...input, title: 'a\0b' }, { ...input, body: 'a\0b' }, { ...input, prompt: 'a\0b' }, { ...input, sources: ['a\0b'] }, { ...input, artefact: 'a\0b' }, { ...input, talkDir: `${talk}\0x` }, { ...input, title: '   ' }]
    for (const bad of cases) {
      for (const result of [await captureResearch(bad, deps()), await researchCaptureHandler(bad, { vaultRootFor: () => vault, env: env(), home })]) {
        assert.equal(result.ok, false, JSON.stringify(bad))
        assert.equal(result.error.code, 'invalid-input', JSON.stringify(bad))
      }
    }
    assert.equal(existsSync(join(logs, 'argv')), false)
  })
  await test('artefact: only a file inside the vault; relative, outside, directory and missing are refused', async () => {
    rmSync(join(logs, 'argv'), { force: true })
    const outsideFile = join(scratch, 'outside', 'secret.txt'); writeFileSync(outsideFile, 's')
    for (const artefact of [outsideFile, 'a.html', join(talk), join(talk, 'missing.html'), join(vault, '..', 'outside', 'secret.txt')]) {
      const r = await captureResearch({ ...input, artefact }, deps())
      assert.equal(r.ok, false, artefact)
      assert.equal(r.error.code, 'outside-vault', artefact)
    }
    assert.equal(existsSync(join(logs, 'argv')), false)
    assert.equal((await captureResearch({ ...input, artefact: join(talk, 'a.html') }, deps())).ok, true)
  })
  await test('body is on stdin and no flag carries a path to it', async () => {
    await captureResearch(input, deps())
    const argv = readFileSync(join(logs, 'argv'), 'utf8').trimEnd().split('\n')
    assert.equal(argv.at(-1), '-')
    assert.ok(!argv.some((a) => a.includes(input.body.trim())))
    assert.equal(readFileSync(join(logs, 'stdin'), 'utf8'), input.body)
  })
  await test('the IPC handler and the registered agent verb reach the same implementation', async () => {
    const verb = AGENT_VERBS.find((v) => v.id === 'research.capture')
    assert.equal(verb, RESEARCH_CAPTURE_VERB)
    await verb.run(input, deps())
    const viaVerb = readFileSync(join(logs, 'argv'), 'utf8')
    rmSync(join(logs, 'argv'))
    await researchCaptureHandler(input, { vaultRootFor: () => vault, env: env(), home })
    assert.equal(readFileSync(join(logs, 'argv'), 'utf8'), viaVerb)
    // The handler delegates to the verb's run: replace it and the handler follows.
    const original = verb.run
    const seen = []
    verb.run = async (i, d) => { seen.push([i, d.vaultRoot]); return { ok: false, error: { code: 'capture-failed', message: 'stubbed' } } }
    try {
      const r = await researchCaptureHandler(input, { vaultRootFor: () => vault, env: env(), home })
      assert.equal(r.error.message, 'stubbed')
      assert.deepEqual(seen, [[input, vault]])
    } finally { verb.run = original }
    assert.equal(verb.run, original)
  })
  await test('the IPC reveal handler resolves the vault and reveals through the same check', () => {
    const shown = []
    const r = researchRevealHandler(talk, { vaultRootFor: () => vault, reveal: (p) => shown.push(p) })
    assert.equal(r.ok, true)
    assert.deepEqual(shown, [join(rtalk, 'research')])
    assert.equal(researchRevealHandler(null, { vaultRootFor: () => vault, reveal: () => assert.fail('x') }).ok, false)
  })
  await test('sheet wording: the kinds are the contract\'s, the notice names the file', () => {
    assert.deepEqual(RESEARCH_KINDS.map((k) => k.value), [...CAPTURE_KINDS])
    assert.equal(capturedFileName('research/2026-10-20-hebb.md'), '2026-10-20-hebb.md')
    assert.equal(capturedNotice('/v/t/research/a.md', true), 'Filed a.md in the research folder.')
    assert.match(capturedNotice('a.md', false), /not in a search index yet/)
  })
  await test('registry: the content command has a verb, the chrome command a reason', async () => {
    const mainSource = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
    const fallback = mainSource.slice(mainSource.indexOf('function installFallbackMenu()'), mainSource.indexOf("\n}\n", mainSource.indexOf('function installFallbackMenu()')) + 3)
    const { stripTypeScriptTypes } = await import('node:module')
    const { runInNewContext } = await import('node:vm')
    let template
    runInNewContext(stripTypeScriptTypes(fallback + '\ninstallFallbackMenu()'), {
      process: {platform:'darwin'}, menuCommands: () => [{label:'Research',menu:{path:['View']},handlerId:'research-panel'}], commandElectronAccelerator: () => 'CmdOrCtrl+Shift+R',
      app: { name: 'TalkWeaver' }, macAppMenu, helpMenu,
      Menu:{buildFromTemplate: value => value,setApplicationMenu: value => {template=value}}, targetEditorFor: () => null
    })
    assert.equal(template.filter(item => item.label === 'View' || item.role === 'viewMenu').length, 1)
    assert.ok(!JSON.stringify(template).includes('forceReload'))
    const verbIds = new Set(AGENT_VERBS.map((v) => v.id))
    const commands = new Set(COMMAND_REGISTRY.map((c) => c.id))
    for (const [id, verb] of Object.entries(COMMAND_VERBS)) {
      assert.ok(commands.has(id), `${id} is not a registry command`)
      assert.ok(verbIds.has(verb), `${id} has no verb ${verb}`)
    }
    for (const [id, reason] of Object.entries(CHROME_COMMANDS)) {
      assert.ok(commands.has(id), `${id} is not a registry command`)
      assert.ok(['ui-navigation', 'presentation', 'duplicate-of'].includes(reason))
    }
    for (const c of COMMAND_REGISTRY.filter(c => c.id.startsWith('research-'))) assert.ok(COMMAND_VERBS[c.id] || CHROME_COMMANDS[c.id], `${c.id} lacks a verb or chrome reason`)
    const capture = AGENT_VERBS.find((v) => v.id === 'research.capture')
    assert.equal(capture.posture, 'direct')
    assert.equal(capture.tier, 'content')
  })
  console.log(`${checks} checks passed`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

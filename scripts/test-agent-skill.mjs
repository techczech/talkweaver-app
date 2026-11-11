// The built-in agent skill's write path (src/main/agent-skill/, src/shared/agent-skill/), plain Node.
// EVERY test runs against a disposable HOME in the system temp folder, with a probe that never looks
// outside it: the real HOME and the real agents' folders are never read or written.
//   first connect; refresh after a version change; a lower version refused; a symlinked folder and an
//   unmarked folder untouched; an edited file kept (Replace overrides it); remove leaves everything else;
//   two agents sharing one real folder written once; a read-only folder reported (and refresh does not
//   throw); an agent that was not found is never written for; install covers only the agents named;
//   Gemini CLI reading Codex's copy; the shim's marker; the `agent` command's parser and exit codes.
import { strict as assert } from 'node:assert'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareVersions } from '../src/shared/agent-skill/versions.ts'
import { createAgentSkills } from '../src/main/agent-skill/service.ts'
import { runAgentCli, parseAgentArgs } from '../src/main/agent-skill/cli.ts'
import { generateShim, installShim, shimMarker, shimStatus } from '../src/main/agent-skill/shim.ts'
import { removeSkillFolder, writeSkillFolder } from '../src/main/agent-skill/folder.ts'
import { createFileStateStore } from '../src/main/agent-skill/state-files.ts'
import { AGENT_TABLE } from '../src/shared/agent-skill/agents.ts'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadSkillSource } from '../src/main/agent-skill/skill-source.ts'
import { agentIdsArg, agentSkillStateStore, decideOnboarding } from '../src/main/agent-skill-host.ts'
import { nodeProbe } from '../src/main/agent-skill/probe.ts'
import { EMPTY_STATE } from '../src/shared/agent-skill/types.ts'
import { skillWording } from '../src/shared/agent-skill/wording.ts'

const roots = []
const tmp = (label) => { const d = realpathSync(mkdtempSync(join(tmpdir(), `agent-skill-${label}-`))); roots.push(d); return d }
process.on('exit', () => { for (const r of roots) try { chmodSync(join(r, 'home', '.agents'), 0o755) } catch {} ; for (const r of roots) rmSync(r, { recursive: true, force: true }) })

const CLI = { command: 'talkweaver', appName: 'TalkWeaver', bundleId: 'net.example.talkweaver' }

/** A stamped skill folder at `version`. */
function makeSkill(root, version, body = 'Use it.') {
  const dir = join(root, `skill-${version}`)
  mkdirSync(join(dir, 'references'), { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: talkweaver\ndescription: test\nmetadata:\n  app: talkweaver\n  app-version: ${version}\n---\n\n${body}\n`)
  writeFileSync(join(dir, 'references', 'a.md'), `reference ${version}\n`)
  return dir
}

/** A disposable computer: HOME, a probe that cannot see outside it, and the app names to show in /Applications. */
function computer({ agents = [], apps = [] } = {}) {
  const root = tmp('c')
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  for (const a of agents) mkdirSync(join(home, a), { recursive: true })
  const real = nodeProbe()
  const probe = {
    stat: (p) => (p.startsWith(home) ? real.stat(p) : Promise.resolve(null)),
    list: (p) => Promise.resolve(p === '/Applications' ? apps : [])
  }
  return { root, home, probe }
}

/** An in-memory store with the file store's interface; `seed` is a whole state, as the older tests hold it. */
function memoryStore(seed) {
  const agents = new Map(); const changes = []
  let app = null
  if (seed) {
    app = { format: 1, appVersion: seed.appVersion ?? null, onboarded: seed.onboarded === true }
    for (const [id, v] of Object.entries(seed.agents ?? {})) agents.set(id, JSON.parse(JSON.stringify(v)))
    changes.push(...(seed.changes ?? []))
  }
  const clone = (v) => JSON.parse(JSON.stringify(v))
  return {
    readApp: () => (app ? clone(app) : null),
    writeApp: (patch) => { app = { ...(app ?? { format: 1, appVersion: null, onboarded: false }), ...patch } },
    readAgent: (id) => (agents.has(id) ? clone(agents.get(id)) : null),
    writeAgent: (id, r) => { agents.set(id, { choice: r.choice, offered: r.offered, lastResult: agents.get(id)?.lastResult ?? null }) },
    writeResult: (id, r) => { agents.set(id, { ...(agents.get(id) ?? { choice: null, offered: false }), lastResult: clone(r) }) },
    readChanges: () => clone(changes),
    appendChange: (n) => { changes.push(clone(n)) },
    view: () => ({ format: 1, appVersion: app?.appVersion ?? null, onboarded: app?.onboarded ?? false, agents: Object.fromEntries(agents), changes: clone(changes) })
  }
}

function service(c, version, { store, skillDir, rawStore } = {}) {
  const s = rawStore ?? memoryStore(store ?? { ...EMPTY_STATE, agents: {}, changes: [] })
  const svc = createAgentSkills({
    appId: 'talkweaver', appName: 'TalkWeaver', skillName: 'talkweaver', version,
    skillDir: skillDir ?? makeSkill(c.root, version), cli: CLI, store: s, home: c.home, env: { PATH: '' }, platform: 'darwin', probe: c.probe
  })
  return { svc, state: () => s.view() }
}

const text = (p) => readFileSync(p, 'utf8')
const skillOf = (c, rel) => join(c.home, rel, 'talkweaver')

// ── versions ───────────────────────────────────────────────────────────────────────────────────
assert.equal(compareVersions('0.42.0-alpha.18', '0.42.0-alpha.19'), -1)
assert.equal(compareVersions('0.42.0', '0.42.0-alpha.19'), 1)
assert.equal(compareVersions('0.42.0-alpha.2', '0.42.0-alpha.10'), -1)
assert.equal(compareVersions('1.0', '1.0.0'), 0)
assert.equal(compareVersions('x', '1.0.0'), null)

// ── first connect ──────────────────────────────────────────────────────────────────────────────
{
  const c = computer({ agents: ['.claude', '.codex'] })
  const { svc, state } = service(c, '0.42.0')
  const before = await svc.status()
  assert.deepEqual(before.agents.filter((a) => a.found).map((a) => a.id), ['claude-code', 'codex'])
  assert.ok(!existsSync(join(c.home, '.claude', 'skills')), 'nothing written by looking')
  const r = await svc.install(['claude-code', 'codex'])
  assert.equal(r.ok, true)
  assert.deepEqual(r.rows.map((x) => x.result), ['installed', 'installed'])
  assert.equal(text(join(skillOf(c, '.claude/skills'), 'references', 'a.md')), 'reference 0.42.0\n')
  const marker = JSON.parse(text(join(skillOf(c, '.agents/skills'), '.app-skill.json')))
  assert.equal(marker.app, 'talkweaver'); assert.equal(marker.version, '0.42.0'); assert.ok(marker.files['SKILL.md'])
  assert.ok(existsSync(join(c.home, '.local', 'bin', 'talkweaver')), 'the command is installed with the skill')
  assert.equal(r.cli.state, 'installed')
  assert.equal(state().agents['codex'].choice, 'connected')
  assert.equal(state().changes.length, 2, 'recorded in the changelog')
  assert.equal(readdirSync(join(c.home, '.agents', 'skills')).join(), 'talkweaver', 'no temporary folders left')
  const again = await svc.install(['codex'])
  assert.equal(again.rows[0].result, 'unchanged')
  const st = await svc.status()
  assert.equal(st.agents.find((a) => a.id === 'codex').state, 'installed')
  assert.equal(st.agents.find((a) => a.id === 'codex').version, '0.42.0')
}

// ── install covers only the agents named; an agent not found is never written for ─────────────
{
  const c = computer({ agents: ['.claude'] })
  const { svc } = service(c, '0.42.0')
  const r = await svc.install(['codex'])
  assert.equal(r.rows[0].result, 'not-found')
  assert.ok(!existsSync(join(c.home, '.agents')), 'no folder made for an agent that was not found')
  const t3 = await svc.install(['t3-code'])
  assert.equal(t3.rows[0].result, 'unsupported')
  await svc.install(['claude-code'])
  assert.ok(!existsSync(join(c.home, '.agents')), 'claude only')
}

// ── refresh after a version change; never adds an agent; a lower version never overwrites a higher ─
{
  const c = computer({ agents: ['.claude', '.codex'] })
  const a = service(c, '0.42.0')
  await a.svc.install(['claude-code'])
  const b = service(c, '0.43.0', { store: a.state() })
  const r = await b.svc.refresh()
  assert.equal(r.rows.length, 1, 'only the agent the person installed')
  assert.equal(r.rows[0].result, 'updated')
  assert.equal(text(join(skillOf(c, '.claude/skills'), 'references', 'a.md')), 'reference 0.43.0\n')
  assert.ok(!existsSync(skillOf(c, '.agents/skills')), 'codex was never added')
  assert.equal(await b.svc.refresh(), null, 'same version again: nothing to do')
  // a preview next to a release: the lower version leaves the higher one alone
  const low = service(c, '0.42.1-alpha.1', { store: { ...b.state(), appVersion: null } })
  const lr = await low.svc.refresh()
  assert.equal(lr.rows[0].result, 'kept')
  assert.equal(text(join(skillOf(c, '.claude/skills'), 'references', 'a.md')), 'reference 0.43.0\n')
  const lowInstall = await low.svc.install(['claude-code'])
  assert.equal(lowInstall.rows[0].result, 'kept')
  // Replace overrides it
  const rep = await low.svc.install(['claude-code'], { replace: true })
  assert.equal(rep.rows[0].result, 'updated')
}

// ── symlinked folder untouched; unmarked folder untouched ─────────────────────────────────────
{
  const c = computer({ agents: ['.claude', '.codex'] })
  const elsewhere = join(c.root, 'skills-repo', 'talkweaver')
  mkdirSync(elsewhere, { recursive: true })
  writeFileSync(join(elsewhere, 'SKILL.md'), '---\nname: talkweaver\nmetadata:\n  app: talkweaver\n  app-version: 0.40.0\n---\nmine\n')
  mkdirSync(join(c.home, '.claude', 'skills'), { recursive: true })
  symlinkSync(elsewhere, skillOf(c, '.claude/skills'))
  mkdirSync(join(c.home, '.agents', 'skills', 'talkweaver'), { recursive: true })
  writeFileSync(join(skillOf(c, '.agents/skills'), 'SKILL.md'), '---\nname: other\n---\nsomeone else\n')
  const { svc } = service(c, '0.42.0')
  const st = await svc.status()
  const claude = st.agents.find((a) => a.id === 'claude-code')
  assert.equal(claude.state, 'separate'); assert.equal(claude.version, '0.40.0'); assert.equal(claude.canReplace, false)
  assert.equal(st.agents.find((a) => a.id === 'codex').state, 'kept')
  const r = await svc.install(['claude-code', 'codex'], { replace: true })
  assert.deepEqual(r.rows.map((x) => x.result), ['kept', 'kept'], 'not even Replace writes through a link or into an unmarked folder')
  assert.ok(lstatSync(skillOf(c, '.claude/skills')).isSymbolicLink())
  assert.equal(readdirSync(elsewhere).join(), 'SKILL.md')
  assert.equal(text(join(skillOf(c, '.agents/skills'), 'SKILL.md')), '---\nname: other\n---\nsomeone else\n')
  assert.equal(readdirSync(skillOf(c, '.agents/skills')).join(), 'SKILL.md')
  const rm = await svc.remove(['claude-code', 'codex'])
  assert.deepEqual(rm.rows.map((x) => x.result), ['kept', 'kept'])
  assert.ok(existsSync(join(elsewhere, 'SKILL.md')))
}

// ── a plain separately installed copy: offered Replace, replaced only on request ───────────────
{
  const c = computer({ agents: ['.codex'] })
  mkdirSync(skillOf(c, '.agents/skills'), { recursive: true })
  writeFileSync(join(skillOf(c, '.agents/skills'), 'SKILL.md'), '---\nname: talkweaver\nmetadata:\n  app: talkweaver\n  app-version: 0.40.0\n---\nold\n')
  const { svc } = service(c, '0.42.0')
  assert.equal((await svc.status()).agents.find((a) => a.id === 'codex').canReplace, true)
  assert.equal((await svc.install(['codex'])).rows[0].result, 'kept')
  assert.equal((await svc.install(['codex'], { replace: true })).rows[0].result, 'updated')
  assert.ok(existsSync(join(skillOf(c, '.agents/skills'), '.app-skill.json')))
}

// ── an edited file is kept; Replace overrides; remove refuses it ───────────────────────────────
{
  const c = computer({ agents: ['.codex'] })
  const a = service(c, '0.42.0')
  await a.svc.install(['codex'])
  writeFileSync(join(skillOf(c, '.agents/skills'), 'SKILL.md'), 'my own words\n')
  const b = service(c, '0.43.0', { store: a.state() })
  const r = await b.svc.refresh()
  assert.equal(r.rows[0].result, 'kept')
  assert.equal(text(join(skillOf(c, '.agents/skills'), 'SKILL.md')), 'my own words\n')
  const row = (await b.svc.status()).agents.find((x) => x.id === 'codex')
  assert.equal(row.state, 'changed'); assert.equal(row.canReplace, true); assert.equal(row.canRemove, false)
  assert.equal((await b.svc.remove(['codex'])).rows[0].result, 'kept')
  assert.equal((await b.svc.install(['codex'], { replace: true })).rows[0].result, 'updated')
  assert.match(text(join(skillOf(c, '.agents/skills'), 'SKILL.md')), /app-version: 0.43.0/)
  // a file added to the folder also counts as an edit
  writeFileSync(join(skillOf(c, '.agents/skills'), 'extra.md'), 'x')
  assert.equal((await b.svc.status()).agents.find((x) => x.id === 'codex').state, 'changed')
}

// ── remove leaves everything else ─────────────────────────────────────────────────────────────
{
  const c = computer({ agents: ['.claude', '.codex'] })
  mkdirSync(join(c.home, '.claude', 'skills', 'other-skill'), { recursive: true })
  writeFileSync(join(c.home, '.claude', 'skills', 'other-skill', 'SKILL.md'), 'keep me')
  const { svc, state } = service(c, '0.42.0')
  await svc.install(['claude-code', 'codex'])
  const r = await svc.remove(['claude-code'])
  assert.equal(r.rows[0].result, 'removed')
  assert.ok(!existsSync(skillOf(c, '.claude/skills')))
  assert.equal(text(join(c.home, '.claude', 'skills', 'other-skill', 'SKILL.md')), 'keep me')
  assert.ok(existsSync(join(c.home, '.claude', 'skills')), 'the agent\'s skills folder stays')
  assert.ok(existsSync(skillOf(c, '.agents/skills')), 'codex untouched')
  assert.equal(state().agents['claude-code'].choice, 'removed')
  assert.deepEqual(readdirSync(join(c.home, '.claude', 'skills')), ['other-skill'])
  // after a removal a refresh does not bring it back
  const b = service(c, '0.43.0', { store: state() })
  const rr = await b.svc.refresh()
  assert.deepEqual(rr.rows.map((x) => x.id), ['codex'])
  assert.ok(!existsSync(skillOf(c, '.claude/skills')))
}

// ── two agents sharing one real folder: written once ───────────────────────────────────────────
{
  const c = computer({ agents: ['.claude', '.codex'] })
  mkdirSync(join(c.home, '.agents', 'skills'), { recursive: true })
  symlinkSync(join(c.home, '.agents', 'skills'), join(c.home, '.claude', 'skills'))
  const { svc } = service(c, '0.42.0')
  const r = await svc.install(['claude-code', 'codex'])
  assert.equal(r.written.length, 1, 'one real folder, written once')
  assert.deepEqual(r.rows.map((x) => x.result), ['installed', 'installed'])
  assert.ok(!lstatSync(skillOf(c, '.agents/skills')).isSymbolicLink())
  assert.equal(readdirSync(join(c.home, '.agents', 'skills')).join(), 'talkweaver')
  const rm = await svc.remove(['claude-code', 'codex'])
  assert.deepEqual(rm.rows.map((x) => x.result), ['removed', 'removed'])
}

// ── a read-only folder is reported and nothing throws ─────────────────────────────────────────
if (process.getuid && process.getuid() !== 0) {
  const c = computer({ agents: ['.codex'] })
  mkdirSync(join(c.home, '.agents'), { recursive: true })
  chmodSync(join(c.home, '.agents'), 0o555)
  const a = service(c, '0.42.0')
  const r = await a.svc.install(['codex'])
  assert.equal(r.rows[0].result, 'failed'); assert.equal(r.ok, false)
  assert.match(r.rows[0].message, /read-only/)
  const row = (await a.svc.status()).agents.find((x) => x.id === 'codex')
  assert.equal(row.state, 'failed'); assert.equal(row.canInstall, true)
  assert.ok(!existsSync(join(c.home, '.agents', 'skills')))
  // and a refresh over a folder that became read-only does not throw
  chmodSync(join(c.home, '.agents'), 0o755)
  await a.svc.install(['codex'])
  chmodSync(join(c.home, '.agents', 'skills'), 0o555)
  const b = service(c, '0.43.0', { store: a.state() })
  const rr = await b.svc.refresh()
  assert.equal(rr.rows[0].result, 'failed')
  chmodSync(join(c.home, '.agents', 'skills'), 0o755)
  assert.match(text(join(skillOf(c, '.agents/skills'), 'SKILL.md')), /app-version: 0.42.0/, 'the old copy is intact')
  // once the folder is writable again the next launch finishes the update, and only then is the version recorded
  assert.equal((await b.svc.refresh()).rows[0].result, 'updated', 'a failed refresh is tried again')
  assert.match(text(join(skillOf(c, '.agents/skills'), 'SKILL.md')), /app-version: 0.43.0/)
  assert.equal(await b.svc.refresh(), null, 'nothing left to retry')
}

// ── Gemini CLI reads Codex's copy; T3 Code comes along; Antigravity found by its app ───────────
{
  const c = computer({ agents: ['.codex'], apps: ['Antigravity.app', 'T3 Code.app'] })
  mkdirSync(join(c.home, '.local', 'bin'), { recursive: true })
  writeFileSync(join(c.home, '.local', 'bin', 'gemini'), '#!/bin/sh\n', { mode: 0o755 })
  const { svc } = service(c, '0.42.0')
  const st = await svc.status()
  assert.deepEqual(st.agents.filter((a) => a.found).map((a) => a.id), ['codex', 'gemini-cli', 'antigravity', 't3-code'])
  assert.equal(st.agents.find((a) => a.id === 't3-code').state, 'via')
  const offer = await svc.offer()
  assert.equal(offer.kind, 'first-run')
  assert.deepEqual(offer.agents.map((a) => a.id), ['codex', 'gemini-cli', 'antigravity'])
  assert.deepEqual(offer.via, [{ name: 'T3 Code', through: ['Codex'] }])
  const r = await svc.answerOffer(['codex', 'gemini-cli', 'antigravity'], [])
  assert.deepEqual(r.rows.map((x) => x.result), ['installed', 'unchanged', 'installed'])
  assert.ok(!existsSync(join(c.home, '.gemini', 'skills')), 'Gemini reads the Codex copy; it gets none of its own')
  assert.ok(existsSync(skillOf(c, '.gemini/antigravity/skills')))
  assert.equal((await svc.status()).agents.find((a) => a.id === 'gemini-cli').state, 'shared')
}

// ── the offer: first run, Not now is final, a later agent gets one offer once ─────────────────
{
  const c = computer({ agents: ['.claude'] })
  const a = service(c, '0.42.0')
  assert.equal((await a.svc.offer()).kind, 'first-run')
  await a.svc.answerOffer([], ['claude-code'])
  assert.equal((await a.svc.offer()).kind, 'none', 'Not now is final')
  mkdirSync(join(c.home, '.codex'))
  const later = await a.svc.offer()
  assert.equal(later.kind, 'later'); assert.deepEqual(later.agents.map((x) => x.id), ['codex'])
  await a.svc.offerShown(['codex'])
  assert.equal((await a.svc.offer()).kind, 'none', 'one offer, once')
  assert.equal((await a.svc.status()).agents.find((x) => x.id === 'codex').canInstall, true, 'Settings still offers it')
  // nothing found at first run: the step is skipped
  const n = computer()
  const none = service(n, '0.42.0')
  assert.equal((await none.svc.offer()).kind, 'none')
  assert.equal(none.state().onboarded, true)
  assert.equal((await none.svc.status()).noneFound, true)
}

// ── the skill that comes with the app must be stamped ─────────────────────────────────────────
{
  const c = computer({ agents: ['.codex'] })
  const dir = join(c.root, 'unstamped'); mkdirSync(dir)
  writeFileSync(join(dir, 'SKILL.md'), '---\nname: talkweaver\n---\nx\n')
  const { svc } = service(c, '0.42.0', { skillDir: dir })
  assert.equal((await svc.install(['codex'])).rows[0].result, 'failed')
  assert.equal((await svc.status()).skillAvailable, false)
  assert.ok(!existsSync(join(c.home, '.agents')))
}

// ── the shim: marker-guarded, idempotent ──────────────────────────────────────────────────────
{
  const c = computer()
  const dir = join(c.home, '.local', 'bin')
  const o = { spec: CLI, home: c.home, platform: 'darwin', pathEnv: dir }
  assert.ok(generateShim(CLI).split('\n')[1] === shimMarker(CLI))
  assert.equal((await installShim(o)).state, 'installed')
  const p = join(dir, 'talkweaver')
  assert.equal(lstatSync(p).mode & 0o111, 0o111)
  writeFileSync(p, `#!/bin/sh\n${shimMarker(CLI)}\nold\n`)
  assert.match((await installShim(o)).message, /Installed/); assert.equal(text(p), generateShim(CLI))
  writeFileSync(p, '#!/bin/sh\necho mine\n')
  const kept = await installShim(o)
  assert.equal(kept.state, 'kept'); assert.equal(text(p), '#!/bin/sh\necho mine\n', 'a file without the marker is never replaced')
  rmSync(p); symlinkSync('/bin/echo', p)
  assert.equal((await installShim(o)).state, 'kept'); assert.ok(lstatSync(p).isSymbolicLink())
  assert.equal((await installShim({ ...o, platform: 'win32' })).state, 'unsupported')
}

// ── the `agent` command ───────────────────────────────────────────────────────────────────────
{
  assert.equal(parseAgentArgs(['install']).ok, false, 'install covers only agents named')
  assert.equal(parseAgentArgs(['install', '--agent', 'nope']).ok, false)
  assert.equal(parseAgentArgs(['status', '--json']).ok, true)
  assert.equal(parseAgentArgs(['remove', '--agent', 'codex', '--agent', 'claude-code']).ids.length, 2)
  const c = computer({ agents: ['.claude', '.codex'] })
  const { svc, state } = service(c, '0.42.0')
  const run = async (args) => { let out = ''; let err = ''; const code = await runAgentCli(args, svc, { stdout: (t) => { out += t }, stderr: (t) => { err += t } }, 'Claude Code'); return { code, out, err } }
  assert.equal((await run(['install'])).code, 2)
  const s0 = await run(['status', '--json'])
  assert.equal(s0.code, 0); assert.equal(JSON.parse(s0.out).format, 'talkweaver-agent/1')
  const i = await run(['install', '--agent', 'codex', '--json'])
  assert.equal(i.code, 0); assert.equal(JSON.parse(i.out).rows[0].result, 'installed')
  assert.ok(!existsSync(skillOf(c, '.claude/skills')), 'only the agent named')
  assert.deepEqual(state().changes.at(-1).who, { kind: 'agent', name: 'Claude Code' }, 'recorded as the agent')
  assert.equal((await run(['install', '--agent', 'gemini-cli'])).code, 1, 'not found: reported, exit 1')
  const r = await run(['remove', '--agent', 'codex'])
  assert.equal(r.code, 0); assert.ok(!existsSync(skillOf(c, '.agents/skills')))
}

// ── wording is the owner's, with only the app and its features filled in ──────────────────────
{
  const w = skillWording({ appName: 'TalkWeaver', features: 'create and edit your presentations' })
  assert.equal(w.title, 'Give your agents skills to use TalkWeaver')
  assert.equal(w.text, 'This will install a skill that tells your agent how to do things with TalkWeaver. You will be able to ask your agent to create and edit your presentations.')
  assert.equal(w.install, 'Install skill'); assert.equal(w.notNow, 'Not now')
}



// ═══ Independent-review fixes (each check below fails with its fix taken out) ═══════════════════

const sourceOf = (c, version) => loadSkillSource(makeSkill(c.root, version), 'talkweaver')
const plantForeign = (target) => { mkdirSync(target); writeFileSync(join(target, 'mine.md'), 'someone else\n') }

// ── 1. what is deleted is what was inspected: swap after the first look, nothing foreign is deleted ─
{
  const c = computer({ agents: ['.codex'] })
  const a = service(c, '0.42.0')
  await a.svc.install(['codex'])
  const target = skillOf(c, '.agents/skills')
  // Remove: the owned folder is swapped for someone's own between the look and the delete.
  const side = join(c.root, 'aside-1')
  await assert.rejects(removeSkillFolder(target, 'talkweaver', { afterInspect: () => { renameSync(target, side); plantForeign(target) } }), /left as it is/)
  assert.equal(text(join(target, 'mine.md')), 'someone else\n', 'the folder swapped in was put back, not deleted')
  // ... or for a link to a folder holding their files.
  rmSync(target, { recursive: true }); renameSync(side, target)
  const theirs = join(c.root, 'theirs'); mkdirSync(theirs); writeFileSync(join(theirs, 'keep.md'), 'keep\n')
  await assert.rejects(removeSkillFolder(target, 'talkweaver', { afterInspect: () => { renameSync(target, side); symlinkSync(theirs, target) } }), /left as it is/)
  assert.ok(lstatSync(target).isSymbolicLink()); assert.equal(text(join(theirs, 'keep.md')), 'keep\n')
  rmSync(target); renameSync(side, target)
  // Install/Replace: same swap, same result.
  const src = await sourceOf(c, '0.43.0')
  await assert.rejects(writeSkillFolder(target, src, { replaces: 'owned', replaceEdited: true, hooks: { afterInspect: () => { renameSync(target, side); plantForeign(target) } } }), /left as it is/)
  assert.equal(text(join(target, 'mine.md')), 'someone else\n')
  assert.ok(!readdirSync(join(c.home, '.agents', 'skills')).some((n) => n.startsWith('.talkweaver.')), 'no temporary or aside folders left but ours')
  // The skills folder itself swapped for a link just before the rename: nothing is written through it.
  rmSync(target, { recursive: true }); renameSync(side, target)
  const skills = join(c.home, '.agents', 'skills'); const moved = join(c.root, 'skills-moved'); const elsewhere = join(c.root, 'elsewhere'); mkdirSync(elsewhere)
  await assert.rejects(writeSkillFolder(target, src, { replaces: 'owned', hooks: { afterInspect: () => { renameSync(skills, moved); symlinkSync(elsewhere, skills) } } }), /left as it is/)
  assert.deepEqual(readdirSync(elsewhere), [], 'nothing was written through the link')
}

// ── 2. renderer ids cannot reach Object.prototype ─────────────────────────────────────────────
{
  const c = computer({ agents: ['.codex'] })
  const { svc, state } = service(c, '0.42.0')
  for (const bad of ['__proto__', 'constructor', 'toString', 'prototype']) {
    const rs = [await svc.decline([bad]), await svc.install([bad]), await svc.remove([bad])]
    for (const r of rs) assert.equal(r.rows[0].result, 'not-found', bad)
    await svc.offerShown([bad])
  }
  for (const k of ['choice', 'offered', 'lastResult', 'declined']) assert.equal(({})[k], undefined, `Object.prototype.${k} untouched`)
  assert.deepEqual(Object.keys(state().agents), [], 'no state recorded for an id that is not an agent')
  assert.equal(state().changes.length, 0)
  assert.deepEqual(agentIdsArg(['__proto__', 'codex', 5, 'constructor', 'codex', 'claude-code']), ['codex', 'claude-code'], 'the IPC boundary drops anything not in the agents table')
  assert.deepEqual(agentIdsArg('codex'), [])
  // a stored state that already carries such a key is not read as an agent
  const poisoned = service(c, '0.42.0', { store: JSON.parse('{"format":1,"appVersion":null,"onboarded":true,"agents":{"__proto__":{"choice":"connected"},"codex":{"choice":null,"offered":false,"lastResult":null}},"changes":[]}') })
  assert.equal((await poisoned.svc.status()).agents.find((a) => a.id === 'codex').state, 'not-installed')
}

// ── 3. a link anywhere inside an installed or separate copy is not ours to erase ───────────────
{
  const c = computer({ agents: ['.codex'] })
  const a = service(c, '0.42.0')
  await a.svc.install(['codex'])
  const target = skillOf(c, '.agents/skills')
  const theirs = join(c.root, 'theirs'); mkdirSync(theirs); writeFileSync(join(theirs, 'keep.md'), 'keep\n')
  symlinkSync(theirs, join(target, 'references', 'mine'))
  const row = (await a.svc.status()).agents.find((x) => x.id === 'codex')
  assert.equal(row.state, 'changed'); assert.equal(row.canReplace, false); assert.equal(row.canRemove, false)
  const r = await a.svc.install(['codex'], { replace: true })
  assert.equal(r.rows[0].result, 'kept')
  assert.ok(lstatSync(join(target, 'references', 'mine')).isSymbolicLink(), 'the link inside survives Replace')
  assert.equal((await a.svc.remove(['codex'])).rows[0].result, 'kept')
  assert.equal(text(join(theirs, 'keep.md')), 'keep\n')
  // a plain separately installed folder with a link inside
  const d = computer({ agents: ['.codex'] })
  const plain = skillOf(d, '.agents/skills'); mkdirSync(join(plain, 'sub'), { recursive: true })
  writeFileSync(join(plain, 'SKILL.md'), '---\nname: talkweaver\nmetadata:\n  app: talkweaver\n  app-version: 0.40.0\n---\nold\n')
  symlinkSync(theirs, join(plain, 'sub', 'mine'))
  const b = service(d, '0.42.0')
  assert.equal((await b.svc.status()).agents.find((x) => x.id === 'codex').canReplace, false)
  assert.equal((await b.svc.install(['codex'], { replace: true })).rows[0].result, 'kept')
  assert.ok(lstatSync(join(plain, 'sub', 'mine')).isSymbolicLink())
}

// ── 4. the command: never through a link, never over a command planted after the look ──────────
{
  const c = computer()
  const base = { spec: CLI, home: c.home, platform: 'darwin', pathEnv: '' }
  const other = join(c.root, 'other-bin'); mkdirSync(other)
  // the bin folder is a link
  mkdirSync(join(c.home, '.local'), { recursive: true })
  symlinkSync(other, join(c.home, '.local', 'bin'))
  const viaDir = await installShim(base)
  assert.equal(viaDir.state, 'blocked'); assert.match(viaDir.message, /link/); assert.deepEqual(readdirSync(other), [])
  assert.equal((await shimStatus(base)).state, 'blocked')
  // a parent inside HOME is a link
  rmSync(join(c.home, '.local'), { recursive: true })
  mkdirSync(join(other, 'bin'), { recursive: true }); symlinkSync(other, join(c.home, '.local'))
  const viaParent = await installShim(base)
  assert.equal(viaParent.state, 'blocked'); assert.deepEqual(readdirSync(join(other, 'bin')), [])
  rmSync(join(c.home, '.local'))
  // a command planted after the first look is not overwritten (new install, and replacing an older shim of ours)
  const bin = join(c.home, '.local', 'bin'); const p = join(bin, 'talkweaver')
  const plant = () => { mkdirSync(bin, { recursive: true }); writeFileSync(p, '#!/bin/sh\necho mine\n', { mode: 0o755 }) }
  const planted = await installShim({ ...base, beforeCommit: plant })
  assert.equal(planted.state, 'kept'); assert.equal(text(p), '#!/bin/sh\necho mine\n')
  rmSync(p); await installShim(base); writeFileSync(p, `#!/bin/sh\n${shimMarker(CLI)}\nold\n`)
  const swapped = await installShim({ ...base, beforeCommit: () => writeFileSync(p, '#!/bin/sh\necho mine again\n') })
  assert.equal(swapped.state, 'kept'); assert.equal(text(p), '#!/bin/sh\necho mine again\n')
  assert.deepEqual(readdirSync(bin), ['talkweaver'], 'the staged file is cleaned up')
}

// ── 5. changes from separate processes lose nothing ────────────────────
const WORKER = fileURLToPath(new URL('./lib/agent-skill-state-worker.mjs', import.meta.url))
function runWorker(stateDir, home, skillDir, action, id) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', WORKER, stateDir, home, skillDir, action, id], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''; let err = ''
    child.stdout.on('data', (d) => { out += d }); child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => (code === 0 ? resolve(JSON.parse(out.trim().split('\n').pop())) : reject(new Error(`worker ${action} ${id} exited ${code}: ${err}`))))
  })
}
const ids = AGENT_TABLE.map((d) => d.id)
const readLines = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
const agentFiles = (dir) => (existsSync(join(dir, 'agents')) ? readdirSync(join(dir, 'agents')).sort() : [])
const homeWith = (root, name) => { const h = join(root, name); for (const a of ['.claude', '.codex', '.gemini', '.antigravity']) mkdirSync(join(h, a), { recursive: true }); return h }
{
  // 12 processes, 20 rounds: installs for different agents (each process its own HOME, one shared state folder)
  const c = computer()
  const skillDir = makeSkill(c.root, '0.42.0')
  const targets = ['claude-code', 'codex', 'antigravity']
  for (let round = 0; round < 20; round++) {
    const stateDir = join(c.root, `state-${round}`)
    const rows = await Promise.all(Array.from({ length: 12 }, (_, i) => runWorker(stateDir, homeWith(c.root, `h-${round}-${i}`), skillDir, 'install', targets[i % 3])))
    for (const r of rows) assert.ok(['installed', 'unchanged'].includes(r[0].result), `round ${round}: ${JSON.stringify(r)}`)
    const store = createFileStateStore(stateDir, ids)
    for (const t of targets) assert.equal(store.readAgent(t)?.choice, 'connected', `round ${round}: ${t} choice survived`)
    assert.equal(readLines(join(stateDir, 'history.jsonl')).length, 12, `round ${round}: every history line survived`)
    assert.equal(store.readChanges().length, 12)
    assert.deepEqual(agentFiles(stateDir), targets.flatMap((t) => [`${t}.json`, `${t}.result.json`]).sort(), `round ${round}: a consent file and a result file per agent, no temporary files`)
  }
}
{
  // decline and install on different agents at once: both kept
  const c = computer()
  const skillDir = makeSkill(c.root, '0.42.0')
  for (let round = 0; round < 15; round++) {
    const stateDir = join(c.root, `state-${round}`)
    const home = homeWith(c.root, `h-${round}`)
    await Promise.all([runWorker(stateDir, home, skillDir, 'decline', 'codex'), runWorker(stateDir, home, skillDir, 'install', 'claude-code'), runWorker(stateDir, home, skillDir, 'decline', 'antigravity')])
    const store = createFileStateStore(stateDir, ids)
    assert.equal(store.readAgent('codex')?.choice, 'declined', `round ${round}`)
    assert.equal(store.readAgent('antigravity')?.choice, 'declined', `round ${round}`)
    assert.equal(store.readAgent('claude-code')?.choice, 'connected', `round ${round}`)
    assert.equal(store.readChanges().length, 3, `round ${round}`)
  }
}
{
  // the same agent installed and removed at once: nothing crashes, nothing is corrupt, status tells what is on disk
  const c = computer()
  const skillDir = makeSkill(c.root, '0.42.0')
  for (let round = 0; round < 10; round++) {
    const stateDir = join(c.root, `state-${round}`)
    const home = homeWith(c.root, `h-${round}`)
    await runWorker(stateDir, home, skillDir, 'install', 'claude-code')
    await Promise.all([runWorker(stateDir, home, skillDir, 'remove', 'claude-code'), runWorker(stateDir, home, skillDir, 'install', 'claude-code'), runWorker(stateDir, home, skillDir, 'remove', 'claude-code')])
    for (const f of agentFiles(stateDir)) JSON.parse(readFileSync(join(stateDir, 'agents', f), 'utf8'))
    for (const l of readLines(join(stateDir, 'history.jsonl'))) assert.equal(typeof l.at, 'number')
    const row = (await runWorker(stateDir, home, skillDir, 'status', ''))
    const mine = row.find((r) => r.id === 'claude-code')
    const onDisk = existsSync(join(home, '.claude', 'skills', 'talkweaver', 'SKILL.md'))
    assert.equal(['not-installed', 'failed'].includes(mine.state), !onDisk, `round ${round}: status ${mine.state}, folder ${onDisk ? 'there' : 'gone'}`)
  }
}
{
  // a damaged agent file, app file, history line and a missing folder all read as absent; nothing throws
  const c = computer({ agents: ['.codex'] })
  const dir = join(c.root, 'damaged')
  const store = createFileStateStore(dir, ids)
  assert.equal(store.readApp(), null, 'missing folder: app state absent'); assert.equal(store.readAgent('codex'), null); assert.deepEqual(store.readChanges(), [])
  mkdirSync(join(dir, 'agents'), { recursive: true })
  writeFileSync(join(dir, 'agents', 'codex.json'), '{"choice": "conn')
  writeFileSync(join(dir, 'agents', 'claude-code.json'), '[1,2]')
  writeFileSync(join(dir, 'app.json'), '\u0000\u0000garbage')
  const good = JSON.stringify({ at: 1, who: { kind: 'you' }, action: 'install', agent: 'codex', result: 'installed', version: '0.42.0' })
  writeFileSync(join(dir, 'history.jsonl'), `${good}\n{"at": 2, "who"\n"not an object"\n${good}\n`)
  assert.equal(store.readAgent('codex'), null); assert.equal(store.readAgent('claude-code'), null); assert.equal(store.readApp(), null)
  assert.equal(store.readChanges().length, 2, 'a damaged history line is skipped, the rest kept')
  const svc = createAgentSkills({ appId: 'talkweaver', appName: 'TalkWeaver', skillName: 'talkweaver', version: '0.42.0', skillDir: makeSkill(c.root, '0.42.0'), cli: CLI, store, home: c.home, env: { PATH: '' }, platform: 'darwin', probe: c.probe })
  assert.equal((await svc.status()).agents.find((a) => a.id === 'codex').state, 'not-installed')
  assert.equal((await svc.offer()).kind, 'first-run', 'no app record: read as a first run')
  assert.equal((await svc.install(['codex'])).rows[0].result, 'installed', 'a damaged file does not stop the next change')
  assert.equal(store.readAgent('codex')?.choice, 'connected', 'and it is replaced by a whole one')
  // a record that names no stored consent cannot claim a folder that is gone
  rmSync(skillOf(c, '.agents/skills'), { recursive: true })
  assert.equal((await svc.status()).agents.find((a) => a.id === 'codex').state, 'not-installed', 'status is read from disk')
}
{
  // a hostile id cannot make a path outside agents/
  const c = computer()
  const parent = join(c.root, 'p'); const dir = join(parent, 'state')
  mkdirSync(parent)
  const store = createFileStateStore(dir, ids)
  const rec = { choice: 'connected', offered: true, lastResult: null }
  for (const bad of ['../x', '../../x', '..', '.', '', 'codex/../../x', '/etc/x', 'codex\u0000', '__proto__', 'constructor', 'CODEX', 5, null, undefined, {}]) {
    assert.throws(() => store.writeAgent(bad, rec), /Not an agent id/, String(bad))
    assert.equal(store.readAgent(bad), null)
  }
  assert.deepEqual(readdirSync(parent), [], 'nothing was created')
  const wide = createFileStateStore(dir, ['../x', 'codex'])
  assert.throws(() => wide.writeAgent('../x', rec), /Not an agent id/, 'even a table entry must have the shape of an id')
  store.writeAgent('codex', rec)
  assert.deepEqual(readdirSync(parent), ['state']); assert.deepEqual(readdirSync(join(dir, 'agents')), ['codex.json'])
  assert.throws(() => store.writeResult('../x', { ok: true, at: 1, message: 'm' }), /Not an agent id/)
}

// ── 6. the command is part of the install: a command that is not ours makes it not ok ──────────
{
  const c = computer({ agents: ['.codex'] })
  mkdirSync(join(c.home, '.local', 'bin'), { recursive: true })
  writeFileSync(join(c.home, '.local', 'bin', 'talkweaver'), '#!/bin/sh\necho not ours\n', { mode: 0o755 })
  const { svc, state } = service(c, '0.42.0')
  const r = await svc.install(['codex'])
  assert.equal(r.rows[0].result, 'installed', 'the skill rows stay truthful')
  assert.equal(r.ok, false); assert.equal(r.cli.state, 'kept')
  assert.equal(state().agents.codex.choice, 'connected')
  assert.equal((await svc.status()).agents.find((x) => x.id === 'codex').state, 'installed')
  let out = ''
  const code = await runAgentCli(['install', '--agent', 'codex'], svc, { stdout: (t) => { out += t }, stderr: () => {} })
  assert.equal(code, 1); assert.match(out, /skill is installed, but the command-line tool is blocked/)
  // the same through a link on the way
  const d = computer({ agents: ['.codex'] })
  const other = join(d.root, 'o'); mkdirSync(other); mkdirSync(join(d.home, '.local'), { recursive: true }); symlinkSync(other, join(d.home, '.local', 'bin'))
  const r2 = await service(d, '0.42.0').svc.install(['codex'])
  assert.equal(r2.ok, false); assert.equal(r2.cli.state, 'blocked'); assert.equal(r2.rows[0].result, 'installed')
}

// ── 8. Settings can Replace a newer copy (the contract lets Replace override the version rule) ──
{
  const c = computer({ agents: ['.claude'] })
  const hi = service(c, '0.43.0')
  await hi.svc.install(['claude-code'])
  const lo = service(c, '0.42.0', { store: hi.state() })
  const row = (await lo.svc.status()).agents.find((x) => x.id === 'claude-code')
  assert.equal(row.newer, true); assert.equal(row.canReplace, true); assert.equal(row.canInstall, false)
  assert.equal((await lo.svc.install(['claude-code'])).rows[0].result, 'kept', 'the command line has no Replace')
  assert.equal((await lo.svc.install(['claude-code'], { replace: true })).rows[0].result, 'updated')
  assert.match(text(join(skillOf(c, '.claude/skills'), 'SKILL.md')), /app-version: 0.42.0/)
}

// ── 9. a person who already had a configuration gets the later offer, not the first-run dialog ──
{
  for (const [had, kind] of [[true, 'later'], [false, 'first-run']]) {
    const c = computer({ agents: ['.codex'] })
    const userData = join(c.root, 'userData'); mkdirSync(userData)
    writeFileSync(join(userData, 'config.json'), JSON.stringify({ vaults: ['/somewhere'] }))
    const store = agentSkillStateStore(userData)
    assert.equal(store.readApp(), null, 'nothing stored until decided')
    decideOnboarding(store, had)
    decideOnboarding(store, !had) // decided once, never again
    assert.deepEqual(JSON.parse(text(join(userData, 'config.json'))).vaults, ['/somewhere'], 'config.json is not touched')
    assert.equal(JSON.parse(text(join(userData, 'agent-skill', 'app.json'))).onboarded, had)
    const svc = createAgentSkills({ appId: 'talkweaver', appName: 'TalkWeaver', skillName: 'talkweaver', version: '0.42.0', skillDir: makeSkill(c.root, '0.42.0'), cli: CLI, store, home: c.home, env: { PATH: '' }, platform: 'darwin', probe: c.probe })
    assert.equal((await svc.offer()).kind, kind, `hadConfiguration=${had}`)
  }
}

// ═══ Second review round ═════════════════════════════════════════════════════════════════════

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── R1. a parent swapped for a link: no cleanup by path, the staging item is left and named ─────
{
  const c = computer({ agents: ['.codex'] })
  const a = service(c, '0.42.0')
  await a.svc.install(['codex'])
  const target = skillOf(c, '.agents/skills')
  const skills = join(c.home, '.agents', 'skills'); const moved = join(c.root, 'skills-moved-r1'); const elsewhere = join(c.root, 'elsewhere-r1'); mkdirSync(elsewhere)
  const src = await sourceOf(c, '0.43.0')
  let victim = null
  await assert.rejects(writeSkillFolder(target, src, { replaces: 'owned', hooks: { afterInspect: () => {
    const tmpName = readdirSync(skills).find((n) => n.startsWith('.talkweaver.tmp-'))
    renameSync(skills, moved); symlinkSync(elsewhere, skills)
    // the same name exists on the other side of the swap, holding a file that is not ours
    victim = join(elsewhere, tmpName); mkdirSync(victim); writeFileSync(join(victim, 'theirs.md'), 'theirs\n')
  } } }), (e) => /left as it is/.test(e.message) && /left at/.test(e.message) && e.message.includes(skills))
  assert.equal(text(join(victim, 'theirs.md')), 'theirs\n', 'nothing was deleted through the swapped parent')
  assert.ok(readdirSync(moved).some((n) => n.startsWith('.talkweaver.tmp-')), 'the staging item is left where it was made')
}
{
  // the command's folder swapped for a link: the staged file is left, not removed by path
  const c = computer()
  const o = { spec: CLI, home: c.home, platform: 'darwin', pathEnv: '' }
  const bin = join(c.home, '.local', 'bin'); const away = join(c.root, 'bin-away'); const elsewhere = join(c.root, 'elsewhere-bin'); mkdirSync(elsewhere)
  let victim = null
  const r = await installShim({ ...o, beforeCommit: () => {
    const staged = readdirSync(bin).find((n) => n.endsWith('.tmp'))
    renameSync(bin, away); symlinkSync(elsewhere, bin)
    victim = join(elsewhere, staged); writeFileSync(victim, 'theirs\n')
  } })
  assert.equal(r.state, 'blocked'); assert.match(r.message, /left at/)
  assert.equal(text(victim), 'theirs\n', 'a file of the same name on the other side is not deleted')
  assert.ok(readdirSync(away).some((n) => n.endsWith('.tmp')))
}

// ── R2. updating our shim never overwrites a command swapped in at the last moment ──────────────
{
  const c = computer()
  const o = { spec: CLI, home: c.home, platform: 'darwin', pathEnv: '' }
  const bin = join(c.home, '.local', 'bin'); const p = join(bin, 'talkweaver')
  await installShim(o)
  writeFileSync(p, `#!/bin/sh\n${shimMarker(CLI)}\nold\n`)
  const swapped = await installShim({ ...o, afterCheck: () => { rmSync(p); writeFileSync(p, '#!/bin/sh\necho mine\n', { mode: 0o755 }) } })
  assert.equal(swapped.state, 'blocked')
  assert.equal(text(p), '#!/bin/sh\necho mine\n', 'their command is back where it was')
  assert.equal(lstatSync(p).mode & 0o111, 0o111)
  assert.deepEqual(readdirSync(bin), ['talkweaver'], 'no aside or staged file left')
  // a new command appears in the gap after our old one was moved: kept, ours put back only if the place is free
  rmSync(p); await installShim(o); writeFileSync(p, `#!/bin/sh\n${shimMarker(CLI)}\nold\n`)
  // an ordinary update still works and leaves nothing behind
  assert.equal((await installShim(o)).state, 'installed'); assert.equal(text(p), generateShim(CLI))
  assert.deepEqual(readdirSync(bin), ['talkweaver'])
}

// ── F1. refresh is update-only and never writes the person's choice ─────────────────────────────
{
  // the folder writer: an update never makes a copy that is not there
  const c = computer()
  const parent = join(c.root, 'skills'); mkdirSync(parent)
  const src = await sourceOf(c, '0.42.0')
  for (const replaces of ['owned', 'any-plain']) {
    await assert.rejects(writeSkillFolder(join(parent, 'talkweaver'), src, { replaces }), (e) => e.code === 'EABSENT', replaces)
    assert.deepEqual(readdirSync(parent), [], `${replaces}: nothing was made`)
  }
  await writeSkillFolder(join(parent, 'talkweaver'), src, { replaces: 'nothing' })
  // the person's choice is read again as the write commits: removed in between, nothing is written
  const setup = async (flipAt) => {
    const c2 = computer({ agents: ['.claude'] })
    const inner = memoryStore()
    let reads = 0; let flipped = false
    const raw = { ...inner,
      readAgent: (id) => {
        if (id !== 'claude-code') return inner.readAgent(id)
        reads++
        if (reads >= flipAt && !flipped) { flipped = true; inner.writeAgent('claude-code', { choice: 'removed', offered: true, lastResult: null }) }
        return inner.readAgent(id)
      } }
    const a = service(c2, '0.42.0', { rawStore: raw })
    assert.equal((await a.svc.install(['claude-code'])).rows[0].result, 'installed')
    reads = 0; flipped = false
    return { c2, raw, inner, b: service(c2, '0.43.0', { rawStore: raw, skillDir: makeSkill(c2.root, '0.43.0') }) }
  }
  for (const flipAt of [3, 4]) { // reads of the agent: 3 is the check before the write, 4 the one as it commits
    const { c2, inner, b } = await setup(flipAt)
    assert.equal(await b.svc.refresh().then((r) => r.rows.length), 0, 'a person who removed it in the meantime gets no rewrite')
    assert.match(text(join(skillOf(c2, '.claude/skills'), 'SKILL.md')), /app-version: 0.42.0/, 'the folder is as it was')
    assert.equal(inner.readAgent('claude-code').choice, 'removed'); assert.match(inner.readAgent('claude-code').lastResult.message, /^Installed/, 'no refresh result written')
  }
  {
    // refresh has no way to touch consent: it writes the result file only, never an agent's consent
    const { inner, raw, c2 } = await setup(99)
    let consentWrites = 0; const results = []
    const spy = { ...raw, writeAgent: (...a) => { consentWrites++; return raw.writeAgent(...a) }, writeResult: (id, r) => { results.push(id); return raw.writeResult(id, r) } }
    const b2 = service(c2, '0.43.0', { rawStore: spy, skillDir: makeSkill(c2.root, '0.43.0') })
    const rep = await b2.svc.refresh()
    assert.equal(rep.rows[0].result, 'updated')
    assert.equal(consentWrites, 0, 'refresh wrote no consent'); assert.deepEqual(results, ['claude-code'], 'only its result')
    assert.equal(inner.readAgent('claude-code').choice, 'connected')
  }
  {
    // on disk: a result write cannot restore consent that a removal has just written
    const c4 = computer()
    const store = createFileStateStore(join(c4.root, 'st'), ids)
    store.writeAgent('codex', { choice: 'connected', offered: true })
    store.writeAgent('codex', { choice: 'removed', offered: true })
    store.writeResult('codex', { ok: true, at: 5, message: 'Updated.' })
    assert.deepEqual(store.readAgent('codex'), { choice: 'removed', offered: true, lastResult: { ok: true, at: 5, message: 'Updated.' } }, 'the two files read merged')
    writeFileSync(join(c4.root, 'st', 'agents', 'codex.result.json'), '{"ok":')
    assert.deepEqual(store.readAgent('codex'), { choice: 'removed', offered: true, lastResult: null }, 'a damaged result file reads as absent')
    rmSync(join(c4.root, 'st', 'agents', 'codex.json'))
    assert.equal(store.readAgent('codex'), null)
  }
  {
    // the folder is gone when refresh commits: it is not made again
    const c3 = computer({ agents: ['.claude'] })
    const a = service(c3, '0.42.0'); await a.svc.install(['claude-code'])
    rmSync(skillOf(c3, '.claude/skills'), { recursive: true })
    const b = service(c3, '0.43.0', { rawStore: undefined, store: a.state(), skillDir: makeSkill(c3.root, '0.43.0') })
    await b.svc.refresh()
    assert.ok(!existsSync(skillOf(c3, '.claude/skills')), 'a deleted skill is not recreated by refresh')
  }
}

// ── F2. a newer copy that arrives between the first look and the move is kept ───────────────────
{
  const c = computer()
  const parent = join(c.root, 'skills'); mkdirSync(parent)
  const target = join(parent, 'talkweaver')
  await writeSkillFolder(target, await sourceOf(c, '0.41.0'), { replaces: 'nothing' })
  const v43 = await sourceOf(c, '0.43.0')
  await assert.rejects(
    writeSkillFolder(target, await sourceOf(c, '0.42.0'), { replaces: 'owned', noDowngrade: true, hooks: { afterInspect: () => writeSkillFolder(target, v43, { replaces: 'owned' }) } }),
    (e) => e.code === 'ENEWER')
  assert.match(text(join(target, 'SKILL.md')), /app-version: 0.43.0/, 'the newer copy is still there')
  assert.deepEqual(readdirSync(parent), ['talkweaver'], 'nothing left beside it')
  // a newer copy seen at the first look is kept as well
  await assert.rejects(
    writeSkillFolder(target, await sourceOf(c, '0.42.0'), { replaces: 'owned', noDowngrade: true }),
    (e) => e.code === 'ENEWER')
  // an explicit Replace may go down
  await writeSkillFolder(target, await sourceOf(c, '0.42.0'), { replaces: 'owned' })
  assert.match(text(join(target, 'SKILL.md')), /app-version: 0.42.0/)
}

// ── G2. a newer copy moved aside is put back even when a lower install filled the gap ───────────
{
  const c = computer()
  const parent = join(c.root, 'skills'); mkdirSync(parent)
  const target = join(parent, 'talkweaver')
  // 0.41 is there at the first look; 0.43 arrives; ours moves it aside; a 0.42 install fills the gap
  await writeSkillFolder(target, await sourceOf(c, '0.41.0'), { replaces: 'nothing' })
  const v42 = await sourceOf(c, '0.42.0')
  const v43first = await sourceOf(c, '0.43.0')
  await assert.rejects(
    writeSkillFolder(target, v42, { replaces: 'owned', noDowngrade: true, hooks: { afterInspect: () => writeSkillFolder(target, v43first, { replaces: 'owned' }), afterAside: () => writeSkillFolder(target, v42, { replaces: 'nothing' }) } }),
    (e) => e.code === 'ENEWER')
  assert.match(text(join(target, 'SKILL.md')), /app-version: 0.43.0/, 'the newer copy is the active one')
  assert.deepEqual(readdirSync(parent), ['talkweaver'], 'no leftover')
  // an occupant that is higher, or not ours, is left alone, nothing is deleted, and the leftover is named
  for (const [label, fill] of [['higher', async () => writeSkillFolder(target, await sourceOf(c, '0.44.0'), { replaces: 'nothing' })], ['foreign', () => { mkdirSync(target); writeFileSync(join(target, 'mine.md'), 'mine\n') }]]) {
    rmSync(target, { recursive: true, force: true })
    await writeSkillFolder(target, await sourceOf(c, '0.41.0'), { replaces: 'nothing' })
    const v43 = await sourceOf(c, '0.43.0')
    await assert.rejects(
      writeSkillFolder(target, v42, { replaces: 'owned', noDowngrade: true, hooks: { afterInspect: () => writeSkillFolder(target, v43, { replaces: 'owned' }), afterAside: fill } }),
      (e) => e.code === 'ECHANGED' && /\.talkweaver\.old-/.test(e.message), label)
    const left = readdirSync(parent).filter((n) => n.startsWith('.talkweaver.old-'))
    assert.equal(left.length, 1, `${label}: the newer copy is named and left`)
    assert.match(text(join(parent, left[0], 'SKILL.md')), /app-version: 0.43.0/)
    assert.ok(existsSync(target), `${label}: the occupant stays`)
    rmSync(join(parent, left[0]), { recursive: true })
  }
}

// ── F3. a half-written history tail does not swallow the next entry; a short write is reported ────
{
  const c = computer()
  const dir = join(c.root, 'hist')
  mkdirSync(dir)
  const note = (n) => ({ at: n, who: { kind: 'you' }, action: 'install', agent: 'codex', result: 'installed', version: '0.42.0' })
  writeFileSync(join(dir, 'history.jsonl'), `${JSON.stringify(note(1))}\n{"at":2,"who":{"kind":"yo`)
  const store = createFileStateStore(dir, ids)
  assert.equal(store.appendChange(note(3)), true)
  assert.deepEqual(store.readChanges().map((n) => n.at), [1, 3], 'the fragment is skipped and the new entry is whole')
  // a short write: reported, not thrown; the next entry is not swallowed by the fragment it left
  const { writeSync } = await import('node:fs')
  const short = createFileStateStore(dir, ids, { write: (fd, buf, off, len) => writeSync(fd, buf, off, len - 5) })
  assert.equal(short.appendChange(note(4)), false)
  assert.equal(store.appendChange(note(5)), true)
  assert.deepEqual(store.readChanges().map((n) => n.at), [1, 3, 5])
  // an unusable history never fails the change itself
  const broken = { ...memoryStore(), appendChange: () => { throw new Error('disk') } }
  const c2 = computer({ agents: ['.codex'] })
  const r = await service(c2, '0.42.0', { rawStore: broken }).svc.install(['codex'])
  assert.equal(r.rows[0].result, 'installed'); assert.equal(r.ok, true)
}

console.log('agent skill: all checks passed')

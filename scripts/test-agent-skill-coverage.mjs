// The agent skill must describe every verb an agent can call (design element 19, "Agent features must update
// the skill"), and must be fit for a stranger's computer. Plain Node, no Electron.
//   - every verb in the inventory (src/main/agent-inventory.ts) is named in the hand-written SKILL.md or
//     references (the generated references/commands.md does not count), or is listed with a reason in
//     resources/agent-skill/not-in-skill.txt; the failure names each missing or stale verb;
//   - every `talkweaver <command>` the skill names exists in the inventory;
//   - the inventory matches the CLI's own usage text (setup, settings), so it cannot drift;
//   - release checks: metadata.app-version equals the app's version; no absolute path or private store name
//     in the packed skill; the packaging and the publish step are wired.
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildAgentSkill } from './build-agent-skill.mjs'
import { publishAgentSkill } from './publish-agent-skill.mjs'
import { checkPublishedSkill, publishedUrl, readSkillFiles } from './check-published-skill.mjs'
import { VERB_INVENTORY, CLI_VERBS } from '../src/main/agent-inventory.ts'
import { USAGE } from '../src/main/setup-cli.ts'
import { runTalkWeaverSettings } from '../src/main/settings-cli.ts'
import { readSkillMetadata } from '../src/main/agent-skill/skill-source.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const scratch = mkdtempSync(join(tmpdir(), 'agent-skill-coverage-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))

const files = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath ?? e.path, e.name))

export function notInSkill(path) {
  const out = new Map()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const [verb, ...why] = t.split('|')
    out.set(verb.trim(), why.join('|').trim())
  }
  return out
}

/** Whether `phrase` is named as whole command tokens: `settings reset` is not satisfied by `settings reset-shortcut`. */
export function mentions(text, phrase) {
  const esc = phrase.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
  return new RegExp(`(?<![\\w-])${esc}(?![\\w-])`).test(text)
}

/** The problems, each naming its verb. `skillDir` is the built skill; generated commands.md is left out. */
export function coverageProblems(skillDir, inventory, omissions) {
  const problems = []
  const hand = files(skillDir).filter((f) => relative(skillDir, f) !== join('references', 'commands.md'))
  const text = hand.map((f) => readFileSync(f, 'utf8')).join('\n')
  const verbs = new Set(inventory.map((v) => v.verb))
  for (const { verb, route } of inventory) {
    const described = route === 'cli' ? mentions(text, `talkweaver ${verb}`) : mentions(text, verb)
    if (omissions.has(verb)) {
      if (!omissions.get(verb)) problems.push(`not-in-skill.txt gives no reason for "${verb}"`)
      if (described) problems.push(`"${verb}" is listed in not-in-skill.txt but the skill describes it: remove the line`)
    } else if (!described) problems.push(`verb "${verb}" is not described in SKILL.md or references (write it in, or list it with a reason in resources/agent-skill/not-in-skill.txt)`)
  }
  for (const verb of omissions.keys()) if (!verbs.has(verb)) problems.push(`stale line in not-in-skill.txt: "${verb}" is not a verb`)
  const families = new Set(['setup', 'settings', 'agent'])
  for (const m of text.matchAll(/`talkweaver ((?:setup|settings|agent)(?: [a-z][a-z-]*)*)/g)) {
    const named = m[1]
    if (families.has(named)) continue
    if (![...verbs].some((v) => named === v)) problems.push(`stale verb "${named}" is named in the skill but is not in the CLI`)
  }
  return problems
}

const built = await buildAgentSkill({ outDir: join(scratch, 'dist') })
const omissions = notInSkill(join(root, 'resources', 'agent-skill', 'not-in-skill.txt'))

// 1. the real skill covers the real inventory
assert.deepEqual(coverageProblems(built, VERB_INVENTORY, omissions), [])

// 2. a missing verb fails and is named; so does a stale one; generated commands.md does not count
{
  const hand = join(scratch, 'broken')
  await buildAgentSkill({ outDir: hand })
  const cli = join(hand, 'talkweaver', 'references', 'cli.md')
  writeLess(cli, 'talkweaver agent remove', 'talkweaver agent delete')
  const problems = coverageProblems(join(hand, 'talkweaver'), VERB_INVENTORY, omissions)
  assert.ok(problems.some((p) => p.includes('"agent remove"')), `names the missing verb: ${problems.join(' | ')}`)
  assert.ok(problems.some((p) => p.includes('"agent delete"')), 'names the stale verb')
  assert.ok(readFileSync(join(hand, 'talkweaver', 'references', 'commands.md'), 'utf8').includes('talkweaver agent remove'), 'commands.md still lists it, and does not count')
  assert.ok(coverageProblems(join(hand, 'talkweaver'), [...VERB_INVENTORY, { verb: 'agent frobnicate', args: '', summary: '', route: 'cli' }], omissions).some((p) => p.includes('"agent frobnicate"')))
  assert.ok(coverageProblems(built, VERB_INVENTORY, new Map([...omissions, ['setup status', 'x']])).some((p) => p.includes('"setup status"')), 'an omission for a described verb is flagged')
}
function writeLess(path, a, b) { const s = readFileSync(path, 'utf8'); assert.ok(s.includes(a)); writeFileSync(path, s.split(a).join(b)) }

// 3. the inventory matches the parsers' own usage text
for (const v of CLI_VERBS.filter((x) => x.verb.startsWith('setup '))) {
  const rest = v.verb.slice('setup '.length)
  assert.ok(USAGE.some((l) => l.trim().startsWith(rest) || l.includes(` ${rest} `) || l.trim().startsWith(rest.split(' ')[0] + ' ' + rest.split(' ')[1] ?? '')) || rest === 'help', `setup verb "${rest}" is in the setup command's usage`)
}
{
  let help = ''
  await runTalkWeaverSettings(['help'], { dir: scratch, version: '0.0.0', io: { stdout: (t) => { help += t }, stderr: (t) => { help += t } } })
  for (const v of CLI_VERBS.filter((x) => x.verb.startsWith('settings '))) assert.ok(help.includes(v.verb.slice('settings '.length)), `settings verb "${v.verb}" is in the settings command's usage`)
  for (const word of [...help.matchAll(/^\s{2}([a-z-]+)\b/gm)].map((m) => m[1])) assert.ok(CLI_VERBS.some((v) => v.verb === `settings ${word}`), `the settings command has a verb "${word}" that the inventory lacks`)
}
for (const l of USAGE.filter((x) => /^ {2}[a-z]/.test(x))) {
  const words = l.trim().split(/\s+/)
  const verb = words[0] === 'cloudflare' ? `setup cloudflare ${words[1]}` : `setup ${words[0]}`
  assert.ok(CLI_VERBS.some((v) => v.verb === verb), `the setup command has a verb "${verb}" that the inventory lacks`)
}

// 4. release checks on the packed skill
const skillMd = readFileSync(join(built, 'SKILL.md'), 'utf8')
const meta = readSkillMetadata(skillMd)
assert.equal(meta.app, 'talkweaver'); assert.equal(meta.version, pkg.version, 'metadata.app-version equals the app version')
// Scout is an optional external tool in the reconciled skill, not a private store.
assert.match(skillMd, /scout search --hybrid/); assert.match(skillMd, /scout capture --project/);
const FORBIDDEN = [/\/Users\//, /\/home\/[a-z]/i, /[A-Z]:\\Users/, /dominik/i, /gitrepos/i, /_SKILLS/, /nexus/i, /onedrive/i, /learninglog/i, /slide-versions/i, /abstracts-archive/, /instruction-only/i, /installs no app/i, /\bIPC\b/, /talk:export-handout|run:build-handout|transcript:run|talk:write-outline/]
for (const f of files(built)) {
  const t = readFileSync(f, 'utf8')
  for (const re of FORBIDDEN) assert.ok(!re.test(t), `${relative(built, f)} holds ${re}`)
}
for (const f of files(built).filter((x) => x.endsWith('.md'))) for (const m of readFileSync(f, 'utf8').replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, '').replace(/(`+)[^`]*?\1/g, '').matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
  if (/^(https?:|\/)/.test(m[1])) continue
  assert.ok(existsSync(join(dirname(f), m[1])), `${relative(built, f)} links to a file that is not in the skill: ${m[1]}`)
}

// 5. packaging and the build are wired
const res = pkg.build.extraResources.find((r) => r.to === 'agent-skill')
assert.ok(res && res.from === 'agent-skill-dist', 'agent-skill-dist is packed as resources/agent-skill')
assert.ok(pkg.scripts.build.includes('build-agent-skill.mjs'), 'npm run build builds the skill')
assert.ok(/^agent-skill-dist\/?$/m.test(readFileSync(join(root, '.gitignore'), 'utf8')), 'the built skill is not committed')

// 6. the separate-publish step: same skill, same version, with its provenance
{
  const target = join(scratch, 'published')
  const r = await publishAgentSkill(target)
  assert.equal(r.version, pkg.version)
  assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), skillMd, 'the same content as the packed skill')
  const prov = readFileSync(join(target, 'PROVENANCE.md'), 'utf8')
  assert.match(prov, /App: TalkWeaver/); assert.ok(prov.includes(`App version: ${pkg.version}`)); assert.match(prov, /Commit: [0-9a-f]{40}|Commit: unknown/)
  assert.ok(statSync(join(target, 'references', 'commands.md')).isFile())
  await assert.rejects(() => publishAgentSkill(undefined), /Usage/)
}



// 7. verbs are matched as whole command tokens: `settings reset-shortcut` does not describe `settings reset`
{
  assert.ok(!mentions('`talkweaver settings reset-shortcut <command>`', 'talkweaver settings reset'))
  assert.ok(mentions('`talkweaver settings reset <key>`', 'talkweaver settings reset'))
  assert.ok(mentions('run talkweaver  settings\n reset now', 'talkweaver settings reset'), 'spacing does not matter')
  const only = join(scratch, 'tokens')
  await buildAgentSkill({ outDir: only })
  writeLess(join(only, 'talkweaver', 'references', 'cli.md'), 'talkweaver settings reset <key>', 'talkweaver settings reset-key <key>')
  const problems = coverageProblems(join(only, 'talkweaver'), VERB_INVENTORY, omissions)
  assert.ok(problems.some((p) => p.includes('"settings reset"')), `names the verb only a longer verb described: ${problems.join(' | ')}`)
}

// 8. the separate publication is enforced: the public copy must match every file of this release's skill
{
  const files = readSkillFiles(built)
  const publicCopy = (over = {}) => {
    const m = new Map(files); m.set('PROVENANCE.md', Buffer.from('p'))
    for (const [k, v] of Object.entries(over)) { if (v === null) m.delete(k); else m.set(k, Buffer.from(v)) }
    return async (url) => { const rel = url.slice(publishedUrl('').length); const b = m.get(rel); if (!b) throw new Error('HTTP 404'); return b }
  }
  const check = (fetchBytes, version = pkg.version) => checkPublishedSkill({ version, files, fetchBytes })
  assert.match(publishedUrl(), /^https:\/\/raw\.githubusercontent\.com\/techczech\/dominiks-agent-skills\/main\/teaching\/talkweaver\/SKILL\.md$/)
  assert.equal(await check(publicCopy()), pkg.version, 'a faithful copy passes (PROVENANCE.md is ignored)')
  const header = readFileSync(join(built, 'SKILL.md'), 'utf8').match(/^---[\s\S]*?\n---/)[0]
  await assert.rejects(check(publicCopy({ 'SKILL.md': `${header}\n` })), /SKILL\.md: differs/, 'a header-only SKILL.md with matching metadata fails')
  await assert.rejects(check(publicCopy({ 'references/commands.md': null })), /references\/commands\.md: missing/)
  await assert.rejects(check(publicCopy({ 'references/cli.md': 'old' })), /references\/cli\.md: differs/)
  await assert.rejects(check(publicCopy(), '9.9.9'), /release is 9\.9\.9.*publish step first/s)
  await assert.rejects(check(async () => { throw new Error('HTTP 404') }), /could not be fetched.*publish step first/s)
  await assert.rejects(check(async () => Buffer.from('no frontmatter')), /not the TalkWeaver agent skill/)
  const wf = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8')
  const jobs = wf.slice(wf.indexOf('\njobs:'))
  const first = jobs.slice(jobs.indexOf('skill-published:'), jobs.indexOf('\n  macos:'))
  assert.ok(jobs.indexOf('skill-published:') < jobs.indexOf('\n  macos:'), 'the check is the first job')
  assert.ok(first.indexOf('build-agent-skill.mjs') > 0 && first.indexOf('build-agent-skill.mjs') < first.indexOf('check-published-skill.mjs'), 'the skill is built before the check')
  assert.equal((wf.match(/needs: skill-published/g) ?? []).length, 2, 'both platform jobs wait for it, so nothing is built, uploaded or fed before it passes')
}

console.log('agent skill coverage: all checks passed')

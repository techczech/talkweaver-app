// One process of the agent skill state stress tests (scripts/test-agent-skill.mjs): runs one action of the real
// service against a shared state folder, with its own disposable HOME unless one is given.
// Usage: node worker.mjs <stateDir> <home> <skillDir> <install|decline|remove|status> <agentId>
// Prints the report's rows as JSON on one line.
import { createAgentSkills } from '../../src/main/agent-skill/service.ts'
import { createFileStateStore } from '../../src/main/agent-skill/state-files.ts'
import { nodeProbe } from '../../src/main/agent-skill/probe.ts'
import { AGENT_TABLE } from '../../src/shared/agent-skill/agents.ts'

const [stateDir, home, skillDir, action, id] = process.argv.slice(2)
const real = nodeProbe()
const probe = {
  stat: (p) => (p.startsWith(home) ? real.stat(p) : Promise.resolve(null)),
  list: (p) => Promise.resolve(p === '/Applications' ? ['Antigravity.app'] : [])
}
const svc = createAgentSkills({
  appId: 'talkweaver', appName: 'TalkWeaver', skillName: 'talkweaver', version: '0.42.0', skillDir,
  cli: { command: 'talkweaver', appName: 'TalkWeaver', bundleId: 'net.example.talkweaver' },
  store: createFileStateStore(stateDir, AGENT_TABLE.map((d) => d.id)),
  home, env: { PATH: '' }, platform: 'darwin', probe
})
const report = action === 'status' ? await svc.status() : await svc[action]([id])
console.log(JSON.stringify(report.rows ?? report.agents))

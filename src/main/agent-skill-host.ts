// TalkWeaver's side of the built-in agent skill (design element 19): the few facts the portable module
// (src/main/agent-skill/, src/shared/agent-skill/) is given: app id, display name, the sentence that says what
// the skill lets the person ask for, the command, where the packaged skill is and where its state is kept.
// The state sits in its own folder, userData/agent-skill/ (one file per agent, app.json, history.jsonl; not a
// preference, and not in config.json, so changes to different agents never share a file). No Electron import: the `agent` command runs here and tests import it as it is.
import { join } from 'node:path'
import { runAgentCli, type AgentCliIO } from './agent-skill/cli.ts'
import { createAgentSkills, type AgentSkills } from './agent-skill/service.ts'
import { createFileStateStore, type StateStore } from './agent-skill/state-files.ts'
import { AGENT_TABLE } from '../shared/agent-skill/agents.ts'
import { commandArguments } from './setup-cli.ts'
import { AGENT_SKILL_IDENTITY } from '../shared/agent-skill-identity.ts'

export { AGENT_SKILL_IDENTITY }

export interface AgentSkillHostParams {
  userDataDir: string
  version: string
  /** The packaged skill's folder, or null when this run carries none (a development run before the build). */
  skillDir: string | null
}

/** Ids from the renderer: only strings that are in the agents table pass; anything else is dropped before main acts on it. */
export function agentIdsArg(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const v of value) if (typeof v === 'string' && AGENT_TABLE.some((d) => d.id === v) && !out.includes(v)) out.push(v)
  return out
}

/** `TalkWeaver agent …` at the command position (like `setup` and `settings`), or null. */
export function agentArguments(argv: readonly string[], defaultApp: boolean): string[] | null {
  return commandArguments(argv, defaultApp, 'agent')
}

/** The feature's own folder under userData: agents/<id>.json, app.json, history.jsonl (state-files.ts). */
export function agentSkillStateStore(userDataDir: string): StateStore {
  return createFileStateStore(join(userDataDir, 'agent-skill'), AGENT_TABLE.map((d) => d.id))
}

export function createTalkWeaverAgentSkills(p: AgentSkillHostParams, store: StateStore = agentSkillStateStore(p.userDataDir)): AgentSkills {
  return createAgentSkills({ appId: AGENT_SKILL_IDENTITY.appId, appName: AGENT_SKILL_IDENTITY.appName, skillName: AGENT_SKILL_IDENTITY.skillName, cli: AGENT_SKILL_IDENTITY.cli, version: p.version, skillDir: p.skillDir, store })
}

/**
 * First launch of a build that has the feature: a person who already has vaults is not walked through
 * onboarding (they get the one later offer, in the status bar); a new person gets the onboarding step.
 * Decided once, before anything creates a vault, and never again.
 */
export function decideOnboarding(store: StateStore, hadConfiguration: boolean): void {
  try {
    if (store.readApp()) return
    store.writeApp({ onboarded: hadConfiguration })
  } catch { /* never a startup failure */ }
}

export function runTalkWeaverAgent(args: string[], p: AgentSkillHostParams, io: AgentCliIO, store?: StateStore): Promise<number> {
  return runAgentCli(args, createTalkWeaverAgentSkills(p, store), io, process.env.BRIDLE_AGENT || 'an agent')
}

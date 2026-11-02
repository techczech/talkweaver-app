import { writeResearch, type ResearchWriteDeps } from './research-writer.ts'
import type { ResearchWriteOp, ResearchWriteResult } from '../shared/research.ts'
// The agent's content verbs (ADR-0019: the content-verb law). TalkWeaver had no verb table before the
// research folders; this is the smallest one the law needs. A verb is one typed main-process function
// that the UI calls through its own handler and the agent calls by id; `posture` is the floor from the
// ADR (direct = reversible, recorded, no approval).
//
// COMMAND_VERBS maps a content command of the registry to its verb; CHROME_COMMANDS lists the commands
// that are chrome, each with its reason class. scripts/test-research-capture.mjs fails when a
// content command named here has no verb or a chrome command has no reason.

import { listResearch, whereUsedResearch, searchResearch, type ResearchDeps } from './research-reader.ts'
import type { ResearchListResult, ResearchUsedResult } from '../shared/research.ts'
import { captureResearch, revealResearchFolder, withoutDetail, CAPTURE_KINDS, type CaptureDeps, type CaptureInput, type CaptureResult, type RevealResult } from './research-capture.ts'

export interface AgentVerb<In, Out> {
  id: string
  tier: 'content'
  posture: 'direct' | 'proposal' | 'approval'
  /** The typed inputs, for the agent's catalogue. */
  inputs: Readonly<Record<string, string>>
  /** Input arrives untyped (IPC, agent); the verb validates its shape. */
  run: (input: In | unknown, deps: ResearchDeps) => Promise<Out>
}

export const RESEARCH_CAPTURE_VERB: AgentVerb<CaptureInput, CaptureResult> = {
  id: 'research.capture',
  tier: 'content',
  posture: 'direct',
  inputs: {
    talkDir: 'absolute path of the talk folder, inside the vault',
    title: 'required',
    kind: CAPTURE_KINDS.join(' | '),
    prompt: 'optional: the question that produced it',
    sources: 'optional list: scout:<passage id> | url:<address> | file:<path>',
    artefact: 'optional: a file to copy into research/ beside the new file',
    body: 'the unit itself'
  },
  // The agent gets the same stripped result as the sheet; scout's detail is logged by captureResearch.
  run: (input, deps) => captureResearch(input, deps).then(withoutDetail)
}

/** The `research:capture` IPC handler: resolves the vault, then calls the registered verb (looked up at call time). */
export function researchCaptureHandler(
  input: unknown,
  host: { vaultRootFor: (talkDir: string) => string | null | undefined } & Omit<CaptureDeps, 'vaultRoot'>
): Promise<CaptureResult> {
  const { vaultRootFor, ...rest } = host
  const talkDir = typeof input === 'object' && input !== null ? (input as { talkDir?: unknown }).talkDir : undefined
  const vaultRoot = typeof talkDir === 'string' && talkDir && !talkDir.includes('\0') ? vaultRootFor(talkDir) ?? null : null
  // The renderer gets the plain message only; scout's raw words stay in the log.
  return RESEARCH_CAPTURE_VERB.run(input, { ...rest, vaultRoot }).then(withoutDetail)
}

/** The `research:reveal-folder` IPC handler. */
export function researchRevealHandler(
  talkDir: unknown,
  host: { vaultRootFor: (talkDir: string) => string | null | undefined; reveal: (path: string) => void }
): RevealResult {
  const vaultRoot = typeof talkDir === 'string' && talkDir && !talkDir.includes('\0') ? host.vaultRootFor(talkDir) ?? null : null
  return revealResearchFolder(talkDir, { vaultRoot, reveal: host.reveal })
}

export const RESEARCH_LIST_VERB: AgentVerb<unknown, ResearchListResult> = {
  id: 'research.list', tier: 'content', posture: 'direct',
  inputs: { talkDir: 'absolute talk folder inside an open vault', file: 'optional: one research file to preview, including bounded artefact bytes' }, run: listResearch
}
export const RESEARCH_WHERE_USED_VERB: AgentVerb<unknown, ResearchUsedResult> = {
  id: 'research.whereUsed', tier: 'content', posture: 'direct',
  inputs: { talkDir: 'absolute talk folder', file: 'absolute research file inside that talk' }, run: whereUsedResearch
}
export const RESEARCH_SEARCH_VERB: AgentVerb<unknown, ResearchListResult> = {
  id: 'research.search', tier: 'content', posture: 'direct',
  inputs: { talkDir: 'absolute current talk folder', query: 'Scout query', scope: 'talk | research | everything' }, run: searchResearch
}
async function insertResearch(input: unknown, deps: ResearchDeps, slide: boolean): Promise<{ ok: true } | import('../shared/research.ts').ResearchFailure> {
  const file = input && typeof input === 'object' && 'file' in input ? input.file : undefined
  const talk = deps.activeTalkDir?.()
  if (!talk || !deps.insertResearch || typeof file !== 'string') return { ok: false, error: { code: 'not-open', message: 'Open a talk and choose one of its research items.' } }
  const reply = await listResearch({ talkDir: talk, file }, deps)
  if (!reply.ok) return reply
  if (deps.activeTalkDir?.() !== talk) return { ok: false, error: { code: 'not-open', message: 'The active talk changed. Try again.' } }
  return deps.insertResearch(reply.items[0].file, slide)
}
export const RESEARCH_INSERT_VERB: AgentVerb<unknown, { ok: true } | import('../shared/research.ts').ResearchFailure> = {
  id: 'research.insert', tier: 'content', posture: 'direct', inputs: { file: 'research file inside the active talk; inserted at the live editor caret' },
  run: (input, deps) => insertResearch(input, deps, false)
}
export const RESEARCH_MAKE_SLIDE_VERB: typeof RESEARCH_INSERT_VERB = {
  id: 'research.makeSlide', tier: 'content', posture: 'direct', inputs: { file: 'research file inside the active talk; made into a slide at the live editor caret' },
  run: (input, deps) => insertResearch(input, deps, true)
}
export const RESEARCH_WRITE_VERBS: AgentVerb<unknown, ResearchWriteResult>[] = (['rename', 'kind', 'delete', 'move', 'copy', 'insertHere'] as ResearchWriteOp[]).map(op => ({
  id: `research.${op}`, tier: 'content', posture: op === 'delete' || op === 'move' || op === 'rename' ? 'approval' : 'direct',
  inputs: { file: 'absolute research file; tidy acts on the active talk only', title: 'rename title, up to 500 characters', kind: 'evidence | table | visualisation | snippet | search | widget', destination: 'copy/move destination talk in an open vault', renameSlug: 'optional boolean', preview: 'true to list affected slides and receive confirmation', confirmation: 'confirmation from the unchanged preview' },
  run: (input, deps) => writeResearch(input && typeof input === 'object' && !Array.isArray(input) ? { ...input, op } : null, deps)
}))
export function researchWriteHandler(op: string, input: unknown, deps: ResearchWriteDeps): Promise<ResearchWriteResult> {
  const verb = RESEARCH_WRITE_VERBS.find(v => v.id === `research.${op}`)
  return verb ? verb.run(input, deps) : Promise.resolve({ ok: false, error: { code: 'invalid-input', message: 'Choose a research action.' } })
}
export const AGENT_VERBS = [RESEARCH_CAPTURE_VERB, RESEARCH_LIST_VERB, RESEARCH_WHERE_USED_VERB, RESEARCH_SEARCH_VERB, RESEARCH_INSERT_VERB, RESEARCH_MAKE_SLIDE_VERB, ...RESEARCH_WRITE_VERBS] as const

/** IPC and agents call the very same registered implementation, with only open vault roots. */
export function researchReadHandler(
  id: 'research.list' | 'research.whereUsed' | 'research.search', input: unknown,
  host: { vaultRootFor: (talkDir: string) => string | null | undefined } & Omit<ResearchDeps, 'vaultRoot'>
): Promise<ResearchListResult | ResearchUsedResult> {
  const { vaultRootFor, ...rest } = host
  const dir = input && typeof input === 'object' ? (input as { talkDir?: unknown }).talkDir : undefined
  const vaultRoot = typeof dir === 'string' && !dir.includes('\0') ? vaultRootFor(dir) ?? null : null
  const verb = [RESEARCH_LIST_VERB, RESEARCH_WHERE_USED_VERB, RESEARCH_SEARCH_VERB].find(v => v.id === id)!
  return verb.run(input, { ...rest, vaultRoot })
}

/** Content commands of the command registry (by command id) and the verb each one calls. */
export const COMMAND_VERBS: Readonly<Record<string, string>> = {
  'research-insert': 'research.insert',
  'research-make-slide': 'research.makeSlide',
  'research-capture': 'research.capture',
  'research-rename': 'research.rename',
  'research-change-kind': 'research.kind',
  'research-delete': 'research.delete',
  'research-move': 'research.move',
  'research-copy': 'research.copy',
  'research-insert-here': 'research.insertHere'
}

/** Chrome commands, each declared with its reason class (ADR-0019 tier 4). */
export const CHROME_COMMANDS: Readonly<Record<string, 'ui-navigation' | 'presentation' | 'duplicate-of'>> = {
  'research-panel': 'ui-navigation',
  'research-find': 'ui-navigation',
  'research-open': 'ui-navigation',
  'research-previous': 'ui-navigation',
  'research-next': 'ui-navigation',
  'research-scope': 'ui-navigation',
  'research-close': 'ui-navigation',
  'research-copy-reference': 'ui-navigation',
  'research-reveal': 'ui-navigation',
  'research-source': 'ui-navigation',
  'research-used-in': 'ui-navigation',
  'research-scope-talk': 'ui-navigation',
  'research-scope-research': 'ui-navigation',
  'research-scope-everything': 'ui-navigation',
  'research-retry': 'ui-navigation',
  'research-reveal-folder': 'ui-navigation'
}

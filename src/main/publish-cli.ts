import { statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { handoutAddressLabel } from '../shared/publish-status.ts'
import { interruptedPublishDiagnostic, publishDiagnosticMessage, publishDiagnosticText, publishStepLabel, redactPublishText, type CliPublishUpdate, type PublishDiagnostic, type PublishProgress } from '../shared/publish-diagnostic.ts'
import type { PublishHistoryAttempt } from '../shared/publish-history.ts'
import { substringDistance } from '../shared/talk-query.ts'
import type { AgentCliIO } from './agent-skill/cli.ts'
import type { PreservationReason } from './publication-preservation.ts'
import type { TalkPublishOptions, TalkPublishResult } from './talk-handout-publish.ts'

export const PUBLISH_CLI_VERB = {
  verb: 'publish',
  args: '<talk path or id> [--dry-run | --status] [--json]',
  summary: 'Publishes the talk handout to the configured site, checks a build with --dry-run, or reads earlier attempts with --status.',
} as const

const usage = [
  `Usage: talkweaver ${PUBLISH_CLI_VERB.verb} ${PUBLISH_CLI_VERB.args}`,
  'Exit codes: 0 done, 1 failed (live site untouched), 2 usage, 3 outcome unknown, 4 setup required, 130 cancelled.',
].join('\n')

type PublishMode = 'publish' | 'dry-run' | 'status'
type PublishArgs = { json: boolean } & (
  { command: 'help' } | { command: 'usage'; reason: string } | { command: PublishMode; talk: string }
)

export function parsePublishArgs(args: readonly string[]): PublishArgs {
  const json = args.includes('--json')
  const dryRun = args.includes('--dry-run')
  const status = args.includes('--status')
  const rest = args.filter(arg => arg !== '--json' && arg !== '--dry-run' && arg !== '--status')
  if (!dryRun && !status && (rest.length === 0 || (rest.length === 1 && rest[0] === '--help'))) return { json, command: 'help' }
  if (dryRun && status) return { json, command: 'usage', reason: 'Choose either --dry-run or --status.' }
  if (rest.length !== 1 || !rest[0] || rest[0].startsWith('-')) {
    return { json, command: 'usage', reason: 'Give one talk path or id. Run talkweaver publish --help for the options.' }
  }
  return { json, command: status ? 'status' : dryRun ? 'dry-run' : 'publish', talk: rest[0] }
}

export type TalkResolution = { path: string } | { reason: string; candidates: string[] }
export function resolvePublishTalk(input: string, cwd: string, talks: {
  findOutlineIn(dir: string): string | null
  isTalk(path: string): boolean
  listTalks(): { slug: string; outlinePath: string }[]
}): TalkResolution {
  const path = resolve(cwd, input)
  const info = statSync(path, { throwIfNoEntry: false })
  const noMatch = 'No matching talk in an open library. Check the talk path or id and open its library in TalkWeaver.'
  if (info || basename(input) !== input || input.endsWith('-outline.md')) {
    const outline = info?.isDirectory() ? talks.findOutlineIn(path) : info?.isFile() ? path : null
    return outline && talks.isTalk(outline) ? { path: outline } : { reason: noMatch, candidates: [] }
  }
  const listed = talks.listTalks()
  const valid = (matches: typeof listed) => [...new Set(matches.map(talk => talk.outlinePath).filter(path => talks.isTalk(path)))]
  const selected = valid(listed.filter(talk => talk.slug === input))
  if (selected.length === 1) return { path: selected[0] }
  if (selected.length > 1) return { reason: 'More than one talk has that id. Give the outline path.', candidates: selected }
  const query = input.toLowerCase()
  const maxEdits = query.length >= 4 ? 1 : 0
  const candidates = valid(listed
    .filter(talk => substringDistance(query, talk.slug.toLowerCase()) <= maxEdits))
    .slice(0, 10)
  return { reason: noMatch, candidates }
}

type PublishCliDeps = {
  resolve(talk: string): TalkResolution
  status(path: string): PublishHistoryAttempt[]
  publish(path: string, options: TalkPublishOptions): Promise<TalkPublishResult>
}
type Failure = {
  outcome: 'failed' | 'setup-required' | 'usage'
  reason: string
  code?: PreservationReason
  liveSite: 'untouched' | 'unknown'
  nextStep: string
  diagnostic?: PublishDiagnostic
  candidates?: string[]
}

function cleanDiagnostic(value: PublishDiagnostic | undefined): PublishDiagnostic | undefined {
  if (!value) return undefined
  return {
    ...value,
    ...(value.cause ? { cause: redactPublishText(value.cause) } : {}),
    ...(value.cloudflareErrors ? { cloudflareErrors: value.cloudflareErrors.map(error => ({
      code: error.code, ...(error.message ? { message: redactPublishText(error.message) } : {}),
    })) } : {}),
  }
}

function failure(result: Extract<TalkPublishResult, { success: false }>, couldHaveSent: boolean): Failure {
  const diagnostic = cleanDiagnostic(result.diagnostic)
  const { notReady } = result
  const untouched = diagnostic ? diagnostic.untouched && !diagnostic.uncertain : !couldHaveSent
  const liveSite = untouched ? 'untouched' : 'unknown'
  const setup = untouched && (diagnostic?.signIn || notReady?.fix.action === 'open-settings')
  // The shared handout operation has already cleaned this message and preserved any recovery code.
  const reason = result.error ?? redactPublishText(notReady?.title ?? 'TalkWeaver could not finish publishing.')
  const nextStep = notReady?.detail
    ?? (setup && !diagnostic?.signIn ? 'Check Settings → Cloudflare and try again.'
      : diagnostic && (diagnostic.kind !== 'local' || diagnostic.uncertain) ? publishDiagnosticMessage(diagnostic)
        : untouched ? 'Address the reported problem and try again. If it repeats, read the publishing history.'
          : 'Check the live site and publishing history before trying again.')
  return { outcome: setup ? 'setup-required' : 'failed', reason, code: result.code, liveSite, nextStep: redactPublishText(nextStep), diagnostic }
}

function printFailure(io: AgentCliIO, json: boolean, result: Failure): number {
  if (json) printEvent(io, 'result', result)
  else {
    const state = result.liveSite === 'untouched' ? 'The live site is untouched.' : 'The outcome on the live site is unknown.'
    io.stderr(`Failed. ${result.reason}\n${state}\n${result.nextStep}\n`)
    if (result.candidates?.length) {
      io.stderr('Matching outlines\n')
      for (const path of result.candidates) io.stderr(`  ${JSON.stringify(path)}\n`)
    }
    if (result.diagnostic) io.stderr(`${publishDiagnosticText(result.diagnostic)}\n`)
  }
  if (result.outcome === 'usage') return 2
  if (result.outcome === 'setup-required') return 4
  return result.liveSite === 'unknown' ? 3 : 1
}

function printEvent(io: AgentCliIO, event: 'progress' | 'warning' | 'result', fields: object): void {
  io.stdout(`${JSON.stringify({ format: 'talkweaver-publish/1', event, ...fields })}\n`)
}

export function publishBusy(args: readonly string[], io: AgentCliIO): number {
  return printFailure(io, args.includes('--json'), {
    outcome: 'failed', reason: 'TalkWeaver is already handling a command-line publish.', liveSite: 'untouched',
    nextStep: 'Wait for that command to finish, then try again.',
  })
}

export function publishConnectionFailure(
  args: readonly string[], io: AgentCliIO, state: 'unavailable' | 'interrupted' | 'cancelled', platform = process.platform,
): number {
  const json = args.includes('--json')
  if (state === 'cancelled') {
    if (json) printEvent(io, 'result', { outcome: 'cancelled', liveSite: 'untouched' })
    else io.stdout('Cancelled. The live site is untouched.\n')
    return 130
  }
  const unknown = state === 'interrupted' && !args.includes('--dry-run')
  return printFailure(io, json, {
    outcome: state === 'unavailable' ? 'setup-required' : 'failed',
    reason: state === 'unavailable' ? 'The running TalkWeaver could not accept the publish command.' : 'The connection to TalkWeaver ended before it returned a result.',
    liveSite: unknown ? 'unknown' : 'untouched',
    nextStep: unknown ? 'Check publishing history and the live site before trying again.'
      : state !== 'unavailable' ? 'Try the dry run again.'
        : platform === 'win32' ? 'Close TalkWeaver and retry.'
          : 'Check that the running TalkWeaver version supports command-line publishing and has finished starting.',
  })
}
/** Format only public URLs. Discard user info, queries and fragments before writing to the terminal. */
function publicUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin + url.pathname
  } catch { /* the publishing operation supplies a web address */ }
  return undefined
}

/** The running app observes the same operation and never forwards the outline text to the terminal. */
export async function publishFromRunningApp(
  outlinePath: string, options: TalkPublishOptions, publish: PublishCliDeps['publish'],
  tell: (update: CliPublishUpdate) => void,
): Promise<TalkPublishResult> {
  if (options.dryRun) return publish(outlinePath, options)
  let diagnostic = interruptedPublishDiagnostic()
  let url: string | undefined
  try {
    const result = await publish(outlinePath, {
      ...options,
      onProgress: progress => {
        options.onProgress?.(progress)
        tell({ outlinePath, kind: 'progress', progress })
      },
    })
    if (!result.success) diagnostic = result.diagnostic ?? interruptedPublishDiagnostic(result.error)
    else if ('url' in result) url = publicUrl(result.url)
    return result
  } finally {
    tell({ outlinePath, kind: 'finished', ...(url ? { url } : { diagnostic }) })
  }
}

export async function runPublishCli(args: readonly string[], deps: PublishCliDeps, io: AgentCliIO, signal?: AbortSignal): Promise<number> {
  const parsed = parsePublishArgs(args)
  const { command, json } = parsed
  if (command === 'help') {
    if (json) printEvent(io, 'result', { outcome: 'help', usage })
    else io.stdout(`${usage}\n`)
    return 0
  }
  if (command === 'usage') {
    return printFailure(io, json, { outcome: 'usage', reason: parsed.reason, liveSite: 'untouched', nextStep: usage })
  }
  let couldHaveSent = false
  try {
    const source = deps.resolve(parsed.talk)
    if ('reason' in source) {
      return printFailure(io, json, {
        outcome: 'usage', reason: 'Talk could not be selected.', liveSite: 'untouched', nextStep: source.reason, candidates: source.candidates,
      })
    }
    if (command === 'status') {
      const attempts = deps.status(source.path)
      if (json) printEvent(io, 'result', { outcome: 'status', attempts })
      else if (!attempts.length) io.stdout('No publishing attempts recorded for this talk.\n')
      else for (const attempt of attempts) {
        const { diagnostic, handoutUrl } = attempt.events.at(-1) ?? {}
        io.stdout(`${attempt.startedAt}  ${attempt.outcome ?? 'no final result recorded'}\n`)
        if (handoutUrl) io.stdout(`${handoutAddressLabel(handoutUrl)}\n`)
        if (diagnostic) io.stdout(`${publishDiagnosticMessage(diagnostic)}\n${publishDiagnosticText(diagnostic)}\n`)
      }
      return 0
    }
    let lastLine = ''
    const result = await deps.publish(source.path, { dryRun: command === 'dry-run', savedOnly: true, pinSource: true, signal,
      onWarning: warning => {
        if (json) printEvent(io, 'warning', { warning })
        else io.stderr(`${warning}\n`)
      }, onProgress: progress => {
      if (!progress.canCancel) couldHaveSent = true
      if (json) printEvent(io, 'progress', progress)
      else {
        const line = progressLine(progress)
        if (line !== lastLine) io.stderr(`${line}\n`)
        lastLine = line
      }
    } })
    if (!result.success) {
      if (result.cancelled) {
        if (json) printEvent(io, 'result', { outcome: 'cancelled', liveSite: 'untouched', diagnostic: cleanDiagnostic(result.diagnostic) })
        else io.stdout('Cancelled. The live site is untouched.\n')
        return 130
      }
      return printFailure(io, json, failure(result, couldHaveSent))
    }
    const warnings = [result.warning, 'liveNotice' in result ? result.liveNotice : undefined]
      .filter((item): item is string => !!item).map(item => redactPublishText(item))
    if ('preview' in result) {
      const { files, bytes } = result.preview
      if (json) printEvent(io, 'result', { outcome: 'dry-run', liveSite: 'untouched', files, bytes, warnings })
      else io.stdout(`Dry run complete. Built ${files} files (${bytes} bytes). The live site is untouched.\n`)
    } else {
      const url = publicUrl(result.url)
      const outcome = result.unchanged ? 'unchanged' : 'published'
      if (json) printEvent(io, 'result', { outcome, url, warnings })
      else io.stdout(`${result.unchanged ? 'Unchanged' : 'Published'}${url ? ` ${handoutAddressLabel(url)}` : ''}\n`)
    }
    if (!json) for (const warning of warnings) io.stderr(`${warning}\n`)
    return 0
  } catch {
    return printFailure(io, json, {
      outcome: 'failed',
      reason: command === 'status' ? 'Publishing history could not be read.' : 'TalkWeaver could not finish the publish command.',
      liveSite: couldHaveSent ? 'unknown' : 'untouched',
      nextStep: couldHaveSent ? 'Check the live site and publishing history before trying again.' : 'Check the talk and try again.',
    })
  }
}

function progressLine(progress: PublishProgress): string {
  const text = progress.step === 'building' ? 'Building'
    : progress.step === 'upload' ? `Uploading ${progress.filesAcknowledged}/${progress.filesTotal} files`
      : progress.step === 'confirm' ? 'Confirming' : publishStepLabel(progress)
  return progress.retry ? `${text}. Retrying in ${Math.ceil(progress.retry.delayMs / 1000)} s.` : `${text}…`
}

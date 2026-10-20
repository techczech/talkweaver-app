// The participant work page for one Run and phase (work-files ticket 15; ADR-0040 decision 4): the compiled,
// pinned work file (compileWorkFile on readPinnedWork's text, tickets 05 and 14) and the phase's object on
// the live Worker (the run work service's row, ticket 13) made into the page published at `…/pre-work` or
// `…/post-work` (ticket 16 publishes it, run-work-publish.ts). The page itself, its policy and what holds for it are
// compiler/scripts/lib/work-page.mjs; this is the main process's door to it.
//
// A file that is not ready (a blocking finding, or no form the Worker would take) is refused here: a page
// is never built from it.
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { CompiledWorkFile } from './work-file-compile.ts'
import type { Phase } from '../shared/run-work.ts'

export interface ParticipantWorkPageInput {
  /** The compiler's `scripts` folder (as for compileWorkFile). */
  compilerDir: string
  /** The pinned copy, compiled. */
  compiled: CompiledWorkFile
  phase: Phase
  /** The phase's object on the Worker and the Worker's address (the run work service's row). */
  preworkId: string
  workerBaseUrl: string
  /** Raw text, written as text: the talk's title and the Run's line ("Saïd workshop · Wed 21 Oct, 14:00"). */
  talkTitle: string
  runLine?: string
  /** The Run's handout: an http(s) address or a path on the same site; empty for none. */
  handoutUrl?: string
  /** Preview page (ticket 16): opened on this computer; it asks nothing of the Worker and sends nothing. */
  preview?: boolean
  /** A preview shows the Run's own times: when the phase opens and closes (epoch ms). */
  previewWindow?: { opensAt: number; closesAt: number }
}

export interface ParticipantWorkPage {
  html: string
  /** The policy in the page's own <meta>. */
  csp: string
  /** What the host should send with the page (the policy with frame-ancestors, referrer, nosniff, noindex). */
  headers: Record<string, string>
}

export class WorkPageNotReady extends Error {
  readonly reason: 'work-file-not-ready' | 'work-file-no-form'
  constructor(reason: 'work-file-not-ready' | 'work-file-no-form') {
    super(reason)
    this.reason = reason
  }
}

type BuildWorkPage = (input: Record<string, unknown>) => ParticipantWorkPage

/**
 * "This page is not available" (ticket 17): the one page an unpublished Run's handout, pre-work and
 * post-work addresses show. Fixed text: it names nothing of the Run and runs nothing.
 */
export async function buildNotAvailablePage(compilerDir: string): Promise<string> {
  const { buildNotAvailablePage: build } = (await import(pathToFileURL(join(compilerDir, 'lib', 'work-page.mjs')).href)) as { buildNotAvailablePage: () => ParticipantWorkPage }
  return build().html
}

export async function buildParticipantWorkPage(input: ParticipantWorkPageInput): Promise<ParticipantWorkPage> {
  const { compiled } = input
  if (!compiled.ok) throw new WorkPageNotReady('work-file-not-ready')
  if (!compiled.form) throw new WorkPageNotReady('work-file-no-form')
  const { buildWorkPage } = (await import(pathToFileURL(join(input.compilerDir, 'lib', 'work-page.mjs')).href)) as { buildWorkPage: BuildWorkPage }
  return buildWorkPage({
    phase: input.phase,
    preworkId: input.preworkId,
    workerBaseUrl: input.workerBaseUrl,
    form: compiled.form,
    introText: compiled.introText,
    steps: compiled.steps.map((step) => ({ id: step.id, kind: step.kind, stepHtml: step.stepHtml })),
    styles: compiled.styles,
    talkTitle: input.talkTitle,
    runLine: input.runLine ?? '',
    handoutUrl: input.handoutUrl ?? '',
    ...(input.preview ? { preview: true } : {}),
    ...(input.preview && input.previewWindow ? { previewWindow: input.previewWindow } : {}),
  })
}

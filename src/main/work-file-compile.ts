// Compile a work file into what participants see (ADR-0040 decision 2; work-files ticket 05).
//
//   readWorkFile (ticket 02) gives the steps, kinds, layouts and findings; the compiler's own
//   `prepareSource` draws each step as a slide with TalkWeaver's layouts (images and videos resolve
//   relative to the work file, inside `assetRoots`, exactly as in a talk); `publicPreworkForm`
//   (src/shared/run-prework.ts) builds the public form field by field, so a quick check's right
//   answer is never copied, and the Worker's own parser checks it.
//
// The output has three parts: `form` (ids, kinds, poll options, no right answer), `steps[].stepHtml`
// (one slide per step, through the DOM allowlist in src/shared/work-step-html.ts, `{right}` gone) and
// `findings` (the reader's, plus what the compiler and the sanitiser found drawing the steps). Nothing
// is restyled: a step in a layout outside the six is drawn as the compiler draws it and carries a finding.
//
// HTML or text: a field whose name ends in `Html` is sanitised HTML, safe to insert as HTML. Every other
// string (`title`, `introText`, step titles, poll labels in `form`) is the author's raw text and must be
// written as text: it is never escaped here.
//
// Steps are matched to the compiler's slides by id, never by position: the compiler renames a repeated
// id `x` to `x-2`, `x-3` … in order, and so does the matching. A step with no slide is a blocking finding.
// Media from outside the work file's folder (`..`, an absolute path, a symlink out, `file:`) is a
// blocking finding; a remote video the compiler embeds stays a warning.
//
// A `video` step goes to the form as `slide`: the Worker's form has no video kind, and the video
// plays from the step's HTML. Phase (pre- or post-work) is not here; the file has none.
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readWorkFile, type WorkFileFinding, type WorkFileLayout, type WorkFileStepKind } from '../shared/work-file.ts'
import { publicPreworkForm, type PreworkForm } from '../shared/run-prework.ts'
import type { SanitisedStepHtml } from '../shared/work-step-html.ts'

/** Findings this module adds to the reader's. */
export type CompiledWorkFindingCode =
  /** A warning the compiler raised drawing a step (detail: the compiler's own text). */
  | 'work-file-compile-warning'
  /** Blocking: the compiler drew no slide with this step's id. */
  | 'work-file-step-unmatched'
  /** Blocking: a step's image or video comes from outside the work file's folder. */
  | 'work-file-media-outside'
  /** Warning: the sanitiser took markup out of a step (detail: what, as `tag` or `tag@attribute`). */
  | 'work-file-markup-removed'
  /**
   * Warning: the step's id is the name of a document property (`title`, `body`, `open`, `head`,
   * `links`), which a public page may not use as an element's id; the sanitiser drops any `id` or
   * `name` that carries it (detail: the id). Rename the step.
   */
  | 'work-file-step-id-reserved'

export type CompiledWorkFinding = WorkFileFinding | (Omit<WorkFileFinding, 'code'> & { code: CompiledWorkFindingCode })

export interface CompiledWorkStep {
  id: string | null
  /** 1-based position. */
  n: number
  /** Raw text: write as text. */
  title: string
  kind: WorkFileStepKind
  layout: WorkFileLayout | null
  /** The compiler's name for the layout when it is outside the six. */
  layoutName: string | null
  /** The compiler's id for the step's slide (the step id, or `id-2` … for a repeated id); null when unmatched. */
  slideId: string | null
  /** The step drawn as a slide: sanitised HTML, safe to publish; '' when no slide matched it. */
  stepHtml: string
}

export interface CompiledWorkFile {
  id: string
  /** Raw text: write as text. */
  title: string
  revision: number | null
  hash: string
  /** The intro paragraph as written: raw text, never escaped here; write as text. */
  introText: string
  steps: CompiledWorkStep[]
  /** The public form; null when the Worker's form rules refuse it (no valid step, a repeated id). Its strings are raw text. */
  form: PreworkForm | null
  /** The compiler's stylesheet for the step slides plus `WORK_STEP_STYLES`. */
  styles: string
  findings: CompiledWorkFinding[]
  /** No finding is blocking. */
  ok: boolean
}

// What the compiler says about a work file's own tokens, which the reader already reports.
const COMPILER_NOISE = /^(prework-token-outside|unknown-trigger:video|icon-suggested|icon-gap|icon-semantic-needed)/
// Compiler warnings whose second field is not a slide id (`poll-type-unknown:<type>`, `unknown-trigger:<token>` …).
const NO_SLIDE_FIELD = new Set(['poll-type-unknown', 'poll-limit-invalid', 'pollresults-unknown', 'unresolved-trigger', 'unknown-trigger'])
// The compiler's media warnings: `code:slideId:reference`.
const MEDIA_WARNING = /^(asset-outside-vault|missing-image|missing-asset|unknown-image-type)$/
/** A reference that names a place outside the work file's folder, whether or not the file is there. */
/** Step ids a page cannot carry as an element id: DOMPurify drops an `id`/`name` naming a document property. */
export const RESERVED_STEP_IDS: ReadonlySet<string> = new Set(['title', 'body', 'open', 'head', 'links'])
const OUTSIDE_REFERENCE = /^(?:file:|[\\/~]|[a-z]:[\\/])|(?:^|[\\/])\.\.(?:[\\/]|$)/i

/**
 * Steps are drawn in a page, not a deck: every slide shows, at its natural height, and the
 * multi-column layouts stack at phone width (390px).
 */
export const WORK_STEP_STYLES = `
.wf-step .slide { display: block !important; position: static !important; width: auto !important; height: auto !important; aspect-ratio: auto !important; overflow: visible; }
.wf-step .slide-content { height: auto; min-height: 0; }
.wf-step video, .wf-step img { max-width: 100%; height: auto; }
@media (max-width: 640px) {
  .wf-step .slot, .wf-step .columns-grid, .wf-step [class*="layout-"] { grid-template-columns: 1fr !important; }
  .wf-step .slot-media, .wf-step .col { width: 100% !important; }
}
`

interface Extracted { id: string; html: string; role: string }

const load = async <T>(compilerDir: string, file: string): Promise<T> => (await import(pathToFileURL(join(compilerDir, file)).href)) as T

/**
 * The step sanitiser (src/shared/work-step-html.ts) as the compiler ships it, bound to its own jsdom
 * window: jsdom is not in the app's bundle, so it comes from the compiler's vendored bundle.
 */
export async function loadStepSanitiser(compilerDir: string): Promise<(html: string) => SanitisedStepHtml> {
  const vendor = await load<{ sanitiseWorkStepHtmlForCompiler?: (html: string) => SanitisedStepHtml }>(compilerDir, '../assets/vendor/svg-sanitiser.mjs')
  if (typeof vendor.sanitiseWorkStepHtmlForCompiler !== 'function') throw new Error('The compiler has no step sanitiser; run npm run generate:compiler-svg-sanitiser')
  return vendor.sanitiseWorkStepHtmlForCompiler
}

/** The slide id the compiler gives each step, in order: a repeated id becomes `id-2`, `id-3` … */
export function expectedSlideIds(stepIds: ReadonlyArray<string | null>): Array<string | null> {
  const used = new Set<string>()
  return stepIds.map((id) => {
    if (id === null) return null
    let finalId = id
    for (let suffix = 2; used.has(finalId); suffix += 1) finalId = `${id}-${suffix}`
    used.add(finalId)
    return finalId
  })
}

/**
 * What the sanitiser took out of a step, for the `work-file-markup-removed` finding. A reserved id is
 * its own finding, so the `id`/`name` dropped for it is not counted. A step whose slide had markup and
 * whose sanitised HTML is empty, with nothing reported (only `<noframes>` or `<title>`, say), still lost
 * its markup: `everything` is reported, so the author is told the step will show nothing.
 */
export function removedMarkup(sourceHtml: string, clean: SanitisedStepHtml, reserved: boolean): string[] {
  const removed = reserved ? clean.removed.filter((what) => !/@(?:id|name)$/.test(what)) : [...clean.removed]
  if (!removed.length && String(sourceHtml).trim() !== '' && String(clean.html).trim() === '') removed.push('everything')
  return removed
}

export interface CompileWorkFileInput {
  /** The compiler's `scripts` folder (what the main process passes everywhere as `compilerDir`). */
  compilerDir: string
  /** Absolute path of the work file; images and videos resolve relative to it. The file need not be on disk. */
  path: string
  /** The file's text, as read (the hash is of exactly this). */
  text: string
  /** Folders the file's media may come from (ADR-0036); defaults to the file's own folder. */
  assetRoots?: string[]
}

export async function compileWorkFile(input: CompileWorkFileInput): Promise<CompiledWorkFile> {
  const { compilerDir, path, text } = input
  const reading = readWorkFile(text)
  const { definition } = reading
  const findings: CompiledWorkFinding[] = [...reading.findings]

  const { prepareSource } = await load<{ prepareSource: (...args: unknown[]) => Promise<Record<string, any>> }>(compilerDir, 'lib/08-source-adapters.mjs')
  const html = await load<{ extractSlides: (html: string) => Extracted[]; extractStyles: (html: string) => string }>(compilerDir, 'lib/04-html-extraction.mjs')
  const { stripAudioElements } = await load<{ stripAudioElements: (html: string) => string }>(compilerDir, 'lib/09-output-builders.mjs')
  const sanitise = await loadStepSanitiser(compilerDir)

  // The compiler reads the stat only to tell a folder from a file; a work file is a file.
  const fileStat = { isDirectory: () => false, isFile: () => true }
  const model = await prepareSource(path, text.replace(/^\uFEFF/, ''), definition.title || undefined, fileStat, undefined, {
    allowedAssetRoots: input.assetRoots ?? [dirname(path)],
  })
  const fullHtml = String(model.fullHtml ?? '')
  const byId = new Map(html.extractSlides(fullHtml).map((slide) => [slide.id, slide]))

  const slideIds = expectedSlideIds(definition.steps.map((step) => step.id))
  const stepBySlideId = new Map<string, (typeof definition.steps)[number]>()
  const steps: CompiledWorkStep[] = definition.steps.map((step, index) => {
    const slideId = slideIds[index]
    const slide = slideId !== null ? byId.get(slideId) : undefined
    let stepHtml = ''
    if (slide && slideId !== null) {
      stepBySlideId.set(slideId, step)
      const clean = sanitise(stripAudioElements(slide.html))
      stepHtml = clean.html
      const reserved = step.id !== null && RESERVED_STEP_IDS.has(step.id)
      const removed = removedMarkup(slide.html, clean, reserved)
      if (reserved) {
        findings.push({ code: 'work-file-step-id-reserved', stepId: step.id, line: step.sourceLine ?? null, detail: step.id!, severity: 'warning' })
      }
      if (removed.length) {
        findings.push({ code: 'work-file-markup-removed', stepId: step.id, line: step.sourceLine ?? null, detail: removed.join(' '), severity: 'warning' })
      }
    } else {
      findings.push({ code: 'work-file-step-unmatched', stepId: step.id, line: step.sourceLine ?? null, detail: step.title, severity: 'blocking' })
    }
    return {
      id: step.id, n: index + 1, title: step.title, kind: step.kind, layout: step.layout, layoutName: step.layoutName,
      slideId: slide ? slideId : null, stepHtml,
    }
  })

  for (const warning of Array.isArray(model.warnings) ? model.warnings : []) {
    const textOf = String(warning)
    if (COMPILER_NOISE.test(textOf)) continue
    const [code = '', slideId = '', ...rest] = textOf.split(':')
    const step = NO_SLIDE_FIELD.has(code) ? undefined : stepBySlideId.get(slideId.trim())
    const at = { stepId: step?.id ?? null, line: step?.sourceLine ?? null }
    const reference = rest.join(':').trim()
    if (code === 'asset-outside-vault' || (MEDIA_WARNING.test(code) && OUTSIDE_REFERENCE.test(reference))) {
      findings.push({ code: 'work-file-media-outside', ...at, detail: reference, severity: 'blocking' })
    } else {
      findings.push({ code: 'work-file-compile-warning', ...at, detail: textOf, severity: 'warning' })
    }
  }

  // The public form: the reader's steps and the compiled slides' polls, field by field.
  const slidesWithIds = definition.steps.map((step, index) => ({ id: step.id ?? undefined, poll: steps[index].slideId ? pollOf(model, steps[index].slideId!) : undefined }))
  const form = publicPreworkForm(
    { title: definition.title, intro: definition.intro, steps: definition.steps.filter((step) => step.id !== null) },
    slidesWithIds,
  )

  return {
    id: definition.id, title: definition.title, revision: definition.revision, hash: reading.hash, introText: definition.intro,
    steps, form,
    styles: `${html.extractStyles(fullHtml)}\n${WORK_STEP_STYLES}`,
    findings,
    ok: !findings.some((finding) => finding.severity === 'blocking'),
  }
}

function pollOf(model: Record<string, any>, slideId: string): unknown {
  const slide = (Array.isArray(model.slides) ? model.slides : []).find((candidate: { id?: unknown }) => candidate.id === slideId)
  return slide?.poll
}

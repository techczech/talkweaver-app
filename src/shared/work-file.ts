// The work-file reader (ADR-0040 decisions 1, 2 and 5; work-files ticket 02).
//
// A work file is Markdown with front matter (`id`, `title`, `revision`), an intro paragraph and one
// `###` slide per step. Steps use TalkWeaver's own slide syntax and the SAME step tokens as the 0.37
// pre-work section (`{task}` `{readonly}` `{minutes=…}` `{check}` + `{right}` `{poll=…}` `{noask}` `{local}`):
// this module builds a synthetic pre-work section out of the file's slides and hands it to
// compiler/scripts/lib/prework.mjs, so step kinds, quick-check options and the token findings are
// that module's reading, not a second parser. What it adds: the front matter, a layout for each step
// (the compiler's own layout decision, mapped to the six a work file allows), a `video` kind, slug
// checks on ids, and the revision hash.
//
// The hash covers the UTF-8 encoding of the text exactly as passed to `readWorkFile` (a BOM, if the
// caller's text carries one, and CRLF line endings included). Anything that pins a revision (ticket
// 14) must call `workFileHash` on the same text the reader was given.
//
// Pure: no Node APIs, no Electron, no file access. The main process, the renderer and the compiler
// import it. Phase (pre- or post-work) is not in the file: the same file is either, per talk.
// A file is never given a question it did not write: steps are exactly its `###` slides.
import { lexMarkdownBlocksWith } from '../../compiler/scripts/lib/03-markdown-lexer-core.mjs'
import { finalSlideLayout, slideLayoutInput } from '../../compiler/scripts/lib/authored-layout.mjs'
import { parseVideoEmbed } from '../../compiler/scripts/lib/image-line-rules.mjs'
import { POLL_TYPES } from '../../compiler/scripts/lib/poll-authoring.mjs'
import { blankHtmlComments } from '../../compiler/scripts/lib/html-comments.mjs'
import { parseSimpleYaml } from '../../compiler/scripts/lib/simple-yaml.mjs'
import {
  preworkFindings, preworkFromTree, preworkOutlineTree, type PreworkFindingCode, type PreworkStep,
} from '../../compiler/scripts/lib/prework.mjs'
import { workFileHash } from './work-file-hash.ts'

export { workFileHash }

/** The layouts a step may use: title, title + image, two columns, numbered steps, full image, video. */
export type WorkFileLayout = 'title' | 'title-image' | 'columns' | 'steps' | 'full-image' | 'video'
export const WORK_FILE_LAYOUTS: readonly WorkFileLayout[] = ['title', 'title-image', 'columns', 'steps', 'full-image', 'video']

/** slide = a slide to read, video = a video to watch, check = quick check, question = a poll, task = a task. */
export type WorkFileStepKind = 'slide' | 'video' | 'check' | 'question' | 'task'

/** A work-file id, as the Run record names it. */
export const WORK_FILE_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/

export interface WorkFileStep extends Omit<PreworkStep, 'kind' | 'id' | 'pollType'> {
  /** The step's id; null when the author's id is not a slug (see the findings). A heading with no id gets the compiler's fallback id. */
  id: string | null
  /** The poll type as written, when it is an existing one; null for an unknown type (a finding). */
  pollType?: string | null
  kind: WorkFileStepKind
  layout: WorkFileLayout | null
  /** The compiler's own name for the layout when it is outside the six; null otherwise. */
  layoutName: string | null
}

export interface WorkFileDefinition {
  /** From the front matter; '' when missing or not a slug (see the findings). */
  id: string
  title: string
  /** An integer the app bumps when steps change; null when missing or not an integer. */
  revision: number | null
  intro: string
  steps: WorkFileStep[]
}

export type WorkFileFindingCode =
  | 'work-file-id-missing' | 'work-file-id-invalid' | 'work-file-title-missing' | 'work-file-revision-missing'
  | 'work-file-revision-invalid' | 'work-file-no-steps' | 'work-file-step-level' | 'work-file-step-id-missing'
  | 'work-file-step-id-invalid' | 'work-file-step-id-duplicate' | 'work-file-layout-unsupported'
  | 'work-file-h1-unsupported' | 'work-file-poll-unknown' | 'work-file-video-missing'
  | Exclude<PreworkFindingCode, 'prework-section-duplicate' | 'prework-section-empty' | 'prework-token-outside' | 'prework-results-unknown' | 'prework-results-invalid' | 'prework-results-local'>

export interface WorkFileFinding {
  code: WorkFileFindingCode
  /** The step the finding is about; null for the file as a whole. */
  stepId: string | null
  /** 1-based line in the file, when known. */
  line: number | null
  /** What was found (the layout name, the duplicated id, …). */
  detail: string
  /** Blocking findings stop a file being sent; warnings do not. */
  severity: 'blocking' | 'warning'
}

export interface WorkFileReading {
  definition: WorkFileDefinition
  findings: WorkFileFinding[]
  /** SHA-256 of the file's bytes (see work-file-hash.ts). */
  hash: string
  /** The `revision` the author's front matter carries (also on `definition`). */
  revision: number | null
  /** True when no finding is blocking. */
  ok: boolean
}

const WARNINGS = new Set<WorkFileFindingCode>([
  'work-file-revision-missing', 'work-file-video-missing', 'prework-right-misplaced', 'prework-readonly-without-task', 'prework-minutes-invalid',
  'prework-local-on-slide',
])

// The compiler's layouts that are a plain slide of text under its title (a list, a statement) and
// the ones with a picture beside the text.
const TITLE_LAYOUTS = new Set(['title', 'list', 'statement'])
const TITLE_IMAGE_LAYOUTS = new Set(['copy-visual', 'list-visual'])
// A block the six layouts cannot hold, named by what it is.
const FOREIGN_BLOCKS = new Set(['table', 'code'])

interface Tree { level: number; title: string; attrs: Record<string, any>; id: string; contentLines: string[]; notesLines: string[]; children: Tree[]; sourceLine: number }

const KEY_RE = /^[A-Za-z0-9_-]+$/

// `key: value   # note`: an unquoted value ends at ` #`. A linear scan (no backtracking pattern), so a
// pathological line costs a pass over its length.
function withoutComment(line: string): string {
  const colon = line.indexOf(':')
  if (colon <= 0 || !KEY_RE.test(line.slice(0, colon))) return line
  const rest = line.slice(colon + 1).trimEnd()
  const start = rest.length - rest.trimStart().length
  const value = rest.slice(start)
  if (value.startsWith('"') || value.startsWith("'")) {
    // A quoted value ends at its closing quote; a ` # note` after it is dropped.
    const close = value.indexOf(value[0], 1)
    const after = close > 0 ? value.slice(close + 1).trim() : ''
    const quoted = close > 0 && (after === '' || after.startsWith('#')) ? value.slice(0, close + 1) : value
    return line.slice(0, colon + 1) + rest.slice(0, start) + quoted
  }
  const hash = value.search(/[ \t]#/)
  return line.slice(0, colon + 1) + rest.slice(0, start) + (hash >= 0 ? value.slice(0, hash).trimEnd() : value)
}

function frontMatterOf(text: string): Record<string, unknown> {
  if (!text.startsWith('---')) return {}
  const end = text.indexOf('\n---', 3)
  if (end < 0) return {}
  const lines = text.slice(3, end).replace(/\r/g, '').split('\n').map(withoutComment)
  return parseSimpleYaml(lines.join('\n'))
}

/** Own keys only: a `__proto__:` line (or any inherited name) is ignored. */
function own(data: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(data, key) ? data[key] : undefined
}

// The file's `#` headings, as 1-based lines: outside front matter, code fences and comments. The
// outline tree keeps a `#` out of every slide (it is the deck title there); a work file has no deck
// title, so each one is reported instead of being dropped.
function h1Lines(source: string): number[] {
  let body = source
  if (body.startsWith('---')) {
    const end = body.indexOf('\n---', 3)
    if (end >= 0) body = body.slice(0, end + 4).replace(/[^\n]/g, '') + body.slice(end + 4)
  }
  const found: number[] = []
  let fence = ''
  blankHtmlComments(body).split('\n').forEach((raw, index) => {
    const line = raw.replace(/\r$/, '')
    const mark = line.trim().match(/^(`{3,}|~{3,})/)
    if (fence) { if (mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && line.trim() === mark[1]) fence = ''; return }
    if (mark) { fence = mark[1]; return }
    if (/^#(\s|$)/.test(line)) found.push(index + 1)
  })
  return found
}

function hasPlayableVideo(node: Tree): boolean {
  if (typeof node.attrs.video === 'string' && node.attrs.video.trim()) return true
  const blocks = lexMarkdownBlocksWith(node.contentLines, () => null)
  return blocks.some((block) => {
    if (block.type === 'video' || block.type === 'embed') return true
    const src = String(block.src ?? '')
    return block.type === 'image' && Boolean(parseVideoEmbed(src))
  })
}

function layoutOf(node: Tree): { layout: WorkFileLayout | null; name: string | null } {
  const lex = (lines: readonly string[]) => lexMarkdownBlocksWith(lines, () => null)
  const name = finalSlideLayout(slideLayoutInput(node as never, {}, lex), lex).layout
  const blocks = lex(node.contentLines)
  const foreign = blocks.find((block) => FOREIGN_BLOCKS.has(block.type))
  if (foreign) return { layout: null, name: foreign.type }
  if (node.attrs.video === true) return { layout: 'video', name: null }
  if (name === 'columns') return { layout: 'columns', name: null }
  if (name === 'steps') return { layout: 'steps', name: null }
  if (name === 'media') {
    const mediaBlock = blocks.find((block) => ['image', 'video', 'embed'].includes(block.type))
    const isVideo = Boolean(mediaBlock) && (mediaBlock!.type !== 'image' || Boolean(parseVideoEmbed(String(mediaBlock!.src ?? ''))))
    return { layout: isVideo ? 'video' : 'full-image', name: null }
  }
  if (TITLE_IMAGE_LAYOUTS.has(name)) return { layout: 'title-image', name: null }
  if (TITLE_LAYOUTS.has(name)) {
    const list = blocks.find((block) => block.type === 'list')
    return { layout: list?.ordered === true ? 'steps' : 'title', name: null }
  }
  return { layout: null, name }
}

/**
 * Reads a work file's text into its definition and findings, and gives its revision hash. Never throws
 * on content. The hash is `workFileHash(text)`: the UTF-8 encoding of `text` exactly as passed in.
 */
export function readWorkFile(text: string): WorkFileReading {
  const input = String(text ?? '')
  const source = input.replace(/^\uFEFF/, '')
  const findings: WorkFileFinding[] = []
  const add = (code: WorkFileFindingCode, stepId: string | null, line: number | null, detail = ''): void => {
    findings.push({ code, stepId, line, detail, severity: WARNINGS.has(code) ? 'warning' : 'blocking' })
  }

  const data = frontMatterOf(source)
  const idValue = own(data, 'id')
  const titleValue = own(data, 'title')
  const revisionValue = own(data, 'revision')
  const rawId = typeof idValue === 'string' ? idValue.trim() : typeof idValue === 'number' ? String(idValue) : ''
  const title = typeof titleValue === 'string' ? titleValue.trim() : ''
  let id = ''
  if (!rawId) add('work-file-id-missing', null, null)
  else if (!WORK_FILE_ID_RE.test(rawId)) add('work-file-id-invalid', null, null, rawId)
  else id = rawId
  if (!title) add('work-file-title-missing', null, null)
  let revision: number | null = null
  if (revisionValue === undefined) add('work-file-revision-missing', null, null)
  else if (typeof revisionValue === 'number' && Number.isSafeInteger(revisionValue) && revisionValue >= 0) revision = revisionValue
  else add('work-file-revision-invalid', null, null, String(revisionValue))

  for (const line of h1Lines(source)) add('work-file-h1-unsupported', null, line)

  // The slides become the steps of a synthetic pre-work section: prework.mjs reads them.
  const root = preworkOutlineTree(source) as unknown as Tree
  const slides = root.children
  const sectionOf = (children: Tree[]): Tree => ({
    level: 2, title, attrs: { prework: true }, id: '', contentLines: root.contentLines, notesLines: [], sourceLine: 0, children,
  })
  const read = preworkFromTree({ ...root, children: [sectionOf(slides)] })
  const readSteps = read?.steps ?? []
  const seen = new Map<string, number>()
  for (const step of readSteps) seen.set(step.id, (seen.get(step.id) ?? 0) + 1)

  const steps: WorkFileStep[] = readSteps.map((step, index) => {
    const node = slides[index]
    const line = node.sourceLine || null
    const { layout, name } = layoutOf(node)
    const idOk = !node.id || WORK_FILE_ID_RE.test(node.id)
    const stepId = idOk ? step.id : null
    if (node.level !== 3) add('work-file-step-level', stepId, line, `h${node.level}`)
    else if (node.children.length) add('work-file-step-level', stepId, line, 'nested heading')
    if (!node.id) add('work-file-step-id-missing', stepId, line, node.title)
    else if (!idOk) add('work-file-step-id-invalid', null, line, node.id)
    if ((seen.get(step.id) ?? 0) > 1) add('work-file-step-id-duplicate', stepId, line, step.id)
    if (!layout) add('work-file-layout-unsupported', stepId, line, name ?? '')
    if (node.attrs.video === true || (typeof node.attrs.video === 'string') ) {
      if (!hasPlayableVideo(node)) add('work-file-video-missing', stepId, line, node.title)
    }
    let pollType: string | null | undefined = step.pollType
    // The compiler lowercases poll types (poll-authoring.mjs), so `{poll=Single}` reads as `single`.
    if (typeof pollType === 'string') pollType = pollType.trim().toLowerCase()
    if (pollType !== undefined && !POLL_TYPES.has(pollType)) {
      add('work-file-poll-unknown', stepId, line, pollType)
      pollType = null
    }
    // This slide alone, so every finding of the token rules carries this slide's own line.
    for (const finding of preworkFindings({ ...root, children: [sectionOf([node])] }, preworkFromTree({ ...root, children: [sectionOf([node])] }))) {
      if (['prework-section-duplicate', 'prework-section-empty', 'prework-token-outside', 'prework-results-unknown', 'prework-results-invalid', 'prework-results-local'].includes(finding.code)) continue
      add(finding.code as WorkFileFindingCode, stepId, line, finding.detail)
    }
    const kind: WorkFileStepKind = step.kind === 'slide' && layout === 'video' ? 'video' : step.kind
    const out: WorkFileStep = { ...step, id: stepId, kind, layout, layoutName: layout ? null : name }
    if (pollType !== undefined) out.pollType = pollType
    return out
  })
  if (steps.length === 0) add('work-file-no-steps', null, null)

  return {
    definition: { id, title, revision, intro: read?.intro ?? '', steps },
    findings,
    hash: workFileHash(input),
    revision,
    ok: !findings.some((finding) => finding.severity === 'blocking'),
  }
}

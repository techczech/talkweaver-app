import { parseMarkdownFenceOpeningLine, isMarkdownFenceClosingLine } from '../../compiler/scripts/lib/03-object-token.mjs'

/** The read-only research seam shared by IPC, agents and the two research surfaces. */
export type ResearchScope = 'talk' | 'research' | 'everything'
export const RESEARCH_SCOPES: readonly ResearchScope[] = ['talk', 'research', 'everything']
export const RESEARCH_SCOPE_LABELS = { talk: 'This talk', research: 'All research', everything: 'Everything' } as const
export interface ResearchArtefact { file: string; name: string; type: 'image' | 'html' | 'text'; data?: string }
export interface ResearchUse { file: string; line: number; text: string; slideLine: number; slideTitle: string; slideNumber?: number }
export interface ResearchItem {
  file: string
  project: string
  projectTitle: string
  title: string
  kind: string
  created: string
  prompt: string
  sources: string[]
  by: string
  body: string
  preview: string
  artefacts: ResearchArtefact[]
  /** Main compares canonical paths, so renderer views also work through talk aliases. */
  inCurrentTalk?: boolean
  /** Archive results carry Scout's passage, rather than reading arbitrary files outside open vaults. */
  archive?: boolean
}
export type ResearchFailure = { ok: false; error: { code: string; message: string } }
export type ResearchListResult = { ok: true; items: ResearchItem[]; skipped: number; limited: boolean } | ResearchFailure
export type ResearchUsedResult = { ok: true; uses: ResearchUse[]; skipped: number } | ResearchFailure
export interface ResearchListInput { talkDir: string; file?: string }
export interface ResearchSearchInput { talkDir: string; query: string; scope: ResearchScope; requestId?: string }
export interface ResearchUsedInput { talkDir: string; file: string; requestId?: string }

const label = (value: string): string => value.replace(/[\r\n]/g, ' ').replace(/[\[\]\\]/g, '\\$&')
const destination = (value: string): string => value.split('/').map(p => encodeURIComponent(p)).join('/')
export function researchReference(item: ResearchItem): string {
  return `[Research: ${label(item.title)}](${destination('research/' + item.file.split(/[\\/]/).at(-1))})`
}
/** The source travels with the content; the basename backlink is also what Scout where-used indexes. */
function mapProse(markdown: string, map: (line: string) => string): string {
  let fence: ReturnType<typeof parseMarkdownFenceOpeningLine> = null
  return markdown.split('\n').map(line => {
    if (fence) { if (isMarkdownFenceClosingLine(line, fence)) fence = null; return line }
    const opening = parseMarkdownFenceOpeningLine(line)
    if (opening) { fence = opening; return line }
    return map(line)
  }).join('\n')
}
export function researchInsertText(item: ResearchItem): string {
  const rebase = (path: string): string => /^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(path) || path.startsWith('research/') ? path : `research/${path}`
  let body = mapProse(item.body.trim(), line => line.replace(/^#{1,6}\s+/, '').replace(/(!?\[[^\]]*\]\()([^\s)]+)(\))/g, (_all, before: string, path: string, after: string) => `${before}${rebase(path)}${after}`)
    .replace(/^(\[(?:Embed|Simulation):\s*)(.+?)(\])$/gim, (_all, before: string, path: string, after: string) => `${before}${rebase(path)}${after}`))
  for (const artefact of item.artefacts) {
    const name = artefact.file.split(/[\\/]/).at(-1) ?? artefact.name
    if (body.includes(name) || body.includes(encodeURIComponent(name))) continue
    const path = destination(`research/${name}`)
    if (artefact.type === 'image') body += `\n\n![${label(item.title)}](${path})`
    else if (artefact.type === 'html') body += `\n\n[Embed: ${path}]`
  }
  return `${body}\n\nSource: ${item.sources.map(researchSourceLabel).join('; ') || item.title}\n\n${researchReference(item)}\n`
}
export function researchSlideText(item: ResearchItem): string {
  // Research headings become prose inside this one new slide. Code fences and table syntax stay intact.
  const body = mapProse(researchInsertText(item), line => line.replace(/^#{1,6}\s+/, ''))
  return `## ${label(item.title)}\n\n${body}`
}
export const RESEARCH_DRAG_TYPE = 'application/x-talkweaver-research'

/** Display provenance without exposing Scout's internal passage identifier. */
export function researchSourceLabel(source: string): string {
  if (/^(?:url:)?https?:\/\//i.test(source)) return source.replace(/^url:/, '')
  if (source.startsWith('scout:')) {
    const match = /^scout:([^:]+):(.+):(\d+)(?::\d+)?$/.exec(source)
    return match ? `${match[1].replace(/[-_]/g, ' ')} · ${match[2].split(/[\\/]/).at(-1)} · line ${match[3]}` : 'Archive passage'
  }
  return source.replace(/^file:/, '').split(/[\\/]/).at(-1) || 'Source file'
}

export type ResearchWriteOp = 'rename' | 'kind' | 'delete' | 'move' | 'copy' | 'insertHere'
export interface ResearchWriteInput {
  op: ResearchWriteOp; file: string; title?: string; kind?: string; destination?: string
  renameSlug?: boolean; preview?: boolean; confirmation?: string
}
export type ResearchWriteResult = { ok: true; file: string; uses?: ResearchUse[]; uncheckedOutlines?: string[]; confirmation?: string } | ResearchFailure

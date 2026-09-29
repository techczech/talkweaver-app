// Share for comments (ticket 03): the handout build hook. Compiles a talk into what one push sends
// the shared-talk Worker — the share-no-notes handout with the colleague's comments runtime, and
// per-slide outline source for her proposal editor. Nothing here touches the network or the disk
// beyond the compiler's own read of the outline's folder.
//
// Speaker notes and HTML comments never leave, and what counts as either is decided by the
// COMPILER's own parse, never a scanner of ours: the outline goes through the compiler's comment
// blanking (blankHtmlComments, html-comments.mjs — the one helper the compiler and its slide-script
// reader use) and outline-tree parse (parseOutlineTree, which also ends a notes
// block at the next heading), exactly as adaptMarkdownOutlineV2 prepares it; every line that parse
// routed to notes is blanked (line count kept), and the compiler then builds the page from that
// text with includeNotes:false. Each slide's source text is read off the same tree (heading,
// Trigger line, content lines — never notes lines). scripts/test-shared-talk-build.mjs asserts the
// pushed HTML (SLIDE_SCRIPT included) and the pushed slide text on every awkward case.
import { statSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { parseFrontmatterPairs } from '../shared/frontmatter-editor.ts'
import type { SharedTalkSlide } from '../shared/shared-talk.ts'
import { outlineCompilerBody, slideVisibleText } from '../shared/slide-source-text.ts'

export interface SharedTalkPayload {
  title: string
  html: string
  slides: SharedTalkSlide[]
}

export interface BuildSharedTalkInput {
  compilerDir: string
  outlinePath: string
  /** The outline text as authored: the slide source text is read from this. */
  content: string
  /** The text the compiler reads (pooled image refs resolved). Same line count as `content`. */
  compileContent?: string
  slug: string
  ownerName: string
  proposals: boolean
}

interface TreeNode { level: number; sourceLine: number; headingLine: string; triggerLine: string; contentLines: string[]; children: TreeNode[] }
interface OutlineTreeLib {
  blankHtmlComments(body: string): string
  parseOutlineTree(text: string): { root: TreeNode; notesLineIndexes: number[] }
}
interface ModelSlide { id?: string; title?: string; navTitle?: string; sourceLine?: number }

function libUrl(compilerDir: string, name: string): string {
  return pathToFileURL(join(compilerDir, 'lib', name)).href
}

export async function loadOutlineTreeLib(compilerDir: string): Promise<OutlineTreeLib> {
  const tree = await import(libUrl(compilerDir, '14-outline-tree.mjs'))
  const comments = await import(libUrl(compilerDir, 'html-comments.mjs'))
  if (typeof comments.blankHtmlComments !== 'function' || typeof tree.parseOutlineTree !== 'function') {
    throw new Error('This compiler cannot strip speaker notes for sharing.')
  }
  return { blankHtmlComments: comments.blankHtmlComments, parseOutlineTree: tree.parseOutlineTree } as OutlineTreeLib
}

/** The outline's body as the tree parse reads it (shared/slide-source-text.ts), with the compiler's
 *  own comment blanking. */
function compilerBody(lib: OutlineTreeLib, text: string): { body: string; fmEnd: number; newlines: number } {
  return outlineCompilerBody(String(text), lib.blankHtmlComments)
}

/** The outline with every comment and every speaker-notes line (as the compiler's parse sees them)
 *  blanked; frontmatter untouched; line count and line endings kept. */
export function shareSafeOutline(lib: OutlineTreeLib, text: string): string {
  const { body, fmEnd, newlines } = compilerBody(lib, String(text))
  const tree = lib.parseOutlineTree(body)
  const lines = body.split('\n')
  for (const index of tree.notesLineIndexes) {
    if (index >= 0 && index < lines.length) lines[index] = lines[index].endsWith('\r') ? '\r' : ''
  }
  return String(text).slice(0, fmEnd) + lines.join('\n').slice(newlines)
}

/** Each slide's source text off the compiler's tree, keyed by its 1-based heading line. */
export function slideTextsByLine(lib: OutlineTreeLib, text: string): Map<number, string> {
  const { root } = lib.parseOutlineTree(compilerBody(lib, String(text)).body)
  const byLine = new Map<number, string>()
  const visit = (node: TreeNode): void => {
    if (node.level >= 2) {
      byLine.set(node.sourceLine, slideVisibleText(node))
    }
    node.children.forEach(visit)
  }
  visit(root)
  return byLine
}

/** Per-slide {slideId, title, text} for the compiled slides, in deck order. */
export function slideSourceTexts(textByLine: Map<number, string>, modelSlides: ModelSlide[], compiledIds: string[]): SharedTalkSlide[] {
  const byId = new Map<string, ModelSlide>()
  for (const slide of modelSlides) if (slide.id && !byId.has(slide.id)) byId.set(slide.id, slide)
  return compiledIds.map((slideId) => {
    const slide = byId.get(slideId)
    const text = slide && Number.isInteger(slide.sourceLine) ? textByLine.get(slide.sourceLine!) ?? '' : ''
    return { slideId, title: String(slide?.navTitle || slide?.title || ''), text }
  })
}

function frontmatterValue(content: string, key: string): string {
  return parseFrontmatterPairs(content).find((pair) => pair.key === key && !pair.value.startsWith('\n'))?.value ?? ''
}

/** The name her page's copy uses: the outline's author line, e-mail addresses dropped. */
export function ownerNameFrom(content: string, fallback = ''): string {
  const raw = frontmatterValue(content, 'author') || fallback
  return raw.replace(/[(<]?[^\s<>()@]+@[^\s<>()@]+[)>]?/g, '').replace(/[·,;|]\s*$/, '').replace(/\s{2,}/g, ' ').trim().slice(0, 60)
}

export async function buildSharedTalkPayload(input: BuildSharedTalkInput): Promise<SharedTalkPayload> {
  const { compilerDir, outlinePath, content, slug } = input
  const tree = await loadOutlineTreeLib(compilerDir)
  const { prepareSource } = await import(libUrl(compilerDir, '08-source-adapters.mjs'))
  const { extractStyles, extractSlides } = await import(libUrl(compilerDir, '04-html-extraction.mjs'))
  const { buildShareHtml } = await import(libUrl(compilerDir, '09-output-builders.mjs'))
  const model = await prepareSource(outlinePath, shareSafeOutline(tree, input.compileContent ?? content), slug, statSync(outlinePath))
  const title = frontmatterValue(content, 'title') || String(model.title || '') || slug
  const fullHtml = String(model.fullHtml)
  const compiled = extractSlides(fullHtml) as Array<{ html: string }>
  const html = String(buildShareHtml({
    title,
    slides: compiled,
    styles: extractStyles(fullHtml),
    includeNotes: false,
    slug,
    license: (model as { license?: unknown }).license,
    sharedTalk: { ownerName: input.ownerName, proposals: input.proposals },
  }))
  const ids = compiled.map((slide) => slide.html.match(/data-id="([^"]+)"/)?.[1] ?? '')
  const slides = slideSourceTexts(slideTextsByLine(tree, content), (model.slides || []) as ModelSlide[], ids).filter((slide) => slide.slideId)
  return { title, html, slides }
}

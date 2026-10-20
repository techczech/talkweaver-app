// "Move to a work file" for a retired `{prework}` section (work-files ticket 28; ADR-0040 decision 1;
// journeys Amendment 1: a talk holds no `{prework}` section).
//
// Pure: outline text in, a plan out. No fs, no Electron. The main process (src/main/prework-move.ts)
// writes the plan: the work file first, then the outline through the one outline writer. What the plan
// does to the outline text:
//   - the `## … {prework}` section is removed, from its heading to the next `#`/`##` heading;
//   - the talk's front matter names the new file: `prework: <file id>`;
//   - an authored `results` attribute (on a slide heading or in its Trigger block, read by the
//     compiler's own tokeniser: `{results=quiz}`, `{poll=board results=quiz}`, `{results="quiz"}`)
//     that named a moved step becomes `results=<file id>/<step id>`, so the results slide still
//     resolves (ticket 27). Nothing else is rewritten: not the front matter, comments (also those
//     sharing a line with a rewritten attribute), code or prose.
// What the plan makes of the file:
//   - front matter `id`, `title`, `revision: 1`; the section's intro (its text before the first step,
//     less only the section's own Trigger block); then the steps' text byte for byte (every step id,
//     `{right}` mark, token and body line is kept). A step written with no `{id=…}` is stamped with the
//     id the compiler resolved for it across the whole talk (`ctx.compiledSteps`), because a work-file
//     step must carry one and a `{results=…}` that named it must still find it.
// Refused, with the reason, and nothing planned: no `{prework}` section; no steps in it; the talk already
// names a work file as its pre-work (moving would silently change which file it uses); the compiler's
// reading of the steps is missing or does not match the section.
import { blankHtmlComments } from '../../compiler/scripts/lib/html-comments.mjs'
import { isPreworkSection, parseResultsToken, preworkOutlineTree } from '../../compiler/scripts/lib/prework.mjs'
import { headingBraceGroups, parseTriggerLine } from '../../compiler/scripts/lib/02-triggers-layout.mjs'
import { chartObjectTokenAt } from '../../compiler/scripts/lib/03-object-token.mjs'
import { TRIGGER_ONLY_RE as TREE_TRIGGER_ONLY_RE, resolveSlideId } from '../../compiler/scripts/lib/slide-id.mjs'
import { tokenizeTriggerBody } from '../../compiler/scripts/lib/trigger-tokenizer.mjs'
import { editFrontmatterText, locateFrontmatter, parseFrontmatterPairs } from './frontmatter-editor.ts'
import { namedWorkFile } from './work-file-name.ts'
import { frontMatterTitle, slugForTitle } from './work-file-write.ts'
import { WORK_FILE_ID_RE } from './work-file.ts'

export const MOVE_PREWORK_ACTION = 'Move to a work file'
export const MOVE_PREWORK_MESSAGE = 'Pre-work now lives in a work file'

/** One step of the talk's pre-work as the compiler resolved it (the compiled model's `prework.steps`). */
export interface CompiledPreworkStep { id: string; sourceLine: number | null }

export interface PreworkMoveContext {
  /** File names already in `Work files/` (compared case-insensitively). */
  existingFileNames: readonly string[]
  /** Ids those files carry; a new file never repeats one. */
  existingIds: readonly string[]
  /** The compiler's pre-work steps for THIS outline text (ids deduplicated across the whole talk);
   *  null when the compiler found no section or could not read the talk. */
  compiledSteps: readonly CompiledPreworkStep[] | null
}

export interface PreworkMovePlan {
  ok: true
  fileName: string
  /** The new file's id, as the talk's `prework:` names it. */
  id: string
  title: string
  /** The whole text of the new work file. */
  workFileText: string
  /** The whole new text of the talk's outline. */
  outline: string
  /** The moved steps' ids, in order. */
  stepIds: string[]
}
export type PreworkMoveRefusal = { ok: false; error: string }

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/
const HEADING_RE = /^(#{1,6})[ \t]+\S/
// A line made only of `{id=…}` groups: past the Trigger block, the tree still takes it as the heading's.
const ID_ONLY_LINE_RE = /^\s*(\{id=[A-Za-z0-9_-]+\}\s*)+$/

/**
 * The lines of a heading's own Trigger block, as the compiler's tree reads them (14-outline-tree.mjs
 * triggerLineAfter + furtherTriggerLines, and the id-only line the slide-id resolver takes): the first
 * Trigger line after the heading (blank lines skipped), the Trigger-only lines consecutive with it, and
 * an id-only line further down the prelude that carries the slide's id. `lines` have front matter and
 * comments blanked and no `\r`.
 */
function triggerBlockLines(lines: readonly string[], headingIdx: number): number[] {
  const out: number[] = []
  let j = headingIdx + 1
  while (j < lines.length && !lines[j].trim()) j += 1
  if (j < lines.length && !/^`{3,}/.test(lines[j].trim()) && parseTriggerLine(lines[j])) {
    out.push(j)
    for (let k = j + 1; k < lines.length; k += 1) {
      if (chartObjectTokenAt(lines, k)) break
      if (!(TREE_TRIGGER_ONLY_RE.test(lines[k].trim()) && parseTriggerLine(lines[k]))) break
      out.push(k)
    }
  }
  const resolved = resolveSlideId(lines, headingIdx)
  if (resolved && resolved.line !== headingIdx && ID_ONLY_LINE_RE.test(lines[resolved.line]) && !out.includes(resolved.line)) out.push(resolved.line)
  return out
}

/** A group body with every `results` token that names a moved step rewritten to `<file id>/<step id>`,
 *  tokens read by the compiler's tokeniser (so `results="quiz"` and `poll=board results=quiz` count). */
function rewriteGroupBody(inner: string, fileId: string, moved: ReadonlyMap<string, string>): string {
  let out = inner
  const tokens = tokenizeTriggerBody(inner)
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i]
    const m = /^results[=:]([\s\S]*)$/.exec(token.raw)
    if (!m) continue
    const parsed = parseResultsToken(m[1])
    const stepId = parsed && !parsed.fileId ? moved.get(parsed.stepId) : undefined
    if (!stepId) continue
    out = out.slice(0, token.start) + `results=${fileId}/${stepId}` + out.slice(token.end)
  }
  return out
}

/** `line` with the groups at `groups` (`{start, end}` of each `{…}`, `end` past the `}`) rewritten. */
function rewriteGroups(line: string, groups: ReadonlyArray<{ start: number; end: number }>, fileId: string, moved: ReadonlyMap<string, string>): string {
  let out = line
  for (const group of [...groups].sort((a, b) => b.start - a.start)) {
    const inner = out.slice(group.start + 1, group.end - 1)
    const next = rewriteGroupBody(inner, fileId, moved)
    if (next !== inner) out = out.slice(0, group.start + 1) + next + out.slice(group.end - 1)
  }
  return out
}

function headingGroups(line: string): Array<{ start: number; end: number }> {
  return headingBraceGroups(line.replace(/\r$/, '')).map(({ start, end }) => ({ start, end }))
}
function triggerLineGroups(line: string): Array<{ start: number; end: number }> {
  return [...line.matchAll(/\{[^}]*\}/g)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }))
}

/** Per line of `text`, which characters lie inside an HTML comment (the comments blankHtmlComments blanks). */
function commentMasks(text: string): boolean[][] {
  const inside = new Uint8Array(text.length)
  for (const m of text.matchAll(/<!--[\s\S]*?-->/g)) inside.fill(1, m.index ?? 0, (m.index ?? 0) + m[0].length)
  const out: boolean[][] = []
  let row: boolean[] = []
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') { out.push(row); row = []; continue }
    row.push(inside[i] === 1)
  }
  out.push(row)
  return out
}

/** Which lines sit inside a code fence (the opening and closing lines included). */
function fencedLines(lines: readonly string[]): boolean[] {
  const flags: boolean[] = []
  let fence: string | null = null
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    const open = line.match(FENCE_RE)
    if (fence) {
      flags.push(true)
      const close = line.trim()
      if (open && close[0] === fence[0] && close.length >= fence.length && /^(`+|~+)$/.test(close)) fence = null
    } else if (open) {
      flags.push(true)
      fence = open[1]
    } else flags.push(false)
  }
  return flags
}

function plainTitle(raw: string): string {
  return raw.replace(/\*\*|__|[*_`]/g, '').replace(/\s+/g, ' ').trim()
}

function talkTitleOf(outline: string, lines: readonly string[]): string {
  const fromFrontMatter = parseFrontmatterPairs(outline).find((pair) => pair.key === 'title')?.value
  if (fromFrontMatter && plainTitle(fromFrontMatter)) return plainTitle(fromFrontMatter)
  const h1 = lines.find((line) => /^#[ \t]+\S/.test(line))
  return h1 ? plainTitle(h1.replace(/^#[ \t]+/, '').replace(/\{[^}]*\}/g, '')) : ''
}

/** Whether the outline has a `{prework}` section: what the Doctor's warning is about. */
export function hasPreworkSection(outline: string): boolean {
  return Boolean(findSection(outline))
}

interface TreeNode {
  level: number; title?: string; id?: string; sourceLine?: number
  attrs?: Record<string, unknown>; children?: TreeNode[]
}

function findSection(outline: string): { node: TreeNode; root: TreeNode } | null {
  const root = preworkOutlineTree(outline) as TreeNode | null
  const node = (root?.children ?? []).find((child) => isPreworkSection(child))
  return root && node ? { node, root } : null
}

function* walkNodes(nodes: readonly TreeNode[] | undefined): Generator<TreeNode> {
  for (const node of nodes ?? []) { yield node; yield* walkNodes(node.children) }
}

export function planPreworkMove(outline: string, ctx: PreworkMoveContext): PreworkMovePlan | PreworkMoveRefusal {
  const found = findSection(outline)
  if (!found) return { ok: false, error: 'This talk has no pre-work section to move.' }
  const section = found.node

  // The talk must not already name a work file for its pre-work.
  const named = namedWorkFile(parseFrontmatterPairs(outline).find((pair) => pair.key === 'prework')?.value)
  if (named && named !== 'true' && named !== 'false') {
    return { ok: false, error: `This talk already names the work file “${named}” as its pre-work. Remove that line from the talk’s details first, then move the section.` }
  }

  const lines = outline.split('\n')
  // Lines as the compiler's tree sees them (front matter and comments blanked): where headings are.
  const block = locateFrontmatter(outline)
  const bodyStart = block ? outline.slice(0, block.to).split('\n').length : 0
  const preBody = lines.map((line, index) => (index < bodyStart ? '' : line)).join('\n')
  const seen = blankHtmlComments(preBody).split('\n')
  const fenced = fencedLines(seen)

  const start = Number(section.sourceLine) - 1
  if (!Number.isInteger(start) || start < 0 || start >= lines.length || !HEADING_RE.test(seen[start] ?? '')) {
    return { ok: false, error: 'The pre-work section could not be located in the outline, so nothing was changed.' }
  }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (fenced[i]) continue
    const heading = seen[i].match(/^(#{1,6})[ \t]+\S/)
    if (heading && heading[1].length <= 2) { end = i; break }
  }

  const children = section.children ?? []
  if (children.length === 0) return { ok: false, error: 'The pre-work section has no steps, so there is nothing to move. Delete the section instead.' }
  const firstStep = Number(children[0].sourceLine) - 1
  if (!Number.isInteger(firstStep) || firstStep <= start || firstStep >= end) {
    return { ok: false, error: 'The pre-work section could not be read, so nothing was changed.' }
  }

  // The intro: the section's own text before its first step, less only the section's own Trigger block.
  const plain = seen.map((line) => line.replace(/\r$/, ''))
  const sectionMeta = new Set(triggerBlockLines(plain, start))
  const introLines: string[] = []
  for (let i = start + 1; i < firstStep; i += 1) if (!sectionMeta.has(i)) introLines.push(lines[i].replace(/\r$/, ''))
  while (introLines.length && introLines[0].trim() === '') introLines.shift()
  while (introLines.length && introLines[introLines.length - 1].trim() === '') introLines.pop()
  const intro = introLines.join('\n')

  // The steps' ids: an id the author wrote is kept as written; a step with none is stamped with the id
  // the compiler resolved for it across the whole talk, so a `{results=…}` that found it still does.
  // `moved`: the id each step answered to before the move (the compiler's) → its id in the file.
  const idOf = (child: TreeNode): string => String((child.attrs?.id as string | undefined) ?? child.id ?? '').trim()
  const compiledAt = new Map<number, string>()
  for (const step of ctx.compiledSteps ?? []) {
    if (Number.isInteger(step.sourceLine) && typeof step.id === 'string' && step.id) compiledAt.set(Number(step.sourceLine), step.id)
  }
  const compiledOf = children.map((child) => compiledAt.get(Number(child.sourceLine)))
  if (compiledOf.some((id) => !id)) return { ok: false, error: 'The pre-work section could not be read, so nothing was changed.' }
  const fileIds: Array<string | null> = children.map(idOf).map((id) => id || null)
  const taken = new Set(fileIds.filter((id): id is string => Boolean(id)))
  // The compiler's id where no written id has it; then a free variant for any that collide.
  children.forEach((_, i) => {
    if (fileIds[i] || taken.has(compiledOf[i]!)) return
    fileIds[i] = compiledOf[i]!
    taken.add(compiledOf[i]!)
  })
  children.forEach((_, i) => {
    if (fileIds[i]) return
    let id = compiledOf[i]!
    for (let n = 2; taken.has(id); n += 1) id = `${compiledOf[i]}-${n}`
    fileIds[i] = id
    taken.add(id)
  })
  const stepIds = fileIds as string[]
  const moved = new Map<string, string>()
  children.forEach((_, i) => moved.set(compiledOf[i]!, stepIds[i]))

  const stepLines = lines.slice(firstStep, end).map((line) => line.replace(/\r$/, ''))
  const insertAfter = new Map<number, string>() // offset in stepLines → id line
  children.forEach((child, i) => {
    if (idOf(child)) return
    // Under the heading's Trigger block (so the block stays one block), else right under the heading.
    const heading = Number(child.sourceLine) - 1
    const at = Math.max(heading, ...triggerBlockLines(plain, heading))
    insertAfter.set(at - firstStep, `{id=${stepIds[i]}}`)
  })
  const steps: string[] = []
  stepLines.forEach((line, index) => {
    steps.push(line)
    const add = insertAfter.get(index)
    if (add) steps.push(add)
  })
  while (steps.length && steps[steps.length - 1].trim() === '') steps.pop()

  // The file's name: a slug of "<talk title> pre-work" that no file or id has.
  const talkTitle = talkTitleOf(outline, lines)
  const title = !talkTitle ? 'Pre-work' : /pre-?work/i.test(talkTitle) ? talkTitle : `${talkTitle} pre-work`
  const base = slugForTitle(title) || 'pre-work'
  const names = new Set(ctx.existingFileNames.map((name) => name.toLowerCase()))
  const ids = new Set(ctx.existingIds)
  let id = base
  for (let n = 2; names.has(`${id}.md`) || ids.has(id); n += 1) id = `${base.slice(0, 76)}-${n}`
  if (!WORK_FILE_ID_RE.test(id)) return { ok: false, error: 'No file name could be made for the work file.' }

  const workFileText = [
    '---', `id: ${id}`, `title: ${frontMatterTitle(title)}`, 'revision: 1', '---', '',
    ...(intro ? [intro, ''] : []),
    ...steps, '',
  ].join('\n')

  // The outline: section gone, results attributes pointed at the file, front matter naming it. Only a
  // slide heading and its Trigger block are rewritten, and only the text outside comments: the groups
  // are found in the line as the compiler reads it (comments blanked) and rewritten at the same place
  // in the line as written, so a comment on the line keeps every character.
  const masks = commentMasks(preBody)
  const rewritten = new Map<number, string>()
  const rewriteAt = (index: number, groupsOf: (line: string) => Array<{ start: number; end: number }>): void => {
    if (index < 0 || index >= lines.length || (index >= start && index < end) || fenced[index] || rewritten.has(index)) return
    const line = lines[index]
    if (!line.includes('results')) return
    const mask = masks[index] ?? []
    const toWritten: number[] = []
    let visible = ''
    for (let c = 0; c < line.length; c += 1) if (!mask[c]) { toWritten.push(c); visible += line[c] }
    toWritten.push(line.length)
    // A group with a comment inside it is left as written (it cannot be rewritten without touching the comment).
    const groups = groupsOf(visible).flatMap(({ start: from, end: to }) => {
      const at = toWritten[from]
      const past = toWritten[to - 1] + 1
      return past - at === to - from ? [{ start: at, end: past }] : []
    })
    const next = rewriteGroups(line, groups, id, moved)
    if (next !== line) rewritten.set(index, next)
  }
  for (const node of walkNodes(found.root.children)) {
    const heading = Number(node.sourceLine) - 1
    if (!Number.isInteger(heading) || heading < 0) continue
    rewriteAt(heading, headingGroups)
    for (const index of triggerBlockLines(plain, heading)) rewriteAt(index, triggerLineGroups)
  }
  const rest: string[] = []
  lines.forEach((line, index) => {
    if (index >= start && index < end) return
    rest.push(rewritten.get(index) ?? line)
  })
  // Keep a blank line where the section was.
  const at = start
  if (at > 0 && at < rest.length && rest[at - 1].trim() !== '' && rest[at].trim() !== '') rest.splice(at, 0, '')
  const withoutSection = rest.join('\n')
  const next = editFrontmatterText(withoutSection, [{ key: 'prework', value: id }])
  return { ok: true, fileName: `${id}.md`, id, title, workFileText, outline: next, stepIds }
}

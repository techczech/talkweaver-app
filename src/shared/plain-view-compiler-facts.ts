// Plain view, ticket 07 (eleventh round): what the compiler's own pipeline says about a document's
// slide content. Pure: no DOM, no CodeMirror.
//
// It runs, for every slide, exactly what the compiler runs to make that slide's blocks, the calls
// the outline verbs use (compiler/scripts/lib/12-outline-edit.mjs compileView and readSlide):
//   outlineCompilerBody + blankHtmlComments   front matter and HTML comments blanked, newlines kept
//   parseOutlineTree                          the slides, each with its content lines and their
//                                             source line indexes; the lines folded into a heading
//   classifyContentLines                      the content lines the lexer sees; the others are
//                                             stray Trigger lines, taken out of the content
//   lexMarkdownBlocksWith                     the lexer (03-markdown-lexer-core.mjs), whose blocks
//                                             say which paragraph and which list row had a
//                                             trailing icon token stripped, and on which line
// Nothing here recognises a paragraph, a list item, a directive, an attribution or a Trigger line
// by a pattern of its own.
//
// The one thing the editor does not have is the icon vocabulary (the compiler reads the vendored
// sets from disk). The lexer asks the vocabulary one question that changes what is a token: is a
// BARE `{NAME}` at the end of a list item an icon. `editorIconKey` answers yes for a name with a
// `lucide:` / `svgl:` / `tabler:` prefix (as the compiler does: an unknown prefixed name is its
// placeholder icon) and no for an unprefixed one, where the compiler answers by looking NAME up.
// So `- Thinking {brain}` is a token for the compiler and text here. An explicit `{icon=NAME}` is
// stripped by the lexer whatever NAME is; the token is reported with NAME as written.
import { blankHtmlComments } from '../../compiler/scripts/lib/html-comments.mjs'
import { lexMarkdownBlocksWith, type LexedBlock } from '../../compiler/scripts/lib/03-markdown-lexer-core.mjs'
import { classifyContentLines, parseOutlineTree, type OutlineTreeNode } from '../../compiler/scripts/lib/14-outline-tree.mjs'
import { authoredLayoutDecision, childFoldKind, deckTriggerDefaultsFrom, finalSlideLayout, foldChildLayoutNodes, slideLayoutInput, type FinalSlideLayout } from '../../compiler/scripts/lib/authored-layout.mjs'
import { headingBraceGroups, parseHeadingAttrs } from '../../compiler/scripts/lib/02-triggers-layout.mjs'
import { tokenizeTriggerBody } from '../../compiler/scripts/lib/trigger-tokenizer.mjs'
import { parseSimpleYaml } from '../../compiler/scripts/lib/simple-yaml.mjs'
import { outlineCompilerBody } from './slide-source-text.ts'
import { memoByText } from './memo-by-text.ts'

export type IconKeyNormaliser = (raw: string) => string | null

const PREFIXED = /^(lucide|svgl|tabler):/

/** The editor's stand-in for the compiler's normalizeIconOverrideKey (see the note above). */
export const editorIconKey: IconKeyNormaliser = (raw) => {
  const v = String(raw).trim()
  return v && PREFIXED.test(v) ? v : null
}

export interface CompilerIconToken {
  kind: 'paragraph' | 'item'
  /** 0-based line of the document that the token ends. */
  line: number
  /** 0-based first line of the paragraph (an item: its own line). */
  firstLine: number
  /** NAME as written. */
  key: string
  /** What the normaliser made of NAME (null: nothing is drawn). */
  icon: string | null
  /** A paragraph, or a top-level list row: the compiler draws the icon. A nested row's token is stripped and nothing drawn. */
  top: boolean
  ordered: boolean
  /** Item: characters of the row's indentation, and of its mark with the whitespace after it. */
  indentLength: number
  markLength: number
}

/** One token inside a `{…}` group of a slide's heading line or of one of its layout lines. */
export interface SlideToken {
  /** 0-based line of the document. */
  line: number
  /** The token's characters in the line as the compiler reads it (`readWhole`: also in the written line). */
  from: number
  to: number
  /** Its `{…}` group in that line, braces included. */
  groupFrom: number
  groupTo: number
  /** The token as written, and as the tokeniser reads it (quotes unwrapped). */
  source: string
  raw: string
  /** The attrs this token alone sets (the compiler's resolver, 02-triggers-layout.mjs parseHeadingAttrs). */
  attrs: Record<string, unknown>
  /**
   * The token writes a layout: alone on a slide it makes the compiler's authored decision
   * (authored-layout.mjs: `{cards}`, `{layout=compare}`, `{barchart}`, `{cols=3}`, `{statement-bg=strong}`,
   * `{blocks:3x3}` …), or it sets the list style (`{iconlist}`, `{numbered}`, `{liststyle=icons}` …),
   * which is what a person picks as a layout for a list.
   */
  writesLayout: boolean
  /** On the heading line (a trailing group), not on a layout line. */
  onHeading: boolean
  /** The compiler reads the token's line as it is written: no part of it is inside an HTML comment. */
  readWhole: boolean
}

/** Which layout a slide's tokens name, by the compiler's own resolution. */
export interface SlideLayoutFacts {
  /** 0-based line of the slide's heading, and of the next heading (or the line count). */
  headingLine: number
  endLine: number
  level: number
  /** Every token of the heading's trailing groups and of the slide's layout lines, in the order the compiler folds them (later wins). */
  tokens: readonly SlideToken[]
  /**
   * The compiler's authored decision over the slide's attrs as it compiles them (the front
   * matter's `triggers:` defaults under the slide's own): the layout and the attr key that
   * decided. null: no token names a layout, the compiler reads the content.
   */
  decision: { layout: string; by: string } | null
  /** The slide's own list style (`liststyle`), '' when it writes none. */
  listStyle: string
  /** The slide writes a layout itself: one of its tokens `writesLayout`. False is "Auto". */
  authored: boolean
  /** The own token that decides: the last one setting the deciding key; for a list (or no decision), the last list-style token. null when a deck default decides or nothing is authored. */
  winner: SlideToken | null
  /**
   * The layout the compiler DRAWS the slide in: the `layout` of the compiled slide, by the compiler's
   * own functions (authored-layout.mjs finalSlideLayout, which 08-source-adapters.mjs runs): the
   * tokens, then the content, the divider default, chart-only, the card treatments, over the tree
   * with its child headings folded as the compiler folds them. `decision` is only what the tokens
   * name; this is what the slide gets. null: the heading is no slide of its own (a layout above it
   * takes it as a card, a column or a half).
   */
  final: FinalSlideLayout | null
  /** Every block of the slide's content is a chart object: the compiler draws it as a chart whatever layout its tokens name (`final.chartOnly`). */
  chartOnly: boolean
  /**
   * The compiler keeps the heading as a section divider (`section-title`) whatever layout its tokens
   * name: it has child headings that stay slides of their own (authored-layout.mjs childFoldKind) and
   * an empty body, and either it writes no token that decides a slide, or it names a layout that takes
   * its children and was refused them (authored-layout.mjs sectionDividerDecision, the compiler's own;
   * `final.divider`).
   */
  divider: boolean
  /**
   * The 0-based heading lines of the headings under this one in the tree as parsed, and how many of
   * them the compiler leaves as slides of their own once it has folded the headings that take their
   * children (`keptChildren`, authored-layout.mjs foldChildLayoutNodes). A heading with `keptChildren`
   * is a section; a heading whose children were folded in (`foldKind`, authored-layout.mjs
   * childFoldKind) holds them as cards, columns or carousel items of its ONE slide.
   */
  children: readonly number[]
  keptChildren: readonly number[]
  foldKind: ReturnType<typeof childFoldKind>
  /** Folding the tokens one by one gives exactly the attrs the compiler's tree has for the slide. False: the slide is not edited by token. */
  consistent: boolean
}

/** One block of a slide's content as the lexer made it, with the document lines it was read from. */
export interface LexedBlockFact {
  /** The lexer's type: 'paragraph', 'list', 'code', 'quote' … */
  type: string
  /** 0-based first and last line of the document that the lexer's turn read the block from. */
  firstLine: number
  lastLine: number
  /** The block as JSON (its enumerable fields: text, items, icon, iconOverrides …). */
  json: string
}

export interface CompilerFacts {
  /** The document's lines as the compiler reads them (front matter and comments blanked, no `\r`). */
  bodyLines: readonly string[]
  /** 0-based lines the compiler takes out of the content as Trigger lines: a heading's Trigger block, an id-only line, a stray Trigger line. */
  layoutLines: ReadonlySet<number>
  /** For each of `layoutLines`: the 0-based line of the `##`–`######` heading whose slide the compiler folds it into. */
  layoutLineHeading: ReadonlyMap<number, number>
  /** Every trailing icon token the lexer stripped from a paragraph or a list row, in line order. */
  iconTokens: readonly CompilerIconToken[]
  /** 0-based lines the lexer read as the inside (and the marks) of fenced code. */
  codeLines: ReadonlySet<number>
  /** For every `##`–`######` heading (by its 0-based line): the layout its slide's tokens name. */
  slideLayouts: ReadonlyMap<number, SlideLayoutFacts>
  /**
   * Every block the lexer made of every slide's content, in document order (the lines before the
   * first slide are no slide's content and are left out). Made when asked for: the icon verbs
   * (icon-verbs.ts) read it before and after an edit; nothing reads it on a keystroke.
   */
  lexedBlocks: () => readonly LexedBlockFact[]
  /** What the compiler reads of the slide at `headingLine` apart from its tokens (title, content lines, notes), as one string. */
  slideContent: (headingLine: number) => string
  /** What the compiler reads of everything but that slide (the talk title, the other slides with their attrs, content and notes), as one string. */
  outsideSlide: (headingLine: number) => string
}

interface SlideRead {
  /** The lexer's blocks. Never changed by a reader. */
  blocks: LexedBlock[]
  tokens: Array<Omit<CompilerIconToken, 'line' | 'firstLine'> & { at: number; first: number }>
  code: Array<[number, number]>
}

function readSlideLines(lexed: readonly string[], normalise: IconKeyNormaliser): SlideRead {
  const out: SlideRead = { blocks: [], tokens: [], code: [] }
  const take = (block: LexedBlock): void => {
    const [first, last] = block.sourceLines ?? [0, 0]
    if (block.type === 'code' || (block.type === 'object-chart' && block.storage === 'fence')) { out.code.push([first, last]); return }
    if (block.iconToken) {
      out.tokens.push({ kind: 'paragraph', at: block.iconToken.line, first, key: block.iconToken.key, icon: block.iconToken.icon, top: true, ordered: false, indentLength: 0, markLength: 0 })
    }
    for (const row of block.iconTokens ?? []) {
      out.tokens.push({ kind: 'item', at: row.line, first: row.line, key: row.key, icon: row.icon, top: row.top, ordered: row.ordered, indentLength: row.indentLength, markLength: row.markLength })
    }
    // A chart token that owns the list under it: the list is the lexer's, its rows in the same lines.
    const list = block.type === 'object-chart' ? block.list as LexedBlock | undefined : undefined
    if (list) take(list)
  }
  const blocks = lexMarkdownBlocksWith(lexed, normalise)
  out.blocks = blocks
  for (const block of blocks) take(block)
  return out
}

// A slide's read depends only on the lines the lexer is given, so it is kept by that text: a
// keystroke re-lexes the one slide it is in. One cache per normaliser.
const SLIDE_CACHE_MAX = 4000
const slideCaches = new WeakMap<IconKeyNormaliser, Map<string, SlideRead>>()

function slideRead(lexed: readonly string[], normalise: IconKeyNormaliser): SlideRead {
  let cache = slideCaches.get(normalise)
  if (!cache) { cache = new Map(); slideCaches.set(normalise, cache) }
  const key = lexed.join('\n')
  let read = cache.get(key)
  if (!read) {
    if (cache.size >= SLIDE_CACHE_MAX) cache.clear()
    read = readSlideLines(lexed, normalise)
    cache.set(key, read)
  }
  return read
}

const STATEMENT_DIMENSION = 'statement-dimension'
const sortedJson = (attrs: Record<string, unknown>): string =>
  JSON.stringify(Object.keys(attrs).filter((key) => key !== 'id').sort().map((key) => [key, attrs[key]]))

function tokensOfGroup(line: number, groupFrom: number, inner: string, onHeading: boolean, readWhole: boolean): SlideToken[] {
  return tokenizeTriggerBody(inner).filter((token) => token.raw).map((token): SlideToken => {
    const attrs = parseHeadingAttrs(`{${token.source}}`).attrs
    const alone = authoredLayoutDecision(attrs, Object.keys(attrs))
    return {
      line, from: groupFrom + 1 + token.start, to: groupFrom + 1 + token.end,
      groupFrom, groupTo: groupFrom + inner.length + 2,
      source: token.source, raw: token.raw, attrs,
      writesLayout: alone !== null || Object.prototype.hasOwnProperty.call(attrs, 'liststyle'),
      onHeading, readWhole
    }
  })
}

function slideLayoutFacts(
  node: OutlineTreeNode, strays: ReadonlyArray<Record<string, unknown>>, lines: readonly number[],
  bodyLines: readonly string[], writtenLines: readonly string[], deckDefaults: Record<string, unknown>, endLine: number, final: FinalSlideLayout | null,
  keptChildren: readonly number[]
): SlideLayoutFacts {
  const headingLine = node.sourceLine - 1
  const whole = (line: number): boolean => (writtenLines[line] ?? '').replace(/\r$/, '') === bodyLines[line]
  const tokens: SlideToken[] = []
  const heading = bodyLines[headingLine] ?? ''
  const titled = heading.match(/^(#{2,6})\s+(.+)/)
  if (titled) {
    const offset = heading.length - titled[2].length
    for (const group of headingBraceGroups(titled[2])) tokens.push(...tokensOfGroup(headingLine, offset + group.start, group.inner, true, whole(headingLine)))
  }
  for (const line of lines) {
    for (const group of (bodyLines[line] ?? '').matchAll(/\{([^}]*)\}/g)) tokens.push(...tokensOfGroup(line, group.index, group[1], false, whole(line)))
  }
  // The attrs the compiler has for the slide: the tree's (heading groups, Trigger block), then its stray Trigger lines.
  const own: Record<string, unknown> = { ...node.attrs }
  for (const attrs of strays) Object.assign(own, attrs)
  const replayed: Record<string, unknown> = {}
  for (const token of tokens) Object.assign(replayed, token.attrs)
  const decided = authoredLayoutDecision({ ...deckDefaults, ...own }, Object.keys(own))
  const decision = decided ? { layout: String(decided.layout), by: decided.by } : null
  const listStyle = Object.prototype.hasOwnProperty.call(own, 'liststyle') ? String(own.liststyle) : ''
  const last = (test: (token: SlideToken) => boolean): SlideToken | null => {
    for (let i = tokens.length - 1; i >= 0; i -= 1) if (test(tokens[i])) return tokens[i]
    return null
  }
  const sets = (key: string) => (token: SlideToken): boolean => Object.prototype.hasOwnProperty.call(token.attrs, key)
  // A token on its own decides "statement-dimension" exactly when it carries such a key.
  const dimension = (token: SlideToken): boolean => authoredLayoutDecision(token.attrs, Object.keys(token.attrs))?.by === STATEMENT_DIMENSION
  let winner: SlideToken | null = null
  if (listStyle && (!decision || decision.layout === 'list')) winner = last(sets('liststyle'))
  if (!winner && decision) winner = decision.by === STATEMENT_DIMENSION ? last(dimension) : last(sets(decision.by))
  return {
    headingLine, endLine, level: node.level, tokens, decision, listStyle,
    authored: tokens.some((token) => token.writesLayout),
    winner, final, chartOnly: final?.chartOnly === true, divider: final?.divider === true,
    children: node.children.map((child) => child.sourceLine - 1), keptChildren,
    foldKind: childFoldKind({ ...deckDefaults, ...own }, node.children.length),
    consistent: sortedJson(replayed) === sortedJson(own)
  }
}

export function compilerFacts(text: string, normalise: IconKeyNormaliser = editorIconKey): CompilerFacts {
  const { body, fmEnd } = outlineCompilerBody(text, blankHtmlComments)
  const tree = parseOutlineTree(body)
  // The front matter's `triggers:` defaults, read as the compiler's adapter reads them.
  const deckDefaults = fmEnd > 0 ? deckTriggerDefaultsFrom(parseSimpleYaml(String(text ?? '').slice(3, fmEnd - 4).trim()).triggers).defaults : {}
  const straysOf = new Map<OutlineTreeNode, Array<Record<string, unknown>>>()
  const nodes: OutlineTreeNode[] = []
  const layoutLines = new Set<number>(tree.triggerLineIndexes)
  const iconTokens: CompilerIconToken[] = []
  const codeLines = new Set<number>()
  /** The heading lines of the tree's nodes, in document order. */
  const nodeLines: number[] = []
  /** Each slide's read with the document line of each line the lexer was given. */
  const slideReads: Array<{ read: SlideRead; source: number[] }> = []
  // The lines before the first slide are read the same way. The compiler makes no slide of them
  // (nothing there is drawn or removed), so they are no layout lines; their icon tokens are shown
  // as they will be once a heading is written above them.
  const walk = (node: OutlineTreeNode, self = false): void => {
    for (const child of self ? [node] : node.children) {
      const indexes = tree.contentLineIndexes.get(child) ?? []
      if (!self) { nodeLines.push(child.sourceLine - 1); nodes.push(child) }
      if (indexes.length) {
        const lexed: string[] = []
        const source: number[] = []
        for (const entry of classifyContentLines(child.contentLines)) {
          if (entry.stray) {
            if (!self) {
              layoutLines.add(indexes[entry.index])
              const list = straysOf.get(child)
              if (list) list.push(entry.stray.attrs); else straysOf.set(child, [entry.stray.attrs])
            }
          }
          else { lexed.push(entry.line); source.push(indexes[entry.index]) }
        }
        const read = slideRead(lexed, normalise)
        if (!self) slideReads.push({ read, source })
        for (const { at, first, ...token } of read.tokens) iconTokens.push({ ...token, line: source[at], firstLine: source[first] })
        for (const [first, last] of read.code) for (let k = first; k <= last && k < source.length; k += 1) codeLines.add(source[k])
      }
      if (!self) walk(child)
    }
  }
  walk(tree.root, true)
  walk(tree.root)
  iconTokens.sort((a, b) => a.line - b.line)
  // A line the compiler removes is folded into the slide it stands in: the node whose heading is
  // the nearest above it (a heading's Trigger block and id-only line, a stray line of its content).
  nodeLines.sort((a, b) => a - b)
  const layoutLineHeading = new Map<number, number>()
  let k = 0
  for (const line of [...layoutLines].sort((a, b) => a - b)) {
    while (k < nodeLines.length && nodeLines[k] < line) k += 1
    if (k > 0) layoutLineHeading.set(line, nodeLines[k - 1])
  }
  const bodyLines = body.split(/\r?\n/)
  const writtenLines = String(text ?? '').split('\n')
  const linesOf = new Map<number, number[]>()
  for (const [line, heading] of layoutLineHeading) {
    const list = linesOf.get(heading)
    if (list) list.push(line); else linesOf.set(heading, [line])
  }
  nodes.sort((a, b) => a.sourceLine - b.sourceLine)
  // The layout each slide is drawn in. The compiler folds child headings into the headings that
  // take them, then makes a slide of every node left: the same two functions, over a copy of the
  // tree (the fold changes nodes; every other reading here is of the tree as parsed).
  const copy = (node: OutlineTreeNode): OutlineTreeNode => ({ ...node, attrs: { ...node.attrs }, children: node.children.map(copy) })
  const folded = tree.root.children.map(copy)
  foldChildLayoutNodes(folded, { deckTriggerDefaults: deckDefaults })
  const lex = (lines: readonly string[]): LexedBlock[] => slideRead(lines, normalise).blocks
  const finals = new Map<number, FinalSlideLayout>()
  const kept = new Map<number, number[]>()
  const drawn = (list: readonly OutlineTreeNode[]): void => {
    for (const node of list) {
      kept.set(node.sourceLine - 1, node.children.map((child) => child.sourceLine - 1))
      finals.set(node.sourceLine - 1, finalSlideLayout(slideLayoutInput(node, deckDefaults, lex), lex))
      drawn(node.children)
    }
  }
  drawn(folded)
  const slideLayouts = new Map<number, SlideLayoutFacts>()
  nodes.forEach((node, index) => {
    const headingLine = node.sourceLine - 1
    const endLine = index + 1 < nodes.length ? nodes[index + 1].sourceLine - 1 : bodyLines.length
    slideLayouts.set(headingLine, slideLayoutFacts(node, straysOf.get(node) ?? [], (linesOf.get(headingLine) ?? []).sort((a, b) => a - b), bodyLines, writtenLines, deckDefaults, endLine, finals.get(headingLine) ?? null, kept.get(headingLine) ?? []))
  })
  const contentOf = (node: OutlineTreeNode): unknown => [
    node.level, node.title, node.titleIcon ?? '', node.id,
    classifyContentLines(node.contentLines).filter((entry) => !entry.stray).map((entry) => entry.line),
    node.notesLines
  ]
  const slideContent = (headingLine: number): string => {
    const node = nodes.find((candidate) => candidate.sourceLine - 1 === headingLine)
    return node ? JSON.stringify(contentOf(node)) : ''
  }
  const outsideSlide = (headingLine: number): string => JSON.stringify([
    tree.meta.title, tree.deckTitleIcon, tree.root.contentLines, tree.root.notesLines, deckDefaults,
    nodes.map((node) => (node.sourceLine - 1 === headingLine ? null : [contentOf(node), node.attrs, node.contentLines]))
  ])
  const lexedBlocks = (): LexedBlockFact[] => slideReads.flatMap(({ read, source }) => read.blocks.map((block) => {
    const [first, last] = block.sourceLines ?? [-1, -1]
    return { type: String(block.type), firstLine: source[first] ?? -1, lastLine: source[last] ?? -1, json: JSON.stringify(block) }
  }))
  return { bodyLines, layoutLines, layoutLineHeading, iconTokens, codeLines, slideLayouts, lexedBlocks, slideContent, outsideSlide }
}

/**
 * `compilerFacts` of a text with the editor's normaliser, computed once per text (memo-by-text.ts):
 * the editor's extensions, the margin's labels and the verbs (the text before an edit, and the text
 * after it, which the editor then holds) read one computation. Throws what `compilerFacts` throws.
 * The facts are shared: no reader changes them.
 */
export const compilerFactsOf: (text: string) => CompilerFacts = memoByText((text) => compilerFacts(text))

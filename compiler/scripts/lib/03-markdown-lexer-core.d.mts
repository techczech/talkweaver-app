// The part of 03-markdown-lexer-core.mjs the app shares (src/shared/plain-view-compiler-facts.ts, src/shared/quote-write-check.ts).
/** A list row's stripped icon token (a non-enumerable `iconTokens` entry of a list block). */
export interface LexedListIconToken {
  /** Index, in the lines passed to the lexer, of the row's line. */
  line: number
  /** NAME as written. */
  key: string
  /** The normalised icon key, or null. */
  icon: string | null
  /** A top-level row: the only kind whose icon is drawn. */
  top: boolean
  ordered: boolean
  /** Characters of the row's indentation. */
  indentLength: number
  /** Characters of the row's mark and the whitespace after it. */
  markLength: number
}
export interface LexedBlock {
  type: string
  text?: string
  icon?: string
  /** Non-enumerable: [first, last] index of the block's lines, in the lines passed in. */
  sourceLines?: [number, number]
  /** Non-enumerable, paragraph: the stripped trailing `{icon=NAME}`. */
  iconToken?: { line: number; key: string; icon: string | null }
  /** Non-enumerable, list: every row whose trailing token was stripped, in line order. */
  iconTokens?: LexedListIconToken[]
  [key: string]: unknown
}
/** The compiler's Markdown lexer. `normalizeIconKey` resolves an icon name (a `{name}` or `{icon=name}` ending a list item or a paragraph) to an icon key, or null. */
export function lexMarkdownBlocksWith(lines: readonly string[], normalizeIconKey: (raw: string) => string | null): LexedBlock[]
export function takeParagraphIconWith(text: string, normalizeIconKey: (raw: string) => string | null): { text: string; icon: string | null; key?: string }
export function paragraphIconTokenAt(text: string): { from: number; tokenFrom: number; keyFrom: number; keyTo: number; tokenTo: number; key: string } | null
export function listItemIconTokenAt(text: string, normalizeIconKey: (raw: string) => string | null): { index: number; key: string; icon: string | null } | null

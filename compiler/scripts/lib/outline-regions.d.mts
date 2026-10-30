export declare const CAPTURE_VIEWS_MARKER: string
export declare function isNotesOpenLine(line: string): boolean
export declare function isNotesCloseLine(line: string): boolean
export declare function isNodeHeadingLine(line: string): boolean
export declare function closedHtmlComments(text: string): Array<{ from: number; to: number }>
export declare const FENCE_KINDS: readonly ['svg', 'mermaid', 'chat', 'terminal', 'trace', 'code']
export type FenceKind = 'svg' | 'mermaid' | 'chat' | 'terminal' | 'trace' | 'code'
export declare function fenceKindForInfo(info: string): FenceKind
export type HtmlCommentKind = 'capture-marker' | 'capture-marker-orphan' | 'reused' | 'added-mark' | 'empty' | 'hidden-heading' | 'comment'
export interface HtmlCommentDescription {
  kind: HtmlCommentKind
  label: string
  explanation: string
  effect: 'deck' | 'hides' | 'none'
}
export declare function describeHtmlComment(
  text: string,
  context?: { aloneOnLine?: boolean; pageAbove?: boolean }
): HtmlCommentDescription

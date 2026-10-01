export declare const ID_TOKEN_RE: RegExp
export declare const TRIGGER_ONLY_RE: RegExp
export declare function preContentWindow(lines: readonly string[], headingIdx: number, endIdx?: number): { start: number; end: number }
export declare function idLineIndex(lines: readonly string[], headingIdx: number, endIdx?: number): number
export declare function resolveSlideId(lines: readonly string[], headingIdx: number, endIdx?: number): { id: string; line: number } | null
export declare function slideIdsInPrelude(lines: readonly string[], headingIdx: number, endIdx?: number): Array<{ id: string; line: number }>
export declare function idTokensToKeep(
  tokens: readonly string[],
  resolved: { id: string; line: number } | null,
  headingIdx?: number
): { keep: Set<number>; kept: string; dropped: string[] }
export declare function headingTitle(line: string): string
export declare function duplicateIdWarning(kept: string, dropped: readonly string[], headingLine: string): string

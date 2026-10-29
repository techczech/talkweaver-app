export declare const LABEL_RE: RegExp
export declare const UNKNOWN_LABEL_RE: RegExp
export declare const NEAREST_LABEL: Readonly<Record<string, string>>
export declare const TURN_ROLES: readonly string[]
export declare const PROMPT_ONLY_RE: RegExp
export declare const COMMAND_RE: RegExp
export type SegmentKind = 'turns' | 'shell' | 'trace'
export interface TurnRow {
  role: string
  duration: string | null
  content: string
  headOnLabel: boolean
  lines: string[]
  contentLength: number
  gap: string[]
}
export interface ShellRow {
  path: string
  command: string
  promptOnly: boolean
  output: string
  lines: string[]
}
export interface TraceRow {
  header: string
  content: string
  lines: string[]
}
export interface TurnSegments { kind: 'turns'; indent: number; preamble: string[]; rows: TurnRow[] }
export interface ShellSegments { kind: 'shell'; indent?: number; preamble: string[]; rows: ShellRow[] }
export interface TraceSegments { kind: 'trace'; indent?: number; preamble: string[]; rows: TraceRow[] }
export type Segments = TurnSegments | ShellSegments | TraceSegments
export type AnyRow = TurnRow | ShellRow | TraceRow
export declare function bodyLineEnding(body: string): '\n' | '\r\n'
export declare function splitTurnSegments(body: string): TurnSegments
export declare function splitShellSegments(body: string): ShellSegments
export declare function splitTraceSegments(body: string): TraceSegments
export declare function splitSegments(kind: 'turns', body: string): TurnSegments
export declare function splitSegments(kind: 'shell', body: string): ShellSegments
export declare function splitSegments(kind: 'trace', body: string): TraceSegments
export declare function splitSegments(kind: SegmentKind, body: string): Segments
export declare function turnContentHints(content: string): Array<{ line: number; word: string; nearest: string }>
export type EditedRow = Record<string, unknown> & { original?: AnyRow }
export declare function serialiseSegments(kind: SegmentKind, body: string, split: Segments, rows: EditedRow[], preamble?: string[]): string
export declare function segmentHash(text: string): string

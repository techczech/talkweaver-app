export interface VideoMarker {
  t: number
  time: string
  name: string
}
export interface VideoMarkerLine extends VideoMarker {
  line: number
}
export const VIDEO_MARKER_RE: RegExp
export const VIDEO_MARKER_MAX_SECONDS: number
export function parseMarkerTime(value: string): number | null
export function formatMarkerTime(seconds: number): string
export function readVideoMarker(line: string): VideoMarker | null
export function videoMarkersAfter(lines: readonly string[], videoLine: number, blocked?: (line: number) => boolean, skip?: (line: number) => boolean): VideoMarkerLine[]

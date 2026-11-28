import {
  IMAGE_SYNTAX_RE, VIDEO_DIRECTIVE_RE, imageSyntaxIsVideo, parseVideoEmbed
} from '../../compiler/scripts/lib/image-line-rules.mjs'
import {
  formatMarkerTime, readVideoMarker, VIDEO_MARKER_MAX_SECONDS, videoMarkersAfter,
  type VideoMarkerLine
} from '../../compiler/scripts/lib/video-markers.mjs'
import { readOutlineObjectRegions, type OutlineObjectRegions } from './objects/outline-object-regions.ts'

export const ORPHAN_VIDEO_MARKER = 'No video above this marker. Move it under a video line.'

export interface AuthoredVideo {
  line: number
  source: string
  ref: string
  player: 'youtube' | 'vimeo' | null
  markers: VideoMarkerLine[]
}

export function scanOutlineVideos(text: string, regions: OutlineObjectRegions = readOutlineObjectRegions(text)): {
  videos: AuthoredVideo[]
  orphans: number[]
} {
  const lines = text.split('\n')
  const skip = (line: number) => regions.kinds[line] === 'comment' && !regions.inFence[line] && !regions.inNotes[line]
  const blocked = (line: number) => !skip(line) && (regions.kinds[line] !== 'outline' || regions.inFence[line] || regions.inNotes[line])
  const videos: AuthoredVideo[] = []
  const orphans: number[] = []
  for (let line = regions.frontmatterLines; line < lines.length; line += 1) {
    if (blocked(line) || skip(line)) continue
    const source = lines[line].trim()
    if (!source) continue
    if (readVideoMarker(source)) {
      orphans.push(line)
      continue
    }
    const directive = VIDEO_DIRECTIVE_RE.exec(source)
    const image = source.startsWith('![') ? IMAGE_SYNTAX_RE.exec(source) : null
    const ref = directive?.[1].trim() ?? (image && !/\{\s*capture\s*\}/i.test(image[4]) &&
      (imageSyntaxIsVideo(image[2]) || /^vid-[a-f0-9]{7}$/.test(image[2])) ? image[2] : null)
    if (!ref) continue
    const markers = videoMarkersAfter(lines, line, blocked, skip)
    videos.push({ line, source, ref, player: parseVideoEmbed(ref)?.kind ?? null, markers })
    line = markers.at(-1)?.line ?? line
  }
  return { videos, orphans }
}

export function markerCountLabel(count: number): string {
  return count === 0 ? 'No markers' : count === 1 ? '1 marker' : `${count} markers`
}

export const videoFileName = (ref: string): string => ref.split(/[?#]/)[0].split(/[\\/]/).at(-1) || ref

export type VideoMarkerEdit =
  | { action: 'add'; t: number; name?: string }
  | { action: 'change'; line: number; t: number; name: string }
  | { action: 'remove'; line: number }

export type VideoMarkerEditResult =
  | { text: string; line: number }
  | { error: string }

/** All three verbs plan a change against the current canonical outline. The caller owns the write. */
function planMarkerEdit(text: string, target: AuthoredVideo, edit: VideoMarkerEdit): VideoMarkerEditResult {
  const current = scanOutlineVideos(text).videos.find(video => video.line === target.line)
  if (!current || current.player || current.source !== target.source ||
      JSON.stringify(current.markers) !== JSON.stringify(target.markers)) {
    return { error: 'The video or its markers changed. Try again.' }
  }
  const marker = edit.action === 'add' ? undefined : current.markers.find(marker => marker.line === edit.line)
  if (edit.action !== 'add' && !marker) return { error: 'This marker moved. Try again.' }
  const lines = text.split(/(?<=\n)/)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const terminated = text.endsWith('\n')
  function finish(line: number): VideoMarkerEditResult {
    if (!terminated && lines.length) lines[lines.length - 1] = lines.at(-1)!.replace(/\r?\n$/, '')
    return { text: lines.join(''), line }
  }
  if (edit.action === 'remove') {
    lines.splice(edit.line, 1)
    return finish(edit.line)
  }
  const name = (edit.name ?? '').trim()
  if (!Number.isSafeInteger(edit.t) || edit.t < 0 || edit.t > VIDEO_MARKER_MAX_SECONDS || /[\r\n\u2028\u2029]/.test(name)) {
    return { error: 'Use a time from 0:00 to 24:00:00 and a name on one line.' }
  }
  if (edit.action === 'add' && current.markers.some(marker => marker.t === edit.t)) return { error: 'A marker is already at this time.' }
  const time = marker?.t === edit.t ? marker.time : formatMarkerTime(edit.t)
  const sourceLine = `[Marker: ${time}${name ? ' ' + name : ''}]`
  if (marker?.t === edit.t) {
    lines[marker.line] = sourceLine + (lines[marker.line].match(/\r?\n$/)?.[0] ?? '')
    return finish(marker.line)
  }
  // An unsorted source has no unique sorted insertion point. Use the first
  // greater time in source order and keep every other authored line in place.
  const others = current.markers.filter(candidate => candidate !== marker)
  const later = others.find(candidate => candidate.t > edit.t)
  let line = later?.line ?? (others.at(-1)?.line ?? current.line) + 1
  if (marker) {
    lines.splice(marker.line, 1)
    if (marker.line < line) line -= 1
  }
  if (!lines[line - 1].endsWith('\n')) lines[line - 1] += eol
  lines.splice(line, 0, sourceLine + eol)
  return finish(line)
}

export const videoMarkerVerbs = {
  add: (text: string, video: AuthoredVideo, edit: Extract<VideoMarkerEdit, { action: 'add' }>) => planMarkerEdit(text, video, edit),
  change: (text: string, video: AuthoredVideo, edit: Extract<VideoMarkerEdit, { action: 'change' }>) => planMarkerEdit(text, video, edit),
  remove: (text: string, video: AuthoredVideo, edit: Extract<VideoMarkerEdit, { action: 'remove' }>) => planMarkerEdit(text, video, edit)
}

export function editVideoMarker(text: string, video: AuthoredVideo, edit: VideoMarkerEdit): VideoMarkerEditResult {
  switch (edit.action) {
    case 'add': return videoMarkerVerbs.add(text, video, edit)
    case 'change': return videoMarkerVerbs.change(text, video, edit)
    case 'remove': return videoMarkerVerbs.remove(text, video, edit)
  }
}

/** The authoring stage gets marker metadata from the panel. Its video keeps its position
 * while marker-only edits change the canonical outline and the compiled presentation. */
export function authoringVideoPreview(text: string, headingLine: number | null) {
  const { videos, orphans } = scanOutlineVideos(text)
  const markers = new Set([...orphans, ...videos.flatMap(video => video.markers.map(marker => marker.line))])
  if (!markers.size) return { text, headingLine }
  const previewText = text.split('\n').filter((_line, index) => !markers.has(index)).join('\n')
  // Marker lines are zero-based; the compiler's heading line is one-based.
  const removedBefore = headingLine === null ? 0 : [...markers].filter(line => line < headingLine - 1).length
  return { text: previewText, headingLine: headingLine === null ? null : headingLine - removedBefore }
}

export function withoutAuthoringVideoMarkers(text: string): string {
  return authoringVideoPreview(text, null).text
}

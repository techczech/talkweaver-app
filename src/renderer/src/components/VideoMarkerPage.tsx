import { useLayoutEffect, useRef, useState } from 'react'
import { Film, Plus, TriangleAlert, X } from 'lucide-react'
import { formatMarkerTime, parseMarkerTime, VIDEO_MARKER_MAX_SECONDS, type VideoMarkerLine } from '../../../../compiler/scripts/lib/video-markers.mjs'
import { videoFileName, type AuthoredVideo, type VideoMarkerEdit } from '../../../shared/video-marker-edits'
import type { MarkerPlayback } from './useMarkerPreview'

export interface VideoMarkerPanel {
  videos: readonly AuthoredVideo[]
  selected: AuthoredVideo
  choose: (index: number) => void
  playback?: MarkerPlayback
  namingT: number | null
  clearNaming: () => void
  add: () => void
  edit: (edit: VideoMarkerEdit) => void
  seek: (t: number) => void
}

type MarkerDraft =
  | { line: number; field: 'name' | 'time'; value: string; error?: string }
  | { t: number; value: string }

export function VideoMarkerPage({ panel }: { panel: VideoMarkerPanel }) {
  const { selected, videos, playback, namingT, clearNaming, add, edit, seek } = panel
  const [draft, setDraft] = useState<MarkerDraft>()
  const input = useRef<HTMLInputElement>(null)
  const markers = [...selected.markers].sort((a, b) => a.t - b.t)
  const duration = playback?.duration ?? null
  const pastEnd = (marker: VideoMarkerLine) => duration !== null && marker.t > duration
  const elapsed = Math.floor(playback?.t ?? 0)
  const time = formatMarkerTime(elapsed)
  const duplicate = markers.some(marker => marker.t === elapsed)
  const active = playback && markers.findLast(marker => !pastEnd(marker) && marker.t <= elapsed)
  const nameLine = markers.find(marker => marker.t === namingT && !marker.name)?.line ?? null
  const autoNaming = !draft || 't' in draft
  const nameValue = autoNaming && draft?.t === namingT ? draft.value : ''
  const current = !autoNaming ? draft
    : nameLine === null ? undefined : { line: nameLine, field: 'name' as const, value: nameValue }
  useLayoutEffect(() => {
    if (current) input.current?.focus()
  }, [current?.line, current?.field])
  function cancel() {
    setDraft(undefined)
    clearNaming()
  }
  function commit(marker: VideoMarkerLine, field: 'name' | 'time', value: string) {
    if (autoNaming && (marker.t !== namingT || marker.name)) {
      cancel()
      return
    }
    const t = field === 'time' ? parseMarkerTime(value) : marker.t
    if (t === null) {
      setDraft({ line: marker.line, field, value, error: 'Use minutes and seconds, like 1:23.' })
      return
    }
    const name = field === 'name' ? value.trim() : marker.name
    cancel()
    if (t !== marker.t || name !== marker.name) edit({ action: 'change', line: marker.line, t, name })
  }
  return <div className="tw-video-marker-page">
    <h4>This video</h4>
    <div className="tw-video-marker-file">
      <Film size={14} aria-hidden />
      {videos.length > 1 ? <select aria-label="This video" value={videos.indexOf(selected)} onChange={event => { cancel(); panel.choose(Number(event.target.value)) }}>
        {videos.map((video, index) => <option key={video.line} value={index}>{videoFileName(video.ref)}</option>)}
      </select> : <span title={videoFileName(selected.ref)}>{videoFileName(selected.ref)}</span>}
      {duration !== null && <time>{formatMarkerTime(duration)}</time>}
    </div>
    <h4 className="tw-video-marker-heading">Markers <span>{markers.length}</span></h4>
    {selected.player ? <p className="tw-video-marker-message">
      Markers work with video files in the talk. This video plays from {selected.player === 'youtube' ? 'YouTube' : 'Vimeo'}, so its markers are kept but not used.
    </p> : <>
      <button type="button" className="toolbar-btn tw-video-marker-add" disabled={duplicate || elapsed > VIDEO_MARKER_MAX_SECONDS} onClick={add}>
        {!duplicate && <Plus size={14} aria-hidden />}
        {duplicate ? `A marker is already at ${time}` : `Add marker at ${time}`}
      </button>
      {!markers.length ? <p className="tw-video-marker-message">No markers yet. Play or drag the video to a point, then add one.</p> :
        <ol className="tw-video-marker-rows" aria-label="Video markers" tabIndex={0}>
          {markers.map((marker, index) => {
            const past = pastEnd(marker)
            const editing = current?.line === marker.line ? current : undefined
            const field = (kind: 'time' | 'name', fallback: string) => editing?.field === kind
              ? <input ref={input} aria-label={kind === 'time' ? 'Marker time' : 'Marker name'}
                  placeholder={kind === 'name' ? 'Name this marker' : undefined}
                  aria-invalid={'error' in editing && !!editing.error || undefined}
                  value={editing.value}
                  onChange={event => {
                    const value = event.target.value
                    setDraft(autoNaming ? { t: marker.t, value } : { line: marker.line, field: kind, value })
                  }}
                  onBlur={cancel}
                  onKeyDown={event => {
                    if (event.key === 'Escape') { event.stopPropagation(); cancel() }
                    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                      event.preventDefault()
                      event.stopPropagation()
                      commit(marker, kind, event.currentTarget.value)
                    }
                  }} />
              : kind === 'time'
                ? <button type="button" className="tw-marker-time" title="Change the time" onClick={() => setDraft({ line: marker.line, field: kind, value: fallback })}>{fallback}</button>
                : <button type="button" className="tw-marker-name" title={fallback} aria-label={fallback}
                    onClick={() => {
                      if (!past) seek(marker.t)
                      setDraft({ line: marker.line, field: kind, value: marker.name })
                    }}>{fallback}</button>
            return <li key={marker.line} data-current={marker === active && !editing || undefined} data-past-end={past || undefined}>
              <div className="tw-video-marker-row">
                <button type="button" className="tw-marker-key" disabled={past} aria-label={`Jump to ${marker.time} ${marker.name}`.trim()}
                  onClick={() => seek(marker.t)}>{past ? <TriangleAlert size={13} aria-hidden /> : index < 9 ? <kbd>{index + 1}</kbd> : '·'}</button>
                {field('time', marker.time)}
                {field('name', marker.name || 'Name this marker')}
                <button type="button" className="tw-marker-remove" title="Remove marker" aria-label={`Remove marker at ${marker.time}`}
                  onClick={() => { cancel(); edit({ action: 'remove', line: marker.line }) }}><X size={13} aria-hidden /></button>
              </div>
              {past && <small>Past the end of the video ({formatMarkerTime(duration!)})</small>}
              {editing && 'error' in editing && editing.error && <small role="status">{editing.error}</small>}
            </li>
          })}
        </ol>}
    </>}
  </div>
}

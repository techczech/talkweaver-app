import { useCallback, useEffect, useRef, useState } from 'react'
import type { AuthoredVideo } from '../../../shared/video-marker-edits'

export interface MarkerPlayback {
  t: number
  duration: number | null
}

interface PreviewVideo extends MarkerPlayback {
  ref: string | null
}

export function markerPreviewUrl(url: string): string {
  const resolved = new URL(url, location.href)
  resolved.searchParams.set('tw-marker-preview', '1')
  return resolved.href
}

export function useMarkerPreview(slideId: string | null, enabled: boolean, files: readonly AuthoredVideo[]) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [snapshot, setSnapshot] = useState<{ url: string; slideId: string; videos: PreviewVideo[] }>()
  useEffect(() => {
    if (!enabled) return
    const receive = (event: MessageEvent): void => {
      const data = event.data
      const iframe = frame.current
      if (!iframe?.contentWindow || event.source !== iframe.contentWindow ||
          data?.type !== 'tw-marker-preview-state' || data.url !== iframe.src ||
          data.slideId !== slideId || !Array.isArray(data.videos)) return
      const videos = data.videos.filter((value: unknown): value is PreviewVideo => {
        if (!value || typeof value !== 'object') return false
        const item = value as PreviewVideo
        return (item.ref === null || typeof item.ref === 'string') &&
          Number.isFinite(item.t) && item.t >= 0 &&
          (item.duration === null || Number.isFinite(item.duration) && item.duration >= 0)
      })
      setSnapshot(old => old && old.url === data.url && old.slideId === data.slideId &&
        JSON.stringify(old.videos) === JSON.stringify(videos)
        ? old : { url: data.url, slideId: data.slideId, videos })
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [enabled, slideId])

  const current = enabled && snapshot?.slideId === slideId && snapshot.url === frame.current?.src ? snapshot : null
  function indexOf(video: AuthoredVideo, files: readonly AuthoredVideo[]): number {
    if (!current || video.player) return -1
    // With the same list length, the DOM and outline share source order (including repeated refs).
    // The reference check also guards against an old frame or an inline/absent asset.
    const local = files.filter(file => !file.player)
    const order = local.indexOf(video)
    const ref = current.videos[order]?.ref
    if (order >= 0 && current.videos.length === local.length &&
        (ref === video.ref || ref === null || /^vid-[a-f0-9]{7}$/.test(video.ref))) return order
    const candidates = current.videos.map((entry, index) => entry.ref === video.ref ? index : -1).filter(index => index >= 0)
    return candidates.length === 1 && files.filter(file => file.ref === video.ref).length === 1 ? candidates[0] : -1
  }
  const currentUrl = current?.url
  const markers = JSON.stringify(files.flatMap(file => {
    const index = indexOf(file, files)
    return index < 0 ? [] : [{ index, markers: file.markers.map(({ t, time, name }) => ({ t, name: name || time })) }]
  }))
  useEffect(() => {
    if (currentUrl) frame.current?.contentWindow?.postMessage({ type: 'tw-marker-preview-markers', url: currentUrl, markers }, '*')
  }, [currentUrl, markers])
  return {
    frame,
    available: !!current?.videos.length,
    playback: (video: AuthoredVideo, files: readonly AuthoredVideo[]): MarkerPlayback | undefined => current?.videos[indexOf(video, files)],
    seek: (video: AuthoredVideo, files: readonly AuthoredVideo[], t: number) => {
      const index = indexOf(video, files)
      if (index >= 0 && current) frame.current?.contentWindow?.postMessage({ type: 'tw-marker-preview-seek', url: current.url, index, t }, '*')
    }
  }
}

export function useMarkerPreviewRead(frame: React.RefObject<HTMLIFrameElement>) {
  return useCallback(() => {
    const iframe = frame.current
    if (iframe?.src) iframe.contentWindow?.postMessage({ type: 'tw-marker-preview-read', url: iframe.src }, '*')
  }, [frame])
}

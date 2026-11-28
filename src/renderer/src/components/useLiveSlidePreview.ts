import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { SlidePreviewSurface } from '../../../shared/slide-preview'

const PREVIEW_DEBOUNCE_MS = 300

type PreviewResult = { path: string; text: string; url: string | null }

/** Keep a full navigation document and use a selected picture while its revision is compiling. */
export function useLiveSlidePreview(outlinePath: string, outlineContent: string, slideId: string, surface: SlidePreviewSurface = 'detail', authoring?: { headingLine: number | null }) {
  const [deck, setDeck] = useState<PreviewResult | null>(null)
  const [focused, setFocused] = useState<(PreviewResult & { slideId: string }) | null>(null)
  const lastPicture = useRef<{ path: string; slideId: string; url: string } | null>(null)
  const deckForPath = deck?.path === outlinePath ? deck : null
  const currentDeck = deckForPath?.text === outlineContent ? deckForPath : null
  const deckUrl = currentDeck?.url
  const targetId = authoring && deckForPath && !deckUrl ? slideId : ''
  const headingLine = targetId ? authoring?.headingLine ?? undefined : undefined
  const currentFocus = focused?.path === outlinePath && focused.text === outlineContent && focused.slideId === slideId ? focused : null
  // An id derived from a heading can change before the workspace's projection rows arrive.
  const fragment = currentFocus?.url?.split('#')[1] ?? encodeURIComponent(slideId)
  const readyUrl = deckUrl
    ? `${deckUrl.split('#')[0]}${fragment ? `#${fragment}` : ''}`
    : currentFocus?.url
  const previewErr = !outlineContent || (currentDeck?.url === null && (!targetId || currentFocus?.url === null))
  const previous = lastPicture.current
  const retainedUrl = previous?.path === outlinePath && previous.slideId === slideId ? previous.url : null
  const previewUrl = previewErr ? null : readyUrl ?? retainedUrl
  const compiling = !previewErr && !readyUrl

  useLayoutEffect(() => {
    if (readyUrl) lastPicture.current = { path: outlinePath, slideId, url: readyUrl }
    else if (!previewUrl) lastPicture.current = null
  }, [outlinePath, slideId, readyUrl, previewUrl])

  useEffect(() => {
    if (!outlineContent) return
    let cancelled = false
    const timer = setTimeout(async () => {
      let url: string | null = null
      try { url = await window.tw.slide.renderPreview(outlinePath, outlineContent, surface) } catch { /* show the preview error */ }
      if (!cancelled) setDeck({ path: outlinePath, text: outlineContent, url })
    }, deckForPath ? PREVIEW_DEBOUNCE_MS : 0)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [outlinePath, outlineContent, surface])

  useEffect(() => {
    if (!outlineContent || !targetId) return
    let cancelled = false
    const timer = setTimeout(async () => {
      let url: string | null = null
      try {
        url = await window.tw.slide.renderPreview(outlinePath, outlineContent, surface, { slideId: targetId, headingLine })
      } catch { /* the full deck can still render this slide */ }
      if (!cancelled) setFocused({ path: outlinePath, text: outlineContent, slideId: targetId, url })
    }, 0)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [outlinePath, outlineContent, surface, targetId, headingLine])

  return { previewUrl, compiling, previewErr }
}

import { useEffect, useRef, useState } from 'react'
import type { SlidePreviewSurface } from '../../../shared/slide-preview'

const PREVIEW_DEBOUNCE_MS = 300

/** Shared last-good-frame compiler discipline for Slide Focus and the Inspector stage. */
export function useLiveSlidePreview(outlinePath: string, outlineContent: string, slideId: string, surface: SlidePreviewSurface = 'detail') {
  const [previewDocumentUrl, setPreviewDocumentUrl] = useState<string | null>(null)
  const [compiling, setCompiling] = useState(false)
  const [previewErr, setPreviewErr] = useState(false)
  const previewNonce = useRef(0)

  useEffect(() => {
    const mine = ++previewNonce.current
    const immediate = previewDocumentUrl == null
    const run = async (): Promise<void> => {
      setCompiling(true)
      let url: string | null = null
      try { url = await window.tw.slide.renderPreview(outlinePath, outlineContent, surface) } catch { url = null }
      if (mine !== previewNonce.current) return
      setCompiling(false)
      if (url == null) setPreviewErr(true)
      else { setPreviewDocumentUrl(url); setPreviewErr(false) }
    }
    if (!outlineContent) { setPreviewErr(true); setCompiling(false); return }
    const handle = setTimeout(() => { void run() }, immediate ? 0 : PREVIEW_DEBOUNCE_MS)
    return () => { clearTimeout(handle); previewNonce.current += 1 }
  }, [outlinePath, outlineContent, surface])

  const previewUrl = previewDocumentUrl == null
    ? null
    : `${previewDocumentUrl.split('#')[0]}${slideId ? `#${encodeURIComponent(slideId)}` : ''}`
  return { previewUrl, compiling, previewErr }
}

import { useEffect, useRef, useState } from 'react'

const PREVIEW_DEBOUNCE_MS = 300

/** Shared last-good-frame compiler discipline for Slide Focus and the Inspector stage. */
export function useLiveSlidePreview(outlinePath: string, outlineContent: string, slideId: string) {
  const [previewDocumentUrl, setPreviewDocumentUrl] = useState<string | null>(null)
  const [compiling, setCompiling] = useState(false)
  const [previewErr, setPreviewErr] = useState(false)
  const previewNonce = useRef(0)

  useEffect(() => {
    const immediate = previewDocumentUrl == null
    const run = async (): Promise<void> => {
      const mine = ++previewNonce.current
      setCompiling(true)
      let url: string | null = null
      try { url = await window.tw.slide.renderPreview(outlinePath, outlineContent) } catch { url = null }
      if (mine !== previewNonce.current) return
      setCompiling(false)
      if (url == null) setPreviewErr(true)
      else { setPreviewDocumentUrl(url); setPreviewErr(false) }
    }
    if (!outlineContent) { setPreviewErr(true); setCompiling(false); return }
    const handle = setTimeout(() => { void run() }, immediate ? 0 : PREVIEW_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [outlinePath, outlineContent])

  const previewUrl = previewDocumentUrl == null
    ? null
    : `${previewDocumentUrl.split('#')[0]}${slideId ? `#${encodeURIComponent(slideId)}` : ''}`
  return { previewUrl, compiling, previewErr }
}

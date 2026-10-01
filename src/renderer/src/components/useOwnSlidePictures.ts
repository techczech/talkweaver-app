// The author's own slide drawn in each layout the picker shows (ADR-0032 §6), requested lazily.
// The picker names the layouts it wants pictures of (Suggested at once, browse and search rows only
// while they are on screen); this hook asks `layoutVariantThumbnail` for them through the shared
// picture policy (src/shared/variant-picture-queue.ts: the window's request slots, retry, backoff and
// give-up), drops requests for rows that scrolled away before their turn, and reuses what it already
// has. The main process caches by content too, so a repeat request is cheap. Nothing is written.
import { useEffect, useRef, useState } from 'react'
import type { SlideRef } from '../../../shared/layout-verbs.ts'
import {
  VARIANT_PICTURE_POLICY, createVariantPictureQueue, markSettled, marksForNewText,
  type VariantPictureMark, type VariantPictureMarks
} from '../../../shared/variant-picture-queue.ts'

/** The surface name main scopes superseding by (see layout-variant-thumbnail.ts). */
export const PICKER_REQUEST_KEY = 'picker'

/** A layout's own-slide picture: its URL, `null` (show the sample), or `{ reason }` (the render says
 *  the layout cannot take this slide: grey the row, say why). Absent while unasked or drawing. */
export type OwnPicture = VariantPictureMark
export type OwnPictures = VariantPictureMarks

interface Params {
  outlinePath: string
  outline: string
  /** The slide: its `{id=…}`, or its heading line while it has none (new slides are unstamped until saved). The
   *  caller re-anchors a line as text above it changes; null asks for nothing. */
  slide: SlideRef | null
  /** Layouts to draw now, most important first. Only layouts the slide can take belong here. */
  wanted: readonly string[]
}

interface SlideRequest { outlinePath: string; outline: string; slide: SlideRef }

/** Layout name → picture mark (see OwnPicture). */
export function useOwnSlidePictures({ outlinePath, outline, slide, wanted }: Params): OwnPictures {
  const [pictures, setPictures] = useState<OwnPictures>({})
  const queueRef = useRef<ReturnType<typeof createVariantPictureQueue<SlideRequest>> | null>(null)
  // One picker session is one slide: an id names it, and so does the heading-line form (whose number moves as
  // lines above shift, so it is not part of the key: the new text asks again for the same slide).
  const slideName = slide == null ? '' : typeof slide === 'string' ? slide : 'heading-line'
  const slideKey = `${outlinePath}\0${slideName}`
  const refKey = slide == null ? '' : typeof slide === 'string' ? slide : `line:${slide.headingLine}`
  const slideKeyRef = useRef(slideKey)
  const wantedKey = wanted.join(',')

  // The queue lives in the effect, so StrictMode's mount → cleanup → mount (and any remount) re-arms a
  // fresh one instead of leaving a disposed queue in the ref. Declared first: the effects below that
  // reset it and name what is wanted run after it on every (re)mount.
  useEffect(() => {
    const queue = createVariantPictureQueue<SlideRequest>(
      (layout, request) => window.tw.talk.layoutVariantThumbnail(request.outlinePath, request.outline, request.slide, layout, undefined, PICKER_REQUEST_KEY),
      (layout, mark) => setPictures((current) => markSettled(current, layout, mark))
    )
    queueRef.current = queue
    return () => {
      queue.dispose()
      if (queueRef.current === queue) queueRef.current = null
    }
  }, [])

  // A different slide never shows the previous slide's pictures; new text of the same slide keeps
  // the old pictures on screen until their replacements arrive (no flicker while the author types),
  // but drops the old text's "cannot take" verdicts.
  useEffect(() => {
    if (slideKeyRef.current !== slideKey) { slideKeyRef.current = slideKey; setPictures({}) }
    else setPictures(marksForNewText)
  }, [slideKey, outline])

  useEffect(() => {
    const queue = queueRef.current
    if (!queue) return
    if (!slide || !window.tw?.talk?.layoutVariantThumbnail) { queue.reset(`none:${slideKey}`, null); return }
    // Naming the slide lets the queue abandon the previous slide's requests still out (their slots free at once).
    queue.reset(`${slideKey}\0${outline}`, { outlinePath, outline, slide }, slideKey)
  }, [slideKey, refKey, outline, outlinePath]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const timer = setTimeout(() => queueRef.current?.want(wantedKey ? wantedKey.split(',') : []), VARIANT_PICTURE_POLICY.settleMs)
    return () => clearTimeout(timer)
  }, [wantedKey, slideKey, outline])

  return pictures
}

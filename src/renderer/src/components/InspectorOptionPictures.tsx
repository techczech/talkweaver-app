import { useEffect, useRef, useState } from 'react'
import type { SlideRef } from '../../../shared/layout-verbs'
import type { OptionValue } from '../../../shared/layout-registry/entries'
import { optionPictureRequest, type OptionPictureSet } from './inspectorModel'
import {
  VARIANT_PICTURE_POLICY, createVariantPictureQueue, isGreyMark, markSettled, marksForNewText,
  type VariantPictureMarks
} from '../../../shared/variant-picture-queue'

/** A group this far below or above the Inspector's visible area already asks for its pictures. */
const VISIBLE_MARGIN_PX = 120

interface Props {
  outlinePath: string
  outline: string
  /** The slide: its `{id=…}`, or its heading line while it has none (new slides are unstamped until saved). */
  slide: SlideRef
  groupKey: string
  groupLabel: string
  set: OptionPictureSet
  selectedToken: string
  /** The token a click on this value WRITES (the deck-marked value clears the group, etc.). */
  commitToken: (value: OptionValue) => string
  onSelect: (value: OptionValue) => void
}

interface GroupRequest { outlinePath: string; outline: string; slide: SlideRef; set: OptionPictureSet; groupKey: string }

/**
 * ADR-0032 §1/§7: one option group drawn as pictures of the author's own slide with that option,
 * the current one outlined. Each picture is `window.tw.talk.layoutVariantThumbnail` for the slide
 * with only that option changed, asked through the shared picture policy (variant-picture-queue.ts:
 * the window's request slots, retry, backoff, give-up) and only while the group is on screen, so a
 * Cards slide's fifteen pictures are drawn a few at a time, the visible group first. A value whose
 * picture is missing (still rendering, or the render failed) shows its name on an empty tile and
 * still works as a button; one the render says cannot take the slide is greyed with the reason.
 */
export default function InspectorOptionPictures({
  outlinePath, outline, slide, groupKey, groupLabel, set, selectedToken, commitToken, onSelect
}: Props): React.JSX.Element {
  const [marks, setMarks] = useState<VariantPictureMarks>({})
  const [onScreen, setOnScreen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const commitRef = useRef(commitToken)
  commitRef.current = commitToken
  const tokensKey = set.pictured.map((value) => value.token).join('\n')
  const slideName = typeof slide === 'string' ? slide : `line:${slide.headingLine}`
  const contentKey = `${outlinePath}\0${slideName}\0${groupKey}\0${set.layout}\0${tokensKey}\0${outline}`

  const queueRef = useRef<ReturnType<typeof createVariantPictureQueue<GroupRequest>> | null>(null)
  // The queue lives in the effect, so StrictMode's mount → cleanup → mount (and any remount) re-arms a
  // fresh one instead of leaving a disposed queue in the ref. Declared before the effects that use it.
  useEffect(() => {
    const queue = createVariantPictureQueue<GroupRequest>(
      (token, request) => {
        const value = request.set.pictured.find((candidate) => candidate.token === token)
        if (!value) return Promise.resolve(null)
        const ask = optionPictureRequest(request.set, request.groupKey, commitRef.current(value))
        return window.tw.talk.layoutVariantThumbnail(request.outlinePath, request.outline, request.slide, ask.layout, ask.options, `inspector:${request.groupKey}`)
      },
      (token, mark) => setMarks((current) => markSettled(current, token, mark))
    )
    queueRef.current = queue
    return () => {
      queue.dispose()
      if (queueRef.current === queue) queueRef.current = null
    }
  }, [])

  // Only a group on screen (or about to be) asks: the rest load as the Inspector scrolls to them.
  useEffect(() => {
    const element = rootRef.current
    if (!element || typeof IntersectionObserver === 'undefined') { setOnScreen(true); return }
    const observer = new IntersectionObserver((entries) => {
      setOnScreen(entries.some((entry) => entry.isIntersecting))
    }, { rootMargin: `${VISIBLE_MARGIN_PX}px 0px` })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // A different slide's pictures are never shown for this one. New text of the same slide keeps the
  // pictures until their replacements arrive (no flicker while typing), but its "cannot take" marks
  // were about the old text and go at once.
  // The heading-line form is one slide whatever line it is on now (the text asks again when lines shift).
  const slideGroup = `${typeof slide === 'string' ? slide : 'heading-line'}\0${groupKey}`
  const slideGroupRef = useRef(slideGroup)
  useEffect(() => {
    if (slideGroupRef.current !== slideGroup) { slideGroupRef.current = slideGroup; setMarks({}) }
    else setMarks(marksForNewText)
  }, [slideGroup, contentKey])

  useEffect(() => {
    const queue = queueRef.current
    if (!queue) return
    if (!window.tw?.talk?.layoutVariantThumbnail) { queue.reset(`none:${slideGroup}`, null); return }
    // Naming the slide lets the queue abandon the previous slide's requests still out (their slots free at once).
    queue.reset(contentKey, { outlinePath, outline, slide, set, groupKey }, slideGroup)
    // `set` is read through contentKey (its layout and tokens); the object itself changes every render.
  }, [contentKey]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const wanted = onScreen ? set.pictured.map((value) => value.token) : []
    const timer = setTimeout(() => queueRef.current?.want(wanted), VARIANT_PICTURE_POLICY.settleMs)
    return () => clearTimeout(timer)
  }, [contentKey, onScreen]) // eslint-disable-line react-hooks/exhaustive-deps

  const columns = set.pictured.length > 4 ? 5 : 4
  // shortcut-id: inspector.option-pictures-move — ← → move between the pictures of one group, as in the Inspector's
  // other option controls (CommandPalette.tsx's OptionControl); focus stays inside the group.
  const moveWithin = (event: React.KeyboardEvent<HTMLButtonElement>, index: number): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    event.stopPropagation()
    const next = (index + (event.key === 'ArrowRight' ? 1 : -1) + set.pictured.length) % set.pictured.length
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
  }
  const hasSelected = set.pictured.some((value) => value.token === selectedToken)

  return (
    <div ref={rootRef} className="opt-pics" role="group" aria-label={groupLabel} style={{ ['--n' as string]: columns }} data-option-pictures={groupKey}>
      {set.pictured.map((value, index) => {
        const selected = value.token === selectedToken
        const mark = marks[value.token]
        const url = typeof mark === 'string' ? mark : undefined
        const cannot = isGreyMark(mark) ? mark.reason : undefined
        return (
          <button
            key={`${groupKey}:${value.token || 'default'}`}
            type="button"
            className={`opt-pic${selected ? ' is-selected' : ''}${cannot ? ' is-unusable' : ''}`}
            data-token={value.token}
            aria-pressed={selected}
            title={cannot ?? value.description}
            tabIndex={selected || (!hasSelected && index === 0) ? 0 : -1}
            // A mouse press must not move focus onto the picture: the cursor stays where it was in the editor.
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              onSelect(value)
              // A mouse click (detail > 0) leaves the cursor in the editor at the same caret, even when focus was
              // elsewhere. A keyboard activation (detail 0) keeps focus on the picture so ←→ and Tab carry on.
              if (event.detail > 0) requestAnimationFrame(() => {
                const editor = document.querySelector<HTMLElement>('.cm-content')
                if (editor && !document.activeElement?.closest('.cm-editor')) editor.focus()
              })
            }}
            // shortcut-id: inspector.option-pictures-choose — ↵ and Space choose the focused picture (a button's own keys).
            onKeyDown={(event) => {
              if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); onSelect(value) }
              else moveWithin(event, index)
            }}
          >
            {url && !cannot ? <img alt="" src={url} draggable={false} /> : <span className="opt-pic-blank" aria-hidden />}
            <span>{value.label}</span>
          </button>
        )
      })}
    </div>
  )
}

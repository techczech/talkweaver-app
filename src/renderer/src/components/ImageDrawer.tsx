import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ImageSearchHit, ImageSearchResult, ImageSearchStatus, VaultPictureResult } from '../../../shared/image-search'
import { shortcutEventMatches } from '../../../shared/shortcut-registry'
import {
  captionFor,
  choiceFor,
  choiceKeyAction,
  CHOICE_COPY,
  DRAWER_COPY,
  editableHint,
  flatOrder,
  moveIndex,
  quietLine,
  viewFor,
  type DrawerTab,
  type HitGroup
} from './imageDrawerModel'

/**
 * The image drawer: docked beside whichever editor view is active, so the editor stays usable. One
 * search (window.tw.images) over SlideWell's screenshots and images, old-PowerPoint images and the
 * pictures in your talks. A result is dragged onto the slide or inserted at the caret with ⌘↵; the
 * parent copies the file into the vault's _assets with its provenance and splices the reference in.
 * What is shown and how it is captioned lives in imageDrawerModel.ts.
 */

/** The drag payload the parent's drop target reads. Only this type is set, so the editor never
 *  mistakes a dragged result for text to paste. */
export const IMAGE_DRAG_TYPE = 'application/x-talkweaver-image'
/** Set as well when the dragged result is an old slide, so the drop target can word its hint before the drop
 *  (the payload itself cannot be read until then). Carries nothing; the hint is the only thing it changes. */
export const OLD_SLIDE_DRAG_TYPE = 'application/x-talkweaver-old-slide'

/** What the drop target says while a result is dragged over it (locked mockup 1, the slot in the stage).
 *  Mockup frame 2 gives no wording for an old slide, so it reads the same with "slide" for "picture". */
export function DropHint({ kind }: { kind: 'picture' | 'slide' | null }) {
  if (!kind) return null
  return <div className="image-drop-hint" data-drop-hint={kind}>Drop a {kind} here<br />or ⌘⏎ to insert at the caret</div>
}

/** Dispatched on window when an old slide is dropped on the slide: the drawer then asks how to use it. */
const DROP_LOST = 'Couldn’t find the slide that was dragged. Nothing was inserted.'
export const OLD_SLIDE_DROP_EVENT = 'tw-image-drawer-old-slide-drop'

export type OldSlideMode = 'editable' | 'picture'

type Props = {
  /** Outline path of the open talk, to caption its own pictures 'This talk · slide N'. */
  currentTalkPath: string | null
  /** Copy the hit into the vault and insert it at the caret. Resolves true when it went in. */
  onInsert: (hit: ImageSearchHit) => Promise<boolean>
  /** Add the old slide as a new, editable slide after the current one. Resolves true when it went in. */
  onInsertOldSlide: (hit: ImageSearchHit) => Promise<boolean>
  /** The number the strip shows for the current slide, for the choice's wording. */
  currentSlide: number | null
  onClose: () => void
}

const DEBOUNCE_MS = 200

export default function ImageDrawer({ currentTalkPath, onInsert, onInsertOldSlide, currentSlide, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<DrawerTab>('images')
  const [status, setStatus] = useState<ImageSearchStatus | null>(null)
  const [result, setResult] = useState<ImageSearchResult | null>(null)
  const [vaultResult, setVaultResult] = useState<VaultPictureResult | null>(null)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const [insertedKey, setInsertedKey] = useState<string | null>(null)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dropNote, setDropNote] = useState<string | null>(null)
  const [choiceHit, setChoiceHit] = useState<ImageSearchHit | null>(null)
  // Counts every request to open the choice, so a repeat opening for the same hit still takes focus.
  const [choiceOpenings, setChoiceOpenings] = useState(0)

  const inputRef = useRef<HTMLInputElement>(null)
  const drawerRef = useRef<HTMLElement>(null)
  const choiceRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const reqRef = useRef(0)
  const busyRef = useRef(false)

  // Which provider answers: decides the quiet line before anything is typed.
  useEffect(() => {
    let cancelled = false
    window.tw.images.status().then((s) => { if (!cancelled) setStatus(s) }).catch(() => { if (!cancelled) setStatus({ provider: null, archive: false }) })
    return () => { cancelled = true }
  }, [])

  // Focus the search box on open. The opening shortcut's keyup can hand focus back to the editor, so
  // it is asked for again a moment later (never selecting, so words typed in between are kept).
  useEffect(() => {
    const focus = (): void => { if (document.activeElement !== inputRef.current) inputRef.current?.focus() }
    const raf = requestAnimationFrame(focus)
    const t = setTimeout(focus, 60)
    return () => { cancelAnimationFrame(raf); clearTimeout(t) }
  }, [])

  // The In your talks tab has its own search (main lists the open vaults' pictures); the other tabs' search is left alone.
  const inTalks = tab === 'in-talks'
  const vaultReqRef = useRef(0)
  useEffect(() => {
    if (!inTalks) return
    const q = query.trim()
    const id = ++vaultReqRef.current
    setLoading(true)
    const handle = setTimeout(async () => {
      let answer: VaultPictureResult | null = null
      try { answer = await window.tw.images.searchVault(q) } catch { answer = null }
      if (id !== vaultReqRef.current) return
      setLoading(false)
      setFailed(answer === null)
      setVaultResult(answer)
      setActive(0)
    }, vaultResult ? DEBOUNCE_MS : 0)
    return () => clearTimeout(handle)
  }, [query, inTalks])

  // Debounced search; a later answer is never overwritten by an earlier one.
  useEffect(() => {
    if (inTalks) return
    const q = query.trim()
    const id = ++reqRef.current
    if (!q) { setResult(null); setFailed(false); setLoading(false); return }
    setLoading(true)
    const handle = setTimeout(async () => {
      let answer: ImageSearchResult | null = null
      try { answer = await window.tw.images.search(q, { match: 'both' }) } catch { answer = null }
      if (id !== reqRef.current) return
      setLoading(false)
      setFailed(answer === null)
      setResult(answer)
      setActive(0)
    }, DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [query, inTalks])

  const view = viewFor({ tab, query, loading, result, vault: vaultResult, failed, status, currentTalkPath })
  const groups: HitGroup[] = view.kind === 'results' ? view.groups : []
  const order = useMemo(() => flatOrder(groups), [groups])
  const quiet = quietLine(status, result, tab, vaultResult)

  useEffect(() => {
    gridRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, order])

  const choice = choiceHit ? choiceFor(choiceHit) : null
  const dismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cancelPendingDismissal = useCallback((): void => {
    if (dismissTimer.current !== null) { clearTimeout(dismissTimer.current); dismissTimer.current = null }
  }, [])

  const openChoice = useCallback((hit: ImageSearchHit): void => {
    setChoiceHit(hit)
    setChoiceOpenings((n) => n + 1)
  }, [])

  const insert = useCallback(async (hit: ImageSearchHit | undefined, mode?: OldSlideMode) => {
    if (!hit || busyRef.current) return
    // An old slide asks first (Editable slide / Picture of the slide); nothing is inserted until it is answered.
    if (hit.source === 'old-slide' && !mode) { openChoice(hit); return }
    busyRef.current = true
    try {
      const went = hit.source === 'old-slide' && mode === 'editable' ? await onInsertOldSlide(hit) : await onInsert(hit)
      if (went) setInsertedKey(hit.key)
    } finally {
      busyRef.current = false
    }
  }, [onInsert, onInsertOldSlide, openChoice])

  // An old slide dropped on the slide: the same question, for the slide that was dragged.
  // The dragged hit is kept from drag start, so a search that ran between drag start and drop does not lose it.
  // Only the key the drop names is trusted: it must match the hit this drawer itself picked up.
  const resultRef = useRef(result)
  resultRef.current = result
  const dragHitRef = useRef<ImageSearchHit | null>(null)
  useEffect(() => {
    const onDrop = (e: Event): void => {
      const key = (e as CustomEvent<{ key?: string }>).detail?.key
      const dragged = dragHitRef.current
      const hit = dragged && dragged.key === key ? dragged : resultRef.current?.hits.find((h) => h.key === key)
      dragHitRef.current = null
      setDragKey(null)
      if (hit) { setDropNote(null); cancelPendingDismissal(); openChoice(hit) }
      else setDropNote(DROP_LOST)
    }
    window.addEventListener(OLD_SLIDE_DROP_EVENT, onDrop)
    return () => window.removeEventListener(OLD_SLIDE_DROP_EVENT, onDrop)
  }, [openChoice])

  // The choice owns the keyboard however it was opened (⌘⏎ in the drawer, or a drop while the cursor was in
  // the editor): it takes focus as it appears, so Enter, P and Esc reach this drawer's key handler and
  // never the editor. Keyed on the opening as well as the hit, so an opening for the same hit (a drop again
  // while the editor has the cursor) takes focus too.
  const choiceKey = choice?.key ?? null
  useLayoutEffect(() => {
    if (choiceKey) choiceRef.current?.focus({ preventScroll: true })
  }, [choiceKey, choiceOpenings])

  // A dismissal scheduled by a blur belongs to the choice that was showing then. Any change of choice
  // (closed, or a new one opened) cancels it, so a late timer can never clear a choice opened after it.
  useLayoutEffect(() => {
    cancelPendingDismissal()
    return cancelPendingDismissal
  }, [choiceHit])

  // Focus leaving the drawer while the choice shows dismisses it, with nothing inserted: its keys must
  // never be answered from somewhere the person is typing. Asked a moment after the blur, when the
  // browser has settled where focus went; the whole window losing focus (another app) keeps the choice.
  function onBlur(): void {
    if (!choiceHit) return
    cancelPendingDismissal()
    dismissTimer.current = setTimeout(() => {
      dismissTimer.current = null
      if (!document.hasFocus()) return
      if (!drawerRef.current?.contains(document.activeElement)) setChoiceHit(null)
    }, 0)
  }

  function answerChoice(mode: OldSlideMode | null): void {
    const hit = choiceHit
    setChoiceHit(null)
    inputRef.current?.focus() // back to the result: the highlight stays on its card
    if (hit && mode) void insert(hit, mode === 'editable' ? 'editable' : 'picture')
  }

  // Another tab shows other results: the highlight (what ⌘↵ inserts) starts again on the first of them.
  function chooseTab(next: DrawerTab): void {
    setTab(next)
    setActive(0)
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLElement>): void {
    const ev = e.nativeEvent
    const answer = choiceKeyAction(choice, ev)
    if (answer) {
      e.preventDefault()
      e.stopPropagation()
      if (answer === 'editable' || answer === 'picture') answerChoice(answer)
      else if (answer === 'cancel') answerChoice(null)
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }
    if (shortcutEventMatches(ev, 'image-drawer.insert')) {
      e.preventDefault()
      e.stopPropagation()
      void insert(order[Math.min(active, order.length - 1)])
      return
    }
    if (order.length === 0) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => moveIndex(i, e.key as 'ArrowUp' | 'ArrowDown', order.length))
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const input = e.target instanceof HTMLInputElement ? e.target : null
      // In the search box the arrows keep moving the text cursor until it reaches an edge of the words.
      const atEdge = !input || (input.selectionStart === input.selectionEnd &&
        (e.key === 'ArrowLeft' ? input.selectionStart === 0 : input.selectionStart === input.value.length))
      if (!atEdge) return
      e.preventDefault()
      setActive((i) => moveIndex(i, e.key as 'ArrowLeft' | 'ArrowRight', order.length))
    }
  }

  let running = 0
  return (
    <aside className="image-drawer" data-image-drawer role="complementary" aria-label={DRAWER_COPY.title} onKeyDown={onKeyDown} onBlur={onBlur} onFocus={cancelPendingDismissal} ref={drawerRef}>
      <div className="image-drawer__head">
        <b>{DRAWER_COPY.title}</b>
        <span className="image-drawer__shortcut">⌘⇧I</span>
        <button type="button" className="image-drawer__close" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <div className="image-drawer__search">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5 21 21" /></svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder={tab === 'in-talks' ? DRAWER_COPY.inTalksPlaceholder : DRAWER_COPY.searchPlaceholder}
          aria-label="Search images"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
        {view.kind === 'results' && <span className="image-drawer__count">{view.count}</span>}
      </div>
      <div className="image-drawer__tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'images'} className={tab === 'images' ? 'is-on' : ''} onClick={() => chooseTab('images')}>{DRAWER_COPY.tabImages}</button>
        <button type="button" role="tab" aria-selected={tab === 'old-slides'} className={tab === 'old-slides' ? 'is-on' : ''} onClick={() => chooseTab('old-slides')}>{DRAWER_COPY.tabOldSlides}</button>
        <button type="button" role="tab" aria-selected={tab === 'in-talks'} className={tab === 'in-talks' ? 'is-on' : ''} onClick={() => chooseTab('in-talks')}>{DRAWER_COPY.tabInTalks}</button>
      </div>
      {quiet && (
        <div className={quiet.icon ? 'image-drawer__quiet image-drawer__quiet--note' : 'image-drawer__quiet'} data-quiet>
          {quiet.icon && <span className="image-drawer__i" aria-hidden="true">i</span>}
          {quiet.text}
        </div>
      )}
      <div className="image-drawer__grid" ref={gridRef} role="listbox" aria-label="Image results">
        {dropNote && <p className="image-drawer__message" data-drop-note>{dropNote}</p>}
        {view.kind === 'idle' && <p className="image-drawer__message">{tab === 'old-slides' ? DRAWER_COPY.idleOldSlides : DRAWER_COPY.idle}</p>}
        {view.kind === 'searching' && <p className="image-drawer__message">{DRAWER_COPY.searching}</p>}
        {view.kind === 'unavailable' && <p className="image-drawer__message">{DRAWER_COPY.unavailable}</p>}
        {view.kind === 'none' && <p className="image-drawer__message">{tab === 'in-talks' ? DRAWER_COPY.inTalksNone : `No ${tab === 'old-slides' ? 'slides' : 'images'} match “${view.query}”.`}</p>}
        {groups.map((group) => (
          <React.Fragment key={group.label ?? 'all'}>
            {group.label && <div className="image-drawer__group">{group.label}</div>}
            {group.hits.map((hit) => {
              const index = running++
              return (
                <Card
                  key={hit.key}
                  hit={hit}
                  index={index}
                  active={index === active}
                  inserted={insertedKey === hit.key}
                  dragging={dragKey === hit.key}
                  currentTalkPath={currentTalkPath}
                  withSourceWord={group.label === null}
                  onPick={() => { setActive(index); inputRef.current?.focus() }}
                  onDragState={(h) => { dragHitRef.current = h; setDragKey(h ? h.key : null) }}
                />
              )
            })}
          </React.Fragment>
        ))}
      </div>
      {choice && (
        <div className="image-drawer__choice" role="group" aria-label={CHOICE_COPY.heading} data-old-slide-choice tabIndex={-1} ref={choiceRef}>
          <div className="image-drawer__choice-title">{CHOICE_COPY.heading}</div>
          {choice.editable ? (
            <button type="button" className="image-drawer__opt is-on" data-choice="editable" onMouseDown={(e) => e.preventDefault()} onClick={() => answerChoice('editable')}>
              <span><b>{CHOICE_COPY.editable}</b><i>{editableHint(currentSlide)}</i></span><kbd>Enter</kbd>
            </button>
          ) : (
            <p className="image-drawer__choice-note" data-choice-note>{choice.note}</p>
          )}
          <button type="button" className={choice.editable ? 'image-drawer__opt' : 'image-drawer__opt is-on'} data-choice="picture" onMouseDown={(e) => e.preventDefault()} onClick={() => answerChoice('picture')}>
            <span><b>{CHOICE_COPY.picture}</b><i>{CHOICE_COPY.pictureHint}</i></span><kbd>P</kbd>
          </button>
          <div className="image-drawer__choice-foot"><kbd>Esc</kbd> {CHOICE_COPY.cancels}</div>
        </div>
      )}
      <div className="image-drawer__foot">
        <span>Drag onto the slide</span><span>·</span>
        <span><kbd>⌘⏎</kbd> insert at caret</span><span>·</span>
        <span><kbd>Esc</kbd> close</span>
      </div>
    </aside>
  )
}

type CardProps = {
  hit: ImageSearchHit
  index: number
  active: boolean
  inserted: boolean
  dragging: boolean
  currentTalkPath: string | null
  withSourceWord: boolean
  onPick: () => void
  onDragState: (hit: ImageSearchHit | null) => void
}

function Card({ hit, index, active, inserted, dragging, currentTalkPath, withSourceWord, onPick, onDragState }: CardProps) {
  const [broken, setBroken] = useState(false)
  const caption = captionFor(hit, currentTalkPath, withSourceWord)
  const cls = ['image-drawer__card', active ? 'is-focus' : '', dragging ? 'is-dragging' : ''].filter(Boolean).join(' ')
  return (
    <div
      className={cls}
      role="option"
      aria-selected={active}
      data-active={active ? 'true' : 'false'}
      data-index={index}
      data-key={hit.key}
      draggable
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
      onDragStart={(e) => {
        e.dataTransfer.setData(IMAGE_DRAG_TYPE, JSON.stringify({ key: hit.key, thumbUrl: hit.thumbUrl, oldSlide: hit.source === 'old-slide' }))
        e.dataTransfer.effectAllowed = 'copy'
        if (hit.source === 'old-slide') e.dataTransfer.setData(OLD_SLIDE_DRAG_TYPE, '1')
        onDragState(hit)
      }}
      onDragEnd={() => onDragState(null)}
    >
      <div className="image-drawer__thumb">
        {broken ? <span>no preview</span> : <img src={hit.thumbUrl} alt="" draggable={false} onError={() => setBroken(true)} />}
      </div>
      <b title={caption.title}>{caption.title}</b>
      {caption.detail && <span className="image-drawer__detail">{caption.detail}</span>}
      {caption.usedIn && <span className="image-drawer__used">{caption.usedIn}</span>}
      {inserted && <span className="image-drawer__used">{DRAWER_COPY.inserted}</span>}
    </div>
  )
}

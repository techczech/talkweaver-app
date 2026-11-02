// The "Search slides" field. It owns what is typed: the Browser learns when typing is pending,
// and receives the query once typing pauses (DEBOUNCE_MS). Before this, the typed text lived in
// the Browser shell, so every keystroke re-rendered every card (~230 ms per key on 5,000 cards).
import { type MutableRefObject, type RefObject, useEffect, useRef, useState } from 'react'
import { DEBOUNCE_MS } from './types'

/** Set the field from outside (Esc, "Clear search", a fresh opening) without waiting for a debounce. */
export interface SlideSearchInputApi {
  set: (value: string) => void
}

export function SlideSearchInput({ inputRef, query, onQueryChange, onPendingChange, apiRef }: {
  inputRef: RefObject<HTMLInputElement>
  /** The committed query the Browser searches with. */
  query: string
  /** Called with the typed text once typing pauses. */
  onQueryChange: (q: string) => void
  /** Reports the debounce as busy so old results cannot appear settled while typing. */
  onPendingChange?: (pending: boolean) => void
  apiRef?: MutableRefObject<SlideSearchInputApi | null>
}) {
  const [raw, setRaw] = useState(query)
  const emittedRef = useRef(query)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onChangeRef = useRef(onQueryChange)
  onChangeRef.current = onQueryChange
  const onPendingRef = useRef(onPendingChange)
  onPendingRef.current = onPendingChange

  const cancel = (): void => {
    if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null }
  }
  // The Browser changed the committed query itself: show it.
  useEffect(() => {
    if (query !== emittedRef.current) { cancel(); onPendingRef.current?.(false); emittedRef.current = query; setRaw(query) }
  }, [query])
  useEffect(() => cancel, [])
  if (apiRef) apiRef.current = { set: (value) => { cancel(); onPendingRef.current?.(false); emittedRef.current = value; setRaw(value) } }

  return (
    <input
      ref={inputRef}
      type="text"
      value={raw}
      onChange={(e) => {
        const value = e.target.value
        setRaw(value)
        cancel()
        onPendingRef.current?.(true)
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          emittedRef.current = value
          onChangeRef.current(value)
          onPendingRef.current?.(false)
        }, DEBOUNCE_MS)
      }}
      placeholder="Words on slides — all words match"
      autoComplete="off"
      aria-label="Search slides — t: title · s: slide · e: exact · i: image text"
      title="t: title · s: slide body · e: exact phrase · i: image text"
    />
  )
}

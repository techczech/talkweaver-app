import { useCallback, useEffect, useRef, useState } from 'react'
import type { ScratchSketch } from '../../../shared/scratchpad'
import { CLOSE_FREEZE_EVENT, type CloseFreezeDetail } from './closeFreezeEvent'
import { notify } from './notify'

interface Draft {
  path: string
  saved: ScratchSketch | null
  text: string
  error: string | null
}

function isDirty(draft: Draft): boolean {
  return draft.text !== (draft.saved?.text ?? '')
}

/** A sketch has its own file and save queue. An outline transaction never passes through here. */
export function useSketch(path: string | null) {
  const pathRef = useRef(path)
  pathRef.current = path
  const draft = useRef<Draft | null>(null)
  const saving = useRef<Promise<boolean> | null>(null)
  const opening = useRef(false)
  const reportedDirty = useRef(false)
  const closeFrozen = useRef(false)
  const [frozen, setFrozen] = useState(false)
  useEffect(() => {
    const freeze = (event: Event) => {
      closeFrozen.current = (event as CustomEvent<CloseFreezeDetail>).detail.frozen
      setFrozen(closeFrozen.current)
    }
    window.addEventListener(CLOSE_FREEZE_EVENT, freeze)
    return () => window.removeEventListener(CLOSE_FREEZE_EVENT, freeze)
  }, [])
  const [display, show] = useState<Draft | null>(null)
  const publish = useCallback((next: Draft | null): void => {
    draft.current = next
    show(next && { ...next })
    const dirty = next !== null && isDirty(next)
    if (dirty !== reportedDirty.current) {
      reportedDirty.current = dirty
      window.tw.scratchpad.reportSketchDirty(dirty)
    }
  }, [])

  const persist = useCallback((current: Draft, target: string, copy = false): Promise<boolean> => {
    if (saving.current) return saving.current
    saving.current = (async () => {
      try {
        let create = copy
        while (create || isDirty(current)) {
          const api = window.tw.scratchpad
          const previous = create ? null : current.saved
          const reply = previous
            ? await api.saveSketch(target, previous.name, previous.revision, current.text)
            : await api.createSketch(target, current.text)
          if (!reply.ok) throw new Error(reply.error)
          current.saved = reply.sketch
          current.path = target
          create = false
        }
        current.error = null
        publish(current.path === pathRef.current ? current : null)
        return true
      } catch (error) {
        current.error = current.path !== pathRef.current
          ? 'The talk moved before this sketch could be saved. Your typing is still here.'
          : error instanceof Error ? error.message : 'The sketch could not be saved. Your typing is still here.'
        publish(current)
        return false
      } finally { saving.current = null }
    })()
    return saving.current
  }, [publish])

  const flush = useCallback((): Promise<boolean> => {
    if (saving.current) return saving.current
    const current = draft.current
    if (!current || !isDirty(current)) return Promise.resolve(true)
    // Always ask to save to the draft's original talk. Main may reject a stale path.
    return persist(current, current.path)
  }, [persist])

  useEffect(() => {
    const current = draft.current
    if (!current || current.path === path) return
    if (isDirty(current) || saving.current) void flush()
    else publish(null)
  }, [path, flush, publish])

  useEffect(() => {
    if (!display || display.path !== path || display.error || !isDirty(display)) return
    const timer = setTimeout(() => void flush(), 450)
    return () => clearTimeout(timer)
  }, [display, path, flush])

  async function open(name?: string): Promise<boolean> {
    const target = pathRef.current
    if (!target || opening.current || closeFrozen.current) return false
    opening.current = true
    try {
      if (!await flush() || target !== pathRef.current || closeFrozen.current) return false
      if (!name) {
        publish({ path: target, text: '', saved: null, error: null })
        return true
      }
      const result = await window.tw.scratchpad.readSketch(target, name)
      if (target !== pathRef.current) return false
      if (!result.ok) throw new Error(result.error)
      if (!await flush() || target !== pathRef.current || closeFrozen.current) return false
      publish({ path: target, text: result.sketch.text, saved: result.sketch, error: null })
      return true
    } catch (error) {
      notify(error instanceof Error ? error.message : 'Could not open the sketch.', 'warning', 'sketch')
      return false
    } finally { opening.current = false }
  }

  const current = display && (display.path === path || isDirty(display)) ? display : null
  return {
    current, frozen, flush, open, read: () => draft.current,
    hasPending() {
      return Boolean(saving.current || (draft.current && isDirty(draft.current)))
    },
    change(text: string) {
      const state = draft.current
      if (!state || closeFrozen.current) return
      state.text = text
      if (!isDirty(state)) state.error = null
      publish(state)
    },
    async saveAsNew() {
      const state = draft.current
      const target = pathRef.current
      if (!state || !target || !state.text || opening.current || saving.current || closeFrozen.current) return false
      return persist(state, target, true)
    },
    async saveElsewhere() {
      const state = draft.current
      if (!state || !isDirty(state) || opening.current || saving.current || closeFrozen.current) return
      opening.current = true
      const text = state.text
      try {
        const reply = await window.tw.scratchpad.exportSketch(text)
        if (!reply.ok) throw new Error(reply.error)
        if (!reply.saved) return
        if (draft.current === state && state.text === text) publish(null)
        notify('Sketch copy saved.', 'success', 'sketch')
      } catch (error) {
        notify(error instanceof Error ? error.message : 'Could not save the sketch copy.', 'warning', 'sketch')
      } finally { opening.current = false }
    },
    discard() {
      const state = draft.current
      if (!state || !isDirty(state) || opening.current || saving.current || closeFrozen.current) return
      if (!window.confirm('Discard the unsaved sketch changes?')) return
      publish(state.saved && state.path === pathRef.current
        ? { ...state, text: state.saved.text, error: null } : null)
    },
    async close() {
      if (!await flush()) return false
      publish(null)
      return true
    },
  }
}

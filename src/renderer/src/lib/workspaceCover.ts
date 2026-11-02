// Whether a full-workspace overlay (the Slide Browser) covers the window. What sits behind it
// skips its layout reads while covered: each read forced a layout of the whole document, overlay
// included (the talk list's row measuring cost 0.6 s per open on a large vault), and nothing behind
// can be seen anyway. It measures again when uncovered.
import { useSyncExternalStore } from 'react'

let covered = false
const listeners = new Set<() => void>()

export function setWorkspaceCovered(value: boolean): void {
  if (covered === value) return
  covered = value
  for (const l of listeners) l()
}

export function isWorkspaceCovered(): boolean {
  return covered
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function useWorkspaceCovered(): boolean {
  return useSyncExternalStore(subscribe, isWorkspaceCovered, isWorkspaceCovered)
}

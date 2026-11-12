// The slides picture's capture surface, made ready before the recording starts (ADR-0043, slice 3a
// review). The presenter's countdown asks for it; by the time the voice starts, the hidden audience
// page has loaded and settled into its audience view and is painting, so nothing painted after the
// recording's origin has to be thrown away. Taking it never waits for the settling: if the surface is
// not settled when the countdown ends, recording starts anyway and keeps every frame as it comes.
// Pure apart from what the caller passes in, so the fallback can be tested without Electron.

export type WarmSource = { isDestroyed: () => boolean; destroy: () => void }
type Entry<S> = { url: string; source: S; loaded: Promise<void>; settled: Promise<void>; timer: ReturnType<typeof setTimeout> }

export function createWarmSources<S extends WarmSource>(deps: {
  create: () => S
  load: (source: S, url: string) => Promise<void>
  settle: (source: S) => Promise<void>
  /** A surface nobody takes is closed after this long (a countdown that led nowhere). */
  idleMs: number
}) {
  const warm = new Map<number, Entry<S>>()
  const close = (owner: number): void => {
    const entry = warm.get(owner)
    if (!entry) return
    warm.delete(owner)
    clearTimeout(entry.timer)
    if (!entry.source.isDestroyed()) entry.source.destroy()
  }
  return {
    /** Start making the surface for this presenter. A second call for the same page reuses it. */
    warm(owner: number, url: string): void {
      const current = warm.get(owner)
      if (current && current.url === url && !current.source.isDestroyed()) return
      close(owner)
      const source = deps.create()
      const loaded = deps.load(source, url)
      // Settling is bounded by the caller's settle; a failure only means it is not settled.
      const settled = loaded.then(() => deps.settle(source)).catch(() => undefined)
      // Only if this surface is still the one being warmed: a newer one for the same presenter stays.
      loaded.catch(() => { if (warm.get(owner)?.source === source) close(owner); else if (!source.isDestroyed()) source.destroy() })
      const timer = setTimeout(() => close(owner), deps.idleMs)
      ;(timer as { unref?: () => void }).unref?.()
      warm.set(owner, { url, source, loaded, settled, timer })
    },
    /**
     * The warmed surface for this page, handed over at once (never waiting for it to settle), or null.
     * A surface for another page is closed.
     */
    take(owner: number, url: string): { source: S; loaded: Promise<void>; settled: Promise<void> } | null {
      const entry = warm.get(owner)
      if (!entry) return null
      warm.delete(owner)
      clearTimeout(entry.timer)
      if (entry.url !== url || entry.source.isDestroyed()) { if (!entry.source.isDestroyed()) entry.source.destroy(); return null }
      return { source: entry.source, loaded: entry.loaded, settled: entry.settled }
    },
    close
  }
}

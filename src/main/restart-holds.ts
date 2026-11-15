// Work that a restart into a new version must not cut short (ADR-0044): a handout publish or export in
// flight. Each IPC handler for such work runs inside during(); the updater's restart gate asks active().
// Pure; unit-tested in scripts/test-update-install.mjs.
export type HoldKind = 'publishing' | 'exporting'

/** `changed` is told whenever work starts or settles, so a waiting update's Restart is offered again at once. */
export function createRestartHolds(changed: () => void = () => {}) {
  const counts: Record<HoldKind, number> = { publishing: 0, exporting: 0 }
  const tell = (): void => { try { changed() } catch { /* starting or closing */ } }
  return {
    /** Runs `work` (sync or async) and counts it as `kind` until it has settled, however it ends. */
    during<A extends unknown[], R>(kind: HoldKind, work: (...args: A) => R | Promise<R>): (...args: A) => Promise<R> {
      return async (...args: A): Promise<R> => {
        counts[kind] += 1
        tell()
        try { return await work(...args) } finally { counts[kind] -= 1; tell() }
      }
    },
    active(kind: HoldKind): boolean { return counts[kind] > 0 },
  }
}
export type RestartHolds = ReturnType<typeof createRestartHolds>

/** The part of ipcMain this needs (so a test can hand in a stand-in). */
interface HandleRegistry { handle(channel: string, listener: (...args: any[]) => unknown): void }

/**
 * Counts every call of the named IPC channels as work in flight, from the moment it is asked until its answer
 * has settled: each handler registered on one of `channels` after this call is wrapped in `holds.during`. Call it
 * before those handlers are registered.
 */
export function holdOnChannels(ipc: HandleRegistry, holds: RestartHolds, channels: Readonly<Record<string, HoldKind>>): void {
  const register = ipc.handle.bind(ipc)
  ipc.handle = (channel, listener) => {
    const kind = channels[channel]
    register(channel, kind ? holds.during(kind, listener) : listener)
  }
}

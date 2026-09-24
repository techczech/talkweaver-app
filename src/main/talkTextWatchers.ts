export interface DirectoryWatcher {
  close: () => void
  on: (event: 'error', listener: () => void) => unknown
}

export type DirectoryWatchFactory = (directory: string, onChange: () => void) => DirectoryWatcher

type WatchEntry = {
  watcher: DirectoryWatcher
  owners: Map<string, () => void>
  timer: ReturnType<typeof setTimeout> | null
}

export function createDirectoryWatcherRegistry(createWatcher: DirectoryWatchFactory): {
  acquire: (directory: string, owner: string, onChange: () => void) => void
  releaseOwner: (owner: string) => void
  releaseAllExcept: (owner: string) => void
  releaseAll: () => void
} {
  const entries = new Map<string, WatchEntry>()

  const closeEntry = (directory: string, entry: WatchEntry): void => {
    if (entry.timer) clearTimeout(entry.timer)
    entries.delete(directory)
    entry.watcher.close()
  }

  const acquire = (directory: string, owner: string, onChange: () => void): void => {
    const existing = entries.get(directory)
    if (existing) {
      existing.owners.set(owner, onChange)
      return
    }

    const entry: WatchEntry = { watcher: null as unknown as DirectoryWatcher, owners: new Map([[owner, onChange]]), timer: null }
    const watcher = createWatcher(directory, () => {
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = setTimeout(() => {
        entry.timer = null
        for (const notify of entry.owners.values()) notify()
      }, 150)
    })
    entry.watcher = watcher
    watcher.on('error', () => closeEntry(directory, entry))
    entries.set(directory, entry)
  }

  const releaseOwner = (owner: string): void => {
    for (const [directory, entry] of entries) {
      entry.owners.delete(owner)
      if (entry.owners.size === 0) closeEntry(directory, entry)
    }
  }

  const releaseAllExcept = (owner: string): void => {
    const owners = new Set([...entries.values()].flatMap((entry) => [...entry.owners.keys()]))
    for (const candidate of owners) {
      if (candidate !== owner) releaseOwner(candidate)
    }
  }

  const releaseAll = (): void => {
    for (const [directory, entry] of [...entries]) closeEntry(directory, entry)
  }

  return { acquire, releaseOwner, releaseAllExcept, releaseAll }
}

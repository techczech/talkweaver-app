export interface RegistryEntry {
  talkSlug: string
  sessionId: string
  expiresAt: number
}

export type SessionLookup = { live: true; sessionId: string } | { live: false }

export function registerSession(entries: Map<string, RegistryEntry>, entry: RegistryEntry): void {
  entries.set(entry.talkSlug, entry)
}

export function lookupSession(entries: Map<string, RegistryEntry>, talkSlug: string, now: number): SessionLookup {
  const entry = entries.get(talkSlug)
  if (!entry || entry.expiresAt <= now) {
    if (entry) entries.delete(talkSlug)
    return { live: false }
  }
  return { live: true, sessionId: entry.sessionId }
}

export function removeSession(entries: Map<string, RegistryEntry>, talkSlug: string, sessionId: string): void {
  if (entries.get(talkSlug)?.sessionId === sessionId) entries.delete(talkSlug)
}

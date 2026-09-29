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

// Shared talks: one active share per talk slug. Entries carry no TTL; the SharedTalk object
// removes its own entry when it is stopped or retired.
export interface ShareRegistryEntry {
  talkSlug: string
  shareId: string
}

export type ShareLookup = { active: true; shareId: string } | { active: false }

export function registerShare(entries: Map<string, ShareRegistryEntry>, entry: ShareRegistryEntry): void {
  entries.set(entry.talkSlug, entry)
}

export function lookupShare(entries: Map<string, ShareRegistryEntry>, talkSlug: string): ShareLookup {
  const entry = entries.get(talkSlug)
  return entry ? { active: true, shareId: entry.shareId } : { active: false }
}

export function removeShare(entries: Map<string, ShareRegistryEntry>, talkSlug: string, shareId: string): void {
  if (entries.get(talkSlug)?.shareId === shareId) entries.delete(talkSlug)
}

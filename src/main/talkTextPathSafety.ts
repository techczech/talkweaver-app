import { existsSync, realpathSync } from 'fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'

export interface TalkTextPaths {
  presentationDir: string
  packDir: string
  partsDir: string
  cleanedDir: string
  notesStorePath: string
  cleanStorePath: string
}

function validatePathSegment(value: unknown, label: 'talk-slug' | 'session-id'): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value ||
      isAbsolute(value) || /[\\/\0]/.test(value) || /^\.+$/.test(value)) {
    throw new Error(`invalid-${label}`)
  }
}

function canonicalTarget(target: string): string {
  let existing = resolve(target)
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) break
    existing = parent
  }
  return resolve(realpathSync(existing), relative(existing, resolve(target)))
}

export function assertPathInsideVault(vaultRoot: string, target: string): string {
  const canonicalVault = realpathSync(vaultRoot)
  const canonical = canonicalTarget(target)
  const fromVault = relative(canonicalVault, canonical)
  if (fromVault === '..' || fromVault.startsWith(`..${sep}`) || isAbsolute(fromVault)) {
    throw new Error('path-outside-vault')
  }
  return canonical
}

export function resolveTalkTextPaths(vaultRoot: string, talkSlug: unknown, sessionId: unknown): TalkTextPaths {
  validatePathSegment(talkSlug, 'talk-slug')
  validatePathSegment(sessionId, 'session-id')
  const presentationDir = assertPathInsideVault(vaultRoot, join(vaultRoot, '_PRESENTATIONS', talkSlug))
  const packDir = assertPathInsideVault(vaultRoot, join(presentationDir, 'agent-rewrite', sessionId))
  return {
    presentationDir,
    packDir,
    partsDir: assertPathInsideVault(vaultRoot, join(packDir, 'parts')),
    cleanedDir: assertPathInsideVault(vaultRoot, join(packDir, 'cleaned')),
    notesStorePath: assertPathInsideVault(vaultRoot, join(packDir, 'notes.json')),
    cleanStorePath: assertPathInsideVault(vaultRoot, join(packDir, 'cleaned.json'))
  }
}

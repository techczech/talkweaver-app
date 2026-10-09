// Where the recording handlers may read, write and delete. Every talk slug and session id the
// recording IPC receives comes from a renderer, and each becomes a path segment; these functions
// are the only place recording.ts turns them into paths. Unsafe input is refused (a named error,
// no path), so a handler that gets `{ ok: false }` touches nothing on disk.
//
// Vault paths go through the guarded Run-path helpers in runs.ts (safe single segments, inside
// `<vault>/_PRESENTATIONS/`, symlinks resolved). Local files under `<userData>/recordings/` are
// named by the session id alone, which must be a safe Run id.

import { lstatSync, readdirSync, realpathSync } from 'fs'
import { readdir, stat } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import { isSafeRunId, isSafeTalkSlug, runPathForTalk, talkRunFolderForTalk } from './runs.ts'
import { pathStaysInside } from './path-containment.ts'

export type RecordingPathError = 'unsafe-talk-slug' | 'unsafe-session-id' | 'unsafe-path'
export type RecordingPath = { ok: true; path: string } | { ok: false; error: RecordingPathError }

function refuse(error: RecordingPathError): RecordingPath {
  return { ok: false, error }
}

function lexists(path: string): boolean {
  try { lstatSync(path); return true } catch { return false }
}

function nameError(talkSlug: unknown, sessionId: unknown): RecordingPathError | null {
  if (!isSafeTalkSlug(talkSlug)) return 'unsafe-talk-slug'
  if (!isSafeRunId(sessionId)) return 'unsafe-session-id'
  return null
}

/** `<userData>/recordings/<sessionId>.<ext>` — the local audio or the no-vault session.json. */
export function localRecordingPath(userDataDir: string, sessionId: unknown, ext: 'webm' | 'json'): RecordingPath {
  if (!isSafeRunId(sessionId)) return refuse('unsafe-session-id')
  const recDir = resolve(userDataDir, 'recordings')
  const path = join(recDir, `${sessionId}.${ext}`)
  return dirname(path) === recDir ? { ok: true, path } : refuse('unsafe-path')
}

/**
 * One continuous audio segment of a session, written as it is recorded: segment 0 is
 * `<sessionId>.webm` (the file every reader already knows), segment n > 0 is
 * `<sessionId>.seg-<n+1>.webm`. A new segment starts when the microphone is picked up again after
 * a loss (WebM from two MediaRecorders does not concatenate into one valid file).
 */
export function localSegmentPath(userDataDir: string, sessionId: unknown, index: unknown): RecordingPath {
  if (!isSafeRunId(sessionId)) return refuse('unsafe-session-id')
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > 999) return refuse('unsafe-path')
  if (index === 0) return localRecordingPath(userDataDir, sessionId, 'webm')
  const recDir = resolve(userDataDir, 'recordings')
  const path = join(recDir, `${sessionId}.seg-${index + 1}.webm`)
  return dirname(path) === recDir ? { ok: true, path } : refuse('unsafe-path')
}

/** `<userData>/recordings/<sessionId>.recording.json` — present while a recording streams to disk. */
export function streamMarkerPath(userDataDir: string, sessionId: unknown): RecordingPath {
  if (!isSafeRunId(sessionId)) return refuse('unsafe-session-id')
  const recDir = resolve(userDataDir, 'recordings')
  const path = join(recDir, `${sessionId}.recording.json`)
  return dirname(path) === recDir ? { ok: true, path } : refuse('unsafe-path')
}

/**
 * The segment files of a session that exist on disk, in segment order. Listed from the folder, so a
 * missing segment (one that recorded nothing) does not hide the ones after it.
 */
export function existingSegmentPaths(userDataDir: string, sessionId: unknown): string[] {
  if (!isSafeRunId(sessionId)) return []
  const recDir = resolve(userDataDir, 'recordings')
  let names: string[]
  try { names = readdirSync(recDir) } catch { return [] }
  const found: Array<{ index: number; path: string }> = []
  for (const name of names) {
    let index: number
    if (name === `${sessionId}.webm`) index = 0
    else {
      const m = name.startsWith(`${sessionId}.seg-`) ? /^\.seg-(\d{1,4})\.webm$/.exec(name.slice(sessionId.length)) : null
      if (!m) continue
      index = Number(m[1]) - 1
    }
    const target = localSegmentPath(userDataDir, sessionId, index)
    if (target.ok && target.path === join(recDir, name)) found.push({ index, path: target.path })
  }
  return found.sort((a, b) => a.index - b.index).map((f) => f.path)
}

/** The segment index a segment file name stands for (`<id>.webm` → 0, `<id>.seg-3.webm` → 2). */
export function segmentIndexOfFile(file: string): number | null {
  if (/^[^/\\]+\.seg-\d{1,4}\.webm$/.test(file)) return Number(/\.seg-(\d{1,4})\.webm$/.exec(file)![1]) - 1
  if (/^[^/\\.]+\.webm$/.test(file)) return 0
  return null
}

/** `<vault>/_PRESENTATIONS/<talkSlug>/<sessionId>.json`, guarded by `runPathForTalk`. */
export function vaultSessionPath(vaultRoot: string, talkSlug: unknown, sessionId: unknown): RecordingPath {
  const error = nameError(talkSlug, sessionId)
  if (error) return refuse(error)
  const path = runPathForTalk(vaultRoot, talkSlug as string, sessionId as string)
  return path ? { ok: true, path } : refuse('unsafe-path')
}

/**
 * A session's JSON: in the vault when one is configured, else beside the local audio. The talk
 * slug is checked in both cases (it also names the R2 key and the History entry).
 */
export function sessionJsonPath(vaultRoot: string | null, userDataDir: string, talkSlug: unknown, sessionId: unknown): RecordingPath {
  if (vaultRoot) return vaultSessionPath(vaultRoot, talkSlug, sessionId)
  const error = nameError(talkSlug, sessionId)
  if (error) return refuse(error)
  return localRecordingPath(userDataDir, sessionId, 'json')
}

/** `<vault>/_PRESENTATIONS/<talkSlug>` for listing a talk's sessions, guarded like a Run path. */
export function talkSessionsFolder(vaultRoot: string, talkSlug: unknown): RecordingPath {
  if (!isSafeTalkSlug(talkSlug)) return refuse('unsafe-talk-slug')
  const path = talkRunFolderForTalk(vaultRoot, talkSlug)
  return path ? { ok: true, path } : refuse('unsafe-path')
}

/** recording:save — the audio file (recording mode only) and the session JSON. */
export function saveTargets(
  vaultRoot: string | null,
  userDataDir: string,
  talkSlug: unknown,
  sessionId: unknown,
  withAudio: boolean
): { ok: true; sessionJson: string; audio: string | null } | { ok: false; error: RecordingPathError } {
  const json = sessionJsonPath(vaultRoot, userDataDir, talkSlug, sessionId)
  if (!json.ok) return json
  if (!withAudio) return { ok: true, sessionJson: json.path, audio: null }
  const audio = localRecordingPath(userDataDir, sessionId, 'webm')
  if (!audio.ok) return audio
  return { ok: true, sessionJson: json.path, audio: audio.path }
}

/** recording:delete-session — the vault session JSON (when a vault is set) and the local audio. */
export function deleteTargets(
  vaultRoot: string | null,
  userDataDir: string,
  talkSlug: unknown,
  sessionId: unknown
): { ok: true; sessionJson: string | null; audio: string } | { ok: false; error: RecordingPathError } {
  const error = nameError(talkSlug, sessionId)
  if (error) return refuse(error) as { ok: false; error: RecordingPathError }
  let sessionJson: string | null = null
  if (vaultRoot) {
    const json = vaultSessionPath(vaultRoot, talkSlug, sessionId)
    if (!json.ok) return json
    sessionJson = json.path
  }
  const audio = localRecordingPath(userDataDir, sessionId, 'webm')
  if (!audio.ok) return audio
  return { ok: true, sessionJson, audio: audio.path }
}

function resolvesInside(parent: string, child: string): boolean {
  try {
    const rel = relative(realpathSync(parent), realpathSync(child))
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  } catch {
    return false
  }
}

/**
 * transcript:get / transcript:run — `<sessionId>.transcript.json` beside the session's Run file in
 * the vault (same guarded talk folder), or beside the local audio when no vault is set. An existing
 * transcript file must itself resolve inside its folder (a link to a file elsewhere is refused).
 */
export function transcriptPath(vaultRoot: string | null, userDataDir: string, talkSlug: unknown, sessionId: unknown): RecordingPath {
  const error = nameError(talkSlug, sessionId)
  if (error) return refuse(error)
  let folder: string
  if (vaultRoot) {
    const run = vaultSessionPath(vaultRoot, talkSlug, sessionId)
    if (!run.ok) return run
    folder = dirname(run.path)
  } else {
    const local = localRecordingPath(userDataDir, sessionId, 'json')
    if (!local.ok) return local
    folder = dirname(local.path)
  }
  const path = join(folder, `${sessionId as string}.transcript.json`)
  if (dirname(path) !== folder) return refuse('unsafe-path')
  if (lexists(path) && !resolvesInside(folder, path)) return refuse('unsafe-path')
  return { ok: true, path }
}

async function sessionFilesIn(vaultRoot: string, dir: string): Promise<string[]> {
  const out: string[] = []
  for (const f of await readdir(dir)) {
    if (!f.endsWith('.json') || f === 'manifest.json') continue
    const file = join(dir, f)
    // A session file that is a link resolving outside the vault is skipped, never read.
    if (pathStaysInside(vaultRoot, file)) out.push(file)
  }
  return out
}

/**
 * The session JSON files recording:list-sessions (one talk) or recording:list-all-sessions (every
 * talk) may read: only folders and files whose real path is inside the vault. An unsafe talk slug
 * lists nothing; a missing talk folder throws (the handler turns that into []).
 */
export async function listSessionJsonFiles(vaultRoot: string, talkSlug?: unknown): Promise<string[]> {
  if (talkSlug !== undefined) {
    const folder = talkSessionsFolder(vaultRoot, talkSlug)
    if (!folder.ok) return []
    return sessionFilesIn(vaultRoot, folder.path)
  }
  const root = join(vaultRoot, '_PRESENTATIONS')
  let slugDirs: string[]
  try { slugDirs = await readdir(root) } catch { return [] }
  const out: string[] = []
  for (const slugDir of slugDirs) {
    const dir = join(root, slugDir)
    if (!pathStaysInside(vaultRoot, dir)) continue
    try {
      if (!(await stat(dir)).isDirectory()) continue
      out.push(...await sessionFilesIn(vaultRoot, dir))
    } catch {
      continue
    }
  }
  return out
}

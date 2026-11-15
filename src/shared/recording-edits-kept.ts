// Two Macs, one edits file (0.45, second Mac). Pure: the store (main) and the recording editor share it.
//
// Who saved it. Every save writes `savedBy` (this Mac's name, the same name a Run's `recordedOn` uses;
// the app version; the time) and `earlier`, the short content hashes of the versions this one grew from,
// newest first. Neither is part of the edit list itself, and no version bump is needed for them: release
// 0.44.5 reads a version 5 file and ignores both (proved in scripts/test-recording-edits-compat.mjs), and
// 0.44.0 refuses any version 5 file as "made by a newer version", as it always has. A save by 0.44.5 drops
// them; the next save here starts them again.
//
// Kept copies. Every copy the app sets aside sits beside the edits file in the vault and is never deleted
// by the app: `<runId>.edits.kept-<time>-<uuid>.json` (Start new edits; a restore keeps the edits it
// replaces), `<runId>.edits.before-<time>-<uuid>.json` (what was there when a save installed new edits,
// when it was not this Mac's own last save), `<runId>.edits.changed-<time>-<uuid>.json` (the edits this Mac last had, kept when
// something else replaced them), `<runId>.edits.unfinished-<time>-<uuid>.json` (a save that did not finish),
// `<runId>.edits.version-<n>-<uuid>.json` (what an older release last wrote, from earlier 0.45 builds), and
// the copies a sync service makes (Dropbox, iCloud Drive, OneDrive, Google Drive, Syncthing). The UUID keeps two Macs that make a copy in the same millisecond, offline, from
// taking the same name, so a sync never puts one over the other. Names without it (`kept-<time>.json`,
// `version-<n>.json`) are what earlier releases wrote, and are listed the same. A copy holding Git conflict
// markers is listed as its two versions. An ordinary save leaves no copy: the save it replaces, this Mac's own,
// is kept in this Mac's app data as its previous save (one, local), listed as "Previous save on this Mac".

export type SavedBy = { mac: string; app: string; at: string }
/** How many earlier versions an edits file names (`earlier`). */
export const EARLIER_LIMIT = 200
const NAME_MAX = 120

const clean = (v: unknown, max = NAME_MAX): string | null => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null)

/** The `savedBy` of a parsed edits file, or null (older files, or a field that is not one). */
export function savedByOf(raw: unknown): SavedBy | null {
  const s = raw && typeof raw === 'object' ? (raw as { savedBy?: unknown }).savedBy : undefined
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null
  const mac = clean((s as SavedBy).mac), app = clean((s as SavedBy).app, 40), at = clean((s as SavedBy).at, 40)
  return mac && app && at && Number.isFinite(Date.parse(at)) ? { mac, app, at } : null
}
/** The `earlier` hashes of a parsed edits file (empty when absent or malformed). */
export function earlierOf(raw: unknown): string[] {
  const e = raw && typeof raw === 'object' ? (raw as { earlier?: unknown }).earlier : undefined
  return Array.isArray(e) ? e.filter((h): h is string => typeof h === 'string' && /^[0-9a-f]{16}$/.test(h)).slice(0, EARLIER_LIMIT) : []
}

/** "Edited on Dominik’s MacBook Air with TalkWeaver 0.45.0" (no full stop). */
export function editedOn(by: SavedBy): string {
  return `Edited on ${by.mac} with TalkWeaver ${by.app}`
}

/** "14 Nov, 10:32" in the Mac's own time; today: "today, 10:32". */
export function whenWords(at: string | null | undefined, now = new Date()): string {
  const d = at ? new Date(at) : null
  if (!d || isNaN(d.getTime())) return 'at a time not recorded'
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (d.toDateString() === now.toDateString()) return `today, ${hm}`
  const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) })
  return `${day}, ${hm}`
}

export type KeptReason = 'set-aside' | 'changed' | 'before-save' | 'unfinished' | 'older-format' | 'sync-copy' | 'git-side' | 'previous-save'
/** One kept copy, as the editor lists it. `id` names it to main (a file name, `#1`/`#2` for a Git side). */
export type KeptEdits = {
  id: string
  file: string
  reason: KeptReason
  /** When its edits were saved (its `savedBy`), else when the copy was made (the file's time). */
  at: string | null
  by: SavedBy | null
  /** The format version it is in, when it can be told. */
  version: number | null
  /** `ok`: opens and can be restored; `unknown`: its details could not be read from its first bytes (read when opened); otherwise why not. */
  state: 'ok' | 'newer' | 'other-recording' | 'unreadable' | 'unknown'
  /** "3 cuts, 1 slide left out" for one that opens. */
  summary: string | null
  /** The sync service that made it (sync-copy), or which version of a Git conflict it is (git-side). */
  service?: string
  side?: 1 | 2
  /** Other copies holding exactly the same bytes, shown as this one row (their ids). */
  same?: string[]
  /** This Mac's previous save, kept in its app data, not a file in the vault (`file` is empty). */
  local?: boolean
}

export function keptReasonWords(k: Pick<KeptEdits, 'reason' | 'version' | 'service' | 'side'>): string {
  switch (k.reason) {
    case 'set-aside': return 'Set aside when new edits were started, or when other edits were restored'
    case 'changed': return 'The edits this Mac last had, kept when something else replaced them'
    case 'before-save': return 'The edits in place before a save replaced them, kept as a copy'
    case 'previous-save': return 'Previous save on this Mac (kept on this Mac only, not beside the recording)'
    case 'unfinished': return 'From a save that did not finish'
    case 'older-format': return `What an older TalkWeaver saved (format ${k.version ?? '?'}), kept when this version first saved`
    case 'sync-copy': return `A copy made by ${k.service ?? 'a sync service'}`
    case 'git-side': return `One of two versions in a Git conflict (version ${k.side ?? '?'} of 2)`
  }
}
export function keptStateWords(k: Pick<KeptEdits, 'state' | 'by'>): string | null {
  switch (k.state) {
    case 'ok': return null
    case 'newer': return `Made by a newer version of TalkWeaver${k.by ? ` (${editedOn(k.by)})` : ''}. Open it there.`
    case 'other-recording': return 'Made for a different recording, so it can be opened but not restored here.'
    case 'unreadable': return 'This copy could not be read.'
    case 'unknown': return 'Details are read when it is opened.'
  }
}
/** "Identical to 2 other kept copies" (rows grouped by identical bytes). */
export function keptSameWords(n: number): string | null {
  return n > 0 ? `Identical to ${n} other kept ${n === 1 ? 'copy' : 'copies'}` : null
}
/** "Kept edits from 14 Nov, 10:32 · Dominik’s MacBook Air · TalkWeaver 0.45.0" parts after "from". */
export function keptByline(k: Pick<KeptEdits, 'at' | 'by'>, now = new Date()): string {
  return [whenWords(k.at, now), k.by ? k.by.mac : 'Mac not recorded', k.by ? `TalkWeaver ${k.by.app}` : 'an earlier TalkWeaver'].join(' · ')
}

/** "3 cuts, 1 slide left out, 2 slide starts moved", or "No edits". */
export function editsSummary(e: { cuts: readonly unknown[]; leftOut: readonly unknown[]; boundaries: readonly unknown[]; faces?: { slides: readonly unknown[] }; takes?: readonly unknown[] }): string {
  const n = (count: number, one: string, many: string): string | null => (count ? `${count} ${count === 1 ? one : many}` : null)
  const parts = [n(e.cuts.length, 'cut', 'cuts'), n(e.leftOut.length, 'slide left out', 'slides left out'), n(e.boundaries.length, 'slide start moved', 'slide starts moved'),
    n(e.faces?.slides.length ?? 0, 'slide with its own face position', 'slides with their own face position'), n(e.takes?.length ?? 0, 'new take chosen', 'new takes chosen')].filter(Boolean)
  return parts.length ? parts.join(', ') : 'No edits'
}

/**
 * The two versions inside a text with Git conflict markers: lines outside conflict blocks go to both, the
 * lines of each side to its own, a diff3 base section to neither. Null when there is no complete block.
 */
export function gitConflictSides(text: string): [string, string] | null {
  const lines = text.split(/(?<=\n)/)
  const a: string[] = [], b: string[] = []
  let mode: 'out' | 'ours' | 'base' | 'theirs' = 'out', blocks = 0
  for (const line of lines) {
    if (mode === 'out' && line.startsWith('<<<<<<< ')) { mode = 'ours'; continue }
    if (mode === 'ours' && line.startsWith('||||||| ')) { mode = 'base'; continue }
    if ((mode === 'ours' || mode === 'base') && /^=======\r?\n?$/.test(line)) { mode = 'theirs'; continue }
    if (mode === 'theirs' && line.startsWith('>>>>>>> ')) { mode = 'out'; blocks++; continue }
    if (mode === 'out') { a.push(line); b.push(line) } else if (mode === 'ours') a.push(line)
    else if (mode === 'theirs') b.push(line)
  }
  return blocks > 0 && mode === 'out' ? [a.join(''), b.join('')] : null
}

/** What the editor says after main kept a version instead of losing it (EditsSnapshot.notice). */
export type EditsNotice =
  /** A save found the file changed since the editor read it (another Mac's sync, another window): that version is kept. */
  /** `older`: that version was saved by a TalkWeaver before 0.45, which does not record the Mac. */
  | { kind: 'changed'; copy: string; by: SavedBy | null; older?: boolean }
  /** On opening: the edits this Mac last saved were replaced since (a sync, another Mac); they are kept. `older` as above. */
  | { kind: 'replaced'; copy: string; mine: SavedBy | null; by: SavedBy | null; gone: boolean; older?: boolean }
  /** Restore: the kept copy is now the edits; the edits it replaced are kept as `copy`, or (`previous`) as this Mac's previous save. */
  | { kind: 'restored'; copy: string | null; from: string; previous?: boolean }
  /** Start new edits: the edits set aside are kept as `copy`. */
  | { kind: 'set-aside'; copy: string }
  /** A save did not finish: what it was saving is kept as `copy`; `restored`: the edits from before it are back in place. */
  | { kind: 'interrupted'; copy: string; restored: boolean }

export function noticeWords(n: EditsNotice, now = new Date()): string {
  switch (n.kind) {
    case 'changed': return n.by
      ? `These edits were also changed elsewhere while you had them open (${editedOn(n.by)}, ${whenWords(n.by.at, now)}). Your edits are saved, and that version is kept as a copy.`
      : n.older
        ? 'These edits were also saved by an earlier version of TalkWeaver while you had them open (it does not record which Mac). Your edits are saved, and that version is kept as a copy.'
        : 'These edits were also changed elsewhere while you had them open, in another window or on another Mac. Your edits are saved, and that version is kept as a copy.'
    case 'replaced': {
      const mine = n.mine ? `The edits you saved on this Mac (${whenWords(n.mine.at, now)})` : 'The edits you last saved on this Mac'
      if (n.gone) return `${mine} are no longer beside the recording. They are kept as a copy.`
      if (n.older && !n.by) return `${mine} were replaced by a version saved by an earlier version of TalkWeaver, which does not record which Mac it was on. Yours are kept as a copy.`
      return `${mine} were replaced by ${n.by ? `a version ${editedOn(n.by).replace(/^Edited/, 'edited')}` : 'a version from another Mac or an older TalkWeaver'}. Yours are kept as a copy.`
    }
    case 'restored': return n.copy ? `The kept edits from ${n.from} are now the edits. The edits they replaced are kept as a copy.`
      : n.previous ? `The kept edits from ${n.from} are now the edits. The edits they replaced are kept as the previous save on this Mac.` : `The kept edits from ${n.from} are now the edits.`
    case 'set-aside': return 'New edits started. The earlier edits are kept as a copy: open Kept edits to see them or restore them.'
    case 'interrupted': return `A save of these edits did not finish. What it was saving is kept as a copy: open Kept edits to see it or restore it.${n.restored ? ' The edits as they were before that save are back.' : ''}`
  }
}

/** The Start new edits dialog. `file`: the copy's file name. */
export const START_NEW_TITLE = 'Start new edits?'
export const startNewBody = (where: 'editor' | 'panel'): string =>
  `The saved edits are not deleted: they are kept as a copy beside the recording. ${where === 'editor'
    ? 'To see them again or restore them, choose Kept edits (the clock button at the top of this editor).'
    : 'To see them again or restore them, choose Kept edits here or in Edit video.'}`
export const KEPT_SHEET_INTRO = 'Earlier edits that TalkWeaver set aside rather than lose, newest first: another Mac’s or an older TalkWeaver’s version, a save that did not finish, edits set aside by Start new edits or a restore, and the previous save on this Mac. Opening one changes nothing. Restoring one makes it the edits, and keeps the edits it replaces.'
export const KEPT_SHEET_FOOT = 'Kept copies are files beside the recording in the vault, and TalkWeaver never deletes them. The previous save on this Mac is kept on this Mac only.'
export const VIEWING_WORDS = (byline: string): string => `Showing kept edits from ${byline}. Nothing can be changed here.`

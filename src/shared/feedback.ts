// Feedback rail (ticket 05): the pure pieces main, preload and renderer share — the feedback file's
// line format and its fold, the per-share summary, and the rail's view model. Plain erasable
// TypeScript: imported by Node tests under native type stripping.
//
// The feedback file `<talk>/feedback/<share-id>.jsonl` is append-only. Three line types:
//   {"v":1,"type":"item","item":{…the Worker's item…},"receivedAt":ms}   — one per itemId (dedupe)
//   {"v":1,"type":"status","itemId","status","at":ms,"edit"?}          — his Done / Dismiss / Accept / Undo
//     (`edit` on an accepted line: the splice Accept made, which Undo reverses — feedback-accept.ts)
//   {"v":1,"type":"synced","itemId","status","at":ms}                  — the Worker took that status
//   {"v":1,"type":"failed","itemId","status","code","at":ms}           — the Worker refused it for good
// A later status line overrides an earlier one. A status line with no later matching synced or
// failed line is still owed to the Worker and is re-sent when the owner socket reconnects.
//
// The file is the single source of truth for the owner socket's replay position (replayFrom): the
// highest item seq written, or — when an item line is torn — the seq before it, so the Worker
// sends the lost item again and the itemId dedupe absorbs the rest.

import {
  applyProposal, changedSince, findSlide, linesChangedSince, readOutlineSlides, SECTION_DELETE,
  ALREADY, type AcceptedEdit, type AcceptRecord, type OutlineSlides,
} from './feedback-accept.ts'

export type FeedbackKind = 'note' | 'replace' | 'delete' | 'insert'
export type FeedbackStatus = 'new' | 'accepted' | 'dismissed' | 'done'
/** The owner socket as the rail and status bar show it. `paused` draws "Sharing paused ·
 *  reconnecting"; `ended` (share stopped or retired, or the owner token refused) draws "Sharing ended". */
export type FeedbackConnection = 'connecting' | 'connected' | 'paused' | 'ended'

export const FEEDBACK_KINDS: readonly FeedbackKind[] = ['note', 'replace', 'delete', 'insert']
export const FEEDBACK_STATUSES: readonly FeedbackStatus[] = ['new', 'accepted', 'dismissed', 'done']

/** One item as the Worker sends it on `item.new` (worker/README.md § Shared talk routes). */
export interface WorkerFeedbackItem {
  itemId: string
  kind: FeedbackKind
  slideId?: string
  afterSlideId?: string
  baseRevision?: number
  text?: string
  reason?: string
  section?: string
  name?: string
  createdAt: number
  seq: number
  status: FeedbackStatus
}

/** An item as the mirror folds it from the file. */
export interface FeedbackItem extends WorkerFeedbackItem {
  /** When his latest status was set here (null: the status came from the Worker). */
  statusAt: number | null
  /** The last status the Worker confirmed for this item (the item line's own status first). */
  syncedStatus: FeedbackStatus
  /** A status the Worker refused for good (404/410): kept here, never re-sent. */
  syncFailed: FeedbackStatus | null
  /** Accepted here: the splice Accept made to the outline (Undo reverses it). */
  acceptedEdit: AcceptedEdit | null
  /** Accepted here with nothing changed: the slide already said what she wrote (no Undo). */
  acceptedAlready?: boolean
}

export interface FeedbackFold {
  /** In arrival order. */
  items: FeedbackItem[]
  /** Highest share-wide seq among mirrored items: the owner socket's `?since=`. */
  cursor: number
  /** Statuses set here that the Worker has not confirmed yet. */
  unsynced: Array<{ itemId: string; status: FeedbackStatus }>
  /** Where the owner socket's replay starts (`?since=`). */
  replayFrom: number
}

/** What the talk row, the toolbar button and the status bar need for one share. */
export interface FeedbackSummary {
  key: string
  shareId: string
  unread: number
  total: number
  connection: FeedbackConnection
}

/** An item as the rail receives it: plus the slide text at its base revision (kept by ticket 03). */
export interface FeedbackListItem extends FeedbackItem {
  /** replace/delete: the slide's text at baseRevision; insert: the after-slide's text. */
  baseText: string | null
  /** The slide's title at baseRevision (for a slide since removed from the outline). */
  baseTitle: string | null
  /** When the base revision was pushed (ISO), for "written against your 22:51 save". */
  baseAt?: string | null
}

export interface FeedbackList {
  key: string
  shareId: string
  /** The share link without the scheme, for "from drafts.handouts.fyi/k7m2". */
  link: string
  connection: FeedbackConnection
  items: FeedbackListItem[]
}

const MAX_ID = 200
const MAX_TEXT = 20_000

function str(value: unknown, max = MAX_TEXT): string | undefined {
  return typeof value === 'string' && value.length <= max ? value : undefined
}

/** A Worker item checked field by field; null when it is not one. */
export function parseWorkerItem(value: unknown): WorkerFeedbackItem | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const itemId = str(raw.itemId, MAX_ID)
  const kind = raw.kind as FeedbackKind
  const seq = raw.seq
  const createdAt = raw.createdAt
  if (!itemId || !FEEDBACK_KINDS.includes(kind)) return null
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return null
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null
  const status = FEEDBACK_STATUSES.includes(raw.status as FeedbackStatus) ? raw.status as FeedbackStatus : 'new'
  const item: WorkerFeedbackItem = { itemId, kind, createdAt, seq, status }
  const slideId = str(raw.slideId, MAX_ID)
  const afterSlideId = str(raw.afterSlideId, MAX_ID)
  if (slideId !== undefined) item.slideId = slideId
  if (afterSlideId !== undefined) item.afterSlideId = afterSlideId
  if (typeof raw.baseRevision === 'number' && Number.isInteger(raw.baseRevision)) item.baseRevision = raw.baseRevision
  for (const field of ['text', 'reason', 'section', 'name'] as const) {
    const v = str(raw[field])
    if (v !== undefined) item[field] = v
  }
  if (kind === 'insert' ? !item.afterSlideId : !item.slideId) return null
  return item
}

export function itemLine(item: WorkerFeedbackItem, receivedAt: number): string {
  return JSON.stringify({ v: 1, type: 'item', item, receivedAt })
}
export function statusLine(itemId: string, status: FeedbackStatus, at: number, edit?: AcceptRecord | null): string {
  const line: Record<string, unknown> = { v: 1, type: 'status', itemId, status, at }
  if (status === 'accepted' && edit === ALREADY) line.already = true
  else if (status === 'accepted' && edit) line.edit = edit
  return JSON.stringify(line)
}

/** An accept record from the renderer: a well-formed splice or ALREADY; null when it is neither. */
export function parseAcceptRecord(value: unknown): AcceptRecord | null {
  return value === ALREADY ? ALREADY : parseAcceptedEdit(value)
}

/** The largest outline splice an accepted line may record (characters on each side). */
export const MAX_EDIT_TEXT = 400_000

/** An accepted edit checked field by field; null when it is not one. */
export function parseAcceptedEdit(value: unknown): AcceptedEdit | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const int = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
  const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
  if (!int(raw.from) || !int(raw.line) || !text(raw.removed, MAX_EDIT_TEXT) || !text(raw.inserted, MAX_EDIT_TEXT)) return null
  if (!text(raw.before, 200) || !text(raw.after, 200)) return null
  return { from: raw.from, line: raw.line, removed: raw.removed, inserted: raw.inserted, before: raw.before, after: raw.after }
}
export function syncedLine(itemId: string, status: FeedbackStatus, at: number): string {
  return JSON.stringify({ v: 1, type: 'synced', itemId, status, at })
}
export function failedLine(itemId: string, status: FeedbackStatus, code: number, at: number): string {
  return JSON.stringify({ v: 1, type: 'failed', itemId, status, code, at })
}

/** How far back a torn item line may pull the replay: at most the last this-many items. */
export const TORN_REPLAY_WINDOW = 200

/** The file folded line by line, kept in memory by the mirror and updated on each append. */
export interface FeedbackIndex {
  items: FeedbackItem[]
  byId: Map<string, FeedbackItem>
  owed: Map<string, FeedbackStatus>
  cursor: number
  /** The first torn item line: how many items came before it (null: none torn). */
  tornAt: number | null
}

export function emptyFeedbackIndex(): FeedbackIndex {
  return { items: [], byId: new Map(), owed: new Map(), cursor: 0, tornAt: null }
}

/** Apply one line of the file. Returns false for a line that could not be read. */
export function applyFeedbackLine(index: FeedbackIndex, raw: string): boolean {
  const line = raw.trim()
  if (!line) return true
  let parsed: Record<string, unknown>
  try { parsed = JSON.parse(line) } catch {
    // A torn line (a crash or a full disk mid-append). If it was an item, the item it held has to
    // come again from the Worker: note where it was.
    if (index.tornAt === null && /"type"\s*:\s*"item"/.test(line)) index.tornAt = index.items.length
    return false
  }
  if (!parsed || typeof parsed !== 'object') return false
  if (parsed.type === 'item') {
    const item = parseWorkerItem(parsed.item)
    if (!item) return false
    index.cursor = Math.max(index.cursor, item.seq)
    if (index.byId.has(item.itemId)) return true
    const folded: FeedbackItem = { ...item, statusAt: null, syncedStatus: item.status, syncFailed: null, acceptedEdit: null, acceptedAlready: false }
    index.byId.set(item.itemId, folded)
    index.items.push(folded)
    return true
  }
  const itemId = typeof parsed.itemId === 'string' ? parsed.itemId : ''
  const status = parsed.status as FeedbackStatus
  const target = index.byId.get(itemId)
  if (!target || !FEEDBACK_STATUSES.includes(status)) return false
  const at = typeof parsed.at === 'number' && Number.isFinite(parsed.at) ? parsed.at : null
  if (parsed.type === 'status') {
    target.status = status
    target.statusAt = at
    target.syncFailed = null
    target.acceptedEdit = status === 'accepted' ? parseAcceptedEdit(parsed.edit) : null
    target.acceptedAlready = status === 'accepted' && parsed.already === true
    index.owed.set(itemId, status)
  } else if (parsed.type === 'synced') {
    target.syncedStatus = status
    if (index.owed.get(itemId) === status) index.owed.delete(itemId)
  } else if (parsed.type === 'failed') {
    target.syncFailed = status
    if (index.owed.get(itemId) === status) index.owed.delete(itemId)
  }
  return true
}

/** The replay position: the highest seq written; when an item line is torn, the seq of the item
 *  before it (0 at the start), but never further back than the last TORN_REPLAY_WINDOW items. */
export function replayFrom(index: FeedbackIndex): number {
  if (index.tornAt === null) return index.cursor
  const before = index.tornAt > 0 ? index.items[index.tornAt - 1].seq : 0
  const n = index.items.length
  const floor = n > TORN_REPLAY_WINDOW ? index.items[n - TORN_REPLAY_WINDOW - 1].seq : 0
  return Math.min(index.cursor, Math.max(before, floor))
}

export function foldView(index: FeedbackIndex): FeedbackFold {
  return {
    items: index.items,
    cursor: index.cursor,
    unsynced: [...index.owed].map(([itemId, status]) => ({ itemId, status })),
    replayFrom: replayFrom(index),
  }
}

/** Fold the file's text. Unparseable lines (a torn line after a crash) are skipped. */
export function foldFeedback(text: string): FeedbackFold {
  const index = emptyFeedbackIndex()
  for (const raw of String(text ?? '').split('\n')) applyFeedbackLine(index, raw)
  return foldView(index)
}

export function unreadCount(items: Pick<FeedbackItem, 'status'>[]): number {
  return items.filter((item) => item.status === 'new').length
}

// ── The rail's view model (LOCKED-feedback-rail-and-markers.html frames 1 and 3) ─────────────────

export type FeedbackFilter = 'all' | 'slide' | 'new'

export interface RailSlide {
  slideId: string
  title: string
  /** 1-based outline line of the slide's heading (null for synthesised slides). */
  line?: number | null
}

export interface FeedbackRailInput {
  list: FeedbackList | null
  /** The talk's compiled slides in order. */
  slides: RailSlide[]
  /** The outline text, for the block line ranges the hints quote. */
  outline?: string
  filter: FeedbackFilter
  /** The slide the editor is on ("Slide 3" in the scope bar). */
  activeSlideId: string | null
  now: number
  /** The rail was opened from a slide's marker (frame 2: "Opened from the marker on slide 3"). */
  fromMarker?: boolean
  /** The slide the "Slide N" scope shows: the marker's slide when opened from one, so the scope never
   *  waits on the editor's active slide; null or absent: the active slide. */
  scopeSlideId?: string | null
}

export interface RailAction { id: 'accept' | 'done' | 'dismiss' | 'compare' | 'undo'; label: string; disabled: boolean; title?: string; tone: 'plain' | 'quiet' }

/** Compare (frame 2): his slide now, her text, and the text she wrote against. */
export interface RailCompare {
  yoursLabel: string
  /** His lines now; `changed`: not in the base (he changed it since she wrote). */
  yours: Array<{ text: string; changed: boolean }>
  hersLabel: string
  /** Her lines (null for a deletion). */
  hers: string[] | null
  baseLabel: string
  /** The slide as she saw it (null when that revision is not kept on this Mac). */
  base: string[] | null
  /** "Using hers replaces all four of your current lines." */
  useHersNote: string
}

export interface RailRow {
  itemId: string
  kind: FeedbackKind
  kindLabel: string
  /** CSS modifier: note (muted), del (crimson), ins (blue), '' (oxford, a proposed edit). */
  kindClass: 'note' | 'del' | 'ins' | ''
  who: string
  when: string
  isNew: boolean
  handled: boolean
  /** "3  The rubric problem" — the slide the item is about (not for insert). */
  slideRef: { number: string; title: string } | null
  /** Insert: "after slide 3 · new section: …". */
  insertRef: { after: string | null; section: string | null } | null
  text: string | null
  reason: string | null
  diff: { lines: Array<{ op: 'del' | 'add'; text: string }>; more: number } | null
  preview: { kicker: string; title: string; bullets: string[]; paras: string[] } | null
  hint: string | null
  /** "Slide changed since this was written." — the row leads with Compare. */
  flag: string | null
  compare: RailCompare | null
  actions: RailAction[]
  stamp: { text: string; tone: 'accepted' | 'done' | 'dismissed' } | null
  /** Accepted here: Undo can put the outline back. */
  undo: boolean
  /** The slide the item is about (for insert: the named slide), for Open slide to merge. */
  slideId: string | null
}

export interface FeedbackRailView {
  countLabel: string
  unread: number
  paused: boolean
  ended: boolean
  endedNote: string
  /** "Newest first · from drafts.handouts.fyi/k7m2" (frame 1); empty while paused (frame 3). */
  sub: string
  pausedNote: string
  scope: Array<{ id: FeedbackFilter; label: string; on: boolean; disabled: boolean }>
  /** The slide filter's heading above its items ("3  The rubric problem"). */
  group: { number: string; title: string } | null
  rows: RailRow[]
  empty: string
}

export const ALREADY_NOTE = 'Already what the slide says'
export const CHANGED_SINCE = 'Slide changed since this was written.'
export const BASE_NOT_KEPT = 'The slide as she saw it is not kept on this Mac, so a change since cannot be ruled out.'
export const SLIDE_GONE = 'This slide is no longer in the talk.'
export const NOT_LOADED = 'The talk is still loading.'
export const PAUSED_LABEL = 'Sharing paused · reconnecting'
export const PAUSED_NOTE = 'Editing and saving carry on as normal. Her page keeps what she writes on her device and sends it when the link is back. Nothing is lost, only delayed.'
export const ENDED_LABEL = 'Sharing ended'
export const ENDED_NOTE = 'This link no longer takes comments. What arrived is kept here; share again for a new link.'

const KIND_LABEL: Record<FeedbackKind, string> = {
  note: 'Note', replace: 'Proposed edit', delete: 'Proposed deletion', insert: 'Proposed new slide',
}
const KIND_CLASS: Record<FeedbackKind, RailRow['kindClass']> = { note: 'note', replace: '', delete: 'del', insert: 'ins' }

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad2 = (n: number): string => String(n).padStart(2, '0')
function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}
function clock(d: Date): string { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}` }

/** The item's time in its row: "23:47" today, "Sun 23:47" this week, "12 Sep 23:47" before. */
export function railWhen(at: number, now: number): string {
  const d = new Date(at)
  const n = new Date(now)
  if (sameDay(d, n)) return clock(d)
  if (now - at < 6 * 24 * 3600 * 1000 && at <= now) return `${WEEKDAYS[d.getDay()]} ${clock(d)}`
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${clock(d)}`
}

/** The handled stamp's time: "08:14 today", else as railWhen. */
export function stampWhen(at: number, now: number): string {
  return sameDay(new Date(at), new Date(now)) ? `${clock(new Date(at))} today` : railWhen(at, now)
}

/** Line diff (LCS), changes grouped as deletions then additions; unchanged lines dropped. */
export function changedLines(before: string, after: string): Array<{ op: 'del' | 'add'; text: string }> {
  const split = (value: string): string[] => {
    const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/\s+$/, ''))
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    return lines
  }
  const a = split(before)
  const b = split(after)
  if (a.length * b.length > 250_000) {
    return [...a.map((text) => ({ op: 'del' as const, text })), ...b.map((text) => ({ op: 'add' as const, text }))]
  }
  const cols = b.length + 1
  const table = new Uint32Array((a.length + 1) * cols)
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = a[i] === b[j] ? table[(i + 1) * cols + j + 1] + 1 : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1])
    }
  }
  const out: Array<{ op: 'del' | 'add'; text: string }> = []
  let dels: Array<{ op: 'del'; text: string }> = []
  let adds: Array<{ op: 'add'; text: string }> = []
  const flush = (): void => { out.push(...dels, ...adds); dels = []; adds = [] }
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { flush(); i += 1; j += 1 }
    else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) { dels.push({ op: 'del', text: a[i] }); i += 1 }
    else { adds.push({ op: 'add', text: b[j] }); j += 1 }
  }
  while (i < a.length) { dels.push({ op: 'del', text: a[i] }); i += 1 }
  while (j < b.length) { adds.push({ op: 'add', text: b[j] }); j += 1 }
  flush()
  return out.filter((line) => line.text.trim() !== '')
}

/** The two-line diff the rail draws: the first removed and the first added line, then a count.
 *  A bullet's own "- " is dropped for display: the diff's − and + stand in its place (as drawn). */
export function twoLineDiff(before: string, after: string): { lines: Array<{ op: 'del' | 'add'; text: string }>; more: number } {
  const all = changedLines(before, after)
  const firstDel = all.find((line) => line.op === 'del')
  const firstAdd = all.find((line) => line.op === 'add')
  let shown = [firstDel, firstAdd].filter(Boolean) as Array<{ op: 'del' | 'add'; text: string }>
  if (shown.length < 2) shown = all.slice(0, 2)
  return { lines: shown.map((line) => ({ op: line.op, text: line.text.replace(/^\s*[-*+]\s+/, '') })), more: all.length - shown.length }
}

const stripMarkup = (text: string): string => text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1$2')

/** Her proposed new slide as the rail previews it (the colleague page's approximation: the first
 *  heading is the title, list lines bullets, other lines paragraphs). The compiler decides on Accept. */
export function proposedSlidePreview(text: string, section: string | null, slideNumber: number | null): RailRow['preview'] {
  let title = ''
  const bullets: string[] = []
  const paras: string[] = []
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    if (!line || /^\{[^}]*\}$/.test(line) || /^:::/.test(line)) continue
    const heading = line.match(/^#{1,6}\s+(.*)$/)
    if (heading && !title) { title = heading[1].replace(/\s*\{[^}]*\}\s*$/, ''); continue }
    const bullet = raw.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/)
    if (bullet) bullets.push(stripMarkup(bullet[1]))
    else paras.push(stripMarkup(heading ? heading[1] : line))
  }
  const number = slideNumber ? pad2(slideNumber) : ''
  const kicker = [number, section || ''].filter(Boolean).join(' · ')
  return { kicker, title: title || 'New slide', bullets: bullets.slice(0, 6), paras: paras.slice(0, 3) }
}

/** 1-based line range of a slide's block: its heading to the line before the next heading, less
 *  trailing blank lines. */
export function slideBlockRange(outline: string, headingLine: number): { start: number; end: number } | null {
  const lines = String(outline ?? '').replace(/\r\n?/g, '\n').split('\n')
  if (!Number.isInteger(headingLine) || headingLine < 1 || headingLine > lines.length) return null
  let end = headingLine
  let fence = false
  for (let i = headingLine; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (!fence && /^#{1,6}\s/.test(line)) break
    end = i + 1
  }
  while (end > headingLine && lines[end - 1].trim() === '') end -= 1
  return { start: headingLine, end }
}

function isHandled(status: FeedbackStatus): boolean { return status !== 'new' }

function itemMatches(item: FeedbackListItem, filter: FeedbackFilter, activeSlideId: string | null): boolean {
  if (filter === 'new') return item.status === 'new'
  if (filter === 'slide') return item.kind !== 'insert' && !!activeSlideId && item.slideId === activeSlideId
  return true
}

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const inWords = (n: number): string => NUMBER_WORDS[n] ?? String(n)

const splitLines = (text: string): string[] => String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[ \t]+$/, ''))

/** Compare's three texts. The heading (and a Trigger line) are left out when hers and yours share
 *  them, so the boxes hold what differs, as drawn. */
function compareOf(item: FeedbackListItem, yoursText: string, now: number): RailCompare {
  let yours = splitLines(yoursText)
  let hers = item.kind === 'replace' ? splitLines(item.text ?? '') : null
  let base = item.baseText != null ? splitLines(item.baseText) : null
  const drop = (n: number): void => {
    yours = yours.slice(n)
    if (hers) hers = hers.slice(n)
    if (base) base = base.slice(n)
  }
  const same = (i: number): boolean => (hers ? hers[i] === yours[i] : true) && (base ? base[i] === yours[i] : true)
  if (yours.length && same(0) && /^#{2,6}\s/.test(yours[0])) {
    drop(1)
    if (yours.length && same(0) && /^\s*\{[^}]*\}(\s*\{[^}]*\})*\s*$/.test(yours[0])) drop(1)
    while (yours.length && yours[0] === '' && same(0)) drop(1)
  }
  const marks = base ? linesChangedSince(base.join('\n'), yours.join('\n')) : yours.map(() => false)
  const at = item.baseAt ? Date.parse(item.baseAt) : NaN
  const save = Number.isFinite(at) ? `your ${railWhen(at, now)} save` : 'an earlier save'
  let useHersNote: string
  if (!hers) {
    useHersNote = 'Using hers deletes this slide, with what you changed since.'
  } else {
    const mine = yours.filter((l) => l.trim() !== '')
    const kept = new Set(hers.filter((l) => l.trim() !== ''))
    const replaced = mine.filter((l) => !kept.has(l)).length
    useHersNote = replaced === 0 ? 'Using hers keeps all your current lines and adds hers.'
      : replaced === mine.length ? (mine.length === 1 ? 'Using hers replaces your one current line.' : `Using hers replaces all ${inWords(mine.length)} of your current lines.`)
        : `Using hers replaces ${inWords(replaced)} of your ${inWords(mine.length)} current lines.`
    useHersNote += ' Your notes and comments stay.'
  }
  return {
    yoursLabel: 'Yours now',
    yours: yours.map((text, i) => ({ text, changed: marks[i] })),
    hersLabel: `Hers · written against ${save}`,
    hers,
    baseLabel: `As she saw it · ${save}`,
    base,
    useHersNote,
  }
}

export function feedbackRailView(input: FeedbackRailInput): FeedbackRailView {
  const list = input.list
  const items = list?.items ?? []
  const index = new Map(input.slides.map((slide, i) => [slide.slideId, i]))
  const unread = unreadCount(items)
  const paused = list?.connection === 'paused'
  const ended = list?.connection === 'ended'
  const scopeId = input.scopeSlideId ?? input.activeSlideId
  const activeIndex = scopeId != null ? index.get(scopeId) : undefined
  const filter: FeedbackFilter = input.filter === 'slide' && activeIndex === undefined ? 'all' : input.filter
  // The outline as the compiler reads it, once: where each slide is and its text now.
  let read: OutlineSlides | null = null
  if (input.outline) { try { read = readOutlineSlides(input.outline) } catch { read = null } }
  const lineOf = (slideId: string | undefined): number | null => {
    const i = slideId !== undefined ? index.get(slideId) : undefined
    return i === undefined ? null : input.slides[i].line ?? null
  }

  const blockOf = (slideId: string | undefined): { start: number; end: number } | null => {
    if (!slideId || !input.outline) return null
    const line = lineOf(slideId)
    return line ? slideBlockRange(input.outline, line) : null
  }
  /** The slide number a block inserted after 1-based line `afterLine` gets. */
  const numberAfterLine = (afterLine: number): number => {
    const k = input.slides.findIndex((slide) => slide.line != null && slide.line > afterLine)
    if (k >= 0) return k + 1
    let last = -1
    input.slides.forEach((slide, i) => { if (slide.line != null) last = i })
    return last + 2
  }

  const rows: RailRow[] = [...items]
    .filter((item) => itemMatches(item, filter, scopeId))
    .sort((a, b) => (b.createdAt - a.createdAt) || (b.seq - a.seq))
    .map((item) => {
      const handled = isHandled(item.status)
      const slideIndex = item.slideId !== undefined ? index.get(item.slideId) : undefined
      const row: RailRow = {
        itemId: item.itemId,
        kind: item.kind,
        kindLabel: KIND_LABEL[item.kind],
        kindClass: KIND_CLASS[item.kind],
        who: item.name?.trim() || 'Colleague',
        when: railWhen(item.createdAt, input.now),
        isNew: item.status === 'new',
        handled,
        slideRef: null,
        insertRef: null,
        text: null,
        reason: null,
        diff: null,
        preview: null,
        hint: null,
        flag: null,
        compare: null,
        actions: [],
        stamp: null,
        undo: false,
        slideId: (item.kind === 'insert' ? item.afterSlideId : item.slideId) ?? null,
      }
      if (item.kind !== 'insert' && filter !== 'slide') {
        row.slideRef = {
          number: slideIndex !== undefined ? String(slideIndex + 1) : '—',
          title: slideIndex !== undefined ? input.slides[slideIndex].title : (item.baseTitle || 'A slide no longer in the talk'),
        }
      }
      // Can Accept apply it to the outline as it stands? (The dry run the hints quote.)
      let acceptBlocked: string | null = null
      const base = { text: item.baseText, line: lineOf(item.kind === 'insert' ? item.afterSlideId : item.slideId) }
      if (item.kind !== 'note' && !handled) {
        if (!read) acceptBlocked = NOT_LOADED
        else if (item.kind !== 'insert' || item.afterSlideId !== 'start') {
          const target = findSlide(read, item.kind === 'insert' ? item.afterSlideId : item.slideId, base.line)
          if (!target) acceptBlocked = SLIDE_GONE
          else if (item.kind === 'replace' || item.kind === 'delete') {
            // The dry run: a proposal Accept would refuse (a section's heading, markup left open, a
            // changed heading level) says why here, before he tries.
            const dry = applyProposal(input.outline!, item, base)
            if (!dry.ok) acceptBlocked = dry.error
            if (item.kind === 'delete' && !dry.ok && dry.error === SECTION_DELETE) row.hint = SECTION_DELETE
            else if (item.kind === 'delete' && dry.ok) {
              let last = target.blockEnd
              while (last > target.start + 1 && !read.lines[last - 1].trim()) last -= 1
              row.hint = `Accept deletes this slide's block, lines ${target.line}–${last} of the outline.`
            }
            const since = changedSince(read, item, base)
            if (since !== false && !acceptBlocked) {
              row.flag = since === null ? BASE_NOT_KEPT : CHANGED_SINCE
              row.compare = compareOf(item, target.text, input.now)
            }
          }
        }
      }
      if (item.kind === 'note') row.text = item.text ?? ''
      if (item.kind === 'delete') {
        row.reason = item.reason?.trim() || null
        if (!read && !handled) {
          const block = blockOf(item.slideId)
          if (block) row.hint = `Accept deletes this slide's block, lines ${block.start}–${block.end} of the outline.`
        }
      }
      if (item.kind === 'replace') row.diff = twoLineDiff(item.baseText ?? '', item.text ?? '')
      if (item.kind === 'insert') {
        const atStart = item.afterSlideId === 'start'
        const afterIndex = atStart ? -1 : index.get(item.afterSlideId ?? '')
        const section = item.section?.trim() || null
        row.insertRef = { after: atStart ? null : afterIndex !== undefined ? String(afterIndex + 1) : '—', section }
        let newNumber = afterIndex !== undefined ? afterIndex + 2 : null
        let where: string | null = atStart ? 'at the start of the talk' : null
        if (!handled && !acceptBlocked && input.outline) {
          const dry = applyProposal(input.outline, item, base)
          if (dry.ok && dry.afterLine != null && !atStart) {
            where = `after line ${dry.afterLine}`
            newNumber = numberAfterLine(dry.afterLine)
          } else if (!dry.ok) {
            acceptBlocked = dry.error
          }
        }
        row.preview = proposedSlidePreview(item.text ?? '', section, newNumber)
        if (!handled && newNumber && !acceptBlocked) {
          const what = section ? 'the section and this slide' : 'this slide'
          row.hint = `Accept adds ${what} ${where ?? `after slide ${afterIndex! + 1}`}, as slide ${newNumber}; the slides after it renumber.`
        }
      }
      if (handled) {
        const tone = item.status === 'accepted' ? 'accepted' : item.status === 'done' ? 'done' : 'dismissed'
        const verb = tone === 'accepted' ? 'Accepted' : tone === 'done' ? 'Done' : 'Dismissed'
        let text = item.statusAt != null ? `${verb} ${stampWhen(item.statusAt, input.now)}` : verb
        if (tone === 'accepted' && item.acceptedAlready) {
          text += ` · ${ALREADY_NOTE}`
        } else if (tone === 'accepted' && item.acceptedEdit) {
          text += item.kind === 'delete' ? ` · removed from the outline at line ${item.acceptedEdit.line}` : ` · in the outline, line ${item.acceptedEdit.line}`
          row.undo = true
          row.actions = [{ id: 'undo', label: 'Undo', disabled: false, tone: 'quiet' }]
        }
        row.stamp = { text, tone }
      } else if (item.kind === 'note') {
        row.actions = [
          { id: 'done', label: 'Done', disabled: false, tone: 'plain' },
          { id: 'dismiss', label: 'Dismiss', disabled: false, tone: 'quiet' },
        ]
      } else {
        row.actions = [
          ...(row.compare ? [{ id: 'compare' as const, label: 'Compare', disabled: false, tone: 'plain' as const }] : []),
          { id: 'accept', label: 'Accept', disabled: acceptBlocked !== null, ...(acceptBlocked ? { title: acceptBlocked } : {}), tone: 'plain' },
          { id: 'dismiss', label: 'Dismiss', disabled: false, tone: 'quiet' },
        ]
      }
      return row
    })

  const activeNumber = activeIndex !== undefined ? activeIndex + 1 : null
  const onSlide = filter === 'slide' && activeIndex !== undefined
  const slideUnread = onSlide ? items.filter((item) => item.status === 'new' && item.kind !== 'insert' && item.slideId === scopeId).length : 0
  const elsewhere = unread - slideUnread
  let sub = paused || !list ? '' : `Newest first · from ${list.link}`
  if (onSlide && input.fromMarker && !paused) {
    sub = `Opened from the marker on slide ${activeNumber}${elsewhere > 0 ? ` · ${elsewhere} more new elsewhere` : ''}`
  }
  return {
    countLabel: onSlide ? `Slide ${activeNumber} · ${slideUnread} new` : `${unread} new`,
    unread,
    paused,
    ended,
    endedNote: ended ? ENDED_NOTE : '',
    sub,
    pausedNote: paused ? PAUSED_NOTE : '',
    scope: [
      { id: 'all', label: 'All slides', on: filter === 'all', disabled: false },
      { id: 'slide', label: activeNumber ? `Slide ${activeNumber}` : 'This slide', on: filter === 'slide', disabled: activeNumber === null },
      { id: 'new', label: 'New only', on: filter === 'new', disabled: false },
    ],
    group: onSlide && rows.length ? { number: String(activeNumber), title: input.slides[activeIndex!].title } : null,
    rows,
    empty: rows.length ? '' : !items.length
      ? 'Nothing yet. What she sends from the shared page arrives here.'
      : filter === 'new' ? 'Nothing new.' : 'Nothing on this slide.',
  }
}

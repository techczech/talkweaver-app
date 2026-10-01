// A Run's read-only share link (ADR-0032 point 7; feedback-boards ticket 06, drawings R6 and R7).
//
// The app pushes what the link shows — the Run's boards and poll results, never a hidden card, a
// name or anything that marks a participant — and the Worker serves it as one plain page. The
// Worker checks every push against a closed schema: only the fields below are read, a card or
// answer that carries a `hidden` or `name` field is refused outright, and all text is escaped when
// the page is written. The link lives until its expiry (7 or 30 days) or until it is stopped
// ("until I stop it"); expired and stopped links answer 410 and their content is deleted.
// Pure: no Workers runtime, so the rules are tested directly.
import { isShareId, SHARE_ID_SOURCE } from './share-id.ts'

export const DAY_MS = 24 * 60 * 60 * 1_000

export const RUN_SHARE_LIMITS = {
  /** A push body, read by the entry Worker before the object sees it. */
  pushBytes: 1024 * 1024,
  /** A close request carries no body worth reading. */
  closeBytes: 1024,
  /** The longest a link may be set to live; "until I stop it" is null. */
  maxLifetimeMs: 31 * DAY_MS,
  titleChars: 300,
  textChars: 1_000,
  labelChars: 300,
  boards: 20,
  columns: 10,
  entriesPerColumn: 1_000,
  polls: 50,
  pollRows: 50,
  scaleLabels: 12,
  responses: 1_000,
} as const

export interface RunShareCard {
  text: string
  /** A group's number. */
  n?: number
  /** A group's visible cards: the "×3". */
  count?: number
}

export interface RunShareColumn {
  label: string
  /** Visible cards in the column, grouped or not. */
  count: number
  entries: RunShareCard[]
}

export interface RunShareBoard {
  question: string
  cardCount: number
  /** `open`: the board still takes cards on the join link; `final`: it has closed. */
  state: 'final' | 'open'
  /** Display date the board closed or will close, as the app words it. */
  when?: string
  columns: RunShareColumn[]
}

export type RunSharePoll =
  | { kind: 'bars'; question: string; people: number; rows: Array<{ label: string; count: number }> }
  | { kind: 'scale'; question: string; people: number; labels: string[]; rows: Array<{ label: string; counts: number[] }> }
  | { kind: 'text'; question: string; people: number; responses: string[] }

export interface RunSharePush {
  /** When the link stops working (ms), or null for "until I stop it". */
  expiresAt: number | null
  title: string
  /** "Mon 28 Sep 2026 · ITSS Briefing, Oxford". */
  subtitle?: string
  boards: RunShareBoard[]
  polls: RunSharePoll[]
}

export interface StoredRunShare {
  shareId: string
  createdAt: number
  status: 'open' | 'closed'
  closedReason?: 'stopped' | 'expired'
  /** Null: until stopped. Set by the first push; before it the link says "not shared yet". */
  expiresAt: number | null
  pushedAt: number | null
}

type Result<T> = { value: T } | { error: { code: string; message: string } }
const fail = (code: string, message: string): { error: { code: string; message: string } } => ({ error: { code, message } })

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
function text(value: unknown, max: number, required = true): string | null {
  if (value === undefined && !required) return ''
  if (typeof value !== 'string' || value.length > max) return null
  const trimmed = value.trim()
  return trimmed || !required ? trimmed : null
}
function count(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}
/** A field that would name or hide someone: never allowed anywhere in a push. */
function marksAPerson(value: Record<string, unknown>): boolean {
  return 'hidden' in value || 'name' in value || 'participant' in value
}

function parseCard(value: unknown): RunShareCard | null {
  if (!record(value) || marksAPerson(value)) return null
  const body = text(value.text, RUN_SHARE_LIMITS.textChars)
  if (body === null) return null
  if (value.n !== undefined && !(count(value.n) && Number(value.n) >= 1)) return null
  if (value.count !== undefined && !(count(value.count) && Number(value.count) >= 1)) return null
  return { text: body, ...(value.n !== undefined ? { n: Number(value.n) } : {}), ...(value.count !== undefined ? { count: Number(value.count) } : {}) }
}

function parseBoard(value: unknown): RunShareBoard | null {
  if (!record(value) || marksAPerson(value)) return null
  const question = text(value.question, RUN_SHARE_LIMITS.textChars, false)
  const when = text(value.when, RUN_SHARE_LIMITS.labelChars, false)
  if (question === null || when === null || !count(value.cardCount) || (value.state !== 'final' && value.state !== 'open')) return null
  if (!Array.isArray(value.columns) || value.columns.length < 1 || value.columns.length > RUN_SHARE_LIMITS.columns) return null
  const columns: RunShareColumn[] = []
  for (const column of value.columns) {
    if (!record(column) || marksAPerson(column) || !count(column.count) || !Array.isArray(column.entries)
      || column.entries.length > RUN_SHARE_LIMITS.entriesPerColumn) return null
    const label = text(column.label, RUN_SHARE_LIMITS.labelChars)
    if (label === null) return null
    const entries = column.entries.map(parseCard)
    if (entries.some((entry) => !entry)) return null
    columns.push({ label, count: Number(column.count), entries: entries as RunShareCard[] })
  }
  return { question, cardCount: Number(value.cardCount), state: value.state, ...(when ? { when } : {}), columns }
}

function parsePoll(value: unknown): RunSharePoll | null {
  if (!record(value) || marksAPerson(value) || !count(value.people)) return null
  const question = text(value.question, RUN_SHARE_LIMITS.textChars, false)
  if (question === null) return null
  const people = Number(value.people)
  if (value.kind === 'bars') {
    if (!Array.isArray(value.rows) || value.rows.length > RUN_SHARE_LIMITS.pollRows) return null
    const rows = value.rows.map((row) => {
      if (!record(row) || marksAPerson(row) || !count(row.count)) return null
      const label = text(row.label, RUN_SHARE_LIMITS.labelChars)
      return label === null ? null : { label, count: Number(row.count) }
    })
    return rows.some((row) => !row) ? null : { kind: 'bars', question, people, rows: rows as Array<{ label: string; count: number }> }
  }
  if (value.kind === 'scale') {
    if (!Array.isArray(value.labels) || value.labels.length < 1 || value.labels.length > RUN_SHARE_LIMITS.scaleLabels
      || !Array.isArray(value.rows) || value.rows.length > RUN_SHARE_LIMITS.pollRows) return null
    const labels = value.labels.map((label) => text(label, RUN_SHARE_LIMITS.labelChars))
    if (labels.some((label) => label === null)) return null
    const rows = value.rows.map((row) => {
      if (!record(row) || marksAPerson(row) || !Array.isArray(row.counts) || row.counts.length !== labels.length || !row.counts.every(count)) return null
      const label = text(row.label, RUN_SHARE_LIMITS.labelChars)
      return label === null ? null : { label, counts: (row.counts as number[]).map(Number) }
    })
    return rows.some((row) => !row) ? null
      : { kind: 'scale', question, people, labels: labels as string[], rows: rows as Array<{ label: string; counts: number[] }> }
  }
  if (value.kind === 'text') {
    if (!Array.isArray(value.responses) || value.responses.length > RUN_SHARE_LIMITS.responses) return null
    const responses = value.responses.map((response) => text(response, RUN_SHARE_LIMITS.textChars))
    return responses.some((response) => response === null) ? null : { kind: 'text', question, people, responses: responses as string[] }
  }
  return null
}

/**
 * What the owner pushed, rebuilt from the allowed fields only. `now` bounds the expiry: null (until
 * stopped) or a time in the next 31 days.
 */
export function parseRunSharePush(value: unknown, now: number): Result<RunSharePush> {
  if (!record(value)) return fail('invalid_push', 'The push must be an object.')
  const expiresAt = value.expiresAt
  if (expiresAt !== null && !(Number.isSafeInteger(expiresAt) && Number(expiresAt) > now && Number(expiresAt) <= now + RUN_SHARE_LIMITS.maxLifetimeMs)) {
    return fail('invalid_expiry', 'expiresAt must be null or a time within the next 31 days.')
  }
  const title = text(value.title, RUN_SHARE_LIMITS.titleChars)
  const subtitle = text(value.subtitle, RUN_SHARE_LIMITS.titleChars, false)
  if (title === null || subtitle === null) return fail('invalid_title', 'A title of at most 300 characters is required.')
  if (!Array.isArray(value.boards) || value.boards.length > RUN_SHARE_LIMITS.boards) return fail('invalid_boards', 'boards must be a list.')
  if (!Array.isArray(value.polls) || value.polls.length > RUN_SHARE_LIMITS.polls) return fail('invalid_polls', 'polls must be a list.')
  if (!value.boards.length && !value.polls.length) return fail('nothing_to_share', 'Choose a board or poll results to share.')
  const boards = value.boards.map(parseBoard)
  if (boards.some((board) => !board)) return fail('invalid_board', 'A board is malformed, or names or hides someone.')
  const polls = value.polls.map(parsePoll)
  if (polls.some((poll) => !poll)) return fail('invalid_poll', 'A poll is malformed, or names or hides someone.')
  return { value: { expiresAt: expiresAt as number | null, title, ...(subtitle ? { subtitle } : {}),
    boards: boards as RunShareBoard[], polls: polls as RunSharePoll[] } }
}

// ── Routes ──────────────────────────────────────────────────────────────────────────────────

export type RunShareAction = 'page' | 'content' | 'close'
export interface RunShareRoute { shareId: string; action: RunShareAction }

const ROUTE = new RegExp(`^/results/(${SHARE_ID_SOURCE})(?:/(content|close))?$`)

/** `/results/<id>` (the page), `/results/<id>/content`, `/results/<id>/close`; nothing else. */
export function parseRunShareRoute(pathname: string): RunShareRoute | null {
  const match = pathname.match(ROUTE)
  if (!match || !isShareId(match[1])) return null
  return { shareId: match[1], action: (match[2] as RunShareAction | undefined) ?? 'page' }
}

/** The one method each route takes; anything else is refused before the object is reached. */
export function runShareRouteMethod(route: RunShareRoute): 'GET' | 'PUT' | 'POST' {
  return route.action === 'content' ? 'PUT' : route.action === 'close' ? 'POST' : 'GET'
}

// ── Lifecycle ───────────────────────────────────────────────────────────────────────────────

export function runShareExpired(share: StoredRunShare, now: number): boolean {
  return share.status === 'open' && share.expiresAt !== null && share.expiresAt <= now
}

/** When the object's alarm should fire (the expiry), or null. */
export function runShareAlarmAt(share: StoredRunShare): number | null {
  return share.status === 'open' && share.expiresAt !== null ? share.expiresAt : null
}

// ── The page ────────────────────────────────────────────────────────────────────────────────

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

const PAGE_STYLE = `
:root{color-scheme:light;--ink:#1d2430;--muted:#5d6675;--line:#d9dce2;--accent:#c2410c;--group:#fbe9e1;--paper:#fbfaf7}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
header{padding:20px 16px 14px;border-bottom:1px solid var(--line);background:#fff}header h1{margin:0;font-size:1.3rem;line-height:1.25}
header p{margin:4px 0 0;color:var(--muted)}main{max-width:1100px;margin:0 auto;padding:18px 16px 40px}
.pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;background:#1d2430;color:#fff;padding:5px 12px;font-size:.85rem;font-weight:600}
.pill.open{background:#1f5f3f}section.board,section.polls{margin:0 0 34px}h2{margin:12px 0 6px;font-size:1.7rem;line-height:1.15}
.lede{margin:0 0 16px;color:var(--muted)}.columns{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px}
.col{border-top:3px solid var(--accent);padding-top:8px}.col h3{margin:0 0 8px;font-size:1.25rem}.col h3 small{color:var(--muted);font-size:.8rem;margin-left:6px}
.card{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--line);background:#fff;border-radius:10px;padding:10px 12px;margin:0 0 8px;overflow-wrap:anywhere}
.card.group{background:var(--group);border-color:transparent}.card .n{color:var(--accent);font-weight:700;min-width:1.2em}.card .t{flex:1}
.card .x{background:var(--accent);color:#fff;border-radius:999px;padding:1px 8px;font-size:.8rem;font-weight:700;white-space:nowrap}
.poll{background:#fff;border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:0 0 14px}.poll h3{margin:0 0 4px;font-size:1.1rem}
.poll .meta{color:var(--muted);font-size:.85rem;margin:0 0 10px}.bar{display:grid;grid-template-columns:minmax(0,1fr) 2fr auto;gap:10px;align-items:center;margin:4px 0}
.bar .track{height:12px;border-radius:6px;background:#f1ece6;overflow:hidden}.bar .fill{height:100%;background:var(--accent)}
.scale .row{margin:6px 0}.scale .stack{display:flex;height:14px;border-radius:6px;overflow:hidden;background:#f1ece6}
.scale .legend{display:flex;flex-wrap:wrap;gap:10px;color:var(--muted);font-size:.8rem;margin-top:6px}.poll ul{margin:0;padding-left:1.1em}
footer{color:var(--muted);font-size:.8rem;text-align:center;padding:0 16px 24px}`

const SCALE_SHADES = ['#eadfd6', '#e9a77f', '#c2410c', '#7c2d12', '#4a1a0a', '#2b0f06']

function renderBoard(board: RunShareBoard): string {
  const pill = board.state === 'open'
    ? `<span class="pill open">Still open for cards${board.when ? ` · until ${escapeHtml(board.when)}` : ''}</span>`
    : `<span class="pill">Final board${board.when ? ` · ${escapeHtml(board.when)}` : ''}</span>`
  const columns = board.columns.map((column) => {
    const entries = column.entries.map((entry) => entry.n !== undefined
      ? `<div class="card group"><span class="n">${entry.n}</span><span class="t">${escapeHtml(entry.text)}</span>${entry.count && entry.count > 1 ? `<span class="x">×${entry.count}</span>` : ''}</div>`
      : `<div class="card"><span class="t">${escapeHtml(entry.text)}</span></div>`).join('')
    return `<div class="col"><h3>${escapeHtml(column.label)}<small>${column.count}</small></h3>${entries}</div>`
  }).join('')
  const cards = `${board.cardCount} card${board.cardCount === 1 ? '' : 's'}`
  return `<section class="board">${pill}${board.question ? `<h2>${escapeHtml(board.question)}</h2>` : ''}`
    + `<p class="lede">${cards} from the room, grouped by the speaker. No names were collected.</p><div class="columns">${columns}</div></section>`
}

function renderPoll(poll: RunSharePoll): string {
  const meta = `<p class="meta">${poll.people} ${poll.people === 1 ? 'person' : 'people'} answered</p>`
  const head = `<h3>${escapeHtml(poll.question || 'Poll')}</h3>${meta}`
  if (poll.kind === 'bars') {
    const max = Math.max(1, ...poll.rows.map((row) => row.count))
    return `<div class="poll">${head}${poll.rows.map((row) => `<div class="bar"><span>${escapeHtml(row.label)}</span>`
      + `<span class="track"><span class="fill" style="width:${Math.round(row.count / max * 100)}%;display:block"></span></span><b>${row.count}</b></div>`).join('')}</div>`
  }
  if (poll.kind === 'scale') {
    const rows = poll.rows.map((row) => {
      const total = Math.max(1, row.counts.reduce((sum, n) => sum + n, 0))
      const parts = row.counts.map((n, i) => n ? `<span style="width:${(n / total * 100).toFixed(2)}%;background:${SCALE_SHADES[i % SCALE_SHADES.length]}" title="${escapeHtml(poll.labels[i])}: ${n}"></span>` : '').join('')
      return `<div class="row"><span>${escapeHtml(row.label)}</span><div class="stack">${parts}</div></div>`
    }).join('')
    const legend = poll.labels.map((label, i) => `<span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${SCALE_SHADES[i % SCALE_SHADES.length]}"></span> ${escapeHtml(label)}</span>`).join('')
    return `<div class="poll scale">${head}${rows}<div class="legend">${legend}</div></div>`
  }
  return `<div class="poll">${head}<ul>${poll.responses.map((response) => `<li>${escapeHtml(response)}</li>`).join('')}</ul></div>`
}

/** The read-only page: every string escaped, no script, nothing that can post back. */
export function renderRunSharePage(push: RunSharePush): string {
  const boards = push.boards.map(renderBoard).join('')
  const polls = push.polls.length ? `<section class="polls"><h2>Poll results</h2>${push.polls.map(renderPoll).join('')}</section>` : ''
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<meta name="robots" content="noindex"><title>${escapeHtml(push.title)}</title><style>${PAGE_STYLE}</style></head><body>`
    + `<header><h1>${escapeHtml(push.title)}</h1>${push.subtitle ? `<p>${escapeHtml(push.subtitle)}</p>` : ''}</header>`
    + `<main>${boards}${polls}</main><footer>A read-only copy shared by the speaker.</footer></body></html>`
}

export function runShareUnavailablePage(reason: 'not_found' | 'stopped' | 'expired'): string {
  // An unknown link and one not pushed yet answer the same words, so a guessed id tells nothing.
  const message = reason === 'expired' ? 'This link has expired.'
    : reason === 'stopped' ? 'The speaker has stopped sharing these results.'
      : 'There are no shared results at this address.'
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Shared results</title></head>`
    + `<body style="font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 32rem; padding: 0 1rem; color: #222;"><p>${message}</p></body></html>`
}

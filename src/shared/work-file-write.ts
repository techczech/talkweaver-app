// The step-writing helpers for a work file (work-files ticket 07; ADR-0040; journeys Amendment 2).
//
// Pure: no Node APIs, no Electron, no file access. Writes text in the same slide syntax the reader
// (work-file.ts) reads, so each Add kind reads back as that kind. The one rule of the module: nothing
// is written that the author did not pick. A new file has no steps unless a preset or an Add was
// chosen; a preset is offered only when making a file and never attached on its own (no default
// questions, no 1–5 rating). The file's revision rises by one whenever steps are appended.
import { readWorkFile, WORK_FILE_ID_RE } from './work-file.ts'

/** What the Add row offers. `question` carries one of the existing poll types. */
export type WorkFileAddKind = 'slide' | 'video' | 'check' | 'question' | 'task'
export const WORK_FILE_ADD_KINDS: readonly WorkFileAddKind[] = ['video', 'slide', 'check', 'task', 'question']

/** Every existing poll type (`POLL_TYPES` in compiler/scripts/lib/poll-authoring.mjs), in the order the menu shows them. */
export type WorkFilePollType = 'single' | 'multiple' | 'open' | 'ranking' | 'rating' | 'categorisation' | 'board'
export const WORK_FILE_POLL_TYPES: readonly WorkFilePollType[] = ['open', 'single', 'multiple', 'ranking', 'rating', 'categorisation', 'board']

export type WorkFileAdd =
  | { kind: 'slide' | 'video' | 'check' | 'task' }
  | { kind: 'question'; pollType: WorkFilePollType }

export const ADD_LABELS: Record<WorkFileAddKind, string> = { video: 'Video', slide: 'Slide', check: 'Quick check', task: 'Task', question: 'Question' }
export const POLL_TYPE_LABELS: Record<WorkFilePollType, string> = {
  open: 'Open question', single: 'Single choice', multiple: 'Multiple choice', ranking: 'Ranking',
  rating: 'Rating scale', categorisation: 'Categorisation', board: 'Board',
}

export function isWorkFileAdd(value: unknown): value is WorkFileAdd {
  if (!value || typeof value !== 'object') return false
  const v = value as { kind?: unknown; pollType?: unknown }
  if (v.kind === 'question') return typeof v.pollType === 'string' && (WORK_FILE_POLL_TYPES as readonly string[]).includes(v.pollType)
  return v.kind === 'slide' || v.kind === 'video' || v.kind === 'check' || v.kind === 'task'
}

/** A "start from" choice offered only when making a file. `blank` has no steps. */
export interface WorkFilePreset { id: string; label: string; description: string; steps: ReadonlyArray<{ id: string; title: string; poll: 'open' }> }
export const WORK_FILE_PRESETS: readonly WorkFilePreset[] = [
  { id: 'blank', label: 'Blank', description: 'No steps. Add them yourself.', steps: [] },
  {
    id: 'survey-learnt', label: 'Survey what was learnt',
    description: 'Two open questions: what was learnt and what will be tried.',
    steps: [
      { id: 'what-learnt', title: 'What did you learn from the session?', poll: 'open' },
      { id: 'will-try', title: 'What will you try?', poll: 'open' },
    ],
  },
]

export function presetById(id: unknown): WorkFilePreset | null {
  return WORK_FILE_PRESETS.find((p) => p.id === id) ?? null
}

// ── File names ──────────────────────────────────────────────────────────────────────────────

/** A title as a file-name slug: lower-case letters, digits and single hyphens; '' when the title has none. */
export function slugForTitle(title: string): string {
  return String(title ?? '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 80).replace(/-+$/g, '')
}

export type NewTitleCheck = { ok: true; title: string; slug: string; fileName: string } | { ok: false; error: string }

/**
 * Whether a title may name a new file. `existingNames` are the file names already in `Work files/`;
 * `existingIds` the ids their front matter gives (an id names a file for talks and Runs, so a repeat
 * would make two files answer to one id). The reason is named in the error.
 */
export function checkNewTitle(rawTitle: unknown, existingNames: readonly string[], existingIds: readonly string[] = []): NewTitleCheck {
  const title = String(rawTitle ?? '').replace(/\s+/g, ' ').trim()
  if (!title) return { ok: false, error: 'Give the work file a title.' }
  if (title.length > 120) return { ok: false, error: 'The title is too long (120 characters at most).' }
  const slug = slugForTitle(title)
  if (!slug || !WORK_FILE_ID_RE.test(slug)) return { ok: false, error: 'The title has no letters or numbers to make a file name from.' }
  const fileName = `${slug}.md`
  if (existingNames.some((n) => n.toLowerCase() === fileName)) return { ok: false, error: `A work file named ${fileName} already exists. Choose another title.` }
  if (existingIds.includes(slug)) return { ok: false, error: `Another work file already has the id ${slug}. Choose another title.` }
  return { ok: true, title, slug, fileName }
}

// ── Step text ───────────────────────────────────────────────────────────────────────────────

export function frontMatterTitle(title: string): string {
  const plain = /^[A-Za-z0-9À-￿]/.test(title) && !/["'{}\[\]#:]/.test(title) && !/^(true|false|null|-?\d+(\.\d+)?)$/.test(title)
  if (plain) return title
  if (!title.includes('"')) return `"${title}"`
  if (!title.includes("'")) return `'${title}'`
  return `"${title.replace(/"/g, '”')}"`
}

const BASE_ID: Record<WorkFileAddKind, string> = { slide: 'slide', video: 'video', check: 'quick-check', question: 'question', task: 'task' }

/** An id not in `taken` (and not a repeat of any earlier call that adds its result to `taken`): `task`, then `task-2`, `task-3`. */
export function uniqueStepId(base: string, taken: Iterable<string>): string {
  const set = new Set(taken)
  if (!set.has(base)) return base
  for (let n = 2; ; n += 1) if (!set.has(`${base}-${n}`)) return `${base}-${n}`
}

const POLL_BODY: Record<WorkFilePollType, string[]> = {
  open: [],
  single: ['- First option', '- Second option'],
  multiple: ['- First option', '- Second option'],
  ranking: ['- First item', '- Second item', '- Third item'],
  // A labelled scale, never bare numbers: the author names what each end means.
  rating: ['[scale: Not at all, Somewhat, Very much]', '', '- First statement'],
  categorisation: ['[categories: First category, Second category]', '', '- First item'],
  board: ['- First column', '- Second column', '- Third column'],
}

/** The step's text (a `###` slide) and its id. `taken` are the ids already in the file. */
export function stepText(add: WorkFileAdd, taken: Iterable<string>, title?: string): { id: string; text: string } {
  const base = add.kind === 'question' ? `${BASE_ID.question}-${add.pollType}` : BASE_ID[add.kind]
  const id = uniqueStepId(base, taken)
  const lines: string[] = []
  switch (add.kind) {
    case 'slide': lines.push(`### ${title ?? 'New slide'}`, `{id=${id}}`, 'Write what to read here.'); break
    case 'video': lines.push(`### ${title ?? 'Watch'}`, `{id=${id}}{video}`); break
    case 'check': lines.push(`### ${title ?? 'Quick check'}`, `{id=${id}}{check}{poll=single}`, '- The right answer {right}', '- Another answer'); break
    case 'task': lines.push(`### ${title ?? 'Task'}`, `{id=${id}}{task}`, '1. First step', '2. Second step'); break
    case 'question':
      lines.push(`### ${title ?? 'Your question'}`, `{id=${id}}{poll=${add.pollType}}`, ...POLL_BODY[add.pollType]); break
  }
  return { id, text: lines.join('\n') + '\n' }
}

function presetStepText(step: WorkFilePreset['steps'][number]): string {
  return [`### ${step.title}`, `{id=${step.id}}{poll=${step.poll}}`].join('\n') + '\n'
}

/**
 * The text of a new work file: front matter (`id`, `title`, `revision: 1`), then the preset's steps
 * (when one was chosen) and the Adds, in order. With neither, the file has no steps.
 */
export function newWorkFileText(opts: { id: string; title: string; presetId?: string | null; adds?: readonly WorkFileAdd[] }): string {
  const preset = presetById(opts.presetId)
  const parts: string[] = [['---', `id: ${opts.id}`, `title: ${frontMatterTitle(opts.title)}`, 'revision: 1', '---', ''].join('\n')]
  const taken: string[] = []
  for (const step of preset?.steps ?? []) { parts.push(presetStepText(step)); taken.push(step.id) }
  for (const add of opts.adds ?? []) {
    const { id, text } = stepText(add, taken)
    taken.push(id); parts.push(text)
  }
  return parts.join('\n')
}

/** `revision: N` becomes `revision: N+1` in the front matter; a file with no `revision` line gets `revision: 1`; a non-integer one is left alone. */
export function bumpRevision(text: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const bom = text.startsWith('﻿') ? '﻿' : ''
  const body = bom ? text.slice(1) : text
  if (!body.startsWith('---')) return text
  const end = body.indexOf('\n---', 3)
  if (end < 0) return text
  const fm = body.slice(0, end)
  const rest = body.slice(end)
  const match = fm.match(/(^|\n)revision:[ \t]*(\d+)[ \t]*(\r?)(?=\n|$)/)
  if (match && match.index !== undefined) {
    const next = Number(match[2]) + 1
    const start = match.index + match[1].length
    const lineEnd = start + match[0].length - match[1].length
    return bom + fm.slice(0, start) + `revision: ${next}${match[3]}` + fm.slice(lineEnd) + rest
  }
  if (/(^|\n)revision:/.test(fm)) return text // not a whole number: left for the author (the reader reports it)
  return bom + fm + eol + 'revision: 1' + rest
}

/**
 * The file's text with one step appended and `revision` raised by one. The step's id is not any id
 * already in the file. Never touches the other text.
 */
export function appendStep(text: string, add: WorkFileAdd): { text: string; id: string } {
  const taken = readWorkFile(text).definition.steps.map((s) => s.id).filter((id): id is string => id !== null)
  const { id, text: step } = stepText(add, taken)
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lead = text.endsWith('\n') ? '' : eol
  const body = (step as string).replace(/\n/g, eol)
  return { text: bumpRevision(text + lead + eol.repeat(text.endsWith('\n\n') || text.endsWith('\r\n\r\n') ? 0 : 1) + body), id }
}

// ── Where a step's answer goes (2026-10-19 prework-responses design) ─────────────────────────────

/** `{local}` as written, any case, spaces inside the braces. */
const LOCAL_TOKEN_RE = /[ \t]*\{[ \t]*local[ \t]*\}/gi
/** A line of trigger tokens only (`{id=x}{task}{minutes=20}`), as written under a step's heading. */
const TOKEN_LINE_RE = /^[ \t]*(?:\{[^{}\n]*\}[ \t]*)+$/

/** The step kinds that carry an answer or a done mark, and so can be Local only. */
export function canBeLocal(kind: string): boolean {
  return kind === 'task' || kind === 'check' || kind === 'question'
}

/**
 * Where a step sits in the text: its heading line and the lines of tokens right under it (0-based), or
 * null when the step is not in the file as a `###` heading. `lines` keep any `\r`.
 */
function stepHeadLines(lines: readonly string[], sourceLine: number | null): { heading: number; tokens: number[] } | null {
  if (!sourceLine || sourceLine < 1 || sourceLine > lines.length) return null
  const heading = sourceLine - 1
  if (!/^###[ \t]/.test(lines[heading].replace(/^﻿/, ''))) return null
  const tokens: number[] = []
  for (let at = heading + 1; at < lines.length && TOKEN_LINE_RE.test(lines[at].replace(/\r$/, '')); at += 1) tokens.push(at)
  return { heading, tokens }
}

/**
 * The step's own source as the Work files view previews it: the heading, its token lines and the first
 * line of its body (cut to 60 characters). Empty when the step cannot be found.
 */
export function stepSourceLines(text: string, sourceLine: number | null): string[] {
  const lines = String(text ?? '').split('\n')
  const head = stepHeadLines(lines, sourceLine)
  if (!head) return []
  const out = [head.heading, ...head.tokens].map((at) => lines[at].replace(/\r$/, '').replace(/^﻿/, ''))
  for (let at = (head.tokens.at(-1) ?? head.heading) + 1; at < lines.length; at += 1) {
    const line = lines[at].replace(/\r$/, '')
    if (/^#{1,6}[ \t]/.test(line)) break
    if (!line.trim()) continue
    out.push(line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line)
    break
  }
  return out
}

/**
 * The file's text with the step's `{local}` written (`local: true`) or taken out (`false`), and its
 * revision raised by one; the text unchanged (and `changed: false`) when it already says so. Only a
 * task, quick check or question takes the token: a slide or video carries no answer. The token goes at
 * the end of the step's last token line, or on its heading when it has none; taking it out removes it
 * from both, and a token line left empty goes with it. Nothing else in the file changes.
 */
export function setStepLocal(text: string, stepId: string, local: boolean): { ok: true; text: string; changed: boolean } | { ok: false; error: string } {
  const source = String(text ?? '')
  const step = readWorkFile(source).definition.steps.find((candidate) => candidate.id === stepId)
  if (!step) return { ok: false, error: 'That step is not in the file any more.' }
  if (!canBeLocal(step.kind)) return { ok: false, error: 'A slide or video has no answer to keep on the phone.' }
  if ((step.local === true) === local) return { ok: true, text: source, changed: false }
  const lines = source.split('\n')
  const head = stepHeadLines(lines, step.sourceLine)
  if (!head) return { ok: false, error: 'That step could not be found in the file.' }
  const cr = (line: string): string => (line.endsWith('\r') ? '\r' : '')
  const body = (line: string): string => line.replace(/\r$/, '')
  if (local) {
    const at = head.tokens.at(-1) ?? head.heading
    const kept = body(lines[at]).trimEnd()
    lines[at] = `${kept}${kept.endsWith('}') ? '' : ' '}{local}${cr(lines[at])}`
  } else {
    lines[head.heading] = `${body(lines[head.heading]).replace(LOCAL_TOKEN_RE, '').trimEnd()}${cr(lines[head.heading])}`
    for (const at of [...head.tokens].reverse()) {
      const kept = body(lines[at]).replace(LOCAL_TOKEN_RE, '')
      if (kept.trim()) lines[at] = `${kept}${cr(lines[at])}`
      else lines.splice(at, 1)
    }
  }
  const next = bumpRevision(lines.join('\n'))
  // Read back: the step is the same step, and says what was asked.
  const after = readWorkFile(next).definition.steps.find((candidate) => candidate.id === stepId)
  if (!after || (after.local === true) !== local || after.kind !== step.kind) return { ok: false, error: 'The step could not be changed safely.' }
  return { ok: true, text: next, changed: true }
}

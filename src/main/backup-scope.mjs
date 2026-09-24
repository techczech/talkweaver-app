// What the backup is FOR (ADR-0024, accepted by Dominik 2026-09-12).
//
// Backup covers the small number of presentations Dominik is currently working on — never the
// vault. The previous design swept every talk whose outline or assets had a newer mtime, which
// sounds like "what changed" but is not: on 2026-09-11 an agent-driven vault migration rewrote 32
// outlines, so 32 talks looked worked-on at once, and compiling them in the main process OOM-
// crashed the app. A file's mtime records that SOMETHING wrote to it. It does not record that
// Dominik is working on it.
//
// So enrolment is keyed on app events, which only he can produce: a save made in the TalkWeaver
// editor. Migrations, importers, agents and OneDrive sync all move mtimes and none of them enrol
// anything. This module is the whole decision layer, kept pure so every rule is provable without
// Electron, a vault, or a clock.
export const AUTO_ENROL_LIMIT = 2
export const STALE_DAYS = 14
export const SAVE_DEBOUNCE_MS = 30_000
const DAY_MS = 24 * 60 * 60 * 1000

// ── State ────────────────────────────────────────────────────────────────────────────────────
// Persisted in the existing backup-state.json. v1 was a flat { slug: signature } map; those
// signatures are deliberately NOT read as enrolment evidence (ADR-0024 §5), because they were
// written by the mtime sweep and would re-enrol the very talks the incident was about. They are
// carried forward untouched so an existing `<slug>-backup.html` is still recognised as current.
export function loadScope(raw) {
  if (!raw || typeof raw !== 'object') return { version: 2, signatures: {}, talks: {} }
  if (raw.version === 2) {
    return { version: 2, signatures: { ...(raw.signatures ?? {}) }, talks: { ...(raw.talks ?? {}) } }
  }
  const signatures = {}
  for (const [slug, value] of Object.entries(raw)) if (typeof value === 'string') signatures[slug] = value
  return { version: 2, signatures, talks: {} }
}

function talkRecord(state, slug) {
  if (!state.talks[slug]) {
    state.talks[slug] = { title: slug, outlinePath: '', appOpenedAt: 0, appEditedAt: 0, lastBackupAt: 0, enrolled: false, decidedAt: 0 }
  }
  return state.talks[slug]
}

// A save made IN THE APP. The only event that makes a talk a backup candidate.
export function recordAppEdit(state, { slug, title, outlinePath, atMs }) {
  const record = talkRecord(state, slug)
  if (title) record.title = title
  if (outlinePath) record.outlinePath = outlinePath
  record.appEditedAt = atMs
  record.appOpenedAt = atMs
  return state
}

// Opening a talk in the app is not enough to enrol it, but it IS enough to keep an enrolled talk
// alive: the 14-day expiry asks when he last had it open, not when he last typed in it.
export function recordAppOpen(state, { slug, title, outlinePath, atMs }) {
  const record = talkRecord(state, slug)
  if (title) record.title = title
  if (outlinePath) record.outlinePath = outlinePath
  record.appOpenedAt = atMs
  return state
}

export function recordBackup(state, slug, atMs) {
  talkRecord(state, slug).lastBackupAt = atMs
  return state
}

export function setEnrolled(state, slug, enrolled, atMs = Date.now()) {
  const record = talkRecord(state, slug)
  record.enrolled = Boolean(enrolled)
  record.decidedAt = atMs
  return state
}

// ── Reading the set ──────────────────────────────────────────────────────────────────────────
export function enrolledSlugs(state) {
  return Object.entries(state.talks)
    .filter(([, record]) => record.enrolled)
    .sort((a, b) => b[1].appEditedAt - a[1].appEditedAt)
    .map(([slug]) => slug)
}

// Every talk he has edited in the app, most recent first. The pool the decision chooses from.
export function appEditedTalks(state) {
  return Object.entries(state.talks)
    .filter(([, record]) => record.appEditedAt > 0)
    .sort((a, b) => b[1].appEditedAt - a[1].appEditedAt)
    .map(([slug, record]) => ({ slug, title: record.title, lastAppEditAt: record.appEditedAt, enrolled: record.enrolled }))
}

// A talk leaves the set when he has not OPENED it in the app for 14 days. Returns the slugs that
// were dropped so the caller can say so.
export function expireStale(state, nowMs, staleDays = STALE_DAYS) {
  const cutoff = nowMs - staleDays * DAY_MS
  const dropped = []
  for (const [slug, record] of Object.entries(state.talks)) {
    if (record.enrolled && record.appOpenedAt > 0 && record.appOpenedAt < cutoff) {
      record.enrolled = false
      dropped.push(slug)
    }
  }
  return dropped
}

// ── The decision ─────────────────────────────────────────────────────────────────────────────
// Given the app-edited candidates (most recent first) and who is enrolled now, decide what should
// happen. Two outcomes only:
//   { kind: 'auto', enrol: [...] }  — free slots: fill them silently, up to the limit.
//   { kind: 'ask', candidates, defaults } — a third distinct talk arrived while the set is full.
//     He chooses; `defaults` is the two most recently app-edited, already ticked.
// Deciding is separate from doing so the rule is testable and the UI stays a thin renderer of it.
export function enrolmentDecision(candidates, enrolled, { limit = AUTO_ENROL_LIMIT } = {}) {
  const enrolledSet = new Set(enrolled)
  const known = candidates.filter((c) => enrolledSet.has(c.slug))
  const newcomers = candidates.filter((c) => !enrolledSet.has(c.slug))
  if (newcomers.length === 0) return { kind: 'auto', enrol: [] }
  const free = Math.max(0, limit - known.length)
  if (newcomers.length <= free) return { kind: 'auto', enrol: newcomers.map((c) => c.slug) }
  // The set is full (or the newcomers overflow it): this is the third-talk case. Offer every
  // candidate, pre-ticking the two he touched most recently.
  const offered = candidates.slice(0, Math.max(limit + newcomers.length, limit + 1))
  return {
    kind: 'ask',
    candidates: offered.map((c) => ({ slug: c.slug, title: c.title, lastAppEditAt: c.lastAppEditAt })),
    defaults: candidates.slice(0, limit).map((c) => c.slug)
  }
}

// Apply the outcome of the dialog: exactly the chosen talks are enrolled, everything else is not.
export function applyEnrolmentChoice(state, chosenSlugs, atMs = Date.now()) {
  const chosen = new Set(chosenSlugs)
  for (const [slug, record] of Object.entries(state.talks)) {
    if (chosen.has(slug) || record.enrolled) {
      record.enrolled = chosen.has(slug)
      record.decidedAt = atMs
    }
  }
  for (const slug of chosen) setEnrolled(state, slug, true, atMs)
  return state
}

// ── Launch ───────────────────────────────────────────────────────────────────────────────────
// One pass on launch, over the ENROLLED talks only — no vault scan, no timer. A talk is exported
// if he edited it in the app since its last backup (so a crash or a quit before the debounce
// elapsed still lands a copy).
export function talksNeedingLaunchBackup(state) {
  return Object.entries(state.talks)
    .filter(([, record]) => record.enrolled && record.appEditedAt > record.lastBackupAt)
    .sort((a, b) => b[1].appEditedAt - a[1].appEditedAt)
    .map(([slug, record]) => ({ slug, outlinePath: record.outlinePath, title: record.title }))
}

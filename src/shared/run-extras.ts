// Extras for this run (work-files ticket 24; ADR-0040 decision 8): an intro note and extra links kept on the
// Run record and shown on the Run's handout home page only; ticket 25 adds the Run's extra slides, kept on the
// Run record too and shown in the Run's presenting and handout only. The talk and its own handout are never touched.
// Pure: no Electron, no fs.
//
// Two ways in:
//   normaliseRunExtras   on every read of a Run file (anyone can edit one): whitelisted fields, text without
//                        control characters, bounded lengths and link count; anything malformed is dropped,
//                        never thrown, so the rest of the Run always reads.
//   checkRunExtrasInput  what the Run page sends to be written: the same rules, but a link that is not a web
//                        address, or text over a limit, is refused in words instead of dropped.
// A link is an http(s) address in its canonical form (`new URL(value).href`), with no user name or password.

export interface RunExtraLink {
  url: string
  /** What the handout shows for the link; without one it shows the link's host. */
  label?: string
}

export interface RunExtras {
  /** A short note shown at the top of the Run's handout home page. */
  intro?: string
  links?: RunExtraLink[]
}

export const RUN_EXTRAS_LIMITS = { intro: 1000, label: 200, url: 2048, links: 10 } as const

// Kept in the intro: line breaks and tabs. Everything else below space, and DEL, goes.
const INTRO_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g
const ANY_CONTROL = /[\u0000-\u001f\u007f]/g

/** At most `max` characters, counted as code points (a pair is never cut in half). */
function capText(text: string, max: number): string {
  const points = Array.from(text)
  return points.length > max ? points.slice(0, max).join('').trimEnd() : text
}

function introText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\r\n?/g, '\n').replace(INTRO_CONTROL, '').replace(/\n{3,}/g, '\n\n').trim()
}

function labelText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(ANY_CONTROL, ' ').replace(/\s+/g, ' ').trim()
}

/** An http(s) link in its canonical form, or undefined: no user name or password, nothing a page could read as markup. */
export function extraLinkUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > RUN_EXTRAS_LIMITS.url || !/^https?:\/\/[^\s]+$/i.test(value) || /[\u0000-\u001f\u007f]/.test(value)) return undefined
  try {
    const url = new URL(value)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname || url.username || url.password) return undefined
    return url.href.length <= RUN_EXTRAS_LIMITS.url && !/[<>"`\\\s\u0000-\u001f\u007f]/.test(url.href) ? url.href : undefined
  } catch { return undefined }
}

/** The Run's extras as read from its file; null when it has none (the field is then left out of the file). */
export function normaliseRunExtras(value: unknown): RunExtras | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const intro = capText(introText(raw.intro), RUN_EXTRAS_LIMITS.intro)
  const links: RunExtraLink[] = []
  for (const item of Array.isArray(raw.links) ? raw.links : []) {
    if (links.length >= RUN_EXTRAS_LIMITS.links) break
    if (!item || typeof item !== 'object') continue
    const url = extraLinkUrl((item as { url?: unknown }).url)
    if (!url) continue
    const label = capText(labelText((item as { label?: unknown }).label), RUN_EXTRAS_LIMITS.label)
    links.push({ url, ...(label ? { label } : {}) })
  }
  if (!intro && !links.length) return null
  return { ...(intro ? { intro } : {}), ...(links.length ? { links } : {}) }
}

/**
 * A link as typed on the Run page: an address without its scheme ("example.org/page") is taken as https; any
 * other scheme (javascript:, data:, mailto:, file:) is refused.
 */
export function extraLinkFromInput(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (!text) return undefined
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`
  return extraLinkUrl(withScheme)
}

export type RunExtrasCheck = { ok: true; extras: RunExtras | null } | { ok: false; error: string }

/** What the Run page asks to keep: refused in words when a link is not a web address or a limit is passed. */
export function checkRunExtrasInput(value: unknown): RunExtrasCheck {
  if (value === null || value === undefined) return { ok: true, extras: null }
  if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'The extras could not be read.' }
  const raw = value as Record<string, unknown>
  if (raw.intro !== undefined && typeof raw.intro !== 'string') return { ok: false, error: 'The intro note could not be read.' }
  const intro = introText(raw.intro)
  if (Array.from(intro).length > RUN_EXTRAS_LIMITS.intro) return { ok: false, error: `The intro note is too long: keep it under ${RUN_EXTRAS_LIMITS.intro} characters.` }
  if (raw.links !== undefined && !Array.isArray(raw.links)) return { ok: false, error: 'The links could not be read.' }
  const items = (raw.links as unknown[] | undefined) ?? []
  if (items.length > RUN_EXTRAS_LIMITS.links) return { ok: false, error: `A run can have up to ${RUN_EXTRAS_LIMITS.links} extra links.` }
  const links: RunExtraLink[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') return { ok: false, error: 'A link could not be read.' }
    const { url: rawUrl, label: rawLabel } = item as { url?: unknown; label?: unknown }
    if (rawLabel !== undefined && typeof rawLabel !== 'string') return { ok: false, error: 'A link name could not be read.' }
    const url = extraLinkFromInput(rawUrl)
    if (!url) return { ok: false, error: 'A link must be a web address starting with http:// or https://.' }
    const label = labelText(rawLabel)
    if (Array.from(label).length > RUN_EXTRAS_LIMITS.label) return { ok: false, error: `A link name is too long: keep it under ${RUN_EXTRAS_LIMITS.label} characters.` }
    links.push({ url, ...(label ? { label } : {}) })
  }
  return { ok: true, extras: normaliseRunExtras({ intro, links }) }
}

// ── Extra slides (work-files ticket 25) ──────────────────────────────────────────────────────────────────
// Kept on the Run record as `extraSlides`, beside `extras`; never in the talk's outline. A compile for the Run
// makes each one a slide from its title and text directly (compiler/scripts/lib/run-extras.mjs), so the text
// is only ever words: no line of it can become a heading, a Trigger, a fence or a comment. The limits are the
// compiler's too.

export interface RunExtraSlide {
  /** Made by main when the slide is added (mintExtraSlideId); the renderer only names an existing one. */
  id: string
  title: string
  /** Plain text; each line is a paragraph of the slide. */
  text: string
  /** The talk slide it is placed after, by slide id; without one it goes at the end of the Run's slides. */
  after?: string
}

export const RUN_EXTRA_SLIDE_LIMITS = { title: 200, text: 2000, slides: 10 } as const
/** An extra slide's id and its "Place after": a slide id as `{id=…}` accepts it. */
export const EXTRA_SLIDE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

function slideTitle(value: unknown): string {
  return typeof value === 'string' ? value.replace(ANY_CONTROL, ' ').replace(/\s+/g, ' ').trim() : ''
}

function slideText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\r\n?/g, '\n').replace(INTRO_CONTROL, '').split('\n').map((line) => line.replace(/\s+$/, '')).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * The Run's extra slides as read from its file; null when it has none (the field is then left out of the file).
 * An entry that is not well formed (no id, a repeated id, no title) is dropped, never thrown, so the rest of the
 * Run always reads; text over a limit is cut; at most RUN_EXTRA_SLIDE_LIMITS.slides are kept.
 */
export function normaliseRunExtraSlides(value: unknown): RunExtraSlide[] | null {
  if (!Array.isArray(value)) return null
  const out: RunExtraSlide[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (out.length >= RUN_EXTRA_SLIDE_LIMITS.slides) break
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const raw = item as Record<string, unknown>
    if (typeof raw.id !== 'string' || !EXTRA_SLIDE_ID_RE.test(raw.id) || seen.has(raw.id)) continue
    const title = capText(slideTitle(raw.title), RUN_EXTRA_SLIDE_LIMITS.title)
    if (!title) continue
    const text = capText(slideText(raw.text), RUN_EXTRA_SLIDE_LIMITS.text)
    const after = typeof raw.after === 'string' && EXTRA_SLIDE_ID_RE.test(raw.after) ? raw.after : ''
    seen.add(raw.id)
    out.push({ id: raw.id, title, text, ...(after ? { after } : {}) })
  }
  return out.length ? out : null
}

export type ExtraSlideCheck = { ok: true; slide: { title: string; text: string; after: string } } | { ok: false; error: string }

/**
 * An extra slide as the Run page sends it, checked: refused in words when it cannot be read, has no title or
 * passes a limit. `after` must be a slide id ('' for the end); whether it is one of the Run's slides is the
 * caller's check. The text may hold anything typed (it is never read as outline); titles are one line.
 */
export function checkExtraSlideInput(value: unknown): ExtraSlideCheck {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'The slide could not be read.' }
  const { title: rawTitle, text: rawText, after: rawAfter } = value as Record<string, unknown>
  if (typeof rawTitle !== 'string') return { ok: false, error: 'The slide title could not be read.' }
  if (rawText !== undefined && typeof rawText !== 'string') return { ok: false, error: 'The slide text could not be read.' }
  if (rawAfter !== undefined && rawAfter !== null && typeof rawAfter !== 'string') return { ok: false, error: 'Place after could not be read.' }
  const title = slideTitle(rawTitle)
  if (!title) return { ok: false, error: 'Give the slide a title.' }
  if (Array.from(title).length > RUN_EXTRA_SLIDE_LIMITS.title) return { ok: false, error: `The slide title is too long: keep it under ${RUN_EXTRA_SLIDE_LIMITS.title} characters.` }
  const text = slideText(rawText)
  if (Array.from(text).length > RUN_EXTRA_SLIDE_LIMITS.text) return { ok: false, error: `The slide text is too long: keep it under ${RUN_EXTRA_SLIDE_LIMITS.text} characters.` }
  const after = typeof rawAfter === 'string' ? rawAfter.trim() : ''
  if (after && !EXTRA_SLIDE_ID_RE.test(after)) return { ok: false, error: 'Place after names a slide that is not in this talk.' }
  return { ok: true, slide: { title, text, after } }
}

/** A fresh extra-slide id, `extra-` and five letters or digits, not one of `taken`. */
export function mintExtraSlideId(taken: Iterable<string>, rng: () => number = Math.random): string {
  const used = new Set(taken)
  for (;;) {
    const tail = rng().toString(36).slice(2, 7)
    const id = `extra-${tail}`
    if (tail.length === 5 && !used.has(id)) return id
  }
}

/**
 * The section header's summary: "none", "intro note", "2 links", "intro note · 1 link", and the Run's extra
 * slides (ticket 25): "intro note · 2 extra slides".
 */
export function runExtrasSummary(extras: RunExtras | null | undefined, extraSlides = 0): string {
  const parts: string[] = []
  if (extras?.intro) parts.push('intro note')
  const count = extras?.links?.length ?? 0
  if (count) parts.push(`${count} link${count === 1 ? '' : 's'}`)
  if (extraSlides > 0) parts.push(`${extraSlides} extra slide${extraSlides === 1 ? '' : 's'}`)
  return parts.length ? parts.join(' · ') : 'none'
}

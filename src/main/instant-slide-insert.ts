// Live-presenting ticket 07 (ADR-0026, frame L6): "Add to talk" for an instant slide recorded on a Run.
//
// One headless operation — addInstantSlideToTalk(document, anchorSlideId, entry, deps) — inserts the
// instant slide into the talk's source outline immediately after the slide it followed, as an ordinary
// slide in the talk's own Markdown. The History UI calls it through IPC; an agent can call it directly.
//
// Safety contract (binding — this writes Dominik's talk files):
//   - the anchor is found by the slide's stable identity: its {id=…} on the source, or the compiled
//     slide id mapped to its heading line — never by index alone; missing or ambiguous → refuse;
//   - the change is ONE pure insertion: old = prefix + suffix, new = prefix + slide + suffix;
//   - nothing is written when the operation refuses (the image asset is stored only once planning has
//     succeeded; a content-addressed asset left behind by a later failure is harmless);
//   - where the bytes go is the OutlineDocument's job: fileOutlineDocument resolves a symlinked outline
//     to its real file and, holding that file's lock (talk-writer.ts), stages the new text in a temp
//     file beside it, re-reads the target and compares its content hash with the planned base
//     immediately before writing it in place (same inode), and refuses on any change; the file keeps
//     its permissions, and a read-only target is refused untouched.
//     The editor route (index.ts) applies the same insertion to the open editor buffer instead and
//     reports success only once the editor's save has reached the disk;
//   - the Run is loaded only from the selected talk's folder and must name that talk; its entry's
//     image is re-checked (live size cap, a complete WebP/PNG/JPEG header with a real size) before
//     anything is stored, and the store must decode it fully or it writes no asset.
import { createHash } from 'crypto'
import { constants as fsConstants } from 'fs'
import { access, readFile, realpath } from 'fs/promises'
import { basename, join } from 'path'
import { pathToFileURL } from 'url'
import {
  asInstantLink, decodeInstantImage, isSafeRunId, isSafeTalkSlug, markRunInstantSlideAdded, persistRunForTalk, readRunForTalk,
  type InstantImageFormat, type RunInstantSlide, type RunRecord
} from './runs.ts'
import { retryPause, withTalkFileLock, writeTalkFileInPlace } from './talk-writer.ts'

export interface SlideBlock { heading: string; occurrence: number; title: string; start: number; end: number }
export interface CompiledSlide { id: string; title: string; sourceLine: number | null }
export interface OutlineTools {
  listSlideBlocks(text: string): SlideBlock[]
  blockRefsForId(text: string, id: string): Array<{ heading: string; occurrence: number }>
  mintId(rng: () => number, taken: Set<string>): string
  compiledSlides(outlinePath: string, text: string): Promise<CompiledSlide[]>
}
export interface OutlineDocument {
  read(): Promise<string>
  /** Replace `base` with `next`. Must refuse (and write nothing) if the document is no longer `base`.
   *  `moved` (the editor route only): refused only because the buffer moved on since the read, so a
   *  fresh read may succeed. */
  commit(base: string, next: string): Promise<{ ok: true } | { ok: false; error: string; moved?: boolean }>
}
export interface InstantAnchor { slideNumber: number; title: string }
export type AddInstantSlideResult =
  | { ok: true; afterSlideNumber: number; afterSlideTitle: string; slideId: string; offset: number; inserted: string }
  | { ok: false; error: string }

const ID_TOKEN_RE = /\{id=([A-Za-z0-9_-]+)\}/g

/** A document read refused for a reason the person should see verbatim (e.g. the editor is not ready). */
export class OutlineRefusal extends Error {}

/** Loads the outline tools from the app's bundled compiler directory (compiler/scripts). */
export async function loadOutlineTools(compilerDir: string): Promise<OutlineTools> {
  const edit = await import(pathToFileURL(join(compilerDir, 'lib/12-outline-edit.mjs')).href)
  const ledger = await import(pathToFileURL(join(compilerDir, 'lib/13-slide-ledger.mjs')).href)
  const adapters = await import(pathToFileURL(join(compilerDir, 'lib/08-source-adapters.mjs')).href)
  return {
    listSlideBlocks: (text) => edit.listSlideBlocks(text),
    blockRefsForId: (text, id) => edit.blockRefsForId(text, id),
    mintId: (rng, taken) => ledger.mintId(rng, taken),
    async compiledSlides(outlinePath, text) {
      // The same model path the presenter deck is compiled through, minus media inlining.
      // No allowed media folder (ADR-0036): only ids, titles and source lines are read here, so no
      // file a talk names is opened on this path, not even for a picture digest.
      const model = await adapters.prepareSource(outlinePath, text, basename(outlinePath).replace(/-outline\.md$/, ''),
        undefined, undefined, { projectionsOnly: true, allowedAssetRoots: [] })
      const slides = Array.isArray(model?.slides) ? model.slides : []
      return slides.map((slide: { id?: unknown; title?: unknown; sourceLine?: unknown }) => ({
        id: String(slide.id ?? ''),
        title: String(slide.title ?? ''),
        sourceLine: Number.isSafeInteger(slide.sourceLine) && Number(slide.sourceLine) > 0 ? Number(slide.sourceLine) : null,
      }))
    },
  }
}

function headingDepth(heading: string): number {
  return (heading.match(/^(#{1,6})\s/) ?? ['', '##'])[1].length
}

function plainTitle(value: string): string {
  return value.replace(ID_TOKEN_RE, '').replace(/\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim()
}

type Placement = { at: number; depth: number; slideNumber: number; title: string }

/** Where the slide goes: the anchor's slide number/title and the line index to insert before. */
function place(text: string, anchorSlideId: string, blocks: SlideBlock[], slides: CompiledSlide[], tools: OutlineTools):
  { ok: true; placement: Placement } | { ok: false; error: string } {
  const missing = `The slide this followed (“${anchorSlideId}”) is no longer in the talk, so nothing was added.`
  if (!anchorSlideId) return { ok: false, error: 'This instant slide was shown before any slide of the talk, so there is no slide to add it after.' }
  const lineCount = text.split('\n').length
  const refs = tools.blockRefsForId(text, anchorSlideId)
  if (refs.length > 1) return { ok: false, error: `More than one slide in the talk carries the id “${anchorSlideId}”, so the place to add it is ambiguous. Nothing was added.` }
  let block: SlideBlock | undefined
  if (refs.length === 1) block = blocks.find((b) => b.heading === refs[0].heading && b.occurrence === refs[0].occurrence)
  const compiledIndex = slides.findIndex((slide) => slide.id === anchorSlideId)
  if (slides.filter((slide) => slide.id === anchorSlideId).length > 1) return { ok: false, error: missing }
  if (!block && compiledIndex >= 0) {
    const compiled = slides[compiledIndex]
    if (compiled.sourceLine !== null) {
      const matches = blocks.filter((b) => b.start === compiled.sourceLine! - 1)
      if (matches.length !== 1) return { ok: false, error: missing }
      block = matches[0]
    } else {
      // A slide the compiler generates (the deck title / closing slide) has no heading of its own.
      const sourced = slides.map((slide, index) => ({ slide, index })).filter(({ slide }) => slide.sourceLine !== null)
      const title = compiled.title || anchorSlideId
      if (!sourced.length || compiledIndex < sourced[0].index) {
        return { ok: true, placement: { at: blocks[0]?.start ?? lineCount, depth: blocks[0] ? headingDepth(blocks[0].heading) : 2, slideNumber: compiledIndex + 1, title } }
      }
      if (compiledIndex > sourced[sourced.length - 1].index) {
        const last = blocks[blocks.length - 1]
        return { ok: true, placement: { at: lineCount, depth: last ? headingDepth(last.heading) : 2, slideNumber: compiledIndex + 1, title } }
      }
      return { ok: false, error: missing }
    }
  }
  if (!block) return { ok: false, error: missing }
  const numberIndex = compiledIndex >= 0 ? compiledIndex : slides.findIndex((slide) => slide.sourceLine === block!.start + 1)
  if (numberIndex < 0) return { ok: false, error: missing }
  const depth = headingDepth(block.heading)
  const next = blocks.find((b) => b.start === block!.end)
  return {
    ok: true,
    placement: {
      at: block.end,
      // A parent heading is followed by its first child: the new slide joins at the child's depth,
      // so it comes immediately after the anchor without adopting the anchor's children.
      depth: next && headingDepth(next.heading) > depth ? headingDepth(next.heading) : depth,
      slideNumber: numberIndex + 1,
      title: slides[numberIndex]?.title || plainTitle(block.title),
    },
  }
}

/**
 * Where each anchor sits in the outline NOW (History's "after slide N · title"), keyed by anchor
 * slide id; null when that slide is no longer in the talk. One compile serves every anchor.
 */
export async function resolveInstantAnchors(outlinePath: string, text: string, anchorSlideIds: Array<string | null>, tools: OutlineTools):
  Promise<Record<string, InstantAnchor | null>> {
  const ids = [...new Set(anchorSlideIds.filter((id): id is string => !!id))]
  if (!ids.length) return {}
  const blocks = tools.listSlideBlocks(text)
  const slides = await tools.compiledSlides(outlinePath, text)
  return Object.fromEntries(ids.map((id) => {
    const result = place(text, id, blocks, slides, tools)
    return [id, result.ok ? { slideNumber: result.placement.slideNumber, title: result.placement.title } : null]
  }))
}

// A heading made from typed text: braces cannot open a Trigger token, and a link or comment in the
// title is escaped exactly as in the body (escapeBodyLine).
function headingText(value: string): string {
  return value.replace(/[{}]/g, (ch) => (ch === '{' ? '(' : ')')).replace(/<!--/g, '<\\!--').replace(/\]\(/g, ']\\(')
    .replace(/\s+/g, ' ').trim()
}

function shortTitle(text: string, limit = 60): string {
  const flat = headingText(text)
  if (flat.length <= limit) return flat
  const cut = flat.slice(0, limit - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > 20 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}…`
}

// Text the presenter typed becomes Markdown content, never structure, media or a hidden link: a line
// that would read as a heading, Trigger line, fence, block directive, [Directive: …], image/video,
// quote, table row or **Timeline:** block — or that starts with `!`, which the lexer drops unless it
// is an image — is escaped with a leading `\`. Anywhere in a line, `](` gets a `\` between the two
// characters, so `[label](url)` / `![alt](url)` stay the characters the audience saw instead of a
// link that hides its URL; `<!--` becomes `<\!--`, so a comment cannot hide the rest. The compiler
// has no backslash-escape rule, so each escape shows as one extra `\`. A line that is only a URL
// would compile to an embedded web page, so it becomes a link showing that same URL. Emphasis,
// inline code and ==marks== are left to render as formatting (no escape exists for them).
function escapeBodyLine(line: string): string {
  const safe = line.replace(/<!--/g, '<\\!--').replace(/\]\(/g, ']\\(')
  const url = safe.trim()
  // The compiler's bare-URL rule (isBareUrl); a URL with brackets cannot be a link label, so it
  // is escaped like any other active line instead.
  if (/^https?:\/\/[^\s<>"']+$/i.test(url)) {
    return /[[\]()\\]/.test(url) ? safe.replace(/^(\s*)/, (space: string) => `${space}\\`) : safe.replace(url, () => `[${url}](${url})`)
  }
  return safe.replace(/^(\s*)(#|\{|`{3,}|~{3,}|:::|\[[A-Za-z][\w-]*:|!|>|\||\*\*Timeline:\*\*\s*$)/i,
    (_m, space: string, lead: string) => `${space}\\${lead}`)
}

function durationToken(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000}min` : `${Math.max(1, Math.round(ms / 1000))}s`
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') || url } catch { return url }
}

/** The slide's Markdown lines (no line endings). `imageRef` is the stored asset id for an image slide. */
export function instantSlideMarkdown(entry: RunInstantSlide, depth: number, id: string, imageRef?: string): string[] | null {
  const hashes = '#'.repeat(Math.min(6, Math.max(2, depth)))
  // Only the canonical href is ever written (new URL(...).href, no < > " or backtick left in it), so a link
  // cannot open an HTML comment or close the QR directive; a link that is not safe is left out.
  const safeLink = asInstantLink((entry.kind === 'link' ? entry.url : entry.link)?.replace(/\s/g, '%20'))
  const linkLines = (url: string): string[] =>
    ['', `<${url}>`, '', `[QR: ${url.replace(/\|/g, '%7C').replace(/\]/g, '%5D')} | ${headingText(hostOf(url)).replace(/[|\]]/g, '')}]`]
  if (entry.kind === 'text' && entry.text && safeLink) {
    // Text and link together: the text, the link and its QR, in the talk's Markdown for links.
    return [`${hashes} ${shortTitle(entry.text) || headingText(hostOf(safeLink))}`, `{id=${id}}`, '',
      ...entry.text.replace(/\r\n?/g, '\n').trim().split('\n').map(escapeBodyLine), ...linkLines(safeLink)]
  }
  if (entry.kind === 'text' && entry.text) {
    return [`${hashes} ${shortTitle(entry.text) || 'Instant slide'}`, `{statement} {id=${id}}`, '',
      ...entry.text.replace(/\r\n?/g, '\n').trim().split('\n').map(escapeBodyLine)]
  }
  if (entry.kind === 'link' && safeLink) {
    return [`${hashes} ${headingText(hostOf(safeLink))}`, `{id=${id}}`, ...linkLines(safeLink)]
  }
  if (entry.kind === 'countdown' && entry.durationMs) {
    return [`${hashes} ${headingText(entry.label ?? '') || 'Countdown'}`, `{countdown-digits-${durationToken(entry.durationMs)}} {id=${id}}`,
      ...(safeLink ? linkLines(safeLink) : [])]
  }
  if (entry.kind === 'image' && imageRef) {
    return [`${hashes} Image`, `{media} {id=${id}}`, '', `![](${imageRef})`]
  }
  return null
}

/** Pure planning: the insertion offset and bytes for `lines` placed before line index `at`. */
export function insertionAt(text: string, at: number, lines: string[]): { offset: number; inserted: string } {
  const all = text.split('\n')
  const crCount = all.slice(0, -1).filter((line) => line.endsWith('\r')).length
  const nl = all.length > 1 && crCount > (all.length - 1) / 2 ? '\r\n' : '\n'
  const blank = (line: string | undefined) => line === undefined || line.replace(/\r$/, '').trim() === ''
  const body = lines.map((line) => line + nl).join('')
  if (text === '') return { offset: 0, inserted: body }
  if (at < all.length && !(at === all.length - 1 && all[at] === '')) {
    let offset = 0
    for (let i = 0; i < at; i += 1) offset += all[i].length + 1
    const lead = at > 0 && !blank(all[at - 1]) ? nl : ''
    return { offset, inserted: lead + body + nl }
  }
  // End of the outline.
  if (text.endsWith('\n')) return { offset: text.length, inserted: (blank(all[all.length - 2]) ? '' : nl) + body }
  return { offset: text.length, inserted: nl + nl + body }
}


/** How many times "Add to talk" plans again after the editor refused its commit because the buffer moved. */
const INSERT_RETRIES = 1

/**
 * The typed headless operation. Inputs: the talk's outline document, the anchor slide's stable id and
 * the Run's instant-slide record. Refuses with a human message — and writes nothing — when the anchor
 * cannot be found unambiguously, the kind has no slide form, or the document changed underneath.
 */
export async function addInstantSlideToTalk(
  document: OutlineDocument,
  outlinePath: string,
  anchorSlideId: string | null,
  entry: RunInstantSlide,
  deps: { tools: OutlineTools; storeImage(bytes: Buffer, format: InstantImageFormat): Promise<string | null>; rng?: () => number },
): Promise<AddInstantSlideResult> {
  if (entry.kind === 'time') return { ok: false, error: 'A live clock has no slide form in the talk’s Markdown, so it cannot be added.' }
  // The Run is ordinary JSON: check its image before anything else, so a bad one stores nothing.
  const image = entry.kind === 'image' ? decodeInstantImage(entry.dataUrl) : null
  if (entry.kind === 'image' && !image) {
    return { ok: false, error: 'The image kept on this Run is not a usable picture (too large for a live image, or not a WebP, PNG or JPEG file), so nothing was added.' }
  }
  // Read, plan and commit. On the editor route a commit refused only because the buffer moved on
  // since the read (a strip reorder or typing landed in between) is planned again once against a
  // fresh read; if that one is overtaken too, the refusal stands. The image is stored at most once.
  let imageRef: string | undefined
  for (let attempt = 0; ; attempt += 1) {
    let text: string
    try { text = await document.read() } catch (cause) {
      return { ok: false, error: cause instanceof OutlineRefusal ? cause.message : 'The talk’s outline could not be read, so nothing was added.' }
    }
    let placed: ReturnType<typeof place>
    try {
      placed = place(text, anchorSlideId ?? '', deps.tools.listSlideBlocks(text), await deps.tools.compiledSlides(outlinePath, text), deps.tools)
    } catch {
      return { ok: false, error: 'The talk could not be compiled to find the slide this followed, so nothing was added.' }
    }
    if (!placed.ok) return placed
    const taken = new Set([...text.matchAll(ID_TOKEN_RE)].map((match) => match[1]))
    const slideId = deps.tools.mintId(deps.rng ?? Math.random, taken)
    if (image && !imageRef) {
      let undecodable = false
      const stored = await deps.storeImage(image.bytes, image.format)
        .catch((cause) => { undecodable = cause instanceof Error && cause.message === 'image-not-decodable'; return null })
      if (undecodable) return { ok: false, error: 'The image kept on this Run could not be decoded as a picture, so nothing was added.' }
      if (!stored) return { ok: false, error: 'The image could not be saved into the talk’s assets, so nothing was added.' }
      imageRef = stored
    }
    const lines = instantSlideMarkdown(entry, placed.placement.depth, slideId, imageRef)
    if (!lines) return { ok: false, error: 'This instant slide has no content to add.' }
    const { offset, inserted } = insertionAt(text, placed.placement.at, lines)
    const next = text.slice(0, offset) + inserted + text.slice(offset)
    const committed = await document.commit(text, next)
    if (!committed.ok) {
      // A short pause first (the talk writer's): a read taken in a pause in the typing can be applied.
      if (committed.moved && attempt < INSERT_RETRIES) { await retryPause(attempt); continue }
      return { ok: false, error: committed.error }
    }
    return { ok: true, afterSlideNumber: placed.placement.slideNumber, afterSlideTitle: placed.placement.title, slideId, offset, inserted }
  }
}

function contentHash(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The outline file on disk. A symlinked outline is followed to its real file, and that file is the
 * one written (in place, staged through a temp file in ITS directory — writeTalkFileInPlace), so the
 * link survives exactly as the app's normal save leaves it. Immediately before the bytes go in the
 * target is re-read and its content hash compared with the planned base; any difference refuses and
 * leaves the file as it is.
 */
export function fileOutlineDocument(
  outlinePath: string,
  // Test seam: runs after the new text is staged in the temp file, just before the last look.
  options: { beforeReplace?: () => Promise<void> } = {},
): OutlineDocument {
  const changed = 'The talk changed while the slide was being added. Nothing was written; try again.'
  return {
    async read() {
      const bytes = await readFile(await realpath(outlinePath))
      const text = bytes.toString('utf8')
      // Bytes that are not valid UTF-8 would not survive a text round trip: never plan against them.
      if (!Buffer.from(text, 'utf8').equals(bytes)) throw new OutlineRefusal('The talk’s outline is not plain UTF-8 text, so the slide was not added. Nothing was written.')
      return text
    },
    async commit(base, next) {
      let target: string
      try { target = await realpath(outlinePath) } catch { return { ok: false, error: 'The talk’s outline could not be read, so nothing was added.' } }
      const baseHash = contentHash(Buffer.from(base, 'utf8'))
      // One writer (talk-writer.ts): under the same per-file lock as every other main-process write
      // of this talk, and written in place (same inode) like them. This write keeps its own last
      // look at the file, so it takes the lock rather than the whole-text writeTalkOutline form.
      return withTalkFileLock(outlinePath, async (held): Promise<{ ok: true } | { ok: false; error: string }> => {
        // A read-only outline (e.g. mode 0444) is a marker the app must respect: refuse before
        // writing anything.
        try { await access(target, fsConstants.W_OK) } catch {
          return { ok: false, error: 'The talk’s outline is read-only, so the slide was not added. Nothing was written.' }
        }
        try {
          if (contentHash(await readFile(target)) !== baseHash) return { ok: false, error: changed }
          // Staged beside the target and fsynced first; then the last look before the bytes go into
          // the file: an autosave or another writer since planning wins. Accepted residual risk: a
          // write from OUTSIDE the app landing between this re-read and the copy is still overwritten
          // (cloud sync clients do not honour file locks; the app's own writers all hold the lock).
          const outcome = await writeTalkFileInPlace(target, next, {
            expectKey: held.key,
            beforeCopy: async () => {
              await options.beforeReplace?.()
              return contentHash(await readFile(target)) === baseHash
            },
          })
          if (outcome === 'aborted') return { ok: false, error: changed }
        } catch {
          return { ok: false, error: 'The talk’s outline could not be written, so nothing was added.' }
        }
        return { ok: true }
      })
    },
  }
}

const inFlight = new Set<string>()

/**
 * "Add to talk" for one instant slide recorded on a Run: inserts it (once) and records the result on
 * the Run, so the button reads "Added after slide N" from then on. An entry already added is reported
 * as added and never inserted a second time.
 */
export async function addRunInstantSlide(args: {
  vaultRoot: string; talkSlug: string; runId: string; entryId: string; outlinePath: string
  document: OutlineDocument; tools: OutlineTools; storeImage(bytes: Buffer, format: InstantImageFormat): Promise<string | null>
  rng?: () => number; now?: () => Date
}): Promise<{ ok: true; afterSlideNumber: number; afterSlideTitle: string; run: RunRecord } | { ok: false; error: string }> {
  // Names from the caller are path components: refuse anything that is not one safe segment, and
  // read the Run only from this talk's folder, only if it says it is this talk's Run.
  if (!isSafeTalkSlug(args.talkSlug) || !isSafeRunId(args.runId)) return { ok: false, error: 'This Run could not be found, so nothing was added.' }
  const run = readRunForTalk(args.vaultRoot, args.talkSlug, args.runId)
  if (!run) return { ok: false, error: 'This Run could not be found, so nothing was added.' }
  const entry = run.instantSlides?.find((item) => item.id === args.entryId)
  if (!entry) return { ok: false, error: 'This instant slide is not on the Run, so nothing was added.' }
  if (entry.added) return { ok: true, afterSlideNumber: entry.added.afterSlideNumber, afterSlideTitle: entry.added.afterSlideTitle, run }
  const key = `${args.vaultRoot}\0${args.talkSlug}\0${args.runId}\0${args.entryId}`
  if (inFlight.has(key)) return { ok: false, error: 'This slide is already being added.' }
  inFlight.add(key)
  try {
    const result = await addInstantSlideToTalk(args.document, args.outlinePath, entry.afterSlideId, entry,
      { tools: args.tools, storeImage: args.storeImage, rng: args.rng })
    if (!result.ok) return result
    try {
      const fresh = readRunForTalk(args.vaultRoot, args.talkSlug, args.runId) ?? run
      const marked = persistRunForTalk(args.vaultRoot, args.talkSlug, args.runId, markRunInstantSlideAdded(fresh, entry.id, {
        afterSlideNumber: result.afterSlideNumber, afterSlideTitle: result.afterSlideTitle,
        slideId: result.slideId, at: (args.now ?? (() => new Date()))().toISOString(),
      }))
      return { ok: true, afterSlideNumber: result.afterSlideNumber, afterSlideTitle: result.afterSlideTitle, run: marked }
    } catch {
      return { ok: false, error: `The slide was added to the talk after slide ${result.afterSlideNumber}, but the Run could not record it. Check the talk before adding it again.` }
    }
  } finally {
    inFlight.delete(key)
  }
}

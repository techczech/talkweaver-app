// A picked slide shows the picture of the slide it was picked from, by the same twthumb:// address the Slide Browser
// uses. A talk that was never opened in the editor has no thumbnail cache yet; the Slide Browser fills that in by
// asking main to render the talk (useThumbRegen) when a picture 404s. The Slide Scratchpad does the same: one talk
// at a time, each at most twice per session, and every waiting picture retries when a talk has been rendered.
import type { ScratchSlide } from '../../../shared/scratchpad'

type Listener = () => void
const listeners = new Set<Listener>()
const nonces = new Map<string, number>()
const attempts = new Map<string, number>()
const queue: string[] = []
let running = false

/** Candidate absolute outline paths for a stored slide: an absolute talkPath as it is, else under the named vault's
 *  folder, else under every vault (the first that can be read wins). */
export function sourceOutlineCandidates(slide: Pick<ScratchSlide, 'talkPath' | 'vaultId'>, vaults: ReadonlyArray<{ id: string; root: string }>): string[] {
  if (slide.talkPath.startsWith('/')) return [slide.talkPath]
  const join = (root: string): string => `${root.replace(/\/+$/, '')}/${slide.talkPath}`
  const named = slide.vaultId ? vaults.filter((v) => v.id === slide.vaultId) : []
  const rest = vaults.filter((v) => !named.includes(v))
  return [...named, ...rest].map((v) => join(v.root))
}

/** Where a stored slide's picture really is on THIS machine. The saved state travels with the talk folder (sync), but a
 *  vault id is a per-machine registry id and a render_hash moves when the slide is edited, so what was saved at pick
 *  time can address nothing here (a vault-qualified twthumb:// URL reads that vault's folder only). */
export interface SlidePicture { talkSlug: string; thumbKey: string; vaultId?: string }
export interface SourceRow { slide_id: string; render_hash?: string; content_hash?: string; talkSlug: string; vaultId?: string; outlinePath: string }

/** Re-derives a slide's picture address from the source talk's current rows and the vault that holds its outline:
 *  the row with the slide's id in that outline gives slug and key; the vault is the one whose folder contains the
 *  outline (the row's own vault id wins). null when no row matches. */
export function deriveSlidePicture(
  slide: Pick<ScratchSlide, 'slideId'>, outlinePath: string, vaults: ReadonlyArray<{ id: string; root: string }>, rows: readonly SourceRow[]
): SlidePicture | null {
  const row = rows.find((r) => r.slide_id === slide.slideId && r.outlinePath === outlinePath)
  if (!row) return null
  const key = row.render_hash || row.content_hash || row.slide_id
  if (!key) return null
  const holder = vaults.find((v) => outlinePath.startsWith(v.root.replace(/\/+$/, '') + '/'))
  const vaultId = row.vaultId ?? holder?.id
  return { talkSlug: row.talkSlug, thumbKey: key, ...(vaultId ? { vaultId } : {}) }
}

const fixes = new Map<string, SlidePicture>()
const fixKey = (slide: Pick<ScratchSlide, 'talkPath' | 'slideId'>): string => `${slide.talkPath}\0${slide.slideId}`
/** The picture address to use for a slide: the re-derived one when the saved one missed, else the saved one. */
export function slidePictureFor(slide: ScratchSlide): SlidePicture | null {
  const fix = fixes.get(fixKey(slide))
  if (fix) return fix
  return slide.talkSlug && slide.thumbKey ? { talkSlug: slide.talkSlug, thumbKey: slide.thumbKey, ...(slide.vaultId ? { vaultId: slide.vaultId } : {}) } : null
}

async function rowsFor(slide: ScratchSlide, vaultIds: string[]): Promise<SourceRow[]> {
  const words = slide.title.split(/\s+/).filter(Boolean)
  if (words.length === 0) return []
  const rows = await window.tw.search.allSlides({ scope: 'title', exact: false, text: slide.title, terms: words }, vaultIds.length ? { vaultIds } : undefined).catch(() => null)
  return (rows ?? []) as unknown as SourceRow[]
}

/** After the source talk was rendered: work out each waiting slide's current address and keep it when it differs. */
async function rederive(talkPath: string, outlinePath: string): Promise<boolean> {
  const slides = [...(waiting.get(talkPath)?.values() ?? [])]
  if (slides.length === 0) return false
  const vaults = await window.tw.vault.list().catch(() => [])
  const rows = await rowsFor(slides[0], vaults.map((v) => v.id))
  let changed = false
  for (const slide of slides) {
    const fix = deriveSlidePicture(slide, outlinePath, vaults, rows)
    const saved = slidePictureFor(slide)
    if (fix && (fix.talkSlug !== saved?.talkSlug || fix.thumbKey !== saved?.thumbKey || fix.vaultId !== saved?.vaultId)) { fixes.set(fixKey(slide), fix); changed = true }
  }
  return changed
}
const waiting = new Map<string, Map<string, ScratchSlide>>()

export const thumbRegenNonce = (talkPath: string): number => nonces.get(talkPath) ?? 0
export function onThumbRegen(listener: Listener): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }

async function resolve(slide: ScratchSlide): Promise<{ path: string; content: string } | null> {
  const vaults = await window.tw.vault.list().catch(() => [])
  for (const path of sourceOutlineCandidates(slide, vaults)) {
    const content = await window.tw.talk.readOutline(path).catch(() => null)
    if (content != null) return { path, content }
  }
  return null
}

async function drain(slides: Map<string, ScratchSlide>): Promise<void> {
  if (running) return
  running = true
  try {
    for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
      const slide = slides.get(key)
      if (!slide) continue
      let rendered = 0
      try {
        const source = await resolve(slide)
        if (source) {
          const map = await window.tw.talk.thumbnails(source.path, source.content, { lane: 'browser' })
          rendered = map ? Object.keys(map).length : 0
          if (await rederive(key, source.path)) rendered = Math.max(rendered, 1) // a corrected address is as good as a render: retry the pictures
        }
      } catch { /* one bad talk must not stall the rest */ }
      if (rendered > 0) {
        nonces.set(key, (nonces.get(key) ?? 0) + 1)
        for (const l of listeners) l()
      } else if ((attempts.get(key) ?? 0) < 2) {
        setTimeout(() => { queue.push(key); void drain(slides) }, 15_000) // "not now" (heap high, editor busy): offer again
      }
    }
  } finally { running = false }
}

const known = new Map<string, ScratchSlide>()
/** The picture of this slide did not load: ask for its talk to be rendered (once per attempt, one talk at a time). */
export function noteSourceThumbUnavailable(slide: ScratchSlide): void {
  const key = slide.talkPath
  known.set(key, slide)
  const mine = waiting.get(key) ?? new Map<string, ScratchSlide>()
  mine.set(slide.slideId, slide)
  waiting.set(key, mine)
  const n = attempts.get(key) ?? 0
  if (n >= 2 || queue.includes(key)) return
  attempts.set(key, n + 1)
  queue.push(key)
  void drain(known)
}

/** For tests: forget every talk. */
export function resetSourceThumbs(): void { queue.length = 0; attempts.clear(); nonces.clear(); known.clear(); fixes.clear(); waiting.clear(); running = false }

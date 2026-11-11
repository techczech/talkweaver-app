// Scratchpad source addresses are portable across machines. This adapter resolves their vault paths
// and repairs stale picture keys; the shared slideThumbnails route owns rendering and retries.
import { sourceThumbnailClient } from './slideThumbnails.ts'
import type { ScratchSlide } from '../../../shared/scratchpad'

type Listener = () => void
const listeners = new Set<Listener>()
const nonces = new Map<string, number>()

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

// Source identity and address repair belong to the Scratchpad adapter; rendering and retries do not.
const resolvedPaths = new Map<string, Set<string>>()
let generation = 0
let client: ReturnType<typeof sourceThumbnailClient> | null = null
function sourceClient(): ReturnType<typeof sourceThumbnailClient> {
  client ??= sourceThumbnailClient((path, _map, outlinePath) => {
    const mine = generation
    void Promise.all([...(resolvedPaths.get(path) ?? [])].map(async key => {
      await rederive(key, outlinePath)
      if (mine !== generation) return
      nonces.set(key, (nonces.get(key) ?? 0) + 1)
      for (const l of listeners) l()
    }))
  })
  return client
}

/** The picture missed: resolve its portable source path, then use the same queue as the Browser. */
export function noteSourceThumbUnavailable(slide: ScratchSlide): void {
  const key = slide.talkPath
  const mine = waiting.get(key) ?? new Map<string, ScratchSlide>()
  mine.set(slide.slideId, slide)
  waiting.set(key, mine)
  // A portable address may fall back to another vault. It is a job identity, never a concrete
  // Browser outline path: rendering that fallback must not mark a different vault's talk done.
  const job = `scratchpad:${JSON.stringify([slide.vaultId ?? '', slide.talkPath])}`
  const keys = resolvedPaths.get(job) ?? new Set<string>()
  keys.add(key); resolvedPaths.set(job, keys)
  sourceClient().note(job, () => resolve(slide))
}

/** For tests: forget every talk and dispose pending retries. */
export function resetSourceThumbs(): void {
  generation += 1; client?.dispose(); client = null
  nonces.clear(); fixes.clear(); waiting.clear(); resolvedPaths.clear()
}

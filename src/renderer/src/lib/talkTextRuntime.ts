export interface RequestGeneration {
  begin: () => number
  current: () => number
  commit: (generation: number, action: () => void) => boolean
}

export function createRequestGeneration(): RequestGeneration {
  let value = 0
  return {
    begin: () => ++value,
    current: () => value,
    commit: (generation, action) => {
      if (generation !== value) return false
      action()
      return true
    }
  }
}

export interface SurfaceRequestGeneration {
  begin: (showLoading: boolean, setLoading: (loading: boolean) => void) => number
  invalidate: () => number
  commit: (generation: number, action: () => void) => boolean
  settle: (generation: number, setLoading: (loading: boolean) => void) => boolean
}

export function createSurfaceRequestGeneration(): SurfaceRequestGeneration {
  const generation = createRequestGeneration()
  return {
    begin: (showLoading, setLoading) => {
      const value = generation.begin()
      if (showLoading) setLoading(true)
      return value
    },
    invalidate: generation.begin,
    commit: generation.commit,
    settle: (value, setLoading) => generation.commit(value, () => setLoading(false))
  }
}

export function buildSlideIndex(slideNumbers: number[]): Map<number, number> {
  return new Map(slideNumbers.map((slideNumber, index) => [slideNumber, index]))
}

export function seekLoadedAudio(
  audio: { readyState: number; currentTime: number } | null,
  ms: number,
  durationMs = 0
): boolean {
  if (!audio || audio.readyState < 1) return false
  const clamped = Math.max(0, durationMs ? Math.min(durationMs, ms) : ms)
  audio.currentTime = clamped / 1000
  return true
}

export type NoteDraftSource = { slug: string; order: number; fileName: string; markdown: string }
export type NoteApprovedSource = { slug: string; order: number; markdown: string; approvedAt: string }
export type MergedNoteSource = {
  slug: string
  order: number
  markdown: string
  approved: boolean
  fileName?: string
}

export function mergeNoteSources(
  drafts: NoteDraftSource[],
  approvedParts: NoteApprovedSource[]
): MergedNoteSource[] {
  const merged = new Map<string, MergedNoteSource>()
  for (const draft of drafts) merged.set(draft.slug, { ...draft, approved: false })
  for (const approved of approvedParts) {
    merged.set(approved.slug, {
      ...merged.get(approved.slug),
      slug: approved.slug,
      order: approved.order,
      markdown: approved.markdown,
      approved: true
    })
  }
  return [...merged.values()].sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug))
}

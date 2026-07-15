// Pathway rendering preferences only. Membership, focus, selection and reorder state remain in
// Pathways so switching the drawing mode cannot reset the shared pathway model (ADR-0012).

export type PathwayViewMode = 'grid' | 'list' | 'matrix'

export const PATHWAY_VIEW_STORAGE_KEY = 'tw-pathway-view'
export const PATHWAY_PREVIEWS_STORAGE_KEY = 'tw-pathway-previews'

type PreferenceStorage = Pick<Storage, 'getItem'>

function rendererStorage(): PreferenceStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function readPathwayViewPreference(storage: PreferenceStorage | null = rendererStorage()): PathwayViewMode {
  try {
    const raw = storage?.getItem(PATHWAY_VIEW_STORAGE_KEY)
    if (raw === 'list' || raw === 'matrix') return raw
  } catch { /* storage failures fall through to the locked default */ }
  return 'grid'
}

export function readPathwayPreviewsPreference(storage: PreferenceStorage | null = rendererStorage()): boolean {
  try {
    const raw = storage?.getItem(PATHWAY_PREVIEWS_STORAGE_KEY)
    if (raw === 'false') return false
  } catch { /* storage failures fall through to the locked default */ }
  return true
}

// Shared prop shapes for the unified rail's sub-components (ADR-0009). The heavy data
// derivation (counts, vocabularies, tree building) lives in SlideBrowser's memos — the
// rail components are deliberately dumb renderers over these flat shapes.
import type { ScopeEntry, RailFacets, ContentKey } from './railModel'

export interface TreeSection {
  /** Projection section slug — the scoping identity. */
  sec: string
  /** Authored display name (never the slug when the name is known). */
  label: string
  count: number
}
export interface TreeTalk {
  slug: string
  title: string
  count: number
  sections: TreeSection[]
}
export interface TreeFolder {
  name: string
  count: number
  talks: TreeTalk[]
}

export interface TalkHit {
  slug: string
  title: string
  count: number
}

/** One Collections lens row — clicking scopes to `slug`. */
export interface CollectionRow {
  key: string
  slug: string
  title: string
  /** e.g. a delivery's context/audience. */
  sub?: string
  when: string
}

export interface FacetItem {
  value: string
  count: number
}
export interface ContentItem {
  key: ContentKey
  label: string
  count: number
}

/** Scope handler: plain click replaces, ⌘click toggles into the set. */
export type ScopeFn = (entry: ScopeEntry, additive: boolean) => void
export type FacetKind = 'tag' | 'sec' | 'lay' | 'content'
export type ToggleFacetFn = (kind: FacetKind, value: string) => void

export type { ScopeEntry, RailFacets, ContentKey }

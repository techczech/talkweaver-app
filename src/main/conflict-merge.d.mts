export type SlideBlock = { heading: string; occurrence: number; title: string; start: number; end: number }
export type OutlineDeps = { listSlideBlocks: (text: string) => SlideBlock[] }
export type ListedSlide = { index: number; start: number; end: number; title: string; occurrence: number; id: string | null; lines: string[]; text: string }
export type ComparedSlide = { index: number; id: string | null; title: string; text: string; match: number; differs: boolean }

export function splitGitConflict(text: string): { ours: string; theirs: string; oursLabel: string | null; theirsLabel: string | null } | null
export function listSlides(text: string, deps: OutlineDeps): { head: string; slides: ListedSlide[]; lines: string[] }
export function matchSlides(a: Array<{ id: string | null; title: string }>, b: Array<{ id: string | null; title: string }>): { matchOfA: number[]; matchOfB: number[] }
export function compareVersions(a: string, b: string, deps: OutlineDeps): { a: ComparedSlide[]; b: ComparedSlide[]; headDiffers: boolean }
export function mergeConflict(
  input: { kept: string; other: string; pull: number[] },
  deps: OutlineDeps & { mintId: (rng: () => number, taken: Set<string>) => string; rng?: () => number }
): { text: string; added: Array<{ from: number; after: number | null; id: string | null }>; restamped: Array<{ from: string; to: string }> }

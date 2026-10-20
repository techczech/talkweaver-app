export const RUN_ID_RE: RegExp
export const EXTRA_SLIDE_ID_RE: RegExp

/** An extra slide as a compile for its Run takes it (from the Run record's `extraSlides`). */
export interface RunCompileExtraSlide { id: string; title: string; text?: string; after?: string }
/** `options.run` of a compile for a Run. */
export interface RunCompileOption { id: string; slideIds: string[] | null; extraSlides: RunCompileExtraSlide[] }
/** Where a compile for the Run put an extra slide. */
export interface PlacedRunExtra { id: string; title: string; after: string; placed: 'after' | 'end' }
/** A compile for a Run's `model.runExtras`: where it put each extra slide, and the deck's final slide order. */
export interface RunExtrasModel { runId?: string; slides: PlacedRunExtra[]; order?: string[] }
export const OPENING_SLIDE_ID: 'deck-title'
export const CLOSING_SLIDE_ID: 'deck-thanks'

export function runCompileOption(value: unknown): { id: string; slideIds: string[] | null; extraSlides: Array<{ id: string; title: string; text: string; after: string }> } | null
export function extraSlideBlocks(text: string): Array<{ type: 'paragraph'; text: string; plain: true }>
export function runExtraSlideNodes(extraSlides: ReadonlyArray<{ id: string; title: string; text: string; after: string }>, takenIds?: Set<string>): unknown[]
export function placeRunExtraNodes(root: unknown, run: { slideIds: string[] | null; extraSlides: ReadonlyArray<{ id: string; title: string; text: string; after: string }> }): PlacedRunExtra[]
export function settleRunExtraTail(slides: Array<{ id?: unknown }>, rootChildren: unknown[], placed: PlacedRunExtra[]): void
export function withRunExtraIds(slideIds: readonly string[], runExtras: { slides?: readonly PlacedRunExtra[]; order?: readonly string[] } | null | undefined): string[]

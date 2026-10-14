// The parts of slide-containers.mjs the app shares (src/shared/quote-write-check.ts: the check before a quote write).
interface FoldNode { attrs?: Record<string, unknown>; contentLines?: readonly string[]; children?: readonly unknown[] }

/** How a heading takes its child headings into its own slide ('' when it does not). */
export function childFoldOfNode(node: FoldNode, deckTriggerDefaults: Record<string, unknown>): '' | 'carousel' | 'cards' | 'columns' | 'compare'

/** The container the compiler rebuilds a slide's blocks as ('' when the slide keeps the blocks it was read with). */
export function slideContainerKind(layout: string, attrs: Record<string, unknown>, cardCount: number): '' | 'compare' | 'image-grid' | 'contrast' | 'carousel' | 'cards'

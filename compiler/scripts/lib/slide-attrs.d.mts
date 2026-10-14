// The parts of slide-attrs.mjs the app shares (src/shared/feedback-accept.ts: slideEffectiveAttrs).
interface AttrNode { attrs?: Record<string, unknown>; contentLines?: readonly string[] }

/** The frontmatter of an outline as the compiler reads it: `{}` when there is none or it is not closed. */
export function outlineFrontmatterMeta(markdown: string): Record<string, unknown>
/** The talk's frontmatter `triggers:` defaults (layout and id barred, each with a warning). */
export function deckTriggerDefaultsFromMeta(meta: Record<string, unknown>): { attrs: Record<string, unknown>; warnings: string[] }
export function slideAttrsFromNode(node: AttrNode, deckTriggerDefaults: Record<string, unknown>): Record<string, unknown>
/** For each content line: the parsed Trigger line the compiler folds into the slide's attributes (outside a code fence, not a chart token owning a list), else null. */
export function contentTriggerLines(contentLines: readonly string[] | null | undefined): Array<{ attrs: Record<string, unknown>; warnings: string[] } | null>
export function foldContentTriggerLines(node: AttrNode, attrs: Record<string, unknown>, options?: { onWarning?: ((warning: string) => void) | null; authoredKeys?: Set<string> | null }): string[]
/** The attributes the compiler gives the node's slide: the deck's defaults, the heading and Trigger line, then Trigger-shaped content lines. */
export function effectiveSlideAttrs(node: AttrNode, deckTriggerDefaults: Record<string, unknown>): Record<string, unknown>

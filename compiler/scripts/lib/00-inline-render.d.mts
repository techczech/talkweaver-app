export function isSafeLinkUrl(url: unknown): boolean
export function renderEmphasisEscaped(source: string): string
/** A title as plain text: inline markers dropped, link labels kept, nothing escaped. */
export function plainInlineText(text: unknown): string
/** Escaped inline HTML for **bold**, *italic*, `code`, ==mark== and links. */
export function renderInline(text: unknown): string
/** The constant markup of one key cap; `content` is raw text and is escaped here. */
export function keyCapHtml(content: string): string

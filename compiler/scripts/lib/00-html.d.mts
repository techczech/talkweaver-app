/** Escapes & < > " ' for HTML element text. null and undefined become "". */
export function escapeHtml(value: unknown): string
/** Escapes & < > " ' for an HTML attribute value. null and undefined become "". */
export function escapeAttr(value: unknown): string

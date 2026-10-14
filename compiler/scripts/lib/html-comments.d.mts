/** Every closed `<!-- … -->` blanked (its characters removed, its newlines kept); an unclosed `<!--` is left as it is. */
export function blankHtmlComments(text: unknown): string

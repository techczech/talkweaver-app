// The parts of quote-forms.mjs the app shares (src/shared/layout-verbs.ts: describe-quote-source).
export type QuoteFormName = 'plain' | 'tweet' | 'video' | 'book' | 'paper' | 'web'
export type QuoteFormDetectedBy = 'x-link' | 'youtube-link' | 'doi' | 'isbn' | 'book-reference' | 'none'
export type QuoteFormPresentation = 'card' | 'player' | 'page' | 'window' | 'panel' | 'plain'

export interface QuoteSourceLink { url: string; scheme: string; host: string; urlPath: string }
export interface QuoteSourceParsed { raw: string; link: QuoteSourceLink | null; isbn: string | null; segments: Array<{ text: string; container: string | null; article: string | null; rest: string }> }

export interface QuoteFormPlan {
  form: QuoteFormName
  chosen: boolean
  detectedBy: QuoteFormDetectedBy
  parsed: QuoteSourceParsed
  fields: Record<string, unknown> & { missing: string[] }
  /** The domain of an ordinary web link in the source line, whatever the form; null when none. */
  webLink: string | null
  /** The source line holds a DOI, whatever the form. */
  doiLink: boolean
  paragraphs: string[]
  awaiting: boolean
  picture: boolean
  /** The form has a renderer. */
  built: boolean
  /** This module draws the slide (false: today's Plain quote). */
  renders: boolean
  /** The form was chosen or found and could not fit its smallest step: it is drawn as Plain. */
  refused: boolean
  step: number
  fits: boolean
  presentation: QuoteFormPresentation
  /** One plain sentence when the form resolves to one with no renderer yet; '' otherwise. */
  note: string
}

export const QUOTE_FORM_VALUES: readonly string[]
export const BUILT_FORMS: ReadonlySet<string>
export function quoteFormLabel(form: string): string
export function unbuiltFormNote(form: string): string
export function parseSourceLine(raw: string): QuoteSourceParsed
export function sourceLinkSpan(raw: string): { index: number; length: number } | null
export function readFields(form: string, parsed: QuoteSourceParsed): Record<string, unknown> & { missing: string[] }
export function detectQuoteForm(parsed: QuoteSourceParsed): { form: QuoteFormName; detectedBy: QuoteFormDetectedBy }
export function quoteFormPlan(input: { token?: string; cite?: string; paragraphs?: readonly string[]; picture?: boolean }): QuoteFormPlan
export function countQuoteBlocks(lines: readonly string[]): number
/** Does the `form=` value name a form (Plain included; not Automatic, not an unknown word)? */
export function quoteFormIsSet(token: unknown): boolean
/** `token`: the slide's `form=` value. With a set form, the address on its own line under the quotation is read as the source line. */
export function readQuoteSlideLines(lines: readonly string[], token?: string): {
  paragraphs: string[]
  cite: string
  picture: boolean
  /** Index into the lines of the first image line (the picture), -1 when there is none. */
  pictureIndex: number
  hasQuote: boolean
  quoteEnd: number
  /** The web address on a line of its own directly under the one quotation that has no source line (`index` into the lines, `url` as typed); null otherwise. */
  address: { index: number; url: string } | null
  /** Something else paints beside the quotation (a list, paragraph, table, practice quote, fence, a second picture...), so no form is drawn. */
  otherContent: boolean
  /** `quote-dash`: the last `>` line leads with a dash; `prefix` is its `> - ` as written. `promoted-tail`: the source follows the closing quote of a quoted paragraph; `endIndex`, `prefix`, `lead` and `suffix` say how to replace it in place. */
  source: { index: number; kind: 'quote-dash'; prefix: string } | { index: number; kind: 'dash' | 'bullet' | 'address' } | { index: number; endIndex: number; kind: 'bare' } | { index: number; endIndex: number; kind: 'promoted-tail'; prefix: string; lead: string; suffix: string } | null
}

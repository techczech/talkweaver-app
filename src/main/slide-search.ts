// Per-query matching for the Slide Browser's `search:all-slides`, moved out of index.ts.
//
// Each slide row is prepared ONCE into lowercased title / body / image-text strings; a query then
// does only `includes` over prepared strings. Prepared talks are cached against the talk's
// freshness key (outline mtime + compiler tag, search-index-freshness.ts) and the identity of its
// rows array, so a talk's strings are rebuilt only when that talk's rows are. The image-text part
// is refreshed by GENERATION: the image-text index bumps a counter whenever any picture's text
// changes; the first query after a bump re-resolves the picture references of just the rows that
// name pictures (the raw references are kept, so a picture that did not exist when the talk was
// prepared - a pooled file that arrived later - is picked up) and re-derives their image string.
//
// Match semantics are those the handler had: scopes all/title/body/image, `matchHay` term logic,
// `titleHit`. The scan yields to the event loop between talks (and every few thousand rows inside
// one) and stops as soon as `shouldStop()` says the request was superseded.

import { fieldHits, matchFields, matchHay, parseQuery, prepareFields, type PreparedFields, type SlideMatchEvidence, type SlideScope } from '../shared/slide-handling/query.ts'
import { authoredPictureText, slideBodyForSearchDisplay } from '../shared/slide-handling/image-refs.ts'

export type SearchScope = SlideScope
// The structured search the renderer sends (mirrors slideBrowserModel.ParsedQuery). A bare
// string is the legacy all-fields all-words form.
export type SearchQuery = { scope: SearchScope; exact: boolean; text: string; terms: string[] }

export function normalizeSearchQuery(q: unknown): SearchQuery {
  if (typeof q === 'string') {
    const { scope, exact, text, terms } = parseQuery(q, { prefixes: false })
    if (scope === 'widget') return { scope, exact, text, terms }
    return { scope: 'all', exact: false, text: q, terms: q.toLowerCase().split(/\s+/).filter(Boolean) }
  }
  const o = (q ?? {}) as Partial<SearchQuery>
  const scope = o.scope === 'title' || o.scope === 'body' || o.scope === 'image' || o.scope === 'widget' ? o.scope : 'all'
  const text = typeof o.text === 'string' ? o.text : ''
  const terms = Array.isArray(o.terms) ? o.terms.filter((t): t is string => typeof t === 'string' && t !== '') : []
  return { scope, exact: Boolean(o.exact), text, terms }
}

// The match rule is src/shared/slide-handling/query.ts (the one search rule); re-exported for this module's callers.
export { matchHay }

export interface SlideRowText {
  nav_title?: unknown
  title?: unknown
  source_markdown?: unknown
  widget_titles?: string[]
}

/** What the search needs to know about pictures' text. */
export interface ImageTextSource {
  /** Rises whenever any picture's text changes. */
  generation(): number
  /** Lowercased text of one picture file ('' when none). */
  textLower(path: string): string
}

interface PreparedRow extends PreparedFields {
  authoredImage: string
  resolvedImage: string
  displayBody?: string
  imageRefs: readonly unknown[]
}
interface PreparedTalk {
  freshness: string
  rows: unknown
  rowsPrepared: PreparedRow[]
  imageRows: number[] // indexes of rows that name pictures
  imageGeneration: number
  resolveImages(refs: readonly unknown[]): string[]
}

export interface LoadedTalk<R extends SlideRowText> {
  /** The outline path: the cache key. */
  key: string
  /** `${outline mtime}|${compiler tag}`: changes whenever the rows are rebuilt. */
  freshness: string
  rows: R[]
  /** The picture references one row's slide shows, unresolved; called once per row per rebuild. */
  imageRefsFor(row: R): readonly unknown[]
  /** Resolve references to picture files; re-run for the rows with references when picture text changes. */
  resolveImages(refs: readonly unknown[]): string[]
}

export interface Hit<T, R extends SlideRowText> { talk: T; loaded: LoadedTalk<R>; row: R; titleHit: boolean; matchEvidence?: SlideMatchEvidence }

export interface SlideSearchOptions { imageText: ImageTextSource }

export interface SlideSearch {
  /**
   * Scan the talks in order. `load` yields each talk's rows (null skips it). Returns the hits in
   * talk order, or null when `shouldStop()` ended the scan early.
   */
  scan<T, R extends SlideRowText>(args: {
    query: SearchQuery
    talks: Iterable<T>
    load(talk: T): Promise<LoadedTalk<R> | null>
    shouldStop?(): boolean
    yieldToLoop?(): Promise<void>
    includeMatch?: boolean
  }): Promise<Array<Hit<T, R>> | null>
  /** How many times a talk's strings were built (tests). */
  prepareCount(): number
  /** How many times a row's image text was re-derived after an image-text change (tests). */
  imageRefreshCount(): number
}

const YIELD_EVERY_ROWS = 2000
const defaultYield = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

export function createSlideSearch(options: SlideSearchOptions): SlideSearch {
  const { imageText } = options
  // Keyed by the rows array: when the index drops or replaces a talk's rows, the prepared strings
  // go with them (nothing to evict). The freshness key is compared as well.
  const byRows = new WeakMap<object, PreparedTalk>()
  let prepared = 0
  let refreshed = 0

  function imageString(paths: string[]): string {
    return paths.map(path => imageText.textLower(path)).filter(Boolean).join('\n')
  }

  const combinedImageText = (authored: string, resolved: string): string =>
    authored && resolved ? [authored, resolved].join('\n') : authored || resolved

  function prepare<R extends SlideRowText>(loaded: LoadedTalk<R>): PreparedTalk {
    const existing = byRows.get(loaded.rows)
    if (existing && existing.freshness === loaded.freshness) return existing
    prepared += 1
    const generation = imageText.generation()
    const imageRows: number[] = []
    const rowsPrepared = loaded.rows.map((row, i): PreparedRow => {
      const imageRefs = loaded.imageRefsFor(row)
      const body = String(row.source_markdown || '')
      const authoredImage = authoredPictureText(body).toLowerCase()
      const resolvedImage = imageRefs.length ? imageString(loaded.resolveImages(imageRefs)) : ''
      if (imageRefs.length) imageRows.push(i)
      return {
        ...prepareFields({
          title: `${row.nav_title || ''}\n${row.title || ''}`,
          body,
          image: combinedImageText(authoredImage, resolvedImage),
          widget: row.widget_titles?.join('\n')
        }),
        authoredImage,
        resolvedImage,
        imageRefs
      }
    })
    const talk: PreparedTalk = { freshness: loaded.freshness, rows: loaded.rows, rowsPrepared, imageRows, imageGeneration: generation, resolveImages: loaded.resolveImages }
    byRows.set(loaded.rows, talk)
    return talk
  }

  function refreshImages(talk: PreparedTalk): void {
    const generation = imageText.generation()
    if (talk.imageGeneration === generation) return
    for (const i of talk.imageRows) {
      const row = talk.rowsPrepared[i]
      row.resolvedImage = imageString(talk.resolveImages(row.imageRefs))
      row.image = combinedImageText(row.authoredImage, row.resolvedImage)
      refreshed += 1
    }
    talk.imageGeneration = generation
  }

  const matches = (row: PreparedRow, q: SearchQuery): boolean => matchFields(row, q)

  return {
    async scan<T, R extends SlideRowText>({ query, talks, load, shouldStop, yieldToLoop, includeMatch }: {
      query: SearchQuery
      talks: Iterable<T>
      load(talk: T): Promise<LoadedTalk<R> | null>
      shouldStop?(): boolean
      yieldToLoop?(): Promise<void>
      includeMatch?: boolean
    }): Promise<Array<Hit<T, R>> | null> {
      const yieldNow = yieldToLoop ?? defaultYield
      const out: Array<Hit<T, R>> = []
      let sinceYield = 0
      for (const talk of talks) {
        if (shouldStop?.()) return null
        const loaded = await load(talk)
        if (loaded) {
          const p = prepare(loaded)
          p.resolveImages = loaded.resolveImages
          refreshImages(p)
          const rows = loaded.rows
          for (let i = 0; i < rows.length; i++) {
            const pr = p.rowsPrepared[i]
            if (matches(pr, query)) {
              const titleHit = query.scope === 'title' || (query.scope !== 'widget' && matchHay(pr.title, query))
              const row = rows[i]
              const hit: Hit<T, R> = { talk, loaded, row, titleHit }
              if (includeMatch) {
                pr.displayBody ??= slideBodyForSearchDisplay(pr.body)
                const fields = fieldHits({ title: pr.title, body: pr.displayBody, image: pr.image, widget: pr.widget }, query)
                const resolvedPictureText = fields.picture && fieldHits({ title: '', body: '', image: pr.resolvedImage }, query).picture
                  ? pr.resolvedImage : undefined
                hit.matchEvidence = { fields, resolvedPictureText }
              }
              out.push(hit)
            }
            if (++sinceYield >= YIELD_EVERY_ROWS) {
              sinceYield = 0
              await yieldNow()
              if (shouldStop?.()) return null
            }
          }
        }
        await yieldNow()
      }
      return out
    },
    prepareCount: () => prepared,
    imageRefreshCount: () => refreshed
  }
}

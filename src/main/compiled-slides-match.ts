import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

type CompiledDeck = { thumbnailHashes?: unknown; fullHtml?: unknown }

/** The hashes cover the rendered sections and deck shell. The companions travel separately. */
export async function loadCompiledSlidesSignature(compilerDir: string): Promise<(deck: CompiledDeck) => string | null> {
  // These readers import compiler code that loads assets relative to its own module on disk.
  const [{ extractSlideScript }, { extractQuoteSources }] = await Promise.all([
    import(pathToFileURL(join(compilerDir, 'lib/04-html-extraction.mjs')).href) as Promise<typeof import('../../compiler/scripts/lib/04-html-extraction.mjs')>,
    import(pathToFileURL(join(compilerDir, 'lib/quote-forms-static.mjs')).href) as Promise<typeof import('../../compiler/scripts/lib/quote-forms-static.mjs')>
  ])
  return ({ thumbnailHashes, fullHtml }) => {
    if (!Array.isArray(thumbnailHashes) || !thumbnailHashes.length ||
        !thumbnailHashes.every(hash => typeof hash === 'string') ||
        typeof fullHtml !== 'string' || !fullHtml) return null
    return JSON.stringify([thumbnailHashes, extractSlideScript(fullHtml), extractQuoteSources(fullHtml)])
  }
}

import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { extractSlides, extractStyles } from '../compiler/scripts/lib/04-html-extraction.mjs'
import { buildShareHtml } from '../compiler/scripts/lib/09-output-builders.mjs'

const repo = resolve(new URL('..', import.meta.url).pathname)
const scratch = mkdtempSync(join(repo, '.tw-mermaid-embed-'))
const vendorMarker = 'BEGIN VENDOR mermaid@11.16.0'

async function compile(name, body) {
  const path = join(scratch, `${name}-outline.md`)
  const source = [
    '---',
    `title: ${name}`,
    'auto_title_slide: false',
    'auto_thanks_slide: false',
    '---',
    '',
    '### Slide',
    '',
    body
  ].join('\n')
  writeFileSync(path, source)
  return prepareSource(path, source, name, statSync(path))
}

try {
  const plain = await compile('plain', 'No diagrams here.')
  const mermaid = await compile('mermaid', '```mermaid\nflowchart LR\n  A --> B\n```')
  assert(!plain.fullHtml.includes(vendorMarker), 'mermaid-free deck omits the vendor payload')
  assert(mermaid.fullHtml.includes(vendorMarker), 'mermaid-bearing deck includes the vendor payload')

  const handoutFor = (model) => buildShareHtml({
    title: model.title,
    slides: extractSlides(model.fullHtml),
    styles: extractStyles(model.fullHtml),
    includeNotes: false,
    slug: model.title,
    license: null
  })
  assert(!handoutFor(plain).includes(vendorMarker), 'mermaid-free handout omits the vendor payload')
  assert(handoutFor(mermaid).includes(vendorMarker), 'mermaid-bearing handout includes the vendor payload')
  console.log('Mermaid vendor embedding: absent from plain deck/handout; present in Mermaid deck/handout')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

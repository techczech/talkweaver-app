// Quote slides must render exactly as before unless they gain a form (quote forms, ticket 01).
// This helper compiles outlines and returns a sha256 of every quote-layout slide's HTML section,
// keyed `<file>#<slide id>`. `scripts/fixtures/quote-forms/quote-slide-hashes.json` holds the hashes
// recorded from the compiler as it was BEFORE quote forms (git HEAD of the ticket's base); the test
// compares the live compiler to them.
//
// Record (once, from the base commit's compiler, in a scratch folder that holds an untouched copy):
//   node scripts/quote-slide-baseline.mjs --record <root holding compiler/ and the outlines> > hashes.json
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const BASELINE_OUTLINES = [
  'docs/layout-sampler-outline.md',
  'docs/design-showcase-outline.md'
]

function demoVaultOutlines(root) {
  const base = join(root, 'demo-vault')
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) { if (entry.name !== 'assets') walk(path) }
      else if (entry.name.endsWith('-outline.md')) found.push(relative(root, path))
    }
  }
  try { walk(base) } catch { /* no demo vault in this root */ }
  return found.sort()
}

/** sha256 per quote-layout slide section across the sampler, the showcase and every demo-vault outline. */
export async function quoteSlideHashes(root, { compilerRoot = root } = {}) {
  const { prepareSource } = await import(pathToFileURL(join(compilerRoot, 'compiler/scripts/lib/08-source-adapters.mjs')).href)
  const { buildDeckHtmlFromModel } = await import(pathToFileURL(join(compilerRoot, 'compiler/scripts/lib/07-assembly.mjs')).href)
  const out = {}
  for (const file of [...BASELINE_OUTLINES, ...demoVaultOutlines(root)]) {
    const path = resolve(root, file)
    let text
    try { text = readFileSync(path, 'utf8') } catch { continue }
    const model = await prepareSource(path, text, 'Quote baseline', statSync(path), undefined, {
      allowedAssetRoots: [dirname(path), join(root, 'e2e/fixtures')]
    })
    const html = await buildDeckHtmlFromModel(model)
    const quoteIds = new Set(model.slides.filter((slide) => slide.layout === 'quote' || slide.layout === 'image-quote').map((slide) => slide.id))
    for (const match of html.matchAll(/<section class="slide[^"]*" data-id="([^"]+)"[\s\S]*?<\/section>/g)) {
      if (!quoteIds.has(match[1])) continue
      // Asset references resolve to absolute paths under the folder the outline sits in: name the root, not the machine.
      const section = match[0].split(root).join('<root>').split(encodeURI(root)).join('<root>').split(pathToFileURL(root).href).join('<root>')
      out[`${file}#${match[1]}`] = createHash('sha256').update(section).digest('hex')
    }
  }
  return out
}

if (import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === '--record') {
  const root = resolve(process.argv[3])
  console.log(JSON.stringify(await quoteSlideHashes(root), null, 1))
}

import { strict as assert } from 'node:assert'
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
const scratch = mkdtempSync(join(tmpdir(), '.tw-packaged-layout-'))
const resources = join(scratch, 'TalkWeaver.app', 'Contents', 'Resources')
const compiler = join(resources, 'compiler')

function filesBelow(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? filesBelow(path) : [path]
  })
}

try {
  cpSync(join(repo, 'compiler'), compiler, { recursive: true })

  // Packaged compiler modules may use relative files and Node built-ins only. This static half of
  // the gate prevents an in-repo node_modules directory from masking a bare dependency during CI.
  for (const file of filesBelow(compiler).filter((path) => path.endsWith('.mjs'))) {
    const source = readFileSync(file, 'utf8')
    const specs = [
      ...source.matchAll(/(?:^|\n)\s*import\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g),
      ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
      ...source.matchAll(/\bexport\s+(?:\*\s*(?:as\s+\w+\s*)?|\{[^}]*\})\s+from\s+["']([^"']+)["']/g),
      ...source.matchAll(/\bcreateRequire\s*\([^)]*\)\s*\(\s*["']([^"']+)["']\s*\)/g)
    ].map((match) => match[1])
    for (const spec of specs) {
      assert(
        spec.startsWith('.') || spec.startsWith('node:'),
        `packaged compiler module ${file.slice(compiler.length + 1)} has bare import ${spec}`
      )
      assert(!spec.includes('/src/'), `packaged compiler module imports repository src path ${spec}`)
    }
  }

  const outlinePath = join(scratch, 'packaged-layout-outline.md')
  const outline = [
    '---',
    'title: Packaged layout',
    'auto_title_slide: false',
    'auto_thanks_slide: false',
    '---',
    '',
    '### Clean SVG',
    '',
    '```svg',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>',
    '```',
    '',
    '### Hostile SVG',
    '',
    '```svg',
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '```'
  ].join('\n')
  writeFileSync(outlinePath, outline)

  const { prepareSource } = await import(
    pathToFileURL(join(compiler, 'scripts', 'lib', '08-source-adapters.mjs')).href
  )
  const model = await prepareSource(
    outlinePath,
    outline,
    'packaged-layout',
    statSync(outlinePath)
  )
  assert.match(model.fullHtml, /<figure class="slide-svg"><svg\b/, 'clean SVG renders')
  assert.match(model.fullHtml, /<pre class="svg-error-source">/, 'hostile SVG shows source')
  assert.match(model.fullHtml, /<div class="svg-error">/, 'hostile SVG shows the visible error')
  assert(!model.fullHtml.includes('<script>alert(1)</script>'), 'hostile SVG never leaks as markup')

  console.log('packaged compiler layout: standalone 08-source-adapters load, clean SVG render, hostile SVG rejection PASS')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

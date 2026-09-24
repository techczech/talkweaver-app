import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const importerPath = new URL('../src/renderer/src/components/Importer.tsx', import.meta.url)
assert.equal(existsSync(importerPath), true, 'Importer component must exist')
const importer = readFileSync(importerPath, 'utf8')
const app = readFileSync(new URL('../src/renderer/src/App.tsx', import.meta.url), 'utf8')

for (const contract of [
  'Choose PowerPoint files', 'Choose a folder', 'Choose destination', 'Import into TalkWeaver', 'Inspection Bench', 'Original PowerPoint',
  'TalkWeaver target', 'Rendering preview', 'Agent cleanup', 'importer.preparePack', 'importer.onProgress'
]) assert.match(importer, new RegExp(contract), `Importer UI is missing ${contract}`)

assert.match(importer, /importer\.chooseSources/)
assert.match(importer, /importer\.chooseDestination/)
assert.match(importer, /talk\.selectedThumbnail/)
assert.doesNotMatch(importer, /talk\.compile/)
assert.doesNotMatch(importer, /talk\.thumbnails/)
assert.match(importer, /IMPORT_LAYOUT_CHOICES/)
assert.doesNotMatch(importer, /\['auto', 'statement', 'list', 'media'/)
assert.match(importer, /<optgroup/)

for (const label of ['Add more files', 'Replace selection']) {
  assert.match(importer, new RegExp(label), `Importer UI is missing ${label}`)
}
assert.match(importer, /appendImportSources/)
assert.match(importer, /chooseSources\('files', 'append'\)/)
assert.match(importer, /chooseSources\('files', 'replace'\)/)

for (const label of ['Default ·', 'Choose folder', 'Reset to default']) {
  assert.match(importer, new RegExp(label), `Importer UI is missing ${label}`)
}
assert.match(importer, /effectiveImportDestination/)
assert.match(importer, /importRequestsForBatch/)
assert.match(importer, /aria-label=\{`Choose destination for \$\{source\.fileName\}`\}/)
assert.match(importer, /aria-label=\{`Reset destination for \$\{source\.fileName\} to default`\}/)

assert.match(app, /'importer'/, 'Tools shell must route the Importer view')
assert.match(app, /<Importer/, 'Tools shell must render Importer')

console.log('importer ui: source, progress, inspection and cleanup surfaces passed')

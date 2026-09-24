import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { inspectPptxSources, pptxFilesInFolder } from '../src/main/importer/ipc.ts'

const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8')
const ipc = readFileSync(new URL('../src/main/importer/ipc.ts', import.meta.url), 'utf8')
const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')

for (const method of [
  'capabilities', 'chooseSources', 'chooseDestination', 'start', 'resume', 'listRuns', 'getRun', 'updateSlide', 'resetSlide', 'preparePack',
  'listSuggestions', 'applySuggestion', 'getSettings', 'setSettings', 'revealRun', 'originalDataUrl', 'onProgress'
]) {
  assert.match(preload, new RegExp(`\\b${method}:`), `preload importer bridge is missing ${method}`)
}

for (const channel of [
  'importer:capabilities', 'importer:choose-sources', 'importer:choose-destination', 'importer:start', 'importer:resume', 'importer:list-runs', 'importer:get-run',
  'importer:update-slide', 'importer:reset-slide', 'importer:prepare-pack',
  'importer:list-suggestions', 'importer:apply-suggestion', 'importer:get-settings',
  'importer:set-settings', 'importer:reveal-run', 'importer:original-data-url'
]) {
  assert.match(ipc, new RegExp(`['"]${channel}['"]`), `main importer IPC is missing ${channel}`)
}

assert.match(preload, /ipcRenderer\.on\('importer:progress'/)
assert.match(preload, /removeListener\('importer:progress'/)
assert.match(preload, /selectedThumbnail:/)
assert.match(preload, /talk:selected-thumbnail/)
assert.match(main, /ipcMain\.handle\('talk:selected-thumbnail'/)
assert.match(ipc, /insideVault/)
assert.match(ipc, /multiSelections/)
assert.match(ipc, /openDirectory/)

const inspected = await inspectPptxSources(['/decks/good.pptx', '/decks/broken.pptx'], async (path) => {
  if (path.includes('broken')) throw new Error('invalid package')
  return { path, fileName: 'good.pptx', hash: 'a'.repeat(64), bytes: 10, slideCount: 2, width: 100, height: 50 }
})
assert.deepEqual(inspected.sources.map((source) => source.fileName), ['good.pptx'])
assert.deepEqual(inspected.errors, [{ path: '/decks/broken.pptx', message: 'invalid package' }])
assert.deepEqual(pptxFilesInFolder('/path/that/does/not/exist'), [])

console.log('importer ipc: typed preload methods and validated main channels passed')

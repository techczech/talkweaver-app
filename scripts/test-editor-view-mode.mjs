// test:editor-view-mode — the Plain / Markdown setting (plain editing view, spec T3).
// Unset means Plain; the stored value is read back through the same config file the main process
// uses; anything that is not one of the two names reads as Plain.
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EDITOR_VIEW_MODE_KEY, editorViewModeFrom } from '../src/shared/editor-view-mode.ts'
import { createConfigFile } from '../src/main/config-file.ts'
import { COMMAND_REGISTRY } from '../src/shared/command-registry.ts'

assert.equal(EDITOR_VIEW_MODE_KEY, 'editorViewMode')
assert.equal(editorViewModeFrom(undefined), 'plain', 'unset is Plain')
assert.equal(editorViewModeFrom(null), 'plain')
assert.equal(editorViewModeFrom('sideways'), 'plain', 'junk is Plain')
assert.equal(editorViewModeFrom(3), 'plain')
assert.equal(editorViewModeFrom('plain'), 'plain')
assert.equal(editorViewModeFrom('markdown'), 'markdown')

const dir = mkdtempSync(join(tmpdir(), 'talk-weaver-editor-view-mode-'))
try {
  const file = createConfigFile(join(dir, 'config.json'))
  assert.equal(editorViewModeFrom(file.read()[EDITOR_VIEW_MODE_KEY]), 'plain', 'fresh config: Plain')
  file.write({ vaultName: 'kept' })
  assert.equal(editorViewModeFrom(file.read()[EDITOR_VIEW_MODE_KEY]), 'plain', 'other keys do not set it')
  file.write({ [EDITOR_VIEW_MODE_KEY]: 'markdown' })
  assert.equal(editorViewModeFrom(createConfigFile(join(dir, 'config.json')).read()[EDITOR_VIEW_MODE_KEY]), 'markdown', 'survives a new reader (restart)')
  assert.equal(file.read().vaultName, 'kept', 'other keys survive')
  file.write({ [EDITOR_VIEW_MODE_KEY]: 'plain' })
  assert.equal(editorViewModeFrom(file.read()[EDITOR_VIEW_MODE_KEY]), 'plain')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

// ADR-0045 promotes the editor modes into the four named workspace views.
for (const [id, label, shortcutId] of [
  ['view-slides', 'View: Slide', 'app.view-slides'],
  ['view-grid', 'View: Grid', 'app.view-grid'],
  ['view-plain', 'View: Outline', 'app.view-plain'],
  ['view-markdown', 'View: Markdown', 'app.view-markdown']
]) {
  const c = COMMAND_REGISTRY.find((x) => x.id === id)
  assert.ok(c, id + ' is registered')
  assert.equal(c.label, label)
  assert.equal(c.shortcutId, shortcutId)
  assert.ok(c.palette.visible)
}
assert.equal(COMMAND_REGISTRY.find(c => c.id === 'view-strip').shortcutId, undefined)
console.log('editor view mode: ok')

// Browser's additive/offscreen picks and Organizer's edit-following focus, using the real hooks.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
const dir = mkdtempSync(join(process.cwd(), '.test-slide-selection-'))
const dom = new JSDOM('<div id="root"></div>')
for (const key of ['window', 'document', 'HTMLElement', 'Node']) Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] })
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let checks = 0
const check = (fn) => { fn(); checks++ }
const host = createRoot(document.getElementById('root'))
try {
  const bundle = join(dir, 'bundle.mjs')
  await build({ stdin: { contents: "export { default as SearchPalette } from './src/renderer/src/components/SearchPalette.tsx'; export { useSelection } from './src/renderer/src/components/slide-browser/useSelection.ts'; export { useSlideSelection } from './src/renderer/src/lib/useSlideSelection.ts'; export { rowAfterEdit } from './src/renderer/src/lib/activeOutlineLine.ts'", resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], outfile: bundle, logLevel: 'silent' })
  const { SearchPalette, useSelection, useSlideSelection, rowAfterEdit } = await import(pathToFileURL(bundle).href)
  let browser
  const fullRows = ['a', 'b', 'c', 'd'].map((id, i) => ({ talkSlug: 'talk', slide_id: id, section: i < 2 ? 'One' : 'Two', order: i, source_line: i + 1, source_markdown: (i % 2 === 0 ? '## ' : '### ') + id, outlinePath: '/v/t/t-outline.md' }))
  function Browser({ visible = fullRows }) { browser = useSelection({ vRows: visible, activePos: 0, rowsByTalk: new Map([['talk', fullRows]]), fullRows }); return null }
  const mount = async element => act(async () => { host.render(element) })
  await mount(React.createElement(Browser))
  await act(async () => { browser.toggleAt(3); browser.setAnchor(0); browser.extendTo(1) })
  check(() => assert.deepEqual([...browser.selected].sort(), ['talk:a', 'talk:b', 'talk:d'], 'Browser range adds to the existing picks'))
  await mount(React.createElement(Browser, { visible: [fullRows[0]] }))
  check(() => assert.deepEqual(browser.selectedRows.map(r => r.slide_id), ['a', 'b', 'd'], 'offscreen picks remain in the tray'))
  await act(async () => { browser.clearSelection(); browser.selectWholeSection('talk', 'Two') })
  check(() => assert.deepEqual([...browser.selected].sort(), ['talk:c', 'talk:d'], 'whole section includes hidden rows'))
  await act(async () => { browser.clearSelection() })
  check(() => assert.equal(browser.selected.size, 0))
  await mount(React.createElement(Browser, { visible: [fullRows[0], fullRows[1], fullRows[2], fullRows[0], fullRows[3]] }))
  await act(async () => { browser.toggleAt(3); browser.extendTo(4) })
  check(() => assert.deepEqual([...browser.selected].sort(), ['talk:a', 'talk:d'], 'range anchors at the clicked duplicate occurrence'))
  await act(async () => { browser.clearSelection(); browser.setAnchor(3); browser.extendTo(4) })
  check(() => assert.deepEqual([...browser.selected].sort(), ['talk:a', 'talk:d'], 'keyboard anchor also retains its duplicate occurrence'))
  const regressions = []
  await mount(React.createElement(Browser))
  await act(async () => { browser.toggleAt(2); browser.clearSelection(); browser.extendTo(3) })
  try { check(() => assert.deepEqual([...browser.selected].sort(), ['talk:c', 'talk:d'], 'Browser clear retains the clicked range anchor')) } catch (e) { regressions.push(e) }
  globalThis.requestAnimationFrame = (fn) => { fn(); return 0 }
  dom.window.HTMLElement.prototype.attachEvent = () => {}
  dom.window.HTMLElement.prototype.detachEvent = () => {}
  dom.window.HTMLElement.prototype.scrollIntoView = () => {}
  window.tw = { vault: { listTalks: async () => [] }, search: { allSlides: async () => fullRows }, talk: {} }
  await mount(React.createElement(SearchPalette, { isOpen: true, onClose() {}, onInsert() {} }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
  const click = async (el, shiftKey = false) => act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, shiftKey })) })
  const paletteRows = () => [...document.querySelectorAll('li[data-active]')]
  await click(paletteRows()[2])
  await click([...document.querySelectorAll('button')].find(b => b.textContent === 'Clear'))
  await click(paletteRows()[3], true)
  try { check(() => assert.deepEqual(paletteRows().map((r, i) => r.dataset.selected === 'true' ? i : null).filter(i => i !== null), [2, 3], 'palette Clear retains the clicked range anchor')) } catch (e) { regressions.push(e) }
  assert.deepEqual(regressions, [], 'clear-then-extend regressions')
  let selection
  function Focus({ rows }) { selection = useSlideSelection(rows.map(r => r.id ?? r.text), { focusRows: rows, focusAfterEdit: rowAfterEdit }); return null }
  const before = [{ line: 1, text: 'Title' }, { line: 3, text: 'A' }, { line: 6, text: 'B' }]
  await mount(React.createElement(Focus, { rows: before }))
  await act(async () => { selection.reset(1) })
  await mount(React.createElement(Focus, { rows: before.map((r, i) => i === 1 ? { ...r, text: 'Renamed' } : r) }))
  check(() => assert.equal(selection.focusedIndex, 1, 'id-less retitle retains Organizer focus as before'))
  await mount(React.createElement(Focus, { rows: [before[0], before[2], { line: 9, text: 'Renamed' }] }))
  check(() => assert.equal(selection.focusedIndex, 2, 'focus follows the renamed row through a move'))
  await mount(React.createElement(Focus, { rows: [before[0], before[2]] }))
  check(() => assert.equal(selection.focusedIndex, null, 'deleted row drops focus'))
  await act(async () => { selection.toggle(0); selection.toggleMany([0, 1]) })
  check(() => assert.deepEqual(selection.indices, [0, 1], 'partial section adds all'))
  await act(async () => { selection.toggleMany([0, 1]) })
  check(() => assert.deepEqual(selection.indices, [], 'selected section clears all'))
  await act(async () => { selection.reset(1); selection.clear(); selection.extendTo(1, 0) })
  check(() => assert.deepEqual(selection.indices, [0, 1], 'default clear drops the anchor for other authoring surfaces'))
  check(() => assert.equal(selection.focusedIndex, null, 'default clear drops focus'))
  console.log(`${checks} selection surface checks passed`)
} finally {
  await act(async () => host.unmount())
  dom.window.close()
  rmSync(dir, { recursive: true, force: true })
}

// Full workspace, real CodeMirror history and compiler projections, fake preload transport.
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildPerSlideProjections } from '../compiler/scripts/lib/10-projections.mjs'
import { preferredIdsFromText, stampMissingIds } from '../compiler/scripts/lib/12-outline-edit.mjs'

const root = join(import.meta.dirname, '..')
const scratch = mkdtempSync(join(tmpdir(), 'tw-right-panel-dom-'))
const outline = join(scratch, 'garden-outline.md')
const source = [
  '---', 'outline_version: 2', 'title: Garden meeting', 'auto_title_slide: false', 'auto_thanks_slide: false', '---',
  '', '## In the garden {id=g1}', '', '### Priorities {id=p1}', '', '- Repair the beds',
  '', '### Volunteer shifts {id=p2}', '', '- Monday', '', '### Garden photographs {id=p3}',
  '', '- The garden at the start of the year', '', '![The beds](beds.png)', ''
].join('\n')
writeFileSync(outline, source)
copyFileSync(join(root, 'demo-vault/layout-sampler/assets/sample-image.png'), join(scratch, 'beds.png'))

let browser
try {
  await build({
    stdin: {
      contents: `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { installMock } from './src/renderer/src/tw-mock.ts'
import WorkspaceLayout from './src/renderer/src/components/WorkspaceLayout.tsx'
import './src/renderer/src/styles.css'
import './src/renderer/src/guide.css'
import './src/renderer/src/image-drawer.css'
installMock()
const empty = () => () => {}
Object.assign(window.tw.talk, {
  readOutline: () => window.readFixture(),
  writeOutline: (_path, text) => window.writeFixture(text),
  compile: async (_path, text) => {
    const rows = await window.compileFixture(text)
    window.compiledFixture = text
    return rows
  },
  layoutVariantThumbnail: async () => null,
  onOutlineChangedOnDisk: empty,
})
window.tw.slide.renderPreview = async () => 'about:blank'
window.tw.workFiles = { list: async () => null }
window.tw.icons = { names: async () => [], svg: async () => null, search: async () => [] }
window.editorView = () => EditorView.findFromDOM(document.querySelector('.cm-editor'))
function Fixture({ path, outlinePath }) {
  const [slideTabView, setSlideTabView] = useState('pages')
  return <div className="app-shell"><WorkspaceLayout activeTalk={{ name: 'Garden', path, outlinePath, slug: 'garden', title: 'Garden meeting' }}
    vaultRoot={path} slideTabView={slideTabView} onChooseSlideTabView={setSlideTabView} /></div>
}
window.mountFixture = props => createRoot(document.getElementById('root')).render(<Fixture {...props} />)
`,
      sourcefile: 'right-panel-fixture.tsx', loader: 'tsx', resolveDir: root
    },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { __TW_SECURITY_TEST__: 'false', 'import.meta.env.DEV': 'false' },
    outfile: join(scratch, 'fixture.js'), logLevel: 'warning'
  })
  const html = join(scratch, 'fixture.html')
  writeFileSync(html, '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
  browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--disable-overlay-scrollbar'] })
  const page = await browser.newPage({ viewport: { width: 1000, height: 631 } })
  await page.route(/^https?:/, route => route.abort())
  const errors = []
  page.on('pageerror', error => { errors.push(error.message); console.error(error) })
  page.setDefaultTimeout(12000)
  await page.exposeFunction('readFixture', () => readFileSync(outline, 'utf8'))
  await page.exposeFunction('writeFixture', text => {
    const { text: stamped } = stampMissingIds(text, undefined, { preferred: preferredIdsFromText(readFileSync(outline, 'utf8')) })
    writeFileSync(outline, stamped)
    return { ok: true, content: stamped }
  })
  await page.exposeFunction('compileFixture', async text =>
    buildPerSlideProjections(await prepareSource(outline, text, 'Garden meeting', statSync(outline)), 'garden'))
  await page.goto(pathToFileURL(html).href)
  await page.evaluate(props => window.mountFixture(props), { path: scratch, outlinePath: outline })

  const inspector = page.locator('.tw-inspector')
  const title = inspector.locator('.tw-right-who strong')
  const next = inspector.getByRole('button', { name: 'Next slide', exact: true })
  const targetName = 'Garden photographs'
  await title.filter({ hasText: /In the garden|Priorities/ }).waitFor()
  for (let clicks = 0; clicks < 4 && (await title.innerText()) !== targetName; clicks++) await next.click()
  assert.equal(await title.innerText(), targetName)
  const home = inspector.locator('.tw-right-adjust')
  const pictureButton = home.getByRole('button', { name: /^Picture\b/ })
  const picture = inspector.locator('[data-section="picture"]')
  const right = picture.getByRole('button', { name: /On the right$/ })
  const left = picture.getByRole('button', { name: /On the left$/ })
  const waitForBuffer = text => page.waitForFunction(expected => window.editorView()?.state.doc.toString() === expected, text)
  await pictureButton.click()
  await right.click()
  await page.waitForFunction(() => {
    const text = window.editorView()?.state.doc.toString()
    return text === window.compiledFixture && text.includes('### Volunteer shifts\n{id=p2}') && /\{[^\n]*image=right/.test(text)
  })
  const changed = readFileSync(outline, 'utf8')
  assert.notEqual(changed, source)
  assert.equal(await title.innerText(), targetName)
  assert.equal(await right.getAttribute('aria-pressed'), 'true')
  await page.locator('.tw-right-bar').getByRole('button', { name: 'Undo', exact: true }).click()
  await waitForBuffer(source)
  await page.waitForFunction(text => window.compiledFixture === text, source)
  assert.equal(await title.innerText(), targetName)
  assert.equal(await left.getAttribute('aria-pressed'), 'true')
  await page.waitForFunction(async text => await window.readFixture() === text, source)
  await inspector.focus()
  await page.keyboard.press('Meta+Shift+Z')
  await waitForBuffer(changed)
  await page.waitForFunction(text => window.compiledFixture === text, changed)
  assert.equal(await title.innerText(), targetName)
  assert.equal(await right.getAttribute('aria-pressed'), 'true')
  console.log('First Picture edit: the save relocates heading IDs, Undo restores the original bytes and Redo restores the saved bytes, both on Picture.')

  // Escape still belongs to CodeMirror when its search panel has focus.
  const editor = page.locator('.cm-content')
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await editor.focus()
  await page.keyboard.press(mod + '+f')
  const search = page.locator('.cm-search')
  await search.waitFor()
  await page.keyboard.press('Escape')
  await search.waitFor({ state: 'hidden' })
  await picture.waitFor()
  await right.focus()
  await page.keyboard.press('Escape')
  await pictureButton.waitFor()
  await picture.waitFor({ state: 'hidden' })

  // A click on a page's entry removes its button. Escape still works immediately.
  await pictureButton.click()
  await page.keyboard.press('Escape')
  await pictureButton.waitFor()

  // Escape from the options menu and the panel's icon picker returns to the same home.
  await pictureButton.click()
  const menu = page.getByRole('button', { name: 'Panel options', exact: true })
  await menu.click()
  const longList = page.getByRole('button', { name: 'One long list', exact: true })
  await longList.waitFor()
  await page.keyboard.press('Escape')
  assert.equal(await menu.getAttribute('aria-expanded'), 'false')
  await pictureButton.waitFor()
  assert.equal(await menu.evaluate(element => element === document.activeElement), true)
  await home.getByRole('button', { name: /^Title\b/ }).click()
  await inspector.getByRole('button', { name: 'Choose an icon', exact: true }).click()
  const iconSearch = inspector.getByRole('textbox', { name: 'Search icons', exact: true })
  await iconSearch.focus()
  await page.keyboard.press('Escape')
  await iconSearch.waitFor({ state: 'hidden' })
  await pictureButton.waitFor()
  console.log('Escape returns to Slide home from a page, panel options and icon picker. Editor search still handles its own Escape.')

  // startView='outline' is the new-talk Sketch entry. Here the author is switching an open talk.
  await page.getByTestId('outline-toggle').click()
  await inspector.locator('.tw-inspector-stage').waitFor()
  await pictureButton.click()
  const pane = inspector.locator('.tw-inspector-pane')
  const geometry = () => pane.evaluate(element => {
    const tiles = element.querySelector('[data-section="picture"] .tw-right-pictures').getBoundingClientRect()
    const copy = element.querySelector('[data-section="picture"] .tw-right-copy').getBoundingClientRect()
    const preview = element.closest('.tw-inspector').querySelector('.tw-inspector-stage').getBoundingClientRect()
    return { left: tiles.left - preview.left, right: preview.right - tiles.right, copy: [copy.x, copy.y], gutter: element.offsetWidth - element.clientWidth,
      scrolls: element.scrollHeight > element.clientHeight }
  })
  await pane.evaluate(element => { element.scrollTop = 0 })
  const overflow = await geometry()
  assert.equal(overflow.scrolls, true, 'the full Picture page overflows at 1000x631')
  assert.ok(Math.abs(overflow.left) <= 1 && Math.abs(overflow.right) <= 1, JSON.stringify(overflow))

  // Model a short options page while measuring the same rendered Copy button.
  await picture.evaluate(section => {
    for (const child of section.children) {
      if (!child.classList.contains('tw-right-page-head')) child.style.display = 'none'
    }
  })
  const fit = await geometry()
  assert.equal(fit.scrolls, false, 'the short options page fits')
  assert.equal(fit.gutter, 6, JSON.stringify(fit))
  assert.deepEqual(overflow.copy, fit.copy)
  assert.deepEqual(errors, [])
  console.log(`1000x631: tile edges align with the preview, with a ${fit.gutter}px gutter and 0px Copy movement as overflow appears.`)
} finally {
  await browser?.close()
  rmSync(scratch, { recursive: true, force: true })
}

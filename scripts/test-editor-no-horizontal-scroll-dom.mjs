// Real workspace and CodeMirror, with a synthetic talk and a fake preload bridge.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildPerSlideProjections } from '../compiler/scripts/lib/10-projections.mjs'
import { markSlidePreviewHtml } from '../src/shared/slide-preview.ts'

const root = join(import.meta.dirname, '..')
const dir = mkdtempSync(join(tmpdir(), 'tw-editor-width-'))
const outlinePath = join(dir, 'width-outline.md')
const longWord = 'abcdefghijklmnop'.repeat(28)
const title = 'Ideas as experiments for teams who want to see how much can fit on the same line'
const image = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="480"><rect width="2400" height="480" fill="#367ca6"/><circle cx="1200" cy="240" r="140" fill="#fbd574"/></svg>').toString('base64')
const columns = Array.from({ length: 12 }, (_, i) => 'Column ' + (i + 1))
const tableRow = cells => '| ' + cells.join(' | ') + ' |'
const source = [
  '---', 'outline_version: 2', 'title: ' + title, 'auto_title_slide: false', 'auto_thanks_slide: false', '---',
  '', '# ' + title, '', '## Getting to know each other {id=welcome}',
  '', '<!-- from: ' + longWord + ' -->',
  '', '### Checking very long text and wide media in the same slide {id=wide}',
  '', '- A long point that needs several lines at this width. ' + title,
  '', '- https://example.test/' + longWord,
  '', tableRow(columns), tableRow(columns.map(() => '---')), tableRow(columns.map(() => 'Wide value')),
  '', '![A wide picture](data:image/svg+xml;base64,' + image + ')',
  '', '~~~javascript', 'const id = "' + longWord + '"', '~~~',
  '', ':::notes', 'A note with a long identifier ' + longWord, ':::',
  '', '### A timeline of tools {id=timeline}',
  '{iconrow}', '', '- Tools',
  '  - **Capabilities in a wider range of projects:** prepare notes, share drafts, organise a whole folder of reference material, and check the result against the original.',
  '  - **Outcomes for the whole group:** make a short demonstration available, capture a record of the decisions, and write up what the next person needs to know.',
  ''
].join('\n')
const shots = process.env.TW_EDITOR_WIDTH_LOOK
let browser
try {
  writeFileSync(outlinePath, source)
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
import './src/renderer/src/lib/appTheme.ts'

installMock()
Object.assign(window.tw.talk, {
  readOutline: async () => window.fixtureText,
  compile: async () => window.fixtureRows,
  thumbnails: async () => null,
  layoutVariantThumbnail: async (_path, text, slide, _layout, _options, key) => {
    if (!key?.startsWith('panel:design:')) return null
    const section = window.fixtureRows.find(row => row.slide_id === 'welcome')
    if (slide !== section.slide_id && slide?.headingLine !== section.source_line) return null
    return window.sectionPicture(text)
  },
  onOutlineChangedOnDisk: () => () => {}
})
window.tw.slide.renderPreview = async () => new URL('preview.html', location.href).href
window.tw.workFiles = { list: async () => null }
window.tw.icons = { names: async () => [], svg: async () => null, search: async () => [] }
function Fixture({ path, outlinePath }) {
  const [left, showLeft] = useState(true)
  const [host, setHost] = useState(null)
  window.showLeft = showLeft
  return <div className="app-shell">
    {left ? <div className="sidebar-wrap" data-sidebar data-slides-mode="outline" ref={setHost}
      style={{ width: 'min(400px, 28vw)' }} /> : <div className="sidebar-rail" />}
    <WorkspaceLayout activeTalk={{ name: 'Width fixture', path, outlinePath, slug: 'width', title: 'Width fixture' }}
      vaultRoot={path} defaultView="outline" leftSidebarShown={left} leftPreviewsHost={left ? host : null} slidesPanelView="outline" />
  </div>
}
window.mountFixture = ({ text, rows, ...props }) => {
  window.fixtureText = text
  window.fixtureRows = rows
  localStorage.setItem('tw-right-width', '900')
  createRoot(document.getElementById('root')).render(<Fixture {...props} />)
}
window.jumpEditor = excerpt => {
  const view = EditorView.findFromDOM(document.querySelector('.cm-editor'))
  const pos = view.state.doc.toString().indexOf(excerpt)
  if (pos < 0) throw new Error('Unknown fixture excerpt: ' + excerpt)
  view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
}
`,
      loader: 'tsx', resolveDir: root
    },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { __TW_SECURITY_TEST__: 'false', 'import.meta.env.DEV': 'false' },
    outfile: join(dir, 'fixture.js'), logLevel: 'warning'
  })
  const model = await prepareSource(outlinePath, source, title, statSync(outlinePath))
  const rows = buildPerSlideProjections(model, 'width')
  writeFileSync(join(dir, 'preview.html'), markSlidePreviewHtml(model.fullHtml))
  const html = join(dir, 'fixture.html')
  writeFileSync(html, '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
  if (shots) mkdirSync(shots, { recursive: true })
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1000, height: 631 } })
  page.setDefaultTimeout(10000)
  const errors = []
  const variantRequests = []
  let releasePictures
  const picturesReady = new Promise(resolve => { releasePictures = resolve })
  await page.exposeFunction('sectionPicture', async text => {
    variantRequests.push(text)
    await picturesReady
    return { status: 'ok', slideId: 'welcome', url: 'data:image/svg+xml;base64,' + image, cached: false }
  })
  page.on('pageerror', error => { errors.push(error.message); console.error(error) })
  await page.route(/^https?:/, route => route.abort())
  await page.goto(pathToFileURL(html).href)
  await page.evaluate(props => window.mountFixture(props), { path: dir, outlinePath, text: source, rows })
  const outline = page.locator('[data-view="outline"] .editor-container > .cm-editor > .cm-scroller')
  const slide = page.locator('.workspace-slide-view')
  const right = page.getByTestId('sidebar-toggle')
  const outlineRow = name => page.locator('[data-slides-organizer]').getByRole('button', { name })
  const failures = []
  const checkWidth = async (scroller, label) => {
    const { scrollWidth, clientWidth, contentWidth } = await scroller.evaluate(element => ({
      scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
      contentWidth: element.querySelector('.cm-content')?.getBoundingClientRect().width
    }))
    if (scrollWidth > clientWidth) failures.push(`${label}: ${scrollWidth} > ${clientWidth} (editor content ${contentWidth})`)
  }
  await outline.locator('.cm-line').filter({ hasText: new RegExp('^' + title + '$') }).waitFor()
  for (const [width, height] of [[1000, 631], [1200, 631], [1440, 900]]) {
    await page.setViewportSize({ width, height })
    for (const leftOpen of [true, false]) {
      await page.evaluate(open => window.showLeft(open), leftOpen)
      await page.locator('[data-sidebar]').waitFor({ state: leftOpen ? 'visible' : 'detached' })
      for (const rightOpen of [true, false]) {
        if ((await right.getAttribute('aria-pressed')) !== String(rightOpen)) await right.click()
        await page.locator('[data-right-column]').waitFor({ state: rightOpen ? 'visible' : 'detached' })
        const label = `${width}×${height} left=${leftOpen} right=${rightOpen}`
        await page.evaluate(() => window.jumpEditor('# Ideas as experiments'))
        await outline.locator('.tw-obj-card-comment .tw-obj-step').filter({ hasText: 'from:' }).waitFor({ state: 'attached' })
        await checkWidth(outline, 'Outline title and comment, ' + label)
        if (width === 1440 && leftOpen && rightOpen) {
          await page.evaluate(() => window.jumpEditor('Capabilities in a wider range'))
          const lead = outline.locator('.cm-line').filter({ hasText: 'Capabilities in a wider range' })
          await lead.scrollIntoViewIfNeeded()
          const ranges = await lead.evaluate(line => {
            const range = document.createRange()
            range.selectNodeContents(line)
            const scroller = line.closest('.cm-scroller').getBoundingClientRect()
            return [...range.getClientRects()].filter(rect => rect.width > 0).map(rect => [rect.top, rect.right <= scroller.right + 1])
          })
          assert.ok(new Set(ranges.map(([top]) => top)).size > 1, 'long bold lead-in bullet wraps')
          assert.ok(ranges.every(([, fits]) => fits), 'every part of the bullet fits the scroller')
          await checkWidth(outline, 'Outline long bold lead-in bullet with both sidebars')
          const timeline = outline.locator('.cm-plain-margin-label').filter({ hasText: 'Icon row' })
          const layout = timeline.locator('.cm-plain-margin-layout')
          await timeline.locator('.cm-plain-margin-word').focus()
          assert.equal(await layout.evaluate(button => {
            const bounds = button.getBoundingClientRect()
            return button.contains(document.elementFromPoint(bounds.right - 2, bounds.top + bounds.height / 2))
          }), true, 'the focused layout control is clickable all the way to its right edge')
          await checkWidth(outline, 'Outline layout pill and bold lead-ins with both sidebars')
          if (shots) await page.screenshot({ path: join(shots, 'outline-bold-bullets-light.png'), animations: 'disabled' })
        }
        await page.evaluate(() => window.jumpEditor('| Column 1'))
        await outline.locator('table.tw-obj-table').waitFor()
        await checkWidth(outline, 'Outline table, ' + label)
        await page.evaluate(() => window.jumpEditor('![A wide picture]'))
        await outline.locator('.cm-image-widget img').evaluate(img => img.decode())
        await checkWidth(outline, 'Outline image, ' + label)
        await page.evaluate(() => window.jumpEditor(':::notes'))
        await outline.locator('.tw-obj-card-code').waitFor()
        const notesCard = outline.locator('.tw-obj-card-notes')
        await notesCard.waitFor()
        await checkWidth(outline, 'Outline code and notes, ' + label)
        if (width === 1000 && leftOpen && rightOpen) {
          await notesCard.getByRole('button', { name: 'Speaker notes', exact: true }).click()
          const noteEditor = outline.locator('.oe-notes-body')
          await noteEditor.waitFor()
          assert.equal(await noteEditor.evaluate(textarea => {
            const editor = textarea.closest('.cm-scroller').getBoundingClientRect()
            const field = textarea.getBoundingClientRect()
            return field.left >= editor.left && field.right <= editor.right
          }), true, 'the expanded notes field fits with both sidebars open')
          await checkWidth(outline, 'Expanded Outline notes, ' + label)
          await outline.getByRole('button', { name: 'Collapse speaker notes', exact: true }).click()
          await notesCard.waitFor()
        }
        if (leftOpen) await outlineRow(/Checking very long text/).click()
        await page.getByTestId('slides-toggle').click()
        await slide.locator('.cm-line').filter({ hasText: 'Checking very long text' }).waitFor()
        await page.evaluate(() => window.jumpEditor('| Column 1'))
        await slide.locator('[data-slide-text-object="gfm-table"]').waitFor()
        await slide.locator('[data-slide-text-object="picture"]').waitFor()
        await checkWidth(slide, 'Slide view, ' + label)
        await checkWidth(slide.locator('.cm-scroller'), 'Slide text scroller, ' + label)
        await page.getByTestId('outline-toggle').click()
      }
    }
  }
  const numberGutter = outline.locator('.cm-gutter.cm-plain-margin')
  assert.ok((await numberGutter.boundingBox()).width <= 40, 'Outline number column is at most 40px')
  await page.getByTestId('markdown-toggle').click()
  const markdown = page.locator('[data-view="markdown"] .cm-scroller')
  await markdown.locator('.cm-foldGutter [title="Fold line"]').first().waitFor()
  assert.equal(await markdown.locator('.cm-gutter').count(), 1, 'Markdown only has the fold gutter')
  if (shots) await page.screenshot({ path: join(shots, 'markdown-light.png'), animations: 'disabled' })
  await page.getByTestId('outline-toggle').click()

  await page.evaluate(() => window.showLeft(true))
  await right.click()
  if (shots) {
    const divider = await page.locator('.workspace-panes').getByRole('separator').boundingBox()
    await page.mouse.move(divider.x + divider.width / 2, divider.y + 15)
    await page.mouse.down()
    await page.mouse.move(970, divider.y + 15)
    await page.mouse.up()
  }
  await outlineRow(/Getting to know/).click()
  const designs = page.locator('[data-section="designs"]')
  const sectionTiles = [
    designs.getByRole('button', { name: /One after another/ }),
    designs.getByRole('button', { name: /^Contents/ })
  ]
  for (const tile of sectionTiles) {
    const frame = tile.locator('.tw-right-picture-frame')
    await frame.scrollIntoViewIfNeeded()
    await frame.locator('svg').waitFor({ timeout: 3000 }).catch(() => {
      failures.push('Section tile stayed blank while its thumbnail was pending: ' + tile)
    })
  }
  if (shots) {
    await outline.evaluate(element => { element.scrollTop = 0 })
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme })
      await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme)
      await page.screenshot({ path: join(shots, `outline-${theme}.png`), animations: 'disabled' })
    }
  }
  releasePictures()
  for (const tile of sectionTiles) await tile.locator('img').evaluate(img => img.decode())
  assert.ok(variantRequests.some(text => !text.includes('{contents}')), 'sequential uses the current slide')
  assert.ok(variantRequests.some(text => text.includes('{contents}')), 'contents requests the changed slide')
  assert.deepEqual(errors, [], 'no renderer exceptions')
  assert.deepEqual(failures, [], 'every editor width fits its scroller')
  console.log('PASS Outline and Slide text: 3 window sizes × 4 sidebar states, with a decoded Outline image, a table, Slide text cards and pending section tiles')
} finally {
  await browser?.close()
  rmSync(dir, { recursive: true, force: true })
}

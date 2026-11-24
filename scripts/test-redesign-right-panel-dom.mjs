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
import { normalizePositions } from '../src/shared/outline-normalize.ts'
import { preferredIdsFromText, stampMissingIds } from '../compiler/scripts/lib/12-outline-edit.mjs'

const root = join(import.meta.dirname, '..')
const polish = process.argv.includes('--polish')
const slideText = process.argv.includes('--slide-text')
const notes = process.argv.includes('--notes')
const outlinePreview = process.argv.includes('--outline-preview')
const sidebarFollow = process.argv.includes('--sidebar-follow')
const scratch = mkdtempSync(join(tmpdir(), 'tw-right-panel-dom-'))
const outline = join(scratch, 'garden-outline.md')
const followTitle = number => ({
  12: '$20 a month was the opening price for a research assistant that could sort through long field reports',
  39: 'Co-Scientist in Nature, and what an automated experiment can actually establish about forest regeneration',
  43: 'Field observations and questions that still need a second visit before winter sets in',
  50: 'What the last round of observations tells us about water, seedlings, soil and the work still to do'
})[number] ?? `Field note ${number}`
const followSlides = Array.from({ length: 50 }, (_, i) => {
  const number = i + 1
  const heading = number === 43 ? '##' : '###'
  return `${heading} ${followTitle(number)} {id=s${number}}\n\n${number === 43 ? '' : `- Observation ${number}\n\n`}`
})
const source = sidebarFollow ? [
  '---\noutline_version: 2\ntitle: Garden meeting\nauto_title_slide: false\nauto_thanks_slide: false\n---\n\n',
  ...followSlides
].join('') : (slideText ? [
  '---', 'outline_version: 2', 'title: Slide text fixture', 'auto_title_slide: false', 'auto_thanks_slide: false', '---',
  '', '### A definition', '{layout=statement}{id=sample-statement}', '',
  'An agent uses tools in a loop.', '',
  '### A quotation', '{id=sample-quote}', '', '> The quotation text.', '> — Jane Example', '',
  '### A list', '{id=sample-list}', '', 'The lead paragraph.', '', '- One point', '- Another point',
  '', 'A paragraph after the list.', '', '![A sample picture](beds.png)', '',
  '| Tool | Count |', '| --- | --- |', '| One | 2 |', '',
  '[Embed: https://example.test/embedded]', '', '[Video: assets/clip.mp4]', ''
] : notes ? [
  '---', 'outline_version: 2', 'title: Garden meeting', 'auto_title_slide: false', 'auto_thanks_slide: false', '---',
  '', '### Priorities', '{id=p1}', '', '- Repair the beds', '',
  ':::notes', 'First note with trailing spaces  ', 'Private second line', ':::', '',
  ':::notes', 'Second block', ':::', '', '- Water the bulbs', '',
  '### Weekend', '{id=weekend}{carousel}', '', ':::notes', 'Parent notes', ':::', '',
  '#### Saturday', '{id=sat}', '', '- Morning', '', ':::notes', 'Subslide notes', ':::', ''
] : polish ? [
  '---', 'outline_version: 2', 'title: Garden meeting', 'auto_title_slide: false', 'auto_thanks_slide: false', '---',
  '', '## In the garden {id=g1}', '', '### Priorities {id=p1}', '', '- Repair the beds',
  '', '### Volunteer shifts {id=p2}', '', '- Monday', '', '### Garden photographs {id=p3}',
  '', '- The garden at the start of the year', '', '![The beds](beds.png)', ''
] : [
  '---', 'outline_version: 2', 'title: Garden meeting', 'auto_title_slide: false', 'auto_thanks_slide: false',
  'defaults: { title: side }', 'sections:', '  Greenhouse: { title: top }',
  '  Examples: { title: top, titlelook: kicker }', '---',
  '', '## In the garden {id=g1}', '', '### Priorities {id=p1}', '', '- Repair the beds',
  '', '### Volunteer shifts {id=p2}', '', '- Monday', '', '### Garden photographs {id=p3}',
  '', '- Soil {icon=lucide:sprout}', '- Water {icon=lucide:droplet}', '- Sun {icon=lucide:sun}',
  '', '![The beds](beds.png)',
  '', '## Greenhouse {id=g2}', '', '### Seedlings {id=p4} {sidebar}',
  '{iconrow}', '', '- Sun', '- Water', '- Soil',
  '', '### Harvest counts {id=p5}', '', '| Bed | Seedlings |', '| --- | --- |', '| A | 12 |', '| B | 18 |', ''
]).concat(outlinePreview ? Array.from({ length: 14 }, (_, index) =>
  `### Field notes ${index + 1} {id=field-${index + 1}}\n\n- Record the first observations\n`) : []).join('\n')
writeFileSync(outline, source)
copyFileSync(join(root, 'demo-vault/layout-sampler/assets/sample-image.png'), join(scratch, 'beds.png'))

let browser
try {
  await build({
    plugins: [{ name: 'observe-workspace-state', setup(bundle) {
      bundle.onLoad({ filter: /talk-structure\.ts$/ }, ({ path }) => {
        const source = readFileSync(path, 'utf8')
        const declaration = 'export function structureOf(text: string) {'
        assert.ok(source.includes(declaration))
        return { loader: 'ts', contents: source.replace(declaration, declaration +
          ' globalThis.workspaceStructureReads = (globalThis.workspaceStructureReads ?? 0) + 1;') }
      })
      if (slideText) bundle.onLoad({ filter: /WorkspaceLayout\.tsx$/ }, ({ path }) => {
        const source = readFileSync(path, 'utf8')
        const publish = '      setCompiledSlides(slides)'
        assert.ok(source.includes(publish))
        return { loader: 'tsx', contents: source.replace(publish, `
          const publications = (globalThis.projectionPublications ??= [])
          publications.push({
            index: activeSlideRef.current,
            expected: slides?.[activeSlideRef.current]?.slide_id,
            readable: compiledSlidesRef.current?.[activeSlideRef.current]?.slide_id
          })
${publish}`) }
      })
    }}],
    stdin: {
      contents: `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { GalleryThumbnails, Library, ListTree } from 'lucide-react'
import { installMock } from './src/renderer/src/tw-mock.ts'
import WorkspaceLayout from './src/renderer/src/components/WorkspaceLayout.tsx'
import Toasts from './src/renderer/src/components/Toasts.tsx'
import { notify } from './src/renderer/src/lib/notify.ts'
import './src/renderer/src/styles.css'
import './src/renderer/src/guide.css'
import './src/renderer/src/image-drawer.css'
import './src/renderer/src/lib/appTheme.ts'
installMock()
window.fixtureWrites = 0
const empty = () => () => {}
Object.assign(window.tw.talk, {
  readOutline: () => window.readFixture(),
  writeOutline: async (_path, text) => {
    window.fixtureWrites++
    const saved = await window.writeFixture(text)
    window.savedFixture = saved.content
    return saved
  },
  compile: async (_path, text) => {
    const rows = await window.compileFixture(text)
    window.compiledFixture = text
    window.compiledRows = rows
    return rows
  },
  // This fixture tests the workspace UI without launching the native thumbnail renderer.
  thumbnails: async () => null,
  layoutVariantThumbnail: async (_path, text, _slide, _layout, _width, key) => {
    if (key?.startsWith('panel:title-')) (window.titleVariantInputs ??= {})[key] = text
    return key?.startsWith('panel:picture:') ? { status: 'ok', slideId: 'p3', url: new URL('beds.png', location.href).href, cached: false } : null
  },
  onOutlineChangedOnDisk: empty,
})
window.fixturePreviewText = new Map()
window.tw.slide.renderPreview = async (_path, text) => {
  const url = await window.renderFixture(text)
  window.fixturePreviewText.set(url, text)
  return url
}
window.tw.asset.pasteTalkPictures = async () => window.acceptPicturePaste ? ['beds.png'] : new Promise((_resolve, reject) => {
  window.failPictureImport = message => reject(new Error(message))
})
window.tw.workFiles = { list: async () => null }
window.tw.pathways = { read: async () => ({ slides: [], pathways: [] }), onChanged: empty }
window.tw.icons = { names: async () => [], svg: async () => null, search: async () => [] }
let attachedView = null
window.editorView = () => {
  const dom = document.querySelector('.cm-editor')
  if (dom) attachedView = EditorView.findFromDOM(dom)
  // The same editor is parked off-DOM while Grid is open.
  return attachedView
}
window.centerFixtureCaret = () => {
  const view = window.editorView()
  view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'center' }) })
}
function Fixture({ path, outlinePath, polish, slideText, outlinePreview }) {
  const [outlineHost, setOutlineHost] = useState(null)
  const [slidesPanelView, setSlidesPanelView] = useState(outlinePreview ? 'previews' : 'outline')
  const [slideTabView, setSlideTabView] = useState('pages')
  return <div className="app-shell">
    {(polish || slideText) && <div ref={setOutlineHost} style={{ flex: "0 0 190px", minWidth: 0 }} />}
    {outlinePreview && <aside className="sidebar-wrap" data-slides-mode={slidesPanelView} style={{ width: 262, '--sidebar-width': '262px' }}>
      <div className="sidebar-modebar">
        <div className="sidebar-modes">
          <button className="sidebar-mode-btn sidebar-mode-btn--active"><GalleryThumbnails size={15} /><span>Slides</span></button>
          <button className="sidebar-mode-btn"><Library size={15} /><span>Talks</span></button>
        </div>
        <div className="tw-slides-switch" role="group" aria-label="Show slides as">
          <button aria-label="Show slides as previews" aria-pressed={slidesPanelView === 'previews'} onClick={() => setSlidesPanelView('previews')}><GalleryThumbnails size={15} /></button>
          <button aria-label="Show slides as an outline" aria-pressed={slidesPanelView === 'outline'} onClick={() => setSlidesPanelView('outline')}><ListTree size={15} /></button>
        </div>
      </div>
      <div className="sidebar-nav-body" ref={setOutlineHost} />
    </aside>}
    <WorkspaceLayout activeTalk={{ name: 'Garden', path, outlinePath, slug: 'garden', title: 'Garden meeting' }}
      vaultRoot={path} startView={polish || outlinePreview ? 'markdown' : undefined} leftPreviewsHost={outlineHost}
      leftSidebarShown={outlinePreview} slidesPanelView={slidesPanelView}
      slideTabView={slideTabView} onChooseSlideTabView={setSlideTabView} /><Toasts /></div>
}
window.mountFixture = props => createRoot(document.getElementById('root')).render(<Fixture {...props} />)
window.showFixtureNotice = level => notify('Fixture ' + level, level, 'fixture-tone', { label: 'Review', onAction() {} }, 'expanded')
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
  const context = await browser.newContext({ viewport: polish ? { width: 1340, height: 740 } : { width: 1000, height: 631 } })
  const page = await context.newPage()
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await page.route(/^https?:/, route => route.abort())
  const errors = []
  page.on('pageerror', error => { errors.push(error.message); console.error(error) })
  page.setDefaultTimeout(20000)
  await page.exposeFunction('readFixture', () => readFileSync(outline, 'utf8'))
  await page.exposeFunction('writeFixture', text => {
    const { text: stamped } = stampMissingIds(text, undefined, { preferred: preferredIdsFromText(readFileSync(outline, 'utf8')) })
    writeFileSync(outline, stamped)
    return { ok: true, content: stamped }
  })
  await page.exposeFunction('compileFixture', async text =>
    buildPerSlideProjections(await prepareSource(outline, text, 'Garden meeting', statSync(outline)), 'garden'))
  let renderSequence = 0
  await page.exposeFunction('renderFixture', async text => {
    if (!slideText && !notes && !outlinePreview && !/image=above|table-bands=on|id=title-loop/.test(text)) return 'about:blank'
    const model = await prepareSource(outline, text, 'Garden meeting', statSync(outline))
    const file = join(scratch, `preview-${++renderSequence}.html`)
    writeFileSync(file, model.fullHtml)
    return pathToFileURL(file).href
  })
  await page.goto(pathToFileURL(html).href)
  const props = { path: scratch, outlinePath: outline, polish, slideText, outlinePreview: outlinePreview || sidebarFollow }
  await page.evaluate(props => window.mountFixture(props), props)

  if (slideText) {
    const panel = page.locator('.workspace-slide-text')
    const buffer = () => page.evaluate(() => window.editorView().state.doc.toString())
    const waitForBuffer = text => page.waitForFunction(expected => window.editorView()?.state.doc.toString() === expected, text)
      .catch(async error => {
        console.error('Expected outline:', JSON.stringify(text))
        console.error('Actual outline:', JSON.stringify(await buffer()))
        throw error
      })
    const selectSlide = name => page.locator('[data-slides-organizer]').getByRole('button', { name: new RegExp(name) }).click()
    const showBody = async (name, lines) => {
      await selectSlide(name)
      for (const text of lines) {
        await panel.locator('.cm-line').filter({ hasText: text }).waitFor().catch(async error => {
          console.error(`Slide text for "${name}":`, await panel.innerText())
          throw error
        })
      }
    }
    const body = 'An agent uses tools in a loop.'
    await showBody('A definition', [body])
    await showBody('A quotation', ['The quotation text.', '— Jane Example'])
    await showBody('A list', ['The lead paragraph.', 'One point', 'Another point', 'A paragraph after the list.'])
    await showBody('A definition', [body])
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('tw-workspace-command', { detail: 'view-plain' })))
    await page.locator('[data-view="outline"] .cm-content').waitFor()
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('tw-workspace-command', { detail: 'fold-all' })))
    await page.locator('[data-view="outline"] .cm-foldPlaceholder').first().waitFor()
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('tw-workspace-command', { detail: 'view-slides' })))
    await panel.getByText(body, { exact: true }).waitFor().catch(async error => {
      console.error('Slide text after folding the outline:', await panel.innerText())
      throw error
    })
    assert.equal(await buffer(), source, 'selecting views and slides leaves the full outline byte for byte')

    if (process.env.TW_SLIDE_TEXT_LOOK === '1') {
      for (const theme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: theme })
        await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme)
        const image = await panel.screenshot()
        console.log(`SLIDE_TEXT_LOOK ${theme} ${image.toString('base64')}`)
      }
      await page.emulateMedia({ colorScheme: 'light' })
    }

    const before = await buffer()
    const undoKey = 'ControlOrMeta+z'
    const placeCaret = lineText => page.evaluate(lineText => {
      const view = window.editorView()
      const pos = view.state.doc.toString().indexOf(lineText)
      if (pos < 0) throw new Error('Missing line ' + lineText)
      const anchor = pos + lineText.length
      view.dispatch({ selection: { anchor } })
      if (view.state.selection.main.head !== anchor) throw new Error('Could not place caret at the end of ' + lineText)
      view.focus()
    }, lineText)
    await placeCaret(body)
    await page.keyboard.press('Enter')
    const beforeTyping = await buffer()
    await page.keyboard.press('Shift+Digit3')
    await page.keyboard.type(' Foo')
    const typed = beforeTyping.replace(body + '\n', body + '\n\\# Foo')
    await waitForBuffer(typed)
    await panel.getByText("# Foo", { exact: true }).waitFor()
    await page.waitForFunction(text => window.compiledFixture === text, typed)
    const stage = page.frameLocator('.workspace-slide-stage iframe')
    await stage.locator('section.slide.active').getByText(/#\s+Foo/).waitFor()
    assert.doesNotMatch(await stage.locator('section.slide.active').innerText(), /\\# Foo/)
    assert.equal(await stage.locator('section.slide').count(), 3)
    await page.keyboard.press(undoKey)
    if (await buffer() === beforeTyping) await page.keyboard.press(undoKey)
    await waitForBuffer(before)

    const paste = text => page.evaluate(text => {
      const data = new DataTransfer()
      data.setData('text/plain', text)
      window.editorView().contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    }, text)
    await placeCaret(body)
    const headingLines = ['# Foo', '## Two', '### Three', '#### Four']
    await paste('\n' + headingLines.join('\n'))
    const pasted = before.replace(body, body + '\n' + headingLines.map(line => '\\' + line).join('\n'))
    await waitForBuffer(pasted)
    await page.waitForFunction(text => window.compiledFixture === text, pasted)
    const renderedPastedLine = stage.locator('section.slide.active .content-p').filter({ hasText: '#### Four' })
    await renderedPastedLine.waitFor().catch(async error => {
      console.error('Paste preview:', await stage.locator('section.slide').evaluateAll(slides => slides.map(slide => ({
        id: slide.dataset.id, active: slide.classList.contains('active'), text: slide.textContent.trim()
      }))))
      console.error('Slide text after paste:', await panel.innerText())
      throw error
    })
    assert.match(await renderedPastedLine.innerText(), /# Foo ## Two ### Three ####\s+Four/)
    assert.equal(await stage.locator('section.slide').count(), 3)
    await page.keyboard.press(undoKey)
    await waitForBuffer(before)

    // Each body is editable through the same panel. An edit to its final line belongs to that
    // slide and each Undo takes the whole outline back to the original bytes.
    for (const [title, lastLine] of [
      ['A definition', body], ['A quotation', '> — Jane Example'], ['A list', 'A paragraph after the list.']
    ]) {
      await showBody(title, [lastLine.replace(/^> /, '')])
      await placeCaret(lastLine)
      await page.keyboard.type('!')
      await waitForBuffer(before.replace(lastLine, lastLine + '!'))
      await page.keyboard.press(undoKey)
      await waitForBuffer(before)
    }
    for (const [command, view] of [['view-plain', 'outline'], ['view-markdown', 'markdown']]) {
      await page.evaluate(detail => window.dispatchEvent(new CustomEvent('tw-workspace-command', { detail })), command)
      await page.locator(`[data-view="${view}"] .cm-content`).waitFor()
      await placeCaret(body)
      await paste('\n# Still a heading')
      await waitForBuffer(before.replace(body, body + '\n# Still a heading'))
      await page.keyboard.press(undoKey)
      await waitForBuffer(before)
    }
    const command = detail => page.evaluate(detail => window.dispatchEvent(new CustomEvent('tw-workspace-command', { detail })), detail)
    await command('view-slides')
    await showBody('A list', ['A paragraph after the list.'])
    const cards = panel.locator('[data-slide-text-object]')
    await cards.nth(3).waitFor()
    assert.deepEqual(await cards.evaluateAll(nodes => nodes.map(node => node.dataset.slideTextObject)),
      ['picture', 'gfm-table', 'embed', 'embed'])
    if (process.env.TW_SLIDE_TEXT_LOOK === '1') {
      for (const theme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: theme })
        await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme)
        console.log(`SLIDE_OBJECTS_LOOK ${theme} ${(await panel.screenshot()).toString('base64')}`)
      }
      await page.emulateMedia({ colorScheme: 'light' })
    }
    const pictureCard = cards.filter({ hasText: 'A sample picture' })
    const pictureFile = readFileSync(join(scratch, 'beds.png'))
    const pictureLine = '![A sample picture](beds.png)'
    const stable = await buffer()
    await pictureCard.click()
    await pictureCard.getByRole('button', { name: 'Move up' }).click()
    await page.waitForFunction(line => {
      const text = window.editorView().state.doc.toString()
      return text.indexOf(line) < text.indexOf('A paragraph after the list.')
    }, pictureLine)
    await page.keyboard.press(undoKey)
    await waitForBuffer(stable)
    await pictureCard.getByRole('button', { name: 'Edit picture' }).click()
    await panel.locator('.oe').waitFor()
    await panel.locator('.oe').getByRole('textbox', { name: 'Alternative text' }).fill('Revised caption')
    await panel.locator('.oe').getByRole('button', { name: 'Done' }).click()
    await waitForBuffer(stable.replace('A sample picture', 'Revised caption'))
    await page.keyboard.press(undoKey)
    await waitForBuffer(stable)
    for (const [kind, label, line, key] of [
      ['picture', 'A sample picture', pictureLine, 'Backspace'],
      ['gfm-table', 'Table', '| Tool | Count |', 'Delete'],
      ['embed', 'example.test', '[Embed: https://example.test/embedded]', 'Backspace'],
      ['embed', 'clip.mp4', '[Video: assets/clip.mp4]', 'Delete']
    ]) {
      const card = cards.filter({ hasText: label }).and(panel.locator(`[data-slide-text-object="${kind}"]`))
      await card.getByRole('button', { name: 'Move up' }).click()
      await page.waitForFunction(({ line, at }) => window.editorView().state.doc.toString().indexOf(line) < at,
        { line, at: stable.indexOf(line) })
      assert.equal(await card.evaluate(node => node.classList.contains('tw-obj-selected')), true)
      const moved = await buffer()
      await card.getByRole('button', { name: 'Move down' }).click()
      await waitForBuffer(stable)
      await page.keyboard.press(undoKey)
      await waitForBuffer(moved)
      await page.keyboard.press(undoKey)
      await waitForBuffer(stable)
      await card.click()
      await page.keyboard.press(key)
      await card.waitFor({ state: 'detached' })
      if (label === 'clip.mp4') await waitForBuffer(stable.replace('\n\n' + line + '\n', '\n'))
      await page.keyboard.press(undoKey)
      await waitForBuffer(stable)
    }
    assert.deepEqual(readFileSync(join(scratch, 'beds.png')), pictureFile, 'removing pictures keeps the file')
    const assertCurrentSlide = async (label, id) => {
      await page.waitForFunction(expected => {
        const view = window.editorView()
        const rows = window.compiledRows ?? []
        const inspectorNumber = document.querySelector('.tw-inspector .tw-right-who small')?.textContent.match(/slide (\d+) of/i)?.[1]
        const current = document.querySelector('[data-slides-organizer] .so-row--current[data-line]')
        const caretLine = view?.state.doc.lineAt(view.state.selection.main.head).number
        const text = view?.state.doc.toString()
        if (!text || !current || !inspectorNumber || !caretLine || text !== window.compiledFixture) return false
        const idAt = line => {
          let heading = line
          while (heading > 1 && !/^#{2,6} /.test(view.state.doc.line(heading).text)) heading--
          const start = view.state.doc.line(heading).from
          const tail = text.slice(start)
          const nextHeading = tail.search(/\n#{2,6} /)
          const block = nextHeading < 0 ? tail : tail.slice(0, nextHeading)
          return block.match(/\{id=([\w-]+)\}/)?.[1]
        }
        const inspectorId = rows[Number(inspectorNumber) - 1]?.slide_id
        const centreNumber = document.querySelector('.workspace-slide-crumb strong')?.textContent.match(/Slide (\d+) of/)?.[1]
        const gridNumber = document.querySelector('.workspace-centre [data-slide-index][data-active="true"]')?.getAttribute('data-slide-index')
        const centreId = centreNumber ? rows[Number(centreNumber) - 1]?.slide_id
          : gridNumber != null ? rows[Number(gridNumber)]?.slide_id : idAt(caretLine)
        return inspectorId === expected && centreId === expected && idAt(Number(current.dataset.line)) === expected && idAt(caretLine) === expected
      }, id, { timeout: 6500 }).catch(async error => {
        console.error(label, { expected: id, inspector: await page.locator('.tw-inspector .tw-right-who').allTextContents(),
          centre: await page.locator('.workspace-slide-crumb strong').allTextContents(),
          sidebar: await page.locator('[data-slides-organizer] .so-row--current[data-line]').allTextContents(),
          caret: await page.evaluate(() => {
            const view = window.editorView()
            return view.state.doc.lineAt(view.state.selection.main.head).text
          }) })
        throw error
      })
    }
    await showBody('A definition', [body])
    await assertCurrentSlide('Sidebar chooses the statement in Slide view', 'sample-statement')
    // Collapsing the docked Scratchpad reveals the Inspector while retaining the Scratchpad tab state.
    await command('scratchpad-dock')
    await page.getByRole('tab', { name: 'Scratchpad', exact: true }).waitFor()
    await command('scratchpad-collapse')
    await assertCurrentSlide('Inspector fallback after collapsing Scratchpad', 'sample-statement')
    await command('view-plain')
    await page.locator('[data-view="outline"] .cm-content').waitFor()
    await placeCaret('The quotation text.')
    await assertCurrentSlide('Outline caret moves while the Inspector is the fallback tab', 'sample-quote')
    const previousSlide = page.locator('.tw-inspector').getByRole('button', { name: 'Previous slide', exact: true })
    const nextSlide = page.locator('.tw-inspector').getByRole('button', { name: 'Next slide', exact: true })
    await previousSlide.click()
    await assertCurrentSlide('Inspector arrow moves the Outline caret', 'sample-statement')
    await command('view-markdown')
    await page.locator('[data-view="markdown"] .cm-content').waitFor()
    await nextSlide.click()
    await assertCurrentSlide('Inspector arrow moves the Markdown caret', 'sample-quote')
    await command('view-grid')
    await page.locator('.workspace-centre [data-slide-index="2"]').click()
    await assertCurrentSlide('Grid card moves the Inspector', 'sample-list')
    await page.locator('.workspace-centre [data-slide-index="2"]').press('ArrowLeft')
    await assertCurrentSlide('Centre Grid arrow moves the Inspector', 'sample-quote')
    await nextSlide.click()
    await assertCurrentSlide('Inspector next arrow moves the Grid selection', 'sample-list')
    await previousSlide.click()
    await assertCurrentSlide('Inspector arrow moves the Grid selection', 'sample-quote')
    await command('view-slides')
    await assertCurrentSlide('Returning to Slide view preserves the current slide', 'sample-quote')

    const navSource = await buffer()
    const previewStage = page.locator('.workspace-slide-stage')
    const slideEditor = panel.locator('.cm-content')
    for (const [name, target] of [['preview', previewStage], ['Slide text', slideEditor]]) {
      for (const [key, id] of [
        ['PageDown', 'sample-list'], ['PageUp', 'sample-quote'],
        ['ControlOrMeta+ArrowDown', 'sample-list'], ['ControlOrMeta+ArrowUp', 'sample-quote']
      ]) {
        await target.press(key)
        await assertCurrentSlide(`${key} from ${name} moves the shared current slide`, id)
        assert.equal(await buffer(), navSource, `${key} from ${name} preserves the outline bytes`)
      }
    }
    await previewStage.press('PageDown')
    await assertCurrentSlide('Select the slide with object controls', 'sample-list')
    await panel.locator('[data-slide-text-object="picture"]').getByRole('button', { name: 'Move up' }).press('PageUp')
    await assertCurrentSlide('Page Up works from an object card button', 'sample-quote')
    assert.equal(await buffer(), navSource)
    assert.match(await nextSlide.getAttribute('title'), /⌘↓.*Page Down/)
    assert.match(await previousSlide.getAttribute('title'), /⌘↑.*Page Up/)
    const deliveredTo = async (target, key) => {
      await target.evaluate((node, expected) => {
        window.fixtureNavKeyDelivered = false
        node.addEventListener('keydown', event => {
          if (event.key === expected) window.fixtureNavKeyDelivered = true
        }, { signal: AbortSignal.timeout(5000) })
      }, key.split('+').at(-1))
      await target.press(key)
      assert.equal(await page.evaluate(() => window.fixtureNavKeyDelivered), true, `${key} reaches its focused control`)
    }
    await deliveredTo(previewStage, 'Control+Meta+ArrowDown')
    await assertCurrentSlide('Control-Command arrows are a separate chord', 'sample-quote')
    const toggleNotes = panel.getByRole('button', { name: /Speaker notes/ })
    await toggleNotes.click()
    const notesInput = page.locator('.workspace-slide-notes textarea')
    await deliveredTo(notesInput, 'PageDown')
    await deliveredTo(notesInput, 'ControlOrMeta+ArrowDown')
    await assertCurrentSlide('Speaker notes keep their text navigation', 'sample-quote')
    await toggleNotes.click()
    for (const [viewCommand, view] of [['view-plain', 'outline'], ['view-markdown', 'markdown']]) {
      await command(viewCommand)
      const fullEditor = page.locator(`[data-view="${view}"] .cm-content`)
      await fullEditor.waitFor()
      await placeCaret(body)
      const headBefore = await page.evaluate(() => window.editorView().state.selection.main.head)
      await deliveredTo(fullEditor, 'ControlOrMeta+ArrowDown')
      if (process.platform === 'darwin') {
        const headAfter = await page.evaluate(() => window.editorView().state.selection.main.head)
        assert.ok(headAfter > headBefore, `⌘↓ moves the text caret in ${view}`)
      }
      assert.equal(await buffer(), navSource)
    }
    await command('view-slides')
    await selectSlide('A quotation')
    await assertCurrentSlide('Slide view after text navigation checks', 'sample-quote')
    await command('app.command-palette')
    await page.getByRole('combobox', { name: 'Command query' }).fill('Next slide')
    const nextCommand = page.locator('[data-command="next-slide"]')
    assert.match(await nextCommand.innerText(), /⌘↓.*Page Down/)
    await nextCommand.click()
    await assertCurrentSlide('Next slide in the command palette', 'sample-list')
    await previousSlide.click()
    await assertCurrentSlide('Return to the quote after the command palette', 'sample-quote')
    await page.keyboard.press('Control+/')
    await page.getByRole('textbox', { name: 'Filter all commands' }).fill('Next slide')
    assert.match(await page.locator('[data-sheet-row="next-slide"]').innerText(), /⌘↓.*Page Down/)
    await page.keyboard.press('Escape')
    await page.evaluate(() => {
      localStorage.setItem('tw-keymap-overrides', JSON.stringify({ 'next-slide': 'Alt-ArrowRight' }))
      window.dispatchEvent(new Event('tw-keymap-changed'))
    })
    await page.waitForFunction(() => document.querySelector('.tw-inspector button[aria-label="Next slide"]')?.title.includes('⌥→'))
    await deliveredTo(slideEditor, 'PageDown')
    await assertCurrentSlide('Rebinding removes the default slide shortcut', 'sample-quote')
    await slideEditor.press('Alt+ArrowRight')
    await assertCurrentSlide('Rebound shortcut moves the shared current slide', 'sample-list')
    assert.equal(await buffer(), navSource)
    await page.evaluate(() => {
      localStorage.removeItem('tw-keymap-overrides')
      window.dispatchEvent(new Event('tw-keymap-changed'))
    })
    await previousSlide.click()
    await assertCurrentSlide('Return to the quote after testing the shortcuts', 'sample-quote')
    console.log('PASS four Slide view shortcuts in preview and Slide text, text-field protection, Outline and Markdown navigation, and live rebinding')

    await nextSlide.click()
    await assertCurrentSlide('Inspector arrow moves the centre and caret in Slide view', 'sample-list')
    const alternateDesign = page.locator('.tw-inspector .tw-right-picture[aria-pressed="false"]:enabled').first()
    await alternateDesign.hover()
    const liveTry = page.locator('.workspace-slide-stage[data-panel-trying]')
    await liveTry.waitFor()
    await assertCurrentSlide('Hover previews a design on the current slide', 'sample-list')
    await page.locator('.workspace-slide-crumb').hover()
    await liveTry.waitFor({ state: 'detached' })
    await assertCurrentSlide('Mouse-out restores the current design', 'sample-list')
    await previousSlide.click()
    await assertCurrentSlide('Inspector previous returns to the quote', 'sample-quote')
    await command('focus-slide')
    await page.locator('.lt-stage-arrow.prev').click()
    await page.locator('.lt-c-slide').filter({ hasText: /^A definition$/ }).waitFor()
    await page.keyboard.press('Escape')
    await assertCurrentSlide('Centre Focus arrow moves the current slide', 'sample-statement')
    await page.locator('.workspace-edit-controls').getByRole('button', { name: 'New slide', exact: true }).click()
    await page.locator('.workspace-slide-crumb strong').filter({ hasText: 'Slide 2 of 4' }).waitFor()
    const newId = await page.evaluate(() => window.compiledRows?.[1]?.slide_id)
    assert.ok(newId)
    assert.notEqual(newId, 'sample-quote')
    await assertCurrentSlide('New slide becomes the current slide before paste', newId)
    await page.waitForFunction(() => document.activeElement?.matches('.workspace-slide-text .cm-content'))
    await page.keyboard.type('Test slide')
    await panel.locator('.cm-line').filter({ hasText: 'Test slide' }).waitFor()
    await assertCurrentSlide('Typing the new slide title keeps its selection', newId)
    const beforePicture = await buffer()
    await page.evaluate(() => {
      window.acceptPicturePaste = true
      const data = new DataTransfer()
      data.items.add(new File(['synthetic picture'], 'beds.png', { type: 'image/png' }))
      window.editorView().contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    })
    await panel.locator('[data-slide-text-object="picture"]').waitFor()
    await page.locator('.tw-inspector .tw-right-who strong').filter({ hasText: /^Test slide$/ }).waitFor()
    await page.locator('.workspace-slide-crumb strong').filter({ hasText: 'Slide 2 of 4' }).waitFor()
    assert.match(await buffer(), /^### Test slide\b[\s\S]*!\[\]\(beds\.png\)[\s\S]*### A quotation/m)
    const withPicture = await buffer()
    await assertCurrentSlide('Picture paste keeps the new slide current', newId)
    await selectSlide('A list')
    await assertCurrentSlide('Sidebar moves away from the picture edit', 'sample-list')
    await page.keyboard.press(undoKey)
    await assertCurrentSlide('Undo moves all views to the changed slide', newId)
    await waitForBuffer(beforePicture)
    await selectSlide('A list')
    await assertCurrentSlide('Sidebar moves away before redoing the paste', 'sample-list')
    await page.keyboard.press(mod + '+Shift+Z')
    await assertCurrentSlide('Redo moves all views back to the changed slide', newId)
    await waitForBuffer(withPicture)
    const beforeDelete = await buffer()
    const deletedLastPicture = beforeDelete.replace('\n\n![](beds.png)\n\n### A quotation', '\n\n### A quotation')
    assert.notEqual(deletedLastPicture, beforeDelete)
    await panel.locator('[data-slide-text-object="picture"]').click()
    await page.keyboard.press('Delete')
    await waitForBuffer(deletedLastPicture)
    await page.keyboard.press(undoKey)
    await waitForBuffer(beforeDelete)

    // Adding a generated cover shifts the current slide without changing its identity.
    // Sample the same refs Inspector actions read, before React gets the new rows.
    await command('view-markdown')
    await page.locator('[data-view="markdown"] .cm-content').waitFor()
    await page.evaluate(() => {
      const view = window.editorView()
      const oldSetting = 'auto_title_slide: false'
      const from = view.state.doc.toString().indexOf(oldSetting)
      if (from < 0) throw Error('Missing cover fixture setting')
      view.dispatch({ changes: { from, to: from + oldSetting.length, insert: 'auto_title_slide: true' } })
    })
    await page.waitForFunction(id => window.compiledRows?.[0]?.slide_id === 'deck-title' &&
      window.compiledRows?.[2]?.slide_id === id, newId)
    await assertCurrentSlide('Recompile moves the active slide without changing its identity', newId)
    const publication = await page.evaluate(id => window.projectionPublications
      .findLast(sample => sample.index === 2 && sample.expected === id), newId)
    assert.deepEqual(publication, { index: 2, expected: newId, readable: newId })
    console.log('PASS one current slide across slide, outline, Markdown and Grid; Focus arrows and paste Undo follow it')
    console.log('PASS in-order object cards, edit, move, Delete and Backspace, byte-exact Undo, asset kept and Inspector follows New slide plus picture paste')
    console.log('PASS complete Statement, Quote and List text, scoped heading typing and paste, compiled literal hashes and byte-exact undo')
  } else if (notes) {
    const viewSwitch = page.locator('[data-view-segment]')
    const selectView = name => viewSwitch.getByRole('button', { name, exact: true }).click()
    const waitForBuffer = text => page.waitForFunction(expected => window.editorView()?.state.doc.toString() === expected, text)
    const switchNotes = page.locator('.workspace-slide-notes').getByRole('button', { name: /Speaker notes/ })
    const first = page.getByRole('textbox', { name: 'Speaker notes 1 of 2' })
    const second = page.getByRole('textbox', { name: 'Speaker notes 2 of 2' })
    const card = page.locator('[data-view="outline"] [data-object-block="notes"]').filter({ hasText: 'First note' })
    await first.waitFor()
    await waitForBuffer(source)
    assert.equal(await first.inputValue(), 'First note with trailing spaces  \nPrivate second line')
    assert.equal(await second.inputValue(), 'Second block')
    await switchNotes.click()
    await first.waitFor({ state: 'hidden' })
    await switchNotes.click()
    await first.waitFor()
    assert.equal(await page.evaluate(() => window.fixtureWrites), 0)

    await selectView('Outline')
    await card.waitFor()
    assert.equal(await card.getByText('Private second line').count(), 0)
    const disclosure = card.getByRole('button', { name: 'Speaker notes', exact: true })
    await disclosure.press('Enter')
    const body = page.getByRole('textbox', { name: 'Speaker notes, presenter only' })
    await body.waitFor()
    assert.equal(await body.inputValue(), 'First note with trailing spaces  \nPrivate second line')
    const collapse = page.getByRole('button', { name: 'Collapse speaker notes' })
    await collapse.click()
    await body.waitFor({ state: 'hidden' })
    await waitForBuffer(source)
    assert.equal(await page.evaluate(() => window.fixtureWrites), 0)

    for (const [width, height] of [[1000, 631], [1440, 900]]) {
      await page.setViewportSize({ width, height })
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
        await card.scrollIntoViewIfNeeded()
        const box = await card.boundingBox()
        assert.ok(box.height <= 38 && box.x >= 0 && box.x + box.width <= width)
        for (const open of [false, true]) {
          if (open) await disclosure.click()
          const panel = open ? body : card
          await panel.scrollIntoViewIfNeeded()
          const bounds = await panel.boundingBox()
          assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= height)
          if (process.env.TW_NOTES_LOOK === '1') {
            const frame = await page.screenshot({ type: 'jpeg', quality: 82 })
            console.log(`NOTES_LOOK ${width}x${height}-${theme}-${open ? 'open' : 'closed'} ${frame.toString('base64')}`)
          }
          if (open) await collapse.click()
        }
      }
    }
    await disclosure.click()
    await body.fill('A prepared reminder')
    await collapse.click()
    await page.getByText('Choose Done to save your changes or Discard to close without saving.').waitFor()
    await waitForBuffer(source)
    await page.locator('.oe-notes .oe-done').click()
    await waitForBuffer(source.replace('First note with trailing spaces  \nPrivate second line', 'A prepared reminder'))
    await page.keyboard.press('ControlOrMeta+z')
    await waitForBuffer(source)

    const move = card.getByRole('button', { name: 'Move speaker notes' })
    const block = ':::notes\nFirst note with trailing spaces  \nPrivate second line\n:::\n'
    const moved = source.replace('- Repair the beds\n\n' + block, block + '- Repair the beds\n\n')
    await move.press('ArrowUp')
    await waitForBuffer(moved)
    await page.locator('.cm-content').press('ControlOrMeta+z')
    await waitForBuffer(source)
    const beforePoint = page.locator('.cm-line').filter({ hasText: 'Repair the beds' })
    await move.dragTo(beforePoint, { targetPosition: { x: 60, y: 2 } })
    await waitForBuffer(moved)
    await page.locator('.cm-content').press('ControlOrMeta+z')
    await waitForBuffer(source)

    await selectView('Markdown')
    const markdown = page.locator('[data-view="markdown"]')
    const rawBody = markdown.locator('.cm-line').getByText('Private second line', { exact: true })
    await rawBody.waitFor()
    await markdown.locator('.cm-line').getByText(':::notes', { exact: true }).first().waitFor()
    assert.equal(await markdown.locator('[data-object-block="notes"]').count(), 0)
    await rawBody.click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End')
    await page.keyboard.insertText(' edited as source')
    await waitForBuffer(source.replace('Private second line', 'Private second line edited as source'))
    await page.keyboard.press('ControlOrMeta+z')
    await waitForBuffer(source)
    await selectView('Grid')
    await page.locator('.workspace-grid-view, [data-view="grid"], .grid-view').first().waitFor()
    await selectView('Slide')
    await waitForBuffer(source)
    await second.waitFor()
    for (const [width, height] of [[1000, 631], [1440, 900]]) {
      await page.setViewportSize({ width, height })
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
        await first.scrollIntoViewIfNeeded()
        const bounds = await first.boundingBox()
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width)
        if (process.env.TW_NOTES_LOOK === '1') {
          const frame = await page.screenshot({ type: 'jpeg', quality: 82 })
          console.log(`NOTES_LOOK ${width}x${height}-${theme}-slide ${frame.toString('base64')}`)
        }
      }
    }
    await second.fill('The second note changed.')
    await waitForBuffer(source.replace('Second block', 'The second note changed.'))
    const inspectorNext = page.locator('.tw-inspector').getByRole('button', { name: 'Next slide', exact: true })
    await inspectorNext.click()
    await page.getByRole('button', { name: /Saturday/ }).click()
    const subnote = page.getByRole('textbox', { name: 'Speaker notes', exact: true })
    await subnote.waitFor()
    assert.equal(await subnote.inputValue(), 'Subslide notes')
    await subnote.fill('Subslide revised')
    await waitForBuffer(source.replace('Second block', 'The second note changed.').replace('Subslide notes', 'Subslide revised'))
    console.log('PASS note collapse is byte-exact, moves are atomic and undoable, Markdown shows the whole block, and Slide edits the selected block or subslide.')
  } else if (sidebarFollow) {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.locator('[data-view="markdown"]').waitFor()
    await page.waitForFunction(text => window.compiledFixture === text && window.editorView()?.state.doc.toString() === text, source)
    const caretTo = async number => page.evaluate(value => {
      const view = window.editorView()
      const heading = view.state.doc.toString().split('\n').findIndex(line => line.endsWith('{id=s' + value + '}')) + 1
      view.dispatch({ selection: { anchor: view.state.doc.line(heading).to }, scrollIntoView: true })
      view.focus()
    }, number)
    const paint = async () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    for (const mode of ['outline', 'previews']) {
      await page.getByRole('button', { name: mode === 'outline' ? 'Show slides as an outline' : 'Show slides as previews' }).click()
      const panel = mode === 'outline' ? '[data-slides-organizer]' : '[data-place-region="strip"] > div:last-child'
      const list = page.locator(panel)
      const isOutline = mode === 'outline'
      const row = number => isOutline ? list.locator(number === 43 ? '.so-section' : '.so-slide')
        .filter({ has: page.getByText(followTitle(number), { exact: true }) })
        : list.locator(`[data-slide-index="${number - 1}"]`)
      const top = async () => list.evaluate(el => el.querySelector('.so-search')?.getBoundingClientRect().bottom ?? el.getBoundingClientRect().top)
      const offset = async item => (await item.boundingBox()).y - await top()
      const assertActive = async number => {
        if (isOutline) await row(number).and(list.locator('.so-row--current')).waitFor()
        else await row(number).and(list.locator('[data-active="true"]')).waitFor()
      }
      const title = number => row(number).locator(number === 43
        ? isOutline ? '.so-section-label > span' : '.tw-structure-section-title'
        : isOutline ? '.so-slide-title' : '.tw-strip-caption > span:nth-child(2)')
      const checkWrapped = async number => {
        const text = title(number)
        const name = followTitle(number)
        const geometry = await text.evaluate(element => {
          const style = getComputedStyle(element)
          const box = element.getBoundingClientRect()
          const line = Number.parseFloat(style.lineHeight)
          return { height: box.height, y: box.y, line, clamp: style.webkitLineClamp, scrollHeight: element.scrollHeight }
        })
        assert.equal(geometry.clamp, '2', `${mode}: ${number} clamps at two lines`)
        assert.ok(Math.abs(geometry.height - 2 * geometry.line) < 1 && geometry.scrollHeight > geometry.height + 1,
          `${mode}: ${number} wraps and clips further text (${JSON.stringify(geometry)})`)
        assert.equal(await text.evaluate(element => element.closest('[title]')?.getAttribute('title')), name,
          `${mode}: ${number} exposes its full title on hover`)
        const marks = row(number).locator(number === 43
          ? isOutline ? ':scope > .so-slide-no, :scope > svg' : ':scope > .tw-structure-row-number, :scope > svg'
          : isOutline ? ':scope > .so-slide-no, :scope > svg' : '.tw-strip-caption > span:first-child')
        for (const mark of await marks.all()) {
          const box = await mark.boundingBox()
          assert.ok(Math.abs((box.y + box.height / 2) - (geometry.y + geometry.line / 2)) < 4,
            `${mode}: ${number} number and icons align with the first line`)
        }
      }
      await list.evaluate(el => {
        const scroll = el.scrollTo.bind(el)
        el.dataset.followCalls = '0'
        el.scrollTo = options => {
          el.dataset.followCalls = String(Number(el.dataset.followCalls) + 1)
          scroll(options)
        }
      })
      await caretTo(39)
      await assertActive(39)
      await paint()
      await checkWrapped(39)
      if (isOutline) assert.ok((await row(39).boundingBox()).height > (await row(38).boundingBox()).height,
        'Outline rows grow with their titles')
      assert.ok(Math.abs(await offset(row(39))) < 2, `${mode}: caret on slide 39 puts row 39 at the top`)
      assert.equal(await list.getAttribute('data-follow-calls'), '1', `${mode}: one programmed scroll to slide 39`)
      await row(12).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }))
      await paint()
      const manualTop = await list.evaluate(el => el.scrollTop)
      await row(12).click()
      await assertActive(12)
      await paint()
      assert.equal(await list.evaluate(el => el.scrollTop), manualTop, `${mode}: clicking row 12 keeps the manual position`)
      assert.equal(await list.getAttribute('data-follow-calls'), '1', `${mode}: clicking row 12 requests no scroll`)
      await row(13).click({ modifiers: ['Shift'] })
      assert.equal(await row(12).and(list.locator(isOutline ? '.so-row--sel' : '[data-selected="true"]')).count(), 1,
        `${mode}: shift-selection includes the wrapped row`)
      await caretTo(50)
      await assertActive(50)
      const section = row(43)
      await paint()
      await checkWrapped(43)
      await checkWrapped(50)
      assert.ok(Math.abs(await offset(section)) < 2, `${mode}: the containing section is at the top`)
      assert.ok(Math.abs((await row(50).boundingBox()).y - ((await section.boundingBox()).y + (await section.boundingBox()).height)) < 2,
        `${mode}: slide 50 sits directly beneath its section at the end of the list`)
      await row(45).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }))
      await paint()
      const browsing = await list.evaluate(el => el.scrollTop)
      await caretTo(50)
      await paint()
      assert.equal(await list.evaluate(el => el.scrollTop), browsing, `${mode}: staying on the same slide leaves manual scrolling alone`)
      await caretTo(1)
      await assertActive(1)
      await paint()
      assert.ok(Math.abs(await offset(row(1))) < 2, `${mode}: following resumes on the next slide change`)

      await caretTo(46)
      await assertActive(46)
      const fold = section.locator('button[aria-expanded]')
      await fold.click()
      assert.equal(await fold.getAttribute('aria-expanded'), 'false')
      await row(50).waitFor({ state: 'detached' })
      await fold.click()
      await row(50).waitFor({ state: 'attached' })
      await row(50).evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }))
      await paint()
      const transfer = await page.evaluateHandle(() => new DataTransfer())
      await row(46).dispatchEvent('dragstart', { dataTransfer: transfer })
      const destination = row(50)
      for (const [side, fromTop] of [['before', true], ['after', false]]) {
        const box = await destination.boundingBox()
        await destination.dispatchEvent('dragover', {
          dataTransfer: transfer, clientX: box.x + 10, clientY: fromTop ? box.y + 2 : box.y + box.height - 2
        })
        await destination.locator(`[data-drop-side="${side}"]`).waitFor()
      }
      await row(46).dispatchEvent('dragend', { dataTransfer: transfer })
      await destination.locator('[data-drop-side]').waitFor({ state: 'detached' })
      await transfer.dispose()

      const gap = isOutline ? row(45).locator('..').locator(':scope > .tw-structure-add-line')
        : row(45).locator('xpath=../following-sibling::*[1]').and(list.locator('.tw-structure-add-line'))
      const trigger = gap.getByRole('button', { name: 'Insert here', exact: true })
      const choices = gap.getByRole('group', { name: 'Insert here', exact: true })
      const captureInsert = async state => {
        if (process.env.TW_OUTLINE_LOOK) console.log('SIDEBAR_INSERT_LOOK ' + mode + '-' + state + ' ' + (
          await page.screenshot({ type: 'jpeg', quality: 86, scale: 'css', animations: 'disabled' })
        ).toString('base64'))
      }
      const text = () => page.evaluate(() => window.editorView().state.doc.toString())
      const writes = await page.evaluate(() => window.fixtureWrites)
      await trigger.hover()
      assert.equal(await trigger.evaluate(button => getComputedStyle(button, '::before').borderTopStyle), 'dotted')
      assert.equal(await choices.count(), 0, `${mode}: hover only shows the dotted prompt`)
      await captureInsert('gap')
      const gapBox = await trigger.boundingBox()
      const upper = await row(45).boundingBox()
      const lower = await row(46).boundingBox()
      assert.ok(gapBox.height > 0 && gapBox.height <= 14 &&
        gapBox.y >= upper.y + upper.height - 1 && gapBox.y + gapBox.height <= lower.y + 1,
      `${mode}: the hit area fits between the rows`)
      for (const number of [46, 45]) {
        await trigger.hover()
        await title(number).click()
        await assertActive(number)
        assert.equal(await text(), source, `${mode}: clicking title ${number} after hovering the gap inserts nothing`)
      }
      assert.equal(await page.evaluate(() => window.fixtureWrites), writes)
      if (isOutline) {
        await caretTo(46)
        await assertActive(46)
        const bars = () => list.locator('[data-line]').evaluateAll(rows => rows
          .filter(el => getComputedStyle(el).boxShadow !== 'none').map(el => Number(el.dataset.line)))
        assert.deepEqual(await bars(), [Number(await row(46).getAttribute('data-line'))], 'An inactive keyboard highlight has no blue bar')
        await title(45).click()
        await title(46).click({ modifiers: ['Shift'] })
        assert.deepEqual(await bars(), await Promise.all([45, 46].map(async number => Number(await row(number).getAttribute('data-line')))),
          'Both members of a real selection have a blue bar')
        await title(45).click()
      }
      await trigger.focus()
      await page.keyboard.press('Enter')
      await choices.waitFor()
      assert.equal(await trigger.getAttribute('aria-expanded'), 'true')
      assert.equal(await text(), source, `${mode}: Enter opens the choices without inserting`)
      await page.keyboard.press('Escape')
      await choices.waitFor({ state: 'detached' })
      assert.equal(await trigger.evaluate(el => el === document.activeElement), true)
      await trigger.click()
      await choices.waitFor()
      await title(46).click()
      await assertActive(46)
      await choices.waitFor({ state: 'detached' })
      assert.equal(await text(), source, `${mode}: a title click dismisses open choices without inserting`)
      await trigger.click()
      await choices.waitFor()
      assert.deepEqual(await choices.getByRole('button').allTextContents(), ['Slide', 'Section', 'Subsection'])
      const choiceBox = await choices.boundingBox()
      assert.ok(choiceBox.y >= (await row(45).boundingBox()).y + (await row(45).boundingBox()).height - 1 &&
        choiceBox.y + choiceBox.height <= (await row(46).boundingBox()).y + 1, `${mode}: open choices leave both rows uncovered`)
      assert.equal(await text(), source, `${mode}: clicking the line opens the choices without inserting`)
      await captureInsert('choices')
      await choices.getByRole('button', { name: 'Slide', exact: true }).click()
      await page.waitForFunction(() => /^### \{id=[0-9a-f]{8}\}$/m.test(window.editorView()?.state.doc.toString() ?? ''))
      const inserted = await text()
      assert.equal(inserted.match(/^### \{id=[0-9a-f]{8}\}$/gm)?.length, 1, `${mode}: one choice inserts exactly one slide`)
      assert.match(inserted, /\{id=s45\}[^]*### \{id=[0-9a-f]{8}\}[^]*\{id=s46\}/)
      await page.waitForFunction(expected => window.compiledFixture === expected && window.savedFixture === expected, inserted)
      await page.locator('.cm-content').focus()
      await page.keyboard.press('ControlOrMeta+z')
      // The next mode checks that title clicks cause zero writes. The original bytes on disk
      // could still be there from before insertion if Undo beat its pending save.
      await page.waitForFunction(expected => window.editorView()?.state.doc.toString() === expected &&
        window.compiledFixture === expected && window.savedFixture === expected, source)
      await page.waitForFunction(async expected => await window.readFixture() === expected, source)
      if (!isOutline) {
        await page.setViewportSize({ width: 1000, height: 631 })
        await trigger.click()
        await choices.waitFor()
        const box = await choices.boundingBox()
        for (const option of await choices.getByRole('button').all()) {
          const button = await option.boundingBox()
          assert.ok(button.x >= box.x && button.x + button.width <= box.x + box.width,
            'All choices fit inside the compact thumbnail sidebar')
        }
        assert.equal(await text(), source, 'Opening the compact choices inserts nothing')
        await captureInsert('compact-choices')
        await page.keyboard.press('Escape')
        await choices.waitFor({ state: 'detached' })
        await page.setViewportSize({ width: 1440, height: 900 })
      }

      if (process.env.TW_OUTLINE_LOOK) {
        for (const [width, height] of [[1000, 631], [1440, 900]]) {
          await page.setViewportSize({ width, height })
          await caretTo(50)
          await assertActive(50)
          if (!isOutline && width < 1200) {
            assert.equal(await row(50).getAttribute('title'), followTitle(50))
            assert.equal(await section.getAttribute('title'), followTitle(43))
            assert.equal(await title(50).isVisible(), false, 'The compact thumbnail layout exposes its caption on hover')
          }
          for (const theme of ['light', 'dark']) {
            await page.emulateMedia({ colorScheme: theme })
            await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme)
            await paint()
            const name = `${width}x${height}-${theme}-${mode}`
            console.log('SIDEBAR_WRAP_LOOK ' + name + ' ' + (
              await page.screenshot({ type: 'jpeg', quality: 86, scale: 'css', animations: 'disabled' })
            ).toString('base64'))
          }
          await caretTo(46)
          await assertActive(46)
        }
        await page.setViewportSize({ width: 1440, height: 900 })
      }
      await caretTo(1)
      await assertActive(1)
    }
    console.log('Sidebar follow, wrapping and insertion: both modes passed title clicks, gap geometry, keyboard disclosure, one insert and one Undo; Outline passed the current and multi-selection bar checks.')
  } else if (outlinePreview) {
    const sidebar = page.locator('[data-right-column]')
    const sidebarToggle = page.getByTestId('sidebar-toggle')
    const organizer = page.locator('[data-slides-organizer]')
    const pinned = page.locator('.tw-structure-pinned')
    const header = pinned.getByRole('button', { name: /Current slide preview/ })
    const picture = pinned.locator('img, .tw-structure-pinned-placeholder')
    const outlineMode = page.getByRole('button', { name: 'Show slides as an outline' })
    const previewsMode = page.getByRole('button', { name: 'Show slides as previews' })
    const shifts = organizer.getByRole('button', { name: /Volunteer shifts/ })
    const photos = organizer.getByRole('button', { name: /Garden photographs/ })
    const level = async () => organizer.evaluate(element => element.clientHeight)
    const look = async name => {
      if (!process.env.TW_OUTLINE_LOOK) return
      console.log('OUTLINE_LOOK ' + name + ' ' + (
        await page.screenshot({ type: 'jpeg', quality: 86, scale: 'css', animations: 'disabled' })
      ).toString('base64'))
    }
    await page.locator('[data-view="markdown"]').waitFor()
    await sidebar.locator('.tw-inspector-stage').waitFor()
    await page.waitForFunction(text => window.compiledFixture === text && window.editorView()?.state.doc.toString() === text, source)
    assert.equal(await organizer.count(), 0, 'Previews mode is the initial sidebar mode')
    await outlineMode.click()
    await shifts.click()
    await organizer.locator('.so-row--current').filter({ hasText: 'Volunteer shifts' }).waitFor()
    await sidebar.getByText('Volunteer shifts', { exact: true }).first().waitFor()
    assert.equal(await pinned.count(), 0, 'Open right column gives all spare height to the outline')

    const firstSection = organizer.locator('.so-section').filter({ hasText: 'In the garden' }).locator('.so-caret')
    await firstSection.click()
    assert.equal(await firstSection.getAttribute('aria-expanded'), 'false')
    await shifts.waitFor({ state: 'detached' })
    await firstSection.click()
    await shifts.waitFor()
    await photos.click({ modifiers: ['Shift'] })
    assert.equal(await organizer.locator('.so-row--sel').count(), 2)
    const drag = await page.evaluateHandle(() => new DataTransfer())
    await shifts.dispatchEvent('dragstart', { dataTransfer: drag })
    const box = await photos.boundingBox()
    await photos.dispatchEvent('dragover', { dataTransfer: drag, clientX: box.x + 15, clientY: box.y + 2 })
    const target = photos.locator('[data-drop-side="before"]')
    await target.waitFor()
    assert.match(await target.innerText(), /^In /)
    await shifts.dispatchEvent('dragend', { dataTransfer: drag })
    await target.waitFor({ state: 'detached' })
    await drag.dispose()
    await shifts.click()

    for (const [width, height] of [[1000, 631], [1440, 900]]) {
      await page.setViewportSize({ width, height })
      for (const theme of ['light', 'dark']) {
        const name = `${width}x${height}-${theme}`
        await page.emulateMedia({ colorScheme: theme })
        await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme)
        const openHeight = await level()
        await look(name + '-right-open')
        await sidebarToggle.click()
        await sidebar.waitFor({ state: 'detached' })
        await picture.waitFor()
        assert.match(await header.innerText(), /Volunteer shifts/)
        assert.equal(await header.getAttribute('aria-expanded'), 'true')
        const previewHeight = await level()
        assert.ok(openHeight - previewHeight > 70, 'Open right column gives the preview space back to the outline')
        assert.ok(await header.evaluate(element => {
          const box = element.getBoundingClientRect()
          return box.width > 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight
        }), 'The preview header fits within the viewport')
        await look(name + '-right-collapsed')
        await header.click()
        assert.equal(await header.getAttribute('aria-expanded'), 'false')
        assert.equal(await picture.count(), 0)
        assert.ok(await level() - previewHeight > 60, 'Collapsing the preview gives its body space back to the outline')
        await look(name + '-preview-collapsed')
        await sidebarToggle.click()
        await sidebar.waitFor()
        assert.equal(await pinned.count(), 0)
        await sidebarToggle.click()
        await header.waitFor()
        assert.equal(await header.getAttribute('aria-expanded'), 'false')
        await previewsMode.click()
        await organizer.waitFor({ state: 'detached' })
        assert.equal(await pinned.count(), 0)
        await outlineMode.click()
        assert.equal(await header.getAttribute('aria-expanded'), 'false')
        await header.press('Enter')
        await picture.waitFor()
        await sidebarToggle.click()
        await sidebar.waitFor()
      }
    }

    // Grid shares the current slide with the Inspector. The pinned preview is
    // available when the user closes that column.
    await page.getByTestId('grid-toggle').click()
    await sidebar.waitFor()
    assert.equal(await sidebarToggle.getAttribute('aria-pressed'), 'true')
    await sidebarToggle.click()
    await sidebar.waitFor({ state: 'detached' })
    await picture.waitFor()
    await look('1440x900-dark-right-hidden')
    await sidebarToggle.click()
    await page.getByTestId('markdown-toggle').click()
    await sidebar.waitFor()
    assert.equal(await pinned.count(), 0)

    // A dedicated Slide view preview still takes precedence with the right column closed.
    await sidebarToggle.click()
    await header.waitFor()
    await photos.click()
    await pinned.getByRole('button', { name: /Current slide preview.*Garden photographs/ }).waitFor()
    await page.getByTestId('slides-toggle').click()
    await page.locator('.workspace-slide-stage').waitFor()
    assert.equal(await pinned.count(), 0)
    await page.getByTestId('markdown-toggle').click()
    await header.waitFor()
    await header.click()
    await page.reload()
    await page.evaluate(props => window.mountFixture(props), props)
    await outlineMode.click()
    await header.waitFor()
    assert.equal(await header.getAttribute('aria-expanded'), 'false', 'Page reload keeps the choice in this window')
    const other = await context.newPage()
    await other.exposeFunction('readFixture', () => source)
    await other.exposeFunction('compileFixture', async text => buildPerSlideProjections(
      await prepareSource(outline, text, 'Garden meeting', statSync(outline)), 'garden'))
    await other.goto(pathToFileURL(html).href)
    await other.evaluate(props => window.mountFixture(props), props)
    await other.getByRole('button', { name: 'Show slides as an outline' }).click()
    const otherHeader = other.locator('.tw-structure-pinned').getByRole('button', { name: /Current slide preview/ })
    await otherHeader.waitFor()
    assert.equal(await otherHeader.getAttribute('aria-expanded'), 'true', 'A second window has its own choice')
    await other.close()
    console.log('Outline preview: open, collapsed and hidden right column; height recovery, fold, selection, drop target, view switching and per-window disclosure.')
  } else if (polish) {
    await page.locator('[data-view="markdown"]').waitFor()
    await page.waitForFunction(text => window.compiledFixture === text && window.editorView()?.state.doc.toString() === text, source)
    await page.evaluate(() => {
      const view = window.editorView()
      const line = view.state.doc.toString().split('\n').findIndex(text => text.includes('Monday')) + 1
      view.dispatch({ selection: { anchor: view.state.doc.line(line).to } })
      view.focus()
      window.workspaceStructureReads = 0
      view.dispatch(view.state.replaceSelection('!'), { userEvent: 'input.type' })
      window.synchronousStructureReads = window.workspaceStructureReads
    })
    assert.equal(await page.evaluate(() => window.synchronousStructureReads), 0, 'typing leaves the structure read to the workspace render')
    await page.waitForFunction(() => window.workspaceStructureReads > 0)
    assert.equal(await page.evaluate(() => window.workspaceStructureReads), 1, 'the rendered outline and caret share the read')
    await page.waitForFunction(() => document.querySelector('.workspace-caret-path')?.textContent.endsWith('Volunteer shifts'))
    await page.locator('[data-slides-organizer]').getByRole('button', { name: /Garden photographs/ }).click()
    await page.waitForFunction(() => {
      const view = window.editorView()
      return view.hasFocus && view.state.doc.lineAt(view.state.selection.main.head).text.includes('Garden photographs')
    })
    const themes = ['light', 'dark']
    const setTheme = theme => page.evaluate(value => { document.documentElement.dataset.theme = value }, theme)
    const look = async (name, theme, target = page) => {
      if (process.env.TW_POLISH_LOOK) console.log('POLISH_LOOK ' + name + '-' + theme + ' ' +
        (await target.screenshot({ type: 'jpeg', quality: 85 })).toString('base64'))
    }
    const contrast = (foreground, background) => {
      const luminance = rgb => rgb.match(/[\d.]+/g).slice(0, 3).map(channel => {
        const value = Number(channel) / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      }).reduce((luma, value, i) => luma + value * [0.2126, 0.7152, 0.0722][i], 0)
      const pair = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
      return (pair[0] + 0.05) / (pair[1] + 0.05)
    }
    const menu = page.locator('.cm-tooltip-autocomplete')
    const inspectMenu = async name => {
      await page.evaluate(() => window.centerFixtureCaret())
      await page.waitForFunction(() => {
        const menu = document.querySelector('.cm-tooltip-autocomplete')
        if (!menu) return false
        const box = menu.getBoundingClientRect()
        return menu.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
      })
      const backgrounds = []
      for (const theme of themes) {
        await setTheme(theme)
        const { panel, rows } = await menu.evaluate(element => ({
          panel: getComputedStyle(element).backgroundColor,
          rows: Array.from(element.querySelectorAll('[role="option"]'), row => ({
            selected: row.getAttribute('aria-selected') === 'true',
            foreground: getComputedStyle(row.querySelector('.cm-completionLabel') ?? row).color,
            background: getComputedStyle(row).backgroundColor
          }))
        }))
        assert.ok(rows.some(row => row.selected) && rows.some(row => !row.selected), name + ' has selected and unselected rows')
        for (const row of rows) {
          assert.equal(row.background === panel, !row.selected, name + ' uses its panel tone on unselected rows')
          assert.ok(contrast(row.foreground, row.background) >= 4.5,
            `${name} label is readable in ${theme} (${row.foreground} on ${row.background})`)
        }
        console.log('Menu contrast', name, theme, Object.fromEntries(rows.map(row =>
          [row.selected ? 'selected' : 'unselected', contrast(row.foreground, row.background).toFixed(2)])))
        backgrounds.push(panel)
        await look(name + '-menu', theme, menu)
      }
      assert.notEqual(...backgrounds, name + ' follows the theme')
    }
    const dropInEditor = async () => page.evaluate(() => {
      const view = window.editorView()
      const lines = view.state.doc.toString().split('\n')
      const caret = view.state.doc.line(lines.indexOf('- Repair the beds') + 1).to
      const drop = view.state.doc.line(lines.indexOf('- Monday!') + 1).from + 2
      view.dispatch({ selection: { anchor: caret } })
      view.focus()
      window.centerFixtureCaret()
      return { caret, drop }
    })
    const noticeTones = { success: [], error: [] }
    const failure = 'This picture could not be added because the destination was temporarily unavailable. Check that the media folder can be written to and try pasting the picture again. The outline still contains the original slide and all its text.'
    for (const theme of themes) {
      await setTheme(theme)
      await page.evaluate(() => {
        const data = new DataTransfer()
        data.items.add(new File(['synthetic picture'], 'test.png', { type: 'image/png' }))
        window.editorView().contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
      })
      const progress = page.locator('.tw-picture-progress')
      await progress.waitFor()
      assert.equal(await progress.innerText(), 'Adding picture…')
      const nearCaret = await progress.evaluate(element => {
        const view = window.editorView()
        const caret = view.coordsAtPos(view.state.selection.main.head)
        const box = element.getBoundingClientRect()
        return Math.abs(box.left - caret.left) < 25 && Math.abs(box.top - caret.bottom) < 45
      })
      assert.equal(nearCaret, true)
      await look('picture-progress', theme)
      await page.waitForFunction(() => window.failPictureImport != null)
      await page.evaluate(message => { window.failPictureImport(message); window.failPictureImport = null }, failure)
      await progress.waitFor({ state: 'detached' })
      const notice = page.getByRole('dialog', { name: 'Notices' }).getByText(failure, { exact: true })
      await notice.waitFor()
      assert.ok(await notice.evaluate(element => element.scrollWidth <= element.clientWidth + 1 && element.clientHeight > 20), 'the full failure wraps')
      await look('picture-failure', theme)
      await notice.locator('..').getByRole('button', { name: 'Dismiss' }).click()
      const popover = page.getByRole('dialog', { name: 'Notices' })
      await popover.waitFor({ state: 'detached' })

      const target = await dropInEditor()
      await page.waitForFunction(drop => {
        const view = window.editorView()
        const point = view.coordsAtPos(drop)
        return point && view.contentDOM.contains(document.elementFromPoint(point.left, (point.top + point.bottom) / 2))
      }, target.drop)
      await page.evaluate(drop => {
        const view = window.editorView()
        const point = view.coordsAtPos(drop)
        const dataTransfer = new DataTransfer()
        for (const name of ['one.png', 'two.png']) {
          dataTransfer.items.add(new File(['synthetic picture'], name, { type: 'image/png' }))
        }
        const clientX = point.left, clientY = (point.top + point.bottom) / 2
        document.elementFromPoint(clientX, clientY).dispatchEvent(new DragEvent('drop', {
          clientX, clientY, dataTransfer, bubbles: true, cancelable: true
        }))
      }, target.drop)
      await progress.waitFor()
      assert.equal(await progress.innerText(), 'Adding pictures…')
      await page.waitForFunction(({ caret, drop }) => {
        const view = window.editorView()
        const status = document.querySelector('.tw-picture-progress')?.getBoundingClientRect()
        const point = view.coordsAtPos(drop)
        const caretPoint = view.coordsAtPos(caret)
        return status && point && caretPoint && view.state.selection.main.head === caret &&
          Math.abs(status.left - point.left) < 25 && Math.abs(status.top - point.bottom) < 45 &&
          Math.abs(status.top - caretPoint.bottom) > 45
      }, target)
      await look('picture-drop-progress', theme)
      await page.waitForFunction(() => window.failPictureImport != null)
      await page.evaluate(message => { window.failPictureImport(message); window.failPictureImport = null }, failure)
      await progress.waitFor({ state: 'detached' })
      await notice.locator('..').getByRole('button', { name: 'Dismiss' }).click()
      await popover.waitFor({ state: 'detached' })

      for (const level of ['success', 'error']) {
        await page.evaluate(value => window.showFixtureNotice(value), level)
        const chip = page.locator(`[data-status-notice="${level}"]`)
        const row = popover.getByText('Fixture ' + level, { exact: true }).locator('..')
        await row.waitFor()
        const tone = element => {
          const style = getComputedStyle(element)
          return { foreground: style.color, background: style.backgroundColor }
        }
        const colours = await chip.evaluate(tone)
        assert.deepEqual(await row.evaluate(tone), colours)
        assert.ok(contrast(colours.foreground, colours.background) >= 4.5, level + ' notice is readable in ' + theme)
        const action = await row.getByRole('button', { name: 'Review', exact: true }).evaluate(tone)
        assert.ok(contrast(action.foreground, action.background) >= 4.5, level + ' action is readable in ' + theme)
        noticeTones[level].push(colours.background)
        await look(level + '-notice', theme, popover)
        await row.getByRole('button', { name: 'Dismiss' }).click()
        await popover.waitFor({ state: 'detached' })
      }
    }
    for (const [level, backgrounds] of Object.entries(noticeTones)) {
      assert.notEqual(...backgrounds, level + ' notice follows the theme')
    }
    await setTheme('light')
    await page.keyboard.press((process.platform === 'darwin' ? 'Meta' : 'Control') + '+z')
    await page.waitForFunction(text => window.editorView()?.state.doc.toString() === text, source)
    await page.evaluate(() => {
      const view = window.editorView()
      view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true })
      view.focus()
    })
    await page.keyboard.press('Enter')
    await page.keyboard.type('## ')
    await page.getByRole('option', { name: 'New section', exact: true }).waitFor()
    await page.waitForTimeout(100)
    await page.keyboard.press('Enter')
    const sectionNotice = page.getByRole('button', { name: /^Notice: Section added/ })
    await sectionNotice.waitFor()
    await sectionNotice.locator('..').getByRole('button', { name: 'Undo', exact: true }).waitFor()
    await page.locator('.cm-content').focus()
    const undoKey = (process.platform === 'darwin' ? 'Meta' : 'Control') + '+z'
    await page.keyboard.press(undoKey)
    await sectionNotice.waitFor({ state: 'detached' })
    const typeBareSlideHeading = async (body = '') => {
      const prefix = source + '\n'
      await page.evaluate(({ text, caret }) => {
        const view = window.editorView()
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: caret }, scrollIntoView: true, filter: false })
        view.focus()
      }, { text: prefix + body, caret: prefix.length })
      await page.keyboard.type('### ')
      await page.getByRole('option', { name: 'New subsection', exact: true }).waitFor()
      return prefix
    }
    const body = '\nExisting body\n'
    const prefix = await typeBareSlideHeading(body)
    const newSlide = page.getByRole('option', { name: 'New slide', exact: true })
    const newSubsection = page.getByRole('option', { name: 'New subsection', exact: true })
    await newSlide.waitFor()
    assert.equal(await newSlide.getAttribute('aria-selected'), 'true')
    await inspectMenu('heading')
    await page.waitForTimeout(100)
    await page.keyboard.press('Enter')
    await newSlide.waitFor({ state: 'detached' })
    const unfinished = await page.evaluate(() => {
      const view = window.editorView()
      return { text: view.state.doc.toString(), caret: view.state.selection.main.head }
    })
    assert.deepEqual(unfinished, { text: prefix + '### ' + body, caret: prefix.length + 5 },
      'Enter with an untouched suggestion keeps the unfinished heading and goes to its body')

    await page.evaluate(() => {
      const view = window.editorView()
      const anchor = view.state.doc.toString().indexOf('\n\n- Monday') + 1
      if (anchor === 0) throw new Error('The brace fixture needs a blank line above Monday')
      view.dispatch({ selection: { anchor }, scrollIntoView: true })
      view.focus()
    })
    await page.keyboard.type('{')
    await menu.waitFor()
    await inspectMenu('brace')
    await page.keyboard.press('Escape')
    await page.evaluate(() => window.editorView().contentDOM.blur())
    await page.waitForFunction(expected => window.editorView()?.state.doc.toString() === expected, unfinished.text)

    const splitSource = normalizePositions(source.replace('- Monday', '- Saturday\n\n- Monday'))
    const midSlide = splitSource.indexOf('- Monday')
    const before = splitSource.slice(0, midSlide)
    const after = splitSource.slice(midSlide)
    const beforeSplit = before + '### \n' + after
    await page.evaluate(({ text, caret }) => {
      const view = window.editorView()
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: caret }, scrollIntoView: true, filter: false })
      view.focus()
    }, { text: before + '\n' + after, caret: midSlide })
    await page.keyboard.type('### ')
    await newSlide.waitFor()
    await page.keyboard.press('Tab')
    await page.waitForFunction(({ at, before, after }) => {
      const view = window.editorView()
      const text = view?.state.doc.toString()
      if (!text || text !== window.compiledFixture || view.state.selection.main.head !== at + 4) return false
      const line = view.state.doc.lineAt(view.state.selection.main.head)
      return line.from === at &&
        text.slice(0, at) === before &&
        /^###[ \t]+\{id=[a-f0-9]{8}\}\n\{list\}\n/.test(text.slice(at)) &&
        text.slice(view.state.doc.line(line.number + 2).from) === after
    }, { at: midSlide, before, after }).catch(async error => {
      console.error('Split fixture after accepting New slide:', await page.evaluate(() => {
        const view = window.editorView()
        const text = view.state.doc.toString()
        return { text, compiled: text === window.compiledFixture, caret: view.state.selection.main.head }
      }))
      throw error
    })
    await page.keyboard.press(undoKey)
    await page.waitForFunction(text => window.editorView()?.state.doc.toString() === text, beforeSplit)
    await typeBareSlideHeading()
    await page.keyboard.press('ArrowDown')
    assert.equal(await newSubsection.getAttribute('aria-selected'), 'true')
    await page.keyboard.press('Enter')
    await page.waitForFunction(() => window.editorView()?.state.doc.toString().includes('{sub}{role=subsection-title}'))
    console.log('PASS Markdown caret reads, outline row focus, picture feedback, section Undo, menu and notice themes')
  } else {
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
    const captureLook = async (label, theme, target) => {
      if (process.env.TW_SLIDE_DESIGN_CAPTURE === '1') {
        const capture = await target.screenshot({ type: 'jpeg', quality: 80 })
        console.log(`SLIDE_DESIGN_CAPTURE ${label} ${theme} ${capture.toString('base64')}`)
      }
    }
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
    await page.waitForFunction(text => window.savedFixture === text, source)
    await inspector.focus()
    await page.keyboard.press(mod + '+Shift+Z')
    await waitForBuffer(changed)
    await page.waitForFunction(text => window.compiledFixture === text, changed)
    assert.equal(await title.innerText(), targetName)
    assert.equal(await right.getAttribute('aria-pressed'), 'true')
    console.log('First Picture edit: the save relocates heading IDs, Undo restores the original bytes and Redo restores the saved bytes, both on Picture.')

    const previousBeforeUndo = inspector.getByRole('button', { name: 'Previous slide', exact: true })
    await previousBeforeUndo.click()
    await title.filter({ hasText: /^Volunteer shifts$/ }).waitFor()
    await page.keyboard.press(mod + '+z')
    await waitForBuffer(source)
    await page.waitForFunction(text => window.compiledFixture === text, source)
    await title.filter({ hasText: targetName }).waitFor()
    await page.locator('.workspace-slide-crumb strong').filter({ hasText: /Slide 4 of / }).waitFor()
    assert.match(await page.evaluate(() => {
      const { doc, selection } = window.editorView().state
      return doc.lineAt(selection.main.head).text
    }), /^### Garden photographs/)
    await left.waitFor()
    await inspector.focus()
    await page.keyboard.press(mod + '+Shift+Z')
    await waitForBuffer(changed)
    await page.waitForFunction(text => window.compiledFixture === text, changed)
    assert.equal(await right.getAttribute('aria-pressed'), 'true')

    // Escape still belongs to CodeMirror when its search panel has focus.
    const editor = page.locator('.cm-content')
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

    // Switch the open talk through the toolbar, as the author would.
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
    await picture.locator('.tw-right-picture[aria-pressed=true] img').evaluate(image => image.decode())
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme })
      await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme)
      const tiles = await picture.locator('.tw-right-picture').evaluateAll(buttons => buttons.map(button => {
        const label = button.querySelector('strong')
        const text = document.createRange()
        text.selectNodeContents(label)
        const frame = button.querySelector('.tw-right-picture-frame').getBoundingClientRect()
        const badge = button.querySelector('.tw-right-current')
        return { label: label.textContent, tileWidth: button.clientWidth, lines: text.getClientRects().length,
          fits: text.getBoundingClientRect().width <= label.clientWidth,
          pictureTop: frame.top, badgeBottom: badge?.getBoundingClientRect().bottom }
      }))
      assert.equal(tiles.length, 3)
      assert.ok(tiles.every(tile => tile.lines === 1 && tile.fits && tile.pictureTop === tiles[0].pictureTop), JSON.stringify(tiles))
      const current = tiles.find(tile => tile.badgeBottom !== undefined)
      assert.ok(current && current.badgeBottom <= current.pictureTop, JSON.stringify(tiles))
      await captureLook('narrow-picture', theme, picture.locator('.tw-right-pictures'))
      console.log(`1000px ${theme} Picture page: all three labels fit and Current clears the previews.`)
    }
    await page.emulateMedia({ colorScheme: 'light' })

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
    console.log(`1000x631: tile edges align with the preview, with a ${fit.gutter}px gutter and 0px Copy movement as overflow appears.`)

    await page.getByTestId('markdown-toggle').click()
    await page.locator('[data-view="markdown"] .cm-content').waitFor()
    await page.evaluate(() => {
      const view = window.editorView()
      const phrase = 'Repair the beds'
      const at = view.state.doc.toString().indexOf(phrase)
      if (at < 0) throw new Error('Missing Markdown formatting fixture')
      view.dispatch({ selection: { anchor: at, head: at + phrase.length }, scrollIntoView: true })
      view.focus()
    })
    const actionBar = page.getByRole('toolbar', { name: 'Action bar' })
    const bold = actionBar.locator('button[data-command="format-bold"]')
    if (!await bold.isVisible()) await actionBar.getByRole('button', { name: 'More actions', exact: true }).click()
    await bold.click()
    await page.waitForFunction(() => window.editorView()?.state.doc.toString().includes('**Repair the beds**'))
    console.log('The Markdown toolbar formats the selected source text.')

    for (let clicks = 0; clicks < 6 && (await title.innerText()) !== 'Seedlings'; clicks++) await next.click()
    assert.equal(await title.innerText(), 'Seedlings')
    await page.waitForFunction(() => window.compiledFixture === window.editorView()?.state.doc.toString())
    await home.getByRole('button', { name: /^Title\b.*At the side/ }).waitFor()
    await inspector.getByRole('button', { name: /Title and points/ }).click()
    await page.waitForFunction(() => {
      const text = window.savedFixture
      const slide = text?.split('### Seedlings')[1]?.split('### Harvest counts')[0]
      return text === window.compiledFixture && /\{[^}]*\blist(?=[\s}])/.test(slide ?? '')
    })
    await home.getByRole('button', { name: /^Title\b.*On top/ }).waitFor()
    const seedlings = readFileSync(outline, 'utf8').split('### Seedlings')[1].split('### Harvest counts')[0]
    assert.match(seedlings, /\{[^}]*\blist\b/)
    assert.doesNotMatch(seedlings, /\b(?:titletop|sidebar|title=show)\b/)
    await home.getByRole('button', { name: /^Title\b/ }).click()
    await inspector.getByText(/Follows the talk: on top/).waitFor()
    console.log('Switching from Row to Title and points clears the old sidebar and inherits the target section’s top title.')
    const placement = inspector.locator('[data-section="title"]')
    await placement.getByRole('button', { name: /^At the side/ }).click()
    await placement.getByRole('button', { name: /Current.*At the side/ }).waitFor()
    await placement.getByRole('button', { name: /^On top/ }).click()
    await placement.getByRole('button', { name: /Current.*On top/ }).waitFor()
    await page.waitForFunction(() => {
      const text = window.savedFixture
      const slide = text?.split('### Seedlings')[1]?.split('### Harvest counts')[0]
      return Boolean(slide) && text === window.compiledFixture && !/\b(?:titletop|sidebar|title=show)\b/.test(slide)
    })
    await inspector.getByText(/Follows the talk: on top/).waitFor()
    console.log('Choosing the inherited placement on the same layout clears its authored placement.')
    await page.evaluate(() => {
      const view = window.editorView()
      const text = view.state.doc.toString()
      const end = text.indexOf('\n', text.indexOf('### Seedlings'))
      view.dispatch({ changes: { from: end, insert: ' {title=top}' } })
    })
    await inspector.getByText('Changed on this slide only.').waitFor()
    await placement.getByRole('button', { name: /Current.*On top/ }).click()
    await inspector.getByText(/Follows the talk: on top/).waitFor()
    console.log('An explicit copy of the inherited placement still reads Current and can be cleared.')

    const back = inspector.getByRole('button', { name: 'Back', exact: true })
    const previous = inspector.getByRole('button', { name: 'Previous slide', exact: true })
    await back.click()
    for (let clicks = 0; clicks < 3 && (await title.innerText()) !== targetName; clicks++) await previous.click()
    assert.equal(await title.innerText(), targetName)
    await home.getByRole('button', { name: /^Title\b.*At the side/ }).waitFor()
    await pictureButton.click()
    const above = picture.getByRole('button', { name: /^Above(?:\s|$)/ })
    await above.click()
    await picture.getByRole('button', { name: /Current.*Above/ }).waitFor()
    assert.match(await page.evaluate(() => window.editorView().state.doc.toString()), /image=above/)
    await back.click()
    await home.getByRole('button', { name: /^Picture\b.*Above the points/ }).waitFor()
    await home.getByRole('button', { name: /^Title\b.*On top/ }).click()
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme })
      await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme)
      await inspector.getByText('On top while the picture is above the points. The talk puts titles at the side.').waitFor()
      await inspector.getByRole('button', { name: 'Change for the talk' }).waitFor()
      await captureLook('picture-title-origin', theme, inspector.locator('[data-section="title"] .tw-right-origin'))
    }
    await page.emulateMedia({ colorScheme: 'light' })
    await back.click()
    await inspector.getByRole('button', { name: /Show all .* designs/ }).click()
    const designs = inspector.locator('[data-section="designs"]')
    const aboveDesign = designs.getByRole('button', { name: /Picture above/ })
    const stage = inspector.locator('.tw-inspector-stage')
    const preview = stage.frameLocator('iframe')
    // The Picture page shows the compiled buffer before autosave necessarily reaches disk.
    await page.waitForFunction(() => {
      const text = window.editorView()?.state.doc.toString()
      return text != null && text === window.compiledFixture && text === window.savedFixture
    })
    const beforeTry = readFileSync(outline, 'utf8')
    assert.match(beforeTry, /^### Garden photographs\n\{id=p3\}\{image=above\}$/m)
    const writesBeforeTry = await page.evaluate(() => window.fixtureWrites)
    await aboveDesign.hover()
    await stage.locator('xpath=self::*[@data-panel-trying="true"]').waitFor()
    await preview.locator('section.slide.active[data-id="p3"] .icon-row').waitFor()
    assert.equal(await page.evaluate(() => window.fixtureWrites), writesBeforeTry, 'trying the design leaves the write queue alone')
    assert.equal(await page.evaluate(() => window.editorView().state.doc.toString()), beforeTry)
    assert.equal(readFileSync(outline, 'utf8'), beforeTry)
    await aboveDesign.click()
    await designs.getByRole('button', { name: /Current.*Picture above/ }).waitFor()
    // Current can update while the iframe still shows the hover preview. Wait for the
    // committed source and the matching preview URL before decoding or measuring its image.
    await page.waitForFunction(before => {
      const text = window.editorView()?.state.doc.toString()
      const stage = document.querySelector('.tw-inspector-stage')
      const url = stage?.querySelector('iframe')?.src.split('#')[0]
      return text !== before && text === window.savedFixture && text === window.compiledFixture &&
        !stage?.hasAttribute('data-panel-trying') && url && window.fixturePreviewText.get(url) === text
    }, beforeTry)

    async function checkLooks(label, slide, geometry) {
      for (const theme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: theme })
        await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme)
        const result = await preview.locator(`section.slide.active[data-id="${slide}"]`).evaluate(geometry)
        await captureLook(label, theme, inspector)
        assert.ok(result.ok, `${theme} ${label}: ${JSON.stringify(result)}`)
        console.log(`${theme} ${label}: ${JSON.stringify(result)}`)
      }
      await page.emulateMedia({ colorScheme: 'light' })
    }
    const frame = await (await stage.locator('iframe').elementHandle()).contentFrame()
    await frame.waitForFunction(async () => {
      const image = document.querySelector('section.slide.active[data-id="p3"] .slot-media img')
      if (!image?.complete || image.naturalWidth === 0) return false
      await image.decode()
      return true
    })
    await checkLooks('picture-above', 'p3', slide => {
      const media = slide.querySelector('.slot[data-slot-side="above"] > .slot-media')
      const row = slide.querySelector('.slot-copy .icon-row')
      const boxes = [...row.querySelectorAll('.ir-item')].map(item => item.getBoundingClientRect())
      const mediaBox = media.getBoundingClientRect()
      const image = media.querySelector('img')
      const imageBox = image.getBoundingClientRect()
      const slideBox = slide.getBoundingClientRect()
      return { ok: image.complete && image.naturalWidth > 0 && Math.abs(imageBox.width - mediaBox.width) <= 1 &&
        getComputedStyle(image).objectFit === 'cover' && boxes.length === 3 && boxes[0].top > mediaBox.bottom &&
        boxes.every((box, index) => box.top === boxes[0].top && box.bottom < slideBox.bottom &&
          (!index || box.left > boxes[index - 1].left)),
      pictureBottom: mediaBox.bottom, pointsTop: boxes[0].top, pointsBottom: Math.max(...boxes.map(box => box.bottom)),
      stageBottom: slideBox.bottom, rowHeight: row.getBoundingClientRect().height, points: boxes.length }
    })
    await pictureButton.click()
    await picture.getByRole('button', { name: /Current.*Above/ }).waitFor()
    await right.click()
    await picture.getByRole('button', { name: /Current.*On the right/ }).waitFor()
    await back.click()
    for (let clicks = 0; clicks < 4 && (await title.innerText()) !== 'Harvest counts'; clicks++) await next.click()
    assert.equal(await title.innerText(), 'Harvest counts')
    await home.getByRole('button', { name: /^Table\b/ }).click()
    const table = inspector.locator('[data-section="table"]')
    await table.getByRole('button', { name: /Row bands/ }).click()
    await table.getByRole('button', { name: /Current.*Row bands/ }).scrollIntoViewIfNeeded()
    await preview.locator('section.slide.active[data-id="p5"] .table-row-bands').waitFor()
    await checkLooks('row-bands', 'p5', slide => {
      const table = slide.querySelector('.table-row-bands')
      const [first, second] = table.tBodies[0].rows
      const marker = getComputedStyle(first.cells[0])
      const fill = getComputedStyle(first.cells[1])
      const gap = second.getBoundingClientRect().top - first.getBoundingClientRect().bottom
      const markerShare = first.cells[0].getBoundingClientRect().width / table.getBoundingClientRect().width
      return { ok: gap > 0 && marker.fontWeight === '700' && marker.backgroundColor !== fill.backgroundColor &&
        markerShare < 0.3 && parseFloat(marker.borderTopLeftRadius) > 0 && table.tHead.rows[0].cells.length === 2,
      rows: table.tBodies[0].rows.length, gap, markerShare, marker: marker.backgroundColor, weight: marker.fontWeight, fill: fill.backgroundColor }
    })
    await table.getByRole('button', { name: /Plain grid/ }).click()
    await table.getByRole('button', { name: /Current.*Plain grid/ }).waitFor()
    assert.doesNotMatch(await page.evaluate(() => window.editorView().state.doc.toString()), /table-bands=on/)

    await back.click()
    const titleExamples = [
      '', '', '## Examples', '{id=title-examples}',
      '', '### Living things in the garden and what they need', '{cycle}{id=title-loop}', '',
      '- Prepare', '  - Check what the other teams expect', '- Plan', '  - Draft a plan',
      '- Review', '  - Send the instructions to the team', '- Share', '  - Pass the proposal to the manager',
      '- Refine', '  - Adjust the plan with the feedback received',
      '', '### What to do before the growing season starts', '{list}{iconlist}{iconlist=boxes}{id=title-list}',
      '', '- Water the beds', '- Pot the seedlings', '- Sort the tools',
      '', '### Three things the greenhouse needs this week', '{iconrow}{id=title-row}', '',
      '- Soil {icon=lucide:sprout}', '  - Replace the soil in the raised beds.',
      '- Water {icon=lucide:droplet}', '  - Bring a tall can for the hanging baskets.',
      '- Sun {icon=lucide:sun}', '  - Move the tray to the south wall.',
      '', '### Plan for the whole season, from seedlings to harvest', '{statement}{statement-sidebar=off}{id=title-statement}',
      '', 'A thriving garden needs a plan for the whole season.', ''
    ].join('\n')
    await page.evaluate(insert => {
      const view = window.editorView()
      view.dispatch({ changes: { from: view.state.doc.length, insert } })
    }, titleExamples)
    await page.waitForFunction(() => window.compiledFixture?.includes('id=title-statement'))

    const bodyDesign = slide => {
      const body = slide.querySelector('.cycle-diagram, .feature-list, .icon-row, .layout-statement > p')
      const items = [...body.querySelectorAll('.cycle-node, .feature-list > li, .ir-item')]
      const text = body.querySelector('.cycle-cap, .fl-text, .ir-label') ?? body
      const rect = body.getBoundingClientRect()
      return {
        design: slide.dataset.look,
        layout: slide.dataset.layout,
        items: items.length,
        columns: getComputedStyle(body).gridTemplateColumns,
        type: getComputedStyle(text).fontSize,
        ring: body.matches('.cycle-diagram') ? [Math.round(rect.width), Math.round(rect.height)] : null,
        ringLabels: [...body.querySelectorAll('.oc-loop-label')].filter(label => getComputedStyle(label).display !== 'contents').length,
        stack: body.hasAttribute('data-oc-stack'),
      }
    }
    for (const [id, name] of [
      ['title-loop', 'Living things in the garden and what they need'],
      ['title-list', 'What to do before the growing season starts'],
      ['title-row', 'Three things the greenhouse needs this week'],
      ['title-statement', 'Plan for the whole season, from seedlings to harvest'],
    ]) {
      for (let clicks = 0; clicks < 4 && (await title.innerText()) !== name; clicks++) await next.click()
      assert.equal(await title.innerText(), name)
      await home.getByRole('button', { name: /^Title\b/ }).click()
      const titlePage = inspector.locator('[data-section="title"]')
      const active = preview.locator(`section.slide.active[data-id="${id}"]`)
      const readBody = async () => {
        await active.evaluate(async () => {
          await document.fonts.ready
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        })
        return active.evaluate(bodyDesign)
      }
      const appliedOutline = () => page.evaluate(() => window.editorView().state.doc.toString())
      const sideTile = titlePage.locator('button.tw-right-picture').filter({ has: page.getByText('At the side', { exact: true }) })
      assert.equal(await sideTile.isDisabled(), true, `${id}: a rail would change the body arrangement`)
      for (const theme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: theme })
        await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme)
        await active.locator('.slide-head:not(.slide-head-quiet)').waitFor({ state: 'attached' })
        const before = await readBody()
        assert.equal(before.design, 'ocean', `${id} starts in the Ocean drawing`)
        for (const [label, key, token, painted] of [
          ['Section strip', 'panel:title-style:5', 'titlelook=tab-strip', '.title-strip .is-current'],
          ['Not shown', 'panel:title-placement:2', 'notitle', '.slide-head-quiet']
        ]) {
          const tile = titlePage.getByRole('button', { name: new RegExp('^' + label) })
          await tile.scrollIntoViewIfNeeded()
          await tile.hover()
          await stage.locator('xpath=self::*[@data-panel-trying="true"]').waitFor()
          await active.locator(painted).waitFor({ state: 'attached' })
          await page.waitForFunction(({ id, key, token }) => window.titleVariantInputs?.[key]?.split('### ').some(
            slide => slide.includes('{id=' + id + '}') && slide.includes('{' + token + '}')
          ), { id, key, token })
          const variant = await page.evaluate(key => window.titleVariantInputs[key], key)
          assert.deepEqual(await readBody(), before, `${theme} ${id} ${label}: preview keeps the body design`)
          await tile.click()
          await page.waitForFunction(text => window.savedFixture === text && window.compiledFixture === text, variant)
          assert.equal(await appliedOutline(), variant, `${label}: thumbnail and apply share the outline`)
          await active.locator(painted).waitFor({ state: 'attached' })
          assert.deepEqual(await readBody(), before, `${theme} ${id} ${label}: applied slide keeps the body design`)
          if (id === 'title-loop') await captureLook(`title-${token.replace('titlelook=', '')}`, theme, stage)
          if (id === 'title-statement') assert.match(variant, /\{statement-sidebar=off\}/)
          await titlePage.getByRole('button', { name: label === 'Not shown' ? /^On top/ : /^Kicker/ }).click()
          await active.locator('.slide-head:not(.slide-head-quiet) h1').waitFor({ state: 'attached' })
          await active.locator('.title-strip').waitFor({ state: 'detached' })
        }
      }
      await back.click()
    }
    for (let clicks = 0; clicks < 6 && (await title.innerText()) !== 'Harvest counts'; clicks++) await previous.click()
    assert.equal(await title.innerText(), 'Harvest counts')
    await page.emulateMedia({ colorScheme: 'light' })
    console.log('Title tiles keep the cycle, boxed list, icon row and statement in light and dark; thumbnail inputs match the saved outline.')
  }
  if (!polish && !slideText && !notes && !outlinePreview && !sidebarFollow) {
    const sidebar = page.getByRole('tablist', { name: 'Sidebar' })
    const talkTab = page.locator('[data-talk-tab]')
    const theme = name => talkTab.locator('.tw-right-picture').filter({ has: page.getByText(name, { exact: true }) })
    const openDesign = async () => {
      await sidebar.getByRole('tab', { name: 'Talk', exact: true }).click()
      await talkTab.getByRole('button', { name: 'Design', exact: true }).click()
    }
    await openDesign()
    assert.deepEqual(await theme('Ocean').locator('..').locator('button > strong').allTextContents(),
      ['Ocean', 'Ocean, bold amber', 'Forest', 'Slate', 'Classic', 'Green (classic)'])
    assert.equal(await theme('Ocean').getAttribute('aria-pressed'), 'true')
    for (const [label, value, colours] of [
      ['Forest', 'forest', ['Green', 'Deep green']],
      ['Slate', 'slate', ['Slate', 'Deep slate']]
    ]) {
      await theme(label).click()
      await page.waitForFunction(palette => {
        const text = window.editorView()?.state.doc.toString()
        return text === window.compiledFixture && text.includes('\npalette: ' + palette + '\n')
      }, value)
      await page.waitForFunction(async expected => (await window.readFixture()).includes('\npalette: ' + expected + '\n'), value)
      assert.equal(await theme(label).getAttribute('aria-pressed'), 'true')

      await sidebar.getByRole('tab', { name: 'Slide', exact: true }).click()
      const inspector = page.locator('.tw-inspector')
      const previous = inspector.getByRole('button', { name: 'Previous slide', exact: true })
      const title = inspector.locator('.tw-right-who strong')
      await title.waitFor()
      for (let step = 0; step < 4 && (await title.innerText()) !== 'Greenhouse'; step++) await previous.click()
      assert.equal(await title.innerText(), 'Greenhouse')
      const colourPage = inspector.locator('[data-section="colour"]')
      // Switching back to this slide can restore its open Colour page.
      if (!await colourPage.isVisible()) await inspector.locator('.tw-right-adjust').getByRole('button', { name: /^Colour\b/ }).click()
      assert.deepEqual(await colourPage.locator('.tw-right-picture > strong').allTextContents(),
        ['Rotation', colours[0], 'Amber', colours[1], 'Light', 'Light with amber'])
      await openDesign()
    }
    await theme('Ocean').click()
    await page.waitForFunction(async () => {
      const text = window.editorView()?.state.doc.toString()
      return text === window.compiledFixture && text === await window.readFixture() && !/^palette:/m.test(text)
    })
    assert.equal(await theme('Ocean').getAttribute('aria-pressed'), 'true')
    console.log('Talk Design offers six palettes. Forest and Slate save and compile, show their section colour labels, and can be reset to Ocean.')
  }
  assert.deepEqual(errors, [])
} finally {
  await browser?.close()
  rmSync(scratch, { recursive: true, force: true })
}

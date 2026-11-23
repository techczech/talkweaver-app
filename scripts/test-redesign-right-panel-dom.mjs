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
const scratch = mkdtempSync(join(tmpdir(), 'tw-right-panel-dom-'))
const outline = join(scratch, 'garden-outline.md')
const source = (polish ? [
  '---', 'outline_version: 2', 'title: Garden meeting', 'auto_title_slide: false', 'auto_thanks_slide: false', '---',
  '', '## In the garden {id=g1}', '', '### Priorities {id=p1}', '', '- Repair the beds',
  '', '### Volunteer shifts {id=p2}', '', '- Monday', '', '### Garden photographs {id=p3}',
  '', '- The garden at the start of the year', '', '![The beds](beds.png)', ''
] : [
  '---', 'outline_version: 2', 'title: Garden meeting', 'auto_title_slide: false', 'auto_thanks_slide: false',
  'sections:', '  Greenhouse: { title: top }', '---',
  '', '## In the garden {id=g1}', '', '### Priorities {id=p1}', '', '- Repair the beds',
  '', '### Volunteer shifts {id=p2}', '', '- Monday', '', '### Garden photographs {id=p3}',
  '', '- Soil {icon=lucide:sprout}', '- Water {icon=lucide:droplet}', '- Sun {icon=lucide:sun}',
  '', '![The beds](beds.png)',
  '', '## Greenhouse {id=g2}', '', '### Seedlings {id=p4} {sidebar}',
  '{iconrow}', '', '- Sun', '- Water', '- Soil',
  '', '### Harvest counts {id=p5}', '', '| Bed | Seedlings |', '| --- | --- |', '| A | 12 |', '| B | 18 |', ''
]).join('\n')
writeFileSync(outline, source)
copyFileSync(join(root, 'demo-vault/layout-sampler/assets/sample-image.png'), join(scratch, 'beds.png'))

let browser
try {
  await build({
    plugins: [{ name: 'count-workspace-structure-reads', setup(bundle) {
      bundle.onLoad({ filter: /talk-structure\.ts$/ }, ({ path }) => {
        const source = readFileSync(path, 'utf8')
        const declaration = 'export function structureOf(text: string) {'
        assert.ok(source.includes(declaration))
        return { loader: 'ts', contents: source.replace(declaration, declaration +
          ' globalThis.workspaceStructureReads = (globalThis.workspaceStructureReads ?? 0) + 1;') }
      })
    }}],
    stdin: {
      contents: `
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
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
    return rows
  },
  // This fixture tests the workspace UI without launching the native thumbnail renderer.
  thumbnails: async () => null,
  layoutVariantThumbnail: async () => null,
  onOutlineChangedOnDisk: empty,
})
window.tw.slide.renderPreview = async (_path, text) => window.renderFixture(text)
window.tw.asset.pasteTalkPictures = async () => new Promise((_resolve, reject) => {
  window.failPictureImport = message => reject(new Error(message))
})
window.tw.workFiles = { list: async () => null }
window.tw.icons = { names: async () => [], svg: async () => null, search: async () => [] }
window.editorView = () => {
  const dom = document.querySelector('.cm-editor')
  return dom ? EditorView.findFromDOM(dom) : null
}
window.centerFixtureCaret = () => {
  const view = window.editorView()
  view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'center' }) })
}
function Fixture({ path, outlinePath, polish }) {
  const [outlineHost, setOutlineHost] = useState(null)
  const [slideTabView, setSlideTabView] = useState('pages')
  return <div className="app-shell">{polish && <div ref={setOutlineHost} style={{ flex: "0 0 190px", minWidth: 0 }} />}<WorkspaceLayout activeTalk={{ name: 'Garden', path, outlinePath, slug: 'garden', title: 'Garden meeting' }}
    vaultRoot={path} startView={polish ? 'markdown' : undefined} leftPreviewsHost={outlineHost} slidesPanelView="outline" slideTabView={slideTabView} onChooseSlideTabView={setSlideTabView} /><Toasts /></div>
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
  const page = await browser.newPage({ viewport: polish ? { width: 1340, height: 740 } : { width: 1000, height: 631 } })
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
    if (!/image=above|table-bands=on/.test(text)) return 'about:blank'
    const model = await prepareSource(outline, text, 'Garden meeting', statSync(outline))
    const file = join(scratch, `preview-${++renderSequence}.html`)
    writeFileSync(file, model.fullHtml)
    return pathToFileURL(file).href
  })
  await page.goto(pathToFileURL(html).href)
  await page.evaluate(props => window.mountFixture(props), { path: scratch, outlinePath: outline, polish })

  if (polish) {
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
    await pictureButton.click()
    const above = picture.getByRole('button', { name: /^Above(?:\s|$)/ })
    await above.click()
    await picture.getByRole('button', { name: /Current.*Above/ }).waitFor()
    assert.match(await page.evaluate(() => window.editorView().state.doc.toString()), /image=above/)
    await back.click()
    await home.getByRole('button', { name: /^Picture\b.*Above the points/ }).waitFor()
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

    async function checkLooks(label, slide, geometry) {
      for (const theme of ['light', 'dark']) {
        await page.emulateMedia({ colorScheme: theme })
        await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, theme)
        const result = await preview.locator(`section.slide.active[data-id="${slide}"]`).evaluate(geometry)
        if (process.env.TW_SLIDE_DESIGN_CAPTURE === '1') {
          const capture = await inspector.screenshot({ type: 'jpeg', quality: 75 })
          console.log(`SLIDE_DESIGN_CAPTURE ${label} ${theme} ${capture.toString('base64')}`)
        }
        assert.ok(result.ok, `${theme} ${label}: ${JSON.stringify(result)}`)
        console.log(`${theme} ${label}: ${JSON.stringify(result)}`)
      }
      await page.emulateMedia({ colorScheme: 'light' })
    }
    await preview.locator('section.slide.active[data-id="p3"] .slot-media img').evaluate(image => image.decode())
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
  }
  if (!polish) {
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

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { macWindowChromeFallback } from '../src/shared/window-chrome.ts'

const scratch = mkdtempSync(join(tmpdir(), 'tw-workspace-pathways-'))
const look = process.argv.includes('--look')
let browser
try {
  await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
import './src/renderer/src/lib/appTheme.ts'
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './src/renderer/src/App.tsx'
import WindowChrome from './src/renderer/src/components/WindowChrome.tsx'
import { installMock } from './src/renderer/src/tw-mock.ts'
import { setOverride } from './src/renderer/src/keymap/store.ts'
import './src/renderer/src/styles.css'
import './src/renderer/src/lighttable.css'
import './src/renderer/src/talklist-vaults.css'
import './src/renderer/src/vault-sheet.css'
import './src/renderer/src/guide.css'
import './src/renderer/src/conflict-compare.css'
import './src/renderer/src/image-drawer.css'
import './src/renderer/src/update-notices.css'

installMock()
window.setPresentShortcut = () => setOverride('present-from-here', 'F6')
const menuListeners = new Set()
window.tw.app.onRunCommand = callback => {
  menuListeners.add(callback)
  return () => menuListeners.delete(callback)
}
window.runMenuCommand = id => menuListeners.forEach(listener => listener(id))
window.twMacInset = true
const root = '/mock/vault'
const title = 'Field notes from the garden: a very long talk title about documenting experiments for next spring'
const talks = [title, 'No pathways yet'].map((name, i) => ({
  name, title: name, slug: 'garden-' + i, vaultId: 'mock-vault', path: root,
  outlinePath: root + '/garden-' + i + '-outline.md'
}))
const titles = ['Preparing the beds', 'Planting the seedlings', 'Counting the harvest']
const slides = titles.map((title, i) => ({
  title, nav_title: title, slide_id: ['beds','seedlings','harvest'][i],
  role: 'content', source_line: 9 + i * 4, render_hash: title, content_hash: title,
  source_markdown: '### ' + title
}))
const source = ['---', 'outline_version: 2', 'title: Garden notes',
  'auto_title_slide: false', 'auto_thanks_slide: false', '---', '', '## Garden {id=garden}',
  ...slides.flatMap(row => ['### ' + row.title + ' {id=' + row.slide_id + '}', '', '- Garden notes', '']),
  '| Crop | Count |', '| --- | --- |', '| Beans | 12 |', ''
].join('\\n')
const sets = [
  { id: 'short', name: 'Short version', slideIds: ['harvest','beds'] },
  { id: 'volunteers', name: 'For volunteers', slideIds: ['seedlings'] },
  { id: 'empty', name: 'Empty draft', slideIds: [] },
  { id: 'long', name: 'For new members who have not seen the plots yet', slideIds: ['seedlings'] }
]
const snapshot = paths => ({
  slides, pathways: paths.map(p => ({ ...p, present: p.slideIds.map(id => slides.find(row => row.slide_id === id)), missing: [] }))
})
const noop = () => () => {}
Object.assign(window.tw.vault, {
  list: async () => [{ id: 'mock-vault', root, open: true, order: 0, name: 'Garden talks', initial: 'G' }],
  listTalks: async () => talks,
  listFolders: async () => []
})
window.tw.windows = {
  ...window.tw.windows,
  takeOpenRequest: async () => ({ kind: 'talk', outlinePath: talks[0].outlinePath }),
  claimTalk: async () => ({ ok: true })
}
Object.assign(window.tw.talk, {
  readOutline: async () => source,
  outlineDiskVersion: async () => ({ text: source, hash: 'fixture' }),
  compile: async () => slides,
  thumbnails: async () => null,
  present: async (...args) => { window.presented = args; return { success: true } }
})
window.tw.slide.renderPreview = async (_path, _source, id) => 'about:blank#' + id
window.tw.pathways = {
  read: async path => snapshot(path === talks[0].outlinePath ? sets : []),
  onChanged: noop,
  present: async (...args) => { window.dockPresented = args; return { success: true } }
}
window.openEmptyTalk = () => window.dispatchEvent(new CustomEvent('tw-open-pathways', {detail: talks[1]}))
createRoot(document.getElementById('root')).render(<WindowChrome><App /></WindowChrome>)
` },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
    loader: { '.svg': 'dataurl', '.woff2': 'dataurl' },
    define: { __TW_SECURITY_TEST__: 'false', 'import.meta.env.DEV': 'false' },
    outfile: join(scratch, 'fixture.js')
  })
  const html = join(scratch, 'fixture.html')
  writeFileSync(html, '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
  browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1000, height: 631 }, reducedMotion: 'reduce' })
  await page.route(/^https?:/, route => route.abort())
  page.setDefaultTimeout(12000)
  const errors = []
  page.on('pageerror', error => { errors.push(error.message); console.error(error) })
  await page.goto(pathToFileURL(html).href)

  const titleBar = page.locator('.workspace-view-titlebar')
  const titleMenu = titleBar.getByTitle('Talk menu', { exact: true })
  const switcher = titleBar.locator('.workspace-pathway-switch > div > button')
  const dock = page.locator('[data-pathway-dock]')
  const tab = name => page.locator('.sidebar-modebar').getByRole('tab', { name, exact: true })
  const view = name => titleBar.getByRole('button', { name, exact: true })
  const selectPath = async name => {
    await switcher.click()
    await page.getByRole('menuitemradio', { name, exact: true }).click()
    await switcher.getByText(name, { exact: true }).waitFor()
  }
  const grid = page.locator('[data-view="grid"]')
  const indices = () => grid.locator('.grid-cell').evaluateAll(cells => cells.map(cell => Number(cell.dataset.slideIndex)))
  const waitForGrid = numbers => page.waitForFunction(expected => [...document.querySelectorAll('.grid-cell')].map(cell => cell.dataset.slideIndex).join(',') === expected.join(','), numbers)
  const slideCrumb = page.locator('.workspace-slide-crumb')
  const activateSidebar = async () => {
    const expand = page.getByRole('button', { name: 'Show sidebar', exact: true })
    if (await expand.isVisible()) await expand.click()
  }

  await switcher.getByText('Full talk').waitFor()
  await activateSidebar()
  await tab('Slides').click()
  await view('Outline').click()
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  const tableCell = page.locator('[data-view="outline"] .tw-obj-table tbody td').first()
  await tableCell.waitFor()
  const contrast = await tableCell.evaluate(cell => {
    const luminance = colour => {
      const [red, green, blue] = colour.match(/\d+/g).slice(0, 3).map(Number).map(channel => {
        const srgb = channel / 255
        return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * red + 0.7152 * green + 0.0722 * blue
    }
    const ink = luminance(getComputedStyle(cell).color)
    const fill = luminance(getComputedStyle(cell.closest('.tw-obj-body')).backgroundColor)
    return (Math.max(ink, fill) + 0.05) / (Math.min(ink, fill) + 0.05)
  })
  const insert = page.locator('[data-sidebar] .tw-structure-insert-trigger').first()
  await insert.waitFor()
  const insertSize = await insert.evaluate(button => ({
    font: getComputedStyle(button.querySelector('span')).fontSize,
    height: getComputedStyle(button).height,
    labelHeight: button.querySelector('span').getBoundingClientRect().height
  }))
  console.log(`Outline dark table contrast ${contrast.toFixed(2)}:1, Insert here ${insertSize.font} in ${insertSize.height}`)
  assert.ok(contrast >= 4.5, 'dark Outline table body text meets 4.5:1')
  assert.deepEqual(insertSize, { font: '11px', height: '14px', labelHeight: 11 })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  assert.deepEqual(await page.locator('.sidebar-modes [role=tab]').evaluateAll(tabs => tabs.map(tab => tab.getAttribute('aria-label'))), ['Slides', 'Talks', 'Pathways'])
  await tab('Pathways').click()
  await page.locator('[data-sidebar] [data-pathway-dock]').waitFor()
  assert.equal(await tab('Pathways').getAttribute('aria-selected'), 'true')
  assert.equal(await dock.getByRole('combobox', { name: 'Pathway' }).inputValue(), '')
  await dock.getByRole('combobox', { name: 'Pathway' }).selectOption('volunteers')
  await switcher.getByText('For volunteers').waitFor()
  await selectPath('Short version')
  assert.equal(await dock.getByRole('combobox', { name: 'Pathway' }).inputValue(), 'short')
  assert.deepEqual(await dock.locator('[data-pathway-row]').evaluateAll(rows => rows.map(row => row.dataset.pathwayRow)), ['harvest', 'beds'])
  assert.deepEqual(await indices(), [0, 1, 2])
  await selectPath('Empty draft')
  await dock.getByText('No slides yet. Drag slides here, or select them in the grid and press Add selected.').waitFor()
  const addSelected = dock.getByRole('button', { name: 'Add selected', exact: true })
  assert.ok(await addSelected.isDisabled())
  const tick = grid.locator('[data-grid-tick]').first()
  await tick.check()
  await addSelected.click()
  const addDialog = page.getByRole('dialog', { name: 'Add to pathway', exact: true })
  await addDialog.getByRole('heading', { name: 'Add 1 slides in talk order' }).waitFor()
  await addDialog.getByRole('button', { name: 'Cancel' }).click()
  await tick.uncheck()
  await dock.locator('button:disabled').filter({ hasText: 'Add selected' }).waitFor()
  await selectPath('Short version')
  await dock.getByRole('button', { name: 'Present this pathway', exact: true }).click()
  await page.waitForFunction(() => window.dockPresented?.[2] === 'short')
  console.log('PASS Pathways tab and title-bar switch agree in both directions, including dock presentation')

  await tab('Talks').click()
  await dock.waitFor({ state: 'detached' })
  await waitForGrid([2, 0])
  await view('Slide').click()
  await slideCrumb.getByText('Slide 2 of 2', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Previous pathway slide' }).click()
  await slideCrumb.getByText('Slide 1 of 2', { exact: true }).waitFor()
  const otherWays = titleBar.getByRole('button', { name: 'Other ways to present', exact: true })
  const expectPresent = async (action, mode, start) => {
    await page.evaluate(() => { window.presented = null })
    await action()
    await page.waitForFunction(({ mode, start }) =>
      window.presented?.[2] === mode && (window.presented?.[3] ?? null) === start
        && window.presented?.[6]?.pathwayId === 'short', { mode, start })
  }
  const launchItems = [
    ['Presenter view from this slide', '⇧F5', 'presenter', 'harvest'],
    ['Presenter view from the start', 'F5', 'presenter', null],
    ['Present in single screen from this slide', '', 'window', 'harvest'],
    ['Present in single screen from the start', '', 'window', null],
    ['Plan a session with an audience…', '']
  ]
  await otherWays.click()
  const menuItems = titleBar.getByRole('menuitem')
  assert.deepEqual(await menuItems.evaluateAll(items => items.map(item => [
    item.querySelector('span')?.textContent,
    item.querySelector('.toolbar-menu-hint')?.textContent ?? ''
  ])), launchItems.map(([name, chord]) => [name, chord]))
  await page.keyboard.press('Escape')
  await menuItems.first().waitFor({ state: 'hidden' })
  await expectPresent(() => view('Present').click(), 'presenter', 'harvest')
  for (const [name, , mode, start] of launchItems.slice(0, 4)) {
    await expectPresent(async () => {
      await otherWays.click()
      await titleBar.getByRole('menuitem', { name: new RegExp('^' + name) }).click()
    }, mode, start)
  }
  await expectPresent(() => page.keyboard.press('F5'), 'presenter', null)
  await expectPresent(() => page.keyboard.press('Shift+F5'), 'presenter', 'harvest')
  await expectPresent(() => page.evaluate(() => window.runMenuCommand('present-from-here')), 'presenter', 'harvest')
  await page.evaluate(() => window.setPresentShortcut())
  await otherWays.click()
  await titleBar.getByRole('menuitem', { name: 'Presenter view from this slide F6', exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await expectPresent(() => page.keyboard.press('F6'), 'presenter', 'harvest')
  await expectPresent(async () => {
    await page.keyboard.press('ControlOrMeta+Shift+KeyP')
    const palette = page.getByRole('dialog', { name: 'Command palette' })
    await palette.locator('.command-menu-input').fill('presenter view from this slide')
    await palette.locator('[data-command="present-from-here"]').filter({ hasText: 'F6' }).click()
  }, 'presenter', 'harvest')
  await selectPath('Full talk')
  await view('Grid').click()
  await waitForGrid([0, 1, 2])
  await selectPath('Empty draft')
  await grid.getByText('No slides in this pathway.').waitFor()
  await view('Slide').click()
  await page.getByText('No slides in this pathway.').waitFor()
  console.log('PASS Grid and Slide use pathway order, and toolbar and F5 pass the same pathway to Present')

  await titleMenu.click()
  await page.getByRole('menuitem', { name: /Pathways/ }).click()
  await dock.waitFor()
  await dock.getByRole('button', { name: /^Back to / }).click()
  await dock.waitFor({ state: 'detached' })
  await page.keyboard.press('ControlOrMeta+Alt+KeyP')
  await dock.waitFor()
  await page.keyboard.press('Escape')
  await dock.waitFor({ state: 'detached' })
  await selectPath('Full talk')
  await switcher.click()
  assert.equal(await page.getByRole('menuitemradio', { name: 'Full talk', exact: true }).getAttribute('aria-checked'), 'true')
  await page.getByRole('menuitem', { name: 'Manage pathways…', exact: true }).click()
  await dock.waitFor()
  assert.equal(await tab('Pathways').getAttribute('aria-selected'), 'true')
  console.log('PASS Talk menu, keyboard shortcut and Manage pathways all open the same tab')

  const longPathway = 'For new members who have not seen the plots yet'
  await selectPath(longPathway)
  assert.equal(await switcher.getAttribute('title'), longPathway)
  const titleGeometry = await titleBar.evaluate(bar => {
    const box = node => node.getBoundingClientRect()
    const title = bar.querySelector(':scope > div:first-child > button')
    const label = bar.querySelector('.workspace-pathway-switch .toolbar-btn-content > span')
    const presentMenu = bar.querySelector('.toolbar-split > button:last-child')
    return {
      talkTitleWidth: box(title).width,
      presentFits: box(presentMenu).right <= box(bar).right,
      titleClearsPathway: box(title).right <= box(label.closest('button')).left
    }
  })
  assert.ok(titleGeometry.talkTitleWidth >= 95 && titleGeometry.presentFits && titleGeometry.titleClearsPathway,
    'the long pathway still leaves room for the talk title and Present menu at 1000 px: ' + JSON.stringify(titleGeometry))

  if (look) {
    for (const [width, height] of [[1000, 631], [1440, 900]]) {
      await page.setViewportSize({ width, height })
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
        await selectPath('Short version')
        const capture = async suffix => console.log('PATHWAYS_LOOK ' + theme + '-' + width + 'x' + height + '-' + suffix + ' ' +
          (await page.screenshot({ type: 'jpeg', quality: 86, animations: 'disabled' })).toString('base64'))
        const boxes = await page.evaluate(() => {
          const box = el => { const rect = el.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } }
          const bar = document.querySelector('.workspace-view-titlebar')
          const tools = document.querySelector('.workspace-centre .tw-action-bar')
          const title = bar.querySelector(':scope > div:first-child .toolbar-btn-content > span')
          const pathway = bar.querySelector('.workspace-pathway-switch .toolbar-btn-content > span')
          return {
            bar: box(bar), tools: box(tools), children: [...bar.children].map(box),
            titleTruncates: title.scrollWidth > title.clientWidth,
            pathwayFits: pathway.clientWidth > 0 && pathway.scrollWidth <= pathway.clientWidth,
            dock: box(document.querySelector('[data-pathway-dock]')),
            status: box(document.querySelector('[data-status-notice-slot]').parentElement)
          }
        })
        assert.ok(boxes.titleTruncates)
        assert.ok(boxes.pathwayFits, 'the ordinary pathway name fits next to a long title')
        assert.ok(boxes.children.every(item => item.left >= macWindowChromeFallback.inline),
          'title-bar controls start after the shared Mac window-control inset')
        assert.ok(boxes.children.every((item, i) => item.top >= boxes.bar.top && item.bottom <= boxes.bar.bottom &&
          item.right <= boxes.bar.right && (!i || item.left >= boxes.children[i - 1].right)), JSON.stringify(boxes))
        assert.equal(boxes.tools.top, boxes.bar.bottom)
        assert.equal(boxes.dock.left, 0)
        assert.equal(boxes.status.bottom, height, 'the workspace fills the available height')
        console.log('PASS geometry', width, height, theme, 'bars', boxes.tools.bottom - boxes.bar.top, 'px')
        await capture('dock')
        await switcher.click()
        await page.getByRole('menuitem', { name: 'Manage pathways…', exact: true }).waitFor()
        await capture('menu')
        await page.keyboard.press('Escape')
      }
    }
  }

  await page.evaluate(() => window.openEmptyTalk())
  const add = titleBar.getByRole('button', { name: 'Add a pathway', exact: true })
  await add.waitFor()
  assert.equal(await switcher.count(), 0)
  await add.click()
  await page.getByRole('dialog', { name: 'New pathway', exact: true }).waitFor()
  assert.deepEqual(errors, [])
  console.log('PASS a talk without pathways has the direct creation control and inherits no selection')
} finally {
  await browser?.close()
  rmSync(scratch, { recursive: true, force: true })
}

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const scratch = mkdtempSync(join(tmpdir(), 'tw-talk-metadata-'))
const outline = join(scratch, 'fixture-outline.md')
const initial = '---\ntitle: Original title\nevent: Original event\nprework: original-work\noutline_version: 2\n---\n\n# Separate heading\n\n## Section {id=section}\n\n### First slide {id=first}\n\nBody\n\n### Second slide {id=second}\n'
writeFileSync(outline, initial)
let browser
try {
  await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './src/renderer/src/App.tsx'
import { installMock } from './src/renderer/src/tw-mock.ts'
import './src/renderer/src/styles.css'
import './src/renderer/src/guide.css'
installMock()
const root = '/mock/vault'
const talk = { name: 'Original title', title: 'Original title', slug: 'fixture', vaultId: 'mock-vault', path: root, outlinePath: root + '/fixture-outline.md' }
const otherTalk = { ...talk, name: 'Other talk', title: 'Other talk', slug: 'other', outlinePath: root + '/other-outline.md' }
const slides = ['First slide', 'Second slide'].map((title, index) => ({
  title, nav_title: title, slide_id: ['first', 'second'][index], role: 'content',
  source_line: 12 + index * 4, source_markdown: '### ' + title, render_hash: title, content_hash: title
}))
Object.assign(window.tw.vault, {
  list: async () => [{ id: 'mock-vault', root, open: true, order: 0, name: 'Fixture' }],
  listTalks: async () => [talk, otherTalk], listFolders: async () => []
})
Object.assign(window.tw.windows, {
  takeOpenRequest: async () => ({ kind: 'talk', outlinePath: talk.outlinePath }),
  claimTalk: async () => ({ ok: true }),
  recoverMovedTalk: async () => ({ kind: 'no-receipt' })
})
window.openOtherTalk = () => window.dispatchEvent(new CustomEvent('tw-open-pathways', { detail: otherTalk }))
window.tw.metadata = { doctor: async () => [], vocabulary: async () => ({}) }
window.addEventListener('tw-toast', event => { window.fixtureToast = event.detail.message })
let writeGate
window.holdFixtureWrite = () => {
  writeGate = new Promise(resolve => { window.releaseFixtureWrite = resolve })
}
Object.assign(window.tw.talk, {
  readOutline: path => window.readFixture(path),
  outlineDiskVersion: async path => ({ text: await window.readFixture(path), hash: 'fixture' }),
  writeOutline: async (path, text) => {
    if (writeGate) {
      const gate = writeGate
      writeGate = undefined
      window.fixtureWriteHeld = true
      await gate
      window.fixtureWriteHeld = false
    }
    await window.writeFixture(path, text)
    return { ok: true, content: text }
  },
  compile: async () => slides, thumbnails: async () => null,
  onCloseRequested: callback => { window.requestClose = quit => callback({ quit }); return () => {} },
  ackCloseRequest: async () => true,
  closeKept: async () => { window.keptClose = true; return true },
  confirmClose: async ({ quit }) => { window.confirmedClose = quit ? 'quit' : 'close'; return true }
})
window.tw.slide.renderPreview = async () => ''
createRoot(document.getElementById('root')).render(<App />)
` },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
    loader: { '.svg': 'dataurl', '.woff2': 'dataurl' },
    define: { __TW_SECURITY_TEST__: 'false', 'import.meta.env.DEV': 'false' },
    outfile: join(scratch, 'fixture.js')
  })
  const html = join(scratch, 'fixture.html')
  writeFileSync(html, '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="fixture.css"><div id="root"></div><script src="fixture.js"></script>')
  browser = await chromium.launch({ headless: true, executablePath: process.env.TW_CHROMIUM_HEADLESS_SHELL || undefined })
  const page = await browser.newPage({ viewport: { width: 1400, height: 850 } })
  page.setDefaultTimeout(7000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route(/^https?:/, route => route.abort())
  await page.exposeFunction('readFixture', path => path.endsWith('/other-outline.md') ? initial.replace('Original title', 'Other talk') : readFileSync(outline, 'utf8'))
  await page.exposeFunction('writeFixture', (path, text) => {
    assert.ok(path.endsWith('/fixture-outline.md'))
    writeFileSync(outline, text)
  })
  await page.goto(pathToFileURL(html).href)

  const tab = page.locator('[data-talk-tab]')
  const titleSelector = '[data-talk-tab] #deck-title'
  const title = page.locator(titleSelector)
  const cardSelector = key => `.cm-frontmatter-table [data-fm-key="${key}"]`
  const card = key => page.locator(cardSelector(key))
  const cardInput = key => cardSelector(key) + ' input'
  const cardValue = key => page.locator(cardInput(key))
  const waitValue = (selector, value) => page.waitForFunction(([target, expected]) =>
    document.querySelector(target)?.value === expected, [selector, value])
  const waitFile = (key, value) => page.waitForFunction(async ([k, v]) =>
    (await window.readFixture('/fixture-outline.md')).split('\n').includes(k + ': ' + v), [key, value])
  await page.getByTestId('markdown-toggle').click()
  await page.locator('[data-rc-tab="talk"]').click()
  await waitValue(titleSelector, 'Original title')
  await waitValue(cardInput('title'), 'Original title')

  await title.fill('Live title')
  await waitFile('title', 'Live title')
  await waitValue(cardInput('title'), 'Live title')
  const event = tab.locator('#deck-event')
  await event.fill('Live event')
  await event.press('Enter')
  await waitFile('event', 'Live event')
  await waitValue(cardInput('event'), 'Live event')
  await page.locator('.cm-content').press('ControlOrMeta+z')
  await waitFile('event', 'Original event')
  await waitValue('#deck-event', 'Original event')
  assert.equal(await cardValue('title').inputValue(), 'Live title', 'undo reverts exactly one metadata commit')
  assert.ok(readFileSync(outline, 'utf8').includes('# Separate heading'))

  // Make a second change to the same field while the Talk tab still holds a typed value.
  // Change the actual CodeMirror widget without moving focus, which would commit the first value.
  await page.evaluate(([panelSelector, widgetSelector]) => {
    const panel = document.querySelector(panelSelector)
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(panel, 'Retry this title')
    panel.dispatchEvent(new Event('input', { bubbles: true }))
    const widget = document.querySelector(widgetSelector)
    widget.value = 'From the card'
    widget.dispatchEvent(new Event('change', { bubbles: true }))
  }, [titleSelector, cardInput('title')])
  await title.press('Enter')
  await page.waitForFunction(() => window.fixtureToast?.startsWith('Couldn’t apply the change to Title.'))
  assert.equal(await title.inputValue(), 'Retry this title', 'the refused commit keeps typed text in the field')
  await waitValue(cardInput('title'), 'From the card')
  await page.locator('[data-rc-tab="inspector"]').click()
  assert.equal(await title.inputValue(), 'Retry this title', 'leaving cannot drop the refused text')
  await title.press('Enter')
  await waitFile('title', 'Retry this title')
  await waitValue(cardInput('title'), 'Retry this title')
  await tab.getByText('Advanced: more details').click()
  const prework = tab.getByRole('textbox', { name: 'Pre-work', exact: true })
  await prework.fill('new-work')
  await prework.press('Tab')
  await waitFile('prework', 'new-work')

  await tab.getByRole('button', { name: 'Design', exact: true }).click()
  const map = tab.locator('#deck-defaults')
  const bar = tab.locator('[data-talk-draft-bar]')
  assert.equal(await bar.count(), 0)
  await map.fill('\n  image: left')
  await map.scrollIntoViewIfNeeded()
  await bar.getByText('Frame defaults', { exact: false }).waitFor()
  const top = await tab.boundingBox()
  const barBox = await bar.boundingBox()
  assert.ok(barBox.y < top.y + 90, 'the Save changes bar is at the top of the scrolled tab')
  assert.ok(!readFileSync(outline, 'utf8').includes('defaults:'))

  const modal = page.getByRole('dialog', { name: 'You have unsaved changes to Frame defaults.' })
  await page.locator('[data-rc-tab="inspector"]').click()
  await modal.waitFor()
  await modal.getByRole('button', { name: 'Keep editing' }).click()
  assert.equal(await map.inputValue(), '\n  image: left')

  await page.getByTestId('grid-toggle').click()
  const nextSlide = page.locator('.grid-cell[data-active="false"]').first()
  const nextSlideIndex = await nextSlide.getAttribute('data-slide-index')
  await nextSlide.click()
  await modal.waitFor()
  await modal.getByRole('button', { name: 'Keep editing' }).click()
  assert.equal(await page.locator(`.grid-cell[data-slide-index="${nextSlideIndex}"]`).getAttribute('data-active'), 'false')
  assert.equal(await map.inputValue(), '\n  image: left')
  await page.getByTestId('markdown-toggle').click()

  await page.evaluate(() => window.requestClose(true))
  await modal.waitFor()
  await modal.getByRole('button', { name: 'Keep editing' }).click()
  await page.waitForFunction(() => window.keptClose)
  assert.equal(await page.evaluate(() => window.confirmedClose), undefined)

  await page.evaluate(() => window.openOtherTalk())
  await modal.waitFor()
  await modal.getByRole('button', { name: 'Keep editing' }).click()
  assert.equal(await map.inputValue(), '\n  image: left')

  await tab.getByRole('button', { name: 'Details', exact: true }).click()
  await modal.waitFor()
  await modal.getByRole('button', { name: 'Save', exact: true }).click()
  await waitValue(titleSelector, 'Retry this title')
  assert.ok(readFileSync(outline, 'utf8').includes('defaults:\n  image: left'))
  await card('defaults').getByText('image: left', { exact: true }).waitFor()

  await tab.getByRole('button', { name: 'Design', exact: true }).click()
  await map.fill('\n  image: right')
  await page.evaluate(() => window.holdFixtureWrite())
  await bar.getByRole('button', { name: 'Save changes' }).click()
  await page.waitForFunction(() => window.fixtureWriteHeld)
  try {
    const thanks = tab.locator('#deck-thanks')
    await thanks.fill('Typed while saving')
    await thanks.press('Enter')
    await map.fill('\n  image: centre')
    assert.equal(await thanks.inputValue(), 'Typed while saving')
    assert.equal(await map.inputValue(), '\n  image: centre')
  } finally {
    await page.evaluate(() => window.releaseFixtureWrite())
  }
  await waitFile('thanks', 'Typed while saving')
  assert.ok(readFileSync(outline, 'utf8').includes('defaults:\n  image: right'), 'new YAML text remains staged')
  await page.evaluate(() => window.requestClose(false))
  await modal.waitFor()
  await modal.getByRole('button', { name: 'Discard' }).click()
  await page.waitForFunction(() => window.confirmedClose === 'close')
  assert.ok(readFileSync(outline, 'utf8').includes('defaults:\n  image: right'))
  assert.deepEqual(errors, [])
  console.log('Talk tab live writes, two-way metadata, undo, staged YAML, and leave choices passed')
} finally {
  await browser?.close()
  rmSync(scratch, { recursive: true, force: true })
}

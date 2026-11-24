// Real compiler, deck runtime and Studio renderer. Chromium stands in for Electron's
// hidden capture window, and the fixture supplies the usual preload replies.
import assert from 'node:assert/strict'
import { writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { testScratchDir } from './lib/test-scratch.mjs'
import { prepareSource } from '../compiler/scripts/lib/08-source-adapters.mjs'
import { buildPerSlideProjections } from '../compiler/scripts/lib/10-projections.mjs'
import { createVariantThumbnailRenderer } from '../src/main/layout-variant-thumbnail.ts'
import { GLOBAL_OPTION_GROUPS } from '../src/shared/layout-registry/entries.ts'
import { normalizePositions } from '../src/shared/outline-normalize.ts'
import { commitOptionSelection } from '../src/shared/trigger-line.ts'
import { markSlidePreviewHtml } from '../src/shared/slide-preview.ts'

const root = join(import.meta.dirname, '..')
const scratch = testScratchDir(join(tmpdir(), 'tw-reveal-preview-'))
const outline = join(scratch, 'reveal-fixture-outline.md')
const text = [
  '---', 'outline_version: 2', 'title: Reveal fixture', 'auto_title_slide: false', 'auto_thanks_slide: false', '---',
  '', '### About you {id=about}', '{iconlist}{iconlist=list}{reveal}', '',
  '- First point {icon=lucide:sprout}', '- Second point {icon=lucide:droplet}', '- Third point {icon=lucide:sun}', '',
  '### Plain {id=plain}', '', 'One ordinary slide.', '',
  '### Next {id=next}', '{mode=reveal}', '', '- Another point', '- A final point', '',
  '### Always visible {id=always}', '{mode=reveal}{nostep}', '', '- This point stays visible', ''
].join('\n')
await writeFile(outline, text)
const compile = async (source) => {
  const model = await prepareSource(outline, source, 'reveal-fixture', null)
  return { slug: 'reveal-fixture', model, rows: buildPerSlideProjections(model, 'reveal-fixture') }
}
const prepared = await compile(text)
const raw = prepared.model.fullHtml
const full = markSlidePreviewHtml(raw, { localPages: true })
assert.equal(markSlidePreviewHtml(full, { localPages: true }), full, 'marking a preview twice changes nothing')
assert.deepEqual(prepared.rows.filter(row => row.reveal_enabled).map(row => row.slide_id), ['about', 'next'])

const browser = await chromium.launch({ headless: true })
try {
  const context = await browser.newContext()
  context.setDefaultTimeout(12000)
  await context.route(/^https?:/, route => route.abort())
  const capture = await context.newPage()
  await capture.setViewportSize({ width: 1280, height: 720 })
  const errors = []
  capture.on('pageerror', error => errors.push(error.message))
  const deck = join(scratch, 'deck.html')
  await writeFile(deck, full)
  const deckUrl = pathToFileURL(deck).href
  const active = (page) => page.locator('.slide.active')
  const visibleCount = (page, mode) => active(page).locator(`[data-mode-state="${mode}"]`).count()
  const openSlide = async (page, id) => {
    await page.evaluate(slideId => {
      location.hash = slideId
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    }, id)
    await page.locator(`.slide.active[data-id="${id}"]`).waitFor()
  }
  await capture.goto(deckUrl + '#about')
  await capture.locator('.slide.active[data-id="about"]').waitFor()
  assert.equal(await visibleCount(capture, 'hidden'), 0, 'a cold authoring preview shows all three points')
  assert.equal(await visibleCount(capture, 'full'), 3, 'the runtime paints the final state')
  await openSlide(capture, 'next')
  assert.equal(await visibleCount(capture, 'full'), 2, 'hash navigation arrives at the final step of another slide')
  await openSlide(capture, 'always')
  assert.equal(await active(capture).locator('[data-mode-state]').count(), 0, 'nostep takes precedence')
  const pictures = {}
  for (const row of prepared.rows) {
    await openSlide(capture, row.slide_id)
    const file = join(scratch, row.slide_id + '.png')
    await capture.screenshot({ path: file, animations: 'disabled' })
    pictures[row.render_hash] = pathToFileURL(file).href
  }

  for (const [name, html] of [['present', raw], ['video-still', markSlidePreviewHtml(raw, { localPages: true, authoring: false })]]) {
    const file = join(scratch, name + '.html')
    await writeFile(file, html)
    await capture.goto(pathToFileURL(file).href + '#about')
    await capture.locator('.slide.active[data-id="about"]').waitFor()
    assert.equal(await visibleCount(capture, 'hidden'), 3, name + ' starts with all three points hidden')
    await capture.keyboard.press('ArrowRight')
    assert.equal(await visibleCount(capture, 'hidden'), 2, name + ' reveals one point per step')
  }

  let serial = 0
  const variants = createVariantThumbnailRenderer({
    prepareTalk: (_path, source) => compile(source),
    cacheDirFor: () => scratch,
    urlFor: (_slug, name) => pathToFileURL(join(scratch, name + '.png')).href,
    documentId: () => 'fixture',
    inputsFingerprint: () => '',
    async render({ fullHtml, slides, onRevealSteps }) {
      const [slide] = slides
      const scene = join(scratch, `variant-${++serial}`)
      await writeFile(scene + '.html', markSlidePreviewHtml(fullHtml, { localPages: true }))
      await capture.goto(pathToFileURL(scene + '.html').href)
      const id = await capture.locator('#stage .slide').nth(slide.index).getAttribute('data-id')
      await openSlide(capture, id)
      const hidden = await visibleCount(capture, 'hidden')
      if (hidden) errors.push(`Design variant ${serial} captured ${hidden} hidden units`)
      assert.equal(hidden, 0, 'each design variant opens fully revealed')
      if (onRevealSteps) {
        const count = await active(capture).getAttribute('data-tw-reveal-steps')
        assert.match(count ?? '', /^\d+$/, 'the variant capture exposes its resolved count')
        onRevealSteps(Number(count))
      }
      await capture.screenshot({ path: scene + '.png', animations: 'disabled' })
      return { [slide.key]: scene + '.png' }
    }
  })
  await build({
    stdin: { sourcefile: 'reveal-workspace.tsx', loader: 'tsx', resolveDir: root, contents: `
      import React, {useState} from 'react'
      import {createRoot} from 'react-dom/client'
      import {installMock} from './src/renderer/src/tw-mock.ts'
      import WorkspaceLayout from './src/renderer/src/components/WorkspaceLayout.tsx'
      import './src/renderer/src/styles.css'
      import './src/renderer/src/guide.css'
      import './src/renderer/src/image-drawer.css'
      installMock()
      window.fixtureWrites = 0
      window.tw.talk.readOutline = path => window.readFixture(path)
      window.tw.talk.writeOutline = async (path, source) => {
        window.fixtureWrites++
        return window.writeFixture(path, source)
      }
      window.tw.talk.compile = (_path, source) => window.fixtureRows(source)
      window.tw.talk.thumbnails = () => window.fixturePictures()
      window.tw.talk.layoutVariantThumbnail = (_path, source, slide, layout, options, key, batchScope) =>
        window.fixtureVariant({source, slide, layout, options, key, batchScope})
      window.tw.slide.renderPreview = (_path, source) => window.fixtureDeck(source)
      window.tw.pathways = { read: async () => ({ slides: [], pathways: [] }), onChanged: () => () => {} }
      function Fixture({outlinePath, path}) {
        const [leftPreviewsHost, setHost] = useState(null)
        return <div className="app-shell">
          <div ref={setHost} style={{flex:'0 0 185px',minWidth:0,overflow:'hidden'}} />
          <WorkspaceLayout activeTalk={{name:'Reveal fixture', title:'Reveal fixture', slug:'reveal-fixture', path, outlinePath}}
            vaultRoot={path} leftSidebarShown leftPreviewsHost={leftPreviewsHost} slidesPanelView="outline" startView="markdown" />
        </div>
      }
      window.mountFixture = props => createRoot(document.getElementById('root')).render(<Fixture {...props} />)
    ` },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
    define: { __TW_SECURITY_TEST__: 'false', 'import.meta.env.DEV': 'false' },
    outfile: join(scratch, 'workspace.js'), logLevel: 'warning'
  })
  const host = join(scratch, 'index.html')
  await writeFile(host, '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="workspace.css"><div id="root"></div><script src="workspace.js"></script>')
  const page = await context.newPage()
  page.on('pageerror', error => {
    errors.push(error.message)
    console.error(error)
  })
  const compilations = new Map([[text, Promise.resolve(prepared)]])
  const compiled = source => {
    if (!compilations.has(source)) compilations.set(source, compile(source))
    return compilations.get(source)
  }
  const previewUrls = new Map([[text, deckUrl]])
  const fixtureFiles = new Set()
  const makeOutline = async (name, source) => {
    const path = join(scratch, name + '-outline.md')
    await writeFile(path, source)
    fixtureFiles.add(path)
    return path
  }
  await page.exposeFunction('fixtureRows', async source => (await compiled(source)).rows)
  await page.exposeFunction('writeFixture', async (path, source) => {
    assert.ok(fixtureFiles.has(path), 'writes are limited to mounted fixture outlines')
    await writeFile(path, source)
    return { ok: true, content: source }
  })
  await page.exposeFunction('readFixture', path => {
    assert.ok(fixtureFiles.has(path), 'reads are limited to mounted fixture outlines')
    return readFile(path, 'utf8')
  })
  await page.exposeFunction('fixturePictures', () => pictures)
  await page.exposeFunction('fixtureDeck', async source => {
    if (previewUrls.has(source)) return previewUrls.get(source)
    const next = (await compiled(source)).model.fullHtml
    const file = join(scratch, `deck-${++serial}.html`)
    await writeFile(file, markSlidePreviewHtml(next, { localPages: true }))
    const url = pathToFileURL(file).href
    previewUrls.set(source, url)
    return url
  })
  await page.exposeFunction('fixtureVariant', ({ source, slide, layout, options, key, batchScope }) => variants({
    outlinePath: outline, outline: source, slideId: typeof slide === 'string' ? slide : `line:${slide.headingLine}`,
    headingLine: typeof slide === 'string' ? undefined : slide.headingLine,
    layout, options, requestKey: key, batchScope
  }))
  const gotoView = (id) => page.evaluate(command => window.dispatchEvent(new CustomEvent('tw-run-command', { detail: command })), id)
  const expectSaved = (path, text) => page.waitForFunction(
    async ({ path, text }) => await window.readFixture(path) === text,
    { path, text }
  )
  const badge = '.tw-reveal-badge'
  const screenshot = async (name) => {
    if (process.argv.includes('--look')) {
      console.log('REVEAL_LOOK ' + name + ' ' + (await page.screenshot({ type: 'jpeg', quality: 74 })).toString('base64'))
    }
  }
  const decodePictures = async (scope, count) => {
    await page.waitForFunction(({ scope, count }) => document.querySelectorAll(scope).length === count, { scope, count })
    await page.locator(scope).evaluateAll(images => Promise.all(images.map(async image => {
      image.loading = 'eager'
      await image.decode()
    })))
  }
  const checkBadge = async (scope, label, dark, expected = 'Reveal on', pointer = 'none') => {
    const element = page.locator(scope).locator(badge).first()
    await element.waitFor()
    assert.equal(await element.innerText(), expected, label)
    const image = page.locator(scope).filter({ has: page.locator(badge) }).first().locator('img').first()
    if (await image.count()) {
      await image.evaluate(img => { img.loading = 'eager' })
      assert.equal(await image.evaluate(async img => { await img.decode(); return img.naturalWidth }), 1280, label + ' loads its captured picture')
    }
    const geometry = await element.evaluate(el => {
      const r = el.getBoundingClientRect()
      const p = el.parentElement.getBoundingClientRect()
      const css = getComputedStyle(el)
      return {
        top: r.top - p.top, right: p.right - r.right,
        bottom: p.bottom - r.bottom, left: r.left - p.left, width: r.width, height: r.height,
        fill: css.backgroundColor, ink: css.color, pointer: css.pointerEvents,
        trying: el.closest('[data-panel-trying]') != null
      }
    })
    const strip = scope === '.tw-strip-thumbnail'
    const edges = strip ? [geometry.bottom, geometry.left] : [geometry.top, geometry.right]
    assert.ok(edges.every(edge => edge >= 0 && edge <= 8),
      label + ' sits in its preview corner ' + JSON.stringify(geometry))
    assert.ok(geometry.width > 35 && geometry.height >= 12, label + ' is readable')
    assert.equal(geometry.pointer, pointer)
    const hit = await element.evaluate(el => {
      const r = el.getBoundingClientRect()
      const underneath = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      return { withinPreview: underneath != null && el.parentElement.parentElement.contains(underneath),
        x: Math.round(r.x), y: Math.round(r.y), covering: underneath?.className }
    })
    if (!hit.withinPreview) {
      console.log(await element.evaluate(el => {
        const chain = []
        for (let at = el; at; at = at.parentElement) {
          const r = at.getBoundingClientRect()
          chain.push([at.className, r.x, r.y, r.width, r.height, at.scrollTop, at.scrollLeft, getComputedStyle(at).overflow])
        }
        return chain
      }))
    }
    assert.equal(hit.withinPreview, true, label + ' appears in the viewport ' + JSON.stringify(hit))
    assert.equal(geometry.fill, dark ? 'rgb(23, 27, 34)' : 'rgb(255, 255, 255)')
    assert.equal(geometry.ink, dark ? 'rgb(233, 236, 241)' : 'rgb(17, 24, 39)')
  }

  for (const [width, height] of [[1000, 631], [1440, 900]]) {
    for (const theme of ['light', 'dark']) {
      const dark = theme === 'dark'
      const look = `${width}x${height}-${theme}`
      // A save already sent to the preload can finish after navigation.
      const viewportOutline = await makeOutline(look, text)
      // A retained pointer can hover a design in the next mount and start a
      // temporary preview. A fresh URL also prevents restoring the previous scroll.
      await page.mouse.move(0, 0)
      await page.setViewportSize({ width, height })
      await page.goto(pathToFileURL(host).href + '?look=' + look)
      await page.evaluate(({ theme, path, outlinePath }) => {
        document.documentElement.dataset.theme = theme
        window.mountFixture({ path, outlinePath })
      }, { theme, path: scratch, outlinePath: viewportOutline })
      const inspector = page.frameLocator('iframe[title="Inspector live preview"]')
      await inspector.locator('.slide.active[data-id="about"] [data-mode-state="full"]').first().waitFor()
      assert.equal(await visibleCount(inspector, 'full'), 3, 'right-panel preview is fully revealed')
      await checkBadge('.tw-inspector-stage', 'right-panel preview', dark)
      // The Inspector's own pane scrolls. Scrolling the tile into view can also scroll
      // the ancestors that clip the pane, which is not an interaction Studio offers.
      await page.locator('.tw-inspector-pane').evaluate(pane => { pane.scrollTop = 0 })
      await checkBadge('.tw-right-picture-frame', 'design tile', dark, 'Reveal on · 3 steps')
      await decodePictures('.tw-right-designs .tw-right-picture-frame img', 2)
      await screenshot(look + '-inspector-sidebar')
      const sidebarToggle = page.getByTestId('sidebar-toggle')
      const pinned = page.locator('.tw-structure-pinned')
      assert.equal(await pinned.count(), 0, 'the open Inspector gives the sidebar space for its slide list')
      await sidebarToggle.click()
      await checkBadge('.tw-structure-pinned', 'pinned sidebar preview', dark)
      await screenshot(look + '-pinned-sidebar')
      const previewToggle = pinned.getByRole('button', { name: /Current slide preview/ })
      await previewToggle.click()
      await pinned.locator(badge).waitFor({ state: 'hidden' })
      await previewToggle.click()
      await pinned.locator(badge).waitFor()
      await sidebarToggle.click()
      await inspector.locator('.slide.active[data-id="about"] [data-mode-state="full"]').first().waitFor()
      const back = page.getByTitle('Step back (⌥←)')
      const forward = page.getByTitle('Step forward (⌥→)')
      assert.equal(await forward.isDisabled(), true, 'initially at the last step')
      for (let i = 3; i >= 0; i--) {
        await back.click()
        await page.getByText(`step ${i} / 4 · reveal`, { exact: true }).waitFor()
      }
      assert.equal(await visibleCount(inspector, 'hidden'), 3, 'Back exposes the first step')
      assert.equal(await back.isDisabled(), true, 'Back is bounded to this slide')
      await forward.click()
      await page.getByText('step 1 / 4 · reveal', { exact: true }).waitFor()
      assert.equal(await visibleCount(inspector, 'hidden'), 2, 'Forward exposes one point')
      await checkBadge('.tw-right-picture-frame', 'design stays fully revealed while Inspector is stepped', dark, 'Reveal on · 3 steps')
      assert.equal(await page.evaluate(() => window.fixtureWrites), 0)
      assert.equal(await readFile(viewportOutline, 'utf8'), text)

      await gotoView('view-strip')
      await checkBadge('.tw-strip-thumbnail', 'Slides strip thumbnail', dark)
      assert.equal(await page.locator('.tw-strip-thumbnail').filter({ has: page.locator(badge) }).count(), 2)
      await page.locator('.tw-strip-thumbnail').filter({ has: page.locator(badge) }).first().hover()
      const overlapsMore = await page.locator('.tw-strip-thumbnail').filter({ has: page.locator(badge) }).first().evaluate(frame => {
        const badge = frame.querySelector('.tw-reveal-badge').getBoundingClientRect()
        const more = frame.closest('.tw-structure-row-wrap').querySelector('.tw-structure-row-more').getBoundingClientRect()
        return badge.left < more.right && badge.right > more.left && badge.top < more.bottom && badge.bottom > more.top
      })
      assert.equal(overlapsMore, false, 'the visible strip menu clears the Reveal on badge')
      await screenshot(look + '-strip')

      await page.getByTestId('grid-toggle').click()
      await page.locator('[data-view="grid"]').waitFor()
      await checkBadge('.grid-cell [style*="padding-top"]', 'Grid thumbnail', dark)
      assert.equal(await page.locator('.grid-cell').filter({ has: page.locator(badge) }).count(), 2)
      await decodePictures('.grid-cell img', 4)
      await screenshot(look + '-grid')

      await page.getByTestId('slides-toggle').click()
      const slide = page.frameLocator('iframe[title="Slide preview"]')
      await slide.locator('.slide.active[data-id="about"] [data-mode-state="full"]').first().waitFor()
      assert.equal(await visibleCount(slide, 'full'), 3, 'Slide view is fully revealed after stepping Inspector')
      await checkBadge('.workspace-slide-stage', 'Slide view', dark, 'Reveal on · 3 steps', 'auto')
      await decodePictures('.tw-right-designs .tw-right-picture-frame img', 4)
      const listDesign = page.locator('.tw-right-designs .tw-right-picture[aria-pressed="true"]')
      assert.equal(await listDesign.locator(badge).textContent(), 'Reveal on · 3 steps')
      await screenshot(look + '-slide')
      const adjust = page.locator('.tw-right-adjust-direct')
      await adjust.getByText('Reveal one by one · on', { exact: true }).waitFor()
      const adjustScroll = adjust.locator('xpath=ancestor::*[contains(@class,"tw-inspector-pane")][1]')
      await adjustScroll.evaluate(pane => { pane.scrollTop = pane.scrollHeight })
      await screenshot(look + '-steps-row')

      const revealDoor = page.getByRole('button', { name: 'Reveal on · 3 steps', exact: true })
      await revealDoor.click()
      const stepsPage = page.getByRole('region', { name: 'Steps', exact: true })
      await stepsPage.getByText('Reveal one by one · on', { exact: true }).waitFor()
      const turnOff = stepsPage.getByRole('button', { name: 'Turn reveal off' })
      assert.equal(await turnOff.evaluate(el => document.activeElement === el), true, 'the badge brings keyboard focus to Steps')
      await screenshot(look + '-steps-open')
      await turnOff.click()
      await stepsPage.getByText('Reveal one by one · off', { exact: true }).waitFor()
      const withoutReveal = normalizePositions(text.replace('{iconlist}{iconlist=list}{reveal}', '{iconlist}{iconlist=list}'))
      await expectSaved(viewportOutline, withoutReveal)
      await revealDoor.waitFor({ state: 'hidden' })
      await stepsPage.getByRole('button', { name: 'Turn reveal on' }).click()
      await stepsPage.getByText('Reveal one by one · on', { exact: true }).waitFor()
      const restored = withoutReveal.replace('{iconlist}{iconlist=list}', commitOptionSelection(
        '{iconlist}{iconlist=list}', GLOBAL_OPTION_GROUPS.find(group => group.key === 'arrival-mode'), 'reveal'
      ))
      await expectSaved(viewportOutline, restored)
      await stepsPage.getByRole('button', { name: 'Back', exact: true }).click()
      await adjust.getByRole('button', { name: 'Turn reveal off' }).click()
      await expectSaved(viewportOutline, withoutReveal)
      await adjust.waitFor({ state: 'hidden' })

      console.log('PASS ' + look + ' — Inspector, design tiles, pinned sidebar, strip, Grid, Slide view')
  }}
  // Old outlines can carry a stamped ID in the heading with a separate arrival token,
  // or put the arrival token itself in the heading.
  const inlineMode = text.replace('### Next {id=next}\n{mode=reveal}', '### Next {reveal}\n{id=next}')
  for (const [name, source, cleared] of [
    ['trigger', text, text.replace('{mode=reveal}', '')],
    ['heading', inlineMode, inlineMode.replace('### Next {reveal}', '### Next')]
  ]) {
    const legacyOutline = await makeOutline(name, source)
    await page.goto(pathToFileURL(host).href)
    await page.evaluate(({ path, outlinePath }) => window.mountFixture({ path, outlinePath }), { path: scratch, outlinePath: legacyOutline })
    await page.getByTestId('slides-toggle').click()
    await page.locator('[data-slides-organizer]').getByRole('button', { name: /Next/ }).click()
    await page.getByRole('button', { name: 'Reveal on · 2 steps', exact: true }).click()
    await page.getByRole('region', { name: 'Steps', exact: true }).getByRole('button', { name: 'Turn reveal off' }).click()
    await expectSaved(legacyOutline, normalizePositions(cleared))
  }
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
}

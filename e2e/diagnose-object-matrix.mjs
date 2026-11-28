// One synthetic vault, real compiler/IPC, live editor, capture window, genuinely paired presenter,
// audience and exported handout. Screenshots and the Markdown result table go to TW_SHOTS_DIR.
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { pathToFileURL } from 'node:url'
import { createAppScratch, launchApp } from './lib/launch-app.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'
import { branches, cases, matrixTitle, outline } from '../scripts/lib/object-matrix-fixture.mjs'

const output = resolve(process.env.TW_SHOTS_DIR || 'artefacts/objects-matrix')
mkdirSync(output, { recursive: true })
const scratch = createAppScratch()
const vault = join(scratch.root, 'vault')
const folder = join(vault, 'object-matrix')
const path = join(folder, 'object-matrix-outline.md')
mkdirSync(join(folder, 'assets'), { recursive: true })
mkdirSync(scratch.userData, { recursive: true })
writeFileSync(join(scratch.userData, 'config.json'), JSON.stringify({ vaultRoot: vault }))
writeFileSync(path, outline)
cpSync('compiler/reference/fixtures-assets/two-box.svg', join(folder, 'assets/two-box.svg'))
cpSync('e2e/fixtures/audience-media/clip.webm', join(folder, 'clip.webm'))
// 100 ms of PCM silence, 8 kHz mono. Rendering the player never requires audio playback.
const wav = Buffer.alloc(44 + 1600)
for (const [offset, label] of [[0, 'RIFF'], [8, 'WAVEfmt '], [36, 'data']]) wav.write(label, offset)
for (const [offset, value] of [[4, wav.length - 8], [16, 16], [24, 8000], [28, 16000], [40, 1600]]) wav.writeUInt32LE(value, offset)
for (const [offset, value] of [[20, 1], [22, 1], [32, 2], [34, 16]]) wav.writeUInt16LE(value, offset)
writeFileSync(join(folder, 'silent.wav'), wav)
writeFileSync(join(folder, 'widget.html'), '<!doctype html><meta charset=utf-8><title>Local widget</title><style>body{margin:12%;font:28px system-ui;background:#def;color:#125}</style><h1>Local widget</h1><p>Deterministic offline content.</p>')

const results = new Map(cases.map(c => [c.id, { case: c.name }]))
const surfaces = ['Markdown', 'Slide editor', 'Inspector', 'Design', 'Grid', 'Presenter first', 'Presenter last', 'Audience first', 'Audience last', 'HTML']
const errors = []
const failedCells = []
const listen = (page, surface) => {
  page.on('pageerror', error => errors.push({ surface, message: error.message }))
  page.on('console', message => {
    if (message.type() === 'error') errors.push({ surface, url: message.location().url, message: message.text() })
  })
}
const clean = value => String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ')
function writeResults() {
  const headings = ['Object or slide', ...surfaces]
  const log = ['| ' + headings.join(' | ') + ' |', '| ' + headings.map(() => '---').join(' | ') + ' |']
  for (const result of results.values()) {
    log.push('| ' + [result.case, ...surfaces.map(surface => result[surface] ?? 'Unrun')].map(clean).join(' | ') + ' |')
  }
  writeFileSync(join(output, 'results.md'), log.join('\n') + '\n')
  writeFileSync(join(output, 'console-errors.json'), JSON.stringify(errors, null, 2))
  writeFileSync(join(output, 'failures.json'), JSON.stringify(failedCells, null, 2))
}
async function check(specimen, surface, page, run) {
  const result = results.get(specimen.id)
  try {
    result[surface] = await run() ?? 'Pass'
  } catch (error) {
    const detail = error.message.split('\n')[0]
    result[surface] = 'Fail'
    failedCells.push({ specimen: specimen.id, surface, detail })
    console.log('FAIL', specimen.id, surface, detail)
    await page.screenshot({ path: join(output, specimen.id + '-' + surface.toLowerCase().replaceAll(' ', '-') + '.png'), timeout: 3000 }).catch(() => {})
  }
  writeResults()
}

const active = (page, id) => page.locator('.slide.active[data-id="' + id + '"]')
const currentPane = presenter => presenter.frameLocator('#currentPreview iframe[title="Slide preview"]:not(.preview-incoming):not(.preview-outgoing)')
const mode = (page, name) => page.locator('.workspace-view-titlebar').getByRole('button', { name, exact: true }).click()

async function picture(slide, specimen, { first = false, share = false } = {}) {
  await slide.waitFor()
  const selector = specimen.painted ?? '.slide-content'
  const node = slide.locator(':is(' + selector + '):visible').first()
  if (specimen.id === 'matrix-map') {
    await slide.locator('.mindmap-mm[data-mm-painted] svg').waitFor()
    const labels = await slide.locator('.markmap-node foreignObject').allTextContents()
    const expected = first ? [] : branches
    assert.deepEqual(branches.filter(label => labels.includes(label)), expected, 'visible top-level branches')
    assert.ok(labels.includes(specimen.name), 'map centre is visible')
  }
  if (first && specimen.id === 'matrix-table') await slide.locator('.slide-table thead').waitFor()
  else await node.waitFor()
  const state = await slide.evaluate((slide, { selector, first }) => {
    const selected = slide.querySelector(selector) ?? slide.querySelector('.slide-content')
    const bounds = slide.getBoundingClientRect()
    const visible = node => node.checkVisibility({ visibilityProperty: true, opacityProperty: true })
    const body = slide.querySelector('.slide-content')
    const parts = [
      ...[...body.children].filter(node => !node.matches('.slide-head')),
      ...slide.querySelectorAll('.slide-head h1:not(.sr-only), .markmap-node foreignObject')
    ].filter(visible)
    const outside = parts.filter(node => {
      const box = node.getBoundingClientRect()
      return box.width && box.height && (box.top < bounds.top - 2 || box.left < bounds.left - 2 ||
        box.right > bounds.right + 2 || box.bottom > bounds.bottom + 2)
    }).map(node => node.className?.baseVal ?? node.className ?? node.nodeName)
    const payload = selected?.innerText?.trim() || selected?.textContent?.trim() ||
      selected?.querySelector('img, video, audio, iframe, svg, canvas') || selected?.matches('img, video, audio, iframe, svg, canvas, figure')
    return { outside, painted: Boolean(payload) || first && slide.classList.contains('mode-reveal') }
  }, { selector: selector.split(',')[0], first })
  assert.ok(state.painted, 'nothing painted in the slide body')
  assert.deepEqual(state.outside, [], 'body extends beyond the slide')
  if (share && ['matrix-notes', 'matrix-comment'].includes(specimen.id)) {
    assert.ok(!(await slide.textContent()).includes('sentinel.'), 'private source leaked into the share slide')
  }
}

async function bitmap(page, image) {
  await image.waitFor()
  const size = await image.evaluate(async img => {
    await img.decode()
    return { width: img.naturalWidth, height: img.naturalHeight }
  })
  assert.ok(Math.abs(size.width / size.height - 16 / 9) < .04,
    'unexpected thumbnail aspect ratio for ' + size.width + '×' + size.height)
  await image.scrollIntoViewIfNeeded()
  const bounds = await image.boundingBox()
  assert.ok(bounds?.width > 0 && bounds?.height > 0, 'thumbnail has no display bounds')
  // The renderer cannot read twthumb:// pixels through a canvas. Read what Electron painted.
  const pixels = await sharp(await page.screenshot({ clip: bounds, scale: 'css' })).resize(96, 54, { fit: 'fill' })
    .removeAlpha().toColourspace('srgb').raw().toBuffer()
  const tones = new Set()
  for (let i = 96 * 12 * 3; i < 96 * 50 * 3; i += 3) tones.add(pixels.readUIntBE(i, 3))
  assert.ok(tones.size > 8, 'thumbnail has no visible body')
}

async function tableStyle(table) {
  return table.evaluate(el => {
    const header = el.tHead?.rows[0]?.cells[0]
    const body = el.tBodies[0].rows[0]
    const headerCss = header && getComputedStyle(header)
    return {
      header: Boolean(header),
      headerBold: headerCss && Number(headerCss.fontWeight) >= 700,
      headerCase: headerCss?.textTransform,
      headerAccent: headerCss && headerCss.color !== getComputedStyle(body.cells[1]).color,
      firstAccent: getComputedStyle(body.cells[0]).color !== getComputedStyle(body.cells[1]).color,
      empty: [...el.querySelectorAll('td')].filter(cell => cell.textContent.trim() === '').length
    }
  })
}

let browser
let run
try {
  run = await launchApp({ scratch, timeout: 60_000 })
  const { app, page } = run
  page.setDefaultTimeout(5500)
  listen(page, 'Workspace')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(win => win.setContentSize(1440, 900)))
  await openTalkByTitle(page, matrixTitle)
  await mode(page, 'Grid')
  const rows = await page.evaluate(([path, outline]) => window.tw.talk.compile(path, outline), [path, outline])
  assert.ok(Array.isArray(rows), 'compile returned projected slides')
  const gridCell = specimen => page.locator('.grid-cell[data-slide-index="' + rows.findIndex(row => row.slide_id === specimen.id) + '"]')
  const inspector = page.frameLocator('.tw-inspector-stage iframe')
  const slideEditor = page.frameLocator('.workspace-slide-stage iframe')
  const cardTables = new Map()

  for (const specimen of cases) {
    await check(specimen, 'Grid', page, async () => {
      const cell = gridCell(specimen)
      await cell.scrollIntoViewIfNeeded({ timeout: 3500 })
      await bitmap(page, cell.locator('img').first())
    })
  }

  await mode(page, 'Markdown')
  const editor = page.locator('[data-view="markdown"] .cm-content')
  for (const specimen of cases) {
    const select = () => editor.evaluate((el, id) => {
      const view = el.cmTile.root.view
      const offset = view.state.doc.toString().match(new RegExp('\\bid=' + id + '(?=[\\s}])'))?.index
      if (offset === undefined) throw Error('Missing source id: ' + id)
      const line = view.state.doc.lineAt(offset)
      const target = /^#+ /.test(line.text) ? line : view.state.doc.line(line.number - 1)
      view.dispatch({ selection: { anchor: target.from + 3 }, effects: view.constructor.scrollIntoView(target.from, { y: 'start' }) })
    }, specimen.id)
    await check(specimen, 'Markdown', page, async () => {
      await select()
      if (!specimen.kind || specimen.kind === 'notes') return 'Source'
      const blockSelector = '[data-object-block="' + specimen.kind + '"]'
      const selector = specimen.kind === 'picture' ? blockSelector + ', .cm-image-widget, .cm-media-file-widget' : blockSelector
      // The caret jump is immediate, but CodeMirror mounts a new viewport on the next measure.
      const position = await page.waitForFunction(selector => {
        const doc = document.querySelector('[data-view="markdown"] .cm-content')
        const view = doc?.cmTile.root.view
        if (!view) return null
        const line = view.state.doc.lineAt(view.state.selection.main.head)
        const level = /^#+/.exec(line.text)?.[0].length ?? 6
        const nextHeading = new RegExp('\n#{2,' + level + '} ')
        const next = view.state.doc.toString().slice(line.to).search(nextHeading)
        const index = [...doc.querySelectorAll(selector)].findIndex(el => {
          const pos = view.posAtDOM(el)
          return pos >= line.to && (next === -1 || pos <= line.to + next + 1)
        })
        return index < 0 ? null : { index }
      }, selector, {timeout: 3000})
      const { index } = await position.jsonValue()
      await position.dispose()
      const card = editor.locator(selector).nth(index)
      await card.waitFor()
      assert.ok((await card.textContent()).trim())
      if (specimen.id === 'matrix-map') {
        await card.locator('.markmap-node').first().waitFor()
        const labels = await card.locator('.markmap-node foreignObject').allTextContents()
        assert.deepEqual(branches.filter(label => labels.includes(label)), branches)
        await page.screenshot({ path: join(output, 'mindmap-markdown.png') })
      }
      if (specimen.id.startsWith('matrix-table')) cardTables.set(specimen.id, await tableStyle(card.locator('table')))
    })
    await check(specimen, 'Inspector', page, async () => {
      const slide = active(inspector, specimen.id)
      await picture(slide, specimen)
      if (specimen.id.startsWith('matrix-table')) {
        const table = slide.locator('.slide-table')
        assert.deepEqual(await tableStyle(table), cardTables.get(specimen.id), 'Markdown and slide header/first-column rendering agree')
        const fill = await table.evaluate(el => el.offsetHeight / el.closest('.slide').offsetHeight)
        assert.ok(fill >= .30, 'table uses the vertical band (' + fill + ')')
      }
      if (['matrix-map', 'matrix-table'].includes(specimen.id)) await page.screenshot({ path: join(output, specimen.id + '-inspector.png') })
    })
    await check(specimen, 'Design', page, async () => {
      const button = page.locator('.tw-right-designs .tw-right-picture[aria-pressed="true"]').first()
      if (!(await button.count()) && !specimen.id.startsWith('matrix-table') && specimen.id !== 'matrix-map') return 'No current design'
      await bitmap(page, button.locator('img'))
      if (['matrix-map', 'matrix-table'].includes(specimen.id)) await page.screenshot({ path: join(output, specimen.id + '-design.png') })
    })
    await check(specimen, 'Slide editor', page, async () => {
      await mode(page, 'Slide')
      try {
        await page.locator('.workspace-slide-input .cm-content').waitFor()
        await picture(active(slideEditor, specimen.id), specimen)
      } finally { await mode(page, 'Markdown') }
    })
  }

  const findDeck = name => app.windows().find(win => new URL(win.url()).searchParams.get(name) === '1')
  const editorTitleBar = page.locator('.workspace-view-titlebar')
  await editorTitleBar.getByRole('button', { name: 'Present', exact: true }).click()
  const findWindow = async name => {
    const deadline = Date.now() + 30_000
    while (!findDeck(name) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
    assert.ok(findDeck(name), name + ' window did not open')
    return findDeck(name)
  }
  const presenter = await findWindow('presenter')
  const audience = await findWindow('audience')
  listen(presenter, 'Presenter')
  listen(audience, 'Audience')
  presenter.setDefaultTimeout(5000)
  audience.setDefaultTimeout(5000)
  const pane = currentPane(presenter)
  const paneSlide = id => active(pane, id)
  const presenterPicture = async (specimen, first = false) => {
    if (specimen.id !== 'ref-auto-embed') return picture(paneSlide(specimen.id), specimen, { first })
    // In this route the presenter selects a real external iframe instead of its slide clone.
    // Playback depends on the vendor and the host's referrer; the local video is checked above.
    const frame = presenter.locator('#currentPreview iframe[title="Live embed"]')
    await frame.waitFor()
    const bounds = await frame.boundingBox()
    assert.ok(bounds && bounds.width > 0 && bounds.height > 0, 'external iframe has a usable box')
    if (first) await presenter.screenshot({ path: join(output, 'bare-video-presenter.png') })
    return 'External frame'
  }
  const audiencePicture = async (specimen, first = false) => {
    const step = await presenter.evaluate(() => {
      const { twLiveReveal, twLiveFocus } = document.documentElement.dataset
      return { reveal: twLiveReveal, focus: twLiveFocus }
    })
    await audience.waitForFunction(({ id, reveal, focus }) => {
      const live = document.documentElement.dataset
      return document.querySelector('.slide.active')?.dataset.id === id &&
        live.twLiveReveal === reveal && live.twLiveFocus === focus
    }, { id: specimen.id, ...step })
    await picture(active(audience, specimen.id), specimen, { first })
  }
  for (const specimen of cases) {
    await presenter.evaluate(id => {
      location.hash = id
      dispatchEvent(new HashChangeEvent('hashchange'))
    }, specimen.id)
    await check(specimen, 'Presenter first', presenter, () => presenterPicture(specimen, true))
    await check(specimen, 'Audience first', audience, () => audiencePicture(specimen, true))

    const stage = active(audience, specimen.id)
    const count = await stage.evaluate(slide => {
      const carousel = slide.querySelector('.card-gallery[data-exclusive]')
      if (carousel) return Math.max(0, carousel.querySelectorAll(':scope > .card').length - 1)
      const units = [...slide.querySelectorAll('.mode-el[data-mode-state]')]
      const collapsesFullStep = units.length <= 1 || units.every(unit => unit.matches('.sim .sim-step, .mindmap-mm > .mm-step'))
      return units.length + Number(!collapsesFullStep)
    }).catch(() => 0)
    const stepFailures = new Map()
    for (let step = 1; step <= count; step++) {
      await presenter.keyboard.press('ArrowRight')
      if (specimen.id !== 'matrix-map') continue
      for (const [name, surface] of [['Audience last', stage], ['Presenter last', paneSlide(specimen.id)]]) {
        if (stepFailures.has(name)) continue
        try {
          await surface.locator('.mindmap-mm[data-mm-painted]').getByText(branches[step - 1], { exact: true }).waitFor()
          const labels = await surface.locator('.markmap-node foreignObject').allTextContents()
          assert.deepEqual(branches.filter(label => labels.includes(label)), branches.slice(0, step), 'branches at step ' + step)
        } catch (error) { stepFailures.set(name, error) }
      }
    }
    await check(specimen, 'Presenter last', presenter, async () => {
      if (stepFailures.has('Presenter last')) throw stepFailures.get('Presenter last')
      return presenterPicture(specimen)
    })
    await check(specimen, 'Audience last', audience, async () => {
      if (stepFailures.has('Audience last')) throw stepFailures.get('Audience last')
      await audiencePicture(specimen)
    })
    if (specimen.id === 'matrix-map') {
      await presenter.screenshot({ path: join(output, 'mindmap-presenter-last.png') })
      await audience.screenshot({ path: join(output, 'mindmap-audience-last.png') })
    }
  }

  const exported = await page.evaluate(([path, outline]) => window.tw.talk.exportHandout(path, outline), [path, outline])
  assert.equal(exported.success, true, exported.error)
  browser = await chromium.launch({ headless: true })
  const share = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  listen(share, 'HTML')
  share.setDefaultTimeout(5000)
  // Check the exported iframe without depending on player availability or the file URL referrer.
  await share.route('https://www.youtube-nocookie.com/**', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Video player</title><p>External video frame</p>'
  }))
  await share.goto(pathToFileURL(exported.path).href)
  for (const specimen of cases) {
    await check(specimen, 'HTML', share, async () => {
      await share.evaluate(id => { location.hash = id; dispatchEvent(new HashChangeEvent('hashchange')) }, specimen.id)
      await picture(active(share, specimen.id), specimen, { share: true })
    })
  }

  assert.ok(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every(win => !win.isVisible())), 'all test windows are hidden')
} finally {
  writeResults()
  try { await browser?.close() } finally { await scratch.close() }
}
const failures = [...results.values()].flatMap(row => surfaces.filter(surface => !row[surface] || row[surface] === 'Fail').map(surface => row.case + '/' + surface))
console.log(cases.length + ' specimens, ' + failures.length + ' failed or unrun cells, ' + errors.length + ' console errors. ' + output)
for (const [detail, cells] of Object.entries(Object.groupBy(failedCells, cell => cell.detail))) {
  console.log(cells.length + ' × ' + detail + ' (first: ' + cells[0].specimen + '/' + cells[0].surface + ')')
}
assert.equal(failures.length + errors.length, 0, 'See failure details and console messages in ' + output)

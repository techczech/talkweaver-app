import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { launchApp, createAppScratch } from './lib/launch-app.mjs'
import { openTalkByTitle } from './lib/talklist.mjs'

const SAMPLES = 5
const BUDGET_MS = 250
const STALE_CHECK_MS = 300
const kinds = ['plain list', 'iconlist', 'table', 'image']
const textFor = kind => `Observe the ${kind} evidence`
const makeSlide = (index, kind) => {
  const marker = textFor(kind)
  const title = kind === 'table' ? marker : `Field notes ${index}`
  const body = {
    'plain list': ['{plainlist}', '', `- ${marker}`, '- Record the observation.', '- Compare with the earlier results.'],
    iconlist: ['{iconlist} {iconlist=list}', '', '- Open the folder {icon=lucide:folder-open}', `- ${marker} {icon=lucide:clipboard-check}`, '- Check the tools {icon=lucide:wrench}'],
    table: ['{table}', '', '| Station | Count |', '| --- | --- |', '| North | 84 |', '| South | 39 |'],
    image: ['', marker, '', `![Field illustration](picture-${index % 12}.png)`],
  }[kind]
  return [`### ${title} {id=field-${index}}`, ...body, ''].join('\n')
}

await using scratch = createAppScratch()
const vault = join(scratch.root, 'vault')
const talk = join(vault, 'field-notes')
const outlinePath = join(talk, 'field-notes-outline.md')
mkdirSync(talk, { recursive: true })
mkdirSync(scratch.userData)
for (let i = 0; i < 12; i++) {
  copyFileSync('demo-vault/layout-sampler/assets/sample-image.png', join(talk, `picture-${i}.png`))
}
const slides = Array.from({ length: 96 }, (_, i) =>
  (i % 12 === 0 ? `## Survey area ${i / 12 + 1} {id=area-${i}}\n\n` : '')
  + (i >= 52 && i <= 57
    ? `### Navigation ${i} {id=field-${i}}\n${i % 2 ? '{mode=reveal}' : '{plainlist}'}\n\n- Detail for ${i}\n- Another detail\n`
    : makeSlide(i, kinds[i % kinds.length])))
writeFileSync(outlinePath, [
  '---', 'outline_version: 2', 'title: Field notes', 'palette: ocean', 'auto_title_slide: false', 'auto_thanks_slide: false',
  'defaults:', '  title: top', '---', '', ...slides,
].join('\n'))
writeFileSync(join(scratch.userData, 'config.json'), JSON.stringify({ vaultRoot: vault, openInView: 'markdown' }))

const { app, page } = await launchApp({ scratch })
await app.evaluate(({ BrowserWindow, ipcMain }) => {
  const windows = BrowserWindow.getAllWindows()
  if (windows.some(win => win.isVisible())) throw Error('Expected a hidden test window')
  for (const win of windows) win.setContentSize(1440, 900)
  const trace = globalThis.previewSpeedTrace = []
  const deckRevisions = globalThis.previewSpeedDeckRevisions = new Map()
  const { createHash } = process.getBuiltinModule('node:crypto')
  for (const channel of ['talk:compile', 'slide:render-preview', 'layout:variant-thumbnail']) {
    const handler = ipcMain._invokeHandlers.get(channel)
    ipcMain.removeHandler(channel)
    ipcMain.handle(channel, async (...args) => {
      const span = { channel, start: performance.timeOrigin + performance.now() }
      trace.push(span)
      try {
        if (channel === 'slide:render-preview' && globalThis.previewSpeedRefuse) return null
        const result = await handler(...args)
        if (channel === 'slide:render-preview' && args[4] == null && typeof result === 'string') {
          deckRevisions.set(result, createHash('sha256').update(args[2]).digest('hex'))
        }
        return result
      } finally {
        span.end = performance.timeOrigin + performance.now()
      }
    })
  }
})

const timeout = 30_000
page.setDefaultTimeout(timeout)
const frames = {
  markdown: 'iframe[title="Inspector live preview"]',
  slide: 'iframe[title="Slide preview"]',
}
const active = 'main.deck .slide.active'
const results = []
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

async function waitForSlide(view, slideId, canary) {
  const locator = page.frameLocator(frames[view]).locator(`${active}[data-id="${slideId}"]`)
  try {
    await locator.getByText(canary, { exact: true }).first().waitFor()
  } catch (error) {
    const heading = await page.locator('.tw-right-who').allTextContents()
    const src = await page.locator(frames[view]).evaluateAll(nodes => nodes.map(node => node.src))
    const shown = await page.frameLocator(frames[view]).locator(active).allTextContents().catch(() => [])
    throw new Error(JSON.stringify({ view, slideId, canary, heading, src, shown }), { cause: error })
  }
  return locator
}

// Observe the rendered slide in the iframe's own clock. Start watching before the key,
// and allow either an iframe navigation or an update to the current document.
await page.addInitScript(({ active }) => {
  if (location.protocol !== 'twpresent:' || location.hostname !== 'preview') return
  let previous
  function frame() {
    const slide = document.querySelector(active)
    if (slide && slide.getClientRects().length && [...slide.querySelectorAll('img')].every(img => img.complete && img.naturalWidth > 0)) {
      const text = slide.innerText
      const hash = location.hash
      const id = slide.dataset.id
      const signature = JSON.stringify([hash, id, text])
      if (signature !== previous) {
        previous = signature
        const at = performance.timeOrigin + performance.now()
        requestAnimationFrame(() => parent.postMessage({ type: 'preview-speed-frame', id, hash, text, at, documentStart: performance.timeOrigin }, '*'))
      }
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}, { active })

await openTalkByTitle(page, 'Field notes', { view: 'markdown' })

async function watch(view, id, before, after, navigation = false) {
  await page.evaluate(({ selector, id, before, after, navigation }) => {
    globalThis.previewSpeedInput = null
    globalThis.previewSpeedPaint = null
    globalThis.previewSpeedStale = false
    const controller = new AbortController()
    const options = { signal: controller.signal, capture: true }
    function input(event) {
      if (navigation && event.type === 'click' && !event.target.closest('button[aria-label="Next slide"]')) return
      if (!navigation && !event.target.closest('.cm-content')) return
      globalThis.previewSpeedInput ??= performance.timeOrigin + event.timeStamp
    }
    // The Slide view handles navigation on window capture and stops propagation to the document.
    window.addEventListener(navigation && selector.includes('Inspector') ? 'click' : 'keydown', input, options)
    window.addEventListener('message', event => {
      if (event.source !== document.querySelector(selector)?.contentWindow || event.data?.type !== 'preview-speed-frame') return
      const { text, hash, at, documentStart } = event.data
      if (globalThis.previewSpeedInput == null || at < globalThis.previewSpeedInput) return
      if (navigation && (hash === '#' + id || globalThis.previewSpeedPaint) && event.data.id !== id) {
        globalThis.previewSpeedStale = true
      }
      if (event.data.id !== id) return
      const lines = text.split('\n').map(line => line.replace(/\s+/g, ' ').trim())
      if (lines.includes(after)) globalThis.previewSpeedPaint ??= { at, documentStart }
      else if (globalThis.previewSpeedPaint && lines.includes(before)) globalThis.previewSpeedStale = true
    }, options)
    globalThis.previewSpeedStop = () => controller.abort()
  }, { selector: frames[view], id, before, after, navigation })
}

async function record(view, kind, sample) {
  await page.waitForFunction(() => globalThis.previewSpeedPaint != null)
  // Keep listening through the background deck's reply window, after the selected picture arrives.
  const timing = await page.evaluate(async ms => {
    const { at, documentStart } = globalThis.previewSpeedPaint
    const remaining = ms - (performance.timeOrigin + performance.now() - at)
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining))
    globalThis.previewSpeedStop()
    return { start: globalThis.previewSpeedInput, paint: at, documentStart, stale: globalThis.previewSpeedStale }
  }, STALE_CHECK_MS)
  assert.equal(timing.stale, false, 'A previous slide or revision appeared after the preview changed')
  assert.ok(Number.isFinite(timing.start) && timing.paint > timing.start)
  const spans = await app.evaluate((_electron, { start, paint }) =>
    globalThis.previewSpeedTrace.filter(span => span.start <= paint && (span.end ?? Infinity) >= start)
      .map(span => ({ channel: span.channel, startMs: Math.round(span.start - start),
        durationMs: span.end == null ? null : Math.round(span.end - span.start) })), timing)
  const result = { view, kind, sample, ms: Math.round((timing.paint - timing.start) * 10) / 10, spans }
  results.push(result)
  console.log(JSON.stringify(result))
  return { ...timing, spans }
}

async function measureNavigation(view) {
  const markdown = '[data-view="markdown"] .cm-content'
  if (view === 'slide') await page.keyboard.press(`${mod}+4`)
  await page.locator(markdown).waitFor()
  await position(markdown, 52, 'Navigation 52')
  await waitForSlide('markdown', 'field-52', 'Navigation 52')
  if (view === 'slide') await page.keyboard.press(`${mod}+1`)
  // Autosave can adopt normalised Trigger lines into the buffer before the clean navigation run.
  const base = await waitForCurrentDeck(view)
  await page.frameLocator(frames[view]).locator('main.deck:has([data-id="field-95"]) .slide.active[data-id="field-52"]').waitFor()
  const documentStart = await page.frameLocator(frames[view]).locator(active).evaluate(() => performance.timeOrigin)
  for (let index = 53; index <= 57; index++) {
    const id = `field-${index}`
    const title = `Navigation ${index}`
    await watch(view, id, `Navigation ${index - 1}`, title, true)
    if (view === 'markdown') {
      await page.getByRole('button', { name: 'Next slide', exact: true }).click()
    } else {
      await page.keyboard.press('PageDown')
    }
    assert.ok(Number.isFinite(await page.evaluate(() => globalThis.previewSpeedInput)),
      `The ${view} navigation input for ${id} was not observed`)
    await waitForSlide(view, id, title)
    const result = await record(view, 'navigation', index - 53)
    assert.equal(result.documentStart, documentStart, 'Clean navigation must keep the loaded deck document')
    assert.equal((await page.locator(frames[view]).getAttribute('src')).split('#')[0], base)
    assert.ok(result.spans.every(span => span.channel !== 'slide:render-preview' || span.startMs < 0),
      'Clean navigation must not request a preview compile')
  }
}

async function waitForCurrentDeck(view) {
  const editor = page.locator(`[data-view="${view}"] .cm-content`)
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const source = await editor.evaluate(element => element.cmTile.root.view.state.doc.toString())
    const base = (await page.locator(frames[view]).getAttribute('src'))?.split('#')[0]
    if (base && readFileSync(outlinePath, 'utf8') === source) {
      const revision = createHash('sha256').update(source).digest('hex')
      const current = await app.evaluate((_electron, { base, revision }) =>
        globalThis.previewSpeedDeckRevisions.get(base) === revision, { base, revision })
      if (current) return base
    }
    await delay(25)
  }
  throw Error(`The saved outline and the loaded ${view} deck did not converge`)
}

for (const view of ['markdown', 'slide']) {
  await page.keyboard.press(`${mod}+${view === 'markdown' ? 4 : 1}`)
  const editable = `[data-view="${view}"] .cm-content[contenteditable="true"]`
  await page.locator(editable).waitFor()
  await page.frameLocator(frames[view]).locator(active).waitFor()
  for (const [offset, kind] of kinds.entries()) {
    const index = 48 + offset
    const id = `field-${index}`
    const marker = textFor(kind)
    const initial = view === 'slide' ? marker + 'abcde' : marker
    if (view === 'slide') {
      const markdown = '[data-view="markdown"] .cm-content'
      await page.keyboard.press(`${mod}+4`)
      await page.locator(markdown).waitFor()
      await position(markdown, index, initial)
      await waitForSlide('markdown', id, initial)
      await page.keyboard.press(`${mod}+1`)
      await page.locator(editable).waitFor()
    }
    await position(editable, index, initial)
    const slide = await waitForSlide(view, id, initial)
    for (let sample = 0; sample < SAMPLES; sample++) {
      const character = 'abcde'[sample]
      const before = view === 'markdown' ? marker + 'abcde'.slice(0, sample) : marker + 'abcde'.slice(0, SAMPLES - sample)
      const after = view === 'markdown' ? before + character : before.slice(0, -1)
      await position(editable, index, before)
      await watch(view, id, before, after)
      await page.keyboard.press(view === 'markdown' ? character : 'Backspace')
      await slide.getByText(after, { exact: true }).first().waitFor()
      await record(view, kind, sample)
    }
  }
  await measureNavigation(view)
}

// A failed new revision gives an error on the stage instead of keeping its old slide picture.
await page.keyboard.press(`${mod}+4`)
const markdown = '[data-view="markdown"] .cm-content'
await page.locator(markdown).waitFor()
await position(markdown, 52, 'Navigation 52')
await waitForSlide('markdown', 'field-52', 'Navigation 52')
await page.keyboard.press(`${mod}+1`)
await waitForSlide('slide', 'field-52', 'Navigation 52')
await app.evaluate(() => { globalThis.previewSpeedRefuse = true })
await position('[data-view="slide"] .cm-content', 52, 'Navigation 52')
await page.keyboard.press('x')
await page.getByText('This slide couldn’t be previewed.', { exact: true }).waitFor()
assert.equal(await page.locator(frames.slide).count(), 0, 'An unavailable preview clears its previous picture')

async function position(selector, index, text) {
  await page.locator(selector).evaluate((element, { index, text }) => {
    const editor = element.cmTile.root.view
    const source = editor.state.doc.toString()
    const slide = source.indexOf(`{id=field-${index}}`)
    const heading = [...source.slice(0, slide).matchAll(/^### .*/gm)].at(-1)?.index ?? -1
    const next = source.indexOf('\n##', slide)
    const at = source.indexOf(text, heading)
    if (slide < 0 || heading < 0 || at < heading || (next >= 0 && at >= next)) throw Error(`Cannot find ${text} on slide ${index}`)
    editor.dispatch({ selection: { anchor: at + text.length }, scrollIntoView: true })
    editor.focus()
  }, { index, text })
}

const groups = []
for (const view of Object.keys(frames)) {
  for (const kind of [...kinds, 'navigation']) {
    const times = results.filter(result => result.view === view && result.kind === kind).map(result => result.ms).sort((a, b) => a - b)
    groups.push({ view, kind, median: times[Math.floor(times.length / 2)], max: times.at(-1) })
  }
}
console.log(JSON.stringify({ slides: slides.length, samplesPerCase: SAMPLES, groups }))
assert.ok(groups.every(group => group.median < BUDGET_MS), `A preview case median exceeded the ${BUDGET_MS} ms budget`)

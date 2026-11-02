// VirtualGrid's scroll anchoring in the DOM (src/renderer/src/components/slide-browser/VirtualGrid.tsx;
// review round 1 of the drawing ticket). One measured row recalibrates every row not yet measured,
// which moves everything below it; the review measured a 10 px correction moving line 500 by 4,990 px,
// so the focused card left the drawn range. This mounts the real VirtualGrid (JSDOM, a scripted
// ResizeObserver) over 600 groups, focuses a card far down, reports the first row 10 px taller than
// estimated, and checks that the focused card is still drawn and still at the same place on screen.
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(root, '.test-slide-browser-virtual-grid-'))
const bundle = join(dir, 'bundle.mjs')

const dom = new JSDOM('<!doctype html><html><body><div id="scroll"><div id="root"></div></div></body></html>', { url: 'https://talkweaver.test/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : (typeof dom.window[key] === 'function' && !/^[A-Z]/.test(key) ? dom.window[key].bind(dom.window) : dom.window[key]) })
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
// A ResizeObserver the test drives: every instance is kept, with what it observes.
const observers = []
globalThis.ResizeObserver = class {
  constructor(cb) { this.cb = cb; this.targets = new Set(); observers.push(this) }
  observe(el) { this.targets.add(el) }
  unobserve(el) { this.targets.delete(el) }
  disconnect() { this.targets.clear() }
}

try {
  await build({
    stdin: {
      contents: [
        "import React from 'react'",
        "import { createRoot } from 'react-dom/client'",
        "import { VirtualGrid } from './src/renderer/src/components/slide-browser/VirtualGrid.tsx'",
        "import { buildGridLines, createMeasureCache, lineHeight } from './src/renderer/src/components/slide-browser/gridWindowing.ts'",
        'export { React, createRoot, VirtualGrid, buildGridLines, createMeasureCache, lineHeight }'
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'test-slide-browser-virtual-grid-entry.tsx',
      loader: 'tsx'
    },
    bundle: true, format: 'esm', platform: 'node', jsx: 'automatic', keepNames: true,
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
    outfile: bundle, logLevel: 'error'
  })
  const { React, createRoot, VirtualGrid, buildGridLines, createMeasureCache, lineHeight } = await import(pathToFileURL(bundle).href)
  const { act } = React
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const settle = (ms = 30) => act(async () => { await sleep(ms) })

  const card = (slug, i) => ({ row: { talkSlug: slug, slide_id: `${slug}-${i}`, order: i }, kind: 'single' })
  const groups = Array.from({ length: 600 }, (_v, i) => ({ talkSlug: `t${i}`, talkTitle: `T${i}`, section: 's', units: 3, cards: [0, 1, 2].map((k) => card(`t${i}`, k)) }))
  const lines = buildGridLines({ mode: 'grouped', groups, groupTotals: new Map(), cols: 3, expandedPos: -1, groupKey: (g) => g.talkSlug, secName: (_k, f) => f })
  const FOCUS = 250 * 3 // the first card of group 250 (line 501)

  const scrollEl = document.getElementById('scroll')
  const scrollRef = { current: scrollEl }
  const renderLine = (line) => line.kind === 'row'
    ? React.createElement('div', null, line.cards.map((_c, j) => React.createElement('div', { key: j, className: 'card', 'data-pos': line.base + j })))
    : React.createElement('div', { className: 'head' }, line.key)
  const host = createRoot(document.getElementById('root'))
  const view = (focusPos) => React.createElement(VirtualGrid, { lines, scrollRef, renderLine, focusPos, focusDeps: lines, entryKey: lines })
  await act(async () => { host.render(view(0)) })
  await settle()
  await act(async () => { host.render(view(FOCUS)) }) // the keyboard moves far down: the list scrolls to it
  await settle()

  const focused = () => document.querySelector(`[data-pos="${FOCUS}"]`)
  const onScreen = () => parseFloat(focused().closest('.lt-vline').style.top) - scrollEl.scrollTop
  assert.ok(focused(), 'the focused card is drawn after the scroll to it')
  assert.ok(scrollEl.scrollTop > 10000, `the list scrolled down to it (${scrollEl.scrollTop}px)`)
  const screenBefore = onScreen()

  // The line observer reports the first row 10 px taller than estimated (it was drawn at the top earlier).
  const lineObserver = observers.find((o) => [...o.targets].some((t) => t.dataset?.vkey))
  assert.ok(lineObserver, 'mounted lines are observed')
  const first = lines[1]
  const fake = { dataset: { vkey: first.key } }
  const width = 0 // the box has no layout in JSDOM: measurements are recorded for width 0
  const measured = lineHeight(first, createMeasureCache(width), width) + 10
  await act(async () => { lineObserver.cb([{ target: fake, borderBoxSize: [{ blockSize: measured }] }]) })
  await settle()
  await settle()

  assert.ok(focused(), 'the focused card is still drawn after the calibration')
  assert.equal(onScreen(), screenBefore, 'and at the same place on screen (the scroll followed it)')

  // Off range: the focused card stays drawn even when the view is scrolled far away from it.
  await act(async () => { scrollEl.scrollTop = 0; scrollEl.dispatchEvent(new dom.window.Event('scroll')) })
  await settle()
  assert.ok(focused(), 'the focused card stays drawn when scrolled out of the drawn range')
  assert.ok(document.querySelector('[data-pos="0"]'), 'and the top of the list is drawn')

  await act(async () => { host.unmount() })
  console.log('PASS slide browser virtual grid: a calibration above the focused card keeps it drawn and in place')
} finally {
  rmSync(dir, { recursive: true, force: true })
}

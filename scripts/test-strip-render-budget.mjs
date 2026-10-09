// React render budget for the slide strip and the grid (docs/talkweaver-performance-contract.md).
//
// The strip's cards are memoised (MemoSlideCard, 94ed811, 10 July) so that a keystroke, a selection
// change or a thumbnail arriving re-renders only the cards whose data changed. On 27 July (187007c)
// a new `warnings` prop was computed inline per card per render, a fresh array every time, so the
// comparator never matched and every card re-rendered on every strip render again. Nothing counted
// React renders, so no gate noticed. This test counts them.
//
// Counting needs no production hook: the bundle rewrites `React.memo(` in the two components to a
// wrapper that counts each call of the memoised function, i.e. each card render React did not skip.
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(root, '.test-strip-render-budget-'))
const bundle = join(dir, 'bundle.mjs')

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://talkweaver.test/' })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : dom.window[key] })
}
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const renders = (globalThis.__twMemoRenders = {})
const reset = () => { for (const k of Object.keys(renders)) delete renders[k] }
const count = (name) => renders[name] ?? 0

// Wrap every React.memo in the two component modules so each non-skipped render is counted by name.
const countMemoRenders = {
  name: 'count-memo-renders',
  setup(b) {
    b.onLoad({ filter: /components[\\/](SlideStrip|GridView)\.tsx$/ }, (args) => {
      const source = readFileSync(args.path, 'utf8')
      const uses = source.split('React.memo(').length - 1
      if (uses === 0) throw new Error(`${args.path}: no React.memo( found; the render counter cannot attach`)
      const prelude = [
        'const __countedMemo = (fn, cmp) => React.memo(function CountedMemo(props) {',
        '  const name = fn.displayName || fn.name',
        '  globalThis.__twMemoRenders[name] = (globalThis.__twMemoRenders[name] ?? 0) + 1',
        '  return fn(props)',
        '}, cmp)'
      ].join('\n')
      const rewritten = source.replaceAll('React.memo(', '__countedMemo(')
      // After the imports (React must be in scope); every import in these files is one line.
      const lines = rewritten.split('\n')
      let last = -1
      lines.forEach((line, i) => { if (/^import\s/.test(line)) last = i })
      lines.splice(last + 1, 0, prelude)
      return { contents: lines.join('\n'), loader: 'tsx' }
    })
  }
}

const SLIDES = 50
function makeRows(n) {
  const rows = []
  for (let i = 0; i < n; i += 1) {
    rows.push({
      slide_id: `s${i}`,
      title: `Slide ${i}`,
      nav_title: `Slide ${i}`,
      section: `Part ${Math.floor(i / 10)}`,
      role: 'content',
      layout: 'default',
      text_excerpt: `excerpt ${i}`,
      source_markdown: `### Slide ${i}\n\n- point`,
      source_line: i * 3 + 1,
      render_hash: `rh${i}`,
      content_hash: `ch${i}`,
      // A few slides carry a strip-badge warning so the badge path is exercised, not just [].
      warnings: i % 7 === 0 ? [`board-columns-few:Slide ${i}:1`] : []
    })
  }
  return rows
}

try {
  await build({
    stdin: {
      contents: [
        "import React from 'react'",
        "import { createRoot } from 'react-dom/client'",
        "import SlideStrip from './src/renderer/src/components/SlideStrip.tsx'",
        "import GridView from './src/renderer/src/components/GridView.tsx'",
        'export { React, createRoot, SlideStrip, GridView }'
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'test-strip-render-budget-entry.tsx',
      loader: 'tsx'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    keepNames: true,
    plugins: [countMemoRenders],
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
    outfile: bundle,
    logLevel: 'error'
  })
  const { React, createRoot, SlideStrip, GridView } = await import(pathToFileURL(bundle).href)
  const { act } = React
  const failures = []
  const check = (ok, message) => { if (!ok) failures.push(message) }

  const talk = { slug: 't', title: 'T', outlinePath: '/v/t/t-outline.md' }
  const rows = makeRows(SLIDES)
  const triggerFindings = []
  const thumbnails = Object.fromEntries(rows.slice(0, SLIDES - 1).map((r) => [r.render_hash, `twthumb://t/${r.render_hash}.png`]))
  const markers = null

  // ---- Slide strip ----
  // Props are rebuilt each time the way WorkspaceLayout does: plain functions and inline arrows
  // are new on every parent render; data props keep their identity unless the data changed.
  const stripProps = (over = {}) => ({
    talk,
    compiledSlides: rows,
    outlineContent: 'outline v1',
    triggerFindings,
    thumbnails,
    activeIndex: 0,
    markers,
    onSelectSlide: () => {},
    onEdit: () => {},
    onReorder: () => {},
    onExplain: () => {},
    onMarker: () => {},
    onGhost: () => {},
    ...over
  })
  const stripRoot = createRoot(document.getElementById('root'))
  const renderStrip = (over) => act(async () => { stripRoot.render(React.createElement(SlideStrip, stripProps(over))) })

  await renderStrip()
  const cards = document.querySelectorAll('[data-slide-index]').length || document.querySelectorAll('.tw-slide-card, [data-testid="slide-card"]').length
  assert(count('SlideCard') >= SLIDES, `the strip mounts all ${SLIDES} cards (counted ${count('SlideCard')}, DOM ${cards})`)
  const badges = document.querySelectorAll('[data-slide-warning], .tw-slide-warning').length
  assert.equal(badges, Math.ceil(SLIDES / 7), 'slides with a strip-badge warning show the badge')

  reset()
  await renderStrip({ activeIndex: 1 })
  check(count('SlideCard') <= 2,
    `strip: changing the active slide re-rendered ${count('SlideCard')} of ${SLIDES} cards (budget: 2, the old and new active card)`)

  reset()
  await renderStrip({ activeIndex: 1 })
  check(count('SlideCard') === 0,
    `strip: a parent re-render with equal inputs re-rendered ${count('SlideCard')} cards (budget: 0)`)

  reset()
  await renderStrip({ activeIndex: 1, outlineContent: 'outline v1 + one keystroke' })
  check(count('SlideCard') === 0,
    `strip: a keystroke (new outline text, same compiled rows) re-rendered ${count('SlideCard')} cards (budget: 0)`)

  reset()
  const last = rows[SLIDES - 1]
  await renderStrip({ activeIndex: 1, thumbnails: { ...thumbnails, [last.render_hash]: `twthumb://t/${last.render_hash}.png` } })
  check(count('SlideCard') === 1,
    `strip: one thumbnail arriving re-rendered ${count('SlideCard')} cards (budget: 1)`)
  assert.equal(document.querySelectorAll('[data-slide-warning], .tw-slide-warning').length, Math.ceil(SLIDES / 7), 'badges survive skipped renders')
  await act(async () => { stripRoot.unmount() })

  // ---- Grid ----
  const host = document.createElement('div')
  document.body.appendChild(host)
  const gridRoot = createRoot(host)
  const gridProps = (over = {}) => ({
    talk,
    compiledSlides: rows,
    triggerFindings,
    thumbnails,
    activeIndex: 0,
    onSelectSlide: () => {},
    onEdit: () => {},
    onReorder: () => {},
    onExplain: () => {},
    columns: 4,
    ...over
  })
  const renderGrid = (over) => act(async () => { gridRoot.render(React.createElement(GridView, gridProps(over))) })
  reset()
  await renderGrid()
  assert(count('GridCell') >= SLIDES, `the grid mounts all ${SLIDES} cells (counted ${count('GridCell')})`)

  reset()
  await renderGrid({ activeIndex: 1 })
  check(count('GridCell') <= 2,
    `grid: changing the active slide re-rendered ${count('GridCell')} of ${SLIDES} cells (budget: 2)`)
  check(count('CellThumb') === 0, `grid: changing the active slide re-rendered ${count('CellThumb')} thumbnails (budget: 0)`)

  reset()
  await renderGrid({ activeIndex: 1 })
  check(count('GridCell') === 0, `grid: a parent re-render with equal inputs re-rendered ${count('GridCell')} cells (budget: 0)`)
  await act(async () => { gridRoot.unmount() })

  if (failures.length) {
    console.error('React render budget exceeded:\n  - ' + failures.join('\n  - '))
    console.error('Every prop a memoised card compares must keep its identity unless its data changed: derive it in useMemo, never inline per render, and route handlers through latest-refs.')
    process.exitCode = 1
  } else {
    console.log(`ok: strip and grid re-render only the cards whose data changed (${SLIDES} slides)`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

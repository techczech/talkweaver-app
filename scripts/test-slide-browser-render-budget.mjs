// React render budget for the Slide Browser (drawing ticket; pattern of test-strip-render-budget.mjs).
//
// On a real vault (8,653 slides) the empty-query view mounted 5,150 cards (121,644 DOM nodes), every
// keystroke re-rendered all of them (~230 ms each) and clearing the search fetched the whole index
// again. This test mounts the real SlideBrowser over ~5,000 synthetic rows in ~700 talk·section
// groups (JSDOM, a mocked window.tw) and checks:
//   - only the cards near the viewport are mounted (under 300);
//   - a keystroke (before the search field's debounce) re-renders no card;
//   - the committed query's loading flag re-renders no card;
//   - a selection change re-renders at most the cards it affects;
//   - a tag change re-renders exactly the tagged cards, and their chips show the new tag;
//   - clearing the search shows the whole set again without a new scan while main's freshness stamp
//     is unchanged; with a new stamp it searches (loading state, never the held rows first), and a
//     failed search then shows the error state, not the held rows.
// Counting needs no production hook: the bundle rewrites `React.memo(` in SlideCard.tsx to a wrapper
// that counts each render React did not skip.
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(root, '.test-slide-browser-render-budget-'))
const bundle = join(dir, 'bundle.mjs')

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'https://talkweaver.test/', pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'Element', 'Node', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'KeyboardEvent', 'MouseEvent', 'Event']) {
  Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? dom.window : (typeof dom.window[key] === 'function' && !/^[A-Z]/.test(key) ? dom.window[key].bind(dom.window) : dom.window[key]) })
}
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const renders = (globalThis.__twMemoRenders = {})
const reset = () => { for (const k of Object.keys(renders)) delete renders[k] }
const count = (name) => renders[name] ?? 0

const countMemoRenders = {
  name: 'count-memo-renders',
  setup(b) {
    b.onLoad({ filter: /slide-browser[\\/]SlideCard\.tsx$/ }, (args) => {
      const source = readFileSync(args.path, 'utf8')
      if (!source.includes('React.memo(')) throw new Error(`${args.path}: no React.memo( found; the render counter cannot attach`)
      const prelude = [
        'const __countedMemo = (fn, cmp) => React.memo(function CountedMemo(props) {',
        '  const name = fn.displayName || fn.name',
        '  globalThis.__twMemoRenders[name] = (globalThis.__twMemoRenders[name] ?? 0) + 1',
        '  return fn(props)',
        '}, cmp)'
      ].join('\n')
      const lines = source.replaceAll('React.memo(', '__countedMemo(').split('\n')
      let last = -1
      lines.forEach((line, i) => { if (/^import\s/.test(line)) last = i })
      lines.splice(last + 1, 0, prelude)
      return { contents: lines.join('\n'), loader: 'tsx' }
    })
  }
}

// ~5,000 rows: 143 talks × 5 sections × 7 slides = 715 groups. Distinct content (no duplicate stacks).
const TALKS = 143, SECTIONS = 5, PER_SECTION = 7
const talks = []
const rows = []
for (let t = 0; t < TALKS; t++) {
  const slug = `talk-${t}`
  const outlinePath = `/vault/${slug}/${slug}-outline.md`
  talks.push({ slug, title: `Talk ${t}`, outlinePath, path: `/vault/${slug}`, vaultId: 'v1' })
  let order = 0
  for (let s = 0; s < SECTIONS; s++) {
    for (let k = 0; k < PER_SECTION; k++) {
      const title = `Slide ${t}.${s}.${k} about **topic** ${k % 2 ? 'alpha' : 'beta'}`
      rows.push({
        slide_id: `${slug}-s${order}`, deck_slug: slug, order, section: `section-${s}`, subsection: '', role: 'content',
        layout: '', nav_title: title, title, word_count: 20 + k, bullet_count: 3, image_count: 0, embed_count: 0,
        source_markdown: `### ${title}\n\n- point ${t} ${s} ${k}\n- another unique ${order * 7919}`, source_line: order * 4 + 1,
        triggers: {}, tags: [], content_hash: `ch-${t}-${order}`, render_hash: `rh-${t}-${order}`,
        talkSlug: slug, talkTitle: `Talk ${t}`, outlinePath, vaultId: 'v1', talkMtimeMs: 1, talkMeta: '', titleHit: false
      })
      order++
    }
  }
}
const TOTAL = rows.length

const { compactSlideSearchReply } = await import(pathToFileURL(join(root, 'src/shared/slide-search-reply.ts')).href)
const searchCalls = []
const stampCalls = []
let gate = null // when set, search replies wait for it (to observe the loading state)
let stamp = 'stamp-1' // main's freshness stamp now
let failSearch = false // when set, main answers the search with null (search unavailable)
let dropped = 0 // rows removed from the end of the index ("another window changed a talk")
function reply(query) {
  const terms = query.terms ?? []
  const all = rows.slice(0, rows.length - dropped)
  const hits = terms.length === 0 ? all : all.filter((r) => terms.every((w) => r.nav_title.toLowerCase().includes(w)))
  return compactSlideSearchReply(hits.map((r) => structuredClone(r)), (r) => {
    const { talkSlug, talkTitle, outlinePath, vaultId, talkMtimeMs, talkMeta, titleHit, ...row } = r
    return { row, titleHit, talk: { talkSlug, talkTitle, outlinePath, vaultId, talkMtimeMs, talkMeta } }
  }, stamp)
}
const noop = () => () => {}
dom.window.tw = {
  vault: {
    list: async () => [{ id: 'v1', name: 'Vault', root: '/vault', open: true, unavailable: null }],
    listTalks: async () => talks,
    listFolders: async () => [],
    talkMeta: async () => ({}),
    onTalkMetaUpdated: noop
  },
  tags: { vocabulary: async () => [], apply: async () => ({ ok: true, failed: [] }) },
  recording: { listAllSessions: async () => [] },
  ledger: { versions: async () => [], whereUsed: async () => [], versionThumbnails: async () => ({}) },
  talk: { readOutline: async () => null, thumbnails: async () => ({}) },
  search: {
    allSlides: async () => { throw new Error('the Browser must use the compact reply') },
    allSlidesCompact: async (query, options) => {
      searchCalls.push({ query, options })
      const s = stamp // the stamp is taken when the scan starts
      if (gate) await gate.promise
      if (failSearch) return null
      const r = reply(query)
      r.stamp = s
      return r
    },
    indexStamp: async (options) => { stampCalls.push(options); return stamp }
  }
}
globalThis.tw = dom.window.tw
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  await build({
    stdin: {
      contents: [
        "import React from 'react'",
        "import { createRoot } from 'react-dom/client'",
        "import SlideBrowser from './src/renderer/src/components/SlideBrowser.tsx'",
        'export { React, createRoot, SlideBrowser }'
      ].join('\n'),
      resolveDir: root,
      sourcefile: 'test-slide-browser-render-budget-entry.tsx',
      loader: 'tsx'
    },
    bundle: true,
    format: 'esm',
    platform: 'node',
    jsx: 'automatic',
    keepNames: true,
    plugins: [countMemoRenders],
    loader: { '.css': 'empty', '.svg': 'text', '.png': 'empty' },
    external: ['react', 'react/*', 'react-dom', 'react-dom/*', 'lucide-react'],
    outfile: bundle,
    logLevel: 'error'
  })
  const { React, createRoot, SlideBrowser } = await import(pathToFileURL(bundle).href)
  const { act } = React
  const failures = []
  const checkBudget = (ok, message) => { if (!ok) failures.push(message) }
  const settle = (ms = 30) => act(async () => { await sleep(ms) })

  const props = {
    isOpen: true, onClose: () => {}, onInsert: () => {}, onInsertMany: () => {}, currentTalkSlug: 'not-on-the-table',
    vaultRoot: '/vault', onOpenHelp: () => {}, currentOutlinePath: '/elsewhere/x-outline.md', currentTalkVaultId: 'v1'
  }
  const host = createRoot(document.getElementById('root'))
  await act(async () => { host.render(React.createElement(SlideBrowser, props)) })
  await settle(60)
  await settle(60)

  const cards = () => document.querySelectorAll('.lt-card:not(.skeleton)').length
  const countLabel = () => document.querySelector('.lt-result-count')?.textContent ?? ''
  assert.equal(searchCalls.length, 1, 'the opening runs one search')
  assert.match(countLabel(), new RegExp(`^${TOTAL} slides · ${TALKS * SECTIONS} sections`), `the whole set is shown (${countLabel()})`)
  const mounted = cards()
  console.log(`  rows ${TOTAL} in ${TALKS * SECTIONS} groups; mounted cards ${mounted}; DOM nodes ${document.getElementsByTagName('*').length}`)
  checkBudget(mounted > 0 && mounted < 300, `mounted ${mounted} cards for ${TOTAL} rows (budget: under 300)`)
  assert.ok(document.querySelectorAll('.lt-group-head').length > 0, 'group headings are drawn with their rows')

  // ---- a keystroke, before the field's debounce ----
  const input = document.querySelector('input[aria-label^="Search slides"]')
  assert.ok(input, 'the search field is there')
  const type = async (value) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
      setter.call(input, value)
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
    })
  }
  reset()
  await type('a')
  checkBudget(count('SlideCard') === 0, `a keystroke re-rendered ${count('SlideCard')} cards (budget: 0)`)
  await type('al')
  await type('alp')
  checkBudget(count('SlideCard') === 0, `three keystrokes re-rendered ${count('SlideCard')} cards (budget: 0)`)
  assert.equal(searchCalls.length, 1, 'typing does not search until the field pauses')
  assert.equal(countLabel(), 'searching…', 'pending typing must not present the old cards as settled results')

  // ---- the committed query: loading flag on, no card re-renders ----
  let open
  gate = { promise: new Promise((r) => { open = r }) }
  reset()
  await settle(260) // past the debounce: the query commits…
  await settle(10) // …and the search is in flight
  assert.equal(searchCalls.length, 2, 'the paused field ran one search')
  assert.equal(countLabel(), 'searching…', 'the loading flag is on')
  checkBudget(count('SlideCard') === 0, `the loading flag re-rendered ${count('SlideCard')} cards (budget: 0)`)
  gate = null
  await act(async () => { open() })
  await settle(30)
  const matches = rows.filter((r) => r.nav_title.toLowerCase().includes('alp')).length
  assert.match(countLabel(), new RegExp(`^${matches} slides`), `the query's results are shown (${countLabel()})`)

  // ---- a selection change ----
  reset()
  const third = document.querySelector('.lt-card[data-pos="2"]')
  assert.ok(third, 'card 2 is drawn')
  await act(async () => { third.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  assert.ok(document.querySelector('.lt-card[data-pos="2"]').classList.contains('selected'), 'the clicked card is selected')
  checkBudget(count('SlideCard') <= 2, `selecting a card re-rendered ${count('SlideCard')} cards (budget: 2 — the clicked card and the one that lost focus)`)
  await act(async () => { input.blur() }) // X is a grid key: never from the search field
  reset()
  await act(async () => { dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'x', bubbles: true })) })
  checkBudget(count('SlideCard') <= 1, `X on the focused card re-rendered ${count('SlideCard')} cards (budget: 1)`)
  assert.equal(document.querySelector('.lt-card[data-pos="2"]').classList.contains('selected'), false, 'X toggled it off')
  reset()
  await act(async () => { host.render(React.createElement(SlideBrowser, { ...props, onClose: () => {} })) })
  checkBudget(count('SlideCard') === 0, `a parent re-render with new handler props re-rendered ${count('SlideCard')} cards (budget: 0)`)

  // ---- a tag change: exactly the tagged cards re-render, with the new chip ----
  const cardAt = (p) => document.querySelector(`.lt-card[data-pos="${p}"]`)
  for (const p of [3, 4]) await act(async () => { cardAt(p).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) })
  assert.ok(cardAt(3).classList.contains('selected') && cardAt(4).classList.contains('selected'), 'cards 3 and 4 are selected')
  await act(async () => { input.blur() })
  await act(async () => { dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 't', bubbles: true })) })
  await settle(10)
  const tagInput = document.querySelector('input[aria-label="Filter or create tags"]')
  assert.ok(tagInput, 'T opened the tag picker')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
    setter.call(tagInput, 'fresh-tag')
    tagInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  })
  reset()
  await act(async () => { tagInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await settle(20)
  const chips = (p) => [...cardAt(p).querySelectorAll('.lt-minitag')].map((e) => e.textContent)
  assert.deepEqual(chips(3), ['fresh-tag'], `card 3 shows the new tag (${chips(3)})`)
  assert.deepEqual(chips(4), ['fresh-tag'], `card 4 shows the new tag (${chips(4)})`)
  assert.deepEqual(chips(5), [], 'an untagged card shows no tag')
  checkBudget(count('SlideCard') === 2, `tagging two cards re-rendered ${count('SlideCard')} cards (budget: exactly the 2 tagged)`)
  await act(async () => { dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
  await settle(10)

  // ---- clearing the search, index unchanged: the held set, no new scan ----
  const before = searchCalls.length
  const probesBefore = stampCalls.length
  await type('')
  await settle(260)
  await settle(10)
  checkBudget(searchCalls.length === before, `clearing the search asked main for a new scan (${searchCalls.length - before} calls; budget: 0)`)
  assert.ok(stampCalls.length > probesBefore, 'clearing asked main whether the held set is current')
  assert.match(countLabel(), new RegExp(`^${TOTAL} slides · ${TALKS * SECTIONS} sections`), `clearing shows the whole set (${countLabel()})`)
  checkBudget(cards() > 0 && cards() < 300, `after clearing, ${cards()} cards mounted (budget: under 300)`)

  // ---- clearing after the index changed: a search, with its loading state; never the held rows ----
  await type('beta')
  await settle(260)
  await settle(30)
  const betaLabel = countLabel()
  assert.match(betaLabel, /^\d+ slides/, `the query's results are shown (${betaLabel})`)
  stamp = 'stamp-2'
  dropped = PER_SECTION // one section of the last talk went (an edit in another window)
  const beforeStale = searchCalls.length
  gate = { promise: new Promise((r) => { open = r }) }
  await type('')
  await settle(260)
  await settle(10)
  assert.equal(searchCalls.length, beforeStale + 1, 'clearing after a change runs a new scan')
  assert.equal(countLabel(), 'searching…', `the loading state shows while it runs, not the held rows (${countLabel()})`)
  gate = null
  await act(async () => { open() })
  await settle(30)
  assert.match(countLabel(), new RegExp(`^${TOTAL - PER_SECTION} slides`), `the new whole set is shown (${countLabel()})`)

  // ---- …and when that search fails: the error state, not the held rows ----
  await type('beta')
  await settle(260)
  await settle(30)
  stamp = 'stamp-3'
  failSearch = true
  await type('')
  await settle(260)
  await settle(30)
  assert.equal(countLabel(), 'search unavailable', `a failed refresh shows the error state (${countLabel()})`)
  assert.equal(cards(), 0, `a failed refresh shows no held cards (${cards()} drawn)`)
  failSearch = false

  await act(async () => { host.unmount() })
  if (failures.length) {
    console.error('Slide Browser render budget exceeded:\n  - ' + failures.join('\n  - '))
    console.error('Cards are memoised (SlideCard): every prop must keep its identity unless its data changed; handlers go through the one CardActions object.')
    process.exitCode = 1
  } else {
    console.log(`PASS slide browser render budget: ${mounted} of ${TOTAL} cards mounted; typing, loading, selection and tagging re-render only affected cards; clearing reuses the whole set only while main's stamp is unchanged`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

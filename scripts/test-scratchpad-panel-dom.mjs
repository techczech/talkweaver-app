// The Slide Scratchpad panel in headless Chromium (Playwright chrome-headless-shell/Chromium, never Chrome) over a
// fake window.tw.scratchpad that holds the snapshot in memory: lists and counts, search with chips and highlighting,
// the group menu, tick boxes and the batch bar, Keep / Reject / Move back, the big preview and its sandboxed HTML
// frame, the empty state, collapse / dock / float with persisted layout, and the panel's commands. Ticket 2: the action
// area (Insert whole slide, Insert visual only with its chooser, the placement note, Change place), the Inserted note,
// Compare side by side, and that nothing but the two Insert buttons asks the workspace to insert.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..')
const scratch = mkdtempSync(join(tmpdir(), 'tw-scratchpad-dom-'))
const shotAt = process.argv.indexOf('--screenshots')
const shots = shotAt >= 0 ? resolve(process.argv[shotAt + 1]) : null
let browser
try {
  await build({
    stdin: {
      contents: `import React from 'react'; import { createRoot } from 'react-dom/client'
import './src/renderer/src/styles.css'
import './src/renderer/src/image-drawer.css'
import ScratchpadPanel from './src/renderer/src/components/scratchpad/ScratchpadPanel.tsx'
import { useScratchpad } from './src/renderer/src/lib/useScratchpad.ts'
import { useScratchpadLayout } from './src/renderer/src/lib/useScratchpadLayout.ts'
const at = (m) => new Date(2026, 9, 27, 22, m).toISOString()
const slide = (id, title, talk, m, over = {}) => ({ id, kind: 'slide', addedAt: at(m), batch: { source: 'slide-browser', at: at(m) }, group: null, status: 'active', title, description: '', sources: [], missing: false, slide: { talkPath: 'b/' + talk + '.md', talkTitle: talk, slideId: id, title, markdown: '### ' + title + '\\n\\n- predicts the next word\\n', thumbKey: 'k' + id }, ...over })
const file = (id, name, fileKind, m, over = {}) => ({ id, kind: 'file', file: name, fileKind, addedAt: at(m), batch: { source: 'agent', at: at(m) }, group: null, status: 'active', title: name.split('.')[0], description: '', sources: [], missing: false, ...over })
const initial = () => ({ groups: [{ id: 'g1', name: 'Opening' }], notices: [], items: [
  slide('a', 'What is a language model', 'Introduction to AI', 50), slide('b', 'A research loop', 'AI in the workflow', 50, { group: 'g1' }),
  file('c', 'research-loop.html', 'html', 40, { description: 'Interactive loop' }), file('d', 'diagram.svg', 'svg', 40, { fileUrl: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%2210%22/%3E' }),
  file('e', 'photo.png', 'pic', 30, { status: 'kept' }), file('f', 'old.svg', 'svg', 20, { status: 'rejected' }), file('m', 'gone.svg', 'svg', 10, { missing: true })] })
let snap = initial(); let listeners = new Set(); window.calls = []; window.emptyMode = false; window.inserts = []
// Picked slide b shows two visuals (a picture and a page), so Insert visual only offers a chooser.
snap.items[1].slide.markdown = '### A research loop\\n\\n![Loop](assets/loop.png)\\n\\n[Embed: assets/loop.html]\\n'
const emit = () => { for (const l of listeners) l(snap) }
const reply = (extra = {}) => ({ ok: true, snapshot: snap, ...extra })
window.tw = { scratchpad: {
  subscribe: async () => reply(), unsubscribe: async () => ({ ok: true }), load: async () => reply(),
  onChanged: (cb) => { listeners.add(cb); return () => listeners.delete(cb) },
  setStatus: async (ids, status) => { window.calls.push('status:' + status + ':' + ids.join(',')); snap = { ...snap, items: snap.items.map((i) => ids.includes(i.id) ? { ...i, status } : i) }; return reply() },
  setGroup: async (ids, g) => { window.calls.push('group:' + g + ':' + ids.join(',')); snap = { ...snap, items: snap.items.map((i) => ids.includes(i.id) ? { ...i, group: g } : i) }; return reply() },
  createGroup: async (name) => { const group = { id: 'g' + (snap.groups.length + 1), name }; window.calls.push('new:' + name); snap = { ...snap, groups: [...snap.groups, group] }; return reply({ group }) },
  removeMissing: async (ids) => { window.calls.push('remove:' + ids.join(',')); snap = { ...snap, items: snap.items.filter((i) => !ids.includes(i.id)) }; return reply() },
  htmlPreview: async (id) => { window.calls.push('html:' + id); return { ok: true, url: 'about:blank', sandbox: 'allow-scripts allow-forms' } },
  revealFolder: async () => { window.calls.push('folder'); return { ok: true } }
} }
window.repaint = () => { snap = { ...snap }; emit() }
window.empty = () => { snap = { groups: [], items: [], notices: [] }; emit() }
window.selectionFixture = () => {
  snap = { groups: [{ id: 'g1', name: 'Opening' }], notices: [], items: [
    slide('old', 'Run oldest', 'Talk', 10), slide('hidden', 'Outside search', 'Talk', 45),
    slide('new', 'Run newest', 'Talk', 59), slide('rejected', 'Run rejected', 'Talk', 55, { status: 'rejected' }),
    slide('middle', 'Run middle', 'Talk', 40), slide('tail', 'Run tail', 'Talk', 5)
  ] }; window.calls = []; emit()
}
window.selectionState = () => snap.items.map(({ id, status, group }) => ({ id, status, group }))
// The workspace's side of inserting, faked: the talk's slides, the place (after the caret's slide 7 until one is
// chosen), and an insert that only records what was asked and marks the item as main would.
const ROWS = [{ line: 5, level: 2, title: 'Reading', no: 3 }, { line: 8, level: 3, title: 'Where AI helps in a research project', no: 7 }, { line: 20, level: 3, title: 'Where it does not help', no: 8 }]
function useFakeInsert() {
  const [chosen, setChosen] = React.useState(null)
  return {
    place: chosen ?? { kind: 'after', line: 8, title: ROWS[1].title }, chosen: chosen !== null, caretInBody: true,
    rows: () => ROWS, numberAt: (line) => ROWS.find((r) => r.line === line)?.no ?? null,
    choose: (place) => setChosen(place), busy: false,
    hasSlideTitled: (title) => ROWS.some((r) => r.title === title) && !window.undone,
    insert: async (item, mode, visual) => {
      window.inserts.push([mode, item.id, visual ? visual.ref : null])
      snap = { ...snap, items: snap.items.map((i) => (i.id === item.id ? { ...i, insertedAt: new Date().toISOString(), insertedInto: 'Where it does not help' } : i)) }; emit()
      return true
    }
  }
}
function App() {
  const data = useScratchpad('/vault/talk/talk-outline.md'); const layoutApi = useScratchpadLayout(); const actions = React.useRef({}); const insert = useFakeInsert()
  window.layoutApi = layoutApi; window.run = (id) => actions.current[id]?.()
  const btn = (label, extra = '') => <button type="button" className={'toolbar-btn' + extra}><span className="toolbar-btn-content"><svg width="15" height="15" /><span>{label}</span><svg width="12" height="12" /></span></button>
  return <div className="workspace-row" style={{ flex: 1 }}><div className="workspace-main"><div className={'workspace-toolbar' + (layoutApi.layout.mode === 'docked' ? ' workspace-toolbar--tight' : '')} data-testid="fake-toolbar">
      <span className="workspace-title">A talk with a fairly long title</span>
      <div className="pane-toggle">{[1, 2, 3, 4].map((n) => <button key={n} className="pane-btn"><svg width="17" height="17" /></button>)}</div>
      <div className="toolbar-actions">{btn('Share')}{btn('Place')}{btn('Deck')}{btn('Tools')}{btn('Present', ' toolbar-btn--primary')}</div>
    </div><button id="open-browser-probe" onClick={() => window.calls.push('browser')}>probe</button></div>
    <ScratchpadPanel data={data} layoutApi={layoutApi} registerActions={(a) => { actions.current = a }} onOpenSlideBrowser={() => window.calls.push('browser')} insert={insert} /></div>
}
createRoot(document.getElementById('root')).render(<App />)`,
      sourcefile: 'scratchpad-dom.tsx', loader: 'tsx', resolveDir: root
    },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(scratch, 'test.js'),
    loader: { '.css': 'css' }, logLevel: 'error'
  })
  writeFileSync(join(scratch, 'test.html'), '<!doctype html><meta charset="utf-8"><style>:root{--panel:#fffdf8;--paper:#f7f3ea;--line:#d9d0c1;--ink:#17202a;--muted:#5d6875;--faint:#8a9099;--oxford:#0b3a6b;--green:#166534;--amber:#92600a;--crimson:#9b1c1c;--hover:#ede8dc;--font-ui:system-ui;--font-serif:Georgia;--font-mono:monospace}body{margin:0;background:var(--paper)}#root{height:100vh;display:flex}</style><link rel="stylesheet" href="test.css"><div id="root"></div><script src="test.js"></script>')
  browser = await chromium.launch({ headless: true, executablePath: process.env.TW_CHROMIUM_HEADLESS_SHELL || undefined })
  const page = await browser.newPage({ viewport: { width: 1300, height: 900 } })
  page.setDefaultTimeout(8000)
  const panel = () => page.locator('.sp-panel')
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(pathToFileURL(join(scratch, 'test.html')).href)

  const calls = () => page.evaluate(() => window.calls)
  const clear = () => page.evaluate(() => { window.calls = [] })
  let checks = 0
  const step = async (name, fn) => { try { await fn(); checks++ } catch (error) { console.error(`FAIL ${name}`); throw error } }

  await step('collapsed: the pill carries the active count and expands to the floating panel', async () => {
    assert.match(await page.locator('.sp-pill').innerText(), /Slide Scratchpad · 5/)
    await page.locator('.sp-pill').click()
    await page.locator('.sp-panel--float').waitFor()
  })
  const tabs = async () => (await page.locator('.sp-tabs button').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')).join('|')
  await step('the header is two rows: search + group menu, then chips + tabs on one row', async () => {
    const rows = await page.evaluate(() => {
      const y = (sel) => Math.round(document.querySelector(sel).getBoundingClientRect().top)
      return { search: y('.sp-searchrow'), chips: y('.sp-chips'), tabs: y('.sp-tabs'), hint: document.querySelectorAll('.sp-hint').length, w: [document.querySelector('.sp-panel').clientWidth, document.querySelector('.sp-chips').getBoundingClientRect().width, document.querySelector('.sp-tabs').getBoundingClientRect().width, document.querySelector('.sp-tabs').scrollWidth] }
    })
    assert.equal(rows.hint, 0, 'the prefix hint line is gone (it is the search box tooltip)')
    assert.ok(Math.abs(rows.chips - rows.tabs) < 14, 'chips and tabs share a row ' + JSON.stringify(rows))
    assert.ok(rows.chips > rows.search)
    assert.match(await page.getByLabel('Search the Slide Scratchpad').getAttribute('title'), /slide: svg: html: pic:/)
  })
  await step('tabs with counts; newest-first sections per arrival batch', async () => {
    assert.equal(await tabs(), 'All5|Picked slides2|Agent visuals3|Kept1|Rejected1')
    assert.deepEqual((await page.locator('.sp-batch').allInnerTexts()).map((h) => h.replace(/\s+/g, ' ')), ['Picked from Slide Browser 22:502', 'Made by agent 22:402', 'Made by agent 22:101'])
    assert.equal(await page.locator('.sp-day').count(), 1, 'one day heading over batches of the same day')
    assert.equal(await page.locator('.sp-badge--missing').count(), 1)
    if (shots) await page.screenshot({ path: join(shots, 'scratchpad-float.png') })
  })
  await step('search: chips edit the query text, typing a prefix lights the chip, hits are highlighted, counts hold', async () => {
    const input = page.getByLabel('Search the Slide Scratchpad')
    await page.getByRole('button', { name: /^SVG/ }).click()
    assert.equal(await input.inputValue(), 'svg:')
    assert.equal(await page.getByRole('button', { name: /^SVG/ }).getAttribute('aria-pressed'), 'true')
    assert.equal(await page.locator('.sp-card').count(), 2, 'svg: shows diagram and the missing svg (active only)')
    await input.fill('html: loop')
    assert.equal(await page.getByRole('button', { name: /^HTML/ }).getAttribute('aria-pressed'), 'true')
    assert.equal(await page.locator('.sp-card').count(), 1)
    assert.equal(await page.locator('.sp-card-title mark').innerText(), 'loop')
    await input.fill('from:workflow')
    assert.deepEqual(await page.locator('.sp-card-title').allInnerTexts(), ['A research loop'])
    assert.match(await page.locator('.sp-res').innerText(), /1 match/)
    assert.equal(await tabs(), 'All5|Picked slides2|Agent visuals3|Kept1|Rejected1')
    await page.getByRole('button', { name: 'Clear', exact: true }).click()
    assert.equal(await input.inputValue(), '')
  })
  await step('Shift selection excludes items hidden by the current filter', async () => {
    const input = page.getByLabel('Search the Slide Scratchpad')
    await input.fill('svg:')
    await page.locator('.sp-card', { hasText: 'diagram' }).click()
    await page.locator('.sp-card', { hasText: 'gone' }).click({ modifiers: ['Shift'] })
    assert.match(await page.locator('.sp-foot').innerText(), /2 selected/)
    assert.equal(await page.getByLabel('Select diagram').isChecked(), true)
    assert.equal(await page.getByLabel('Select gone').isChecked(), true)
    await page.getByRole('button', { name: 'Clear selection' }).click()
    await input.fill('')
  })
  await step('group menu: counts, filter by group, new group from the menu', async () => {
    await page.getByRole('button', { name: /^All items ▾/ }).click()
    const rows = (await page.locator('.sp-searchrow .sp-menu-row').allInnerTexts()).map((t) => t.replace(/\s+/g, ' '))
    assert.deepEqual(rows, ['All items 5', 'Ungrouped 4', 'Opening 1', 'New group…'])
    await page.locator('.sp-menu-row', { hasText: 'Opening' }).click()
    assert.deepEqual(await page.locator('.sp-card-title').allInnerTexts(), ['A research loop'])
    await page.getByRole('button', { name: /^Opening ▾/ }).click()
    await page.getByRole('menuitem', { name: 'New group…' }).click()
    await page.getByLabel('New group name').fill('Maybe')
    await page.getByRole('button', { name: 'Create' }).click()
    assert.ok((await calls()).includes('new:Maybe'))
    assert.match(await page.locator('.sp-searchrow > .sp-anchor > .sp-btn').innerText(), /Maybe/)
    assert.equal(await page.locator('.sp-card').count(), 0)
    assert.match(await page.locator('.sp-none').innerText(), /Nothing matches/)
    await page.getByRole('button', { name: 'show All items' }).click()
    assert.equal(await page.locator('.sp-card').count(), 5)
    await clear()
  })
  const inserts = () => page.evaluate(() => window.inserts)
  const card = (title) => page.locator('.sp-card', { hasText: title })
  await step('action area: Insert buttons beside Keep / Reject / Move, the placement note, Change place (which inserts nothing)', async () => {
    await card('A research loop').click()
    const insertButton = page.getByRole('button', {name: 'Insert whole slide', exact:true})
    const styleOf = () => insertButton.evaluate(el => { const s=getComputedStyle(el); return {color:s.color, background:s.backgroundColor, outline:s.outlineStyle, opacity:s.opacity} })
    assert.equal((await styleOf()).color, 'rgb(255, 255, 255)', 'primary insert foreground overrides panel button inheritance')
    await insertButton.hover()
    assert.equal((await styleOf()).color, 'rgb(255, 255, 255)', 'hover keeps the explicit foreground')
    await insertButton.focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    assert.notEqual((await styleOf()).outline, 'none', 'keyboard focus stays visible')
    await insertButton.evaluate(el => {el.disabled=true})
    assert.equal((await styleOf()).color, 'rgb(255, 255, 255)', 'disabled primary keeps its foreground')
    assert.equal((await styleOf()).opacity, '0.45', 'disabled state keeps the existing treatment')
    await insertButton.evaluate(el => {el.disabled=false})
    const single = page.locator('.sp-single')
    assert.deepEqual((await single.locator('.sp-actions > button, .sp-actions > .sp-anchor > button').allInnerTexts()).map((t) => t.trim()),
      ['Insert whole slide', 'Insert visual only ▾', 'Keep for library', 'Reject', 'Move to group… ▾'])
    assert.equal(await page.locator('.sp-place-where').innerText(), 'Inserts after slide 7 · ‘Where AI helps in a research project’')
    assert.equal(await page.locator('.sp-place-rule').innerText(), 'Insert whole slide adds a new slide after slide 7. Insert visual only adds to slide 7 at the cursor.')
    await page.getByRole('button', { name: 'Change place' }).click()
    const chooser = page.getByRole('dialog', { name: 'Change place' })
    assert.deepEqual((await chooser.locator('.sp-menu-row').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()),
      ['At the start of the talk', '03Reading', '07Where AI helps in a research project', '08Where it does not help'])
    // A click with no press before it (an accessibility press) outside the list closes it, as a pick does.
    await page.evaluate(() => document.querySelector('.sp-place-where').click())
    assert.equal(await chooser.count(), 0, 'a click outside closes Change place')
    await page.getByRole('button', { name: 'Change place' }).click()
    await page.getByRole('button', { name: 'Change place' }).click()
    assert.equal(await chooser.count(), 0, 'Change place again closes it')
    await page.getByRole('button', { name: 'Change place' }).click()
    await page.getByLabel('Find a slide').fill('8')
    assert.equal(await chooser.locator('.sp-menu-row').count(), 1, 'typed digits find the slide by its number')
    await page.getByLabel('Find a slide').press('Enter')
    assert.equal(await page.locator('.sp-place-where').innerText(), 'Inserts after slide 8 · ‘Where it does not help’')
    assert.equal(await chooser.count(), 0, 'a pick closes Change place')
    assert.equal(await page.locator('.sp-place-rule').innerText(), 'Adds a new slide after slide 8.', 'a chosen place: always a new slide')
    await page.getByRole('button', { name: 'Change place' }).click()
    await page.getByRole('button', { name: 'At the start of the talk' }).click()
    assert.equal(await page.locator('.sp-place-where').innerText(), 'Inserts at the start of the talk')
    assert.equal(await page.locator('.sp-place-rule').innerText(), 'Adds a new slide at the start of the talk.')
    await page.getByRole('button', { name: 'Follow the cursor' }).click()
    assert.match(await page.locator('.sp-place-where').innerText(), /after slide 7/)
    assert.deepEqual(await inserts(), [], 'choosing a place inserts nothing')
    assert.deepEqual(await calls(), [], 'and changes nothing in the Slide Scratchpad')
    if (shots) await page.screenshot({ path: join(shots, 'scratchpad-one-selected.png') })
  })
  await step('Insert whole slide and Insert visual only ask the workspace; the item stays, marked Inserted · its slide’s title (or that it is gone); twice is allowed', async () => {
    await page.getByRole('button', { name: 'Insert whole slide' }).click()
    await page.waitForFunction(() => window.inserts.length === 1)
    await card('A research loop').locator('.sp-inserted').waitFor()
    assert.equal(await card('A research loop').locator('.sp-inserted').innerText(), 'Inserted · ‘Where it does not help’', 'by title: a number goes stale')
    await page.evaluate(() => { window.undone = true; window.repaint() })
    await page.waitForFunction(() => document.querySelector('.sp-inserted')?.textContent === 'Inserted before · not in the talk now')
    await page.evaluate(() => { window.undone = false; window.repaint() })
    await page.getByRole('button', { name: 'Insert whole slide' }).click()
    await page.waitForFunction(() => window.inserts.length === 2)
    await page.getByRole('button', { name: 'Insert visual only ▾' }).click()
    const chooser = page.getByRole('menu', { name: 'Choose a visual' })
    assert.deepEqual((await chooser.locator('.sp-vlabel').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')), ['LoopPicture', 'loop.htmlPage'])
    await chooser.getByRole('menuitem', { name: /loop\.html/ }).click()
    await page.waitForFunction(() => window.inserts.length === 3)
    assert.deepEqual(await inserts(), [['slide', 'b', null], ['slide', 'b', null], ['visual', 'b', 'assets/loop.html']])
    await card('What is a language model').click()
    assert.equal(await page.getByRole('button', { name: 'Insert visual only' }).isDisabled(), true, 'a slide with no visual')
    await card('diagram').click()
    assert.equal(await page.getByRole('button', { name: 'Insert whole slide' }).isDisabled(), true, 'an agent file is no whole slide')
    assert.equal(await page.locator('.sp-place-rule').innerText(), 'Adds to slide 7 at the cursor.')
    await page.getByRole('button', { name: 'Insert visual only' }).click()
    await page.waitForFunction(() => window.inserts.length === 4)
    assert.deepEqual((await inserts())[3], ['visual', 'd', null])
    assert.deepEqual(await calls(), [], 'inserting changes no status or group')
    await page.evaluate(() => { window.inserts = [] })
  })
  await step('Compare side by side: 2 to 4 ticked, large columns with their own actions, one placement note; only Insert inserts', async () => {
    await page.getByLabel('Select What is a language model').check()
    await page.getByLabel('Select A research loop').check()
    await page.getByLabel('Select research-loop').check()
    await page.getByRole('button', { name: 'Compare side by side' }).click()
    const cols = page.locator('.sp-compare-col')
    assert.equal(await cols.count(), 3)
    assert.match(await page.locator('.sp-compare-top').innerText(), /Side by side · 3 items/)
    assert.equal(await page.locator('.sp-compare .sp-place').count(), 1, 'one shared placement note')
    for (const [i, slide] of [[0, true], [1, true], [2, false]]) {
      const col = cols.nth(i)
      assert.equal(await col.getByRole('button', { name: 'Insert whole slide' }).isDisabled(), !slide)
      assert.equal(await col.getByRole('button', { name: 'Keep for library' }).count(), 1)
      assert.equal(await col.getByRole('button', { name: 'Reject' }).count(), 1)
      assert.equal(await col.getByRole('button', { name: 'Take out of comparison' }).count(), 1)
    }
    assert.match(await cols.nth(0).innerText(), /Slide text: predicts the next word/)
    if (shots) await page.screenshot({ path: join(shots, 'scratchpad-side-by-side.png') })
    await cols.nth(2).getByRole('button', { name: 'Keep for library' }).click()
    await page.waitForFunction(() => window.calls.includes('status:kept:c'))
    assert.equal(await cols.count(), 3, 'deciding one column keeps the comparison')
    assert.match(await cols.nth(2).innerText(), /Kept for library/)
    await cols.nth(2).getByRole('button', { name: 'Move back' }).click()
    await page.waitForFunction(() => window.calls.includes('status:active:c'))
    await cols.nth(0).getByRole('button', { name: 'Take out of comparison' }).click()
    assert.equal(await cols.count(), 2)
    await cols.nth(0).getByRole('button', { name: 'Insert whole slide' }).click()
    await page.waitForFunction(() => window.inserts.length === 1)
    assert.deepEqual(await inserts(), [['slide', 'b', null]], 'Keep, Move back, Take out inserted nothing; Insert did, once')
    await page.getByRole('button', { name: '← Back to the list' }).click()
    assert.equal(await page.locator('.sp-cards').count() > 0, true)
    // Keep in a column clears the ticks, as Keep in the list does; tick five afresh.
    for (const t of ['What is a language model', 'A research loop', 'research-loop', 'diagram', 'gone']) await page.getByLabel(`Select ${t}`).check()
    assert.match(await page.locator('.sp-batchbar').innerText(), /5 selected/)
    assert.equal(await page.getByRole('button', { name: 'Compare side by side' }).isDisabled(), true)
    assert.equal(await page.locator('.sp-why').innerText(), 'Compare side by side takes 2 to 4 items. Untick some to compare.')
    await page.getByRole('button', { name: 'Clear selection' }).click()
    await clear(); await page.evaluate(() => { window.inserts = [] })
  })
  await step('commands: Insert acts on the one selected item, Compare needs 2 to 4 ticked, Change place opens the list', async () => {
    await page.evaluate(() => window.run('scratchpad-insert-slide'))
    assert.deepEqual(await inserts(), [], 'nothing selected, nothing inserted')
    await card('A research loop').click()
    await page.evaluate(() => window.run('scratchpad-insert-slide'))
    await page.waitForFunction(() => window.inserts.length === 1)
    await page.evaluate(() => window.run('scratchpad-insert-visual'))
    assert.equal((await inserts()).length, 1, 'a slide with two visuals asks for the chooser instead')
    await page.evaluate(() => window.run('scratchpad-compare'))
    assert.equal(await page.locator('.sp-compare').count(), 0)
    await page.evaluate(() => window.run('scratchpad-change-place'))
    await page.getByRole('dialog', { name: 'Change place' }).waitFor()
    await page.keyboard.press('Escape')
    assert.equal(await page.getByRole('dialog', { name: 'Change place' }).count(), 0)
    await page.locator('.sp-card', { hasText: 'A research loop' }).click()
    await clear(); await page.evaluate(() => { window.inserts = [] })
  })
  await step('card select, tick boxes, batch bar: Move to group, Keep, Reject', async () => {
    await page.locator('.sp-card', { hasText: 'What is a language model' }).click()
    assert.match(await page.locator('.sp-who').innerText(), /Selected: What is a language model/)
    await page.getByLabel('Select What is a language model').check()
    await page.getByLabel('Select diagram').check()
    assert.match(await page.locator('.sp-batchbar').innerText(), /2 selected/)
    await page.getByRole('button', { name: 'Move to group… ▾' }).click()
    await page.locator('.sp-foot .sp-menu-row', { hasText: 'Opening' }).click()
    assert.deepEqual(await calls(), ['group:g1:a,d'])
    assert.equal(await page.locator('.sp-batchbar').count(), 0, 'selection cleared after the move')
    await clear()
    await page.getByLabel('Select What is a language model').check()
    await page.getByLabel('Select diagram').check()
    await page.getByRole('button', { name: 'Keep for library' }).click()
    assert.deepEqual(await calls(), ['status:kept:a,d'])
    assert.equal(await tabs(), 'All3|Picked slides1|Agent visuals2|Kept3|Rejected1')
    await clear()
    await page.getByLabel('Select research-loop').check()
    await page.getByLabel('Select A research loop').check()
    await page.getByRole('button', { name: 'Reject' }).click()
    assert.deepEqual(await calls(), ['status:rejected:c,b'])
    await clear()
  })
  await step('Kept and Rejected: notes, no tick boxes, Move back', async () => {
    await page.locator('.sp-tabs button', { hasText: 'Kept' }).click()
    assert.match(await page.locator('.sp-note').innerText(), /Move one back/)
    assert.equal(await page.locator('.sp-tick').count(), 0)
    assert.equal(await page.locator('.sp-batch').count(), 0, 'no arrival headings in Kept')
    await page.locator('.sp-card', { hasText: 'photo' }).getByRole('button', { name: 'Move back' }).click()
    assert.deepEqual(await calls(), ['status:active:e'])
    await clear()
  })
  await step('missing file: Remove from Slide Scratchpad takes the state item out', async () => {
    await page.locator('.sp-tabs button', { hasText: 'Agent visuals' }).click()
    await page.getByRole('button', { name: 'Remove from Slide Scratchpad' }).click()
    assert.deepEqual(await calls(), ['remove:m'])
    await clear()
  })
  await step('big preview: a picture shows large; an HTML page runs only on request, in the sandbox main names', async () => {
    await page.locator('.sp-tabs button', { hasText: 'All' }).click()
    await page.locator('.sp-card', { hasText: 'photo' }).dblclick()
    assert.equal(await page.locator('.sp-preview-top h2').innerText(), 'photo')
    assert.equal(await page.locator('.sp-preview-frame').count(), 0)
    await page.getByRole('button', { name: '← Back to the list' }).click()
    await page.locator('.sp-tabs button', { hasText: 'Rejected' }).click()
    await page.locator('.sp-card', { hasText: 'research-loop' }).dblclick()
    assert.equal(await page.locator('.sp-preview-frame').count(), 0, 'nothing runs before Run interactive')
    await page.getByRole('button', { name: 'Run interactive' }).click()
    const frame = page.locator('.sp-preview-frame')
    await frame.waitFor()
    assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts allow-forms')
    assert.equal(await frame.getAttribute('allow'), 'autoplay; fullscreen')
    assert.deepEqual(await calls(), ['html:c'])
    await page.getByRole('button', { name: '← Back to the list' }).click()
    await clear()
  })
  await step('commands act on the selection and say so when there is none', async () => {
    await page.locator('.sp-tabs button', { hasText: 'All' }).click()
    await page.evaluate(() => window.run('scratchpad-keep'))
    assert.deepEqual(await calls(), [], 'nothing selected, nothing changes')
    await page.locator('.sp-card', { hasText: 'photo' }).click()
    await page.evaluate(() => window.run('scratchpad-reject'))
    await page.waitForFunction(() => window.calls.includes('status:rejected:e'))
    await clear()
  })
  await step('dock, float and collapse; the layout is saved and restored', async () => {
    await page.getByRole('button', { name: 'Dock to the right' }).click()
    assert.ok(await page.locator('.sp-panel--docked').count() === 1)
    assert.equal(await page.locator('.sp-panel--docked').evaluate((el) => Math.round(el.getBoundingClientRect().width)), 560)
    if (shots) await page.screenshot({ path: join(shots, 'scratchpad-docked.png') })
    await page.setViewportSize({ width: 1160, height: 900 }) // the installed window: the main area is left with about 600px
    const geometry = await page.evaluate(() => {
      const panelBox = document.querySelector('.sp-panel--docked').getBoundingClientRect()
      const bar = document.querySelector('[data-testid="fake-toolbar"]').getBoundingClientRect()
      const buttons = [...document.querySelectorAll('[data-testid="fake-toolbar"] button')].map((b) => b.getBoundingClientRect())
      const sp = document.querySelector('.toolbar-btn--primary')
      return { panelLeft: panelBox.left, barRight: bar.right, rightmost: Math.max(...buttons.map((r) => r.right)), spHeight: sp.getBoundingClientRect().height, spLine: parseFloat(getComputedStyle(sp).lineHeight) || 20 }
    })
    assert.ok(geometry.barRight <= geometry.panelLeft + 1, 'the toolbar ends where the docked panel begins')
    assert.ok(geometry.rightmost <= geometry.panelLeft, `no toolbar control sits under the docked panel (${geometry.rightmost} vs ${geometry.panelLeft})`)
    assert.ok(geometry.spHeight < geometry.spLine * 2 + 12, 'the Present button stays on one line')
    await page.setViewportSize({ width: 1300, height: 900 })
    await page.getByRole('button', { name: 'Collapse' }).click()
    await page.locator('.sp-pill').waitFor()
    const saved = JSON.parse(await page.evaluate(() => localStorage.getItem('tw-scratchpad-layout-v1')))
    assert.deepEqual([saved.mode, saved.restore], ['collapsed', 'docked'])
    await page.evaluate(() => window.layoutApi.toggle())
    await page.locator('.sp-panel--docked').waitFor()
    await page.getByRole('button', { name: 'Float' }).click()
    // drag by the header, then resize from the corner
    const before = await panel().boundingBox()
    await page.mouse.move(before.x + 120, before.y + 20)
    await page.mouse.down(); await page.mouse.move(before.x + 20, before.y + 60, { steps: 4 }); await page.mouse.up()
    const moved = await panel().boundingBox()
    assert.ok(moved.x < before.x - 50 && moved.y > before.y + 20, `moved from ${before.x},${before.y} to ${moved.x},${moved.y}`)
    const corner = { x: moved.x + moved.width - 6, y: moved.y + moved.height - 6 }
    await page.mouse.move(corner.x, corner.y); await page.mouse.down(); await page.mouse.move(corner.x - 100, corner.y - 100, { steps: 4 }); await page.mouse.up()
    const sized = await panel().boundingBox()
    assert.ok(sized.width < moved.width - 50 && sized.height < moved.height - 50)
    const stored = JSON.parse(await page.evaluate(() => localStorage.getItem('tw-scratchpad-layout-v1')))
    assert.equal(stored.mode, 'float'); assert.equal(stored.box.w, Math.round(sized.width))
  })
  await step('search and newest-first range: tick exactly the visible run, Keep only those cards', async () => {
    await page.evaluate(() => window.selectionFixture())
    await page.locator('.sp-tabs button', { hasText: 'All' }).click()
    const search = page.getByLabel('Search the Slide Scratchpad')
    await search.fill('run')
    assert.deepEqual(await page.locator('.sp-card-title').allInnerTexts(), ['Run newest', 'Run middle', 'Run oldest', 'Run tail'])
    await card('Run newest').click()
    await card('Run oldest').click({ modifiers: ['Shift'] })
    assert.deepEqual(await page.locator('.sp-card:has(input:checked) .sp-card-title').allInnerTexts(), ['Run newest', 'Run middle', 'Run oldest'])
    await page.getByRole('button', { name: 'Keep for library', exact: true }).click()
    assert.deepEqual(await calls(), ['status:kept:new,middle,old'])
    assert.deepEqual(await page.evaluate(() => window.selectionState()), [
      { id: 'old', status: 'kept', group: null }, { id: 'hidden', status: 'active', group: null },
      { id: 'new', status: 'kept', group: null }, { id: 'rejected', status: 'rejected', group: null },
      { id: 'middle', status: 'kept', group: null }, { id: 'tail', status: 'active', group: null }
    ])
    await search.fill('')
  })
  for (const action of ['keep', 'reject', 'group']) {
    await step('a previously ticked hidden card is excluded from ' + action, async () => {
      await page.evaluate(() => window.selectionFixture())
      await page.getByLabel('Select Outside search', { exact: true }).check()
      await page.getByLabel('Select Run newest', { exact: true }).check()
      await page.getByLabel('Search the Slide Scratchpad').fill('run')
      if (action === 'group') {
        await page.getByRole('button', { name: 'Move to group… ▾', exact: true }).click()
        await page.locator('.sp-foot .sp-menu-row', { hasText: 'Opening' }).click()
      } else await page.evaluate(action => window.run('scratchpad-' + action), action)
      await page.waitForFunction(() => window.calls.length > 0)
      assert.deepEqual(await calls(), [action === 'group' ? 'group:g1:new' : 'status:' + (action === 'keep' ? 'kept' : 'rejected') + ':new'])
      assert.deepEqual((await page.evaluate(() => window.selectionState())).find(item => item.id === 'hidden'), { id: 'hidden', status: 'active', group: null })
      await page.getByLabel('Search the Slide Scratchpad').fill('')
    })
  }
  await step('a focused card hidden by search is not a command target', async () => {
    await page.evaluate(() => window.selectionFixture())
    await card('Outside search').click()
    await page.getByLabel('Search the Slide Scratchpad').fill('run')
    await page.evaluate(() => window.run('scratchpad-keep'))
    assert.deepEqual(await calls(), [])
    await page.getByLabel('Search the Slide Scratchpad').fill('')
  })
  await step('empty state: the mockup wording, both starting points work', async () => {
    await page.evaluate(() => window.empty())
    await page.getByRole('heading', { name: 'Nothing in the Slide Scratchpad yet' }).waitFor()
    assert.equal(await page.getByLabel('Search the Slide Scratchpad').count(), 0)
    await page.getByRole('button', { name: 'Show the scratch folder' }).click()
    await page.getByRole('button', { name: 'Open the Slide Browser' }).click()
    assert.deepEqual(await calls(), ['folder', 'browser'])
    if (shots) await page.screenshot({ path: join(shots, 'scratchpad-empty.png') })
  })
  assert.deepEqual(errors, [])
  console.log(`${checks} checks passed`)
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await browser?.close()
  rmSync(scratch, { recursive: true, force: true })
}

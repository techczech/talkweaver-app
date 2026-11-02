// Real renderer, populated fixture, three viewports. Fails on the boxed-path-button/paragraph-fact/row-Open layout.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fixtureSource, FIXTURE_TALKS } from './lib/vault-gallery-redesign-fixture.mjs'
const root = resolve(import.meta.dirname, '..')
const src = resolve(root, process.env.VG_SRC ?? 'src')
const dir = mkdtempSync(join(tmpdir(), 'tw-vg-redesign-'))
// Screenshots stay in this run's temporary folder unless VG_OUT names a place in the evidence folder to keep them.
const out = process.env.VG_OUT ? join(root, 'evidence/vault-gallery/redesign-repairs', process.env.VG_OUT) : join(dir, 'shots')
mkdirSync(out, { recursive: true })
let browser
try {
  await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import Gallery from '${src}/renderer/src/components/vault-gallery/VaultGallery';
    ${fixtureSource}
    function Harness(){const[open,setOpen]=useState(true);return <><textarea aria-label="Editor" defaultValue="Unsaved text"/>{open&&<Gallery revision={1} onClose={()=>setOpen(false)} onOpen={async t=>{window.calls.open.push(t.outlinePath);return !window.refuseOpen}} management={window.managementFixture()}/>}</>}
    createRoot(document.getElementById('root')).render(<Harness/>)` }, bundle: true, outfile: join(dir, 'bundle.js'), platform: 'browser', jsx: 'automatic', loader: { '.css': 'css' } })
  browser = await chromium.launch({ headless: true, ...(process.env.TW_HEADLESS_SHELL ? { executablePath: process.env.TW_HEADLESS_SHELL } : {}) })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.route('http://tw.test/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/bundle.css"></head><body style="margin:0"><div id="root"></div><script src="/bundle.js"></script></body></html>' }))
  await context.route('http://tw.test/bundle.js', route => route.fulfill({ contentType: 'text/javascript', path: join(dir, 'bundle.js') }))
  await context.route('http://tw.test/bundle.css', route => route.fulfill({ contentType: 'text/css', path: join(dir, 'bundle.css') }))
  const page = await context.newPage()
  const errors = []; page.on('pageerror', e => errors.push(String(e)))
  const load = async () => { await page.goto('http://tw.test/'); await page.getByRole('dialog', { name: 'Vault Gallery' }).waitFor() }
  const shot = name => page.screenshot({ path: join(out, name + '.png') })
  // Table alignment and overflow: header cells share the row cells' left edges; nothing overflows its cell or the pane.
  const alignment = () => page.evaluate(() => {
    const grid = document.querySelector('[role="grid"]'), heads = [...grid.querySelectorAll('[role="columnheader"]')].filter(h => h.getClientRects().length)
    const rows = [...grid.querySelectorAll('.vg-row')]
    const problems = []
    for (const row of rows) {
      const cells = [...row.querySelectorAll('[role="gridcell"]')].filter(c => c.getClientRects().length)
      if (cells.length !== heads.length) { problems.push('cell count ' + cells.length + ' vs ' + heads.length); continue }
      cells.forEach((c, i) => { if (Math.abs(c.getBoundingClientRect().left - heads[i].getBoundingClientRect().left) > 1) problems.push(`column ${i} misaligned`) })
      if (row.scrollWidth > row.clientWidth + 1) problems.push('row overflows')
    }
    return { problems: [...new Set(problems)], rowHeight: rows[0]?.getBoundingClientRect().height, scrollX: document.querySelector('.vault-gallery').scrollWidth - document.querySelector('.vault-gallery').clientWidth, rows: rows.length }
  })
  const g = () => page.getByRole('dialog', { name: 'Vault Gallery' })
  const bar = () => g().getByRole('toolbar', { name: 'Actions' })
  const grid = () => g().getByRole('grid', { name: 'Talks and folders' }), grid0 = grid

  // ---- default: List first, remembered view empty; All vaults overview is where the app opens
  await load()
  assert.equal(await page.evaluate(() => localStorage.getItem('tw.vaultGallery.view')), null)
  await shot('overview-1440')
  assert.match(await g().innerText(), /All vaults/)
  assert.equal(await g().getByRole('grid', { name: 'Vaults' }).getByRole('row').count(), 5, 'header + four vaults')
  for (const status of ['Open', 'Closed', 'Not connected']) assert.ok(await g().getByRole('gridcell', { name: status, exact: true }).count() >= 1, status)
  assert.equal(await g().getByRole('button', { name: /^Preview title slide/ }).count(), 0)

  for (const [w, h, name] of [[1160, 740, '1160'], [1440, 1000, '1440'], [800, 600, '800']]) {
    await page.setViewportSize({ width: w, height: h }); await load()
    if (w === 800) { assert.equal(await g().getByRole('tree').count(), 0, 'folders are a drawer at the minimum size') }
    await g().getByRole('grid', { name: 'Vaults' }).getByRole('row', { name: 'dominiks-presentations-library' }).dblclick()
    const grid = g().getByRole('grid', { name: 'Talks and folders' }); await grid.waitFor()
    // direct folder contents: 10 top-level folders (+ nested external-workshops stays inside) and 2 root talks, nothing recursive
    const names = await grid.locator('.vg-row .vg-c-name .vg-tx').allTextContents()
    assert.equal(names.length, 16, '14 top-level folders and 2 root talks, nothing recursive')
    assert.deepEqual(names.slice(0, 3), ['agents-2026', 'agents-presentations', 'AI Agent Workshops'])
    assert.ok(names.includes('Getting started with TalkWeaver') && names.includes('Scratch talk for trying layouts'))
    assert.ok(!names.includes('AI for research methods'), 'deep talks are not listed at the root')
    // a real file list: no per-row buttons, no Open column, no path-as-button
    assert.equal(await grid.locator('button').evaluateAll(b => b.filter(x => !x.closest('[role="columnheader"]')).length), 0, 'rows carry no buttons')
    assert.equal(await g().getByRole('button', { name: /^Open talk$/ }).count(), 0, 'no Open talk until a talk is selected')
    const a = await alignment(); assert.deepEqual(a.problems, [], `aligned at ${w}`); assert.equal(a.rowHeight, 34); assert.ok(a.scrollX <= 0, 'no horizontal page overflow')
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.vg-row')).display), 'grid')
    if (w !== 800) {
      assert.ok(await g().getByRole('tree').count() === 1)
      assert.match(await g().getByRole('tree').innerText(), /All talks/)
      assert.equal(await g().getByRole('columnheader', { name: 'Handouts' }).count(), 1)
    }
    await shot(`list-root-${name}`)
  }

  // ---- 1160: folders, selection, All talks, details
  await page.setViewportSize({ width: 1160, height: 740 }); await load()
  await page.waitForFunction(() => window.calls.facts.length >= 4)
  const mark = await page.evaluate(() => window.calls.facts.length)
  await g().getByRole('grid', { name: 'Vaults' }).getByRole('row', { name: 'dominiks-presentations-library' }).dblclick()
  await grid().waitFor()
  assert.equal(await page.evaluate(() => window.calls.inventory.every(r => r.recursive === false)), true, 'entry lists directories only')
  assert.equal(await page.evaluate(() => window.calls.listTalks), 0, 'no listTalks on entry')
  await page.waitForFunction(m => window.calls.facts.length > m, mark)
  assert.equal(await page.evaluate(m => window.calls.facts.slice(m).every(f => f[2] === false), mark), true, 'List asks for facts, not title slides')
  // folder selected: contextual toolbar, no talk actions; rename/bin offered for a recognised category folder
  await grid().getByRole('row', { name: 'agents-presentations' }).click()
  for (const b of ['Open folder', 'Rename', 'Move to Bin']) await bar().getByRole('button', { name: b, exact: true }).waitFor()
  assert.equal(await bar().getByRole('button', { name: 'Duplicate' }).count(), 0, 'no folder duplicate')
  assert.equal(await bar().getByRole('button', { name: /^Move$/ }).count(), 0, 'no folder move')
  await grid().getByRole('row', { name: 'agents-presentations' }).dblclick()
  assert.match(await g().getByRole('navigation', { name: 'Location' }).innerText(), /dominiks-presentations-library\s*agents-presentations/)
  assert.equal(await grid().locator('.vg-row').count(), 7)
  // talk selected -> toolbar in place; Details optional and remembered
  await grid().getByRole('row', { name: /^Context engineering/ }).click()
  for (const b of ['Open talk', 'Handouts', 'Rename', 'Move to Bin']) await bar().getByRole('button', { name: b, exact: true }).waitFor()
  assert.equal(await g().getByRole('complementary', { name: 'Details' }).count(), 0, 'Details closed by default')
  await bar().getByRole('button', { name: 'Details', exact: true }).click()
  const details = g().getByRole('complementary', { name: 'Details' }); await details.waitFor()
  await details.getByText('Images used').waitFor()
  await page.waitForFunction(() => document.querySelector('[aria-label="Details"] img'))
  assert.equal(await page.evaluate(() => localStorage.getItem('tw.vaultGallery.details')), 'open')
  assert.match(await details.innerText(), /Location\s+dominiks-presentations-library \/ agents-presentations \/ context-engineering/)
  assert.ok(await details.getByRole('button', { name: 'Copy location' }).count() === 1)
  const a2 = await alignment(); assert.deepEqual(a2.problems, []); assert.ok(a2.scrollX <= 0)
  await shot('list-details-1160')
  await bar().getByRole('button', { name: 'Details', exact: true }).click()
  assert.equal(await page.evaluate(() => localStorage.getItem('tw.vaultGallery.details')), 'closed')
  // New talk and New folder create where you are: the folder you are in, the vault root from All talks
  await grid().getByRole('row', { name: /^Agents as collaborators/ }).click(); await page.keyboard.press('Escape')
  assert.equal(await grid().locator('.vg-row.sel').count(), 0, 'Escape clears the selection first')
  assert.equal(await g().count(), 1, 'and the gallery stays open')
  await bar().getByRole('button', { name: 'New talk', exact: true }).click()
  assert.deepEqual(await page.evaluate(() => window.calls.newTalk), ['agents-presentations', 'a'], 'New talk targets the current folder')
  // keyboard: arrows move selection, Enter opens, Escape clears then closes
  await grid().getByRole('row', { name: /^Agent architecture/ }).focus()
  await page.keyboard.press('ArrowDown'); assert.equal(await grid().locator('.vg-row.sel').getAttribute('aria-label').then(x => x.startsWith('Agents as collaborators')), true)
  await page.keyboard.press('Enter'); await page.waitForFunction(() => window.calls.open.length === 1)
  await page.evaluate(() => { window.refuseOpen = false })
  // ---- All talks: separate flat scope with Location
  await load()
  await g().getByRole('grid', { name: 'Vaults' }).getByRole('row', { name: 'dominiks-presentations-library' }).dblclick()
  await g().getByRole('treeitem', { name: /All talks/ }).click()
  await bar().getByRole('button', { name: 'New talk', exact: true }).click()
  assert.deepEqual(await page.evaluate(() => window.calls.newTalk), ['', 'a'], 'New talk from All talks targets the vault root')
  assert.equal(await grid().locator('.vg-row').count(), FIXTURE_TALKS)
  await g().getByRole('columnheader', { name: 'Location' }).waitFor()
  const a3 = await alignment(); assert.deepEqual(a3.problems, []); assert.ok(a3.scrollX <= 0)
  const deepLocations = await grid().locator('.vg-c-loc').allTextContents()
  assert.ok(deepLocations.some(l => l.includes('…')), 'deep locations are middle-shortened')
  assert.equal(new Set(await grid().locator('.vg-row').evaluateAll(r => r.map(x => x.getAttribute('data-row-key')))).size, FIXTURE_TALKS, 'duplicate leaves stay distinct rows')
  await shot('all-talks-1160')
  // sort by Contents (slides): the fixture leaves some talks' facts unavailable; unknown rows come last in both directions, known ones in order
  await page.waitForFunction(() => window.calls.facts.length >= 15)
  for (const dir of ['ascending', 'descending']) {
    await g().getByRole('columnheader', { name: 'Slides' }).getByRole('button').click()
    assert.equal(await g().getByRole('columnheader', { name: 'Slides' }).getAttribute('aria-sort'), dir)
    const cells = (await grid().locator('.vg-row .vg-c-contents').allInnerTexts()).map(t => t.trim())
    const firstUnknown = cells.findIndex(t => !/^\d+$/.test(t))
    assert.ok(firstUnknown > 0 && cells.slice(firstUnknown).every(t => !/^\d+$/.test(t)), `unknown slide counts sort last (${dir})`)
    const known = cells.slice(0, firstUnknown).map(Number)
    assert.deepEqual(known, [...known].sort((a, b) => dir === 'ascending' ? a - b : b - a), `known slide counts ordered (${dir})`)
  }
  // ---- Gallery view, remembered across reload
  await g().getByRole('button', { name: 'Gallery', exact: true }).click()
  await g().getByRole('listbox', { name: 'Talks and folders' }).waitFor()
  assert.equal(await page.evaluate(() => localStorage.getItem('tw.vaultGallery.view')), 'Gallery')
  await page.waitForFunction(() => document.querySelectorAll('.vg-thumb img').length > 0)
  await shot('gallery-all-1160')
  await load()
  await g().getByRole('grid', { name: 'Vaults' }).getByRole('row', { name: 'dominiks-presentations-library' }).dblclick()
  await g().getByRole('listbox', { name: 'Talks and folders' }).waitFor()
  await shot('gallery-root-1160')
  await g().getByRole('button', { name: 'List', exact: true }).click()
  // ---- search recursion
  await g().getByRole('searchbox').or(g().getByPlaceholder('Search this vault')).fill('research methods')
  await page.waitForFunction(() => document.querySelectorAll('.vg-row').length === 2)
  await g().getByRole('button', { name: 'Clear search' }).click()
  // ---- closed / unavailable vaults
  await g().getByRole('treeitem', { name: /All vaults/ }).click()
  await g().getByRole('grid', { name: 'Vaults' }).getByRole('row', { name: 'Archive drive' }).click()
  await g().getByRole('button', { name: 'Check again' }).waitFor()
  assert.equal(await g().getByRole('button', { name: 'Open vault' }).count(), 0)
  await g().getByRole('treeitem', { name: /All vaults/ }).click(); await page.keyboard.press('Escape')
  await g().waitFor({ state: 'detached' })
  assert.equal(errors.length, 0, errors.join('\n'))
  console.log('PASS populated redesign: direct contents, normal list, contextual toolbar, All talks Location, Gallery, remembered view/details, alignment at 1160/1440/800')
} finally { await browser?.close(); rmSync(dir, { recursive: true, force: true }) }

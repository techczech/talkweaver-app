// Storage behaviour of the vault browser, through the real gallery: directory listing on entry, explicit
// measurement, whole-root confirmation, Stop with late-result discard, inspect-only entries behind the toggle.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fixtureSource } from './lib/vault-gallery-redesign-fixture.mjs'
const root = resolve(import.meta.dirname, '..')
const home = join(root, 'evidence/vault-gallery/redesign-implementation'); mkdirSync(home, { recursive: true })
const dir = mkdtempSync(join(home, '.storage-')); let browser
try {
  await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `import React from 'react';import {createRoot} from 'react-dom/client';import Gallery from './src/renderer/src/components/vault-gallery/VaultGallery';${fixtureSource}
    window.inventoryEntries=r=>r.relativePath===''?[{relativePath:'empty',kind:'folder',logical:null,allocated:null},{relativePath:'file.txt',kind:'file',logical:13,allocated:4096},{relativePath:'assets',kind:'assets',logical:null,allocated:null},{relativePath:'link',kind:'link',logical:null,allocated:null,reason:'Links are not followed'}]:[]
    createRoot(document.getElementById('root')).render(<Gallery revision={1} onClose={()=>{}} onOpen={async()=>false} management={window.managementFixture()}/>)` }, bundle: true, outfile: join(dir, 'bundle.js'), platform: 'browser', jsx: 'automatic' })
  browser = await chromium.launch({ headless: true, ...(process.env.TW_HEADLESS_SHELL ? { executablePath: process.env.TW_HEADLESS_SHELL } : {}) })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); const errors = []; page.on('pageerror', e => errors.push(String(e)))
  await page.setContent('<div id="root"></div>'); await page.addScriptTag({ path: join(dir, 'bundle.js') }); await page.addStyleTag({ path: join(dir, 'bundle.css') })
  const g = page.getByRole('dialog', { name: 'Vault Gallery' }), grid = g.getByRole('grid', { name: 'Talks and folders' })
  await g.getByRole('grid', { name: 'Vaults' }).getByRole('row', { name: 'dominiks-presentations-library' }).dblclick()
  await grid.waitFor()
  const calls = () => page.evaluate(() => window.calls.inventory)
  assert.deepEqual((await calls()).map(c => [c.relativePath, c.recursive, c.confirmedRoot]), [['', false, false]], 'entry lists the directory only')
  // a folder that exists on disk shows without the toggle; files, assets and links stay hidden until it is on
  await grid.getByRole('row', { name: 'empty' }).waitFor()
  assert.equal(await grid.getByRole('row', { name: 'file.txt' }).count(), 0)
  await g.getByRole('button', { name: 'Show assets and system folders' }).click()
  for (const n of ['file.txt', 'assets', 'link']) await grid.getByRole('row', { name: n }).waitFor()
  await grid.getByRole('row', { name: 'file.txt' }).click()
  await g.getByRole('toolbar').getByRole('button', { name: 'Details' }).click()
  assert.match(await g.getByRole('complementary', { name: 'Details' }).innerText(), /Size on disk\s+4\.1 KB/)
  assert.equal(await g.getByRole('toolbar').getByRole('button', { name: /^(Rename|Move to Bin|Duplicate|Move)$/ }).count(), 0, 'files offer no management action')
  await grid.getByRole('row', { name: 'link' }).click()
  assert.match(await g.getByRole('complementary', { name: 'Details' }).innerText(), /Links are not followed/)
  await g.getByRole('toolbar').getByRole('button', { name: 'Details' }).click()
  // search at the root never scans the root
  const before = (await calls()).length
  await page.getByPlaceholder('Search this vault').fill('needle')
  await g.getByRole('button', { name: 'Search whole vault' }).waitFor()
  assert.equal((await calls()).length, before, 'typing at root starts no scan')
  await page.evaluate(() => { window.deferRecursive = true })
  await g.getByRole('button', { name: 'Search whole vault' }).click()
  await g.getByRole('group', { name: 'Confirm whole-vault measurement' }).waitFor()
  assert.equal((await calls()).length, before, 'confirmation comes first')
  await g.getByRole('button', { name: 'Measure whole vault' }).click()
  assert.deepEqual((await calls()).at(-1), { ...(await calls()).at(-1), relativePath: '', recursive: true, confirmedRoot: true })
  await g.getByRole('button', { name: 'Stop', exact: true }).waitFor()
  await g.getByRole('button', { name: 'Stop', exact: true }).click()
  await page.evaluate(() => window.release())
  await page.waitForFunction(() => document.querySelector('.vg-sizestatus')?.textContent?.includes('Stopped'))
  assert.ok((await page.evaluate(() => window.calls.cancel2.length)) >= 1, 'Stop cancels the main-process scan')
  // explicit measure of a folder; Refresh re-reads the cached catalogue and re-lists non-recursively, and never asks the host
  await g.getByRole('button', { name: 'Clear search' }).click()
  await grid.getByRole('row', { name: 'empty' }).dblclick()
  await g.getByRole('button', { name: 'Measure this folder' }).click()
  assert.deepEqual((await calls()).at(-1).relativePath + ':' + (await calls()).at(-1).recursive, 'empty:true')
  await page.evaluate(() => window.release())
  const listed = (await calls()).length
  await g.getByRole('button', { name: 'Refresh' }).click()
  await page.waitForFunction(n => window.calls.inventory.length > n, listed)
  assert.equal((await calls()).at(-1).recursive, false)
  assert.deepEqual(await page.evaluate(() => [window.calls.refresh ?? 0, window.calls.listTalks]), [0, 0], 'Refresh is not a host listing')
  assert.equal(errors.length, 0, errors.join('\n'))
  console.log('PASS directory listing on entry, inspect-only entries behind the toggle, no root scan from typing, whole-root confirmation, Stop and late-result discard, folder measure, Refresh without a host listing')
} finally { await browser?.close(); rmSync(dir, { recursive: true, force: true }) }

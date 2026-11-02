// Captures the real renderer on the populated fixture at each approved frame's viewport (2x), for direct comparison.
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fixtureSource } from './lib/vault-gallery-redesign-fixture.mjs'
const root = resolve(import.meta.dirname, '..')
const out = join(root, process.env.VG_FRAMES_OUT ?? 'evidence/vault-gallery/redesign-implementation/actual-frames'); mkdirSync(out, { recursive: true })
const dir = mkdtempSync(join(root, 'evidence/vault-gallery/redesign-implementation/.cap-')); let browser
try {
  await build({ stdin: { resolveDir: root, loader: 'tsx', contents: `import React from 'react';import {createRoot} from 'react-dom/client';import Gallery from './src/renderer/src/components/vault-gallery/VaultGallery';${fixtureSource}
    createRoot(document.getElementById('root')).render(<Gallery revision={1} onClose={()=>{}} onOpen={async()=>false} management={window.managementFixture()}/>)` }, bundle: true, outfile: join(dir, 'bundle.js'), platform: 'browser', jsx: 'automatic' })
  browser = await chromium.launch({ headless: true, ...(process.env.TW_HEADLESS_SHELL ? { executablePath: process.env.TW_HEADLESS_SHELL } : {}) })
  const shoot = async (id, w, h, { view = 'List', details = false } = {}, steps) => {
    const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 })
    await context.addInitScript(([v, d]) => { localStorage.setItem('tw.vaultGallery.view', v); localStorage.setItem('tw.vaultGallery.details', d ? 'open' : 'closed') }, [view, details])
    await context.route('http://tw.test/**', r => { const u = r.request().url(); r.fulfill(u.endsWith('bundle.js') ? { contentType: 'text/javascript', path: join(dir, 'bundle.js') } : u.endsWith('bundle.css') ? { contentType: 'text/css', path: join(dir, 'bundle.css') } : { contentType: 'text/html', body: '<!doctype html><link rel="stylesheet" href="/bundle.css"><body style="margin:0"><div id="root"></div><script src="/bundle.js"></script>' }) })
    const page = await context.newPage(); await page.goto('http://tw.test/')
    const g = page.getByRole('dialog', { name: 'Vault Gallery' }); await g.waitFor()
    await steps(page, g)
    await page.mouse.move(w - 5, h - 5); await page.waitForTimeout(500)
    await page.screenshot({ path: join(out, id + '.png') }); await context.close()
  }
  const vault = async (page, g) => { await g.getByRole('grid', { name: 'Vaults' }).getByRole('row', { name: 'dominiks-presentations-library' }).dblclick(); await g.getByRole('grid', { name: 'Talks and folders' }).or(g.getByRole('listbox', { name: 'Talks and folders' })).waitFor() }
  const tree = (g, re) => g.getByRole('tree').getByRole('treeitem', { name: re }).click()
  const folderSel = async (page, g) => { await vault(page, g); await tree(g, /^agents-presentations \d/) }
  const folderNarrow = async (page, g) => { await vault(page, g); await g.getByRole('row', { name: 'agents-presentations' }).dblclick() }
  const pickNarrow = async (page, g) => { await folderNarrow(page, g); await g.getByRole('row', { name: /^Context engineering/ }).click() }
  const pick = async (page, g) => { await folderSel(page, g); await g.getByRole('row', { name: /^Context engineering/ }).or(g.getByRole('option', { name: /^Context engineering/ })).click() }
  for (const [w, h, s] of [[1160, 740, '1160'], [1440, 1000, '1440']]) {
    await shoot(`a0${s === '1160' ? 1 : 2}-list-root-${s}`, w, h, {}, vault)
    await shoot(`a0${s === '1160' ? 3 : 4}-list-folder-talk-details-${s}`, w, h, { details: true }, pick)
    await shoot(`a0${s === '1160' ? 6 : 7}-list-all-talks-${s}`, w, h, {}, async (p, g) => { await vault(p, g); await tree(g, /^All talks/) })
  }
  const covers = p => p.waitForFunction(() => document.querySelectorAll('.vg-thumb img').length >= 3)
  await shoot('a08-gallery-folder-1160', 1160, 740, { view: 'Gallery' }, async (p, g) => { await folderSel(p, g); await covers(p) })
  await shoot('a09-gallery-folder-talk-details-1160', 1160, 740, { view: 'Gallery', details: true }, async (p, g) => { await pick(p, g); await covers(p) })
  await shoot('a10-gallery-vault-root-1440', 1440, 1000, { view: 'Gallery' }, async (p, g) => { await vault(p, g); await covers(p) })
  await shoot('a11-gallery-folder-talk-details-1440', 1440, 1000, { view: 'Gallery', details: true }, async (p, g) => { await pick(p, g); await covers(p) })
  await shoot('a12-overview-1160', 1160, 740, {}, async (p, g) => { await covers(p) })
  await shoot('a13-overview-details-1440', 1440, 1000, { details: true }, async (p, g) => { await covers(p) })
  await shoot('a14-narrow-list-800', 800, 600, {}, folderNarrow)
  await shoot('a15-narrow-details-drawer-800', 800, 600, {}, async (p, g) => { await pickNarrow(p, g); await g.getByRole('toolbar').getByRole('button', { name: 'Details' }).click(); await p.waitForFunction(() => document.querySelector('.vg-drawer.right img')) })
  await shoot('a16-narrow-folders-drawer-800', 800, 600, {}, async (p, g) => { await folderNarrow(p, g); await g.getByRole('button', { name: 'Folders', exact: true }).click(); await g.getByRole('tree').waitFor() })
  console.log('captured')
} finally { await browser?.close(); rmSync(dir, { recursive: true, force: true }) }

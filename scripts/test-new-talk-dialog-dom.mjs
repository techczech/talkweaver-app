// New talk dialog: a title that names a protected folder (Assets, Research, Bundle, Dist) keeps its title and gets a safe folder name;
// a refused creation (null from main) stays in the dialog with a message instead of closing it; the created talk's own identity is the one used.
// VG_SRC (relative to the checkout) points the same test at another source tree to prove it fails there.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const repo = resolve(import.meta.dirname, '..'), src = resolve(repo, process.env.VG_SRC ?? 'src')
const dir = mkdtempSync(join(tmpdir(), 'tw-vg-new-talk-'))
const harness = `
import React from 'react';import {createRoot} from 'react-dom/client';import NewTalkDialog from '${src}/renderer/src/components/NewTalkDialog';
import * as dialog from '${src}/renderer/src/components/NewTalkDialog';
const calls=window.calls={create:[],created:[],closed:0};window.ctl={result:null};window.dialog=dialog;
window.tw={vault:{createTalk:async o=>{calls.create.push(o);return window.ctl.result}}};
createRoot(document.getElementById('root')).render(<NewTalkDialog vaultRoot="/fixture/library" vaultId="a" folders={['Work']} defaultTopic="" onCreated={t=>calls.created.push(t)} onClose={()=>{calls.closed++}}/>)`
let browser
const open = async () => {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } })
  await context.route('http://tw.test/**', r => r.fulfill(r.request().url().endsWith('bundle.js') ? { contentType: 'text/javascript', path: join(dir, 'bundle.js') } : { contentType: 'text/html', body: '<!doctype html><body><div id="root"></div><script src="/bundle.js"></script>' }))
  const page = await context.newPage(); await page.goto('http://tw.test/'); await page.getByLabel('Talk title').waitFor()
  return { page, context }
}
const failures = []
const check = async (name, fn) => { try { await fn(); console.log('HOLD', name) } catch (e) { failures.push(name); console.log('FAIL', name, '-', String(e.message).split('\n')[0]) } }
try {
  await build({ stdin: { resolveDir: repo, loader: 'tsx', contents: harness }, bundle: true, outfile: join(dir, 'bundle.js'), platform: 'browser', jsx: 'automatic', logLevel: 'error' })
  browser = await chromium.launch({ headless: true, ...(process.env.TW_HEADLESS_SHELL ? { executablePath: process.env.TW_HEADLESS_SHELL } : {}) })
  const slugOf = async (title) => { const { page, context } = await open(); await page.getByLabel('Talk title').fill(title); const slug = await page.locator('code').innerText(); await page.getByRole('button', { name: /^Create/ }).click(); await page.waitForTimeout(150); const sent = await page.evaluate(() => window.calls.create.at(-1)); await context.close(); return { slug, sent } }
  for (const [title, slug] of [['Assets', 'assets-talk'], ['Research', 'research-talk'], ['Bundle', 'bundle-talk'], ['Dist', 'dist-talk'], ['assets', 'assets-talk'], ['Assets review', 'assets-review'], ['Research methods', 'research-methods'], ['Bundles', 'bundles'], ['Distinction', 'distinction'], ['My talk', 'my-talk']]) {
    await check(`slug for “${title}” is ${slug}, the title stays`, async () => { const r = await slugOf(title); assert.equal(r.slug, slug, 'preview'); assert.equal(r.sent.slug, slug, 'slug sent'); assert.equal(r.sent.title, title, 'title kept as typed') })
  }
  await check('a refusal from main stays in the dialog with a message', async () => {
    const { page, context } = await open()
    try {
      await page.getByLabel('Talk title').fill('Taken'); await page.getByRole('button', { name: /^Create/ }).click(); await page.waitForTimeout(200)
      const alert = await page.getByRole('alert').innerText().catch(() => null)
      assert.ok(alert && /could not be created/i.test(alert), `a refused creation says so (${alert})`)
      assert.equal(await page.evaluate(() => window.calls.created.length), 0, 'no talk is reported created'); assert.equal(await page.getByLabel('Talk title').count(), 1, 'the dialog stays')
      assert.equal(await page.getByRole('button', { name: /^Create/ }).isEnabled(), true, 'and can be submitted again')
    } finally { await context.close() }
  })
  await check('the created talk is reported as main returned it, and the vault is added only when it is missing', async () => {
    const ok = await open()
    try {
      await ok.page.evaluate(() => { window.ctl.result = { title: 'Taken', slug: 'taken', path: '/x', outlinePath: '/x/o.md', vaultId: 'b' } }); await ok.page.getByLabel('Talk title').fill('Taken'); await ok.page.getByRole('button', { name: /^Create/ }).click(); await ok.page.waitForTimeout(150)
      const created = await ok.page.evaluate(() => window.calls.created); assert.equal(created.length, 1); assert.equal(created[0].vaultId, 'b')
      const merged = await ok.page.evaluate(() => [window.dialog.createdTalk({ vaultId: 'b', title: 't' }, 'a').vaultId, window.dialog.createdTalk({ title: 't' }, 'a').vaultId])
      assert.deepEqual(merged, ['b', 'a'])
    } finally { await ok.context.close() }
  })
  if (failures.length) { console.log(`${failures.length} checks failed`); process.exitCode = 1 } else console.log('new talk dialog: all checks passed')
} finally { await browser?.close(); rmSync(dir, { recursive: true, force: true }) }

// Shared browser harness for the vault browser repair tests: one bundle of the real renderer, one session per scenario.
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { harnessSource } from './vault-gallery-repair-fixture.mjs'
const root = resolve(import.meta.dirname, '../..')
/** VG_SRC (relative to the checkout) points the same test at another source tree to prove it fails there. */
export async function startHarness() {
  const home = join(root, 'evidence/vault-gallery/redesign-repairs'); mkdirSync(home, { recursive: true })
  const dir = mkdtempSync(join(home, '.dom-'))
  const src = resolve(root, process.env.VG_SRC ?? 'src')
  await build({ stdin: { resolveDir: root, loader: 'tsx', contents: harnessSource(src) }, bundle: true, outfile: join(dir, 'bundle.js'), platform: 'browser', jsx: 'automatic', logLevel: 'error' })
  const browser = await chromium.launch({ headless: true, ...(process.env.TW_HEADLESS_SHELL ? { executablePath: process.env.TW_HEADLESS_SHELL } : {}) })
  const html = '<!doctype html><link rel="stylesheet" href="/bundle.css"><body style="margin:0"><div id="root"></div><script src="/bundle.js"></script>'
  const open = async ({ w = 1160, h = 740, init, query = '' } = {}) => {
    const context = await browser.newContext({ viewport: { width: w, height: h } })
    if (init) await context.addInitScript(init)
    await context.route('http://tw.test/**', r => { const u = r.request().url(); r.fulfill(u.endsWith('bundle.js') ? { contentType: 'text/javascript', path: join(dir, 'bundle.js') } : u.endsWith('bundle.css') ? { contentType: 'text/css', path: join(dir, 'bundle.css') } : { contentType: 'text/html', body: html }) })
    const page = await context.newPage(); const errors = []; page.on('pageerror', e => errors.push(String(e)))
    await page.goto('http://tw.test/'); const g = page.getByRole('dialog', { name: 'Vault Gallery' }); await g.waitFor()
    const s = {
      page, g, errors, grid: g.getByRole('grid', { name: 'Talks and folders' }), bar: g.getByRole('toolbar', { name: 'Actions' }), close: () => context.close(),
      settle: () => page.waitForTimeout(150),
      calls: (f = 'c=>c') => page.evaluate(`(${f})(window.calls)`),
      ctl: (f, arg) => page.evaluate(({ f, arg }) => new Function('ctl', 'calls', 'arg', f)(window.ctl, window.calls, arg), { f, arg }),
      enter: async (vault = 'Library') => { await g.getByRole('grid', { name: 'Vaults' }).getByRole('row', { name: vault, exact: true }).dblclick(); await s.grid.waitFor() },
      tree: re => g.getByRole('tree').getByRole('treeitem', { name: re }).click(),
      row: name => s.grid.getByRole('row', { name, exact: true }),
      rows: async name => s.row(name).count(),
      text: () => page.locator('body').innerText(),
      lastInv: () => s.calls('c=>c.inv.at(-1)'),
      tree0: t => s.ctl('ctl.tree=arg', t)
    }
    return s
  }
  return { open, close: async () => { await browser.close(); rmSync(dir, { recursive: true, force: true }) } }
}
export const DISK = {
  Work: { kind: 'folder' }, Empty: { kind: 'folder' }, 'file.txt': { kind: 'file', logical: 13, allocated: 4096 }, assets: { kind: 'assets' }, link: { kind: 'link', reason: 'Links are not followed' }, _PRESENTATIONS: { kind: 'folder' },
  'Work/disk-only': { kind: 'folder' }, 'Work/file.txt': { kind: 'file', logical: 13, allocated: 4096 }, 'Work/deep': { kind: 'folder' }, 'Work/deep/needle.txt': { kind: 'file', logical: 7, allocated: 4096 }
}
export const emitProgress = (s, over) => s.page.evaluate(over => { const r = window.calls.inv.at(-1); window.ctl.progress({ ...r, rootIdentity: 'fx', checkedAt: 'x', state: 'running', entries: [], counted: 64, unreadable: 0, excluded: 0, truncated: false, logicalBytes: null, allocatedBytes: null, allocationUnknown: 0, ...over }) }, over)

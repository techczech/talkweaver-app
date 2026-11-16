// 0.45, set-up folder: Settings › Set-up folder rendered with the Settings window's own styles (Playwright's
// bundled Chromium, 760 px wide, as the Settings window opens). What it shows of the rules that keep text off
// the folder and a batch's way back: a setting whose text stays on this Mac is named with why; a Mac that cannot
// identify itself says it keeps no file there; a value that could not be put back is named, its batch stays
// listed with Undo; nothing overlaps or leaves the page. Screenshots go to artefacts/setup-folder/ (ignored).
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = resolve(import.meta.dirname, '..'), scratch = mkdtempSync(join(tmpdir(), 'tw-setup-folder-dom-'))
const shots = join(root, 'artefacts', 'setup-folder'); mkdirSync(shots, { recursive: true })
let browser, checks = 0
const test = async (name, fn) => { await fn(); checks++; console.log('PASS ' + name) }

const HELD_AUTHOR = 'Author stays on this Mac and is not changed from the folder: it contains characters that are not sent to the set-up folder.'
const HELD_LOGO = 'Title-slide logo stays on this Mac and is not changed from the folder: it is not a registered logo name (a logo file or address stays on this Mac).'
const READ_ONLY = 'This Mac cannot keep its own file in the set-up folder (it could not identify itself); it still takes changes from your other Macs.'
const STUCK = 'Changes from MacBook Air were being applied when TalkWeaver stopped part-way, and Talks: Author could not be put back. Nothing more is taken from the folder until they are; Undo tries again.'
const NOT_PUT_BACK = 'Talks: Author could not be put back. The change stays listed; Undo tries again.'
const at = Date.UTC(2026, 10, 16, 9, 30)
const STATUS = {
  chosen: '/Users/someone/Library/Mobile Documents/com~apple~CloudDocs', folder: '/Users/someone/Library/Mobile Documents/com~apple~CloudDocs/TalkWeaver set-up', state: 'joined', problem: null,
  thisMac: { name: 'Mac mini', file: 'mac-0f8fad5b-d9cb-469f-a165-70867728950e.json' },
  macs: [{ macId: '0f8fad5b-d9cb-469f-a165-70867728950e', name: 'Mac mini', appVersion: '0.45.0', lastActive: 0, thisMac: true }, { macId: '0f8fad5b-d9cb-469f-a165-70867728950e', name: 'MacBook Air', appVersion: '0.45.0', lastActive: at, thisMac: false }],
  lastRead: at, skipped: [], preview: null,
  history: [
    { id: 'stuck-1', macName: 'MacBook Air', at, rows: [{ label: 'Talks: Author', from: 'Before', to: 'After' }, { label: 'Talks: Badge colour', from: '#112233', to: '#aabbcc' }], undone: false, undoable: true, unfinished: true },
    { id: 'done-1', macName: 'MacBook Air', at: at - 3600_000, rows: [{ label: 'Clock turns amber', from: '5 min before the end', to: '9 min before the end' }], undone: false, undoable: true }
  ],
  suggestions: [],
  notices: [
    { kind: 'read-only', text: READ_ONLY },
    { kind: 'not-restored', text: STUCK },
    { kind: 'clock', text: 'MacBook Air’s clock and this Mac’s do not agree: its file has times about 1 day ahead of this Mac’s clock. One of the two clocks is wrong. Changes with those times are not taken until the clocks agree (System Settings › General › Date & Time › Set time and date automatically, on each Mac).' },
    { kind: 'held', text: HELD_AUTHOR },
    { kind: 'held', text: HELD_LOGO }
  ],
  leftFile: null
}
try {
  await build({
    stdin: {
      contents: `import React from 'react'; import { createRoot } from 'react-dom/client'
import { SetupFolderPage } from './src/renderer/src/components/SetupFolderPage.tsx'
import '@app-patterns/settings-react/settings.css'
import './src/renderer/src/settings-page.css'
const STATUS = ${JSON.stringify(STATUS)}
window.calls = []
const after = { ...STATUS, notices: [...STATUS.notices, { kind: 'not-restored', text: ${JSON.stringify(NOT_PUT_BACK)} }] }
window.tw = { setupFolder: {
  status: async () => STATUS, choose: async () => STATUS, stop: async () => STATUS, readNow: async () => STATUS, notNow: async () => STATUS, newFile: async () => STATUS,
  apply: async () => ({ ok: true, status: STATUS }), use: async () => ({ ok: true, status: STATUS }), removeOwn: async () => ({ ok: true, status: STATUS }), reveal: async () => true,
  undo: async (id) => { window.calls.push(['undo', id]); return { ok: false, error: ${JSON.stringify(NOT_PUT_BACK)}, status: after } },
  onChange: () => () => {}
} }
createRoot(document.getElementById('root')).render(<div style={{ maxWidth: 760 }}><SetupFolderPage /></div>)`,
      resolveDir: root, loader: 'tsx', sourcefile: 'setup-folder-dom.tsx'
    },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', outfile: join(scratch, 'test.js'), logLevel: 'error', loader: { '.woff2': 'empty', '.woff': 'empty', '.ttf': 'empty', '.svg': 'dataurl', '.png': 'dataurl' }
  })
  writeFileSync(join(scratch, 'test.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="test.css"><div id="root"></div><script src="test.js"></script>')
  browser = await chromium.launch({ headless: true, executablePath: process.env.TW_CHROMIUM_HEADLESS_SHELL || undefined })
  const page = await browser.newPage({ viewport: { width: 760, height: 1100 } })
  page.setDefaultTimeout(6000)
  const errors = []; page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(pathToFileURL(join(scratch, 'test.html')).href)
  await page.locator('[data-setup-folder-state="joined"]').waitFor()
  /** Visible boxes matching `sel` that overlap each other or leave the window. */
  const overlaps = (sel) => page.evaluate((sel) => {
    const boxes = [...document.querySelectorAll(sel)].filter((e) => e.offsetParent !== null).map((e) => ({ e, r: e.getBoundingClientRect() })).filter((b) => b.r.width > 0)
    const bad = []
    for (const b of boxes) if (b.r.left < 0 || b.r.right > innerWidth + 0.5) bad.push(`${b.e.textContent.slice(0, 40)} leaves the window`)
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i].r, c = boxes[j].r
      if (boxes[i].e.contains(boxes[j].e) || boxes[j].e.contains(boxes[i].e)) continue
      if (a.left < c.right - 0.5 && c.left < a.right - 0.5 && a.top < c.bottom - 0.5 && c.top < a.bottom - 0.5) bad.push(`${boxes[i].e.textContent.slice(0, 40)} overlaps ${boxes[j].e.textContent.slice(0, 40)}`)
    }
    return bad
  }, sel)

  await test('text that stays on this Mac is named with why; a Mac that cannot identify itself says it keeps no file there', async () => {
    const held = await page.locator('[data-setup-folder-notice="held"]').allInnerTexts()
    assert.deepEqual(held.map((t) => t.trim()), [HELD_AUTHOR, HELD_LOGO])
    assert.equal((await page.locator('[data-setup-folder-notice="read-only"]').innerText()).trim(), READ_ONLY)
    const colour = async (kind) => page.locator(`[data-setup-folder-notice="${kind}"]`).first().evaluate((e) => getComputedStyle(e).color)
    assert.notEqual(await colour('read-only'), await colour('held'), 'the read-only line stands out from the held lines')
    assert.deepEqual(await overlaps('[data-setup-folder-notice]'), [])
  })

  await test('a batch that could not all be put back is named, stays listed first with Undo, and Undo says again what was not put back', async () => {
    assert.equal((await page.locator('[data-setup-folder-notice="not-restored"]').first().innerText()).trim(), STUCK)
    const batches = page.locator('[data-setup-folder-batch]')
    assert.equal(await batches.count(), 2)
    assert.match(await batches.first().innerText(), /From MacBook Air \(stopped part-way, not all put back\)/)
    assert.match(await batches.first().innerText(), /Talks: Author[\s\S]*Before[\s\S]*After/)
    const undo = batches.first().locator('[data-setup-folder="undo"]')
    assert.equal(await undo.isEnabled(), true)
    await page.screenshot({ path: join(shots, 'held-and-stuck-760.png'), fullPage: true })
    await undo.click()
    await page.locator('[data-setup-folder-notice="not-restored"]', { hasText: NOT_PUT_BACK }).first().waitFor()
    assert.deepEqual(await page.evaluate(() => window.calls), [['undo', 'stuck-1']])
    assert.equal((await page.locator('body').innerText()).split(NOT_PUT_BACK).length - 1, 1, 'said once, among the notices')
    assert.equal(await page.locator('[data-setup-folder-batch]').first().locator('[data-setup-folder="undo"]').count(), 1, 'Undo still offered')
    assert.deepEqual(await overlaps('[data-setup-folder-notice], [data-setup-folder-batch]'), [])
    await page.screenshot({ path: join(shots, 'undo-not-put-back-760.png'), fullPage: true })
  })
  assert.deepEqual(errors, [])
  console.log(`${checks} checks passed`)
} finally {
  await browser?.close()
  rmSync(scratch, { recursive: true, force: true })
}

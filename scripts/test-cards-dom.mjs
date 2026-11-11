// House rule R10 and R13: the one confirm card, the one name card, and the ⌘/ keyboard sheet scoped to a view.
// Confirm card: names the item, says where it goes and whether it can be recovered; Cancel on the left, a red verb
// button on the right; Cancel has the focus; Esc cancels. Name card: "New <kind>" / "Rename <kind>", one field,
// pre-filled and selected, Enter submits, an empty name is refused. Sheet: opens on the view's own keys.
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { chromium } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const repo = resolve(import.meta.dirname, '..'), src = resolve(repo, 'src')
const dir = mkdtempSync(join(tmpdir(), 'tw-cards-'))
const harness = `
import React, { useState } from 'react'; import { createRoot } from 'react-dom/client';
import { ConfirmCard, NameCard, BIN_CONSEQUENCE, BIN_RECOVERY } from '${src}/renderer/src/components/cards';
import KeyboardHelp from '${src}/renderer/src/components/KeyboardHelp';
window.log = [];
window.tw = {};
function App() {
  const [which, setWhich] = useState(new URLSearchParams(location.search).get('case'));
  if (which === 'confirm') return <ConfirmCard title="Delete this talk?" itemName="Embedded Page" consequence={BIN_CONSEQUENCE} recovery={BIN_RECOVERY} cta="Delete" onCancel={() => window.log.push('cancel')} onConfirm={() => window.log.push('confirm')} />;
  if (which === 'confirm-enter') return <ConfirmCard title="Delete this talk?" itemName="Embedded Page" consequence={BIN_CONSEQUENCE} recovery={BIN_RECOVERY} cta="Delete" enterConfirms onCancel={() => window.log.push('cancel')} onConfirm={() => window.log.push('confirm')} />;
  if (which === 'rename') return <NameCard kind="pathway" mode="rename" initial="Short probe" onCancel={() => window.log.push('cancel')} onSubmit={(v) => window.log.push('submit:' + v)} />;
  if (which === 'new') return <NameCard kind="talk" mode="new" onCancel={() => window.log.push('cancel')} onSubmit={(v) => window.log.push('submit:' + v)} />;
  const view = which === 'sheet-studio' ? 'studio' : which === 'sheet-history' ? 'runs' : undefined;
  return <KeyboardHelp isOpen onClose={() => {}} view={view} />;
}
createRoot(document.getElementById('root')).render(<App />)`
let browser
const failures = []
const check = async (name, fn) => { try { await fn(); console.log('HOLD', name) } catch (e) { failures.push(name); console.log('FAIL', name, '-', String(e.message).split('\n')[0]) } }
const open = async (which) => {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } })
  await context.route('http://tw.test/**', (r) => r.fulfill(r.request().url().includes('bundle.js') ? { contentType: 'text/javascript', path: join(dir, 'bundle.js') } : { contentType: 'text/html', body: '<!doctype html><body><div id="root"></div><script src="/bundle.js"></script></body>' }))
  const page = await context.newPage(); await page.goto(`http://tw.test/?case=${which}`)
  return { page, context }
}
try {
  await build({ stdin: { resolveDir: repo, loader: 'tsx', contents: harness }, bundle: true, outfile: join(dir, 'bundle.js'), platform: 'browser', jsx: 'automatic', logLevel: 'error' })
  browser = await chromium.launch({ headless: true, ...(process.env.TW_HEADLESS_SHELL ? { executablePath: process.env.TW_HEADLESS_SHELL } : {}) })

  await check('confirm card: names the item, says where it goes and that it can be recovered', async () => {
    const { page, context } = await open('confirm')
    try {
      const card = page.getByRole('dialog', { name: 'Delete this talk?' })
      await card.waitFor()
      const text = await card.innerText()
      assert.match(text, /“Embedded Page”/); assert.match(text, /Bin/); assert.match(text, /recover/i); assert.doesNotMatch(text, /Trash/)
    } finally { await context.close() }
  })
  await check('confirm card: Cancel on the left with the focus, a red verb button on the right', async () => {
    const { page, context } = await open('confirm')
    try {
      const cancel = page.getByRole('button', { name: 'Cancel', exact: true }), verb = page.getByRole('button', { name: 'Delete', exact: true })
      await cancel.waitFor()
      assert.equal(await cancel.evaluate((el) => el === document.activeElement), true, 'Cancel has the focus')
      const [c, v] = [await cancel.boundingBox(), await verb.boundingBox()]
      assert.ok(c.x < v.x, 'Cancel is left of the verb')
      assert.equal(await verb.evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(179, 38, 30)', 'the verb is red')
      await page.keyboard.press('Enter')
      assert.deepEqual(await page.evaluate(() => window.log), ['cancel'], 'Return is Cancel, not Delete')
    } finally { await context.close() }
  })
  await check('confirm card with Enter-to-confirm: Enter on the focused Cancel cancels, never deletes', async () => {
    const { page, context } = await open('confirm-enter')
    try {
      const cancel = page.getByRole('button', { name: 'Cancel', exact: true })
      await cancel.waitFor()
      assert.equal(await cancel.evaluate((el) => el === document.activeElement), true, 'Cancel has the focus')
      await page.keyboard.press('Enter')
      assert.deepEqual(await page.evaluate(() => window.log), ['cancel'], 'Enter on Cancel is Cancel')
    } finally { await context.close() }
  })
  await check('confirm card: Esc cancels, the red button confirms', async () => {
    const a = await open('confirm')
    try { await a.page.getByRole('button', { name: 'Cancel' }).waitFor(); await a.page.keyboard.press('Escape'); assert.deepEqual(await a.page.evaluate(() => window.log), ['cancel']) } finally { await a.context.close() }
    const b = await open('confirm')
    try { await b.page.getByRole('button', { name: 'Delete', exact: true }).click(); assert.deepEqual(await b.page.evaluate(() => window.log), ['confirm']) } finally { await b.context.close() }
  })
  await check('name card (rename): "Rename pathway", one field pre-filled and selected, Cancel and a verb', async () => {
    const { page, context } = await open('rename')
    try {
      const card = page.getByRole('dialog', { name: 'Rename pathway' }); await card.waitFor()
      const field = card.getByRole('textbox'); assert.equal(await field.count(), 1, 'one field')
      assert.equal(await field.inputValue(), 'Short probe')
      await page.waitForFunction(() => { const i = document.querySelector('input'); return i === document.activeElement && i.selectionStart === 0 && i.selectionEnd === i.value.length })
      await page.keyboard.type('Long probe')
      await page.getByRole('button', { name: 'Rename', exact: true }).click()
      assert.deepEqual(await page.evaluate(() => window.log), ['submit:Long probe'])
    } finally { await context.close() }
  })
  await check('name card (new): "New talk", Create is off until there is a name, Enter submits', async () => {
    const { page, context } = await open('new')
    try {
      await page.getByRole('dialog', { name: 'New talk' }).waitFor()
      assert.equal(await page.getByRole('button', { name: 'Create', exact: true }).isDisabled(), true)
      await page.keyboard.press('Enter'); assert.deepEqual(await page.evaluate(() => window.log), [], 'an empty name is refused')
      await page.keyboard.type('Autumn keynote'); await page.keyboard.press('Enter')
      assert.deepEqual(await page.evaluate(() => window.log), ['submit:Autumn keynote'])
    } finally { await context.close() }
  })
  await check('keyboard sheet: opened from Studio it lists Studio’s keys, from Runs Runs’, unscoped it opens on the task groups', async () => {
    const studio = await open('sheet-studio')
    try {
      await studio.page.locator('[data-sheet-pane="section"] .kbd-sheet-pane-title', { hasText: 'Studio keys' }).waitFor()
      const rows = await studio.page.locator('[data-sheet-view-row]').allInnerTexts()
      assert.ok(rows.some((r) => /Play \/ pause\s*Space/.test(r.replace(/\n/g, ' '))), rows.join(' | '))
      assert.ok(rows.some((r) => /Trim or restore/.test(r)))
    } finally { await studio.context.close() }
    const history = await open('sheet-history')
    try {
      await history.page.locator('.kbd-sheet-pane-title', { hasText: 'Runs keys' }).waitFor()
      assert.ok((await history.page.locator('[data-sheet-view-row]').allInnerTexts()).some((r) => /Cycle grouping/.test(r)))
    } finally { await history.context.close() }
    const plain = await open('sheet')
    try {
      await plain.page.locator('.kbd-sheet-pane-title').waitFor()
      assert.doesNotMatch(await plain.page.locator('.kbd-sheet-pane-title').innerText(), /keys$/, 'unscoped does not open on a view')
      assert.ok(await plain.page.locator('[data-sheet-section="view:studio"]').count() === 1, 'every view is still one click away')
    } finally { await plain.context.close() }
  })
  if (failures.length) { console.log(`${failures.length} checks failed`); process.exitCode = 1 } else console.log('cards and scoped sheet: all checks passed')
} finally { await browser?.close(); rmSync(dir, { recursive: true, force: true }) }

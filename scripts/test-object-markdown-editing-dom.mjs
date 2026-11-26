import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { openEditorHarness } from './editor-dom-harness.mjs'

const header = '## Table slide\n{id=s1} {table}\n\n'
const body = '- Tools\n  - Editors\n    - Vim\n  - Git'
const original = header + body + '\n'
const h = await openEditorHarness({ fileBacked: true })
try {
  const { page, outlinePath } = h
  const disk = () => readFileSync(outlinePath, 'utf8')
  const outerDoc = () => page.evaluate(() => window.view().state.doc.toString())
  const waitForWrite = (text) => page.waitForFunction((value) => window.writes.at(-1) === value, text)
  await h.mount('|' + original, 'markdown')
  await page.evaluate((pos) => window.setCaret(pos), header.length)
  await page.keyboard.press('Enter')
  const shell = page.locator('.oe')
  const draft = shell.locator('textarea, .cm-content')
  await draft.waitFor()
  await page.waitForFunction(() => document.activeElement?.closest('.oe-surface'))
  for (let line = 0; line < body.split('\n').length; line += 1) {
    await page.keyboard.press('ArrowDown')
  }
  await page.keyboard.press('End')
  const draftText = () => draft.evaluate((node) => node.value ??
    Array.from(node.querySelectorAll('.cm-line'), (line) => line.textContent).join('\n'))
  const focused = () => draft.evaluate((node) => document.activeElement === node)

  await page.keyboard.press('Enter')
  assert.equal(await draftText(), body + '\n  - ', 'Enter continues the list at the same level')
  await page.keyboard.type('New')
  await page.keyboard.press('Tab')
  assert.equal(await draftText(), body + '\n    - New', 'Tab indents the item with spaces')
  assert.equal(await focused(), true, 'Tab keeps focus in the draft')
  await page.keyboard.press('Shift+Tab')
  assert.equal(await draftText(), body + '\n  - New', 'Shift-Tab outdents the item')
  assert.equal(await focused(), true, 'Shift-Tab keeps focus in the draft')

  for (const _ of 'New') await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('ControlOrMeta+b')
  assert.equal(await draftText(), body + '\n  - **New**', 'Bold uses the same Markdown as the main editor')
  await page.keyboard.press('ControlOrMeta+z')
  assert.equal(await draftText(), body + '\n  - New', 'Undo inside the card affects only the draft')
  await page.keyboard.press(process.platform === 'darwin' ? 'ControlOrMeta+Shift+z' : 'ControlOrMeta+y')
  assert.equal(await draftText(), body + '\n  - **New**')
  assert.equal(await outerDoc(), original)
  assert.equal(disk(), original)
  assert.equal(await page.evaluate(() => window.depth()), 0)
  if (process.env.TW_OBJECT_MARKDOWN_SHOT) {
    await shell.screenshot({ path: process.env.TW_OBJECT_MARKDOWN_SHOT })
  }

  const edited = header + body + '\n  - **New**\n'
  await page.keyboard.press('ControlOrMeta+Enter')
  await shell.waitFor({ state: 'detached' })
  assert.equal(await outerDoc(), edited)
  await waitForWrite(edited)
  assert.equal(disk(), edited)
  assert.equal(await page.evaluate(() => window.depth()), 1)

  await page.keyboard.press('ControlOrMeta+z')
  assert.equal(await outerDoc(), original, 'one Undo after Done reverses the whole object edit')
  await waitForWrite(original)
  assert.equal(disk(), original)
  // Reopen by the same object key. Escape closes the card without touching an unchanged file.
  await page.evaluate((pos) => window.setCaret(pos), header.length)
  await page.keyboard.press('Enter')
  await draft.waitFor()
  await page.waitForFunction(() => document.activeElement?.closest('.oe-surface'))
  await page.keyboard.press('Escape')
  await shell.waitFor({ state: 'detached' })
  assert.equal(await outerDoc(), original)
  assert.equal(await page.evaluate(() => window.depth()), 0)
  assert.deepEqual(h.errors, [])
  console.log('PASS Markdown table card continues, indents, outdents and formats lists, saves, and undoes in one step')
} finally {
  await h.close()
}
